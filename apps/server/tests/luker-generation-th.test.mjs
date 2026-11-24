/**
 * luker-generation → TH 生命周期信箱(修复「正常生成路径无生命周期事件」)。
 *
 * 背景:generation_started/ended 此前只有宿主发起链(ctx.generate/
 * /trigger/th.generate)亲手 recordThEvent;用户正常发送走
 * /api/utopinn/generate → runLukerDispatch → job,信箱一行没有——
 * CardApp 的 arm()/回滚钩子永远不跑。
 *
 * 修复:全部 job 状态迁移的既有漏斗 emitJobTransition 挂生命周期 emit
 * (running→started / completed→ended / failed|cancelled→stopped),
 * request.utopinnThCtx 或 persist_target 派生 ctx;trigger/quiet 自管链
 * 经 request.utopinnThSelfManaged 豁免防双发。
 *
 * 本钉(in-process,真 FsEngine):
 *   1. createGenerationJob(running) → th.events 信箱 generation_started[verb]
 *   2. 同 job awaiting_ack → ack → completed → generation_ended[finalText]
 *   3. failed → generation_stopped[err];每 job 恰 started + 一个终态事件
 *   4. utopinnThSelfManaged job → 信箱零增长(自管链不双发)
 *   5. 显式 utopinnThCtx 挂法(.jsonl 后缀剥除)
 *
 * 跑法:node --test tests/luker-generation-th.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChatRepo, initStorage } from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLE = 'h1';
const CHAR = 'Alice';
const CHAT = 'th-life';
const TH_NS = 'th.events';

function makeDirs(tmpDir) {
    return {
        root: tmpDir,
        characters: path.join(tmpDir, 'characters'),
        chats: path.join(tmpDir, 'chats'),
        worlds: path.join(tmpDir, 'worlds'),
        groups: path.join(tmpDir, 'groups'),
        groupChats: path.join(tmpDir, 'group chats'),
        backups: path.join(tmpDir, 'backups'),
        openAI_Settings: path.join(tmpDir, 'OpenAI Settings'),
        context: path.join(tmpDir, 'context'),
        instruct: path.join(tmpDir, 'instruct'),
        sysprompt: path.join(tmpDir, 'sysprompt'),
        reasoning: path.join(tmpDir, 'reasoning'),
        koboldAI_Settings: path.join(tmpDir, 'KoboldAI Settings'),
        novelAI_Settings: path.join(tmpDir, 'NovelAI Settings'),
        textGen_Settings: path.join(tmpDir, 'TextGen Settings'),
    };
}

function makeRequest(dirs, extra = {}) {
    return {
        method: 'POST',
        url: '/test/generate',
        headers: {},
        user: { profile: { handle: HANDLE, name: 'User' }, directories: dirs },
        once() { return this; },
        body: { type: 'normal' },
        ...extra,
    };
}

const persistTarget = {
    kind: 'character',
    avatar_url: CHAR + '.png',
    file_name: CHAT + '.jsonl',
};

async function eventLog(expectedCount, tries = 40) {
    // recordThEvent 是 emitJobTransition 里 fire-and-forget 的异步写,
    // 轮询 chat_state 到目标条数(或超时返回现状)。
    const repo = getChatRepo();
    let doc = null;
    for (let i = 0; i < tries; i++) {
        doc = await repo.getState(HANDLE, CHAR, CHAT, TH_NS).catch(() => null);
        if ((doc?.log?.length ?? 0) >= expectedCount) return doc;
        await new Promise((r) => setTimeout(r, 50));
    }
    return doc;
}

test('luker-generation job 生命周期 → TH 信箱(started/ended/stopped + 自管豁免)', async (t) => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    const {
        createGenerationJob,
        completeGenerationJobFromText,
        acknowledgeGenerationJobsForRequest,
        failGenerationJob,
    } = await import('../src/endpoints/backends/luker-generation.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-gen-th-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();
        // chat 资源须在场 —— withEventDoc 对缺席 chat 返回 404 不落信箱。
        await repo.save(HANDLE, CHAR, CHAT, { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开场。' },
        ], null);

        let lifeJob = null;
        await t.test('running → generation_started[verb](persist_target 派生 ctx)', async () => {
            const request = makeRequest(dirs);
            lifeJob = createGenerationJob(request, { job_id: 'job-life-1', persist_target: persistTarget });
            assert.ok(lifeJob, 'job created');
            // 未挂 utopinnThCtx —— avatar_url/file_name 派生面须命中。
            assert.equal(lifeJob.thCtx.charDir, CHAR);
            assert.equal(lifeJob.thCtx.chatName, CHAT);
            const doc = await eventLog(1);
            const e = doc?.log?.[0];
            assert.equal(e?.event, 'generation_started');
            assert.deepEqual(e?.args, ['normal'], 'started 负载 = verb(trigger-generation 同形)');
            assert.equal(e?.origin, 'server');
        });

        await t.test('awaiting_ack → ack → completed → generation_ended[text]', async () => {
            const request = makeRequest(dirs);
            const done = await completeGenerationJobFromText(request, lifeJob, '最终定稿文本', 'test-model');
            assert.equal(done, false, 'completeFromText 回 false(等 ack)');
            assert.equal(lifeJob.status, 'awaiting_ack');
            const acked = acknowledgeGenerationJobsForRequest(request, ['job-life-1']);
            assert.deepEqual(acked, ['job-life-1']);
            const doc = await eventLog(2);
            const e = doc?.log?.[1];
            assert.equal(e?.event, 'generation_ended');
            assert.deepEqual(e?.args, ['最终定稿文本'], 'ended 负载 = 定稿文本(TH GENERATION_ENDED 语义)');
        });

        await t.test('failed → generation_stopped[err]', async () => {
            const request = makeRequest(dirs);
            const job = createGenerationJob(request, { job_id: 'job-life-2', persist_target: persistTarget });
            assert.ok(job);
            failGenerationJob(job, 'mock upstream exploded');
            const doc = await eventLog(4);
            const last = doc?.log?.at(-1);
            assert.equal(last?.event, 'generation_stopped');
            assert.match(String(last?.args?.[0] ?? ''), /upstream exploded/);
            // job-life-2 的 started 也在信箱 —— started→stopped 二选一终态成对。
            const events = doc.log.map((x) => x.event);
            assert.deepEqual(events, [
                'generation_started', 'generation_ended',
                'generation_started', 'generation_stopped',
            ], '信箱序:每 job 恰 started + 一个终态事件');
        });

        await t.test('utopinnThSelfManaged → 漏斗静默(自管链不双发)', async () => {
            const request = makeRequest(dirs, { utopinnThSelfManaged: true });
            const job = createGenerationJob(request, { job_id: 'job-life-3', persist_target: persistTarget });
            assert.ok(job);
            assert.equal(job.thSelfManaged, true);
            failGenerationJob(job, 'self managed boom');
            await new Promise((r) => setTimeout(r, 300));
            const doc = await repo.getState(HANDLE, CHAR, CHAT, TH_NS);
            assert.equal(doc.log.length, 4, '自管 job 不写信箱(宿主自己发)');
        });

        await t.test('显式 utopinnThCtx 挂法(.jsonl 后缀剥除)', async () => {
            const request = makeRequest(dirs, {
                utopinnThCtx: { charDir: CHAR, chatName: CHAT + '.jsonl' },
            });
            const job = createGenerationJob(request, { job_id: 'job-life-4', persist_target: persistTarget });
            assert.equal(job.thCtx.chatName, CHAT, '.jsonl 后缀被剥');
            assert.equal(job.thCtx.charDir, CHAR);
            const doc = await eventLog(5);
            assert.equal(doc?.log?.at(-1)?.event, 'generation_started');
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
