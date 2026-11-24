// T0 host dispatcher tests — mock fetch, verify scope mapping + call shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { UtopinnClient, createPanelT0Handler } = await import(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js'));

const CHAT = {
    header: { chat_metadata: { variables: { hp: 10, inv: ['sword'] } } },
    body: [
        { name: 'User', is_user: true, mes: 'hi', data: {} },
        { name: 'Char', is_user: false, mes: 'hello', data: { mood: 'calm' } },
        { name: 'Char', is_user: false, mes: 'again', is_hidden: true, data: {}, swipes: ['a', 'b'], swipe_id: 1 },
    ],
};

function mockFetch(routes) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ path: u.pathname, method: init.method ?? 'GET', body });
        const handler = routes[u.pathname];
        const result = handler ? await handler(body) : {};
        return new Response(JSON.stringify(result ?? {}), { status: 200 });
    };
    fn.calls = calls;
    return fn;
}

function makeDeps(routes, extra = {}) {
    const f = mockFetch(routes);
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    const handle = createPanelT0Handler({
        client, avatarUrl: 'c.png', chatFileName: 'chat', mountMessageId: 0,
        initializedGlobals: new Set(['Mvu']), ...extra,
    });
    return { handle, calls: f.calls };
}

const chatRoute = { '/api/chats/get': () => CHAT };

test('chat scope: getVariables reads chat_metadata.variables', async () => {
    const { handle } = makeDeps(chatRoute);
    assert.deepEqual(await handle('th.getVariables', { type: 'chat' }), { hp: 10, inv: ['sword'] });
});

test('chat scope: insertOrAssign merges, writes via meta/patch /variables', async () => {
    const { handle, calls } = makeDeps({ ...chatRoute, '/api/chats/meta/patch': (b) => ({ patched: b.operations }) });
    await handle('th.insertOrAssignVariables', { type: 'chat', variables: { hp: 20, mp: 5 } });
    const op = calls.find(c => c.path === '/api/chats/meta/patch').body.operations[0];
    assert.equal(op.path, '/variables');
    assert.deepEqual(op.value, { hp: 20, inv: ['sword'], mp: 5 });
});

test('insertVariables keeps existing values', async () => {
    const { handle, calls } = makeDeps({ ...chatRoute, '/api/chats/meta/patch': () => ({}) });
    await handle('th.insertVariables', { type: 'chat', variables: { hp: 99, mp: 5 } });
    const op = calls.find(c => c.path === '/api/chats/meta/patch').body.operations[0];
    assert.deepEqual(op.value, { hp: 10, inv: ['sword'], mp: 5 });
});

test('global scope: reads+writes extension_settings.variables.global(服务端落点,信封须解)', async () => {
    const { handle, calls } = makeDeps({
        // buildSettingsResponse 真实信封:{settings:'<json string>'} ——
        // 旧实现拿信封当文档找 th_global_variables 根键,读写全落空。
        '/api/settings/get': () => ({ settings: JSON.stringify({ extension_settings: { variables: { global: { g: 1 } } } }) }),
        '/api/settings/patch': () => ({}),
    });
    assert.deepEqual(await handle('th.getVariables', { type: 'global' }), { g: 1 });
    await handle('th.replaceVariables', { type: 'global', variables: { g: 2 } });
    const ops = calls.find(c => c.path === '/api/settings/patch').body.operations;
    const leaf = ops.at(-1);
    assert.equal(leaf.path, '/extension_settings/variables/global');
    assert.equal(leaf.op, 'add');
    assert.deepEqual(leaf.value, { g: 2 });
});

test('global scope: 父段缺席时逐级立(extension_settings/variables)', async () => {
    const { handle, calls } = makeDeps({
        '/api/settings/get': () => ({ settings: JSON.stringify({ power_user: {} }) }),
        '/api/settings/patch': () => ({}),
    });
    await handle('th.insertOrAssignVariables', { type: 'global', variables: { g: 1 } });
    const paths = calls.find(c => c.path === '/api/settings/patch').body.operations.map(o => o.path);
    assert.deepEqual(paths, ['/extension_settings', '/extension_settings/variables', '/extension_settings/variables/global']);
});

test('message scope: reads body[i].data; negative index from last', async () => {
    const { handle } = makeDeps(chatRoute);
    assert.deepEqual(await handle('th.getVariables', { type: 'message', message_id: 1 }), { mood: 'calm' });
    assert.deepEqual(await handle('th.getVariables', { type: 'message', message_id: -2 }), { mood: 'calm' });
});

test('script scope: chat_state ns thvars.<id>', async () => {
    const { handle, calls } = makeDeps({
        '/api/chats/state/get': (b) => (b.namespace === 'thvars.s1' ? { x: 1 } : null),
        '/api/chats/state/patch': () => ({}),
    });
    assert.deepEqual(await handle('th.getVariables', { type: 'script', script_id: 's1' }), { x: 1 });
    await handle('th.replaceVariables', { type: 'script', script_id: 's1', variables: { x: 2 } });
    const c = calls.find(c => c.path === '/api/chats/state/patch').body;
    assert.equal(c.namespace, 'thvars.s1');
    assert.deepEqual(c.operations[0].value, { x: 2 });
});

test('deleteVariable removes dot-path from scope store', async () => {
    const { handle, calls } = makeDeps({ ...chatRoute, '/api/chats/meta/patch': () => ({}) });
    await handle('th.deleteVariable', { type: 'chat', path: 'hp' });
    const op = calls.find(c => c.path === '/api/chats/meta/patch').body.operations[0];
    assert.deepEqual(op.value, { inv: ['sword'] });
});

test('insertOrAssign 深合嵌套对象;数组整替(TH mergeWith 语义)', async () => {
    const { handle, calls } = makeDeps({
        '/api/chats/get': () => ({
            header: { chat_metadata: { variables: { sd: { a: { x: 1, y: 9 } }, arr: [1, 2, 3] } } },
            body: [],
        }),
        '/api/chats/meta/patch': () => ({}),
    });
    await handle('th.insertOrAssignVariables', {
        type: 'chat',
        variables: { sd: { a: { x: 2 } }, arr: [9], keep: 'yes' },
    });
    const op = calls.find(c => c.path === '/api/chats/meta/patch').body.operations[0];
    assert.deepEqual(op.value, { sd: { a: { x: 2, y: 9 } }, arr: [9], keep: 'yes' });
});

test('insertVariables defaultsDeep:深补缺不覆既有(TH)', async () => {
    const { handle, calls } = makeDeps({
        '/api/chats/get': () => ({
            header: { chat_metadata: { variables: { sd: { a: { x: 1, y: 9 } } } } },
            body: [],
        }),
        '/api/chats/meta/patch': () => ({}),
    });
    await handle('th.insertVariables', {
        type: 'chat',
        variables: { sd: { a: { x: 99, z: 5 }, b: 1 }, top: 'new' },
    });
    const op = calls.find(c => c.path === '/api/chats/meta/patch').body.operations[0];
    assert.deepEqual(op.value, { sd: { a: { x: 1, y: 9, z: 5 }, b: 1 }, top: 'new' });
});

test('replaceVariables 丢根护栏:root_loss 拒绝不写盘;force:true 放行(GH#4)', async () => {
    const { handle, calls } = makeDeps({ ...chatRoute, '/api/chats/meta/patch': () => ({}) });
    // CHAT 种子变量 {hp, inv} —— 替换成 {hp:99} 会丢 inv 根 → 拒绝
    await assert.rejects(
        () => handle('th.replaceVariables', { type: 'chat', variables: { hp: 99 } }),
        /root_loss/);
    assert.ok(!calls.find(c => c.path === '/api/chats/meta/patch'), '拒绝时未写盘');
    // force:true 显式确认 → 照写
    await handle('th.replaceVariables', { type: 'chat', force: true, variables: { hp: 99 } });
    const op = calls.find(c => c.path === '/api/chats/meta/patch').body.operations[0];
    assert.deepEqual(op.value, { hp: 99 });
});

test('getChatMessages: TH view shape + role/hide filters + range', async () => {
    const { handle } = makeDeps(chatRoute);
    const all = await handle('th.getChatMessages', { range: 'all' });
    assert.equal(all.length, 3);
    assert.equal(all[1].role, 'assistant');
    assert.equal(all[1].data.mood, 'calm');
    const unhidden = await handle('th.getChatMessages', { range: 'all', hide_state: 'unhidden' });
    assert.equal(unhidden.length, 2);
    const lastOne = await handle('th.getChatMessages', { range: '-1', include_swipes: true });
    assert.equal(lastOne.length, 1);
    assert.deepEqual(lastOne[0].swipes, ['a', 'b']);
    assert.equal(await handle('th.getLastMessageId', {}), 2);
    assert.equal(await handle('th.getCurrentMessageId', {}), 0);
});

test('injectPrompts round-trips through chat_state th.inject; uninject removes by id', async () => {
    let store = { prompts: [] };
    const { handle } = makeDeps({
        '/api/chats/state/get': (b) => (b.namespace === 'th.inject' ? store : null),
        '/api/chats/state/patch': (b) => { if (b.namespace === 'th.inject') store = b.operations[0].value; return {}; },
    });
    await handle('th.injectPrompts', { prompts: [{ id: 'p1', position: 'in_chat', depth: 1, content: 'X', should_scan: true }] });
    await handle('th.injectPrompts', { prompts: [{ id: 'p2', position: 'none', content: 'Y' }] });
    assert.deepEqual(store.prompts.map(p => p.id), ['p1', 'p2']);
    await handle('th.uninjectPrompts', { ids: ['p1'] });
    assert.deepEqual(store.prompts.map(p => p.id), ['p2']);
});

test('events: eventOn records subscription; eventEmit fans out via emitToPanels', async () => {
    const emitted = [];
    const { handle } = makeDeps(chatRoute, { emitToPanels: (e, a) => emitted.push([e, a]) });
    await handle('th.eventOn', { event: 'message_received' });
    assert.deepEqual(handle.subscribedEvents(), ['message_received']);
    await handle('th.eventEmit', { event: 'ping', args: [1] });
    assert.deepEqual(emitted, [['ping', [1]]]);
});

test('events: shadow forward writes server th/call; clear ops keep filter truthful', async () => {
    const thCalls = [];
    const { handle, calls } = makeDeps({
        ...chatRoute,
        '/api/utopinn/th/call': (b) => { thCalls.push(b); return { ok: true, result: {} }; },
    });
    // eventOn(带 lid)→ 订阅 + 影子转发
    await handle('th.eventOn', { event: 'e1', listener_id: 'l1.x' });
    await handle('th.eventOn', { event: 'e1', listener_id: 'l2.x' });
    await handle('th.eventOn', { event: 'e2', listener_id: 'l1.y' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(thCalls.filter((c) => c.method === 'eventOn').length, 3);
    assert.equal(thCalls[0].args.listener_id, 'l1.x');
    assert.deepEqual(handle.subscribedEvents().sort(), ['e1', 'e2']);

    // eventClearListener(lids)→ e1 余 l2.x 仍订阅;e2 摘掉
    await handle('th.eventClearListener', { listener_ids: ['l1.x', 'l1.y'] });
    assert.deepEqual(handle.subscribedEvents(), ['e1']);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(thCalls.at(-1).method, 'eventClearListener');
    assert.deepEqual(thCalls.at(-1).args.listener_ids, ['l1.x', 'l1.y']);

    // eventClearEvent → 带本 mount lids 的影子写,不殃及其它 mount
    await handle('th.eventClearEvent', { event: 'e1' });
    assert.deepEqual(handle.subscribedEvents(), []);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(thCalls.at(-1).args.listener_ids, ['l2.x']);

    // eventClearAll → 全清(带全量 lids)
    await handle('th.eventOn', { event: 'z', listener_id: 'lz' });
    await handle('th.eventClearAll', {});
    assert.deepEqual(handle.subscribedEvents(), []);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(thCalls.at(-1).method, 'eventClearAll');
    assert.deepEqual(thCalls.at(-1).args.listener_ids, ['lz']);

    // eventRemoveListener by lid
    await handle('th.eventOn', { event: 'w', listener_id: 'lw' });
    await handle('th.eventRemoveListener', { event: 'w', listener_id: 'lw' });
    assert.deepEqual(handle.subscribedEvents(), []);
    void calls;
});

test('events: eventMakeFirst/eventMakeLast 转发影子(过滤面不变)', async () => {
    const thCalls = [];
    const { handle } = makeDeps({
        ...chatRoute,
        '/api/utopinn/th/call': (b) => { thCalls.push(b); return { ok: true }; },
    });
    await handle('th.eventOn', { event: 'e', listener_id: 'la' });
    await handle('th.eventMakeFirst', { event: 'e', listener_id: 'la' });
    await handle('th.eventMakeLast', { event: 'e', listener_id: 'la' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(thCalls[1].method, 'eventMakeFirst');
    assert.equal(thCalls[2].method, 'eventMakeLast');
    assert.deepEqual(handle.subscribedEvents(), ['e']);
});

test('waitGlobalInitialized consults initializedGlobals; character name strips .png', async () => {
    const { handle } = makeDeps(chatRoute);
    assert.equal(await handle('th.waitGlobalInitialized', { name: 'Mvu' }), true);
    assert.equal(await handle('th.waitGlobalInitialized', { name: 'Nope' }), false);
    assert.equal(await handle('th.getCurrentCharacterName', {}), 'c');
});
