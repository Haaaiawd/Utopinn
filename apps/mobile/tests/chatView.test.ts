// stToView 展示投影道回归(GH#3 + reviewer 返修):
//   - 有 swipes 链:content 跟随当前 swipe 下标(swipes_display[active] ?? 原文),
//     mes_display 滞后时不再优先 —— 选稿后 reopen 不再显示上一稿
//   - 无 swipes 链:mes_display ?? mes
//   - 各版推理:swipe_info[i].extra.reasoning_display ?? reasoning
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stToView, type StChatMessage } from '../src/api/chatView.ts';

test('无 swipes 链:mes_display 优先于 mes', () => {
    const v = stToView({ mes: 'raw', mes_display: 'projected', is_user: false }, 0);
    assert.equal(v.content, 'projected');
});

test('有 swipes:content 取当前稿下标,不吃滞后的 mes_display(返修)', () => {
    // PATCH 只改 swipe_id 时,mes/mes_display 仍是上一稿的镜像 —— 优先吃它
    // 会把旧稿当当前稿。swipe 车道自身投影才是权威展示文本。
    const m: StChatMessage = {
        is_user: false,
        mes: 'draft A raw',
        mes_display: 'draft A projected',   // 滞后镜像(swipe_id=1 时仍指 A)
        swipes: ['draft A raw', 'draft B raw'],
        swipes_display: ['draft A projected', 'draft B projected'],
        swipe_id: 1,
    };
    const v = stToView(m, 0);
    assert.equal(v.content, 'draft B projected');
    assert.equal(v.activeSwipe, 1);
});

test('swipes_display 缺位 → 回落当稿 wire 原文(不吃别稿投影)', () => {
    const v = stToView({
        is_user: false,
        mes_display: 'draft A projected',
        swipes: ['A raw', 'B raw'],
        // 只有 0 位有投影
        swipes_display: ['draft A projected'],
        swipe_id: 1,
    }, 0);
    assert.equal(v.content, 'B raw');
});

test('swipes_display 全缺 → wire 原文;swipe 预览各稿独立', () => {
    const v = stToView({
        is_user: false,
        swipes: ['A raw', 'B raw'],
        swipe_id: 0,
    }, 0);
    assert.equal(v.content, 'A raw');
    assert.equal(v.swipes?.[1]?.content, 'B raw');
});

test('单稿 swipes(len=1)不当链 → mes 车道', () => {
    const v = stToView({
        is_user: false,
        mes: 'only',
        mes_display: 'only projected',
        swipes: ['only'],
        swipe_id: 0,
    }, 0);
    assert.equal(v.content, 'only projected');
    assert.equal(v.swipes, undefined);
});

test('reasoning 投影链:reasoning_display → extra.reasoning → swipe_info 位', () => {
    const v = stToView({
        is_user: false,
        mes: 'x',
        reasoning_display: 'reason projected',
        extra: { reasoning: 'reason raw' },
    }, 0);
    assert.equal(v.reasoning, 'reason projected');
    // 各版推理:swipe_info[i].extra.reasoning_display 优先
    const v2 = stToView({
        is_user: false,
        mes: 'x',
        swipes: ['A', 'B'],
        swipe_id: 1,
        swipe_info: [
            { extra: { reasoning: 'rA raw' } },
            { extra: { reasoning_display: 'rB projected', reasoning: 'rB raw' } },
        ],
    }, 0);
    assert.equal(v2.swipes?.[1]?.reasoning, 'rB projected');
    assert.equal(v2.swipes?.[0]?.reasoning, 'rA raw');
});
