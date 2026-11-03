/**
 * Prompt 组装层类型 —— 移植自 openai.js/PromptManager.js/prompt-injections.js。
 * 命名保留 ST 语义,便于 golden-diff 对照。
 */

export type InjectionPosition = 0 | 1 | 2; // RELATIVE | ABSOLUTE | ATTACH_EXISTING

export interface PromptLike {
    identifier: string;
    name?: string;
    role: string; // 'system' | 'user' | 'assistant' | ST 自定义 role(getPromptRole 归一)
    content?: string;
    enabled?: boolean;
    marker?: boolean;
    system_prompt?: boolean;
    forbid_overrides?: boolean;
    extension?: boolean;
    position?: string | number; // 'start'|'end' —— 相对 main 的注入位(injectToMain)
    injection_position?: number;
    injection_depth?: number;
    injection_order?: number;
    attach_role?: string;
    attach_index?: number;
    attach_side?: string;
    /** 由调用方标记:本卡禁用该 prompt(isPromptDisabledForActiveCharacter) */
    disabledForChar?: boolean;
    /** extension prompt 原始 position(extension_prompt_types 数值) */
    rawPosition?: number;
}

/** 聊天消息输入(setOpenAIMessages 的源) */
export interface ChatMessageInput {
    is_user?: boolean;
    is_system?: boolean;
    name?: string;
    mes: string;
    force_avatar?: boolean;
    extra?: {
        type?: number; // system_message_types(NARRATOR→system)
        api?: string;
        model?: string;
        media?: unknown[];
        mediaDisplay?: string; // MEDIA_DISPLAY: 'list' | 'gallery'
        mediaIndex?: number;
        reasoning?: string;
        reasoning_blocks?: unknown[];
        reasoning_details?: unknown[];
        reasoning_signature?: string;
        tool_invocations?: unknown[];
        isSmallSys?: boolean;
        [IGNORE_SYMBOL]?: boolean;
    } & Record<string, unknown>;
}

export const IGNORE_SYMBOL = Symbol.for('uberge.ignore_message');

/** setOpenAIMessages 产出的中间消息(注入前) */
export interface PromptMessage {
    role: string;
    content: string;
    name?: string;
    injected?: boolean;
    media?: unknown[];
    mediaDisplay?: string; // 'list' | 'gallery'
    mediaIndex?: number;
    invocations?: unknown[];
    signature?: string | null;
    reasoning?: string | null;
    reasoning_blocks?: unknown[] | null;
    reasoning_details?: unknown[] | null;
}

/** 组装的请求 DTO(promptBuilder seam 的入参) */
export interface PromptBuildRequest {
    /** 卡片字段 */
    card: {
        name: string;
        description?: string;
        personality?: string;
        scenario?: string;
        mesExample?: string;
        systemPromptOverride?: string;
        jailbreakOverride?: string;
    };
    /** 用户 persona */
    user: { name: string; description?: string };
    /** 聊天历史(原序,旧→新) */
    chat: ChatMessageInput[];
    /** 预设解析后的 prompt 集合(含 marker)与顺序(enabled 记在序条目上,原版语义) */
    prompts: PromptLike[];
    promptOrder: ({ identifier: string; enabled?: boolean } | string)[];
    /** 预设/设置字段(oai_settings 的相关子集) */
    settings: {
        wi_format?: string;
        scenario_format?: string;
        personality_format?: string;
        group_nudge_prompt?: string;
        impersonation_prompt?: string;
        new_chat_prompt?: string;
        new_group_chat_prompt?: string;
        new_example_chat_prompt?: string;
        continue_nudge_prompt?: string;
        continue_prefill?: boolean;
        assistant_prefill?: string;
        send_if_empty?: string;
        names_behavior?: number; // NONE=0 DEFAULT=1 CONTENT=2 COMPLETION=3
        squash_system_messages?: boolean;
        pin_examples?: boolean;
    };
    /** 上下文预算 */
    contextTokens: number;
    responseTokens: number;
    /** WI 引擎产出(已按 position 分桶) */
    worldInfo: {
        beforeEntries?: string[];
        afterEntries?: string[];
        /** 深度注入条目(in-chat @D):每条的 depth/order/role/content 已由 WI 引擎决定 */
        depthEntries?: PromptLike[];
        /** 输出格式串,空走 settings.wi_format */
        format?: string;
    };
    /** extension prompts 原始注入面(extensionPrompts[key] = {value,role,position,depth,order,scan}) */
    extensionPrompts?: Record<
        string,
        { value: string; role?: number; position?: number; depth?: number; order?: number; scan?: boolean }
    >;
    /** 生成类型:normal / continue / impersonate / quiet … */
    type?: string;
    cyclePrompt?: string;
    bias?: string;
    quietPrompt?: string;
    /** 群聊面 */
    group?: { members?: string[]; botNames?: string[] };
    /** 当前 api/model(reasoning signature 判同) */
    api?: string;
    model?: string;
    /** 工具调用面(ToolManager.isToolCallingSupported 等的服务端等价) */
    tools?: {
        canUse?: boolean;
        includeSignature?: boolean;
        /** tool_reasoning_modes:'disabled' | 'since_last_user' | 'active_chain' */
        reasoningMode?: string;
    };
    /** 媒体内联开关(isImage/Video/AudioInliningSupported 等价)+ 宿主 MediaProvider 经 deps.setMediaProvider 绑 */
    media?: { image?: boolean; video?: boolean; audio?: boolean };
}

/** 产出:messages + 诊断轨迹 */
export interface BuiltPrompt {
    messages: { role: string; content: unknown; name?: string }[];
    trace: {
        /** 每个 collection 的最终 token 数与消息数(prompt viewer 数据源) */
        collections: { identifier: string; tokens: number; count: number }[];
        tokenBudget: number;
        remainingBudget: number;
        droppedChatCount: number;
        injectedCount: number;
    };
}
