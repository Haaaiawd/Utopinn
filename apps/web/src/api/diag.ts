// Diag 观测面 /api/utopinn/diag/*(诊断与观测板块 + top-job-slot 数据源)。
// 服务端:apps/server/src/plugins/utopinn-diag.js + services/diag-bus.js
//   GET    /diag/events     kind/lvl(最低)/since/seq_gt/code/job/limit → {items,count,seq,size}
//   GET    /diag/errors     = events lvl≥warn 快捷面(同过滤参数)
//   GET    /diag/stats      环形缓冲水位:capacity/size/seq/dropped/byKind/byLvl
//   POST   /diag/client     前端/CardApp/CLI 自己的错误上报进总线
//   GET    /diag/jobs/:id/trace  聚合回放:job 详情 + injections 注入时序 + 相关事件
// 事件契约(diag-bus):{seq,ts,lvl,kind,code?,msg,ctx?,data?} —— ctx 白名单
// 指针袋(jobId/diagId/stage/plugin/model…),正文永远不进 msg。
import { apiGet, apiPost } from './client';
import type { JobDetail } from './jobs';

/** diag-bus DIAG_KINDS 十种(服务端权威词表,过滤片全集)。 */
export const DIAG_KINDS = [
    'http', 'job', 'generate', 'inject', 'th',
    'state', 'storage', 'plugin', 'ws', 'client',
] as const;
export type DiagKind = (typeof DIAG_KINDS)[number];

/** diag-bus DIAG_LVLS;lvl 过滤参数是"最低等级"(warn = warn+error)。 */
export const DIAG_LVLS = ['debug', 'info', 'warn', 'error'] as const;
export type DiagLvl = (typeof DIAG_LVLS)[number];

/** ctx 白名单指针袋(diag-bus CTX_KEYS)——标量指针,无正文。 */
export interface DiagEventCtx {
    route?: string; method?: string; path?: string; status?: number;
    jobId?: string; diagId?: string; chatId?: string; chatKey?: string;
    charDir?: string; groupId?: string; verb?: string; stage?: string;
    source?: string; plugin?: string; scope?: string; handle?: string;
    endpoint?: string; model?: string; preset?: string;
    [extra: string]: string | number | boolean | undefined;
}

export interface DiagEvent {
    seq: number;
    ts: number;
    lvl: DiagLvl | (string & {});
    kind: DiagKind | (string & {});
    code?: string;
    msg: string;
    ctx?: DiagEventCtx;
    /** 递归瘦身小对象(深≤4/数组≤50/长串截断);WI 激活明细在 data.entries。 */
    data?: unknown;
}

export interface DiagEventsReply {
    items: DiagEvent[];
    count: number;
    /** 服务端环当前 seq 水位(增量拉取用它当 seq_gt 起点)。 */
    seq: number;
    size: number;
}

/** /diag/events|errors 的过滤参数(与 diag-bus query 一一对应)。 */
export interface DiagEventFilter {
    /** 精确 kind。 */
    kind?: DiagKind | (string & {});
    /** 最低等级('warn' → warn+error);不传 = 全部等级。 */
    lvl?: DiagLvl | (string & {});
    /** ts ms 或可 Date.parse 的串。 */
    since?: number | string;
    /** 增量拉取:只要 seq > N。 */
    seq_gt?: number;
    /** 精确 code。 */
    code?: string;
    /** ctx.jobId 或 ctx.diagId(组装事件比 job 先出生,靠 diagId 认亲)。 */
    job?: string;
    /** 默认 200,服务端上限 2000。 */
    limit?: number;
}

function qs(f: DiagEventFilter): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
        if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
}

/** GET /diag/events —— 全过滤事件面(旧→新,尾 limit 条)。 */
export async function listEvents(filter: DiagEventFilter = {}): Promise<DiagEventsReply> {
    return apiGet(`/api/utopinn/diag/events${qs(filter)}`);
}

/** GET /diag/errors —— lvl≥warn 快捷面;同过滤参数(lvl 由服务端钉死)。 */
export async function listErrors(filter: Omit<DiagEventFilter, 'lvl'> = {}): Promise<DiagEventsReply> {
    return apiGet(`/api/utopinn/diag/errors${qs(filter)}`);
}

/** GET /diag/stats —— 环形缓冲水位 + 各 kind/lvl 计数。 */
export interface DiagBusStats {
    capacity: number;
    size: number;
    seq: number;
    dropped: number;
    byKind: Record<string, number>;
    byLvl: Record<string, number>;
    oldest: number | null;
    newest: number | null;
}

export async function diagStats(): Promise<DiagBusStats> {
    return apiGet('/api/utopinn/diag/stats');
}

/** 注入时序行(kind='inject' 事件的展开:stage + data 摊平)。
 *  stage 工程八段:preset/load/charbook/instruct/worldinfo/regex/assemble/macro
 *  (+动态 stage);entries 仅 worldinfo 带(激活条目明细)。 */
export interface JobInjection {
    ts: number;
    seq: number;
    stage: string | null;
    injected?: number;
    tokens?: number;
    ms?: number;
    entries?: {
        world?: string | null;
        uid?: number | string | null;
        key?: unknown;
        [extra: string]: unknown;
    }[];
    [extra: string]: unknown;
}

/** GET /diag/jobs/:id/trace —— job 详情 + 注入时序 + 相关事件聚合回放。
 *  perf 是 job 生命周期耗时(组装 totalMs 在 perf.totalMs);promptMessages/
 *  timedWorldInfo 是组装明细,体量可大,消费方自定深浅。 */
export interface JobTrace {
    id: string;
    status: string;
    verb: string | null;
    model: string;
    chatKey: string | null;
    diagId: string | null;
    text: string;
    error: string | null;
    persisted: boolean;
    lastSeq: number;
    eventCount: number;
    trace: JobDetail['trace'];
    sources: JobDetail['sources'];
    perf: { totalMs?: number; [extra: string]: unknown } | null;
    promptMessages: unknown;
    timedWorldInfo: unknown;
    created_at: number;
    updated_at: number;
    injections: JobInjection[];
    /** 相关事件(jobId ∪ diagId 双键认亲,按 seq 归序)。 */
    events: DiagEvent[];
}

export async function getJobTrace(id: string): Promise<JobTrace> {
    return apiGet(`/api/utopinn/diag/jobs/${encodeURIComponent(id)}/trace`);
}

/** POST /diag/client —— 客户端事件上报(lvl/kind 服务端白名单校验,
 *  默认 warn/client;ctx/data 自由键不污染检索面)。 */
export async function postClientEvent(body: {
    lvl?: DiagLvl | (string & {});
    kind?: DiagKind | (string & {});
    code?: string;
    msg: string;
    ctx?: Record<string, unknown>;
    data?: unknown;
}): Promise<{ ok: boolean; seq: number | null }> {
    return apiPost('/api/utopinn/diag/client', body);
}
