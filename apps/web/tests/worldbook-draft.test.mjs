/**
 * worldbookDraft 单测 —— TASK-061 验收「表单写→读回环零丢失」的离线半:
 * draftOf/applyDraft 字段级保真(数组是数组、number 是 number、null 是
 * null)、未覆盖键透传、uid 分配、新条目模板、脏判基线。
 * 跑法:node --test apps/web/tests/worldbook-draft.test.mjs
 * (被测 .ts 走 Node>=22.6 type-stripping,纯逻辑零依赖)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyDraft, draftDirty, draftOf, newEntry, nextUid, splitKeys,
    POSITION_OPTIONS, LOGIC_OPTIONS, ROLE_OPTIONS,
} from '../src/components/views/worldbookDraft.ts';

const baseEntry = () => ({
    uid: 3,
    key: ['foo', 'bar'],
    keysecondary: ['baz'],
    comment: '守卫条目',
    content: '{{user}} 触发时注入这段',
    constant: false,
    selective: true,
    selectiveLogic: 1,
    disable: false,
    position: 4,
    depth: 7,
    role: 2,
    outletName: 'out-1',
    order: 42,
    probability: 66,
    useProbability: true,
    group: 'g1',
    groupWeight: 120,
    sticky: 5,
    cooldown: null,
    delay: 2,
    /* 表单不覆盖的生态键 —— 必须透传 */
    display_index: 9,
    extensions: { position: 4, exclude_recursion: false },
    automationId: 'a-1',
});

test('draftOf → applyDraft 恒等回环(全字段零丢失/类型保全)', () => {
    const e = baseEntry();
    const back = applyDraft(e, draftOf(e));
    assert.deepEqual(back, e);
    /* 类型逐个钉死 —— JSON 序列化后仍同形(模拟 PUT 写→GET 读) */
    const wire = JSON.parse(JSON.stringify(back));
    assert.deepEqual(wire, e);
    for (const k of ['order', 'probability', 'position', 'depth', 'role', 'groupWeight', 'selectiveLogic', 'sticky', 'delay']) {
        assert.equal(typeof wire[k], 'number', `${k} must stay number`);
    }
    assert.equal(wire.cooldown, null);
    assert.ok(Array.isArray(wire.key) && Array.isArray(wire.keysecondary));
});

test('applyDraft 只动表单键,生态扩展键原样透传', () => {
    const e = baseEntry();
    const next = applyDraft(e, { ...draftOf(e), comment: '改名', content: '新内容' });
    assert.equal(next.comment, '改名');
    assert.equal(next.content, '新内容');
    assert.equal(next.display_index, 9);
    assert.deepEqual(next.extensions, { position: 4, exclude_recursion: false });
    assert.equal(next.automationId, 'a-1');
    assert.equal(next.order, 42, '未编辑字段保留原值');
});

test('keys 数组 ↔ 逗号串往返;脏段丢弃、trim', () => {
    assert.deepEqual(splitKeys('a, b ,,c'), ['a', 'b', 'c']);
    assert.deepEqual(splitKeys(''), []);
    const e = baseEntry();
    const next = applyDraft(e, { ...draftOf(e), key: 'x,y, z ' });
    assert.deepEqual(next.key, ['x', 'y', 'z']);
    assert.ok(Array.isArray(next.key));
});

test('数字字段:空串保原值、NaN 保原值、浮点取整', () => {
    const e = baseEntry();
    const d = draftOf(e);
    const next = applyDraft(e, { ...d, order: '', probability: 'abc', depth: '4.6' });
    assert.equal(next.order, 42);
    assert.equal(next.probability, 66);
    assert.equal(next.depth, 5);
});

test('定时效果:空串 → null,数字 → number,NaN 保原值', () => {
    const e = baseEntry();
    const d = draftOf(e);
    assert.equal(d.sticky, '5');
    assert.equal(d.cooldown, '');
    const next = applyDraft(e, { ...d, sticky: '', cooldown: '9', delay: 'oops' });
    assert.equal(next.sticky, null);
    assert.equal(next.cooldown, 9);
    assert.equal(next.delay, 2, 'NaN 不清掉盘上合法值');
});

test('draftDirty:基线净、改一字即脏、改回原值回净', () => {
    const e = baseEntry();
    const d = draftOf(e);
    assert.equal(draftDirty(e, d), false);
    assert.equal(draftDirty(e, { ...d, comment: 'x' }), true);
    assert.equal(draftDirty(e, { ...d, order: '42' }), false, '同值不同形不算脏');
    assert.equal(draftDirty(e, { ...d, disable: !d.disable }), true);
});

test('draftOf 缺省条目归位:selective 缺省关、布尔严格 true', () => {
    const d = draftOf({ uid: 0, comment: '', content: '' });
    assert.equal(d.selective, false, '引擎语义:无 flag → 次关键字不求值');
    assert.equal(d.constant, false);
    assert.equal(d.useProbability, true, 'useProbability 缺省 = 模板 true');
    assert.equal(d.order, '100');
    assert.equal(d.position, '0');
    assert.equal(d.depth, '4');
});

test('nextUid = max uid + 1(键与 entry.uid 两源)', () => {
    assert.equal(nextUid({}), 0);
    assert.equal(nextUid({ '0': { uid: 0 }, '3': { uid: 3 } }), 4);
    assert.equal(nextUid({ '7': { uid: 20 } }), 21, 'uid 域比键大时按 uid');
    assert.equal(nextUid({ '5': { uid: 1 } }), 6, '键比 uid 大时按键');
});

test('newEntry:disable 起步安全 + ST 模板键齐', () => {
    const e = newEntry(11);
    assert.equal(e.uid, 11);
    assert.equal(e.disable, true, '新建停用起步 —— 半成品不注入');
    assert.deepEqual(e.key, []);
    assert.equal(e.selective, true);
    assert.equal(e.order, 100);
    assert.equal(e.position, 0);
    assert.equal(e.probability, 100);
    assert.equal(e.depth, 4);
    assert.equal(e.sticky, null);
    /* 可被编辑面直接消费 */
    const d = draftOf(e);
    assert.equal(d.disable, true);
    assert.equal(draftDirty(e, d), false);
});

test('取值域枚举 = core world_info_position/logic 全域', () => {
    assert.deepEqual([...POSITION_OPTIONS], [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...LOGIC_OPTIONS], [0, 1, 2, 3]);
    assert.deepEqual([...ROLE_OPTIONS], [0, 1, 2]);
});

test('position/role/selectiveLogic 以 number 写回(枚举不串味)', () => {
    const e = baseEntry();
    const next = applyDraft(e, { ...draftOf(e), position: '4', role: '2', selectiveLogic: '3' });
    assert.equal(next.position, 4);
    assert.equal(next.role, 2);
    assert.equal(next.selectiveLogic, 3);
});
