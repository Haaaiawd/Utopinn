// 规范稿 plugins 域(renderPluginsMain + renderPluginsSections)—— 真服务端面。
// 职能分工:rail 插件页 = 详情面(点插件行 → 滚动区顶部详情卡,回答
//   「这是什么 / 给界面贡献了什么」);settings 插件签 = 批量开关面
//   (PluginsSections full 三段全出,扫一遍启停)。
// 数据全部走 /api/utopinn/plugins(TASK-021 管理面):
//   · 内核锁定段 = list 行 core:true(profile.yaml 旗标透出,与内核
//     disable 闸同源)∪ 自锁件(utopinn-plugins 拒自己的 disable/reload);
//   · 可停用段 = enable/disable/reload 真写面,status/patch 原样透显;
//   · 市场段 = 服务端无目录面(假数据令:mock 目录已撤)—— 区块渲
//     「未提供」明说空态,不做假条目不假徽标。
// PluginsSections 与 settings 的「内核插件」页签共享(规范稿同一函数两处用)。
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { PanelEmpty, PanelError, useRemote, type Remote } from '../panels/panelShared';
import { disablePlugin, enablePlugin, listPlugins, reloadPlugin, type PluginItem } from '../../api/plugins';
import { listUiContrib, type UiContribItem } from '../../api/contrib';

/* ------------------------------------------------------------------ */
/* 服务端插件 id → 展示元数据(规范稿 BUILTIN/CORE 插件表的落地形)。          */
/* 集合判定看真 list;这里只管图标/中文名/描述 —— 未登记的 id 原样显示。    */
/* ------------------------------------------------------------------ */

interface PluginMeta {
    icon: IconName;
    label?: string;
    desc?: string;
    /** core 件:为什么不能关(锁定行的提示文案)。 */
    lockReason?: string;
    /** 可拆件:关掉之后明确会失去什么(停用确认 + 详情卡警示)。 */
    consequence?: string;
}

const PLUGIN_META: Record<string, PluginMeta> = {
    'utopinn-library': {
        icon: 'bookOpen', label: '内容库', desc: '角色卡、世界书、预设与人设核心读写域',
        lockReason: '角色卡 / 聊天读写 / 世界书 / 预设 / 人设的全部数据面 —— 关掉等于拔掉数据层',
    },
    'utopinn-generate': {
        icon: 'cpu', label: '生成引擎', desc: 'Prompt 组装、流式生成与 Jobs 调度中枢',
        lockReason: '生成与组装主入口 —— 关掉产品没有输出',
    },
    'utopinn-diag': {
        icon: 'code', label: '诊断总线', desc: 'diag-bus 事件、报错与 Trace 时序采集',
        consequence: '诊断/统计面板与 CLI logs·stats 全灭;前端与 CardApp 的错误上报(POST /diag/client)404;mobile 用 GET /_kernel 做连通探测 —— 关掉后手机端连不上服务器',
    },
    'utopinn-delivery': {
        icon: 'radio', label: '断线续传', desc: '手机切后台缓冲生成流,重连无缝补齐楼层',
        lockReason: '生成结果的 WS 交付通道 —— 关掉流式回执到不了客户端',
    },
    'utopinn-plugins': {
        icon: 'plugins', label: '插件管理', desc: '插件启停与热重载执行面 —— 自锁保护',
        lockReason: '插件管理面本体 —— 关掉它连「再打开」的 API 都没了(自锁)',
    },
    'utopinn-mvu': {
        icon: 'database', label: 'MVU 状态引擎', desc: '服务端原子化楼层变量补丁与快照回滚树',
        consequence: '生成管线的自动 settle 不受影响(持久化层直调 services/mvu-settle);关掉的是手动 settle/resettle、/state 读面与 MVU 状态板渲染 —— MVU 面板与 mvu CLI 动词失效',
    },
    'utopinn-th': {
        icon: 'shield', label: 'CardApp 沙箱桥', desc: '卡面 HTML 应用的受控宿主与 ctx 桥',
        lockReason: 'CardApp / TavernHelper 桥 —— 卡面应用的变量与消息读写全断',
    },
    'utopinn-stats': { icon: 'compass', label: '统计与 WI 命中', desc: '生成延迟、Token 与世界书命中率汇总' },
    'utopinn-import': { icon: 'import', label: '导入管线', desc: 'PNG / JSON / CHARX 导入与 ST 迁移扫描' },
    'utopinn-script': {
        icon: 'slash', label: 'STscript 指令面', desc: '斜杠指令与宏执行',
        consequence: 'Web 端斜杠指令执行与 `/` 补全注册表失效;经 CardApp 桥的 triggerSlash 不受影响(直调 @utopinn/core)',
    },
    'utopinn-data': {
        icon: 'folder', label: '数据辅助', desc: '数据目录扫描与迁移辅助',
        lockReason: '备份 / 导入 / LAN 迁移 —— 数据进出实例边界的唯一通路',
    },
    'utopinn-connection': {
        icon: 'plug', label: '上游连接', desc: '上游端点与连接管理',
        lockReason: '上游连接探测与模型清单 —— 关掉无法验证/选择生成上游',
    },
    'utopinn-regex': {
        icon: 'wand', label: '正则管线', desc: '服务端正则替换管线',
        consequence: '正则脚本的读写管理面失效(studio 正则编辑、CLI regex 动词);生成管线的正则引擎在 core,已存脚本照常生效',
    },
};

/** 内核锁定回退集合 —— 正常以 PluginItem.core(服务端 profile.yaml
 *  core 旗标透出)为准;旧服务端不回该字段时按本表置锁。
 *  与 profile.yaml core:true 行同集(library/generate/delivery/plugins/
 *  th/data/connection);utopinn-plugins 另有自锁闸。 */
const CORE_LOCKED = new Set([
    'utopinn-library', 'utopinn-generate', 'utopinn-delivery', 'utopinn-plugins',
    'utopinn-th', 'utopinn-data', 'utopinn-connection',
]);

const isCorePlugin = (p: PluginItem): boolean => p.core ?? CORE_LOCKED.has(p.id);

export const pluginIcon = (id: string): IconName => PLUGIN_META[id]?.icon ?? 'puzzle';
export const pluginLabel = (id: string): string => PLUGIN_META[id]?.label ?? id;
const pluginDesc = (p: PluginItem): string => PLUGIN_META[p.id]?.desc ?? p.module;

/** 插件清单 hook —— 每个消费面(插件页 / 域树 / settings 页签)挂一份,
 *  写操作后由持有方 reload。 */
export function useServerPlugins() {
    return useRemote('api:utopinn-plugins', listPlugins);
}

export type ServerPlugins = Remote<{ items: PluginItem[] }>;

/** 启停/热重载动作面 —— PluginsSections 与详情卡共享(busy 锁 + hint + reload)。 */
function usePluginAct(plugins: ServerPlugins) {
    const { t } = useI18n();
    const s = useShell();
    const [busy, setBusy] = useState<string | null>(null);
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
    return { busy, act };
}

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
    const { busy, act } = usePluginAct(plugins);
    const items = plugins.data?.items ?? [];
    const core = items.filter(isCorePlugin);
    const rest = items.filter((p) => !isCorePlugin(p));
    const showSys = full || s.pluginsNav === 'installed';

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
                                                    <span className="sh-switch cursor-not-allowed opacity-45" data-checked title={PLUGIN_META[p.id]?.lockReason ?? t('plugins.lockedHint')}><span className="sh-switch-thumb" /></span>
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
                                                            title={enabled ? (PLUGIN_META[p.id]?.consequence ?? undefined) : undefined}
                                                            onClick={() => {
                                                                // 停用前明示后果:可拆件都有真实代价,不静默关。
                                                                if (enabled) {
                                                                    const warn = PLUGIN_META[p.id]?.consequence;
                                                                    if (warn && !window.confirm(`${t('plugins.disableConfirm')}\n${pluginLabel(p.id)}\n\n${warn}`)) return;
                                                                }
                                                                act(p.id, () => (enabled ? disablePlugin(p.id) : enablePlugin(p.id)));
                                                            }}
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

            {/* 3. Stage 形态与扩展市场 —— 服务端无目录面:mock 目录已撤,
                本区块明说「未提供」空态;安装面落地再补真目录。 */}
            <div className="space-y-2">
                <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('plugins.market')}</span>
                    <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{t('plugins.marketHint')}</span>
                </div>
                <PanelEmpty icon="puzzle" desc={t('panel.feature.unavailableDesc')}>{t('panel.feature.unavailable')}</PanelEmpty>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* PluginDetailCard —— 插件详情面(域树点插件行的落点;规范稿无对应,自      */
/*   设计贴 inset-group/PluginRowShell 既有件)。                          */
/*   服务端件:徽标行(status/patch/locked)+ module 路径 + 启停/重载 +       */
/*   ui.contrib 贡献清单(按 slot 分组);市场目录件('mkt:' 前缀)随 mock     */
/*   目录一同撤除 —— 选择源已不存在。                                     */
/* ------------------------------------------------------------------ */

/** 徽标小条(详情卡内通用)。 */
function DetailBadge({ text, color = 'var(--fg-muted)' }: { text: string; color?: string }) {
    return (
        <span className="rounded px-1.5 py-0.5 font-mono-ui text-[10px]" style={{ background: 'var(--bg-active)', color }}>
            {text}
        </span>
    );
}

function PluginDetailCard({ sel, plugins }: { sel: string; plugins: ServerPlugins }) {
    const { t } = useI18n();
    const s = useShell();
    const { busy, act } = usePluginAct(plugins);
    const item = (plugins.data?.items ?? []).find((p) => p.id === sel) ?? null;
    /* 贡献清单:ui.contrib 全量拉一次按 plugin 过滤,按 slot 分组列条。 */
    const contrib = useRemote(`ui-contrib:${sel}`, listUiContrib);
    const contribGroups = useMemo(() => {
        const g = new Map<string, UiContribItem[]>();
        for (const it of contrib.data?.items ?? []) {
            if (it.plugin !== sel) continue;
            const list = g.get(it.slot) ?? [];
            list.push(it);
            g.set(it.slot, list);
        }
        return [...g.entries()];
    }, [contrib.data, sel]);

    const icon: IconName = pluginIcon(sel);
    const name = pluginLabel(sel);
    const desc = item ? pluginDesc(item) : '';
    const missing = !item && !!plugins.data; // 清单已回但找不到 → 件已下线

    return (
        <div
            className="space-y-4 rounded-[14px] p-4 sm:p-5"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-card)' }}
        >
            {/* 头:图标 + 名 + 描述;右上 × 回总览 */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <span
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                        style={{ background: 'var(--bg-active)', border: '1px solid var(--border-hairline)', color: 'var(--fg-primary)' }}
                    >
                        <Icon name={icon} size={20} />
                    </span>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-semibold text-[color:var(--fg-primary)]">{name}</span>
                        </div>
                        {desc && <div className="mt-0.5 text-[12px] leading-relaxed text-[color:var(--fg-muted)]">{desc}</div>}
                    </div>
                </div>
                <button className="ghost-btn h-7 w-7 shrink-0" title={t('plugins.detail.back')} onClick={() => s.setSelectedPlugin(null)}>
                    <Icon name="x" size={14} />
                </button>
            </div>

            {/* 服务端件:徽标行 + module + 动作(core 件不给写面,改给锁因;
                可拆件给写面 + 停用后果警示 —— 两处文案都在 PLUGIN_META)。 */}
            {item && (
                <>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <DetailBadge
                            text={item.status}
                            color={item.status === 'failed' ? 'var(--status-danger)' : item.status === 'active' ? 'var(--status-ok)' : 'var(--fg-muted)'}
                        />
                        {item.patch && <DetailBadge text="patch" />}
                        {isCorePlugin(item) && <DetailBadge text={t('plugins.locked')} />}
                        {item.disabled && <DetailBadge text="disabled" />}
                        <span className="min-w-0 flex-1 truncate text-right font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]" title={item.module}>
                            {item.module}
                        </span>
                        {!isCorePlugin(item) && (
                            <span className="flex shrink-0 items-center gap-1.5">
                                <button
                                    className="ghost-btn h-7 w-7"
                                    title={t('plugins.reload')}
                                    disabled={busy === item.id}
                                    onClick={() => act(item.id, () => reloadPlugin(item.id), `${t('plugins.reloadDone')}:${pluginLabel(item.id)}`)}
                                >
                                    <Icon name="refresh" size={14} />
                                </button>
                                <button
                                    className="sh-switch"
                                    data-checked={!item.disabled || undefined}
                                    disabled={busy === item.id}
                                    style={busy === item.id ? { opacity: 0.5 } : undefined}
                                    onClick={() => {
                                        if (!item.disabled) {
                                            const warn = PLUGIN_META[item.id]?.consequence;
                                            if (warn && !window.confirm(`${t('plugins.disableConfirm')}\n${pluginLabel(item.id)}\n\n${warn}`)) return;
                                        }
                                        act(item.id, () => (item.disabled ? enablePlugin(item.id) : disablePlugin(item.id)));
                                    }}
                                >
                                    <span className="sh-switch-thumb" />
                                </button>
                            </span>
                        )}
                    </div>
                    {isCorePlugin(item) && PLUGIN_META[item.id]?.lockReason && (
                        <div className="rounded-lg px-3 py-2 text-[11.5px] leading-relaxed text-[color:var(--fg-muted)]" style={{ background: 'var(--bg-active)' }}>
                            {PLUGIN_META[item.id]?.lockReason}
                        </div>
                    )}
                    {!isCorePlugin(item) && PLUGIN_META[item.id]?.consequence && (
                        <div className="rounded-lg px-3 py-2 text-[11.5px] leading-relaxed" style={{ background: 'var(--bg-active)', color: 'var(--status-warn)' }}>
                            {t('plugins.consequence')}{PLUGIN_META[item.id]?.consequence}
                        </div>
                    )}
                </>
            )}
            {missing && (
                <div className="inset-group">
                    <div className="inset-row text-[11.5px] text-[color:var(--fg-faint)]">{t('plugins.detail.gone')}</div>
                </div>
            )}

            {/* 服务端件:UI 贡献清单(slot 分组 · contribution.type/title 摘要) */}
            <div className="space-y-2">
                <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('plugins.detail.contribs')}</span>
                    <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">ui.contrib</span>
                </div>
                {contrib.error ? (
                    <div className="inset-group">
                        <div className="inset-row"><span className="break-all font-mono-ui text-[10.5px]" style={{ color: 'var(--status-danger)' }}>{contrib.error}</span></div>
                    </div>
                ) : contribGroups.length > 0 ? (
                    contribGroups.map(([slot, list]) => (
                        <div key={slot} className="space-y-1.5">
                            <div className="px-0.5 font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{slot}</div>
                            <div className="inset-group">
                                {list.map((it, i) => {
                                    const c = it.contribution;
                                    const label = String(c.title ?? c.type ?? c.id ?? '—');
                                    const sub = c.type && c.type !== c.title ? String(c.type) : null;
                                    return (
                                        <div key={`${slot}:${i}`} className="inset-row">
                                            <div className="min-w-0">
                                                <div className="truncate text-[12.5px] text-[color:var(--fg-primary)]">{label}</div>
                                                {sub && <div className="truncate font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{sub}</div>}
                                            </div>
                                            <span className="flex shrink-0 items-center gap-1.5">
                                                {it.core && <DetailBadge text="core" />}
                                                {it.disabled && <DetailBadge text="disabled" />}
                                                {typeof c.wired === 'boolean' && (
                                                    <DetailBadge text={c.wired ? 'wired' : 'unwired'} color={c.wired ? 'var(--status-ok)' : 'var(--status-warn)'} />
                                                )}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="inset-group">
                        <div className="inset-row text-[11.5px] text-[color:var(--fg-faint)]">
                            {contrib.loading ? '…' : t('plugins.detail.noContribs')}
                        </div>
                    </div>
                )}
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
                                <h1 className="heading-tight text-title-lg font-semibold text-[color:var(--fg-primary)]">{t('nav.plugins')}</h1>
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
                    {/* 详情卡:域树点插件行的落点(详情面,在总览三段之上)。 */}
                    {s.selectedPlugin && <PluginDetailCard sel={s.selectedPlugin} plugins={plugins} />}
                    <PluginsSections plugins={plugins} />
                </div>
            </div>
        </section>
    );
}
