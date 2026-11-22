/**
 * TASK-044 余量集成测试(node:test):
 *   novel 章目录聚合(GET …/chats/:chatName/chapters:sidecar chapters ns
 *   优先,否则楼→章推导)+ theater 三件套(GET /characters/:charDir/assets)
 *   + scene/chapters sidecar 经通用 state/chat 面读写(ns 约定钉样)。
 * 真 FsEngine + 种子数据 + 真 express + 真 HTTP;request.user 经中间件注入。
 * 跑法:node --test tests/novel-theater.test.mjs
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
import { getChatRepo, initStorage } from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
// 插件传递依赖(secrets.js)模块级读 config —— 动态 import 放 test.before。

const HANDLE = 'u1';
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

// 与 tests/storage/harness/fs-harness.js USER_DIRS 同构
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
    name: 'Alice', chat: 'novel',
    data: { name: 'Alice', description: 'A wandering knight.', first_mes: 'Hail.', extensions: {} },
});

async function api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/** chat_state 通用写面:patch ns sidecar(target=单卡会话)。 */
async function patchState(chatName, namespace, operations) {
    return api('/api/utopinn/state/chat/patch', {
        method: 'POST',
        body: {
            avatar_url: 'Alice.png', file_name: `${chatName}.jsonl`,
            namespace, operations,
        },
    });
}

/** chat_state 通用读面(body 形)。 */
async function getState(chatName, namespace) {
    return api('/api/utopinn/state/chat/get', {
        method: 'POST',
        body: { avatar_url: 'Alice.png', file_name: `${chatName}.jsonl`, namespace },
    });
}

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    const { apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js');
    const router = express.Router();
    const ws = {
        register: (spec) => {
            router[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    applyUtopinnLibrary({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-novel-th-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(ROOT, rel);
    }
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    fs.mkdirSync(dirs.avatars, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    // ---- 种子:角色卡 ----
    fs.writeFileSync(
        path.join(dirs.characters, 'Alice.png'),
        writeCardToPng(new Uint8Array(PNG_1PX), CARD_ALICE),
    );

    // ---- 种子:会话 ----
    // novel:system 楼=分章标记(markers 策略:序章 + 第三章/第四章)
    await getChatRepo().save(HANDLE, 'Alice', 'novel',
        { user_name: 'User', character_name: 'Alice', create_date: 1, chat_metadata: {} },
        [
            { name: 'User', is_user: true, send_date: 2, mes: 'prologue first para.\n\nsecond para' },
            { name: 'Alice', is_user: false, send_date: 3, mes: 'prologue continued' },
            { name: '', is_system: true, send_date: 4, mes: '第三章 龙眠谷' },
            { name: 'Alice', is_user: false, send_date: 5, mes: 'chapter three text one' },
            { name: 'Alice', is_user: false, send_date: 6, mes: 'chapter three text two' },
            { name: '', is_system: true, send_date: 7, mes: '第四章:归途' },
            { name: 'Alice', is_user: false, send_date: 8, mes: 'chapter four text' },
        ],
        null);
    // plain:5 楼无标记 → segmented(4+1)
    await getChatRepo().save(HANDLE, 'Alice', 'plain',
        { user_name: 'User', character_name: 'Alice', create_date: 9, chat_metadata: {} },
        [0, 1, 2, 3, 4].map((i) => ({ name: 'Alice', is_user: false, send_date: 10 + i, mes: `floor ${i} text` })),
        null);
    // tiny:2 楼 → single 兜底
    await getChatRepo().save(HANDLE, 'Alice', 'tiny',
        { user_name: 'User', character_name: 'Alice', create_date: 20, chat_metadata: {} },
        [
            { name: 'User', is_user: true, send_date: 21, mes: 'hi' },
            { name: 'Alice', is_user: false, send_date: 22, mes: 'hello there' },
        ],
        null);
    // scnovel:sidecar 章清单专用(写 chapters ns,不走推导)
    await getChatRepo().save(HANDLE, 'Alice', 'scnovel',
        { user_name: 'User', character_name: 'Alice', create_date: 30, chat_metadata: {} },
        [0, 1, 2, 3].map((i) => ({ name: 'Alice', is_user: false, send_date: 31 + i, mes: `part ${i} opening line` })),
        null);

    // ---- 种子:theater 资产(三件套既有落盘约定 + bgm 新约定) ----
    fs.mkdirSync(path.join(dirs.characters, 'Alice', 'backgrounds'), { recursive: true });
    fs.mkdirSync(path.join(dirs.characters, 'Alice', 'bgm'), { recursive: true });
    fs.mkdirSync(path.join(dirs.backgrounds), { recursive: true });
    fs.mkdirSync(path.join(dirs.assets, 'bgm'), { recursive: true });
    fs.writeFileSync(path.join(dirs.characters, 'Alice', 'joy.png'), PNG_1PX);
    fs.writeFileSync(path.join(dirs.characters, 'Alice', 'joy-angry.png'), PNG_1PX);
    fs.writeFileSync(path.join(dirs.characters, 'Alice', 'readme.txt'), 'not an image');
    fs.writeFileSync(path.join(dirs.characters, 'Alice', 'backgrounds', 'hall.jpg'), PNG_1PX);
    fs.writeFileSync(path.join(dirs.characters, 'Alice', 'bgm', 'rain.ogg'), Buffer.from('OggS'));
    fs.writeFileSync(path.join(dirs.backgrounds, 'night.png'), PNG_1PX);
    fs.writeFileSync(path.join(dirs.assets, 'bgm', 'theme.ogg'), Buffer.from('OggS'));

    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
        next();
    });
    app.use(router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- novel 章目录(推导路) ----------

test('chapters derived/markers — system 楼分章,序章+两章(range 含端点不含标记)', async () => {
    const { status, body } = await api('/api/utopinn/characters/Alice/chats/novel/chapters');
    assert.equal(status, 200);
    assert.equal(body.source, 'derived');
    assert.equal(body.strategy, 'markers');
    assert.equal(body.floors, 7);
    assert.equal(body.total, 3);

    const [pro, ch3, ch4] = body.items;
    assert.equal(pro.kind, 'prologue');
    assert.deepEqual(pro.range, [0, 1]);
    assert.equal(pro.floors, 2);
    assert.equal(pro.snippet, 'prologue first para.'); // 首段(空行切段)

    assert.equal(ch3.kind, 'chapter');
    assert.equal(ch3.num, '第三章');
    assert.equal(ch3.title, '龙眠谷');
    assert.deepEqual(ch3.range, [3, 4]);
    assert.equal(ch3.markerFloor, 2);
    assert.equal(ch3.snippet, 'chapter three text one');

    assert.equal(ch4.num, '第四章');
    assert.equal(ch4.title, '归途');
    assert.deepEqual(ch4.range, [6, 6]);
    assert.equal(ch4.markerFloor, 5);
});

test('chapters derived/segmented — 无标记 >4 楼按 4 楼一节', async () => {
    const { status, body } = await api('/api/utopinn/characters/Alice/chats/plain/chapters');
    assert.equal(status, 200);
    assert.equal(body.source, 'derived');
    assert.equal(body.strategy, 'segmented');
    assert.equal(body.total, 2);
    assert.equal(body.items[0].kind, 'section');
    assert.deepEqual(body.items[0].range, [0, 3]);
    assert.deepEqual(body.items[1].range, [4, 4]);
    assert.equal(body.items[0].title, 'floor 0 text');
});

test('chapters derived/single — 小楼兜底单章;404/400 诚实语义', async () => {
    const single = await api('/api/utopinn/characters/Alice/chats/tiny/chapters');
    assert.equal(single.status, 200);
    assert.equal(single.body.strategy, 'single');
    assert.equal(single.body.total, 1);
    assert.deepEqual(single.body.items[0].range, [0, 1]);
    assert.equal(single.body.items[0].title, 'tiny'); // 会话名兜底作题

    const missing = await api('/api/utopinn/characters/Alice/chats/ghost/chapters');
    assert.equal(missing.status, 404);
    const missingChar = await api('/api/utopinn/characters/ghost/chats/novel/chapters');
    assert.equal(missingChar.status, 404);
    const unsafe = await api('/api/utopinn/characters/Alice/chats/a%2Fb/chapters');
    assert.equal(unsafe.status, 400);
});

// ---------- novel 章目录(sidecar 'chapters' ns 优先) ----------

test('chapters sidecar — 通用 state 面写 chapters ns;聚合视图切 sidecar 源,非法条目记 skipped', async () => {
    // 写显式章清单:to 缺省=下条 from-1/末楼;from:99 越界应被跳过
    const patch = await patchState('scnovel', 'chapters', [
        { op: 'add', path: '/items', value: [
            { from: 0, title: '序', num: '序章' },
            { from: 1, title: '龙眠谷', num: '第三章' },
            { from: 99, title: '越界' },
        ] },
    ]);
    assert.equal(patch.status, 200);
    assert.equal(patch.body.ok, true);

    // 通用读面能原样读回(证明 sidecar 走 chat_state 而非新存储)
    const got = await getState('scnovel', 'chapters');
    assert.equal(got.status, 200);
    assert.equal(got.body.data.items.length, 3);

    const { status, body } = await api('/api/utopinn/characters/Alice/chats/scnovel/chapters');
    assert.equal(status, 200);
    assert.equal(body.source, 'sidecar');
    assert.equal(body.strategy, 'sidecar');
    assert.equal(body.total, 2);
    assert.equal(body.skipped, 1); // from:99 越界,如实记数

    const [a, b] = body.items;
    assert.equal(a.kind, 'sidecar');
    assert.equal(a.title, '序');
    assert.deepEqual(a.range, [0, 0]); // to 缺省 = 下条 from-1
    assert.equal(b.num, '第三章');
    assert.deepEqual(b.range, [1, 3]); // 末条 to 缺省 = 末楼
    assert.equal(b.snippet, 'part 1 opening line');
});

test('chapters sidecar 形不符回推导 —— items 非数组的 doc 不劫走视图', async () => {
    await patchState('scnovel', 'chapters', [
        { op: 'add', path: '/items', value: 'not-an-array' },
    ]);
    const { status, body } = await api('/api/utopinn/characters/Alice/chats/scnovel/chapters');
    assert.equal(status, 200);
    assert.equal(body.source, 'derived'); // 4 楼无标记 ≤4 → single
    assert.equal(body.strategy, 'single');
});

// ---------- theater scene sidecar(ns 约定:通用 state 面即写读通路) ----------

test('scene ns — 通用 state/chat 面 patch+get 回环(剧场「当前场」运行态)', async () => {
    const patch = await patchState('novel', 'scene', [
        { op: 'add', path: '/bg', value: '/characters/Alice/backgrounds/hall.jpg' },
        { op: 'add', path: '/bgm', value: 'rain.ogg' },
        { op: 'add', path: '/cast', value: [{ name: 'Alice', sprite: 'joy' }] },
        { op: 'add', path: '/floor', value: 6 },
    ]);
    assert.equal(patch.status, 200);
    assert.equal(patch.body.created, true);

    const { status, body } = await getState('novel', 'scene');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.bg, '/characters/Alice/backgrounds/hall.jpg');
    assert.equal(body.data.bgm, 'rain.ogg');
    assert.deepEqual(body.data.cast, [{ name: 'Alice', sprite: 'joy' }]);
    assert.equal(body.data.floor, 6);
});

// ---------- theater 资产清单 ----------

test('assets — 三件套枚举:立绘 label 同 /sprites/get,背景 char+global,BGM 双侧', async () => {
    const { status, body } = await api('/api/utopinn/characters/Alice/assets');
    assert.equal(status, 200);
    assert.equal(body.charDir, 'Alice');
    assert.equal(body.name, 'Alice');
    assert.equal(body.empty, false);

    // sprites:顶层图,label 抽取(joy-angry → joy);非图文件不收
    assert.deepEqual(
        body.sprites.map((s) => s.file).sort(),
        ['joy-angry.png', 'joy.png'],
    );
    const joy = body.sprites.find((s) => s.file === 'joy.png');
    assert.equal(joy.label, 'joy');
    assert.equal(joy.url, '/characters/Alice/joy.png');
    assert.equal(joy.scope, 'char');
    assert.ok(joy.bytes > 0);

    // backgrounds:char 级 backgrounds/ + 全局 backgrounds/
    const bgChar = body.backgrounds.find((b) => b.file === 'hall.jpg');
    assert.equal(bgChar.url, '/characters/Alice/backgrounds/hall.jpg');
    assert.equal(bgChar.scope, 'char');
    const bgGlobal = body.backgrounds.find((b) => b.file === 'night.png');
    assert.equal(bgGlobal.url, '/backgrounds/night.png');
    assert.equal(bgGlobal.scope, 'global');

    // bgm:char 级 bgm/ + 全局 assets/bgm/
    const rain = body.bgm.find((b) => b.file === 'rain.ogg');
    assert.equal(rain.url, '/characters/Alice/bgm/rain.ogg');
    assert.equal(rain.scope, 'char');
    const theme = body.bgm.find((b) => b.file === 'theme.ogg');
    assert.equal(theme.url, '/assets/bgm/theme.ogg');
    assert.equal(theme.scope, 'global');
});

test('assets — 卡不在 404;不安全名 400(诚实语义,不空壳假成功)', async () => {
    const missing = await api('/api/utopinn/characters/ghost/assets');
    assert.equal(missing.status, 404);
    const unsafe = await api('/api/utopinn/characters/..%2F..%2Fetc/assets');
    assert.equal(unsafe.status, 400);
});
