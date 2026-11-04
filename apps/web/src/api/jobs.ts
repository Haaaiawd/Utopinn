// Generation jobs via /api/uberge/jobs(TASK-017 监视/回放面)。
// 列表=摘要(新→旧);详情=状态/文本/trace(组装分块)/sources(WI轨迹)。
// events 不回传 —— 事件流走 WS resume 通道,详情面回放的是落盘文本。
import { apiGet } from './client';

export interface JobSummary {
    id: string;
    status: string;
    chatKey: string | null;
    textPreview: string;
    error: string | null;
    persisted: boolean;
    eventCount: number;
    hasTrace: boolean;
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
    return apiGet('/api/uberge/jobs');
}

export async function getJob(id: string): Promise<JobDetail> {
    return apiGet(`/api/uberge/jobs/${encodeURIComponent(id)}`);
}
