/**
 * TASK-037 — /api/utopinn/generate 非 openai 源(textgen/kobold/novel)旁路接入。
 *
 * 两层:
 *   纯函数层 —— textgen-body.js 的 kobold/novel 塑形 + kai_flags 版本门 +
 *   探测回落(encode/fetch 全走注入位,无网络无存储)。
 *   e2e 层 —— 真 Luker server + 内联 mock 上游(http.createServer):
 *     · api:'text'   → /v1/completions 全通(generic 形)
 *     · api:'kobold' → 探测 /v1/info/version + /extra/version → /v1/generate 全通
 *     · api:'novel'  → 路由进 dispatchNovelAI 证明位:无 secret → job failed
 *                      'NovelAI Access Token is missing'(provider 专属错误串)
 *     · api:'bogus'  → 400,不静默落 chat 路
 * 跑法:node --test tests/utopinn-generate-textapi.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServer, tearDownServer } from './e2e/_lib/server.js';
import { markOnboarded, writeCharacter, writePreset } from './e2e/_lib/fixtures.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

// tokenizers.js/secrets.js 模块级 getConfigValue —— 先指到 default/config.yaml
// 再动态 import textgen-body(mvu-settle.test.mjs:441 同款序)。
const __dirname = fileURLToPath(new URL('.', import.meta.url));
if (!getConfigFilePath()) {
    setConfigFilePath(resolve(__dirname, '../default/config.yaml'));
    reloadConfigCache();
}
const {
    versionGte,
    resolveKaiFlags,
    probeKoboldFlags,
    buildKoboldDispatchBody,
    buildNovelDispatchBody,
    novelTokenizerNameForModel,
    selectNovelPrefix,
} = await import('../src/services/textgen-body.js');

const HANDLE = 'default-user';
const CHAT = 'utopinn-textapi';
const TEXTGEN_REPLY = '*Ash unrolls the reef-chart across the table.* "Text route answers."';
const KOBOLD_REPLY = '*Ash taps the brass spyglass twice.* "Kobold route answers."';

// ═══════════════════════════ 纯函数层 ═══════════════════════════

// evaluateMacros 需 chatMetadata( chat_id_hash 落点 )+ globalVariables ——
// 与 generate-context.js:595 的真实 substCtx 同构的最小集
const SUBST_CTX = { name1: 'User', name2: 'Ash', chat: [], chatMetadata: {}, globalVariables: {} };
const ALL_FLAGS = {
    can_use_tokenization: true,
    can_use_stop_sequence: true,
    can_use_streaming: true,
    can_use_default_badwordsids: true,
    can_use_mirostat: true,
    can_use_grammar: true,
    can_use_min_p: true,
};

test('versionGte:逐段数值比 + 尾巴按 prerelease 低一档', () => {
    assert.equal(versionGte('1.2.4', '1.2.2'), true);
    assert.equal(versionGte('1.2.2', '1.2.2'), true);
    assert.equal(versionGte('1.2.1', '1.2.2'), false);
    assert.equal(versionGte('1.35', '1.30'), true);
    assert.equal(versionGte('1.48.0', '1.48'), true);
    assert.equal(versionGte('1.30rc1', '1.30'), false); // 净版本等值带尾巴 → 低一档
    assert.equal(versionGte(null, '1.30'), false);
});

test('resolveKaiFlags:两路版本各门各旗', () => {
    const flags = resolveKaiFlags({ koboldUnitedVersion: '1.2.5', koboldCppVersion: '1.50.0' });
    assert.deepEqual(flags, {
        can_use_tokenization: true,
        can_use_stop_sequence: true,
        can_use_streaming: true,
        can_use_default_badwordsids: true,
        can_use_mirostat: true,
        can_use_grammar: true,
        can_use_min_p: true,
    });
    const old = resolveKaiFlags({ koboldUnitedVersion: '1.2.0', koboldCppVersion: '1.25' });
    for (const v of Object.values(old)) assert.equal(v, false);
    // 单侧:null 侧全 false,另一侧照门
    const one = resolveKaiFlags({ koboldCppVersion: '1.50' });
    assert.equal(one.can_use_streaming, true);
    assert.equal(one.can_use_stop_sequence, false);
});

test('probeKoboldFlags:fetchImpl 探测 /v1/info/version + /extra/version', async () => {
    const seen = [];
    const flags = await probeKoboldFlags('http://kai.test', {
        fetchImpl: async (url) => {
            seen.push(String(url));
            const result = url.endsWith('/v1/info/version') ? '1.2.5' : '1.50';
            return { ok: true, json: async () => ({ result }) };
        },
    });
    assert.deepEqual(seen.sort(), ['http://kai.test/extra/version', 'http://kai.test/v1/info/version'].sort());
    assert.equal(flags.can_use_streaming, true);
    assert.equal(flags.can_use_stop_sequence, true);

    // 探测失败 → 全 false(保守,未知字段不上行)
    const dead = await probeKoboldFlags('http://dead.test', {
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    for (const v of Object.values(dead)) assert.equal(v, false);
});

test('buildKoboldDispatchBody:旗标门控字段 + undefined 剔除', () => {
    const kaiSettings = {
        temp: 0.7, rep_pen: 1.1, rep_pen_range: 256, rep_pen_slope: 0.9,
        tfs: 0.95, top_a: 0.1, top_k: 40, top_p: 0.9, min_p: 0.05, typical: 0.95,
        mirostat: 2, mirostat_tau: 5, mirostat_eta: 0.1,
        use_default_badwordsids: true,
        grammar: 'root ::= "x"',
        seed: 42,
        sampler_order: [6, 5, 0, 1, 2, 3, 4],
    };
    const powerUser = { context: { names_as_stop_strings: true } };
    const body = buildKoboldDispatchBody({
        kaiSettings, prompt: 'PROMPT', maxLength: 64, maxContext: 4096,
        kaiFlags: ALL_FLAGS, type: 'normal', powerUser, substCtx: SUBST_CTX, instructEngine: null,
    });
    assert.equal(body.prompt, 'PROMPT');
    assert.equal(body.max_length, 64);
    assert.equal(body.max_context_length, 4096);
    assert.equal(body.gui_settings, false);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.min_p, 0.05);            // can_use_min_p
    assert.equal(body.mirostat, 2);            // can_use_mirostat
    assert.equal(body.grammar, 'root ::= "x"'); // can_use_grammar
    assert.equal(body.sampler_seed, 42);       // seed >= 0
    assert.deepEqual(body.stop_sequence, ['\nUser:']); // names_as_stop_strings
    assert.equal(body.use_default_badwordsids, true);

    // 旗标全灭:门控字段一律不上行
    const blind = buildKoboldDispatchBody({
        kaiSettings, prompt: 'P', kaiFlags: {},
        powerUser, substCtx: SUBST_CTX, instructEngine: null,
    });
    for (const k of ['stop_sequence', 'mirostat', 'mirostat_tau', 'mirostat_eta', 'min_p', 'grammar', 'use_default_badwordsids']) {
        assert.equal(k in blind, false, `${k} should be absent when flag off`);
    }
    // undefined 值永不上行(JSON.stringify 语义)
    for (const [k, v] of Object.entries(body)) assert.notEqual(v, undefined, k);
});

test('novelTokenizerNameForModel / selectNovelPrefix', () => {
    assert.equal(novelTokenizerNameForModel('clio-v1'), 'nerdstash');
    assert.equal(novelTokenizerNameForModel('kayra-v1'), 'nerdstash_v2');
    assert.equal(novelTokenizerNameForModel('erato-v1'), 'llama3');
    assert.equal(novelTokenizerNameForModel('sigurd'), null);

    // 新模型 prompt 尾 1500 含 '}' → instruct 前缀;老模型恒 vanilla
    assert.equal(selectNovelPrefix('vanilla', 'story } tail', 'kayra-v1'), 'special_instruct');
    assert.equal(selectNovelPrefix('vanilla', 'plain tail', 'clio-v1'), 'vanilla');
    assert.equal(selectNovelPrefix('special_instruct', 'anything }', 'sigurd'), 'vanilla');
});

test('buildNovelDispatchBody:encode 注入 → 停止/禁词/logit_bias + erato 头', async () => {
    // 确定性注入:text → 逐码点 id(够验「编码被调用/数组形态」,不验词表)
    const encodeText = async (s) => Array.from(String(s)).map(c => c.charCodeAt(0) % 97);
    const naiSettings = {
        model_novel: 'erato-v1',
        temperature: 0.8, min_length: 5, tail_free_sampling: 0.9,
        repetition_penalty: 1.05, repetition_penalty_range: 1024,
        repetition_penalty_slope: 3.3, repetition_penalty_frequency: 0.02,
        repetition_penalty_presence: 0.0,
        top_a: 0.1, top_p: 0.95, top_k: 20, min_p: 0.05,
        math1_temp: 1, math1_quad: 1, math1_quad_entropy_scale: 1,
        typical_p: 0.9, mirostat_lr: 1, mirostat_tau: 5,
        phrase_rep_pen: 'aggressive',
        banned_tokens: '{driftwood}\n[11,22]\nsaltmark',
        logit_bias: [{ text: 'reef', value: -0.5 }],
        prefix: 'vanilla',
        order: [1, 2, 3],
    };
    const powerUser = { context: { names_as_stop_strings: true } };
    const body = await buildNovelDispatchBody({
        naiSettings, prompt: 'BASE', model: 'erato-v1', maxLength: 300,
        maxResponseTokens: 250, type: 'normal',
        powerUser, substCtx: SUBST_CTX, instructEngine: null,
        encodeText,
    });
    // erato 头 prepend + 模型名透传 + use_string 固定
    assert.equal(body.model, 'erato-v1');
    assert.equal(body.use_string, true);
    assert.ok(body.input.startsWith('<|startoftext|><|reserved_special_token81|>'));
    assert.ok(body.input.endsWith('BASE'));
    // max_length 被 tier 上限截(300 → 250)
    assert.equal(body.max_length, 250);
    // erato 停止串扩展:\nX: → 加标点变体(12 头 × 原串)
    const stops = body.stop_sequences;
    assert.ok(Array.isArray(stops) && stops.length > 1);
    assert.ok(stops.every(s => Array.isArray(s) && s.length > 0));
    // {driftwood} verbatim 编码 1 条、[11,22] 原样 1 条、
    // saltmark 10 变体去重后 6 条(大小写全同形被 onlyUnique 收掉)
    const bad = body.bad_words_ids;
    assert.ok(bad.some(ids => ids.length === 2 && ids[0] === 11 && ids[1] === 22));
    assert.equal(bad.length, 8);
    // logit_bias → [{bias,sequence,…}] 序列是编码数组
    assert.equal(body.logit_bias_exp.length, 1);
    assert.equal(body.logit_bias_exp[0].bias, -0.5);
    assert.ok(Array.isArray(body.logit_bias_exp[0].sequence));
    assert.equal(body.prefix, 'vanilla');
    assert.deepEqual(body.order, [1, 2, 3]);
    for (const [k, v] of Object.entries(body)) assert.notEqual(v, undefined, k);
});

test('buildNovelDispatchBody:无 encode → 三处 id 数组恒空(前端 NONE 语义)', async () => {
    // model 不含已知家族名 → tokenizerName null → encode null(不触真实加载)
    const body = await buildNovelDispatchBody({
        naiSettings: { model_novel: 'sigurd', prefix: 'vanilla' },
        prompt: 'P', model: 'sigurd', maxLength: 100,
        powerUser: {}, substCtx: SUBST_CTX, instructEngine: null,
    });
    assert.equal(body.stop_sequences, undefined);
    assert.equal(body.bad_words_ids, undefined);
    assert.deepEqual(body.logit_bias_exp, []);
    assert.equal(body.prefix, 'vanilla'); // 老模型恒 vanilla
    assert.equal(body.input, 'P');
});

// ═══════════════════════════ e2e 层 ═══════════════════════════

/** 复用已有 webpack 产物跳过首启编译:scratch 三层 + apps/server/data 两层 */
function findPrebuiltBundles() {
    if (process.env.LUKER_PREBUILT_BUNDLES_DIR) return process.env.LUKER_PREBUILT_BUNDLES_DIR;
    const here = fileURLToPath(new URL('.', import.meta.url));
    // tests/.e2e-scratch/<scenario>/_webpack/<hash>/output(utopinn-generate-e2e 同款)
    const scratch = resolve(here, '.e2e-scratch');
    if (existsSync(scratch)) {
        for (const scenario of readdirSync(scratch)) {
            const webpackDir = resolve(scratch, scenario, '_webpack');
            if (!existsSync(webpackDir)) continue;
            for (const hash of readdirSync(webpackDir)) {
                const out = resolve(webpackDir, hash, 'output');
                if (existsSync(resolve(out, 'lib.core.bundle.js'))) return out;
            }
        }
    }
    // apps/server/data/_webpack/<hash>/output(开发服直跑产物)
    const dataWebpack = resolve(here, '../data/_webpack');
    if (existsSync(dataWebpack)) {
        for (const hash of readdirSync(dataWebpack)) {
            const out = resolve(dataWebpack, hash, 'output');
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
async function postJSON(baseURL, path, session, body) {
    return fetch(`${baseURL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.token, Cookie: session.cookie },
        body: JSON.stringify(body),
    });
}
async function getJSON(baseURL, path, session) {
    return fetch(`${baseURL}${path}`, { headers: { Cookie: session.cookie } });
}

/** 内联 mock 上游:kobold(united+cpp 探测 + generate)+ textgen(generic completions) 合一 */
async function startTextUpstream() {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
            requests.push({ method: req.method, url: req.url, body });
            const json = (obj) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(obj));
            };
            if (req.method === 'GET' && req.url === '/v1/info/version') return json({ result: '1.2.5' });
            if (req.method === 'GET' && req.url === '/extra/version') return json({ result: '1.50' });
            if (req.method === 'POST' && req.url === '/v1/generate') return json({ results: [{ text: KOBOLD_REPLY }] });
            if (req.method === 'POST' && req.url === '/v1/completions') return json({ results: [{ text: TEXTGEN_REPLY }] });
            res.writeHead(404); res.end('mock: unhandled');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, requests, baseURL: `http://127.0.0.1:${server.address().port}` };
}

function patchSettings(dataRoot, patch) {
    const settingsPath = resolve(dataRoot, HANDLE, 'settings.json');
    const s = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    Object.assign(s, patch);
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
}

async function pollJob(baseURL, session, jobId, { tries = 80 } = {}) {
    for (let i = 0; i < tries; i++) {
        const r = await getJSON(baseURL, `/api/utopinn/jobs/${jobId}`, session);
        if (r.ok) {
            const j = await r.json();
            if (j.persisted || j.status === 'failed' || j.status === 'cancelled') return j;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
}

test('/api/utopinn/generate e2e — text/kobold/novel 三分支 + 未知 api 400', async (t) => {
    const upstream = await startTextUpstream();
    const prebuilt = findPrebuiltBundles();
    const server = await startServer({
        batchKey: 'generation',
        scenarioId: 'utopinn-textapi',
        extraEnv: {
            ...(prebuilt ? { LUKER_PREBUILT_BUNDLES_DIR: prebuilt } : {}),
            NO_PROXY: '*', no_proxy: '*',
            HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
        },
    });
    try {
        markOnboarded({ dataRoot: server.dataRoot });
        const avatarFile = writeCharacter({ dataRoot: server.dataRoot });
        const charDir = avatarFile.replace(/\.png$/, '');
        const presetName = writePreset({ dataRoot: server.dataRoot, name: 'utopinn-textapi-preset' });
        patchSettings(server.dataRoot, {
            firstRun: false,
            // kobold:非 gui 预设名走全塑形;sampler/grammar/seed 由 kai_settings 出
            kai_settings: {
                preset_settings: 'e2e-kai',
                api_server: upstream.baseURL,
                streaming_kobold: false,
                temp: 0.7, rep_pen: 1.1, rep_pen_range: 256, rep_pen_slope: 0.9,
                tfs: 0.95, top_k: 40, top_p: 0.9, top_a: 0.1, min_p: 0.05, typical: 0.95,
                mirostat: 2, mirostat_tau: 5, mirostat_eta: 0.1,
                use_default_badwordsids: true, grammar: '', seed: -1,
                sampler_order: [6, 5, 0, 1, 2, 3, 4],
            },
            // novel:模型必备;不种 secret → provider 层缺 key 报错
            nai_settings: {
                model_novel: 'clio-v1', streaming_novel: false,
                prefix: 'vanilla', banned_tokens: '', order: [1, 5, 0, 2, 3, 4],
                temperature: 0.8, min_length: 5,
            },
        });

        const chatsDir = resolve(server.dataRoot, HANDLE, 'chats', charDir);
        mkdirSync(chatsDir, { recursive: true });
        const jsonl = [
            { user_name: 'User', character_name: 'Ash', create_date: Date.now(), chat_metadata: {} },
            { name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: 'What do you read in the reef tonight?' },
        ].map((o) => JSON.stringify(o)).join('\n') + '\n';
        writeFileSync(resolve(chatsDir, `${CHAT}.jsonl`), jsonl);

        const session = await getSession(server.baseURL);

        await t.test('api:bogus → 400 显式拒绝', async () => {
            const res = await postJSON(server.baseURL, '/api/utopinn/generate', session, {
                charDir, chatName: CHAT, presetName, api: 'bogus',
                luker_generation: { job_id: randomUUID() },
            });
            assert.equal(res.status, 400);
            const j = await res.json();
            assert.match(String(j.error ?? ''), /api must be one of/);
        });

        await t.test('api:text → 单串 prompt 上 mock /v1/completions', async () => {
            const jobId = randomUUID();
            const res = await postJSON(server.baseURL, '/api/utopinn/generate', session, {
                charDir, chatName: CHAT, presetName,
                api: 'text', api_type: 'generic', api_server: upstream.baseURL,
                luker_generation: { job_id: jobId },
            });
            assert.equal(res.status, 200, await res.text().catch(() => ''));
            const job = await pollJob(server.baseURL, session, jobId);
            assert.ok(job, 'job reachable');
            assert.ok(job.persisted, `persisted, last=${JSON.stringify(job)}`);
            assert.equal(job.text, TEXTGEN_REPLY);
            const req = upstream.requests.find((r) => r.url === '/v1/completions');
            assert.ok(req, 'mock saw /v1/completions');
            assert.equal(typeof req.body.prompt, 'string');
            assert.match(req.body.prompt, /reef tonight|Ash/); // 服务端组装产物
            assert.equal(req.body.stream, false);
        });

        await t.test('api:kobold → 探测旗标 + 塑形袋上 /v1/generate', async () => {
            const jobId = randomUUID();
            const res = await postJSON(server.baseURL, '/api/utopinn/generate', session, {
                charDir, chatName: CHAT, presetName,
                api: 'kobold',
                luker_generation: { job_id: jobId },
            });
            assert.equal(res.status, 200, await res.text().catch(() => ''));
            const job = await pollJob(server.baseURL, session, jobId);
            assert.ok(job, 'job reachable');
            assert.ok(job.persisted, `persisted, last=${JSON.stringify(job)}`);
            assert.equal(job.text, KOBOLD_REPLY);
            const gen = upstream.requests.find((r) => r.url === '/v1/generate');
            assert.ok(gen, 'mock saw /v1/generate');
            assert.equal(typeof gen.body.prompt, 'string');
            assert.match(gen.body.prompt, /reef tonight|Ash/);
            // gui_settings 同 streaming/can_abort:dispatch 侧开关(provider
            // 据它选白名单块),不进上游体 —— 非 gui 路径由 sampler 键在
            // 场证明(gui 模式 provider 整段跳过 sampler 块)
            assert.equal('gui_settings' in gen.body, false);
            // streaming/can_abort 是 dispatch 侧旗标(provider 消费:URL 分支
            // +abort 钩),不进上游体 —— 非流式由命中 /v1/generate 而非
            // /extra/generate/stream 这一事实钉死
            assert.equal('streaming' in gen.body, false);
            assert.equal(gen.body.rep_pen_slope, 0.9);
            // 探测版 1.2.5/1.50 → 全旗标开:min_p/mirostat/stop_sequence 上行
            assert.equal(gen.body.min_p, 0.05);
            assert.equal(gen.body.mirostat, 2);
            assert.ok(Array.isArray(gen.body.stop_sequence));
            // 探测请求确实走过(服务端 probe,非 body 传入)
            assert.ok(upstream.requests.some((r) => r.url === '/v1/info/version'));
            assert.ok(upstream.requests.some((r) => r.url === '/extra/version'));
        });

        await t.test('api:novel → 路由进 dispatchNovelAI(无 key 报错层)', async () => {
            const jobId = randomUUID();
            const res = await postJSON(server.baseURL, '/api/utopinn/generate', session, {
                charDir, chatName: CHAT, presetName,
                api: 'novel',
                luker_generation: { job_id: jobId, persist_target: { kind: 'none' } },
            });
            assert.equal(res.status, 200, await res.text().catch(() => ''));
            const job = await pollJob(server.baseURL, session, jobId);
            assert.ok(job, 'job reachable');
            assert.equal(job.status, 'failed', JSON.stringify(job));
            // 塑形层已在 dispatch 前把 request.body 改成 novel 形 ——
            // requestMeta.model 落 'clio-v1'(chat 旁落会是 chat 模型/空)
            assert.equal(job.model, 'clio-v1', JSON.stringify(job));
            // runner 对 emit.error 只记事件,job.error 被空产出检查盖成通用串;
            // 更强的路由证据在 request-inspector:provider 专属错误串挂在
            // 本 job 的 inspection 记录上(attach 之前缺 key → fail(400))
            const insp = await getJSON(server.baseURL, '/api/request-inspector/list', session);
            assert.equal(insp.status, 200);
            const list = await insp.json();
            const rec = list.find((e) => e.generationJobId === jobId);
            assert.ok(rec, `inspector record for ${jobId} missing: ${JSON.stringify(list?.slice?.(0, 3))}`);
            assert.match(String(rec.error ?? ''), /NovelAI Access Token is missing/);
        });
    } finally {
        upstream.server.close();
        await tearDownServer(server);
    }
});
