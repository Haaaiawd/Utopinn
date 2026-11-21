/**
 * Legacy macro evaluator — ported from `public/scripts/macros.js evaluateMacros`
 * plus the built-in macro sources it aggregates (instruct/variable/time/random/pick/roll).
 * All environment access is injected through `MacroContext`.
 */
import droll from 'droll';
import moment from 'moment';
import seedrandom from 'seedrandom';
import { stringify as yamlStringify } from 'yaml';
import { escapeRegex, getStringHash, isDigitsOnly } from '../utils.js';
import {
    get as lodashGet,
    set as lodashSet,
} from '../mvu/lodash.js';
import {
    addVariable,
    decrementVariable,
    getVariable,
    incrementVariable,
    setVariable,
    type VarStore,
} from '../variables.js';

export interface Macro {
    regex: RegExp;
    replace: (...args: string[]) => string;
}

export interface MacroChatMessage {
    mes?: string;
    is_user?: boolean;
    is_system?: boolean;
    swipes?: unknown[];
    swipe_id?: number;
    send_date?: string | number;
    /**
     * TH/MVU 楼层变量袋:`variables[swipe_id]` = 该楼当前 swipe 槽位的
     * MvuData 快照(stat_data/schema/…)。message 域变量宏的读源 —
     * host 传活引用时 set_message_variable 的同请求回读才一致。
     */
    variables?: Record<string | number, unknown> | unknown[];
}

export interface MacroInstructSettings {
    enabled: boolean;
    story_string_prefix?: string;
    story_string_suffix?: string;
    input_sequence?: string;
    input_suffix?: string;
    output_sequence?: string;
    output_suffix?: string;
    system_sequence?: string;
    system_suffix?: string;
    first_output_sequence?: string;
    last_output_sequence?: string;
    user_alignment_message?: string;
    last_system_sequence?: string;
    first_input_sequence?: string;
    last_input_sequence?: string;
    stop_sequence?: string;
}

export interface MacroContext {
    /** Chat messages (chronological order). */
    chat: MacroChatMessage[];
    /** Mutable chat metadata (variables + chat_id_hash persist here). */
    chatMetadata: {
        variables?: VarStore;
        chat_id_hash?: number;
        lastInContextMessageId?: number;
        main_chat?: string;
        [key: string]: unknown;
    };
    /** Global (extension_settings.variables.global) store. */
    globalVariables: VarStore;
    /**
     * TH 'character'/'char' 域变量源 — 卡级变量,宿主绑
     * `card.data.extensions.tavern_helper.variables`(旧键
     * `TavernHelper_characterScriptVariables` 由宿主在绑定时折叠)。
     * 活引用;set_char_variable 直接改写,持久化取决于宿主写面。
     */
    charVariables?: VarStore;
    /**
     * TH 'preset' 域变量源 — `presetDoc.extensions.tavern_helper.variables`
     * 活引用(TH store/settings/preset.ts:预设 extensions.tavern_helper)。
     */
    presetVariables?: VarStore;
    /**
     * 变量写回钉(op 日志形):set_X_variable / setvar 家族每次写后 push
     * `{domain, path, value}`。宿主在组装末按域落盘
     * (message/chat→chat_metadata CAS;global→settings 整档;preset→preset
     * 文档;char→无卡写通道时记 volatile diag)。未提供 = 写仅活在请求内。
     */
    variableWrites?: { domain: string; path?: string; value?: unknown }[];
    /** Current chat id used for {{pick}} seeding when chat_id_hash is unset. */
    currentChatId?: string;
    /** Instruct + context-template settings. */
    instruct?: MacroInstructSettings;
    contextTemplate?: {
        example_separator?: string;
        chat_start?: string;
    };
    sysprompt?: { enabled: boolean; content?: string };
    preferCharacterPrompt?: boolean;
    /** Prompt size limits for {{maxPrompt}} etc. */
    limits?: { maxPrompt?: number; maxContext?: number; maxResponse?: number };
    /** {{input}} — current composer text. */
    input?: string;
    /** {{outlet::key}} lookup. */
    outletLookup?: (key: string) => string;
    /** First displayed message id (DOM in the original). */
    firstDisplayedMessageId?: number | null;
    /** Banned-words sink (textgen api only); also drains to '' otherwise. */
    bannedWords?: { collect: boolean; push: (word: string) => void };
    /** Clock — injectable for deterministic tests. */
    now?: Date;
    /** Registered extra macros (MacrosParser registry equivalent). */
    registeredMacros?: Record<string, string | ((nonce: string) => string)>;
    /** RNG for {{random}} / dice. Default Math.random. */
    rng?: () => number;
}

export type MacroEnvValue = string | number | ((nonce: string) => string | number);
export type MacroEnv = Record<string, MacroEnvValue>;

function uuidv4(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function sanitizeMacroValue(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value === null || value === undefined) {
        return '';
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function getChatIdHash(ctx: MacroContext): number {
    const meta = ctx.chatMetadata;
    const cachedIdHash = meta.chat_id_hash;
    if (!cachedIdHash) {
        const chatId = meta.main_chat ?? ctx.currentChatId ?? '';
        const chatIdHash = getStringHash(String(chatId));
        meta.chat_id_hash = chatIdHash;
        return chatIdHash;
    }
    return cachedIdHash;
}

function getLastMessageId(chat: MacroChatMessage[], { exclude_swipe_in_propress = true, filter = null as null | ((m: MacroChatMessage) => boolean) } = {}): number | null {
    for (let i = chat?.length - 1; i >= 0; i--) {
        const message = chat[i]!;
        if (exclude_swipe_in_propress && message.swipes && (message.swipe_id ?? 0) >= message.swipes.length) {
            continue;
        }
        if (!filter || filter(message)) {
            return i;
        }
    }
    return null;
}

function getLastMessage(chat: MacroChatMessage[]): string {
    const mid = getLastMessageId(chat);
    return (mid !== null ? chat[mid]?.mes : undefined) ?? '';
}

function getLastUserMessage(chat: MacroChatMessage[]): string {
    const mid = getLastMessageId(chat, { filter: m => !!m.is_user && !m.is_system });
    return (mid !== null ? chat[mid]?.mes : undefined) ?? '';
}

function getLastCharMessage(chat: MacroChatMessage[]): string {
    const mid = getLastMessageId(chat, { filter: m => !m.is_user && !m.is_system });
    return (mid !== null ? chat[mid]?.mes : undefined) ?? '';
}

function getLastSwipeId(chat: MacroChatMessage[]): number | undefined {
    const mid = getLastMessageId(chat, { exclude_swipe_in_propress: false });
    const swipes = mid !== null ? chat[mid]?.swipes : undefined;
    return swipes?.length;
}

function getCurrentSwipeId(chat: MacroChatMessage[]): number | null {
    const mid = getLastMessageId(chat, { exclude_swipe_in_propress: false });
    const swipeId = mid !== null ? chat[mid]?.swipe_id : undefined;
    return swipeId !== null && swipeId !== undefined ? swipeId + 1 : null;
}

/** `power_user.instruct` + `sysprompt` + context-template macros. */
function getInstructMacros(ctx: MacroContext, env: MacroEnv): Macro[] {
    const instruct = ctx.instruct;
    const sysprompt = ctx.sysprompt;
    const contextTemplate = ctx.contextTemplate;
    const instructMacros = [
        { key: 'instructStoryStringPrefix', value: instruct?.story_string_prefix, enabled: instruct?.enabled },
        { key: 'instructStoryStringSuffix', value: instruct?.story_string_suffix, enabled: instruct?.enabled },
        { key: 'instructInput|instructUserPrefix', value: instruct?.input_sequence, enabled: instruct?.enabled },
        { key: 'instructUserSuffix', value: instruct?.input_suffix, enabled: instruct?.enabled },
        { key: 'instructOutput|instructAssistantPrefix', value: instruct?.output_sequence, enabled: instruct?.enabled },
        { key: 'instructSeparator|instructAssistantSuffix', value: instruct?.output_suffix, enabled: instruct?.enabled },
        { key: 'instructSystemPrefix', value: instruct?.system_sequence, enabled: instruct?.enabled },
        { key: 'instructSystemSuffix', value: instruct?.system_suffix, enabled: instruct?.enabled },
        { key: 'instructFirstOutput|instructFirstAssistantPrefix', value: instruct?.first_output_sequence || instruct?.output_sequence, enabled: instruct?.enabled },
        { key: 'instructLastOutput|instructLastAssistantPrefix', value: instruct?.last_output_sequence || instruct?.output_sequence, enabled: instruct?.enabled },
        { key: 'instructStop', value: instruct?.stop_sequence, enabled: instruct?.enabled },
        { key: 'instructUserFiller', value: instruct?.user_alignment_message, enabled: instruct?.enabled },
        { key: 'instructSystemInstructionPrefix', value: instruct?.last_system_sequence, enabled: instruct?.enabled },
        { key: 'instructFirstInput|instructFirstUserPrefix', value: instruct?.first_input_sequence || instruct?.input_sequence, enabled: instruct?.enabled },
        { key: 'instructLastInput|instructLastUserPrefix', value: instruct?.last_input_sequence || instruct?.input_sequence, enabled: instruct?.enabled },
        {
            key: 'systemPrompt',
            value: ctx.preferCharacterPrompt && env['charPrompt'] ? env['charPrompt'] : sysprompt?.content,
            enabled: sysprompt?.enabled,
        },
        { key: 'defaultSystemPrompt|instructSystem|instructSystemPrompt', value: sysprompt?.content, enabled: sysprompt?.enabled },
        { key: 'chatSeparator', value: contextTemplate?.example_separator, enabled: true },
        { key: 'chatStart', value: contextTemplate?.chat_start, enabled: true },
    ];

    const macros: Macro[] = [];
    for (const { key, value, enabled } of instructMacros) {
        const regex = new RegExp(`{{(${key})}}`, 'gi');
        const replace = () => enabled ? String(value ?? '') : '';
        macros.push({ regex, replace });
    }
    return macros;
}

/**
 * TH `_.unescape` 路径还原 — 宏参数里的 HTML 实体
 * (&amp;/&lt;/&gt;/&quot;/&#39;)。TH macro_like getWithout$ 同款预处理,
 * 世界书/卡面手写的转义路径必须能命中变量键。
 */
function unescapeVarPath(path: string): string {
    return String(path)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/**
 * TH `omitDeepBy(_, key.startsWith('$'))` 等价 — 深遍历剔除 `$meta`/`$internal`
 * 等内部键(MVU stat_data 的 schema/缓存键不进 prompt 回显)。
 * 数组按元素映射;循环引用按首次出现剪枝(同 omitDeep 的迭代语义,防死循环)。
 */
function withoutInternalKeys(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        seen.set(value, out);
        for (const item of value) {
            out.push(withoutInternalKeys(item, seen));
        }
        return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) {
        if (key.startsWith('$')) {
            continue;
        }
        out[key] = withoutInternalKeys(item, seen);
    }
    return out;
}

/**
 * TH `chat.findLastIndex(m => _.isObject(m.variables?.[m.swipe_id ?? 0]))`:
 * 最新带「当前 swipe 槽位快照对象」的楼层 —— message 域的读/写目标。
 */
function latestMessageSnapshot(ctx: MacroContext): VarStore | null {
    const chat = ctx.chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i]!;
        const snapshot = message.variables?.[message.swipe_id ?? 0];
        if (snapshot !== null && typeof snapshot === 'object') {
            return snapshot as VarStore;
        }
    }
    return null;
}

/**
 * TH get_variables_without_clone 的域 → store 解析:
 *   message → 最新楼层快照,缺席回退 chat_metadata.variables
 *             (MVU 镜像 —— settle 每轮把 stat_data/schema 等顶层键
 *             同步进来;口径对齐 issue:聊天变量 = 快照读、镜像兜底)。
 *   chat    → chat_metadata.variables(ST {{setvar}} 同一 store)。
 *   char/character → ctx.charVariables(TH tavern_helper 卡级变量)。
 *   preset  → ctx.presetVariables(TH 预设 extensions.tavern_helper.variables)。
 *   global  → ctx.globalVariables(extension_settings.variables.global)。
 */
function variableDomainStore(ctx: MacroContext, domain: string): VarStore | null {
    switch (domain) {
        case 'message': {
            const snapshot = latestMessageSnapshot(ctx);
            if (snapshot) {
                return snapshot;
            }
            return (ctx.chatMetadata.variables ??= {});
        }
        case 'chat': {
            return (ctx.chatMetadata.variables ??= {});
        }
        case 'char':
        case 'character': {
            return ctx.charVariables ?? null;
        }
        case 'preset': {
            return ctx.presetVariables ?? null;
        }
        case 'global': {
            return (ctx.globalVariables ??= {});
        }
        default:
            return null;
    }
}

/** `{{set_*_variable::path::value}}` 的值解析:JSON 字面量优先,原样字符串兜底。 */
function parseMacroSetValue(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

const TH_VAR_DOMAIN_ALT = 'message|chat|character|char|preset|global';
const TH_FORMAT_VAR_RE = new RegExp(`^(.*)\\{\\{format_(${TH_VAR_DOMAIN_ALT})_variable::(.*?)\\}\\}`, 'im');
const TH_FORMAT_VAR_QUOTED_RE = new RegExp(`^(.*)\\{\\{format_(${TH_VAR_DOMAIN_ALT})_variable_quoted::(.*?)\\}\\}`, 'im');

/**
 * TH `applyFormatVariable` — `{{format_X_variable::path}}` 把域内 path 子树
 * 序列化成 YAML(`blockQuote:'literal'`,quoted 变体全量双引号),并按
 * 「行内前缀长度」对齐续行缩进(同一行可叠多个 format 宏,递归先解靠前者)。
 * 字符串原样输出(不包 YAML 引号),缺失路径 → 'null'。
 */
function applyFormatVariable(ctx: MacroContext, prefix: string, domain: string, path: string, { quoted = false } = {}): string {
    const innerRe = quoted ? TH_FORMAT_VAR_QUOTED_RE : TH_FORMAT_VAR_RE;
    const earlier = prefix.match(innerRe);
    if (earlier) {
        prefix = applyFormatVariable(ctx, earlier[1]!, earlier[2]!, earlier[3]!, { quoted })
            + prefix.slice(earlier[0].length);
    }
    const store = variableDomainStore(ctx, domain);
    const value = withoutInternalKeys(lodashGet(store ?? {}, unescapeVarPath(path)) ?? null);
    const rendered = typeof value === 'string'
        ? value
        : yamlStringify(value, quoted
            ? { blockQuote: 'literal', defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' }
            : { blockQuote: 'literal' }).trimEnd();
    return prefix + rendered.replaceAll('\n', '\n' + ' '.repeat(prefix.length));
}

/**
 * `{{set_X_variable::path::value}}` — 宏展开为空串但执行域写(TH replaceVariables
 * 语义;持久化由宿主按 ctx.variableWrites 落盘,宏本身不保证写穿)。
 * message 域双写:楼层快照(请求内回读一致)+ chat_metadata.variables 镜像
 * ({{getvar}}/chat 域读同键、updateChatMetadata 持久通道)。
 */
function applySetVariable(ctx: MacroContext, domain: string, path: string, rawValue: string): void {
    const value = parseMacroSetValue(rawValue);
    const p = unescapeVarPath(path);
    switch (domain) {
        case 'message': {
            const snapshot = latestMessageSnapshot(ctx);
            if (snapshot) {
                lodashSet(snapshot, p, value);
            }
            lodashSet((ctx.chatMetadata.variables ??= {}), p, value);
            ctx.variableWrites?.push({ domain: 'message', path: p, value });
            break;
        }
        case 'chat': {
            lodashSet((ctx.chatMetadata.variables ??= {}), p, value);
            ctx.variableWrites?.push({ domain: 'chat', path: p, value });
            break;
        }
        case 'char':
        case 'character': {
            lodashSet((ctx.charVariables ??= {}), p, value);
            ctx.variableWrites?.push({ domain: 'char', path: p, value });
            break;
        }
        case 'preset': {
            lodashSet((ctx.presetVariables ??= {}), p, value);
            ctx.variableWrites?.push({ domain: 'preset', path: p, value });
            break;
        }
        case 'global': {
            lodashSet((ctx.globalVariables ??= {}), p, value);
            ctx.variableWrites?.push({ domain: 'global', path: p, value });
            break;
        }
    }
}

/** {{setvar/getvar/...}} local + global variable macros + TH/MVU 三域变量宏家族。 */
function getVariableMacros(ctx: MacroContext): Macro[] {
    const local = () => {
        if (!ctx.chatMetadata.variables) {
            ctx.chatMetadata.variables = {};
        }
        return ctx.chatMetadata.variables;
    };
    const global = () => ctx.globalVariables;
    const markLocal = (path?: string, value?: unknown) => ctx.variableWrites?.push({ domain: 'chat', path, value });
    const markGlobal = (path?: string, value?: unknown) => ctx.variableWrites?.push({ domain: 'global', path, value });

    return [
        { regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: (_m, name, value) => { setVariable(local(), name.trim(), value); markLocal(name.trim(), value); return ''; } },
        { regex: /{{addvar::([^:]+)::([^}]+)}}/gi, replace: (_m, name, value) => { addVariable(local(), name.trim(), value); markLocal(name.trim()); return ''; } },
        { regex: /{{incvar::([^}]+)}}/gi, replace: (_m, name) => { const v = incrementVariable(local(), name.trim()); markLocal(name.trim(), v); return String(v ?? ''); } },
        { regex: /{{decvar::([^}]+)}}/gi, replace: (_m, name) => { const v = decrementVariable(local(), name.trim()); markLocal(name.trim(), v); return String(v ?? ''); } },
        { regex: /{{getvar::([^}]+)}}/gi, replace: (_m, name) => String(getVariable(local(), name.trim()) ?? '') },
        { regex: /{{setglobalvar::([^:]+)::([^}]*)}}/gi, replace: (_m, name, value) => { setVariable(global(), name.trim(), value); markGlobal(name.trim(), value); return ''; } },
        { regex: /{{addglobalvar::([^:]+)::([^}]+)}}/gi, replace: (_m, name, value) => { addVariable(global(), name.trim(), value); markGlobal(name.trim()); return ''; } },
        { regex: /{{incglobalvar::([^}]+)}}/gi, replace: (_m, name) => { const v = incrementVariable(global(), name.trim()); markGlobal(name.trim(), v); return String(v ?? ''); } },
        { regex: /{{decglobalvar::([^}]+)}}/gi, replace: (_m, name) => { const v = decrementVariable(global(), name.trim()); markGlobal(name.trim(), v); return String(v ?? ''); } },
        { regex: /{{getglobalvar::([^}]+)}}/gi, replace: (_m, name) => String(getVariable(global(), name.trim()) ?? '') },

        // —— TH/MVU 变量宏家族(TASK issue#2):set/get/format_quoted/format ×
        //    message|chat|character|char|preset|global。
        //    过序约定:set 先跑整串 → 同串里文本位置在后的 get/format 读到
        //    set 后的状态(与上方 setvar→getvar 原生顺序一致);format 收尾,
        //    其行内前缀里不应再残留未展开的变量宏(TH macro_like 同款顺序)。 ——
        {
            regex: new RegExp(`\\{\\{set_(${TH_VAR_DOMAIN_ALT})_variable::(.*?)::([\\s\\S]*?)\\}\\}`, 'gi'),
            replace: (_m, domain, path, rawValue) => {
                applySetVariable(ctx, domain, path, rawValue);
                return '';
            },
        },
        {
            regex: new RegExp(`\\{\\{get_(${TH_VAR_DOMAIN_ALT})_variable::(.*?)\\}\\}`, 'gi'),
            replace: (_m, domain, path) => {
                const store = variableDomainStore(ctx, domain);
                const value = withoutInternalKeys(lodashGet(store ?? {}, unescapeVarPath(path)) ?? null);
                return typeof value === 'string' ? value : JSON.stringify(value);
            },
        },
        {
            regex: new RegExp(`^(.*)\\{\\{format_(${TH_VAR_DOMAIN_ALT})_variable_quoted::(.*?)\\}\\}`, 'gim'),
            replace: (_m, prefix, domain, path) => applyFormatVariable(ctx, prefix, domain, path, { quoted: true }),
        },
        {
            regex: new RegExp(`^(.*)\\{\\{format_(${TH_VAR_DOMAIN_ALT})_variable::(.*?)\\}\\}`, 'gim'),
            replace: (_m, prefix, domain, path) => applyFormatVariable(ctx, prefix, domain, path),
        },
    ];
}

function getDiceRollMacro(rng: () => number): Macro {
    const rollPattern = /{{roll[ : ]([^}]+)}}/gi;
    const rollReplace = (_match: string, matchValue: string) => {
        let formula = matchValue.trim();
        if (isDigitsOnly(formula)) {
            formula = `1d${formula}`;
        }
        if (!droll.validate(formula)) {
            return '';
        }
        // droll accepts a custom RNG via droll.roll(formula, rng)? — it uses
        // Math.random internally; swap temporarily for determinism in tests.
        const original = Math.random;
        try {
            (Math as { random: () => number }).random = rng;
            const result = droll.roll(formula);
            if (result === false) return '';
            return String(result.total);
        } finally {
            (Math as { random: () => number }).random = original;
        }
    };
    return { regex: rollPattern, replace: rollReplace };
}

function getTimeSinceLastMessage(ctx: MacroContext, now: moment.Moment): string {
    const chat = ctx.chat;
    if (Array.isArray(chat) && chat.length > 0) {
        let lastMessage: MacroChatMessage | undefined;
        let takeNext = false;

        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i]!;
            if (message.is_system) {
                continue;
            }
            if (message.is_user && takeNext) {
                lastMessage = message;
                break;
            }
            takeNext = true;
        }

        if (lastMessage?.send_date) {
            const lastMessageDate = moment(lastMessage.send_date);
            const duration = moment.duration(now.diff(lastMessageDate));
            return duration.humanize();
        }
    }
    return 'just now';
}

function getRandomReplaceMacro(): Macro {
    const randomPattern = /{{random\s?::?([^}]+)}}/gi;
    const randomReplace = (_match: string, listString: string) => {
        const list = listString.includes('::')
            ? listString.split('::')
            : listString.replace(/\\,/g, '##�COMMA�##').split(',').map(item => item.trim().replace(/##�COMMA�##/g, ','));
        if (list.length === 0) {
            return '';
        }
        const rng = seedrandom('added entropy.', { entropy: true });
        const randomIndex = Math.floor(rng() * list.length);
        return list[randomIndex]!;
    };
    return { regex: randomPattern, replace: randomReplace };
}

function getPickReplaceMacro(rawContent: string, ctx: MacroContext): Macro {
    const chatIdHash = getChatIdHash(ctx);
    const rawContentHash = getStringHash(rawContent);
    const pickPattern = /{{pick\s?::?([^}]+)}}/gi;
    const pickReplace = (_match: string, listString: string, offset: string | number) => {
        const list = listString.includes('::')
            ? listString.split('::')
            : listString.replace(/\\,/g, '##�COMMA�##').split(',').map(item => item.trim().replace(/##�COMMA�##/g, ','));
        if (list.length === 0) {
            return '';
        }
        const combinedSeedString = `${chatIdHash}-${rawContentHash}-${offset}`;
        const finalSeed = getStringHash(combinedSeedString);
        // @ts-ignore - seedrandom accepts numeric seeds at runtime
        const rng = seedrandom(finalSeed);
        const randomIndex = Math.floor(rng() * list.length);
        return list[randomIndex]!;
    };
    return { regex: pickPattern, replace: pickReplace };
}

function getTimeDiffMacro(): Macro {
    const timeDiffPattern = /{{timeDiff::(.*?)::(.*?)}}/gi;
    const timeDiffReplace = (_m: string, matchPart1: string, matchPart2: string) => {
        const time1 = moment(matchPart1);
        const time2 = moment(matchPart2);
        const timeDifference = moment.duration(time1.diff(time2));
        return timeDifference.humanize(true);
    };
    return { regex: timeDiffPattern, replace: timeDiffReplace };
}

function getBannedWordsMacro(ctx: MacroContext): Macro {
    const banPattern = /{{banned "(.*)"}}/gi;
    const banReplace = (_match: string, bannedWord: string) => {
        if (ctx.bannedWords?.collect) {
            ctx.bannedWords.push(bannedWord);
        }
        return '';
    };
    return { regex: banPattern, replace: banReplace };
}

/**
 * Substitutes {{macro}} parameters in a string.
 * Faithful port of `macros.js evaluateMacros`.
 *
 * @param content The string to substitute parameters in.
 * @param env Map of macro names to values (functions called with nonce).
 * @param postProcessFn Function run on each substituted value.
 * @param ctx Injected environment (chat, stores, settings, clock, rng).
 */
export function evaluateMacros(
    content: string,
    env: MacroEnv,
    postProcessFn: (x: string) => string = (x) => x,
    ctx: MacroContext,
): string {
    if (!content) {
        return '';
    }

    if (typeof postProcessFn !== 'function') {
        postProcessFn = (x) => x;
    }
    const rawContent = content;
    const rng = ctx.rng ?? Math.random;
    const now = moment(ctx.now ?? new Date());
    const chat = ctx.chat ?? [];

    const ESCAPE_SENTINEL = 'ESC_MACRO_OPEN';
    if (content.includes('\\{{')) {
        content = content.replace(/\\\{\{/g, ESCAPE_SENTINEL);
    }

    // <USER>/<CHAR>/... call env functions with NO args (faithful to original)
    const envString = (key: string): string => {
        const v = env[key];
        const value = typeof v === 'function' ? (v as () => unknown)() : v;
        return String(value ?? '');
    };

    /** Built-ins running before the env variables */
    const preEnvMacros: Macro[] = [
        { regex: /<USER>/gi, replace: () => envString('user') },
        { regex: /<BOT>/gi, replace: () => envString('char') },
        { regex: /<CHAR>/gi, replace: () => envString('char') },
        { regex: /<CHARIFNOTGROUP>/gi, replace: () => envString('group') },
        { regex: /<GROUP>/gi, replace: () => envString('group') },
        getDiceRollMacro(rng),
        ...getInstructMacros(ctx, env),
        ...getVariableMacros(ctx),
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
        { regex: /{{input}}/gi, replace: () => String(ctx.input ?? '') },
    ];

    /** Built-ins running after the env variables */
    const postEnvMacros: Macro[] = [
        { regex: /{{maxPrompt}}/gi, replace: () => String(ctx.limits?.maxPrompt ?? '') },
        { regex: /{{maxPromptTokens}}/gi, replace: () => String(ctx.limits?.maxPrompt ?? '') },
        { regex: /{{maxContext}}/gi, replace: () => String(ctx.limits?.maxContext ?? '') },
        { regex: /{{maxContextTokens}}/gi, replace: () => String(ctx.limits?.maxContext ?? '') },
        { regex: /{{maxResponse}}/gi, replace: () => String(ctx.limits?.maxResponse ?? '') },
        { regex: /{{maxResponseTokens}}/gi, replace: () => String(ctx.limits?.maxResponse ?? '') },
        { regex: /{{lastMessage}}/gi, replace: () => getLastMessage(chat) },
        { regex: /{{lastMessageId}}/gi, replace: () => String(getLastMessageId(chat) ?? '') },
        { regex: /{{lastUserMessage}}/gi, replace: () => getLastUserMessage(chat) },
        { regex: /{{lastCharMessage}}/gi, replace: () => getLastCharMessage(chat) },
        { regex: /{{firstIncludedMessageId}}/gi, replace: () => String(ctx.chatMetadata.lastInContextMessageId ?? '') },
        { regex: /{{firstDisplayedMessageId}}/gi, replace: () => String(ctx.firstDisplayedMessageId ?? '') },
        { regex: /{{lastSwipeId}}/gi, replace: () => String(getLastSwipeId(chat) ?? '') },
        { regex: /{{currentSwipeId}}/gi, replace: () => String(getCurrentSwipeId(chat) ?? '') },
        { regex: /{{allChatRange}}/gi, replace: () => chat.length === 0 ? '' : `0-${chat.length - 1}` },
        { regex: /{{reverse:(.+?)}}/gi, replace: (_m, str) => Array.from(str).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
        { regex: /{{time}}/gi, replace: () => now.format('LT') },
        { regex: /{{date}}/gi, replace: () => now.format('LL') },
        { regex: /{{weekday}}/gi, replace: () => now.format('dddd') },
        { regex: /{{isotime}}/gi, replace: () => now.format('HH:mm') },
        { regex: /{{isodate}}/gi, replace: () => now.format('YYYY-MM-DD') },
        { regex: /{{datetimeformat +([^}]*)}}/gi, replace: (_m, format) => now.format(format) },
        { regex: /{{idle_duration}}/gi, replace: () => getTimeSinceLastMessage(ctx, now) },
        { regex: /{{time_UTC([-+]\d+)}}/gi, replace: (_m, offset) => now.clone().utc().utcOffset(parseInt(offset, 10)).format('LT') },
        { regex: /{{outlet::(.+?)}}/gi, replace: (_m, key) => ctx.outletLookup?.(key.trim()) || '' },
        getTimeDiffMacro(),
        getBannedWordsMacro(ctx),
        getRandomReplaceMacro(),
        getPickReplaceMacro(rawContent, ctx),
    ];

    // Registered macros join the env (MacrosParser.populateEnv equivalent)
    const fullEnv: MacroEnv = { ...env };
    for (const [key, value] of Object.entries(ctx.registeredMacros ?? {})) {
        fullEnv[key] = value;
    }

    const nonce = uuidv4();
    const envMacros: Macro[] = [];
    for (const varName in fullEnv) {
        if (!Object.hasOwn(fullEnv, varName)) continue;
        const envRegex = new RegExp(`{{${escapeRegex(varName)}}}`, 'gi');
        const envReplace = () => {
            const param = fullEnv[varName]!;
            const value = sanitizeMacroValue(typeof param === 'function' ? param(nonce) : param);
            return value;
        };
        envMacros.push({ regex: envRegex, replace: envReplace });
    }

    const macros = [...preEnvMacros, ...envMacros, ...postEnvMacros];

    for (const macro of macros) {
        if (!content) {
            break;
        }
        if (!macro.regex.source.startsWith('<') && !content.includes('{{')) {
            break;
        }
        try {
            content = content.replace(macro.regex, (...args) => {
                const replaced = macro.replace(...(args as [string, ...string[]]));
                return postProcessFn(String(replaced));
            });
        } catch (e) {
            console.warn(`Macro content can't be replaced: ${macro.regex} in ${content}`, e);
        }
    }

    if (content.includes(ESCAPE_SENTINEL)) {
        content = content.split(ESCAPE_SENTINEL).join('\\{{');
    }

    return content;
}
