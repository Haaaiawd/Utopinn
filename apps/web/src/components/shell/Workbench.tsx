// 右工作台:wb-tab 条(激活 brand 下划线)+ 板块体 + 「新标签页」launcher +
// 可拆悬浮窗。板块类型全部走 panel.type 贡献点 —— 壳不枚举。
import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useContribs, useShell } from '../../kernel/context';
import { Icon } from '../Icon';

/** 「新标签页」launcher:panel.type 贡献的目录面(desc/badge/category)。 */
function PanelLauncher() {
    const { t } = useI18n();
    const { addPanel } = useShell();
    const types = useContribs('panel.type');
    const news = types.filter((p) => p.category === 'new');
    const suggested = types.filter((p) => p.category !== 'new');
    return (
        <div className="no-scrollbar h-full overflow-y-auto p-3">
            <div className="mb-2 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('wb.launcher.new')}</div>
            <div className="grid grid-cols-2 gap-2">
                {news.map((p) => (
                    <button key={p.type} type="button" onClick={() => addPanel(p.type)}
                        className="inset-group flex flex-col gap-1 p-3 text-left transition-colors hover:bg-[color:var(--bg-surface-hover)]">
                        <span className="flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--fg-primary)]">
                            <Icon name={p.icon} size={13} />{t(`panel.type.${p.type}`)}
                            {p.badge && <span className="rounded-full bg-[color:var(--brand-soft)] px-1.5 text-[10px] text-[color:var(--brand)]">{t(p.badge)}</span>}
                        </span>
                        <span className="text-[11px] leading-relaxed text-[color:var(--fg-muted)]">{t(p.desc ?? 'panel.stub')}</span>
                    </button>
                ))}
            </div>
            <div className="mb-2 mt-4 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('wb.launcher.suggested')}</div>
            <div className="inset-group">
                {suggested.map((p) => (
                    <button key={p.type} type="button" onClick={() => addPanel(p.type)}
                        className="inset-row inset-row-btn">
                        <span className="flex items-center gap-2 text-[12px] text-[color:var(--fg-primary)]">
                            <Icon name={p.icon} size={14} />{t(`panel.type.${p.type}`)}
                            {!p.wired && <span className="rounded-full border border-[color:var(--border-subtle)] px-1.5 text-[10px] text-[color:var(--fg-faint)]">{t('panel.unwired')}</span>}
                        </span>
                        <span className="text-[11px] text-[color:var(--fg-faint)]">{t(p.desc ?? '')}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

export function Workbench() {
    const { t } = useI18n();
    const { panels, activePanel, selectPanel, closePanel, panelHidden, launcherOpen, openLauncher, detachPanel } = useShell();
    const types = useContribs('panel.type');
    if (panelHidden) return null;
    const active = panels.find((p) => p.id === activePanel);
    const activeType = active ? types.find((tp) => tp.type === active.type) : undefined;
    const Body = activeType?.Body;
    return (
        <section className="flex w-[300px] shrink-0 flex-col border-l border-[color:var(--border-hairline)] bg-[color:var(--bg-workbench)]">
            {/* wb-tab 条 */}
            <div className="no-scrollbar flex h-11 items-end gap-0.5 overflow-x-auto border-b border-[color:var(--border-hairline)] px-2">
                {panels.map((p) => {
                    const tp = types.find((x) => x.type === p.type);
                    const on = p.id === activePanel && !launcherOpen;
                    return (
                        <div key={p.id} data-active={on}
                            className="wb-tab group flex h-8 cursor-pointer items-center gap-1.5 rounded-t-[8px] px-2.5 text-[12px]"
                            style={{ color: on ? 'var(--fg-primary)' : 'var(--fg-muted)' }}
                            onClick={() => selectPanel(p.id)}>
                            {tp && <Icon name={tp.icon} size={12} />}
                            <span className="max-w-[92px] truncate">{t(`panel.type.${p.type}`)}</span>
                            <button type="button" className="wb-tab-close ghost-btn h-4 w-4"
                                onClick={(e) => { e.stopPropagation(); closePanel(p.id); }}>
                                <Icon name="x" size={10} />
                            </button>
                        </div>
                    );
                })}
                <button type="button" className="ghost-btn mb-1 h-7 w-7" title={t('wb.launcher')} onClick={openLauncher}>
                    <Icon name="plus" size={14} />
                </button>
            </div>
            {/* 板块体 */}
            <div className="min-h-0 flex-1">
                {launcherOpen || !Body ? <PanelLauncher /> : (
                    <div className="flex h-full flex-col">
                        <div className="flex items-center justify-end gap-1 px-2 pt-1.5">
                            <button type="button" className="ghost-btn h-6 w-6" title={t('wb.detach')}
                                onClick={() => active && detachPanel(active.id)}>
                                <Icon name="detach" size={12} />
                            </button>
                        </div>
                        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                            <Body />
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}

/** 悬浮窗:头部拖拽移位,dockBack 收回工作台。 */
export function FloatingWin() {
    const { t } = useI18n();
    const { floating, floatingPos, setFloatingPos, dockPanel } = useShell();
    const types = useContribs('panel.type');
    const drag = useRef<{ dx: number; dy: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    if (!floating) return null;
    const tp = types.find((x) => x.type === floating.type);
    const Body = tp?.Body;
    return (
        <div className="floating-win pop-in" style={{ left: floatingPos.x, top: floatingPos.y }}>
            <div className="flex h-9 cursor-grab items-center gap-2 border-b border-[color:var(--border-hairline)] px-3 select-none"
                style={{ cursor: dragging ? 'grabbing' : 'grab' }}
                onPointerDown={(e) => {
                    drag.current = { dx: e.clientX - floatingPos.x, dy: e.clientY - floatingPos.y };
                    setDragging(true);
                    const mv = (ev: PointerEvent) => drag.current && setFloatingPos({ x: ev.clientX - drag.current.dx, y: ev.clientY - drag.current.dy });
                    const up = () => { drag.current = null; setDragging(false); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
                    window.addEventListener('pointermove', mv);
                    window.addEventListener('pointerup', up);
                }}>
                {tp && <Icon name={tp.icon} size={13} />}
                <span className="flex-1 text-[12px] font-medium text-[color:var(--fg-primary)]">{t(`panel.type.${floating.type}`)}</span>
                <button type="button" className="ghost-btn h-6 w-6" title={t('wb.dockBack')} onClick={dockPanel}
                    onPointerDown={(e) => e.stopPropagation()}>
                    <Icon name="dockBack" size={12} />
                </button>
            </div>
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                {Body ? <Body /> : null}
            </div>
        </div>
    );
}
