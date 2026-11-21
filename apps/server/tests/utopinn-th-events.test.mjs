/**
 * TASK-049 TH 事件面测试(node:test,双段):
 *
 *  A. server 语义:/api/utopinn/th/call eventOn 家族 + eventEmit 信箱 +
 *     getEventLog 分页 —— 影子注册表落 chat_state `th.events` 实读。
 *  B. 宿主→卡真触发:cardapp-host.mjs(jsdom)挂 TH 测试卡,卡内
 *     TavernHelper.eventOn 注册的 listener 经 nonce 桥订阅记账 →
 *     宿主楼层 diff / 信箱泵真推送 → 断言卡 realm 命中。
 *     双 mount 验证 eventEmit 信箱的跨 mount 扇出 + origin 去重。
 *
 * 跑法:node --test tests/utopinn-th-events.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getChatRepo, initStorage } from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const HANDLE = 'u1';
const CHAR = 'EvtCard';
const CHAT = 'e1';

// 与 utopinn-library.test.mjs 同构(FsEngine 按 dirKey 寻址)
const USER_DIRS = Object.freeze({
    root: '', thumbnails: 'thumbnails', thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar', thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds', user: 'user', avatars: 'User Avatars', userImages: 'user/images',
    groups: 'groups', groupChats: 'group chats', chats: 'chats', characters: 'characters',
    backgrounds: 'backgrounds', novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings', openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings', themes: 'themes', movingUI: 'movingUI',
    extensions: 'extensions', instruct: 'instruct', context: 'context',
    quickreplies: 'QuickReplies', assets: 'assets', comfyWorkflows: 'user/workflows',
    files: 'user/files', vectors: 'vectors', backups: 'backups', sysprompt: 'sysprompt',
    reasoning: 'reasoning', cardApps: 'card-apps',
});

let ROOT, dirs, server, BASE;

async function api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const call = (method, args = {}, target = { charDir: CHAR, chatName: CHAT }) =>
    api('/api/utopinn/th/call', { method: 'POST', body: { method, args, target } });
const shadow = () => getChatRepo().getState(HANDLE, CHAR, CHAT, 'th.events');

const TEST_CARD_HTML = `<!doctype html><html><body><div id="app">evt probe</div>
<script>
window.__hits = {};
function hit(n, a){ (window.__hits[n] = window.__hits[n] || []).push(a === undefined ? null : a); }
TavernHelper.eventOn('message_received', function(mid){ hit('message_received', mid); });
TavernHelper.eventOn('message_edited', function(mid){ hit('message_edited', mid); });
TavernHelper.eventOn('chat_changed', function(c){ hit('chat_changed', c); });
TavernHelper.eventOn('custom_ping', function(v){ hit('custom_ping', v); });
TavernHelper.eventOnce('ping_once', function(v){ hit('ping_once', v); });
</script></body></html>`;

async function waitFor(cond, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const v = await cond();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 50));
    }
    return null;
}

test.before(async () => {
    if (!getConfigFilePath()) setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-th-events-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) dirs[key] = path.join(ROOT, rel);
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    // 种子:角色 JSON + 会话(2 楼)
    fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`),
        JSON.stringify({ name: CHAR, data: { name: CHAR } }));
    await getChatRepo().save(HANDLE, CHAR, CHAT,
        { user_name: 'User', character_name: CHAR, create_date: 1, chat_metadata: { variables: {} } },
        [
            { name: 'User', is_user: true, send_date: 2, mes: 'ping' },
            { name: CHAR, is_user: false, send_date: 3, mes: 'pong' },
        ], null);

    const { apply: applyTh } = await import('../src/plugins/utopinn-th.js');
    const { apply: applyLibrary } = await import('../src/plugins/utopinn-library.js');
    const router = express.Router();
    const ws = {
        register: (spec) => {
            router[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    applyTh({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });
    applyLibrary({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
        next();
    });
    // UtopinnClient.autoSession:每个请求前 GET /csrf-token(否则全链 HTTP 404)
    app.get('/csrf-token', (_req, res) => res.send({ token: 'test-csrf' }));
    app.use(router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── A. server 事件面 ────────────────────────────────────────────────────

test('eventOn 注册影子 → chat_state th.events 持久化', async () => {
    let r = await call('eventOn', { event: 'message_received', listener_id: 't-l1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.listener_id, 't-l1');
    const doc = await shadow();
    assert.equal(doc.listeners.length, 1);
    assert.deepEqual(
        { id: doc.listeners[0].id, event: doc.listeners[0].event, priority: doc.listeners[0].priority, once: doc.listeners[0].once },
        { id: 't-l1', event: 'message_received', priority: 'normal', once: false });

    // 同 lid 再注册 = upsert(不重条)
    r = await call('eventOn', { event: 'chat_changed', listener_id: 't-l1' });
    assert.equal(r.status, 200);
    assert.equal((await shadow()).listeners.length, 1);
});

test('eventOnce 记 once 位;eventEmit 计数并消费 once 影子', async () => {
    await call('eventClearAll', {});
    let r = await call('eventOnce', { event: 'gen', listener_id: 'o1' });
    assert.equal(r.body.result.listener_id, 'o1');
    await call('eventOn', { event: 'gen', listener_id: 'o2' });
    assert.equal((await shadow()).listeners.length, 2);

    r = await call('eventEmit', { event: 'gen', args: [42], origin: 'test' });
    assert.equal(r.body.result.delivered, 2);
    assert.equal(r.body.result.seq, 1);
    // once 已消费,普通影子仍在
    const doc = await shadow();
    assert.equal(doc.listeners.length, 1);
    assert.equal(doc.listeners[0].id, 'o2');
    assert.equal(doc.log.length, 1);
    assert.equal(doc.log[0].event, 'gen');
    assert.deepEqual(doc.log[0].args, [42]);
    assert.equal(doc.log[0].origin, 'test');
});

test('eventMakeFirst/eventMakeLast 重排影子序与 priority', async () => {
    await call('eventClearAll', {});
    await call('eventOn', { event: 'e', listener_id: 'm1' });
    await call('eventOn', { event: 'e', listener_id: 'm2' });
    await call('eventOn', { event: 'e', listener_id: 'm3' });

    let r = await call('eventMakeLast', { listener_id: 'm1' });
    assert.equal(r.body.result.moved, true);
    let doc = await shadow();
    assert.deepEqual(doc.listeners.map((l) => l.id), ['m2', 'm3', 'm1']);
    assert.equal(doc.listeners[2].priority, 'last');

    r = await call('eventMakeFirst', { listener_id: 'm3' });
    assert.equal(r.body.result.moved, true);
    doc = await shadow();
    assert.deepEqual(doc.listeners.map((l) => l.id), ['m3', 'm2', 'm1']);
    assert.equal(doc.listeners[0].priority, 'first');

    // 新 normal 插到 last 组之前
    await call('eventOn', { event: 'e', listener_id: 'm4' });
    assert.deepEqual((await shadow()).listeners.map((l) => l.id), ['m3', 'm2', 'm4', 'm1']);

    // 不存在的 listener → moved:false(幂等,不报错)
    r = await call('eventMakeLast', { listener_id: 'nope' });
    assert.equal(r.body.result.moved, false);
});

test('getEventLog since 分页;eventRemoveListener/eventClear* 面', async () => {
    await call('eventClearAll', {});
    await call('eventOn', { event: 'a', listener_id: 'x1' });
    await call('eventOn', { event: 'b', listener_id: 'x2' });
    await call('eventOn', { event: 'a', listener_id: 'x3' });

    // removeListener by lid
    let r = await call('eventRemoveListener', { listener_id: 'x1' });
    assert.equal(r.body.result.removed, 1);
    assert.equal((await shadow()).listeners.length, 2);

    // clearEvent 按事件名清
    r = await call('eventClearEvent', { event: 'a' });
    assert.equal(r.body.result.removed, 1);
    assert.deepEqual((await shadow()).listeners.map((l) => l.id), ['x2']);

    // clearListener(listener_ids) 跨 lid 摘:再加一个 lid,一次摘俩
    await call('eventOn', { event: 'c', listener_id: 'x4' });
    r = await call('eventClearListener', { listener_ids: ['x2', 'x4'] });
    assert.equal(r.body.result.removed, 2);
    assert.equal((await shadow()).listeners.length, 0);

    // clearAll 清场
    await call('eventOn', { event: 'a', listener_id: 'y1' });
    r = await call('eventClearAll', {});
    assert.equal(r.body.result.removed, 1);

    // 信箱:三条 emit,since 分页
    const s0 = (await call('getEventLog', {})).body.result.seq;
    await call('eventEmit', { event: 'k1', args: [1], origin: 'pumpA' });
    await call('eventEmit', { event: 'k2', args: [2], origin: 'pumpB' });
    await call('eventEmit', { event: 'k3', args: [3], origin: 'pumpA' });
    r = await call('getEventLog', { since: s0 });
    assert.equal(r.body.result.entries.length, 3);
    assert.deepEqual(r.body.result.entries.map((e) => e.event), ['k1', 'k2', 'k3']);
    assert.equal(r.body.result.entries[1].origin, 'pumpB');
    r = await call('getEventLog', { since: s0 + 2 });
    assert.equal(r.body.result.entries.length, 1);
    assert.equal(r.body.result.entries[0].event, 'k3');
});

test('会话态(无 chat 目标)注册/emit/getEventLog 走内存面', async () => {
    const noTarget = { charDir: CHAR, chatName: null };
    let r = await api('/api/utopinn/th/call', {
        method: 'POST',
        body: { method: 'eventOn', args: { event: 'sess', listener_id: 's1' }, target: {} },
    });
    assert.equal(r.status, 200);
    r = await api('/api/utopinn/th/call', {
        method: 'POST',
        body: { method: 'eventEmit', args: { event: 'sess', args: [7] }, target: {} },
    });
    assert.equal(r.body.result.delivered, 1);
    r = await api('/api/utopinn/th/call', {
        method: 'POST', body: { method: 'getEventLog', args: {}, target: noTarget },
    });
    assert.equal(r.body.result.entries.length, 1);
    assert.equal(r.body.result.entries[0].event, 'sess');
    await api('/api/utopinn/th/call', { method: 'POST', body: { method: 'eventClearAll', args: {}, target: {} } });
});

test('缺席 chat → 404;缺 event 名 → 400;未知方法 → unsupported', async () => {
    let r = await call('eventOn', { event: 'x' }, { charDir: CHAR, chatName: 'ghost-chat' });
    assert.equal(r.status, 404);
    r = await call('eventEmit', {}, { charDir: CHAR, chatName: CHAT });
    assert.equal(r.status, 400);
    r = await call('someUnknownMethod', {}, { charDir: CHAR, chatName: CHAT });
    assert.equal(r.body.unsupported, true);
});

// ── B. 宿主→卡真事件(headless mount;jsdom 缺席则跳过) ──────────────────

test('TH 测试卡 eventOn 收真事件:楼层 diff + 信箱跨 mount 扇出', async (t) => {
    let mountCardApp;
    try {
        ({ mountCardApp } = await import('../../cli/cardapp-host.mjs'));
        await import('jsdom');
    } catch (e) {
        t.skip(`headless harness 不可用: ${e?.message ?? e}`);
        return;
    }
    // TH 面测试卡(document 入口 → t0 shim → TavernHelper 全局)
    const cardPath = path.join(ROOT, 'evt-card.json');
    fs.writeFileSync(cardPath, JSON.stringify({
        name: CHAR,
        data: {
            name: CHAR,
            extensions: {
                card_app: {
                    enabled: true,
                    entry: 'index.html',
                    files: { 'index.html': TEST_CARD_HTML },
                },
            },
        },
    }));
    const mk = () => mountCardApp({ server: BASE, charDir: CHAR, chatName: CHAT, card: cardPath, settleMs: 600 });
    const sA = await mk();
    const sB = await mk();
    try {
        assert.equal(sA.face, 'th');
        // 卡内 eventOn 经桥 → panelT0 订阅记账(双 mount 各自)
        assert.ok(await waitFor(() => sA.subscribedEvents().includes('message_received') && sA.subscribedEvents().includes('custom_ping')),
            `A subscriptions: ${JSON.stringify(sA.subscribedEvents())}`);
        assert.ok(await waitFor(() => sB.subscribedEvents().includes('custom_ping')),
            `B subscriptions: ${JSON.stringify(sB.subscribedEvents())}`);
        // 影子注册表:卡侧 eventOn 经 shadow() 写进 chat_state
        const shadowOk = await waitFor(async () => ((await shadow())?.listeners?.length ?? 0) >= 3);
        assert.ok(shadowOk,
            'server shadow receives card registrations; shadow-debug='
            + JSON.stringify(sA.consoleLog?.filter((l) => l.lvl === 'shadow')));

        // jsdom realm 数组原型 ≠ Node —— 归一成同 realm 再 deepEqual
        const hitsA = (n) => Array.from(sA.window.__hits?.[n] ?? []);
        const hitsB = (n) => Array.from(sB.window.__hits?.[n] ?? []);

        // ① 楼层追加 → message_received 真触发(diffAndEmitChat 全链路)
        await getChatRepo().append(HANDLE, CHAR, CHAT, [
            { name: CHAR, is_user: false, send_date: 4, mes: 'floor-3' },
        ]);
        const r1 = await sA.syncChat();
        sA.diffAndEmitChat(r1.prev, r1.next);
        await new Promise((r) => setTimeout(r, 60));
        assert.deepEqual(hitsA('message_received'), [2], `A hits: ${JSON.stringify(sA.window.__hits)}`);
        assert.equal(hitsA('chat_changed').length, 1, 'chat_changed 兜底');

        // ② 同长楼层编辑 → message_edited(repo patch /body/2/mes)
        await getChatRepo().patch(HANDLE, CHAR, CHAT,
            [{ op: 'replace', path: '/body/2/mes', value: 'floor-3-edit' }]);
        const r2 = await sA.syncChat();
        sA.diffAndEmitChat(r2.prev, r2.next);
        await new Promise((r) => setTimeout(r, 60));
        assert.deepEqual(hitsA('message_edited'), [2], '同长 mes 编辑真触发');
        assert.equal(hitsA('chat_changed').length, 2, '编辑也出 chat_changed');

        // ③ 卡 eventEmit → 本卡本地派发 + 信箱扇出到 B(不同 mount)
        await sA.evalInCard(`TavernHelper.eventEmit('custom_ping', 'v1')`);
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(hitsA('custom_ping').length, 1, '本卡 dispatchLocal 命中');
        await sB.syncChat();   // B 泵信箱(syncChat 尾部 pollMailbox)
        await new Promise((r) => setTimeout(r, 60));
        assert.deepEqual(hitsB('custom_ping'), ['v1'], 'B 跨 mount 收到 emit');
        // A 再泵:自己的条目 origin 去重,不双发
        await sA.syncChat();
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(hitsA('custom_ping').length, 1, 'A 不回流');

        // ④ eventOnce:同一 emit 两次 → 只中一次(本卡注册在 mount 时)
        await sA.evalInCard(`TavernHelper.eventEmit('ping_once')`);
        await sA.evalInCard(`TavernHelper.eventEmit('ping_once')`);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(hitsA('ping_once').length, 1, 'once 只中一次');

        // ⑤ eventClearEvent:清订阅后追加楼层 → 不再命中 + 过滤面同步
        await sA.evalInCard(`TavernHelper.eventClearEvent('message_received')`);
        await new Promise((r) => setTimeout(r, 150));
        assert.ok(!sA.subscribedEvents().includes('message_received'),
            `clear 后过滤面: ${JSON.stringify(sA.subscribedEvents())}`);
        await getChatRepo().append(HANDLE, CHAR, CHAT, [
            { name: CHAR, is_user: false, send_date: 5, mes: 'floor-4' },
        ]);
        const r3 = await sA.syncChat();
        sA.diffAndEmitChat(r3.prev, r3.next);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(hitsA('message_received').length, 1, 'clear 后不再命中');

        // ⑥ mount 作用域清:A 的影子条目摘了,B 的还在(lid 集级清,不误伤)
        const scopeOk = await waitFor(async () => {
            const d = await shadow();
            return d && d.listeners.filter((l) => l.event === 'message_received').length === 1;
        });
        assert.ok(scopeOk, 'A 影子清了、B 的还在(剩 1 条 message_received 注册)');
        // B 仍在听:再追加楼层 → B 命中 message_received,A 没有
        await getChatRepo().append(HANDLE, CHAR, CHAT, [
            { name: CHAR, is_user: false, send_date: 6, mes: 'floor-5' },
        ]);
        const rb = await sB.syncChat();
        sB.diffAndEmitChat(rb.prev, rb.next);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(hitsB('message_received').length, 2,
            `B 应补齐 idx3-4 两条(③已同步过 3 楼);实际 ${JSON.stringify(sB.window.__hits)}`);
    } finally {
        await sA.dispose().catch(() => { });
        await sB.dispose().catch(() => { });
    }
});
