/**
 * TASK-070 —— preset 域 regex 'in_use' 解析(node:test + 实弹 HTTP)。
 *
 * 验收(tasks.json 逐字):
 *   1. 'in_use' 在 TH regex 读写面解析为当前启用预设,不再 400
 *      —— in_use 调用实弹断言非 400 + 指向正确 preset。
 *   2. preset-scope regex 在生成链按 'in_use' 归属过滤命中(七放置位语义不破)
 *      —— preset regex 写→prompt/display 投影断言。
 *
 * 覆盖:
 *   A. resolvePresetInUse 单元面:openai 顶层指针优先/canonical 兜底、
 *      horde→kobold、无 selected/未知 apiId → null。
 *   B. TH getTavernRegexes/replaceTavernRegexes {type:'preset',name:'in_use'}
 *      → 解析 apiId(openai/novel 显式 + 楼层 extra.api 推断)+ 读写落正确档。
 *   C. 生成链:buildGenerationContext prompt 车道 + chats 读面 display 车道
 *      消费「in_use 且 allowlist 放行」的预设脚本;非 in_use / 未放行不进。
 *   D. 多 apiId:mainApi='novel' 时 preset 域解 novel 的 selected(不拿 openai 硬套)。
 *   E. REST:?scope=preset&preset=in_use 别名 + 全量视图 inUse/active 标志。
 *   F. TH formatAsTavernRegexedString:preset 域 in_use+allowlist 口径补齐。
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
import {
    resolvePresetInUse,
    floorApiToPresetApiId,
    chatPresetApiId,
} from '../src/services/extension-prompts.js';

let chatsRouter, applyUtopinnLibrary, applyUtopinnRegex, applyTh;

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(import.meta.dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';
    ({ router: chatsRouter } = await import('../src/endpoints/chats.js'));
    ({ apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js'));
    ({ apply: applyUtopinnRegex } = await import('../src/plugins/utopinn-regex.js'));
    ({ apply: applyTh } = await import('../src/plugins/utopinn-th.js'));
});

const HANDLE = 'u';
const CHAR = 'InUseCard';
const CHAT = 'c1';

const OPENAI_PRESET = 'InUsePreset';
const NOVEL_PRESET = 'NaiPreset';

/** openai prompt 结构档(组装必需;preset 域脚本在 extensions.regex_scripts)。 */
const OAI_DOC = {
    openai_model: 'test-model', openai_max_context: 8192,
    prompts: [
        { identifier: 'main', name: 'Main Prompt', content: 'SYS', role: 'system', system_prompt: true, marker: false },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    extensions: {
        regex_scripts: [
            // 归属探针:openai 预设 in_use 时命中;novel 生成时绝不能命中(防硬套)。
            { id: 'oa1', scriptName: 'oai-probe', findRegex: '<PTAG>', replaceString: 'OAI-WRONG', placement: [2], promptOnly: true, markdownOnly: true },
        ],
    },
};
const NAI_DOC = {
    model: 'nai-model',
    extensions: {
        regex_scripts: [
            { id: 'n1', scriptName: 'nai-probe', findRegex: '<PTAG>', replaceString: 'NAI-ON', placement: [2], promptOnly: true },
            { id: 'n2', scriptName: 'nai-md', findRegex: '<PTAG>', replaceString: 'NAI-DISP', placement: [2], markdownOnly: true },
        ],
    },
};

const CARD = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: CHAR, description: 'd', first_mes: 'hi', extensions: {} },
};

/** 楼层:末楼 depth0 带 <PTAG>;extra.api 记 'chat'(openai 族)。 */
const CHAT_BODY = [
    { is_user: true, name: 'User', send_date: 1, mes: 'hi' },
    { is_user: false, name: CHAR, send_date: 2, mes: 'tail <PTAG>', extra: { api: 'chat' } },
];

function makeTmpDirs() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-thinuse-'));
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

/**
 * 种子:settings(顶层 preset_settings_openai 指针 + oai_settings 镜像
 * + allowlist 可选)+ openai/novel 预设档 + 卡 + 会话。
 */
async function seed(dirs, {
    settings = {},
    chatBody = CHAT_BODY,
    chatName = CHAT,
    oaiDoc = OAI_DOC,
    naiDoc = NAI_DOC,
} = {}) {
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
    await getSettingsRepo().save(HANDLE, {
        power_user: {},
        oai_settings: { preset_settings_openai: OPENAI_PRESET },
        preset_settings_openai: OPENAI_PRESET,
        ...settings,
    });
    if (oaiDoc) await getPresetRepo().save(HANDLE, 'openai', OPENAI_PRESET, oaiDoc);
    if (naiDoc) await getPresetRepo().save(HANDLE, 'novel', NOVEL_PRESET, naiDoc);
    if (chatBody) {
        await getChatRepo().save(HANDLE, CHAR, chatName,
            { user_name: 'User', character_name: CHAR, chat_metadata: {} }, chatBody, null);
    }
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`), JSON.stringify(CARD));
}

function makeApp(dirs) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
        req.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs, canWrite: true };
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
    applyTh(ctx);
    app.use(utopinnRouter);
    return app;
}

async function withServer(app, fn) {
    const srv = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve, reject) => {
            srv.once('listening', resolve);
            srv.once('error', reject);
        });
        const port = srv.address().port;
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => srv.close(resolve));
    }
}

const thCall = async (base, method, args = {}, target = { charDir: CHAR, chatName: CHAT }) => {
    const res = await fetch(`${base}/api/utopinn/th/call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args, target }),
    });
    return { status: res.status, body: await res.json() };
};

const getJson = async (base, url) => {
    const res = await fetch(`${base}${url}`);
    return { status: res.status, json: await res.json() };
};
const putJson = async (base, url, body) => {
    const res = await fetch(`${base}${url}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
};

// ── A. resolvePresetInUse / floor→apiId 单元面 ───────────────────────────

test('resolvePresetInUse: 顶层指针优先/canonical 兜底 + horde→kobold + 空/未知 → null', () => {
    const s = {
        oai_settings: { preset_settings_openai: 'OaiP' },
        preset_settings_openai: 'LegacyOai',          // openai 顶层指针优先(产品选择指针;
        //                                               分叉态顶层=产品面一致的「当前启用」)
        kai_settings: { preset_settings: 'KaiP' },
        nai_settings: { preset_settings_novel: 'NaiP' },
        textgenerationwebui_settings: { preset: 'TgP' },
    };
    assert.deepEqual(resolvePresetInUse(s, 'openai'), { apiId: 'openai', name: 'LegacyOai' });
    // canonical-only 文档(上游导入,无顶层槽)→ oai_settings 内嵌兜底
    assert.deepEqual(resolvePresetInUse({ oai_settings: { preset_settings_openai: 'OaiP' } }, 'openai'), { apiId: 'openai', name: 'OaiP' });
    assert.deepEqual(resolvePresetInUse(s, 'kobold'), { apiId: 'kobold', name: 'KaiP' });
    // horde→kobold(上游 getPresetManager 同映射)
    assert.deepEqual(resolvePresetInUse(s, 'koboldhorde'), { apiId: 'kobold', name: 'KaiP' });
    assert.deepEqual(resolvePresetInUse(s, 'novel'), { apiId: 'novel', name: 'NaiP' });
    assert.deepEqual(resolvePresetInUse(s, 'textgenerationwebui'), { apiId: 'textgenerationwebui', name: 'TgP' });
    // legacy 顶层兜底
    assert.deepEqual(resolvePresetInUse({ preset_settings_openai: 'LegacyOai' }, 'openai'), { apiId: 'openai', name: 'LegacyOai' });
    assert.deepEqual(resolvePresetInUse({ preset_settings: 'LegacyKai' }, 'kobold'), { apiId: 'kobold', name: 'LegacyKai' });
    assert.deepEqual(resolvePresetInUse({ preset_settings_novel: 'LegacyNai' }, 'novel'), { apiId: 'novel', name: 'LegacyNai' });
    // 空 selected / 未知 apiId → null
    assert.equal(resolvePresetInUse({}, 'openai'), null);
    assert.equal(resolvePresetInUse(s, 'mystery'), null);
    assert.equal(resolvePresetInUse({ oai_settings: { preset_settings_openai: '  ' } }, 'openai'), null);
});

test('floorApiToPresetApiId / chatPresetApiId: extra.api → preset 族 apiId', () => {
    assert.equal(floorApiToPresetApiId('chat'), 'openai');
    assert.equal(floorApiToPresetApiId('deepseek'), 'openai');      // chat-completion source 全归 openai 族
    assert.equal(floorApiToPresetApiId('text'), 'textgenerationwebui');
    assert.equal(floorApiToPresetApiId('kobold'), 'kobold');
    assert.equal(floorApiToPresetApiId('koboldhorde'), 'kobold');
    assert.equal(floorApiToPresetApiId('novel'), 'novel');
    // 从尾取首个带 extra.api 的楼;无记录 → 'openai'
    const body = [
        { mes: 'a', extra: { api: 'novel' } },
        { mes: 'b' },
        { mes: 'c', extra: { api: 'text' } },
    ];
    assert.equal(chatPresetApiId(body), 'textgenerationwebui');
    assert.equal(chatPresetApiId([{ mes: 'x' }]), 'openai');
    assert.equal(chatPresetApiId([]), 'openai');
});

// ── B. TH 'in_use' 读写面实弹 ────────────────────────────────────────────

test("TH getTavernRegexes name='in_use' → 解 openai selected,非 400,指向正确", async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, {
            settings: { nai_settings: { preset_settings_novel: NOVEL_PRESET } },
        });
        const app = makeApp(dirs);
        await withServer(app, async (base) => {
            const r = await thCall(base, 'getTavernRegexes', { type: 'preset', name: 'in_use' });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(r.body.ok, true);
            assert.deepEqual(r.body.resolved, { apiId: 'openai', name: OPENAI_PRESET });
            // TavernRegex 视图(script_name/enabled 等)
            assert.equal(r.body.result.length, 1);
            assert.equal(r.body.result[0].script_name, 'oai-probe');
            assert.equal(r.body.result[0].enabled, true);
            assert.deepEqual(r.body.result[0].destination, { display: true, prompt: true });

            // 显式 api_id=novel → 解 novel selected
            const rn = await thCall(base, 'getTavernRegexes',
                { type: 'preset', name: 'in_use', api_id: 'novel' });
            assert.equal(rn.status, 200, JSON.stringify(rn.body));
            assert.deepEqual(rn.body.resolved, { apiId: 'novel', name: NOVEL_PRESET });
            assert.equal(rn.body.result.length, 2);

            // 具体预设名仍是合法旧路(回归)
            const rx = await thCall(base, 'getTavernRegexes',
                { type: 'preset', name: OPENAI_PRESET, api_id: 'openai' });
            assert.equal(rx.status, 200);
            assert.equal(rx.body.result[0].script_name, 'oai-probe');
        });
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("TH 'in_use':楼层 extra.api 推断 apiId;无 selected → 400 诚实错", async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, {
            settings: { nai_settings: { preset_settings_novel: NOVEL_PRESET } },
            chatBody: [
                { is_user: false, name: CHAR, send_date: 1, mes: 'm', extra: { api: 'novel' } },
            ],
        });
        const app = makeApp(dirs);
        await withServer(app, async (base) => {
            // 会话最近生成 api=novel → 'in_use' 解 novel selected(不拿 openai 硬套)
            const r = await thCall(base, 'getTavernRegexes', { type: 'preset', name: 'in_use' });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.deepEqual(r.body.resolved, { apiId: 'novel', name: NOVEL_PRESET });

            // apiId 无 selected → 诚实 400(非静默空)
            const r2 = await thCall(base, 'getTavernRegexes',
                { type: 'preset', name: 'in_use', api_id: 'textgenerationwebui' });
            assert.equal(r2.status, 400);
            assert.equal(r2.body.ok, false);
            assert.match(String(r2.body.error), /in_use/);
        });
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("TH replaceTavernRegexes name='in_use' → 写进实解预设档,读回一致", async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs);
        const app = makeApp(dirs);
        const NEW = [{
            script_name: 'wrote-via-in_use', enabled: true,
            find_regex: '/<P>/g', replace_string: 'W',
            source: { ai_output: true }, destination: { prompt: true },
        }];
        await withServer(app, async (base) => {
            const r = await thCall(base, 'replaceTavernRegexes',
                { type: 'preset', name: 'in_use', regexes: NEW });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(r.body.ok, true);
        });
        // 落库位 = openai/OPENAI_PRESET 的 extensions.regex_scripts
        const doc = await getPresetRepo().get(HANDLE, 'openai', OPENAI_PRESET);
        assert.equal(doc.extensions.regex_scripts.length, 1);
        assert.equal(doc.extensions.regex_scripts[0].scriptName, 'wrote-via-in_use');
        assert.equal(doc.extensions.regex_scripts[0].promptOnly, true);
        // 读回同一份
        await withServer(app, async (base) => {
            const r = await thCall(base, 'getTavernRegexes', { type: 'preset', name: 'in_use' });
            assert.equal(r.status, 200);
            assert.equal(r.body.result[0].script_name, 'wrote-via-in_use');
        });
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// ── C. 生成链:in_use + allowlist 双闸,prompt/display 双投影 ──────────────

test('prompt 车道:in_use+allowed 的 preset 脚本命中;disallowed/非 in_use 不进', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, {
            settings: {
                extension_settings: { preset_allowed_regex: { openai: [OPENAI_PRESET] } },
            },
        });
        const request = { user: { profile: { handle: HANDLE, name: 'User' }, directories: dirs } };
        const { request: asmReq } = await buildGenerationContext({
            request, charDir: CHAR, chatName: CHAT, card: CARD,
            user: { name: 'User' },
        });
        const tail = asmReq.chat[asmReq.chat.length - 1];
        assert.equal(tail.mes, 'tail OAI-WRONG', 'in_use+allowed preset promptOnly 命中 prompt 车道');

        // 闸关掉:preset_allowed_regex 空 → 同预设脚本不进(放行是第二道闸)
        await seed(dirs, { settings: { extension_settings: {} } });
        const { request: asmReq2 } = await buildGenerationContext({
            request, charDir: CHAR, chatName: CHAT, card: CARD,
            user: { name: 'User' },
        });
        const tail2 = asmReq2.chat[asmReq2.chat.length - 1];
        assert.equal(tail2.mes, 'tail <PTAG>', '未放行的 in_use 预设脚本不进链');

        // 非 in_use 预设(同名 allowlisted 但不是 selected)不进:
        // selected 指 'Other',allowlist 同时放 Other+InUsePreset —— 只消费 Other 的脚本。
        await getPresetRepo().save(HANDLE, 'openai', 'Other', {
            ...OAI_DOC,
            extensions: {
                regex_scripts: [
                    { id: 'o2', scriptName: 'other-probe', findRegex: '<PTAG>', replaceString: 'OTHER-ON', placement: [2], promptOnly: true },
                ],
            },
        });
        await seed(dirs, {
            chatBody: null,
            settings: {
                oai_settings: { preset_settings_openai: 'Other' },
                preset_settings_openai: 'Other',
                extension_settings: { preset_allowed_regex: { openai: ['Other', OPENAI_PRESET] } },
            },
        });
        const { request: asmReq3 } = await buildGenerationContext({
            request, charDir: CHAR, chatName: CHAT, card: CARD,
            user: { name: 'User' },
        });
        const tail3 = asmReq3.chat[asmReq3.chat.length - 1];
        assert.equal(tail3.mes, 'tail OTHER-ON', '只消费 in_use(Other)预设的脚本,非 in_use 的 InUsePreset 不进');
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('display 车道(GET chats):in_use+allowed 的 preset 脚本投影 mes_display', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, {
            settings: {
                extension_settings: { preset_allowed_regex: { openai: [OPENAI_PRESET] } },
            },
        });
        const app = makeApp(dirs);
        await withServer(app, async (base) => {
            const lib = await getJson(base, `/api/utopinn/characters/${CHAR}/chats/${CHAT}`);
            assert.equal(lib.status, 200);
            const tail = lib.json.messages[lib.json.messages.length - 1];
            assert.equal(tail.mes_display, 'tail OAI-WRONG', 'markdownOnly 预设脚本投影进 display 车道');
            assert.equal(tail.mes, 'tail <PTAG>', '存储原文不被投影污染');
        });
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test("多 apiId:mainApi='novel' 时 preset 域解 novel selected(openai 不硬套)", async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, {
            settings: {
                nai_settings: { preset_settings_novel: NOVEL_PRESET },
                extension_settings: {
                    preset_allowed_regex: { novel: [NOVEL_PRESET], openai: [OPENAI_PRESET] },
                },
            },
        });
        const request = { user: { profile: { handle: HANDLE, name: 'User' }, directories: dirs } };
        const { request: asmReq } = await buildGenerationContext({
            request, charDir: CHAR, chatName: CHAT, card: CARD,
            user: { name: 'User' }, mainApi: 'novel',
        });
        const tail = asmReq.chat[asmReq.chat.length - 1];
        // novel 派发时 in_use = novel/NaiPreset;n1 promptOnly 命中,
        // openai 预设脚本(同 allowlisted)绝不能进 —— 不拿 openai 硬套。
        assert.equal(tail.mes, 'tail NAI-ON');
        assert.ok(!tail.mes.includes('OAI-WRONG'), 'openai in_use 预设不得进 novel 生成链');
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// ── D. REST in_use 别名 + inUse/active 标志 ──────────────────────────────

test('REST:?scope=preset&preset=in_use 别名实解 + 全量视图 inUse/active', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, {
            settings: {
                extension_settings: { preset_allowed_regex: { openai: [OPENAI_PRESET] } },
            },
        });
        const app = makeApp(dirs);
        await withServer(app, async (base) => {
            const r = await getJson(base, `/api/utopinn/regex?scope=preset&apiId=openai&preset=in_use`);
            assert.equal(r.status, 200, JSON.stringify(r.json));
            assert.equal(r.json.name, OPENAI_PRESET);
            assert.equal(r.json.inUse, true);
            assert.equal(r.json.allowed, true);
            assert.equal(r.json.active, true);
            assert.equal(r.json.scripts.length, 1);

            const full = await getJson(base, `/api/utopinn/regex`);
            const grp = full.json.presets.find((p) => p.apiId === 'openai' && p.name === OPENAI_PRESET);
            assert.ok(grp, 'in_use 预设组必须在全量视图');
            assert.equal(grp.inUse, true);
            assert.equal(grp.active, true);
            assert.equal(full.json.inUse.openai, OPENAI_PRESET);

            // PUT allow 经 in_use 别名(不具名即可关闸)
            const off = await putJson(base, `/api/utopinn/regex`,
                { scope: 'preset', apiId: 'openai', preset: 'in_use', allow: false });
            assert.equal(off.status, 200, JSON.stringify(off.json));
            assert.equal(off.json.allow, false);
            const r2 = await getJson(base, `/api/utopinn/regex?scope=preset&preset=in_use`);
            assert.equal(r2.json.allowed, false);
            assert.equal(r2.json.inUse, true);
            assert.equal(r2.json.active, false, 'in_use 但未放行 → 不进链');
        });
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// ── E. TH formatAsTavernRegexedString:preset 域 in_use+allowlist ─────────

test('TH formatAs:in_use+allowed 的 preset 脚本进 formatAs 收集面', async () => {
    const { tmpDir, dirs } = makeTmpDirs();
    try {
        await seed(dirs, {
            settings: {
                extension_settings: { preset_allowed_regex: { openai: [OPENAI_PRESET] } },
            },
        });
        const app = makeApp(dirs);
        await withServer(app, async (base) => {
            const r = await thCall(base, 'formatAsTavernRegexedString', {
                text: 'x <PTAG> y', source: 'ai_output', destination: 'prompt',
            });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(r.body.result, 'x OAI-WRONG y');

            const rd = await thCall(base, 'formatAsTavernRegexedString', {
                text: 'x <PTAG> y', source: 'ai_output', destination: 'display',
            });
            assert.equal(rd.body.result, 'x OAI-WRONG y');
        });

        // 未放行 → formatAs 不入 preset 域(只过 global/char 口径)
        await seed(dirs, { settings: { extension_settings: {} } });
        await withServer(app, async (base) => {
            const r = await thCall(base, 'formatAsTavernRegexedString', {
                text: 'x <PTAG> y', source: 'ai_output', destination: 'prompt',
            });
            assert.equal(r.body.result, 'x <PTAG> y');
        });
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});
