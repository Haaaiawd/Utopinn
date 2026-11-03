/**
 * prompt-injections.js(176行)+ populationInjectionPrompts 的移植。
 */
import type { PromptLike, PromptMessage } from './types.js';

export const INJECTION_POSITION = {
    RELATIVE: 0,
    ABSOLUTE: 1,
    ATTACH_EXISTING: 2,
} as const;

const ATTACH_ROLES = new Set(['system', 'user', 'assistant']);
const ATTACH_SIDES = new Set(['start', 'end']);

export function getPromptInjectionPosition(prompt: PromptLike): number {
    const position = Number(prompt?.injection_position ?? INJECTION_POSITION.RELATIVE);
    return Object.values(INJECTION_POSITION).includes(position as InjectionPositionValue)
        ? position
        : INJECTION_POSITION.RELATIVE;
}
type InjectionPositionValue = (typeof INJECTION_POSITION)[keyof typeof INJECTION_POSITION];

export function isPromptInjectionPosition(prompt: PromptLike, position: number): boolean {
    return getPromptInjectionPosition(prompt) === position;
}

const OVERRIDE_KEYS = [
    'injection_position',
    'injection_depth',
    'injection_order',
    'role',
    'attach_role',
    'attach_index',
    'attach_side',
] as const;

export function applyPromptManagerOverrides(prompt: PromptLike, collectionPrompt?: PromptLike | null): PromptLike {
    if (!collectionPrompt) return prompt;
    for (const key of OVERRIDE_KEYS) {
        const v = collectionPrompt[key];
        if (v !== undefined) (prompt as unknown as Record<string, unknown>)[key] = v;
    }
    return prompt;
}

export interface InjectionGroups {
    userRelativePromptIds: string[];
    absolutePrompts: PromptLike[];
    attachedPrompts: PromptLike[];
}

export function getPromptInjectionGroups(prompts: { collection?: PromptLike[] }): InjectionGroups {
    const collection = Array.isArray(prompts?.collection) ? prompts.collection : [];
    return {
        userRelativePromptIds: collection
            .filter((p) => p?.system_prompt === false && isPromptInjectionPosition(p, INJECTION_POSITION.RELATIVE))
            .map((p) => p.identifier),
        absolutePrompts: collection.filter((p) => isPromptInjectionPosition(p, INJECTION_POSITION.ABSOLUTE)),
        attachedPrompts: collection.filter((p) => isPromptInjectionPosition(p, INJECTION_POSITION.ATTACH_EXISTING)),
    };
}

export function getRelativePromptById(prompts: { get?: (id: string) => PromptLike | null | undefined }, identifier: string): PromptLike | null {
    const prompt = prompts?.get?.(identifier) ?? null;
    return prompt && isPromptInjectionPosition(prompt, INJECTION_POSITION.RELATIVE) ? prompt : null;
}

/** attach 到既有聊天消息(messages 为最新在前序)。返回应用数。 */
export function applyAttachedPromptsToMessages(
    attachedPrompts: PromptLike[],
    messages: PromptMessage[],
    { warn }: { warn?: (m: string) => void } = {},
): number {
    if (!attachedPrompts?.length || !messages?.length) return 0;
    let applied = 0;
    const describe = (p: PromptLike) => p.identifier || p.name || '(unnamed)';

    for (const attachPrompt of attachedPrompts) {
        const attachContent = String(attachPrompt?.content ?? '').trim();
        const attachRole = String(attachPrompt?.attach_role ?? '').trim();
        const attachSide = String(attachPrompt?.attach_side ?? 'end').trim();
        const rawIndex = attachPrompt?.attach_index ?? 1;

        if (!attachContent) continue;
        if (!ATTACH_ROLES.has(attachRole)) {
            warn?.(`[PromptManager] Attach prompt "${describe(attachPrompt)}" has an invalid target role: ${attachRole || '(empty)'}.`);
            continue;
        }

        const idx = Number(rawIndex);
        if (!Number.isFinite(idx) || !Number.isInteger(idx)) {
            warn?.(`[PromptManager] Attach prompt "${describe(attachPrompt)}" has an invalid message index: ${String(rawIndex)}.`);
            continue;
        }
        const requestedIndex = idx === 0 ? 1 : idx;

        const chronologicalRoleMatches = messages
            .filter((m) => m && !m.injected && m.role === attachRole)
            .slice()
            .reverse();
        if (!chronologicalRoleMatches.length) {
            warn?.(`[PromptManager] Attach prompt "${describe(attachPrompt)}" found no existing ${attachRole} messages.`);
            continue;
        }

        const targetIndex = requestedIndex > 0
            ? Math.min(requestedIndex - 1, chronologicalRoleMatches.length - 1)
            : Math.max(chronologicalRoleMatches.length + requestedIndex, 0);
        const target = chronologicalRoleMatches[targetIndex]!;
        const current = String(target.content ?? '');
        const side = ATTACH_SIDES.has(attachSide) ? attachSide : 'end';
        if (!ATTACH_SIDES.has(attachSide)) {
            warn?.(`[PromptManager] Attach prompt "${describe(attachPrompt)}" has an invalid attach side. Using end.`);
        }
        target.content = side === 'start'
            ? [attachContent, current].filter(Boolean).join('\n\n')
            : [current, attachContent].filter(Boolean).join('\n\n');
        applied += 1;
    }
    return applied;
}

/** 深度注入回调 —— ST 的 getExtensionPrompt(IN_CHAT, depth, sep, role, wrap) 的宿主注入面 */
export type DepthInjectionProvider = (depth: number, role: 'system' | 'user' | 'assistant') => Promise<string>;

/**
 * populationInjectionPrompts 移植:messages 为**最新在前**序,
 * 按 injection_depth 逐层在 depth+已插数 处 splice,返回反转(原序)数组。
 */
export async function populationInjectionPrompts(
    prompts: PromptLike[],
    messages: PromptMessage[],
    opts: { maxDepth?: number; getDepthInjection?: DepthInjectionProvider } = {},
): Promise<PromptMessage[]> {
    let totalInserted = 0;
    const maxDepth = opts.maxDepth ?? 100;
    const roleOrder = ['system', 'user', 'assistant'];
    const extensionPromptsOrder = 100;

    for (let i = 0; i <= maxDepth; i++) {
        // 原版语义:injection_depth === i 严格匹配,undefined 不落入任何层
        const depthPrompts = prompts.filter((p) => p.injection_depth === i && p.content);
        const roleMessages: PromptMessage[] = [];
        const separator = '\n';
        const orderGroups: Record<number, PromptLike[]> = { [extensionPromptsOrder]: [] };
        for (const prompt of depthPrompts) {
            const order = prompt.injection_order ?? 100;
            (orderGroups[order] ??= []).push(prompt);
        }
        const orders = Object.keys(orderGroups).map(Number).sort((a, b) => b - a);
        for (const order of orders) {
            for (const role of roleOrder) {
                const rolePrompts = orderGroups[order]!
                    .filter((p) => p.role === role)
                    .map((x) => x.content)
                    .join(separator);
                const extensionPrompt = order === extensionPromptsOrder && opts.getDepthInjection
                    ? await opts.getDepthInjection(i, role as 'system' | 'user' | 'assistant')
                    : '';
                const joint = [rolePrompts, extensionPrompt].filter((x) => x).map((x) => x.trim()).join(separator);
                if (joint?.length) {
                    roleMessages.push({ role, content: joint, injected: true });
                }
            }
        }
        if (roleMessages.length) {
            const injectIdx = i + totalInserted;
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInserted += roleMessages.length;
        }
    }
    return [...messages].reverse();
}
