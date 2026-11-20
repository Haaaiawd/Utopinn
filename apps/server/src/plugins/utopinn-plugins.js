/**
 * utopinn-plugins —— 插件管理 API(TASK-021 服务端执行面)。
 *
 *   GET  /api/utopinn/plugins              合并态清单(profile × patch × 运行时)
 *   POST /api/utopinn/plugins/:id/enable   patch 落盘 disabled:false + 重新 apply
 *   POST /api/utopinn/plugins/:id/disable  patch 落盘 disabled:true + fiber.dispose()
 *   POST /api/utopinn/plugins/:id/reload   dispose + cache-bust 重导入 + apply
 *   GET  /api/utopinn/ui/contrib           插件 UI 贡献点清单(§C-12 manifest 面)
 *
 * ui/contrib —— Cordis 贡献槽的服务端面(plugin-architecture §插件UI贡献点):
 *   插件模块可声明
 *       export const ui = { contrib: [{ slot, contribution }] }
 *   (兼容 export const meta = { ui: { contrib } } 形,以及 { slot: contribution }
 *   映射速写)。contribution 只过 JSON 可序列化载荷 —— 客户端渲染声明,不执行
 *   插件 JS;函数/循环引用等非线形条目静默摘除。
 *   slot 词表归前端 apps/web/src/kernel/contributions.ts(nav.rail / view /
 *   sidebar.tree / stage.form / panel.type / renderer / ctbar.chat / locale),
 *   declare-merge 可扩 —— 服务端不钉死校验,未知 slot 原样透传,词表随响应
 *   slots 字段带出当参照。
 *   内核件声明写在 BUILTIN_CONTRIB 常量(面板宿主是前端本地组件,服务端只补
 *   「谁供了这块板」的归属映射);CORE_PLUGINS 的贡献项带 core:true —— 对照
 *   前端要锁定的件(library/generate/delivery/diag)。disabled 行只回 BUILTIN
 *   声明 + disabled 位,不 import 模块 —— 关掉的插件不跑它顶层代码。
 *
 * 自锁保护:本插件的 disable/reload 会拆了自己的路由面(或把自己关进
 * disabled 而无路可开)—— 一律 400 拒绝;真要关它,改 profile.patch.yaml。
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPluginModule } from '@utopinn/kernel';

export const inject = ['webServer', 'pluginManager'];

const SELF = 'utopinn-plugins';

/** profile.yaml 所在目录(本文件在 src/plugins/,模块 specifier 相对 src/ 解析)。 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 贡献槽词表 —— 与 apps/web/src/kernel/contributions.ts 的 Contributions
 * 映射表一一对应;前端 declare-merge 可扩,这里只当参照词表带出,不做硬校验。
 */
const KNOWN_SLOTS = [
    'nav.rail', 'view', 'sidebar.tree', 'stage.form',
    'panel.type', 'renderer', 'ctbar.chat', 'locale',
];

/** 内核锁定件:这些插件的贡献项带 core:true(前端不可卸的面)。 */
const CORE_PLUGINS = new Set([
    'utopinn-library', 'utopinn-generate', 'utopinn-delivery', 'utopinn-diag',
]);

/**
 * 内核件贡献声明 —— 面板 Body 是前端本地组件,这里登记的是「服务端插件 →
 * 前端板块」的归属映射(plugin 详情/市场面的清单数据源)。元数据镜像前端
 * panels feature 的注册值,不是另一套词。
 */
const BUILTIN_CONTRIB = {
    'utopinn-diag': [
        { slot: 'panel.type', contribution: { type: 'diag', icon: 'code', wired: true, badge: 'diag', category: 'system', desc: 'panel.desc.diag' } },
    ],
    'utopinn-stats': [
        { slot: 'panel.type', contribution: { type: 'stats', icon: 'compass', wired: true, badge: 'stats', category: 'system', desc: 'panel.desc.stats' } },
    ],
    'utopinn-mvu': [
        { slot: 'panel.type', contribution: { type: 'mvu', icon: 'database', wired: true, category: 'system', desc: 'panel.desc.mvu' } },
    ],
};

/** contribution 必须能上线:JSON round-trip 掉函数/undefined/循环引用。 */
function wireSafe(value) {
    if (!value || typeof value !== 'object') return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

/**
 * manifest 读取:mod.ui.contrib / mod.meta.ui.contrib 两形都认;
 * 值接受 [{slot,contribution}] 数组或 {slot:contribution} 映射。
 * 返回 [{slot, contribution}] —— 逐条 wireSafe 由调用方做。
 */
function readManifestContrib(mod) {
    const raw = mod?.ui?.contrib ?? mod?.meta?.ui?.contrib;
    const out = [];
    if (Array.isArray(raw)) {
        for (const e of raw) {
            if (!e || typeof e !== 'object') continue;
            const slot = typeof e.slot === 'string' ? e.slot : '';
            const contribution = e.contribution ?? e.payload;
            if (slot && contribution && typeof contribution === 'object') {
                out.push({ slot, contribution });
            }
        }
    } else if (raw && typeof raw === 'object') {
        for (const [slot, contribution] of Object.entries(raw)) {
            if (contribution && typeof contribution === 'object') {
                out.push({ slot, contribution });
            }
        }
    }
    return out;
}

/**
 * profile 行 → 模块对象(manifest 读取用,不跑 apply)。
 * 相对 specifier 按 mtime 缓存:文件没变 → 复用已导入模块;编辑/reload 后
 * mtime 变 → cache-bust 重导入,manifest 跟盘不跟运行时快照。每文件版本至多
 * 一个模块实例 —— 不按请求 bust(?t= 每发一次是一个永不回收的 ESM 实例,
 * 观测面被轮询时会慢性漏)。裸 specifier/<inline> 行无法 stat,走普通导入。
 * import 失败(failed/坏 specifier)回 null,不连坐。
 */
const manifestCache = new Map(); // specifier → {mtimeMs, mod}
async function importRowModule(row) {
    const spec = row?.module;
    if (typeof spec !== 'string' || spec === '<inline>') return null;
    if (!spec.startsWith('.')) {
        try { return await importPluginModule(row, SRC_DIR); } catch { return null; }
    }
    let mtimeMs;
    try {
        mtimeMs = statSync(join(SRC_DIR, spec)).mtimeMs;
    } catch {
        return null;
    }
    const cached = manifestCache.get(spec);
    if (cached && cached.mtimeMs === mtimeMs) return cached.mod;
    try {
        const mod = await importPluginModule(row, SRC_DIR, `${mtimeMs}`);
        manifestCache.set(spec, { mtimeMs, mod });
        return mod;
    } catch {
        return null;
    }
}

export function apply(ctx) {
    const pm = ctx.pluginManager;
    const reg = (path, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));

    ctx.effect(() => ctx.webServer.register({
        kind: 'pattern',
        method: 'GET',
        path: '/api/utopinn/plugins',
        handler: async function (request, response) {
            if (!request.user?.profile?.admin) {
                return response.status(403).send({ error: 'Unauthorized' });
            }
            return response.send({ items: await pm.list() });
        },
    }));

    /**
     * GET /api/utopinn/ui/contrib —— 合并态贡献清单:
     *   BUILTIN_CONTRIB(内核件常量)× 模块 manifest(ui.contrib/meta.ui.contrib)。
     *   {items:[{plugin, slot, contribution, core?, disabled?}], slots:[词表]}
     *   无插件声明时 items 即内核件映射;全无 → {items:[]}。
     */
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        method: 'GET',
        path: '/api/utopinn/ui/contrib',
        handler: async function (request, response) {
            if (!request.user?.profile?.admin) {
                return response.status(403).send({ error: 'Unauthorized' });
            }
            const items = [];
            const seen = new Set();
            for (const row of await pm.list()) {
                const entries = [...(BUILTIN_CONTRIB[row.id] ?? [])];
                if (!row.disabled) {
                    entries.push(...readManifestContrib(await importRowModule(row)));
                }
                for (const e of entries) {
                    const contribution = wireSafe(e.contribution);
                    if (!contribution) continue;
                    const key = `${row.id}${e.slot}${JSON.stringify(contribution)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    items.push({
                        plugin: row.id,
                        slot: e.slot,
                        contribution,
                        ...(CORE_PLUGINS.has(row.id) ? { core: true } : {}),
                        ...(row.disabled ? { disabled: true } : {}),
                    });
                }
            }
            return response.send({ items, slots: KNOWN_SLOTS });
        },
    }));

    const act = (verb) => async function (request, response) {
        if (!request.user?.profile?.admin) {
            return response.status(403).send({ error: 'Unauthorized' });
        }
        const id = request.params?.id;
        if (id === SELF && verb !== 'enable') {
            return response.status(400).send({ error: `cannot ${verb} the plugin manager itself` });
        }
        const r = await pm[verb](id);
        if (!r.ok) return response.status(r.code ?? 500).send({ error: r.error });
        return response.send(r);
    };

    reg('/api/utopinn/plugins/:id/enable', act('enable'));
    reg('/api/utopinn/plugins/:id/disable', act('disable'));
    reg('/api/utopinn/plugins/:id/reload', act('reload'));
}
