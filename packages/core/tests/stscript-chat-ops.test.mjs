/**
 * STscript 楼层/会话操作族 + 作者注命令 — TASK-064 首批验收。
 *
 * 覆盖:
 * - /del /cut /delname /hide /unhide /swap(含 toolcalls 级联、patch 回执)
 * - /swipe /delswipe /addswipe(swipe_id/swipes/swipe_info 联动、整楼 op、
 *   overswipe 降级、切版前 syncMesToSwipe 防编辑丢失)
 * - /messages /message-role /message-name /reroll-pick /go
 * - /note /note-set /note-get /note-depth /note-frequency /note-position
 *   /note-role(chat_metadata.note_* + note op 回执)
 * - /incvar /decvar 校验(变量域原有面)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createStscriptEnv,
    runStscript,
    registerBuiltinCommands,
    getCommand,
} from '../dist/index.js';

registerBuiltinCommands();

const floor = (mes, extra = {}) => ({
    name: extra.name ?? 'Char',
    is_user: extra.is_user ?? false,
    is_system: extra.is_system ?? false,
    send_date: extra.send_date ?? '2026-01-01 00:00',
    mes,
    ...extra,
});

/** 带楼层与 patch seam 的 env;patches 收集 host.patchChat 收到的 ops 批。 */
function makeChatEnv(floors = [], host = {}) {
    const patches = [];
    const notifications = [];
    const env = createStscriptEnv({
        chat: floors,
        chatMetadata: { variables: {} },
        globalVariables: {},
        name1: 'User',
        name2: 'Char',
    }, {
        patchChat: (ops) => { patches.push(ops); },
        notify: (severity, title, text) => { notifications.push({ severity, title, text }); },
        ...host,
    });
    return { env, patches, notifications };
}

const patchOps = (patches) => patches.flat();

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('new commands are registered (first batch)', () => {
    for (const name of ['del', 'cut', 'swipe', 'delswipe', 'addswipe', 'swap', 'go',
        'hide', 'unhide', 'delname', 'messages', 'message-role', 'message-name',
        'reroll-pick', 'note', 'note-set', 'note-get', 'note-depth',
        'note-frequency', 'note-position', 'note-role']) {
        assert.ok(getCommand(name), `missing builtin: ${name}`);
    }
    assert.equal(getCommand('note-set'), getCommand('note'));
    assert.equal(getCommand('note-get'), getCommand('note'));
});

// ---------------------------------------------------------------------------
// /del /cut /delname /hide /unhide /swap
// ---------------------------------------------------------------------------

test('/del N removes the last N floors and returns their text', async () => {
    const { env, patches } = makeChatEnv([floor('a'), floor('b'), floor('c')]);
    const out = await runStscript(env, '/del 2');
    assert.equal(env.macro.chat.length, 1);
    assert.match(out.result, /b\nc\n?$/);
    // 预镜像下标降序 remove
    assert.deepEqual(patchOps(patches), [
        { op: 'remove', path: '/body/2' },
        { op: 'remove', path: '/body/1' },
    ]);
    assert.equal(out.ops.at(-1).type, 'chat-patch');
});

test('/del with no argument does nothing (UI delete mode is client-side)', async () => {
    const { env } = makeChatEnv([floor('a'), floor('b')]);
    const out = await runStscript(env, '/del');
    assert.equal(env.macro.chat.length, 2);
    assert.equal(out.result, '');
});

test('/cut 0-1 removes inclusive range and returns cut text', async () => {
    const { env, patches } = makeChatEnv([floor('x'), floor('y'), floor('z')]);
    const out = await runStscript(env, '/cut 0-1');
    assert.equal(env.macro.chat.length, 1);
    assert.equal(env.macro.chat[0].mes, 'z');
    assert.match(out.result, /x\ny\n?$/);
    assert.deepEqual(patchOps(patches), [
        { op: 'remove', path: '/body/1' },
        { op: 'remove', path: '/body/0' },
    ]);
});

test('/cut toolcalls cascade eats preceding tool-call floors of an AI floor', async () => {
    const toolCall = floor('tc', { is_system: true, extra: { tool_invocations: [{ id: 1 }] } });
    const { env, patches } = makeChatEnv([floor('u', { is_user: true, name: 'User' }), toolCall, floor('ai')]);
    const out = await runStscript(env, '/cut 2');
    // tool-call 级联:1..2 一起删,只剩 user 楼
    assert.equal(env.macro.chat.length, 1);
    assert.equal(env.macro.chat[0].mes, 'u');
    assert.deepEqual(patchOps(patches), [
        { op: 'remove', path: '/body/2' },
        { op: 'remove', path: '/body/1' },
    ]);
    assert.match(out.result, /ai\n?$/);
});

test('/cut toolcalls=false disables the cascade', async () => {
    const toolCall = floor('tc', { is_system: true, extra: { tool_invocations: [{}] } });
    const { env } = makeChatEnv([floor('u', { is_user: true }), toolCall, floor('ai')]);
    await runStscript(env, '/cut toolcalls=false 2');
    assert.equal(env.macro.chat.length, 2);
    assert.equal(env.macro.chat[1].mes, 'tc');
});

test('/cut warns on invalid range', async () => {
    const { env, notifications } = makeChatEnv([floor('a')]);
    const out = await runStscript(env, '/cut 9-12');
    assert.equal(out.result, '');
    assert.ok(notifications.some(n => n.severity === 'warning'));
});

test('/swap exchanges two floors via dual replace ops', async () => {
    const { env, patches } = makeChatEnv([floor('a'), floor('b'), floor('c')]);
    await runStscript(env, '/swap 0 2');
    assert.deepEqual(env.macro.chat.map(m => m.mes), ['c', 'b', 'a']);
    assert.equal(env.macro.chatMetadata.tainted, true);
    const ops = patchOps(patches);
    assert.equal(ops.length, 2);
    assert.equal(ops[0].path, '/body/0');
    assert.equal(ops[0].value.mes, 'c');
    assert.equal(ops[1].path, '/body/2');
    assert.equal(ops[1].value.mes, 'a');
});

test('/swap rejects out-of-bounds and same-index', async () => {
    const { env, notifications } = makeChatEnv([floor('a'), floor('b')]);
    await runStscript(env, '/swap 0 5');
    assert.ok(notifications.some(n => n.severity === 'warning'));
    assert.deepEqual(env.macro.chat.map(m => m.mes), ['a', 'b']);
});

test('/delname removes every floor by name and taints metadata', async () => {
    const { env, patches } = makeChatEnv([
        floor('keep1', { name: 'User', is_user: true }),
        floor('x1', { name: 'Char' }),
        floor('keep2', { name: 'User', is_user: true }),
        floor('x2', { name: 'Char' }),
    ]);
    await runStscript(env, '/delname Char');
    assert.deepEqual(env.macro.chat.map(m => m.mes), ['keep1', 'keep2']);
    assert.equal(env.macro.chatMetadata.tainted, true);
    assert.deepEqual(patchOps(patches), [
        { op: 'remove', path: '/body/3' },
        { op: 'remove', path: '/body/1' },
    ]);
});

test('/hide and /unhide toggle is_system over a range', async () => {
    const { env, patches } = makeChatEnv([floor('a'), floor('b'), floor('c')]);
    await runStscript(env, '/hide 0-1');
    assert.equal(env.macro.chat[0].is_system, true);
    assert.equal(env.macro.chat[1].is_system, true);
    assert.equal(env.macro.chat[2].is_system, false);
    assert.deepEqual(patchOps(patches), [
        { op: 'replace', path: '/body/0/is_system', value: true },
        { op: 'replace', path: '/body/1/is_system', value: true },
    ]);
    await runStscript(env, '/unhide 0');
    assert.equal(env.macro.chat[0].is_system, false);
});

test('/hide with no range defaults to the last floor', async () => {
    const { env } = makeChatEnv([floor('a'), floor('b')]);
    await runStscript(env, '/hide');
    assert.equal(env.macro.chat[0].is_system, false);
    assert.equal(env.macro.chat[1].is_system, true);
});

// ---------------------------------------------------------------------------
// /swipe /delswipe /addswipe
// ---------------------------------------------------------------------------

test('/swipe right past the last AI swipe without generateSwipe reverts + warns', async () => {
    const { env, patches, notifications } = makeChatEnv([
        floor('u', { is_user: true, name: 'User' }),
        floor('only version', { swipe_id: 0, swipes: ['only version'], swipe_info: [{ send_date: 'd' }] }),
    ]);
    // 末楼 AI + 非 greeting → overswipe=regenerate;seam 缺席 → revert + warn(不静默)
    const out = await runStscript(env, '/swipe');
    const m = env.macro.chat[1];
    assert.equal(m.swipe_id, 0);
    assert.equal(m.mes, 'only version');
    assert.ok(notifications.some(n => /generateSwipe/.test(n.text)));
    assert.equal(out.result, '');
    assert.equal(patchOps(patches).length, 0);
});

test('/swipe right on user message loops to first swipe', async () => {
    const { env } = makeChatEnv([
        floor('v0', { is_user: true, name: 'User', swipe_id: 1, swipes: ['v0', 'v1'], swipe_info: [{ send_date: 'd0' }, { send_date: 'd1', extra: { tag: 'x' } }] }),
    ]);
    // 已在末版 → 右划 overswipe;用户楼 → LOOP 回 0
    await runStscript(env, '/swipe direction=right');
    assert.equal(env.macro.chat[0].swipe_id, 0);
    assert.equal(env.macro.chat[0].mes, 'v0');
});

test('/swipe left/right navigates and syncs mes/extra from swipe_info', async () => {
    const { env, patches } = makeChatEnv([
        floor('v0', {
            swipe_id: 0,
            swipes: ['v0', 'v1', 'v2'],
            swipe_info: [
                { send_date: 'd0', gen_started: 'g0', extra: { e: 0 } },
                { send_date: 'd1', gen_started: 'g1', gen_finished: 'f1', extra: { e: 1 } },
                { send_date: 'd2', extra: { e: 2 } },
            ],
            extra: { e: 0, memory: 'stale' },
        }),
    ]);
    let out = await runStscript(env, '/swipe direction=right');
    const m = env.macro.chat[0];
    assert.equal(m.swipe_id, 1);
    assert.equal(m.mes, 'v1');
    assert.equal(m.send_date, 'd1');
    assert.equal(m.gen_started, 'g1');
    assert.equal(m.gen_finished, 'f1');
    assert.deepEqual(m.extra, { e: 1 });
    // 整楼 replace op
    assert.equal(patchOps(patches).length, 1);
    assert.equal(patchOps(patches)[0].path, '/body/0');
    assert.equal(patchOps(patches)[0].value.swipe_id, 1);

    out = await runStscript(env, '/swipe direction=left');
    assert.equal(env.macro.chat[0].swipe_id, 0);
    assert.equal(env.macro.chat[0].mes, 'v0');
    // syncMesToSwipe 在切走时把含 memory 的 extra 写回槽 0 —— 上游同语义,
    // 划回来整包还原;gen_finished 随槽 0 的 swipe_info(无该键)不残留
    assert.deepEqual(env.macro.chat[0].extra, { e: 0, memory: 'stale' });
    assert.equal(env.macro.chat[0].gen_finished, undefined);
});

test('/swipe writes the edited mes back into the old slot before switching', async () => {
    const { env } = makeChatEnv([
        floor('earlier'), // chat.length>1 → syncMesToSwipe 写回正文
        floor('v0', { swipe_id: 0, swipes: ['v0', 'v1'], swipe_info: [{}, {}] }),
    ]);
    env.macro.chat[1].mes = 'v0-edited';
    await runStscript(env, '/swipe direction=left');
    // 左划越界 → 回末版;走前 swipes[0] 已写回编辑稿
    assert.equal(env.macro.chat[1].swipes[0], 'v0-edited');
    assert.equal(env.macro.chat[1].swipe_id, 1);
});

test('/swipe overswipe REGENERATE hits host.generateSwipe when bound', async () => {
    const calls = [];
    const { env } = makeChatEnv([
        floor('v0', { swipe_id: 0, swipes: ['v0'], swipe_info: [{ send_date: 'd' }], extra: { memory: 'x' } }),
    ], {
        generateSwipe: async (i) => { calls.push(i); },
    });
    env.macro.chatMetadata.tainted = true; // 非 pristine → AI 楼 overswipe=regenerate
    await runStscript(env, '/swipe await=true');
    assert.deepEqual(calls, [0]);
    const m = env.macro.chat[0];
    assert.equal(m.swipe_id, 1); // 新槽位
    assert.equal(m.mes, '');
});

test('/addswipe appends a version and /delswipe removes the current', async () => {
    const { env, patches, notifications } = makeChatEnv([floor('base')]);
    let out = await runStscript(env, '/addswipe switch=true "second take"');
    const m = env.macro.chat[0];
    assert.equal(m.swipes.length, 2);
    assert.equal(m.swipe_id, 1);
    assert.equal(m.mes, 'second take');
    assert.equal(out.result, '1');

    out = await runStscript(env, '/delswipe');
    assert.equal(m.swipes.length, 1);
    assert.equal(m.swipe_id, 0);
    assert.equal(m.mes, 'base');
    assert.equal(env.macro.chatMetadata.tainted, true);

    // 仅剩一版 → 拒绝
    await runStscript(env, '/delswipe');
    assert.ok(notifications.some(n => /last swipe/i.test(n.text)));
    assert.equal(patchOps(patches).every(o => o.op === 'replace'), true);
});

test('/addswipe refuses user and system floors', async () => {
    const { env, notifications } = makeChatEnv([floor('u', { is_user: true, name: 'User' })]);
    await runStscript(env, '/addswipe nope');
    assert.ok(notifications.some(n => /user messages/i.test(n.text)));
});

// ---------------------------------------------------------------------------
// /messages /message-role /message-name /reroll-pick /go
// ---------------------------------------------------------------------------

test('/messages returns range text with name prefixes by default', async () => {
    const { env } = makeChatEnv([
        floor('hi', { name: 'User', is_user: true }),
        floor('yo', { name: 'Char' }),
        floor('sys', { name: 'System', is_system: true }),
    ]);
    let out = await runStscript(env, '/messages 0-1');
    assert.equal(out.result, 'User: hi\n\nChar: yo');
    // 隐藏楼默认不收
    out = await runStscript(env, '/messages names=off 0-2');
    assert.equal(out.result, 'hi\n\nyo');
    out = await runStscript(env, '/messages hidden=on names=off 0-2');
    assert.equal(out.result, 'hi\n\nyo\n\nsys');
    // role 过滤:narrator extra.type → system
    out = await runStscript(env, '/messages role=user names=off 0-2');
    assert.equal(out.result, 'hi');
});

test('/message-role get/set via at=', async () => {
    const { env, patches } = makeChatEnv([
        floor('u', { is_user: true, name: 'User' }),
        floor('a', { name: 'Char' }),
    ]);
    let out = await runStscript(env, '/message-role at=1');
    assert.equal(out.result, 'assistant');
    out = await runStscript(env, '/message-role at=1 system');
    assert.equal(out.result, 'system');
    assert.equal(env.macro.chat[1].extra.type, 'narrator');
    assert.equal(env.macro.chat[1].is_user, false);
    out = await runStscript(env, '/message-role at=-1');
    assert.equal(out.result, 'system'); // -1 = 末楼
    assert.equal(patchOps(patches)[0].path, '/body/1');
});

test('/message-name get/set resolves persona and character avatars', async () => {
    const { env } = makeChatEnv([
        floor('u', { is_user: true, name: 'Old' }),
        floor('a', { name: 'OldChar' }),
    ], {
        findPersona: (n) => n === 'Me' ? { name: 'Me', avatar: 'me.png' } : null,
        resolveCharacter: (n) => n === 'Char2' ? { name: 'Char2', avatar: 'char2.png' } : null,
        avatarUrl: (kind, id) => `${kind}/${id}`,
        currentCharAvatar: 'other.png',
    });
    let out = await runStscript(env, '/message-name at=0');
    assert.equal(out.result, 'Old');
    await runStscript(env, '/message-name at=0 Me');
    assert.equal(env.macro.chat[0].name, 'Me');
    assert.equal(env.macro.chat[0].force_avatar, 'persona/me.png');
    assert.equal(env.macro.chat[0].original_avatar, 'me.png');
    await runStscript(env, '/message-name at=1 Char2');
    assert.equal(env.macro.chat[1].name, 'Char2');
    assert.equal(env.macro.chat[1].force_avatar, 'avatar/char2.png');
});

test('/reroll-pick increments the pick seed in chat_metadata', async () => {
    const { env } = makeChatEnv([floor('a')]);
    let out = await runStscript(env, '/reroll-pick');
    assert.equal(out.result, '1');
    assert.equal(env.macro.chatMetadata.pick_reroll_seed, 1);
    out = await runStscript(env, '/reroll-pick 42');
    assert.equal(env.macro.chatMetadata.pick_reroll_seed, 42);
});

test('/go resolves via host seam and emits a go op receipt', async () => {
    const { env, notifications } = makeChatEnv([floor('a')], {
        resolveChatTarget: (name) => name === 'Hero'
            ? { charDir: 'hero', chatName: 'chat-1', name: 'Hero' }
            : null,
    });
    let out = await runStscript(env, '/go Hero');
    assert.equal(out.result, 'Hero');
    assert.deepEqual(out.ops.at(-1), { type: 'go', target: 'Hero', charDir: 'hero', chatName: 'chat-1' });
    out = await runStscript(env, '/go Nobody');
    assert.equal(out.result, '');
    assert.ok(notifications.some(n => /No matches/.test(n.text)));
});

test('/go without resolveChatTarget seam fails explicitly', async () => {
    const { env } = makeChatEnv([floor('a')]);
    const out = await runStscript(env, '/go Hero');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /resolveChatTarget/);
});

// ---------------------------------------------------------------------------
// 作者注 — chat_metadata.note_* + note op
// ---------------------------------------------------------------------------

test('/note sets and returns the author note; note-set/note-get are aliases', async () => {
    const { env } = makeChatEnv([floor('a')]);
    let out = await runStscript(env, '/note remember the dagger');
    assert.equal(out.result, 'remember the dagger');
    assert.equal(env.macro.chatMetadata.note_prompt, 'remember the dagger');
    assert.deepEqual(out.ops.at(-1), { type: 'note', key: 'note_prompt', value: 'remember the dagger' });
    out = await runStscript(env, '/note-get');
    assert.equal(out.result, 'remember the dagger');
    out = await runStscript(env, '/note-set replaced');
    assert.equal(env.macro.chatMetadata.note_prompt, 'replaced');
});

test('/note-depth /note-frequency store Math.abs numbers', async () => {
    const { env } = makeChatEnv([floor('a')]);
    let out = await runStscript(env, '/note-depth -4');
    assert.equal(env.macro.chatMetadata.note_depth, 4);
    assert.equal(out.result, '4'); // 管道 lint 成字符串
    out = await runStscript(env, '/note-frequency 2');
    assert.equal(env.macro.chatMetadata.note_interval, 2);
    // 非法数 → error notify + 返回旧值
    out = await runStscript(env, '/note-depth abc');
    assert.equal(out.result, '');
    assert.equal(env.macro.chatMetadata.note_depth, 4);
});

test('/note-position maps names to numeric position and back', async () => {
    const { env } = makeChatEnv([floor('a')]);
    let out = await runStscript(env, '/note-position chat');
    assert.equal(env.macro.chatMetadata.note_position, 1);
    assert.equal(out.result, 'chat');
    out = await runStscript(env, '/note-position before_scenario');
    assert.equal(env.macro.chatMetadata.note_position, 2);
    assert.equal(out.result, 'before_scenario');
    // 别名 before → 同值 2,读出规范名 before_scenario
    await runStscript(env, '/note-position before');
    out = await runStscript(env, '/note-position');
    assert.equal(out.result, 'before_scenario');
    out = await runStscript(env, '/note-position nowhere');
    assert.equal(out.result, '');
});

test('/note-role maps names to numeric role and back', async () => {
    const { env } = makeChatEnv([floor('a')]);
    let out = await runStscript(env, '/note-role user');
    assert.equal(env.macro.chatMetadata.note_role, 1);
    assert.equal(out.result, 'user');
    out = await runStscript(env, '/note-role bogus');
    assert.equal(out.result, '');
});

// ---------------------------------------------------------------------------
// 变量域校验(原有面,工作令点名确认)
// ---------------------------------------------------------------------------

test('/incvar /decvar /setvar /getvar stay intact', async () => {
    const env = createStscriptEnv({
        chat: [], chatMetadata: { variables: {} }, globalVariables: {},
        name1: 'U', name2: 'C',
    });
    let out = await runStscript(env, '/setvar key=counter 5 | /incvar counter | /getvar counter');
    assert.equal(out.result, '6');
    out = await runStscript(env, '/decvar counter | /getvar counter');
    assert.equal(out.result, '5');
});

test('/sendas still resolves through resolveCharacter seam', async () => {
    const env = createStscriptEnv({
        chat: [], chatMetadata: { variables: {} }, globalVariables: {},
        name1: 'U', name2: 'C',
    }, {
        resolveCharacter: (n) => n === 'Char' ? { name: 'Char', avatar: 'char.png' } : null,
        currentCharAvatar: 'char.png',
    });
    const out = await runStscript(env, '/sendas name=Char hello');
    assert.equal(env.macro.chat.at(-1).name, 'Char');
    assert.equal(out.isError, false);
});
