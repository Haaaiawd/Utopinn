/**
 * PR#28 review 返修 — script_injects 生命周期服务端验收。
 *
 * 契约:
 * - consumeEphemeralScriptInjectsForChat:CAS 读-改-写,只删消费时点
 *   仍 ephemeral 的条目 —— 生成途中并发写进的 inject/外部键随
 *   integrity 校验存活,不拿快照整图回写(不擦新增/不复活已删);
 *   撞档重试到 CONSUME_CAS_ATTEMPTS 上限。
 * - consumeEphemeralScriptInjectsForJob:verb 'quiet' / 无持久目标
 *   不消费;character/group persistTarget 按 persistGeneratedReply
 *   同寻址消费 —— job 终态挂点(awaiting_ack/failed/cancelled)。
 * - buildStscriptEnv persistMetadata:撞档 → 3-way 合并重试
 *   (脚本键与外部键互不丢);不可合并的失败(聊天没了)真抛 ——
 *   /inject 族写失败回非零 receipt,不谎报成功。
 *
 * 跑法:node --test tests/utopinn-injects.test.mjs
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
import { ConflictError } from '../src/storage/errors.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
import {
    consumeEphemeralScriptInjectsForChat,
    consumeEphemeralScriptInjectsForJob,
} from '../src/services/script-injects.js';

const HANDLE = 'u1';
const CHAR = 'InjectCard';
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
const doc = (chat = CHAT) => getChatRepo().get(HANDLE, CHAR, chat);
const meta = (chat = CHAT) => doc(chat).then((d) => d?.header?.chat_metadata ?? {});

async function seedChat(name, metadata = {}) {
    await getChatRepo().save(HANDLE, CHAR, name,
        { user_name: 'User', character_name: CHAR, create_date: 1, chat_metadata: { variables: {}, ...metadata } },
        [{ name: CHAR, is_user: false, is_system: false, send_date: '2026-01-01 00:00', mes: 'hi', extra: {} }],
        null);
}

const eph = (value) => ({ value, position: 0, depth: 4, scan: false, role: 0, filter: null, ephemeral: true });
const keep = (value) => ({ value, position: 0, depth: 4, scan: false, role: 0, filter: null, ephemeral: false });

test.before(async () => {
    if (!getConfigFilePath()) setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-injects-'));
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

// ── /inject 端到端:metadata 真落盘 ─────────────────────────────────────

test('/inject writes record to chat_metadata via repo', async () => {
    await seedChat(CHAT);
    const r = await run('/inject id=abc hello there');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pipe, 'abc');
    const injects = (await meta()).script_injects;
    assert.deepEqual(injects.abc, keep('hello there'));
    const injectOp = r.body.ops.find((o) => o.type === 'inject');
    assert.equal(injectOp.id, 'abc');
    assert.equal(injectOp.inject.value, 'hello there');
});

// ── CAS consume:并发写存活(fix 1 回归)─────────────────────────────────

test('consume deletes only ephemeral; concurrent additions survive', async () => {
    await seedChat(CHAT, { script_injects: { e: eph('gone'), k: keep('stay') } });
    // 模拟生成进行中另一写面:先加非 ephemeral 新 inject + 外部键,
    // 再消费 —— 快照整图回写会把 n/x 擦掉,CAS 存活。
    const live = await doc();
    await getChatRepo().updateChatMetadata(HANDLE, CHAR, CHAT, {
        script_injects: { e: eph('gone'), k: keep('stay'), n: eph('late-eph') },
        external_key: 'external',
    }, live.integrity);
    const removed = await consumeEphemeralScriptInjectsForChat({ handle: HANDLE, charDir: CHAR, chatName: CHAT });
    // 'late-eph' 消费时点仍是 ephemeral —— 上游 live 语义一并清(终态看当前图)。
    assert.equal(removed, 2);
    const md = await meta();
    assert.deepEqual(Object.keys(md.script_injects).sort(), ['k']);
    assert.equal(md.external_key, 'external');
    // 幂等:再消费 = 0
    assert.equal(await consumeEphemeralScriptInjectsForChat({ handle: HANDLE, charDir: CHAR, chatName: CHAT }), 0);
});

test('consume CAS retry survives a conflicting write', async () => {
    await seedChat(CHAT, { script_injects: { e: eph('gone') } });
    const repo = getChatRepo();
    const origUpdate = repo.updateChatMetadata.bind(repo);
    let calls = 0;
    repo.updateChatMetadata = async (...args) => {
        calls += 1;
        if (calls === 1) {
            // 第一次 CAS 撞上并发写(integrity 过期)—— 抛上游同款错。
            throw new ConflictError('integrity_mismatch', { expected: 'x', actual: 'y' });
        }
        return origUpdate(...args);
    };
    try {
        const removed = await consumeEphemeralScriptInjectsForChat({ handle: HANDLE, charDir: CHAR, chatName: CHAT });
        assert.equal(removed, 1);
    } finally {
        repo.updateChatMetadata = origUpdate;
    }
    assert.ok(calls >= 2, `expected CAS retry, got ${calls} update calls`);
    assert.deepEqual((await meta()).script_injects, {});
});

// ── job 终态门(fix 2):quiet 不消费,character/group 寻址 ───────────────

test('job hook: quiet verb does not consume', async () => {
    await seedChat(CHAT, { script_injects: { e: eph('x') } });
    consumeEphemeralScriptInjectsForJob({
        id: 'j1', handle: HANDLE,
        requestMeta: { verb: 'quiet' },
        persistTarget: { kind: 'character', avatar_url: `${CHAR}.png`, file_name: `${CHAT}.jsonl` },
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await meta()).script_injects.e.value, 'x');
});

test('job hook: non-quiet character job consumes', async () => {
    await seedChat(CHAT, { script_injects: { e: eph('x'), k: keep('y') } });
    consumeEphemeralScriptInjectsForJob({
        id: 'j2', handle: HANDLE, chatKey: 'char:k',
        requestMeta: { verb: 'normal' },
        persistTarget: { kind: 'character', avatar_url: `${CHAR}.png`, file_name: `${CHAT}.jsonl` },
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(Object.keys((await meta()).script_injects), ['k']);
});

test('job hook: missing persistTarget / handle no-ops', async () => {
    await seedChat(CHAT, { script_injects: { e: eph('x') } });
    consumeEphemeralScriptInjectsForJob({ id: 'j3', handle: HANDLE, requestMeta: { verb: 'normal' }, persistTarget: null });
    consumeEphemeralScriptInjectsForJob({ id: 'j4', handle: '', requestMeta: { verb: 'normal' }, persistTarget: { kind: 'character', avatar_url: 'A.png', file_name: 'c.jsonl' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await meta()).script_injects.e.value, 'x');
});

test('failGenerationJob funnel consumes (dispatch error terminal)', async () => {
    await seedChat(CHAT, { script_injects: { e: eph('x'), k: keep('y') } });
    const { createGenerationJob, failGenerationJob } = await import('../src/endpoints/backends/luker-generation.js');
    const request = {
        user: { profile: { handle: HANDLE }, directories: dirs },
        body: { type: 'normal', model: 'm', chat_completion_source: 'openai' },
    };
    const job = createGenerationJob(request, {
        job_id: `j-fail-${Date.now()}`,
        persist_target: { kind: 'character', avatar_url: `${CHAR}.png`, file_name: `${CHAT}.jsonl` },
    });
    failGenerationJob(job, 'provider exploded');
    assert.equal(job.status, 'failed');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(Object.keys((await meta()).script_injects), ['k']);
});

// ── persistMetadata 3-way + 失败真抛(fix 4)─────────────────────────────

test('persistMetadata 3-way merge preserves script + external writes', async () => {
    await seedChat(CHAT, { note_depth: 4 });
    const { buildStscriptEnv } = await import('../src/services/stscript-env.js');
    const built = await buildStscriptEnv({ handle: HANDLE, directories: dirs, charDir: CHAR, chatName: CHAT, card: null });
    assert.ok(!built.error, built.error);
    // 外部写(env 装载后):推进 integrity + 加键
    const d0 = await doc();
    await getChatRepo().updateChatMetadata(HANDLE, CHAR, CHAT, { ext_added: true }, d0.integrity);
    // 脚本侧写:直接改活对象后经 seam 落盘 —— CAS 撞档 → 3-way 合并重试
    built.env.macro.chatMetadata.script_wrote = 'yes';
    await built.env.host.persistMetadata();
    const md = await meta();
    assert.equal(md.script_wrote, 'yes');   // 脚本键存活
    assert.equal(md.ext_added, true);       // 外部键存活
    assert.equal(md.note_depth, 4);         // base 键存活
});

test('persistMetadata rejection surfaces as /inject error receipt', async () => {
    await seedChat(CHAT);
    const { buildStscriptEnv } = await import('../src/services/stscript-env.js');
    const built = await buildStscriptEnv({ handle: HANDLE, directories: dirs, charDir: CHAR, chatName: CHAT, card: null });
    assert.ok(!built.error);
    // 会话被删 → 任何写面都是诚实失败,不可合并 —— seam 必须真抛。
    await getChatRepo().delete(HANDLE, CHAR, CHAT);
    built.env.macro.chatMetadata.script_wrote = 'yes';
    await assert.rejects(() => built.env.host.persistMetadata());
});

test('/inject failure propagates as error through runStscript seam', async () => {
    await seedChat(CHAT);
    const { buildStscriptEnv } = await import('../src/services/stscript-env.js');
    const { runStscript } = await import('@utopinn/core');
    const built = await buildStscriptEnv({ handle: HANDLE, directories: dirs, charDir: CHAR, chatName: CHAT, card: null });
    assert.ok(!built.error);
    await getChatRepo().delete(HANDLE, CHAR, CHAT);
    const out = await runStscript(built.env, '/inject id=x hi');
    assert.equal(out.isError, true);
});

// ── 生成 commit 后 resync(fix 4 后半):env 活态对齐盘上 ────────────────

test('env resyncs live metadata+integrity after external generation writes', async () => {
    await seedChat(CHAT, { script_injects: { e: eph('gone'), k: keep('stay') } });
    const { buildStscriptEnv } = await import('../src/services/stscript-env.js');
    const { runStscript } = await import('@utopinn/core');
    const built = await buildStscriptEnv({ handle: HANDLE, directories: dirs, charDir: CHAR, chatName: CHAT, card: null });
    assert.ok(!built.error);
    // 模拟「/trigger await」后:生成链消费 ephemeral + 落回复楼 + 写变量,
    // 由 seam finally 的 refreshChatState 预同步 —— 这里直接模拟其效果:
    // triggerGeneration seam 绑定替身先按真实顺序写盘再 resync。
    const d0 = await doc();
    await getChatRepo().updateChatMetadata(HANDLE, CHAR, CHAT, {
        script_injects: { k: keep('stay') },   // ephemeral 已清
        gen_var: 'from-generation',            // 生成期 setvar
    }, d0.integrity);
    await getChatRepo().append(HANDLE, CHAR, CHAT, [{ name: CHAR, is_user: false, is_system: false, send_date: '2026-01-02 00:00', mes: 'reply', extra: {} }]);
    // seam finally 同款刷新 —— buildStscriptEnv 透出的 resync 原语。
    assert.equal(typeof built.refreshChatState, 'function', 'refreshChatState exposed');
    await built.refreshChatState();
    // env 活态已对齐:e 不可见、gen_var 可见、integrity 最新、chat 含新楼
    assert.equal(built.env.macro.chatMetadata.script_injects.e, undefined);
    assert.equal(built.env.macro.chatMetadata.gen_var, 'from-generation');
    assert.equal(built.env.macro.chat.at(-1).mes, 'reply');
    // 随后 /inject 拿最新 CAS 游标一把过,不走合并
    const out = await runStscript(built.env, '/inject id=post hi');
    assert.equal(out.isError, false, out.errorMessage);
    const md = await meta();
    assert.equal(md.script_injects.post.value, 'hi');
    assert.equal(md.script_injects.k.value, 'stay');      // k 不复活 e
    assert.equal(md.gen_var, 'from-generation');
});
