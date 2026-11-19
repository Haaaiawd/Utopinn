/**
 * prepareOpenAIMessages 的纯函数移植(chat completions 路径)。
 * 序列严格对齐 openai.js 1895-2335 + PromptManager.preparePrompt。
 * 注入依赖:substituteParams(core 已移植)、TokenCounter seam、可选 depthInjectionProvider。
 */
import type {
    BuiltPrompt,
    ChatMessageInput,
    PromptBuildRequest,
    PromptLike,
    PromptMessage,
} from './types.js';
import { IGNORE_SYMBOL } from './types.js';
import { PromptCollection } from './collection.js';
import { ChatCompletion, Message, MessageCollection, type MediaAttachment, type ToolInvocation } from './messages.js';
import {
    applyAttachedPromptsToMessages,
    applyPromptManagerOverrides,
    getPromptInjectionGroups,
    getRelativePromptById,
    INJECTION_POSITION,
    isPromptInjectionPosition,
    populationInjectionPrompts,
    type DepthInjectionProvider,
} from './injections.js';
import { substituteParams, type SubstituteContext } from '../macros/substitute.js';

const SYSTEM_MESSAGE_TYPE_NARRATOR = 4; // system_message_types.NARRATOR
const NAMES_NONE = 0;
const NAMES_DEFAULT = 1;
const NAMES_CONTENT = 2;
const NAMES_COMPLETION = 3;

// extension_prompt_types(script.js:1456):NONE=-1, IN_PROMPT=0, IN_CHAT=1, BEFORE_PROMPT=2
const EXT_IN_PROMPT = 0;
const EXT_BEFORE_PROMPT = 2;

export interface AssembleDeps {
    substCtx: SubstituteContext;
    depthInjection?: DepthInjectionProvider;
    maxDepth?: number;
    group?: { selected?: string | null; botNames?: string[]; memberNames?: string[] };
    warn?: (m: string) => void;
}

function isValidName(name: string): boolean {
    return /^[a-zA-Z0-9_]{1,64}$/.test(name);
}
function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
}

function sub(content: string | undefined, deps: AssembleDeps, original?: string): string {
    const opts = original !== undefined ? { original } : undefined;
    return substituteParams(content ?? '', deps.substCtx, opts as never) as string;
}

/** setOpenAIMessages 移植:chat[] → 最新在前 PromptMessage[] */
export function setOpenAIMessages(
    chat: ChatMessageInput[],
    req: Pick<PromptBuildRequest, 'settings' | 'api' | 'model'> & { groupBotNames?: string[]; name1?: string; name2?: string },
): PromptMessage[] {
    const namesBehavior = req.settings.names_behavior ?? NAMES_NONE;
    const messages: (PromptMessage | undefined)[] = [];
    let j = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const c = chat[j]!;
        let role = c.is_user ? 'user' : 'assistant';
        let content = c.mes ?? '';
        if (c.extra?.[IGNORE_SYMBOL]) {
            j++;
            continue;
        }
        if (c.extra?.type === SYSTEM_MESSAGE_TYPE_NARRATOR) role = 'system';

        switch (namesBehavior) {
            case NAMES_NONE:
                break;
            case NAMES_DEFAULT:
                if ((req.groupBotNames?.length && c.name !== req.name1) ||
                    (c.force_avatar && c.name !== req.name1 && c.extra?.type !== SYSTEM_MESSAGE_TYPE_NARRATOR)) {
                    content = `${c.name}: ${content}`;
                }
                break;
            case NAMES_CONTENT:
                if (c.extra?.type !== SYSTEM_MESSAGE_TYPE_NARRATOR) content = `${c.name}: ${content}`;
                break;
            case NAMES_COMPLETION:
                break;
        }
        content = content.replace(/\r/gm, '');

        const isSameModel = c.extra?.api === req.api && c.extra?.model === req.model;
        const isOtherGroupMember = Boolean(req.groupBotNames?.length) && c.name !== req.name2;
        const signature = isSameModel && !isOtherGroupMember ? (c.extra?.reasoning_signature ?? null) : null;
        const reasoning = isSameModel && !isOtherGroupMember ? String(c.extra?.reasoning ?? '') : '';
        const reasoningBlocks = isSameModel && !isOtherGroupMember && Array.isArray(c.extra?.reasoning_blocks)
            ? c.extra!.reasoning_blocks!
            : null;
        const reasoningDetails = isSameModel && !isOtherGroupMember && Array.isArray(c.extra?.reasoning_details)
            ? c.extra!.reasoning_details!
            : null;

        let invocations = c.extra?.tool_invocations?.slice();
        if (Array.isArray(invocations) && invocations.length && !isSameModel) {
            invocations = (invocations as Record<string, unknown>[]).map((inv) => {
                const clone = { ...inv };
                delete clone.signature;
                delete clone.reasoning;
                return clone;
            });
        }

        const prev = messages[i + 1];
        const mergeSummary =
            c.extra?.isSmallSys === true && Array.isArray(invocations) && invocations.length > 0 && prev?.role === 'assistant';
        if (mergeSummary) {
            prev!.invocations = Array.isArray(prev!.invocations) ? prev!.invocations!.concat(invocations!) : invocations;
            j++;
            continue;
        }
        const isUnmerged = c.extra?.isSmallSys === true && Array.isArray(invocations) && invocations.length > 0;
        if (isUnmerged) content = '';

        messages[i] = {
            role,
            content,
            name: c.name,
            media: c.extra?.media as unknown[] | undefined,
            mediaDisplay: c.extra?.mediaDisplay as string | undefined,
            mediaIndex: c.extra?.mediaIndex as number | undefined,
            invocations,
            signature,
            reasoning,
            reasoning_blocks: reasoningBlocks,
            reasoning_details: reasoningDetails,
        };
        j++;
    }
    return messages.filter((m): m is PromptMessage => Boolean(m));
}

/** parseExampleIntoIndividual 移植 */
export function parseExampleIntoIndividual(
    mesExample: string,
    deps: AssembleDeps & { name1: string; name2: string },
): { role: string; content: string; name: string }[] {
    const groupBotNames = (deps.group?.botNames ?? []).map((n) => `${n}:`);
    const result: { role: string; content: string; name: string }[] = [];
    const lines = mesExample.split('\n');
    let cur: string[] = [];
    let inUser = false;
    let inBot = false;
    let botName = deps.name2;
    const appendNames = Boolean(deps.group?.selected);

    const flush = (name: string, role: string, sysName: string) => {
        let parsed = cur.join('\n').replace(name + ':', '').trim();
        if (appendNames && ['example_user', 'example_assistant'].includes(sysName)) {
            parsed = `${name}: ${parsed}`;
        }
        result.push({ role, content: parsed, name: sysName });
        cur = [];
    };

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith(deps.name1 + ':')) {
            inUser = true;
            if (inBot) flush(botName, 'system', 'example_assistant');
            inBot = false;
        } else if (line.startsWith(deps.name2 + ':') || groupBotNames.some((n) => line.startsWith(n))) {
            if (!line.startsWith(deps.name2 + ':') && groupBotNames.length) {
                botName = line.split(':')[0]!;
            }
            inBot = true;
            if (inUser) flush(deps.name1, 'system', 'example_user');
            inUser = false;
        }
        cur.push(line);
    }
    if (inUser) flush(deps.name1, 'system', 'example_user');
    else if (inBot) flush(botName, 'system', 'example_assistant');
    return result;
}

/** formatWorldInfo + getWorldInfoMessageContents */
export function formatWorldInfo(value: string, wiFormat?: string): string {
    if (!value) return '';
    const format = wiFormat ?? 'World Information:\n{0}';
    return format.includes('{0}') ? format.replace('{0}', value) : `${format}\n${value}`;
}

/**
 * 原版 getWorldInfoMessageContents + formatSplitWorldInfoEntries(openai.js:1434-1458):
 * 每条 WI 各成一条消息;wi_format 恰含一个 {0} 时 prefix/suffix 分到首末条,
 * 占位符数≠1 才 join 成单条;空/默认格式('{0}')原样逐条。
 */
export function getWorldInfoMessageContents(entries: string[] | undefined, wiFormat?: string): string[] {
    const normalized = (entries ?? []).filter((x) => typeof x === 'string' && x.trim().length);
    if (!normalized.length) return [];
    const format = String(wiFormat ?? '').trim();
    if (!format || format === '{0}') return [...normalized];
    const placeholderCount = (format.match(/\{0\}/g) || []).length;
    if (placeholderCount !== 1) {
        return [formatWorldInfo(normalized.join('\n'), wiFormat)];
    }
    const [prefix, suffix] = format.split('{0}');
    const lastIndex = normalized.length - 1;
    return normalized.map((entry, index) => `${index === 0 ? prefix : ''}${entry}${index === lastIndex ? suffix : ''}`);
}

function getPromptPosition(position: number | undefined): 'start' | 'end' | false {
    if (position === EXT_BEFORE_PROMPT) return 'start';
    if (position === EXT_IN_PROMPT) return 'end';
    return false;
}

function getPromptRole(role: number | string | undefined): string {
    switch (role) {
        case 0:
        case 'system':
            return 'system';
        case 1:
        case 'user':
            return 'user';
        case 2:
        case 'assistant':
            return 'assistant';
        default:
            return 'system';
    }
}

/** preparePromptsForChatCompletion:基础 prompt + extension prompts 并入集合 + 卡级 override */
function preparePrompts(
    req: PromptBuildRequest,
    deps: AssembleDeps,
): PromptCollection {
    const s = req.settings;
    const scenarioText = req.card.scenario && s.scenario_format ? sub(s.scenario_format, deps) : (req.card.scenario || '');
    const personalityText = req.card.personality && s.personality_format ? sub(s.personality_format, deps) : (req.card.personality || '');
    const groupNudge = sub(s.group_nudge_prompt, deps);
    const impersonationPrompt = s.impersonation_prompt ? sub(s.impersonation_prompt, deps) : '';

    const systemPrompts: PromptLike[] = [
        { role: 'system', content: '', identifier: 'worldInfoBefore' },
        { role: 'system', content: '', identifier: 'worldInfoAfter' },
        { role: 'system', content: req.card.description, identifier: 'charDescription' },
        { role: 'system', content: personalityText, identifier: 'charPersonality' },
        { role: 'system', content: scenarioText, identifier: 'scenario' },
        { role: 'system', content: impersonationPrompt, identifier: 'impersonate' },
        { role: 'system', content: req.quietPrompt, identifier: 'quietPrompt' },
        { role: 'system', content: groupNudge, identifier: 'groupNudge' },
        { role: 'assistant', content: req.bias, identifier: 'bias' },
    ];

    const ext = req.extensionPrompts ?? {};
    const authorsNote = ext['2_floating_prompt'];
    if (authorsNote?.value) {
        systemPrompts.push({
            role: getPromptRole(authorsNote.role),
            content: authorsNote.value,
            identifier: 'authorsNote',
            position: getPromptPosition(authorsNote.position) || undefined,
        });
    }
    const vectorsMemory = ext['3_vectors'];
    if (vectorsMemory?.value) {
        systemPrompts.push({ role: 'system', content: vectorsMemory.value, identifier: 'vectorsMemory', position: getPromptPosition(vectorsMemory.position) || undefined });
    }
    const vectorsDataBank = ext['4_vectors_data_bank'];
    if (vectorsDataBank?.value) {
        systemPrompts.push({ role: getPromptRole(vectorsDataBank.role), content: vectorsDataBank.value, identifier: 'vectorsDataBank', position: getPromptPosition(vectorsDataBank.position) || undefined });
    }
    const smartContext = ext['chromadb'];
    if (smartContext?.value) {
        systemPrompts.push({ role: 'system', content: smartContext.value, identifier: 'smartContext', position: getPromptPosition(smartContext.position) || undefined });
    }
    if (req.user.description) {
        systemPrompts.push({ role: 'system', content: req.user.description, identifier: 'personaDescription' });
    }

    const knownExtensionPrompts = [
        '2_floating_prompt', '3_vectors', '4_vectors_data_bank',
        'chromadb', 'PERSONA_DESCRIPTION', 'QUIET_PROMPT', 'DEPTH_PROMPT',
    ];
    for (const key of Object.keys(ext)) {
        if (knownExtensionPrompts.includes(key)) continue;
        const p = ext[key];
        if (!p?.value) continue;
        if (![EXT_BEFORE_PROMPT, EXT_IN_PROMPT].includes(p.position ?? -1)) continue;
        systemPrompts.push({
            identifier: key.replace(/\W/g, '_'),
            position: getPromptPosition(p.position) || undefined,
            role: getPromptRole(p.role),
            content: p.value,
            extension: true,
        });
    }

    // WI 深度注入条目 → absolute prompts(WI 引擎已给出 depth/order/role)
    for (const e of req.worldInfo.depthEntries ?? []) {
        systemPrompts.push({ ...e, extension: e.extension ?? true });
    }

    // getPromptCollection(type) 移植:按 promptOrder 遍历,
    // enabled && shouldTrigger(= injection_trigger 无则放行/含 type)才进集合,
    // 每项 preparePrompt(= 宏替换);被禁 main 给空替身保 marker 位。
    // 不在序里的 preset prompt 原版不进集合。
    const type = req.type ?? 'normal';
    const order = Array.isArray(req.promptOrder) ? req.promptOrder : [];
    const byId = new Map((req.prompts ?? []).map((p) => [p.identifier, p]));
    const prompts = new PromptCollection([], order);
    order.forEach((entry, i) => {
        const id = typeof entry === 'string' ? entry : entry.identifier;
        const prompt = byId.get(id);
        if (!prompt) return;
        const trigger = Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length
            ? prompt.injection_trigger.includes(type)
            : true;
        // 原版 `entry.enabled && shouldTrigger`:缺 enabled 视为禁用(序条目恒带)
        const enabled = typeof entry === 'object' ? Boolean(entry.enabled) : true;
        if (enabled && trigger) {
            prompts.collection[i] = { ...prompt, content: sub(prompt.content, deps) };
        } else if (id === 'main') {
            prompts.collection[i] = { ...prompt, content: '' };
        }
    });

    // 合并 system prompts 进集合(应用 prompt-manager override + 宏替换)
    for (const p of systemPrompts) {
        applyPromptManagerOverrides(p, prompts.get(p.identifier));
        const prepared: PromptLike = { ...p, content: sub(p.content, deps) };
        const markerIndex = prompts.index(p.identifier);
        if (markerIndex !== -1) prompts.collection[markerIndex] = prepared;
        else prompts.add(prepared);
    }

    // 卡级 main/jailbreak override
    const mainPrompt = prompts.get('main');
    if (req.card.systemPromptOverride && mainPrompt && mainPrompt.forbid_overrides !== true && !prompts.isPromptDisabledForActiveCharacter('main')) {
        const original = mainPrompt.content;
        mainPrompt.content = req.card.systemPromptOverride;
        const replacement = { ...mainPrompt, content: sub(mainPrompt.content, deps, original) };
        prompts.override(replacement, prompts.index('main'));
    }
    const jailbreakPrompt = prompts.get('jailbreak');
    if (req.card.jailbreakOverride && jailbreakPrompt && jailbreakPrompt.forbid_overrides !== true && !prompts.isPromptDisabledForActiveCharacter('jailbreak')) {
        const original = jailbreakPrompt.content;
        jailbreakPrompt.content = req.card.jailbreakOverride;
        const replacement = { ...jailbreakPrompt, content: sub(jailbreakPrompt.content, deps, original) };
        prompts.override(replacement, prompts.index('jailbreak'));
    }

    return prompts;
}

/** populateDialogueExamples */
async function populateDialogueExamples(
    prompts: PromptCollection,
    chatCompletion: ChatCompletion,
    messageExamples: { role: string; content: string; name?: string }[][],
    req: PromptBuildRequest,
    deps: AssembleDeps,
): Promise<void> {
    if (!prompts.has('dialogueExamples')) return;
    chatCompletion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));
    if (!messageExamples?.length) return;
    const newExampleChat = await Message.createAsync('system', sub(req.settings.new_example_chat_prompt, deps), 'newChat');
    for (let d = 0; d < messageExamples.length; d++) {
        const dialogue = messageExamples[d]!;
        const chatMessages = await Message.createManyAsync(
            dialogue.map((p, i) => ({
                role: 'system',
                content: p.content || '',
                identifier: `dialogueExamples ${d}-${i}`,
                name: p.name,
            })),
        );
        if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) break;
        chatCompletion.insert(newExampleChat, 'dialogueExamples');
        for (const m of chatMessages) chatCompletion.insert(m, 'dialogueExamples');
    }
}

/** populateChatHistory:预算装配心脏 */
async function populateChatHistory(
    messages: PromptMessage[],
    prompts: PromptCollection,
    chatCompletion: ChatCompletion,
    req: PromptBuildRequest,
    deps: AssembleDeps,
): Promise<void> {
    if (!prompts.has('chatHistory')) return;
    const s = req.settings;
    const type = req.type ?? 'normal';
    const cyclePrompt = req.cyclePrompt ?? null;
    const selectedGroup = deps.group?.selected;

    chatCompletion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

    const newChat = selectedGroup ? s.new_group_chat_prompt : s.new_chat_prompt;
    const newChatMessage = await Message.createAsync('system', sub(newChat, deps), 'newMainChat');
    chatCompletion.reserveBudget(newChatMessage);

    let groupNudgeMessage: Message | null = null;
    if (selectedGroup && prompts.has('groupNudge') && type !== 'impersonate') {
        groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge')!);
        chatCompletion.reserveBudget(groupNudgeMessage);
    }

    let continueMessageCollection: MessageCollection | null = null;
    if (type === 'continue' && cyclePrompt && !s.continue_prefill) {
        continueMessageCollection = new MessageCollection('continueNudge');
        let continueIdx = -1;
        for (let k = messages.length - 1; k >= 0; k--) { if (!messages[k]!.injected) { continueIdx = k; break; } }
        if (continueIdx >= 0) {
            const continueMsg = messages.splice(continueIdx, 1)[0]!;
            // 上游 openai.js:917-921 — continueNudge 路径 fromPromptAsync 不带 name
            // (与 continue_prefill:1329 的显式 setName 不同,此处上游不上名)。
            const chatMessage = await Message.createAsync(
                continueMsg.role,
                sub(continueMsg.content, deps),
                `chatHistory-${continueIdx}`,
            );
            continueMessageCollection.add(chatMessage);
        }
        const nudgePrompt: PromptLike = {
            identifier: 'continueNudge',
            role: 'system',
            // 上游 openai.js:909-912 — substituteParamsExtended 带
            // { lastChatMessage: String(cyclePrompt).trim() } 动态宏,
            // 等价 dynamicMacros 注入(audit L2)。
            content: substituteParams(s.continue_nudge_prompt ?? '', deps.substCtx, {
                dynamicMacros: { lastChatMessage: String(cyclePrompt).trim() },
            }),
            system_prompt: true,
        };
        const nudgeMessage = await Message.fromPromptAsync(nudgePrompt);
        continueMessageCollection.add(nudgeMessage);
        chatCompletion.reserveBudget(continueMessageCollection);
    }

    const lastChatPrompt = messages[messages.length - 1];
    const emptyMsg = await Message.createAsync('user', s.send_if_empty, 'emptyUserMessageReplacement');
    if (lastChatPrompt && lastChatPrompt.role === 'assistant' && s.send_if_empty && chatCompletion.canAfford(emptyMsg)) {
        chatCompletion.insert(emptyMsg, 'chatHistory');
    }

    // —— 以下逐段移植 openai.js:1601-1792 的池装填循环 ——
    const tools = req.tools ?? {};
    const media = req.media ?? {};
    const toolReasoningMode = tools.reasoningMode ?? 'disabled';
    const includeToolReasoning = toolReasoningMode !== 'disabled';
    const includeSignature = tools.includeSignature ?? false;
    const canUseTools = tools.canUse ?? false;
    let lastUserIdx = -1;
    for (let k = messages.length - 1; k >= 0; k--) {
        if (messages[k]!.role === 'user') { lastUserIdx = k; break; }
    }

    const chatPool = [...messages].reverse();
    const chatEntries: {
        chatPrompt: PromptMessage;
        chatMessageIndex: number;
        toolResultStartIndex: number;
        toolResultCount: number;
        postCountSignature: string | null;
    }[] = [];
    const batchedMessageDefinitions: (Record<string, unknown> & { role: string })[] = [];

    for (let index = 0; index < chatPool.length; index++) {
        const chatPrompt = chatPool[index]!;
        const identifier = `chatHistory-${messages.length - index}`;
        const messageName =
            s.names_behavior === NAMES_COMPLETION && chatPrompt.name
                ? isValidName(chatPrompt.name)
                    ? chatPrompt.name
                    : sanitizeName(chatPrompt.name)
                : undefined;
        const invocations = canUseTools && Array.isArray(chatPrompt.invocations)
            ? (chatPrompt.invocations as ToolInvocation[])
            : [];
        const shouldCountSignature = invocations.length > 0 && includeSignature && Boolean(chatPrompt.signature);
        const reasoning = typeof chatPrompt.reasoning === 'string' && chatPrompt.reasoning.length > 0
            ? chatPrompt.reasoning
            : null;
        const reasoningBlocks = Array.isArray(chatPrompt.reasoning_blocks) && chatPrompt.reasoning_blocks.length > 0
            ? chatPrompt.reasoning_blocks
            : null;
        const reasoningDetails = Array.isArray(chatPrompt.reasoning_details) && chatPrompt.reasoning_details.length > 0
            ? chatPrompt.reasoning_details
            : null;
        const chatMessageDefinition: Record<string, unknown> & { role: string } = {
            role: chatPrompt.role,
            content: sub(chatPrompt.content, deps),
            identifier,
            injected: chatPrompt.injected,
            ...(messageName ? { name: messageName } : {}),
            ...(invocations.length > 0 ? { tool_calls: Message.formatToolCalls(invocations, includeSignature) } : {}),
            ...(shouldCountSignature ? { signature: chatPrompt.signature } : {}),
            ...(reasoning ? { reasoning } : {}),
            ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
            ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
        };
        const chatMessageIndex = batchedMessageDefinitions.length;
        batchedMessageDefinitions.push(chatMessageDefinition);

        const toolResultStartIndex = batchedMessageDefinitions.length;
        if (invocations.length > 0) {
            batchedMessageDefinitions.push(
                ...invocations.slice().reverse().map((invocation) => ({
                    role: 'tool',
                    content: invocation.result || '[No content]',
                    identifier: invocation.id,
                })),
            );
        }

        chatEntries.push({
            chatPrompt,
            chatMessageIndex,
            toolResultStartIndex,
            toolResultCount: invocations.length,
            postCountSignature: !shouldCountSignature && includeSignature ? (chatPrompt.signature ?? null) : null,
        });
    }

    const batched = await Message.createManyAsync(batchedMessageDefinitions);
    for (const entry of chatEntries) {
        const chatMessage = batched[entry.chatMessageIndex]!;

        if (entry.postCountSignature) {
            chatMessage.signature = entry.postCountSignature;
        }

        const inlineMediaAttachment = async (m: MediaAttachment): Promise<void> => {
            if (!m || !m.url) return;
            if (!m.type) m.type = 'image';
            if (media.image && m.type === 'image') await chatMessage.addImage(m.url);
            if (media.video && m.type === 'video') await chatMessage.addVideo(m.url);
            if (media.audio && m.type === 'audio') await chatMessage.addAudio(m.url);
        };

        if (Array.isArray(entry.chatPrompt.media) && entry.chatPrompt.media.length) {
            if (entry.chatPrompt.mediaDisplay === 'list') { // MEDIA_DISPLAY.LIST
                for (const m of entry.chatPrompt.media as MediaAttachment[]) await inlineMediaAttachment(m);
            }
            if (entry.chatPrompt.mediaDisplay === 'gallery') { // MEDIA_DISPLAY.GALLERY
                const m = (entry.chatPrompt.media as MediaAttachment[])[entry.chatPrompt.mediaIndex ?? 0];
                if (m) await inlineMediaAttachment(m);
            }
        }

        if (canUseTools && Array.isArray(entry.chatPrompt.invocations)) {
            const promptIdx = messages.indexOf(entry.chatPrompt);
            const reasoningIsEligible = toolReasoningMode !== 'disabled' && promptIdx > lastUserIdx;
            let previousAssistantReasoning = '';
            if (reasoningIsEligible) {
                if (toolReasoningMode === 'active_chain') {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        if (candidate?.role === 'tool') continue;
                        if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) continue;
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (hasAssistantText) {
                            previousAssistantReasoning = String(candidate.reasoning ?? '');
                        }
                        break;
                    }
                } else if (toolReasoningMode === 'since_last_user') {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (!hasAssistantText) continue;
                        const candidateReasoning = String(candidate.reasoning ?? '');
                        if (candidateReasoning) {
                            previousAssistantReasoning = candidateReasoning;
                            break;
                        }
                    }
                }
            }
            const invocations = (entry.chatPrompt.invocations as ToolInvocation[]).map((invocation) => {
                const clone = structuredClone(invocation);
                if (!reasoningIsEligible) {
                    delete clone.reasoning;
                } else if (previousAssistantReasoning && !clone.reasoning) {
                    clone.reasoning = previousAssistantReasoning;
                }
                return clone;
            });
            const toolCallMessage = await Message.createAsync(chatMessage.role, undefined, 'toolCall-' + chatMessage.identifier);
            const toolResultMessages = await Message.createManyAsync(
                invocations.slice().reverse().map((invocation) => ({
                    role: 'tool',
                    content: invocation.result || '[No content]',
                    identifier: invocation.id,
                })),
            );
            await toolCallMessage.setToolCalls(invocations, includeSignature, includeToolReasoning);
            if (chatCompletion.canAffordAll([toolCallMessage, ...toolResultMessages])) {
                for (const resultMessage of toolResultMessages) {
                    chatCompletion.insertAtStart(resultMessage, 'chatHistory');
                }
                chatCompletion.insertAtStart(chatMessage, 'chatHistory');
            } else {
                break;
            }
            continue;
        }

        if (chatCompletion.canAfford(chatMessage)) {
            chatCompletion.insertAtStart(chatMessage, 'chatHistory');
        } else {
            break;
        }
    }

    chatCompletion.freeBudget(newChatMessage);
    chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

    if (selectedGroup && groupNudgeMessage) {
        chatCompletion.freeBudget(groupNudgeMessage);
        chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
    }

    if (type === 'continue' && continueMessageCollection) {
        chatCompletion.freeBudget(continueMessageCollection);
        chatCompletion.add(continueMessageCollection, -1);
    }
}

/** populateChatCompletion 主编排(原版 openai.js:1895) */
async function populateChatCompletion(
    prompts: PromptCollection,
    chatCompletion: ChatCompletion,
    req: PromptBuildRequest,
    messages: PromptMessage[],
    messageExamples: { role: string; content: string; name?: string }[][],
    deps: AssembleDeps,
): Promise<void> {
    const type = req.type ?? 'normal';
    const s = req.settings;

    const addToChatCompletion = async (source: string, target: string | null = null): Promise<void> => {
        if (!prompts.has(source)) return;
        if (prompts.isPromptDisabledForActiveCharacter(source) && source !== 'main') return;
        const prompt = prompts.get(source)!;
        if (!isPromptInjectionPosition(prompt, INJECTION_POSITION.RELATIVE)) return;
        const index = target ? prompts.index(target) : prompts.index(source);
        const collection = new MessageCollection(source);
        if (source === 'worldInfoBefore' || source === 'worldInfoAfter') {
            const contents = getWorldInfoMessageContents(
                source === 'worldInfoBefore' ? req.worldInfo.beforeEntries : req.worldInfo.afterEntries,
                req.worldInfo.format ?? s.wi_format,
            );
            if (!contents.length) return;
            const batched = await Message.createManyAsync(
                contents.map((content, i) => ({ role: prompt.role, content, identifier: `${source}-${i + 1}` })),
            );
            for (const m of batched) collection.add(m);
        } else {
            collection.add(await Message.fromPromptAsync(prompt));
        }
        chatCompletion.add(collection, index);
    };

    chatCompletion.reserveBudget(3);
    await addToChatCompletion('worldInfoBefore');
    await addToChatCompletion('main');
    await addToChatCompletion('worldInfoAfter');
    await addToChatCompletion('charDescription');
    await addToChatCompletion('charPersonality');
    await addToChatCompletion('scenario');
    await addToChatCompletion('personaDescription');

    const controlPrompts = new MessageCollection('controlPrompts');
    const impersonatePrompt = getRelativePromptById(prompts, 'impersonate');
    const impersonateMessage = impersonatePrompt ? await Message.fromPromptAsync(impersonatePrompt) : null;
    if (type === 'impersonate' && impersonateMessage) controlPrompts.add(impersonateMessage);

    const quietPromptEntry = getRelativePromptById(prompts, 'quietPrompt');
    const quietPromptMessage = quietPromptEntry ? await Message.fromPromptAsync(quietPromptEntry) : null;
    if (quietPromptMessage?.content) controlPrompts.add(quietPromptMessage);
    chatCompletion.reserveBudget(controlPrompts);

    const systemPrompts = ['nsfw', 'jailbreak'];
    const { userRelativePromptIds, absolutePrompts, attachedPrompts } = getPromptInjectionGroups(prompts);
    for (const id of [...systemPrompts, ...userRelativePromptIds]) await addToChatCompletion(id);
    if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');
    if (req.bias?.trim().length) await addToChatCompletion('bias');

    const injectToMain = async (prompt: PromptLike, position: string | number): Promise<void> => {
        if (!isPromptInjectionPosition(prompt, INJECTION_POSITION.RELATIVE)) return;
        if (chatCompletion.has('main')) {
            const message = await Message.fromPromptAsync(prompt);
            chatCompletion.insert(message, 'main', position);
        } else {
            const indexOfMain = absolutePrompts.findIndex((p) => p.identifier === 'main');
            if (indexOfMain >= 0) {
                const main = absolutePrompts[indexOfMain]!;
                const copy: PromptLike = {
                    ...prompt,
                    role: main.role,
                    injection_position: main.injection_position,
                    injection_depth: main.injection_depth,
                    injection_order: main.injection_order,
                };
                absolutePrompts.splice(position === 'end' ? indexOfMain + 1 : indexOfMain, 0, copy);
            }
        }
    };

    const knownPrompts = ['authorsNote', 'vectorsMemory', 'vectorsDataBank', 'smartContext'];
    for (const key of knownPrompts) {
        if (prompts.has(key)) {
            const p = prompts.get(key)!;
            if (p.position) await injectToMain(p, p.position);
        }
    }
    for (const p of prompts.collection.filter((x) => x.extension && x.position)) {
        await injectToMain(p, p.position!);
    }

    if (attachedPrompts.length) {
        applyAttachedPromptsToMessages(attachedPrompts, messages, { warn: deps.warn });
    }

    if (type === 'continue' && s.continue_prefill && messages.length) {
        const chatMessage = messages.shift()!;
        const isAssistant = chatMessage.role === 'assistant';
        const supportsPrefill = false; // V1:CLAUDE prefill 留 seam(source 相关)
        const assistantPrefill = isAssistant && supportsPrefill ? sub(s.assistant_prefill, deps) : '';
        const content = [assistantPrefill, chatMessage.content].filter((x) => x).join('\n\n');
        const continueMessage = await Message.createAsync(
            chatMessage.role,
            content,
            'continuePrefill',
            chatMessage.name && s.names_behavior === NAMES_COMPLETION ? sanitizeName(chatMessage.name) : undefined,
        );
        controlPrompts.add(continueMessage);
        chatCompletion.reserveBudget(continueMessage);
    }

    messages = await populationInjectionPrompts(absolutePrompts, messages, {
        maxDepth: deps.maxDepth ?? 100,
        getDepthInjection: deps.depthInjection,
    });

    if (s.pin_examples) {
        await populateDialogueExamples(prompts, chatCompletion, messageExamples, req, deps);
        await populateChatHistory(messages, prompts, chatCompletion, req, deps);
    } else {
        await populateChatHistory(messages, prompts, chatCompletion, req, deps);
        await populateDialogueExamples(prompts, chatCompletion, messageExamples, req, deps);
    }

    chatCompletion.freeBudget(controlPrompts);
    if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);
}

/**
 * promptBuilder seam 入口:PromptBuildRequest → BuiltPrompt(messages + trace)。
 * 对应原版 prepareOpenAIMessages。
 */
export async function buildPromptMessages(
    req: PromptBuildRequest,
    deps: AssembleDeps,
): Promise<BuiltPrompt> {
    const chatCompletion = new ChatCompletion();
    chatCompletion.setTokenBudget(req.contextTokens, req.responseTokens);

    const prompts = preparePrompts(req, deps);

    const messages = setOpenAIMessages(req.chat, {
        settings: req.settings,
        api: req.api,
        model: req.model,
        groupBotNames: deps.group?.botNames,
        name1: req.user.name,
        name2: req.card.name,
    });

    const chatCount = messages.length;

    // 对话示例块(parseExample → 块数组)
    const messageExamples: { role: string; content: string; name?: string }[][] = [];
    if (req.card.mesExample) {
        const blocks = req.card.mesExample.split(/<START>/i).map((b) => b.trim()).filter(Boolean);
        for (const block of blocks) {
            messageExamples.push(
                parseExampleIntoIndividual(block, { ...deps, name1: req.user.name, name2: req.card.name }),
            );
        }
    }

    await populateChatCompletion(prompts, chatCompletion, req, messages, messageExamples, deps);

    if (req.settings.squash_system_messages) {
        await chatCompletion.squashSystemMessages();
    }

    // 原版 MessageCollection.getChat()(openai.js:5693-5704):
    // content 为空(falsy)且无 tool_calls 的消息不上 wire——空 nsfw/jailbreak/空卡字段占位
    const flat = chatCompletion.messages.flatten();
    const finalMessages = flat.filter((m) => m.content || m.tool_calls).map((m) => {
        const out: Record<string, unknown> & { role: string } = { role: m.role, content: m.content };
        if (m.name) out.name = m.name;
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.signature) out.signature = m.signature;
        if (m.reasoning) out.reasoning = m.reasoning;
        if (m.reasoning_blocks) out.reasoning_blocks = m.reasoning_blocks;
        if (m.reasoning_details) out.reasoning_details = m.reasoning_details;
        return out as { role: string; content: unknown; name?: string };
    });

    // collection 是按 promptOrder 槽位预分配的稀疏数组——禁用/缺席槽
    // 是空洞,JSON 化变 null。诊断面滤掉空槽,只看实际进组装的段。
    const collections = chatCompletion.messages.collection
        .filter((c): c is NonNullable<typeof c> => c != null)
        .map((c) =>
            c instanceof MessageCollection
                ? { identifier: c.identifier, tokens: c.getTokens(), count: c.flatten().length }
                : { identifier: (c as Message).identifier, tokens: c.getTokens(), count: 1 },
        );

    const injectedCount = flat.filter((m) => m.injected).length;
    const historyCount = flat.filter((m) => m.identifier.startsWith('chatHistory')).length;

    return {
        messages: finalMessages,
        trace: {
            collections,
            tokenBudget: req.contextTokens - req.responseTokens,
            remainingBudget: chatCompletion.tokenBudget,
            droppedChatCount: Math.max(0, chatCount - historyCount),
            // TASK-034:进上下文的聊天层数(openai_messages_count 等价物)——
            // 浏览器短路后由 job.trace 回填 lastInContext,变量现成只差导出。
            chatHistoryCount: historyCount,
            injectedCount,
        },
    };
}
