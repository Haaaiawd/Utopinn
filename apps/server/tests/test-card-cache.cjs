/**
 * test-card-cache.cjs —— GET /api/utopinn/characters 浅字段索引缓存实弹验证。
 *
 * 跑法(脚本与运行时无关;Windows 下用 D:\nodejs\node.exe 可避开 /mnt/d 9P):
 *   node tests/test-card-cache.cjs            # WSL
 *   D:\nodejs\node.exe tests\test-card-cache.cjs   # Windows 侧
 *
 * 真起隔离服(node server.js,LUKER_SKIP_WEBPACK=1,自带 dataRoot/config/独占
 * 端口),断言:
 *   1. 连续两次列表 —— 第二次 diag 计数 misses=0(PNG 卡不重解),
 *      并打印两次时延对比;
 *   2. PATCH /characters/:charDir 改 PNG 卡 → 列表立即反映新 name
 *      (写盘换 mtime/size,缓存自然失效);
 *   3. 直接改盘 JSON 卡文件 → 列表立即反映新 name;
 *   4. 删卡 → 条目消失;新卡 → 条目出现。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.resolve(__dirname, '..');
const SEED_PNG = path.join(SERVER_DIR, 'default', 'content', 'default_我没想当掌门啊.png');
const SEED_CONFIG = path.join(SERVER_DIR, 'default', 'config.yaml');
const PNG_CARD_COUNT = 8;   // 8×551KB 真 PNG 卡 —— 冷/热列表时延拉开量级差
const READY_TIMEOUT_MS = 180_000;

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-card-cache-'));
const DATA_ROOT = path.join(SCRATCH, 'data');
const CONFIG_PATH = path.join(SCRATCH, 'config.yaml');
const CHARS_DIR = path.join(DATA_ROOT, 'default-user', 'characters');

let server = null;
let baseURL = '';
let PORT = 0;

function log(...args) { console.log('[card-cache]', ...args); }
function fail(msg) { throw new Error(msg); }

function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

async function api(method, route, body) {
    const res = await fetch(`${baseURL}${route}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 204/空体 */ }
    return { status: res.status, json };
}

/** 最近一次 card_list_scan diag 事件 {total,hits,misses}。 */
async function lastScanEvent() {
    const { status, json } = await api('GET', '/api/utopinn/diag/events?code=card_list_scan&limit=50');
    if (status !== 200) fail(`diag/events status=${status}`);
    const items = json?.items ?? [];
    return items.length ? items[items.length - 1].data : null;
}

async function waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseURL}/`, { redirect: 'manual' });
            if ([200, 302, 401].includes(res.status)) return;
        } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 300));
    }
    fail(`server on :${PORT} not ready within ${timeoutMs}ms`);
}

async function startServer() {
    PORT = await getFreePort();
    baseURL = `http://127.0.0.1:${PORT}`;
    fs.copyFileSync(SEED_CONFIG, CONFIG_PATH);
    fs.mkdirSync(CHARS_DIR, { recursive: true });
    const child = spawn(process.execPath, [
        'server.js',
        `--dataRoot=${DATA_ROOT}`,
        `--port=${PORT}`,
        `--configPath=${CONFIG_PATH}`,
        '--browserLaunchEnabled=false',
        '--listen=false',
        '--whitelist=127.0.0.1',
        '--disableCsrf=true',
    ], {
        cwd: SERVER_DIR,
        env: {
            ...process.env,
            LUKER_SKIP_WEBPACK: '1',
            NODE_ENV: 'production',
            // 启动期任何出站探测都别走代理/别挂外网
            NO_PROXY: '*', no_proxy: '*',
            HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });
    let output = '';
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => {
        output += String(d);
        if (process.env.CARD_CACHE_DEBUG) process.stderr.write(`[srv] ${d}`);
    });
    server = { child, output: () => output };
    await waitReady(READY_TIMEOUT_MS);
    log(`server ready on :${PORT} (dataRoot=${DATA_ROOT})`);
}

async function stopServer() {
    if (!server?.child) return;
    try {
        server.child.kill('SIGKILL');
        await Promise.race([
            new Promise((r) => server.child.once('exit', r)),
            new Promise((r) => setTimeout(r, 3000)),
        ]);
    } catch { /* gone */ }
    server = null;
}

function seedCards() {
    fs.mkdirSync(CHARS_DIR, { recursive: true });
    for (let i = 0; i < PNG_CARD_COUNT; i++) {
        fs.copyFileSync(SEED_PNG, path.join(CHARS_DIR, `CardCachePng${i}.png`));
    }
    writeJsonCard('CardCacheJson', 'Json Card Alpha');
}

function writeJsonCard(charDir, name, extra = {}) {
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: 'card-cache test fixture',
            personality: 'fixture',
            scenario: 'fixture',
            first_mes: 'hi',
            mes_example: '',
            tags: ['cache-fixture'],
            ...extra,
        },
    };
    fs.writeFileSync(path.join(CHARS_DIR, `${charDir}.json`), JSON.stringify(card), 'utf8');
}

async function listItems() {
    const t0 = performance.now();
    const { status, json } = await api('GET', '/api/utopinn/characters');
    const ms = performance.now() - t0;
    if (status !== 200) fail(`GET /characters status=${status} body=${JSON.stringify(json)?.slice(0, 300)}`);
    return { items: json.items ?? [], total: json.total, ms };
}

function itemOf(items, charDir) {
    return items.find((it) => it.charDir === charDir);
}

async function main() {
    log(`scratch=${SCRATCH} runtime=${process.execPath} v${process.version}`);
    await startServer();
    try {
        seedCards();
        // 服务器自己也可能往 characters 里播种(默认卡迁移等),桩卡按 charDir 断言
        const expected = PNG_CARD_COUNT + 1;

        // -- 1) 冷列表:全部实解 ------------------------------------------
        const cold = await listItems();
        const coldScan = await lastScanEvent();
        log(`cold list: ${cold.total} items in ${cold.ms.toFixed(1)}ms; diag=${JSON.stringify(coldScan)}`);
        const png0 = itemOf(cold.items, 'CardCachePng0');
        if (!png0) fail('CardCachePng0 missing from list');
        if (png0.name !== '我没想当掌门啊') fail(`CardCachePng0 name=${png0.name}, expected 我没想当掌门啊`);
        if (png0.avatar !== 'CardCachePng0.png' || png0.readable !== true) fail(`CardCachePng0 row=${JSON.stringify(png0)}`);
        const jsonRow = itemOf(cold.items, 'CardCacheJson');
        if (!jsonRow) fail('CardCacheJson missing from list');
        if (jsonRow.name !== 'Json Card Alpha') fail(`CardCacheJson name=${jsonRow.name}`);
        if (jsonRow.avatar !== null || jsonRow.fileName !== 'CardCacheJson.json' || jsonRow.readable !== true) {
            fail(`CardCacheJson row=${JSON.stringify(jsonRow)}`);
        }
        if (!coldScan || coldScan.misses < expected || coldScan.hits !== 0) {
            fail(`cold scan expected misses>=${expected} hits=0, got ${JSON.stringify(coldScan)}`);
        }

        // -- 2) 热列表:浅字段全命中,零重解 --------------------------------
        const warm = await listItems();
        const warmScan = await lastScanEvent();
        log(`warm list: ${warm.total} items in ${warm.ms.toFixed(1)}ms; diag=${JSON.stringify(warmScan)}`);
        if (!warmScan || warmScan.misses !== 0 || warmScan.hits !== warmScan.total) {
            fail(`warm scan expected misses=0 hits=total, got ${JSON.stringify(warmScan)}`);
        }
        if (itemOf(warm.items, 'CardCachePng0')?.name !== '我没想当掌门啊') fail('warm list name drift');
        log(`latency: cold=${cold.ms.toFixed(1)}ms warm=${warm.ms.toFixed(1)}ms speedup=${(cold.ms / Math.max(warm.ms, 0.01)).toFixed(1)}x`);

        // 再两次稳态确认计数不动
        for (let i = 0; i < 2; i++) {
            await listItems();
            const s = await lastScanEvent();
            if (!s || s.misses !== 0) fail(`repeat warm scan re-parsed: ${JSON.stringify(s)}`);
        }

        // -- 3) PATCH PNG 卡(真写路径:原子重写)→ name 立即刷新 -----------
        const patch = await api('PATCH', '/api/utopinn/characters/CardCachePng0', { name: 'Cache Renamed' });
        if (patch.status !== 200) fail(`PATCH status=${patch.status} body=${JSON.stringify(patch.json)?.slice(0, 300)}`);
        const afterPatch = await listItems();
        const patchScan = await lastScanEvent();
        const renamed = itemOf(afterPatch.items, 'CardCachePng0');
        if (renamed?.name !== 'Cache Renamed') fail(`PATCHed name not reflected: ${JSON.stringify(renamed)}`);
        // 其余卡指纹未变 → 只有这一张重解
        if (!patchScan || patchScan.misses !== 1) fail(`post-PATCH scan expected misses=1, got ${JSON.stringify(patchScan)}`);
        log(`post-PATCH list: name="${renamed.name}", scan=${JSON.stringify(patchScan)}`);

        // -- 4) 直接改盘 JSON 卡 → name 立即刷新 ---------------------------
        writeJsonCard('CardCacheJson', 'Json Card Beta');
        const afterEdit = await listItems();
        const editScan = await lastScanEvent();
        const jsonEdited = itemOf(afterEdit.items, 'CardCacheJson');
        if (jsonEdited?.name !== 'Json Card Beta') fail(`disk-edit not reflected: ${JSON.stringify(jsonEdited)}`);
        if (!editScan || editScan.misses !== 1) fail(`post-edit scan expected misses=1, got ${JSON.stringify(editScan)}`);
        log(`post-edit list: name="${jsonEdited.name}", scan=${JSON.stringify(editScan)}`);

        // -- 5) 删 → 消失;加 → 出现 --------------------------------------
        fs.unlinkSync(path.join(CHARS_DIR, 'CardCacheJson.json'));
        const afterDelete = await listItems();
        if (itemOf(afterDelete.items, 'CardCacheJson')) fail('deleted card still listed');
        if (afterDelete.total !== cold.total - 1) fail(`after delete total=${afterDelete.total}, expected ${cold.total - 1}`);

        writeJsonCard('CardCacheNew', 'Json Card New');
        const afterAdd = await listItems();
        const added = itemOf(afterAdd.items, 'CardCacheNew');
        if (!added || added.name !== 'Json Card New') fail(`added card missing: ${JSON.stringify(added)}`);
        if (afterAdd.total !== cold.total) fail(`after add total=${afterAdd.total}, expected ${cold.total}`);

        log('ALL CHECKS PASSED');
    } finally {
        await stopServer();
    }
}

main().then(
    async () => {
        try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best-effort */ }
        process.exit(0);
    },
    async (error) => {
        console.error('[card-cache] FAILED:', error?.stack ?? error);
        if (server) {
            const tail = server.output().split('\n').slice(-30).join('\n');
            if (tail.trim()) console.error('--- server output tail ---\n' + tail);
        }
        await stopServer();
        try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best-effort */ }
        process.exit(1);
    },
);
