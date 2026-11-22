/**
 * STscript 执行环境注入 — Luker 里回调靠 import 全局(script.js/chat_metadata/
 * toastr/globalThis.executeQuickReplyByName)取副作用;core 全部收口为
 * 宿主注入的 env。设计约束:本模块只做类型与 ops 收集,不触 fs/DOM/network。
 */
import type { SubstituteContext } from '../macros/substitute.js';
import type { RegexScript } from '../regex/types.js';
import type { SlashCommandScope } from './scope.js';
import type { SlashCommandAbortController, SlashCommandDebugController } from './control.js';
import type { NamedArguments } from './types.js';

/**
 * JSON-Patch op —— 与 PATCH /characters/:dir/chats/:name 的 ops 同形,
 * path 命名空间限 /body/<i>/…(楼层字段)与 /header/…。/del /cut /swipe
 * 等楼层写面全经它 —— 与 web 前端 opsOf/PATCH ops 同一事实源,
 * 服务端落点同一个 repo.patch,不造平行写面。
 */
export interface StscriptPatchOp {
    op: 'add' | 'remove' | 'replace';
    path: string;
    value?: unknown;
}

/**
 * 一条副作用回执。设计文档要求 ops 随 /run 响应返回,供渲染器做
 * variable receipt / 发送回执展示(与 MVU receipt 同通道)。
 */
export type StscriptOp =
    | { type: 'send'; name: string; index: number }
    | { type: 'setvar'; scope: 'local' | 'global'; key: string; value: unknown }
    | { type: 'delvar'; scope: 'local' | 'global'; key: string }
    | { type: 'echo'; severity: string; title?: string; text: string }
    | { type: 'input'; prompt: string }
    | { type: 'trigger' }
    | { type: 'gen' }
    | { type: 'abort'; reason: string }
    | { type: 'run'; name: string }
    | { type: 'system-message'; text: string }
    | { type: 'popup'; text: string }
    | { type: 'setinput'; text: string }
    /** 楼层写面回执:/del /cut /swipe /hide 等经 host.patchChat 落的 patch ops。 */
    | { type: 'chat-patch'; ops: StscriptPatchOp[] }
    /** 作者注写面:/note* 写 chat_metadata.note_*。 */
    | { type: 'note'; key: string; value: unknown }
    /** /go 会话跳转请求(客户端导航类 op receipt;服务端自身不切 ctx)。 */
    | { type: 'go'; target: string; charDir?: string; chatName?: string }
    | { type: 'custom'; kind: string; data?: unknown };

/** /send /sendas /sys /comment 构造的消息形状(与 Luker message 对象一致)。 */
export interface StscriptMessage {
    name: string;
    is_user: boolean;
    is_system: boolean | string;
    send_date: string;
    mes: string;
    force_avatar?: string;
    original_avatar?: string;
    swipe_id?: number;
    swipes?: string[];
    swipe_info?: unknown[];
    extra?: Record<string, unknown>;
    [key: string]: unknown;
}

/** /echo 通知选项(toastr options 的可序列化子集)。 */
export interface StscriptNotifyOptions {
    timeOut?: number;
    extendedTimeOut?: number;
    preventDuplicates?: boolean;
    toastClass?: string;
    escapeHtml?: boolean;
    color?: string;
    onClick?: () => void | Promise<void>;
    /** /echo awaitDismissal:toast 隐藏时回调。 */
    onHidden?: () => void;
}

/** /input 弹窗选项(callGenericPopup options 的可序列化子集)。 */
export interface StscriptInputOptions {
    large?: boolean;
    wide?: boolean;
    okButton?: string;
    rows?: number;
    placeholder?: string | null;
    tooltip?: string | null;
}

/** /gen → generateQuietPrompt 的可序列化参数。 */
export interface StscriptGenerateParams {
    quietToLoud?: boolean;
    quietName?: string;
    responseLength?: number;
    trimToSentence?: boolean;
    forceChId?: number | null;
    stop?: string | string[];
}

/**
 * 宿主 seams — 全部为可选;缺失的 seam 对应命令走"温和降级"
 * (warn + 空返回)或直接报错,与 Luker 中 UI 不存在时行为对齐。
 */
export interface StscriptHost {
    /**
     * 写入一条构造完成的消息。insertAt 为数字时在该下标插入(对应
     * `chat.splice`),为 null 时末尾追加(对应 `chat.push` + 渲染)。
     * 宿主负责持久化/事件派发;chat 数组本体由 env.macro.chat 提供。
     */
    appendMessage?: (message: StscriptMessage, insertAt: number | null) => void | Promise<void>;
    /** /echo、/abort quiet=false 提示、return 通道 toast-* 的落脚。 */
    notify?: (severity: 'error' | 'warning' | 'success' | 'info', title: string | undefined, text: string, options?: StscriptNotifyOptions) => void | Promise<void>;
    /** return 通道 chat-html/chat-text、/help 等系统消息。 */
    sendSystemMessage?: (text: string, isHtml: boolean) => void | Promise<void>;
    /** return 通道 popup-html/popup-text 与 /listvar 默认输出。 */
    showPopup?: (text: string, isHtml: boolean) => void | Promise<void>;
    /** /input:返回输入文本;null=空输入,false=取消。 */
    requestInput?: (prompt: string, defaultInput: string, options: StscriptInputOptions) => Promise<string | null | false>;
    /** 设置输入框文本(/setinput)。 */
    setInput?: (text: string) => void | Promise<void>;
    /** /trigger → Generate('normal');member 为群成员定位值。 */
    triggerGeneration?: (member?: string) => Promise<unknown>;
    /** /gen → generateQuietPrompt。 */
    generateQuiet?: (prompt: string, params: StscriptGenerateParams) => Promise<string>;
    /** /run 兜底:按名字执行 Quick Reply(Luker 走 globalThis.executeQuickReplyByName)。 */
    runQuickReply?: (name: string, args: NamedArguments, options: { abortController?: SlashCommandAbortController; debugController?: SlashCommandDebugController }) => Promise<unknown>;
    /**
     * 角色解析(/sendas name/avatar → findChar)。返回 null=未找到。
     * avatar 为原始 avatar key;force_avatar 由 host 按 getNameAndAvatarForMessage
     * 语义折算(currentCharAvatar/defaultAvatar/avatarUrl 共同决定)。
     */
    resolveCharacter?: (name: string) => { name: string; avatar?: string } | null;
    /** persona 查找(findPersona({name});/send name= 的 avatar 解析)。 */
    findPersona?: (name: string) => { name: string; avatar?: string } | null;
    /** 常量:user_avatar(当前用户头像 key)。 */
    userAvatar?: string;
    /** power_user.personas 中是否存在该 avatar key(/send 的 force_avatar 判定)。 */
    personaAvatarExists?: (avatarKey: string) => boolean;
    /** power_user.message_token_count_enabled 开关。 */
    messageTokenCountEnabled?: boolean;
    /** getTokenCountAsync seam(配合 messageTokenCountEnabled)。 */
    countTokens?: (text: string) => Promise<number> | number;
    /** populateFileAttachment + extractMessageById(附件填充;服务端通常无附件)。 */
    attachFiles?: (message: StscriptMessage) => Promise<void> | void;
    /** statMesProcess 统计追踪(/send user 消息)。 */
    trackMessageStats?: (message: StscriptMessage, role: string) => Promise<void> | void;
    /** getThumbnailUrl(kind, id)。缺省时直接使用 id。 */
    avatarUrl?: (kind: 'avatar' | 'persona', id: string) => string;
    /** saveChatConditional / patch 持久化。 */
    persistChat?: () => void | Promise<void>;
    /**
     * 楼层 JSON-Patch 写面 —— 与 PATCH /characters/:dir/chats/:name
     * 同一服务端写面(repo.patch)。/del /cut /delswipe /hide 等楼层
     * 删除/字段写在改完内存 chat 数组后经它落盘;ops path 用
     * /body/<i>/… 命名空间。缺省 = 无持久宿主:命令只改内存 chat。
     */
    patchChat?: (ops: StscriptPatchOp[]) => void | Promise<void>;
    /**
     * /go 的会话解析面:name → 可打开的会话目标。
     * 服务端按 char 名/群名/'last'(最近聊天)解析;返回 null=未命中。
     * 命令本身只发 go op receipt(导航类),实际切换是客户端的事。
     */
    resolveChatTarget?: (name: string) => Promise<{ charDir?: string; chatName?: string; name: string } | null> | { charDir?: string; chatName?: string; name: string } | null;
    /**
     * /swipe 右划越界(OVERSWIPE_REGENERATE)→ 生成新 swipe 版本。
     * = Generate('swipe') 的宿主缝;与 /trigger 同类(TASK-069),
     * 缺席时 /swipe 在越界位 revert + warn(不静默假装生成)。
     */
    generateSwipe?: (messageIndex: number) => Promise<boolean | void>;
    /** saveMetadataDebounced(局部变量写库)。 */
    persistMetadata?: () => void;
    /** saveSettingsDebounced(全局变量写库)。 */
    persistSettings?: () => void;
    /** 常量:当前聊天角色 avatar(getNameAndAvatarForMessage 用)。 */
    currentCharAvatar?: string;
    /** 常量:name2 === neutralCharacterName 判定。 */
    neutralCharacterName?: string;
    /** 常量:默认头像(default_avatar)与系统/评论头像。 */
    defaultAvatar?: string;
    systemAvatar?: string;
    commentAvatar?: string;
    /** return= 的 *-html 通道:markdown→html(+sanitize)渲染;缺省透传原文。 */
    markdownToHtml?: (text: string) => string;
    /** 正则脚本来源(getRegexedString scripts → RegexParams.scripts)。 */
    regexScripts?: RegexScript[];
    /** extension_settings.disabledExtensions 中 regex 总开关。 */
    regexDisabled?: boolean;
    /** regex_perf_detection 开关。 */
    regexPerfDetection?: boolean;
}

/** 每次脚本执行的注入环境;closures 经 args._env / parser.env 传递。 */
export interface StscriptEnv {
    /** 宏求值上下文(substituteParams 的 ctx;chat/chatMetadata/globalVariables)。 */
    macro: SubstituteContext;
    /** 副作用回执收集,引擎随结果一并返回。 */
    ops: StscriptOp[];
    /** 宿主 seams。 */
    host: StscriptHost;
    /** 外层 scope(executeSlashCommandsWithOptions 的 scope)。 */
    outerScope?: SlashCommandScope | null;
}

/** 创建默认 env(宿主最少给 macro;ops 由引擎收集)。 */
export function createStscriptEnv(macro: SubstituteContext, host: StscriptHost = {}, extra: Partial<StscriptEnv> = {}): StscriptEnv {
    return {
        macro,
        ops: [],
        host,
        outerScope: null,
        ...extra,
    };
}
