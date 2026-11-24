/**
 * embedded-world 首见自愈 —— loadCharacterDocMerged 读面物化 + 绑定写回
 * (node:test + express 直挂,与 shared-library/utopinn-library 测试同型)。
 *
 * 背景:种子卡(seedContent fs cpSync)、LAN 迁移、sync 落盘、手工丢进
 * characters/ 的卡都不走 commitCharacter —— 卡带 character_book 但
 * extensions.world 缺绑,worlds/ 下也没有物化文件。生成装配层靠
 * primaryWorldName + 内存即时转换兜底,但 LorePanel(getCharacter→
 * extensions.world→getWorld)与 CardApp getWorldBooks 枚举看不到书。
 *
 * 覆盖:
 *   1. 私有 PNG 卡首读自愈:返回卡带绑定、PNG 写回、worlds/<派生名> 物化;
 *      二读不重复动作(已绑早退)。
 *   2. HTTP 面同源:GET /characters/:charDir 回报 extensions.world;
 *      GET /worlds/<派生名> 直接命中物化文件(不走 ?char= 回落)。
 *   3. .json 卡:绑定写回 JSON 文件。
 *   4. 已绑卡不自愈:绑到不存在书名也不复活文件(用户删书是意图)。
 *   5. 撞名不覆盖:既有同名书在库 → 绑它、物化 skipped、doc 原样。
 *   6. 共享池卡:物化进本用户世界库 + 返回卡内存态绑定;池文件字节不动。
 *   7. 无双注:自愈后生成 WI 扫描供给一次(物化文件赢,内存兜底不叠加)。
 *   8. read-only 模式:跳过一切写,仅内存绑定,不抛。
 * 跑法:node --test tests/embedded-world-heal.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { readCardFromPng, writeCardToPng } from '@utopinn/formats';
import { getConfigFilePath, setConfigFilePath, reloadConfigCache } from '../src/util.js';
import {
    getChatRepo,
    getPresetRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    initStorage,
} from '../src/storage/index.js';
import { setReadOnly } from '../src/storage/read-only-mode.js';

// 插件传递依赖(secrets.js 等)模块级读 config —— 动态 import 等 config 就绪。
let applyUtopinnLibrary;
let loadCharacterDocMerged;
let buildGenerationContext;

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(import.meta.dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';
    ({ apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js'));
    ({ loadCharacterDocMerged } = await import('../src/services/shared-library.js'));
    ({ buildGenerationContext } = await import('../src/services/generate-context.js'));
});

const HANDLE = 'u';
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

/** 带 1 条内嵌书的 v2 卡;extensions 无 world 绑定。 */
const EMBED_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: 'Seedling', description: 'factory seeded card', first_mes: 'hi',
        character_book: {
            name: 'SeedCodex',
            entries: [{ keys: ['dragonlore'], content: 'EMBEDDED_LORE_SIGNAL', enabled: true, insertion_order: 0 }],
        },
        extensions: {},
    },
};
const EMBED_DERIVED = 'SeedCodex';

function makeTmpDirs() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-embheal-'));
    const dataRoot = path.join(tmpDir, 'dataRoot');
    const userRoot = path.join(dataRoot, HANDLE);
    const dirs = {
        root: userRoot,
        characters: path.join(userRoot, 'characters'),
        chats: path.join(userRoot, 'chats'),
        worlds: path.join(userRoot, 'worlds'),
        groups: path.join(userRoot, 'groups'),
        cardApps: path.join(userRoot, 'card_apps'),
        openAI_Settings: path.join(userRoot, 'OpenAI Settings'),
        context: path.join(userRoot, 'context'),
        instruct: path.join(userRoot, 'instruct'),
        sysprompt: path.join(userRoot, 'sysprompt'),
        reasoning: path.join(userRoot, 'reasoning'),
        koboldAI_Settings: path.join(userRoot, 'KoboldAI Settings'),
        novelAI_Settings: path.join(userRoot, 'NovelAI Settings'),
        textGen_Settings: path.join(userRoot, 'TextGen Settings'),
    };
    for (const d of [dirs.characters, dirs.chats, dirs.worlds]) fs.mkdirSync(d, { recursive: true });
    const libDir = path.join(dataRoot, '_library', 'characters');
    fs.mkdirSync(libDir, { recursive: true });
    return { tmpDir, dataRoot, dirs, libDir };
}

function writePngCard(dir, stem, card) {
    fs.writeFileSync(path.join(dir, `${stem}.png`), Buffer.from(writeCardToPng(new Uint8Array(PNG_1PX), JSON.stringify(card))));
}
function writeJsonCard(dir, stem, card) {
    fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(card));
}

function makeApp(dirs) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
        req.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs, canWrite: true };
        next();
    });
    const utopinnRouter = express.Router();
    const ws = { register: (spec) => { utopinnRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler); return () => {}; } };
    applyUtopinnLibrary({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });
    app.use(utopinnRouter);
    return app;
}

async function callJson(app, method, url, body) {
    const srv = app.listen(0);
    try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    } finally { srv.close(); }
}
const getJson = (app, url) => callJson(app, 'GET', url);

async function withEnv(fn) {
    const { tmpDir, dataRoot, dirs, libDir } = makeTmpDirs();
    globalThis.DATA_ROOT = dataRoot;
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        await fn({ dataRoot, dirs, libDir, app: makeApp(dirs) });
    } finally {
        delete globalThis.DATA_ROOT;
        setReadOnly(false);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ---------- 1. 私有 PNG 卡:首读自愈全链 ----------

test('私有 PNG 卡首读:物化 worlds/<派生名> + 绑定写回卡面 + 返回卡已绑', async () => {
    await withEnv(async ({ dirs }) => {
        writePngCard(dirs.characters, 'Seedling', EMBED_CARD);
        const pngPath = path.join(dirs.characters, 'Seedling.png');

        const first = await loadCharacterDocMerged(dirs, 'Seedling');
        assert.equal(first.card.data.extensions.world, EMBED_DERIVED,
            '返回卡内存态恒带生效绑定(读面/extensions.world 枚举同口径)');

        // 物化落盘:派生名(character_book.name)在库、内容是转换后的 world doc。
        const doc = await getWorldInfoRepo().get(HANDLE, EMBED_DERIVED);
        assert.ok(doc?.doc?.entries ?? doc?.entries, '物化文件应在世界书库');
        const entries = Object.values((doc.doc ?? doc).entries);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].content, 'EMBEDDED_LORE_SIGNAL');

        // 绑定写回 PNG:tEXt 重读卡面 extensions.world 已绑。
        const stored = JSON.parse(readCardFromPng(fs.readFileSync(pngPath)));
        assert.equal(stored.data.extensions.world, EMBED_DERIVED, '卡文件应写回 extensions.world');
        assert.equal(stored.data.character_book.entries.length, 1,
            '内嵌书保留在卡面(导出兼容语义,不靠删除防双注)');

        // 二读:已绑 → 零动作(物化 skipped 早退由 gate 吃掉,不重复写)。
        const mtime = fs.statSync(pngPath).mtimeMs;
        const second = await loadCharacterDocMerged(dirs, 'Seedling');
        assert.equal(second.card.data.extensions.world, EMBED_DERIVED);
        assert.equal(fs.statSync(pngPath).mtimeMs, mtime, '已绑卡不再重写文件');
    });
});

// ---------- 2. HTTP 面:LorePanel/getWorldBooks 数据源就位 ----------

test('GET /characters/:charDir 回报 extensions.world;GET /worlds/:name 直接命中', async () => {
    await withEnv(async ({ dirs, app }) => {
        writePngCard(dirs.characters, 'Seedling', EMBED_CARD);

        const card = await getJson(app, '/api/utopinn/characters/Seedling');
        assert.equal(card.status, 200);
        assert.equal(card.json.data.extensions.world, EMBED_DERIVED,
            'LorePanel 的 getCharacter→extensions.world 链路必须见绑定');

        // 直接命中物化文件 —— 不走 ?char= 回落(回执无 embedded:true 标)。
        const world = await getJson(app, `/api/utopinn/worlds/${encodeURIComponent(EMBED_DERIVED)}`);
        assert.equal(world.status, 200);
        assert.equal(world.json.name, EMBED_DERIVED);
        assert.equal(world.json.embedded, undefined, '命中物化文件,不是 embedded 回落');
        assert.equal(Object.keys(world.json.doc.entries).length, 1);

        // 列表面:物化书出现在用户世界书清单。
        const list = await getJson(app, '/api/utopinn/worlds');
        assert.ok(list.json.items.some((i) => i.name === EMBED_DERIVED));
    });
});

// ---------- 3. .json 卡写回 ----------

test('.json 卡:绑定写回 JSON 文件', async () => {
    await withEnv(async ({ dirs }) => {
        writeJsonCard(dirs.characters, 'JSeed', EMBED_CARD);
        const { card } = await loadCharacterDocMerged(dirs, 'JSeed');
        assert.equal(card.data.extensions.world, EMBED_DERIVED);
        const stored = JSON.parse(fs.readFileSync(path.join(dirs.characters, 'JSeed.json'), 'utf8'));
        assert.equal(stored.data.extensions.world, EMBED_DERIVED);
    });
});

// ---------- 4. 已绑卡:不自愈、不复活 ----------

test('已绑卡不自愈:绑到缺席书名也不复活文件(用户删书是意图)', async () => {
    await withEnv(async ({ dirs }) => {
        const bound = JSON.parse(JSON.stringify(EMBED_CARD));
        bound.data.extensions.world = 'ExternalBook';
        writeJsonCard(dirs.characters, 'Bound', bound);

        const { card } = await loadCharacterDocMerged(dirs, 'Bound');
        assert.equal(card.data.extensions.world, 'ExternalBook', '既有绑定原样');
        assert.equal(await getWorldInfoRepo().resolveName(HANDLE, 'ExternalBook'), null,
            '绑定的缺席书不该被自愈复活');
        assert.equal(await getWorldInfoRepo().resolveName(HANDLE, EMBED_DERIVED), null,
            '派生名也不该被物化(自愈门 = 缺绑才开)');
    });
});

// ---------- 5. 撞名不覆盖 ----------

test('派生名撞既有书:绑到既有书、物化 skipped、doc 不被覆盖', async () => {
    await withEnv(async ({ dirs }) => {
        await getWorldInfoRepo().save(HANDLE, EMBED_DERIVED, {
            entries: { '0': { uid: 0, key: ['existing'], content: 'PREEXISTING_BOOK_MARK', order: 1, position: 0 } },
        });
        writePngCard(dirs.characters, 'Seedling', EMBED_CARD);

        const { card } = await loadCharacterDocMerged(dirs, 'Seedling');
        assert.equal(card.data.extensions.world, EMBED_DERIVED);
        const doc = await getWorldInfoRepo().get(HANDLE, EMBED_DERIVED);
        const entries = Object.values((doc.doc ?? doc).entries);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].content, 'PREEXISTING_BOOK_MARK',
            '读路径自愈不覆盖用户既有书(与导入 createIfAbsent 同语义)');
    });
});

// ---------- 6. 共享池卡:物化进用户库 + 内存绑定;池档字节不动 ----------

test('共享池卡:物化进本用户世界库 + 返回卡已绑;池文件不写回', async () => {
    await withEnv(async ({ dirs, libDir }) => {
        writePngCard(libDir, 'PoolSeed', EMBED_CARD);
        const poolPath = path.join(libDir, 'PoolSeed.png');
        const before = fs.readFileSync(poolPath);

        const first = await loadCharacterDocMerged(dirs, 'PoolSeed');
        assert.equal(first.shared, true);
        assert.equal(first.card.data.extensions.world, EMBED_DERIVED,
            '共享卡内存态绑定(读面/extensions.world 枚举同口径)');
        assert.deepEqual(fs.readFileSync(poolPath), before, '共享池文件只读,绝不写回');

        const doc = await getWorldInfoRepo().get(HANDLE, EMBED_DERIVED);
        assert.ok(doc, '物化书应落进本用户世界库');
        assert.equal(Object.values((doc.doc ?? doc).entries)[0].content, 'EMBEDDED_LORE_SIGNAL');
    });
});

// ---------- 7. 无双注:绑定 + 物化后 WI 只供给一次 ----------

test('无双注:自愈后生成,WORLD 文件供给一次(内存兜底不叠加)', async () => {
    await withEnv(async ({ dirs }) => {
        writePngCard(dirs.characters, 'Seedling', EMBED_CARD);
        await getSettingsRepo().save(HANDLE, {
            power_user: {},
            world_info_settings: { world_info_depth: 2, world_info_budget: 100, world_info: {} },
            preset_settings_openai: 'Default',
        });
        await getPresetRepo().save(HANDLE, 'openai', 'Default', {
            openai_model: 'gpt-test', openai_max_context: 8192, openai_max_tokens: 200,
            prompts: [
                { identifier: 'main', role: 'system', content: 'You are {{char}}.' },
                { identifier: 'worldInfoBefore', role: 'system', marker: true, content: '' },
                { identifier: 'chatHistory', role: 'system', marker: true, content: '' },
            ],
            prompt_order: [{ character_id: 100001, order: ['main', 'worldInfoBefore', 'chatHistory'].map((identifier) => ({ identifier, enabled: true })) }],
        });
        await getChatRepo().save(HANDLE, 'Seedling', 'c1',
            { user_name: 'User', chat_metadata: {} },
            [{ is_user: true, name: 'User', mes: 'tell me dragonlore' }],
            null);

        // 首读触发自愈(等价于 generate 前的卡加载)。
        const { card } = await loadCharacterDocMerged(dirs, 'Seedling');
        const { builtPrompt, sources } = await buildGenerationContext({
            request: { user: { profile: { handle: HANDLE, name: 'User' } } },
            charDir: 'Seedling', chatName: 'c1', card, user: { name: 'User' },
        });
        const text = builtPrompt.messages.map((m) => String(m.content)).join('\n');
        const hits = text.split('EMBEDDED_LORE_SIGNAL').length - 1;
        assert.equal(hits, 1, `内嵌条目应恰好注入一次,实际 ${hits} 次`);
        assert.equal(sources.worldInfoActivated, 1, 'WI 激活计数 = 物化文件的 1 条,无双份');
    });
});

// ---------- 8. read-only 模式:仅内存绑定,不抛不写 ----------

test('read-only 存储模式:跳过一切写,仅内存绑定,不抛', async () => {
    await withEnv(async ({ dirs }) => {
        writePngCard(dirs.characters, 'Seedling', EMBED_CARD);
        const pngPath = path.join(dirs.characters, 'Seedling.png');
        const before = fs.readFileSync(pngPath);
        setReadOnly(true);

        const { card } = await loadCharacterDocMerged(dirs, 'Seedling');
        assert.equal(card.data.extensions.world, EMBED_DERIVED, '内存绑定仍成立(读面口径)');
        assert.deepEqual(fs.readFileSync(pngPath), before, 'read-only 不写卡文件');
        assert.equal(await getWorldInfoRepo().resolveName(HANDLE, EMBED_DERIVED), null,
            'read-only 不物化');
    });
});
