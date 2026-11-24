/**
 * /api/utopinn/generate normal-send path → TH lifecycle events e2e
 * (node:test, real server subprocess + mock LLM).
 *
 * The fix: a plain user send (job chain) previously wrote no recordThEvent
 * at all — CardApp eventOn('generation_started')/arm()/rollback hooks
 * never ran. This pin walks the full orchestration surface (plugin
 * attaches utopinnThCtx → runner creates the job → emitJobTransition
 * funnel → recordThEvent → chat_state 'th.events') and asserts:
 *   1. started lands before the terminal event, args[0]=verb;
 *   2. fallback persist → completed → generation_ended, args[0]=full mock reply;
 *   3. no generation_stopped (a successful terminal never mixes).
 *
 * Run: E2E_SCRATCH_ROOT=/tmp/uto-scratch node --test tests/utopinn-generate-th-events.test.mjs
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

/** Reuse prebuilt webpack bundles from the scratch dir to skip the ~60s+ first-boot build; falls back to a normal build when absent. */
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

test('/api/utopinn/generate → TH lifecycle mailbox (started→ended, no stopped)', async (t) => {
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
        // Tighten the ack grace window (floor 1000ms): the fallback persist
        // reaches its terminal state fast so the test doesn't wait out 15s.
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

        // Poll the job until persisted (fallback persist → completed; 1.2s grace)
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
        assert.ok(status.persisted, 'fallback persist landed');

        // TH mailbox: started → ended pair, no stopped
        const log = await (await post(server.baseURL, '/api/utopinn/th/call', session, {
            method: 'getEventLog', args: {}, target: { charDir, chatName: CHAT },
        })).json();
        const entries = log?.result?.entries ?? [];
        const events = entries.map((e) => e.event);
        assert.ok(events.includes('generation_started'), 'generation_started landed: ' + JSON.stringify(events));
        assert.ok(events.includes('generation_ended'), 'generation_ended landed: ' + JSON.stringify(events));
        assert.ok(!events.includes('generation_stopped'), 'no stopped on a successful terminal: ' + JSON.stringify(events));
        assert.ok(events.indexOf('generation_started') < events.indexOf('generation_ended'), 'started lands before ended');

        const started = entries.find((e) => e.event === 'generation_started');
        assert.deepEqual(started?.args, ['normal'], 'started payload = verb');
        const ended = entries.find((e) => e.event === 'generation_ended');
        assert.equal(String(ended?.args?.[0] ?? ''), REPLY, 'ended payload = full mock reply');
    } finally {
        await tearDownServer(server).catch(() => {});
        await mock.stop().catch(() => {});
    }
});
