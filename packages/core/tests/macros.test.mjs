/**
 * Macro evaluator tests — evaluateMacros + substituteParams fidelity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMacros, substituteParams } from '../dist/index.js';

function ctx(over = {}) {
    return {
        chat: over.chat ?? [],
        chatMetadata: over.chatMetadata ?? {},
        globalVariables: over.globalVariables ?? {},
        limits: { maxPrompt: 2048, maxContext: 4096, maxResponse: 512 },
        input: 'typed text',
        now: over.now,
        rng: over.rng,
        ...over.extra,
    };
}

test('env 宏:{{user}}/{{char}}/<USER>/<BOT>', () => {
    const env = { user: 'Anon', char: 'Seraphina' };
    const r = evaluateMacros('{{user}} meets {{char}}. <USER>+<BOT>', env, undefined, ctx());
    assert.equal(r, 'Anon meets Seraphina. Anon+Seraphina');
});

test('转义:\\{{...}} 不求值,还原为字面 \\{{', () => {
    const r = evaluateMacros('\\{{setvar::x::1}} kept', {}, undefined, ctx());
    assert.equal(r, '\\{{setvar::x::1}} kept');
});

test('{{newline}}/{{noop}}/{{trim}}', () => {
    assert.equal(evaluateMacros('a{{newline}}b', {}, undefined, ctx()), 'a\nb');
    assert.equal(evaluateMacros('a{{noop}}b', {}, undefined, ctx()), 'ab');
    assert.equal(evaluateMacros('x\n{{trim}}\ny', {}, undefined, ctx()), 'xy');
});

test('{{// 注释}} 删除', () => {
    assert.equal(evaluateMacros('keep {{// secret}} tail', {}, undefined, ctx()), 'keep  tail');
});

test('变量宏:setvar/getvar/addvar/incvar/decvar 走 chatMetadata.variables', () => {
    const meta = {};
    const c = ctx({ chatMetadata: meta });
    assert.equal(evaluateMacros('{{setvar::hp::10}}[{{getvar::hp}}]', {}, undefined, c), '[10]');
    assert.equal(evaluateMacros('{{addvar::hp::5}}[{{getvar::hp}}]', {}, undefined, c), '[15]');
    // 原版 incvar/decvar 输出增减后的值,不是空串
    assert.equal(evaluateMacros('{{incvar::hp}}[{{getvar::hp}}]', {}, undefined, c), '16[16]');
    assert.equal(evaluateMacros('{{decvar::hp}}[{{getvar::hp}}]', {}, undefined, c), '15[15]');
    assert.equal(meta.variables.hp, 15);
});

test('全局变量宏:setglobalvar/getglobalvar 走 globalVariables', () => {
    const g = {};
    const c = ctx({ globalVariables: g });
    assert.equal(evaluateMacros('{{setglobalvar::world::eden}}[{{getglobalvar::world}}]', {}, undefined, c), '[eden]');
    assert.equal(g.world, 'eden');
});

test('getvar 数值 coercion:"42" → 数字 42', () => {
    const meta = { variables: { n: '42' } };
    const c = ctx({ chatMetadata: meta });
    assert.equal(evaluateMacros('{{getvar::n}}', {}, undefined, c), '42');
});

test('{{lastMessage}}/{{lastUserMessage}}/{{lastCharMessage}}', () => {
    const chat = [
        { mes: 'hello', is_user: true },
        { mes: 'hi there', is_user: false },
        { mes: 'sys', is_user: false, is_system: true },
    ];
    const c = ctx({ chat });
    assert.equal(evaluateMacros('{{lastMessage}}', {}, undefined, c), 'sys');
    assert.equal(evaluateMacros('{{lastUserMessage}}', {}, undefined, c), 'hello');
    assert.equal(evaluateMacros('{{lastCharMessage}}', {}, undefined, c), 'hi there');
});

test('{{lastMessageId}}/{{allChatRange}}', () => {
    const chat = [{ mes: 'a' }, { mes: 'b' }];
    const c = ctx({ chat });
    assert.equal(evaluateMacros('{{lastMessageId}}', {}, undefined, c), '1');
    assert.equal(evaluateMacros('{{allChatRange}}', {}, undefined, c), '0-1');
});

test('swipe 宏:lastSwipeId/currentSwipeId(含进行中 swipe)', () => {
    const chat = [{ mes: 'a', swipes: ['s1', 's2'], swipe_id: 0 }];
    const c = ctx({ chat });
    assert.equal(evaluateMacros('{{lastSwipeId}}', {}, undefined, c), '2');
    assert.equal(evaluateMacros('{{currentSwipeId}}', {}, undefined, c), '1');
});

test('{{roll:1d1}} 确定性 + 非法公式 → 空', () => {
    const c = ctx();
    const r = evaluateMacros('roll={{roll:1d1}}', {}, undefined, c);
    assert.equal(r, 'roll=1');
    assert.equal(evaluateMacros('x{{roll:notdice}}y', {}, undefined, c), 'xy');
});

test('{{pick}} 确定性:同 chat+content+offset 同结果', () => {
    const c = ctx({ chatMetadata: {}, extra: { currentChatId: 'chat1' } });
    const a = evaluateMacros('{{pick::a::b::c::d}}', {}, undefined, c);
    const meta2 = {};
    const c2 = ctx({ chatMetadata: meta2, extra: { currentChatId: 'chat1' } });
    const b = evaluateMacros('{{pick::a::b::c::d}}', {}, undefined, c2);
    assert.equal(a, b);
    assert.ok(['a', 'b', 'c', 'd'].includes(a));
    assert.equal(typeof c.chatMetadata.chat_id_hash, 'number');
    assert.equal(meta2.chat_id_hash, c.chatMetadata.chat_id_hash);
});

test('{{reverse}}/{{input}}', () => {
    const c = ctx();
    assert.equal(evaluateMacros('{{reverse:abc}}', {}, undefined, c), 'cba');
    assert.equal(evaluateMacros('{{input}}', {}, undefined, c), 'typed text');
});

test('{{maxPrompt}}/{{maxContextTokens}}', () => {
    assert.equal(evaluateMacros('{{maxPrompt}}/{{maxContextTokens}}', {}, undefined, ctx()), '2048/4096');
});

test('时间宏(注入时钟)', () => {
    const c = ctx({ now: new Date('2026-11-03T15:04:05Z') });
    const r = evaluateMacros('{{isodate}} {{isotime}}', {}, undefined, c);
    assert.equal(r, '2026-11-03 ' + r.split(' ')[1]); // isotime = local HH:mm,环境相关,只校验格式
    assert.match(r, /^2026-11-03 \d{2}:\d{2}$/);
});

test('{{outlet::key}}', () => {
    const c = ctx({ extra: { outletLookup: (k) => k === 'inv' ? 'INVENTORY' : '' } });
    assert.equal(evaluateMacros('{{outlet::inv}}|{{outlet::none}}', {}, undefined, c), 'INVENTORY|');
});

test('postProcessFn 包一层', () => {
    const r = evaluateMacros('{{char}}', { char: 'X' }, (x) => `<${x}>`, ctx());
    assert.equal(r, '<X>');
});

test('函数 env 拿 nonce', () => {
    let seen;
    const env = { fn: (nonce) => { seen = nonce; return 'R'; } };
    evaluateMacros('{{fn}}', env, undefined, ctx());
    assert.match(seen, /^[0-9a-f-]{36}$/);
});

test('空/非字符串 content 安全返回', () => {
    assert.equal(evaluateMacros('', {}, undefined, ctx()), '');
    assert.equal(evaluateMacros(null, {}, undefined, ctx()), '');
});

// ---------- substituteParams ----------

test('substituteParams:卡字段 + 名称 + 优先级', () => {
    const c = ctx({
        extra: {
            name1: 'User', name2: 'CharName',
            cardFields: { description: 'A {{user}} desc', scenario: 'Scene' },
            model: 'gpt-x',
        },
    });
    const r = substituteParams('{{char}} says {{description}}|{{scenario}}|{{model}}', c);
    assert.equal(r, 'CharName says A User desc|Scene|gpt-x');
});

test('substituteParams:nameOverride 覆盖', () => {
    const c = ctx({ extra: { name1: 'U1', name2: 'C1' } });
    const r = substituteParams('{{user}}&{{char}}', c, { name1Override: 'X', name2Override: 'Y' });
    assert.equal(r, 'X&Y');
});

test('substituteParams:{{original}} 只替换一次', () => {
    const c = ctx();
    const r = substituteParams('{{original}} {{original}}', c, { original: 'ONE' });
    assert.equal(r, 'ONE ');
});

test('substituteParams:dynamicMacros 注入', () => {
    const r = substituteParams('{{extra}}', ctx(), { dynamicMacros: { extra: 'DYN' } });
    assert.equal(r, 'DYN');
});
