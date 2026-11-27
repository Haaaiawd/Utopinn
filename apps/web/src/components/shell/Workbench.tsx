// 规范稿右工作台:wb-resizer(拖宽/双击 410 复位) + aside(宽条)|
// h-12 tab 条(openTabs +「+ 新标签页」)+ 板块池 + 逐板块悬浮窗
// (detach/dockPanel/closeFloat/floatToFront,矩形记忆 + 点击置顶)。
// 壳不识板块类型 —— 体与目录元数据全走 'panel.type' 贡献点,launcher 由贡献目录自动生成。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    useShell, useContribs,
    DEFAULT_FLOAT_RECT, FLOAT_MIN_W, FLOAT_MIN_H,
    type FloatRect,
} from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import type { PanelType, PanelTypeContribution } from '../../kernel/contributions';
import { cardAppInfo, type CardAppInfo } from '../../api/cardRuntime';
import { charImageUrl } from '../../api/characters';
import { builtinCoverSrc } from '../../api/personas';
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
    /* 当前会话情境行:launcher 顶对齐后首部用「你在开谁的面板」压住场,
       不空顶(群会话无卡头像 → 只列会话名)。 */
    const chat = shell.chat;
    const card = chat?.charDir ? shell.cards.get(chat.charDir) : undefined;
    /* 本会话已开板块(openTabs ∪ floatOrder)—— launcher 行给「已开」
       尾标,重开=回到该页而非误以为没开成。 */
    const isOpen = (type: string) => shell.openTabs.includes(type) || shell.floatOrder.includes(type);
    const openTag = (
        <span className="ml-auto shrink-0 rounded-full bg-[color:var(--bg-active)] px-1.5 py-px text-[9.5px] text-[color:var(--fg-muted)]">
            {t('wb.launcher.open')}
        </span>
    );
    return (
        <div className="flex min-h-0 flex-1 flex-col justify-start overflow-y-auto overscroll-contain px-5 pb-8 pt-5">
            <div className="mx-auto w-full max-w-[440px] space-y-7">
                {chat && (
                    <div className="flex items-center gap-3 px-0.5">
                        {chat.charDir && (
                            <img
                                src={card?.avatar ? charImageUrl(card.avatar) : builtinCoverSrc(chat.charDir)}
                                alt=""
                                className="h-9 w-9 shrink-0 rounded-[10px] border border-[color:var(--border-hairline)] object-cover"
                                onError={(e) => { e.currentTarget.src = builtinCoverSrc(chat.charDir!); }}
                            />
                        )}
                        <div className="min-w-0">
                            <div className="truncate text-[12.5px] font-medium leading-tight text-[color:var(--fg-primary)]">
                                {card?.name ?? chat.title}
                            </div>
                            <div className="mt-0.5 truncate font-mono-ui text-[10.5px] leading-tight text-[color:var(--fg-faint)]">
                                {chat.title}
                            </div>
                        </div>
                    </div>
                )}
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
                                    <span className="flex shrink-0 items-center gap-2">
                                        {isOpen(c.type) && openTag}
                                        <span className="font-mono-ui text-[10.5px] text-[color:var(--brand)]">{t('wb.launcher.iframe')}</span>
                                    </span>
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
                                    <span className="min-w-0 truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{panelTitle(t, c)}</span>
                                    {isOpen(c.type) && openTag}
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
                                    {isOpen(c.type) ? openTag : <Icon name="plus" size={13} className="text-[color:var(--fg-faint)]" />}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/** wb tab 条:h-12 px-4(板块 tabs +「+ 新标签页」+ 右钮组);
 *  移动端右钮组由 desk-only 隐藏(sheet 有对等物)。 */
function WorkbenchTabsRow() {
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
                            {/* 移动 tab 密度:未激活窄截断(60px≈2-3 字)给激活让位,
                                激活页放全名槽(140px);桌面保持 110 原稿。 */}
                            <span className={`max-w-[110px] truncate ${active ? 'mob:max-w-[140px]' : 'mob:max-w-[60px]'}`}>{tb.label}</span>
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
                    本体是 .cardapp-host 切 fixed inset-0,同树不 remount。
                    移动对等物是 sheet 的 full 档(openPanel/selectTab 自动升),
                    desk-only 藏钮不藏功能。 */}
                {cardappTab && (
                    <button className="ghost-btn h-7 w-7 desk-only" onClick={() => shell.setCardappFs(true)} title={t('wb.fs')}>
                        <Icon name="focus" size={15} />
                    </button>
                )}
                {/* 规范稿 detach-panel —— v3 逐板块:激活页摘出为独立浮窗;
                    launcher 页无对象不画,移动端不出(屏小浮窗没意义)。 */}
                {!launcherActive && shell.activeTab && shell.openTabs.includes(shell.activeTab) && (
                    <button className="ghost-btn h-7 w-7 desk-only" onClick={() => shell.detachPanel(shell.activeTab)} title={t('wb.detach')}>
                        <Icon name="detach" size={15} />
                    </button>
                )}
                {/* 占满聊天区:右栏吃整个 workspace-inset(main 压 0 宽不 unmount),
                    还原回原宽 —— CardApp/TH JS 的大视面通道。 */}
                <button className="ghost-btn h-7 w-7 desk-only" onClick={() => shell.setWbExpand(!shell.wbExpand)} title={shell.wbExpand ? t('wb.restore') : t('wb.expand')}>
                    <Icon name={shell.wbExpand ? 'dockBack' : 'wbExpand'} size={15} />
                </button>
                <button className="ghost-btn h-7 w-7 desk-only" onClick={shell.toggleWorkbench} title={t('wb.collapse')}>
                    <Icon name="x" size={15} />
                </button>
            </div>
        </div>
    );
}

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 浮窗八向缩放的拖拽方向;光标映射给热区样式 + 拖拽中 body 锁形。 */
type FloatResizeDir = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
const RZ_CURSORS: Record<FloatResizeDir, string> = {
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
};

/** 单板块宿主槽 —— 板块池里按 type keyed 的常驻位:
 *  docked(右栏体)与 floating(浮窗壳)是「同一个 div 换 className」,
 *  DOM 不搬、React 子树不换 —— 嵌卡 iframe detach/dock 零 remount(§6.2)。
 *  浮窗 chrome(标题栏/缩放柄)挂在 body 槽之后的兄弟位:body 槽恒定
 *  子位[0],chrome 增删不触 body DOM;标题栏 order:-1 视觉置顶。 */
function PoolSlot({ type, isMobile, docked }: { type: PanelType; isMobile: boolean; docked: boolean }) {
    const { t } = useI18n();
    const shell = useShell();
    const contribs = useContribs('panel.type');
    const floatIdx = shell.floatOrder.indexOf(type);
    const floating = !isMobile && floatIdx >= 0;
    const live = floating || docked;
    /* rect 本地跟手(拖/resize 每帧只重渲本槽),pointerup 才写回 ctx —
       写回经 WbLayout 持久化段落盘。layout-effect 同步:存档/钳位改档
       在 paint 前落位,浮出瞬间不闪默认位。 */
    const stored = shell.floatRects[type];
    const [rect, setRect] = useState<FloatRect>(() => stored ?? DEFAULT_FLOAT_RECT);
    const rectRef = useRef(rect);
    rectRef.current = rect;
    useLayoutEffect(() => { if (stored) setRect(stored); }, [stored]);
    if (!live) return null;

    const c = contribs.find((x) => x.type === type);
    const zIndex = 70 + Math.min(floatIdx, 12);   // 规范稿 z 层 float 70,天花板让位 modal 85

    /* 标题栏拖拽:钮/输入上不启动;整窗钳在视口内(不许拖出)。 */
    const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        e.preventDefault();
        const dx = e.clientX - rectRef.current.x;
        const dy = e.clientY - rectRef.current.y;
        const onMove = (ev: PointerEvent) => {
            setRect((r) => ({
                ...r,
                x: Math.round(clampN(ev.clientX - dx, 0, Math.max(0, window.innerWidth - r.w))),
                y: Math.round(clampN(ev.clientY - dy, 0, Math.max(0, window.innerHeight - r.h))),
            }));
        };
        const onUp = () => {
            shell.setFloatRect(type, rectRef.current);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    /* 八向缩放(边 N/S/E/W + 四角):E/S 只改尺寸(锚左上),W/N 位置
       尺寸同改(锚右/下边)。每帧从 r0 快照单向推导,不累积误差;
       拖拽中钳 min + 视口 8px 余量,松手 setFloatRect→clampFloatRect 收口。
       不 stopPropagation —— 冒泡到壳触发 floatToFront,拖边也置顶。 */
    const onResizeDown = (dir: FloatResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const r0 = rectRef.current;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        document.body.style.cursor = RZ_CURSORS[dir];
        const onMove = (ev: PointerEvent) => {
            const dx = ev.clientX - sx;
            const dy = ev.clientY - sy;
            let { x, y, w, h } = r0;
            if (dir.includes('e')) w = clampN(r0.w + dx, FLOAT_MIN_W, Math.max(FLOAT_MIN_W, vw - r0.x - 8));
            if (dir.includes('s')) h = clampN(r0.h + dy, FLOAT_MIN_H, Math.max(FLOAT_MIN_H, vh - r0.y - 8));
            if (dir.includes('w')) {
                /* 锚右边:x+w 不动,w 变 x 跟;上限 x≥8(对称 SE 的 8px 余量)。 */
                w = clampN(r0.w - dx, FLOAT_MIN_W, Math.max(FLOAT_MIN_W, r0.x + r0.w - 8));
                x = r0.x + r0.w - w;
            }
            if (dir.includes('n')) {
                h = clampN(r0.h - dy, FLOAT_MIN_H, Math.max(FLOAT_MIN_H, r0.y + r0.h - 8));
                y = r0.y + r0.h - h;
            }
            setRect({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
        };
        const onUp = () => {
            document.body.style.cursor = '';
            shell.setFloatRect(type, rectRef.current);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <div
            className={floating ? 'floating-win pop-in' : 'h-full min-h-0'}
            style={floating
                ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, maxWidth: 'none', maxHeight: 'none', zIndex }
                : undefined}
            onPointerDown={floating ? () => shell.floatToFront(type) : undefined}
        >
            {/* body 槽:恒定子位[0] —— docked↔floating 只换 class,
                不搬 DOM 节点,PanelBody/嵌卡 iframe 全程不死。 */}
            <div className={floating ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : 'h-full overflow-y-auto overscroll-contain'}>
                <PanelBody type={type} />
            </div>
            {floating && (
                <div className="wb-float-bar" onPointerDown={onBarDown}>
                    <span className="shrink-0 text-[color:var(--fg-muted)]">
                        <Icon name={c?.icon ?? 'layout'} size={14} />
                    </span>
                    <span className="wb-float-title">{panelTitle(t, c, type)}</span>
                    <button type="button" className="ghost-btn h-6 w-6 shrink-0" onClick={() => shell.dockPanel(type)} title={t('wb.dockPanel')}>
                        <Icon name="dockBack" size={13} />
                    </button>
                    <button type="button" className="ghost-btn h-6 w-6 shrink-0" onClick={() => shell.closeFloat(type)} title={t('wb.close')}>
                        <Icon name="x" size={13} />
                    </button>
                </div>
            )}
            {/* 八向隐形热区:7 条透明边/角(SE 角由下方可见握把兼任)。 */}
            {floating &&
                (['n', 's', 'e', 'w', 'nw', 'ne', 'sw'] as const).map((d) => (
                    <div key={d} className={`wb-float-rz wb-float-rz-${d}`} onPointerDown={onResizeDown(d)} />
                ))}
            {floating && <div className="wb-float-grip" title={t('wb.floatGrip')} onPointerDown={onResizeDown('se')} />}
        </div>
    );
}

/** 板块池:launcher + 按 type keyed 的常驻槽位。
 *  池序 = DOM 稳定序(挂载即尾插、闭合才移除):dock/float/置顶只改
 *  className 与 zIndex,数组序不动 → keyed 槽 DOM 零搬动。 */
function WorkbenchPool({ isMobile = false, dockedLive = true }: { isMobile?: boolean; dockedLive?: boolean }) {
    const shell = useShell();
    const poolRef = useRef<PanelType[]>([]);
    const union = [...shell.openTabs, ...shell.floatOrder.filter((tp) => !shell.openTabs.includes(tp))];
    poolRef.current = poolRef.current.filter((tp) => union.includes(tp));
    for (const tp of union) if (!poolRef.current.includes(tp)) poolRef.current.push(tp);

    const launcherActive = shell.activeTab === 'newtab' || !shell.activeTab;
    const dockedActive = dockedLive && !launcherActive && shell.openTabs.includes(shell.activeTab) ? shell.activeTab : null;
    const showLauncher = dockedLive && !dockedActive;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {showLauncher && <Launcher key="__launcher" isMobile={isMobile} />}
            {poolRef.current.map((tp) => (
                <PoolSlot key={tp} type={tp} isMobile={isMobile} docked={dockedActive === tp} />
            ))}
        </div>
    );
}

/** wb 体:tab 条 + 板块池 —— 桌面 aside 与移动 sheet 共用。
 *  dockedLive=false(工作台收折)时只留池:浮窗活着,tab 条/停靠体不渲。 */
export function WorkbenchBody({ isMobile = false, dockedLive = true }: { isMobile?: boolean; dockedLive?: boolean }) {
    return (
        <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-workbench)' }}>
            {dockedLive && <WorkbenchTabsRow />}
            <WorkbenchPool isMobile={isMobile} dockedLive={dockedLive} />
        </div>
    );
}

/** 右工作台:wb-resizer(宽 290–min(680,56vw),双击复位 410)+ 变宽 aside。
 *  浮窗 v3(逐板块,§6.2 detach 不杀卡):板块池常驻 aside 内,浮窗槽只是
 *  池中 div 换 fixed 壳 —— 工作台收折时 aside 留壳保活(w-0 不占位),
 *  浮窗不受收折影响,嵌卡 iframe 全程零 remount。 */
export function Workbench() {
    const shell = useShell();
    const [width, setWidth] = useState(410);
    const widthRef = useRef(width);
    widthRef.current = width;
    const open = shell.workbenchOpen;
    const hasFloats = shell.floatOrder.length > 0;
    if (!open && !hasFloats) return null;

    /* 磁吸阈值(按视口宽):请求宽 ≥ 2/3 → 放手吸成「占满聊天区」;
       ≤ 1/4 → 放手吸成「全屏聊天」(收起工作台)。中间正常定宽。 */
    const onResizerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        const startX = e.clientX;
        const startW = widthRef.current;
        const vw = window.innerWidth;
        const maxW = Math.min(680, Math.floor(vw * 0.56));
        const minW = 290;
        let snap: 'expand' | 'close' | null = null;
        const onMove = (ev: PointerEvent) => {
            const req = startW + (startX - ev.clientX);
            snap = req >= vw * 0.66 ? 'expand' : req <= vw * 0.25 ? 'close' : null;
            setWidth(Math.round(Math.max(minW, Math.min(maxW, req))));
        };
        const onUp = () => {
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (snap === 'expand') { setWidth(410); shell.setWbExpand(true); }
            else if (snap === 'close') { setWidth(410); shell.toggleWorkbench(); }
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <>
            {open && !shell.wbExpand && (
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
                className={open ? (shell.wbExpand ? 'h-full min-w-0 flex-1' : 'h-full shrink-0') : 'w-0 shrink-0'}
                style={open && !shell.wbExpand ? { width } : undefined}
            >
                <WorkbenchBody dockedLive={open} />
            </aside>
        </>
    );
}
