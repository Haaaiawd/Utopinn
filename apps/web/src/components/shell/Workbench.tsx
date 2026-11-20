// 规范稿右工作台:wb-resizer(拖宽/双击 410 复位) + aside(state.workbenchWidth)|
// h-12 tab 条(openTabs +「+ 新标签页」)+ 板块体 + 受控悬浮窗(detach/dockBack)。
// 壳不识板块类型 —— 体与目录元数据全走 'panel.type' 贡献点,launcher 由贡献目录自动生成。
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

/** 新键 launcher(规范稿 renderNewTabLauncher:px-5 py-8 垂直居中 + 440px 栏 —
 *  圆角搜索条 → cardapp 卡提供面板行(1.5px 粗边 + 「iframe 宿主」尾注)→
 *  system 系统面板两列格;suggested 是三方贡献逃生位,稿内未画,沿用 inset 行式)。 */
function Launcher({ isMobile = false }: { isMobile?: boolean }) {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    const q = shell.launcherSearch.trim().toLowerCase();
    const match = (c: PanelTypeContribution) =>
        !q || panelTitle(t, c).toLowerCase().includes(q) || c.type.includes(q) || (c.desc ? t(c.desc).toLowerCase().includes(q) : false);
    const cardItems = contribs.filter((c) => c.category === 'cardapp' && match(c));
    const sysItems = contribs.filter((c) => (c.category ?? 'system') === 'system' && match(c));
    const suggested = contribs.filter((c) => c.category === 'suggested' && match(c));
    const sect = 'px-0.5 text-[11px] font-medium text-[color:var(--fg-muted)]';
    return (
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 py-8">
            <div className="mx-auto w-full max-w-[440px] space-y-7">
                <div
                    className="flex h-10 items-center gap-2.5 rounded-full px-4"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--inner-highlight)' }}
                >
                    <span className="text-[color:var(--fg-muted)]"><Icon name="search" size={15} /></span>
                    <input
                        /* 移动 sheet 收起时 launcher 也在 DOM 里 —— autoFocus 会抢焦点
                           并把 overflow:hidden 壳滚动 40px 顶走 stage-header。 */
                        autoFocus={!isMobile}
                        value={shell.launcherSearch}
                        onChange={(e) => shell.setLauncherSearch(e.target.value)}
                        placeholder={t('wb.launcher.search')}
                        className="w-full bg-transparent text-[13px] text-[color:var(--fg-primary)] outline-none"
                    />
                </div>
                {cardItems.length > 0 && (
                    <div className="space-y-2">
                        <div className={sect}>{t('wb.launcher.cardapp')}</div>
                        {cardItems.map((c) => (
                            <button
                                key={c.type}
                                className="flex w-full items-center justify-between gap-3 rounded-[10px] p-3.5 text-left transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                                style={{ background: 'var(--bg-surface)', border: '1.5px solid var(--border-bold)', boxShadow: 'var(--shadow-card)' }}
                                onClick={() => shell.openPanel(c.type)}
                            >
                                <span className="flex min-w-0 items-center gap-3">
                                    <span className="text-[color:var(--fg-primary)]"><Icon name={c.icon} size={18} /></span>
                                    <span className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{panelTitle(t, c)}</span>
                                </span>
                                <span className="shrink-0 font-mono-ui text-[10.5px] text-[color:var(--brand)]">{t('wb.launcher.iframe')}</span>
                            </button>
                        ))}
                    </div>
                )}
                {sysItems.length > 0 && (
                    <div className="space-y-2">
                        <div className={sect}>{t('wb.launcher.system')}</div>
                        <div className="grid grid-cols-2 gap-2">
                            {sysItems.map((c) => (
                                <button
                                    key={c.type}
                                    className="flex items-center gap-2.5 rounded-[10px] p-3 text-left transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-card)' }}
                                    onClick={() => shell.openPanel(c.type)}
                                >
                                    <span className="shrink-0 text-[color:var(--fg-secondary)]"><Icon name={c.icon} size={17} /></span>
                                    <span className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{panelTitle(t, c)}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {suggested.length > 0 && (
                    <div className="space-y-2">
                        <div className={sect}>{t('wb.launcher.suggested')}</div>
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
                    </div>
                )}
            </div>
        </div>
    );
}

/** wb 体:h-12 px-4 tab 条 + 激活板块体;isMobile 时隐 detach/收起。 */
export function WorkbenchBody({ isMobile = false }: { isMobile?: boolean }) {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    const tabs = shell.openTabs.map((type) => {
        const c = contribs.find((x) => x.type === type);
        return { id: type, label: panelTitle(t, c, type) };
    });
    const launcherActive = shell.activeTab === 'newtab' || (!shell.activeTab && tabs.length === 0);
    return (
        <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-workbench)' }}>
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-hairline)] px-4">
                <div className="no-scrollbar flex flex-1 items-center gap-1 overflow-x-auto">
                    {tabs.map((tb) => {
                        const active = !launcherActive && shell.activeTab === tb.id;
                        return (
                            <div
                                key={tb.id}
                                className="wb-tab inline-flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg py-1 pl-2.5 pr-1.5 text-[12px] transition-colors"
                                data-active={active || undefined}
                                style={active ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                                onClick={() => shell.selectTab(tb.id)}
                                role="button" tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter') shell.selectTab(tb.id); }}
                            >
                                <span className="max-w-[110px] truncate">{tb.label}</span>
                                <button
                                    className="wb-tab-close flex h-4 w-4 items-center justify-center rounded transition-colors hover:bg-[color:var(--bg-active)]"
                                    onClick={(e) => { e.stopPropagation(); shell.closeTab(tb.id); }}
                                    title={t('wb.close')}
                                >
                                    <Icon name="x" size={10} />
                                </button>
                            </div>
                        );
                    })}
                    <button
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] transition-colors"
                        style={launcherActive ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-muted)' }}
                        onClick={shell.openNewTab}
                    >
                        <Icon name="plus" size={13} /><span>{t('wb.newtab')}</span>
                    </button>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    {/* 规范稿 detach-panel:激活板块拆出为受控悬浮窗(launcher 页无对象不画)。 */}
                    {!isMobile && !launcherActive && shell.activeTab && (
                        <button className="ghost-btn h-7 w-7" onClick={() => shell.detachPanel(shell.activeTab)} title={t('wb.detach')}>
                            <Icon name="detach" size={15} />
                        </button>
                    )}
                    {!isMobile && (
                        <button className="ghost-btn h-7 w-7" onClick={shell.toggleWorkbench} title={t('wb.collapse')}>
                            <Icon name="x" size={15} />
                        </button>
                    )}
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {launcherActive ? <Launcher isMobile={isMobile} /> : <PanelBody type={shell.activeTab} />}
            </div>
        </div>
    );
}

/** 右工作台:wb-resizer(宽 290–min(680,56vw),双击复位 410)+ 变宽 aside。 */
export function Workbench() {
    const shell = useShell();
    const [width, setWidth] = useState(410);
    const widthRef = useRef(width);
    widthRef.current = width;
    if (!shell.workbenchOpen) return null;

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        const startX = e.clientX;
        const startW = widthRef.current;
        const maxW = Math.min(680, Math.floor(window.innerWidth * 0.56));
        const minW = 290;
        const onMove = (ev: PointerEvent) => {
            setWidth(Math.round(Math.max(minW, Math.min(maxW, startW + (startX - ev.clientX)))));
        };
        const onUp = () => {
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <>
            <div
                className="wb-resizer"
                title="左右拖动调节右栏宽度 · 双击重置"
                onPointerDown={onPointerDown}
                onDoubleClick={() => setWidth(410)}
            >
                <span className="wb-width-badge font-mono-ui">{width}px</span>
            </div>
            <aside className="h-full shrink-0" style={{ width }}>
                <WorkbenchBody />
            </aside>
        </>
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
