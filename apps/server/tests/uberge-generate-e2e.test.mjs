/**
 * /api/uberge/generate 端到端(node:test,非 Playwright):
 * 真 Luker server + mock LLM + 真 HTTP——
 *   POST /api/uberge/generate → 200 + x-luker-generation-id
 *   → 轮询 jobs/status 到 persisted → 断言 mock 上游请求 messages
 *   是服务端组装产物(宏替换/聊天史)→ chat JSONL 已追加 assistant 回复。
 * 跑法:node --test tests/uberge-generate-e2e.test.mjs
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
const CHAT = 'uberge-e2e';
const REPLY = '*Ash lifts the lantern, angling its light across the reef.* "Three breakers where the moon says none should be. We watch until dawn."';

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

/** CSRF token + session cookie(Luker 中间件要求;getSetCookie 拿全多条) */
async function getSession(baseURL) {
    const r = await fetch(`${baseURL}/csrf-token`);
    const { token } = await r.json();
    const cookies = typeof r.headers.getSetCookie === 'function'
        ? r.headers.getSetCookie()
        : [r.headers.get('set-cookie')].filter(Boolean);
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    return { token, cookie };
}
async function post(baseURL, path, session, body) {
    return fetch(`${baseURL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.token, Cookie: session.cookie },
        body: JSON.stringify(body),
    });
}

test('/api/uberge/generate e2e — assemble→dispatch→job→persist', async (t) => {
    const mock = await startMockLLM({ scriptedReplies: [REPLY] });
    const prebuilt = findPrebuiltBundles();
    const server = await startServer({
        batchKey: 'generation',
        scenarioId: 'uberge-generate',
        extraEnv: {
            ...(prebuilt ? { LUKER_PREBUILT_BUNDLES_DIR: prebuilt } : {}),
            // 子进程继承壳层代理;本地回环/出站全部绕过,防启动期外呼挂死
            NO_PROXY: '*', no_proxy: '*',
            HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
        },
    });
    try {
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        const avatarFile = writeCharacter({ dataRoot: server.dataRoot });
        const charDir = avatarFile.replace(/\.png$/, '');
        const presetName = writePreset({ dataRoot: server.dataRoot, name: 'uberge-e2e-preset' });

        // 手写聊天 JSONL(header 行 + 时序消息行)
        const chatsDir = resolve(server.dataRoot, HANDLE, 'chats', charDir);
        mkdirSync(chatsDir, { recursive: true });
        const jsonl = [
            { user_name: 'User', character_name: 'Ash', create_date: Date.now(), chat_metadata: {} },
            { name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: 'What do you read in the reef tonight?' },
        ].map((o) => JSON.stringify(o)).join('\n') + '\n';
        writeFileSync(resolve(chatsDir, `${CHAT}.jsonl`), jsonl);

        const session = await getSession(server.baseURL);
        const jobId = randomUUID();

        await t.test('generate returns job handle', async () => {
            const res = await post(server.baseURL, '/api/uberge/generate', session, {
                charDir, chatName: CHAT, presetName,
                chat_completion_source: 'custom',
                luker_generation: { job_id: jobId },
            });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('x-luker-generation-id'), jobId);
        });

        // 轮询 job 直至 persisted(dispatch 后台跑,persist 有宽限)
        let status;
        for (let i = 0; i < 80; i++) {
            const s = await post(server.baseURL, '/api/backends/chat-completions/jobs/status', session, { id: jobId });
            if (s.ok) {
                status = await s.json();
                if (status.persisted) break;
            }
            await new Promise((r) => setTimeout(r, 250));
        }

        await t.test('job completes and persists', () => {
            assert.ok(status, 'job status reachable');
            assert.ok(status.persisted, `persisted, last=${JSON.stringify(status)}`);
            assert.match(String(status.text ?? ''), /breakers|lantern/);
        });

        await t.test('mock upstream received server-assembled messages', () => {
            const upstream = mock.requests.find((r) => /chat\/completions/.test(r.url));
            assert.ok(upstream, 'mock saw /chat/completions');
            const msgs = upstream.body?.messages ?? [];
            // 聊天史经服务端组装进上游请求
            assert.ok(msgs.some((m) => String(m.content).includes('What do you read in the reef tonight?')),
                'chat history in upstream messages');
            // {{char}} 宏已被替换(服务端,不是前端)
            assert.ok(msgs.every((m) => !String(m.content ?? '').includes('{{char}}')),
                'no raw {{char}} macro reaches upstream');
        });

        await t.test('assistant reply persisted to chat JSONL', () => {
            const raw = readFileSync(resolve(chatsDir, `${CHAT}.jsonl`), 'utf8');
            const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
            const last = lines.at(-1);
            assert.equal(last.is_user, false, 'last line is the assistant turn');
            assert.match(last.mes, /breakers|lantern/);
        });
    } finally {
        await tearDownServer(server);
        await mock.stop();
    }
});
