// /api/utopinn/* REST wire contracts — endpoint shapes not covered by
// generation.ts (generation + WS) or panels.ts (panel bridge).
// Every shape mirrors the actual server wire in apps/server/src/plugins/utopinn-*.js;
// line references in .skeinn/eval/task038-cli-coverage-audit.md are the audit anchor.

import type { JsonPatchOp } from './common.js';
import type { CharacterCardData, PresetDocument, WorldBook } from './resources.js';

// =========================================================================
// library — characters / chats
// =========================================================================

/** GET /api/utopinn/characters → items[] */
export interface LibraryCharacterItem {
    charDir: string;
    name: string;
    /** Avatar file name when the card file is an image, else null. */
    avatar: string | null;
    fileName: string;
    fileSize: number;
    tags: string[];
    /** false = card file exists but failed to parse (name degrades to charDir). */
    readable: boolean;
    /** Card file ctime ms (legacy date_added). */
    dateAdded: number;
    /** Max updatedAt across this char's chats (legacy date_last_chat). */
    dateLastChat: number;
}
export interface LibraryCharactersResponse {
    items: LibraryCharacterItem[];
    total: number;
}

/** GET /api/utopinn/characters/:charDir → card doc as stored (v1/v2/v3 原样). */
export type CharacterCardDocument = Record<string, unknown> & {
    name?: string;
    data?: CharacterCardData | Record<string, unknown>;
};

/** GET /api/utopinn/characters/:charDir/chats → items[] */
export interface LibraryChatItem {
    name: string;
    fileName: string;
    messageCount: number;
    byteSize: number;
    lastMessage: unknown;
    chatMetadata: Record<string, unknown>;
    updatedAt: number;
    createdAt: number;
    integrity: string | null;
}
export interface LibraryChatsResponse {
    items: LibraryChatItem[];
    total: number;
}

/** GET …/chats/:chatName → utopinn chat doc(header + messages,非 legacy [header,...floors])。 */
export interface ChatDocument {
    name: string;
    fileName: string;
    header: Record<string, unknown> & { chat_metadata?: Record<string, unknown> };
    messages: Record<string, unknown>[];
    integrity: string | null;
    updatedAt: number;
    createdAt: number;
}
/** File exists but repo can't read it → {corrupted:true}(legacy new_chat 分流依据)。 */
export interface ChatCorruptedResult {
    corrupted: true;
}
export type ChatGetResponse = ChatDocument | ChatCorruptedResult;

/** PUT …/chats/:chatName —— 立即建空会话;已存在 → 409。 */
export interface ChatCreateRequest {
    header?: Record<string, unknown>;
}
export interface ChatCreateResponse {
    ok: true;
    name: string;
    fileName: string;
    integrity: string;
}

/** POST …/chats/:chatName/rename */
export interface ChatRenameRequest {
    newName: string;
    /** 服务端刷 recent-index 用,可选。 */
    avatar_url?: string;
}
export interface ChatRenameResponse {
    ok: true;
    name: string;
    fileName: string;
}

/**
 * POST …/chats/:chatName/messages —— 追加楼层(legacy /append 逐义)。
 * 缺失即建;双去重(队首等值 + gen-id 侧车);integrity 乐观锁。
 */
export interface AppendMessagesRequest {
    /** messages[]|message 二选一。 */
    messages?: Record<string, unknown>[];
    message?: Record<string, unknown>;
    integrity?: string;
    force?: boolean;
    chat_metadata?: Record<string, unknown>;
    /** gen-id:写侧车 + ack 双通道。 */
    luker_generation_id?: string;
}
export interface AppendMessagesResponse {
    ok: true;
    appended: number;
    created: boolean;
    skipped?: number;
    matched_existing_generation_id?: boolean;
    integrity: string | null;
}

/**
 * PATCH …/chats/:chatName —— JSON-Patch 局部改。
 * op.path 限 `/body/<i>/…` 或 `/header/…` 命名空间;顶层 /N 拒绝。
 * chat_metadata 顶键展成 /header/chat_metadata/<k> 合并。
 */
export interface ChatPatchRequest {
    ops: JsonPatchOp[];
    integrity?: string;
    chat_metadata?: Record<string, unknown>;
    luker_generation_id?: string;
}
export interface ChatPatchResponse {
    ok: true;
    applied: number;
    total_messages: number | null;
    integrity: string | null;
}

/**
 * PUT …/chats/:chatName/document —— 整文档替换(legacy /save 等价,upsert)。
 * 双形状:{header,messages} 或 {chat:[header,...floors]}。
 * CAS:body.integrity ?? header.chat_metadata.integrity;force 跳过。
 */
export interface ChatDocumentPutRequest {
    header?: Record<string, unknown>;
    messages?: Record<string, unknown>[];
    chat?: Record<string, unknown>[];
    integrity?: string;
    force?: boolean;
    luker_generation_id?: string;
}
export interface ChatDocumentPutResponse {
    ok: true;
    integrity: string;
}

/**
 * 409 完整性冲突体 —— patch/document/append CAS 与 test/missing-parent 失败时:
 *   {error:'integrity', current_integrity}        (utopinn ConflictError / patch 守卫)
 *   {error:'integrity_mismatch', actual}          (legacy 端点变体)
 */
export interface IntegrityConflictBody {
    error: string;
    current_integrity?: string;
    actual?: string;
}

// =========================================================================
// TASK-044 —— novel 章目录 + theater 三件套余量
// =========================================================================

/**
 * GET …/chats/:chatName/chapters —— novel 章目录聚合视图。
 * sidecar chat_state 'chapters' ns 有 {items:[]} 显式清单 → source:'sidecar';
 * 否则按 web stagepack 同规则从楼层推导 → source:'derived'。
 * range 为 body 楼号区间(含端点,不含标记楼)——CLI regen --range <from:to>
 * 用同一口径。章无内容楼时 range=null。
 */
export interface ChatChapterItem {
    index: number;
    /** prologue|chapter|section|body(derived)/ sidecar(sidecar 清单)。 */
    kind: 'prologue' | 'chapter' | 'section' | 'body' | 'sidecar';
    /** 显式序号称谓('第三章'/'序章' 形);无显式序号 → null(按 index 自排)。 */
    num: string | null;
    title: string;
    /** [from,to] body 楼号区间(含端点);空章 → null。 */
    range: [number, number] | null;
    /** 内容楼数(不含分章标记楼)。 */
    floors: number;
    /** 首内容楼首段 snippet(≤40 字)。 */
    snippet: string;
    /** markers 策略专有:分章标记楼(system 楼)的 body 下标。 */
    markerFloor?: number;
}
export interface ChatChaptersResponse {
    chat: string;
    charDir: string;
    /** 全书楼数(body)。 */
    floors: number;
    source: 'sidecar' | 'derived';
    /** derived 细分:markers|segmented|single|empty;sidecar 恒 'sidecar'。 */
    strategy: 'markers' | 'segmented' | 'single' | 'empty' | 'sidecar';
    items: ChatChapterItem[];
    total: number;
    /** sidecar 源专有:清单里非法(from 非 int/越界/to<from)被跳过的条数。 */
    skipped?: number;
}

/**
 * sidecar chat_state ns 'chapters' 的显式章清单文档
 * (读写走通用 /api/utopinn/state/chat/* 面;非此形 → 视图回推导路)。
 */
export interface NovelChaptersSidecar {
    items: {
        /** 章起始 body 楼号(必需,int ≥0)。 */
        from: number;
        /** 章末 body 楼号(缺省=下一条 from-1/末楼,越界钳到末楼)。 */
        to?: number;
        title?: string;
        num?: string;
    }[];
}

/**
 * GET /characters/:charDir/assets —— theater 三件套资产清单。
 * 卡不存在 → 404;资产目录缺席 → 空数组(不静默造数据)。
 * sprites:characters/<名>/ 顶层图;label 与 legacy /api/sprites/get 同正则。
 * backgrounds:char 级 backgrounds/(charx 落点,scope:'char')+ 全局
 *   backgrounds/(scope:'global')。
 * bgm:char 级 bgm/ + 全局 assets/bgm/(本格新约定乐库位)。
 */
export interface CharAssetItem {
    /** 文件主名(去扩展名)。 */
    name: string;
    file: string;
    /** 静态面直取路径(/characters|/backgrounds|/assets 前缀)。 */
    url: string;
    bytes: number;
    scope: 'char' | 'global';
}
export interface CharAssetSpriteItem extends CharAssetItem {
    /** 表情标签(joy-1.png → joy;与 /api/sprites/get 同抽取)。 */
    label: string;
}
export interface CharAssetsResponse {
    charDir: string;
    name: string;
    sprites: CharAssetSpriteItem[];
    backgrounds: CharAssetItem[];
    bgm: CharAssetItem[];
    /** 三件套全空 → true(诚实语义,不合成默认资产)。 */
    empty: boolean;
}

/**
 * sidecar chat_state ns 'scene' 的 theater 场景运行态文档
 * (读写走通用 state/chat/* 面)。楼层 extra.scene 是单楼场景引用;
 * 本 sidecar 是「当前场」运行值 —— 客户端进聊天/切场后写,读侧取最新。
 * 字段刻意稀疏:bg/bgm 取值域与 floor.extra.scene 一致(资产清单 url 或裸文件名)。
 */
export interface TheaterSceneState {
    /** 当前底图 url(如 /characters/<名>/backgrounds/hall.jpg 或 /backgrounds/x.png)。 */
    bg?: string;
    /** 当前 BGM(bgm 清单 name/file/url 皆可,客户端自决)。 */
    bgm?: string;
    /** 台上立绘:[{name:角色显示名, sprite:表情 label}]。 */
    cast?: { name: string; sprite?: string }[];
    /** 最近一次写场景对应的 body 楼号(溯源用,可选)。 */
    floor?: number;
    /** ISO 时间戳(可选)。 */
    updatedAt?: string;
}

// =========================================================================
// library — presets / worlds / personas / settings / secrets
// =========================================================================

export interface PresetListItem {
    name: string;
}
export interface PresetListResponse {
    items: PresetListItem[];
    total: number;
    apiId: string;
}
export interface PresetGetResponse {
    name: string;
    apiId: string;
    doc: PresetDocument;
}
export interface PresetPutResponse {
    ok: true;
    name: string;
    apiId: string;
}

export interface WorldListItem {
    name: string;
    displayName: string;
    extensions: Record<string, unknown>;
}
export interface WorldListResponse {
    items: WorldListItem[];
    total: number;
}
export interface WorldGetResponse {
    name: string;
    doc: WorldBook;
}
export interface WorldPutResponse {
    ok: true;
    name: string;
}

export interface PersonaItem {
    avatar: string;
    name: string;
    description: string;
    position: number;
    title: string;
    hasImage: boolean;
    isDefault: boolean;
}
export interface PersonaListResponse {
    items: PersonaItem[];
    total: number;
    defaultPersona: string | null;
}
/** PUT /personas/:avatar —— 嵌套合并进 power_user.personas + persona_descriptions。 */
export interface PersonaPutRequest {
    name?: string;
    description?: string;
    position?: number;
    title?: string;
    is_default?: boolean;
}
export interface PersonaPutResponse {
    ok: true;
    avatar: string;
    name: string;
    description: string;
    position: number;
    title: string;
    isDefault: boolean;
}

/** GET /settings → {settings};?raw=1 未脱敏(旧前端消费,薄客户端别用)。 */
export interface SettingsResponse {
    settings: Record<string, unknown>;
}
/**
 * PATCH /settings —— 受限浅合并:
 * 对象段白名单 'power_user' | 'extension_settings' | 'oai_settings' | 'world_info_settings'
 * (world_info_settings.world_info 二层保留同级键);
 * 标量白名单 'preset_settings_openai'(string | null,双向镜像 oai_settings)。
 */
export interface SettingsPatchRequest {
    power_user?: Record<string, unknown>;
    extension_settings?: Record<string, unknown>;
    oai_settings?: Record<string, unknown>;
    world_info_settings?: Record<string, unknown>;
    preset_settings_openai?: string | null;
}

/** PATCH /characters/:charDir —— 字段级 Merge Patch(C-3)。 */
export interface CharacterPatchExtensions {
    world?: string | null;
    alternate_greetings?: string[] | null;
    regex_scripts?: Record<string, unknown>[] | null;
}
export interface CharacterPatchRequest {
    name?: string;
    description?: string | null;
    personality?: string | null;
    scenario?: string | null;
    first_mes?: string | null;
    mes_example?: string | null;
    creator_notes?: string | null;
    system_prompt?: string | null;
    post_history_instructions?: string | null;
    creator?: string | null;
    character_version?: string | null;
    tags?: string[] | null;
    extensions?: CharacterPatchExtensions;
}

// =========================================================================
// connection / models / regex
// =========================================================================

export type ConnectionProbeErrorCode =
    | 'not_configured'
    | 'unreachable'
    | 'timeout'
    | 'auth_failed'
    | 'http_error'
    | 'unsupported';

/**
 * 哪层凭据在生效(TASK-072,shared-secrets.md §2.4):
 *   proxy = 请求体 proxy_password 显式压 resolver;
 *   user  = 本人档(secret_id 槽或 active);
 *   shared = <dataRoot>/_shared 共享档且 ACL 放行;
 *   none  = 无凭据(anonymous pollinations 也归此)。
 */
export type ProviderCredentialSource = 'user' | 'shared' | 'proxy' | 'none';

/** POST /api/utopinn/connection/test */
export interface ConnectionTestResponse {
    ok: boolean;
    source: string;
    credential: ProviderCredentialSource;
    latencyMs: number;
    modelCount?: number;
    upstreamStatus: number | null;
    error?: ConnectionProbeErrorCode | (string & {});
    detail?: string;
}

export interface UpstreamModelItem {
    id: string;
    owned_by?: string;
}

/** GET /api/utopinn/models(?fresh=1) */
export interface ModelsResponse {
    source: string;
    credential: ProviderCredentialSource;
    items: UpstreamModelItem[];
    stale?: boolean;
    error?: ConnectionProbeErrorCode | (string & {});
    upstreamStatus?: number | null;
    detail?: string;
}

/** RegexScriptData(utopinn-regex.js)。 */
export interface RegexScriptData {
    id?: string;
    scriptName?: string;
    findRegex?: string;
    replaceString?: string;
    trimStrings?: string[];
    placement?: number[];
    disabled?: boolean;
    markdownOnly?: boolean;
    promptOnly?: boolean;
    runOnEdit?: boolean;
    substituteRegex?: number;
    minDepth?: number | null;
    maxDepth?: number | null;
    [k: string]: unknown;
}

export interface RegexCharGroup {
    charDir: string;
    avatar: string;
    name: string;
    allowed: boolean;
    autoAllowed?: boolean;
    active?: boolean;
    scripts: RegexScriptData[];
}

export interface RegexPresetGroup {
    apiId: string;
    name: string;
    allowed: boolean;
    /** 该预设当前是其 apiId 的 in_use(settings selected)预设 —— 生成链只消费 in_use 预设脚本(TASK-070)。 */
    inUse?: boolean;
    /** 如实报「本会进生成链」:allowed && inUse && 有脚本 && 扩展未全灭。 */
    active?: boolean;
    count?: number;
    scripts: RegexScriptData[];
}

/** GET /api/utopinn/regex(全量视图)。 */
export interface RegexFullViewResponse {
    global: RegexScriptData[];
    allowed: {
        characters: string[];
        presets: Record<string, string[]>;
    };
    /** apiId → 当前 in_use 预设名(settings selected)。 */
    inUse?: Record<string, string>;
    /** 服务端实键(extension_settings.disabledExtensions 含 'regex')。 */
    extensionDisabled?: boolean;
    disabled: boolean;
    chars: RegexCharGroup[];
    presets: RegexPresetGroup[];
}

export interface SecretEntry {
    id: string;
    /** 已脱敏(服务端 SecretManager.getSecretState 原生打码)。 */
    value: string;
    label: string;
    active: boolean;
}
/**
 * 实例共享档对当前 handle 的可用性视图(TASK-072 §2.4)。
 * 只含 {label, active:true};null = 无可用共享(档缺 / 无 active / ACL 拒)。
 * 不回 id / 掩码 / handles 名单 —— 普通用户只见"服务端已提供"。
 */
export interface SharedSecretAvailability {
    label: string;
    active: true;
}

/** GET /secrets → {secrets: {key: SecretEntry[] | null}, shared}(null = 未设)。 */
export interface SecretsResponse {
    secrets: Record<string, SecretEntry[] | null>;
    shared: Record<string, SharedSecretAvailability | null>;
}
/** PUT /secrets/:key —— 写一条新 secret(服务端铸 id,自动 active,不 echo 明文)。 */
export interface SecretSetRequest {
    value: string;
    label?: string;
}
export interface SecretSetResponse {
    ok: true;
    id: string;
    key: string;
    entries: SecretEntry[] | null;
}

// =========================================================================
// state sidecar 三族 —— /api/utopinn/state/{chat|char|preset}
// =========================================================================

/**
 * chat_state 目标:
 *   单卡 {avatar_url:'<charDir>.png', file_name:'<chat>.jsonl'}
 *   群   {is_group:true, id:'<groupChatId>'}
 * GET 变体同形走 query(+is_group='false' 单卡),另需 ?account=<handle>。
 */
export type ChatStateTarget =
    | { avatar_url: string; file_name: string; is_group?: false; char_name?: string }
    | { is_group: true; id: string };

export interface CharStateTarget {
    /** '<charDir>.png'(POST 体里经 validateAvatarUrlMiddleware)。 */
    avatar_url: string;
}

export interface PresetStateTarget {
    apiId: string;
    name: string;
}

/** POST get / GET get(ETag 资源读)统一应答。 */
export interface StateGetResponse<T = unknown> {
    ok: true;
    data: T | null;
}
export interface StateGetBatchResponse<T = unknown> {
    ok: true;
    /** { <namespace>: doc | null } */
    data: Record<string, T | null>;
}

/** patch 请求体:operations[] | operation 单 op(服务端两形都收)。 */
export interface StatePatchRequest {
    operations?: JsonPatchOp[] | JsonPatchOp;
    operation?: JsonPatchOp;
}
export interface StatePatchResponse {
    ok: true;
    applied: number;
    /** namespace 本次新建(char 恒有;chat 经引擎 tx 也有;preset 有)。 */
    created?: boolean;
}

/** chat delete 恒 {deleted:true};char/preset 缺失 → {deleted:false}(不是错误)。 */
export interface StateDeleteResponse {
    ok: true;
    deleted: boolean;
}

/** char 独有:整态覆写;body.data 必须是 JSON 对象;卡不在 → 404。 */
export interface StateSetRequest {
    data: Record<string, unknown>;
}
export interface StateSetResponse {
    ok: true;
}

/** preset 独有:清全 ns → {deleted:<count>}。 */
export interface StateDeleteAllResponse {
    ok: true;
    deleted: number;
}

/** preset 独有:ns 随名迁移;同名 {renamed:0};撞档 → 409。 */
export interface StateRenameRequest {
    apiId: string;
    oldName: string;
    newName: string;
}
export interface StateRenameResponse {
    ok: true;
    renamed: number;
}

/** GET state get 变体的 ETag 资源读错误体(sendResourceReadError)。 */
export interface ResourceReadErrorBody {
    code: 'invalid_args' | 'forbidden' | 'read_failed' | (string & {});
    resource: string;
    detail?: string;
}

// =========================================================================
// mvu
// =========================================================================

/** mvu 目标 —— {avatar_url,file_name} | {is_group,id}(与 chat_state target 同形)。 */
export type MvuTarget = ChatStateTarget;

/** GET /mvu/state → 200 {ok,...view};无聊天 → 404 {error:'Chat not found.'}。 */
export interface MvuStateResponse {
    ok: true;
    status: string;
    chatVariables: Record<string, unknown>;
    statData?: unknown;
    floorVariables?: unknown;
    /** mvu state sidecar 原文(无则 null)。 */
    state: unknown;
}

/** POST /mvu/settle —— 手动重结算目标楼层。 */
export interface MvuSettleRequest {
    avatar_url?: string;
    file_name?: string;
    is_group?: boolean;
    id?: string;
    message_index?: number;
    /** 缺省 true;false 只结算不回写 chat 变量。 */
    update_chat_variables?: boolean;
}
export interface MvuSettleResponse {
    ok: true;
    [k: string]: unknown;
}
export type MvuResettleRequest = Omit<MvuSettleRequest, 'message_index'>;
export type MvuResettleResponse = MvuSettleResponse;

// =========================================================================
// izumi —— /api/utopinn/izumi/*(IzumiEdit 信息库面板面)
// =========================================================================

/** 信息库条目(操作名 = scope 前缀 + 短名;'info' scope 无前缀)。 */
export interface IzumiEntry {
    /** 完整操作名(目录里照抄的引用名,含 '资料/'/'预设/' 前缀)。 */
    opName: string;
    /** 短名(无前缀)。 */
    name: string;
    /** 'info'(小此信息库,默认)| '资料' | '预设'。 */
    scope: 'info' | '资料' | '预设' | string;
    /** 关闭条目不进 KonataExtraInformation 注入文。 */
    enabled: boolean;
    /** 创建序(渲染/目录排序键)。 */
    order: number;
    content: string;
}

/** 「隐藏 N楼~M楼」落地的楼层区间(0-based body 下标,闭区间)。 */
export interface IzumiHiddenRange {
    from: number;
    to: number;
}

/** 单条 op 回执(写侧解释器逐 op 记入 state.log)。 */
export interface IzumiLogEntry {
    at: number;
    floor?: number;
    verb: string;
    name: string;
    ok: boolean;
    reason?: string;
}

/** GET|POST /izumi/state 与 POST /izumi/put 的统一视图应答。 */
export interface IzumiStateView {
    ok: true;
    entries: IzumiEntry[];
    hiddenFloors: IzumiHiddenRange[];
    log: IzumiLogEntry[];
    /** 「关闭 世界系统」落旗 —— 置位时不再注入 KonataExtraInformation。 */
    worldSystemClosed: boolean;
    /** 服务端重建的注入文预览(下轮组装的实际注入文本;null = 本轮不注入)。 */
    konata: string | null;
    /** [[IZUMI_CHAT_INDEX_V1]] 目录替换文。 */
    catalog: string;
    /** put 面逐项回执(未应用的改动 + 原因)。 */
    errors?: { opName: string; reason: string }[];
}

/** POST /izumi/put 请求体(target 字段并入;body.patch 缺省时顶层即 patch)。 */
export interface IzumiPutRequest {
    entries?: Record<string, { enabled?: boolean; content?: string }>;
    hiddenFloors?: IzumiHiddenRange[];
    worldSystemClosed?: boolean;
}

/** POST /izumi/reset → {ok,deleted:true};无聊天 → 404。 */
export interface IzumiResetResponse {
    ok: true;
    deleted: boolean;
}

/**
 * POST /mvu/panel/render —— 模板 × 变量 → 面板 HTML。
 * scope 缺省取目标聊天的 chatVariables(此时必须带 target)。
 */
export interface MvuPanelRenderRequest {
    template: string;
    scope?: Record<string, unknown>;
    avatar_url?: string;
    file_name?: string;
    is_group?: boolean;
    id?: string;
    fallback?: string;
    escape_html?: boolean;
}
export interface MvuPanelRenderResponse {
    ok: true;
    html: string;
}

// =========================================================================
// plugins / diag / script / th
// =========================================================================

export interface PluginItem {
    id: string;
    name?: string;
    version?: string;
    disabled?: boolean;
    [k: string]: unknown;
}
export interface PluginListResponse {
    items: PluginItem[];
}
/** enable/disable/reload 应答:pm result 原样({ok:true,…} | {error} + status)。 */
export interface PluginOpResponse {
    ok?: boolean;
    error?: string;
    [k: string]: unknown;
}

/** GET /api/utopinn/_kernel */
export interface KernelInfo {
    /** "METHOD|kind|path" 串 + "upgrade|…" 条目。 */
    routes: string[];
    services: unknown[];
}

/** POST /script/run —— 服务端 STscript runner。 */
export interface ScriptRunRequest {
    script: string;
    charDir?: string;
    chatName?: string;
}
export interface ScriptRunResponse {
    ok: true;
    pipe: unknown;
    isAborted: boolean;
    ops: unknown[];
    notifications: unknown[];
    popups: unknown[];
    inputs: unknown[];
}

/** POST /th/call —— TavernHelper 兼容调用面。 */
export interface ThCallTarget {
    charDir?: string;
    chatName?: string;
}
export interface ThCallRequest {
    method: string;
    target?: ThCallTarget;
    args?: Record<string, unknown>;
}
export type ThCallResponse =
    | { ok: true; result?: unknown; [k: string]: unknown }
    | { ok: false; unsupported: true; method: string }
    | { ok: false; error: string; status?: number };

// =========================================================================
// named-docs —— /named-docs/*(TASK-058 读面 + TASK-063 写面;
//                GET 走 sendJsonResource ETag 私有读,PUT/DELETE 为孪生写面)
// =========================================================================

/** 白名单桶名(URL 形);服务端映射到 repo camelCase 桶。 */
export const NAMED_DOC_BUCKETS = ['quick-replies', 'themes', 'moving-ui'] as const;
export type NamedDocBucket = (typeof NAMED_DOC_BUCKETS)[number];

/** GET /named-docs/:bucket → 名单(字典序)。 */
export interface NamedDocListResponse {
    names: string[];
}

/**
 * GET /named-docs/:bucket/:name → 具名文档原文。
 * 形状按桶而异(quick-replies = {qrList:[{label,message,isHidden,…}]},
 * themes/moving-ui 为自由 JSON),消费方按桶解释。
 */
export type NamedDocGetResponse = Record<string, unknown>;

/** named-docs 读面错误(sendResourceReadError 形,{code,resource,detail?})。 */
export interface NamedDocErrorResponse {
    code: 'not_found' | 'invalid_resource' | 'read_failed';
    resource: string;
    detail?: string;
}

/**
 * PUT /named-docs/:bucket/:name —— 整档写回(TASK-063 写面)。
 * body = 文档本体(自由 JSON 对象,QR 册 = {version?,name?,qrList:[…],…});
 * 服务端把 doc.name 归一到路由名(URL 是唯一权威名,legacy /save 的
 * body.name 落点名语义在 REST 面收敛)。其余键原样透传。
 * 非对象 body → 400。
 */
export type NamedDocSaveRequest = Record<string, unknown>;
export interface NamedDocSaveResponse {
    ok: true;
    name: string;
}

/** DELETE /named-docs/:bucket/:name → 204;missing → 404 {error}(strict 删除)。 */
export type NamedDocDeleteResponse = void;

// =========================================================================
// data —— import / backup / lan
// =========================================================================

/** POST /import/scan-st(admin;dir 是服务端路径)。 */
export interface ImportScanRequest {
    dir: string;
}
export interface ImportScanItem {
    kind: string;
    name: string;
    file: string;
    bytes: number;
}
export interface ImportScanResponse {
    root: string;
    total: number;
    counts: Record<string, number>;
    items: ImportScanItem[];
}

export const IMPORT_KINDS = ['char', 'world', 'preset', 'persona'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const IMPORT_CONFLICT_POLICIES = ['rename', 'overwrite', 'skip'] as const;
export type ImportConflictPolicy = (typeof IMPORT_CONFLICT_POLICIES)[number];

/** preview/commit 共用载荷:base64 JSON 体(multipart 暂不进本包)。 */
export interface ImportPayloadRequest {
    /** 原始文件名(扩展名嗅探用),不是目标名。 */
    name: string;
    dataBase64: string;
    kind?: ImportKind;
    targetName?: string;
    conflict?: ImportConflictPolicy;
    apiId?: string;
}

export interface ImportPreviewResponse {
    kind: ImportKind | (string & {});
    name: string;
    targetName: string;
    avatarKey?: string;
    summary: Record<string, unknown>;
    warnings: string[];
    conflicts: { existingSameName: boolean };
}

export interface ImportCommitResponse {
    ok: true;
    kind: ImportKind | (string & {});
    name: string;
    targetName: string;
    avatarKey?: string;
    renamed: boolean;
    skipped?: boolean;
    warnings?: string[];
}

/** POST /backup —— 响应是 zip 附件二进制,不是 JSON。 */
export interface BackupRequest {
    selection?: Record<string, boolean>;
}

export interface LanOfferRequest {
    /** 缺省=认证 handle;跨 handle 需 admin。 */
    handle?: string;
    selection?: Record<string, boolean>;
}
export interface LanOfferResponse {
    /** 一次性 offer URL(对端 /api/users/transfer/backup/<token>,~10min)。 */
    url: string;
    expiresAt: number;
}

export interface LanImportRequest {
    /** 对端 lan-offer 产出的一次性 URL。 */
    url: string;
    handle?: string;
    selection?: Record<string, boolean>;
    mode?: 'merge' | 'overwrite';
}
/** lan-import 是 legacy 面薄代理——上游应答原样透传,形状不做承诺。 */
export type LanImportResponse = Record<string, unknown>;

// =========================================================================
// misc —— ws-ticket
// =========================================================================

/** POST /api/ws-ticket → {ticket}(一次性,~TTL 内有效,verify 即消耗)。 */
export interface WsTicketResponse {
    ticket: string;
}
