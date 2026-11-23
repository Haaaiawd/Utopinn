/**
 * STscript 会话/角色命名 + 系统帮助 + 阻塞弹窗族 — TASK-064 批二验收。
 *
 * 覆盖:/renamechat /getchatname /forcesave /rename-char /impersonate
 * /? /help /popup /buttons;以及 /input 未绑 seam 的显式报错(GH#9 同路)。
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

function makeEnv({ chatMetadata = {}, chat = [], currentChatId = 'chat-1', host = {} } = {}) {
    const notifications = [];
    const systemMessages = [];
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
        ...host,
    });
    return { env, notifications, systemMessages };
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('session/dialog/system commands are registered', () => {
    for (const name of ['renamechat', 'getchatname', 'forcesave', 'rename-char',
        'impersonate', 'popup', 'buttons', '?']) {
        assert.ok(getCommand(name), `missing builtin: ${name}`);
    }
    assert.equal(getCommand('imp'), getCommand('impersonate'));
    assert.equal(getCommand('help'), getCommand('?'));
});

// ---------------------------------------------------------------------------
// /renamechat /getchatname /forcesave
// ---------------------------------------------------------------------------

test('/renamechat renames via seam and updates currentChatId', async () => {
    const calls = [];
    const { env, notifications } = makeEnv({
        host: { renameChat: (o, n) => { calls.push([o, n]); return true; } },
    });
    const out = await runStscript(env, '/renamechat new-name');
    assert.equal(out.isError, false);
    assert.deepEqual(calls, [['chat-1', 'new-name']]);
    assert.equal(env.macro.currentChatId, 'new-name');
    assert.ok(notifications.some((n) => n.severity === 'success'));
});

test('/renamechat empty name warns and no-ops', async () => {
    const calls = [];
    const { env, notifications } = makeEnv({ host: { renameChat: () => { calls.push(1); return true; } } });
    const out = await runStscript(env, '/renamechat');
    assert.equal(out.result, '');
    assert.equal(calls.length, 0);
    assert.ok(notifications.some((n) => n.severity === 'warning'));
});

test('/renamechat seam failure notifies error', async () => {
    const { env, notifications } = makeEnv({ host: { renameChat: () => false } });
    await runStscript(env, '/renamechat x');
    assert.ok(notifications.some((n) => n.severity === 'error' && /Failed to rename/.test(n.text)));
    assert.equal(env.macro.currentChatId, 'chat-1');
});

test('/renamechat unbound seam errors explicitly (no silent no-op)', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/renamechat x');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /renameChat/);
});

test('/getchatname pipes the current chat file name', async () => {
    const { env } = makeEnv({ currentChatId: 'abc-123' });
    const out = await runStscript(env, '/getchatname');
    assert.equal(out.result, 'abc-123');
});

test('/forcesave persists chat + settings', async () => {
    const calls = [];
    const { env } = makeEnv({
        host: {
            persistChat: () => { calls.push('chat'); },
            persistMetadata: () => { calls.push('meta'); },
            persistSettings: () => { calls.push('settings'); },
        },
    });
    const out = await runStscript(env, '/forcesave');
    assert.equal(out.isError, false);
    assert.deepEqual(calls, ['chat', 'meta', 'settings']);
});

// ---------------------------------------------------------------------------
// /rename-char /impersonate
// ---------------------------------------------------------------------------

test('/rename-char delegates to seam with parsed opts, returns true/false', async () => {
    const calls = [];
    const { env } = makeEnv({
        host: {
            currentCharAvatar: 'Char.png',
            renameCharacter: (n, opts) => { calls.push([n, opts]); return true; },
        },
    });
    const out = await runStscript(env, '/rename-char chats=on NewName');
    assert.equal(out.result, 'true');
    assert.deepEqual(calls, [['NewName', { silent: true, renameChats: true }]]);
});

test('/rename-char without a current character warns and returns false', async () => {
    const { env, notifications } = makeEnv();
    const out = await runStscript(env, '/rename-char X');
    assert.equal(out.result, 'false');
    assert.ok(notifications.some((n) => /No character selected/.test(n.text)));
});

test('/rename-char unbound seam errors explicitly', async () => {
    const { env } = makeEnv({ host: { currentCharAvatar: 'Char.png' } });
    const out = await runStscript(env, '/rename-char X');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /renameCharacter/);
});

test('/impersonate unbound generation seam errors explicitly (GH#9 line)', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/impersonate say hi');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /generateImpersonate|impersonate/);
});

test('/impersonate bound seam forwards prompt; await=on awaits it', async () => {
    let resolved = false;
    const { env } = makeEnv({
        host: {
            generateImpersonate: async (prompt) => {
                await new Promise((r) => setTimeout(r, 5));
                resolved = true;
                return { text: prompt };
            },
        },
    });
    const out = await runStscript(env, '/impersonate await=on hello there');
    assert.equal(out.isError, false);
    assert.equal(resolved, true);
});

// ---------------------------------------------------------------------------
// /? /help
// ---------------------------------------------------------------------------

test('/? sends help text as a system message', async () => {
    const { env, systemMessages } = makeEnv();
    const out = await runStscript(env, '/?');
    assert.equal(out.isError, false);
    assert.equal(systemMessages.length, 1);
    assert.match(systemMessages[0].text, /slash|macros|format/i);
});

test('/help macros / /? slash route to topic text; commands list is registry-sourced', async () => {
    const { env, systemMessages } = makeEnv();
    await runStscript(env, '/help macros');
    assert.match(systemMessages.at(-1).text, /\{\{user\}\}/);
    await runStscript(env, '/? slash');
    const listing = systemMessages.at(-1).text;
    assert.match(listing, /Slash commands/);
    assert.match(listing, /\/world/);
    assert.match(listing, /\/renamechat/);
});

test('/? unbound sendSystemMessage seam errors explicitly', async () => {
    const env = createStscriptEnv({ chat: [], chatMetadata: {}, globalVariables: {} }, {});
    const out = await runStscript(env, '/?');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /sendSystemMessage/);
});

// ---------------------------------------------------------------------------
// /popup /buttons — 阻塞 seam 未绑显式报错;绑定按语义兑现
// ---------------------------------------------------------------------------

test('/popup unbound seam errors explicitly', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/popup hello');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /requestPopup/);
});

test('/popup bound seam gets normalized options; result=on returns code', async () => {
    const seen = [];
    const { env } = makeEnv({
        host: { requestPopup: async (opts) => { seen.push(opts); return 1; } },
    });
    let out = await runStscript(env, '/popup large=on okButton=Sure cancelButton=Nah hello world');
    assert.equal(out.result, 'hello world');
    assert.equal(seen[0].large, true);
    assert.equal(seen[0].okButton, 'Sure');
    assert.equal(seen[0].cancelButton, 'Nah');
    out = await runStscript(env, '/popup result=on hi');
    assert.equal(out.result, '1');
});

test('/buttons unbound seam errors explicitly', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/buttons labels=["Yes","No"] pick');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /requestButtons/);
});

test('/buttons bound seam returns clicked label; multiple=on returns JSON array', async () => {
    const seen = [];
    const { env } = makeEnv({
        host: { requestButtons: async (opts) => { seen.push(opts); return [3]; } },
    });
    // code = index+2 → 3 = 第二枚
    const out = await runStscript(env, '/buttons labels=["Yes","No"] pick one');
    assert.equal(out.result, 'No');
    assert.deepEqual(seen[0].buttons.map((b) => b.text), ['Yes', 'No']);

    const { env: env2 } = makeEnv({ host: { requestButtons: async () => [2, 3] } });
    const out2 = await runStscript(env2, '/buttons multiple=on labels=["A","B","C"] go');
    assert.deepEqual(JSON.parse(out2.result), ['A', 'B']);
});

test('/buttons invalid labels JSON returns empty (upstream warn path)', async () => {
    const { env } = makeEnv({ host: { requestButtons: async () => [2] } });
    const out = await runStscript(env, '/buttons labels=notjson pick');
    assert.equal(out.result, '');
});

// ---------------------------------------------------------------------------
// /input — 未绑显式报错(批二行为修正)
// ---------------------------------------------------------------------------

test('/input unbound requestInput seam errors explicitly (was silent null)', async () => {
    const { env } = makeEnv();
    const out = await runStscript(env, '/input prompt?');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /requestInput/);
});

test('/input bound seam pipes the entered value', async () => {
    const { env } = makeEnv({ host: { requestInput: async () => 'typed text' } });
    const out = await runStscript(env, '/input prompt?');
    assert.equal(out.result, 'typed text');
});

// ---------------------------------------------------------------------------
// /persona-set(别名 /persona /name)— personas.js setNameCallback 服务端面
// ---------------------------------------------------------------------------

test('/persona-set registered under all three names', () => {
    assert.equal(getCommand('persona'), getCommand('persona-set'));
    assert.equal(getCommand('name'), getCommand('persona-set'));
});

test('/name temp mode calls setUserName and updates name1', async () => {
    const calls = [];
    const { env } = makeEnv({ host: { setUserName: (n) => calls.push(n) } });
    const out = await runStscript(env, '/name mode=temp Alice');
    assert.equal(out.isError, false);
    assert.deepEqual(calls, ['Alice']);
    assert.equal(env.macro.name1, 'Alice');
});

test('/name lookup hit selects persona avatar + syncs name1', async () => {
    const selected = [];
    const userNames = [];
    const { env, notifications } = makeEnv({
        host: {
            findPersona: (n) => (n === 'Alice' ? { name: 'Alice', avatar: 'alice.png' } : null),
            selectPersona: (a) => selected.push(a),
            setUserName: (n) => userNames.push(n),
        },
    });
    const out = await runStscript(env, '/name Alice');
    assert.equal(out.isError, false);
    assert.deepEqual(selected, ['alice.png']);
    assert.deepEqual(userNames, ['Alice']);
    assert.equal(env.macro.name1, 'Alice');
    assert.ok(!notifications.some((n) => n.severity === 'warning'));
});

test('/name lookup miss in lookup mode warns; in all mode falls back to temp', async () => {
    const calls = [];
    const { env, notifications } = makeEnv({
        host: { findPersona: () => null, setUserName: (n) => calls.push(n) },
    });
    const out1 = await runStscript(env, '/name mode=lookup Ghost');
    assert.equal(out1.result, '');
    assert.equal(calls.length, 0);
    assert.ok(notifications.some((n) => /Persona Ghost not found/.test(n.text)));

    const out2 = await runStscript(env, '/name Ghost');
    assert.equal(out2.isError, false);
    assert.deepEqual(calls, ['Ghost']);
});

test('/name persona hit with unbound selectPersona warns but still applies name', async () => {
    const userNames = [];
    const { env, notifications } = makeEnv({
        host: {
            findPersona: () => ({ name: 'Alice', avatar: 'alice.png' }),
            setUserName: (n) => userNames.push(n),
        },
    });
    const out = await runStscript(env, '/name Alice');
    assert.equal(out.isError, false);
    assert.deepEqual(userNames, ['Alice']);
    assert.equal(env.macro.name1, 'Alice');
    assert.ok(notifications.some((n) => /selectPersona unbound/.test(n.text)));
});

test('/name unbound setUserName errors explicitly; bad mode warns', async () => {
    const { env, notifications } = makeEnv();
    const out = await runStscript(env, '/name mode=temp Alice');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /setUserName/);
    const out2 = await runStscript(env, '/name mode=bogus Alice');
    assert.equal(out2.isError, false);
    assert.ok(notifications.some((n) => /Mode must be one of/.test(n.text)));
    const out3 = await runStscript(env, '/name');
    assert.ok(notifications.some((n) => /specify a name/.test(n.text)));
});
