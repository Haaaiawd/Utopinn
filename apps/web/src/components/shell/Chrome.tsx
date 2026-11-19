// 顶层 chrome 条 + 左侧 chrome(rail + 可展树 + 账户 dock)。
// 规范稿 688–735:52px rail / 276px 展开宽 / dock 高度 92→52 的空间连续动画。
// rail 条目 = nav.rail 贡献点;树体 = sidebar.tree 贡献点按 railTab 渲染。
import { useEffect } from 'react';
import { useI18n } from '../../i18n';
import { useContribs, useShell } from '../../kernel/context';
import { useTheme } from '../../theme';
import { Icon } from '../Icon';
import { LogoU } from '../LogoU';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { RAIL_VIEWS, type RailId } from '../../types';

export function TopChrome() {
    const { t } = useI18n();
    const { setCmdkOpen, toggleWorkbench, serverStatus } = useShell();
    const { theme, toggle: toggleTheme } = useTheme();
    return (
        <header className="top-chrome-bar">
            <div className="flex items-center gap-1.5">
                <button type="button" className="logo-btn ghost-btn h-7 gap-1.5 px-2" title="Utopinn">
                    <LogoU size={20} />
                    <span className="heading-tight text-[13px]">{t('app.name')}</span>
                </button>
                {/* 全局搜索 → cmdk */}
                <button type="button" className="ghost-btn h-7 gap-2 px-2 text-[12px]"
                    onClick={() => setCmdkOpen(true)} title={t('cmdk.hint')}>
                    <Icon name="search" size={13} />
                    <span className="text-[color:var(--fg-faint)]">{t('cmdk.hint')}</span>
                    <kbd className="font-mono-ui rounded border border-[color:var(--border-subtle)] px-1 text-[10px] text-[color:var(--fg-muted)]">⌘K</kbd>
                </button>
            </div>
            <div className="flex items-center gap-1">
                {/* 服务器状态点(诚实指示,不写活字) */}
                <span className="mr-1 flex items-center gap-1.5 text-[11px] text-[color:var(--fg-muted)]">
                    <span className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: serverStatus === 'online' ? 'var(--status-ok)' : serverStatus === 'mock' ? 'var(--status-warn)' : 'var(--status-danger)' }} />
                    {t(`status.${serverStatus}`)}
                </span>
                <button type="button" className="ghost-btn h-7 w-7" title={t('shell.theme')}
                    onClick={toggleTheme}>
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
                </button>
                <button type="button" className="ghost-btn h-7 w-7" title={t('shell.workbench')}
                    onClick={toggleWorkbench}>
                    <Icon name="panelRight" size={14} mirrored />
                </button>
            </div>
        </header>
    );
}

/** rail 单键:图标 + 激活时左缘 4px brand 棘条(规范稿 .rail-btn)。 */
function RailBtn({ rail, icon, label }: { rail: RailId; icon: Parameters<typeof Icon>[0]['name']; label: string }) {
    const { view, setView, sidebarCollapsed, toggleSidebar } = useShell();
    const active = view === rail;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" data-active={active ? 'true' : 'false'} onClick={() => {
                    if (active) toggleSidebar();
                    else { setView(rail); if (sidebarCollapsed) toggleSidebar(); }
                }}
                    className="rail-btn ghost-btn h-9 w-9 text-[color:var(--fg-secondary)] data-[active=true]:text-[color:var(--fg-primary)]">
                    <Icon name={icon} size={19} weight={active ? 'duotone' : 'regular'} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
    );
}

export function LeftChrome() {
    const { t } = useI18n();
    const { railTab, sidebarCollapsed, accountPopOpen, setAccountPopOpen, openSettings, serverStatus } = useShell();
    const railContribs = useContribs('nav.rail');
    const trees = useContribs('sidebar.tree').filter((s) => s.rail === railTab).sort((a, b) => a.order - b.order);
    // 关弹层:点击外部 / Esc
    useEffect(() => {
        if (!accountPopOpen) return;
        const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof MouseEvent || e.key === 'Escape') setAccountPopOpen(false); };
        window.addEventListener('mousedown', close);
        window.addEventListener('keydown', close);
        return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); };
    }, [accountPopOpen, setAccountPopOpen]);

    const rails = RAIL_VIEWS.map((id) => railContribs.find((r) => r.view === id)).filter((r) => r != null);

    return (
        <aside className="left-chrome" data-open={!sidebarCollapsed}>
            <div className="flex min-w-0 flex-1">
                {/* 52px rail */}
                <nav className="flex w-[52px] shrink-0 flex-col items-center gap-1 pt-2">
                    {rails.map((r) => (
                        <RailBtn key={r.view} rail={r.view as RailId} icon={r.icon} label={t(`nav.${r.view}`)} />
                    ))}
                </nav>
                {/* 224px 树面板(展开时见) */}
                <div className="left-tree-pane">
                    <div className="flex items-center justify-between px-3 pb-1 pt-3">
                        <span className="text-[12px] font-medium text-[color:var(--fg-muted)]">{t(`rail.${railTab}`)}</span>
                    </div>
                    <div className="scroll-fade-mask no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                        {trees.map(({ Component }, i) => <Component key={i} />)}
                    </div>
                </div>
            </div>
            {/* 账户 dock:折叠 92px 高(齿轮在头像上方),展开 52px(齿轮 90° 转到右缘) */}
            <div className="account-dock">
                <button type="button" className="dock-account-btn" onClick={() => setAccountPopOpen(!accountPopOpen)}>
                    <span className="dock-avatar-circle border border-[color:var(--border-strong)] bg-[color:var(--bg-active)] text-[color:var(--fg-secondary)]">
                        旅
                        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--bg-chrome)]"
                            style={{ background: serverStatus === 'online' ? 'var(--status-ok)' : 'var(--status-warn)' }} />
                    </span>
                    <span className="dock-meta-text">
                        <span className="truncate text-[13px] text-[color:var(--fg-primary)]">旅人</span>
                        <span className="truncate text-[11px] text-[color:var(--fg-muted)]">{t('dock.sub')}</span>
                    </span>
                </button>
                <button type="button" className="dock-gear" title={t('nav.settings')} onClick={() => openSettings()}>
                    <Icon name="settings" size={16} />
                </button>
                {accountPopOpen && (
                    <div className="pop-in absolute bottom-[60px] left-2 z-[80] w-[224px] rounded-[10px] bg-[color:var(--bg-elevated)] p-1.5 shadow-[var(--shadow-pop)]"
                        onMouseDown={(e) => e.stopPropagation()}>
                        {(['dock.profile', 'dock.usage', 'dock.shortcuts'] as const).map((k) => (
                            <button key={k} type="button" className="inset-row inset-row-btn rounded-[8px] text-[12px] text-[color:var(--fg-secondary)]"
                                onClick={() => { setAccountPopOpen(false); openSettings(); }}>{t(k)}</button>
                        ))}
                        <button type="button" className="inset-row inset-row-btn rounded-[8px] text-[12px] text-[color:var(--status-danger)]"
                            onClick={() => { setAccountPopOpen(false); }}>
                            {t('dock.logout')} {/* SPEC-DATA: 待接 —— 会话管理端点未出 */}
                        </button>
                    </div>
                )}
            </div>
        </aside>
    );
}
