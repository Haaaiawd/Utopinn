// POST /api/utopinn/generate + WS job stream.
// Server contract (apps/server):
//   POST /api/utopinn/generate → 200 + `x-luker-generation-id` header; the job
//   runs in background, events delivered via /api/ws-delivery.
//   POST /api/ws-ticket → {ticket} (one-shot, mounted behind session+CSRF).
//   WS upgrade: Sec-WebSocket-Protocol `luker-ws-ticket.<ticket>` — the ticket
//   travels in the subprotocol because browsers can't set WS headers.
//   Completed jobs replay via {type:'resume', request_id, from_seq} —
//   `subscribe` only streams future events (verified in e2e).
//   Chunk frames carry base64-encoded upstream SSE bytes; the client decodes
//   and parses `data:` lines for delta content.
import { ApiError, apiPost } from './client';
import type { PreviewRequestBody } from '../types';

export interface GenerateResult {
    /** Job id == request_id for ws resume; from response header. */
    jobId: string;
}

export async function postGenerate(body: PreviewRequestBody): Promise<GenerateResult> {
    const { apiFetch } = await import('./client');
    const res = await apiFetch('/api/utopinn/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) {
        const unreachable = res.status === 502 && res.headers.has('x-utopinn-proxy-error');
        const text = await res.text().catch(() => '');
        throw new ApiError(unreachable ? 'upstream_unavailable' : (text || res.statusText), res.status);
    }
    const jobId = res.headers.get('x-luker-generation-id') ?? '';
    if (!jobId) throw new ApiError('missing x-luker-generation-id', res.status);
    return { jobId };
}

export interface JobStreamHandlers {
    /** Accumulated assistant text so far (deltas folded). */
    onDelta: (accumulated: string, delta: string) => void;
    onEnd?: () => void;
    onError?: (message: string) => void;
}

/** base64 → utf8 (browser atob on binary string). */
function b64decode(b64: string): string {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/**
 * SSE frames can split across chunk boundaries — accumulate raw text and only
 * parse frames terminated by the blank-line separator; the tail is carried.
 */
function extractDelta(sseText: string): string {
    let out = '';
    for (const line of sseText.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:') || t === 'data: [DONE]') continue;
        try {
            const frame = JSON.parse(t.slice(5));
            const choice = frame.choices?.[0];
            out += choice?.delta?.content ?? choice?.text ?? '';
        } catch { /* non-JSON data line — skip */ }
    }
    return out;
}

/**
 * Resume a (possibly in-flight) job over WS. The server replays all events
 * from `from_seq`, so subscribing after completion is safe.
 * Returns a close() to abort the stream early.
 */
export async function streamJob(jobId: string, h: JobStreamHandlers): Promise<() => void> {
    const { ticket } = await apiPost<{ ticket: string }>('/api/ws-ticket', {});
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/ws-delivery`, `luker-ws-ticket.${ticket}`);
    let acc = '';
    let pending = '';
    ws.onopen = () => ws.send(JSON.stringify({ type: 'resume', request_id: jobId, from_seq: 1 }));
    ws.onmessage = (ev) => {
        let frame: { type?: string; data?: string; message?: string };
        try { frame = JSON.parse(String(ev.data)); } catch { return; }
        if (frame.type === 'chunk' && frame.data) {
            pending += b64decode(String(frame.data));
            const cut = pending.lastIndexOf('\n\n');
            if (cut < 0) return;
            const complete = pending.slice(0, cut + 2);
            pending = pending.slice(cut + 2);
            const delta = extractDelta(complete);
            if (delta) { acc += delta; h.onDelta(acc, delta); }
        } else if (frame.type === 'end') {
            if (pending.trim()) {
                try { acc += extractDelta(pending); } catch { /* malformed tail */ }
                if (acc) h.onDelta(acc, '');
                pending = '';
            }
            h.onEnd?.(); ws.close();
        } else if (frame.type === 'error') {
            h.onError?.(frame.message ?? 'job error'); ws.close();
        }
    };
    ws.onerror = () => h.onError?.('ws_error');
    return () => { try { ws.close(); } catch { /* already closed */ } };
}
