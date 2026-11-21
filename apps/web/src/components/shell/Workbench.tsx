// 规范稿右工作台:wb-resizer(拖宽/双击 410 复位) + aside(state.workbenchWidth)|
// h-12 tab 条(openTabs +「+ 新标签页」)+ 板块体 + 受控悬浮窗(detach/dockBack)。
// 壳不识板块类型 —— 体与目录元数据全走 'panel.type' 贡献点,launcher 由贡献目录自动生成。
import { useEffect, useRef, useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import type { PanelTypeContribution } from '../../kernel/contributions';
import { cardAppInfo, type CardAppInfo } from '../../api/cardRuntime';
import { readPanelFreq, panelFreqScore } from './panelFreq';

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

/** 当前会话卡的 CardApp 申报 —— manifest dry-run(不 mint mount);
 *  charDir 空 → has:false;回包未到 → null(加载位)。 */
function useCardApp(charDir: string | null): CardAppInfo | null {
    const [info, setInfo] = useState<CardAppInfo | null>(null);
    useEffect(() => {
        if (!charDir) { setInfo({ has: false }); return; }
        let dead = false;
        setInfo(null);
        void cardAppInfo(charDir).then((i) => { if (!dead) setInfo(i); });
        return () => { dead = true; };
    }, [charDir]);
    return info;
}

/** 新键 launcher(规范稿 renderNewTabLauncher:px-5 py-8 垂直居中 + 440px 栏 —
 *  圆角搜索条 → cardapp 卡提供面板行(1.5px 粗边 + 「iframe 宿主」尾注)→
 *  system 系统面板两列格;suggested 是三方贡献逃生位,稿内未画,沿用 inset 行式)。
 *  cardapp 区按当前会话卡的 manifest 过滤:卡没声明 card_app → 温和空态
 *  「该卡无 CardApp」,不再把别卡应用挂进来;有条目时名取 manifest 面板名。 */
function Launcher({ isMobile = false }: { isMobile?: boolean }) {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    const appInfo = useCardApp(shell.chat?.charDir ?? null);
    const q = shell.launcherSearch.trim().toLowerCase();
    const match = (c: PanelTypeContribution) =>
        !q || panelTitle(t, c).toLowerCase().includes(q) || c.type.includes(q) || (c.desc ? t(c.desc).toLowerCase().includes(q) : false);
    const cardItems = appInfo?.has ? contribs.filter((c) => c.category === 'cardapp' && match(c)) : [];
    /* 活跃 launcher:系统区按使用频度重排 —— score = count + 近因加成
       (openPanel 打点 'utopinn.wb.freq');无记录 -1 殿后保注册序。 */
    const freqMap = readPanelFreq();
    const sysItems = contribs
        .filter((c) => (c.category ?? 'system') === 'system' && match(c))
        .map((c, i) => ({ c, i, s: panelFreqScore(freqMap[c.type]) }))
        .sort((a, b) => (b.s - a.s) || (a.i - b.i))
        .map((x) => x.c);
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
                {appInfo?.has ? (
                    cardItems.length > 0 && (
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
                                        <span className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{appInfo.name ?? panelTitle(t, c)}</span>
                                    </span>
                                    <span className="shrink-0 font-mono-ui text-[10.5px] text-[color:var(--brand)]">{t('wb.launcher.iframe')}</span>
                                </button>
                            ))}
                        </div>
                    )
                ) : (
                    /* 当前卡无 card_app 声明(或取数失败):不列条目不露 iframe
                       badge,一条温和空态 —— 别卡应用不许挂进来。 */
                    <div className="space-y-2">
                        <div className={sect}>{t('wb.launcher.cardapp')}</div>
                        <div className="px-0.5 text-[11.5px] leading-relaxed text-[color:var(--fg-faint)]">
                            {appInfo === null ? '…' : t('wb.launcher.nocardapp')}
                        </div>
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

/** wb 体:h-12 px-4 tab 条 + 激活板块体;isMobile 时隐 detach/收起。
 *  floating = aside 正以浮窗壳渲染(浮窗 v2:同树不切容器,零 remount)——
 *  tab 条空白区兼作拖柄(onFloatDrag),detach 钮换 dockBack。 */
export function WorkbenchBody({ isMobile = false, floating = false, onFloatDrag }: {
    isMobile?: boolean;
    floating?: boolean;
    onFloatDrag?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    const tabs = shell.openTabs.map((type) => {
        const c = contribs.find((x) => x.type === type);
        return { id: type, label: panelTitle(t, c, type) };
    });
    const launcherActive = shell.activeTab === 'newtab' || (!shell.activeTab && tabs.length === 0);
    const activeContrib = contribs.find((x) => x.type === shell.activeTab);
    const cardappTab = !launcherActive && activeContrib?.category === 'cardapp';
    /* 自愈:激活板块离开 cardapp 桶 → 收回 fs 旗标(切 tab/关 tab 不背
       全屏残念;fs 本体在 CardAppFrame 里挂 .cardapp-host 上)。 */
    useEffect(() => {
        if (!cardappTab && shell.cardappFs) shell.setCardappFs(false);
    }, [cardappTab, shell]);
    return (
        <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-workbench)' }}>
            <div
                className={`flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-hairline)] px-4${floating ? ' cursor-grab active:cursor-grabbing' : ''}`}
                onPointerDown={floating ? onFloatDrag : undefined}
            >
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
                    {/* CardApp 全屏提升(§6.4):cardapp 桶板块激活时给「全屏」;
                        本体是 .cardapp-host 切 fixed inset-0,同树不 remount。 */}
                    {!isMobile && cardappTab && (
                        <button className="ghost-btn h-7 w-7" onClick={() => shell.setCardappFs(true)} title={t('wb.fs')}>
                            <Icon name="focus" size={15} />
                        </button>
                    )}
                    {/* 规范稿 detach-panel —— v2:浮窗是工作台自身的展示态;
                        floating 时此位换「收回工作台」(launcher 页无对象不画)。 */}
                    {!isMobile && !launcherActive && shell.activeTab && (
                        floating ? (
                            <button className="ghost-btn h-7 w-7" onClick={shell.dockBack} title={t('wb.dock')}>
                                <Icon name="dockBack" size={15} />
                            </button>
                        ) : (
                            <button className="ghost-btn h-7 w-7" onClick={() => shell.detachPanel(shell.activeTab)} title={t('wb.detach')}>
                                <Icon name="detach" size={15} />
                            </button>
                        )
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

/** 右工作台:wb-resizer(宽 290–min(680,56vw),双击复位 410)+ 变宽 aside。
 *  浮窗 v2(detach 不杀卡,§6.2):floatingType 非 null → 同一个 <aside>
 *  DOM 节点换 floating-win chrome(fixed + rect),openTabs/PanelBody 子树
 *  原地不动 —— 嵌卡 iframe 零 remount。tab 条空白区拖拽移动,右下角柄
 *  resize(min 320×240,上限视口),矩形随 WbLayout 按会话存档。 */
export function Workbench() {
    const shell = useShell();
    const [width, setWidth] = useState(410);
    const widthRef = useRef(width);
    widthRef.current = width;
    const floating = !!shell.floatingType;
    /* rect 本地跟手(拖/resize 每帧只重渲本组件),pointerup 才写回 ctx
       —— 写回经 WbLayout 持久化段落盘。水合/外部改档 → effect 同步。 */
    const [rect, setRect] = useState(shell.floatingRect);
    const rectRef = useRef(rect);
    rectRef.current = rect;
    useEffect(() => { setRect(shell.floatingRect); }, [shell.floatingRect]);
    if (!shell.workbenchOpen) return null;

    const onResizerDown = (e: React.PointerEvent<HTMLDivElement>) => {
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

    /* 浮窗拖拽:tab 条空白区为柄(交互控件上方不启动);钳位保证 ≥120px
       宽、64px 高始终留在视口内。 */
    const onFloatDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('.wb-tab, button, input, a')) return;
        e.preventDefault();
        const dx = e.clientX - rectRef.current.x;
        const dy = e.clientY - rectRef.current.y;
        const onMove = (ev: PointerEvent) => {
            setRect((r) => ({
                ...r,
                x: Math.max(8 - r.w + 120, Math.min(window.innerWidth - 120, ev.clientX - dx)),
                y: Math.max(8, Math.min(window.innerHeight - 64, ev.clientY - dy)),
            }));
        };
        const onUp = () => {
            shell.setFloatingRect(rectRef.current);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    /* 浮窗 resize:右下拖柄,min 320×240,上限不越视口右边/底边。 */
    const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX;
        const sy = e.clientY;
        const sw = rectRef.current.w;
        const sh = rectRef.current.h;
        const onMove = (ev: PointerEvent) => {
            setRect((r) => ({
                ...r,
                w: Math.round(Math.max(320, Math.min(window.innerWidth - r.x - 8, sw + (ev.clientX - sx)))),
                h: Math.round(Math.max(240, Math.min(window.innerHeight - r.y - 8, sh + (ev.clientY - sy)))),
            }));
        };
        const onUp = () => {
            shell.setFloatingRect(rectRef.current);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <>
            {/* 浮窗态侧栏不在流内,左缘拖宽条无对象 —— 同级条件渲染只动
                resizer 自己,aside 位置/类型不变,子树 DOM 零搬动。 */}
            {!floating && (
                <div
                    className="wb-resizer"
                    title="左右拖动调节右栏宽度 · 双击重置"
                    onPointerDown={onResizerDown}
                    onDoubleClick={() => setWidth(410)}
                >
                    <span className="wb-width-badge font-mono-ui">{width}px</span>
                </div>
            )}
            <aside
                className={floating ? 'floating-win pop-in' : 'h-full shrink-0'}
                style={floating
                    ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, maxWidth: 'none', maxHeight: 'none' }
                    : { width }}
            >
                <WorkbenchBody floating={floating} onFloatDrag={onFloatDrag} />
                {floating && <div className="wb-float-grip" title="拖拽调整大小" onPointerDown={onGripDown} />}
            </aside>
        </>
    );
}
