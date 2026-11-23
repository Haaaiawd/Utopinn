/**
 * TASK-064 批二 — WI 族 + 会话/命名 + 阻塞弹窗族:服务端 runner 端到端。
 *
 * 断言口径(与 utopinn-stscript-ops 同规):不只看响应回执 ——
 * WI 书重读 WorldInfoRepo 文档、globalSelect 重读 settings 档、
 * timedWorldInfo 重读 chat_metadata;挂起 seam 走 /interact 真兑现。
 *
 * 跑法:node --test tests/utopinn-stscript-wi.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getChatRepo, getSettingsRepo, getWorldInfoRepo, initStorage } from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const HANDLE = 'u1';
const CHAR = 'WiCard';
const CHAT = 'c1';

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
const interact = (runId, action, value) =>
    api('/api/utopinn/script/interact', { method: 'POST', body: { runId, action, value } });
const chatDoc = (chat = CHAT, char = CHAR) => getChatRepo().get(HANDLE, char, chat);
const settingsDoc = () => getSettingsRepo().get(HANDLE);
const wiGlobalSelect = async () => (await settingsDoc())?.world_info_settings?.world_info?.globalSelect ?? [];

/** persistSettings/persistMetadata 是 fire-and-forget 落盘 —— 断言前等它飞完。 */
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) return last;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
}
const globalSelectWhen = async (expected) => waitFor(async () => {
    const sel = await wiGlobalSelect();
    return Array.isArray(sel) && sel.length === expected.length && expected.every((n) => sel.includes(n)) ? sel : null;
});

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

async function seedBook(name, entries = {}) {
    await getWorldInfoRepo().save(HANDLE, name, { entries });
}

test.before(async () => {
    if (!getConfigFilePath()) setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-stscript-wi-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) dirs[key] = path.join(ROOT, rel);
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`),
        JSON.stringify({ name: CHAR, data: { name: CHAR } }));
    await seedChat(CHAT, [mkFloor('hello'), mkFloor('hi', { is_user: true, name: 'User' })]);

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

// ── /world:globalSelect → settings 档 ────────────────────────────────────

test('/world activates book into settings.world_info_settings.world_info.globalSelect', async () => {
    await seedBook('Alpha');
    await run('/world'); // 清底(globalSelect 跨用例累积)
    const r = await run('/world Alpha');
    assert.equal(r.body.ok, true);
    assert.deepEqual(await globalSelectWhen(['Alpha']), ['Alpha']);
});

test('/world state=off / toggle mutate the persisted selection', async () => {
    await seedBook('Beta');
    await run('/world'); // 清底
    await run('/world Beta');
    assert.deepEqual(await globalSelectWhen(['Beta']), ['Beta']);
    await run('/world state=toggle Beta');
    assert.deepEqual(await globalSelectWhen([]), []);
});

// ── /getchatbook:create + chat_metadata 绑定 ──────────────────────────────

test('/getchatbook creates repo book and binds chat_metadata.world_info', async () => {
    const r = await run('/getchatbook name=ChatBound');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pipe, 'ChatBound');
    const book = await getWorldInfoRepo().get(HANDLE, 'ChatBound');
    assert.ok(book && typeof book.entries === 'object');
    const meta = await waitFor(async () => (await chatDoc())?.header?.chat_metadata?.world_info === 'ChatBound' ? (await chatDoc()).header.chat_metadata : null);
    assert.equal(meta?.world_info, 'ChatBound');
});

test('/getchatbook re-returns the bound book on second call', async () => {
    // chat_metadata.world_info 绑定经 persistMetadata 在飞写 —— 先等落库
    await waitFor(async () => (await chatDoc())?.header?.chat_metadata?.world_info === 'ChatBound');
    const r = await run('/getchatbook');
    assert.equal(r.body.pipe, 'ChatBound');
});

// ── /getglobalbooks ──────────────────────────────────────────────────────

test('/getglobalbooks reflects the persisted selection', async () => {
    await run('/world'); // 清底
    await run('/world Alpha');
    const r = await run('/getglobalbooks');
    assert.deepEqual(JSON.parse(r.body.pipe), ['Alpha']);
});

// ── 条目 CRUD:createentry/findentry/getentryfield/setentryfield ───────────

test('/createentry + /findentry + /getentryfield roundtrip through WorldInfoRepo', async () => {
    const r1 = await run('/createentry file=ChatBound key=dragon The dragon entry text');
    const uid = r1.body.pipe;
    assert.match(uid, /^\d+$/);
    const book = await getWorldInfoRepo().get(HANDLE, 'ChatBound');
    assert.equal(book.entries[uid].content, 'The dragon entry text');
    assert.deepEqual(book.entries[uid].key, ['dragon']);

    const r2 = await run('/findentry file=ChatBound dragon');
    assert.equal(r2.body.pipe, uid);

    const r3 = await run(`/getentryfield file=ChatBound field=content ${uid}`);
    assert.equal(r3.body.pipe, 'The dragon entry text');
});

test('/setentryfield writes through repo.save (verified by re-read)', async () => {
    const r1 = await run('/findentry file=ChatBound dragon');
    const uid = r1.body.pipe;
    await run(`/setentryfield file=ChatBound uid=${uid} field=content Rewritten`);
    let book = await getWorldInfoRepo().get(HANDLE, 'ChatBound');
    assert.equal(book.entries[uid].content, 'Rewritten');
    await run(`/setentryfield file=ChatBound uid=${uid} field=key red, blue`);
    book = await getWorldInfoRepo().get(HANDLE, 'ChatBound'); // repo.get 是快照,重取
    assert.deepEqual(book.entries[uid].key, ['red', 'blue']);
});

// ── timed effects → chat_metadata.timedWorldInfo ──────────────────────────

test('/wi-set-timed-effect persists sticky into chat metadata; get reads it back', async () => {
    // test 7 把 key 改成了 red/blue —— 按新 key 搜
    const r1 = await run('/findentry file=ChatBound red');
    const uid = r1.body.pipe;
    assert.match(uid, /^\d+$/);
    await run(`/setentryfield file=ChatBound uid=${uid} field=sticky 3`);
    const r2 = await run(`/wi-set-timed-effect file=ChatBound uid=${uid} effect=sticky on`);
    assert.equal(r2.body.ok, true);
    // persistMetadata 在飞写 —— 轮询 chat_metadata 而不是即时读
    const meta = await waitFor(async () => (await chatDoc())?.header?.chat_metadata?.timedWorldInfo?.sticky ? (await chatDoc()).header.chat_metadata : null);
    assert.ok(meta?.timedWorldInfo?.sticky, 'timedWorldInfo.sticky persisted');
    const key = Object.keys(meta.timedWorldInfo.sticky)[0];
    assert.ok(key.endsWith(`.${uid}`) || key.includes(uid), `effect key ${key} names uid ${uid}`);

    const r3 = await run(`/wi-get-timed-effect file=ChatBound effect=sticky ${uid}`);
    assert.equal(r3.body.pipe, 'true');
});

// ── /renamechat /getchatname/forcesave ────────────────────────────────────

test('/renamechat migrates the chat doc; /getchatname reflects new id', async () => {
    const r = await run('/renamechat renamed-c1');
    assert.equal(r.body.ok, true);
    try {
        assert.equal(await chatDoc('renamed-c1') !== null, true);
        // c1 已不存在 —— /getchatname 必须在新名 ctx 下跑(env 绑会话)
        const r2 = await run('/getchatname', { charDir: CHAR, chatName: 'renamed-c1' });
        assert.equal(r2.body.pipe, 'renamed-c1');
    } finally {
        // 还原放 finally —— assert 挂了也不能让后续用例吃 404
        await run('/renamechat c1', { charDir: CHAR, chatName: 'renamed-c1' });
    }
});

test('/getcharname... /forcesave persists settings doc (globalSelect 落档)', async () => {
    const r = await run('/forcesave');
    assert.equal(r.body.ok, true);
    const s = await settingsDoc();
    assert.ok(s && typeof s === 'object');
});

// ── /rename-char:json-only 卡 → 显式失败回执(png 写面未通)──────────────

test('/rename-char on json-only card returns false (explicit, not silent)', async () => {
    const r = await run('/rename-char NewName');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pipe, 'false');
});

// ── /impersonate:generateImpersonate 未绑 → 结构化 error ──────────────────

test('/impersonate errors explicitly while generateImpersonate is unbound', async () => {
    const r = await run('/impersonate say hello');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error?.code, 'execution_error');
    assert.match(r.body.error?.message ?? '', /generateImpersonate/);
});

// ── 阻塞弹窗族:/run awaiting + /interact 兑现 ────────────────────────────

test('/input suspends into awaiting receipt; interact submit resumes with value', async () => {
    const r = await run('/input Type something');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.awaiting?.kind, 'input');
    const r2 = await interact(r.body.awaiting.runId, 'submit', 'user typed');
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.pipe, 'user typed');
});

test('/popup result=on suspends; interact submit=1 returns code 1', async () => {
    const r = await run('/popup result=on Continue?');
    assert.equal(r.body.awaiting?.kind, 'popup');
    const r2 = await interact(r.body.awaiting.runId, 'submit', 1);
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.pipe, '1');
});

test('/buttons suspends; interact submit=[code] returns clicked label', async () => {
    const r = await run('/buttons labels=["Yes","No"] Choose');
    assert.equal(r.body.awaiting?.kind, 'buttons');
    // code=2 → 第一枚 label
    const r2 = await interact(r.body.awaiting.runId, 'submit', [2]);
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.pipe, 'Yes');
});

test('/input interact cancel → cancel semantics (false → empty pipe path)', async () => {
    const r = await run('/input Question?');
    assert.equal(r.body.awaiting?.kind, 'input');
    const r2 = await interact(r.body.awaiting.runId, 'cancel');
    // /input 上游:cancel(false) → '' 入管道(非错误)
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.pipe, '');
});

// ── /? /help:系统消息楼落盘 ───────────────────────────────────────────────

test('/? writes a help system-message floor via sendSystemMessage seam', async () => {
    const r = await run('/? slash');
    assert.equal(r.body.ok, true);
    const d = await chatDoc();
    const last = d.body[d.body.length - 1];
    assert.equal(last.is_system, true);
    assert.match(last.mes, /Slash commands/);
    assert.match(last.mes, /\/world/);
});

// ── /persona-set(别名 /name):temp 落 settings.username;lookup 落 default_persona ──

test('/name temp persists settings.username; persona lookup sets default_persona', async () => {
    // 先种一份 persona,lookup 才有得命中(活对象在 settings 档上)。
    const s = (await settingsDoc()) ?? {};
    s.power_user ??= {};
    s.power_user.personas = { 'alice.png': 'Alice' };
    await getSettingsRepo().save(HANDLE, s);

    const r1 = await run('/name mode=temp Wanderer');
    assert.equal(r1.body.ok, true);
    const persisted = await waitFor(async () => (await settingsDoc())?.username === 'Wanderer');
    assert.ok(persisted, 'settings.username should persist Wanderer');

    const r2 = await run('/name Alice');
    assert.equal(r2.body.ok, true);
    const sel = await waitFor(async () =>
        (await settingsDoc())?.power_user?.default_persona === 'alice.png');
    assert.ok(sel, 'power_user.default_persona should persist alice.png');

    // lookup miss → warning notify,不落档
    const r3 = await run('/name mode=lookup Ghost');
    assert.equal(r3.body.ok, true);
    assert.ok(r3.body.notifications?.some((n) => /Persona Ghost not found/.test(n.text ?? '')));
});
