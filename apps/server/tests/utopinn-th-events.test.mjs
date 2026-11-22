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
import { getChatRepo, getPresetRepo, getWorldInfoRepo, initStorage } from '../src/storage/index.js';
import { query as diagQuery } from '../src/services/diag-bus.js';
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
    fs.mkdirSync(dirs.worlds, { recursive: true });
    fs.mkdirSync(dirs.cardApps, { recursive: true });
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
    const { cardRuntimeApiRouter, cardRuntimePublicRouter } = await import('../src/card-runtime/index.js');
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
    app.use('/api/card-runtime', cardRuntimeApiRouter);
    app.use('/card-runtime', cardRuntimePublicRouter);
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

// ── C. GH#4 变量写面:replaceVariables 护栏 + insertOrAssign 深合 ──────

test('insertOrAssignVariables:TH 深合(嵌套合、数组整替、带点键路径写)', async () => {
    // 种子根
    let r = await call('insertOrAssignVariables', {
        variables: {
            stat_data: { '背包': { '金币': 100, '卷轴': ['火把', '绳子'] }, '状态': { hp: 80 } },
            display_data: { hp: 80 },
        },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // 嵌套对象深合:只动金币,兄弟键/其它根不动
    r = await call('insertOrAssignVariables', { variables: { stat_data: { '背包': { '金币': 150 } } } });
    assert.equal(r.status, 200);
    let vars = (await call('getVariables', {})).body.result;
    assert.equal(vars.stat_data['背包']['金币'], 150);
    assert.deepEqual(vars.stat_data['背包']['卷轴'], ['火把', '绳子'], '深合不动兄弟键');
    assert.equal(vars.stat_data['状态'].hp, 80, '深合不动其它根');
    assert.equal(vars.display_data.hp, 80);
    // 数组整体替换(TH mergeWith:不逐位合)
    await call('insertOrAssignVariables', { variables: { stat_data: { '背包': { '卷轴': ['药草'] } } } });
    vars = (await call('getVariables', {})).body.result;
    assert.deepEqual(vars.stat_data['背包']['卷轴'], ['药草'], '数组整替');
    // 带点键 = 路径写(生态扩展,兼容 /setvar 形)
    await call('insertOrAssignVariables', { variables: { 'stat_data.背包.金币': 300 } });
    vars = (await call('getVariables', {})).body.result;
    assert.equal(vars.stat_data['背包']['金币'], 300);
    // 非法形
    r = await call('insertOrAssignVariables', { variables: ['x'] });
    assert.equal(r.status, 400);
    r = await call('insertOrAssignVariables', { variables: 'x' });
    assert.equal(r.status, 400);
});

test('insertVariables 只补缺(defaultsDeep);updateVariablesWith 全量回写(TH)', async () => {
    // insertVariables:既有键不动,缺失键补
    let r = await call('insertVariables', {
        variables: { stat_data: { '背包': { '金币': 999, '新物': 7 } }, extra_root: 1 },
    });
    assert.equal(r.status, 200);
    let vars = (await call('getVariables', {})).body.result;
    assert.equal(vars.stat_data['背包']['金币'], 300, '既有键不被覆盖');
    assert.equal(vars.stat_data['背包']['新物'], 7, '缺失键补入');
    assert.equal(vars.extra_root, 1, '新根补入');
    // updateVariablesWith:TH 本体 = replaceVariables(result)——shim 卡侧跑
    // updater(收全量→回全量),server 全量替换写回(非 merge)。
    const cur = (await call('getVariables', {})).body.result;
    cur.stat_data['状态'].hp = 55;
    r = await call('updateVariablesWith', { result: cur });
    assert.equal(r.status, 200);
    vars = (await call('getVariables', {})).body.result;
    assert.equal(vars.stat_data['状态'].hp, 55);
    assert.equal(vars.stat_data['背包']['金币'], 300, '全文档回写不动兄弟根');
});

test('replaceVariables:丢根无 force → 400+明细且不写盘;force 照写+warnings(GH#4)', async () => {
    let vars = (await call('getVariables', {})).body.result;
    assert.ok(vars.stat_data && vars.display_data, '种子根在');
    // 残缺对象全替 → 400,丢根名单可见,既有根不毁
    let r = await call('replaceVariables', { variables: { stat_data: { '背包': { '金币': 1 } } } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'root_loss');
    assert.deepEqual(r.body.lost_roots, ['display_data', 'extra_root']);
    assert.ok(typeof r.body.hint === 'string');
    vars = (await call('getVariables', {})).body.result;
    assert.ok(vars.display_data && vars.extra_root, '拒绝后既有根未毁');
    assert.equal(vars.stat_data['状态'].hp, 55);
    // stat_data 内根将丢也被拦
    r = await call('replaceVariables', {
        variables: { stat_data: { '背包': {} }, display_data: {}, extra_root: 1 },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.lost_stat_data_roots, ['状态']);
    vars = (await call('getVariables', {})).body.result;
    assert.ok(vars.stat_data['状态'], 'stat_data.状态 未被毁');
    // force:true 显式确认 → 照写 + warnings 留痕
    r = await call('replaceVariables', {
        force: true,
        variables: { stat_data: { '背包': { '金币': 1 } }, display_data: {}, extra_root: 1 },
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.warnings) && r.body.warnings.length >= 1, '丢根警告回执');
    vars = (await call('getVariables', {})).body.result;
    assert.deepEqual(vars, { stat_data: { '背包': { '金币': 1 } }, display_data: {}, extra_root: 1 });
    // 无丢根的合规全替 → 200 无 warnings
    r = await call('replaceVariables', {
        variables: { stat_data: { '背包': { '金币': 2 } }, display_data: {}, extra_root: 1 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.warnings, undefined);
    // 非法形
    r = await call('replaceVariables', { variables: 42 });
    assert.equal(r.status, 400);
    r = await call('replaceVariables', { variables: null });
    assert.equal(r.status, 400);
});

test('GH#4 validateStatDataAgainstSchema:非变异 + 逐路径错', async () => {
    // 纯函数面:逐路径 + 输入不毁(generateSchema 会就地消费 $meta,
    // 校验面必须只读——这里钉死非变异契约)
    const { validateStatDataAgainstSchema } = await import('@utopinn/core');
    const schema = {
        type: 'object', extensible: false,
        properties: {
            hp: { type: 'number', required: true },
            inv: { type: 'array', elementType: { type: 'object', extensible: true, properties: { name: { type: 'string' } } } },
        },
    };
    const data = { hp: 'x', inv: [{ name: 'sword', qty: 1 }, { name: 2 }], stray: 1, $meta: { extensible: true } };
    const before = JSON.stringify(data);
    const errs = validateStatDataAgainstSchema(data, schema);
    assert.equal(JSON.stringify(data), before, '校验不得改动被校验数据');
    const paths = errs.map((e) => e.path);
    assert.ok(paths.includes('hp'), `hp type_mismatch: ${JSON.stringify(errs)}`);
    assert.ok(paths.includes('inv[1].name'), `inv[1].name type_mismatch: ${JSON.stringify(errs)}`);
    assert.ok(paths.includes('stray'), `stray unexpected_key: ${JSON.stringify(errs)}`);
    assert.ok(!paths.includes('$meta'), '$meta 元数据位不进校验');
    assert.ok(!paths.includes('inv[0].qty'), 'extensible 子对象额外键放行');
    // required 缺位 → missing_required
    const errs2 = validateStatDataAgainstSchema({ inv: [] }, schema);
    assert.ok(errs2.some((e) => e.path === 'hp' && e.code === 'missing_required'), JSON.stringify(errs2));
    // VWD 二元组:[值,"描述"] 只校验值位,描述串不算类型错
    const s3 = { type: 'object', extensible: true, properties: { hp: { type: 'array', elementType: { type: 'number' } } } };
    assert.equal(validateStatDataAgainstSchema({ hp: [10, '血量'] }, s3).length, 0, 'VWD 描述位不校验');
    assert.ok(validateStatDataAgainstSchema({ hp: ['x', '血量'] }, s3).some((e) => e.path === 'hp[0]'), 'VWD 值位仍校验');
});

test('GH#4 schema 校验:replaceMvuData/replaceVariables 违规 → 400 逐路径 + 一字不落盘', async () => {
    let r = await call('createChatMessages', {
        chat_messages: [{ role: 'assistant', message: 'mvu-schema-floor' }],
    });
    assert.equal(r.status, 200);
    const mid = r.body.result.message_ids[0];
    const schema = { type: 'object', extensible: false, properties: { hp: { type: 'number', required: true } } };
    // 违规:type_mismatch(hp 串) + unexpected_key(extra,非 extensible)→ 400 + 逐路径
    r = await call('replaceMvuData', { type: 'message', message_id: mid, data: { stat_data: { hp: 'ten', extra: 1 }, schema } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'mvu_schema');
    const paths = r.body.schema_errors.map((e) => e.path);
    assert.ok(paths.includes('hp') && paths.includes('extra'), `逐路径明细: ${JSON.stringify(r.body.schema_errors)}`);
    // 不落盘:本楼仍非 MVU(data 空)
    r = await call('getMvuData', { type: 'message', message_id: mid });
    assert.equal(r.status, 400);
    assert.equal(r.body.mvu, false);
    // required 缺位 → missing_required
    r = await call('replaceMvuData', { type: 'message', message_id: mid, data: { stat_data: {}, schema } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.schema_errors.map((e) => e.code), ['missing_required']);
    // 合规写 → 200(store 自此有 schema)
    r = await call('replaceMvuData', { type: 'message', message_id: mid, data: { stat_data: { hp: 10 }, schema } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // replaceVariables 写 stat_data + 自带合法 schema → 违规也 400
    r = await call('replaceVariables', { type: 'message', message_id: mid, variables: { stat_data: { hp: 'x' }, schema, other_root: 1 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'mvu_schema');
    // 未落盘:hp 仍 10
    r = await call('getMvuData', { type: 'message', message_id: mid });
    assert.equal(r.body.result.stat_data.hp, 10);
    // vars.schema 非法形 → 回落 store.schema 校验(schema 根在场不丢根)
    r = await call('replaceVariables', { type: 'message', message_id: mid, variables: { stat_data: { hp: 'x' }, schema: 'bogus', other_root: 1 } });
    assert.equal(r.status, 400, `store schema 兜底同样拦: ${JSON.stringify(r.body)}`);
    // force:true → 降级 warnings 照写 + schema_errors 回执留痕
    r = await call('replaceVariables', {
        type: 'message', message_id: mid, force: true,
        variables: { stat_data: { hp: 'x', bonus: 1 }, schema: { ...schema, extensible: true }, other_root: 1 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.warnings.some((w) => w.includes('schema_errors')), 'force 违规进 warnings');
    assert.ok(Array.isArray(r.body.schema_errors), 'force 违规明细回执');
    // 回收
    r = await call('deleteChatMessages', { message_ids: [mid] });
    assert.equal(r.status, 200);
});

// ── D. GH#9 辅助生成面 ────────────────────────────────────────────────

test('th.generate 校验面:无 prompt/target → 400;generateRaw ordered_prompts → unsupported', async () => {
    let r = await call('generate', {});
    assert.equal(r.status, 400);
    r = await call('generate', { user_input: 42 });
    assert.equal(r.status, 400);
    r = await call('generate', { user_input: 'hi' }, { charDir: CHAR, chatName: null });
    assert.equal(r.status, 400, '无 chat 目标 → 诚实 400');
    r = await call('generateRaw', { ordered_prompts: [{ role: 'user', content: 'x' }] });
    assert.equal(r.body.unsupported, true, 'ordered_prompts 诚实 unsupported');
});

test('th.generate 失败可见:ok:false + generation_requested/stopped 信箱 + diag', async () => {
    const s0 = (await call('getEventLog', {})).body.result.seq;
    // 无 API 后端 → quiet 链必然失败;断言失败面完整(不回吞、有信箱、有 diag)
    const r = await call('generate', { user_input: 'summon a forum post', timeout_ms: 2500 });
    assert.equal(r.body.ok, false, JSON.stringify(r.body));
    assert.ok(r.body.error && r.body.error.length > 0, '失败原因可见');
    const log = await call('getEventLog', { since: s0 });
    const events = log.body.result.entries.map((e) => e.event);
    assert.ok(events.includes('generation_requested'), `requested 入信箱: ${events}`);
    assert.ok(events.includes('generation_stopped'), `stopped 终态入信箱: ${events}`);
    // 生命周期事件 origin 标 server(宿主泵不误判自发)
    const stopped = log.body.result.entries.find((e) => e.event === 'generation_stopped');
    assert.equal(stopped.origin, 'server');
    assert.ok(String(stopped.args[0]).length > 0, 'stopped 携带失败原因');
});

// 最小可用预设(lorebookEntries 选择性 WI 要过组装到 WI 段;
// utopinn-generate-context.test.mjs PRESET 同构)
const PRESET_MIN = {
    openai_model: 'gpt-test',
    openai_max_context: 8192,
    openai_max_tokens: 200,
    prompts: [
        { identifier: 'main', role: 'system', content: 'You are {{char}}.' },
        { identifier: 'worldInfoBefore', role: 'system', marker: true, content: '' },
        { identifier: 'chatHistory', role: 'system', marker: true, content: '' },
        { identifier: 'worldInfoAfter', role: 'system', marker: true, content: '' },
    ],
    prompt_order: [{
        character_id: 100001,
        order: ['main', 'worldInfoBefore', 'chatHistory', 'worldInfoAfter'].map((identifier) => ({ identifier, enabled: true })),
    }],
};

test('th.generate lorebookEntries:选择性 WI 注入;全未命中 → 400;部分未命中 → warnings', async () => {
    await getPresetRepo().save(HANDLE, 'openai', 'Default', PRESET_MIN);
    await getWorldInfoRepo().save(HANDLE, 'SelBook', {
        entries: {
            '0': { uid: 0, comment: 'e1', key: ['论坛'], content: 'E1-sel', constant: false },
            '1': { uid: 1, comment: 'e2', key: [], content: 'E2-const', constant: true },
        },
    });
    await call('setChatLorebook', { lorebook: 'SelBook' });
    try {
        const since = Date.now();
        // 校验形:非 array/object/string → 400
        let r = await call('generate', { user_input: 'x', lorebookEntries: 42 });
        assert.equal(r.status, 400, JSON.stringify(r.body));
        // 全部未命中 → 组装侧 lorebook_entries_unresolved → 400(参数错,非后端事故)
        r = await call('generate', { user_input: 'x', lorebookEntries: ['SelBook:999'], timeout_ms: 8000 });
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.match(String(r.body.error), /unresolved/);
        // 命中 e1 → 选择性注入(force-activated);dispatch 无后端失败,
        // 但 worldinfo inject diag 先行 —— selective 段 + 激活明细只含 e1。
        r = await call('generate', { user_input: 'x', lorebookEntries: [{ lorebook: 'SelBook', uid: 0 }], timeout_ms: 10000 });
        const selEvts = diagQuery({ kind: 'inject', code: 'worldinfo', since })
            .filter((e) => e.data?.selective);
        assert.ok(selEvts.length >= 1, `选择性 WI diag: ${JSON.stringify(selEvts.map((e) => e.data))}`);
        assert.equal(selEvts[0].data.selective.resolved, 1);
        assert.deepEqual(selEvts[0].data.selective.unresolved, []);
        assert.deepEqual(selEvts[0].data.entries.map((e) => e.uid), [0],
            `只激活点名条目(e2 constant 不入选——整表替换合并池): ${JSON.stringify(selEvts[0].data.entries)}`);
        // 部分未命中 → 圈定照常进组装;本 fixture 无后端 → 生成段 502,
        // 但未命中名单不随事故吞掉:warnings 点名 GhostBook + lorebook
        // 回执明细挂在错误体上(error.lorebook 由 quiet-generation 失败
        // 路径回填)。
        r = await call('generate', { user_input: 'x', lorebookEntries: ['SelBook:0', 'GhostBook:0'], timeout_ms: 10000 });
        assert.equal(r.status, 502, JSON.stringify(r.body));
        assert.ok((r.body.warnings ?? []).some((w) => String(w).includes('GhostBook')),
            `部分未命中 warnings 点名: ${JSON.stringify(r.body)}`);
        assert.deepEqual(r.body.lorebook?.unresolved, ['GhostBook:0'],
            `失败路径 lorebook 回执: ${JSON.stringify(r.body)}`);
        const sel2 = diagQuery({ kind: 'inject', code: 'worldinfo', since }).filter((e) => e.data?.selective);
        assert.equal(sel2.length, 2);
        assert.deepEqual(sel2[1].data.selective.unresolved, ['GhostBook:0']);
        // generateRaw 同享(委托 generate)
        r = await call('generateRaw', { user_input: 'x', lorebookEntries: ['SelBook:999'], timeout_ms: 8000 });
        assert.equal(r.status, 400, 'generateRaw 同享 lorebookEntries→unresolved 400');
    } finally {
        await call('setChatLorebook', { lorebook: null });
    }
});

test('triggerSlash:/gen → generateQuiet→runQuietGeneration 钉;/trigger 未绑定 → 显式错(GH#9)', async () => {
    // /gen:host.generateQuiet 已绑 → 走真 quiet 链(组装/派发失败也诚实
    // 经 sinks.notification 回执)——seam 缺失的旧行为是无声 ''。
    let r = await call('triggerSlash', { script: '/gen hello' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body.ops ?? []).some((o) => o.type === 'gen'), `ops 含 gen: ${JSON.stringify(r.body.ops)}`);
    assert.ok((r.body.notifications ?? []).some((n) => String(n.text).includes('/gen failed')),
        `generateQuiet→runQuietGeneration 链真走(失败面经 sinks): ${JSON.stringify(r.body.notifications)}`);
    // /trigger:seam 缺席 → 引擎显式抛错(不再静默假成功)
    r = await call('triggerSlash', { script: '/trigger' });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.match(String(r.body.error), /triggerGeneration/);
});

// ── E. 消息写家族(TH 字段名,楼层一致 + 信箱事件) ──────────────────────

test('createChatMessages:尾部追加+insert_before 插入,写后读回+信箱事件', async () => {
    const s0 = (await call('getEventLog', {})).body.result.seq;
    // 尾插 user+assistant
    let r = await call('createChatMessages', {
        chat_messages: [
            { role: 'user', message: 'u-floor' },
            { role: 'assistant', message: 'a-floor', data: { tag: 1 } },
        ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.result.message_ids;
    assert.equal(ids.length, 2);
    const n = (await call('getChatMessages', {})).body.result.length;
    assert.equal(ids[1], n - 1, '尾插落在最后');
    const body = (await call('getChatMessages', {})).body.result;
    assert.equal(body[ids[0]].is_user, true);
    assert.equal(body[ids[0]].mes, 'u-floor');
    assert.equal(body[ids[1]].mes, 'a-floor');
    assert.deepEqual(body[ids[1]].variables, [{ tag: 1 }], 'data → variables[0]');
    // insert_before=0 头插
    r = await call('createChatMessages', {
        chat_messages: [{ role: 'system', message: 'sys-head' }],
        insert_before: 0,
    });
    const head = (await call('getChatMessages', {})).body.result[0];
    assert.equal(head.mes, 'sys-head');
    assert.equal(head.extra?.type, 'narrator', 'system 楼 extra.type');
    // 校验面
    r = await call('createChatMessages', { chat_messages: [{ role: 'ghost', message: 'x' }] });
    assert.equal(r.status, 400);
    r = await call('createChatMessages', { chat_messages: [] });
    assert.equal(r.status, 400);
    // 信箱:user→message_sent,assistant/system→message_received,chat_changed 兜底
    const log = await call('getEventLog', { since: s0 });
    const events = log.body.result.entries.map((e) => e.event);
    assert.ok(events.includes('message_sent'), `message_sent 入信箱: ${events}`);
    assert.ok(events.includes('message_received'), `message_received 入信箱: ${events}`);
    assert.ok(events.includes('chat_changed'), `chat_changed 入信箱: ${events}`);
    // ghost chat → 404
    r = await call('createChatMessages', { chat_messages: [{ role: 'user', message: 'x' }] }, { charDir: CHAR, chatName: 'ghost' });
    assert.equal(r.status, 404);
});

test('setChatMessages/setChatMessage:正文/data/swipe 面写 + message_edited', async () => {
    const s0 = (await call('getEventLog', {})).body.result.seq;
    const body = (await call('getChatMessages', {})).body.result;
    const mid = body.length - 1;
    // 正文写:mes + swipes[swipe_id] 同步(TH 语义)
    let r = await call('setChatMessages', { chat_messages: [{ message_id: mid, message: 'edited-text', data: { hp: 42 } }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.result.edited, [mid]);
    let m = (await call('getChatMessages', {})).body.result[mid];
    assert.equal(m.mes, 'edited-text');
    assert.deepEqual(m.variables[m.swipe_id ?? 0], { hp: 42 });
    // swipe 面:新 swipes 数组 + swipe_id 切换 → mes/extra 跟当前页
    r = await call('setChatMessages', {
        chat_messages: [{ message_id: mid, swipes: ['s0', 's1'], swipe_id: 1, swipes_data: [{ d: 0 }, { d: 1 }] }],
    });
    assert.equal(r.status, 200);
    m = (await call('getChatMessages', {})).body.result[mid];
    assert.deepEqual(m.swipes, ['s0', 's1']);
    assert.equal(m.swipe_id, 1);
    assert.equal(m.mes, 's1', 'mes 同步当前 swipe');
    assert.deepEqual(m.variables, [{ d: 0 }, { d: 1 }]);
    // role/is_hidden 面
    r = await call('setChatMessage', { message_id: mid, message: 'via-setChatMessage', is_hidden: true });
    assert.equal(r.status, 200);
    m = (await call('getChatMessages', {})).body.result[mid];
    assert.equal(m.mes, 'via-setChatMessage');
    assert.equal(m.is_system, true, 'is_hidden → is_system');
    // 越界 mid 静默跳过(TH:对不存在楼层 no-op)
    r = await call('setChatMessages', { chat_messages: [{ message_id: 9999, message: 'x' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.edited.length, 0);
    // 校验
    r = await call('setChatMessages', { chat_messages: 'x' });
    assert.equal(r.status, 400);
    r = await call('setChatMessage', { message: 'x' });
    assert.equal(r.status, 400);
    // 信箱
    const events = (await call('getEventLog', { since: s0 })).body.result.entries.map((e) => e.event);
    assert.ok(events.includes('message_edited'), `message_edited 入信箱: ${events}`);
    // refreshOneMessage → refresh_message 信箱事件
    r = await call('refreshOneMessage', { message_id: mid });
    assert.equal(r.status, 200);
    const log2 = await call('getEventLog', {});
    assert.ok(log2.body.result.entries.some((e) => e.event === 'refresh_message' && e.args[0] === mid));
});

test('deleteChatMessages + rotateChatMessages:楼层一致 + chat_changed', async () => {
    const s0 = (await call('getEventLog', {})).body.result.seq;
    // 现状 len;rotate [0,1)[1,len) → [1,len)[0,1):头楼移尾
    const before = (await call('getChatMessages', {})).body.result.map((m) => m.mes);
    const n = before.length;
    let r = await call('rotateChatMessages', { begin: 0, middle: 1, end: n });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.rotated, true);
    let after = (await call('getChatMessages', {})).body.result.map((m) => m.mes);
    assert.equal(after.length, n);
    assert.equal(after[0], before[1], 'rotate:原 idx1 到首');
    assert.equal(after[n - 1], before[0], 'rotate:原 idx0 到尾');
    // delete 尾楼 + 头楼
    r = await call('deleteChatMessages', { message_ids: [0, -1] });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.deleted.length, 2);
    after = (await call('getChatMessages', {})).body.result.map((m) => m.mes);
    assert.equal(after.length, n - 2);
    // 校验
    r = await call('deleteChatMessages', { message_ids: [] });
    assert.equal(r.status, 400);
    r = await call('rotateChatMessages', { begin: 0, middle: 1 });
    assert.equal(r.status, 400);
    const events = (await call('getEventLog', { since: s0 })).body.result.entries.map((e) => e.event);
    assert.ok(events.includes('message_deleted'), `message_deleted 入信箱: ${events}`);
    assert.ok(events.includes('chat_changed'), `chat_changed 入信箱: ${events}`);
});

// ── F. 世界书 TH 面 ───────────────────────────────────────────────────

test('lorebook CRUD:建→条目写→TH 视图读回→合并/删除→绑定', async () => {
    // 建书 + 名单
    let r = await call('createLorebook', { lorebook: 'Forum' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.created, true);
    r = await call('getLorebooks', {});
    assert.ok(r.body.result.includes('Forum'));
    // 条目创建(TH 平铺字段)→ TH 视图读回
    r = await call('createLorebookEntries', {
        lorebook: 'Forum',
        entries: [{ comment: 'e1', keys: ['论坛'], content: 'BBS 正文', type: 'constant', position: 'after_character_definition' }],
    });
    assert.equal(r.status, 200);
    const uid = r.body.result.new_uids[0];
    assert.equal(typeof uid, 'number');
    let ent = r.body.result.entries.find((e) => e.uid === uid);
    assert.equal(ent.comment, 'e1');
    assert.deepEqual(ent.keys, ['论坛']);
    assert.equal(ent.position, 'after_character_definition', 'TH position 字符串回读');
    assert.equal(ent.enabled, true);
    // setLorebookEntries merge-by-uid
    r = await call('setLorebookEntries', { lorebook: 'Forum', entries: [{ uid, content: 'BBS 改', enabled: false }] });
    ent = r.body.result.entries.find((e) => e.uid === uid);
    assert.equal(ent.content, 'BBS 改');
    assert.equal(ent.enabled, false, 'enabled → disable 反向映射');
    assert.equal(ent.comment, 'e1', '未写字段不动');
    // getLorebookEntries 读面一致
    r = await call('getLorebookEntries', { lorebook: 'Forum' });
    assert.equal(r.body.result.entries.length, 1);
    // replaceLorebookEntries 全量替换
    r = await call('replaceLorebookEntries', {
        lorebook: 'Forum',
        entries: [{ comment: 'only', content: 'x', type: 'selective' }],
    });
    assert.equal(r.body.result.entries.length, 1);
    assert.equal(r.body.result.entries[0].comment, 'only');
    // deleteLorebookEntries
    const uid2 = r.body.result.entries[0].uid;
    r = await call('deleteLorebookEntries', { lorebook: 'Forum', uids: [uid2] });
    assert.equal(r.body.result.delete_occurred, true);
    assert.equal(r.body.result.entries.length, 0);
    // 绑定:getChatLorebook null → setChatLorebook → getOrCreateChatLorebook
    r = await call('getChatLorebook', {});
    assert.equal(r.body.result, null);
    r = await call('setChatLorebook', { lorebook: 'Forum' });
    assert.equal(r.status, 200);
    r = await call('getChatLorebook', {});
    assert.equal(r.body.result, 'Forum');
    r = await call('setChatLorebook', { lorebook: null });
    r = await call('getChatLorebook', {});
    assert.equal(r.body.result, null, 'null 解绑落盘');
    r = await call('getOrCreateChatLorebook', { lorebook: 'AutoBook' });
    assert.equal(r.body.result, 'AutoBook');
    // 角色书绑定读面(EvtCard 无绑书 → primary null)
    r = await call('getCharLorebooks', {});
    assert.equal(r.body.result.primary, null);
    // 错误面
    r = await call('getLorebookEntries', { lorebook: 'ghost-book' });
    assert.equal(r.status, 404);
    r = await call('createLorebookEntries', { lorebook: 'Forum', entries: [] });
    assert.equal(r.status, 400);
    r = await call('setLorebookEntries', { lorebook: 'Forum', entries: [{ content: 'x' }] });
    assert.equal(r.status, 400, '无 uid → 400');
    r = await call('deleteLorebook', { lorebook: 'Forum' });
    assert.equal(r.body.result.deleted, true);
});

// ── G. 正则 TH 面 ─────────────────────────────────────────────────────

test('tavern regex:global/character 读写 TH 视图 + formatAs + 放行判定', async () => {
    // global 写(TH 视图)→ 读回同视图
    const script = {
        id: 'r1', script_name: 'strip-x', enabled: true,
        find_regex: '/x+/g', trim_strings: [], replace_string: 'Y',
        source: { ai_output: true, user_input: false, slash_command: false, world_info: false, reasoning: false },
        destination: { display: false, prompt: true },
        run_on_edit: false, min_depth: null, max_depth: null,
    };
    let r = await call('replaceTavernRegexes', { type: 'global', regexes: [script] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('getTavernRegexes', { type: 'global' });
    assert.equal(r.body.result.length, 1);
    const v = r.body.result[0];
    assert.equal(v.script_name, 'strip-x');
    assert.equal(v.enabled, true);
    assert.equal(v.find_regex, '/x+/g');
    assert.equal(v.source.ai_output, true);
    // formatAs(TH 签名 source/destination 为字符串):AI_OUTPUT+prompt → 'YhiY'
    r = await call('formatAsTavernRegexedString', { text: 'xxhixx', source: 'ai_output', destination: 'prompt' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result, 'YhiY', `regex 应用: ${JSON.stringify(r.body)}`);
    // destination 不命中(display 域本脚本未挂)→ 原文不动(TH 车道语义)
    r = await call('formatAsTavernRegexedString', { text: 'xxhixx', source: 'ai_output', destination: 'display' });
    assert.equal(r.body.result, 'xxhixx');
    // character 域:写卡(json 卡原子写)→ 读回
    r = await call('replaceTavernRegexes', { type: 'character', regexes: [{ ...script, id: 'r2', script_name: 'card-script' }] });
    assert.equal(r.status, 200);
    r = await call('getTavernRegexes', { type: 'character' });
    assert.equal(r.body.result.length, 1);
    assert.equal(r.body.result[0].script_name, 'card-script');
    // 写后卡文件里 regex_scripts 落在 data.extensions(canonical 槽)
    const card = JSON.parse(fs.readFileSync(path.join(dirs.characters, `${CHAR}.json`), 'utf8'));
    assert.ok(Array.isArray(card.data.extensions.regex_scripts));
    assert.equal(card.data.extensions.regex_scripts[0].scriptName, 'card-script');
    assert.equal('regex_scripts' in (card.extensions ?? {}), false, '旧槽已摘');
    // 放行判定(未放行 → false)
    r = await call('isCharacterTavernRegexesEnabled', {});
    assert.equal(r.body.result, false);
    // updateTavernRegexesWith:ship 结果全量替换
    r = await call('updateTavernRegexesWith', { type: 'global', result: [] });
    assert.equal(r.status, 200);
    r = await call('getTavernRegexes', { type: 'global' });
    assert.equal(r.body.result.length, 0);
    // substituteMacros:{{user}}/{{char}} 真上下文替换
    r = await call('substituteMacros', { text: 'hi {{char}}, I am {{user}}' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result, `hi ${CHAR}, I am User`, `宏替换: ${JSON.stringify(r.body)}`);
    // 错误面
    r = await call('getTavernRegexes', { type: 'bogus' });
    assert.equal(r.status, 400);
    r = await call('replaceTavernRegexes', { type: 'character', name: 'ghostchar', regexes: [] });
    assert.equal(r.status, 404);
    r = await call('replaceTavernRegexes', {});
    assert.equal(r.status, 400);
});

// ── H. stopGeneration ─────────────────────────────────────────────────

test('stopGeneration:generation_id 未命中 → 404;无活跃 → cancelled:0 如实', async () => {
    let r = await call('stopGeneration', { generation_id: 'nope-job' });
    assert.equal(r.status, 404);
    r = await call('stopGeneration', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.result.cancelled, 0);
    assert.ok(r.body.result.covered, '覆盖口径如实标注');
});

// ── I. displayed_message + Mvu + 前端界面块 ────────────────────────────

test('formatAsDisplayedMessage:楼层别名解析 + 展示车道投影 + 宏尾段', async () => {
    // display 车道全局脚本:仅 AI_OUTPUT 源命中(user 楼 placement 不吃 →
    // 证明走 chatFloorRegexPlacement 真楼层定位,不是全量瞎投)
    const script = {
        id: 'd1', script_name: 'disp-x', enabled: true,
        find_regex: '/x+/g', trim_strings: [], replace_string: '{{char}}',
        source: { ai_output: true, user_input: false, slash_command: false, world_info: false, reasoning: false },
        destination: { display: true, prompt: false },
        run_on_edit: false, min_depth: null, max_depth: null,
    };
    let r = await call('replaceTavernRegexes', { type: 'global', regexes: [script] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // 'last'/缺省 → 末楼(char):display 车道 + 宏尾段 {{char}} → CHAR
    r = await call('formatAsDisplayedMessage', { text: 'xxhixx', message_id: 'last' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result, `${CHAR}hi${CHAR}`);
    r = await call('formatAsDisplayedMessage', { text: 'xxhixx' });
    assert.equal(r.body.result, `${CHAR}hi${CHAR}`);
    // 'last_char' + 负数(负从尾)同指末楼
    r = await call('formatAsDisplayedMessage', { text: 'xx', message_id: -1 });
    assert.equal(r.body.result, CHAR);
    r = await call('formatAsDisplayedMessage', { text: 'xx', message_id: 'last_char' });
    assert.equal(r.body.result, CHAR);
    // 'last_user' → user 楼:AI_OUTPUT 脚本不命中 → 原文
    r = await call('formatAsDisplayedMessage', { text: 'xxhixx', message_id: 'last_user' });
    assert.equal(r.body.result, 'xxhixx');
    // 越界/无效 → 400(TH 抛错面)
    r = await call('formatAsDisplayedMessage', { text: 'xx', message_id: 9999 });
    assert.equal(r.status, 400);
    // 无 chat 目标 → 400
    r = await call('formatAsDisplayedMessage', { text: 'xx' }, { charDir: CHAR });
    assert.equal(r.status, 400);
});

test('retrieveDisplayedMessage:展示投影 + 前端界面块提取 + 别名', async () => {
    const widget = '<body><div class="widget">panel-dom</div></body>';
    // 铺一个带 ```html 前端界面块的 assistant 楼(文本无 'x',不吃 d1 脚本)
    let r = await call('createChatMessages', {
        chat_messages: [{ role: 'assistant', message: `看下面板\n\n\`\`\`html\n${widget}\n\`\`\`\n` }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mid = r.body.result.message_ids[0];
    r = await call('retrieveDisplayedMessage', { message_id: mid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = r.body.result;
    assert.equal(v.message_id, mid);
    assert.equal(v.has_frontend, true);
    assert.equal(v.frontend_blocks.length, 1);
    assert.ok(v.frontend_blocks[0].includes('panel-dom'), `块内容: ${v.frontend_blocks[0]}`);
    assert.ok(v.display_text.includes(widget), 'display_text = 投影全文(宿主再切)');
    // 'last' 别名 = 刚追加的楼
    r = await call('retrieveDisplayedMessage', { message_id: 'last' });
    assert.equal(r.body.result.message_id, mid);
    // 越界 → 400
    r = await call('retrieveDisplayedMessage', { message_id: 9999 });
    assert.equal(r.status, 400);
    // 回收:删除铺的楼
    r = await call('deleteChatMessages', { message_ids: [mid] });
    assert.equal(r.status, 200);
});

test('Mvu.getMvuData/replaceMvuData:MVU 形校验 + 楼 data 全量写', async () => {
    // 干净楼层(空 data → 根守卫无丢根)
    let r = await call('createChatMessages', {
        chat_messages: [{ role: 'assistant', message: 'mvu-floor' }],
    });
    assert.equal(r.status, 200);
    const mid = r.body.result.message_ids[0];
    // 非 MVU 形(缺 stat_data/schema)→ 400(TH 校验面)
    r = await call('replaceMvuData', { type: 'message', message_id: mid, data: { foo: 1 } });
    assert.equal(r.status, 400);
    r = await call('replaceMvuData', { type: 'message', message_id: mid, data: 'str' });
    assert.equal(r.status, 400);
    // MVU 形全量写 → getMvuData 同楼读回
    const mvu = { stat_data: { hp: 10, inv: ['sword'] }, schema: { properties: { hp: { type: 'number' } } } };
    r = await call('replaceMvuData', { type: 'message', message_id: mid, data: mvu });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('getMvuData', { type: 'message', message_id: mid });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.stat_data.hp, 10);
    assert.deepEqual(r.body.result.schema, mvu.schema);
    // 非 MVU 域 → 400 + mvu:false 如实标记
    r = await call('getMvuData', { type: 'chat' });
    assert.equal(r.status, 400);
    assert.equal(r.body.mvu, false);
    // 回收
    r = await call('deleteChatMessages', { message_ids: [mid] });
    assert.equal(r.status, 200);
});

// ── K. ctx surface 面(openOverlay/closeOverlay → ctx.surface*)───────────
// wire:protocol PANEL_METHODS ctx.surfaceOpen/surfaceClose;shim:ctx-shim
// openOverlay/closeOverlay 真转发(panel-shim.test.mjs 钉 wire 一跳);
// host:web ctxHost + 本文件 cardapp-host 同契约 opts.surface =
// {panelType, openPanel, collapsePanels}(web 挂载组件接 s.openPanel/
// s.collapsePanels;web 格在 kernel context 实现 collapsePanels,名字锁定)。

test('ctx surface:headless 无壳如实降级;opts.surface 注壳两跳 openPanel/collapsePanels', async (t) => {
    let mountCardApp;
    try {
        ({ mountCardApp } = await import('../../cli/cardapp-host.mjs'));
        await import('jsdom');
    } catch (e) {
        t.skip(`headless harness 不可用: ${e?.message ?? e}`);
        return;
    }
    const cardPath = path.join(ROOT, 'surface-card.json');
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
    // ① headless 无 opts.surface → 如实降级(不假装成了)+ console 留痕
    const plain = await mountCardApp({ server: BASE, charDir: CHAR, chatName: CHAT, card: cardPath, settleMs: 400 });
    try {
        let r = await plain.callDispatch('ctx.surfaceOpen', {});
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'headless_no_shell');
        assert.equal(r.surface, 'open');
        r = await plain.callDispatch('ctx.surfaceClose', {});
        assert.equal(r.reason, 'headless_no_shell');
        assert.equal(r.surface, 'close');
        assert.ok(plain.consoleLog.some((e) => /surface(Open|Close)|无壳可收/.test(String(e.msg))),
            `console 留痕: ${JSON.stringify(plain.consoleLog.slice(-4))}`);
    } finally {
        await plain.dispose();
    }
    // ② opts.surface 注壳 → host case 两跳:open→openPanel(panelType)、close→collapsePanels
    const calls = [];
    const shelled = await mountCardApp({
        server: BASE, charDir: CHAR, chatName: CHAT, card: cardPath, settleMs: 400,
        surface: {
            panelType: 'cardapp',
            openPanel: (pt) => calls.push(['openPanel', pt]),
            collapsePanels: () => calls.push(['collapsePanels']),
        },
    });
    try {
        const r1 = await shelled.callDispatch('ctx.surfaceOpen', {});
        assert.deepEqual(r1, { ok: true, panel: 'cardapp' });
        const r2 = await shelled.callDispatch('ctx.surfaceClose', {});
        assert.equal(r2.ok, true);
        assert.deepEqual(calls, [['openPanel', 'cardapp'], ['collapsePanels']],
            `shell 两跳: ${JSON.stringify(calls)}`);
    } finally {
        await shelled.dispose();
    }
});

// ── J. message doc mount(前端界面 iframe 承载面)────────────────────────

test('card-runtime message doc mount:铸帧→出壳→shim 拼接→CSP', async () => {
    // 铸 doc mount(TH 楼层 iframe:payload=楼层前端块 HTML)
    let res = await fetch(`${BASE}/api/card-runtime/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'message', charId: CHAR, chatName: CHAT, html: '<body><div id="w">hi-dom</div></body>' }),
    });
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json().catch(() => null)));
    const bundle = await res.json();
    assert.ok(bundle.mountId?.match(/^[a-f0-9]{32}$/), `mountId: ${bundle.mountId}`);
    assert.ok(bundle.bridgeNonce);
    assert.ok(bundle.entryUrl.replace(/\/$/, '').endsWith(`/m/${bundle.mountId}`), `entryUrl: ${bundle.entryUrl}`);
    assert.equal(bundle.manifest?.entryKind, 'document');
    // 出壳:?shim=t0 → TH shim 拼接 + nonce bootstrap + 壳内容 + 自动量高
    res = await fetch(`${BASE}${bundle.entryUrl}?shim=t0`);
    assert.equal(res.status, 200);
    const doc = await res.text();
    assert.ok(doc.includes('data-card-runtime-shim'), 'shim tag 拼入');
    assert.ok(doc.includes(bundle.bridgeNonce), 'bridgeNonce bootstrap 拼入');
    assert.ok(doc.includes('hi-dom'), '楼层块内容在壳内');
    assert.ok(doc.includes('utopinn-msgframe-height'), '自动量高脚本在壳内');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes('sandbox allow-scripts'), `CSP 沙箱: ${csp}`);
    // 坏输入面:无 html → 400;幽灵卡 → 404;文档超限 → 413
    res = await fetch(`${BASE}/api/card-runtime/mounts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'message', charId: CHAR, html: '' }),
    });
    assert.equal(res.status, 400);
    res = await fetch(`${BASE}/api/card-runtime/mounts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'message', charId: 'ghost-char', html: '<body>x</body>' }),
    });
    assert.equal(res.status, 404);
    res = await fetch(`${BASE}/card-runtime/m/deadbeefdeadbeefdeadbeefdeadbeef`);
    assert.equal(res.status, 404);
});

// ── L. GH#15b ctx 订阅记账 + GH#13 归闲探针(headless)────────────────────

test('subscribedEvents 含 ctx.on 登记(GH#15b);waitForIdle/is_send_press 探针(GH#13)', async (t) => {
    let mountCardApp;
    try {
        ({ mountCardApp } = await import('../../cli/cardapp-host.mjs'));
        await import('jsdom');
    } catch (e) {
        t.skip(`headless harness 不可用: ${e?.message ?? e}`);
        return;
    }
    const cardPath = path.join(ROOT, 'idle-card.json');
    fs.writeFileSync(cardPath, JSON.stringify({
        name: CHAR,
        data: {
            name: CHAR,
            extensions: {
                card_app: { enabled: true, entry: 'index.html', files: { 'index.html': TEST_CARD_HTML } },
            },
        },
    }));
    const s = await mountCardApp({ server: BASE, charDir: CHAR, chatName: CHAT, card: cardPath, settleMs: 500 });
    try {
        // GH#15b:ctx.on 经桥登记进 ctxSubscribed —— subscribedEvents 必须吐它,
        // 否则 op push 的 subscribed 永远只见 T0 面。
        await waitFor(() => s.subscribedEvents().includes('message_received'));
        await s.callDispatch('ctx.on', { event: 'ctx_custom_evt' });
        assert.ok(s.subscribedEvents().includes('ctx_custom_evt'),
            `ctx.on 进订阅面: ${JSON.stringify(s.subscribedEvents())}`);
        assert.ok(s.subscribedEvents().includes('message_received'), 'T0 面仍在');
        await s.callDispatch('ctx.off', { event: 'ctx_custom_evt' });
        assert.ok(!s.subscribedEvents().includes('ctx_custom_evt'), 'ctx.off 摘除');

        // GH#13:idle 会话 → waitForIdle 归闲(grace 窗内无条件等待,下限 ~graceMs)
        const idle = await s.waitForIdle({ timeoutMs: 3000 });
        assert.equal(idle.settled, true, JSON.stringify(idle));
        assert.ok(idle.waitedMs >= 400, `grace 下限: ${idle.waitedMs}ms`);
        assert.equal(idle.bridgePending, 0);
        assert.equal(idle.activeGenerations, 0);
        assert.equal(idle.isSendPress, false);

        // 生成在途:runCardGeneration 同步段先 activeGenerations++(POST 前),
        // is_send_press 活 getter 同步变真(旧常量 false 永远探不到)。
        const genP = s.runCardGeneration({ type: 'quiet' }).catch((e) => ({ failed: String(e?.message ?? e) }));
        assert.equal(s.idleSnapshot().activeGenerations, 1, 'job 台账在途');
        assert.equal(s.idleSnapshot().isSendPress, true);
        assert.equal(s.ctx.lukerContext.is_send_press, true, 'ctx.lukerContext.is_send_press 活 getter');
        const r = await genP;   // 服务端无 /api/utopinn/generate 路由 → 快速失败终态
        assert.ok(r, '失败也收敛');
        assert.equal(s.idleSnapshot().activeGenerations, 0, 'finally 落账');
        assert.equal(s.ctx.lukerContext.is_send_press, false);
        const after = await s.waitForIdle({ timeoutMs: 3000, graceMs: 50 });
        assert.equal(after.settled, true, JSON.stringify(after));
    } finally {
        await s.dispose().catch(() => { });
    }
});

test('ctx 事件投递 e2e:卡内 eventSource.on ← host.event push(GH#15b 全链)', async (t) => {
    let mountCardApp;
    try {
        ({ mountCardApp } = await import('../../cli/cardapp-host.mjs'));
        await import('jsdom');
    } catch (e) {
        t.skip(`headless harness 不可用: ${e?.message ?? e}`);
        return;
    }
    // module 入口(.js)→ entryKind=module → face=ctx:卡 realm 才有
    // __CARDAPP_CTX__/ctx.eventSource —— 掌门卡同款依赖路径。
    const cardPath = path.join(ROOT, 'ctx-delivery-card.json');
    fs.writeFileSync(cardPath, JSON.stringify({
        name: CHAR,
        data: {
            name: CHAR,
            extensions: {
                card_app: {
                    enabled: true, entry: 'index.js',
                    files: {
                        'index.js': `module.exports = { init(ctx) {
                            window.__delivered = [];
                            window.__deliverFn = function (a, b) { window.__delivered.push([a, b]); };
                            ctx.eventSource.on('deliver_evt', window.__deliverFn);
                        } };`,
                    },
                },
            },
        },
    }));
    const s = await mountCardApp({ server: BASE, charDir: CHAR, chatName: CHAT, card: cardPath, settleMs: 500 });
    try {
        assert.equal(s.face, 'ctx', 'module 入口 → ctx 面');
        // ctx.on 是 fire-and-forget 桥调用 —— 等 ctxSubscribed 记账落位再发 push。
        assert.ok(await waitFor(() => s.subscribedEvents().includes('deliver_evt')),
            `deliver_evt 订阅记账: ${JSON.stringify(s.subscribedEvents())}`);
        // 全链:pushCtxEvent → ctxSubscribed 门 → bridge.push('host.event') →
        // 卡 shim __utopinnPanelReceive → dispatchLocal → 卡内 listener 真跑。
        s.pushCtxEvent('deliver_evt', [7, 'seven']);
        // 跨 realm:evalInCard 取出的是 jsdom realm 数组(原型不同,
        // deepEqual 必拒)——卡内 stringify 取串比。
        assert.equal(s.evalInCard('JSON.stringify(window.__delivered)'), '[[7,"seven"]]', 'host.event 投递进卡 realm');
        // 未订阅名不过门:宿主侧 emit 了,但 bridge.push 被闸 —— 卡侧零投递。
        s.pushCtxEvent('never_subscribed', [1]);
        assert.equal(s.evalInCard('window.__delivered.length'), 1, '未订阅事件不进卡');
        // ctx.off(带 fn 引用)摘除后不再投递。
        s.evalInCard('window.__CARDAPP_CTX__.eventSource.off("deliver_evt", window.__deliverFn)');
        assert.ok(await waitFor(() => !s.subscribedEvents().includes('deliver_evt')),
            'ctx.off 摘除记账');
        s.pushCtxEvent('deliver_evt', [8]);
        assert.equal(s.evalInCard('window.__delivered.length'), 1, 'off 后事件不再投递');
    } finally {
        await s.dispose().catch(() => { });
    }
});
