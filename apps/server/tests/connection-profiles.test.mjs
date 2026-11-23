/**
 * connection profiles —— 档案制核心单测(node:test,纯函数面):
 *   resolveConnectionDispatch:profile 覆盖袋 + anti-bleed + 模型兜底序
 *   + 旧单槽兜底;readConnectionProfiles/readActiveModel 归一化;
 *   synthesizeLegacyProfile 迁移合成(含旧键不删、模型/端点/格式映射)。
 * 跑法:node --test tests/connection-profiles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let CONNECTION_KEYS;
let PROFILE_FORMATS;
let readConnectionProfiles;
let readActiveModel;
let resolveActiveProfile;
let profileDispatchBag;
let resolveConnectionDispatch;
let presetToDispatchParams;
let synthesizeLegacyProfile;
let sanitizeProfileInput;
let ensureConnectionProfiles;

/* —— 路由级面(initStorage + 真 express 挂 connection/library 插件)—— */
let DATA_ROOT;
let server;
let BASE;
let getSettingsRepoFn;
let getSharedSecretManagerFn;
const HANDLE = 'u1';

function dirsFor(handle) {
    const root = path.join(DATA_ROOT, handle);
    fs.mkdirSync(root, { recursive: true });
    return { root, chats: path.join(root, 'chats'), characters: path.join(root, 'characters'), settings: path.join(root, 'settings') };
}

// secrets.js 链模块级读 config —— 先 setConfigFilePath 再动态 import。
test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-prof-'));
    globalThis.DATA_ROOT = DATA_ROOT;

    const mod = await import('../src/services/connection-dispatch.js');
    ({
        CONNECTION_KEYS,
        PROFILE_FORMATS,
        readConnectionProfiles,
        readActiveModel,
        resolveActiveProfile,
        profileDispatchBag,
        resolveConnectionDispatch,
        presetToDispatchParams,
        synthesizeLegacyProfile,
        sanitizeProfileInput,
        ensureConnectionProfiles,
    } = mod);

    const storage = await import('../src/storage/index.js');
    getSettingsRepoFn = storage.getSettingsRepo;
    const dirsCache = new Map();
    const memoDirs = (h) => {
        if (!dirsCache.has(h)) dirsCache.set(h, dirsFor(h));
        return dirsCache.get(h);
    };
    await storage.initStorage({ mode: 'fs', directoriesByHandle: memoDirs });
    getSharedSecretManagerFn = (await import('../src/endpoints/secrets.js')).getSharedSecretManager;

    const { apply: applyConnection } = await import('../src/plugins/utopinn-connection.js');
    const { apply: applyLibrary } = await import('../src/plugins/utopinn-library.js');
    const pluginRouter = express.Router();
    const ws = { register: (spec) => { pluginRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler); return () => {}; } };
    const ctx = { webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) };
    applyConnection(ctx);
    applyLibrary(ctx);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: HANDLE, name: HANDLE, admin: true }, directories: memoDirs(HANDLE) };
        next();
    });
    app.use(pluginRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    delete globalThis.DATA_ROOT;
});

async function api(method, p, body) {
    const r = await fetch(`${BASE}${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 204/纯文本 */ }
    return { status: r.status, json };
}

const PROF_DS = {
    id: 'p-ds', name: 'DeepSeek', format: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', secretId: 'sec-1',
    models: { checked: ['deepseek-chat', 'deepseek-reasoner'], manual: ['ds-manual'] },
};
const PROF_CL = {
    id: 'p-cl', name: 'Claude', format: 'anthropic',
    baseUrl: 'https://proxy.example.com', secretId: 'sec-2',
    models: { checked: [], manual: ['claude-opus-4'] },
};

function oaiWith(profiles, activeModel = null) {
    return {
        chat_completion_source: 'openai',
        openai_model: 'gpt-legacy',
        reverse_proxy: 'https://old-proxy.example.com',
        custom_url: 'https://old-custom.example.com',
        proxy_password: 'leak-me-not',
        temperature: 0.7,
        connection_profiles: profiles,
        connection: { activeModel },
    };
}

test('profile dispatch: openai 格式 → custom 源 + anti-bleed 空串', () => {
    const { body, profile } = resolveConnectionDispatch(
        oaiWith([PROF_DS], { profileId: 'p-ds', modelId: 'deepseek-chat' }),
        { temperature: 0.9, chat_completion_source: 'claude' }, // 预设源字段被剥
        {},
    );
    assert.equal(profile?.id, 'p-ds');
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.custom_url, 'https://api.deepseek.com/v1');
    assert.equal(body.reverse_proxy, '');
    assert.equal(body.base_url, '');
    assert.equal(body.proxy_password, '');
    assert.equal(body.secret_id, 'sec-1');
    assert.equal(body.profile_id, 'p-ds');
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.temperature, 0.9); // 预设参数照吃
});

test('profile dispatch: anthropic 格式 → claude 源 + url 走 reverse_proxy', () => {
    const { body, profile } = resolveConnectionDispatch(
        oaiWith([PROF_CL], { profileId: 'p-cl', modelId: 'claude-opus-4' }),
        {},
        {},
    );
    assert.equal(profile?.id, 'p-cl');
    assert.equal(body.chat_completion_source, 'claude');
    assert.equal(body.reverse_proxy, 'https://proxy.example.com');
    assert.equal(body.custom_url, '');
    assert.equal(body.base_url, '');
    assert.equal(body.secret_id, 'sec-2');
    assert.equal(body.model, 'claude-opus-4');
});

test('profile dispatch: anthropic 空 baseUrl → 官方端点(空串照传)', () => {
    const p = { ...PROF_CL, baseUrl: '' };
    const { body } = resolveConnectionDispatch(
        oaiWith([p], { profileId: 'p-cl', modelId: 'm' }), {}, {},
    );
    assert.equal(body.chat_completion_source, 'claude');
    assert.equal(body.reverse_proxy, '');
});

test('模型兜底序:body.model > activeModel.modelId > checked[0] > manual[0]', () => {
    const oai = oaiWith([PROF_DS], { profileId: 'p-ds', modelId: 'deepseek-reasoner' });
    // body.model 显式压一切
    assert.equal(resolveConnectionDispatch(oai, {}, { model: 'explicit' }).body.model, 'explicit');
    // activeModel.modelId
    assert.equal(resolveConnectionDispatch(oai, {}, {}).body.model, 'deepseek-reasoner');
    // checked[0]
    const oai2 = oaiWith([PROF_DS], { profileId: 'p-ds', modelId: '' });
    assert.equal(resolveConnectionDispatch(oai2, {}, { profile_id: 'p-ds' }).body.model, 'deepseek-chat');
    // manual[0](checked 空)
    const p3 = { ...PROF_DS, models: { checked: [], manual: ['ds-manual'] } };
    assert.equal(resolveConnectionDispatch(oaiWith([p3]), {}, { profile_id: 'p-ds' }).body.model, 'ds-manual');
});

test('profile 选择:body.profile_id > activeModel.profileId;disabled 不命中', () => {
    const oai = oaiWith([PROF_DS, PROF_CL], { profileId: 'p-cl', modelId: 'claude-opus-4' });
    // 显式指 p-ds 压过指针 p-cl
    assert.equal(resolveConnectionDispatch(oai, {}, { profile_id: 'p-ds' }).profile?.id, 'p-ds');
    // 指针生效
    assert.equal(resolveConnectionDispatch(oai, {}, {}).profile?.id, 'p-cl');
    // disabled 档不可选 → 掉回旧单槽
    const oai2 = oaiWith([{ ...PROF_DS, disabled: true }], { profileId: 'p-ds', modelId: 'x' });
    const r = resolveConnectionDispatch(oai2, {}, {});
    assert.equal(r.profile, null);
    assert.equal(r.body.chat_completion_source, 'openai'); // legacy 面
});

test('旧单槽兜底:无 profile / 无指针 → 与修前逐字同构', () => {
    const oai = {
        chat_completion_source: 'deepseek',
        deepseek_model: 'deepseek-v3',
        temperature: 0.5,
    };
    const { body, profile } = resolveConnectionDispatch(oai, { temperature: 0.9 }, {});
    assert.equal(profile, null);
    assert.equal(body.chat_completion_source, 'deepseek');
    assert.equal(body.model, 'deepseek-v3');
    assert.equal(body.temperature, 0.9);
    // 空 oai → source 'openai',model null
    const r2 = resolveConnectionDispatch({}, {}, {});
    assert.equal(r2.profile, null);
    assert.equal(r2.body.chat_completion_source, 'openai');
    assert.equal(r2.body.model, null);
});

test('presetToDispatchParams:connection_profiles/connection/profile_id 在剥除集内', () => {
    assert.ok(CONNECTION_KEYS.has('connection_profiles'));
    assert.ok(CONNECTION_KEYS.has('connection'));
    assert.ok(CONNECTION_KEYS.has('profile_id'));
    const out = presetToDispatchParams({
        temperature: 1, connection_profiles: [{ id: 'x' }],
        connection: { activeModel: { profileId: 'x', modelId: 'y' } },
        profile_id: 'x', model: 'wire-model',
    });
    assert.deepEqual(out, { temperature: 1 }); // model 是 wire 键本就不透传
});

test('readConnectionProfiles 归一化:脏条丢弃/models 三槽归位/lastProbe 保留', () => {
    const out = readConnectionProfiles({
        connection_profiles: [
            null, 'x', { name: 'no id' },
            {
                id: ' a ', name: '', format: 'weird', baseUrl: ' u ',
                secretId: ' ', models: { checked: ['m1', ' m1 ', '  '], manual: 'no', lastProbe: { at: '5', ok: 1, items: [{ id: 'x' }, 'y', {}] } },
                disabled: 1,
            },
        ],
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
        id: 'a', name: 'a', format: 'openai', baseUrl: 'u', secretId: null,
        models: { checked: ['m1'], manual: [], lastProbe: { at: 5, ok: true, items: [{ id: 'x' }, { id: 'y' }] } },
        disabled: true,
    });
});

test('readActiveModel / resolveActiveProfile 边界', () => {
    assert.equal(readActiveModel({}), null);
    assert.equal(readActiveModel({ connection: { activeModel: { profileId: 'p' } } }), null);
    assert.deepEqual(
        readActiveModel({ connection: { activeModel: { profileId: 'p', modelId: 'm' } } }),
        { profileId: 'p', modelId: 'm' },
    );
    assert.equal(resolveActiveProfile(oaiWith([], null), {}), null);
});

test('resolveActiveProfile:显式指档须命中;指针悬空/缺失 → 首个未停用档兜底', () => {
    // 显式 profile_id 点名落空 → null 不猜别档(防 key 打错端点)
    assert.equal(resolveActiveProfile(oaiWith([PROF_DS]), { profile_id: 'ghost' }), null);
    // 指针悬(指向不存在档)→ 顺延首个未停用档
    assert.equal(
        resolveActiveProfile(oaiWith([PROF_DS], { profileId: 'ghost', modelId: 'm' }), {})?.id,
        'p-ds',
    );
    // 无指针 → 首个未停用档(quiet/trigger/CLI 无 profile_id 与 web 兜底同语义)
    assert.equal(
        resolveActiveProfile(oaiWith([PROF_DS, PROF_CL], null), {})?.id,
        'p-ds',
    );
    // 指针档被停用 → 顺延到未停用的
    assert.equal(
        resolveActiveProfile(
            oaiWith([{ ...PROF_DS, disabled: true }, PROF_CL], { profileId: 'p-ds', modelId: 'x' }),
            {},
        )?.id,
        'p-cl',
    );
    // 全停用 → null(回 legacy)
    assert.equal(
        resolveActiveProfile(oaiWith([{ ...PROF_DS, disabled: true }], null), {}),
        null,
    );
});

test('profileDispatchBag:格式映射 + 袋内 profile_id/model', () => {
    const o = profileDispatchBag(PROF_DS, 'm1');
    assert.equal(o.chat_completion_source, 'custom');
    assert.equal(o.profile_id, 'p-ds');
    assert.equal(o.model, 'm1');
    const c = profileDispatchBag(PROF_CL, null);
    assert.equal(c.chat_completion_source, 'claude');
    assert.equal(c.custom_url, '');
    assert.equal(c.model, null);
    assert.ok(PROFILE_FORMATS.includes('openai') && PROFILE_FORMATS.includes('anthropic'));
});

test('synthesizeLegacyProfile:openai 生态源 → openai 格式 + 官方端点物化', () => {
    const p = synthesizeLegacyProfile({
        chat_completion_source: 'deepseek',
        deepseek_model: 'deepseek-chat',
    });
    assert.equal(p.id, 'default');
    assert.equal(p.format, 'openai');
    assert.equal(p.baseUrl, 'https://api.deepseek.com/v1');
    assert.deepEqual(p.models.checked, ['deepseek-chat']);
    assert.equal(p.secretId, null); // 无 secrets 面 → null 占位
});

test('synthesizeLegacyProfile:claude 源 → anthropic 格式 + reverse_proxy 直通', () => {
    const p = synthesizeLegacyProfile({
        chat_completion_source: 'claude',
        claude_model: 'claude-sonnet-4',
        reverse_proxy: 'https://rp.example.com',
    });
    assert.equal(p.format, 'anthropic');
    assert.equal(p.baseUrl, 'https://rp.example.com');
    assert.deepEqual(p.models.checked, ['claude-sonnet-4']);
});

test('synthesizeLegacyProfile:custom 源取 custom_url;空配置 → 空档', () => {
    const p = synthesizeLegacyProfile({ chat_completion_source: 'custom', custom_url: 'https://c.example.com/v1', custom_model: 'x' });
    assert.equal(p.format, 'openai');
    assert.equal(p.baseUrl, 'https://c.example.com/v1');
    assert.deepEqual(p.models.checked, ['x']);
    const empty = synthesizeLegacyProfile({});
    assert.equal(empty.id, 'default');
    assert.equal(empty.baseUrl, '');
    assert.deepEqual(empty.models.checked, []);
    assert.deepEqual(empty.models.manual, []);
});

test('sanitizeProfileInput:upsert 归一化(保留 lastProbe/models 当未给)', () => {
    const existing = {
        id: 'p1', name: 'old', format: 'anthropic', baseUrl: 'b', secretId: 's',
        models: { checked: ['m'], manual: ['n'], lastProbe: { at: 1, ok: true, items: [] } },
    };
    // 空 body → 全保留
    assert.deepEqual(sanitizeProfileInput({}, { existing, id: 'p1' }), existing);
    // 部分写:name+disabled;models/lastProbe 不动
    const r = sanitizeProfileInput({ name: 'new', disabled: false }, { existing, id: 'p1' });
    assert.equal(r.name, 'new');
    assert.equal(r.disabled, false); // 显式 false 落 false(解除停用)
    // models 未给 → 保留含 lastProbe
    assert.deepEqual(r.models, existing.models);
    // models 给了 → checked/manual 覆盖;lastProbe 簿记保留;format 非法 → 沿用旧
    const r2 = sanitizeProfileInput({ format: 'nope', models: { checked: ['a'] } }, { existing, id: 'p1' });
    assert.equal(r2.format, 'anthropic');
    assert.deepEqual(r2.models.checked, ['a']);
    assert.equal(r2.models.manual.length, 0);
    assert.deepEqual(r2.models.lastProbe, existing.models.lastProbe);
});

/* ------------------------------------------------------------------ */
/* review 返修用例                                                      */
/* ------------------------------------------------------------------ */

test('迁移:特殊派发源不合成(fireworks/makersuite/vertexai/azure/cometapi/…)', () => {
    for (const src of ['fireworks', 'makersuite', 'vertexai', 'azure_openai', 'workers_ai', 'pollinations', 'cohere', 'openai_responses', 'cometapi']) {
        assert.equal(
            synthesizeLegacyProfile({ chat_completion_source: src, [`${src}_model`]: 'm' }),
            null,
            `${src} should not migrate`,
        );
    }
});

test('迁移:proxy_password 非空 → 不合成(字段层凭据 profile 无槽)', () => {
    assert.equal(
        synthesizeLegacyProfile({ chat_completion_source: 'deepseek', proxy_password: 'px', deepseek_model: 'm' }),
        null,
    );
    // 空串/缺省 → 照常迁移
    assert.ok(synthesizeLegacyProfile({ chat_completion_source: 'deepseek', proxy_password: '', deepseek_model: 'm' }));
    assert.ok(synthesizeLegacyProfile({ chat_completion_source: 'deepseek', deepseek_model: 'm' }));
});

test('ensureConnectionProfiles:键缺失才迁移;显式 [] 不重合成', async () => {
    // fake repo(内存版;getDoc 读 update 后的新对象)
    const mkRepo = (initial) => {
        let doc = initial;
        return {
            get: async () => doc,
            update: async (_h, fn) => { doc = fn(structuredClone(doc)); return doc; },
            getDoc: () => doc,
        };
    };
    const mkReq = () => ({ user: { profile: { handle: 'h' }, directories: null } });

    // 1) 键缺失 + 可映射源 → 迁移落盘
    const r1 = mkRepo({ oai_settings: { chat_completion_source: 'deepseek', deepseek_model: 'ds' } });
    const out1 = await ensureConnectionProfiles(mkReq(), r1);
    assert.equal(out1.migrated, true);
    assert.equal(out1.profiles[0]?.id, 'default');
    assert.equal(r1.getDoc().oai_settings.connection_profiles.length, 1);

    // 2) 显式 [] → 不重合成(用户删光档语义)
    const r2 = mkRepo({ oai_settings: { chat_completion_source: 'deepseek', connection_profiles: [] } });
    const out2 = await ensureConnectionProfiles(mkReq(), r2);
    assert.equal(out2.migrated, false);
    assert.deepEqual(out2.profiles, []);
    assert.deepEqual(r2.getDoc().oai_settings.connection_profiles, []);

    // 3) 不可映射源 → profiles=[] 且键不落盘(下次重估)
    const r3 = mkRepo({ oai_settings: { chat_completion_source: 'fireworks', fireworks_model: 'f' } });
    const out3 = await ensureConnectionProfiles(mkReq(), r3);
    assert.equal(out3.migrated, false);
    assert.deepEqual(out3.profiles, []);
    assert.equal('connection_profiles' in r3.getDoc().oai_settings, false);

    // 4) 无连接配置 → 合成空 default 档
    const r4 = mkRepo({ oai_settings: { temperature: 0.7 } });
    const out4 = await ensureConnectionProfiles(mkReq(), r4);
    assert.equal(out4.profiles[0]?.id, 'default');
    assert.deepEqual(out4.profiles[0]?.models.checked, []);
});

test('迁移:shared 层凭证 → 不合成(共享档不拷进个人档)', async () => {
    // _shared 面种一条 mode:all 的 api_key_deepseek → resolver 落到 shared 层
    fs.mkdirSync(path.join(DATA_ROOT, '_shared'), { recursive: true });
    const mgr = getSharedSecretManagerFn();
    const id = mgr.writeSecret('api_key_deepseek', 'shared-key', 'host');
    mgr.updateSecretShare('api_key_deepseek', id, { mode: 'all' });
    const request = {
        user: { profile: { handle: 'shared-guy' }, directories: dirsFor('shared-guy') },
    };
    assert.equal(
        synthesizeLegacyProfile(
            { chat_completion_source: 'deepseek', deepseek_model: 'ds' },
            { directories: request.user.directories, request },
        ),
        null,
    );
});

test('路由:PUT profile 移出指针模型 → activeModel 清针', async () => {
    await getSettingsRepoFn().save(HANDLE, {
        oai_settings: {
            connection_profiles: [{
                id: 'p1', name: 'P1', format: 'openai', baseUrl: 'https://x.example.com',
                secretId: null, models: { checked: ['m1'], manual: [] },
            }],
            connection: { activeModel: { profileId: 'p1', modelId: 'm1' } },
        },
    });
    // 勾选面把 m1 换成 m2 → 指针失效 → 服务端清针
    const r = await api('PUT', '/api/utopinn/connection/profiles/p1', {
        models: { checked: ['m2'], manual: [] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.activeModel, null);
    // 指向别档的指针不受影响
    await getSettingsRepoFn().save(HANDLE, {
        oai_settings: {
            connection_profiles: [
                { id: 'p1', name: 'P1', format: 'openai', baseUrl: 'u', secretId: null, models: { checked: ['m2'], manual: [] } },
                { id: 'p2', name: 'P2', format: 'openai', baseUrl: 'u', secretId: null, models: { checked: ['k'], manual: [] } },
            ],
            connection: { activeModel: { profileId: 'p2', modelId: 'k' } },
        },
    });
    const r2 = await api('PUT', '/api/utopinn/connection/profiles/p1', { models: { checked: [], manual: [] } });
    assert.deepEqual(r2.json.activeModel, { profileId: 'p2', modelId: 'k' });
});

test('路由:DELETE 最后一档 → GET 回 [](显式空态不复活)', async () => {
    await getSettingsRepoFn().save(HANDLE, {
        oai_settings: {
            chat_completion_source: 'deepseek',
            deepseek_model: 'ds',
            connection_profiles: [{ id: 'only', name: 'O', format: 'openai', baseUrl: 'u', secretId: null, models: { checked: [], manual: [] } }],
        },
    });
    await api('DELETE', '/api/utopinn/connection/profiles/only');
    const r = await api('GET', '/api/utopinn/connection/profiles');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.profiles, []); // 不被惰性迁移复活
});

test('路由:草稿瞬时 key 剥 missing —— anthropic 空 url 草稿不再 not_configured', async () => {
    /* 复现 review #3:anthropic 空 baseUrl(= 官方默认端点)+ 无 key
       → genericMissingCheck 补 api_key → not_configured 拦门前。 */
    const noKey = await api('POST', '/api/utopinn/connection/test', { format: 'anthropic', baseUrl: '' });
    assert.equal(noKey.json.error, 'not_configured');
    assert.ok((noKey.json.detail ?? '').includes('api_key'));
    /* 同样空 url + 瞬时 key → 剥 missing 进上游探测(真 api.anthropic.com;
       401/unreachable/timeout 都可能,只要不是 not_configured 就证明过闸)。 */
    const withKey = await api('POST', '/api/utopinn/connection/test', { format: 'anthropic', baseUrl: '', key: 'sk-test' });
    assert.equal(withKey.status, 200);
    assert.notEqual(withKey.json.error, 'not_configured');
    assert.equal(withKey.json.credential, 'user');
    /* 死端口草稿有 key → 确定性 unreachable(不过 missing 闸就发不出请求)。 */
    const dead = await api('POST', '/api/utopinn/connection/test', { format: 'anthropic', baseUrl: 'http://127.0.0.1:9/', key: 'x' });
    assert.equal(dead.json.error, 'unreachable');
});

test('路由:PUT /secrets activate:false 不挤池 active 槽', async () => {
    const r1 = await api('PUT', '/api/utopinn/secrets/api_key_custom', { value: 'k-one', label: 'a' });
    assert.equal(r1.status, 200);
    const r2 = await api('PUT', '/api/utopinn/secrets/api_key_custom', { value: 'k-two', label: 'b', activate: false });
    assert.equal(r2.status, 200);
    const entries = r2.json.entries ?? [];
    const e1 = entries.find((e) => e.id === r1.json.id);
    const e2 = entries.find((e) => e.id === r2.json.id);
    assert.equal(e1?.active, true);  // k-one 仍 active(档 B 存 key 不抢)
    assert.equal(e2?.active, false);
    // 显式 activate:true 依旧抢占(旧行为)
    const r3 = await api('PUT', '/api/utopinn/secrets/api_key_custom', { value: 'k-three', activate: true });
    const e3 = (r3.json.entries ?? []).find((e) => e.id === r3.json.id);
    assert.equal(e3?.active, true);
});
