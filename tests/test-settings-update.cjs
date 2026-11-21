/**
 * W1 实测:PATCH /api/utopinn/settings 弃 CAS 走 SettingsRepo.update() 临界区
 * (设计:.skeinn/design/deferred-surgery.md §W1 方案 A)。
 *
 * 隔离服:真 FsEngine / SqliteEngine + tmp dataRoot + 真 express 挂随机端口,
 * fetch 打真 HTTP —— 与生产同一条 request→repo→engine 路径。
 *
 * 跑法:node tests/test-settings-update.cjs
 *
 * 断言面:
 *  1. 缺 settings.json 自动建(put upsert 语义)
 *  2. HTTP 并发 PATCH 异段(oai_settings/world_info_settings/extension_settings)互不失
 *  3. repo.update 临界区串行:慢 fn 与快 fn 并发,快方必须读到慢方的已提交结果
 *  4. 同键并发按 tx 到达序后写胜(尾链 FIFO)
 *  5. preset_settings_openai 镜像对(oai_settings 内嵌 ↔ 顶层)同 patch/跨 patch 原子
 *  6. sanitizeSettingsDoc 剥键:密钥形键不落盘不进响应
 *  7. 端点契约不变:400/422 前置校验照旧,响应仍是 {settings} 全文档
 *  8. fn 抛错 → 全滚,盘上文档不动
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const SERVER_ROOT = path.resolve(__dirname, '..', 'apps', 'server');
// express 等依赖只装在 apps/server 下(pnpm 不提升),用 server 自己的
// package.json 作 require 锚点解析。
const serverRequire = createRequire(path.join(SERVER_ROOT, 'package.json'));
const express = serverRequire('express');
const imp = (rel) => import(pathToFileURL(path.join(SERVER_ROOT, rel)).href);

// 与 apps/server/tests/storage/harness/fs-harness.js USER_DIRS 同构
// (镜像 src/constants.js USER_DIRECTORY_TEMPLATE)。
const USER_DIRS = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

const out = [];
let failures = 0;
const log = (name, ok, detail = '') => {
    out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildDirs(userDir) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(userDir, rel);
    }
    return dirs;
}

async function runMode(mode, mods) {
    const { initStorage, getSettingsRepo, getStorageEngine } = mods.storage;
    const { apply } = mods.library;

    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `settings-update-${mode}-`));
    const dirsByHandle = { u1: buildDirs(path.join(dataRoot, 'u1')), u2: buildDirs(path.join(dataRoot, 'u2')) };
    for (const d of Object.values(dirsByHandle)) fs.mkdirSync(d.root, { recursive: true });
    await initStorage({ mode, directoriesByHandle: (h) => dirsByHandle[h] });

    // 插件路由挂到全新 Router 上(webServer stub 与 utopinn-library.test.mjs 同形)。
    const router = express.Router();
    const ws = {
        register: (spec) => {
            router[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    apply({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const handle = req.get('x-handle') || 'u1';
        req.user = { profile: { handle, name: 'Test' }, directories: dirsByHandle[handle] };
        next();
    });
    app.use(router);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const BASE = `http://127.0.0.1:${server.address().port}`;
    const api = async (p, { method = 'GET', body, handle = 'u1' } = {}) => {
        const res = await fetch(BASE + p, {
            method,
            headers: { 'content-type': 'application/json', 'x-handle': handle },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const repo = getSettingsRepo();
    const P = `/api/utopinn/settings`;
    const tag = `[${mode}]`;

    try {
        // ---- 1. 缺 settings.json 自动建 ----
        const fresh = await api(P, { method: 'PATCH', handle: 'u2', body: { power_user: { fresh: 1 } } });
        log(`${tag} 缺 settings.json → PATCH 200`, fresh.status === 200, `status=${fresh.status}`);
        const freshDoc = await repo.get('u2');
        log(`${tag} 缺档 patch 落盘`, freshDoc && freshDoc.power_user && freshDoc.power_user.fresh === 1);
        if (mode === 'fs') {
            log(`${tag} settings.json 文件已建`, fs.existsSync(path.join(dirsByHandle.u2.root, 'settings.json')));
        }

        // ---- 2. HTTP 并发异段不互丢 ----
        // 旧实现 get→merge→save 整文档覆写,并发 PATCH 互丢整段。
        // 8 轮三段齐发,任意交错都必须全合。
        const ROUNDS = 8;
        const races = [];
        for (let i = 0; i < ROUNDS; i++) {
            races.push(Promise.all([
                api(P, { method: 'PATCH', body: { oai_settings: { [`oai_k${i}`]: `o${i}` } } }),
                api(P, { method: 'PATCH', body: { world_info_settings: { [`wi_k${i}`]: `w${i}` } } }),
                api(P, { method: 'PATCH', body: { extension_settings: { [`ext_k${i}`]: `e${i}` } } }),
            ]));
        }
        const raceRes = await Promise.all(races);
        const all200 = raceRes.every((rs) => rs.every((r) => r.status === 200));
        log(`${tag} 并发 PATCH 全部 200`, all200);
        const merged = await api(P);
        let lostCount = 0;
        for (let i = 0; i < ROUNDS; i++) {
            const s = merged.body.settings;
            if (s.oai_settings?.[`oai_k${i}`] !== `o${i}`) lostCount++;
            if (s.world_info_settings?.[`wi_k${i}`] !== `w${i}`) lostCount++;
            if (s.extension_settings?.[`ext_k${i}`] !== `e${i}`) lostCount++;
        }
        log(`${tag} 并发异段零丢写`, lostCount === 0, `lost=${lostCount}/${ROUNDS * 3}`);

        // ---- 3. repo.update 临界区串行(确定性) ----
        // 慢 fn 持锁 60ms;快 fn 若不在临界区内会读到慢方写入前的快照 → 丢键。
        const slow = repo.update('u1', async (doc) => {
            await sleep(60);
            return { ...doc, _tortoise: { v: 1 } };
        });
        const hare = repo.update('u1', (doc) => ({ ...doc, _hare: { v: 2 } }));
        await Promise.all([slow, hare]);
        const afterRace = await repo.get('u1');
        log(`${tag} update 串行:快慢双键俱在`,
            afterRace._tortoise?.v === 1 && afterRace._hare?.v === 2,
            `tortoise=${afterRace._tortoise?.v} hare=${afterRace._hare?.v}`);

        // ---- 4. 同键并发按 tx 到达序后写胜 ----
        const p1 = repo.update('u1', (doc) => ({ ...doc, _order: 'first' }));
        const p2 = repo.update('u1', (doc) => ({ ...doc, _order: 'second' }));
        await Promise.all([p1, p2]);
        const ordered = await repo.get('u1');
        log(`${tag} 同键到达序 last-wins`, ordered._order === 'second', `_order=${ordered._order}`);
        // HTTP 面顺序写同理
        await api(P, { method: 'PATCH', body: { power_user: { theme: 'a' } } });
        const seqB = await api(P, { method: 'PATCH', body: { power_user: { theme: 'b' } } });
        log(`${tag} HTTP 同键顺序写后胜`, seqB.body.settings.power_user.theme === 'b');

        // ---- 5. preset 镜像对原子(同 patch 顶层优先 + 双向镜像 + null 删键) ----
        const viaOai = await api(P, { method: 'PATCH', body: { oai_settings: { preset_settings_openai: 'P_oai' } } });
        log(`${tag} oai 内嵌写 → 顶层同步`,
            viaOai.body.settings.preset_settings_openai === 'P_oai'
            && viaOai.body.settings.oai_settings.preset_settings_openai === 'P_oai');
        const viaTop = await api(P, { method: 'PATCH', body: { preset_settings_openai: 'P_top' } });
        log(`${tag} 顶层写 → oai 内嵌同步`,
            viaTop.body.settings.preset_settings_openai === 'P_top'
            && viaTop.body.settings.oai_settings.preset_settings_openai === 'P_top');
        const both = await api(P, {
            method: 'PATCH',
            body: { preset_settings_openai: 'P_win', oai_settings: { preset_settings_openai: 'P_lose' } },
        });
        log(`${tag} 同 patch 顶层优先`,
            both.body.settings.preset_settings_openai === 'P_win'
            && both.body.settings.oai_settings.preset_settings_openai === 'P_win');
        const nulled = await api(P, { method: 'PATCH', body: { preset_settings_openai: null } });
        log(`${tag} null 删键:镜像对同死`,
            !('preset_settings_openai' in nulled.body.settings)
            && !('preset_settings_openai' in (nulled.body.settings.oai_settings || {})));
        // 镜像对并发一致性:指针写与 oai 段写并发后,顶/嵌两槽仍一致(同 tx 全或无)
        const seedMirror = await api(P, { method: 'PATCH', body: { preset_settings_openai: 'P0' } });
        void seedMirror;
        await Promise.all([
            api(P, { method: 'PATCH', body: { preset_settings_openai: 'PX' } }),
            api(P, { method: 'PATCH', body: { oai_settings: { openai_model: 'm9' } } }),
        ]);
        const disk = await repo.get('u1');
        log(`${tag} 并发后镜像对一致(盘上)`,
            disk.preset_settings_openai === 'PX'
            && disk.oai_settings?.preset_settings_openai === 'PX'
            && disk.oai_settings?.openai_model === 'm9',
            `top=${disk.preset_settings_openai} oai=${disk.oai_settings?.preset_settings_openai}`);

        // ---- 6. sanitize 剥键:不落盘、不进响应 ----
        const dirty = await api(P, {
            method: 'PATCH',
            body: {
                oai_settings: { api_key_openai: 'sk-live', openai_model: 'm-clean' },
                power_user: { auth_token: 'tok', note: 'keep' },
            },
        });
        const ds = dirty.body.settings;
        const disk2 = await repo.get('u1');
        log(`${tag} 响应剥密钥`,
            ds.oai_settings.openai_model === 'm-clean' && !('api_key_openai' in ds.oai_settings)
            && ds.power_user.note === 'keep' && !('auth_token' in ds.power_user));
        log(`${tag} 盘上同样无密钥`,
            !('api_key_openai' in (disk2.oai_settings || {})) && !('auth_token' in (disk2.power_user || {})));

        // ---- 7. 端点契约不变 ----
        const badKey = await api(P, { method: 'PATCH', body: { world_info: { x: 1 } } });
        log(`${tag} 非白名单段仍 400`, badKey.status === 400, `status=${badKey.status}`);
        const badSec = await api(P, { method: 'PATCH', body: { power_user: 'nope' } });
        log(`${tag} 非对象段仍 422`, badSec.status === 422, `status=${badSec.status}`);
        const empty = await api(P, { method: 'PATCH', body: {} });
        log(`${tag} 空 body 仍 400`, empty.status === 400, `status=${empty.status}`);
        const badMirror = await api(P, { method: 'PATCH', body: { oai_settings: { preset_settings_openai: { bad: 1 } } } });
        log(`${tag} 镜像非标量仍 422`, badMirror.status === 422, `status=${badMirror.status}`);
        const badScalar = await api(P, { method: 'PATCH', body: { preset_settings_openai: 42 } });
        log(`${tag} 标量非 string 仍 422`, badScalar.status === 422, `status=${badScalar.status}`);

        // ---- 8. fn 抛错 → 全滚 ----
        const before = await repo.get('u1');
        let threw = false;
        try {
            await repo.update('u1', () => { throw new Error('boom'); });
        } catch { threw = true; }
        const after = await repo.get('u1');
        log(`${tag} fn 抛错拒绝`, threw);
        log(`${tag} fn 抛错盘上不动`, JSON.stringify(before) === JSON.stringify(after));
    } finally {
        server.close();
        await getStorageEngine().close?.();
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

async function main() {
    // secrets.js 等模块级读 config:import 插件前先把 config 路径就位。
    const util = await imp('src/util.js');
    if (!util.getConfigFilePath()) {
        util.setConfigFilePath(path.join(SERVER_ROOT, 'default', 'config.yaml'));
    }
    util.reloadConfigCache();
    // node-persist 磁盘缓存的 setInterval 会吊着进程退不出
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    const mods = {
        storage: await imp('src/storage/index.js'),
        library: await imp('src/plugins/utopinn-library.js'),
    };

    for (const mode of ['fs', 'sqlite']) {
        try {
            await runMode(mode, mods);
        } catch (error) {
            log(`[${mode}] suite 抛错`, false, String(error && error.stack || error));
        }
    }

    console.log(out.join('\n'));
    console.log(`\n${out.length - failures}/${out.length} passed`);
    process.exit(failures ? 1 : 0);
}

main().catch((error) => {
    console.error('harness error:', error);
    process.exit(2);
});
