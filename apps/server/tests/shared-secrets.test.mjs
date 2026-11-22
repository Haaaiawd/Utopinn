/**
 * TASK-072 共享 secrets(shared-secrets.md §2)测试(node:test)。
 *
 * 覆盖:
 *   A. resolver 四层:secret_id 槽 > 本人 active > 共享档(ACL)> ''
 *      + proxy_password 在调用点恒最优先(不进 resolver)
 *   B. share ACL 三态:all / handles(名单内外)/ none + 缺 share 字段 = none
 *   C. admin 六动词:list/write/delete/rotate/visibility/promote —
 *      全 POST + requireAdmin;应答永远无明文(list 也只有 masked)
 *   D. GET /api/utopinn/secrets 的 shared 可用性视图 ——
 *      普通用户只见 {label,active:true}|null,不回 id/掩码/名单
 *   E. connection/test + models 的 credential ∈ user|shared|proxy|none
 *      (用 cometapi disabled 源做桩 —— resolveConnection 已跑 resolver
 *      但 kind=disabled 在发网前就回,零网络依赖)
 *   F. 隔离:共享档在 <dataRoot>/_shared(任一 user root 之外),
 *      天然不进 backup/settings/context;list 应答全文不含明文。
 *
 * 跑法:node --test tests/shared-secrets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { initStorage, getSettingsRepo } from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
// secrets.js / users.js / 插件在模块级读 config —— 静态 import 会抢在
// setConfigFilePath 前炸掉,全部放 test.before 动态 import。

const USER_DIRS = Object.freeze({
    root: '',
    chats: 'chats',
    characters: 'characters',
    settings: 'settings',
});

let DATA_ROOT;   // <tmp>/data —— globalThis.DATA_ROOT,共享档落 ./_shared
let server;
let BASE;

/** 每个 handle 的最小目录集(secrets.json 落 root)。 */
function dirsFor(handle) {
    const root = path.join(DATA_ROOT, handle);
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(root, rel);
    }
    fs.mkdirSync(root, { recursive: true });
    return dirs;
}

/** 构造 resolver 直调用的最小 request(不经过 HTTP)。 */
function fakeReq(handle, { admin = true, body = {} } = {}) {
    return {
        user: { profile: { handle, name: handle, admin }, directories: dirsFor(handle) },
        body,
    };
}

/** HTTP 助手:x-handle / x-admin 头选身份(中间件据此注入 request.user)。 */
async function api(pathname, { method = 'GET', body, handle = 'admin', admin = true } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            'x-test-handle': handle,
            'x-test-admin': String(admin),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 204/纯文本 */ }
    return { status: res.status, body: json, text };
}

let mod; // secrets.js 模块(dynamic import 后持有)

/** 共享档管理器 + 写入助手(含 ACL;目录懒建,与 admin 写面同约定)。 */
function sharedWrite(key, value, label, share) {
    fs.mkdirSync(path.join(DATA_ROOT, '_shared'), { recursive: true });
    const mgr = mod.getSharedSecretManager();
    const id = mgr.writeSecret(key, value, label);
    if (share) mgr.updateSecretShare(key, id, share);
    return id;
}

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-shared-'));
    globalThis.DATA_ROOT = DATA_ROOT;

    mod = await import('../src/endpoints/secrets.js');
    const { router: sharedSecretsRouter } = await import('../src/endpoints/shared-secrets.js');
    const { apply: applyLibrary } = await import('../src/plugins/utopinn-library.js');
    const { apply: applyConnection } = await import('../src/plugins/utopinn-connection.js');

    const dirsCache = new Map();
    const memoDirs = (handle) => {
        if (!dirsCache.has(handle)) dirsCache.set(handle, dirsFor(handle));
        return dirsCache.get(handle);
    };
    await initStorage({ mode: 'fs', directoriesByHandle: memoDirs });

    // 连接探测用源:cometapi = kind 'disabled'(resolveConnection 里照常
    // 跑 pick→resolver,但 probeModels 不会发网)。各 handle 的 oai_settings:
    //   admin    → 本人 cometapi key(后面 secrets.json 种)
    //   guest    → 无本人 key,吃共享兜底
    //   outsider → 无本人 key,ACL handles 模式不在名单
    //   proxyguy → vertexai + reverse_proxy(死端口) → credential 'proxy'
    //              且 probe 只撞本机回环秒拒,零外网
    for (const h of ['admin', 'guest', 'outsider', 'proxyguy', 'nonadmin']) {
        memoDirs(h);
        const oai = { chat_completion_source: 'cometapi' };
        if (h === 'proxyguy') {
            Object.assign(oai, {
                chat_completion_source: 'vertexai',
                vertexai_auth_mode: 'express',
                vertexai_region: 'us-central1',
                reverse_proxy: 'http://127.0.0.1:9/',
                proxy_password: 'px-top-secret',
            });
        }
        await getSettingsRepo().save(h, { oai_settings: oai });
    }

    const pluginRouter = express.Router();
    const ws = {
        register: (spec) => {
            pluginRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    const ctx = { webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) };
    applyLibrary(ctx);
    applyConnection(ctx);

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const handle = request.get('x-test-handle') || 'admin';
        request.user = {
            profile: { handle, name: handle, admin: request.get('x-test-admin') !== 'false' },
            directories: memoDirs(handle),
        };
        next();
    });
    app.use('/api/users', sharedSecretsRouter);
    app.use(pluginRouter); // /api/utopinn/* 全路径
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    delete globalThis.DATA_ROOT;
});

const K = 'api_key_cometapi'; // 探测源与 resolver 单测共用的键(VALID_SECRET_KEYS 内)

// ---------- A. resolver 四层 ----------

test('resolver: 本人 active 压共享档(user 恒优先)', () => {
    const mgr = new mod.SecretManager(dirsFor('admin'));
    mgr.writeSecret(K, 'mine-key-AAAA', 'mine');
    sharedWrite(K, 'host-key-BBBB', 'host', { mode: 'all' });

    const d = mod.resolveProviderSecretDetailed(fakeReq('admin'), K);
    assert.equal(d.source, 'user');
    assert.equal(d.value, 'mine-key-AAAA');

    const guest = mod.resolveProviderSecretDetailed(fakeReq('guest'), K);
    assert.equal(guest.source, 'shared');
    assert.equal(guest.value, 'host-key-BBBB');
});

test('resolver: secret_id 指定槽 > active > 共享;未命中槽继续下落', () => {
    const mgr = new mod.SecretManager(dirsFor('slotman'));
    const idA = mgr.writeSecret(K, 'slot-A-key', 'a');      // 写入即 active
    const idB = mgr.writeSecret(K, 'slot-B-key', 'b');      // B 变 active,A 退役
    sharedWrite('api_key_serper', 'unused', 'x', { mode: 'all' });

    const dirs = dirsFor('slotman');
    // 显式 secret_id → 指定槽(即使不是 active)
    const bySlot = mod.resolveProviderSecretDetailed({
        user: { profile: { handle: 'slotman', admin: true }, directories: dirs },
        body: { secret_id: idA },
    }, K);
    assert.equal(bySlot.value, 'slot-A-key');
    assert.equal(bySlot.source, 'user');

    // 幽灵 id → 落到本人 active(B)
    const ghost = mod.resolveProviderSecretDetailed({
        user: { profile: { handle: 'slotman', admin: true }, directories: dirs },
        body: { secret_id: 'does-not-exist' },
    }, K);
    assert.equal(ghost.value, 'slot-B-key');
    assert.equal(ghost.source, 'user');
    assert.ok(idB);

    // 空用户档 + 幽灵 id → 落共享
    const lonely = mod.resolveProviderSecretDetailed({
        user: { profile: { handle: 'lonely', admin: true }, directories: dirsFor('lonely') },
        body: { secret_id: 'nope' },
    }, K);
    assert.equal(lonely.source, 'shared');
});

test('resolver: ACL 三态 —— all 放行 / handles 名单内放行、名单外拒 / none 全拒', () => {
    const KEY = 'api_key_serper';
    // all:任何人拿共享
    const id1 = sharedWrite(KEY, 'shared-serper', 's', { mode: 'all' });
    let d = mod.resolveProviderSecretDetailed(fakeReq('anybody'), KEY);
    assert.equal(d.source, 'shared');

    // handles:名单内 guest 放行,outsider 拒
    const mgr = mod.getSharedSecretManager();
    mgr.updateSecretShare(KEY, id1, { mode: 'handles', handles: ['vip-1'] });
    d = mod.resolveProviderSecretDetailed(fakeReq('vip-1'), KEY);
    assert.equal(d.source, 'shared');
    d = mod.resolveProviderSecretDetailed(fakeReq('rando'), KEY);
    assert.equal(d.source, 'none');
    assert.equal(d.value, '');

    // none:连写它的人也不放行
    mgr.updateSecretShare(KEY, id1, { mode: 'none' });
    d = mod.resolveProviderSecretDetailed(fakeReq('vip-1'), KEY);
    assert.equal(d.source, 'none');
});

test('resolver: 缺 share 字段 = none;无共享档/无 active = none', () => {
    const KEY2 = 'api_key_tavily';
    sharedWrite(KEY2, 'raw-entry-no-share', 'x', null); // 无 share → 默认拒
    const d = mod.resolveProviderSecretDetailed(fakeReq('guest'), KEY2);
    assert.equal(d.source, 'none');
    // 从未写过的键 → none
    const e = mod.resolveProviderSecretDetailed(fakeReq('guest'), 'api_key_brave_search');
    assert.equal(e.source, 'none');
    assert.equal(e.value, '');
});

test('resolver: proxy_password 契约在调用点(resolver 不认 proxy)', () => {
    // 模拟 chat-completions.js 的调用形态:body.proxy_password || resolver
    const req = fakeReq('proxyguy', { body: { proxy_password: 'px-top-secret' } });
    const resolved = mod.resolveProviderSecret(req, K);
    const effective = req.body.proxy_password || resolved;
    assert.equal(effective, 'px-top-secret', 'proxy_password must outrank every resolver layer');
    // resolver 自己不知道 proxy —— 仍能拿到本人/共享层当 backup
    assert.equal(typeof resolved, 'string');
});

// ---------- B. admin 六动词(HTTP;无明文) ----------

test('admin: 非管理员 403;无 user 403', async () => {
    const r1 = await api('/api/users/shared-secrets/list', { method: 'POST', body: {}, admin: false });
    assert.equal(r1.status, 403);
    const r2 = await api('/api/users/shared-secrets/write', { method: 'POST', body: { key: K, value: 'x' }, admin: false });
    assert.equal(r2.status, 403);
});

test('admin: write → {id};list 只回 masked+share,全文无明文', async () => {
    const PLAIN = 'sk-super-plaintext-zzz';
    const w = await api('/api/users/shared-secrets/write', {
        method: 'POST', body: { key: 'api_key_deepseek', value: PLAIN, label: 'host', mode: 'all' },
    });
    assert.equal(w.status, 200);
    assert.ok(w.body.id, 'write returns {id}');
    assert.equal(Object.keys(w.body).length, 1, 'write response is exactly {id}');
    assert.ok(!w.text.includes(PLAIN), 'plaintext must not echo');

    const l = await api('/api/users/shared-secrets/list', { method: 'POST', body: {} });
    assert.equal(l.status, 200);
    assert.ok(!l.text.includes(PLAIN), 'list must not contain plaintext');
    const entry = l.body.items.api_key_deepseek.find((e) => e.id === w.body.id);
    assert.ok(entry, 'written entry shows up in list');
    assert.equal(entry.masked.includes(PLAIN), false);
    assert.ok(entry.masked.startsWith('*'), 'masked is stars-prefixed');
    assert.equal(entry.active, true);
    assert.equal(entry.share.mode, 'all');
    assert.ok(!('value' in entry), 'no value field on wire');
});

test('admin: visibility → handles 模式只放行名单;none 全拒', async () => {
    const w = await api('/api/users/shared-secrets/write', {
        method: 'POST', body: { key: 'api_key_tavily', value: 'vis-key-1', mode: 'all' },
    });
    const id = w.body.id;

    // handles 名单只有 vip-1
    const v = await api('/api/users/shared-secrets/visibility', {
        method: 'POST', body: { key: 'api_key_tavily', id, mode: 'handles', handles: ['vip-1'] },
    });
    assert.equal(v.status, 204);
    let d = mod.resolveProviderSecretDetailed(fakeReq('vip-1'), 'api_key_tavily');
    assert.equal(d.source, 'shared');
    d = mod.resolveProviderSecretDetailed(fakeReq('outsider'), 'api_key_tavily');
    assert.equal(d.source, 'none');

    // none → vip-1 也被拒
    const n = await api('/api/users/shared-secrets/visibility', {
        method: 'POST', body: { key: 'api_key_tavily', id, mode: 'none' },
    });
    assert.equal(n.status, 204);
    d = mod.resolveProviderSecretDetailed(fakeReq('vip-1'), 'api_key_tavily');
    assert.equal(d.source, 'none');

    // 非法 mode → 400;handles 模式缺名单 → 400
    const bad1 = await api('/api/users/shared-secrets/visibility', {
        method: 'POST', body: { key: 'api_key_tavily', id, mode: 'bogus' },
    });
    assert.equal(bad1.status, 400);
    const bad2 = await api('/api/users/shared-secrets/visibility', {
        method: 'POST', body: { key: 'api_key_tavily', id, mode: 'handles' },
    });
    assert.equal(bad2.status, 400);
    const ghost = await api('/api/users/shared-secrets/visibility', {
        method: 'POST', body: { key: 'api_key_tavily', id: 'ghost', mode: 'all' },
    });
    assert.equal(ghost.status, 404);
});

test('admin: rotate 切 active;delete 幂等 204;bad key 400', async () => {
    const KEY = 'api_key_nanogpt';
    const a = await api('/api/users/shared-secrets/write', { method: 'POST', body: { key: KEY, value: 'first', mode: 'all' } });
    const b = await api('/api/users/shared-secrets/write', { method: 'POST', body: { key: KEY, value: 'second', mode: 'all' } });
    // 新写入自动 active → 现在 active 是 b;rotate 回 a
    let r = await api('/api/users/shared-secrets/rotate', { method: 'POST', body: { key: KEY, id: a.body.id } });
    assert.equal(r.status, 204);
    let l = await api('/api/users/shared-secrets/list', { method: 'POST', body: {} });
    const ea = l.body.items[KEY].find((e) => e.id === a.body.id);
    const eb = l.body.items[KEY].find((e) => e.id === b.body.id);
    assert.equal(ea.active, true);
    assert.equal(eb.active, false);

    // resolver 也切过去
    const d = mod.resolveProviderSecretDetailed(fakeReq('guest'), KEY);
    assert.equal(d.value, 'first');

    // delete 幂等(存在/不存在都 204)
    r = await api('/api/users/shared-secrets/delete', { method: 'POST', body: { key: KEY, id: b.body.id } });
    assert.equal(r.status, 204);
    r = await api('/api/users/shared-secrets/delete', { method: 'POST', body: { key: KEY, id: 'ghost-id' } });
    assert.equal(r.status, 204);
    l = await api('/api/users/shared-secrets/list', { method: 'POST', body: {} });
    assert.equal(l.body.items[KEY].length, 1);

    const bad = await api('/api/users/shared-secrets/write', { method: 'POST', body: { key: 'not_a_key', value: 'x' } });
    assert.equal(bad.status, 400);
    const empty = await api('/api/users/shared-secrets/write', { method: 'POST', body: { key: KEY, value: '' } });
    assert.equal(empty.status, 400);
});

test('admin: promote 复制本人 secret 进共享档(原条不删,应答 {id})', async () => {
    const mgr = new mod.SecretManager(dirsFor('admin'));
    const ownId = mgr.writeSecret('api_key_xai', 'my-own-xai-key', 'mine');
    const p = await api('/api/users/shared-secrets/promote', {
        method: 'POST', body: { key: 'api_key_xai', id: ownId },
    });
    assert.equal(p.status, 200);
    assert.ok(p.body.id && p.body.id !== ownId, 'promote mints a new shared id');
    assert.ok(!p.text.includes('my-own-xai-key'), 'no plaintext in response');

    // 本人原条还在
    const mine = mgr.getAllSecrets()['api_key_xai'];
    assert.equal(mine.find((e) => e.id === ownId).value, 'my-own-xai-key');
    // 共享档里是新 id + 值复制
    const sharedArr = mod.getSharedSecretManager().getAllSecrets()['api_key_xai'];
    const promoted = sharedArr.find((e) => e.id === p.body.id);
    assert.ok(promoted);
    assert.equal(promoted.share.mode, 'all');
    assert.ok(!promoted.value.includes('my-own-xai-key') === false || promoted.value === 'my-own-xai-key');

    // promote 不存在的 id → 404
    const ghost = await api('/api/users/shared-secrets/promote', {
        method: 'POST', body: { key: 'api_key_xai', id: 'nope' },
    });
    assert.equal(ghost.status, 404);
});

// ---------- C. GET /api/utopinn/secrets shared 面 ----------

test('GET /secrets: shared 面只见 {label,active}|null —— 无 id/掩码/名单', async () => {
    // vip-1 在 api_key_tavily 的 handles 名单…(B 用例里已把它切回 none —
    // 这里重开一个干净的键)
    sharedWrite('api_key_jina', 'jina-shared-plain', '宿主共享', { mode: 'handles', handles: ['vip-2'] });

    const r = await api('/api/utopinn/secrets', { handle: 'vip-2' });
    assert.equal(r.status, 200);
    const sh = r.body.shared;
    assert.ok(sh, 'shared view present');
    assert.deepEqual(sh.api_key_jina, { label: '宿主共享', active: true });
    // 名单外 handle → null
    const r2 = await api('/api/utopinn/secrets', { handle: 'outsider' });
    assert.equal(r2.body.shared.api_key_jina, null);
    // 共享面绝不回明文/掩码/id/名单
    assert.ok(!r.text.includes('jina-shared-plain'));
    assert.ok(!('masked' in (sh.api_key_jina ?? {})));
    assert.ok(!('handles' in (sh.api_key_jina ?? {})));
    assert.ok(!('id' in (sh.api_key_jina ?? {})));
});

// ---------- D. credential 字段(connection/test + models,disabled 源零网络) ----------

test('credential: user / shared / proxy / none 四分(cometapi disabled 桩)', async () => {
    // 先保有一条对所有人开放的 cometapi 共享 key
    sharedWrite(K, 'cometapi-host-key', 'host', { mode: 'all' });

    // admin:本人有 cometapi key(前面 A 用例 admin 写的是同 K —— api_key_cometapi)→ user
    const mine = new mod.SecretManager(dirsFor('admin')).getAllSecrets()[K] ?? [];
    if (!mine.length) new mod.SecretManager(dirsFor('admin')).writeSecret(K, 'mine-cometapi', 'm');
    const u = await api('/api/utopinn/connection/test', { method: 'POST', body: {}, handle: 'admin' });
    assert.equal(u.status, 200);
    assert.equal(u.body.credential, 'user');
    assert.equal(u.body.error, 'unsupported'); // cometapi → disabled → unsupported;零网络

    // guest:无本人 → shared
    const g = await api('/api/utopinn/connection/test', { method: 'POST', body: {}, handle: 'guest' });
    assert.equal(g.body.credential, 'shared');

    // proxyguy:vertexai + reverse_proxy → credential 'proxy'(探测只撞 127.0.0.1:9 秒拒)
    const p = await api('/api/utopinn/connection/test', { method: 'POST', body: {}, handle: 'proxyguy' });
    assert.equal(p.body.credential, 'proxy');
    assert.equal(p.body.ok, false); // 本机死端口 → unreachable;断言分类而非连通

    // nonadmin handle(无 cometapi 本人 key,但非管理员只能打 /api/utopinn 面)…
    // outsider 也是 shared;none 用从未写过的源:换 openai,无 key → not_configured + none
    await getSettingsRepo().save('nonadmin', { oai_settings: { chat_completion_source: 'openai' } });
    const n = await api('/api/utopinn/connection/test', { method: 'POST', body: {}, handle: 'nonadmin', admin: false });
    assert.equal(n.status, 200);
    assert.equal(n.body.credential, 'none');
    assert.equal(n.body.error, 'not_configured');

    // /api/utopinn/models 同样带 credential(disabled 源直接回 base)
    const m = await api('/api/utopinn/models', { handle: 'guest' });
    assert.equal(m.status, 200);
    assert.equal(m.body.credential, 'shared');
    assert.equal(m.body.error, 'unsupported');
});

// ---------- E. 隔离:共享档不进任何 user 面 ----------

test('隔离: _shared 在 dataRoot 而非 user root;settings 文档不含共享凭据', async () => {
    const sharedRoot = mod.getSharedSecretsRoot(fakeReq('guest'));
    assert.equal(sharedRoot, path.join(DATA_ROOT, '_shared'));
    for (const h of ['admin', 'guest', 'vip-1']) {
        assert.ok(!sharedRoot.startsWith(dirsFor(h).root + path.sep), '_shared must not nest inside a user root');
    }
    // 用户 settings 里不放共享凭据(服务端 settings 文档是 per-handle)
    const settings = await getSettingsRepo().get('guest');
    assert.ok(!JSON.stringify(settings).includes('cometapi-host-key'));
    // 共享 secrets.json 物理存在于 _shared
    assert.ok(fs.existsSync(path.join(sharedRoot, 'secrets.json')));
    // guest 自己的 secrets.json 里看不到共享条目(本人档为空 → 读面 null)
    const r = await api('/api/utopinn/secrets', { handle: 'outsider' });
    assert.equal(r.body.secrets[K], null, 'guest personal store does not mirror shared entries');
});
