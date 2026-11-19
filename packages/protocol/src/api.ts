// /api/utopinn/* REST wire contracts — endpoint shapes not covered by
// generation.ts (generation + WS) or panels.ts (panel bridge).
// Every shape mirrors the actual server wire in apps/server/src/plugins/utopinn-*.js;
// line references in .loom/eval/task038-cli-coverage-audit.md are the audit anchor.

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
 * PATCH /settings —— 受限浅合并,顶层键白名单:
 * 'power_user' | 'extension_settings';每段值必须是对象。
 * 其余顶层段(oai_settings 等)不经此端点写。
 */
export type SettingsPatchRequest = Record<'power_user' | 'extension_settings' | (string & {}), Record<string, unknown> | undefined>;

export interface SecretEntry {
    id: string;
    /** 已脱敏(服务端 SecretManager.getSecretState 原生打码)。 */
    value: string;
    label: string;
    active: boolean;
}
/** GET /secrets → {secrets: {key: SecretEntry[] | null}}(null = 未设)。 */
export interface SecretsResponse {
    secrets: Record<string, SecretEntry[] | null>;
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
