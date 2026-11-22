/**
 * 开场问候播种(TASK-059)集成测试(node:test)。
 * 真 FsEngine + 种子卡 + 真 express + 真 HTTP;
 * 覆盖 POST messages「缺失即建」与 PUT create 两入口的 ST 语义:
 *   - 卡 first_mes → body[0] 问候楼({{user}}/{{char}} 宏展开)
 *   - alternate_greetings → 同楼 swipes 槽(swipe 组 = first + 全部 alternate)
 *   - 幂等:重复调用不重复播种;空「会话头种」占位楼被顶位
 *   - 退化:无问候卡 → 现行为(原样入库,诚实空)
 *   - 真实语料:tests/corpus/cards/泉此方.json(first_mes + 1 alternate)
 * 跑法:node --test tests/utopinn-greeting-seed.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
    getChatRepo,
    getSettingsRepo,
    initStorage,
} from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
// 插件经 secrets.js 在模块级读 config —— 静态 import 会抢在 setConfigFilePath 前
// 炸掉,改在 test.before 里动态 import(config 就绪后)。

const HANDLE = 'u1';
const CORPUS_KONATA = path.resolve(__dirname, '../../../tests/corpus/cards/泉此方.json');

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

/** web createChat(apps/web/src/api/chats.ts)发出的占位「会话头种」楼,原样复刻。 */
const HEAD_SEED = () => ({ name: '', is_user: false, is_system: true, mes: '', send_date: new Date().toISOString(), extra: {} });

const CHAR_GREETING = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    name: 'Greeter',
    data: {
        name: 'Greeter',
        first_mes: 'Hi {{user}}, I am {{char}}.',
        alternate_greetings: ['Alt-A for {{user}}', 'Alt-B by {{char}}'],
        extensions: {},
    },
});
const CHAR_NO_GREETING = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    name: 'Silent',
    data: { name: 'Silent', first_mes: '', extensions: {} },
});
const CHAR_ALT_ONLY = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    name: 'AltOnly',
    data: {
        name: 'AltOnly',
        first_mes: '',
        alternate_greetings: ['Only alt for {{user}}'],
        extensions: {},
    },
});
const CHAR_SETVAR = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    name: 'Varlord',
    data: {
        name: 'Varlord',
        first_mes: 'Boot.{{setvar::greeted::yes}}',
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

const chatUrl = (charDir, chatName) =>
    `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`;

test.before(async () => {
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

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-greet-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(ROOT, rel);
    }
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    // ---- 种子卡(JSON 承载;loadCharacterDoc 探测序 png/webp→json,直接落 .json)----
    fs.writeFileSync(path.join(dirs.characters, 'Greeter.json'), CHAR_GREETING);
    fs.writeFileSync(path.join(dirs.characters, 'Silent.json'), CHAR_NO_GREETING);
    fs.writeFileSync(path.join(dirs.characters, 'AltOnly.json'), CHAR_ALT_ONLY);
    fs.writeFileSync(path.join(dirs.characters, 'Varlord.json'), CHAR_SETVAR);
    // 真实语料卡(仓库钉住):first_mes 含 {{user}} + 1 条 alternate + 内嵌书
    fs.copyFileSync(CORPUS_KONATA, path.join(dirs.characters, '泉此方.json'));

    // settings:默认人设 'ava.png'→'Mia'({{user}} 展开口径,与
    // chats.js chatDisplaySubstCtx / generate-context 同族)
    await getSettingsRepo().save(HANDLE, {
        power_user: {
            personas: { 'ava.png': 'Mia' },
            default_persona: 'ava.png',
        },
        extension_settings: { variables: { global: { seed: 'g' } } },
    });

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

// ---------------------------------------------------------------------------
// REST「缺失即建」(POST messages)— 验收条目 1
// ---------------------------------------------------------------------------

test('POST messages 建会话:first_mes 落 body[0],alternate 进 swipes 槽,宏展开', async () => {
    const { status, body } = await api(`${chatUrl('Greeter', 'g-rest')}/messages`, {
        method: 'POST',
        body: { chat_metadata: {}, message: HEAD_SEED() },
    });
    assert.equal(status, 200);
    assert.equal(body.created, true);
    assert.equal(body.greeting_seeded, true);
    // 占位头种被顶位:posted 楼未入库
    assert.equal(body.appended, 0);

    const chat = await getChatRepo().get(HANDLE, 'Greeter', 'g-rest');
    assert.equal(chat.body.length, 1);
    const floor0 = chat.body[0];
    assert.equal(floor0.name, 'Greeter');
    assert.equal(floor0.is_user, false);
    assert.equal(floor0.is_system, false);
    assert.equal(typeof floor0.send_date, 'string');
    assert.equal(floor0.mes, 'Hi Mia, I am Greeter.');
    assert.equal(floor0.swipe_id, 0);
    assert.deepEqual(floor0.swipes, ['Hi Mia, I am Greeter.', 'Alt-A for Mia', 'Alt-B by Greeter']);
    assert.equal(floor0.swipe_info.length, 3);
    assert.deepEqual(floor0.extra, {});
});

test('POST messages 建会话:posted 真楼跟在问候楼后(REST 直建语义)', async () => {
    const userMsg = { name: 'Mia', is_user: true, is_system: false, mes: 'yo', send_date: new Date().toISOString(), extra: {} };
    const { status, body } = await api(`${chatUrl('Greeter', 'g-rest-msg')}/messages`, {
        method: 'POST',
        body: { message: userMsg },
    });
    assert.equal(status, 200);
    assert.equal(body.greeting_seeded, true);
    assert.equal(body.appended, 1);
    const chat = await getChatRepo().get(HANDLE, 'Greeter', 'g-rest-msg');
    assert.equal(chat.body.length, 2);
    assert.equal(chat.body[0].mes, 'Hi Mia, I am Greeter.');
    assert.equal(chat.body[1].mes, 'yo');
    assert.equal(chat.body[1].is_user, true);
});

test('GET 楼层读面:问候楼原样透出(swipes/mes_display 契约不破)', async () => {
    const { status, body } = await api(chatUrl('Greeter', 'g-rest'));
    assert.equal(status, 200);
    assert.equal(body.messages.length, 1);
    const floor0 = body.messages[0];
    assert.equal(floor0.mes, 'Hi Mia, I am Greeter.');
    assert.equal(floor0.swipes.length, 3);
});

test('swipe 切换:PATCH /body/0/swipe_id 在问候楼上生效(SPA swipe 面)', async () => {
    const patched = await api(chatUrl('Greeter', 'g-rest'), {
        method: 'PATCH',
        body: { ops: [{ op: 'replace', path: '/body/0/swipe_id', value: 1 }] },
    });
    assert.equal(patched.status, 200);
    const chat = await getChatRepo().get(HANDLE, 'Greeter', 'g-rest');
    assert.equal(chat.body[0].swipe_id, 1);
    assert.equal(chat.body[0].swipes[1], 'Alt-A for Mia');
});

// ---------------------------------------------------------------------------
// PUT create —— 与缺失即建同一播种语义
// ---------------------------------------------------------------------------

test('PUT 建会话:同样播种问候楼', async () => {
    const { status, body } = await api(chatUrl('Greeter', 'g-put'), { method: 'PUT', body: {} });
    assert.equal(status, 201);
    assert.equal(body.greeting_seeded, true);
    const chat = await getChatRepo().get(HANDLE, 'Greeter', 'g-put');
    assert.equal(chat.body.length, 1);
    assert.equal(chat.body[0].mes, 'Hi Mia, I am Greeter.');
    assert.equal(chat.body[0].swipes.length, 3);
});

// ---------------------------------------------------------------------------
// 幂等与退化 —— 验收条目 3
// ---------------------------------------------------------------------------

test('幂等:二次 POST 不增生问候楼', async () => {
    const again = await api(`${chatUrl('Greeter', 'g-rest')}/messages`, {
        method: 'POST',
        body: { message: { name: 'Mia', is_user: true, is_system: false, mes: 'second', send_date: new Date().toISOString(), extra: {} } },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    const chat = await getChatRepo().get(HANDLE, 'Greeter', 'g-rest');
    const greetings = chat.body.filter((m) => m.mes === 'Hi Mia, I am Greeter.');
    assert.equal(greetings.length, 1);
    assert.equal(chat.body[0].mes, 'Hi Mia, I am Greeter.');
});

test('退化:无 first_mes 卡 → 现行为(posted 原样入库,无问候楼)', async () => {
    const { status, body } = await api(`${chatUrl('Silent', 's-1')}/messages`, {
        method: 'POST',
        body: { message: HEAD_SEED() },
    });
    assert.equal(status, 200);
    assert.equal(body.created, true);
    assert.equal(body.greeting_seeded, undefined);
    assert.equal(body.appended, 1);
    const chat = await getChatRepo().get(HANDLE, 'Silent', 's-1');
    assert.equal(chat.body.length, 1);
    assert.equal(chat.body[0].is_system, true);
    assert.equal(chat.body[0].mes, '');
});

test('退化:无问候卡 PUT → 真空文件', async () => {
    const { status, body } = await api(chatUrl('Silent', 's-put'), { method: 'PUT', body: {} });
    assert.equal(status, 201);
    assert.equal(body.greeting_seeded, undefined);
    const chat = await getChatRepo().get(HANDLE, 'Silent', 's-put');
    assert.equal(chat.body.length, 0);
});

test('上游移位:first_mes 空 + alternates → 首个 alternate 顶上', async () => {
    const { status } = await api(chatUrl('AltOnly', 'a-1'), { method: 'PUT', body: {} });
    assert.equal(status, 201);
    const chat = await getChatRepo().get(HANDLE, 'AltOnly', 'a-1');
    assert.equal(chat.body.length, 1);
    assert.equal(chat.body[0].mes, 'Only alt for Mia');
    assert.deepEqual(chat.body[0].swipes, ['Only alt for Mia']);
});

test('setvar 宏:问候文本写进 chat_metadata.variables(上游同 store)', async () => {
    const { status } = await api(chatUrl('Varlord', 'v-1'), { method: 'PUT', body: {} });
    assert.equal(status, 201);
    const chat = await getChatRepo().get(HANDLE, 'Varlord', 'v-1');
    assert.equal(chat.body[0].mes, 'Boot.');
    assert.equal(chat.header.chat_metadata.variables.greeted, 'yes');
});

// ---------------------------------------------------------------------------
// 真实语料卡:泉此方(first_mes 含 {{user}} + 1 alternate + 内嵌书)
// ---------------------------------------------------------------------------

test('泉此方语料卡:POST 建会话 → 问候楼 + swipe 组 = first + 1 alternate', async () => {
    const { status, body } = await api(`${chatUrl('泉此方', 'k-1')}/messages`, {
        method: 'POST',
        body: { message: HEAD_SEED() },
    });
    assert.equal(status, 200);
    assert.equal(body.greeting_seeded, true);
    const chat = await getChatRepo().get(HANDLE, '泉此方', 'k-1');
    assert.equal(chat.body.length, 1);
    const floor0 = chat.body[0];
    assert.equal(floor0.name, '泉此方');
    assert.equal(floor0.is_user, false);
    assert.match(floor0.mes, /^……啊,Mia\?你还没走啊。/);
    assert.ok(!floor0.mes.includes('{{user}}'));
    assert.equal(floor0.swipe_id, 0);
    assert.equal(floor0.swipes.length, 2); // first_mes + 1 alternate
    assert.match(floor0.swipes[1], /^\*周末的电玩店,泉此方正踮着脚/);
    assert.ok(floor0.swipes[1].includes('喂,Mia,搭把手'));
    assert.ok(!floor0.swipes[1].includes('{{user}}'));
});
