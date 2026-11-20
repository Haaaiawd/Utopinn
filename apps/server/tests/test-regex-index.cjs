/**
 * test-regex-index.cjs —— W3 卡正则 slim 索引实弹验证。
 *
 * 跑法(脚本与运行时无关;Windows 下用 D:\nodejs\node.exe 可避开 /mnt/d 9P):
 *   node tests/test-regex-index.cjs            # WSL
 *   D:\nodejs\node.exe tests\test-regex-index.cjs   # Windows 侧
 *
 * 两段:
 *   A) 进程内单测 file-stat-index:指纹命中/失效、负缓存条、并发 miss 归并、
 *      put 回填、sweep 回收、LRU 上限。
 *   B) 隔离服 e2e(node server.js,LUKER_SKIP_WEBPACK=1,自带 dataRoot/config/
 *      独占端口):全量视图冷/热时延对比,PUT 写路径回填命中,外部改盘/utimes
 *      惰性失效,删卡消失,scoped 视图,V2 canonical/root 扩展位置。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.resolve(__dirname, '..');
const SEED_PNG = path.join(SERVER_DIR, 'default', 'content', 'default_Seraphina.png');
const SEED_CONFIG = path.join(SERVER_DIR, 'default', 'config.yaml');
const PNG_CARD_COUNT = 8;   // 8×551KB 真 PNG 卡 —— 冷/热全量视图拉开量级差
const READY_TIMEOUT_MS = 180_000;

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-regex-index-'));
const DATA_ROOT = path.join(SCRATCH, 'data');
const CONFIG_PATH = path.join(SCRATCH, 'config.yaml');
const CHARS_DIR = path.join(DATA_ROOT, 'default-user', 'characters');

let server = null;
let baseURL = '';
let PORT = 0;

function log(...args) { console.log('[regex-index]', ...args); }
function fail(msg) { throw new Error(msg); }

// ---------------------------------------------------------------------------
// A) file-stat-index 进程内单测
// ---------------------------------------------------------------------------

async function unitTests() {
    const { createFileStatIndex } = await import('../src/services/file-stat-index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsi-'));
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, '{"v":1}', 'utf8');

    // 冷 miss → loader 跑;热 hit → loader 不跑
    const index = createFileStatIndex();
    let loads = 0;
    const loader = async () => { loads++; return { scripts: ['x'] }; };
    const r1 = await index.get(dir, file, loader);
    if (r1.cached || r1.value.scripts[0] !== 'x' || loads !== 1) fail(`cold get: ${JSON.stringify(r1)} loads=${loads}`);
    const r2 = await index.get(dir, file, loader);
    if (!r2.cached || loads !== 1) fail(`warm get should hit: ${JSON.stringify(r2)} loads=${loads}`);

    // 并发 miss 归并:5 个并发 get 只触发一次 loader
    const file2 = path.join(dir, 'b.json');
    fs.writeFileSync(file2, '{"v":2}', 'utf8');
    let loads2 = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () =>
        index.get(dir, file2, async () => { loads2++; await new Promise((r) => setTimeout(r, 20)); return { scripts: [] }; })));
    if (loads2 !== 1) fail(`in-flight dedup broken: loads2=${loads2}`);
    if (results.some((r) => r.cached)) fail(`first-flight callers should all report miss`);

    // 负缓存条:loader 返回 scripts:null,二次 get 命中不重跑
    const bad = path.join(dir, 'bad.webp');
    fs.writeFileSync(bad, 'not a png', 'utf8');
    let loads3 = 0;
    const negLoader = async () => { loads3++; return { scripts: null }; };
    const n1 = await index.get(dir, bad, negLoader);
    const n2 = await index.get(dir, bad, negLoader);
    if (n1.value.scripts !== null || !n2.cached || loads3 !== 1) fail(`negative entry: loads3=${loads3}`);

    // 外部改写 → stat 三元组不匹配 → 惰性重解
    await new Promise((r) => setTimeout(r, 5)); // 让 mtimeMs 可分辨
    fs.writeFileSync(file, '{"v":2}', 'utf8');
    const r3 = await index.get(dir, file, loader);
    if (r3.cached || loads !== 2) fail(`edit should invalidate: ${JSON.stringify(r3)} loads=${loads}`);

    // utimes 摸 mtime → 同样失效
    fs.utimesSync(file, new Date(), new Date());
    const r4 = await index.get(dir, file, loader);
    if (r4.cached || loads !== 3) fail(`utimes should invalidate: loads=${loads}`);

    // put 回填:不写盘也立指纹,下一发 get 命中且零 loader
    const r5 = await index.get(dir, file, loader); // 已在上一步回填
    if (!r5.cached || loads !== 3) fail(`post-invalidate get should hit: loads=${loads}`);
    fs.writeFileSync(file, '{"v":3}', 'utf8');
    if (!index.put(dir, file, { scripts: ['put'] })) fail('put should succeed on existing file');
    const r6 = await index.get(dir, file, loader);
    if (!r6.cached || r6.value.scripts[0] !== 'put' || loads !== 3) fail(`put refill should hit: ${JSON.stringify(r6)}`);

    // sweep:删掉不在 alive 集的条目
    index.sweep(dir, new Set([file]));
    if (index.size(dir) !== 1) fail(`sweep should leave 1 entry, got ${index.size(dir)}`);

    // LRU 上限
    const capped = createFileStatIndex({ maxEntries: 2 });
    for (const n of ['c1', 'c2', 'c3']) {
        const f = path.join(dir, `${n}.json`);
        fs.writeFileSync(f, '{}', 'utf8');
        await capped.get(dir, f, async () => ({ scripts: [] }));
    }
    if (capped.size(dir) !== 2) fail(`cap should hold 2 entries, got ${capped.size(dir)}`);

    fs.rmSync(dir, { recursive: true, force: true });
    log('unit: file-stat-index get/dedup/negative/invalidate/put/sweep/cap OK');
}

// ---------------------------------------------------------------------------
// B) 隔离服 e2e
// ---------------------------------------------------------------------------

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

/** 最近一次 regex_index_scan diag 事件 {stems,gets,hits,misses,loads}。 */
async function lastScanEvent() {
    const { status, json } = await api('GET', '/api/utopinn/diag/events?code=regex_index_scan&limit=50');
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
        if (process.env.REGEX_INDEX_DEBUG) process.stderr.write(`[srv] ${d}`);
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

const FIXTURE_SCRIPT = {
    id: 'rx-1', scriptName: 'greeting', findRegex: '/hi/g', replaceString: 'hello',
    placement: [2], disabled: false, markdownOnly: false, promptOnly: false,
    runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null,
};
const FIXTURE_SCRIPT_2 = { ...FIXTURE_SCRIPT, id: 'rx-2', scriptName: 'edited', replaceString: 'edited!' };

function writeJsonCard(charDir, name, { canonical = true, scripts = [FIXTURE_SCRIPT] } = {}) {
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: 'regex-index test fixture',
            personality: 'fixture',
            scenario: 'fixture',
            first_mes: 'hi',
            mes_example: '',
        },
    };
    // canonical: data.extensions.regex_scripts(V2);否则 root extensions(legacy 槽)
    const slot = { regex_scripts: scripts };
    if (canonical) card.data.extensions = slot; else card.extensions = slot;
    fs.writeFileSync(path.join(CHARS_DIR, `${charDir}.json`), JSON.stringify(card), 'utf8');
}

function seedCards() {
    fs.mkdirSync(CHARS_DIR, { recursive: true });
    for (let i = 0; i < PNG_CARD_COUNT; i++) {
        fs.copyFileSync(SEED_PNG, path.join(CHARS_DIR, `RegexPng${i}.png`));
    }
    writeJsonCard('RegexJsonCanonical', 'Canonical Card');
    writeJsonCard('RegexJsonRoot', 'Root Slot Card', { canonical: false });
    fs.writeFileSync(path.join(CHARS_DIR, 'BadWebp.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])); // 负缓存源
}

async function fetchFullView() {
    const t0 = performance.now();
    const { status, json } = await api('GET', '/api/utopinn/regex');
    const ms = performance.now() - t0;
    if (status !== 200) fail(`GET /regex status=${status} body=${JSON.stringify(json)?.slice(0, 300)}`);
    return { ...json, ms };
}

function charOf(chars, charDir) {
    return (chars ?? []).find((c) => c.charDir === charDir);
}

async function e2e() {
    seedCards();
    // 服务器可能自播种默认卡,断言一律按桩卡 charDir + 计数下限做
    const expectedStems = PNG_CARD_COUNT + 3; // 8 png + 2 json + 1 webp

    // -- 1) 冷全量:全部实解 ------------------------------------------------
    const cold = await fetchFullView();
    const coldScan = await lastScanEvent();
    log(`cold view: ${cold.chars.length} listed of ${coldScan?.stems} stems in ${cold.ms.toFixed(1)}ms; diag=${JSON.stringify(coldScan)}`);
    if (!coldScan || coldScan.stems < expectedStems) fail(`cold stems=${coldScan?.stems}, expected >=${expectedStems}`);
    if (coldScan.hits !== 0 || coldScan.misses < expectedStems - 1 /* webp stem 解析 2 文件? 见下 */) {
        fail(`cold scan expected hits=0 misses>=stems, got ${JSON.stringify(coldScan)}`);
    }
    const canon = charOf(cold.chars, 'RegexJsonCanonical');
    if (!canon || canon.name !== 'Canonical Card' || canon.count !== 1 || canon.scripts[0]?.id !== 'rx-1') {
        fail(`canonical card row: ${JSON.stringify(canon)}`);
    }
    if (canon.avatar !== 'RegexJsonCanonical.json') fail(`json-only card avatar=${canon.avatar}`);
    const root = charOf(cold.chars, 'RegexJsonRoot');
    if (!root || root.scripts[0]?.id !== 'rx-1') fail(`root-slot card row: ${JSON.stringify(root)}`);
    if (charOf(cold.chars, 'BadWebp')) fail('unparseable webp should not be listed');
    if (charOf(cold.chars, 'RegexPng0')) fail('script-less png should not be listed');

    // -- 2) 热全量:全命中零重解 --------------------------------------------
    const warm = await fetchFullView();
    const warmScan = await lastScanEvent();
    log(`warm view: ${warm.ms.toFixed(1)}ms; diag=${JSON.stringify(warmScan)}`);
    if (!warmScan || warmScan.misses !== 0) fail(`warm scan re-parsed: ${JSON.stringify(warmScan)}`);
    if (warmScan.hits !== coldScan.gets) fail(`warm hits=${warmScan.hits}, expected ${coldScan.gets} (bad webp 负缓存也算 hit)`);
    if (charOf(warm.chars, 'BadWebp')) fail('negative-cached webp leaked into view');
    log(`latency: cold=${cold.ms.toFixed(1)}ms warm=${warm.ms.toFixed(1)}ms speedup=${(cold.ms / Math.max(warm.ms, 0.01)).toFixed(1)}x`);

    // -- 3) scoped 视图:同一条索引 ------------------------------------------
    const scoped = await api('GET', '/api/utopinn/regex?scope=char&char=RegexJsonCanonical');
    if (scoped.status !== 200 || scoped.json.name !== 'Canonical Card' || scoped.json.scripts[0]?.id !== 'rx-1') {
        fail(`scoped view: status=${scoped.status} ${JSON.stringify(scoped.json)?.slice(0, 200)}`);
    }
    if (scoped.json.avatar !== 'RegexJsonCanonical.json') fail(`scoped avatar=${scoped.json.avatar}`);
    const missing = await api('GET', '/api/utopinn/regex?scope=char&char=NoSuchCard');
    if (missing.status !== 404) fail(`scoped missing card expected 404, got ${missing.status}`);

    // -- 4) PUT 写路径回填:写完下轮扫描 0 miss ------------------------------
    const put = await api('PUT', '/api/utopinn/regex', { scope: 'char', char: 'RegexPng0', scripts: [FIXTURE_SCRIPT] });
    if (put.status !== 200) fail(`PUT char scripts status=${put.status} body=${JSON.stringify(put.json)?.slice(0, 300)}`);
    const afterPut = await fetchFullView();
    const putScan = await lastScanEvent();
    const png0 = charOf(afterPut.chars, 'RegexPng0');
    if (!png0 || png0.count !== 1 || png0.scripts[0]?.id !== 'rx-1' || png0.avatar !== 'RegexPng0.png') {
        fail(`post-PUT png row: ${JSON.stringify(png0)}`);
    }
    if (!putScan || putScan.misses !== 0) fail(`post-PUT scan should be all hits (write-path refill), got ${JSON.stringify(putScan)}`);
    log(`post-PUT view: RegexPng0 listed with 1 script, scan=${JSON.stringify(putScan)}`);

    // -- 5) allow 放行无脚本卡 → 列出 count=0 --------------------------------
    const allow = await api('PUT', '/api/utopinn/regex', { scope: 'char', char: 'RegexPng1', allow: true });
    if (allow.status !== 200 || allow.json?.allow !== true) fail(`PUT allow status=${allow.status}`);
    const afterAllow = await fetchFullView();
    const png1 = charOf(afterAllow.chars, 'RegexPng1');
    if (!png1 || png1.count !== 0 || png1.allowed !== true) fail(`allowed png row: ${JSON.stringify(png1)}`);

    // -- 6) 外部直接改盘 JSON → 指纹失效,惰性重解 ---------------------------
    writeJsonCard('RegexJsonCanonical', 'Canonical Card', { scripts: [FIXTURE_SCRIPT, FIXTURE_SCRIPT_2] });
    const afterEdit = await fetchFullView();
    const editScan = await lastScanEvent();
    const edited = charOf(afterEdit.chars, 'RegexJsonCanonical');
    if (!edited || edited.count !== 2 || edited.scripts[1]?.id !== 'rx-2') {
        fail(`disk-edit not reflected: ${JSON.stringify(edited)}`);
    }
    if (!editScan || editScan.misses !== 1) fail(`post-edit expected misses=1, got ${JSON.stringify(editScan)}`);
    log(`post-edit view: 2 scripts, scan=${JSON.stringify(editScan)}`);

    // -- 7) utimes 摸 PNG(内容不动)→ stat 失效触发重解,数据不变 ------------
    const now = new Date();
    fs.utimesSync(path.join(CHARS_DIR, 'RegexPng0.png'), now, now);
    await fetchFullView();
    const touchScan = await lastScanEvent();
    if (!touchScan || touchScan.misses !== 1) fail(`utimes touch expected misses=1, got ${JSON.stringify(touchScan)}`);
    const png0After = charOf((await fetchFullView()).chars, 'RegexPng0');
    if (!png0After || png0After.count !== 1) fail(`touched png row drifted: ${JSON.stringify(png0After)}`);
    log(`post-touch scan=${JSON.stringify(touchScan)} (重解后内容不变)`);

    // -- 8) 删卡 → 全量视图消失;scoped 404 -----------------------------------
    fs.unlinkSync(path.join(CHARS_DIR, 'RegexJsonRoot.json'));
    const afterDelete = await fetchFullView();
    if (charOf(afterDelete.chars, 'RegexJsonRoot')) fail('deleted card still listed');
    const delScoped = await api('GET', '/api/utopinn/regex?scope=char&char=RegexJsonRoot');
    if (delScoped.status !== 404) fail(`scoped deleted card expected 404, got ${delScoped.status}`);

    // -- 9) PATCH 字段级 → 走同一写路径,下轮仍命中 ---------------------------
    const patch = await api('PATCH', `/api/utopinn/regex/rx-1?scope=char&char=RegexJsonCanonical`, { set: { scriptName: 'patched' } });
    if (patch.status !== 200 || patch.json?.script?.scriptName !== 'patched') {
        fail(`PATCH status=${patch.status} body=${JSON.stringify(patch.json)?.slice(0, 200)}`);
    }
    const afterPatch = await fetchFullView();
    const patchScan = await lastScanEvent();
    const patched = charOf(afterPatch.chars, 'RegexJsonCanonical');
    if (!patched || patched.scripts[0]?.scriptName !== 'patched') fail(`PATCH not reflected: ${JSON.stringify(patched)}`);
    if (!patchScan || patchScan.misses !== 0) fail(`post-PATCH expected refill-hit misses=0, got ${JSON.stringify(patchScan)}`);

    log('ALL CHECKS PASSED');
}

async function main() {
    log(`scratch=${SCRATCH} runtime=${process.execPath} v${process.version}`);
    await unitTests();
    await startServer();
    try {
        await e2e();
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
        console.error('[regex-index] FAILED:', error?.stack ?? error);
        if (server) {
            const tail = server.output().split('\n').slice(-30).join('\n');
            if (tail.trim()) console.error('--- server output tail ---\n' + tail);
        }
        await stopServer();
        try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best-effort */ }
        process.exit(1);
    },
);
