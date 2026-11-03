/**
 * Regex 引擎类型 — 移植自 Luker
 * `public/scripts/extensions/regex/engine.js` 与 `char-data.js RegexScriptData`。
 * 枚举数值与原版逐一对应,勿改。
 */

/**
 * @readonly
 * regex_placement — 脚本应用位置。4 为 sendAs(legacy)空位,保留跳号。
 */
export const regex_placement = {
    /** @deprecated MD Display is deprecated. Do not use. */
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    // 4 - sendAs (legacy)
    WORLD_INFO: 5,
    REASONING: 6,
} as const;

export type RegexPlacement = (typeof regex_placement)[keyof typeof regex_placement];

/**
 * @readonly
 * substitute_find_regex — findRegex 里 {{macro}} 的替换方式。
 */
export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
} as const;

export type SubstituteFindRegex = (typeof substitute_find_regex)[keyof typeof substitute_find_regex];

/**
 * @readonly
 * SCRIPT_TYPES — 持久化脚本来源。
 * 声明顺序即优先级:Object.values → [GLOBAL, PRESET, SCOPED],
 * getRegexScripts 依此拼接,顺序决定多脚本流水线次序。
 */
export const SCRIPT_TYPES = {
    // ORDER MATTERS: defines the regex script priority
    GLOBAL: 0,
    PRESET: 2,
    SCOPED: 1,
} as const;

/** Special type for unknown/invalid script types. */
export const SCRIPT_TYPE_UNKNOWN = -1;

export type ScriptType = (typeof SCRIPT_TYPES)[keyof typeof SCRIPT_TYPES] | typeof SCRIPT_TYPE_UNKNOWN;

export type RegexPluginLane = 'request' | 'reply';

/**
 * RegexScript — 对应原版 RegexScriptData。
 * 字段名保持持久化形状;导入数据可能缺字段,引擎按原版容错读取。
 */
export interface RegexScript {
    /** UUID of the script */
    id: string;
    /** The name of the script */
    scriptName: string;
    /** The regex to find */
    findRegex: string;
    /** The string to replace */
    replaceString: string;
    /** The strings to trim */
    trimStrings: string[];
    /** The placement of the script(数值数组;非法值会被跳过) */
    placement?: number[] | null;
    /** Whether the script is disabled */
    disabled?: boolean;
    /** Whether the script only applies to Markdown(显示/渲染路径) */
    markdownOnly?: boolean;
    /** Whether the script only applies to prompts(仅提示用途) */
    promptOnly?: boolean;
    /** 插件应用点:request = 送入插件请求的文本;reply = 插件请求返回的助手文本 */
    pluginLanes?: RegexPluginLane[];
    /** 旧持久化字段:等价于 pluginLanes = ['request', 'reply'] */
    pluginOnly?: boolean;
    /** Whether the script runs on edit */
    runOnEdit?: boolean;
    /** Whether the regex should be substituted(substitute_find_regex) */
    substituteRegex?: number;
    /** The minimum depth(null/undefined = 不限) */
    minDepth?: number | null;
    /** The maximum depth(null/undefined = 不限) */
    maxDepth?: number | null;
    /** 用户已允许慢执行,ReDoS 检测不再自动暂停 */
    allowSlow?: boolean;
}

/** getRegexedString 的第三个参数(RegexParams)+ 服务端注入缝。 */
export interface RegexParams {
    characterOverride?: string;
    isMarkdown?: boolean;
    isPrompt?: boolean;
    isPluginInput?: boolean;
    isPluginOutput?: boolean;
    isEdit?: boolean;
    /** null/undefined = 不做深度过滤(原版 typeof depth === 'number' 判定) */
    depth?: number | null;
    /**
     * 注入:本轮参与过滤的脚本集,等价原版
     * `getRegexScripts({ allowedOnly: true })` 的返回。
     */
    scripts?: readonly RegexScript[];
    /** 注入:等价 `extension_settings.disabledExtensions.includes('regex')`。 */
    regexDisabled?: boolean;
    /** 注入:等价 `extension_settings.regex_perf_detection !== false`,默认开启。 */
    perfDetection?: boolean;
    /** 注入:计时源(原版 performance.now),默认 Date.now。 */
    now?: () => number;
}

/** runRegexScript 的第三个参数(RegexScriptParams)。 */
export interface RegexScriptParams {
    characterOverride?: string;
}

/** getRegexScripts 的脚本来源(等价全局/预设/卡级/运行时四类持久化槽位)。 */
export interface RegexScriptSources {
    global?: readonly RegexScript[] | null;
    preset?: readonly RegexScript[] | null;
    scoped?: readonly RegexScript[] | null;
    /** 运行时脚本(原版 registerRegexProvider 提供),需带非空 scriptName。 */
    runtime?: readonly RegexScript[] | null;
}
