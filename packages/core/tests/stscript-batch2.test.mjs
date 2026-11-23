/**
 * TASK-064 批三验收 — /inject 族、文本/匹配工具族、power_user 写面族、
 * 会话生命周期(/newchat /delchat /closechat)。
 *
 * 覆盖点:
 * - /inject:chat_metadata.script_injects 写面形状(Luker
 *   {value,position,depth,scan,role,filter,ephemeral} 七键;position/role
 *   为 extension_prompt_* 原值),空值删除,persistMetadata + inject op 回执
 * - /listinjects:return=object/pipe 通道 + 默认 popup-html 经 showPopup
 * - /flushinject[/flushinjects]:按 id 删 / 全清
 * - consumeEphemeralScriptInjects:只清 ephemeral===true(非 quiet 生成
 *   终态调,quiet 不得消费 —— trigger-generation.js 接线,本测试钉纯函数)
 * - /upper /lower /substr /replace /test /match /trimstart /trimend
 *   /tokens /count /fuzzy /is-mobile
 * - /stop-strings /start-reply-with /single /flat /bubble:powerUser 活对象
 *   写 + persistSettings;未绑 seam → warning notify 不静默假写
 * - /newchat /delchat /closechat:host seam + go/close-chat op 回执;
 *   未绑 seam 显式报错
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createStscriptEnv,
    runStscript,
    registerBuiltinCommands,
    getCommand,
    consumeEphemeralScriptInjects,
} from '../dist/index.js';

registerBuiltinCommands();

function makeEnv({ chatMetadata = {}, chat = [], currentChatId = 'chat-1', host = {} } = {}) {
    const notifications = [];
    const systemMessages = [];
    const popups = [];
    const persisted = { metadata: 0, settings: 0 };
    const env = createStscriptEnv({
        chat,
        chatMetadata,
        globalVariables: {},
        name1: 'User',
        name2: 'Char',
        currentChatId,
    }, {
        notify: (severity, title, text) => { notifications.push({ severity, title, text }); },
        sendSystemMessage: (text, isHtml) => { systemMessages.push({ text, isHtml }); },
        showPopup: (text, isHtml) => { popups.push({ text, isHtml }); },
        persistMetadata: () => { persisted.metadata += 1; },
        persistSettings: () => { persisted.settings += 1; },
        ...host,
    });
    return { env, notifications, systemMessages, popups, persisted };
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('batch-2 commands are registered', () => {
    const names = [
        'inject', 'listinjects', 'flushinject',
        'upper', 'lower', 'substr', 'replace', 'test', 'match',
        'trimstart', 'trimend', 'tokens', 'count', 'fuzzy', 'is-mobile',
        'stop-strings', 'start-reply-with', 'single', 'flat', 'bubble',
        'newchat', 'delchat', 'closechat',
    ];
    for (const name of names) {
        assert.ok(getCommand(name), `missing builtin: ${name}`);
    }
    // 别名
    assert.equal(getCommand('flushinjects'), getCommand('flushinject'));
    assert.equal(getCommand('uppercase'), getCommand('upper'));
    assert.equal(getCommand('lowercase'), getCommand('lower'));
    assert.equal(getCommand('substring'), getCommand('substr'));
    assert.equal(getCommand('re'), getCommand('replace'));
    assert.equal(getCommand('bubbles'), getCommand('bubble'));
});

// ---------------------------------------------------------------------------
// /inject — chat_metadata.script_injects 写面
// ---------------------------------------------------------------------------

test('/inject writes Luker-shaped record with defaults', async () => {
    const { env, persisted } = makeEnv();
    const out = await runStscript(env, '/inject id=foo hello world');
    assert.equal(out.isError, false);
    assert.equal(out.result, 'foo');
    const inject = env.macro.chatMetadata.script_injects.foo;
    // IN_PROMPT=0 depth=4 scan=false SYSTEM=0(Luker injectCallback 默认值)
    assert.deepEqual(inject, {
        value: 'hello world', position: 0, depth: 4,
        scan: false, role: 0, filter: null, ephemeral: false,
    });
    assert.equal(persisted.metadata, 1);
    const op = out.ops.at(-1);
    assert.equal(op.type, 'inject');
    assert.equal(op.id, 'foo');
    assert.equal(op.inject.value, 'hello world');
});

test('/inject maps named args to extension_prompt constants', async () => {
    const { env } = makeEnv();
    await runStscript(env, '/inject id=a position=chat depth=6 scan=true role=assistant ephemeral=true hi');
    const inject = env.macro.chatMetadata.script_injects.a;
    assert.equal(inject.position, 1); // IN_CHAT
    assert.equal(inject.depth, 6);
    assert.equal(inject.scan, true);
    assert.equal(inject.role, 2);   // ASSISTANT
    assert.equal(inject.ephemeral, true);
    await runStscript(env, '/inject id=b position=before role=user hi');
    assert.equal(env.macro.chatMetadata.script_injects.b.position, 2); // BEFORE_PROMPT
    assert.equal(env.macro.chatMetadata.script_injects.b.role, 1);     // USER
    await runStscript(env, '/inject id=c position=none hi');
    assert.equal(env.macro.chatMetadata.script_injects.c.position, -1);
});

test('/inject keeps filter closure rawText', async () => {
    const { env } = makeEnv();
    await runStscript(env, '/inject id=f filter={: /echo hi :} hello');
    const inject = env.macro.chatMetadata.script_injects.f;
    assert.equal(typeof inject.filter, 'string');
    assert.ok(inject.filter.includes('echo'));
});

test('/inject auto-generates id when missing', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/inject hello');
    const id = out.result;
    assert.ok(id.length >= 6);
    assert.equal(env.macro.chatMetadata.script_injects[id].value, 'hello');
});

test('/inject empty value deletes the injection', async () => {
    const { env, persisted } = makeEnv();
    await runStscript(env, '/inject id=foo hello');
    assert.ok(env.macro.chatMetadata.script_injects.foo);
    const out = await runStscript(env, '/inject id=foo');
    assert.equal(out.result, 'foo');
    assert.equal(env.macro.chatMetadata.script_injects.foo, undefined);
    const op = out.ops.at(-1);
    assert.deepEqual(op, { type: 'inject', id: 'foo', inject: null });
    assert.equal(persisted.metadata, 2);
});

test('/listinjects return=object returns JSON store', async () => {
    const { env } = makeEnv();
    await runStscript(env, '/inject id=foo hello');
    const out = await runStscript(env, '/listinjects return=object');
    const parsed = JSON.parse(out.result);
    assert.equal(parsed.foo.value, 'hello');
    assert.equal(parsed.foo.position, 0);
});

test('/listinjects default popup channel + pipe channel', async () => {
    const { env, popups } = makeEnv();
    await runStscript(env, '/inject id=foo position=chat depth=2 role=user hi');
    const out = await runStscript(env, '/listinjects');
    assert.equal(out.result, '');
    assert.equal(popups.length, 1);
    assert.ok(popups[0].text.includes('foo'));
    const pipe = await runStscript(env, '/listinjects return=pipe');
    assert.ok(pipe.result.includes('IN_CHAT'));
    assert.ok(pipe.result.includes('depth: 2'));
});

test('/flushinject removes single id; bare removes all', async () => {
    const { env, persisted } = makeEnv();
    await runStscript(env, '/inject id=a one');
    await runStscript(env, '/inject id=b two');
    await runStscript(env, '/flushinject a');
    assert.equal(env.macro.chatMetadata.script_injects.a, undefined);
    assert.equal(env.macro.chatMetadata.script_injects.b.value, 'two');
    await runStscript(env, '/inject id=c three');
    const out = await runStscript(env, '/flushinjects');
    assert.equal(out.result, '');
    assert.deepEqual(env.macro.chatMetadata.script_injects, {});
    assert.ok(persisted.metadata >= 4);
});

test('consumeEphemeralScriptInjects removes only ephemeral entries', async () => {
    const { env } = makeEnv();
    await runStscript(env, '/inject id=keep stay');
    await runStscript(env, '/inject id=temp ephemeral=true gone');
    const md = env.macro.chatMetadata;
    const removed = consumeEphemeralScriptInjects(md);
    assert.equal(removed, 1);
    assert.equal(md.script_injects.temp, undefined);
    assert.equal(md.script_injects.keep.value, 'stay');
    assert.equal(consumeEphemeralScriptInjects(md), 0);
    assert.equal(consumeEphemeralScriptInjects({}), 0);
    assert.equal(consumeEphemeralScriptInjects(null), 0);
    assert.equal(consumeEphemeralScriptInjects({ script_injects: { x: { ephemeral: false } } }), 0);
});

// ---------------------------------------------------------------------------
// 文本/匹配工具族
// ---------------------------------------------------------------------------

test('/upper /lower case conversion', async () => {
    const { env } = makeEnv();
    assert.equal((await runStscript(env, '/upper hello there')).result, 'HELLO THERE');
    assert.equal((await runStscript(env, '/lowercase ABC')).result, 'abc');
});

test('/substr slices with start/end incl. negative', async () => {
    const { env } = makeEnv();
    assert.equal((await runStscript(env, '/substr start=2 end=5 abcdef')).result, 'cde');
    assert.equal((await runStscript(env, '/substr start=-3 abcdef')).result, 'def');
    assert.equal((await runStscript(env, '/substring abcdef')).result, 'abcdef');
});

test('/replace literal and regex modes', async () => {
    const { env } = makeEnv();
    assert.equal((await runStscript(env, '/replace pattern=l replacer=L hello')).result, 'heLLo');
    assert.equal((await runStscript(env, '/replace mode=regex pattern=/l/g replacer=L hello')).result, 'heLLo');
    assert.equal((await runStscript(env, '/re pattern=o replacer=0 hello')).result, 'hell0');
});

test('/replace empty pattern throws; bad regex throws', async () => {
    const { env } = makeEnv();
    const e1 = await runStscript(env, '/replace pattern= hello');
    assert.equal(e1.isError, true);
    const e2 = await runStscript(env, '/replace mode=regex pattern=/[/ hello');
    assert.equal(e2.isError, true);
    assert.match(e2.errorMessage, /not a valid regular expression/);
});

test('/test returns JSON boolean', async () => {
    const { env } = makeEnv();
    assert.equal((await runStscript(env, '/test pattern=/^h/ hello')).result, 'true');
    assert.equal((await runStscript(env, '/test pattern=/^x/ hello')).result, 'false');
});

test('/match returns match JSON; /g gives all matches', async () => {
    const { env } = makeEnv();
    const single = await runStscript(env, '/match pattern=/l+/ hello');
    assert.deepEqual(JSON.parse(single.result)[0], 'll');
    const all = await runStscript(env, '/match pattern=/l/g hello');
    assert.deepEqual(JSON.parse(all.result), [['l'], ['l']]);
    const none = await runStscript(env, '/match pattern=/z/ hello');
    assert.equal(none.result, '');
});

test('/trimstart and /trimend trim to sentence bounds', async () => {
    const { env } = makeEnv();
    assert.equal((await runStscript(env, '/trimstart one. two')).result, 'two');
    assert.equal((await runStscript(env, '/trimend one! two three')).result, 'one!');
});

test('/tokens uses countTokens seam; unbound falls back to len/4', async () => {
    const { env } = makeEnv();
    assert.equal((await runStscript(env, '/tokens abcd')).result, '1');
    const bound = makeEnv({ host: { countTokens: () => 42 } });
    assert.equal((await runStscript(bound.env, '/tokens abcd')).result, '42');
});

test('/count joins non-system floors for token count', async () => {
    const chat = [
        { mes: 'aaaa', is_user: true, is_system: false },
        { mes: 'bbbb', is_user: false, is_system: false },
        { mes: 'skip me', is_user: false, is_system: true },
    ];
    const { env } = makeEnv({ chat });
    // 'aaaa bbbb' → 9 chars → ceil(9/4) = 3
    assert.equal((await runStscript(env, '/count')).result, '3');
});

test('/fuzzy mode=first finds item inside text; mode=best matches text in list', async () => {
    const { env } = makeEnv();
    await runStscript(env, '/setvar key=fuzlist ["apple","banana","grape"]');
    const first = await runStscript(env, '/fuzzy list=fuzlist mode=first I want an apple pie today');
    assert.equal(first.result, 'apple');
    const best = await runStscript(env, '/fuzzy list=fuzlist mode=best aple');
    assert.equal(best.result, 'apple');
    const miss = await runStscript(env, '/fuzzy list=fuzlist mode=first zucchini');
    assert.equal(miss.result, '');
    // 变量名解析失败/非数组 → warn + ''
    const bad = await runStscript(env, '/fuzzy list=not-a-list-var x');
    assert.equal(bad.result, '');
});

test('/is-mobile false by default; honors bound seam', async () => {
    const { env } = makeEnv();
    assert.equal((await runStscript(env, '/is-mobile')).result, 'false');
    const mob = makeEnv({ host: { isMobile: true } });
    assert.equal((await runStscript(mob.env, '/is-mobile')).result, 'true');
});

// ---------------------------------------------------------------------------
// power_user 写面族
// ---------------------------------------------------------------------------

function puEnv(initial = {}) {
    const pu = { ...initial };
    return { powerUser: pu, pu };
}

test('/stop-strings sets and gets custom_stopping_strings', async () => {
    const { powerUser, pu } = puEnv();
    const { env, persisted } = makeEnv({ host: { powerUser } });
    const set = await runStscript(env, '/stop-strings ["END","STOP"]');
    assert.equal(pu.custom_stopping_strings, '["END","STOP"]');
    assert.equal(set.result, '["END","STOP"]');
    assert.equal(persisted.settings, 1);
    const get = await runStscript(env, '/stop-strings');
    assert.equal(get.result, '["END","STOP"]');
    const bad = await runStscript(env, '/stop-strings not-json');
    assert.equal(bad.isError, true);
    const cleared = await runStscript(env, '/stop-strings force=true');
    assert.equal(cleared.result, '[]');
});

test('/start-reply-with sets and gets user_prompt_bias', async () => {
    const { powerUser, pu } = puEnv();
    const { env, persisted } = makeEnv({ host: { powerUser } });
    await runStscript(env, '/start-reply-with Sure thing');
    assert.equal(pu.user_prompt_bias, 'Sure thing');
    assert.equal(persisted.settings, 1);
    assert.equal((await runStscript(env, '/start-reply-with')).result, 'Sure thing');
    assert.equal((await runStscript(env, '/start-reply-with force=true')).result, '');
});

test('/single /bubble /flat write chat_display style numbers', async () => {
    const { powerUser, pu } = puEnv();
    const { env, persisted } = makeEnv({ host: { powerUser } });
    await runStscript(env, '/single');
    assert.equal(pu.chat_display, 2); // DOCUMENT
    await runStscript(env, '/bubbles');
    assert.equal(pu.chat_display, 1); // BUBBLES
    await runStscript(env, '/flat');
    assert.equal(pu.chat_display, 0); // DEFAULT
    assert.equal(persisted.settings, 3);
});

test('power-user commands warn when seam unbound', async () => {
    const { env, notifications } = makeEnv();
    await runStscript(env, '/stop-strings ["a"]');
    await runStscript(env, '/start-reply-with x');
    await runStscript(env, '/single');
    const warns = notifications.filter((n) => n.severity === 'warning');
    assert.equal(warns.length, 3);
    assert.ok(warns.every((n) => /powerUser/.test(n.text)));
});

// ---------------------------------------------------------------------------
// 会话生命周期
// ---------------------------------------------------------------------------

test('/newchat calls seam and emits go op', async () => {
    const calls = [];
    const { env } = makeEnv({
        host: {
            newChat: (opts) => { calls.push(opts); return { name: 'Char - 2026-01-01', charDir: 'char', chatName: 'Char - 2026-01-01' }; },
        },
    });
    const out = await runStscript(env, '/newchat');
    assert.equal(out.isError, false);
    assert.deepEqual(calls, [{ deleteCurrent: false }]);
    assert.deepEqual(out.ops.at(-1), { type: 'go', target: 'Char - 2026-01-01', charDir: 'char', chatName: 'Char - 2026-01-01' });
});

test('/newchat delete=true passes deleteCurrent through', async () => {
    const calls = [];
    const { env } = makeEnv({
        host: { newChat: (opts) => { calls.push(opts); return { name: 'new' }; } },
    });
    await runStscript(env, '/newchat delete=true');
    assert.deepEqual(calls, [{ deleteCurrent: true }]);
});

test('/newchat unbound seam throws; null result warns', async () => {
    const { env, notifications } = makeEnv();
    const out = await runStscript(env, '/newchat');
    assert.equal(out.isError, true);
    assert.match(out.errorMessage, /newChat/);
    const { env: env2, notifications: n2 } = makeEnv({ host: { newChat: () => null } });
    await runStscript(env2, '/newchat');
    assert.ok(n2.some((n) => n.severity === 'warning' && /Failed to create/.test(n.text)));
    assert.ok(notifications.length === 0);
});

test('/delchat calls seam and emits close-chat op', async () => {
    const calls = [];
    const { env } = makeEnv({ host: { deleteChat: () => { calls.push(1); return true; } } });
    const out = await runStscript(env, '/delchat');
    assert.equal(calls.length, 1);
    assert.deepEqual(out.ops.at(-1), { type: 'custom', kind: 'close-chat' });
});

test('/delchat unbound seam throws; false result notifies error', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/delchat');
    assert.equal(out.isError, true);
    const { env: env2, notifications } = makeEnv({ host: { deleteChat: () => false } });
    await runStscript(env2, '/delchat');
    assert.ok(notifications.some((n) => n.severity === 'error' && /Failed to delete/.test(n.text)));
});

test('/closechat emits close-chat op without seam', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/closechat');
    assert.equal(out.isError, false);
    assert.deepEqual(out.ops.at(-1), { type: 'custom', kind: 'close-chat' });
});
