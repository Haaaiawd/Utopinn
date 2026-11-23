// panel-wire tests — 授权展开/shape 门/wire 错误编码/降级码(收敛 §5.1–5.2)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
    expandApiGrants, isPanelRequestData, toWireError, PANEL_SURFACE_UNAVAILABLE,
    PANEL_METHODS, PANEL_METHODS_TH_T0, isPanelRequest,
} = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js'));

const req = (over = {}) => ({
    channel: 'utopinn-panel', direction: 'request', nonce: 'n',
    requestId: 'r1', method: 'th.getVariables', args: {}, ...over,
});

// ─── expandApiGrants ─────────────────────────────────────────────────────

test('empty/undeclared api → full T0 table, thFace only', () => {
    for (const api of [undefined, []]) {
        const g = expandApiGrants(api);
        assert.equal(g.ctxFace, false);
        assert.equal(g.thFace, true);
        assert.deepEqual([...g.allowed].sort(), [...PANEL_METHODS_TH_T0].sort());
    }
});

test("'th' grant → T0 table + thFace", () => {
    const g = expandApiGrants(['th']);
    assert.equal(g.thFace, true);
    assert.equal(g.ctxFace, false);
    assert.equal(g.allowed.size, PANEL_METHODS_TH_T0.length);
});

test("'ctx' grant → whole ctx face (web/CLI semantics)", () => {
    const g = expandApiGrants(['ctx']);
    assert.equal(g.ctxFace, true);
    assert.equal(g.thFace, false);
    for (const m of PANEL_METHODS) assert.ok(g.allowed.has(m), m);
});

test("'ctx' + surfaceOnlyCtx → only the two surface verbs (mobile semantics)", () => {
    const g = expandApiGrants(['ctx'], { surfaceOnlyCtx: true });
    assert.equal(g.ctxFace, true);
    assert.deepEqual([...g.allowed].sort(), ['ctx.surfaceClose', 'ctx.surfaceOpen']);
    assert.ok(!g.allowed.has('ctx.getChat'));
});

test('single-method grants pass through with face flags', () => {
    const g = expandApiGrants(['ctx.surfaceOpen', 'th.getVariables']);
    assert.equal(g.ctxFace, true);
    assert.equal(g.thFace, true);
    assert.ok(g.allowed.has('ctx.surfaceOpen'));
    assert.ok(g.allowed.has('th.getVariables'));
    assert.ok(!g.allowed.has('th.getChatMessages'));
});

test('unknown/face-less grants are ignored', () => {
    const g = expandApiGrants(['bogus', 'ctxx.notathing', '']);
    assert.equal(g.allowed.size, 0);
    assert.equal(g.ctxFace, false);
    assert.equal(g.thFace, false);
});

// ─── isPanelRequestData ──────────────────────────────────────────────────

test('well-formed request passes; isPanelRequest agrees', () => {
    assert.ok(isPanelRequestData(req()));
    assert.ok(isPanelRequest(req()));
});

test('foreign channel/direction/non-object → not a request', () => {
    for (const v of [null, undefined, 5, 'x', req({ channel: 'x' }), req({ direction: 'push' })]) {
        assert.equal(isPanelRequestData(v), false, JSON.stringify(v));
    }
});

test('empty requestId rejected (stricter than isPanelRequest)', () => {
    assert.equal(isPanelRequestData(req({ requestId: '' })), false);
    assert.equal(isPanelRequest(req({ requestId: '' })), true); // base check stays loose
});

test('non-string nonce rejected', () => {
    assert.equal(isPanelRequestData(req({ nonce: 5 })), false);
});

test('unknown method rejected (allowlist shape gate)', () => {
    assert.equal(isPanelRequestData(req({ method: 'th.notAMethod' })), false);
    assert.equal(isPanelRequestData(req({ method: 'evil' })), false);
});

test('args must be absent or an object (CLI semantics, unified)', () => {
    assert.ok(isPanelRequestData(req({ args: undefined })));
    assert.ok(isPanelRequestData(req({ args: {} })));
    assert.ok(isPanelRequestData(req({ args: { a: 1 } })));
    for (const bad of [null, 5, 'x', true]) {
        assert.equal(isPanelRequestData(req({ args: bad })), false, JSON.stringify(bad));
    }
});

test('ctx methods pass the method gate', () => {
    assert.ok(isPanelRequestData(req({ method: 'ctx.surfaceOpen' })));
});

// ─── toWireError ─────────────────────────────────────────────────────────

test('unsupported_method prefix keeps its code', () => {
    assert.deepEqual(toWireError(new Error('unsupported_method: ctx.foo')),
        { code: 'unsupported_method', message: 'unsupported_method: ctx.foo' });
});

test('generic errors → call_failed; non-Error coerced', () => {
    assert.deepEqual(toWireError(new Error('boom')), { code: 'call_failed', message: 'boom' });
    assert.deepEqual(toWireError('oops'), { code: 'call_failed', message: 'oops' });
});

// ─── PANEL_SURFACE_UNAVAILABLE ───────────────────────────────────────────

test('unified surface-verb degrade reason', () => {
    assert.equal(PANEL_SURFACE_UNAVAILABLE, 'panel_surface_unavailable');
});
