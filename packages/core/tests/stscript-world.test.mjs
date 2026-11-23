/**
 * STscript 世界书(WI)族 — TASK-064 批二验收。
 *
 * 覆盖:/world /getchatbook /getglobalbooks /getpersonabook /getcharbook
 * /findentry /getentryfield /createentry /setentryfield
 * /wi-set-timed-effect /wi-get-timed-effect。
 * 宿主面 = 内存 WI 书仓 + settings 活对象;未绑 seam 显式报错。
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

/** 内存 WI 仓 + settings 活对象宿主;books = {name: {entries:{}}}. */
function makeWiEnv({ books = {}, chatMetadata = {}, chat = [], currentChatId = 'chat-1', settings = {}, host = {} } = {}) {
    const notifications = [];
    const savedBooks = [];
    const created = [];
    const wiSettings = settings.worldInfo ?? { globalSelect: [], charLore: [] };
    const powerUser = settings.powerUser ?? {};
    const tags = settings.tags ?? [];
    const env = createStscriptEnv({
        chat,
        chatMetadata,
        globalVariables: {},
        name1: 'User',
        name2: 'Char',
        currentChatId,
    }, {
        notify: (severity, title, text) => { notifications.push({ severity, title, text }); },
        worldInfoSettings: wiSettings,
        powerUser,
        listWorldBooks: () => Object.keys(books).sort(),
        getWorldBook: (name) => {
            const canonical = Object.keys(books).find((n) => n.toLowerCase() === String(name).toLowerCase());
            return canonical ? books[canonical] : null;
        },
        saveWorldBook: (name, doc) => {
            const canonical = Object.keys(books).find((n) => n.toLowerCase() === String(name).toLowerCase()) ?? name;
            books[canonical] = doc;
            savedBooks.push(canonical);
        },
        createWorldBook: (name) => {
            books[name] = { entries: {} };
            created.push(name);
            return name;
        },
        ...host,
    });
    return { env, books, wiSettings, powerUser, notifications, savedBooks, created, chatMetadata };
}

const bookWith = (entries) => ({ entries: Object.fromEntries(entries.map((e, i) => [e.uid ?? i, e])) });

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('WI commands are registered with upstream aliases', () => {
    for (const name of ['world', 'getchatbook', 'getglobalbooks', 'getpersonabook',
        'getcharbook', 'findentry', 'getentryfield', 'createentry', 'setentryfield',
        'wi-set-timed-effect', 'wi-get-timed-effect']) {
        assert.ok(getCommand(name), `missing builtin: ${name}`);
    }
    // 上游别名落同一命令对象
    assert.equal(getCommand('getcharlore'), getCommand('getcharbook'));
    assert.equal(getCommand('getcharwi'), getCommand('getcharbook'));
    assert.equal(getCommand('findlore'), getCommand('findentry'));
    assert.equal(getCommand('findwi'), getCommand('findentry'));
    assert.equal(getCommand('getlorefield'), getCommand('getentryfield'));
    assert.equal(getCommand('getwifield'), getCommand('getentryfield'));
    assert.equal(getCommand('createlore'), getCommand('createentry'));
    assert.equal(getCommand('createwi'), getCommand('createentry'));
    assert.equal(getCommand('setlorefield'), getCommand('setentryfield'));
    assert.equal(getCommand('setwifield'), getCommand('setentryfield'));
});

// ---------------------------------------------------------------------------
// /world
// ---------------------------------------------------------------------------

test('/world activates a world (default state=on) into globalSelect', async () => {
    const { env, wiSettings } = makeWiEnv({ books: { A: { entries: {} }, B: { entries: {} } } });
    const out = await runStscript(env, '/world A');
    assert.equal(out.isError, false);
    assert.deepEqual(wiSettings.globalSelect, ['A']);
});

test('/world state=off removes only that world; state=toggle flips', async () => {
    const { env, wiSettings } = makeWiEnv({ books: { A: { entries: {} }, B: { entries: {} } } });
    wiSettings.globalSelect.push('A', 'B');
    await runStscript(env, '/world state=off A');
    assert.deepEqual(wiSettings.globalSelect, ['B']);
    await runStscript(env, '/world state=toggle B');
    assert.deepEqual(wiSettings.globalSelect, []);
    await runStscript(env, '/world state=toggle B');
    assert.deepEqual(wiSettings.globalSelect, ['B']);
});

test('/world with no args deactivates all worlds', async () => {
    const { env, wiSettings } = makeWiEnv({ books: {} });
    wiSettings.globalSelect.push('A', 'B');
    await runStscript(env, '/world');
    assert.deepEqual(wiSettings.globalSelect, []);
});

test('/world unknown name warns and does not mutate', async () => {
    const { env, wiSettings, notifications } = makeWiEnv({ books: { A: { entries: {} } } });
    await runStscript(env, '/world nope');
    assert.deepEqual(wiSettings.globalSelect, []);
    assert.ok(notifications.some((n) => n.severity === 'error' && /No world found/.test(n.text)));
});

test('/world name match is case-insensitive canonical (getWIElement:option)', async () => {
    const { env, wiSettings } = makeWiEnv({ books: { 'My Book': { entries: {} } } });
    await runStscript(env, '/world my book');
    assert.deepEqual(wiSettings.globalSelect, ['My Book']);
});

test('/world persists settings through persistSettings seam', async () => {
    let persisted = 0;
    const { env } = makeWiEnv({ books: { A: { entries: {} } }, host: { persistSettings: () => { persisted++; } } });
    await runStscript(env, '/world A');
    assert.equal(persisted, 1);
});

// ---------------------------------------------------------------------------
// /getchatbook /getglobalbooks /getpersonabook
// ---------------------------------------------------------------------------

test('/getchatbook returns bound book when metadata key resolves to a real book', async () => {
    const { env } = makeWiEnv({ books: { Bound: { entries: {} } }, chatMetadata: { world_info: 'Bound' } });
    const out = await runStscript(env, '/getchatbook');
    assert.equal(out.result, 'Bound');
});

test('/getchatbook creates and binds when unbound (default create)', async () => {
    const { env, chatMetadata, created } = makeWiEnv({ books: {} });
    const out = await runStscript(env, '/getchatbook name=ChatLore');
    assert.equal(out.result, 'ChatLore');
    assert.equal(chatMetadata.world_info, 'ChatLore');
    assert.deepEqual(created, ['ChatLore']);
});

test('/getchatbook create=off returns empty without creating', async () => {
    const { env, created } = makeWiEnv({ books: {} });
    const out = await runStscript(env, '/getchatbook create=off');
    assert.equal(out.result, '');
    assert.equal(created.length, 0);
});

test('/getchatbook without chat warns', async () => {
    const { env, notifications } = makeWiEnv({ currentChatId: null });
    const out = await runStscript(env, '/getchatbook');
    assert.equal(out.result, '');
    assert.ok(notifications.some((n) => /Open a chat/.test(n.text)));
});

test('/getglobalbooks returns globalSelect as JSON', async () => {
    const { env, wiSettings } = makeWiEnv({ books: {} });
    wiSettings.globalSelect.push('X', 'Y');
    const out = await runStscript(env, '/getglobalbooks');
    assert.deepEqual(JSON.parse(out.result), ['X', 'Y']);
});

test('/getpersonabook returns bound persona book; create=true binds new', async () => {
    const { env, powerUser } = makeWiEnv({ books: {} });
    powerUser.persona_description_lorebook = 'PB';
    let out = await runStscript(env, '/getpersonabook');
    assert.equal(out.result, 'PB');

    const { env: env2, powerUser: pu2, created } = makeWiEnv({ books: {} });
    out = await runStscript(env2, '/getpersonabook create=on name=MyPersonaBook');
    assert.equal(out.result, 'MyPersonaBook');
    assert.equal(pu2.persona_description_lorebook, 'MyPersonaBook');
    assert.deepEqual(created, ['MyPersonaBook']);
});

// ---------------------------------------------------------------------------
// /getcharbook
// ---------------------------------------------------------------------------

test('/getcharbook type=primary reads extensions.world from the card', async () => {
    const { env } = makeWiEnv({
        books: { CL: { entries: {} } },
        host: {
            loadCharacterCard: (avatar) => ({ name: 'Char', data: { extensions: { world: 'CL' } } }),
        },
    });
    const out = await runStscript(env, '/getcharbook Char.png');
    assert.equal(out.result, 'CL');
});

test('/getcharbook type=additional reads charLore aux books', async () => {
    const { env, wiSettings } = makeWiEnv({
        books: { Aux: { entries: {} } },
        host: { resolveCharacter: (name) => (name === 'Char.png' || name === 'Char' ? { name: 'Char', avatar: 'Char.png' } : null) },
    });
    wiSettings.charLore.push({ name: 'Char', extraBooks: ['Aux'] });
    const out = await runStscript(env, '/getcharbook type=additional Char.png');
    assert.deepEqual(JSON.parse(out.result), ['Aux']);
});

test('/getcharbook create=on type=primary writes extensions.world via setCharacterWorld', async () => {
    const writes = [];
    const { env, created } = makeWiEnv({
        books: {},
        host: {
            loadCharacterCard: () => ({ name: 'Char', data: { extensions: {} } }),
            setCharacterWorld: (avatar, world) => { writes.push([avatar, world]); return true; },
        },
    });
    const out = await runStscript(env, '/getcharbook create=on name=NewBook Char.png');
    assert.equal(out.result, 'NewBook');
    assert.deepEqual(created, ['NewBook']);
    assert.deepEqual(writes, [['Char.png', 'NewBook']]);
});

test('/getcharbook create=on type=additional appends into charLore', async () => {
    const { env, wiSettings } = makeWiEnv({
        books: {},
        host: { loadCharacterCard: () => ({ name: 'Char', data: {} }) },
    });
    const out = await runStscript(env, '/getcharbook create=on type=additional name=AuxBook Char.png');
    assert.deepEqual(JSON.parse(out.result), ['AuxBook']);
    const lore = wiSettings.charLore.find((l) => l.name === 'Char');
    assert.deepEqual(lore.extraBooks, ['AuxBook']);
});

// ---------------------------------------------------------------------------
// /findentry /getentryfield
// ---------------------------------------------------------------------------

const lorebook = bookWith([
    { uid: 0, key: ['sword'], keysecondary: [], comment: 'blade', content: 'A sharp blade', constant: false, order: 10, disable: false },
    { uid: 1, key: ['shield'], keysecondary: [], comment: 'defense', content: 'A round shield', constant: true, order: 20, disable: true },
]);

test('/findentry fuzzy-matches key and returns uid', async () => {
    const { env } = makeWiEnv({ books: { Lore: lorebook } });
    const out = await runStscript(env, '/findentry file=Lore sword');
    assert.equal(out.result, '0');
});

test('/findentry field=comment matches; boolean fields normalize on/off', async () => {
    const { env } = makeWiEnv({ books: { Lore: lorebook } });
    assert.equal((await runStscript(env, '/findentry file=Lore field=comment blade')).result, '0');
    assert.equal((await runStscript(env, '/findentry file=Lore field=disable on')).result, '1');
});

test('/findentry on missing book warns, returns empty', async () => {
    const { env, notifications } = makeWiEnv({ books: {} });
    const out = await runStscript(env, '/findentry file=Nope x');
    assert.equal(out.result, '');
    assert.ok(notifications.some((n) => /Valid World Info file/.test(n.text)));
});

test('/getentryfield returns scalar and JSON array values', async () => {
    const { env } = makeWiEnv({ books: { Lore: lorebook } });
    assert.equal((await runStscript(env, '/getentryfield file=Lore field=content 0')).result, 'A sharp blade');
    assert.deepEqual(JSON.parse((await runStscript(env, '/getentryfield file=Lore field=key 0')).result), ['sword']);
    assert.equal((await runStscript(env, '/getentryfield file=Lore field=constant 1')).result, 'true');
    assert.equal((await runStscript(env, '/getentryfield file=Lore field=order 0')).result, '10');
});

test('/getentryfield invalid uid/field warns', async () => {
    const { env, notifications } = makeWiEnv({ books: { Lore: lorebook } });
    await runStscript(env, '/getentryfield file=Lore 99');
    assert.ok(notifications.some((n) => /Valid UID/.test(n.text)));
    notifications.length = 0;
    await runStscript(env, '/getentryfield file=Lore field=bogus 0');
    assert.ok(notifications.some((n) => /Valid field name/.test(n.text)));
});

test('/getentryfield characterFilterNames/Tags resolve through listTags', async () => {
    const tagged = bookWith([
        { uid: 0, key: ['x'], content: 'c', characterFilter: { isExclude: false, names: ['Char'], tags: ['t1'] } },
    ]);
    const { env } = makeWiEnv({
        books: { Lore: tagged },
        settings: { tags: [{ id: 't1', name: 'TagOne' }] },
        host: { listTags: () => [{ id: 't1', name: 'TagOne' }] },
    });
    assert.deepEqual(JSON.parse((await runStscript(env, '/getentryfield file=Lore field=characterFilterNames 0')).result), ['Char']);
    assert.deepEqual(JSON.parse((await runStscript(env, '/getentryfield file=Lore field=characterFilterTags 0')).result), ['TagOne']);
    assert.equal((await runStscript(env, '/getentryfield file=Lore field=characterFilterExclude 0')).result, 'false');
});

// ---------------------------------------------------------------------------
// /createentry /setentryfield
// ---------------------------------------------------------------------------

test('/createentry adds a template entry, sets key/comment/memo, returns uid', async () => {
    const { env, books, savedBooks } = makeWiEnv({ books: { Lore: { entries: {} } } });
    const out = await runStscript(env, '/createentry file=Lore key=magic The magic system');
    const uid = Number(out.result);
    assert.equal(Number.isInteger(uid), true);
    const entry = books.Lore.entries[uid];
    assert.ok(entry);
    assert.deepEqual(entry.key, ['magic']);
    assert.equal(entry.content, 'The magic system');
    assert.equal(entry.comment, 'magic');
    assert.equal(entry.addMemo, true);
    assert.deepEqual(savedBooks, ['Lore']);
});

test('/setentryfield writes scalar/array/bool by definition type', async () => {
    const { env, books } = makeWiEnv({ books: { Lore: lorebook } });
    await runStscript(env, '/setentryfield file=Lore uid=0 field=content New content');
    assert.equal(books.Lore.entries[0].content, 'New content');
    await runStscript(env, '/setentryfield file=Lore uid=0 field=key a,b, c');
    assert.deepEqual(books.Lore.entries[0].key, ['a', 'b', 'c']);
    await runStscript(env, '/setentryfield file=Lore uid=0 field=constant on');
    assert.equal(books.Lore.entries[0].constant, true);
    await runStscript(env, '/setentryfield file=Lore uid=0 field=order 42');
    assert.equal(books.Lore.entries[0].order, 42);
});

test('/setentryfield characterFilter* maps names/tags and writes extensions', async () => {
    const data = bookWith([{ uid: 0, key: ['x'], content: 'c' }]);
    const { env, books } = makeWiEnv({
        books: { Lore: data },
        settings: { tags: [{ id: 't1', name: 'One' }, { id: 't2', name: 'Two' }] },
        host: {
            listTags: () => [{ id: 't1', name: 'One' }, { id: 't2', name: 'Two' }],
            resolveCharacter: (name) => (name === 'Alice' ? { name: 'Alice', avatar: 'Alice.png' } : null),
        },
    });
    await runStscript(env, '/setentryfield file=Lore uid=0 field=characterFilterNames Alice,Bob');
    assert.deepEqual(books.Lore.entries[0].characterFilter.names, ['Alice']);
    await runStscript(env, '/setentryfield file=Lore uid=0 field=characterFilterTags One,Two,Three');
    assert.deepEqual(books.Lore.entries[0].characterFilter.tags, ['t1', 't2']);
    await runStscript(env, '/setentryfield file=Lore uid=0 field=characterFilterExclude on');
    assert.equal(books.Lore.entries[0].characterFilter.isExclude, true);
});

test('/setentryfield unknown uid warns; missing value warns', async () => {
    const { env, notifications } = makeWiEnv({ books: { Lore: lorebook } });
    await runStscript(env, '/setentryfield file=Lore uid=42 field=content x');
    assert.ok(notifications.some((n) => /Valid UID/.test(n.text)));
});

// ---------------------------------------------------------------------------
// timed effects
// ---------------------------------------------------------------------------

test('/wi-set-timed-effect + /wi-get-timed-effect sticky roundtrip via metadata', async () => {
    const chatMetadata = {};
    const { env } = makeWiEnv({
        books: { Lore: bookWith([{ uid: 0, key: ['x'], content: 'c', sticky: 3, cooldown: 2 }]) },
        chatMetadata,
        chat: [{ mes: 'one' }, { mes: 'two' }],
    });
    const out = await runStscript(env, '/wi-set-timed-effect file=Lore uid=0 effect=sticky on');
    assert.equal(out.isError, false);
    assert.ok(chatMetadata.timedWorldInfo?.sticky, 'metadata written');
    assert.equal((await runStscript(env, '/wi-get-timed-effect file=Lore effect=sticky 0')).result, 'true');
    // format=number → 剩余条数
    const num = (await runStscript(env, '/wi-get-timed-effect file=Lore effect=sticky format=number 0')).result;
    assert.equal(Number.isNaN(Number(num)), false);
    // toggle off
    await runStscript(env, '/wi-set-timed-effect file=Lore uid=0 effect=sticky off');
    assert.equal((await runStscript(env, '/wi-get-timed-effect file=Lore effect=sticky 0')).result, 'false');
});

test('/wi-set-timed-effect on entry without the effect warns (editor-gate)', async () => {
    const { env, notifications } = makeWiEnv({
        books: { Lore: bookWith([{ uid: 0, key: ['x'], content: 'c' }]) },
        chat: [],
    });
    await runStscript(env, '/wi-set-timed-effect file=Lore uid=0 effect=sticky on');
    assert.ok(notifications.some((n) => /does not have the selected effect/.test(n.text)));
});

test('/wi-*-timed-effect require a chat context', async () => {
    const { env } = makeWiEnv({ books: { Lore: lorebook }, currentChatId: null });
    const out = await runStscript(env, '/wi-set-timed-effect file=Lore uid=0 effect=sticky on');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /only be used in chat/);
});

// ---------------------------------------------------------------------------
// 未绑 seam → 显式报错(不静默)
// ---------------------------------------------------------------------------

test('unbound createWorldBook seam errors explicitly on /getchatbook create', async () => {
    const env = createStscriptEnv({ chat: [], chatMetadata: {}, globalVariables: {}, currentChatId: 'c1' }, {
        listWorldBooks: () => [],
        notify: () => {},
    });
    const out = await runStscript(env, '/getchatbook name=X');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /createWorldBook/);
});

test('/getcharbook create= without setCharacterWorld errors explicitly', async () => {
    const { env } = makeWiEnv({
        books: {},
        host: { loadCharacterCard: () => ({ name: 'Char', data: {} }) },
    });
    const out = await runStscript(env, '/getcharbook create=on type=primary Char.png');
    assert.equal(out.isError, true);
    assert.match(out.error?.message ?? '', /setCharacterWorld/);
});
