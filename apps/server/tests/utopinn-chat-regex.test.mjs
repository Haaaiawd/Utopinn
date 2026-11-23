/**
 * issue #3 — 卡内 regex 楼层管线测试(node:test + supertest 风格直挂 express)。
 *
 * 覆盖:
 *   1. 收集面:card.data.extensions.regex_scripts 无 allowlist 自动放行;
 *      disabledExtensions 含 'regex' 全灭。
 *   2. 展示车道(GET chats):mes_display/swipes_display/reasoning_display
 *      投影正确,存储字段(mes/swipes/swipe_info.extra)原样。
 *   3. placement 隔离:USER_INPUT 只动用户楼、SLASH_COMMAND 只动 narrator、
 *      AI_OUTPUT promptOnly/markdownOnly 双旗脚本两条道都生效。
 *   4. 组装车道(buildGenerationContext):历史楼层 persisted→isPrompt,
 *      depth 门控(minDepth)、reasoning REASONING placement。
 *   5. diag trace:regex 事件报真 scriptCount / promptApplied。
 *   6. /api/utopinn/regex?scope=char 面报 autoAllowed/active。
 *   7. output lane (GH#3 residual):generated reply display-chain transforms
 *      job.text once at completion and lands in persisted mes; ordering is
 *      before MVU settle (wrapper-preserving rewrites still fold);
 *      appended floor reasoning gets the REASONING display chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import WebSocket from 'ws';

import { getConfigFilePath, setConfigFilePath, reloadConfigCache } from '../src/util.js';
import { initStorage, getChatRepo, getPresetRepo, getSettingsRepo } from '../src/storage/index.js';
import { buildGenerationContext } from '../src/services/generate-context.js';
import { createFloorRegexRunner, projectChatFloorsForDisplay } from '../src/services/extension-prompts.js';
import { query as diagQuery } from '../src/services/diag-bus.js';

// chats.js 传递依赖(backends/luker-generation.js)模块级读 config ——
// 必须 setConfigFilePath 后才可 import,故重依赖全部动态引入。
let chatsRouter, applyUtopinnLibrary, applyUtopinnRegex, applyUtopinnGenerate, applyUtopinnDelivery, lukerGeneration, runLukerDispatch, wsTicketTestUtils;

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(import.meta.dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    // node-persist 磁盘卡缓存的 setInterval 会吊着进程退不出
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';
    ({ router: chatsRouter } = await import('../src/endpoints/chats.js'));
    ({ apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js'));
    ({ apply: applyUtopinnRegex } = await import('../src/plugins/utopinn-regex.js'));
    ({ apply: applyUtopinnGenerate } = await import('../src/plugins/utopinn-generate.js'));
    lukerGeneration = await import('../src/endpoints/backends/luker-generation.js');
    ({ runLukerDispatch } = await import('../src/luker-dispatch/runner.js'));
    ({ apply: applyUtopinnDelivery } = await import('../src/plugins/utopinn-delivery.js'));
    ({ __wsTicketTestUtils: wsTicketTestUtils } = await import('../src/ws-ticket-router.js'));
});

const HANDLE = 'u';
const CHAR = 'MVU';

// —— 卡自带脚本(模拟 MVU 卡:MVU 状态栏/变量更新块 + 车道/depth 门控探针)——
const SCRIPTS = [
    // MVU 招牌:AI 输出里的 <UpdateVariable> 块,promptOnly+markdownOnly 双旗 → 两条道都藏。
    { id: 's1', scriptName: 'hide-updatevar', findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g', replaceString: '', placement: [2], markdownOnly: true, promptOnly: true, runOnEdit: true },
    // 状态栏占位:promptOnly → 只瞒 AI,展示面留给 markdown 版本。
    { id: 's2', scriptName: 'prompt-hide-status', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', placement: [2], promptOnly: true },
    { id: 's3', scriptName: 'md-status', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<SB>ON</SB>', placement: [2], markdownOnly: true },
    // plain(无旗):落盘车道 → 展示/出参两边都看不到 <SECRET>。
    { id: 's4', scriptName: 'secret-strip', findRegex: '<SECRET>', replaceString: '', placement: [1, 2] },
    { id: 's5', scriptName: 'user-shout', findRegex: '/quiet/gi', replaceString: 'LOUD', placement: [1] },
    { id: 's6', scriptName: 'narrator-tag', findRegex: 'nar', replaceString: 'NN', placement: [3] },
    { id: 's7', scriptName: 'deep-gate', findRegex: 'deep', replaceString: 'D', placement: [2], promptOnly: true, minDepth: 1 },
    { id: 's8', scriptName: 'md-deep', findRegex: 'deep', replaceString: 'DD', placement: [2], markdownOnly: true, minDepth: 1 },
    // REASONING placement:reasoning 文本落盘前(flagless)即被改写。
    { id: 's9', scriptName: 'reason-tag', findRegex: 'think', replaceString: '[R]', placement: [6] },
    { id: 's10', scriptName: 'reason-secret', findRegex: '<SECRET>', replaceString: '', placement: [6] },
];

const CARD = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: 'MVU', description: 'You are MVU.', first_mes: 'hi',
        extensions: { regex_scripts: SCRIPTS },
    },
};

const PRESET = {
    openai_model: 'test-model', openai_max_context: 8192,
    prompts: [
        { identifier: 'main', name: 'Main Prompt', content: 'SYS', role: 'system', system_prompt: true, marker: false },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
};

// 楼层集(non-system 4 层:idx0 depth3 / idx1 depth2 / idx2 depth1 / idx4 depth0)
const CHAT_BODY = [
    { is_user: true, name: 'User', send_date: 1, mes: 'quiet hello <SECRET>' },
    {
        is_user: false, name: 'MVU', send_date: 2,
        mes: 'old text. <UpdateVariable>{"x":1}</UpdateVariable> <StatusPlaceHolderImpl/> deep',
        swipes: [
            'v0 <UpdateVariable>{"x":0}</UpdateVariable> deep',
            'v1 <StatusPlaceHolderImpl/> <SECRET>',
        ],
        swipe_id: 1,
        swipe_info: [
            { send_date: 2, extra: { reasoning: 'r0 think <SECRET>' } },
            { send_date: 3, extra: { reasoning: 'r1 think' } },
        ],
        extra: { api: 'openai', reasoning: 'active think' },
    },
    { is_user: false, name: 'MVU', send_date: 3, mes: 'nar test <SECRET>', extra: { type: 'narrator' } },
    { is_system: true, name: 'Luker System', send_date: 4, mes: 'sys <SECRET> deep' },
    { is_user: false, name: 'MVU', send_date: 5, mes: 'tail <StatusPlaceHolderImpl/> deep' },
];

function makeTmpDirs() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-chatrx-'));
    const dirs = {
        root: tmpDir,
        characters: path.join(tmpDir, 'characters'),
        chats: path.join(tmpDir, 'chats'),
        worlds: path.join(tmpDir, 'worlds'),
        groups: path.join(tmpDir, 'groups'),
        openAI_Settings: path.join(tmpDir, 'OpenAI Settings'),
        context: path.join(tmpDir, 'context'),
        instruct: path.join(tmpDir, 'instruct'),
        sysprompt: path.join(tmpDir, 'sysprompt'),
        reasoning: path.join(tmpDir, 'reasoning'),
        koboldAI_Settings: path.join(tmpDir, 'KoboldAI Settings'),
        novelAI_Settings: path.join(tmpDir, 'NovelAI Settings'),
        textGen_Settings: path.join(tmpDir, 'TextGen Settings'),
    };
    return { tmpDir, dirs };
}

function makeApp(dirs) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: HANDLE, name: 'User' },
            directories: dirs,
            canWrite: true,
        };
        next();
    });
    app.use('/api/chats', chatsRouter);
    const utopinnRouter = express.Router();
    const ws = {
        register: (spec) => {
            utopinnRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    const ctx = { webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) };
    applyUtopinnLibrary(ctx);
    applyUtopinnRegex(ctx);
    applyUtopinnGenerate(ctx);
    // 插件注册的是全路径(/api/utopinn/...),router 挂根。
    app.use(utopinnRouter);
    return app;
}

async function seed(dirs, { settings = {}, chatBody = CHAT_BODY, card = CARD } = {}) {
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
    await getSettingsRepo().save(HANDLE, {
        power_user: { personas: { 'p1': 'Vela' }, default_persona: 'p1' },
        preset_settings_openai: 'Default',
        ...settings,
    });
    await getPresetRepo().save(HANDLE, 'openai', 'Default', PRESET);
    await getChatRepo().save(HANDLE, CHAR, 'c1', { user_name: 'User', chat_metadata: {} }, chatBody, null);
    if (card) {
        fs.mkdirSync(dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`), JSON.stringify(card));
    }
}

async function getJson(app, url) {
    const srv = app.listen(0);
    try {
        const port = srv.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${url}`);
        return { status: res.status, json: await res.json() };
    } finally { srv.close(); }
}

async function postJson(app, url, body) {
    const srv = app.listen(0);
    try {
        const port = srv.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() };
    } finally { srv.close(); }
}

// —— 单元面:收集自动放行 + 展示投影纯函数 ————————————————————————————————

// substituteParams 会无条件读 chatMetadata.chat_id_hash —— substCtx 最小完整形。
const SUBST = () => ({ name1: 'User', name2: 'MVU', chatMetadata: {}, currentChatId: 'c1', chat: [] });

test('collect: 卡作用域脚本无 allowlist 自动放行;disabledExtensions 全灭', () => {
    const settingsDoc = { extension_settings: {} };
    const runner = createFloorRegexRunner(settingsDoc, SUBST(), { card: CARD, charDir: CHAR });
    assert.equal(runner.scriptCount, SCRIPTS.length, 'card scripts must enter collection');

    const killed = createFloorRegexRunner(
        { extension_settings: { disabledExtensions: ['regex'] } },
        SUBST(), { card: CARD, charDir: CHAR });
    assert.equal(killed.scriptCount, 0, 'disabledExtensions must kill all lanes');
});

test('display projection: mes/swipes/reasoning 各车道与 depth 门控', () => {
    const runner = createFloorRegexRunner({ extension_settings: {} }, SUBST(), { card: CARD, charDir: CHAR });
    const { floors, applied } = projectChatFloorsForDisplay(CHAT_BODY, runner);
    assert.equal(applied >= 3, true, 'several floors rewritten');

    // 用户楼:persisted 车道 s5(USER_INPUT)+ s4 → 'quiet'→LOUD、<SECRET> 抹除。
    assert.equal(floors[0].mes_display, 'LOUD hello ');
    assert.equal(floors[0].mes, 'quiet hello <SECRET>', 'raw mes preserved');

    // AI 楼 depth=2:markdown 车道 s1 藏 UpdateVariable、s3 换状态栏、s8 deep→DD。
    assert.equal(floors[1].mes_display, 'old text.  <SB>ON</SB> DD');
    assert.match(floors[1].mes, /<UpdateVariable>/, 'raw mes keeps UpdateVariable block');
    assert.match(floors[1].mes, /<StatusPlaceHolderImpl\/>/, 'raw mes keeps status tag');

    // 各 swipe 版本独立投影。
    assert.deepEqual(floors[1].swipes_display, ['v0  DD', 'v1 <SB>ON</SB> ']);
    assert.equal(floors[1].swipes[0], 'v0 <UpdateVariable>{"x":0}</UpdateVariable> deep', 'raw swipe preserved');

    // reasoning = persisted→markdown 同链:s9 think→[R]、s10 <SECRET> 抹除。
    assert.equal(floors[1].reasoning_display, 'active [R]');
    assert.equal(floors[1].extra.reasoning, 'active think', 'raw extra.reasoning preserved');
    assert.equal(floors[1].swipe_info[0].extra.reasoning_display, 'r0 [R] ');
    assert.equal(floors[1].swipe_info[1].extra.reasoning_display, 'r1 [R]');
    assert.equal(floors[1].swipe_info[0].extra.reasoning, 'r0 think <SECRET>', 'raw swipe reasoning preserved');

    // narrator 楼 → SLASH_COMMAND:s6 nar→NN;s4(placement 1/2)不动 SLASH。
    assert.equal(floors[2].mes_display, 'NN test <SECRET>');

    // 'Luker System' 楼 → 上游门控整楼跳过(连投影键都没有)。
    assert.equal(floors[3].mes_display, undefined);
    assert.equal(floors[3].mes, 'sys <SECRET> deep');

    // depth 门控:尾楼 depth=0 < s8.minDepth=1 → deep 不动,标签照换。
    assert.equal(floors[4].mes_display, 'tail <SB>ON</SB> deep');
});

// —— 端点面:两条 chats 读取路径同一投影 —————————————————————————————————

test('endpoints: library GET 与 legacy /api/chats/get 投影一致,存储字段原样', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const app = makeApp(dirs);

        const lib = await getJson(app, `/api/utopinn/characters/${CHAR}/chats/c1`);
        assert.equal(lib.status, 200);
        const m1 = lib.json.messages[1];
        assert.equal(m1.mes_display, 'old text.  <SB>ON</SB> DD');
        assert.match(m1.mes, /<UpdateVariable>/, 'library GET preserves raw mes');
        assert.deepEqual(m1.swipes_display, ['v0  DD', 'v1 <SB>ON</SB> ']);
        assert.equal(m1.reasoning_display, 'active [R]');

        const legacy = await postJson(app, '/api/chats/get', { avatar_url: `${CHAR}.png`, file_name: 'c1' });
        assert.equal(legacy.status, 200);
        assert.ok(Array.isArray(legacy.json), 'legacy shape = [header, ...floors]');
        const l1 = legacy.json[2]; // [0]=header
        assert.equal(l1.mes_display, m1.mes_display);
        assert.deepEqual(l1.swipes_display, m1.swipes_display);
        assert.match(l1.mes, /<UpdateVariable>/, 'legacy GET preserves raw mes');

        // 写回面拿到的仍是存储真值:再读一次确认 sidecar/disk 未被投影污染。
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        assert.match(reread.body[1].mes, /<UpdateVariable>/, 'repo body untouched by projection');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('endpoints: disabledExtensions 全灭 → 投影透传无 *_display 键', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, { settings: { extension_settings: { disabledExtensions: ['regex'] } } });
        const app = makeApp(dirs);
        const lib = await getJson(app, `/api/utopinn/characters/${CHAR}/chats/c1`);
        assert.equal(lib.status, 200);
        assert.equal(lib.json.messages[1].mes_display, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('regex REST: scope=char 面报 autoAllowed/active,allowlist 仅留档', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const app = makeApp(dirs);
        const r = await getJson(app, `/api/utopinn/regex?scope=char&char=${CHAR}`);
        assert.equal(r.status, 200);
        assert.equal(r.json.autoAllowed, true, 'card-scope scripts are auto-allowed');
        assert.equal(r.json.active, true, 'scripts active at display/prompt lanes');
        assert.equal(r.json.allowed, false, 'legacy allowlist untouched');
        assert.equal(r.json.scripts.length, SCRIPTS.length);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// —— 组装车道:buildGenerationContext 楼层出参 + trace 真数 ————————————————

test('prompt lane: buildGenerationContext 楼层 persisted→isPrompt + regex trace 真数', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const request = { user: { profile: { handle: HANDLE, name: 'User' }, directories: dirs } };
        const { request: asmReq } = await buildGenerationContext({
            request, charDir: CHAR, chatName: 'c1', card: CARD, presetName: 'Default', user: { name: 'User' },
        });
        const chat = asmReq.chat;

        // floor3(Luker System)被 chatBodyToInput 过滤 → 4 层进组装。
        assert.equal(chat.length, 4);
        assert.equal(chat[0].mes, 'LOUD hello ', 'user floor: persisted USER_INPUT');
        // s1(promptOnly) 藏 UpdateVariable、s2 抹状态栏、s7 deep→D(depth2≥1)。
        assert.equal(chat[1].mes, 'old text.   D');
        assert.equal(chat[1].extra.reasoning, 'active [R]', 'reasoning: REASONING persisted→prompt');
        // narrator:持久车道 SLASH_COMMAND(nar→NN);prompt 车道无 SLASH 脚本。
        assert.equal(chat[2].mes, 'NN test <SECRET>');
        // 尾楼 depth=0:s7 minDepth=1 门住 → deep 保留;标签照样被 s2 抹。
        assert.equal(chat[3].mes, 'tail  deep');

        // trace:regex 事件报真收集数与出参命中数(不再是 WI 面恒 0)。
        const evts = diagQuery({ kind: 'inject', code: 'regex' });
        const last = evts[evts.length - 1];
        assert.equal(last.data.scripts, SCRIPTS.length, 'trace reports real collected script count');
        assert.equal(last.data.promptApplied, 4, 'floors rewritten at prompt lane');
        assert.equal(last.data.applied, (last.data.wiApplied ?? 0) + last.data.promptApplied);

        // 存储真值不被组装面污染。
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        assert.match(reread.body[1].mes, /<UpdateVariable>/, 'chat file keeps raw mes');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('prompt lane: continue 时末层 depth=-1(上游同式)', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const request = { user: { profile: { handle: HANDLE, name: 'User' }, directories: dirs } };
        const { request: asmReq } = await buildGenerationContext({
            request, charDir: CHAR, chatName: 'c1', card: CARD, presetName: 'Default',
            user: { name: 'User' }, type: 'continue',
        });
        const chat = asmReq.chat;
        // continue 末层 depth=-1 < minDepth → s7 仍不触发;其余同 normal。
        assert.equal(chat[3].mes, 'tail  deep');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// —— Output lane (GH#3 residual): generated reply regex before persist ————————

function makeGenRequest(dirs, { type = 'normal' } = {}) {
    return {
        user: { profile: { handle: HANDLE, name: 'User' }, directories: dirs },
        body: { type, model: 'test-model', chat_completion_source: 'openai' },
    };
}

function makeGenJob(request, jobId) {
    const job = lukerGeneration.createGenerationJob(request, {
        job_id: jobId,
        persist_target: {
            kind: 'character',
            avatar_url: `${CHAR}.png`,
            file_name: 'c1.jsonl',
            char_name: CHAR,
            chat_metadata: {},
        },
    });
    assert.ok(job, 'job created');
    return job;
}

/** Defuse the 15s grace persist timer so it cannot fire into removed tmp dirs. */
function defuseJob(job) {
    job.acked = true;
    clearTimeout(job.persistenceTimer);
}

test('output lane: generated reply persisted-lane lands canonical in stored mes', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const request = makeGenRequest(dirs);
        // Same stash shape buildGenerationContext leaves on the request.
        request.utopinnFloorRegexRunner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: CARD, charDir: CHAR });
        const job = makeGenJob(request, 'job-out-transform');

        const reply = 'fresh <UpdateVariable>{"x":9}</UpdateVariable> <SECRET> deep';
        await lukerGeneration.completeGenerationJobFromText(request, job, reply, 'test-model');
        defuseJob(job);

        // Persisted lane only: s4 (plain) strips <SECRET>. s1 is
        // markdownOnly+promptOnly and s2 promptOnly — neither may run here,
        // so the UpdateVariable block survives into the canonical text.
        assert.equal(job.text, 'fresh <UpdateVariable>{"x":9}</UpdateVariable>  deep');
        assert.equal(job.outputRegexApplied, true);

        // regex_output diag event reports the real output-side application.
        const evts = diagQuery({ kind: 'inject', code: 'regex_output' });
        const last = evts[evts.length - 1];
        assert.equal(last.data.scripts, SCRIPTS.length);
        assert.equal(last.data.applied, 1);

        // The fallback persist route lands the canonical text and stamps
        // the canonical marks on both the floor and the swipe version.
        const ok = await lukerGeneration.persistJobReplyText(job, job.text, job.id, 'test-model');
        assert.equal(ok, true);
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        const floor = reread.body[reread.body.length - 1];
        assert.equal(floor.mes, 'fresh <UpdateVariable>{"x":9}</UpdateVariable>  deep');
        assert.deepEqual(floor.swipes, ['fresh <UpdateVariable>{"x":9}</UpdateVariable>  deep']);
        assert.doesNotMatch(floor.mes, /<SECRET>/);
        assert.equal(floor.extra.regex_persisted, true, 'floor mes marked canonical');
        assert.equal(floor.swipe_info[0].extra.regex_persisted, true, 'swipe version marked canonical');

        // Display projection re-derives the markdown view at read time —
        // canonical marked text skips the persisted lane and only runs the
        // markdown lane (s1 folds the UpdateVariable block away).
        const runner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: CARD, charDir: CHAR });
        const { floors } = projectChatFloorsForDisplay(reread.body, runner);
        assert.equal(floors[floors.length - 1].mes_display, 'fresh   deep');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('output lane: impersonate verb uses USER_INPUT placement', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const request = makeGenRequest(dirs, { type: 'impersonate' });
        request.utopinnFloorRegexRunner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: CARD, charDir: CHAR });
        const job = makeGenJob(request, 'job-out-impersonate');

        // s5 'user-shout' (plain, placement [1]) only fires on USER_INPUT.
        await lukerGeneration.completeGenerationJobFromText(request, job, 'quiet reply', 'test-model');
        defuseJob(job);
        assert.equal(job.text, 'LOUD reply');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('output lane: no stashed runner leaves job.text raw', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const request = makeGenRequest(dirs); // no utopinnFloorRegexRunner
        const job = makeGenJob(request, 'job-out-norunner');
        const raw = 'raw <UpdateVariable>{"x":1}</UpdateVariable>';
        await lukerGeneration.completeGenerationJobFromText(request, job, raw, 'test-model');
        defuseJob(job);
        assert.equal(job.text, raw);
        assert.equal(job.status, 'awaiting_ack');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('output lane ordering: wrapper-preserving rewrite still folds MVU (regex before settle)', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    // Card whose markdownOnly script wraps UpdateVariable in a fold div —
    // the inner _.set command survives, proving regex ran before settle.
    const WRAP_CARD = {
        ...CARD,
        data: {
            ...CARD.data,
            extensions: {
                regex_scripts: [{
                    id: 'w1', scriptName: 'wrap-uv',
                    findRegex: '/<UpdateVariable>([\\s\\S]*?)<\\/UpdateVariable>/g',
                    replaceString: '<div class="fold">$1</div>',
                    placement: [2], markdownOnly: true, trimStrings: [],
                }],
            },
        },
    };
    const mvuBaseline = {
        stat_data: { hp: 1 },
        schema: { type: 'object', extensible: true, properties: { hp: { type: 'number' } } },
        initialized_lorebooks: [],
    };
    try {
        await seed(dirs, {
            card: WRAP_CARD,
            chatBody: [
                { is_user: true, name: 'User', send_date: 1, mes: 'hi' },
                {
                    is_user: false, name: 'MVU', send_date: 2, mes: 'init',
                    swipe_id: 0, swipes: ['init'], swipe_info: [{ send_date: 2, extra: {} }],
                    variables: { 0: mvuBaseline },
                },
            ],
        });
        const request = makeGenRequest(dirs);
        request.utopinnFloorRegexRunner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: WRAP_CARD, charDir: CHAR });
        const job = makeGenJob(request, 'job-out-mvu');

        await lukerGeneration.completeGenerationJobFromText(
            request, job, 'settle me <UpdateVariable>_.set(\'hp\', 5)</UpdateVariable>', 'test-model');
        defuseJob(job);
        // markdownOnly scripts must not run on the persist path — the
        // canonical text keeps the raw UpdateVariable block so MVU settle
        // can still extract the _.set command from stored mes.
        assert.equal(job.text, 'settle me <UpdateVariable>_.set(\'hp\', 5)</UpdateVariable>');

        await lukerGeneration.persistJobReplyText(job, job.text, job.id, 'test-model');
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        const floor = reread.body[reread.body.length - 1];
        // _.set('hp', 5) folded out of the canonical block, then the settle
        // appended its status anchor — before-settle ordering proven end to
        // end, and this now works even for scripts that hide the block.
        assert.match(floor.mes, /<UpdateVariable>_\.set\('hp', 5\)<\/UpdateVariable>/);
        assert.match(floor.mes, /<StatusPlaceHolderImpl\/>/);
        assert.equal(floor.extra.regex_persisted, true, 'floor marked canonical');
        assert.equal(floor.variables?.[0]?.stat_data?.hp, 5);
        assert.equal(reread.header?.chat_metadata?.variables?.stat_data?.hp, 5);

        // The markdown fold itself is re-derived at read time by the display
        // projection — it never touches the stored canonical text.
        const runner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: WRAP_CARD, charDir: CHAR });
        const { floors } = projectChatFloorsForDisplay(reread.body, runner);
        assert.match(floors[floors.length - 1].mes_display, /<div class="fold">_.set\('hp', 5\)<\/div>/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('output lane: appended floor reasoning gets REASONING display chain', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const app = makeApp(dirs);
        const res = await postJson(app, `/api/utopinn/characters/${CHAR}/chats/c1/messages`, {
            message: {
                name: CHAR, is_user: false, send_date: 100,
                mes: 'plain reply',
                swipes: ['plain reply'], swipe_id: 0,
                swipe_info: [{ send_date: 100, extra: { reasoning: 'think deep' } }],
                extra: { api: 'openai', reasoning: 'think <SECRET>' },
            },
        });
        assert.equal(res.status, 200);
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        const floor = reread.body[reread.body.length - 1];
        // s9 'think'→'[R]' and s10 '<SECRET>'→'' both ran at REASONING —
        // the persisted lane only (plain scripts), matching upstream's
        // flagless call before the reasoning field lands.
        assert.equal(floor.extra.reasoning, '[R] ');
        assert.equal(floor.swipe_info[0].extra.reasoning, '[R] deep');
        // Transformed fields are stamped reasoning_persisted so read/prompt
        // projections run only their own lane on them.
        assert.equal(floor.extra.reasoning_persisted, true);
        assert.equal(floor.swipe_info[0].extra.reasoning_persisted, true);
        // mes is client-supplied floor text, not a job reply — untouched here.
        assert.equal(floor.mes, 'plain reply');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// —— Filtered-empty terminal: whole reply consumed by output regex ————————

const FILTER_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: 'MVU', description: 'You are MVU.', first_mes: 'hi',
        extensions: {
            regex_scripts: [
                // Plain persisted-lane script that consumes the entire reply.
                { id: 'f1', scriptName: 'strip-analysis', findRegex: '/<Analysis>[\\s\\S]*?<\\/Analysis>/g', replaceString: '', placement: [2] },
            ],
        },
    },
};

test('output lane: reply fully consumed by regex finalizes empty, not failed', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, { card: FILTER_CARD });
        const request = makeGenRequest(dirs);
        request.utopinnFloorRegexRunner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: FILTER_CARD, charDir: CHAR });

        // Contrast 1: provider returned nothing → still a failure.
        const emptyJob = makeGenJob(request, 'job-provider-empty');
        await lukerGeneration.completeGenerationJobFromText(request, emptyJob, '', 'test-model');
        assert.equal(emptyJob.status, 'failed');
        assert.equal(emptyJob.error, 'Generation produced no output.');
        assert.equal(emptyJob.outputFiltered ?? false, false);

        // Contrast 2: provider returned text that the rules consumed
        // entirely → finalized empty reply, completed with nothing to write.
        const job = makeGenJob(request, 'job-filtered-empty');
        await lukerGeneration.completeGenerationJobFromText(
            request, job, '<Analysis>draft</Analysis>', 'test-model');
        assert.equal(job.status, 'completed');
        assert.equal(job.outputFiltered, true);
        assert.equal(job.text, '');
        assert.equal(job.error ?? '', '');
        // No persistence timer was armed (job never entered awaiting_ack).
        assert.equal(job.persistenceTimer ?? null, null);

        // Nothing was persisted for the filtered reply.
        assert.notEqual(job.persisted, true);
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        assert.equal(reread.body.length, CHAT_BODY.length, 'no floor appended');

        // Job detail reports the filtered terminal so clients can never
        // mistake it for a stream failure and fill raw chunks back in.
        const app = makeApp(dirs);
        const detail = await getJson(app, '/api/utopinn/jobs/job-filtered-empty');
        assert.equal(detail.status, 200);
        assert.equal(detail.json.status, 'completed');
        assert.equal(detail.json.outputFiltered, true);
        assert.equal(detail.json.text, '');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// —— Two-round canonical: markdown/prompt lanes on their views only ————————

const TWO_ROUND_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: 'MVU', description: 'You are MVU.', first_mes: 'hi',
        extensions: {
            regex_scripts: [
                // Plain persisted lane, deliberately NON-idempotent so a
                // second persisted pass would leave visible damage.
                { id: 't1', scriptName: 'double-o', findRegex: 'o', replaceString: 'oo', placement: [2] },
                // Same marker, two view-specific rewrites — proves each lane
                // only runs on its own projection.
                { id: 't2', scriptName: 'fold-md', findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g', replaceString: '[FOLD]', placement: [2], markdownOnly: true },
                { id: 't3', scriptName: 'fold-prompt', findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g', replaceString: '[HIDDEN]', placement: [2], promptOnly: true },
            ],
        },
    },
};

test('two-round: canonical stores persisted text; markdown/prompt views stay separate', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, { card: TWO_ROUND_CARD });
        const request = makeGenRequest(dirs);
        request.utopinnFloorRegexRunner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: TWO_ROUND_CARD, charDir: CHAR });
        const job = makeGenJob(request, 'job-two-round');

        // Round 1 — provider reply goes through the persisted lane only:
        // t1 doubles the first 'o' (literal find, no /g flag — still
        // non-idempotent: a second pass would add another 'o'); t2/t3 are
        // view lanes and must not run.
        await lukerGeneration.completeGenerationJobFromText(
            request, job, 'root <UpdateVariable>{"x":9}</UpdateVariable> end', 'test-model');
        defuseJob(job);
        const canonical = 'rooot <UpdateVariable>{"x":9}</UpdateVariable> end';
        assert.equal(job.text, canonical);

        await lukerGeneration.persistJobReplyText(job, job.text, job.id, 'test-model');
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        const stored = reread.body[reread.body.length - 1];
        assert.equal(stored.mes, canonical, 'canonical text persisted');
        assert.equal(stored.extra.regex_persisted, true, 'floor marked canonical');

        // Display projection: marked canonical floor runs ONLY the markdown
        // lane — t2 folds the block to [FOLD], t3 does not run, t1 is not
        // re-applied (o count unchanged).
        const runner = createFloorRegexRunner(
            { extension_settings: {} }, SUBST(), { card: TWO_ROUND_CARD, charDir: CHAR });
        const { floors } = projectChatFloorsForDisplay(reread.body, runner);
        assert.equal(
            floors[floors.length - 1].mes_display,
            'rooot [FOLD] end');

        // Round 2 — prompt assembly: marked canonical floor runs ONLY the
        // prompt lane — t3 yields [HIDDEN], t2 does not run, and crucially
        // t1 does not double-apply (canonical 'rooot' would become 'roooot'
        // if the persisted lane ran again).
        const { request: asmReq } = await buildGenerationContext({
            request, charDir: CHAR, chatName: 'c1', card: TWO_ROUND_CARD, presetName: 'Default', user: { name: 'User' },
        });
        const chat = asmReq.chat;
        assert.equal(chat[chat.length - 1].mes, 'rooot [HIDDEN] end');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// —— Real WS delivery → client write-back stores canonical text ————————————

const WS_RAW = 'fresh <SECRET> deep';
const WS_CANONICAL = 'fresh  deep';

/** Decode WS chunk frames (base64 SSE bytes) into joined delta text. */
function wsStreamedText(frames) {
    let out = '';
    for (const m of frames) {
        if (m.type !== 'chunk') continue;
        const sse = Buffer.from(m.data, 'base64').toString('utf8');
        for (const line of sse.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const j = JSON.parse(payload);
                out += j?.choices?.[0]?.delta?.content ?? '';
            } catch { /* non-JSON SSE line — ignore */ }
        }
    }
    return out;
}

test('ws e2e: streamed raw chunks vs job detail canonical → append + PATCH store canonical', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    let httpServer = null;
    const jobs = [];
    try {
        await seed(dirs);
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((req, _res, next) => {
            req.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs, canWrite: true };
            next();
        });
        app.post('/api/backends/chat-completions/generate', (req, res) => {
            // Same stash the generate endpoint leaves on the request.
            req.utopinnFloorRegexRunner = createFloorRegexRunner(
                { extension_settings: {} }, SUBST(), { card: CARD, charDir: CHAR });
            return runLukerDispatch(req, res, {
                endpoint: 'chat-completions',
                select: () => async (ctx) => {
                    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: WS_RAW } }] })}\n\n`;
                    ctx.emit.chunk(new TextEncoder().encode(sse));
                    ctx.emit.end();
                },
            });
        });
        const utopinnRouter = express.Router();
        httpServer = http.createServer(app);
        // Minimal webServer seam — registerUpgrade dispatches on request
        // path the same way the kernel webServer does in production.
        const upgradeHandlers = [];
        httpServer.on('upgrade', (req, socket, head) => {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            const hit = upgradeHandlers.find((h) => h.path === pathname);
            if (hit) return hit.handler(req, socket, head);
            socket.destroy();
        });
        const wsr = {
            register: (spec) => {
                utopinnRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
                return () => {};
            },
            registerUpgrade: ({ path: p, handler }) => {
                upgradeHandlers.push({ path: p, handler });
                return () => {};
            },
        };
        const pctx = { webServer: wsr, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) };
        applyUtopinnLibrary(pctx);
        applyUtopinnGenerate(pctx);
        applyUtopinnDelivery(pctx);
        app.use(utopinnRouter);
        await new Promise((r) => httpServer.listen(0, r));
        const port = httpServer.address().port;
        const base = `http://127.0.0.1:${port}`;

        const requestId = 'job-ws-canonical';
        const genRes = await fetch(`${base}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-luker-request-id': requestId },
            // kind 'none' — client owns the write-back; server never persists.
            body: JSON.stringify({ type: 'normal', luker_generation: { persist_target: { kind: 'none' } } }),
        });
        assert.equal(genRes.status, 200);

        // Stream over real WS — resume from seq 1 like the production client.
        const ticket = wsTicketTestUtils.mintTicket(HANDLE);
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws-delivery`, [`luker-ws-ticket.${ticket}`]);
        await new Promise((r) => ws.once('open', r));
        const frames = [];
        const done = new Promise((resolve) => {
            ws.on('message', (raw) => {
                const m = JSON.parse(String(raw));
                frames.push(m);
                if (m.type === 'end') resolve();
            });
        });
        ws.send(JSON.stringify({ type: 'resume', request_id: requestId, from_seq: 1 }));
        await done;
        ws.close();

        // The stream carried raw provider text — regex runs at finalize,
        // not on the wire. The end frame carries no text by design.
        const streamed = wsStreamedText(frames);
        assert.equal(streamed, WS_RAW);
        const endFrame = frames.find((m) => m.type === 'end');
        assert.ok(endFrame, 'end frame delivered');
        assert.equal('text' in endFrame, false, 'end frame stays text-less');

        // The authoritative finalized text comes from the job detail —
        // the web stage polls it after the end frame before write-back.
        const jobRes = await fetch(`${base}/api/utopinn/jobs/${requestId}`);
        assert.equal(jobRes.status, 200);
        const job = await jobRes.json();
        jobs.push(job);
        assert.equal(job.status, 'awaiting_ack');
        assert.equal(job.outputFiltered, false);
        assert.equal(job.text, WS_CANONICAL, 'server-finalized text is canonical, not raw');

        // Write-back 1: append — the stage's non-swipe path.
        const appendRes = await fetch(`${base}/api/utopinn/characters/${CHAR}/chats/c1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                luker_generation_id: requestId,
                messages: [{
                    is_user: false, name: 'MVU', send_date: 100,
                    mes: job.text,
                    swipes: [job.text],
                    swipe_id: 0,
                    swipe_info: [{ send_date: 100, gen_started: null, gen_finished: null, extra: {} }],
                    extra: { api: 'openai', model: 'test-model' },
                }],
            }),
        });
        assert.equal(appendRes.status, 200);
        let reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        let floor = reread.body[reread.body.length - 1];
        assert.equal(floor.mes, WS_CANONICAL, 'append stored canonical text');
        assert.deepEqual(floor.swipes, [WS_CANONICAL]);
        assert.equal(floor.extra.regex_persisted, true, 'appended floor marked canonical');
        assert.equal(floor.swipe_info[0].extra.regex_persisted, true, 'appended swipe marked canonical');

        // Write-back 2: PATCH swipe-merge — the stage's swipe verb path on
        // the floor just appended (a re-swipe writes another version).
        const lastIdx = reread.body.length - 1;
        const patchRes = await fetch(`${base}/api/utopinn/characters/${CHAR}/chats/c1`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                luker_generation_id: requestId,
                ops: [
                    { op: 'add', path: `/body/${lastIdx}/swipes/-`, value: job.text },
                    { op: 'replace', path: `/body/${lastIdx}/swipe_id`, value: 1 },
                    { op: 'add', path: `/body/${lastIdx}/swipe_info/-`, value: { send_date: 200, extra: {} } },
                    { op: 'replace', path: `/body/${lastIdx}/mes`, value: job.text },
                ],
            }),
        });
        assert.equal(patchRes.status, 200);
        reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        floor = reread.body[lastIdx];
        assert.deepEqual(floor.swipes, [WS_CANONICAL, WS_CANONICAL], 'PATCH stored canonical swipe');
        assert.equal(floor.mes, WS_CANONICAL, 'PATCH stored canonical mes');
        assert.equal(floor.swipe_info[1].extra.regex_persisted, true, 'PATCH marked new swipe slot');
        assert.equal(floor.extra.regex_persisted, true, 'PATCH marked floor mes');
    } finally {
        for (const j of jobs) {
            const live = lukerGeneration.getGenerationJobForRequest(
                { user: { profile: { handle: HANDLE } } }, j.id);
            if (live?.persistenceTimer) clearTimeout(live.persistenceTimer);
        }
        if (httpServer) await new Promise((r) => httpServer.close(r));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
