/**
 * /api/utopinn 库/管理 API(utopinn-library.js)集成测试(node:test)。
 * 真 FsEngine + 种子数据 + 真 express + 真 HTTP(fetch 本地端口);
 * request.user 经中间件注入(等价 requireLogin+setUserData 之后的形态)。
 * 跑法:node --test tests/utopinn-library.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { parseChatJsonl, readCardFromPng, writeCardToPng } from '@utopinn/formats';
import {
    getChatRepo,
    getNamedDocRepo,
    getPresetRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    initStorage,
} from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
// 插件经 secrets.js 在模块级读 config —— 静态 import 会抢在 setConfigFilePath 前
// 炸掉,改在 test.before 里动态 import(config 就绪后)。

const HANDLE = 'u1';
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

// 与 tests/storage/harness/fs-harness.js USER_DIRS 同构(FsEngine 按 dirKey 寻址)
const USER_DIRS = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

let ROOT;
let dirs;
let server;
let BASE;
let utopinnLibraryRouter;

const CARD_ALICE = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    name: 'Alice',
    chat: 'c1',
    data: {
        name: 'Alice', description: 'A wandering knight.',
        tags: ['fantasy', 'knight'], first_mes: 'Hail, traveler.',
        extensions: {},
    },
});

async function api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
    // 插件的传递依赖(secrets.js 等)模块级读 config —— 必须在 import 前就绪
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    // 关磁盘卡缓存:node-persist 的 setInterval 会吊着进程退不出
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';
    // wasm-png 的 __wbg_init 走 fetch(file:) —— 本机 undici 无该 scheme;
    // 测试约定 = jitless 纯 JS codec(jimp-jitless.test.js 同旗)。
    process.env.LUKER_FORCE_JITLESS = '1';

    const { apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js');
    utopinnLibraryRouter = express.Router();
    const ws = {
        register: (spec) => {
            utopinnLibraryRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    applyUtopinnLibrary({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-lib-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(ROOT, rel);
    }
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    fs.mkdirSync(dirs.avatars, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    // ---- 种子:角色卡(PNG 内嵌 + 纯 JSON + 无卡数据的坏 PNG) ----
    fs.writeFileSync(
        path.join(dirs.characters, 'Alice.png'),
        writeCardToPng(new Uint8Array(PNG_1PX), CARD_ALICE),
    );
    fs.writeFileSync(
        path.join(dirs.characters, 'Bob.json'),
        JSON.stringify({ name: 'Bob', data: { name: 'Bob', tags: ['sci-fi'] } }),
    );
    fs.writeFileSync(path.join(dirs.characters, 'Broken.png'), PNG_1PX);

    // ---- 种子:会话 ----
    await getChatRepo().save(HANDLE, 'Alice', 'c1',
        { user_name: 'User', character_name: 'Alice', create_date: 1, chat_metadata: { world_info: 'GlobalBook' } },
        [
            { name: 'User', is_user: true, send_date: 2, mes: 'I found a dragon scale.' },
            { name: 'Alice', is_user: false, send_date: 3, mes: 'Keep your voice down.' },
        ],
        null);
    await getChatRepo().save(HANDLE, 'Alice', 'c2',
        { user_name: 'User', character_name: 'Alice', create_date: 4, chat_metadata: {} },
        [{ name: 'User', is_user: true, send_date: 5, mes: 'Hello?' }],
        null);

    // ---- 种子:预设 / 世界书 / settings ----
    await getPresetRepo().save(HANDLE, 'openai', 'Default', {
        openai_model: 'gpt-test', openai_max_tokens: 200, prompts: [],
    });
    await getWorldInfoRepo().save(HANDLE, 'GlobalBook', {
        entries: { '0': { uid: 0, key: ['dragon'], content: 'Dragons once ruled.', order: 100, position: 0 } },
    });
    await getSettingsRepo().save(HANDLE, {
        power_user: {
            personas: { 'ava.png': 'Mia' },
            persona_descriptions: { 'ava.png': { description: 'Curious.', position: 1, title: 'Wanderer' } },
            default_persona: 'ava.png',
            persona_description: 'fallback',
        },
        oai_settings: {
            chat_completion_source: 'openai',
            proxy_password: 'p4ssw0rd',
            custom_include_headers: 'Authorization: Bearer sk-live',
            openai_max_tokens: 300,
        },
        extension_settings: {
            coolExt: { api_key: 'ext-secret', theme: 'dark' },
        },
        world_info: { charLore: [] },
        preset_settings_openai: 'Default',
    });

    // ---- 种子:具名文档桶(TASK-058;桶名走 repo camelCase) ----
    await getNamedDocRepo().save(HANDLE, 'quickReplies', 'Zeta Pack', {
        qrList: [
            { label: 'Yes', message: 'Yes, proceed.' },
            { label: 'Hidden', message: 'ghost', isHidden: true },
        ],
    });
    await getNamedDocRepo().save(HANDLE, 'quickReplies', 'Alpha Pack', { qrList: [] });
    await getNamedDocRepo().save(HANDLE, 'themes', 'midnight', { colors: { bg: '#000' } });

    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
        next();
    });
    app.use(utopinnLibraryRouter); // 插件注册的是 /api/utopinn/* 全路径,根挂
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- Characters ----------

test('GET /characters — lists png + json cards with name/avatar/tags', async () => {
    const { status, body } = await api('/api/utopinn/characters');
    assert.equal(status, 200);
    assert.equal(body.total, 3);
    const byDir = Object.fromEntries(body.items.map((i) => [i.charDir, i]));

    assert.equal(byDir.Alice.name, 'Alice');
    assert.equal(byDir.Alice.avatar, 'Alice.png');
    assert.deepEqual(byDir.Alice.tags, ['fantasy', 'knight']);
    assert.equal(byDir.Alice.readable, true);
    assert.equal(byDir.Alice.chat, 'c1'); // legacy all 语义:卡内当前会话指针
    assert.ok(byDir.Alice.fileSize > 0);

    // 纯 JSON 卡:avatar 为 null,仍能列出
    assert.equal(byDir.Bob.name, 'Bob');
    assert.equal(byDir.Bob.avatar, null);
    assert.deepEqual(byDir.Bob.tags, ['sci-fi']);

    // 坏卡仍列出,readable 标记退化
    assert.equal(byDir.Broken.name, 'Broken');
    assert.equal(byDir.Broken.readable, false);
});

test('GET /characters/:charDir — card doc; 404 on missing; 400 on unsafe', async () => {
    const ok = await api('/api/utopinn/characters/Alice');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.name, 'Alice');
    assert.equal(ok.body.data.description, 'A wandering knight.');

    const jsonOnly = await api('/api/utopinn/characters/Bob');
    assert.equal(jsonOnly.status, 200);
    assert.equal(jsonOnly.body.data.name, 'Bob');

    const missing = await api('/api/utopinn/characters/ghost');
    assert.equal(missing.status, 404);
    assert.ok(missing.body.error);

    const unsafe = await api('/api/utopinn/characters/..%2F..%2Fetc');
    assert.equal(unsafe.status, 400);
    assert.ok(unsafe.body.error);
});

// ---------- Chats ----------

test('GET /characters/:charDir/chats — chat metadata list', async () => {
    const { status, body } = await api('/api/utopinn/characters/Alice/chats');
    assert.equal(status, 200);
    assert.equal(body.total, 2);
    const c1 = body.items.find((i) => i.name === 'c1');
    assert.equal(c1.fileName, 'c1.jsonl');
    assert.equal(c1.messageCount, 2);
    assert.equal(c1.lastMessage.mes, 'Keep your voice down.');
    assert.equal(c1.chatMetadata.world_info, 'GlobalBook');
    assert.ok(c1.integrity);
});

test('GET chat detail — header + messages; .jsonl suffix tolerated; 404s', async () => {
    const ok = await api('/api/utopinn/characters/Alice/chats/c1');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.header.user_name, 'User');
    assert.equal(ok.body.messages.length, 2);
    assert.equal(ok.body.messages[1].mes, 'Keep your voice down.');
    assert.ok(ok.body.integrity);

    const suffixed = await api('/api/utopinn/characters/Alice/chats/c1.jsonl');
    assert.equal(suffixed.status, 200);
    assert.equal(suffixed.body.name, 'c1');

    const missingChat = await api('/api/utopinn/characters/Alice/chats/ghost');
    assert.equal(missingChat.status, 404);
    const missingChar = await api('/api/utopinn/characters/ghost/chats/c1');
    assert.equal(missingChar.status, 404);
    const unsafe = await api('/api/utopinn/characters/Alice/chats/a%2Fb');
    assert.equal(unsafe.status, 400);
});

test('DELETE chat — 204 then gone; ghost chat 404', async () => {
    const del = await api('/api/utopinn/characters/Alice/chats/c2', { method: 'DELETE' });
    assert.equal(del.status, 204);
    const after = await api('/api/utopinn/characters/Alice/chats/c2');
    assert.equal(after.status, 404);
    const again = await api('/api/utopinn/characters/Alice/chats/c2', { method: 'DELETE' });
    assert.equal(again.status, 404);
});

// ---------- Presets ----------

test('GET /presets — apiId validation + list', async () => {
    const ok = await api('/api/utopinn/presets?apiId=openai');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.apiId, 'openai');
    assert.equal(ok.body.total, 1);
    assert.deepEqual(ok.body.items, [{ name: 'Default' }]);

    // apiId 省略时默认 openai
    const dflt = await api('/api/utopinn/presets');
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.total, 1);

    const bad = await api('/api/utopinn/presets?apiId=bogus');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /apiId/);
});

test('GET /presets/:name — doc; 404 missing', async () => {
    const ok = await api('/api/utopinn/presets/Default?apiId=openai');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.name, 'Default');
    assert.equal(ok.body.doc.openai_model, 'gpt-test');

    const missing = await api('/api/utopinn/presets/ghost?apiId=openai');
    assert.equal(missing.status, 404);
});

// ---------- World books ----------

test('GET /worlds — list + doc + 404', async () => {
    const list = await api('/api/utopinn/worlds');
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].name, 'GlobalBook');

    const doc = await api('/api/utopinn/worlds/GlobalBook');
    assert.equal(doc.status, 200);
    assert.equal(doc.body.name, 'GlobalBook');
    assert.equal(doc.body.doc.entries['0'].content, 'Dragons once ruled.');

    const missing = await api('/api/utopinn/worlds/ghost');
    assert.equal(missing.status, 404);
});

// ---------- Personas ----------

test('GET /personas — merged personas + persona_descriptions view', async () => {
    const { status, body } = await api('/api/utopinn/personas');
    assert.equal(status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.defaultPersona, 'ava.png');
    const p = body.items[0];
    assert.equal(p.avatar, 'ava.png');
    assert.equal(p.name, 'Mia');
    assert.equal(p.description, 'Curious.');
    assert.equal(p.position, 1);
    assert.equal(p.title, 'Wanderer');
    assert.equal(p.isDefault, true);
    // avatars/ 下没有真实图片文件 → hasImage false
    assert.equal(p.hasImage, false);
});

// ---------- Named docs(TASK-058 只读面;sendJsonResource 需 ?account=<handle>)----------

test('GET /named-docs/quick-replies — {names} 字典序;?account 私有读闸', async () => {
    // 无 ?account → sendJsonResource 的 sendPrivateRepresentation 拒私有读
    const denied = await api('/api/utopinn/named-docs/quick-replies');
    assert.notEqual(denied.status, 200);
    const { status, body } = await api(`/api/utopinn/named-docs/quick-replies?account=${HANDLE}`);
    assert.equal(status, 200);
    assert.deepEqual(body.names, ['Alpha Pack', 'Zeta Pack']);
});

test('GET /named-docs/quick-replies/:name — 文档原文;404 missing;400 bad bucket', async () => {
    const { status, body } = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Zeta Pack')}?account=${HANDLE}`);
    assert.equal(status, 200);
    assert.equal(body.qrList.length, 2);
    assert.equal(body.qrList[1].isHidden, true);

    const missing = await api(`/api/utopinn/named-docs/quick-replies/ghost?account=${HANDLE}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');

    const badBucket = await api(`/api/utopinn/named-docs/quickreplies?account=${HANDLE}`);
    assert.equal(badBucket.status, 400); // camelCase 桶名不收,只收 URL 形白名单

    const theme = await api(`/api/utopinn/named-docs/themes/midnight?account=${HANDLE}`);
    assert.equal(theme.status, 200);
    assert.equal(theme.body.colors.bg, '#000');
});

// ---------- Named docs 写面(TASK-063:PUT 整档建/改;DELETE strict) ----------

test('PUT /named-docs/quick-replies/:name — 新建整档;doc.name 归一路由名;读面对账', async () => {
    const put = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Gamma Pack')}`, {
        method: 'PUT',
        // body.name 与路由名不一致 → 服务端归一到路由名(SPA 重命名路径靠它)
        body: { version: 2, name: 'stale-name', qrList: [{ id: 1, label: 'Go', message: '/echo hi' }] },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { ok: true, name: 'Gamma Pack' });

    const got = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Gamma Pack')}?account=${HANDLE}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.name, 'Gamma Pack');
    assert.equal(got.body.qrList[0].message, '/echo hi');

    const list = await api(`/api/utopinn/named-docs/quick-replies?account=${HANDLE}`);
    assert.deepEqual(list.body.names, ['Alpha Pack', 'Gamma Pack', 'Zeta Pack']);
});

test('PUT /named-docs/:name — 覆盖写整档替换(label/message/isHidden 编辑落盘形)', async () => {
    const put = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Gamma Pack')}`, {
        method: 'PUT',
        body: { version: 2, qrList: [{ id: 2, label: 'Go2', message: '/echo hi2', isHidden: true }] },
    });
    assert.equal(put.status, 200);
    const got = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Gamma Pack')}?account=${HANDLE}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.qrList.length, 1);
    assert.equal(got.body.qrList[0].label, 'Go2');
    assert.equal(got.body.qrList[0].isHidden, true);
    assert.equal(got.body.version, 2, '未知键透传 —— 生态扩展位不吃');
});

test('PUT /named-docs — 400 非对象 body;400 bad bucket;400 unsafe name', async () => {
    const arr = await api(`/api/utopinn/named-docs/quick-replies/x`, { method: 'PUT', body: [1, 2] });
    assert.equal(arr.status, 400);
    const badBucket = await api(`/api/utopinn/named-docs/quickreplies/x`, { method: 'PUT', body: {} });
    assert.equal(badBucket.status, 400);
    // 名字里的路径分隔符经 safeName 拒(穿目录防护同 legacy safeNameForFile 语义)
    const slash = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('a/b')}`, { method: 'PUT', body: {} });
    assert.equal(slash.status, 400);
    const traversal = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('..')}`, { method: 'PUT', body: {} });
    assert.notEqual(traversal.status, 200);
});

test('DELETE /named-docs/quick-replies/:name — 204;名录摘名;读回 404;missing → strict 404', async () => {
    const del = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Gamma Pack')}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const got = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Gamma Pack')}?account=${HANDLE}`);
    assert.equal(got.status, 404);
    const list = await api(`/api/utopinn/named-docs/quick-replies?account=${HANDLE}`);
    assert.deepEqual(list.body.names, ['Alpha Pack', 'Zeta Pack']);

    const delAgain = await api(`/api/utopinn/named-docs/quick-replies/${encodeURIComponent('Gamma Pack')}`, { method: 'DELETE' });
    assert.equal(delAgain.status, 404, 'strict delete:missing 报 not_found 不静默');

    const badBucket = await api(`/api/utopinn/named-docs/quickreplies/x`, { method: 'DELETE' });
    assert.equal(badBucket.status, 400);
});

// ---------- Settings ----------

test('GET /settings — secrets stripped, legit fields kept', async () => {
    const { status, body } = await api('/api/utopinn/settings');
    assert.equal(status, 200);
    const s = body.settings;
    assert.equal(s.power_user.personas['ava.png'], 'Mia');
    assert.equal(s.preset_settings_openai, 'Default');

    // oai_settings.proxy_password / custom_include_headers 必须被剥掉
    assert.equal(s.oai_settings.chat_completion_source, 'openai');
    assert.equal(s.oai_settings.openai_max_tokens, 300, 'legit token-named field must survive');
    assert.ok(!('proxy_password' in s.oai_settings), 'proxy_password must be stripped');
    assert.ok(!('custom_include_headers' in s.oai_settings), 'custom_include_headers must be stripped');

    // extension_settings 内嵌的密钥也被剥,其余字段保留
    assert.equal(s.extension_settings.coolExt.theme, 'dark');
    assert.ok(!('api_key' in s.extension_settings.coolExt), 'extension api_key must be stripped');
});

test('PATCH /settings — allowlist shallow-merge only', async () => {
    const merged = await api('/api/utopinn/settings', {
        method: 'PATCH',
        body: { power_user: { new_key: 'yes' }, extension_settings: { coolExt: { theme: 'light' } } },
    });
    assert.equal(merged.status, 200);
    const s = merged.body.settings;
    assert.equal(s.power_user.new_key, 'yes');
    // 浅合并:同段已有键保留
    assert.equal(s.power_user.personas['ava.png'], 'Mia');
    assert.equal(s.extension_settings.coolExt.theme, 'light');

    // 已写入存储层(GET 能再读到)
    const again = await api('/api/utopinn/settings');
    assert.equal(again.body.settings.power_user.new_key, 'yes');

    // oai_settings / world_info_settings 在 0afb4c5 后同属白名单
    const oai = await api('/api/utopinn/settings', {
        method: 'PATCH', body: { oai_settings: { chat_completion_source: 'claude' } },
    });
    assert.equal(oai.status, 200);
    assert.equal(oai.body.settings.oai_settings.chat_completion_source, 'claude');

    // world_info_settings.world_info 二层保留同级键(写 globalSelect 不冲掉 charLore)
    await api('/api/utopinn/settings', {
        method: 'PATCH',
        body: { world_info_settings: { world_info: { charLore: [{ name: 'Alice', extraBooks: ['GlobalBook'] }] } } },
    });
    const wiGlobal = await api('/api/utopinn/settings', {
        method: 'PATCH',
        body: { world_info_settings: { world_info: { globalSelect: ['GlobalBook'] } } },
    });
    assert.equal(wiGlobal.status, 200);
    assert.deepEqual(wiGlobal.body.settings.world_info_settings.world_info.globalSelect, ['GlobalBook']);
    assert.deepEqual(wiGlobal.body.settings.world_info_settings.world_info.charLore, [{ name: 'Alice', extraBooks: ['GlobalBook'] }]);

    const rejected = await api('/api/utopinn/settings', {
        method: 'PATCH', body: { world_info: { charLore: [] } },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /not patchable/);

    const badSection = await api('/api/utopinn/settings', {
        method: 'PATCH', body: { power_user: 'string-not-object' },
    });
    assert.equal(badSection.status, 422);

    const empty = await api('/api/utopinn/settings', { method: 'PATCH', body: {} });
    assert.equal(empty.status, 400);
});

// ---------- 楼层书签与岔出(TASK-065 ST bookmark 语义) ----------

test('bookmarks — create/list/delete + validation + integrity 不轮', async () => {
    // c1 种子:2 楼,header.chat_metadata.world_info='GlobalBook'
    const before = await api('/api/utopinn/characters/Alice/chats/c1');
    assert.equal(before.status, 200);
    const integrityBefore = before.body.integrity;

    // 打书签(带 swipeId + 自定义名)
    const mk = await api('/api/utopinn/characters/Alice/chats/c1/bookmarks', {
        method: 'POST', body: { messageId: 1, name: '龙鳞', swipeId: 0 },
    });
    assert.equal(mk.status, 201);
    assert.equal(mk.body.item.messageId, 1);
    assert.equal(mk.body.item.name, '龙鳞');
    assert.equal(mk.body.item.swipeId, 0);
    assert.ok(mk.body.item.id.startsWith('bm_'));
    assert.ok(mk.body.item.ts > 0);

    // 缺省名 → 第N楼
    const dflt = await api('/api/utopinn/characters/Alice/chats/c1/bookmarks', {
        method: 'POST', body: { messageId: 0 },
    });
    assert.equal(dflt.status, 201);
    assert.equal(dflt.body.item.name, '第1楼');

    // 列表:楼层序排,floors 随行
    const list = await api('/api/utopinn/characters/Alice/chats/c1/bookmarks');
    assert.equal(list.status, 200);
    assert.equal(list.body.floors, 2);
    assert.equal(list.body.total, 2);
    assert.deepEqual(list.body.items.map((b) => b.messageId), [0, 1]);

    // 书签写不轮会话 integrity(侧车档语义 —— 客户端 CAS 不因打点过期)
    const after = await api('/api/utopinn/characters/Alice/chats/c1');
    assert.equal(after.body.integrity, integrityBefore);

    // 边界:越界/非 int/负楼 → 400;ghost 会话 → 404
    for (const bad of [2, -1, 'x', null]) {
        const r = await api('/api/utopinn/characters/Alice/chats/c1/bookmarks', {
            method: 'POST', body: { messageId: bad },
        });
        assert.equal(r.status, 400, `messageId=${bad}`);
    }
    const ghost = await api('/api/utopinn/characters/Alice/chats/ghost/bookmarks', {
        method: 'POST', body: { messageId: 0 },
    });
    assert.equal(ghost.status, 404);

    // 删除 → 204;重复删 → 404;删完列表剩 1
    const del = await api(`/api/utopinn/characters/Alice/chats/c1/bookmarks/${dflt.body.item.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const again = await api(`/api/utopinn/characters/Alice/chats/c1/bookmarks/${dflt.body.item.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
    const list2 = await api('/api/utopinn/characters/Alice/chats/c1/bookmarks');
    assert.equal(list2.body.total, 1);
    assert.equal(list2.body.items[0].name, '龙鳞');
});

test('fork — 复制 0..N 成新会话,原名·书签名,源会话不动,书签随迁', async () => {
    // 岔出(c1 现有书签「龙鳞」@1)
    const fork = await api('/api/utopinn/characters/Alice/chats/c1/fork', {
        method: 'POST', body: { messageId: 1, name: '龙鳞' },
    });
    assert.equal(fork.status, 201);
    assert.equal(fork.body.name, 'c1·龙鳞');
    assert.equal(fork.body.fileName, 'c1·龙鳞.jsonl');
    assert.equal(fork.body.messageCount, 2);
    assert.deepEqual(fork.body.fork, { from: 'c1', messageId: 1 });
    assert.ok(fork.body.integrity);

    // 新会话内容 = 前缀复制;header 元数据随行、integrity slug 剔除、溯源记账
    const doc = await api('/api/utopinn/characters/Alice/chats/c1%C2%B7%E9%BE%99%E9%B3%9E');
    assert.equal(doc.status, 200);
    assert.equal(doc.body.messages.length, 2);
    assert.equal(doc.body.messages[1].mes, 'Keep your voice down.');
    const meta = doc.body.header.chat_metadata;
    assert.equal(meta.world_info, 'GlobalBook');
    // repo.save 会把新会话自己的 integrity 写回 chat_metadata ——
    // 正确语义是「≠ 源会话 slug」,即等于 fork 响应里的新 slug
    assert.equal(meta.integrity, fork.body.integrity);
    const srcIntegrity = (await api('/api/utopinn/characters/Alice/chats/c1')).body.integrity;
    assert.notEqual(meta.integrity, srcIntegrity, 'must not carry the source chat CAS slug');
    assert.deepEqual(meta.forked_from, { chat: 'c1', messageId: 1 });

    // 书签随迁(坐标 ≤ 岔点者)
    const bms = await api('/api/utopinn/characters/Alice/chats/c1%C2%B7%E9%BE%99%E9%B3%9E/bookmarks');
    assert.equal(bms.status, 200);
    assert.equal(bms.body.total, 1);
    assert.equal(bms.body.items[0].name, '龙鳞');

    // 同书签再岔 → 撞名自动 ·2,原会话不动
    const fork2 = await api('/api/utopinn/characters/Alice/chats/c1/fork', {
        method: 'POST', body: { messageId: 1, name: '龙鳞' },
    });
    assert.equal(fork2.status, 201);
    assert.equal(fork2.body.name, 'c1·龙鳞·2');
    const src = await api('/api/utopinn/characters/Alice/chats/c1');
    assert.equal(src.body.messages.length, 2);

    // 岔点取 0 → 只复制首楼;默认名 → 第N楼
    const fork0 = await api('/api/utopinn/characters/Alice/chats/c1/fork', {
        method: 'POST', body: { messageId: 0 },
    });
    assert.equal(fork0.status, 201);
    assert.equal(fork0.body.name, 'c1·第1楼');
    assert.equal(fork0.body.messageCount, 1);

    // 边界:越界 → 400;ghost → 404
    const bad = await api('/api/utopinn/characters/Alice/chats/c1/fork', {
        method: 'POST', body: { messageId: 9 },
    });
    assert.equal(bad.status, 400);
    const ghost = await api('/api/utopinn/characters/Alice/chats/ghost/fork', {
        method: 'POST', body: { messageId: 0 },
    });
    assert.equal(ghost.status, 404);

    // 岔出的会话进了该卡会话列表
    const chats = await api('/api/utopinn/characters/Alice/chats');
    const names = chats.body.items.map((i) => i.name);
    assert.ok(names.includes('c1·龙鳞'));
    assert.ok(names.includes('c1·龙鳞·2'));
});

/* ------------------------------------------------------------------ */
/* TASK-067:导出中心(chat/card/world/preset)+ persona 自定义头像上传。   */
/* 验收锚点:四类导出与 formats 解码面互认(导出→回导不丢语义)。         */
/* ------------------------------------------------------------------ */

test('export chat — ST JSONL 形:首行整 header,消息行齐;parseChatJsonl 回解不丢', async () => {
    const res = await fetch(`${BASE}/api/utopinn/export/chat/Alice/c1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /x-ndjson/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment.*c1\.jsonl/);

    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3);
    /* 首行 = repo header 整对象(user_name/character_name/create_date/chat_metadata)
       —— 不是裸 {chat_metadata},ST 实档同形。 */
    const head = JSON.parse(lines[0]);
    assert.equal(head.user_name, 'User');
    assert.equal(head.character_name, 'Alice');
    assert.equal(head.create_date, 1);
    assert.equal(head.chat_metadata.world_info, 'GlobalBook');

    /* formats 解码面回解:metadata + 2 楼消息字段齐。 */
    const parsed = parseChatJsonl(text);
    assert.equal(parsed.metadata.world_info, 'GlobalBook');
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0].mes, 'I found a dragon scale.');
    assert.equal(parsed.messages[0].is_user, true);
    assert.equal(parsed.messages[1].mes, 'Keep your voice down.');

    /* .jsonl 尾缀容忍(stripJsonlExt);ghost → 404。 */
    const suffixed = await fetch(`${BASE}/api/utopinn/export/chat/Alice/c1.jsonl`);
    assert.equal(suffixed.status, 200);
    const ghost = await api('/api/utopinn/export/chat/Alice/ghost');
    assert.equal(ghost.status, 404);
});

test('export card — PNG 原字节回出,readCardFromPng 回解出同一张卡', async () => {
    const res = await fetch(`${BASE}/api/utopinn/export/card/Alice`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/png/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment.*Alice\.png/);

    const bytes = new Uint8Array(await res.arrayBuffer());
    /* PNG magic + tEXt 卡块原样 —— 与 writeCardToPng 种子同文件。 */
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const disk = fs.readFileSync(path.join(dirs.characters, 'Alice.png'));
    assert.deepEqual(bytes, new Uint8Array(disk), 'export must be the on-disk file bytes');
    const card = JSON.parse(readCardFromPng(bytes));
    assert.equal(card.data.name, 'Alice');
    assert.equal(card.data.first_mes, 'Hail, traveler.');

    const ghost = await api('/api/utopinn/export/card/ghost');
    assert.equal(ghost.status, 404);
});

test('export world — {entries:{}} JSON 直出,import world 嗅探形同构', async () => {
    const res = await fetch(`${BASE}/api/utopinn/export/world/GlobalBook`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const doc = await res.json();
    assert.equal(doc.entries['0'].key[0], 'dragon');
    assert.equal(doc.entries['0'].content, 'Dragons once ruled.');
    assert.equal(doc.entries['0'].order, 100);

    const ghost = await api('/api/utopinn/export/world/ghost');
    assert.equal(ghost.status, 404);
});

test('export preset — 预设整档 JSON;apiId 校验 + 404', async () => {
    const res = await fetch(`${BASE}/api/utopinn/export/preset/Default?apiId=openai`);
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.openai_model, 'gpt-test');
    assert.equal(doc.openai_max_tokens, 200);

    const bad = await api('/api/utopinn/export/preset/Default?apiId=nope-family');
    assert.equal(bad.status, 400);
    const ghost = await api('/api/utopinn/export/preset/ghost');
    assert.equal(ghost.status, 404);
});

test('personas/avatar — 上传落盘 User Avatars/<key>,hasImage 翻真,{path} 回主键', async () => {
    /* 测试 app 无全局 multer(server-main.js 挂的)—— 注入 request.file
       模拟 multer 落盘产物,走同一条 Jimp→crop→avatars 管线。 */
    const uploadPath = path.join(ROOT, 'uploads-sim.png');
    fs.writeFileSync(uploadPath, PNG_1PX);
    const uploadApp = express();
    uploadApp.use(express.json());
    uploadApp.use((request, _response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
        request.file = { path: uploadPath, destination: ROOT, filename: 'uploads-sim.png' };
        next();
    });
    uploadApp.use(utopinnLibraryRouter);
    const uploadServer = await new Promise((resolve) => {
        const s = uploadApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
        const ub = `http://127.0.0.1:${uploadServer.address().port}`;
        /* overwrite_name = persona 主键 'ava.png' —— 同键覆写,主键不换。 */
        const res = await fetch(`${ub}/api/utopinn/personas/avatar`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ overwrite_name: 'ava.png' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.path, 'ava.png');
        /* 落盘点 = avatars 目录,PNG magic 真文件;临时上传已清。 */
        const outFile = path.join(dirs.avatars, 'ava.png');
        assert.ok(fs.existsSync(outFile), 'uploaded avatar must land in User Avatars');
        const outBytes = fs.readFileSync(outFile);
        assert.deepEqual([...outBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
        assert.ok(!fs.existsSync(uploadPath), 'temp upload file must be cleaned');
        /* GET /personas 读面 hasImage 翻真(PersonaPop/楼层头像直引同一 URL)。 */
        const personas = await api('/api/utopinn/personas');
        assert.equal(personas.body.items.find((p) => p.avatar === 'ava.png').hasImage, true);

        /* 无 overwrite_name → 服务端铸 <ts>.png 并回 path。 */
        fs.writeFileSync(uploadPath, PNG_1PX);
        const res2 = await fetch(`${ub}/api/utopinn/personas/avatar`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(res2.status, 200);
        const body2 = await res2.json();
        assert.match(body2.path, /^\d+\.png$/);
        assert.ok(fs.existsSync(path.join(dirs.avatars, body2.path)));

        /* 坏字节 → 400(诚实失败,不落半档)。 */
        fs.writeFileSync(uploadPath, Buffer.from('not-an-image'));
        const res3 = await fetch(`${ub}/api/utopinn/personas/avatar`, { method: 'POST', body: '{}' });
        assert.equal(res3.status, 400);
    } finally {
        uploadServer.close();
    }
});
