/**
 * Generation pipeline wire contract — SINGLE SOURCE OF TRUTH.
 *
 * 2026-11 audit 裁决:本文件原先描述的是一份理想化 wire(delta/final/
 * persisted 事件族),与服务端实际 wire(Luker fork 的 head/chunk/end +
 * request_id/seq 帧)完全对不上 —— dead spec。服务端 wire 已部署且经
 * TASK-017 E2E 验证,客户端 TS 侧尚无消费者,故「类型迁就 wire」:
 * 本文件如实描述现行协议,不发明尚未实现的事件。
 *
 * 覆盖:
 *   POST /api/utopinn/generate   生产生成(chat completions dispatch)
 *   POST /api/utopinn/preview    干跑组装(dryRun,不落盘不写 effects)
 *   GET  /api/utopinn/jobs       本 handle 全部 job 摘要(新→旧)
 *   GET  /api/utopinn/jobs/:id   单 job 详情(text/trace/sources)
 *   POST /api/generation/:request_id/abort
 *   POST /api/ws-ticket         一次性 WS 票据
 *   WS   /api/ws-delivery       job 事件流(subscribe/resume/unsubscribe)
 *   SSE  legacy /generate 流    event: status|event 帧
 */

import type { WorldBook } from './resources.js';

// ---------- Generate request ----------

/** 生成类型 —— 上游 GENERATION_TYPE_TRIGGERS 同义集。 */
export const GENERATION_MODES = [
    'normal',
    'continue',
    'impersonate',
    'swipe',
    'regenerate',
    'quiet',
] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

/** Prompt-level overrides applied for this call only (never persisted). */
export interface GenerationOverrides {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** Instruct/context preset patch merged over presetRef. */
    presetPatch?: Record<string, unknown>;
    /** 覆盖 extension prompts 合并结果(advanced 用法)。 */
    extensionPrompts?: Record<string, unknown>;
}

/** Ephemeral document uploaded for assembly only — never persisted server-side. */
export interface EphemeralDocument {
    kind: 'worldbook' | 'regex' | 'preset' | 'other';
    name: string;
    document: WorldBook | Record<string, unknown>;
}

/**
 * 生成落点:dispatch 完成后把 assistant 楼层写回哪个会话。
 * 以服务端 wire 为准(luker-generation.js getPersistChatKey / persistTargetDefault):
 *   - 'none'      客户端自有写盘(swipe/continue/impersonate/quiet)——必须纯 {kind:'none'},
 *                 带上 avatar_url+file_name 会被当真 persist 目标,误替客户端写整楼。
 *   - 'character' 服务端兜底写盘到单卡会话(send/regen 默认)。
 *   - 'group'     群聊持久化目标(id = 群聊文件 id,成员楼层字段随 target 走)。
 */
export type PersistTarget =
    | { kind: 'none' }
    | { kind: 'character'; avatar_url: string; file_name: string; char_name?: string }
    | {
        kind: 'group'; id: string; char_name?: string;
        original_avatar?: string; force_avatar?: string; gen_id?: number;
        chat_metadata?: Record<string, unknown>;
    }
    /** 容错形:服务端只读 kind/avatar_url/file_name/id,其余字段透传。 */
    | ({ kind?: string; avatar_url?: string; file_name?: string; id?: string } & Record<string, unknown>);

/** POST /api/utopinn/generate 请求体(核心字段;dispatch 参数按源透传)。 */
export interface GenerateRequest {
    /** 单卡路必填;群路(给 groupId)时服务端自解析发言成员卡。 */
    charDir?: string;
    /** 单卡路必填;群路下服务端用群聊文件 id。 */
    chatName?: string;
    presetName?: string;
    /** 本次用户面;缺省取 request.user.profile.name。 */
    user?: { name: string; description?: string };
    /** 生成类型,驱动 WI trigger + 上游分支;缺省 'normal'。 */
    type?: GenerationMode | (string & {});
    /** 'chat'(默认,chat completions)|'text'(textgen 单串)。 */
    api?: 'chat' | 'text';
    api_type?: string;
    /** textgen 路显式覆盖 api_server(缺省按 api_type+settings 解析)。 */
    api_server?: string;
    /** 显式模型覆盖(textgen:body.model;chat:经 generation_overrides)。 */
    model?: string;
    /** 流式开关(缺省取 settings/preset 的 stream_openai);quiet 强转 false。 */
    stream?: boolean;
    /** 群路目标:给 groupId 即走群生成(charDir/chatName 服务端自解析)。 */
    groupId?: string;
    /** 群聊文件 id;缺省取群 doc.chat_id ?? doc.id。 */
    chatId?: string;
    /** 群路成员 force token(legacy force_chid 语义)。 */
    member?: string;
    overrides?: GenerationOverrides;
    /** 派发体最后并入的显式覆盖(优先级高于 preset/settings,会发给上游)。 */
    generation_overrides?: Record<string, unknown>;
    ephemeralDocs?: EphemeralDocument[];
    /** 预生成 job id —— 与 WS subscribe 的 request_id 对齐。 */
    luker_generation?: {
        job_id?: string;
        persist_target?: PersistTarget;
        /** Host-managed lifecycle: the caller (CardApp host) publishes
         *  generation_started/ended|stopped itself — the server transition
         *  funnel stays silent for this job (no double events). */
        th_self_managed?: boolean;
    };
    // —— 透传派发参数(chat_completion_source/model/temperature/…按上游 body 走)
    [key: string]: unknown;
}

/**
 * 响应:`200 {}` 空 JSON 体;job id 走头部。
 * 群路成员空(activatedMembers=[])= 不派发,直接回
 * `{ok:true, skipped:'no_activated_member', group:{groupId,chatId,queue:[]}}`。
 *   x-luker-generation-id     —— request_id(WS subscribe / jobs/:id / abort 同值)
 *   x-luker-server-persisted  —— '0' 初始快照;真正 persisted 态经 WS/SSE 或轮询获知
 *   x-utopinn-perf            —— JSON:组装耗时分解(perf)
 *   x-utopinn-group           —— JSON:群路成员选择轨迹(仅 groupId 请求)
 */
export interface GenerateResponse {
    ok?: boolean;
    /** 'no_activated_member'(群路空队列,无 job 产生)。 */
    skipped?: string;
    group?: { groupId: string; chatId: string; queue: unknown[] };
    [key: string]: unknown;
}

export interface GenerateAcceptedHeaders {
    'x-luker-generation-id': string;
    'x-luker-server-persisted': '0' | '1';
    'x-utopinn-perf'?: string;
    'x-utopinn-group'?: string;
}

// ---------- Jobs (REST) ----------

/**
 * Job 生命周期(server:luker-generation.js)。
 * 'awaiting_ack' = dispatch 收尾后等客户端写盘 ack(15s grace);
 * 'persisting'   = 服务端兜底写盘中。
 */
export const JOB_STATUSES = [
    'queued',
    'running',
    'streaming',
    'awaiting_ack',
    'persisting',
    'completed',
    'failed',
    'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** 终态集合 —— 轮询/waitForJob 的默认停机面。 */
export const JOB_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type JobTerminalStatus = (typeof JOB_TERMINAL_STATUSES)[number];

/** GET /api/utopinn/jobs → { items: GenerationJobSummary[] }(新→旧)。 */
export interface GenerationJobsResponse {
    items: GenerationJobSummary[];
}

export interface GenerationJobSummary {
    id: string;
    status: JobStatus | (string & {});
    /** 生成动词(requestMeta.verb;send/regen/swipe/…),旧 job 可 null。 */
    verb: string | null;
    /** 派发模型(job.modelName ?? requestMeta.model)。 */
    model: string;
    chatKey: string | null;
    textPreview: string;
    error: string | null;
    persisted: boolean;
    eventCount: number;
    hasTrace: boolean;
    created_at: number;
    updated_at: number;
}

/** GET /api/utopinn/jobs/:id → GenerationJobDetail(events 不回传,走 WS resume)。 */
export interface GenerationJobDetail {
    id: string;
    status: JobStatus | (string & {});
    verb: string | null;
    model: string;
    chatKey: string | null;
    text: string;
    error: string | null;
    persisted: boolean;
    lastSeq: number;
    eventCount: number;
    /** 组装 trace(prompt 分块/token 分段),TASK-017 诊断面。 */
    trace: unknown | null;
    /** WI 激活轨迹:uid/world/comment/key/position/depth/outlet 条目数组。 */
    sources: unknown | null;
    /**
     * TASK-034 reconcile:派发给上游的 messages 快照。
     * chat 路在 body.messages;textgen 路挂 request.utopinnPromptMessages。
     * 可空 —— legacy 派发与补件前创建的老 job 恒 null。
     */
    promptMessages: { role: string; content: string; name?: string }[] | null;
    /** TASK-034:WI timed effects 落库后快照(回同步 chat_metadata.timedWorldInfo)。可空。 */
    timedWorldInfo: unknown | null;
    created_at: number;
    updated_at: number;
}

/** POST /api/generation/:request_id/abort → 200 { aborted: true } | 400/403/404/409。 */
export interface AbortJobResponse {
    aborted: boolean;
    error?: string;
}

// ---------- WS /api/ws-delivery ----------
// upgrade 要求 `Sec-WebSocket-Protocol: luker-ws-ticket.<一次性票据>`;
// 票据由 POST /api/ws-ticket 在完整 HTTP 中间件链下签发。

/** client→server:附着到 job 事件流。 */
export interface WsSubscribe {
    type: 'subscribe';
    request_id: string;
}
/** client→server:断线重挂;回放 seq >= from_seq 的事件。 */
export interface WsResume {
    type: 'resume';
    request_id: string;
    from_seq: number;
}
export interface WsUnsubscribe {
    type: 'unsubscribe';
    request_id: string;
}
/** client→server:app 心跳回包;ts 回显 ping 的 ts(服务端只看 type)。 */
export interface WsPong {
    type: 'pong';
    ts?: number;
}
export type WsClientMessage = WsSubscribe | WsResume | WsUnsubscribe | WsPong;

// —— server→client:job 事件帧(eventToFrame 产物,seq 单调)——

/** 上游响应头帧(dispatch 开始时)。 */
export interface WsHeadFrame {
    type: 'head';
    request_id: string;
    seq: number;
    headers?: Record<string, string>;
    status?: number;
}
/** 上游流式分块;data 为原始 SSE 字节(二进制时为 base64 串)。 */
export interface WsChunkFrame {
    type: 'chunk';
    request_id: string;
    seq: number;
    data: string;
}
/** job 正常收尾。 */
export interface WsEndFrame {
    type: 'end';
    request_id: string;
    seq: number;
}
/** job 级错误帧(dispatch/上游失败)。 */
export interface WsJobErrorFrame {
    type: 'error';
    request_id: string;
    seq: number;
    code: string;
    message: string;
}
/** 心跳(server→client,~间隔由 WS_SERVER_PING_INTERVAL_MS 定)。 */
export interface WsPingFrame {
    type: 'ping';
    ts: number;
}
/** 订阅期错误(无 seq):request_id 无权限/不存在。 */
export interface WsSubscribeErrorFrame {
    type: 'error';
    request_id: string;
    code: 'forbidden' | 'not_found';
    message: string;
}

export type WsServerMessage =
    | WsHeadFrame
    | WsChunkFrame
    | WsEndFrame
    | WsJobErrorFrame
    | WsSubscribeErrorFrame
    | WsPingFrame;

// ---------- SSE(legacy /generate 同流备用面)----------
// `event: status` 快照 + `event: event` 单条回放/增量(entry 与 WS 帧同源)。

/** event: status —— 订阅即回 + 每次 status 迁移。 */
export interface SseStatusPayload {
    status: JobStatus | (string & {});
    text: string;
    last_seq: number;
    error: string;
    finished_at: number | null;
}

/**
 * event: event —— 服务端回放缓冲的单条事件。
 * kind 与 WS 帧一一对应(head/chunk/end/error);
 * chunk 的 data 为上游 SSE 字节。
 */
export interface SseEventEntry {
    seq: number;
    kind: 'head' | 'chunk' | 'end' | 'error';
    data: unknown;
}

// ---------- Preview ----------

/**
 * POST /api/utopinn/preview 请求体 —— 与 /generate 同形目标/组装字段
 * (charDir|chatName|groupId|chatId|member|presetName|user|type|overrides);
 * dispatch-only 字段被忽略,dryRun 恒 true。
 */
export type GeneratePreviewRequest = GenerateRequest;

/** POST /api/utopinn/preview → 干跑产物;dryRun 不写 timed effects/楼层。 */
export interface PreviewResponse {
    messages: { role: 'system' | 'user' | 'assistant' | (string & {}); content: string; name?: string }[];
    trace: unknown;
    /** 群路附加 {group:{groupId,chatId,mode,strategy,member,queue}}。 */
    sources: unknown;
    /** 群路空队列 skipped 时 perf 为 null。 */
    perf: {
        cardMs: number;
        loadMs: number;
        presetMs: number;
        wiMs: number;
        assembleMs: number;
        collectionMs: number;
        populateMs: number;
        tokenMs: number;
        totalMs: number;
    } | null;
    /** 'no_activated_member'(群路空队列)。 */
    skipped?: string;
}
