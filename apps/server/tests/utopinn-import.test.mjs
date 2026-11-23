/**
 * /api/utopinn/import 导入管线(plugins/utopinn-data.js + services/import-pipeline.js)
 * 集成测试(node:test)。真 FsEngine + 真 express + 真 HTTP;
 * request.user 经中间件注入(等价 requireLogin+setUserData 之后的形态)。
 * 插件经 ctx.webServer.register 挂路由 —— 假 webServer 直挂 express.Router
 * (与 utopinn-library.test.mjs 同型);ctx.effect 的清理函数收集起来 after 释放
 * (LAN discover 的 UDP socket 不关进程退不出)。
 *
 * characters.js(writeCharacterData 所在)模块加载期读 config ——
 * before() 里先 setConfigFilePath(default/config.yaml) + DATA_ROOT,
 * 再让第一次 commit 触发它的惰性 import。
 *
 * 跑法:node --test tests/utopinn-import.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { zipSync } from 'fflate';
import { readCardFromPng, writeCardToPng } from '@utopinn/formats';
import {
    getPresetRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    initStorage,
} from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const HANDLE = 'u1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);
const te = new TextEncoder();

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
const effectCleanups = [];

const CARD_ALICE = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: 'Alice', description: 'A wandering knight.',
        first_mes: 'Hail, traveler.', tags: ['fantasy', 'knight'],
        character_book: {
            entries: [{ keys: ['dragon'], content: 'Dragons once ruled.', enabled: true, insertion_order: 0 }],
        },
        extensions: {
            depth_prompt: { prompt: 'Stay sharp.', depth: 2, role: 'system' },
            regex_scripts: [{ id: 'r1', scriptName: 'Strip markup', findRegex: '<b>(.*?)</b>' }],
            world: 'GlobalBook',
        },
    },
});

const CARD_V1_JSON = JSON.stringify({
    name: 'Vince', description: 'A quiet mage.', first_mes: 'Hmm?',
    personality: 'taciturn', scenario: 'A tower.', creatorcomment: 'cc',
});

const WORLDBOOK = JSON.stringify({
    entries: { '0': { uid: 0, key: ['dragon'], content: 'Dragons once ruled.', order: 100, position: 0 } },
});

const PRESET = JSON.stringify({
    name: 'TestPreset',
    prompts: [{ name: 'main', role: 'system', content: 'You are terse.' }],
    openai_model: 'gpt-test', openai_max_tokens: 120,
});

const PERSONA = JSON.stringify({
    name: 'Mia', description: 'Curious wanderer.', position: 1, title: 'Wanderer',
});

function pngCardB64(cardJson) {
    return Buffer.from(writeCardToPng(new Uint8Array(PNG_1PX), cardJson)).toString('base64');
}

function charxFixture() {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name: 'Charxie', description: 'from charx', first_mes: 'Yo.',
            assets: [
                { type: 'icon', name: 'main', uri: 'embeded://assets/icon.png', ext: 'png' },
                { type: 'emotion', name: 'happy', uri: 'embeded://assets/happy.png', ext: 'png' },
            ],
        },
    };
    return zipSync({
        'card.json': te.encode(JSON.stringify(card)),
        'assets/icon.png': new Uint8Array(PNG_1PX),
        'assets/happy.png': new Uint8Array(PNG_1PX),
    });
}

function byafFixture() {
    const manifest = {
        characters: ['char/character.json'],
        scenarios: ['scen/one.json'],
        author: { name: 'BackYard' },
    };
    const character = {
        name: 'Byafie', displayName: 'Byaf Display',
        persona: 'quiet dragon', isNSFW: false,
        images: [{ path: 'img.png', label: 'main' }],
        loreItems: [{ key: 'cave', value: 'its home' }],
    };
    const scenario = { narrative: 'A cold cave.', firstMessages: [{ text: '*rumbles*' }], exampleMessages: [] };
    return zipSync({
        'manifest.json': te.encode(JSON.stringify(manifest)),
        'char/character.json': te.encode(JSON.stringify(character)),
        'char/img.png': new Uint8Array(PNG_1PX),
        'scen/one.json': te.encode(JSON.stringify(scenario)),
    });
}

async function api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
    // characters.js 加载期要读 config —— 必须在第一次 commit 前就绪
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    // 关掉磁盘卡缓存:否则 node-persist 在 DATA_ROOT/_cache 起 setInterval,测试进程退不出
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-import-'));
    globalThis.DATA_ROOT = ROOT;
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(ROOT, rel);
    }
    for (const dir of [dirs.characters, dirs.chats, dirs.avatars, dirs.userImages, dirs.cardApps, path.join(ROOT, '_uploads')]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    // 插件域合并后导入管线在 plugins/utopinn-data.js(utopinn-import.js 已删)。
    // 假 webServer 把 ctx.webServer.register 的 spec 直挂 express.Router;
    // ctx.effect 立即执行并收集清理函数(LAN discover 的 UDP socket 要关)。
    const { apply: applyUtopinnData } = await import('../src/plugins/utopinn-data.js');
    const utopinnRouter = express.Router();
    const ws = {
        register: (spec) => {
            utopinnRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    applyUtopinnData({
        webServer: ws,
        effect: (fn) => {
            const cleanup = typeof fn === 'function' ? fn() : undefined;
            if (typeof cleanup === 'function') effectCleanups.push(cleanup);
        },
    });

    const app = express();
    app.use(express.json());
    // 只在 multipart 请求上启用上传解析 —— 与 server-main 的全局 multer 等价(field 'avatar')
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, path.join(ROOT, '_uploads')),
        }),
    }).single('avatar');
    app.use('/api/utopinn', (request, response, next) => {
        if (request.is('multipart/*')) return upload(request, response, next);
        next();
    });
    app.use((request, response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
        next();
    });
    app.use(utopinnRouter); // 插件注册的是 /api/utopinn/* 全路径,根挂
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    server?.close();
    for (const cleanup of effectCleanups) {
        try { cleanup(); } catch { /* best-effort */ }
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- Preview:各类型探测 ----------

test('preview PNG card — kind char, summary 列出书条目/regex/depth_prompt', async () => {
    const { status, body } = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'alice.png', dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(status, 200);
    assert.equal(body.kind, 'char');
    assert.equal(body.name, 'Alice');
    assert.equal(body.targetName, 'Alice');
    // writeCardToPng 同时嵌 chara(v2)+ccv3(v3)两个 chunk,读取优先 ccv3 → v3
    assert.equal(body.summary.spec, 'chara_card_v3');
    assert.equal(body.summary.bookEntries, 1);
    assert.equal(body.summary.regexScripts, 1);
    assert.deepEqual(body.summary.regexScriptNames, ['Strip markup']);
    assert.equal(body.summary.depthPrompt.depth, 2);
    assert.equal(body.summary.firstGreetingLen, 'Hail, traveler.'.length);
    assert.equal(body.summary.boundWorld, 'GlobalBook');
    assert.equal(body.summary.avatar, 'bundled');
    assert.equal(body.conflicts.existingSameName, false);
    assert.ok(body.warnings.some((w) => /regex script/i.test(w)));
    // GlobalBook 不在库 → 绑定世界书缺失警告
    assert.ok(body.warnings.some((w) => /bound to world "GlobalBook"/i.test(w)));
});

test('preview — GH#3 regex_disabled:服务端总闸灭 + 卡侧全灭 + 可执行', async () => {
    // 基线:CARD_ALICE 带 1 条未 disabled 的 regex —— 正常时应可执行。
    const enabled = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'alice-ok.png', dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.summary.regexScripts, 1);
    assert.equal(enabled.body.regex_disabled, false,
        'script enabled + no server kill → regex_disabled=false');

    // 服务端总闸:extension_settings.disabledExtensions 含 'regex'。
    const settings = (await getSettingsRepo().get(HANDLE)) ?? {};
    const killed = {
        ...settings,
        extension_settings: { ...(settings.extension_settings ?? {}), disabledExtensions: ['regex'] },
    };
    await getSettingsRepo().save(HANDLE, killed);
    try {
        const body = (await api('/api/utopinn/import/preview', {
            method: 'POST',
            body: { name: 'alice-killed.png', dataBase64: pngCardB64(CARD_ALICE) },
        })).body;
        assert.equal(body.regex_disabled, true, 'server disabledExtensions=[regex] → flagged');
        assert.ok(body.warnings.some((w) => /disabledExtensions.*regex/i.test(w)),
            `expected server-kill warning, got: ${JSON.stringify(body.warnings)}`);
    } finally {
        await getSettingsRepo().save(HANDLE, settings);
    }

    // 卡侧全灭:逐脚本 disabled:true(regexScripts camelCase 键也收)。
    const disabledCard = JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name: 'Dead', description: 'x', first_mes: 'y',
            extensions: {
                regexScripts: [
                    { id: 'a', scriptName: 'A', findRegex: 'x', disabled: true },
                    { id: 'b', scriptName: 'B', findRegex: 'y', disabled: true },
                ],
            },
        },
    });
    const allDisabled = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'dead.png', dataBase64: pngCardB64(disabledCard) },
    });
    assert.equal(allDisabled.status, 200);
    assert.equal(allDisabled.body.summary.regexScripts, 2, 'regexScripts camelCase key counted');
    assert.equal(allDisabled.body.summary.regexScriptsDisabled, 2);
    assert.equal(allDisabled.body.summary.regexDisabled, true);
    assert.equal(allDisabled.body.regex_disabled, true, 'all card-side disabled → flagged');
    assert.ok(allDisabled.body.warnings.some((w) => /marked disabled/i.test(w)),
        `expected all-disabled warning, got: ${JSON.stringify(allDisabled.body.warnings)}`);
});

test('commit — GH#3 regex_disabled 同样回传', async () => {
    const settings = (await getSettingsRepo().get(HANDLE)) ?? {};
    await getSettingsRepo().save(HANDLE, {
        ...settings,
        extension_settings: { ...(settings.extension_settings ?? {}), disabledExtensions: ['regex'] },
    });
    try {
        const { status, body } = await api('/api/utopinn/import/commit', {
            method: 'POST',
            body: { name: 'alice-c.png', targetName: 'AliceCommit', dataBase64: pngCardB64(CARD_ALICE) },
        });
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.regex_disabled, true, 'commit response also flags regex_disabled');
        assert.ok(body.warnings.some((w) => /disabledExtensions.*regex/i.test(w)));
    } finally {
        await getSettingsRepo().save(HANDLE, settings);
    }
});

test('preview JSON v1 card — char + 升级警告', async () => {
    const { status, body } = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'vince.json', dataBase64: Buffer.from(CARD_V1_JSON).toString('base64') },
    });
    assert.equal(status, 200);
    assert.equal(body.kind, 'char');
    assert.equal(body.name, 'Vince');
    assert.equal(body.summary.spec, 'chara_card_v1');
    assert.equal(body.summary.avatar, 'none');
    assert.ok(body.warnings.some((w) => /upgraded to chara_card_v2/i.test(w)));
    assert.ok(body.warnings.some((w) => /default avatar/i.test(w)));
});

test('preview charx / byaf — 都是 char,带各自警告', async () => {
    const charx = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'charxie.charx', dataBase64: Buffer.from(charxFixture()).toString('base64') },
    });
    assert.equal(charx.status, 200);
    assert.equal(charx.body.kind, 'char');
    assert.equal(charx.body.name, 'Charxie');
    assert.equal(charx.body.summary.sourceFormat, 'charx');
    assert.ok(charx.body.warnings.some((w) => /CharX assets/i.test(w)));

    const byaf = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'byafie.byaf', dataBase64: Buffer.from(byafFixture()).toString('base64') },
    });
    assert.equal(byaf.status, 200);
    assert.equal(byaf.body.kind, 'char');
    assert.equal(byaf.body.name, 'Byafie');
    assert.equal(byaf.body.summary.sourceFormat, 'byaf');
    assert.equal(byaf.body.summary.bookEntries, 1);
});

test('preview worldbook / preset / persona — kind 分流正确', async () => {
    const world = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'GlobalBook.json', dataBase64: Buffer.from(WORLDBOOK).toString('base64') },
    });
    assert.equal(world.status, 200);
    assert.equal(world.body.kind, 'world');
    assert.equal(world.body.targetName, 'GlobalBook');
    assert.equal(world.body.summary.entries, 1);

    const preset = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'preset.json', dataBase64: Buffer.from(PRESET).toString('base64') },
    });
    assert.equal(preset.status, 200);
    assert.equal(preset.body.kind, 'preset');
    assert.equal(preset.body.name, 'TestPreset');
    assert.equal(preset.body.summary.prompts, 1);

    const persona = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'mia.json', dataBase64: Buffer.from(PERSONA).toString('base64') },
    });
    assert.equal(persona.status, 200);
    assert.equal(persona.body.kind, 'persona');
    assert.equal(persona.body.name, 'Mia');
    assert.equal(persona.body.avatarKey, 'Mia.png');
    assert.equal(persona.body.summary.descriptionLen, 'Curious wanderer.'.length);
});

test('preview — 不可识别载荷一律 422 + hints', async () => {
    const garbage = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'x.bin', dataBase64: Buffer.from('not json at all \x01\x02').toString('base64') },
    });
    assert.equal(garbage.status, 422);
    assert.ok(garbage.body.error);
    assert.ok(garbage.body.hints);

    const barePng = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'bare.png', dataBase64: PNG_1PX.toString('base64') },
    });
    assert.equal(barePng.status, 422);
    assert.match(barePng.body.error, /PNG/i);

    const zipNoCard = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'x.charx', dataBase64: Buffer.from(zipSync({ 'readme.txt': te.encode('hi') })).toString('base64') },
    });
    assert.equal(zipNoCard.status, 422);
    assert.match(zipNoCard.body.error, /ZIP/i);

    const unknownJson = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'x.json', dataBase64: Buffer.from('{"foo":1,"bar":2}').toString('base64') },
    });
    assert.equal(unknownJson.status, 422);
    assert.deepEqual(unknownJson.body.hints.topLevelKeys, ['foo', 'bar']);
});

test('preview — multipart 上传(avatar 字段)走同一管线', async () => {
    const fd = new FormData();
    fd.append('avatar', new Blob([writeCardToPng(new Uint8Array(PNG_1PX), CARD_ALICE)]), 'alice.png');
    const res = await fetch(`${BASE}/api/utopinn/import/preview`, { method: 'POST', body: fd });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.kind, 'char');
    assert.equal(body.name, 'Alice');
});

// ---------- Commit ----------

test('commit PNG card → characters/Alice.png 可读回', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.ok, true);
    assert.equal(commit.body.kind, 'char');
    assert.equal(commit.body.targetName, 'Alice');
    assert.equal(commit.body.renamed, false);

    const pngPath = path.join(dirs.characters, 'Alice.png');
    assert.ok(fs.existsSync(pngPath), 'expected Alice.png in characters dir');
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(pngPath)));
    assert.equal(stored.data.name, 'Alice');
    assert.equal(stored.data.first_mes, 'Hail, traveler.');
    // 私有字段已摘、create_date 已盖
    assert.ok(stored.create_date);
    assert.equal(stored.data.extensions.fav, false);
});

test('commit JSON v1 card → 升格 v2 PNG(默认头像)', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { name: 'vince.json', dataBase64: Buffer.from(CARD_V1_JSON).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.targetName, 'Vince');
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Vince.png'))));
    assert.equal(stored.data.name, 'Vince');
    // 写盘同时嵌 chara(v2)+ccv3(v3),读取优先 ccv3 → v3
    assert.equal(stored.spec, 'chara_card_v3');
    assert.equal(stored.data.first_mes, 'Hmm?');
});

test('commit charx → PNG + 辅助立绘落 sprites 目录', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { name: 'charxie.charx', dataBase64: Buffer.from(charxFixture()).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.targetName, 'Charxie');
    assert.ok(fs.existsSync(path.join(dirs.characters, 'Charxie.png')));
    // emotion 资产 → characters/<显示名>/happy.png
    assert.ok(
        fs.existsSync(path.join(dirs.characters, 'Charxie', 'happy.png')),
        'expected charx emotion sprite under characters/Charxie/',
    );
});

test('commit byaf → PNG,宏已替换、首图作头像', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { name: 'byafie.byaf', dataBase64: Buffer.from(byafFixture()).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.targetName, 'Byafie');
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Byafie.png'))));
    assert.equal(stored.data.name, 'Byafie');
    assert.equal(stored.data.first_mes, '*rumbles*');
    assert.equal(stored.data.creator, 'BackYard');
});

test('commit worldbook → WorldInfoRepo 可读', async () => {
    // GlobalBook 已被 Alice 卡的内嵌书物化占据 —— 独立 worldbook 用自由名,
    // 否则命中同名冲突要显式 conflict(这本身也是物化生效的旁证)。
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { name: 'StandaloneBook.json', dataBase64: Buffer.from(WORLDBOOK).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.kind, 'world');
    assert.equal(commit.body.targetName, 'StandaloneBook');
    const doc = await getWorldInfoRepo().get(HANDLE, 'StandaloneBook');
    assert.equal(doc.entries['0'].content, 'Dragons once ruled.');
});

test('commit preset → PresetRepo(openai) 可读;非法 apiId → 400', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: Buffer.from(PRESET).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.kind, 'preset');
    const doc = await getPresetRepo().get(HANDLE, 'openai', 'TestPreset');
    assert.equal(doc.openai_model, 'gpt-test');

    // apiId 校验在冲突裁决之前 → 400 而非 409
    const badId = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { apiId: 'bogus', dataBase64: Buffer.from(PRESET).toString('base64') },
    });
    assert.equal(badId.status, 400);
    assert.match(badId.body.error, /apiId/);
});

test('commit persona → settings.power_user 两表都落', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: Buffer.from(PERSONA).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.kind, 'persona');
    assert.equal(commit.body.avatarKey, 'Mia.png');
    const settings = await getSettingsRepo().get(HANDLE);
    assert.equal(settings.power_user.personas['Mia.png'], 'Mia');
    assert.equal(settings.power_user.persona_descriptions['Mia.png'].description, 'Curious wanderer.');
    assert.equal(settings.power_user.persona_descriptions['Mia.png'].title, 'Wanderer');
});

// ---------- 冲突三策 ----------

test('同名冲突:无策略→409;skip→skipped;rename→Name1', async () => {
    // Alice.png 已在上面的 commit 里落下
    const again = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.conflicts.existingSameName, true);

    const skipped = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { conflict: 'skip', dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.skipped, true);
    assert.ok(!fs.existsSync(path.join(dirs.characters, 'Alice1.png')), 'skip must not write');

    const renamed = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { conflict: 'rename', dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.targetName, 'Alice1');
    assert.equal(renamed.body.renamed, true);
    assert.ok(fs.existsSync(path.join(dirs.characters, 'Alice1.png')));
});

test('overwrite 同名片 → 继承旧 chat 指针', async () => {
    // 先手工落一张带 chat 指针的 Kee.png
    const oldCard = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Kee' }, chat: 'chat-abc' });
    fs.writeFileSync(path.join(dirs.characters, 'Kee.png'), writeCardToPng(new Uint8Array(PNG_1PX), oldCard));

    const newCard = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'KeeNew', description: 'fresh' } });
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { targetName: 'Kee', conflict: 'overwrite', dataBase64: pngCardB64(newCard) },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.targetName, 'Kee');
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Kee.png'))));
    assert.equal(stored.data.name, 'KeeNew');
    assert.equal(stored.chat, 'chat-abc', 'overwrite should inherit the old card chat pointer');
});

// ---------- 内嵌世界书物化(issue #7:overwrite 要同步刷新 linked world)----------

function cardWithBook(name, worldName, entryCount) {
    return JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name, description: `${name} card.`,
            character_book: {
                entries: Array.from({ length: entryCount }, (_, i) => ({
                    keys: [`kw${i}`], content: `entry ${i}`, enabled: true, insertion_order: i,
                })),
            },
            extensions: { world: worldName },
        },
    });
}

test('issue #7: overwrite 再导入 → 已物化世界书同步更新(27→30 条)+ overwrote 提示', async () => {
    // 复现 issue 原场景:首次导入物化 27 条;改卡到 30 条 --conflict overwrite 再导入
    const first = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithBook('Keeper', 'KeeperBook', 27)) },
    });
    assert.equal(first.status, 200);
    assert.ok(
        first.body.warnings.some((w) => /materialized to world "KeeperBook" \(27 entries\)/.test(w)),
        `expected materialize warning, got: ${JSON.stringify(first.body.warnings)}`,
    );
    let doc = await getWorldInfoRepo().get(HANDLE, 'KeeperBook');
    assert.equal(Object.keys(doc.entries).length, 27);

    const second = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { conflict: 'overwrite', dataBase64: pngCardB64(cardWithBook('Keeper', 'KeeperBook', 30)) },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.ok, true);
    assert.ok(
        second.body.warnings.some((w) => /overwrote world "KeeperBook" \(30 entries\)/.test(w)),
        `expected overwrote warning, got: ${JSON.stringify(second.body.warnings)}`,
    );
    doc = await getWorldInfoRepo().get(HANDLE, 'KeeperBook');
    assert.equal(Object.keys(doc.entries).length, 30, 'overwrite must refresh the materialized world');
    assert.equal(doc.entries['29'].content, 'entry 29');
});

test('内嵌书:overwrite 但世界书已被删 → 重新物化(materialized 而非 overwrote)', async () => {
    await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithBook('Ghost', 'GhostBook', 2)) },
    });
    await getWorldInfoRepo().delete(HANDLE, 'GhostBook');

    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { conflict: 'overwrite', dataBase64: pngCardB64(cardWithBook('Ghost', 'GhostBook', 4)) },
    });
    assert.equal(commit.status, 200);
    assert.ok(
        commit.body.warnings.some((w) => /materialized to world "GhostBook" \(4 entries\)/.test(w)),
        `expected fresh materialize warning, got: ${JSON.stringify(commit.body.warnings)}`,
    );
    const doc = await getWorldInfoRepo().get(HANDLE, 'GhostBook');
    assert.equal(Object.keys(doc.entries).length, 4);
});

test('内嵌书:rename 策略不动既有世界书,但不再静默(skipped 提示)', async () => {
    await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithBook('Lore', 'LoreBook', 2)) },
    });
    const renamed = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { conflict: 'rename', dataBase64: pngCardB64(cardWithBook('Lore', 'LoreBook', 5)) },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.targetName, 'Lore1');
    assert.ok(
        renamed.body.warnings.some((w) => /skipped: world "LoreBook" already exists/.test(w)),
        `expected skipped warning, got: ${JSON.stringify(renamed.body.warnings)}`,
    );
    const doc = await getWorldInfoRepo().get(HANDLE, 'LoreBook');
    assert.equal(Object.keys(doc.entries).length, 2, 'rename must not clobber the existing world');
});

test('内嵌书:无卡面冲突但世界已存在 → skipped 提示 + 不覆盖', async () => {
    await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithBook('Alpha', 'SharedBook', 2)) },
    });
    // 不同名的另一张卡绑定同一世界 —— 无冲突提示可给,但书静默被跳过是 issue 同款
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithBook('Beta', 'SharedBook', 9)) },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.targetName, 'Beta');
    assert.ok(
        commit.body.warnings.some((w) => /skipped: world "SharedBook" already exists/.test(w)),
        `expected skipped warning, got: ${JSON.stringify(commit.body.warnings)}`,
    );
    const doc = await getWorldInfoRepo().get(HANDLE, 'SharedBook');
    assert.equal(Object.keys(doc.entries).length, 2, 'existing world must not be clobbered without overwrite');
});

test('内嵌书:卡已删只剩物化书 → conflict=overwrite 仍刷新(策略挂声明不挂卡面冲突)', async () => {
    // 卡文件删掉、物化书残留 —— 此时再导无卡面冲突;若把书刷新挂在卡面
    // existing 上,这条路会永远跳过(issue #7 同款陷阱的另一半)。
    await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithBook('Orphan', 'OrphanBook', 2)) },
    });
    fs.unlinkSync(path.join(dirs.characters, 'Orphan.png'));

    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { conflict: 'overwrite', dataBase64: pngCardB64(cardWithBook('Orphan', 'OrphanBook', 7)) },
    });
    assert.equal(commit.status, 200);
    assert.ok(
        commit.body.warnings.some((w) => /overwrote world "OrphanBook" \(7 entries\)/.test(w)),
        `expected overwrote warning, got: ${JSON.stringify(commit.body.warnings)}`,
    );
    const doc = await getWorldInfoRepo().get(HANDLE, 'OrphanBook');
    assert.equal(Object.keys(doc.entries).length, 7);
});

test('overwrite 无内嵌书的卡 → 无世界书动静,行为不受影响', async () => {
    const solo = JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0',
        data: { name: 'Solo', description: 'no book' },
    });
    const first = await api('/api/utopinn/import/commit', {
        method: 'POST', body: { dataBase64: pngCardB64(solo) },
    });
    assert.equal(first.status, 200);
    const second = await api('/api/utopinn/import/commit', {
        method: 'POST', body: { conflict: 'overwrite', dataBase64: pngCardB64(solo) },
    });
    assert.equal(second.status, 200);
    assert.ok(
        !(second.body.warnings ?? []).some((w) => /character_book|world/i.test(w)),
        `no world-book warning expected, got: ${JSON.stringify(second.body.warnings)}`,
    );
});

// ---------- 内嵌书无 extensions.world(issue #10:派生名物化+绑定,不再静默)----------

/** 内嵌书但 extensions 无 world 绑定(extensions 整个缺省也覆盖)。 */
function cardWithUnboundBook(name, entryCount, { bookName = null, extensions = {} } = {}) {
    const book = {
        entries: Array.from({ length: entryCount }, (_, i) => ({
            keys: [`kw${i}`], content: `entry ${i}`, enabled: true, insertion_order: i,
        })),
    };
    if (bookName != null) book.name = bookName;
    return JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0',
        data: { name, description: `${name} card.`, character_book: book, extensions },
    });
}

test('issue #10: preview 无绑定内嵌书 → 派生名进 summary + fallback 警告', async () => {
    const { status, body } = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'drifter.png', dataBase64: pngCardB64(cardWithUnboundBook('Drifter', 3)) },
    });
    assert.equal(status, 200);
    assert.equal(body.kind, 'char');
    assert.equal(body.summary.boundWorld, null);
    assert.equal(body.summary.embeddedWorldName, "Drifter's Lorebook");
    assert.equal(body.summary.embeddedWorldFallback, true);
    assert.ok(
        body.warnings.some((w) => /not linked to a world.*materialize as "Drifter's Lorebook"/i.test(w)),
        `expected fallback-name preview warning, got: ${JSON.stringify(body.warnings)}`,
    );
});

test('issue #10: commit 派生名物化 + 绑定写回卡面 + embeddedBook 机读字段', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithUnboundBook('Drifter', 3)) },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.ok, true);
    assert.deepEqual(
        commit.body.embeddedBook,
        { worldName: "Drifter's Lorebook", fallback: true, outcome: 'materialized', entries: 3 },
    );
    assert.ok(
        commit.body.warnings.some((w) => /materialized to world "Drifter's Lorebook" \(3 entries\)/.test(w)),
        `expected materialize warning, got: ${JSON.stringify(commit.body.warnings)}`,
    );
    assert.ok(
        commit.body.warnings.some((w) => /no bound world; derived name/i.test(w)),
        `expected derived-name note, got: ${JSON.stringify(commit.body.warnings)}`,
    );
    // 书真的落了库
    const doc = await getWorldInfoRepo().get(HANDLE, "Drifter's Lorebook");
    assert.equal(Object.keys(doc.entries).length, 3);
    // 绑定写回了卡面(上游 writeExtensionField 等价)——装配按此名解析
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Drifter.png'))));
    assert.equal(stored.data.extensions.world, "Drifter's Lorebook");
});

test('issue #10: character_book.name 优先于角色名派生', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithUnboundBook('Nomad', 2, { bookName: 'Nomad Codex' })) },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.embeddedBook.worldName, 'Nomad Codex');
    assert.equal(commit.body.embeddedBook.fallback, true);
    const doc = await getWorldInfoRepo().get(HANDLE, 'Nomad Codex');
    assert.equal(Object.keys(doc.entries).length, 2);
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Nomad.png'))));
    assert.equal(stored.data.extensions.world, 'Nomad Codex');
});

test('issue #7+#10: 派生名 overwrite 再导入 → 物化书同步刷新 + overwrote', async () => {
    const first = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithUnboundBook('Vagrant', 2)) },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.embeddedBook.outcome, 'materialized');

    const second = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { conflict: 'overwrite', dataBase64: pngCardB64(cardWithUnboundBook('Vagrant', 5)) },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.embeddedBook.outcome, 'overwrote');
    assert.equal(second.body.embeddedBook.worldName, "Vagrant's Lorebook");
    const doc = await getWorldInfoRepo().get(HANDLE, "Vagrant's Lorebook");
    assert.equal(Object.keys(doc.entries).length, 5, 'overwrite must refresh the fallback-named world');
    // 新卡仍指向派生名(重新绑定 —— 新卡文件同样不自带 extensions.world)
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Vagrant.png'))));
    assert.equal(stored.data.extensions.world, "Vagrant's Lorebook");
});

test('issue #10: 派生名撞既有书 → skipped 不覆盖 + 卡仍绑定 + 警告齐', async () => {
    // 预置一本同名但内容不同的既有书
    await getWorldInfoRepo().save(HANDLE, "Castaway's Lorebook", {
        entries: { '0': { uid: 0, key: ['other'], content: 'pre-existing lore', order: 1, position: 0 } },
    });
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { dataBase64: pngCardB64(cardWithUnboundBook('Castaway', 4)) },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.embeddedBook.outcome, 'skipped');
    assert.equal(commit.body.embeddedBook.fallback, true);
    assert.ok(
        commit.body.warnings.some((w) => /skipped: world "Castaway's Lorebook" already exists/.test(w)),
        `expected skipped warning, got: ${JSON.stringify(commit.body.warnings)}`,
    );
    const doc = await getWorldInfoRepo().get(HANDLE, "Castaway's Lorebook");
    assert.equal(Object.keys(doc.entries).length, 1, 'existing world must not be clobbered');
    // 卡仍绑定到该名 —— 装配时指向既有书,与显式绑定同语义
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Castaway.png'))));
    assert.equal(stored.data.extensions.world, "Castaway's Lorebook");
});

test('issue #10: 同名既有书的 preview → 撞名预警(commit 前可见)', async () => {
    // Castaway's Lorebook 由上一条测试留下
    const { status, body } = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'castaway2.png', dataBase64: pngCardB64(cardWithUnboundBook('Castaway', 7)) },
    });
    assert.equal(status, 200);
    assert.equal(body.summary.embeddedWorldName, "Castaway's Lorebook");
    assert.ok(
        body.warnings.some((w) => /world named "Castaway's Lorebook" already exists.*will NOT overwrite/i.test(w)),
        `expected existing-world preview warning, got: ${JSON.stringify(body.warnings)}`,
    );
});

test('worldbook 同名 rename → GlobalBook1 落库', async () => {
    const renamed = await api('/api/utopinn/import/commit', {
        method: 'POST',
        // worldbook 文档本身无 name,客户端回传原文件名作提示
        body: { name: 'GlobalBook.json', conflict: 'rename', dataBase64: Buffer.from(WORLDBOOK).toString('base64') },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.targetName, 'GlobalBook1');
    const doc = await getWorldInfoRepo().get(HANDLE, 'GlobalBook1');
    assert.equal(doc.entries['0'].key[0], 'dragon');
});

// ---------- 边界 ----------

test('commit — 声明 kind 与探测不符 → 422;非法 kind → 400', async () => {
    const mismatch = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { kind: 'world', dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(mismatch.status, 422);
    assert.match(mismatch.body.error, /detected kind "char"/);

    const badKind = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { kind: 'galaxy', dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(badKind.status, 400);
});

test('无载荷 → 400', async () => {
    const res = await api('/api/utopinn/import/preview', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
});

// ---------- TASK-069:ST theme JSON → named-doc themes 桶 ----------

const THEME = JSON.stringify({
    name: 'BrynNight',
    main_text_color: '#d8e2ee', italics_text_color: '#9fb3cc',
    underline_text_color: '#7fa8d9', quote_text_color: '#a8c9a1',
    blur_tint_color: 'rgba(12,24,40,0.6)', chat_tint_color: 'rgba(10,20,36,0.5)',
    user_mes_blur_tint_color: 'rgba(20,40,66,0.5)', bot_mes_blur_tint_color: 'rgba(16,32,54,0.5)',
    shadow_color: '#05090f', shadow_width: 2, border_color: '#24405e',
    font_scale: 1, blur_strength: 10, chat_width: 50,
    custom_css: '.mes_text { letter-spacing: 0.01em; }',
});

test('preview theme JSON → kind theme + 特征键摘要', async () => {
    const { status, body } = await api('/api/utopinn/import/preview', {
        method: 'POST',
        body: { name: 'BrynNight.json', dataBase64: Buffer.from(THEME).toString('base64') },
    });
    assert.equal(status, 200);
    assert.equal(body.kind, 'theme');
    assert.equal(body.name, 'BrynNight');
    assert.equal(body.targetName, 'BrynNight');
    assert.ok(body.summary.markers >= 3, JSON.stringify(body.summary));
    assert.equal(body.summary.customCss, true);
});

test('commit theme → named-doc themes 桶可读回(repo + 读面同源)', async () => {
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { name: 'BrynNight.json', dataBase64: Buffer.from(THEME).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.ok, true);
    assert.equal(commit.body.kind, 'theme');
    assert.equal(commit.body.targetName, 'BrynNight');

    // named-doc 读面同源实读 —— 主题 JSON 原样回来
    const { getNamedDocRepo } = await import('../src/storage/index.js');
    const doc = await getNamedDocRepo().get(HANDLE, 'themes', 'BrynNight');
    assert.ok(doc, 'themes bucket doc readable');
    assert.equal(doc.name, 'BrynNight');
    assert.equal(doc.main_text_color, '#d8e2ee');
    assert.match(String(doc.custom_css), /letter-spacing/);
});

test('commit theme 撞名 → 409 + conflict=overwrite 覆盖语义', async () => {
    const again = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { name: 'BrynNight.json', dataBase64: Buffer.from(THEME).toString('base64') },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.conflicts?.existingSameName, true);

    const ow = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: {
            name: 'BrynNight.json', conflict: 'overwrite',
            dataBase64: Buffer.from(THEME.replace('letter-spacing: 0.01em', 'letter-spacing: 0.02em')).toString('base64'),
        },
    });
    assert.equal(ow.status, 200);
    assert.equal(ow.body.ok, true);
    const { getNamedDocRepo } = await import('../src/storage/index.js');
    const doc = await getNamedDocRepo().get(HANDLE, 'themes', 'BrynNight');
    assert.match(String(doc.custom_css), /0\.02em/, 'overwrite 真刷新文档');
});
