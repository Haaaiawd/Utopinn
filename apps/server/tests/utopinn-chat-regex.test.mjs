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
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { getConfigFilePath, setConfigFilePath, reloadConfigCache } from '../src/util.js';
import { initStorage, getChatRepo, getPresetRepo, getSettingsRepo } from '../src/storage/index.js';
import { buildGenerationContext } from '../src/services/generate-context.js';
import { createFloorRegexRunner, projectChatFloorsForDisplay } from '../src/services/extension-prompts.js';
import { query as diagQuery } from '../src/services/diag-bus.js';

// chats.js 传递依赖(backends/luker-generation.js)模块级读 config ——
// 必须 setConfigFilePath 后才可 import,故重依赖全部动态引入。
let chatsRouter, applyUtopinnLibrary, applyUtopinnRegex, lukerGeneration;

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
    lukerGeneration = await import('../src/endpoints/backends/luker-generation.js');
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

test('output lane: generated reply display-chain lands in persisted mes', async () => {
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

        // persisted lane strips <SECRET> (s4 plain); markdown lane strips the
        // UpdateVariable block (s1 markdownOnly); depth-gated s8 stays quiet.
        assert.equal(job.text, 'fresh   deep');

        // regex_output diag event reports the real output-side application.
        const evts = diagQuery({ kind: 'inject', code: 'regex_output' });
        const last = evts[evts.length - 1];
        assert.equal(last.data.scripts, SCRIPTS.length);
        assert.equal(last.data.applied, 1);

        // The fallback persist route lands the already-processed text.
        const ok = await lukerGeneration.persistJobReplyText(job, job.text, job.id, 'test-model');
        assert.equal(ok, true);
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        const floor = reread.body[reread.body.length - 1];
        assert.equal(floor.mes, 'fresh   deep');
        assert.deepEqual(floor.swipes, ['fresh   deep']);
        assert.doesNotMatch(floor.mes, /<UpdateVariable>/);
        assert.doesNotMatch(floor.mes, /<SECRET>/);
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
        assert.equal(job.text, 'settle me <div class="fold">_.set(\'hp\', 5)</div>');

        await lukerGeneration.persistJobReplyText(job, job.text, job.id, 'test-model');
        const reread = await getChatRepo().get(HANDLE, CHAR, 'c1');
        const floor = reread.body[reread.body.length - 1];
        // _.set('hp', 5) folded out of the wrapped block, then the settle
        // appended its status anchor — before-settle ordering proven end to end.
        assert.match(floor.mes, /<div class="fold">_.set\('hp', 5\)<\/div>/);
        assert.match(floor.mes, /<StatusPlaceHolderImpl\/>/);
        assert.equal(floor.variables?.[0]?.stat_data?.hp, 5);
        assert.equal(reread.header?.chat_metadata?.variables?.stat_data?.hp, 5);
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
        // s9 'think'→'[R]' and s10 '<SECRET>'→'' both ran at REASONING.
        assert.equal(floor.extra.reasoning, '[R] ');
        assert.equal(floor.swipe_info[0].extra.reasoning, '[R] deep');
        // mes is client-supplied floor text, not a job reply — untouched here.
        assert.equal(floor.mes, 'plain reply');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
