/**
 * kernel-boot —— 服务端 Cordis 装配点(B 步)。
 *
 * createAppContext() 立根 context + ServiceCatalog;
 * webServer 服务立在这里,插件清单经 profile.yaml + loadProfileFile
 * 声明式装载(DSH cordis.yml 同形):每行状态(active/degraded/
 * disabled/failed)打到日志,degraded 不静默不连坐。
 *
 * profile.patch.yaml —— 运行时覆盖层(enable/disable 持久化在这,
 * 不动基座清单;applyPatch 语义 = 按 id 整行替换)。
 *
 * pluginManager 服务(TASK-021 执行面):
 *   list()                      合并态清单(profile × patch × 运行时)
 *   disable(id)/enable(id)      patch 落盘 + fiber dispose / 重新 ctx.plugin
 *   reload(id)                  dispose + cache-bust 重导入 + 重新 apply
 *   —— 必须先于 loadProfileFile provide,否则 inject 等位失败。
 *
 * 顶层 await:ESM TLA,server-startup import 本模块时自然等插件就绪
 * —— Express 挂载 dispatcher 之前路由表已就位,无启动竞态。
 *
 * 对外只出两样:
 *   webServer.middleware()   → server-startup.js 挂进 Express
 *                              (/api/uberge 面已 100% 插件化;未命中
 *                               next() 继续向后走)
 *   webServer.upgradeListener() → server-main.js 挂 httpServer 'upgrade'
 *                              (/api/ws-delivery 经 registerUpgrade 贡献)
 */
import { createAppContext, WebServer, loadProfileFile, importPluginModule, applyPatch, loadYaml, dumpYaml } from '@uberge/kernel';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

export const appCtx = createAppContext();

appCtx.provide('webServer', new WebServer());
// cordis provide 管注入语义,catalog 管归属可见性 —— 两个都要
appCtx.catalog.register({ role: 'core', name: 'webServer', providedBy: 'kernel-boot' });
export const webServer = appCtx.webServer;

const here = dirname(fileURLToPath(import.meta.url));
const profilePath = join(here, 'profile.yaml');
const patchPath = join(here, 'profile.patch.yaml');
const baseProfile = loadYaml(await readFile(profilePath, 'utf8'));

// ---------------------------------------------------------------------------
// pluginManager —— 先于装载 provide(插件 inject 它),装载后回填 fibers/results
// ---------------------------------------------------------------------------

const fibers = new Map();   // id → Fiber
const results = new Map();  // id → LoadedPlugin

async function readPatchRows() {
    if (!existsSync(patchPath)) return [];
    const doc = loadYaml(await readFile(patchPath, 'utf8'));
    return doc?.plugins ?? [];
}

function mergedRows(patchRows) {
    return applyPatch(baseProfile.plugins ?? [], patchRows);
}

async function upsertPatchRow(row) {
    const rows = await readPatchRows();
    const i = rows.findIndex((r) => r.id === row.id);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    await writeFile(patchPath, dumpYaml({ plugins: rows }), 'utf8');
}

async function applyRow(row) {
    const mod = await importPluginModule(row, here, String(Date.now()));
    const plugin = mod.apply ? { ...mod, name: mod.name ?? row.id } : mod;
    const fiber = appCtx.plugin(plugin, row.config);
    fibers.set(row.id, fiber);
    results.set(row.id, { id: row.id, status: 'active', fiber });
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
            };
        });
    },

    /** 返回合并行或 undefined */
    async row(id) {
        return mergedRows(await readPatchRows()).find((r) => r.id === id);
    },

    async disable(id) {
        const row = await this.row(id);
        if (!row) return { ok: false, code: 404, error: `no such plugin: ${id}` };
        await upsertPatchRow({ ...row, disabled: true });
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
        await upsertPatchRow({ ...row, disabled: false });
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
}
for (const r of loaded) {
    results.set(r.id, r);
    if (r.fiber) fibers.set(r.id, r.fiber);
}
const failed = loaded.filter((r) => r.status === 'failed');
if (failed.length) {
    console.warn(`[kernel] ${failed.length} plugin(s) failed to load — degraded surface, not fatal`);
}
