// 规范稿右工作台:wb-tab 条(openTabs + '+' launcher 页)+ 板块体 +
// 受控悬浮窗(detach/dockBack)。壳不识板块类型 —— 体与目录元数据全走
// 'panel.type' 贡献点,launcher 由贡献目录自动生成。
import { useRef, useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import type { PanelTypeContribution } from '../../kernel/contributions';

/** 按类型解析板块体(panel.type 贡献点;未注册 → 诚实占位)。 */
export function PanelBody({ type }: { type: string }) {
    const { t } = useI18n();
    const contribs = useContribs('panel.type');
    const c = contribs.find((x) => x.type === type);
    if (!c) {
        return (
            <div className="flex h-full items-center justify-center p-6 text-center text-[11.5px] text-[color:var(--fg-faint)]">
                {t('panel.unregistered')} · {type}
            </div>
        );
    }
    return <c.Body />;
}

function panelTitle(t: (k: string) => string, c?: PanelTypeContribution, fallback = '') {
    if (!c) return fallback || '…';
    return c.title ? t(c.title) : t(`panel.type.${c.type}`);
}

/** 新键 launcher(规范稿 newtab 页:搜索 + 「新键」目录格 + 「建议」行)。 */
function Launcher() {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    const q = shell.launcherSearch.trim().toLowerCase();
    const match = (c: PanelTypeContribution) =>
        !q || panelTitle(t, c).toLowerCase().includes(q) || c.type.includes(q) || (c.desc ? t(c.desc).toLowerCase().includes(q) : false);
    const fresh = contribs.filter((c) => (c.category ?? 'new') === 'new' && match(c));
    const suggested = contribs.filter((c) => c.category === 'suggested' && match(c));
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
            <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2">
                <Icon name="search" size={13} className="text-[color:var(--fg-faint)]" />
                <input
                    autoFocus
                    value={shell.launcherSearch}
                    onChange={(e) => shell.setLauncherSearch(e.target.value)}
                    placeholder={t('wb.launcher.search')}
                    className="w-full bg-transparent text-[12.5px] outline-none"
                />
            </div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">{t('wb.launcher.new')}</div>
            <div className="grid grid-cols-2 gap-2">
                {fresh.map((c) => (
                    <button
                        key={c.type}
                        className="inset-group inset-row-btn flex items-center gap-2.5 !border-[color:var(--border-hairline)] px-3 py-2.5 text-left"
                        onClick={() => shell.openPanel(c.type)}
                    >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color:var(--bg-active)] text-[color:var(--fg-secondary)]">
                            <Icon name={c.icon} size={14} />
                        </span>
                        <span className="min-w-0">
                            <span className="block truncate text-[12px] text-[color:var(--fg-primary)]">{panelTitle(t, c)}</span>
                            {c.desc && <span className="block truncate text-[10px] text-[color:var(--fg-muted)]">{t(c.desc)}</span>}
                        </span>
                    </button>
                ))}
            </div>
            {suggested.length > 0 && (
                <>
                    <div className="mb-1.5 mt-4 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">{t('wb.launcher.suggested')}</div>
                    <div className="inset-group">
                        {suggested.map((c) => (
                            <button key={c.type} className="inset-row inset-row-btn" onClick={() => shell.openPanel(c.type)}>
                                <span className="flex min-w-0 items-center gap-2.5">
                                    <Icon name={c.icon} size={14} className="text-[color:var(--fg-secondary)]" />
                                    <span className="truncate text-[12px] text-[color:var(--fg-primary)]">{panelTitle(t, c)}</span>
                                    {c.badge && <span className="rounded-full bg-[color:var(--bg-active)] px-1.5 py-px text-[9px] text-[color:var(--fg-muted)]">{t(c.badge)}</span>}
                                </span>
                                <Icon name="plus" size={13} className="text-[color:var(--fg-faint)]" />
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

/** 右工作台:w-[300px] 固定宽,tab 条 + 激活板块体;workbenchOpen=false 时整块收起。 */
export function Workbench() {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    if (!shell.workbenchOpen) return null;
    const tabs: { id: string; label: string; icon?: string }[] = shell.openTabs.map((type) => {
        const c = contribs.find((x) => x.type === type);
        return { id: type, label: panelTitle(t, c, type), icon: c?.icon };
    });
    const launcherActive = shell.activeTab === 'newtab' || (!shell.activeTab && tabs.length === 0);
    return (
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-[color:var(--border-hairline)] bg-[color:var(--bg-workbench)]">
            <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[color:var(--border-hairline)] px-2 no-scrollbar">
                {tabs.map((tb) => {
                    const active = !launcherActive && shell.activeTab === tb.id;
                    return (
                        <button
                            key={tb.id}
                            className="wb-tab ghost-btn h-7 shrink-0 gap-1.5 rounded-md px-2.5 text-[11.5px]"
                            data-active={active || undefined}
                            style={active ? { color: 'var(--fg-primary)', background: 'var(--bg-active)' } : undefined}
                            onClick={() => shell.selectTab(tb.id)}
                        >
                            {tb.icon && <Icon name={tb.icon as never} size={12} />}
                            <span className="max-w-[110px] truncate">{tb.label}</span>
                            <span
                                className="wb-tab-close ghost-btn -mr-1 h-4 w-4 text-[10px]"
                                onClick={(e) => { e.stopPropagation(); shell.closeTab(tb.id); }}
                            >
                                <Icon name="x" size={9} />
                            </span>
                        </button>
                    );
                })}
                <button
                    className="wb-tab ghost-btn h-7 w-7 shrink-0 rounded-md"
                    data-active={launcherActive || undefined}
                    onClick={shell.openNewTab}
                    title={t('wb.newtab')}
                >
                    <Icon name="plus" size={13} />
                </button>
                <span className="flex-1" />
                <button className="ghost-btn h-6 w-6 shrink-0" onClick={shell.toggleWorkbench} title={t('wb.collapse')}>
                    <Icon name="panelRight" size={12} />
                </button>
            </div>
            {launcherActive ? <Launcher /> : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <PanelBody type={shell.activeTab} />
                </div>
            )}
        </aside>
    );
}

/** 受控悬浮窗:拖标题栏移动,dockBack 回工作台,closeFloat 关闭。 */
export function FloatingWin() {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    const drag = useRef<{ dx: number; dy: number } | null>(null);
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    if (!shell.floatingType) return null;
    const c = contribs.find((x) => x.type === shell.floatingType);
    const p = pos ?? shell.floatingPos;
    const onDown = (e: React.PointerEvent) => {
        drag.current = { dx: e.clientX - p.x, dy: e.clientY - p.y };
        const move = (ev: PointerEvent) => {
            if (!drag.current) return;
            const np = {
                x: Math.max(8, Math.min(window.innerWidth - 200, ev.clientX - drag.current.dx)),
                y: Math.max(40, Math.min(window.innerHeight - 80, ev.clientY - drag.current.dy)),
            };
            setPos(np);
        };
        const up = () => {
            drag.current = null;
            if (pos) shell.setFloatingPos(pos);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return (
        <div className="floating-win pop-in" style={{ left: p.x, top: p.y }}>
            <div
                className="flex h-9 shrink-0 cursor-grab select-none items-center gap-2 border-b border-[color:var(--border-hairline)] px-3 active:cursor-grabbing"
                onPointerDown={onDown}
            >
                {c?.icon && <Icon name={c.icon} size={13} className="text-[color:var(--fg-secondary)]" />}
                <span className="flex-1 truncate text-[12px] font-medium text-[color:var(--fg-primary)]">{panelTitle(t, c)}</span>
                <button className="ghost-btn h-6 w-6" onClick={shell.dockBack} title={t('wb.dock')}>
                    <Icon name="panelRight" size={12} />
                </button>
                <button className="ghost-btn h-6 w-6" onClick={shell.closeFloat} title={t('wb.close')}>
                    <Icon name="x" size={12} />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <PanelBody type={shell.floatingType} />
            </div>
        </div>
    );
}
