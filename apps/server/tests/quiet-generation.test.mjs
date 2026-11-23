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
import fs from 'node:fs';
import { initStorage, getChatRepo, getSettingsRepo, getPresetRepo, getWorldInfoRepo } from '../src/storage/index.js';
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

// ── GH#9:lorebookEntries 选择性 WI 注入 + /gen·/trigger seam 钉 ──────────

const QUIET_PRESET = {
    openai_model: 'gpt-test',
    openai_max_context: 8192,
    openai_max_tokens: 200,
    prompts: [
        { identifier: 'main', role: 'system', content: 'You are {{char}}.' },
        { identifier: 'worldInfoBefore', role: 'system', marker: true, content: '' },
        { identifier: 'chatHistory', role: 'system', marker: true, content: '' },
        { identifier: 'worldInfoAfter', role: 'system', marker: true, content: '' },
    ],
    prompt_order: [{
        character_id: 100001,
        order: ['main', 'worldInfoBefore', 'chatHistory', 'worldInfoAfter'].map((identifier) => ({ identifier, enabled: true })),
    }],
};

async function seedQuietBase(fixture, { withPreset = true } = {}) {
    if (withPreset) {
        await getPresetRepo().save(fixture.handle, 'openai', 'Default', QUIET_PRESET);
    }
    await getSettingsRepo().save(fixture.handle, { preset_settings_openai: 'Default', power_user: {} });
    await getWorldInfoRepo().save(fixture.handle, 'Forum', {
        entries: {
            '0': { uid: 0, comment: 'e1', key: ['论坛'], content: 'E1-content', constant: false },
            '1': { uid: 1, comment: 'e2', key: [], content: 'E2-content', constant: true },
        },
    });
    await getChatRepo().save(fixture.handle, 'Alice', 'c1',
        { user_name: 'User', chat_metadata: { world_info: ['Forum'] } },
        [{ name: 'User', is_user: true, send_date: '2026-01-01T00:00:00.000Z', mes: 'hi' }],
        null);
}

test('GH#9 lorebookEntries:选择性 WI 注入——只点名条目激活;全未命中 → lorebook_entries_unresolved', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        await seedQuietBase(fixture);
        const { buildGenerationContext } = await import('../src/services/generate-context.js');
        const req = () => ({ user: { profile: { handle: fixture.handle, name: 'User' } } });

        // 点名单条:选择性注入(force-activated)——e1 激活,e2(constant)
        // 不入选(圈定 = 整表替换合并池,不是「追加」)。
        const ctx = await buildGenerationContext({
            request: req(), charDir: 'Alice', chatName: 'c1', card: CARD,
            user: { name: 'User' }, type: 'quiet',
            overrides: { quietPrompt: 'x', skipWIAN: true, lorebookEntries: [{ lorebook: 'Forum', uid: 0 }] },
        });
        assert.deepEqual(ctx.sources.worldInfo.selective.unresolved, []);
        assert.equal(ctx.sources.worldInfo.selective.resolved.length, 1);
        assert.equal(ctx.sources.worldInfo.selective.resolved[0].uid, 0);
        assert.deepEqual(ctx.sources.worldInfo.activated.map((e) => e.uid), [0],
            `只激活点名条目: ${JSON.stringify(ctx.sources.worldInfo.activated)}`);

        // 整书 ref → 全部启用条目都注入(e2 constant 也激活)
        const ctx2 = await buildGenerationContext({
            request: req(), charDir: 'Alice', chatName: 'c1', card: CARD,
            user: { name: 'User' }, type: 'quiet',
            overrides: { quietPrompt: 'x', skipWIAN: true, lorebookEntries: ['Forum'] },
        });
        assert.equal(ctx2.sources.worldInfo.activated.length, 2, '整书 ref 全条目');

        // 无 lorebookEntries + skipWIAN → WI 全灭(旧契约对照)
        const ctx3 = await buildGenerationContext({
            request: req(), charDir: 'Alice', chatName: 'c1', card: CARD,
            user: { name: 'User' }, type: 'quiet',
            overrides: { quietPrompt: 'x', skipWIAN: true },
        });
        assert.equal(ctx3.sources.worldInfo.activated.length, 0, 'skipWIAN 无圈定 → 0 激活');

        // params→overrides 直通钉:全未命中 ref → runQuietGeneration 抛
        // lorebook_entries_unresolved(经 B5 失败面登记 failed job)
        await assert.rejects(
            runQuietGeneration(quietInput(fixture, { params: { lorebookEntries: ['Forum:999'] } })),
            /lorebookEntries unresolved.*999/,
        );
        // 选择性回执经 diag worldinfo 事件(quiet 链真走 resolve)
        const since = Date.now();
        await runQuietGeneration(quietInput(fixture, { params: { lorebookEntries: ['Forum:0'] }, timeoutMs: 10_000 }))
            .catch(() => { /* dispatch 无后端失败不影响选择性断言 */ });
        const selEvts = diagQuery({ kind: 'inject', code: 'worldinfo', since })
            .filter((e) => e.data?.selective);
        assert.equal(selEvts.length, 1, JSON.stringify(selEvts.map((e) => e.data)));
        assert.equal(selEvts[0].data.selective.resolved, 1);
        assert.deepEqual(selEvts[0].data.entries.map((e) => e.uid), [0]);
    } finally {
        fixture.cleanup();
    }
});

test('GH#9 STscript seam 钉:/gen → generateQuiet→runQuietGeneration;/trigger → runTriggerGeneration(失败面 sinks)', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        // 卡 + chat(stscript-env 要实体);不种预设 → /gen 在组装段快速失败,
        // 失败面经 sinks.notification —— 证明链真走而不是 seam 缺席的空回。
        fs.writeFileSync(path.join(fixture.dirs.characters, 'Alice.json'), JSON.stringify(CARD));
        await getChatRepo().save(fixture.handle, 'Alice', 'c1',
            { user_name: 'User', chat_metadata: {} }, [], null);
        const { buildStscriptEnv } = await import('../src/services/stscript-env.js');
        const { runStscript } = await import('@utopinn/core');
        const built = await buildStscriptEnv({
            handle: fixture.handle, directories: fixture.dirs,
            charDir: 'Alice', chatName: 'c1', userName: 'User',
        });
        assert.ok(built.env, JSON.stringify(built));
        assert.equal(typeof built.env.host.generateQuiet, 'function', 'generateQuiet seam 已绑');

        const genOut = await runStscript(built.env, '/gen hello');
        assert.equal(genOut.isError, false, JSON.stringify(genOut.error));
        assert.ok(built.sinks.notifications.some((n) => String(n.text).includes('/gen failed')),
            `/gen → runQuietGeneration 链真走: ${JSON.stringify(built.sinks.notifications)}`);

        // /trigger:TASK-069 已绑 runTriggerGeneration 真链 —— 无预设时
        // 组装/派发段失败如实进 sinks.notification(seam 不外抛,与 /gen
        // 同语义);seam 缺席 → 显式 execution_error 的旧断言已过时。
        assert.equal(typeof built.env.host.triggerGeneration, 'function', 'triggerGeneration seam 已绑');
        const trigOut = await runStscript(built.env, '/trigger await=true');
        assert.equal(trigOut.isError, false, JSON.stringify(trigOut));
        assert.ok(built.sinks.notifications.some((n) => String(n.text).includes('/trigger failed')),
            `/trigger → runTriggerGeneration 链真走: ${JSON.stringify(built.sinks.notifications)}`);
    } finally {
        fixture.cleanup();
    }
});
