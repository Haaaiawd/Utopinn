/**
 * /api/utopinn/generate 正常发送路径 → TH 生命周期事件 e2e(node:test,
 * 真 server 子进程 + mock LLM)。
 *
 * 修复点:用户正常发送(job 链)此前无任何 recordThEvent —— CardApp
 * eventOn('generation_started')/arm()/回滚钩子永远不跑。本钉走完整
 * 编排面(插件挂 utopinnThCtx → runner 建 job → emitJobTransition 漏斗
 * → recordThEvent → chat_state 'th.events')断言:
 *   1. started 先于终态落地,args[0]=verb;
 *   2. 兜底 persist → completed → generation_ended,args[0]=mock 回复全文;
 *   3. 无 generation_stopped(成功终态不混搭)。
 *
 * 跑法:E2E_SCRATCH_ROOT=/tmp/uto-scratch node --test tests/utopinn-generate-th-events.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServer, tearDownServer } from './e2e/_lib/server.js';
import { startMockLLM } from './e2e/_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, writeCharacter, writePreset } from './e2e/_lib/fixtures.js';

const HANDLE = 'default-user';
const CHAT = 'utopinn-gen-th';
const REPLY = '"The lantern dips once — the reef is listening tonight." — lifecycle reply floor.';

/** 复用 scratch 里已有的 webpack 产物跳过首启编译(~60s+);无则正常编译 */
function findPrebuiltBundles() {
    if (process.env.LUKER_PREBUILT_BUNDLES_DIR) return process.env.LUKER_PREBUILT_BUNDLES_DIR;
    const scratch = resolve(fileURLToPath(new URL('.', import.meta.url)), '.e2e-scratch');
    if (!existsSync(scratch)) return '';
    for (const scenario of readdirSync(scratch)) {
        const webpackDir = resolve(scratch, scenario, '_webpack');
        if (!existsSync(webpackDir)) continue;
        for (const hash of readdirSync(webpackDir)) {
            const out = resolve(webpackDir, hash, 'output');
            if (existsSync(resolve(out, 'lib.core.bundle.js'))) return out;
        }
    }
    return '';
}

async function getSession(baseURL) {
    const r = await fetch(baseURL + '/csrf-token');
    const { token } = await r.json();
    const cookies = typeof r.headers.getSetCookie === 'function'
        ? r.headers.getSetCookie()
        : [r.headers.get('set-cookie')].filter(Boolean);
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    return { token, cookie };
}
async function post(baseURL, path, session, body) {
    return fetch(baseURL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.token, Cookie: session.cookie },
        body: JSON.stringify(body),
    });
}

test('/api/utopinn/generate → TH 生命周期信箱(started→ended,无 stopped)', async (t) => {
    const mock = await startMockLLM({ scriptedReplies: [REPLY] });
    const prebuilt = findPrebuiltBundles();
    const server = await startServer({
        batchKey: 'generation',
        scenarioId: 'utopinn-generate-th',
        extraEnv: {
            ...(prebuilt ? { LUKER_PREBUILT_BUNDLES_DIR: prebuilt } : {}),
            NO_PROXY: '*', no_proxy: '*',
            HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
        },
        // ack 宽限收紧(下限 1000ms):兜底 persist 快进终态,测试不白等 15s。
        extraConfig: { generationAckGraceMs: 1200 },
    });
    let charDir;
    try {
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        const avatarFile = writeCharacter({ dataRoot: server.dataRoot });
        charDir = avatarFile.replace(/\.png$/, '');
        const presetName = writePreset({ dataRoot: server.dataRoot, name: 'utopinn-gen-th-preset' });

        const chatsDir = resolve(server.dataRoot, HANDLE, 'chats', charDir);
        mkdirSync(chatsDir, { recursive: true });
        const jsonl = [
            { user_name: 'User', character_name: 'Ash', create_date: Date.now(), chat_metadata: {} },
            { name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: 'Light the lantern and tell me what moves.' },
        ].map((o) => JSON.stringify(o)).join('\n') + '\n';
        writeFileSync(resolve(chatsDir, CHAT + '.jsonl'), jsonl);

        const session = await getSession(server.baseURL);
        const jobId = randomUUID();

        const res = await post(server.baseURL, '/api/utopinn/generate', session, {
            charDir, chatName: CHAT, presetName,
            chat_completion_source: 'custom',
            luker_generation: { job_id: jobId },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-luker-generation-id'), jobId);

        // 轮询 job 到 persisted(兜底 persist → completed;宽限 1.2s)
        let status = null;
        for (let i = 0; i < 120; i++) {
            const s = await post(server.baseURL, '/api/backends/chat-completions/jobs/status', session, { id: jobId });
            if (s.ok) {
                status = await s.json();
                if (status.persisted || String(status.status) === 'completed') break;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.ok(status, 'job status reachable');
        assert.equal(String(status.status), 'completed', JSON.stringify(status));
        assert.ok(status.persisted, '兜底 persist 落账');

        // TH 信箱:started → ended 成对,无 stopped
        const log = await (await post(server.baseURL, '/api/utopinn/th/call', session, {
            method: 'getEventLog', args: {}, target: { charDir, chatName: CHAT },
        })).json();
        const entries = log?.result?.entries ?? [];
        const events = entries.map((e) => e.event);
        assert.ok(events.includes('generation_started'), 'generation_started 落信箱: ' + JSON.stringify(events));
        assert.ok(events.includes('generation_ended'), 'generation_ended 落信箱: ' + JSON.stringify(events));
        assert.ok(!events.includes('generation_stopped'), '成功终态无 stopped: ' + JSON.stringify(events));
        assert.ok(events.indexOf('generation_started') < events.indexOf('generation_ended'), 'started 先于 ended');

        const started = entries.find((e) => e.event === 'generation_started');
        assert.deepEqual(started?.args, ['normal'], 'started 负载 = verb');
        const ended = entries.find((e) => e.event === 'generation_ended');
        assert.equal(String(ended?.args?.[0] ?? ''), REPLY, 'ended 负载 = mock 回复全文');
    } finally {
        await tearDownServer(server).catch(() => {});
        await mock.stop().catch(() => {});
    }
});
