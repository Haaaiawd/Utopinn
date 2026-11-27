/**
 * quickreplies.ts 纯件单测 —— TASK-063 验收「册/条目启停持久化」的离线半:
 * link 解析(qrBound/qrVisible)、三域并集(qrEnabledNames)、启停写回稿
 * (qrv2WithSetVisible/qrConfigWithLink)的语义钉死 —— 「绑定但隐藏」是
 * ST 真状态,off 只翻 isVisible 不偷删 link;null settings 首启初始化。
 * 跑法:node --test apps/web/tests/quickreplies.test.mjs
 * (被测 .ts 走 Node>=22.6 type-stripping;纯逻辑零网络 —— 只测不碰 fetch 的件)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    newQrSetDoc, qrBound, qrCharScopeKey, qrChatConfigFromHeader,
    qrConfigWithLink, qrEnabledNames, qrLink, qrv2WithSetVisible, qrVisible,
} from '../src/api/quickreplies-model.ts';

test('newQrSetDoc — ST QuickReplySet.toJSON 同形基线', () => {
    const d = newQrSetDoc('晨间例程');
    assert.equal(d.version, 2);
    assert.equal(d.name, '晨间例程');
    assert.deepEqual(d.qrList, []);
    assert.equal(d.idIndex, 0);
    assert.equal(d.disableSend, false);
});

test('qrLink/qrBound/qrVisible — link 存在 vs isVisible 两态分离', () => {
    const cfg = { setList: [{ set: 'A', isVisible: true }, { set: 'B', isVisible: false }, { set: 'C' }] };
    assert.equal(qrBound(cfg, 'A'), true);
    assert.equal(qrBound(cfg, 'B'), true, '隐藏 link 仍是绑定');
    assert.equal(qrBound(cfg, 'Z'), false);
    assert.equal(qrVisible(cfg, 'A'), true);
    assert.equal(qrVisible(cfg, 'B'), false, 'isVisible:false → 不可见但绑定在');
    assert.equal(qrVisible(cfg, 'C'), true, 'isVisible 缺省按可见(ST link 默认)');
    assert.equal(qrVisible(null, 'A'), false);
    assert.equal(qrLink(cfg, 'B')?.set, 'B');
});

test('qrEnabledNames — 三域并集;quickReplyV2 未初始化(null/{})全册放行', () => {
    const names = ['A', 'B', 'C', 'D'];
    /* qr===null = 从未配过绑定面 → 旧只读面「有册即亮」语义,不造全灭 */
    assert.deepEqual([...qrEnabledNames(null, 'x.png', null, names)].sort(), names);
    /* qr==={} = 共享 store 对 missing doc 的归一化(也可能是外部写入的
       退档)—— 显式全关的真状态带 isVisible:false link 留存,裸空对象
       只可能是没配置过 → 同 null 判未配置(🟡7:有册无绑定不全灭)。 */
    assert.deepEqual([...qrEnabledNames({}, 'x.png', null, names)].sort(), names);
    /* 有内容但无任何 link = 配过绑定面且全没绑 → 严格判,全不亮。 */
    assert.equal(qrEnabledNames({ isEnabled: true }, 'x.png', null, names).size, 0);

    /* 档在 → 严格 link 解释:全局 A + 本卡 B + 本会话 C → 并集 {A,B,C} */
    const qr = {
        isEnabled: true,
        config: { setList: [{ set: 'A', isVisible: true }] },
        characterConfigs: { 'x.png': { setList: [{ set: 'B' }] } },
    };
    const chat = { setList: [{ set: 'C', isVisible: true }, { set: 'D', isVisible: false }] };
    const on = qrEnabledNames(qr, 'x.png', chat, names);
    assert.equal(on.has('A'), true);
    assert.equal(on.has('B'), true);
    assert.equal(on.has('C'), true);
    assert.equal(on.has('D'), false, '本会话显式隐藏 → 不进并集');
    /* charKey 不配(无卡会话)→ 卡域不吃 */
    const on2 = qrEnabledNames(qr, null, chat, names);
    assert.equal(on2.has('B'), false);
});

test('qrv2WithSetVisible on — 全局补 link;已有 link 翻真;null 档初始化', () => {
    const a = qrv2WithSetVisible(null, null, 'A', true);
    assert.equal(a.isEnabled, true, 'null 档起步即建 isEnabled:true');
    assert.deepEqual(a.config.setList, [{ set: 'A', isVisible: true }]);

    const b = qrv2WithSetVisible({ config: { setList: [{ set: 'A', isVisible: false }] } }, null, 'A', true);
    assert.deepEqual(b.config.setList, [{ set: 'A', isVisible: true }]);
});

test('qrv2WithSetVisible off — 全域(全局+本卡)link 翻假,绑定不摘', () => {
    const qr = {
        config: { setList: [{ set: 'A' }, { set: 'B' }] },
        characterConfigs: { 'x.png': { setList: [{ set: 'A', isVisible: true }] } },
        misc: { keep: 1 },
    };
    const next = qrv2WithSetVisible(qr, 'x.png', 'A', false);
    assert.equal(qrBound(next.config, 'A'), true, 'link 留 —— 停≠摘');
    assert.equal(qrVisible(next.config, 'A'), false);
    assert.equal(qrVisible(next.config, 'B'), true, '别的册不动');
    assert.equal(qrVisible(next.characterConfigs['x.png'], 'A'), false);
    assert.equal(next.misc.keep, 1, '未知键透传');
    /* 输入档不被原地改写 —— setList 数组要新分配 */
    assert.equal(qrVisible(qr.config, 'A'), true, '原档不可变(React state 安全)');
});

test('qrConfigWithLink — on/off/unbind 三语义', () => {
    const c0 = { setList: [{ set: 'A' }], other: 'keep' };
    const off = qrConfigWithLink(c0, 'A', 'off');
    assert.deepEqual(off.setList, [{ set: 'A', isVisible: false }]);
    assert.equal(off.other, 'keep');
    const onNew = qrConfigWithLink(null, 'N', 'on');
    assert.deepEqual(onNew.setList, [{ set: 'N', isVisible: true }]);
    const unbind = qrConfigWithLink(c0, 'A', 'unbind');
    assert.deepEqual(unbind.setList, []);
    /* 未绑册 off = 无操作(不凭空建 link) */
    const noop = qrConfigWithLink(c0, 'Z', 'off');
    assert.deepEqual(noop.setList, [{ set: 'A' }]);
});

test('qrCharScopeKey — avatar 优先,无图卡退 <charDir>.png', () => {
    assert.equal(qrCharScopeKey('Alice.png', 'Alice'), 'Alice.png');
    assert.equal(qrCharScopeKey(null, 'Bob'), 'Bob.png');
    assert.equal(qrCharScopeKey('', 'Bob'), 'Bob.png');
});

test('qrChatConfigFromHeader — chat_metadata.quickReply 原键读', () => {
    assert.equal(qrChatConfigFromHeader(null), null);
    assert.equal(qrChatConfigFromHeader({ chat_metadata: {} }), null);
    const cfg = { setList: [{ set: 'A' }] };
    assert.deepEqual(qrChatConfigFromHeader({ chat_metadata: { quickReply: cfg } }), cfg);
    /* 非标形状(数组/标量)不当 cfg 吃 */
    assert.equal(qrChatConfigFromHeader({ chat_metadata: { quickReply: [1] } }), null);
});
