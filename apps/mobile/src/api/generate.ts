// Generation transport — POST /api/utopinn/generate then WS job stream.
// Server contract (apps/server/src/plugins/utopinn-generate.js +
// utopinn-delivery.js, verified in tests/e2e/utopinn-stream-delivery.mjs):
//   POST /api/utopinn/generate → 200 + `x-luker-generation-id` header;
//   the job runs in background, events arrive over /api/ws-delivery.
//   POST /api/ws-ticket → {ticket}; the ticket travels in the WS
//   subprotocol `luker-ws-ticket.<ticket>` because WS can't set headers.
//   `resume` (not `subscribe`) replays buffered events from from_seq —
//   safe even when the job already finished.
//   chunk.data = base64-encoded upstream SSE bytes; the client decodes and
//   parses `data:` lines for choices[].text / delta.content.
// Degradation: if the socket dies before `end`, waitForPersistedReply()
// polls the chat file until the assistant floor lands — never dead-wait.
import { b64ToBytes, createUtf8Decoder } from './b64';
import { client, getChat, type StChatMessage } from './client';
import { session } from './session';

export interface GenerateBody {
    charDir: string;
    chatName: string;
    /** 'chat' (default) | 'text' — server-side dispatch fork. */
    api?: string;
    type?: string;
    user?: { name: string; description?: string };
    presetName?: string;
    overrides?: Record<string, unknown>;
    /** api_type/api_server let callers point at a specific upstream (e2e stub). */
    [k: string]: unknown;
}

export async function postGenerate(body: GenerateBody): Promise<{ jobId: string }> {
    const res = await session.apiFetch('/api/utopinn/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} generate: ${text.slice(0, 200)}`);
    }
    const jobId = res.headers.get('x-luker-generation-id') ?? '';
    if (!jobId) throw new Error('missing x-luker-generation-id');
    return { jobId };
}

export interface JobStreamHandlers {
    /** Accumulated assistant text so far (deltas folded). */
    onDelta: (accumulated: string, delta: string) => void;
    onEnd?: () => void;
    onError?: (message: string) => void;
}

interface JobFrame {
    type?: string;
    seq?: number;
    data?: string;
    message?: string;
    code?: string;
}

/** SSE frames can split across chunk boundaries — only parse up to the last blank-line separator. */
function extractDelta(sseText: string): string {
    let out = '';
    for (const line of sseText.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:') || t === 'data: [DONE]') continue;
        try {
            const frame = JSON.parse(t.slice(5)) as {
                choices?: { delta?: { content?: string }; text?: string }[];
            };
            const choice = frame.choices?.[0];
            out += choice?.delta?.content ?? choice?.text ?? '';
        } catch {
            /* non-JSON data line — skip */
        }
    }
    return out;
}

/**
 * Resume a job over WS. Returns a close() to abort early.
 * onError fires at most once; an 'end' frame settles normally.
 */
export async function streamJob(jobId: string, h: JobStreamHandlers): Promise<() => void> {
    const { ticket } = await client().request<{ ticket: string }>('/api/ws-ticket', {
        method: 'POST',
        body: {},
    });
    const ws = new WebSocket(session.wsUrl('/api/ws-delivery'), `luker-ws-ticket.${ticket}`);
    const decodeUtf8 = createUtf8Decoder();
    let acc = '';
    let pending = '';
    let settled = false;

    const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        try {
            ws.close();
        } catch {
            /* already closed */
        }
        h.onError?.(msg);
    };

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resume', request_id: jobId, from_seq: 1 }));
    };
    ws.onmessage = (ev: { data?: unknown }) => {
        let frame: JobFrame;
        try {
            frame = JSON.parse(String(ev.data)) as JobFrame;
        } catch {
            return;
        }
        if (frame.type === 'chunk' && frame.data) {
            pending += decodeUtf8(b64ToBytes(String(frame.data)));
            const cut = pending.lastIndexOf('\n\n');
            if (cut < 0) return;
            const complete = pending.slice(0, cut + 2);
            pending = pending.slice(cut + 2);
            const delta = extractDelta(complete);
            if (delta) {
                acc += delta;
                h.onDelta(acc, delta);
            }
        } else if (frame.type === 'end') {
            if (settled) return;
            settled = true;
            if (pending.trim()) {
                acc += extractDelta(pending);
                pending = '';
                if (acc) h.onDelta(acc, '');
            }
            h.onEnd?.();
            try {
                ws.close();
            } catch {
                /* noop */
            }
        } else if (frame.type === 'error') {
            fail(frame.message ?? 'job error');
        }
    };
    ws.onerror = () => fail('ws_error');
    ws.onclose = () => {
        // Closed without an end frame = dropped connection → caller falls back.
        if (!settled) fail('ws_closed');
    };
    return () => {
        settled = true;
        try {
            ws.close();
        } catch {
            /* already closed */
        }
    };
}

export interface PollOptions {
    /** Give up after this long (default 45s — textgen can be slow). */
    timeoutMs?: number;
    intervalMs?: number;
}

/**
 * WS-less completion path: poll the chat file until a floor after
 * `fromIndex` appears (the server persists the reply at end of job).
 * Returns the fresh message list, or null on timeout.
 */
export async function waitForPersistedReply(
    charDir: string,
    chatName: string,
    fromIndex: number,
    opts: PollOptions = {},
): Promise<StChatMessage[] | null> {
    const timeout = opts.timeoutMs ?? 45_000;
    const interval = opts.intervalMs ?? 1_500;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        try {
            const chat = await getChat(charDir, chatName);
            const msgs = chat.messages ?? [];
            if (msgs.length > fromIndex && msgs.slice(fromIndex).some((m) => !m.is_user && (m.mes ?? '').length)) {
                return msgs;
            }
        } catch {
            /* transient — keep polling */
        }
    }
    return null;
}
