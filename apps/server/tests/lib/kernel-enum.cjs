/**
 * kernel-enum —— 防漂移测试共享件:起一台隔离 kernel 服,经
 * GET /api/utopinn/_kernel 取 webServer.list() 路由全集
 * ("METHOD|kind|path" 串 + "upgrade|path" 升级位)。
 *
 * 复用 e2e harness(tests/e2e/_lib/server.js):克隆 data/ 种子 +
 * OS 空端口 + 就绪轮询。LUKER_SKIP_WEBPACK=1 + LUKER_SERVE_LEGACY=0
 * → kernel-only 启动,不碰 webpack/legacy UI。
 *
 * scratch 默认落 os.tmpdir():/mnt 盘是 9P 挂载,高并发 I/O 会楔死
 * (AGENTS.md 运维备忘);外层可用 E2E_SCRATCH_ROOT 覆盖。
 */
'use strict';
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const HERE = __dirname;                        // tests/lib
const SERVER_DIR = resolve(HERE, '..', '..');  // apps/server
const KERNEL_URL = '/api/utopinn/_kernel';

/**
 * 起隔离服并取路由表。
 * @returns {Promise<{ handle: object, base: string, routes: string[], stop: () => Promise<void> }>}
 *   routes = kernel webServer.list() 原始串数组(含 "upgrade|" 行)。
 */
async function bootKernelRoutes() {
    // harness 在模块顶层读 E2E_SCRATCH_ROOT —— 必须先于 dynamic import。
    process.env.E2E_SCRATCH_ROOT ||= join(tmpdir(), 'utopinn-drift-scratch');
    process.env.E2E_READY_TIMEOUT_MS ||= '120000';
    const harnessUrl = pathToFileURL(resolve(HERE, '..', 'e2e', '_lib', 'server.js')).href;
    const { startServer, tearDownServer } = await import(harnessUrl);

    const handle = await startServer({
        batchKey: 'server',
        scenarioId: `drift-enum-${process.pid}`,
        extraEnv: {
            // kernel-only:路由表不需要 legacy UI 与前端 bundle。
            LUKER_SKIP_WEBPACK: '1',
            LUKER_SERVE_LEGACY: '0',
            NO_PROXY: 'localhost,127.0.0.1',
            no_proxy: 'localhost,127.0.0.1',
        },
    });
    const base = handle.baseURL;
    const stop = async () => { await tearDownServer(handle); };

    // harness 只轮询 /;kernel dispatcher 是 TLA 插件装载,二次确认
    // _kernel 就位(enableUserAccounts=false 种子下该 GET 无需会话)。
    const deadline = Date.now() + 60_000;
    let routes = null;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${base}${KERNEL_URL}`);
            if (response.ok) {
                const data = await response.json();
                routes = (data?.routes ?? []).map(String);
                break;
            }
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(r => setTimeout(r, 300));
    }
    if (!routes) {
        await stop();
        throw new Error(`kernel ${KERNEL_URL} 60s 内未就绪: ${lastError?.message ?? 'unknown'}`);
    }
    return { handle, base, routes, stop };
}

/**
 * "METHOD|kind|path" → { key, method, kind, path };"upgrade|…" 行 → null。
 */
function parseKernelRoute(entry) {
    const s = String(entry);
    if (s.startsWith('upgrade|')) return null;
    const i = s.indexOf('|');
    const j = s.indexOf('|', i + 1);
    if (i < 0 || j < 0) return null;
    return { key: s, method: s.slice(0, i), kind: s.slice(i + 1, j), path: s.slice(j + 1) };
}

/**
 * 路由表里的注册路径 → 一条可喂给 matchGatedRoute() 的代表请求路径:
 *   pattern 的 ":param" 段填占位符;prefix 补一段子路径(闸表按完整
 *   请求路径匹配,prefix 位真正到达的请求一定多一段)。
 */
function probePath(routePath, kind) {
    let p = routePath.split('/').map(seg => (seg.startsWith(':') ? 'x' : seg)).join('/');
    if (kind === 'prefix') p = `${p.replace(/\/+$/, '')}/x`;
    return p;
}

module.exports = { bootKernelRoutes, parseKernelRoute, probePath, SERVER_DIR };
