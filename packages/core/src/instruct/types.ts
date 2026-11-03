/**
 * Instruct-mode 类型 —— 移植自 Luker `public/scripts/instruct-mode.js`
 * 与 `power-user.js` 的 `power_user.instruct` / `power_user.context` 默认字段。
 * `InstructSettings = typeof power_user.instruct` 同构。
 */
import type { SubstituteContext } from '../macros/substitute.js';

/** 原版 `names_behavior_types`(instruct-mode.js:17-21) */
export const names_behavior_types = {
    NONE: 'none',
    FORCE: 'force',
    ALWAYS: 'always',
} as const;

export type InstructNamesBehavior = (typeof names_behavior_types)[keyof typeof names_behavior_types];

/** 原版 `force_output_sequence`(instruct-mode.js:369-372) */
export const force_output_sequence = {
    FIRST: 1,
    LAST: 2,
} as const;

export type ForceOutputSequence = (typeof force_output_sequence)[keyof typeof force_output_sequence] | false | 0;

/** script.js `extension_prompt_types`(:1456-1461)—— story_string_position 用同一编号 */
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
} as const;

/**
 * `power_user.instruct` 同构(power-user.js:274-301)。
 * 预设条目同样用这个类型(原版 `InstructSettings[]`,`name` 携带预设名;
 * `enabled` 在预设上通常缺省——引擎按原版注释"Since preset's don't have
 * 'enabled', we assume it's always enabled"处理)。
 */
export interface InstructSettings {
    enabled: boolean;
    preset?: string;
    /** 预设名(instruct_presets 条目才有) */
    name?: string;
    input_sequence?: string;
    input_suffix?: string;
    output_sequence?: string;
    output_suffix?: string;
    system_sequence?: string;
    system_suffix?: string;
    last_system_sequence?: string;
    first_input_sequence?: string;
    first_output_sequence?: string;
    last_input_sequence?: string;
    last_output_sequence?: string;
    story_string_prefix?: string;
    story_string_suffix?: string;
    stop_sequence?: string;
    wrap?: boolean;
    macro?: boolean;
    names_behavior?: InstructNamesBehavior | string;
    activation_regex?: string;
    bind_to_context?: boolean;
    user_alignment_message?: string;
    system_same_as_user?: boolean;
    sequences_as_stop_strings?: boolean;
    skip_examples?: boolean;
    /** @deprecated 由 migrateInstructModeSettings 迁入 output_suffix */
    separator_sequence?: string;
    /** @deprecated 由 migrate 消化为 names_behavior */
    names?: boolean;
    /** @deprecated 同上 */
    names_force_groups?: boolean;
    /** @deprecated 废弃字段,migrate 删除 */
    system_sequence_prefix?: string;
    /** @deprecated 废弃字段,migrate 删除 */
    system_sequence_suffix?: string;
    /** @deprecated 旧字段,宿主侧迁到 power_user.instruct_derived */
    derived?: boolean;
    [key: string]: unknown;
}

/**
 * `power_user.context` 中 instruct 引擎读到的字段(power-user.js:303-313)。
 * 基座形状与 MacroContext.contextTemplate 兼容(超集)。
 */
export interface InstructContextSettings {
    preset?: string;
    story_string?: string;
    chat_start?: string;
    example_separator?: string;
    use_stop_strings?: boolean;
    names_as_stop_strings?: boolean;
    /** extension_prompt_types 编号 */
    story_string_position?: number;
    story_string_role?: number;
    story_string_depth?: number;
}

/** `parseExampleIntoIndividual` 产出的单条样例消息(openai.js) */
export interface ParsedExampleMessage {
    role: string;
    content: string;
    /** 'example_user' | 'example_assistant' */
    name: string;
}

/**
 * Instruct 引擎上下文 —— SubstituteContext 超集。
 * 原版的全部全局量(power_user.instruct / power_user.context / name1 / name2 /
 * selected_group / getGroupNames / instruct_presets / context_presets /
 * model_templates_mappings)在这里都成为注入字段;
 * `substituteParams` 直接吃这个 ctx(含 instruct/contextTemplate 宏面)。
 */
export interface InstructEngineContext extends SubstituteContext {
    /** `power_user.instruct` 全字段 */
    instruct?: InstructSettings;
    /** `power_user.context` 模板字段 */
    contextTemplate?: InstructContextSettings;
    /** `getGroupNames()` 等价物:当前群成员显示名(selectedGroup 为空时无意义) */
    groupMemberNames?: string[];
    /** `instruct_presets` 列表 */
    instructPresets?: InstructSettings[];
    /** `context_presets` 列表(只读 name) */
    contextPresets?: { name?: string }[];
    /** `power_user.model_templates_mappings`:modelId → {instruct, context} 预设名 */
    modelTemplatesMappings?: Record<string, { instruct?: string; context?: string }>;
    /** console.warn 替代(非法 activation_regex 等告警) */
    warn?: (msg: string) => void;
}

/** `autoSelectInstructPreset` 产出:由宿主执行实际"选中"副作用 */
export interface InstructAutoSelectResult {
    matched: boolean;
    /** 应选中的 instruct 预设名 */
    instructPreset?: string;
    /** 应选中的 context 模板名 */
    contextPreset?: string;
}

/** createInstructEngine 返回的绑定面;formatInstructExamples 形状对齐 SubstituteContext.formatInstructExamples */
export interface InstructEngine {
    formatChat: (
        name: string,
        mes: string,
        isUser: boolean,
        isNarrator: boolean,
        forceAvatar: string | boolean | undefined | null,
        name1: string,
        name2: string,
        forceOutputSequence?: ForceOutputSequence,
        customInstruct?: InstructSettings | null,
    ) => string;
    formatPrompt: (
        name: string,
        isImpersonate: boolean,
        promptBias: string,
        name1: string,
        name2: string,
        isQuiet: boolean,
        isQuietToLoud: boolean,
        customInstruct?: InstructSettings | null,
    ) => string;
    formatStoryString: (
        storyString: string,
        opts?: { customContext?: InstructContextSettings | null; customInstruct?: InstructSettings | null },
    ) => string;
    /** 形状 == SubstituteContext.formatInstructExamples,可直接填入 seam */
    formatInstructExamples: (examples: string[], name1: string, name2: string) => string[];
    getStoppingSequences: (opts?: {
        customInstruct?: InstructSettings | null;
        useStopStrings?: boolean | null;
    }) => string[];
    autoSelectPreset: (modelId: string) => InstructAutoSelectResult;
}
