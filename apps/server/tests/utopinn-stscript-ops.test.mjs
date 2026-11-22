/**
 * TASK-064 — 楼层/会话操作族 + 作者注:服务端 runner 端到端。
 *
 *  POST /api/utopinn/script/run → buildStscriptEnv(patchChat→repo.patch
 *   同一写面,CAS 游标) → 命令副作用落 FsEngine 文档。
 *
 * 断言口径:不只是响应回执 —— 逐条重读 chatRepo 文档核 body/header,
 * 与 web PATCH 写面同事实源;note_* 再经 resolveAuthorsNote 真读验证
 * 注入面消费路径。
 *
 * 跑法:node --test tests/utopinn-stscript-ops.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getChatRepo, initStorage } from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
import { resolveAuthorsNote } from '../src/services/extension-prompts.js';

const HANDLE = 'u1';
const CHAR = 'OpsCard';
const CHAT = 'c1';
const CHAT2 = 'c2';

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
const run = (script, ctx = { charDir: CHAR, chatName: CHAT }) =>
    api('/api/utopinn/script/run', { method: 'POST', body: { script, ...ctx } });
const doc = (chat = CHAT) => getChatRepo().get(HANDLE, CHAR, chat);

const mkFloor = (mes, extra = {}) => ({
    name: extra.name ?? CHAR,
    is_user: extra.is_user ?? false,
    is_system: extra.is_system ?? false,
    send_date: extra.send_date ?? '2026-01-01 00:00',
    mes,
    ...extra,
});

async function seedChat(name, floors, metadata = {}) {
    await getChatRepo().save(HANDLE, CHAR, name,
        { user_name: 'User', character_name: CHAR, create_date: 1, chat_metadata: { variables: {}, ...metadata } },
        floors, null);
}

test.before(async () => {
    if (!getConfigFilePath()) setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-stscript-ops-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) dirs[key] = path.join(ROOT, rel);
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`),
        JSON.stringify({ name: CHAR, data: { name: CHAR } }));

    const { apply: applyScript } = await import('../src/plugins/utopinn-script.js');
    const router = express.Router();
    const ws = {
        register: (spec) => {
            router[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    applyScript({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
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

// ── /del /cut /swap —— 楼层删换,repo 文档为证 ──────────────────────────

test('/cut removes range and persists via repo.patch', async () => {
    await seedChat(CHAT, [mkFloor('a'), mkFloor('b'), mkFloor('c', { is_user: true, name: 'User' })]);
    const r = await run('/cut 0-1');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(String(r.body.pipe), /a\nb\n?$/);
    const d = await doc();
    assert.equal(d.body.length, 1);
    assert.equal(d.body[0].mes, 'c');
    // chat-patch 回执:preImage 降序 remove
    const patchOp = r.body.ops.find(o => o.type === 'chat-patch');
    assert.deepEqual(patchOp.ops, [{ op: 'remove', path: '/body/1' }, { op: 'remove', path: '/body/0' }]);
});

test('/del 2 removes last two floors', async () => {
    await seedChat(CHAT, [mkFloor('x'), mkFloor('y'), mkFloor('z')]);
    const r = await run('/del 2');
    assert.equal(r.body.ok, true);
    const d = await doc();
    assert.equal(d.body.length, 1);
    assert.equal(d.body[0].mes, 'x');
});

test('/swap exchanges floors in the stored doc', async () => {
    await seedChat(CHAT, [mkFloor('a'), mkFloor('b'), mkFloor('c')]);
    const r = await run('/swap 0 2');
    assert.equal(r.body.ok, true);
    const d = await doc();
    assert.deepEqual(d.body.map(m => m.mes), ['c', 'b', 'a']);
    assert.equal(d.header.chat_metadata.tainted, true);
});

// ── /swipe /addswipe /delswipe —— swipe 持久化整楼语义 ──────────────────

test('/swipe switches swipe_id + mes + extra and persists whole floor', async () => {
    await seedChat(CHAT, [
        mkFloor('u', { is_user: true, name: 'User' }),
        mkFloor('v0', {
            swipe_id: 0, swipes: ['v0', 'v1'],
            swipe_info: [{ send_date: 'd0', extra: { tag: 'zero' } }, { send_date: 'd1', gen_started: 'g1', extra: { tag: 'one' } }],
            extra: { tag: 'zero' },
        }),
    ]);
    const r = await run('/swipe direction=right');
    assert.equal(r.body.ok, true);
    const d = await doc();
    const m = d.body[1];
    assert.equal(m.swipe_id, 1);
    assert.equal(m.mes, 'v1');
    assert.equal(m.send_date, 'd1');
    assert.equal(m.gen_started, 'g1');
    assert.deepEqual(m.extra, { tag: 'one' });
    assert.deepEqual(m.swipes, ['v0', 'v1']);
    assert.equal(m.swipe_info.length, 2);
});

test('/addswipe + /delswipe mutate swipes arrays in the stored doc', async () => {
    await seedChat(CHAT, [mkFloor('u', { is_user: true, name: 'User' }), mkFloor('base')]);
    let r = await run('/addswipe switch=true alt');
    assert.equal(r.body.pipe, '1');
    let d = await doc();
    assert.deepEqual(d.body[1].swipes, ['base', 'alt']);
    assert.equal(d.body[1].swipe_id, 1);
    assert.equal(d.body[1].mes, 'alt');

    r = await run('/delswipe');
    assert.equal(r.body.pipe, '0');
    d = await doc();
    assert.deepEqual(d.body[1].swipes, ['base']);
    assert.equal(d.body[1].swipe_id, 0);
    assert.equal(d.body[1].mes, 'base');
    assert.equal(d.header.chat_metadata.tainted, true);
});

// ── /hide /unhide /delname /message-* /reroll-pick /messages ────────────

test('/hide + /unhide persist is_system flags', async () => {
    await seedChat(CHAT, [mkFloor('a'), mkFloor('b')]);
    await run('/hide 0');
    let d = await doc();
    assert.equal(d.body[0].is_system, true);
    await run('/unhide 0');
    d = await doc();
    assert.equal(d.body[0].is_system, false);
});

test('/delname removes all floors by name', async () => {
    await seedChat(CHAT, [
        mkFloor('u1', { is_user: true, name: 'User' }),
        mkFloor('x1'),
        mkFloor('x2'),
    ]);
    const r = await run(`/delname ${CHAR}`);
    assert.equal(r.body.ok, true);
    const d = await doc();
    assert.equal(d.body.length, 1);
    assert.equal(d.body[0].mes, 'u1');
});

test('/message-role and /message-name mutate floor fields', async () => {
    await seedChat(CHAT, [
        mkFloor('u', { is_user: true, name: 'User' }),
        mkFloor('a'),
    ]);
    let r = await run('/message-role at=1 system');
    assert.equal(r.body.pipe, 'system');
    let d = await doc();
    assert.equal(d.body[1].extra.type, 'narrator');
    r = await run('/message-name at=0 Hero');
    assert.equal(r.body.pipe, 'Hero');
    d = await doc();
    assert.equal(d.body[0].name, 'Hero');
});

test('/messages reads floors; /reroll-pick writes pick_reroll_seed', async () => {
    await seedChat(CHAT, [mkFloor('u', { is_user: true, name: 'User' }), mkFloor('a')]);
    let r = await run('/messages names=off 0-1');
    assert.equal(r.body.pipe, 'u\n\na');
    r = await run('/reroll-pick');
    assert.equal(r.body.pipe, '1');
    const d = await doc();
    assert.equal(d.header.chat_metadata.pick_reroll_seed, 1);
});

// ── /go —— 会话导航 op receipt ─────────────────────────────────────────

test('/go resolves a sibling chat by name and emits go op', async () => {
    await seedChat(CHAT, [mkFloor('here')]);
    await seedChat(CHAT2, [mkFloor('there')]);
    const r = await run(`/go ${CHAT2}`);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pipe, CHAT2);
    const goOp = r.body.ops.find(o => o.type === 'go');
    assert.deepEqual(goOp, { type: 'go', target: CHAT2, charDir: CHAR, chatName: CHAT2 });
});

test('/go last targets the most recent other chat', async () => {
    await seedChat(CHAT2, [mkFloor('older')]);
    await new Promise(r => setTimeout(r, 30));
    await seedChat(CHAT, [mkFloor('newest')]);
    const r = await run('/go last');
    assert.equal(r.body.ok, true);
    const goOp = r.body.ops.find(o => o.type === 'go');
    assert.equal(goOp?.chatName, CHAT2);
});

test('/go typo resolves to null → warn, no op, no implicit chat', async () => {
    const r = await run('/go NoSuchCharEver');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pipe, '');
    assert.equal(r.body.ops.find(o => o.type === 'go'), undefined);
    assert.ok(r.body.notifications.some(n => /No matches/.test(n.text)));
});

// ── 作者注 —— chat_metadata.note_* + resolveAuthorsNote 消费 ───────────

test('/note /note-depth /note-position /note-role write metadata the injector reads', async () => {
    await seedChat(CHAT, [mkFloor('u', { is_user: true, name: 'User' })]);
    await run('/note watch the knife');
    await run('/note-depth 2');
    await run('/note-frequency 1');
    await run('/note-position chat');
    await run('/note-role user');
    const d = await doc();
    const md = d.header.chat_metadata;
    assert.equal(md.note_prompt, 'watch the knife');
    assert.equal(md.note_depth, 2);
    assert.equal(md.note_interval, 1);
    assert.equal(md.note_position, 1);
    assert.equal(md.note_role, 1);
    // 真读路径:generate-context 的 resolveAuthorsNote 消费同一份 metadata
    const an = resolveAuthorsNote({ chatMetadata: md, userMessageCount: 1, noteSettings: {}, charDir: CHAR });
    assert.equal(an.shouldAdd, true);
    assert.equal(an.entry.value, 'watch the knife');
    assert.equal(an.entry.position, 1);
    assert.equal(an.entry.depth, 2);
    assert.equal(an.entry.role, 1);
    // /note-get 读面
    const r = await run('/note-get');
    assert.equal(r.body.pipe, 'watch the knife');
});

// ── 变量域 + /sendas 校验 + 结构化错误回执 ─────────────────────────────

test('/incvar /decvar /setvar persist into chat_metadata.variables', async () => {
    await seedChat(CHAT, [mkFloor('u', { is_user: true, name: 'User' })]);
    const r = await run('/setvar key=c 10 | /incvar c | /decvar c | /getvar c');
    assert.equal(r.body.pipe, '10');
    // persistMetadata 是 fire-and-forget,轮询落库
    let md;
    for (let i = 0; i < 40; i++) {
        md = (await doc()).header.chat_metadata;
        if (md.variables?.c === 10) break; // incvar/decvar 存 JSON number
        await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(md.variables.c, 10);
});

test('/sendas appends a character floor via existing seam', async () => {
    await seedChat(CHAT, [mkFloor('u', { is_user: true, name: 'User' })]);
    const r = await run(`/sendas name=${CHAR} hello there`);
    assert.equal(r.body.ok, true);
    const d = await doc();
    const m = d.body.at(-1);
    assert.equal(m.name, CHAR);
    assert.equal(m.mes, 'hello there');
});

test('unknown command returns structured error (not 500, not silent)', async () => {
    await seedChat(CHAT, [mkFloor('a')]);
    const r = await run('/definitely-bogus xyz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error?.code, 'unknown_command');
    assert.match(r.body.error?.message ?? '', /Unknown command/);
    assert.ok(typeof r.body.error?.hint === 'string');
});

test('script registry endpoint lists the new commands', async () => {
    const r = await api('/api/utopinn/script/commands');
    assert.equal(r.status, 200);
    const names = r.body.commands.map(c => c.name);
    for (const n of ['del', 'cut', 'swipe', 'swap', 'go', 'note', 'delswipe', 'addswipe', 'hide', 'unhide', 'messages']) {
        assert.ok(names.includes(n), `registry missing ${n}`);
    }
    const note = r.body.commands.find(c => c.name === 'note');
    assert.ok(note.aliases.includes('note-set') && note.aliases.includes('note-get'));
});
