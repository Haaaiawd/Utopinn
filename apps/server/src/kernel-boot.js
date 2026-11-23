/**
 * kernel-boot —— 服务端 Cordis 装配点(B 步)。
 *
 * createAppContext() 立根 context + ServiceCatalog;
 * webServer 服务立在这里,插件清单经 profile.yaml + loadProfileFile
 * 声明式装载(DSH cordis.yml 同形):每行状态(active/degraded/
 * disabled/failed)打到日志,degraded 不静默不连坐。
 *
 * profile.patch.yaml —— 运行时覆盖层(enable/disable 持久化在这,
 * 不动基座清单;行 = {id, disabled} 增量,按 id 叠回 base 行)。
 *
 * pluginManager 服务(TASK-021 执行面):
 *   list()                      合并态清单(profile × patch × 运行时)
 *   disable(id)/enable(id)      patch 落盘 + fiber dispose / 重新 ctx.plugin
 *   reload(id)                  dispose + cache-bust 重导入 + 重新 apply
 *   module(id)                  活模块实例(W5;读面吃运行中声明,disabled/failed 无)
 *   —— 必须先于 loadProfileFile provide,否则 inject 等位失败。
 *
 * 顶层 await:ESM TLA,server-startup import 本模块时自然等插件就绪
 * —— Express 挂载 dispatcher 之前路由表已就位,无启动竞态。
 *
 * 对外只出两样:
 *   webServer.middleware()   → server-startup.js 挂进 Express
 *                              (/api/utopinn 面已 100% 插件化;未命中
 *                               next() 继续向后走)
 *   webServer.upgradeListener() → server-main.js 挂 httpServer 'upgrade'
 *                              (/api/ws-delivery 经 registerUpgrade 贡献)
 */
import { createAppContext, WebServer, loadProfileFile, importPluginModule, loadYaml, dumpYaml } from '@utopinn/kernel';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { emit as diagEmit } from './services/diag-bus.js';

export const appCtx = createAppContext();

const webServerInstance = new WebServer();
// 诊断统一挂钩:所有经 webServer.register 的路由缠一层 finish 监听——
// 响应落地时 statusCode>=400 即向 diag-bus 发 http 事件(路由+status)。
// 单点挂载,路由 handler 与 middleware 的 4xx/5xx 产出路径全覆盖,
// 插件不需要各自埋点;成功响应零事件(观测面只收异常)。
const _registerRoute = webServerInstance.register.bind(webServerInstance);
webServerInstance.register = (route) => _registerRoute({
    ...route,
    handler: (req, res) => {
        try {
            if (typeof res?.once === 'function') {
                res.once('finish', () => {
                    try {
                        const status = Number(res.statusCode ?? 0);
                        if (status >= 400) {
                            const path = String(req.url ?? '').split('?')[0];
                            diagEmit({
                                lvl: status >= 500 ? 'error' : 'warn',
                                kind: 'http',
                                code: `http_${status}`,
                                msg: `${req.method ?? 'GET'} ${path} → ${status}`,
                                ctx: { route: route.path, method: req.method, path, status },
                            });
                        }
                    } catch { /* 观测面绝不炸响应收尾 */ }
                });
            }
        } catch { /* res 非 EventEmitter 的边角不炸路由 */ }
        return route.handler(req, res);
    },
});
appCtx.provide('webServer', webServerInstance);
// cordis provide 管注入语义,catalog 管归属可见性 —— 两个都要
appCtx.catalog.register({ role: 'core', name: 'webServer', providedBy: 'kernel-boot' });
export const webServer = appCtx.webServer;

const here = dirname(fileURLToPath(import.meta.url));
const profilePath = join(here, 'profile.yaml');
// patch 是运行时面(toggle 会写):Docker/只读镜像部署下源码目录不可写,
// 可变副本落到 dataRoot;读时 dataRoot 优先、回落镜像内文件——
// 旧部署留在源码旁的 patch 不丢,首次 upsert 会带着旧行整体落进 dataRoot。
const bundledPatchPath = join(here, 'profile.patch.yaml');
const patchPath = join(globalThis.DATA_ROOT || here, 'profile.patch.yaml');
const baseProfile = loadYaml(await readFile(profilePath, 'utf8'));

// ---------------------------------------------------------------------------
// pluginManager —— 先于装载 provide(插件 inject 它),装载后回填 fibers/results
// ---------------------------------------------------------------------------

const fibers = new Map();   // id → Fiber
const results = new Map();  // id → LoadedPlugin

async function readPatchRows() {
    const src = existsSync(patchPath) ? patchPath : bundledPatchPath;
    if (!existsSync(src)) return [];
    const doc = loadYaml(await readFile(src, 'utf8'));
    return doc?.plugins ?? [];
}

// Patch 语义(2026-11 修正):patch 行只承载 {id, disabled} 增量 ——
// 旧实现整行替换,module/config 的快照会永久遮蔽 base profile 的后续
// 变更;且 enable 面可复活已从 base 删除的插件(module 注入面)。
// base 缺失 id 的 patch 行直接忽略。旧部署遗留的整行 patch 仍兼容
// (这里只读 .disabled),下次 upsert 自动落成增量形。
function mergedRows(patchRows) {
    const disabledById = new Map(patchRows.map((r) => [r.id, r.disabled]));
    return (baseProfile.plugins ?? []).map((row) => {
        const disabled = disabledById.get(row.id);
        return disabled === undefined ? row : { ...row, disabled: !!disabled };
    });
}

let patchTail = Promise.resolve();

async function upsertPatchRow(id, disabled) {
    const next = patchTail.then(async () => {
        const rows = await readPatchRows();
        const i = rows.findIndex((r) => r.id === id);
        const row = { id, disabled };
        if (i >= 0) rows[i] = row;
        else rows.push(row);
        // 原子写:tmp+rename,避免崩溃留半文件 → 下次启动 loadYaml 抛错。
        await mkdir(dirname(patchPath), { recursive: true });
        const tmp = `${patchPath}.${process.pid}.tmp`;
        await writeFile(tmp, dumpYaml({ plugins: rows }), 'utf8');
        await rename(tmp, patchPath);
    });
    patchTail = next.then(() => undefined, () => undefined);
    return next;
}

async function applyRow(row) {
    const mod = await importPluginModule(row, here, String(Date.now()));
    const plugin = mod.apply ? { ...mod, name: mod.name ?? row.id } : mod;
    const fiber = appCtx.plugin(plugin, row.config);
    fibers.set(row.id, fiber);
    results.set(row.id, { id: row.id, status: 'active', fiber, module: mod });
    // cordis 4:返回值 thenable 暴露 fiber.await() —— async apply() reject 在此抛出。
    await fiber;
    return fiber;
}

// cordis FiberState 数字面(cordis 4 fiber.d.ts const enum)。
const FIBER_STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'];

export const pluginManager = {
    async list() {
        const patchRows = await readPatchRows();
        return mergedRows(patchRows).map((row) => {
            const rt = results.get(row.id);
            // fiber 在场时读活状态:装载后 async 失败的插件不该报 active。
            const liveStatus = rt?.fiber && typeof rt.fiber.state === 'number'
                ? (FIBER_STATES[rt.fiber.state] ?? 'unknown')
                : (rt?.status ?? 'unknown');
            return {
                id: row.id,
                module: typeof row.module === 'string' ? row.module : '<inline>',
                disabled: !!row.disabled,
                status: row.disabled ? 'disabled' : liveStatus,
                reason: rt?.reason,
                patch: patchRows.some((p) => p.id === row.id),
                // profile 行 core:true —— 锁定的唯一真相源(disable() 闸也读它);
                // 透出给管理面/UI 贡献标记,不再由消费侧各养一份 id 表。
                core: row.core === true,
            };
        });
    },

    /** 返回合并行或 undefined */
    async row(id) {
        return mergedRows(await readPatchRows()).find((r) => r.id === id);
    },

    /**
     * 活模块实例句柄(W5):contrib 等读面吃"运行中代码的声明",不为读
     * manifest 再造第二个 ESM 实例。disabled/failed 的 results 行天然无
     * module 字段 → undefined;reload 后返回新实例。只读约定,勿改模块状态。
     */
    module(id) {
        return results.get(id)?.module;
    },

    async disable(id) {
        const row = await this.row(id);
        if (!row) return { ok: false, code: 404, error: `no such plugin: ${id}` };
        if (row.core === true) return { ok: false, code: 400, error: `plugin ${id} is core and cannot be disabled` };
        await upsertPatchRow(row.id, true);
        const fiber = fibers.get(id);
        if (fiber) {
            await fiber.dispose();
            fibers.delete(id);
        }
        results.set(id, { id, status: 'disabled' });
        return { ok: true, id, status: 'disabled' };
    },

    async enable(id) {
        const row = await this.row(id);
        if (!row) return { ok: false, code: 404, error: `no such plugin: ${id}` };
        if (typeof row.module !== 'string') {
            return { ok: false, code: 400, error: `plugin ${id} has no importable module` };
        }
        await upsertPatchRow(row.id, false);
        try {
            await applyRow({ ...row, disabled: false });
            return { ok: true, id, status: 'active' };
        } catch (e) {
            results.set(id, { id, status: 'failed', reason: e.message });
            return { ok: false, code: 500, error: e.message };
        }
    },

    async reload(id) {
        const row = await this.row(id);
        if (!row) return { ok: false, code: 404, error: `no such plugin: ${id}` };
        if (row.disabled) return { ok: false, code: 400, error: `plugin ${id} is disabled` };
        const fiber = fibers.get(id);
        if (fiber) {
            await fiber.dispose();
            fibers.delete(id);
        }
        try {
            await applyRow(row);
            return { ok: true, id, status: 'active' };
        } catch (e) {
            results.set(id, { id, status: 'failed', reason: e.message });
            return { ok: false, code: 500, error: e.message };
        }
    },
};

/** 关机 drain:反序 dispose 全部插件 fiber(ctx.effect 清理面全跑:路由摘除/定时器/WS 终止/写冲刷)。 */
export async function shutdownKernelFibers() {
    const entries = [...fibers.entries()].reverse();
    for (const [id, fiber] of entries) {
        try {
            await fiber.dispose();
        } catch (e) {
            console.warn(`[kernel] fiber ${id} dispose failed:`, e?.message ?? e);
        }
        fibers.delete(id);
    }
}

appCtx.provide('pluginManager', pluginManager);
appCtx.catalog.register({ role: 'core', name: 'pluginManager', providedBy: 'kernel-boot' });

// ---------------------------------------------------------------------------
// 声明式装载
// ---------------------------------------------------------------------------

const loaded = await loadProfileFile(appCtx, profilePath, existsSync(patchPath) ? patchPath : undefined);
for (const row of loaded) {
    const line = `[kernel] plugin ${row.id}: ${row.status}${row.reason ? ` (${row.reason})` : ''}`;
    if (row.status === 'active') console.info(line);
    else console.warn(line);
    diagEmit({
        lvl: row.status === 'active' ? 'info' : 'warn',
        kind: 'plugin',
        code: `plugin_${row.status}`,
        msg: line.replace(/^\[kernel\] /, ''),
        ctx: { plugin: row.id },
        ...(row.reason ? { data: { reason: String(row.reason).slice(0, 300) } } : {}),
    });
}
for (const r of loaded) {
    results.set(r.id, r);
    if (r.fiber) fibers.set(r.id, r.fiber);
}
const failed = loaded.filter((r) => r.status === 'failed');
if (failed.length) {
    console.warn(`[kernel] ${failed.length} plugin(s) failed to load — degraded surface, not fatal`);
}
