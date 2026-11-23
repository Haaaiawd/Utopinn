/**
 * TASK-069 — /trigger 实弹链 + 挂起回执(node:test,真 server 子进程)。
 *
 * 验收钉:
 *   POST /api/utopinn/script/run {script:'/trigger'}
 *     → runTriggerGeneration:buildGenerationContext → runLukerDispatch
 *     → mock LLM → job 终态 → 服务端 persistJobReplyText 落楼层
 *   断言:
 *     1. /run 响应 ok,pipe 载生成文本(triggerGeneration seam 回 text);
 *     2. GET /api/utopinn/jobs 台账有 completed+persisted 的 normal job;
 *     3. chat JSONL 末楼 = mock 回复(服务端写的,不是客户端 ack);
 *     4. TH 信箱 getEventLog 见 generation_requested/started/ended +
 *        message_received(origin:server)——eventOn 订阅面同源;
 *     5. /trigger <member> 单聊语境忽略参数(照上游 selected_group 语义)
 *        但照常生成 —— 不报错不静默吞;
 *     6. /input → {awaiting:{kind:'input'}} → /script/interact submit
 *        兑现 → pipe 载用户值;/popup → awaiting popup → submit 1;
 *        cancel → input 取消语义(onCancel/onSuccess 分支);
 *        过期 runId → 404。
 *
 * 跑法:E2E_SCRATCH_ROOT=/tmp/uto-scratch node --test tests/utopinn-stscript-trigger.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, tearDownServer } from './e2e/_lib/server.js';
import { startMockLLM } from './e2e/_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, writeCharacter, writePreset } from './e2e/_lib/fixtures.js';

const HANDLE = 'default-user';
const CHAT = 'utopinn-trigger-e2e';
const REPLY = '*Ash plants the lantern on the chart table.* "Trigger-chain floor — written by the server, not the client."';
const REPLY2 = '"Second shot — the reef moved while we weren\'t looking."';

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
async function get(baseURL, path, session) {
    return fetch(`${baseURL}${path}`, {
        headers: { 'X-CSRF-Token': session.token, Cookie: session.cookie },
    });
}

test('TASK-069 /trigger 实弹链 + /input /popup 挂起回执', async (t) => {
    const mock = await startMockLLM({ scriptedReplies: [REPLY, REPLY2] });
    const prebuilt = findPrebuiltBundles();
    const server = await startServer({
        batchKey: 'generation',
        scenarioId: 'utopinn-stscript-trigger',
        extraEnv: {
            ...(prebuilt ? { LUKER_PREBUILT_BUNDLES_DIR: prebuilt } : {}),
            NO_PROXY: '*', no_proxy: '*',
            HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
        },
    });
    let charDir;
    try {
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        const avatarFile = writeCharacter({ dataRoot: server.dataRoot });
        charDir = avatarFile.replace(/\.png$/, '');
        writePreset({ dataRoot: server.dataRoot, name: 'Default' });

        const chatsDir = resolve(server.dataRoot, HANDLE, 'chats', charDir);
        mkdirSync(chatsDir, { recursive: true });
        const jsonl = [
            { user_name: 'User', character_name: 'Ash', create_date: Date.now(), chat_metadata: {} },
            { name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: 'Read the reef for me.' },
        ].map((o) => JSON.stringify(o)).join('\n') + '\n';
        writeFileSync(resolve(chatsDir, `${CHAT}.jsonl`), jsonl);

        const session = await getSession(server.baseURL);
        const runScript = (script, extra = {}) =>
            post(server.baseURL, '/api/utopinn/script/run', session, { charDir, chatName: CHAT, script, ...extra });
        const readFloors = () => readFileSync(resolve(chatsDir, `${CHAT}.jsonl`), 'utf8')
            .split('\n').filter(Boolean).map((l) => JSON.parse(l));

        await t.test('/trigger → job 终态 + 服务端楼层落账 + TH 生命周期事件', async () => {
            // await=true:上游 shouldAwait 语义 —— 命令阻塞到生成终态;
            // /trigger 命令本身恒回 ''(上游形),生成文本走楼层不走 pipe。
            const res = await runScript('/trigger await=true');
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true, JSON.stringify(body.error ?? body));
            assert.equal(body.awaiting ?? null, null, 'trigger 非交互命令,不该挂起');
            assert.ok((body.ops ?? []).some((o) => o.type === 'trigger'), 'ops 记 trigger');
            assert.equal(body.notifications?.some((n) => /\/trigger failed/.test(String(n.text))), false,
                `无 trigger failed 通知: ${JSON.stringify(body.notifications)}`);

            // 1) jobs 台账:completed + persisted 的 character persist_target job
            const jobsRes = await get(server.baseURL, '/api/utopinn/jobs', session);
            assert.equal(jobsRes.status, 200);
            const jobsDoc = await jobsRes.json();
            const jobs = jobsDoc.items ?? jobsDoc.jobs ?? [];
            const tj = (Array.isArray(jobs) ? jobs : []).find((j) =>
                String(j.chatKey ?? '').includes(CHAT) && String(j.id ?? '').length > 0);
            assert.ok(tj, `trigger job 落台账: ${JSON.stringify(jobsDoc).slice(0, 400)}`);
            assert.equal(String(tj.status), 'completed');
            assert.equal(Boolean(tj.persisted), true);

            // 2) chat JSONL 末楼 = mock 回复(persistJobReplyText 服务端写面)
            const floors = readFloors();
            const last = floors.at(-1);
            assert.equal(last.is_user, false);
            assert.match(last.mes, /Trigger-chain floor/);
            assert.ok(Array.isArray(last.swipes) && last.swipes.length >= 1, 'ST 楼层形有 swipes');

            // 3) TH 信箱:生命周期事件 origin:server(eventOn 订阅同源事实)
            const log = await (await post(server.baseURL, '/api/utopinn/th/call', session, {
                method: 'getEventLog', args: {}, target: { charDir, chatName: CHAT },
            })).json();
            const entries = log?.result?.entries ?? [];
            const events = entries.map((e) => e.event);
            for (const want of ['generation_requested', 'generation_started', 'generation_ended', 'message_received']) {
                assert.ok(events.includes(want), `事件 ${want} 在信箱: ${JSON.stringify(events)}`);
            }
        });

        await t.test('/trigger <member> 单聊忽略参数(上游 selected_group 语义)仍正常生成', async () => {
            const res = await runScript('/trigger await=true someMember');
            const body = await res.json();
            assert.equal(body.ok, true, JSON.stringify(body.error ?? body));
            const floors = readFloors();
            assert.match(floors.at(-1).mes, /Second shot|reef moved/);
        });

        await t.test('/input 挂起回执:awaiting → interact submit → pipe 载值', async () => {
            const res = await runScript('/input Tell me the tide word');
            const body = await res.json();
            assert.equal(body.ok, true);
            const aw = body.awaiting;
            assert.ok(aw, `awaiting 回执: ${JSON.stringify(body)}`);
            assert.equal(aw.kind, 'input');
            assert.match(String(aw.prompt ?? ''), /tide word/i);
            assert.ok(aw.runId);

            const done = await (await post(server.baseURL, '/api/utopinn/script/interact', session, {
                runId: aw.runId, action: 'submit', value: 'slow swallow',
            })).json();
            assert.equal(done.ok, true, JSON.stringify(done));
            assert.equal(done.awaiting ?? null, null);
            assert.match(String(done.pipe ?? ''), /slow swallow/, 'input 兑现值进 pipe');
        });

        await t.test('/popup 挂起回执:awaiting popup → submit 1(ok 码)', async () => {
            const res = await runScript('/popup result=true Confirm?');
            const body = await res.json();
            assert.equal(body.ok, true);
            const aw = body.awaiting;
            assert.ok(aw, `awaiting: ${JSON.stringify(body)}`);
            assert.equal(aw.kind, 'popup');
            assert.match(String(aw.text ?? ''), /Confirm/);

            const done = await (await post(server.baseURL, '/api/utopinn/script/interact', session, {
                runId: aw.runId, action: 'submit', value: 1,
            })).json();
            assert.equal(done.ok, true, JSON.stringify(done));
            assert.equal(String(done.pipe ?? ''), '1', 'result=true → pipe 载结果码');
        });

        await t.test('/input cancel → onCancel 分支;迟到 interact → 404', async () => {
            // cancel → result=false → onCancel 闭包;echo 会被 /input 末位
            // return '' 盖掉,用 /setvar 落可观测副作用,再 /getvar 读回。
            const res = await runScript('/input onCancel={: | /setvar key=branch cancelled :} onSuccess={: | /setvar key=branch ok :} Pick?');
            const body = await res.json();
            const aw = body.awaiting;
            assert.ok(aw, `awaiting: ${JSON.stringify(body)}`);

            const done = await (await post(server.baseURL, '/api/utopinn/script/interact', session, {
                runId: aw.runId, action: 'cancel',
            })).json();
            assert.equal(done.ok, true, JSON.stringify(done));
            const gv = await (await runScript('/getvar branch')).json();
            assert.equal(String(gv.pipe ?? ''), 'cancelled', 'onCancel 闭包执行、onSuccess 未跑');

            const late = await post(server.baseURL, '/api/utopinn/script/interact', session, {
                runId: aw.runId, action: 'submit', value: 'late',
            });
            const lateBody = await late.json().catch(() => null);
            assert.ok(late.status === 404 || late.status === 409,
                `完成 run 的迟到 interact: ${late.status} ${JSON.stringify(lateBody)}`);
        });
    } finally {
        await tearDownServer(server);
        await mock.stop();
    }
});
