// 规范稿 plugins 域(renderPluginsMain + renderPluginsSections)—— 真服务端面。
// 数据全部走 /api/utopinn/plugins(TASK-021 管理面):
//   · 内核锁定段 = 服务端 CORE_PLUGINS ∪ 自锁件(utopinn-plugins 拒自己的
//     disable/reload),清单来自真 list,锁定身份与后端同一集合;
//   · 可停用段 = enable/disable/reload 真写面,status/patch 原样透显;
//   · 市场段 = ui.contrib 读面有、安装面未备(C12)—— 目录行渲染「已内置 /
//     计划中」徽标,不做假安装钮。
// PluginsSections 与 settings 的「Cordis 插件」页签共享(规范稿同一函数两处用)。
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { PanelError, useRemote, type Remote } from '../panels/panelShared';
import { disablePlugin, enablePlugin, listPlugins, reloadPlugin, type PluginItem } from '../../api/plugins';
import { MOCK_MARKET_PLUGINS } from '../../api/mock';

/* ------------------------------------------------------------------ */
/* 服务端插件 id → 展示元数据(规范稿 BUILTIN/CORE 插件表的落地形)。          */
/* 集合判定看真 list;这里只管图标/中文名/描述 —— 未登记的 id 原样显示。    */
/* ------------------------------------------------------------------ */

interface PluginMeta { icon: IconName; label?: string; desc?: string }

const PLUGIN_META: Record<string, PluginMeta> = {
    'utopinn-library': { icon: 'bookOpen', desc: '角色卡、世界书、预设与人设核心读写域' },
    'utopinn-generate': { icon: 'cpu', desc: 'Prompt 组装、流式生成与 Jobs 调度中枢' },
    'utopinn-diag': { icon: 'code', desc: 'diag-bus 事件、报错与 Trace 时序采集' },
    'utopinn-delivery': { icon: 'radio', desc: '手机切后台缓冲生成流,重连无缝补齐楼层' },
    'utopinn-plugins': { icon: 'plugins', desc: '插件启停与热重载执行面 —— 自锁保护' },
    'utopinn-mvu': { icon: 'database', label: 'MVU 状态引擎', desc: '服务端原子化楼层变量补丁与快照回滚树' },
    'utopinn-th': { icon: 'shield', label: 'CardApp 沙箱桥', desc: '卡面 HTML 应用的受控宿主与 ctx 桥' },
    'utopinn-stats': { icon: 'compass', label: '统计与 WI 命中', desc: '生成延迟、Token 与世界书命中率汇总' },
    'utopinn-import': { icon: 'import', label: '导入管线', desc: 'PNG / JSON / CHARX 导入与 ST 迁移扫描' },
    'utopinn-script': { icon: 'slash', label: 'STscript 指令面', desc: '斜杠指令与宏执行' },
    'utopinn-data': { icon: 'folder', label: '数据辅助', desc: '数据目录扫描与迁移辅助' },
    'utopinn-connection': { icon: 'plug', label: '上游连接', desc: '上游端点与连接管理' },
    'utopinn-regex': { icon: 'wand', label: '正则管线', desc: '服务端正则替换管线' },
};

/** 内核锁定集合 —— utopinn-plugins.js CORE_PLUGINS(library/generate/
 *  delivery/diag)∪ SELF(管理面拒绝对自己 disable/reload)。 */
const CORE_LOCKED = new Set(['utopinn-library', 'utopinn-generate', 'utopinn-delivery', 'utopinn-diag', 'utopinn-plugins']);

export const pluginIcon = (id: string): IconName => PLUGIN_META[id]?.icon ?? 'puzzle';
export const pluginLabel = (id: string): string => PLUGIN_META[id]?.label ?? id;
const pluginDesc = (p: PluginItem): string => PLUGIN_META[p.id]?.desc ?? p.module;

/** 插件清单 hook —— 每个消费面(插件页 / 域树 / settings 页签)挂一份,
 *  写操作后由持有方 reload。 */
export function useServerPlugins() {
    return useRemote('api:utopinn-plugins', listPlugins);
}

export type ServerPlugins = Remote<{ items: PluginItem[] }>;

/* ------------------------------------------------------------------ */
/* PluginsSections —— 规范稿 renderPluginsSections 三段。                */
/*   full(settings 页签)= 无视 pluginsNav 过滤,三段全出;                */
/*   插件页内:pluginsNav 'installed' → 系统两段 + 市场,'market' → 仅市场。*/
/* ------------------------------------------------------------------ */

function PluginRowShell({ icon, title, sub, right }: { icon: IconName; title: string; sub: string; right: ReactNode }) {
    return (
        <div className="inset-row">
            <div className="flex min-w-0 items-center gap-3">
                <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: 'var(--bg-active)', border: '1px solid var(--border-hairline)', color: 'var(--fg-primary)' }}
                >
                    <Icon name={icon} size={18} />
                </span>
                <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{title}</span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-[color:var(--fg-muted)]">{sub}</span>
                </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">{right}</div>
        </div>
    );
}

export function PluginsSections({ full = false, plugins }: { full?: boolean; plugins: ServerPlugins }) {
    const { t } = useI18n();
    const s = useShell();
    const [busy, setBusy] = useState<string | null>(null);
    const items = plugins.data?.items ?? [];
    const core = items.filter((p) => CORE_LOCKED.has(p.id));
    const rest = items.filter((p) => !CORE_LOCKED.has(p.id));
    const showSys = full || s.pluginsNav === 'installed';

    const act = (id: string, fn: () => Promise<{ ok: boolean; error?: string }>, doneMsg?: string) => {
        if (busy) return;
        setBusy(id);
        void fn()
            .then((r) => {
                if (r && r.ok === false) throw new Error(r.error ?? 'failed');
                if (doneMsg) s.hint(doneMsg);
            })
            .then(() => plugins.reload())
            .catch((e) => s.hint(`${t('plugins.actFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(null));
    };

    return (
        <div className="space-y-5">
            {showSys && (
                <>
                    {plugins.error ? (
                        <PanelError error={plugins.error} onRetry={plugins.reload} />
                    ) : (
                        <>
                            {/* 1. 内核锁定段(规范稿:核心锁定章 + 死开关) */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between px-0.5">
                                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('plugins.core')}</span>
                                    <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">profile.yaml core</span>
                                </div>
                                <div className="inset-group">
                                    {core.map((p) => (
                                        <PluginRowShell key={p.id} icon={pluginIcon(p.id)} title={pluginLabel(p.id)} sub={pluginDesc(p)}
                                            right={
                                                <>
                                                    <span className="rounded px-1.5 py-0.5 font-mono-ui text-[10px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>{t('plugins.locked')}</span>
                                                    <span className="sh-switch cursor-not-allowed opacity-45" data-checked title={t('plugins.lockedHint')}><span className="sh-switch-thumb" /></span>
                                                </>
                                            }
                                        />
                                    ))}
                                    {!plugins.data && <div className="inset-row text-[11.5px] text-[color:var(--fg-faint)]">…</div>}
                                    {plugins.data && !core.length && <div className="inset-row text-[11.5px] text-[color:var(--fg-faint)]">{t('plugins.none')}</div>}
                                </div>
                            </div>

                            {/* 2. 可停用系统插件(真启停 + 热重载) */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between px-0.5">
                                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('plugins.sys')}</span>
                                    <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">enable · disable · reload</span>
                                </div>
                                <div className="inset-group">
                                    {rest.map((p) => {
                                        const enabled = !p.disabled;
                                        return (
                                            <PluginRowShell key={p.id} icon={pluginIcon(p.id)} title={pluginLabel(p.id)} sub={pluginDesc(p)}
                                                right={
                                                    <>
                                                        {p.status !== 'active' && (
                                                            <span className="rounded px-1.5 py-0.5 font-mono-ui text-[10px]" style={{ background: 'var(--bg-active)', color: p.status === 'failed' ? 'var(--status-danger)' : 'var(--fg-muted)' }}>{p.status}</span>
                                                        )}
                                                        {p.patch && (
                                                            <span className="rounded px-1.5 py-0.5 font-mono-ui text-[10px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>patch</span>
                                                        )}
                                                        <button
                                                            className="ghost-btn h-7 w-7"
                                                            title={t('plugins.reload')}
                                                            disabled={busy === p.id}
                                                            onClick={() => act(p.id, () => reloadPlugin(p.id), `${t('plugins.reloadDone')}:${pluginLabel(p.id)}`)}
                                                        >
                                                            <Icon name="refresh" size={14} />
                                                        </button>
                                                        <button
                                                            className="sh-switch"
                                                            data-checked={enabled || undefined}
                                                            disabled={busy === p.id}
                                                            style={busy === p.id ? { opacity: 0.5 } : undefined}
                                                            onClick={() => act(p.id, () => (enabled ? disablePlugin(p.id) : enablePlugin(p.id)))}
                                                        >
                                                            <span className="sh-switch-thumb" />
                                                        </button>
                                                    </>
                                                }
                                            />
                                        );
                                    })}
                                    {plugins.data && !rest.length && <div className="inset-row text-[11.5px] text-[color:var(--fg-faint)]">{t('plugins.none')}</div>}
                                </div>
                            </div>
                        </>
                    )}
                </>
            )}

            {/* 3. Stage 形态与扩展市场(规范稿:目录行 + 计划中/已内置徽标。
                安装面未备(C12 只读 manifest)—— 行不可点,不做假钮。) */}
            <div className="space-y-2">
                <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('plugins.market')}</span>
                    <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{t('plugins.marketHint')}</span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {MOCK_MARKET_PLUGINS.map((p) => (
                        <div
                            key={p.id}
                            className="flex items-center justify-between gap-3 rounded-[10px] p-3 transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}
                        >
                            <div className="flex min-w-0 items-center gap-3">
                                <span
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                                    style={{ background: 'var(--bg-active)', border: '1px solid var(--border-hairline)', color: 'var(--fg-primary)' }}
                                >
                                    <Icon name={p.icon as IconName} size={18} active={p.installed} />
                                </span>
                                <div className="min-w-0">
                                    <div className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{p.name}</div>
                                    <div className="mt-0.5 truncate text-[11px] text-[color:var(--fg-muted)]">{p.desc}</div>
                                </div>
                            </div>
                            <span className="shrink-0 rounded px-1.5 py-0.5 font-mono-ui text-[10px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>
                                {p.installed ? t('plugins.bundled') : t('plugins.planned')}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* PluginsView —— 规范稿 renderPluginsMain:滚动页壳 + 头行(移动前置       */
/* 菜单钮)+ 右上动作钮。添加安装面未备 → 头钮诚实落为「刷新清单」。          */
/* ------------------------------------------------------------------ */

export function PluginsView() {
    const { t } = useI18n();
    const s = useShell();
    const plugins = useServerPlugins();
    return (
        <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
                <div className="mx-auto max-w-4xl space-y-7">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex items-center gap-2">
                            {s.isMobile && (
                                <button className="ghost-btn h-8 w-8" onClick={() => s.setMobileDrawer(true)} title={t('mob.menu')}>
                                    <Icon name="menu" size={20} />
                                </button>
                            )}
                            <div>
                                <h1 className="heading-tight text-xl font-semibold text-[color:var(--fg-primary)]">{t('nav.plugins')}</h1>
                                <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">{t('plugins.sub')}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                className="h-8 rounded-lg px-3.5 text-[12px] font-medium"
                                style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                onClick={() => { plugins.reload(); s.hint(t('plugins.refreshed')); }}
                            >
                                {t('plugins.refresh')}
                            </button>
                        </div>
                    </div>
                    <PluginsSections plugins={plugins} />
                </div>
            </div>
        </section>
    );
}
