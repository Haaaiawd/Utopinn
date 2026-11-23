/**
 * /inject 命令族 — 移植自 ref/Luker public/scripts/slash-commands.js:
 * injectCallback / listInjectsCallback / flushInjectsCallback,
 * 以及 consumeEphemeralScriptInjectsForMainGeneration(服务端导出给
 * 生成链调用,trigger-generation.js 接线)。
 *
 * 写侧落点 = chat_metadata.script_injects:
 *   generate-context.js 每次生成把它并入 mergedExtPrompts
 *   (script_inject_<id> 键 —— 即上游 processChatSlashCommands 的
 *   「每轮重建 extension_prompts」等价物)。服务端没有常驻
 *   extensionPrompts 运行时表,写 metadata + persistMetadata 即全链;
 *   上游 inject 同时调的 setExtensionPrompt 在这里无对应物,也不需要。
 * 记录形状照抄 Luker:{value,position,depth,scan,role,filter,ephemeral}
 *   —— 读侧把条目原样当 extension_prompts 值消费(value/position/
 *   depth/scan/role 五键;filter 是闭包 rawText,服务端组装不求值,
 *   仅持久化留档;ephemeral 由生成链消费,非 quiet 生成终态清除)。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandEnumValue, enumTypes, enumIcons, booleanEnumProvider } from '../types.js';
import { SlashCommandClosure } from '../closure.js';
import { isTrueBoolean } from '../util.js';
import type { StscriptEnv, ScriptInjectRecord } from '../env.js';
import { addCommandObject } from '../registry.js';
import { doReturn, returnEnumList } from './common.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

/** extension_prompt_types 原值(与 assemble.ts EXT_* / extension-prompts.js 同号)。 */
const POSITIONS: Record<string, number> = {
    'before': 2,
    'after': 0,
    'chat': 1,
    'none': -1,
};

/** extension_prompt_roles 原值。 */
const ROLES: Record<string, number> = {
    'system': 0,
    'user': 1,
    'assistant': 2,
};

/** /listinjects 展示名:Object.entries(extension_prompt_types) 查得的键名(上游同款)。 */
const POSITION_NAMES: Record<number, string> = {
    [-1]: 'NONE',
    [0]: 'IN_PROMPT',
    [1]: 'IN_CHAT',
    [2]: 'BEFORE_PROMPT',
};

/** chat_metadata.script_injects 活对象(缺省自动初始化,与上游一致)。 */
function injectsStore(env: StscriptEnv): Record<string, ScriptInjectRecord> {
    const md = env.macro.chatMetadata as Record<string, unknown>;
    if (!md['script_injects'] || typeof md['script_injects'] !== 'object') {
        md['script_injects'] = {};
    }
    return md['script_injects'] as Record<string, ScriptInjectRecord>;
}

/** Luker injectCallback:value 非空 → upsert;空 → 删除。返回注入 id。 */
export function injectCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    const id = String(args?.id ?? '') || Math.random().toString(36).substring(2);
    const ephemeral = isTrueBoolean(String(args?.ephemeral ?? ''));

    const defaultPosition = 'after';
    const defaultDepth = 4;
    const positionValue = String(args?.position ?? defaultPosition);
    const position = POSITIONS[positionValue] ?? POSITIONS[defaultPosition] ?? 0;
    const depthValue = Number(args?.depth ?? defaultDepth);
    const depth = isNaN(depthValue) ? defaultDepth : depthValue;
    // 上游:字符串 role 名 → 枚举;非字符串按 Number 折(非法 → SYSTEM)
    const roleValue = typeof args?.role === 'string' ? args.role.toLowerCase().trim() : Number(args?.role ?? ROLES['system']);
    const role = ROLES[roleValue as string] ?? ROLES['system'] ?? 0;
    const scan = isTrueBoolean(String(args?.scan));
    const filter = args?.filter instanceof SlashCommandClosure ? (args.filter.rawText ?? null) : null;
    const text = String(Array.isArray(value) ? value.join(' ') : value ?? '');

    if (args?.filter && !String(filter ?? '').trim()) {
        throw new Error('Failed to parse the filter argument. Make sure it is a valid non-empty closure.');
    }

    const store = injectsStore(env);
    if (text) {
        const inject: ScriptInjectRecord = { value: text, position, depth, scan, role, filter, ephemeral };
        store[id] = inject;
        env.ops.push({ type: 'inject', id, inject });
    } else {
        delete store[id];
        env.ops.push({ type: 'inject', id, inject: null });
    }
    env.host.persistMetadata?.();

    return id;
}

/** Luker listInjectsCallback:return= 通道,默认 popup-html。 */
export async function listInjectsCallback(args: NamedArguments): Promise<unknown> {
    const env = envOf(args);
    const returnType = String(args?.['return'] ?? 'popup-html');
    const injects = (env.macro.chatMetadata?.['script_injects'] ?? {}) as Record<string, ScriptInjectRecord>;

    const buildTextValue = (o: unknown): string => {
        const injectsStr = Object.entries(o as Record<string, ScriptInjectRecord>)
            .map(([id, inject]) => {
                const positionName = POSITION_NAMES[inject.position] ?? 'unknown';
                return `* **${id}**: <code>${inject.value}</code> (${positionName}, depth: ${inject.depth}, scan: ${inject.scan ?? false}, role: ${inject.role ?? ROLES['system']})`;
            })
            .join('\n');
        return `### Script injections:\n${injectsStr || 'No script injections for the current chat'}`;
    };

    return await doReturn(env, returnType, injects, { objectToStringFunc: buildTextValue });
}

/** Luker flushInjectsCallback:id → 删单条;无参 → 全清。返回空串。 */
export function flushInjectsCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    const md = env.macro.chatMetadata as Record<string, unknown>;
    if (!md['script_injects'] || typeof md['script_injects'] !== 'object') {
        return '';
    }
    const store = md['script_injects'] as Record<string, ScriptInjectRecord>;
    const idArgument = String(Array.isArray(value) ? value.join(' ') : value ?? '');

    let touched = false;
    for (const id of Object.keys(store)) {
        if (idArgument && id !== idArgument) continue;
        delete store[id];
        env.ops.push({ type: 'inject', id, inject: null });
        touched = true;
    }
    if (touched) env.host.persistMetadata?.();
    return '';
}

/**
 * Luker consumeEphemeralScriptInjectsForMainGeneration —— 非 quiet 生成
 * 生命周期终态(成功/失败/停止同口径,上游 hideStopButton 同点)清除
 * ephemeral 标记的注入。quiet/辅助生成不得消费一次性 inject。
 * 服务端由 trigger-generation.js 在终态调用;持久化是调用方职责
 * (返回 >0 时 updateChatMetadata)。
 * @returns 清除的条目数
 */
export function consumeEphemeralScriptInjects(chatMetadata: Record<string, unknown> | null | undefined): number {
    if (!chatMetadata || typeof chatMetadata !== 'object') return 0;
    const store = chatMetadata['script_injects'];
    if (!store || typeof store !== 'object') return 0;
    let removed = 0;
    for (const [id, inject] of Object.entries(store as Record<string, ScriptInjectRecord>)) {
        if (!inject || inject.ephemeral !== true) continue;
        delete (store as Record<string, ScriptInjectRecord>)[id];
        removed += 1;
    }
    return removed;
}

export function registerInjectCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'inject',
        returns: 'injection ID',
        callback: (args, value) => injectCallback(args, value),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'id',
                description: 'injection ID',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            new SlashCommandNamedArgument(
                'position', 'injection position', [ARGUMENT_TYPE.STRING], false, false, 'after', ['before', 'after', 'chat', 'none'],
            ),
            new SlashCommandNamedArgument(
                'depth', 'injection depth', [ARGUMENT_TYPE.NUMBER], false, false, '4',
            ),
            new SlashCommandNamedArgument(
                'scan', 'include injection content into World Info scans', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false', booleanEnumProvider('trueFalse')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'role',
                description: 'role for in-chat injections',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('assistant', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('user', null, enumTypes.enum, enumIcons.user),
                ],
            }),
            new SlashCommandNamedArgument(
                'ephemeral', 'remove injection after generation', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false', booleanEnumProvider('trueFalse')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'filter',
                description: 'if a filter is defined, an injection will only be performed if the closure returns true',
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text', [ARGUMENT_TYPE.STRING], false),
        ],
        helpString: 'Injects a text into the LLM prompt for the current chat. Requires a unique injection ID (auto-generated if not provided). Positions: "before" main prompt, "after" main prompt, in-"chat", hidden with "none" (default: after). Depth: injection depth (default: 4). Role: role for in-chat injections (default: system). Scan: include content into World Info scans (default: false). Ephemeral: removed after next non-quiet generation. Empty text deletes the injection. Returns the injection ID.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'listinjects',
        callback: (args) => listInjectsCallback(args),
        returns: 'Optionally the JSON object of script injections',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'The way how you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'popup-html',
                enumList: returnEnumList({ allowPipe: false, allowObject: true, allowChat: true, allowPopup: true, allowTextVersion: false }),
                forceEnum: true,
            }),
        ],
        helpString: 'Lists all script injections for the current chat. Displays injects in a popup by default. Use the return argument to change the return type.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'flushinject',
        aliases: ['flushinjects'],
        callback: (args, value) => flushInjectsCallback(args, value),
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'injection ID or a variable name pointing to ID',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Removes a script injection for the current chat. If no ID is provided, removes all script injections.',
    }));
}
