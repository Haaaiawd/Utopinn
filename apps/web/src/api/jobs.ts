// Generation jobs via /api/utopinn/jobs(TASK-017 监视/回放面)。
// 列表=摘要(新→旧);详情=状态/文本/trace(组装分块)/sources(WI轨迹)。
// events 不回传 —— 事件流走 WS resume 通道,详情面回放的是落盘文本。
import { ApiError, apiFetch, apiGet } from './client';

export interface JobSummary {
    id: string;
    status: string;
    verb: string | null;
    model: string;
    chatKey: string | null;
    textPreview: string;
    error: string | null;
    persisted: boolean;
    eventCount: number;
    hasTrace: boolean;
    totalMs: number | null;
    tokens: number | null;
    created_at: number;
    updated_at: number;
}

export interface JobDetail {
    id: string;
    status: string;
    chatKey: string | null;
    text: string;
    error: string | null;
    persisted: boolean;
    /**
     * Finalized-empty terminal: output regex consumed the whole reply.
     * Distinct from provider-empty (failed) — the job completed with
     * nothing to persist; clients must not fill the floor from raw
     * streamed chunks when this is true.
     */
    outputFiltered?: boolean;
    lastSeq: number;
    eventCount: number;
    trace: {
        collections?: { identifier: string; tokens: number }[];
        budget?: number;
        remaining?: number;
        [extra: string]: unknown;
    } | null;
    sources: {
        preset?: string;
        model?: string;
        chatCount?: number;
        worldInfo?: { activated?: unknown[] };
        [extra: string]: unknown;
    } | null;
    created_at: number;
    updated_at: number;
}

export async function listJobs(): Promise<{ items: JobSummary[] }> {
    return apiGet('/api/utopinn/jobs');
}

export async function getJob(id: string): Promise<JobDetail> {
    return apiGet(`/api/utopinn/jobs/${encodeURIComponent(id)}`);
}

const JOB_FINAL_STATUSES = new Set(['awaiting_ack', 'persisting', 'completed', 'failed', 'cancelled']);

/**
 * Poll GET /jobs/:id until the job leaves running/queued or the timeout
 * elapses, then return the last seen detail (null when never fetched).
 * The WS `end` frame precedes server-side finalization — output regex and
 * the filtered-empty check run after dispatch — so consumers needing the
 * authoritative finalized text must wait for the status to settle.
 */
export async function waitJobFinal(id: string, { timeoutMs = 5000, intervalMs = 250 } = {}): Promise<JobDetail | null> {
    const deadline = Date.now() + timeoutMs;
    let last: JobDetail | null = null;
    do {
        try {
            const job = await getJob(id);
            last = job;
            if (JOB_FINAL_STATUSES.has(String(job.status))) return job;
        } catch { /* transient fetch failure — keep polling until deadline */ }
        await new Promise((r) => setTimeout(r, intervalMs));
    } while (Date.now() < deadline);
    return last;
}

/**
 * POST /api/utopinn/jobs/:id/abort —— 中止在跑的生成任务(utopinn 孪生,
 * 与 legacy /api/generation/:id/abort 守卫同构:仅 running/queued 可中止)。
 * 应答:{aborted:true};job 不在 → ApiError(404 'not_found');
 * 非 running/queued(已完成/失败/awaiting_ack)→ ApiError(409 'not_running')。
 */
export async function abortJob(id: string): Promise<{ aborted: boolean }> {
    const res = await apiFetch(`/api/utopinn/jobs/${encodeURIComponent(id)}/abort`, { method: 'POST' });
    const body = (await res.json().catch(() => null)) as { aborted?: boolean; error?: string } | null;
    if (!res.ok) {
        const unreachable = res.status === 502 && res.headers.has('x-utopinn-proxy-error');
        throw new ApiError(unreachable ? 'upstream_unavailable' : (body?.error || res.statusText), res.status);
    }
    return { aborted: body?.aborted === true };
}
