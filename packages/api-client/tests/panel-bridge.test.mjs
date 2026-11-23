// PanelBridge tests — 六门判序/台账/应答编码/传输 seam(收敛 §5.3)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { PanelBridge } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js'));

const NONCE = 'n-1';
const req = (over = {}) => ({
    channel: 'utopinn-panel', direction: 'request', nonce: NONCE,
    requestId: 'r1', method: 'th.getVariables', args: {}, ...over,
});

function makeBridge(over = {}) {
    const sent = [];
    const dispatched = [];
    const bridge = new PanelBridge({
        nonce: NONCE,
        allowed: new Set(['th.getVariables']),
        send: (m) => sent.push(m),
        dispatch: async (m, a) => { dispatched.push([m, a]); return { echo: a }; },
        ...over,
    });
    return { bridge, sent, dispatched };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ─── transport seams ─────────────────────────────────────────────────────

test('verifySource gate drops foreign senders before parsing', async () => {
    const { bridge, sent, dispatched } = makeBridge({
        verifySource: (ev) => ev.src === 'frame',
        normalize: (ev) => ev.data,
    });
    bridge.onMessage({ src: 'other', data: req() });
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(dispatched.length, 0);
    bridge.onMessage({ src: 'frame', data: req() });
    await flush();
    assert.equal(dispatched.length, 1);
});

test('normalize seam: RN-style JSON string payload', async () => {
    const { bridge, sent, dispatched } = makeBridge({
        normalize: (raw) => { try { return JSON.parse(raw); } catch { return undefined; } },
    });
    bridge.onMessage(JSON.stringify(req()));
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(sent[0].ok, true);
    // non-JSON garbage → silent drop
    bridge.onMessage('not json {');
    await flush();
    assert.equal(sent.length, 1);
});

test('encodeResult seam applies to ok results', async () => {
    const { bridge, sent } = makeBridge({ encodeResult: (r) => ({ wrapped: r }) });
    bridge.onMessage(req());
    await flush();
    assert.deepEqual(sent[0].result, { wrapped: { echo: {} } });
});

// ─── six gates ───────────────────────────────────────────────────────────

test('foreign channel/direction dropped silently (no wire reply)', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onMessage({ channel: 'other', direction: 'request' });
    bridge.onMessage(req({ direction: 'response' }));
    bridge.onMessage(null);
    await flush();
    assert.equal(sent.length, 0);
});

test('non-string requestId dropped silently', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onMessage(req({ requestId: 42 }));
    await flush();
    assert.equal(sent.length, 0);
});

test('nonce mismatch → bad_nonce (before shape/allowlist)', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onMessage(req({ nonce: 'wrong', method: 'th.notEvenReal' }));
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ok, false);
    assert.equal(sent[0].error.code, 'bad_nonce');
    assert.equal(sent[0].requestId, 'r1');
});

test('malformed shape → bad_request (empty requestId, unknown method, bad args)', async () => {
    const { bridge, sent } = makeBridge();
    for (const over of [{ requestId: '' }, { method: 'th.nope' }, { args: 5 }]) {
        bridge.onMessage(req(over));
    }
    await flush();
    assert.equal(sent.length, 3);
    for (const s of sent) assert.equal(s.error.code, 'bad_request');
});

test('ungranted method → denied', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onMessage(req({ method: 'th.deleteVariable' }));
    await flush();
    assert.equal(sent[0].error.code, 'denied');
    assert.match(sent[0].error.message, /th\.deleteVariable/);
});

// ─── dispatch + ledger ───────────────────────────────────────────────────

test('dispatch success → ok response correlated by requestId', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onMessage(req({ args: { type: 'chat' } }));
    await flush();
    assert.deepEqual(sent[0], {
        channel: 'utopinn-panel', direction: 'response',
        nonce: NONCE, requestId: 'r1', ok: true, result: { echo: { type: 'chat' } },
    });
});

test('dispatch throw → wire error; unsupported_method keeps code', async () => {
    const { bridge, sent } = makeBridge({
        dispatch: async (m) => { throw new Error(m === 'th.getVariables' ? 'unsupported_method: x' : 'boom'); },
    });
    bridge.onMessage(req());
    await flush();
    assert.equal(sent[0].error.code, 'unsupported_method');
});

test('dispatch may return non-promise values', async () => {
    const { bridge, sent } = makeBridge({ dispatch: (m, a) => 42 });
    bridge.onMessage(req());
    await flush();
    assert.equal(sent[0].result, 42);
});

test('sync-throwing dispatch adapter → error reply + pending cleared', async () => {
    let mode = 'throw';
    const { bridge, sent } = makeBridge({
        // 同步 throw(非 rejected promise):与异步失败走同一 wire 路,
        // 且不得让 requestId 烂在 pending 台账里。
        dispatch: (m, a) => { if (mode === 'throw') throw new Error('sync boom'); return 'recovered'; },
    });
    bridge.onMessage(req());
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ok, false);
    assert.equal(sent[0].error.code, 'call_failed');
    assert.equal(sent[0].error.message, 'sync boom');
    assert.equal(bridge.pendingCount(), 0);
    // 后续请求正常收敛 —— 台账没被泄漏的请求卡死。
    mode = 'ok';
    bridge.onMessage(req({ requestId: 'r2' }));
    await flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].result, 'recovered');
});

// ─── push / dispose ──────────────────────────────────────────────────────

test('push emits host→card frame with nonce', () => {
    const { bridge, sent } = makeBridge();
    bridge.push('th.event', { name: 'chat_changed', args: [] });
    assert.deepEqual(sent[0], {
        channel: 'utopinn-panel', direction: 'push',
        nonce: NONCE, event: 'th.event', payload: { name: 'chat_changed', args: [] },
    });
});

test('dispose: inbound ignored, outbound suppressed', async () => {
    const { bridge, sent, dispatched } = makeBridge();
    bridge.dispose();
    bridge.onMessage(req());
    bridge.push('chat.updated');
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(dispatched.length, 0);
});

test('dispose mid-flight suppresses the late response', async () => {
    let release;
    const { bridge, sent } = makeBridge({
        dispatch: () => new Promise((r) => { release = r; }),
    });
    bridge.onMessage(req());
    await flush();          // dispatch 是异步启动的 —— 先让它真的挂上进 pending
    bridge.dispose();
    release({ late: true });
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(bridge.pendingCount(), 0);
});
