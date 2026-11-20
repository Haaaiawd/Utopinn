// 规范稿外框:top-chrome-bar(36px)| left-chrome(rail 56px + tree 228px +
// account-dock 102/58px)。壳不识域:rail 按钮/树体全走贡献点(nav.rail /
// sidebar.tree),齿轮→settings,头像→account pop。
import { useEffect, useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { Icon } from '../Icon';
import { LogoU } from '../LogoU';
import { listJobs, type JobSummary } from '../../api/jobs';
import { diagTraceParams, isJobTerminal } from '../panels/DiagPanel';

/**
 * 规范稿 top-job-slot:顶条 job 指示(平台件,钉死在壳里 —— 规范稿 D3 裁定
 * 倾向固定 chrome 元素而非新贡献槽;若未来三方要挂指示再开 chrome.job 点)。
 * 轮询 listJobs ~8s(document.hidden 跳过,回前台立即补拉):
 *   有在跑 job      → 「生成中」脉冲钮 → 直开该 job trace;
 *   最新 job 失败   → 「任务失败」红钮 → 直开该 job trace;
 *   否则            → 安静 Jobs 指示(离线时红点+「离线」)→ 开 diag 面板。
 */
function TopJobSlot() {
    const { t } = useI18n();
    const shell = useShell();
    const [jobs, setJobs] = useState<JobSummary[] | null>(null);

    useEffect(() => {
        let dead = false;
        const load = () => {
            void listJobs()
                .then((r) => { if (!dead) setJobs(r.items); })
                .catch(() => { /* 离线不刷屏 —— 状态点已表达 */ });
        };
        load();
        const iv = setInterval(() => { if (!document.hidden) load(); }, 8000);
        const onVis = () => { if (!document.hidden) load(); };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            dead = true;
            clearInterval(iv);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, []);

    const running = jobs?.find((j) => !isJobTerminal(j.status));
    const latest = jobs?.[0];
    const offline = shell.serverStatus === 'offline';

    const base = 'inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-mono-ui text-[11px] transition-colors';
    if (running) {
        return (
            <button
                className={base}
                style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}
                onClick={() => shell.openPanel('diag', diagTraceParams(running.id))}
                title={t('diag.job.runningTitle')}
            >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--brand)' }} />
                <span>{t('diag.job.running')}</span>
            </button>
        );
    }
    if (latest?.status === 'failed') {
        return (
            <button
                className={base}
                style={{ background: 'rgba(248,113,113,0.14)', color: 'var(--status-danger)' }}
                onClick={() => shell.openPanel('diag', diagTraceParams(latest.id))}
                title={t('diag.job.failedTitle')}
            >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--status-danger)' }} />
                <span>{t('diag.job.failed')}</span>
            </button>
        );
    }
    return (
        <button
            className={`${base} hover:bg-[color:var(--bg-active)]`}
            style={{ color: 'var(--fg-muted)' }}
            onClick={() => shell.openPanel('diag')}
            title={t('diag.job.idleTitle')}
        >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: offline ? 'var(--status-danger)' : 'var(--status-ok)' }} />
            <span>{offline ? t('diag.job.offline') : 'Jobs'}</span>
        </button>
    );
}

/** 36px 顶条:左双灯点 + 「Utopinn ·」字标;右 job-slot + Desktop/Mobile 分段。 */
export function TopChrome() {
    const shell = useShell();
    return (
        <header className="top-chrome-bar">
            <div className="flex items-center">
                <div className="flex w-[32px] items-center justify-center gap-1.5" aria-hidden="true">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--border-strong)' }} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--border-subtle)' }} />
                </div>
                <span className="heading-tight ml-3 flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--fg-secondary)]">
                    <span>Utopinn</span>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--brand)' }} />
                </span>
            </div>
            <div className="flex items-center gap-2">
                {/* 规范稿 top-job-slot:vp 切换左侧的 job 指示位 */}
                <TopJobSlot />
                {/* 规范稿 Desktop/Mobile 分段控件 */}
                <div className="inline-flex items-center rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-0.5">
                    {(['desktop', 'mobile'] as const).map((m) => {
                        const act = (m === 'mobile') === shell.isMobile;
                        return (
                            <button
                                key={m}
                                className="rounded-[6px] px-2.5 py-0.5 text-[11px] font-medium transition-colors"
                                style={act ? { background: 'var(--primary-bg)', color: 'var(--primary-fg)' } : { color: 'var(--fg-secondary)' }}
                                onClick={() => shell.setVpMode(m)}
                            >
                                {m === 'mobile' ? 'Mobile' : 'Desktop'}
                            </button>
                        );
                    })}
                </div>
            </div>
        </header>
    );
}

/** 56px rail 窄条(规范稿左侧 chrome 的固定列,四域按钮 38×38 / icon 20)。 */
function Rail() {
    const { t } = useI18n();
    const shell = useShell();
    const navs = useContribs('nav.rail');
    return (
        <nav className="flex w-[56px] shrink-0 flex-col items-center gap-1.5 pt-1">
            {navs.map((n) => {
                const active = shell.railTab === n.view;
                return (
                    <button
                        key={n.view}
                        className="rail-btn flex h-[38px] w-[38px] items-center justify-center rounded-[10px] transition-colors"
                        data-active={active || undefined}
                        style={active ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                        title={t(`nav.${n.view}`)}
                        onClick={() => {
                            shell.setView(n.view);
                            if (!shell.sidebarOpen) shell.toggleSidebar();
                        }}
                    >
                        <Icon name={n.icon} size={20} active={active} />
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
                    <img src="/assets/avatars/user-redpanda.png" alt="" className="h-full w-full rounded-full object-cover" />
                    <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border" style={{ background: 'var(--status-ok)', borderColor: 'var(--bg-chrome)' }} />
                </span>
                <span className="dock-meta-text">
                    <span className="truncate text-[12.5px] font-medium leading-none text-[color:var(--fg-primary)]">{t('acct.name')}</span>
                    <span className="mt-0.5 truncate text-[10.5px] leading-none text-[color:var(--fg-muted)]">{t('acct.plan')}</span>
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
    const rowCls = 'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-[12.5px] transition-colors hover:bg-[color:var(--bg-active)]';
    return (
        <div className="space-y-0.5 rounded-2xl p-1.5" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}>
            <div className="mb-1 flex items-center justify-between border-b border-[color:var(--border-hairline)] px-2.5 py-2">
                <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[color:var(--fg-primary)]">{t('acct.name')}</div>
                    <div className="truncate text-[11.5px] text-[color:var(--fg-muted)]">{t('acct.plan')}</div>
                </div>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--status-ok)' }} />
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

/** 账户锚点弹层(规范稿 account pop:左下 64px 锚定,字号/主题/语言/设置四行)。 */
function AccountPop() {
    const shell = useShell();
    return (
        <>
            <div className="fixed inset-0 z-[75]" onClick={() => shell.setAccountPopOpen(false)} />
            <div className="pop-in fixed bottom-2.5 left-[64px] z-[75] w-[248px]">
                <AccountPopCard />
            </div>
        </>
    );
}

/** 左 chrome:brand-header-row + 56px rail 常驻 + 228px tree 面板滑入 + 账户 dock。 */
export function LeftChrome() {
    const { t } = useI18n();
    const shell = useShell();
    const trees = useContribs('sidebar.tree');
    const domain = shell.railTab;
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
                    <span className="brand-wordmark pr-1.5">{t('app.name')}</span>
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
