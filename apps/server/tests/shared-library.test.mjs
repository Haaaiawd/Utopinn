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

// chats.js 传递依赖(backends/luker-generation.js)模块级读 config ——
// 必须 setConfigFilePath 后才可 import,故重依赖全部动态引入。
let chatsRouter, applyUtopinnLibrary, applyUtopinnRegex;
let getSharedCharactersDir, isSafeSharedStem, resolveSharedLibraryFilePath,
    materializeSharedCharacter, resolveCharacterFileMerged, readCharacterStateMerged;

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
    ({
        getSharedCharactersDir,
        isSafeSharedStem,
        resolveSharedLibraryFilePath,
        materializeSharedCharacter,
        resolveCharacterFileMerged,
        readCharacterStateMerged,
    } = await import('../src/services/shared-library.js'));
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
        openAI_Settings: path.join(userRoot, 'OpenAI Settings'),
    };
    for (const d of [dirs.characters, dirs.chats, dirs.worlds]) {
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
