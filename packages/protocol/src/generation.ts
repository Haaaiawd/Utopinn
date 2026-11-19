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

/** 生成落点:dispatch 完成后把 assistant 楼层写回哪个会话。 */
export interface PersistTarget {
    /** 'char' = 单卡会话;group 暂不在 utopinn 面。 */
    kind?: 'char';
    avatar_url?: string;
    file_name?: string;
    char_name?: string;
}

/** POST /api/utopinn/generate 请求体(核心字段;dispatch 参数按源透传)。 */
export interface GenerateRequest {
    charDir: string;
    chatName: string;
    presetName?: string;
    /** 本次用户面;缺省取 request.user.profile.name。 */
    user?: { name: string; description?: string };
    /** 生成类型,驱动 WI trigger + 上游分支;缺省 'normal'。 */
    type?: GenerationMode | (string & {});
    /** 'chat'(默认,chat completions)|'text'(textgen 单串)。 */
    api?: 'chat' | 'text';
    api_type?: string;
    overrides?: GenerationOverrides;
    ephemeralDocs?: EphemeralDocument[];
    /** 预生成 job id —— 与 WS subscribe 的 request_id 对齐。 */
    luker_generation?: {
        job_id?: string;
        persist_target?: PersistTarget;
    };
    // —— 透传派发参数(chat_completion_source/model/temperature/…按上游 body 走)
    [key: string]: unknown;
}

/**
 * 响应:`200 {}` 空 JSON 体;job id 走头部。
 *   x-luker-generation-id     —— request_id(WS subscribe / jobs/:id / abort 同值)
 *   x-luker-server-persisted  —— '0' 初始快照;真正 persisted 态经 WS/SSE 或轮询获知
 */
export interface GenerateAcceptedHeaders {
    'x-luker-generation-id': string;
    'x-luker-server-persisted': '0' | '1';
}

// ---------- Jobs (REST) ----------

export const JOB_STATUSES = [
    'queued',
    'running',
    'streaming',
    'completed',
    'failed',
    'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** GET /api/utopinn/jobs → { items: GenerationJobSummary[] }(新→旧)。 */
export interface GenerationJobSummary {
    id: string;
    status: JobStatus | (string & {});
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
export interface WsPong {
    type: 'pong';
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

/** POST /api/utopinn/preview → 干跑产物;dryRun 不写 timed effects/楼层。 */
export interface PreviewResponse {
    messages: { role: 'system' | 'user' | 'assistant'; content: string; name?: string }[];
    trace: unknown;
    sources: unknown;
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
    };
}
