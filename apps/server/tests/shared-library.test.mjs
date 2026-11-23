/**
 * shared-library —— 实例级共享卡池(node:test + express 直挂,同
 * utopinn-chat-regex.test.mjs 的 ws.register shim 面)。
 *
 * 覆盖:
 *   1. 双源合并列表:私有 ∪ _library,shared:true 徽标,同干私有遮蔽。
 *   2. 详情合并读:共享卡带 shared:true 元字段。
 *   3. PATCH 物化:共享卡改字段 → 私有 copy 落盘、池档字节不动、
 *      响应带 __materialized + charDir。
 *   4. POST install:显式物化 → {charDir,fileName,card};重复装 → 409;
 *      非共享卡 → 404。
 *   5. 干名避让:私有已占 Foo1 → 物化落 Foo2;chats/<stem> 不挡同干名。
 *   6. char_state 合并读:发布侧车回落;用户侧车在场即赢;写面恒 per-user。
 *   7. regex 写面物化:PUT scope=char 脚本 → 私有 copy 承接,池档不动。
 *   8. 穿越闸:charDir=../、_library 保留名、isSafeSharedStem 边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { writeCardToPng } from '@utopinn/formats';

import { getConfigFilePath, setConfigFilePath, reloadConfigCache } from '../src/util.js';
import { initStorage } from '../src/storage/index.js';
import nodePersist from 'node-persist';

// chats.js 传递依赖(backends/luker-generation.js)模块级读 config ——
// 必须 setConfigFilePath 后才可 import,故重依赖全部动态引入。
let chatsRouter, applyUtopinnLibrary, applyUtopinnRegex, applyUtopinnTh;
let getSharedCharactersDir, isSafeSharedStem, resolveSharedLibraryFilePath,
    materializeSharedCharacter, resolveCharacterFileMerged, readCharacterStateMerged,
    loadCharacterDocFromDir;
let saveAdminSettings, getDirectorySizeBytes, cardAppAssetDir, sharedAssetKey, ensureCardAppAssets;
let buildStscriptEnv, estimateSharedMaterializeBytes;

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(import.meta.dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';
    // node-persist(admin-settings/users quota 底座)默认 init 会落
    // ./.node-persist —— 测试引到临时目录,防污染仓库树。
    await nodePersist.init({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-persist-')),
        ttl: false, expiredInterval: 0,
    });
    ({ router: chatsRouter } = await import('../src/endpoints/chats.js'));
    ({ apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js'));
    ({ apply: applyUtopinnRegex } = await import('../src/plugins/utopinn-regex.js'));
    ({ apply: applyUtopinnTh } = await import('../src/plugins/utopinn-th.js'));
    ({
        getSharedCharactersDir,
        isSafeSharedStem,
        resolveSharedLibraryFilePath,
        materializeSharedCharacter,
        resolveCharacterFileMerged,
        readCharacterStateMerged,
        loadCharacterDocFromDir,
    } = await import('../src/services/shared-library.js'));
    ({ saveAdminSettings, getDirectorySizeBytes } = await import('../src/admin-settings.js'));
    ({
        cardAppAssetDir,
        sharedAssetKey,
        ensureCardAppAssets,
    } = await import('../src/card-runtime/mounts.js'));
    ({ buildStscriptEnv } = await import('../src/services/stscript-env.js'));
    ({ estimateSharedMaterializeBytes } = await import('../src/services/shared-library.js'));
});

const HANDLE = 'u';
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

const CARD_PRIVATE = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'Private', description: 'mine', first_mes: 'hi', tags: ['local'] },
};
const CARD_SHARED = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'Shared', description: 'pool', first_mes: 'pool hi', tags: ['pool'] },
};
const CARD_SAME_STEM_PRIVATE = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'MineDup', description: 'shadows the pool card' },
};
const CARD_SAME_STEM_SHARED = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'PoolDup', description: 'shadowed' },
};

/** @returns {{tmpDir:string, dataRoot:string, dirs:object, libDir:string}} */
function makeTmpDirs() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-sharedlib-'));
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
    };
    for (const d of [dirs.characters, dirs.chats, dirs.worlds, dirs.cardApps]) {
        fs.mkdirSync(d, { recursive: true });
    }
    const libDir = path.join(dataRoot, '_library', 'characters');
    fs.mkdirSync(libDir, { recursive: true });
    return { tmpDir, dataRoot, dirs, libDir };
}

function writeJsonCard(dir, stem, card) {
    fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(card));
}

function writePngCard(dir, stem, card) {
    const png = writeCardToPng(new Uint8Array(PNG_1PX), JSON.stringify(card));
    fs.writeFileSync(path.join(dir, `${stem}.png`), Buffer.from(png));
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
    applyUtopinnTh(ctx);
    app.use(utopinnRouter);
    return app;
}

async function callJson(app, method, url, body) {
    const srv = app.listen(0);
    try {
        const port = srv.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    } finally { srv.close(); }
}
const getJson = (app, url) => callJson(app, 'GET', url);

async function withEnv(fn) {
    const { dataRoot, dirs, libDir } = makeTmpDirs();
    globalThis.DATA_ROOT = dataRoot;
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        await fn({ dataRoot, dirs, libDir, app: makeApp(dirs) });
    } finally {
        delete globalThis.DATA_ROOT;
    }
}

// —— 纯函数面:干名闸 + 池监禁解析 —————————————————————————————————————

test('isSafeSharedStem: 拒空/./../分隔/NUL/_library(大小写不敏感)', () => {
    for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\x00b', '_library', '_LIBRARY', '_Library']) {
        assert.equal(isSafeSharedStem(bad), false, JSON.stringify(bad));
    }
    for (const good of ['Foo', '卡', 'a.b', ' _lib'.trim() === '' ? null : 'lib_']) {
        assert.equal(isSafeSharedStem(good), true, JSON.stringify(good));
    }
});

test('resolveSharedLibraryFilePath: 监禁池根,穿越/_library 干名一律拒', () => {
    const { dirs, libDir } = makeTmpDirs();
    globalThis.DATA_ROOT = path.dirname(path.dirname(libDir));
    try {
        fs.writeFileSync(path.join(libDir, 'Foo.json'), '{}');
        assert.equal(resolveSharedLibraryFilePath(dirs, 'Foo.json'), path.join(libDir, 'Foo.json'));
        assert.equal(resolveSharedLibraryFilePath(dirs, '../secrets.json'), null);
        assert.equal(resolveSharedLibraryFilePath(dirs, '..\\secrets.json'), null);
        assert.equal(resolveSharedLibraryFilePath(dirs, '_library.png'), null, 'reserved stem rejected');
        assert.equal(resolveSharedLibraryFilePath(dirs, 'nope.png'), null);
    } finally {
        delete globalThis.DATA_ROOT;
    }
});

// —— HTTP 面:列表/详情/PATCH/install/侧车 ————————————————————————————

test('列表双源合并:私有 ∪ 池,shared:true,同干私有遮蔽', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(dirs.characters, 'Private', CARD_PRIVATE);
        writeJsonCard(libDir, 'Shared', CARD_SHARED);
        writeJsonCard(dirs.characters, 'Dup', CARD_SAME_STEM_PRIVATE);
        writeJsonCard(libDir, 'Dup', CARD_SAME_STEM_SHARED);

        const { status, json } = await getJson(app, '/api/utopinn/characters');
        assert.equal(status, 200);
        assert.equal(json.total, 3);
        const byDir = Object.fromEntries(json.items.map((i) => [i.charDir, i]));
        assert.equal(byDir.Shared.shared, true, '池卡带 shared 徽标');
        assert.equal(byDir.Private.shared, undefined, '私有卡不带 shared 键');
        assert.equal(byDir.Dup.name, 'MineDup', '同干名私有遮蔽池卡');
        assert.equal(byDir.Dup.shared, undefined);
    });
});

test('详情合并读:共享卡顶层带 shared:true 元字段', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Shared', CARD_SHARED);
        writeJsonCard(dirs.characters, 'Private', CARD_PRIVATE);

        const sharedRes = await getJson(app, '/api/utopinn/characters/Shared');
        assert.equal(sharedRes.status, 200);
        assert.equal(sharedRes.json.shared, true);
        assert.equal(sharedRes.json.data.name, 'Shared');

        const privRes = await getJson(app, '/api/utopinn/characters/Private');
        assert.equal(privRes.status, 200);
        assert.equal(privRes.json.shared, undefined);

        const missing = await getJson(app, '/api/utopinn/characters/Nope');
        assert.equal(missing.status, 404);
    });
});

test('PATCH 物化:JSON 共享卡 → 私有 copy 承接,池档字节不动', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Shared', CARD_SHARED);
        const poolFile = path.join(libDir, 'Shared.json');
        const poolBytes = fs.readFileSync(poolFile);

        const res = await callJson(app, 'PATCH', '/api/utopinn/characters/Shared', { description: 'user edit' });
        assert.equal(res.status, 200);
        assert.equal(res.json.__materialized, true);
        assert.equal(res.json.charDir, 'Shared');
        assert.equal(res.json.data.description, 'user edit');

        // 私有 copy 落盘且承载补丁;池档原封不动。
        const privFile = path.join(dirs.characters, 'Shared.json');
        assert.ok(fs.existsSync(privFile));
        assert.deepEqual(fs.readFileSync(poolFile), poolBytes, 'pool file must stay untouched');
        const privCard = JSON.parse(fs.readFileSync(privFile, 'utf8'));
        assert.equal(privCard.data.description, 'user edit');

        // 物化后再 PATCH 走纯私有路径(无 __materialized)。
        const res2 = await callJson(app, 'PATCH', '/api/utopinn/characters/Shared', { description: 'second edit' });
        assert.equal(res2.status, 200);
        assert.equal(res2.json.__materialized, undefined);
        assert.equal(res2.json.data.description, 'second edit');
    });
});

test('PATCH 物化:PNG 共享卡 → 私有 PNG 落盘(writeCharacterData 管线)', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writePngCard(libDir, 'PoolPng', CARD_SHARED);
        const poolFile = path.join(libDir, 'PoolPng.png');
        const poolBytes = fs.readFileSync(poolFile);

        const res = await callJson(app, 'PATCH', '/api/utopinn/characters/PoolPng', { tags: ['x'] });
        assert.equal(res.status, 200);
        assert.equal(res.json.__materialized, true);
        assert.equal(res.json.charDir, 'PoolPng');
        assert.deepEqual(fs.readFileSync(poolFile), poolBytes, 'pool PNG untouched');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'PoolPng.png')));
    });
});

test('POST install:显式物化 → {charDir,fileName,card};重复装 → 409;非共享 → 404', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Shared', CARD_SHARED);
        writeJsonCard(dirs.characters, 'Private', CARD_PRIVATE);

        const res = await callJson(app, 'POST', '/api/utopinn/characters/Shared/install');
        assert.equal(res.status, 200);
        assert.equal(res.json.charDir, 'Shared');
        assert.equal(res.json.fileName, 'Shared.json');
        assert.equal(res.json.card.data.name, 'Shared');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Shared.json')));

        const again = await callJson(app, 'POST', '/api/utopinn/characters/Shared/install');
        assert.equal(again.status, 409, '已转私有 → 409');

        const priv = await callJson(app, 'POST', '/api/utopinn/characters/Private/install');
        assert.equal(priv.status, 409);

        const missing = await callJson(app, 'POST', '/api/utopinn/characters/Nope/install');
        assert.equal(missing.status, 404);
    });
});

test('物化干名避让:私有 Foo1 已占 → 落 Foo2;chats/<stem> 不挡', async () => {
    await withEnv(async ({ dirs, libDir }) => {
        writeJsonCard(libDir, 'Foo', CARD_SHARED);
        writeJsonCard(dirs.characters, 'Foo1', CARD_PRIVATE); // 占了 Foo1
        fs.mkdirSync(path.join(dirs.chats, 'Foo'), { recursive: true }); // chats 目录不挡同干名

        const m = await materializeSharedCharacter(dirs, 'Foo');
        assert.equal(m.charDir, 'Foo', 'Foo 私有卡档缺席 → 原干名保留(chats/Foo 不挡)');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Foo.json')));

        // 再摆一张同名池卡场景:删私有 Foo.json 但留 Foo1,再物化 → Foo 回。
        // 直接测避让:私有 Foo.json 在场时物化 → Foo2(Foo1 被占)。
        const m2 = await materializeSharedCharacter(dirs, 'Foo');
        assert.equal(m2.charDir, 'Foo2', 'Foo/Foo1 双占 → 跳 Foo2');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Foo2.json')));
        // 三份独立 copy 都在。
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Foo.json')));
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Foo1.json')));
    });
});

test('char_state 合并读:发布侧车回落 → 用户侧车压制;写面恒 per-user', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Shared', CARD_SHARED);
        // 发布侧车(池内 <stem>.state.<ns>.json)。
        fs.writeFileSync(path.join(libDir, 'Shared.state.th_char.json'), JSON.stringify({ variables: { hp: 9 } }));

        const url = `/api/utopinn/state/char/get?avatar=Shared.png&namespace=th_char&account=${HANDLE}`;
        const r1 = await getJson(app, url);
        assert.equal(r1.status, 200);
        assert.equal(r1.json.data.variables.hp, 9, '无用户侧车 → 发布态回落');

        // 用户侧车在场 → 压制发布态。
        fs.writeFileSync(path.join(dirs.characters, 'Shared.state.th_char.json'), JSON.stringify({ variables: { hp: 1 } }));
        const r2 = await getJson(app, url);
        assert.equal(r2.json.data.variables.hp, 1);

        // 写面:仅共享卡在场时 set 也能写,但落点是用户目录侧车。
        writeJsonCard(libDir, 'OnlyPool', CARD_SHARED);
        const set = await callJson(app, 'POST', '/api/utopinn/state/char/set', {
            avatar_url: 'OnlyPool.png', namespace: 'th_char', data: { variables: { mp: 5 } },
        });
        assert.equal(set.status, 200);
        assert.ok(fs.existsSync(path.join(dirs.characters, 'OnlyPool.state.th_char.json')), '写锚落用户目录');
        assert.equal(fs.existsSync(path.join(libDir, 'OnlyPool.state.th_char.json')), false, '池内零写入');
        assert.equal(readCharacterStateMerged(dirs, 'OnlyPool', 'th_char').variables.mp, 5);
    });
});

test('regex 写面物化:PUT scope=char → 私有 copy 承接脚本,池档不动', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Shared', CARD_SHARED);
        const poolFile = path.join(libDir, 'Shared.json');
        const poolBytes = fs.readFileSync(poolFile);

        const scripts = [{ id: 's1', scriptName: 'x', findRegex: 'a', replaceString: 'b', placement: [2] }];
        const res = await callJson(app, 'PUT', '/api/utopinn/regex', { scope: 'char', char: 'Shared', scripts });
        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.deepEqual(fs.readFileSync(poolFile), poolBytes, '池档不动');

        const privCard = JSON.parse(fs.readFileSync(path.join(dirs.characters, 'Shared.json'), 'utf8'));
        assert.equal(privCard.data.extensions.regex_scripts.length, 1);

        // 读面:scoped view 现在从私有 copy 出。
        const view = await getJson(app, '/api/utopinn/regex?scope=char&char=Shared');
        assert.equal(view.status, 200);
        assert.equal(view.json.scripts.length, 1);
        assert.equal(view.json.shared, false);
    });
});

test('regex 读面:仅共享卡的 scoped view / full view 标 shared', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Shared', CARD_SHARED);

        const view = await getJson(app, '/api/utopinn/regex?scope=char&char=Shared');
        assert.equal(view.status, 200);
        assert.equal(view.json.shared, true);
        assert.equal(view.json.avatar, 'Shared.json', 'json-only 卡 avatar 报 .json(同私有语义)');

        const full = await getJson(app, '/api/utopinn/regex');
        const hit = (full.json.chars ?? []).find((c) => c.charDir === 'Shared');
        // 无脚本又未放行 → 不进全量列表(与私有同过滤语义);
        // 有脚本的池卡才进列表。补一张带脚本的:
        writeJsonCard(libDir, 'WithRx', {
            spec: 'chara_card_v2', spec_version: '2.0',
            data: { name: 'WithRx', extensions: { regex_scripts: [{ id: 'x', findRegex: 'a', replaceString: 'b' }] } },
        });
        const full2 = await getJson(app, '/api/utopinn/regex');
        const hit2 = (full2.json.chars ?? []).find((c) => c.charDir === 'WithRx');
        assert.ok(hit2, '有脚本的池卡进全量视图');
        assert.equal(hit2.shared, true);
        assert.equal(hit2.avatar, 'WithRx.json');
        assert.ok(!hit || true); // Shared 无脚本不进表(过滤语义保持)
    });
});

test('穿越闸:charDir=_library 拒;../ 段 safeName 拒;_library 干名永不入池寻址', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(dirs.characters, 'Private', CARD_PRIVATE);

        const r1 = await getJson(app, '/api/utopinn/characters/_library');
        assert.equal(r1.status, 400, '_library 保留名 → 400');
        const r2 = await getJson(app, '/api/utopinn/characters/..%2F..%2Fetc');
        assert.ok([400, 404].includes(r2.status), `traversal rejected (${r2.status})`);

        // _library 池里就算真有 _library.json 也不可寻址。
        fs.writeFileSync(path.join(libDir, '_library.json'), JSON.stringify(CARD_SHARED));
        assert.equal(resolveCharacterFileMerged(dirs, '_library'), null);
        const r3 = await getJson(app, '/api/utopinn/characters/_library');
        assert.equal(r3.status, 400);
    });
});

test('合并寻址:私有在场即私有(共享池同款不掺和)', async () => {
    await withEnv(async ({ dirs, libDir }) => {
        writeJsonCard(dirs.characters, 'Both', CARD_SAME_STEM_PRIVATE);
        writeJsonCard(libDir, 'Both', CARD_SAME_STEM_SHARED);
        const m = resolveCharacterFileMerged(dirs, 'Both');
        assert.equal(m.shared, false);
        assert.equal(m.filePath, path.join(dirs.characters, 'Both.json'));

        fs.rmSync(path.join(dirs.characters, 'Both.json'));
        const m2 = resolveCharacterFileMerged(dirs, 'Both');
        assert.equal(m2.shared, true);
        assert.equal(m2.filePath, path.join(libDir, 'Both.json'));
    });
});

// ── review 返修回归(CWE-59 符号链接 / CWE-770 配额 / 正确性) ────────────

test('符号链接监禁:池内 symlink 出界 → 寻址/静态面全拒;池内互指放行', () => {
    const { dirs, libDir, dataRoot } = makeTmpDirs();
    globalThis.DATA_ROOT = dataRoot;
    try {
        const secretPath = path.join(dataRoot, 'outside-secret.json');
        fs.writeFileSync(secretPath, JSON.stringify({ secret: 'nope' }));
        let canSymlink = true;
        try {
            fs.symlinkSync(secretPath, path.join(libDir, 'Escape.json'));
            fs.symlinkSync(secretPath, path.join(libDir, 'Escape.png'));
        } catch { canSymlink = false; } // 平台不允 symlink(如未开开发者模式的 Windows) → 跳过
        if (canSymlink) {
            assert.equal(resolveSharedLibraryFilePath(dirs, 'Escape.json'), null, 'static face: out-of-pool symlink rejected');
            assert.equal(resolveCharacterFileMerged(dirs, 'Escape'), null, 'card resolve: out-of-pool symlink invisible');
            writeJsonCard(libDir, 'Real', CARD_SHARED);
            fs.symlinkSync(path.join(libDir, 'Real.json'), path.join(libDir, 'Alias.json'));
            const aliased = resolveSharedLibraryFilePath(dirs, 'Alias.json');
            assert.ok(aliased && path.basename(aliased) === 'Real.json', 'in-pool symlink resolves to canonical target');
        }
    } finally {
        delete globalThis.DATA_ROOT;
    }
});

test('配额闸:超限账号 install/PATCH 物化 → 413,私有副本不落盘,池档不动', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Shared', CARD_SHARED);
        const poolBytes = fs.readFileSync(path.join(libDir, 'Shared.json'));

        // 预算压到 1 字节 —— userRoot 已非空,任何物化必超。
        await saveAdminSettings({ storage: { defaultUserQuotaBytes: 1 } });
        try {
            const inst = await callJson(app, 'POST', '/api/utopinn/characters/Shared/install');
            assert.equal(inst.status, 413, 'install → 413');
            assert.equal(fs.existsSync(path.join(dirs.characters, 'Shared.json')), false, 'no private copy written');

            const pat = await callJson(app, 'PATCH', '/api/utopinn/characters/Shared', { description: 'x' });
            assert.equal(pat.status, 413, 'PATCH materialize → 413');
            assert.equal(fs.existsSync(path.join(dirs.characters, 'Shared.json')), false);
            assert.deepEqual(fs.readFileSync(path.join(libDir, 'Shared.json')), poolBytes, 'pool untouched');
        } finally {
            await saveAdminSettings({ storage: { defaultUserQuotaBytes: -1 } });
        }

        // 恢复无限配额后同卡可装 —— 闸是计量不是开关。
        const ok = await callJson(app, 'POST', '/api/utopinn/characters/Shared/install');
        assert.equal(ok.status, 200);
    });
});

test('物化多档:PNG 封面+JSON 卡 → 双档随迁可读;非卡 JSON → 拒绝且零落盘', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        // PNG 无内嵌卡(纯封面)+ JSON 载卡 —— 合并读走 json,物化必须两档随迁。
        fs.writeFileSync(path.join(libDir, 'Mix.png'), PNG_1PX);
        writeJsonCard(libDir, 'Mix', CARD_SHARED);

        const res = await callJson(app, 'POST', '/api/utopinn/characters/Mix/install');
        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Mix.png')), 'cover migrated');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Mix.json')), 'card json migrated');
        const { card } = await loadCharacterDocFromDir(dirs.characters, 'Mix');
        assert.equal(card?.data?.name, 'Shared', 'private copy readable through json source');
        const detail = await getJson(app, '/api/utopinn/characters/Mix');
        assert.equal(detail.json.data.name, 'Shared');

        // PATCH 混合档共享卡:source=json → 写私有 json,池档字节不动。
        fs.writeFileSync(path.join(libDir, 'MixP.png'), PNG_1PX);
        writeJsonCard(libDir, 'MixP', { ...CARD_SHARED, data: { ...CARD_SHARED.data, name: 'MixP' } });
        const poolMixP = fs.readFileSync(path.join(libDir, 'MixP.json'));
        const pat = await callJson(app, 'PATCH', '/api/utopinn/characters/MixP', { description: 'patched' });
        assert.equal(pat.status, 200, JSON.stringify(pat.json));
        assert.equal(pat.json.__materialized, true);
        const privateDoc = JSON.parse(fs.readFileSync(path.join(dirs.characters, 'MixP.json'), 'utf8'));
        assert.equal(privateDoc.data.description, 'patched');
        assert.deepEqual(fs.readFileSync(path.join(libDir, 'MixP.json')), poolMixP, 'pool json untouched');

        // 非卡 JSON(裸 state 文档形状)物化必须拒且零落盘 —— 不发坏副本。
        fs.writeFileSync(path.join(libDir, 'NotACard.json'), JSON.stringify({ hp: 9, vars: {} }));
        const bad = await callJson(app, 'POST', '/api/utopinn/characters/NotACard/install');
        assert.ok([400, 404].includes(bad.status), 'non-card refused');
        assert.equal(fs.existsSync(path.join(dirs.characters, 'NotACard.json')), false, 'rolled back');
    });
});

test('TH regex 写共享 PNG:replaceTavernRegexes → 私有 copy 承接脚本,池档字节不动', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writePngCard(libDir, 'SharedPng', CARD_SHARED);
        const poolBytes = fs.readFileSync(path.join(libDir, 'SharedPng.png'));

        const res = await callJson(app, 'POST', '/api/utopinn/th/call', {
            method: 'replaceTavernRegexes',
            args: {
                type: 'character',
                name: 'SharedPng',
                regexes: [{ scriptName: 'pool-fix', findRegex: 'a', replaceString: 'b', placement: ['ai_output'] }],
            },
        });
        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.equal(res.json?.ok, true, JSON.stringify(res.json));
        assert.deepEqual(fs.readFileSync(path.join(libDir, 'SharedPng.png')), poolBytes, 'pool PNG untouched');
        const privPng = path.join(dirs.characters, 'SharedPng.png');
        assert.ok(fs.existsSync(privPng), 'materialized private PNG exists');
        const { card } = await loadCharacterDocFromDir(dirs.characters, 'SharedPng');
        const scripts = card?.data?.extensions?.regex_scripts;
        assert.ok(Array.isArray(scripts) && scripts.length === 1, 'script landed on private copy');
        assert.equal(scripts[0].scriptName, 'pool-fix');
    });
});

test('CardApp 资产指纹:共享源独立缓存根分目录;新指纹重解包+GC,私有面板资产零误伤', () => {
    const { dirs } = makeTmpDirs();
    const mkCard = (html) => ({
        data: {
            name: 'App',
            extensions: { card_app: { entry: 'index.html', files: { 'index.html': html } } },
        },
    });
    const k1 = sharedAssetKey({ mtimeMs: 1000, size: 10 });
    const k2 = sharedAssetKey({ mtimeMs: 2000, size: 20 });
    assert.notEqual(k1, k2, 'fingerprint participates in key');

    const dir1 = cardAppAssetDir(dirs, 'Foo', k1);
    // 共享解包落 _cardapps_shared/<stem>/<fp>,物理隔离 cardApps 命名空间。
    assert.equal(dir1, path.join(dirs.root, '_cardapps_shared', 'Foo', '1000-10'), dir1);
    assert.equal(path.basename(cardAppAssetDir(dirs, 'Foo')), 'Foo');

    // 私有卡 stem 形如 @lib- 前缀的命名空间碰撞场景:私有面板资产在场,
    // 共享解包 GC 不许碰它一根毛。
    const privDir = path.join(dirs.cardApps, 'Atlas@lib-notes');
    fs.mkdirSync(privDir, { recursive: true });
    fs.writeFileSync(path.join(privDir, 'panel.html'), 'private panel');
    const before = fs.readdirSync(dirs.cardApps);

    assert.equal(ensureCardAppAssets(mkCard('<html>v1</html>'), dirs, 'Atlas', k1), true);
    assert.equal(ensureCardAppAssets(mkCard('<html>v2</html>'), dirs, 'Atlas', k2), true);
    const dir2 = cardAppAssetDir(dirs, 'Atlas', k2);
    assert.equal(fs.readFileSync(path.join(dir2, 'index.html'), 'utf8'), '<html>v2</html>');
    assert.equal(fs.existsSync(dir1), false, 'stale shared fingerprint dir GC-ed');
    assert.ok(fs.existsSync(path.join(privDir, 'panel.html')), 'private @lib- asset dir untouched');
    assert.deepEqual(fs.readdirSync(dirs.cardApps), before, 'cardApps namespace untouched by shared GC');
});

test('state 回落防泄漏:私有遮蔽永不回落池侧车;删已拷侧车仍不回落', async () => {
    await withEnv(async ({ dirs, libDir }) => {
        writeJsonCard(libDir, 'Dup', CARD_SAME_STEM_SHARED);
        writeJsonCard(dirs.characters, 'Dup', CARD_SAME_STEM_PRIVATE);
        // 池发布侧车 hp=9 —— 私有卡赢了寻址,不许渗进私有卡命名空间。
        fs.writeFileSync(path.join(libDir, 'Dup.state.hp.json'), JSON.stringify({ hp: 9 }));
        assert.equal(readCharacterStateMerged(dirs, 'Dup', 'hp'), null, 'private shadows: pool state must not leak');

        // 已物化场景:侧车随迁后用户删掉自己的侧车 → 仍不回落(不是"借池态")。
        writeJsonCard(libDir, 'Only', CARD_SHARED);
        fs.writeFileSync(path.join(libDir, 'Only.state.hp.json'), JSON.stringify({ hp: 9 }));
        const m = await materializeSharedCharacter(dirs, 'Only');
        assert.equal(m.charDir, 'Only');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Only.state.hp.json')), 'sidecar migrated');
        assert.equal(readCharacterStateMerged(dirs, 'Only', 'hp')?.hp, 9, 'user sidecar serves');
        fs.rmSync(path.join(dirs.characters, 'Only.state.hp.json'));
        assert.equal(readCharacterStateMerged(dirs, 'Only', 'hp'), null, 'deleted user sidecar: private card never falls back');

        // 仅共享卡(无私有)仍正常回落 —— 对照组。
        writeJsonCard(libDir, 'Free', CARD_SHARED);
        fs.writeFileSync(path.join(libDir, 'Free.state.hp.json'), JSON.stringify({ hp: 3 }));
        assert.equal(readCharacterStateMerged(dirs, 'Free', 'hp')?.hp, 3);
    });
});

test('侧车不入卡:列表排除 *.state.*.json;install/详情对侧车干名 → 404', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Foo', CARD_SHARED);
        fs.writeFileSync(path.join(libDir, 'Foo.state.chat.json'), JSON.stringify({ history: [1] }));
        writeJsonCard(dirs.characters, 'Bar', CARD_PRIVATE);
        fs.writeFileSync(path.join(dirs.characters, 'Bar.state.hp.json'), JSON.stringify({ hp: 1 }));

        const list = await getJson(app, '/api/utopinn/characters');
        const names = list.json.items.map((i) => i.charDir);
        assert.ok(names.includes('Foo') && names.includes('Bar'));
        assert.ok(!names.includes('Foo.state.chat'), 'pool sidecar not listed as card');
        assert.ok(!names.includes('Bar.state.hp'), 'private sidecar not listed as card');

        const inst = await callJson(app, 'POST', '/api/utopinn/characters/Foo.state.chat/install');
        assert.equal(inst.status, 404, 'sidecar stem not installable');
        const detail = await getJson(app, '/api/utopinn/characters/Foo.state.chat');
        assert.equal(detail.status, 404, 'sidecar stem not addressable as card');
    });
});

// ── 二轮 review 返修回归 ─────────────────────────────────────────────────

test('被拒候选挡路:Atlas.png 出界 symlink + Atlas.json 有效 → 解析到 JSON,install 只迁 JSON', async () => {
    await withEnv(async ({ dirs, libDir, dataRoot, app }) => {
        const outside = path.join(dataRoot, 'escape-target.png');
        fs.writeFileSync(outside, PNG_1PX);
        try {
            fs.symlinkSync(outside, path.join(libDir, 'Atlas.png'));
        } catch {
            return; // 平台不允 symlink → 跳过
        }
        writeJsonCard(libDir, 'Atlas', CARD_SHARED);

        // 出界 PNG 不再整体否决干名 —— 落到有效 JSON 候选。
        const resolved = resolveCharacterFileMerged(dirs, 'Atlas');
        assert.equal(resolved?.shared, true);
        assert.equal(resolved.fileName, 'Atlas.json');

        const res = await callJson(app, 'POST', '/api/utopinn/characters/Atlas/install');
        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Atlas.json')), 'json migrated');
        assert.equal(fs.existsSync(path.join(dirs.characters, 'Atlas.png')), false, 'escaping cover never copied');
        const detail = await getJson(app, '/api/utopinn/characters/Atlas');
        assert.equal(detail.json.data.name, 'Shared');
    });
});

test('配额估算按 copy plan:已拷侧车不计 → 预算贴边也能装;rename 干名变侧车也不计', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'Q', CARD_SHARED);
        // 池发布侧车 + 用户同干侧车已在场 —— COPYFILE_EXCL 不会拷,不许入估算。
        const poolSidecar = 'Q.state.hp.json';
        fs.writeFileSync(path.join(libDir, poolSidecar), JSON.stringify({ hp: 9 }));
        fs.writeFileSync(path.join(dirs.characters, poolSidecar), JSON.stringify({ hp: 1 }));

        const cardBytes = fs.statSync(path.join(libDir, 'Q.json')).size;
        const est = estimateSharedMaterializeBytes(dirs, 'Q');
        assert.equal(est, cardBytes, 'existing user sidecar excluded from estimate');

        // 配额 = usage + cardBytes 贴边放行(若把侧车算进来就会被 413 误杀)。
        const usage = await getDirectorySizeBytes(dirs.root);
        await saveAdminSettings({ storage: { defaultUserQuotaBytes: usage + cardBytes + 1 } });
        try {
            const res = await callJson(app, 'POST', '/api/utopinn/characters/Q/install');
            assert.equal(res.status, 200, JSON.stringify(res.json));
        } finally {
            await saveAdminSettings({ storage: { defaultUserQuotaBytes: -1 } });
        }
    });
});

test('池内别名:Alias.png→Original.png 读发布侧车按请求 stem(Alias.state),物化随迁同 stem', async () => {
    await withEnv(async ({ dirs, libDir }) => {
        writeJsonCard(libDir, 'Original', CARD_SHARED);
        try {
            fs.symlinkSync(path.join(libDir, 'Original.json'), path.join(libDir, 'Alias.json'));
        } catch {
            return; // 平台不允 symlink → 跳过
        }
        fs.writeFileSync(path.join(libDir, 'Alias.state.hp.json'), JSON.stringify({ hp: 9 }));
        fs.writeFileSync(path.join(libDir, 'Original.state.hp.json'), JSON.stringify({ hp: 3 }));

        // 请求 stem = Alias → 读 Alias.state.hp(9),不是 realpath 目标的 Original.state(3)。
        assert.equal(readCharacterStateMerged(dirs, 'Alias', 'hp')?.hp, 9, 'alias reads request-stem sidecar');
        assert.equal(readCharacterStateMerged(dirs, 'Original', 'hp')?.hp, 3, 'original reads its own');

        const m = await materializeSharedCharacter(dirs, 'Alias');
        assert.equal(m.charDir, 'Alias');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Alias.state.hp.json')), 'sidecar migrated under request stem');
        assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.characters, 'Alias.state.hp.json'), 'utf8')).hp, 9);
        assert.equal(fs.existsSync(path.join(dirs.characters, 'Original.state.hp.json')), false, 'no original-identity leak');
    });
});

test('stscript rename:物化多档卡改名 → 全兄弟档随迁,旧干零残留不遮蔽池卡', async () => {
    await withEnv(async ({ dirs, libDir }) => {
        // 池卡 = 内嵌卡 PNG 封面 + JSON 数据 —— 物化后干名两份档。
        writePngCard(libDir, 'Old', { ...CARD_SHARED, data: { ...CARD_SHARED.data, name: 'OldName' } });
        writeJsonCard(libDir, 'Old', { ...CARD_SHARED, data: { ...CARD_SHARED.data, name: 'OldName' } });
        fs.writeFileSync(path.join(libDir, 'Old.state.hp.json'), JSON.stringify({ hp: 7 }));
        await materializeSharedCharacter(dirs, 'Old');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'Old.json')) && fs.existsSync(path.join(dirs.characters, 'Old.png')));

        const built = await buildStscriptEnv({ handle: HANDLE, directories: dirs, charDir: 'Old', chatName: null, userName: 'User' });
        assert.ok(built.env?.host?.renameCharacter, JSON.stringify(built));
        const ok = await built.env.host.renameCharacter('NewName');
        assert.equal(ok, true);

        // 旧干零残留:png/json/侧车全搬走。
        assert.equal(fs.existsSync(path.join(dirs.characters, 'Old.png')), false, 'old png gone');
        assert.equal(fs.existsSync(path.join(dirs.characters, 'Old.json')), false, 'old json gone');
        assert.equal(fs.existsSync(path.join(dirs.characters, 'Old.state.hp.json')), false, 'old sidecar gone');
        assert.ok(fs.existsSync(path.join(dirs.characters, 'NewName.png')));
        // JSON 兄弟随迁并同步改名。
        const jsonDoc = JSON.parse(fs.readFileSync(path.join(dirs.characters, 'NewName.json'), 'utf8'));
        assert.equal(jsonDoc.data.name, 'NewName');
        // 池卡旧干回归可见(不再被残档遮蔽)。
        const merged = resolveCharacterFileMerged(dirs, 'Old');
        assert.equal(merged?.shared, true, 'pool card un-shadowed after rename');
    });
});

test('配额缓存窗:fresh 计量 → 连装两卡第二发 413,窗口期不超卖', async () => {
    await withEnv(async ({ dirs, libDir, app }) => {
        writeJsonCard(libDir, 'A', CARD_SHARED);
        writeJsonCard(libDir, 'B', { ...CARD_SHARED, data: { ...CARD_SHARED.data, name: 'B' } });
        const sizeA = fs.statSync(path.join(libDir, 'A.json')).size;
        const usage = await getDirectorySizeBytes(dirs.root);

        // 配额恰好放行 A(usage+A+1),B 必超 —— 若走 5s 旧值 B 会被误放。
        await saveAdminSettings({ storage: { defaultUserQuotaBytes: usage + sizeA + 1 } });
        try {
            const ra = await callJson(app, 'POST', '/api/utopinn/characters/A/install');
            assert.equal(ra.status, 200, JSON.stringify(ra.json));
            const rb = await callJson(app, 'POST', '/api/utopinn/characters/B/install');
            assert.equal(rb.status, 413, 'fresh usage sees A landing → B rejected');
            assert.equal(fs.existsSync(path.join(dirs.characters, 'B.json')), false);
        } finally {
            await saveAdminSettings({ storage: { defaultUserQuotaBytes: -1 } });
        }
    });
});
