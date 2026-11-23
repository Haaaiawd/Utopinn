// 规范稿外框:left-chrome(rail 64px + tree 228px + account-dock 102/58px)。
// 壳不识域:rail 按钮/树体全走贡献点(nav.rail / sidebar.tree),
// 齿轮→settings,头像→account pop。
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { createPortal } from 'react-dom';
import { personaAvatarSrc } from '../../api/personas';
import { Icon } from '../Icon';
import { LogoU } from '../LogoU';

/** 56px rail 窄条(规范稿左侧 chrome 的固定列,四域按钮 38×38 / icon 20)。 */
function Rail() {
    const { t } = useI18n();
    const shell = useShell();
    const navs = useContribs('nav.rail');
    return (
        <nav className="flex w-[64px] shrink-0 flex-col items-center gap-1.5 pt-1">
            {navs.map((n) => {
                const active = shell.railTab === n.view;
                return (
                    <button
                        key={n.view}
                        className="rail-btn flex h-[46px] w-[46px] items-center justify-center rounded-[12px] transition-colors"
                        data-active={active || undefined}
                        style={active ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                        title={t(`nav.${n.view}`)}
                        onClick={() => {
                            shell.setView(n.view);
                            if (!shell.sidebarOpen) shell.toggleSidebar();
                        }}
                    >
                        <Icon name={n.icon} size={26} active={active} />
                    </button>
                );
            })}
        </nav>
    );
}

/** 账户 dock:收起 102px 高(头像在上齿轮弧入),展开 58px(头像+双行文字+右侧齿轮)。 */
function AccountDock() {
    const { t } = useI18n();
    const shell = useShell();
    const dispName = shell.currentUser?.name || shell.currentUser?.handle || t('acct.name');
    const subLabel = shell.live
        ? (shell.currentUser?.handle ? `@${shell.currentUser.handle}` : t('acct.plan'))
        : t('diag.job.offline');
    const dotColor = shell.live ? 'var(--status-ok)' : 'var(--status-warn)';
    const activePersonaItem = shell.persona?.avatar ? shell.personas.find((p) => p.avatar === shell.persona!.avatar) : undefined;
    const avatarSrc = personaAvatarSrc(shell.persona?.avatar, activePersonaItem?.hasImage);
    return (
        <div className="account-dock">
            <button
                className="dock-account-btn"
                onClick={() => shell.setAccountPopOpen(!shell.accountPopOpen)}
                title={t('acct.menu')}
            >
                <span
                    className="dock-avatar-circle border"
                    style={{ background: 'var(--bg-active)', borderColor: shell.accountPopOpen ? 'var(--brand)' : 'var(--border-strong)' }}
                >
                    <img src={avatarSrc} alt="" className="h-full w-full rounded-full object-cover" onError={(e) => { e.currentTarget.src = '/assets/avatars/user-redpanda.png'; }} />
                    <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border" style={{ background: dotColor, borderColor: 'var(--bg-chrome)' }} />
                </span>
                <span className="dock-meta-text">
                    <span className="truncate text-[12.5px] font-medium leading-none text-[color:var(--fg-primary)]">{dispName}</span>
                    <span className="mt-0.5 truncate text-[10.5px] leading-none text-[color:var(--fg-muted)]">{subLabel}</span>
                </span>
            </button>
            <button
                className="dock-gear"
                onClick={() => shell.openSettings('api')}
                title={t('settings.title')}
            >
                <Icon name="settings" size={20} active={shell.settingsOpen} />
            </button>
            {shell.accountPopOpen && <AccountPop />}
        </div>
    );
}

/** 账户弹层卡片体 —— 桌面 fixed 锚卡 / 移动 in-shell 卡共用内容
 * (规范稿 renderAccountPopoverHtml 同一份 markup,仅锚定方式不同)。 */
export function AccountPopCard() {
    const { t, locale, setLocale } = useI18n();
    const shell = useShell();
    const { theme, toggle } = useTheme();
    const fs = shell.chatSettings.fontSize;
    const dispName = shell.currentUser?.name || shell.currentUser?.handle || t('acct.name');
    const subLabel = shell.live
        ? (shell.currentUser?.handle ? `@${shell.currentUser.handle}` : t('acct.plan'))
        : t('diag.job.offline');
    const rowCls = 'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-[12.5px] transition-colors hover:bg-[color:var(--bg-active)]';
    return (
        <div className="space-y-0.5 rounded-2xl p-1.5" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}>
            <div className="mb-1 flex items-center justify-between border-b border-[color:var(--border-hairline)] px-2.5 py-2">
                <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[color:var(--fg-primary)]">{dispName}</div>
                    <div className="truncate text-[11.5px] text-[color:var(--fg-muted)]">{subLabel}</div>
                </div>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: shell.live ? 'var(--status-ok)' : 'var(--status-warn)' }} />
            </div>
            {/* 规范稿字号行:A- / 值 / A+ */}
            <div className="flex items-center justify-between rounded-xl px-2.5 py-1.5">
                <span className="text-[12px] text-[color:var(--fg-secondary)]">{t('acct.fontSize')}</span>
                <div className="flex items-center gap-1">
                    <button className="ghost-btn h-6 w-6 text-xs" onClick={() => shell.setChatSetting('fontSize', Math.max(12, fs - 0.5))}>A-</button>
                    <span className="w-8 text-center font-mono-ui text-[11px] text-[color:var(--fg-primary)]">{fs}</span>
                    <button className="ghost-btn h-6 w-6 text-xs" onClick={() => shell.setChatSetting('fontSize', Math.min(18, fs + 0.5))}>A+</button>
                </div>
            </div>
            <button className={rowCls} onClick={toggle}>
                <span className="flex items-center gap-2.5">
                    <span className="text-[color:var(--fg-secondary)]"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} /></span>
                    <span className="text-[color:var(--fg-primary)]">{t('acct.theme')}</span>
                </span>
                <span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{theme === 'dark' ? t('acct.theme.dark') : t('acct.theme.light')}</span>
            </button>
            <button className={rowCls} onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>
                <span className="flex items-center gap-2.5">
                    <span className="text-[color:var(--fg-secondary)]"><Icon name="globe" size={16} /></span>
                    <span className="text-[color:var(--fg-primary)]">{t('acct.lang')}</span>
                </span>
                <span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{locale === 'zh-CN' ? '简体中文' : 'English'}</span>
            </button>
            <div className="my-1 h-px" style={{ background: 'var(--border-hairline)' }} />
            <button className={rowCls} onClick={() => { shell.setAccountPopOpen(false); shell.openSettings('api'); }}>
                <span className="flex items-center gap-2.5">
                    <span className="text-[color:var(--fg-secondary)]"><Icon name="settings" size={16} /></span>
                    <span className="text-[color:var(--fg-primary)]">{t('settings.title')}</span>
                </span>
            </button>
        </div>
    );
}

/** 账户锚点弹层(规范稿 account pop:左下 64px 锚定,字号/主题/语言/设置四行)。
 *  portal 出 body —— left-chrome 带 backdrop-filter + overflow:hidden,
 *  fixed 后代会被锁进 chrome 裁掉(弹层被 chat 框盖),portal 逃这个包含块。 */
function AccountPop() {
    const shell = useShell();
    return createPortal(
        <>
            <div className="fixed inset-0 z-[75]" onClick={() => shell.setAccountPopOpen(false)} />
            <div className="pop-in fixed bottom-2.5 left-[64px] z-[75] w-[248px]">
                <AccountPopCard />
            </div>
        </>,
        document.body,
    );
}

/** 左 chrome:brand-header-row + 56px rail 常驻 + 228px tree 面板滑入 + 账户 dock。 */
export function LeftChrome() {
    const { t } = useI18n();
    const shell = useShell();
    const trees = useContribs('sidebar.tree');
    /* 规范稿 renderSidebarBody:studio 特例 + plugins 域树,其余 rail 全回落
       chat 会话树 —— home 无专属树,与移动 drawer(drawerDomain)同一规则。 */
    const domain = shell.railTab === 'home' ? 'chat' : shell.railTab;
    const domainTrees = trees.filter((tr) => tr.rail === domain);
    return (
        <aside className="left-chrome" data-open={shell.sidebarOpen || undefined}>
            {/* Unified Top Brand Row:Logo+Utopinn 单按钮 + 右侧成对动作标 */}
            <div className="brand-header-row">
                <button
                    className="brand-pill-btn logo-btn"
                    onClick={shell.toggleSidebar}
                    title={t('chrome.toggleSidebar')}
                    aria-label="Utopinn"
                >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center"><LogoU size={26} /></span>
                    <span className="brand-wordmark">{t('app.name')}</span>
                </button>
                <div className="brand-actions">
                    <button className="ghost-btn h-8 w-8 rounded-[8px]" onClick={() => shell.setCmdkOpen(true)} title={t('chrome.search')}>
                        <Icon name="search" size={16} />
                    </button>
                    <button className="ghost-btn h-8 w-8 rounded-[8px]" onClick={() => shell.setView('home')} title={t('chrome.newCard')}>
                        <Icon name="pencil" size={16} />
                    </button>
                </div>
            </div>
            {/* Middle:56px rail + 228px tree(域树体由 sidebar.tree 贡献点出) */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
                <Rail />
                <aside className="left-tree-pane">
                    {domainTrees.map((tr) => <tr.Component key={tr.rail + String(tr.order)} />)}
                </aside>
            </div>
            <AccountDock />
        </aside>
    );
}
