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
    /** /inject 写面回执:chat_metadata.script_injects 条目 upsert/删除(inject=null)。 */
    | { type: 'inject'; id: string; inject: ScriptInjectRecord | null }
    | { type: 'custom'; kind: string; data?: unknown };

/**
 * chat_metadata.script_injects 条目 —— ref/Luker injectCallback 落档形
 * ({value,position,depth,scan,role,filter,ephemeral})。generate-context
 * 读侧原样并入 extension_prompts(script_inject_* 键);filter 是闭包原文,
 * 服务端组装不求值,仅持久化留档(shim 端预过滤)。
 */
export interface ScriptInjectRecord {
    value: string;
    /** extension_prompt_types 原值:NONE=-1 IN_PROMPT=0 IN_CHAT=1 BEFORE_PROMPT=2。 */
    position: number;
    depth: number;
    scan: boolean;
    /** extension_prompt_roles 原值:SYSTEM=0 USER=1 ASSISTANT=2。 */
    role: number;
    /** /inject filter= 闭包 rawText(无闭包 → null)。 */
    filter: string | null;
    /** Luker:非 quiet 生成终态后由 consumeEphemeralScriptInjects 清除。 */
    ephemeral?: boolean;
}

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

/** /popup → Popup.show.text options 的可序列化子集。 */
export interface StscriptPopupOptions {
    /** 弹窗正文(未 sanitize —— sanitize 属宿主职责,与 /input 注释一致)。 */
    text: string;
    header?: string | null;
    allowVerticalScrolling?: boolean;
    large?: boolean;
    wide?: boolean;
    wider?: boolean;
    transparent?: boolean;
    okButton?: string;
    cancelButton?: string | null;
    tooltip?: string | null;
}

/** /buttons 单枚按钮(label 可为 {text,tooltip,icon} 对象)。 */
export interface StscriptButtonLabel {
    text: string;
    tooltip?: string;
    icon?: string;
}

/** /buttons → 阻塞按钮组参数。 */
export interface StscriptButtonsOptions {
    text: string;
    buttons: StscriptButtonLabel[];
    /** true=多选(确认后返回全部被点 result code);false=单选(点中即返回)。 */
    multiple: boolean;
}

/**
 * WI 书 doc 形态 — `{entries:{uid: entry}}`,与磁盘/线格式同构。
 * entry 字段细节由调用方(world-commands)按上游 definition 校验,
 * 本类型只承载仓库边界。
 */
export interface StscriptWorldBook {
    entries: Record<string | number, Record<string, unknown>>;
    [key: string]: unknown;
}

/** settings.world_info 活对象切片(/world 与 /getcharbook 的写面)。 */
export interface StscriptWorldInfoSettings {
    /** selected_world_info 持久位(/world 写)。 */
    globalSelect?: string[];
    /** 角色辅助书绑表:[{name: charDir, extraBooks: []}](charUpdateAddAuxWorld)。 */
    charLore?: { name: string; extraBooks?: string[] }[];
    [key: string]: unknown;
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
     * 允许 async(服务端扫卡目录实现),调用点一律 await。
     */
    resolveCharacter?: (name: string) => { name: string; avatar?: string } | null | Promise<{ name: string; avatar?: string } | null>;
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

    // -------------------------------------------------------------------
    // WI 族 seams(TASK-064 批二)— settings 活对象直接改 + persist* 落盘。
    // -------------------------------------------------------------------

    /** settings.world_info 活对象(/world 写 globalSelect、/getcharbook 写 charLore)。 */
    worldInfoSettings?: StscriptWorldInfoSettings;
    /** settings.power_user 活对象(/getpersonabook 写 persona_description_lorebook)。 */
    powerUser?: Record<string, unknown>;
    /** world_names 等价物 — WI 书 canonical 名清单。 */
    listWorldBooks?: () => string[] | Promise<string[]>;
    /** loadWorldInfo:canonical 名读整 doc;不存在/坏档 → null。 */
    getWorldBook?: (name: string) => Promise<StscriptWorldBook | null> | StscriptWorldBook | null;
    /** saveWorldInfo:整 doc 回写(与服务端 /api/worldinfo/edit 同写面)。 */
    saveWorldBook?: (name: string, doc: StscriptWorldBook) => void | Promise<void>;
    /** createNewWorldInfo:空书 {entries:{}} 落盘;返回可寻址的 canonical 名,失败 null。 */
    createWorldBook?: (name: string) => Promise<string | null> | string | null;
    /**
     * 卡文件读面(/getcharbook primary 取 data.extensions.world)。
     * avatar 为 'Foo.png' 形态 avatar key;不存在 → null。
     */
    loadCharacterCard?: (avatar: string) => Promise<{ name?: string; data?: { extensions?: Record<string, unknown>; world?: string } } | null>;
    /** writeExtensionField('world') 等价:把 extensions.world 写进卡文件。 */
    setCharacterWorld?: (avatar: string, worldName: string) => Promise<boolean> | boolean;
    /** settings.tags 等价物 — characterFilterTags 的 id↔name 对表。 */
    listTags?: () => { id: string; name: string }[] | Promise<{ id: string; name: string }[]>;

    // -------------------------------------------------------------------
    // 会话/角色族 seams(TASK-064 批二)
    // -------------------------------------------------------------------

    /**
     * /renamechat → renameChat(currentChatName, newName) 写面
     * (服务端 = ChatRepo.rename)。返回是否成功;命令层负责 notify。
     */
    renameChat?: (oldName: string, newName: string) => Promise<boolean> | boolean;
    /**
     * /rename-char → script.js renameCharacter 服务端面:卡文件重命名 +
     * charDir 迁移;opts.renameChats=true 时重写历史聊天中的消息 name。
     * 未绑 → 命令显式报错(重副作用不静默降级)。
     */
    renameCharacter?: (newName: string, opts: { silent: boolean; renameChats: boolean | null }) => Promise<boolean>;
    /** /impersonate → Generate('impersonate', {quiet_prompt, quietToLoud})。 */
    generateImpersonate?: (prompt?: string) => Promise<unknown>;
    /**
     * /persona-set(temp / all 未命中兜底)→ setUserName:
     * 用户名持久化(服务端 = settings.username + settings 落档)。
     * 命令层同步 env.macro.name1;未绑 → 显式报错(GH#9 同路)。
     */
    setUserName?: (name: string) => void;
    /**
     * /persona-set(lookup/all 命中 persona)→ autoSelectPersona:
     * 切换当前 persona avatar(服务端 = power_user.default_persona 落档)。
     * 未绑时命令层 warn 后退化 setUserName(persona.name) —— 同用户名、
     * 仅缺 avatar 切换,不静默(notify 有痕)。
     */
    selectPersona?: (avatarKey: string) => void;

    // -------------------------------------------------------------------
    // 阻塞式弹窗 seams(TASK-064 批二)— 未绑 → 命令显式报错。
    // -------------------------------------------------------------------

    /**
     * /popup → Popup.show.text 阻塞结果;返回 POPUP_RESULT 语义数值
     * (确认=1 取消=0,dismiss=undefined)。仅交互宿主可绑。
     */
    requestPopup?: (options: StscriptPopupOptions) => Promise<number | undefined>;
    /**
     * /buttons → 自定义按钮阻塞选择;返回被点中的 result code 数组
     * (labels 下标 +2;取消/dismiss/多选空选 = [])。
     */
    requestButtons?: (options: StscriptButtonsOptions) => Promise<number[]>;

    // -------------------------------------------------------------------
    // 会话生命周期 / 设备面 seams(TASK-064 批三)
    // -------------------------------------------------------------------

    /**
     * /newchat → doNewChat 服务端面:为当前角色建空会话
     * (`<name2> - <humanizedDateTime>` 命名),deleteCurrent=true 时
     * 先删当前会话(上游同语义)。返回新会话定位(命令层发 go op)。
     * 未绑 → 命令显式报错。
     */
    newChat?: (opts: { deleteCurrent: boolean }) => Promise<{ name: string; charDir?: string; chatName?: string } | null> | { name: string; charDir?: string; chatName?: string } | null;
    /**
     * /delchat → 删除当前会话文件(上游 UI 删除路径的服务端面)。
     * 未绑 → 命令显式报错;返回 false → 命令 error notify。
     */
    deleteChat?: () => Promise<boolean> | boolean;
    /**
     * isMobile() 等价物 —— 引擎执行环境的移动设备判定。服务端宿主缺省
     * 不绑 → /is-mobile 恒 'false'(服务端非移动设备;薄客户端判定应在
     * 客户端侧求值,移动端宿主可绑 true)。
     */
    isMobile?: boolean;
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
