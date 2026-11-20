import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import type { AppContext } from './context.js';
import type { PluginEntry, PluginModule } from './plugin.js';

/**
 * 组合语义(DSH 式):
 *   profile = 插件行的有序列表;patch = 按 id 整体替换/追加/禁用行
 *   装载顺序 = 列表顺序;inject 缺失 → degraded(记录不崩),非静默
 */

export interface LoadedPlugin {
    id: string;
    status: 'active' | 'degraded' | 'disabled' | 'failed';
    reason?: string;
    /** ctx.plugin 返回的 Fiber —— 管理面 enable/disable/reload 靠它 dispose */
    fiber?: { dispose(): Promise<void> };
    /**
     * 活模块实例(W5)—— 观测面(contrib manifest 等)读"运行中代码的声明",
     * 不做第二次 import(双 ESM 实例:顶层副作用跑两遍、读面与运行面漂移)。
     * 仅 active 行携带;disabled/failed/degraded 天然无句柄。
     */
    module?: PluginModule;
}

export interface Profile {
    name: string;
    plugins: PluginEntry[];
}

/** patch 层应用:按 id 整行替换;新 id 追加;disabled 行保留位但不装载 */
export function applyPatch(base: PluginEntry[], patch: PluginEntry[]): PluginEntry[] {
    const rows = [...base];
    for (const p of patch) {
        const i = rows.findIndex((r) => r.id === p.id);
        if (i >= 0) rows[i] = p;
        else rows.push(p);
    }
    return rows;
}

async function resolveModule(
    entry: PluginEntry,
    baseDir?: string,
): Promise<PluginModule | ((ctx: unknown, config: unknown) => void)> {
    if (typeof entry.module === 'string') {
        const spec =
            baseDir && entry.module.startsWith('.')
                ? pathToFileURL(resolve(baseDir, entry.module)).href
                : entry.module;
        const mod = (await import(spec)) as PluginModule;
        return (mod.default ?? mod) as PluginModule;
    }
    return entry.module;
}

function normalize(mod: PluginModule | ((ctx: unknown, config: unknown) => void)): PluginModule {
    if (typeof mod === 'function') {
        return { apply: mod as (ctx: unknown, config: unknown) => void };
    }
    return mod;
}

/** 管理面 enable/reload 复用:按 profile 行解析 + 归一化模块(bust 供 reload 绕过 ESM 缓存) */
export async function importPluginModule(
    entry: PluginEntry,
    baseDir?: string,
    bust?: string,
): Promise<PluginModule> {
    if (typeof entry.module === 'string' && bust) {
        const spec =
            baseDir && entry.module.startsWith('.')
                ? `${pathToFileURL(resolve(baseDir, entry.module)).href}?t=${bust}`
                : `${entry.module}?t=${bust}`;
        const mod = (await import(spec)) as PluginModule;
        return normalize((mod.default ?? mod) as PluginModule);
    }
    return normalize(await resolveModule(entry, baseDir));
}

/**
 * 有序装载 profile。inject 声明的服务在装配时检查:
 * 缺失 → status=degraded 记录原因,插件不装载,继续后续行(不静默、不全崩)。
 */
export async function loadProfile(
    ctx: AppContext,
    profile: Profile,
    patch: PluginEntry[] = [],
    baseDir?: string,
): Promise<LoadedPlugin[]> {
    const rows = applyPatch(profile.plugins, patch);
    const results: LoadedPlugin[] = [];

    for (const row of rows) {
        if (row.disabled) {
            results.push({ id: row.id, status: 'disabled' });
            continue;
        }

        let mod: PluginModule;
        try {
            mod = normalize(await resolveModule(row, baseDir));
        } catch (e) {
            results.push({ id: row.id, status: 'failed', reason: `import: ${(e as Error).message}` });
            continue;
        }

        const injectList = Array.isArray(mod.inject)
            ? mod.inject
            : Object.keys(mod.inject ?? {});
        const missing = injectList.filter(
            (svc) => (ctx as unknown as Record<string, unknown>)[svc] === undefined,
        );
        if (missing.length) {
            results.push({
                id: row.id,
                status: 'degraded',
                reason: `missing inject: ${missing.join(', ')}`,
            });
            continue;
        }

        try {
            const plugin = mod.apply
                ? { ...mod, name: mod.name ?? row.id }
                : mod;
            // cordis Plugin 泛型按模块形状推断 config 元组;profile 行 config 恒为 Record,走宽松通道
            const fiber = (ctx.plugin as (p: unknown, c?: unknown) => { dispose(): Promise<void> })(
                plugin,
                row.config,
            );
            // cordis 4:ctx.plugin() 返回 thenable —— await 走 fiber.await(),
            // async apply() 的 reject 会在这里抛出;不 await 则假 active。
            await (fiber as unknown as PromiseLike<unknown>);
            results.push({ id: row.id, status: 'active', fiber, module: mod });
        } catch (e) {
            results.push({ id: row.id, status: 'failed', reason: (e as Error).message });
        }
    }
    return results;
}

/**
 * profile.yaml 装载(DSH cordis.yml 同形):
 *   name: my-profile
 *   plugins:
 *     - id: tavern-core
 *       module: ../plugins/tavern-core/dist/index.js   # import specifier
 *       config: { ... }
 *     - id: some-opt
 *       module: '...'
 *       disabled: true
 * patch 文件同形(plugins 数组),按 id 替换/追加/禁用。
 */
export async function loadProfileFile(
    ctx: AppContext,
    profilePath: string,
    patchPath?: string,
): Promise<LoadedPlugin[]> {
    const profile = loadYaml(await readFile(profilePath, 'utf8')) as Profile;
    const patch = patchPath
        ? ((loadYaml(await readFile(patchPath, 'utf8')) as { plugins?: PluginEntry[] }).plugins ?? [])
        : [];
    return loadProfile(ctx, profile, patch, dirname(profilePath));
}

/** yaml 透出 —— 管理面写 patch 文件用(server 侧无 js-yaml 依赖) */
export { loadYaml, dumpYaml };

/** --dump-config:当前组合的可视化(调试/文档用) */
export function dumpConfig(profile: Profile, patch: PluginEntry[] = []): string {
    const rows = applyPatch(profile.plugins, patch);
    return rows
        .map((r) => `${r.disabled ? '- ' : '+ '}${r.id}${typeof r.module === 'string' ? ` <- ${r.module}` : ''}`)
        .join('\n');
}
