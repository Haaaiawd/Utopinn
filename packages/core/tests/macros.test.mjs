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

// ---------- TH/MVU 变量宏家族(issue#2)----------
// 语义基准:ref/extensions/JS-Slash-Runner/src/function/macro_like.ts
//   + variables.ts(get_variables_without_clone 五域)。
// 域口径:message = 最新楼层 variables[swipe_id] 快照,缺席回退
//   chat_metadata.variables(MVU 镜像);chat = chat_metadata.variables;
//   char|character = ctx.charVariables;preset = ctx.presetVariables;
//   global = ctx.globalVariables。

/** MVU 楼层:variables[swipe_id] = MvuData 快照。 */
function mvuFloor(snap, { swipeId = 0, mes = 'floor' } = {}) {
    return { mes, is_user: false, swipe_id: swipeId, swipes: [mes], variables: { [swipeId]: snap } };
}

test('get_message_variable:楼层快照读(TH findLastIndex 口径)', () => {
    const snap = { stat_data: { hp: [80, 'desc'], name: 'Mira' }, schema: {} };
    const chat = [mvuFloor({ stat_data: { hp: [1, 'old'] }, schema: {} }), mvuFloor(snap)];
    const meta = { variables: { stat_data: { hp: 999 } } };
    const c = ctx({ chat, chatMetadata: meta });
    assert.equal(evaluateMacros('{{get_message_variable::stat_data.name}}', {}, undefined, c), 'Mira');
    // 对象 → JSON.stringify(TH literal);缺失 → 'null'
    assert.equal(evaluateMacros('{{get_message_variable::stat_data.hp}}', {}, undefined, c), '[80,"desc"]');
    assert.equal(evaluateMacros('{{get_message_variable::stat_data.nope}}', {}, undefined, c), 'null');
    // 读的是最新快照楼,不是镜像(meta.variables.hp=999 不可见)
    assert.equal(evaluateMacros('{{get_message_variable::stat_data.hp[0]}}', {}, undefined, c), '80');
});

test('get_message_variable:无快照楼层回退 chat_metadata.variables 镜像', () => {
    const chat = [{ mes: 'plain', is_user: false }];
    const meta = { variables: { stat_data: { mood: 'calm' } } };
    const c = ctx({ chat, chatMetadata: meta });
    assert.equal(evaluateMacros('{{get_message_variable::stat_data.mood}}', {}, undefined, c), 'calm');
    assert.equal(evaluateMacros('{{get_chat_variable::stat_data.mood}}', {}, undefined, c), 'calm');
});

test('get_message_variable:$ 内部键深剔除(MVU $meta/$internal)', () => {
    const snap = { stat_data: { $meta: { strict: true }, hp: 5, nested: { $internal: { d: 1 }, v: 2 } } };
    const c = ctx({ chat: [mvuFloor(snap)], chatMetadata: {} });
    assert.equal(evaluateMacros('{{get_message_variable::stat_data}}', {}, undefined, c), '{"hp":5,"nested":{"v":2}}');
    // TH getWithout$ 是 post-get 剔除:直接寻址 $ 键会命中(TH 忠实口径)。
    assert.equal(evaluateMacros('{{get_message_variable::stat_data.$meta}}', {}, undefined, c), '{"strict":true}');
});

test('format_message_variable:YAML 回显 + 行内前缀对齐', () => {
    const snap = { stat_data: { hp: 80, inv: { sword: 1 } } };
    const c = ctx({ chat: [mvuFloor(snap)], chatMetadata: {} });
    const r = evaluateMacros('---\n<status>\n{{format_message_variable::stat_data}}\n</status>', {}, undefined, c);
    assert.equal(r, '---\n<status>\nhp: 80\ninv:\n  sword: 1\n</status>');
    // 缩进前缀:续行按前缀长度对齐(TH prefix.length padding)
    const indented = evaluateMacros('X {{format_message_variable::stat_data}}', {}, undefined, c);
    assert.equal(indented, 'X hp: 80\n  inv:\n    sword: 1');
    // 缺失路径 → 'null'
    assert.equal(evaluateMacros('{{format_message_variable::nope}}', {}, undefined, c), 'null');
    // 字符串子树原样输出(不包引号)
    const c2 = ctx({ chat: [mvuFloor({ stat_data: { note: 'hi\nthere' } })], chatMetadata: {} });
    assert.equal(evaluateMacros('{{format_message_variable::stat_data.note}}', {}, undefined, c2), 'hi\nthere');
});

test('format_message_variable_quoted:字符串全量双引号', () => {
    const snap = { stat_data: { name: 'Mira', hp: 80 } };
    const c = ctx({ chat: [mvuFloor(snap)], chatMetadata: {} });
    const r = evaluateMacros('{{format_message_variable_quoted::stat_data}}', {}, undefined, c);
    assert.equal(r, 'name: "Mira"\nhp: 80');
});

test('format_message_variable:同一行叠多个 format 宏(递归)', () => {
    const snap = { a: { x: 1 }, b: { y: 2 } };
    const c = ctx({ chat: [mvuFloor(snap)], chatMetadata: {} });
    const r = evaluateMacros('{{format_message_variable::a}}|{{format_message_variable::b}}', {}, undefined, c);
    assert.equal(r, 'x: 1|y: 2');
});

test('get/set_char_variable + character 别名:卡级变量域', () => {
    const charVars = { affection: 10 };
    const c = ctx({ extra: { charVariables: charVars, variableWrites: [] } });
    assert.equal(evaluateMacros('{{get_char_variable::affection}}|{{get_character_variable::affection}}', {}, undefined, c), '10|10');
    assert.equal(evaluateMacros('{{set_char_variable::affection::20}}[{{get_char_variable::affection}}]', {}, undefined, c), '[20]');
    assert.equal(charVars.affection, 20);
    assert.deepEqual(c.variableWrites, [{ domain: 'char', path: 'affection', value: 20 }]);
    // 未绑定 → 'null'
    const c2 = ctx();
    assert.equal(evaluateMacros('{{get_char_variable::affection}}', {}, undefined, c2), 'null');
});

test('get/set_global_variable:全局域读写 + 写回钉', () => {
    const g = { world: 'eden' };
    const c = ctx({ globalVariables: g, extra: { variableWrites: [] } });
    assert.equal(evaluateMacros('{{get_global_variable::world}}', {}, undefined, c), 'eden');
    assert.equal(evaluateMacros('{{set_global_variable::world::utopia}}[{{get_global_variable::world}}]', {}, undefined, c), '[utopia]');
    assert.equal(g.world, 'utopia');
    assert.equal(c.variableWrites.at(-1).domain, 'global');
});

test('set_message_variable:展开空串,快照+镜像双写,variableWrites 带 path+value', () => {
    const snap = { stat_data: { hp: 1 }, schema: {} };
    const meta = { variables: { stat_data: { hp: 1 } } };
    const c = ctx({ chat: [mvuFloor(snap)], chatMetadata: meta, extra: { variableWrites: [] } });
    const r = evaluateMacros('{{set_message_variable::stat_data.hp::42}}', {}, undefined, c);
    assert.equal(r, '');
    assert.equal(snap.stat_data.hp, 42);
    assert.equal(meta.variables.stat_data.hp, 42);
    assert.deepEqual(c.variableWrites, [{ domain: 'message', path: 'stat_data.hp', value: 42 }]);
});

test('set_message_variable:无快照楼层写镜像;值 JSON 解析优先', () => {
    const meta = {};
    const c = ctx({ chat: [], chatMetadata: meta, extra: { variableWrites: [] } });
    evaluateMacros('{{set_message_variable::a.b::[1,2]}}', {}, undefined, c);
    assert.deepEqual(meta.variables.a.b, [1, 2]);
    evaluateMacros('{{set_message_variable::a.s::hello}}', {}, undefined, c);
    assert.equal(meta.variables.a.s, 'hello');
});

test('set_chat_variable:chat 域写镜像 + 钉', () => {
    const meta = {};
    const c = ctx({ chatMetadata: meta, extra: { variableWrites: [] } });
    assert.equal(evaluateMacros('{{set_chat_variable::flag::true}}', {}, undefined, c), '');
    assert.equal(meta.variables.flag, true);
    assert.deepEqual(c.variableWrites, [{ domain: 'chat', path: 'flag', value: true }]);
});

test('set_preset_variable:预设域绑定', () => {
    const p = {};
    const c = ctx({ extra: { presetVariables: p, variableWrites: [] } });
    evaluateMacros('{{set_preset_variable::tone::dark}}', {}, undefined, c);
    assert.equal(p.tone, 'dark');
    assert.equal(evaluateMacros('{{get_preset_variable::tone}}', {}, undefined, c), 'dark');
});

test('setvar/setglobalvar 家族同样推写回钉', () => {
    const meta = {};
    const g = {};
    const c = ctx({ chatMetadata: meta, globalVariables: g, extra: { variableWrites: [] } });
    evaluateMacros('{{setvar::hp::1}}{{incvar::hp}}{{setglobalvar::g::x}}', {}, undefined, c);
    assert.deepEqual(c.variableWrites.map((w) => w.domain), ['chat', 'chat', 'global']);
});

test('TH 域宏:HTML 实体路径还原(_.unescape 语义)', () => {
    const snap = { 'a<b': { 'c&d': 7 } };
    const c = ctx({ chat: [mvuFloor(snap)], chatMetadata: {} });
    assert.equal(evaluateMacros('{{get_message_variable::a&lt;b.c&amp;d}}', {}, undefined, c), '7');
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
