// panelShim — entryKind→shim 选择 + ctx-only 降级判据(伤 1 复发闸):
//   module   → ?shim=ctx(服务端 init-caller 调 init(ctx);掌门卡形态)
//   document → ?shim=t0(TH 面)
//   缺席     → t0
//   ctx-only + document → degraded;ctx-only + module → 不降级
// node --test 直跑(纯逻辑,@utopinn/protocol 经 dist 解析 —— 需先 build)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPanelShim, degradesCtxOnly } from '../src/panels/shim.ts';

test('module 入口 → ctx shim(init-caller 面)', () => {
    assert.equal(pickPanelShim({ entryKind: 'module', entry: 'index.js' }), 'ctx');
});

test('document 入口 → t0 shim', () => {
    assert.equal(pickPanelShim({ entryKind: 'document', entry: 'panel.html' }), 't0');
    assert.equal(pickPanelShim({}), 't0');
    assert.equal(pickPanelShim(undefined), 't0');
});

test('ctx-only manifest:document 降级,module 不降级', () => {
    const ctxOnly = { permissions: { api: ['ctx'] } };
    assert.equal(degradesCtxOnly({ ...ctxOnly, entryKind: 'document' }), true);
    assert.equal(degradesCtxOnly({ ...ctxOnly, entryKind: 'module' }), false);
});

test('th/双面 manifest 不降级', () => {
    assert.equal(degradesCtxOnly({ permissions: { api: ['th'] } }), false);
    assert.equal(degradesCtxOnly({ permissions: { api: ['ctx', 'th'] } }), false);
    assert.equal(degradesCtxOnly({}), false);   // 无声明 → 生态默认 T0
    assert.equal(degradesCtxOnly(undefined), false);
});
