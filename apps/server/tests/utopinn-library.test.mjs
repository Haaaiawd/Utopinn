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
import { writeCardToPng } from '@utopinn/formats';
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

const CARD_ALICE = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    name: 'Alice',
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

    const { apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js');
    const utopinnLibraryRouter = express.Router();
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
