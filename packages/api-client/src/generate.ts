/**
 * Generation domain — /api/utopinn/{generate,preview,jobs} + WS ticket 流。
 * CLI generate 动词(send/say/impersonate/cmdGenerate)语义对齐:
 *   - generate():POST 回 {jobId(x-luker-generation-id 头优先),status,headers}。
 *   - streamJob():POST /api/ws-ticket → WS(luker-ws-ticket.<ticket>) →
 *     resume{from_seq} → head/chunk/end/error;断连一次重连续传。
 *   - attachJob():先短轮询 GET /jobs/:id——已终态直接回档(不建 WS);
 *     未完成才流;回执后 waitForJob 收权威 text(REST 优先于流文本)。
 *   - waitForJob():轮询到 persisted|终态|超时(同 CLI pollStatus,
 *     走 kernel /api/utopinn/jobs 字段超集)。
 *   - abort():legacy POST /api/generation/:id/abort——Utopinn 目前
 *     没有原生 abort 路由,CLI 同款保留。
 *   - generateWithStream():generate→attachJob 一条龙。
 */

import type {
    GeneratePreviewRequest,
    GenerateRequest,
    GenerateResponse,
    GenerationJobDetail,
    GenerationJobsResponse,
    JobStatus,
    PreviewResponse,
    WsJobErrorFrame,
    WsServerMessage,
    WsSubscribeErrorFrame,
    WsTicketResponse,
} from '@utopinn/protocol';
import { JOB_TERMINAL_STATUSES } from '@utopinn/protocol';
import { ApiError } from './errors.js';
import type { UtopinnClient } from './index.js';
import { streamJobEvents, type StreamJobResult } from './stream.js';

const P = '/api/utopinn';

export const isTerminalStatus = (status: string): boolean =>
    (JOB_TERMINAL_STATUSES as readonly string[]).includes(status);

/** POST /generate 的薄回执(jobId 走响应头;body 恒 {ok:true} 或群路 skipped)。 */
export interface GenerateAccepted {
    jobId: string | null;
    status: number;
    headers: Headers;
    data: GenerateResponse;
}

/** POST /preview 的薄回执。 */
export interface PreviewAccepted {
    status: number;
    headers: Headers;
    data: PreviewResponse;
}

export interface StreamCallbacks {
    onDelta?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    /** 全帧回调(head/chunk/end/error;ping 已消化不上抛)。 */
    onFrame?: (frame: WsServerMessage) => void;
    onEnd?: (frame: WsServerMessage) => void;
    onError?: (frame: WsJobErrorFrame | WsSubscribeErrorFrame) => void;
    signal?: AbortSignal;
}

export interface WaitForJobOptions {
    waitMs?: number;   // 默认 60s
    pollMs?: number;   // 默认 700ms
    breakOn?: JobStatus[];
}

export interface AttachJobResult {
    jobId: string;
    /** 权威 job 档(REST GET)。 */
    job: GenerationJobDetail | null;
    /** job.text 优先,流文本兜底(CLI 同款权威序)。 */
    text: string;
    /** 若走了流,返回流消费结果;已终态直回时 null。 */
    stream: StreamJobResult | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GenerationApi {
    constructor(private readonly client: UtopinnClient) {}

    /**
     * CLI gen/preview/send/say/impersonate/cmdGenerate 的 POST 步。
     * body 照 cli 的 GenerateRequest 拼(verb/api_server/messages/messages_ref/…)。
     */
    async generate(body: GenerateRequest, opts: { timeout?: number } = {}): Promise<GenerateAccepted> {
        const r = await this.client.requestRaw(`${P}/generate`, {
            method: 'POST',
            body,
            timeout: opts.timeout,
        });
        if (r.status >= 400) {
            throw new ApiError(r.status, r.data, `HTTP ${r.status} POST ${P}/generate`, undefined, r.headers);
        }
        const jobId = r.headers.get('x-luker-generation-id')
            ?? body.luker_generation?.job_id
            ?? null;
        return { jobId, status: r.status, headers: r.headers, data: r.data as GenerateResponse };
    }

    /** CLI `preview --dry`:同一执行链,不落楼层、不进运行表。 */
    async preview(body: GeneratePreviewRequest): Promise<PreviewAccepted> {
        const r = await this.client.requestRaw(`${P}/preview`, { method: 'POST', body });
        if (r.status >= 400) {
            throw new ApiError(r.status, r.data, `HTTP ${r.status} POST ${P}/preview`, undefined, r.headers);
        }
        return { status: r.status, headers: r.headers, data: r.data as PreviewResponse };
    }

    /** CLI `jobs`(?limit)。 */
    jobs(opts: { limit?: number } = {}): Promise<GenerationJobsResponse> {
        return this.client.request(`${P}/jobs`, { query: { limit: opts.limit } });
    }

    /** CLI `job-get`(kernel 面;trace/sources/promptMessages/timedWorldInfo 全带)。 */
    jobGet(id: string): Promise<GenerationJobDetail> {
        return this.client.request(`${P}/jobs/${encodeURIComponent(id)}`);
    }

    /**
     * ⚠ legacy 控制路由:POST /api/generation/:request_id/abort。
     * Utopinn 没有原生 jobs abort 面;CLI `abort` 保留同款。
     */
    abort(id: string): Promise<{ ok: true } | Record<string, unknown>> {
        return this.client.request(`/api/generation/${encodeURIComponent(id)}/abort`, { method: 'POST' });
    }

    /** POST /api/ws-ticket → {ticket}(一次性 30s TTL;WS 子协议 verify 即消耗)。 */
    wsTicket(): Promise<WsTicketResponse> {
        return this.client.request('/api/ws-ticket', { method: 'POST' });
    }

    /**
     * WS 流消费(ticket → subscribe/resume → 帧;断连重连一次续传)。
     * 必须在 POST /generate 之后挂(job 不存在 subscribe 期会被 not_found 拒)。
     */
    async streamJob(jobId: string, opts: StreamCallbacks & { mode?: 'resume' | 'subscribe'; fromSeq?: number; waitMs?: number } = {}): Promise<StreamJobResult> {
        return streamJobEvents({
            ticket: async () => (await this.wsTicket()).ticket,
            wsUrl: () => this.client.wsBaseUrl(),
            wsFactory: () => this.client.wsFactory(),
        }, jobId, opts);
    }

    /**
     * CLI pollStatus:轮询 GET /jobs/:id 到 persisted|终态|超时。
     * 回最后一眼(超时也回 job,不 throw;取不到 → null)。
     */
    async waitForJob(jobId: string, opts: WaitForJobOptions = {}): Promise<GenerationJobDetail | null> {
        const terminals = new Set<string>([...JOB_TERMINAL_STATUSES, ...(opts.breakOn ?? [])]);
        const deadline = Date.now() + (opts.waitMs ?? 60_000);
        const pollMs = opts.pollMs ?? 700;
        let job: GenerationJobDetail | null = null;
        while (Date.now() < deadline) {
            job = await this.jobGet(jobId).catch(() => job);
            if (job && (job.persisted === true || terminals.has(job.status))) break;
            await sleep(pollMs);
        }
        return job;
    }

    /**
     * CLI `attach`:先看档——已终态直接回档;跑着才建流;
     * 流回执后再 waitForJob 收权威 text。
     * statusWaitMs:前置短轮询窗口(默认 3s,CLI 同款"先等它落"窗口)。
     */
    async attachJob(jobId: string, opts: StreamCallbacks & { fromSeq?: number; waitMs?: number; statusWaitMs?: number; finalWaitMs?: number } = {}): Promise<AttachJobResult> {
        const seen = await this.waitForJob(jobId, { waitMs: opts.statusWaitMs ?? 3_000 });
        if (seen && (seen.persisted === true || isTerminalStatus(seen.status))) {
            return { jobId, job: seen, text: seen.text ?? '', stream: null };
        }
        const stream = await this.streamJob(jobId, {
            mode: 'resume',
            fromSeq: opts.fromSeq ?? 1,
            waitMs: opts.waitMs,
            signal: opts.signal,
            onDelta: opts.onDelta,
            onReasoning: opts.onReasoning,
            onFrame: opts.onFrame,
            onEnd: opts.onEnd,
            onError: opts.onError,
        });
        const finalJob = await this.waitForJob(jobId, { waitMs: opts.finalWaitMs ?? 30_000 });
        const job = finalJob ?? seen;
        const text = job?.text || stream.streamed || '';
        return { jobId, job, text, stream };
    }

    /** generate → attachJob 一条龙(CLI `gen`(非 --raw)同款编排)。 */
    async generateWithStream(body: GenerateRequest, opts: StreamCallbacks & { waitMs?: number } = {}): Promise<AttachJobResult & { accepted: GenerateAccepted }> {
        const accepted = await this.generate(body);
        if (!accepted.jobId) {
            throw new Error('generate: no job id (x-luker-generation-id header missing)');
        }
        const attached = await this.attachJob(accepted.jobId, opts);
        return { ...attached, accepted };
    }
}
