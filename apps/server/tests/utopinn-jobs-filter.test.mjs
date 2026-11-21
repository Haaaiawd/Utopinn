/**
 * /api/utopinn/jobs ?target=&status= 过滤(TASK-058)集成测试(node:test)。
 * target → chatKey 必须与服务端 getPersistChatKey 同构(护栏语义):
 *   <charDir>/<chatName> → char:<dir>.png:<chat>
 *   group:<chatId> / group/<chatId> → group:<chatId>
 * status=active → 护栏四态 running|queued|persisting|awaiting_ack。
 * 真 express + 进程内 job store(createGenerationJob 直接种)。
 * 跑法:node --test tests/utopinn-jobs-filter.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
// utopinn-generate 的传递依赖模块级读 config —— 动态 import 前先备妥。

const HANDLE = 'u1';
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
    const { apply: applyUtopinnGenerate } = await import('../src/plugins/utopinn-generate.js');
    const { createGenerationJob, failGenerationJob } = await import('../src/endpoints/backends/luker-generation.js');

    const generateRouter = express.Router();
    const ws = {
        register: (spec) => {
            generateRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    applyUtopinnGenerate({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });

    // ---- 种子:不同 chatKey × 状态的 job(唯一 id 防与并跑套件串库) ----
    const tag = `jf-${process.pid}-${Date.now()}`;
    const seedReq = () => ({ user: { profile: { handle: HANDLE } }, body: {} });
    const jA = createGenerationJob(seedReq(), {
        job_id: `${tag}-a1`,
        persist_target: { avatar_url: 'Alice.png', file_name: 'c1.jsonl' },
    }); // chatKey=char:Alice.png:c1 · running
    createGenerationJob(seedReq(), {
        job_id: `${tag}-a2`,
        persist_target: { avatar_url: 'Alice.png', file_name: 'c2.jsonl' },
    }); // chatKey=char:Alice.png:c2 · running
    createGenerationJob(seedReq(), {
        job_id: `${tag}-g1`,
        persist_target: { kind: 'group', id: 'grp1' },
    }); // chatKey=group:grp1 · running
    const jDone = createGenerationJob(seedReq(), {
        job_id: `${tag}-done`,
        persist_target: { avatar_url: 'Alice.png', file_name: 'c1.jsonl' },
    });
    failGenerationJob(jDone, 'seeded terminal');
    assert.equal(jDone.status, 'failed'); // c1 一活一终 —— active 过滤的区分度
    assert.equal(jA.status, 'running');

    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: {} };
        next();
    });
    app.use(generateRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); });

test('GET /jobs — 无参全量(本 handle 全部摘要)', async () => {
    const { status, body } = await api('/api/utopinn/jobs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 4);
});

test('GET /jobs?target=<dir>/<chat> — 只回该聊天的 job(含终态)', async () => {
    const { status, body } = await api(`/api/utopinn/jobs?target=${encodeURIComponent('Alice/c1')}`);
    assert.equal(status, 200);
    assert.equal(body.items.length, 2); // a1(running) + done(failed)
    assert.ok(body.items.every((j) => j.chatKey === 'char:Alice.png:c1'));
});

test('GET /jobs?target=&status=active — 护栏四态只留活的', async () => {
    const { status, body } = await api(`/api/utopinn/jobs?${new URLSearchParams({ target: 'Alice/c1', status: 'active' })}`);
    assert.equal(status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].status, 'running');
    assert.equal(body.items[0].chatKey, 'char:Alice.png:c1');
});

test('GET /jobs?target=group:<chatId> / group/<chatId> — 群聊两种形等价', async () => {
    const colon = await api(`/api/utopinn/jobs?target=${encodeURIComponent('group:grp1')}`);
    const slash = await api(`/api/utopinn/jobs?target=${encodeURIComponent('group/grp1')}`);
    assert.equal(colon.status, 200);
    assert.equal(colon.body.items.length, 1);
    assert.equal(colon.body.items[0].chatKey, 'group:grp1');
    assert.deepEqual(slash.body.items.map((j) => j.id), colon.body.items.map((j) => j.id));
});

test('GET /jobs?target — 容忍 .png/.jsonl 尾;无形 → 400', async () => {
    const tolerant = await api(`/api/utopinn/jobs?target=${encodeURIComponent('Alice.png/c1.jsonl')}`);
    assert.equal(tolerant.status, 200);
    assert.equal(tolerant.body.items.length, 2);

    const bad = await api('/api/utopinn/jobs?target=noslash');
    assert.equal(bad.status, 400);
});

test('GET /jobs?status — 具体状态白名单;错名 → 400', async () => {
    const failed = await api('/api/utopinn/jobs?status=failed');
    assert.equal(failed.status, 200);
    assert.ok(failed.body.items.length >= 1);
    assert.ok(failed.body.items.every((j) => j.status === 'failed'));

    const multi = await api('/api/utopinn/jobs?status=running,queued');
    assert.equal(multi.status, 200);
    assert.ok(multi.body.items.every((j) => ['running', 'queued'].includes(j.status)));

    const bad = await api('/api/utopinn/jobs?status=not-a-status');
    assert.equal(bad.status, 400);
});
