/**
 * WS job stream — `/api/ws-delivery` ticket protocol consumer.
 * Semantics mirror apps/cli/utopinn-cli.mjs `streamJob`:
 *   ticket → WS(`luker-ws-ticket.<ticket>`) → resume{from_seq} →
 *   head/chunk/end/error frames → base64 chunk → SSE delta lines →
 *   one reconnect+resume on abnormal close.
 *
 * WebSocket is injectable (browsers/RN/Node≥22 have a global; older Node
 * passes the `ws` package — its instances accept on*-handler assignment).
 */

import type {
    WsClientMessage,
    WsJobErrorFrame,
    WsServerMessage,
    WsSubscribeErrorFrame,
} from '@utopinn/protocol';
import { decodeBase64Utf8 } from './base64.js';

// ─── WebSocket abstraction ───────────────────────────────────────────────

/** Minimal WS surface the streamer needs (WHATWG-style handler properties). */
export interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onclose: ((ev: { code?: number; reason?: unknown }) => void) | null;
}
export type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike;

const WS_CLOSED = 3;

// ─── SSE delta parsing (port of CLI parseSSEDelta + sseBuf accumulation) ──

export interface SseDelta {
    /** choices[0].delta.content / choices[0].text — the visible reply stream. */
    delta?: string;
    /** choices[0].delta.reasoning_content — model思考流。 */
    reasoning?: string;
    /** `data:{luker:…}` trailer frame (job bookkeeping tail). */
    luker?: unknown;
    /** `data:[DONE]` marker. */
    done?: boolean;
}

/**
 * Parse ONE SSE line (`data: …`). Returns null for comments/event lines/keepalives.
 * Mirrors CLI parseSSEDelta exactly.
 */
export function parseSseDeltaLine(line: string): SseDelta | null {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { done: true };
    try {
        const j = JSON.parse(payload) as {
            luker?: unknown;
            choices?: { delta?: { content?: string; reasoning_content?: string }; message?: { content?: string; reasoning_content?: string }; text?: string }[];
        };
        if (j.luker) return { luker: j.luker };
        const d = j.choices?.[0]?.delta ?? j.choices?.[0]?.message ?? {};
        const delta = d.content ?? j.choices?.[0]?.text ?? '';
        const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : '';
        return (delta || reasoning) ? { delta, reasoning } : null;
    } catch {
        return null;
    }
}

/**
 * Incremental SSE text → delta decoder. Chunks arrive as arbitrary byte
 * splits; feed decoded chunk text, take parsed deltas per complete line.
 * `flush()` drains the tail buffer the same way CLI's post-loop sweep does.
 */
export class SseDeltaDecoder {
    private buf = '';
    push(text: string): SseDelta[] {
        this.buf += text;
        const out: SseDelta[] = [];
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i).replace(/\r$/, '');
            this.buf = this.buf.slice(i + 1);
            const p = parseSseDeltaLine(line);
            if (p) out.push(p);
        }
        return out;
    }
    flush(): SseDelta[] {
        const out: SseDelta[] = [];
        if (this.buf.includes('data:')) {
            for (const line of this.buf.split('\n')) {
                const p = parseSseDeltaLine(line.replace(/\r$/, ''));
                if (p) out.push(p);
            }
        }
        this.buf = '';
        return out;
    }
}

// ─── WS frame parsing ────────────────────────────────────────────────────

/**
 * Parse a raw WS message payload into a typed server frame.
 * Returns null for unparseable/binary payloads (server only sends JSON text).
 */
export function tryParseWsMessage(raw: unknown): WsServerMessage | null {
    let f: unknown = raw;
    if (typeof raw !== 'object' || raw === null || raw instanceof Uint8Array || raw instanceof ArrayBuffer ||
        (typeof Blob !== 'undefined' && raw instanceof Blob)) {
        try { f = JSON.parse(String(raw)); } catch { return null; }
    }
    if (!f || typeof f !== 'object') return null;
    const t = (f as { type?: unknown }).type;
    if (t !== 'head' && t !== 'chunk' && t !== 'end' && t !== 'error' && t !== 'ping') return null;
    return f as WsServerMessage;
}

// ─── streamJob ───────────────────────────────────────────────────────────

export interface StreamJobDeps {
    /** POST /api/ws-ticket mint(一次性票据)。 */
    ticket(): Promise<string>;
    /** ws(s)://… base(url no trailing slash;`/api/ws-delivery` appended)。 */
    wsUrl(): string;
    wsFactory(): WebSocketFactory;
    sleep?: (ms: number) => Promise<void>;
}

export interface StreamJobOptions {
    /** 'resume'(默认,from_seq)|'subscribe'(零回放起点)。 */
    mode?: 'resume' | 'subscribe';
    fromSeq?: number;
    waitMs?: number;
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    /** 全帧回调(head/chunk/end/error;ping 已内部消化,不上抛)。 */
    onFrame?: (frame: WsServerMessage) => void;
    onEnd?: (frame: WsServerMessage) => void;
    onError?: (frame: WsJobErrorFrame | WsSubscribeErrorFrame) => void;
}

export interface StreamJobResult {
    jobId: string;
    /** 拼接后的可见回复流(权威文本以 GET /jobs/:id 的 text 为准)。 */
    streamed: string;
    /** 拼接后的 reasoning 流。 */
    reasoned: string;
    /** 按帧 type 计数。 */
    frames: Record<string, number>;
    lastSeq: number;
    /** job 级 error 帧 | 订阅期 error 帧 | {code:'ws'} 本地连接失败。 */
    error: WsJobErrorFrame | WsSubscribeErrorFrame | { type: 'error'; code: string; message: string } | null;
    /** `data:{luker:…}` 尾帧载荷(job 收尾簿记)。 */
    tailLuker: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Attach to a job's WS event stream and consume it to end/error/timeout.
 * WS 必须在 POST /generate 之后(job 不存在会被 not_found 拒)。
 */
export async function streamJobEvents(
    deps: StreamJobDeps,
    jobId: string,
    opts: StreamJobOptions = {},
): Promise<StreamJobResult> {
    const sleep = deps.sleep ?? defaultSleep;
    const result: StreamJobResult = {
        jobId, streamed: '', reasoned: '',
        frames: { head: 0, chunk: 0, end: 0, error: 0 },
        lastSeq: 0, error: null, tailLuker: null,
    };
    const decoder = new SseDeltaDecoder();
    let ws: WebSocketLike | undefined;
    let closedByUs = false;
    let doneResolve: () => void = () => undefined;
    const done = new Promise<void>((r) => { doneResolve = r; });

    const emitDelta = (p: SseDelta) => {
        if (p.delta) { result.streamed += p.delta; opts.onDelta?.(p.delta); }
        if (p.reasoning) { result.reasoned += p.reasoning; opts.onReasoning?.(p.reasoning); }
        if (p.luker) result.tailLuker = p.luker;
    };

    const connect = async (seq: number): Promise<void> => {
        const ticket = await deps.ticket();
        ws = deps.wsFactory()(`${deps.wsUrl()}/api/ws-delivery`, `luker-ws-ticket.${ticket}`);
        await new Promise<void>((res, rej) => {
            const to = setTimeout(() => rej(new Error('ws open timeout')), 10_000);
            ws!.onopen = () => {
                clearTimeout(to);
                const msg: WsClientMessage = opts.mode === 'subscribe'
                    ? { type: 'subscribe', request_id: jobId }
                    : { type: 'resume', request_id: jobId, from_seq: seq };
                ws!.send(JSON.stringify(msg));
                res();
            };
            ws!.onerror = () => { clearTimeout(to); rej(new Error('ws connect failed')); };
        });
        ws.onmessage = (evt) => {
            const f = tryParseWsMessage(evt?.data);
            if (!f) return;
            if (f.type === 'ping') {
                try { ws!.send(JSON.stringify({ type: 'pong', ts: f.ts } satisfies WsClientMessage)); } catch { /* dying */ }
                return;
            }
            if (f.request_id !== jobId) return;
            if ('seq' in f && typeof f.seq === 'number') result.lastSeq = Math.max(result.lastSeq, f.seq);
            result.frames[f.type] = (result.frames[f.type] ?? 0) + 1;
            opts.onFrame?.(f);
            if (f.type === 'chunk') {
                for (const p of decoder.push(decodeBase64Utf8(f.data))) emitDelta(p);
            } else if (f.type === 'error') {
                result.error = f;
                opts.onError?.(f);
                doneResolve();
            } else if (f.type === 'end') {
                opts.onEnd?.(f);
                doneResolve();
            }
        };
        ws.onclose = (e) => {
            const code = e?.code ?? 1005;
            if (!closedByUs && code !== 1000 && code !== 1005) doneResolve();
        };
        ws.onerror = () => doneResolve();
    };

    const onAbort = () => {
        closedByUs = true;
        try { ws?.close(1000); } catch { /* already gone */ }
        doneResolve();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
        await connect(opts.mode === 'subscribe' ? 0 : (opts.fromSeq ?? 1));
    } catch (e) {
        result.error = { type: 'error', code: 'ws', message: e instanceof Error ? e.message : String(e) };
        return result;
    }

    // 等待:done / 超时 / 断连重连一次(CLI 同款)
    const deadline = Date.now() + (opts.waitMs ?? 180_000);
    let reconnected = false;
    while (Date.now() < deadline) {
        const winner = await Promise.race([done, sleep(1500).then(() => 'tick' as const)]);
        if (winner !== 'tick') break;
        if (result.frames.end || result.error) break;
        if (ws!.readyState === WS_CLOSED && !reconnected) {
            reconnected = true;
            try { await connect(result.lastSeq + 1); } catch { break; }
        } else if (ws!.readyState === WS_CLOSED) break;
    }

    closedByUs = true;
    opts.signal?.removeEventListener('abort', onAbort);
    try { ws!.close(1000); } catch { /* already gone */ }
    // SSE 尾残留(流尾不带 \n 的 data 行)
    for (const p of decoder.flush()) emitDelta(p);
    return result;
}
