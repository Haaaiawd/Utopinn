// WS stream smoke tests — fake WebSocketLike; no real connection.
// Covers: ticket→subprotocol handshake, resume frame, ping→pong,
// base64 chunk → SSE delta accumulation, end frame, frame counting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = (p) => join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', p);
const {
    UtopinnClient,
    tryParseWsMessage, parseSseDeltaLine, SseDeltaDecoder,
    decodeBase64Utf8, encodeBase64Bytes, decodeBase64Bytes,
    streamJobEvents,
} = await import(dist('index.js'));

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ── pure parsers ─────────────────────────────────────────────────────────

test('tryParseWsMessage: typed frames parse, junk returns null', () => {
    const job = { type: 'chunk', request_id: 'j', seq: 3, data: 'AA==' };
    assert.deepEqual(tryParseWsMessage(JSON.stringify(job)), job);
    assert.equal(tryParseWsMessage(JSON.stringify(job)).type, 'chunk');
    // Buffer input (Node `ws` package hands Buffers)
    assert.equal(tryParseWsMessage(Buffer.from(JSON.stringify(job))).type, 'chunk');
    // ping is a server frame too
    assert.equal(tryParseWsMessage('{"type":"ping","ts":1}').type, 'ping');
    assert.equal(tryParseWsMessage('not json'), null);
    assert.equal(tryParseWsMessage('{"type":"mystery"}'), null);
    assert.equal(tryParseWsMessage(null), null);
    assert.equal(tryParseWsMessage({}), null);
});

test('parseSseDeltaLine: delta/reasoning/luker/done, comments ignored', () => {
    assert.deepEqual(
        parseSseDeltaLine('data: {"choices":[{"delta":{"content":"hi"}}]}'),
        { delta: 'hi', reasoning: '' });
    assert.deepEqual(
        parseSseDeltaLine('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}'),
        { delta: '', reasoning: 'think' });
    assert.deepEqual(parseSseDeltaLine('data: {"luker":{"x":1}}'), { luker: { x: 1 } });
    assert.deepEqual(parseSseDeltaLine('data: [DONE]'), { done: true });
    assert.equal(parseSseDeltaLine('event: status'), null);
    assert.equal(parseSseDeltaLine(': keepalive'), null);
    assert.equal(parseSseDeltaLine('data: {bad json'), null);
});

test('SseDeltaDecoder: byte-split chunks accumulate correctly + flush tail', () => {
    const d = new SseDeltaDecoder();
    // split mid-line: 'data: {"cho' + 'ices":...'
    const part1 = 'data: {"choices":[{"delta":{"content":"Hel';
    const part2 = 'lo"}}]}\n\ndata: [DONE]\n';
    assert.deepEqual(d.push(part1), []);
    const out = d.push(part2);
    assert.equal(out[0].delta, 'Hello');
    assert.equal(out[1].done, true);
    // tail without trailing newline still yields via flush
    const d2 = new SseDeltaDecoder();
    assert.deepEqual(d2.push('data: {"choices":[{"delta":{"content":"tail"}}]}'), []);
    assert.equal(d2.flush()[0].delta, 'tail');
});

test('base64 portable round-trip (pure-js path exercised too)', () => {
    const s = 'data: {"choices":[{"delta":{"content":"世界"}}]}\n';
    const enc = encodeBase64Bytes(new TextEncoder().encode(s));
    assert.equal(Buffer.from(enc, 'base64').toString('utf8'), s); // enc is valid b64
    assert.equal(decodeBase64Utf8(b64(s)), s);
    assert.deepEqual([...decodeBase64Bytes(b64('abc'))], [...Buffer.from(b64('abc'), 'base64')]);
});

// ── fake WebSocket + streamJob ───────────────────────────────────────────

function fakeWsFactory(frames, opts = {}) {
    const instances = [];
    const factory = (url, protocols) => {
        const ws = {
            readyState: 0, url, protocols, sent: [],
            onopen: null, onmessage: null, onerror: null, onclose: null,
            send(d) { this.sent.push(JSON.parse(d)); },
            close() { this.readyState = 3; this.onclose?.({ code: 1000 }); },
        };
        instances.push(ws);
        setTimeout(() => {
            ws.readyState = 1;
            ws.onopen?.({});
            // microtask AFTER res()'s continuation (which assigns onmessage)
            queueMicrotask(() => {
                for (const f of frames) {
                    if (ws.readyState !== 1) break;
                    ws.onmessage?.({ data: typeof f === 'string' ? f : JSON.stringify(f) });
                }
            });
        }, 0);
        return ws;
    };
    factory.instances = instances;
    return factory;
}

const sseText = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test('streamJob: ticket→protocol handshake, resume, ping→pong, deltas, end', async () => {
    const frames = [
        { type: 'ping', ts: 11 },
        { type: 'head', request_id: 'j1', seq: 1, status: 200 },
        { type: 'chunk', request_id: 'j1', seq: 2, data: b64(sseText('Hello, ')) },
        { type: 'chunk', request_id: 'j1', seq: 3, data: b64(sseText('world') + 'data: [DONE]\n\n') },
        { type: 'chunk', request_id: 'OTHER', seq: 9, data: b64(sseText('noise')) }, // filtered
        { type: 'end', request_id: 'j1', seq: 4 },
    ];
    const factory = fakeWsFactory(frames);
    const deltas = [];
    const ticketCalls = [];
    const result = await streamJobEvents({
        ticket: async () => { ticketCalls.push(1); return 'tk-1'; },
        wsUrl: () => 'ws://server',
        wsFactory: () => factory,
    }, 'j1', { onDelta: (d) => deltas.push(d), waitMs: 5_000 });

    const ws = factory.instances[0];
    assert.equal(ticketCalls.length, 1);
    assert.equal(ws.url, 'ws://server/api/ws-delivery');
    assert.equal(ws.protocols, 'luker-ws-ticket.tk-1');
    // first frame sent after open: resume
    assert.deepEqual(ws.sent[0], { type: 'resume', request_id: 'j1', from_seq: 1 });
    // ping → pong(ts echo)
    assert.deepEqual(ws.sent[1], { type: 'pong', ts: 11 });
    assert.equal(result.streamed, 'Hello, world');
    assert.equal(result.lastSeq, 4);
    assert.equal(result.frames.chunk, 2);
    assert.equal(result.frames.end, 1);
    assert.equal(result.error, null);
    assert.deepEqual(deltas, ['Hello, ', 'world']);
});

test('streamJob: job error frame surfaces via onError + result.error', async () => {
    const frames = [{ type: 'error', request_id: 'j1', seq: 5, code: 'upstream', message: 'boom' }];
    const factory = fakeWsFactory(frames);
    let errFrame = null;
    const result = await streamJobEvents({
        ticket: async () => 't',
        wsUrl: () => 'ws://s',
        wsFactory: () => factory,
    }, 'j1', { onError: (f) => { errFrame = f; }, waitMs: 5_000 });
    assert.equal(result.error.code, 'upstream');
    assert.equal(errFrame.message, 'boom');
});

test('streamJob: subscribe mode sends subscribe frame', async () => {
    const factory = fakeWsFactory([{ type: 'end', request_id: 'j', seq: 1 }]);
    await streamJobEvents({
        ticket: async () => 't', wsUrl: () => 'ws://s', wsFactory: () => factory,
    }, 'j', { mode: 'subscribe', waitMs: 5_000 });
    assert.deepEqual(factory.instances[0].sent[0], { type: 'subscribe', request_id: 'j' });
});

test('client.generation.streamJob: end-to-end via injected webSocket+fetch', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        calls.push(u.pathname);
        if (u.pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'c' }));
        if (u.pathname === '/api/ws-ticket') return new Response(JSON.stringify({ ticket: 'tk-9' }));
        return new Response('{}');
    };
    const factory = fakeWsFactory([
        { type: 'chunk', request_id: 'j2', seq: 1, data: b64(sseText('ok')) },
        { type: 'end', request_id: 'j2', seq: 2 },
    ]);
    const client = new UtopinnClient({ baseUrl: 'http://s', fetch: fetchImpl, webSocket: factory });
    const deltas = [];
    const r = await client.generation.streamJob('j2', { onDelta: (d) => deltas.push(d), waitMs: 5_000 });
    assert.equal(r.streamed, 'ok');
    assert.deepEqual(deltas, ['ok']);
    assert.ok(calls.includes('/api/ws-ticket'));
    assert.equal(factory.instances[0].protocols, 'luker-ws-ticket.tk-9');
});

test('attachJob: terminal job short-circuits without WS', async () => {
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/csrf-token') return new Response(JSON.stringify({ token: 'c' }));
        if (u.pathname === '/api/utopinn/jobs/j3') {
            return new Response(JSON.stringify({
                id: 'j3', status: 'completed', persisted: true, text: 'final text',
                verb: 'send', model: 'm', chatKey: null, error: null,
                lastSeq: 5, eventCount: 5, trace: null, sources: null,
                promptMessages: null, timedWorldInfo: null, created_at: 1, updated_at: 2,
            }));
        }
        return new Response('{}');
    };
    let wsCreated = 0;
    const client = new UtopinnClient({
        baseUrl: 'http://s', fetch: fetchImpl,
        webSocket: (...a) => { wsCreated++; return fakeWsFactory([])(...a); },
    });
    const r = await client.generation.attachJob('j3', { statusWaitMs: 500 });
    assert.equal(r.text, 'final text');
    assert.equal(r.stream, null);
    assert.equal(wsCreated, 0);
});
