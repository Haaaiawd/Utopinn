/**
 * luker-generation → TH lifecycle mailbox (fix: the normal generation path
 * emitted no lifecycle events at all).
 *
 * Background: generation_started/ended used to be recorded only by
 * host-initiated chains (ctx.generate / /trigger / th.generate) via
 * recordThEvent; a plain user send through /api/utopinn/generate →
 * runLukerDispatch → job wrote nothing to the mailbox — CardApp arm()/
 * rollback hooks never ran.
 *
 * Fix: the existing emitJobTransition funnel (all job status transitions)
 * emits lifecycle events (running→started / completed→ended /
 * failed|cancelled→stopped) with ctx from request.utopinnThCtx or derived
 * from persist_target; self-managed chains (trigger/quiet, CardApp hosts)
 * are exempt via utopinnThSelfManaged / luker_generation.th_self_managed.
 * Group persist_target resolves to the GROUP mailbox (isGroup) — never a
 * same-named private chat (cross-session leak guard). Writes chain per job
 * (job.thWriteChain) so started lands before the terminal event, and
 * persistJobReplyText drains the chain before appending the reply floor.
 *
 * Pins (in-process, real FsEngine):
 *   1. createGenerationJob(running) → th.events mailbox generation_started[verb]
 *   2. same job awaiting_ack → ack → completed → generation_ended[finalText]
 *   3. failed → generation_stopped[err]; each job emits started + one terminal
 *   4. utopinnThSelfManaged job → mailbox unchanged (self-managed, no doubles)
 *   5. explicit utopinnThCtx (.jsonl suffix stripped)
 *   6. group job: group chatId == a member's private chatName → events land
 *      in the group mailbox only, private mailbox untouched
 *   7. body.luker_generation.th_self_managed → funnel silent (CardApp host path)
 *
 * Run: node --test tests/luker-generation-th.test.mjs
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
    // recordThEvent is a fire-and-forget async write inside
    // emitJobTransition — poll chat_state until the target count (or the
    // timeout returns whatever landed).
    const repo = getChatRepo();
    let doc = null;
    for (let i = 0; i < tries; i++) {
        doc = await repo.getState(HANDLE, CHAR, CHAT, TH_NS).catch(() => null);
        if ((doc?.log?.length ?? 0) >= expectedCount) return doc;
        await new Promise((r) => setTimeout(r, 50));
    }
    return doc;
}

test('luker-generation job lifecycle → TH mailbox (started/ended/stopped + self-managed exemption)', async (t) => {
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
        // The chat resource must exist — withEventDoc 404s on an absent
        // chat and never lands a mailbox entry.
        await repo.save(HANDLE, CHAR, CHAT, { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开场。' },
        ], null);

        let lifeJob = null;
        await t.test('running → generation_started[verb] (ctx derived from persist_target)', async () => {
            const request = makeRequest(dirs);
            lifeJob = createGenerationJob(request, { job_id: 'job-life-1', persist_target: persistTarget });
            assert.ok(lifeJob, 'job created');
            // No utopinnThCtx attached — the avatar_url/file_name derivation
            // surface must hit.
            assert.equal(lifeJob.thCtx.charDir, CHAR);
            assert.equal(lifeJob.thCtx.chatName, CHAT);
            const doc = await eventLog(1);
            const e = doc?.log?.[0];
            assert.equal(e?.event, 'generation_started');
            assert.deepEqual(e?.args, ['normal'], 'started payload = verb (same shape as trigger-generation)');
            assert.equal(e?.origin, 'server');
        });

        await t.test('awaiting_ack → ack → completed → generation_ended[text]', async () => {
            const request = makeRequest(dirs);
            const done = await completeGenerationJobFromText(request, lifeJob, '最终定稿文本', 'test-model');
            assert.equal(done, false, 'completeFromText returns false (awaiting ack)');
            assert.equal(lifeJob.status, 'awaiting_ack');
            const acked = acknowledgeGenerationJobsForRequest(request, ['job-life-1']);
            assert.deepEqual(acked, ['job-life-1']);
            const doc = await eventLog(2);
            const e = doc?.log?.[1];
            assert.equal(e?.event, 'generation_ended');
            assert.deepEqual(e?.args, ['最终定稿文本'], 'ended payload = final text (TH GENERATION_ENDED semantics)');
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
            // job-life-2's started is in the mailbox too — each job pairs
            // started with exactly one of ended|stopped.
            const events = doc.log.map((x) => x.event);
            assert.deepEqual(events, [
                'generation_started', 'generation_ended',
                'generation_started', 'generation_stopped',
            ], 'mailbox order: started + exactly one terminal event per job');
        });

        await t.test('utopinnThSelfManaged → funnel silent (self-managed chains do not double-fire)', async () => {
            const request = makeRequest(dirs, { utopinnThSelfManaged: true });
            const job = createGenerationJob(request, { job_id: 'job-life-3', persist_target: persistTarget });
            assert.ok(job);
            assert.equal(job.thSelfManaged, true);
            failGenerationJob(job, 'self managed boom');
            await new Promise((r) => setTimeout(r, 300));
            const doc = await repo.getState(HANDLE, CHAR, CHAT, TH_NS);
            assert.equal(doc.log.length, 4, 'self-managed job writes nothing (the host publishes itself)');
        });

        await t.test('explicit utopinnThCtx (.jsonl suffix stripped)', async () => {
            const request = makeRequest(dirs, {
                utopinnThCtx: { charDir: CHAR, chatName: CHAT + '.jsonl' },
            });
            const job = createGenerationJob(request, { job_id: 'job-life-4', persist_target: persistTarget });
            assert.equal(job.thCtx.chatName, CHAT, '.jsonl suffix stripped');
            assert.equal(job.thCtx.charDir, CHAR);
            const doc = await eventLog(5);
            assert.equal(doc?.log?.at(-1)?.event, 'generation_started');
        });

        await t.test('body.luker_generation.th_self_managed → funnel silent (CardApp host path)', async () => {
            const request = makeRequest(dirs);
            request.body = { type: 'normal', luker_generation: { job_id: 'host-job', th_self_managed: true } };
            const job = createGenerationJob(request, { job_id: 'job-life-5', persist_target: persistTarget });
            assert.ok(job);
            assert.equal(job.thSelfManaged, true, 'body flag marks the job self-managed');
            failGenerationJob(job, 'host-managed boom');
            await new Promise((r) => setTimeout(r, 300));
            const doc = await repo.getState(HANDLE, CHAR, CHAT, TH_NS);
            assert.equal(doc.log.length, 5, 'host-flagged job writes nothing to the mailbox');
        });

        await t.test('group persist_target → group mailbox only, no private-chat leak', async () => {
            // Adversary: a private chat named exactly like the group chatId.
            // The group job's lifecycle must land in the group doc
            // (isGroup key) — never the member's same-named private mailbox.
            const GID = 'guild-chat';
            const repo2 = getChatRepo();
            await repo2.save(HANDLE, CHAR, GID, { user_name: 'User', chat_metadata: {} }, [
                { is_user: false, name: CHAR, mes: '同名私聊。' },
            ], null);
            await repo2.save(HANDLE, '', GID, { user_name: 'User', chat_metadata: {} }, [
                { is_user: false, name: CHAR, mes: '群开局。' },
            ], null, { isGroup: true, groupId: GID });

            const request = makeRequest(dirs);
            const job = createGenerationJob(request, {
                job_id: 'job-grp-1',
                persist_target: { kind: 'group', id: GID, original_avatar: CHAR + '.png' },
            });
            assert.ok(job);
            assert.equal(job.thCtx.isGroup, true);
            assert.equal(job.thCtx.chatName, GID);
            failGenerationJob(job, 'group boom');

            let gdoc = null;
            for (let i = 0; i < 40; i++) {
                gdoc = await repo2.getState(HANDLE, '', GID, TH_NS, { isGroup: true, groupId: GID }).catch(() => null);
                if ((gdoc?.log?.length ?? 0) >= 2) break;
                await new Promise((r) => setTimeout(r, 50));
            }
            assert.deepEqual(gdoc?.log?.map((x) => x.event), ['generation_started', 'generation_stopped'],
                'group lifecycle lands in the group mailbox');

            // The member's same-named private mailbox must stay empty.
            const pdoc = await repo2.getState(HANDLE, CHAR, GID, TH_NS).catch(() => null);
            assert.equal(pdoc?.log?.length ?? 0, 0, 'no leak into the same-named private chat mailbox');
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
