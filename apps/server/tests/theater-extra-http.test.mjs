/**
 * TASK-044 剧场楼层 extra 契约 —— HTTP 写/读面(node:test,真 FsEngine + 真 express)。
 *
 * 契约(与生成侧 theater-extra.test.mjs 姊妹):
 *   - POST /api/utopinn/characters/:dir/chats/:name/messages 追加楼层,
 *     message.extra 全透传(scene/choices/narrator/type 原样落盘,
 *     仅剥协议层 extra.luker_generation_id);
 *   - PATCH /api/utopinn/characters/:dir/chats/:name 的 /body/<i>/extra/*
 *     路径同样透传;
 *   - GET 同一路由回读:extra 逐键原样;无 extra 的老楼层不炸。
 *
 * 跑法:node --test tests/theater-extra-http.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { getChatRepo, initStorage } from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLE = 'u1';

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

async function api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
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

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-theater-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(ROOT, rel);
    }
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    fs.mkdirSync(dirs.backups, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    // 种子:无 extra 的老聊天 + 待写入的新聊天名
    await getChatRepo().save(HANDLE, 'Alice', 'legacy',
        { user_name: 'User', chat_metadata: {} },
        [
            { name: 'User', is_user: true, send_date: 1, mes: 'old hi' },
            { name: 'Alice', is_user: false, send_date: 2, mes: 'old reply' },
        ],
        null);

    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
        next();
    });
    app.use(utopinnLibraryRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

test('POST messages:extra.scene/choices/narrator 原样落盘,GET 逐键回读', async () => {
    const floor = {
        name: 'Alice',
        is_user: false,
        is_system: false,
        mes: '烛火摇曳。',
        send_date: '2026-11-20T12:00:00.000Z',
        swipes: ['烛火摇曳。'],
        swipe_id: 0,
        swipe_info: [{ send_date: '2026-11-20T12:00:00.000Z', gen_started: null, gen_finished: null, extra: {} }],
        extra: {
            scene: { bg: '/assets/backgrounds/hall.jpg', bgm: 'rain.ogg' },
            choices: [{ label: '上前', goto: 'h2' }, { text: '退下' }],
            narrator: true,
            luker_generation_id: 'proto-id-should-strip', // 协议层令牌:落盘前剥
        },
    };
    const appended = await api('/api/utopinn/characters/Alice/chats/t1/messages', {
        method: 'POST',
        body: { message: floor },
    });
    assert.equal(appended.status, 200);
    assert.equal(appended.body.appended, 1);
    assert.equal(appended.body.created, true);

    const got = await api('/api/utopinn/characters/Alice/chats/t1');
    assert.equal(got.status, 200);
    assert.equal(got.body.messages.length, 1);
    const back = got.body.messages[0];
    assert.equal(back.mes, '烛火摇曳。');
    assert.equal(back.name, 'Alice');
    assert.deepEqual(back.extra.scene, { bg: '/assets/backgrounds/hall.jpg', bgm: 'rain.ogg' });
    assert.deepEqual(back.extra.choices, [{ label: '上前', goto: 'h2' }, { text: '退下' }]);
    assert.equal(back.extra.narrator, true);
    assert.equal(back.extra.luker_generation_id, undefined, '协议层令牌被剥,其余键原样');
});

test('PATCH /body/<i>/extra/* 路径透传:scene 覆写 + choices 追加', async () => {
    // 先落一楼
    await api('/api/utopinn/characters/Alice/chats/t2/messages', {
        method: 'POST',
        body: {
            message: { name: 'Alice', is_user: false, is_system: false, mes: 'v1', send_date: '2026-11-20T12:00:00.000Z', extra: { scene: { bg: '/a.jpg' } } },
        },
    });
    const patched = await api('/api/utopinn/characters/Alice/chats/t2', {
        method: 'PATCH',
        body: {
            ops: [
                { op: 'replace', path: '/body/0/extra/scene', value: { bg: '/b.jpg', bgm: 'wind.ogg' } },
                { op: 'add', path: '/body/0/extra/choices', value: [{ label: '继续' }] },
            ],
        },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.applied, 2);

    const got = await api('/api/utopinn/characters/Alice/chats/t2');
    const back = got.body.messages[0];
    assert.deepEqual(back.extra.scene, { bg: '/b.jpg', bgm: 'wind.ogg' });
    assert.deepEqual(back.extra.choices, [{ label: '继续' }]);
});

test('上游惯例旁白楼层(extra.type=narrator + is_system)透传', async () => {
    const floor = {
        name: '',
        is_user: false,
        is_system: true,
        mes: '【旁白】三日后。',
        send_date: '2026-11-20T12:00:00.000Z',
        extra: { type: 'narrator' },
    };
    const appended = await api('/api/utopinn/characters/Alice/chats/t3/messages', {
        method: 'POST',
        body: { message: floor },
    });
    assert.equal(appended.status, 200);

    const got = await api('/api/utopinn/characters/Alice/chats/t3');
    const back = got.body.messages[0];
    assert.equal(back.is_system, true);
    assert.equal(back.extra.type, 'narrator');
});

test('老聊天无 extra → GET 不炸,楼层原样', async () => {
    const got = await api('/api/utopinn/characters/Alice/chats/legacy');
    assert.equal(got.status, 200);
    assert.equal(got.body.messages.length, 2);
    assert.equal(got.body.messages[0].mes, 'old hi');
    assert.equal(got.body.messages[0].extra, undefined);
    assert.equal(got.body.messages[1].extra, undefined);
});
