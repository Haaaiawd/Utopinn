/**
 * TASK-051 B5 — quiet 生成组装失败的终态登记(node:test,真 FsEngine)。
 *
 * 契约:buildGenerationContext 抛错(assemble_failed,如 Chat not found /
 * Token budget exceeded)时——
 *   1. 台账登记一条 failed job(原 jobId 可查,error 带组装失败原因);
 *   2. diag-bus 落 quiet_terminal(warn,ctx.diagId 认亲,data.jobId);
 *   3. 原始异常照常上抛(调用方行为不变,只是不再无声)。
 * 修法前:quiet_submit 之后再无下文,/jobs 查无此任务。
 *
 * 跑法:node --test tests/quiet-generation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
import { initStorage, getChatRepo, getSettingsRepo, getPresetRepo } from '../src/storage/index.js';
import { makeTempFsEngine } from './storage/harness/fs-harness.js';
import { query as diagQuery } from '../src/services/diag-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// quiet-generation.loadDispatchLayer 的延迟 import 会触端点侧
// getConfigValue —— 先指配置再动态 import(与 swipe 测试同款姿势)。
if (!getConfigFilePath()) {
    setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
}
reloadConfigCache();
process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

const { runQuietGeneration } = await import('../src/services/quiet-generation.js');
const { getTaskByRequestId } = await import('../src/endpoints/backends/luker-generation.js');

const CARD = {
    name: 'Alice',
    description: 'A quiet-test character.',
    data: {
        name: 'Alice',
        description: 'A quiet-test character.',
        personality: 'calm',
        scenario: 'a test room',
        first_mes: 'Hello.',
        mes_example: '',
        extensions: {},
    },
};

function quietInput(fixture, overrides = {}) {
    return {
        handle: fixture.handle,
        directories: fixture.dirs,
        charDir: 'Alice',
        chatName: 'c1',
        card: CARD,
        prompt: 'Say something.',
        params: {},
        userName: 'User',
        timeoutMs: 5000,
        ...overrides,
    };
}

test('B5 assemble_failed(Chat not found)→ failed job 登记 + quiet_terminal diag', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const since = Date.now();

        // chat 不存在 → buildGenerationContext 抛 Chat not found(真实组装失败)
        await assert.rejects(
            runQuietGeneration(quietInput(fixture)),
            /Chat not found: Alice\/c1/,
        );

        // 1. quiet_terminal diag 落地(warn),data.jobId 给台账寻址
        const terminals = diagQuery({ kind: 'generate', code: 'quiet_terminal', since });
        assert.equal(terminals.length, 1);
        const term = terminals[0];
        assert.equal(term.lvl, 'warn');
        assert.equal(term.ctx.verb, 'quiet');
        assert.equal(term.ctx.charDir, 'Alice');
        assert.equal(term.ctx.chatId, 'c1');
        assert.ok(term.ctx.diagId, 'diagId 认亲键在');
        assert.equal(term.data.stage, 'assemble');
        const jobId = term.data.jobId;
        assert.ok(jobId, 'quiet_terminal 必须带 jobId 供台账回查');
        assert.match(String(term.msg), /Chat not found/);

        // quiet_submit 与 quiet_terminal 同 diagId 成对(可观测性闭环)
        const submits = diagQuery({ kind: 'generate', code: 'quiet_submit', since });
        assert.equal(submits.length, 1);
        assert.equal(submits[0].ctx.diagId, term.ctx.diagId);

        // 2. jobs 台账:同 jobId 查到 failed 终态,error 带组装原因
        const job = getTaskByRequestId(jobId, fixture.handle);
        assert.ok(job, 'jobs 台账可查(assemble 失败不再无痕)');
        assert.equal(job.status, 'failed');
        assert.match(String(job.error), /quiet generation assemble failed/);
        assert.match(String(job.error), /Chat not found/);
        assert.equal(job.requestMeta.verb, 'quiet');
        assert.deepEqual(job.persistTarget, { kind: 'none' });
    } finally {
        fixture.cleanup();
    }
});

test('B5 assemble_failed(Token budget exceeded)→ failed job 同语义登记', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const since = Date.now();
        const chatRepo = getChatRepo();

        // 真实聊天 + 一个非 Default 名的小预算预设(50 tokens,绕开 B6
        // 抬升口径——抬升只对 openai/Default 遗物值生效)。大卡 must-fit
        // 必炸 → 组装层 TokenBudgetExceededError。
        await chatRepo.save(fixture.handle, 'Alice', 'c1',
            { user_name: 'User', chat_metadata: {} },
            [
                { name: 'Alice', is_user: false, is_system: false, send_date: '2026-11-20T00:00:00.000Z', mes: 'hi', swipes: ['hi'], swipe_id: 0, swipe_info: [{}] },
            ],
            null);
        const defaultPreset = JSON.parse(await readFile(
            path.resolve(__dirname, '../default/content/presets/openai/Default.json'), 'utf8'));
        const tinyPreset = {
            ...defaultPreset,
            openai_max_context: 50,
            openai_max_tokens: 20,
        };
        await getPresetRepo().save(fixture.handle, 'openai', 'TinyBudget', tinyPreset);
        await getSettingsRepo().save(fixture.handle, {
            preset_settings_openai: 'TinyBudget',
            power_user: {},
        });
        const bigCard = {
            name: 'Alice',
            description: 'word '.repeat(400),
            data: {
                name: 'Alice',
                description: 'word '.repeat(400),
                personality: 'calm',
                scenario: 'a test room',
                first_mes: 'Hello.',
                mes_example: '',
                extensions: {},
            },
        };

        await assert.rejects(
            runQuietGeneration(quietInput(fixture, { card: bigCard })),
            /Token budget exceeded/,
        );

        const terminals = diagQuery({ kind: 'generate', code: 'quiet_terminal', since });
        assert.equal(terminals.length, 1);
        const jobId = terminals[0].data.jobId;
        assert.ok(jobId);
        assert.match(String(terminals[0].msg), /Token budget exceeded/);

        const job = getTaskByRequestId(jobId, fixture.handle);
        assert.ok(job);
        assert.equal(job.status, 'failed');
        assert.match(String(job.error), /Token budget exceeded/);
    } finally {
        fixture.cleanup();
    }
});
