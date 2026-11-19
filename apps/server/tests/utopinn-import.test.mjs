/**
 * /api/utopinn/import 导入管线(utopinn-import.js + services/import-pipeline.js)
 * 集成测试(node:test)。真 FsEngine + 真 express + 真 HTTP;
 * request.user 经中间件注入(等价 requireLogin+setUserData 之后的形态)。
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
import { router as utopinnImportRouter } from '../src/endpoints/utopinn-import.js';

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
    app.use('/api/utopinn', utopinnImportRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    server?.close();
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
    const commit = await api('/api/utopinn/import/commit', {
        method: 'POST',
        body: { name: 'GlobalBook.json', dataBase64: Buffer.from(WORLDBOOK).toString('base64') },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.kind, 'world');
    assert.equal(commit.body.targetName, 'GlobalBook');
    const doc = await getWorldInfoRepo().get(HANDLE, 'GlobalBook');
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
        body: { kind: 'theme', dataBase64: pngCardB64(CARD_ALICE) },
    });
    assert.equal(badKind.status, 400);
});

test('无载荷 → 400', async () => {
    const res = await api('/api/utopinn/import/preview', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
});
