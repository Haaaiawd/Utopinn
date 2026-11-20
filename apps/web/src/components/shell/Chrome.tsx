// 规范稿外框:top-chrome-bar(36px)| left-chrome(rail 52px + tree 224px +
// account-dock 92/52px)。壳不识域:rail 按钮/树体全走贡献点(nav.rail /
// sidebar.tree),齿轮→settings,头像→account pop。
import { useEffect, useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
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

/** 36px 顶条:左 logo+分隔+域标题,右 vp 切换 + workbench 开关 + 状态点。 */
export function TopChrome() {
    const { t } = useI18n();
    const shell = useShell();
    const navs = useContribs('nav.rail');
    const cur = navs.find((n) => n.view === shell.railTab);
    const label = cur ? t(`nav.${cur.view}`) : t(`nav.${shell.view}`) !== `nav.${shell.view}` ? t(`nav.${shell.view}`) : t('app.name');
    return (
        <header className="top-chrome-bar">
            <div className="flex min-w-0 items-center gap-2">
                <button
                    className="logo-btn ghost-btn h-7 w-7 text-[color:var(--brand)]"
                    onClick={shell.toggleSidebar}
                    title={t('chrome.toggleSidebar')}
                    aria-label="Utopinn"
                >
                    <LogoU size={18} />
                </button>
                <span className="heading-tight truncate text-[12.5px] font-semibold text-[color:var(--fg-primary)]">{t('app.name')}</span>
                <span className="heading-tight truncate text-[12.5px] text-[color:var(--fg-secondary)]">· {label}</span>
            </div>
            <div className="flex items-center gap-1">
                <button className="ghost-btn h-7 w-7" onClick={() => shell.setCmdkOpen(true)} title="⌘K">
                    <Icon name="search" size={14} />
                </button>
                <button
                    className="ghost-btn h-7 w-7"
                    data-active={shell.workbenchOpen || undefined}
                    style={shell.workbenchOpen ? { color: 'var(--brand)' } : undefined}
                    onClick={shell.toggleWorkbench}
                    title={t('chrome.workbench')}
                >
                    <Icon name="penNib" size={14} />
                </button>
                {/* 规范稿 top-job-slot:vp 切换左侧的 job 指示位 */}
                <TopJobSlot />
                {/* 规范稿 Desktop/Mobile 分段控件 */}
                <div className="ml-1 flex h-6 items-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-0.5">
                    {(['desktop', 'mobile'] as const).map((m) => (
                        <button
                            key={m}
                            className="h-5 rounded-full px-2.5 text-[10px]"
                            style={(m === 'mobile') === shell.isMobile ? { background: 'var(--fg-primary)', color: 'var(--bg-canvas)' } : { color: 'var(--fg-muted)' }}
                            onClick={() => shell.setVpMode(m === 'mobile' ? 'mobile' : 'auto')}
                        >
                            {m === 'mobile' ? 'Mobile' : 'Desktop'}
                        </button>
                    ))}
                </div>
                <span
                    className="ml-1 inline-block h-1.5 w-1.5 rounded-full"
                    title={shell.serverStatus}
                    style={{
                        background: shell.serverStatus === 'online' ? 'var(--status-ok)'
                            : shell.serverStatus === 'mock' ? 'var(--status-warn)'
                            : shell.serverStatus === 'offline' ? 'var(--status-danger)' : 'var(--fg-faint)',
                    }}
                />
            </div>
        </header>
    );
}

/** 52px rail 窄条(规范稿左侧 chrome 的固定列,logo 之外五个域按钮)。 */
function Rail() {
    const { t } = useI18n();
    const shell = useShell();
    const navs = useContribs('nav.rail');
    return (
        <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 pb-2 pt-1">
            {navs.map((n) => {
                const active = shell.railTab === n.view;
                return (
                    <button
                        key={n.view}
                        className="rail-btn ghost-btn h-9 w-9"
                        data-active={active || undefined}
                        style={active ? { color: 'var(--brand)', background: 'var(--bg-active)' } : undefined}
                        title={t(`nav.${n.view}`)}
                        onClick={() => {
                            shell.setView(n.view);
                            if (!shell.sidebarOpen) shell.toggleSidebar();
                        }}
                    >
                        <Icon name={n.icon} size={17} />
                    </button>
                );
            })}
        </div>
    );
}

/** 账户 dock:收起 92px 高(头像在上齿轮弧入),展开 52px(头像+双行文字+右侧齿轮)。 */
function AccountDock() {
    const { t } = useI18n();
    const shell = useShell();
    const open = shell.sidebarOpen;
    return (
        <div className="account-dock">
            <button
                className="dock-account-btn"
                onClick={() => shell.setAccountPopOpen(!shell.accountPopOpen)}
                title={t('acct.menu')}
            >
                <span
                    className="dock-avatar-circle"
                    style={{ background: 'linear-gradient(135deg, var(--brand), #b04a3f)', color: 'var(--brand-fg)' }}
                >
                    掌
                </span>
                <span className="dock-meta-text">
                    <span className="truncate text-[12px] font-medium text-[color:var(--fg-primary)]">{t('acct.name')}</span>
                    <span className="truncate text-[10px] text-[color:var(--fg-muted)]">{t('acct.plan')}</span>
                </span>
            </button>
            <button
                className="dock-gear"
                onClick={() => shell.openSettings('api')}
                title={t('settings.title')}
            >
                <Icon name="gear" size={15} />
            </button>
            {shell.accountPopOpen && <AccountPop />}
        </div>
    );
}

/** 账户锚点弹层(规范稿 account pop:左下弹出 pop-in)。 */
function AccountPop() {
    const { t } = useI18n();
    const shell = useShell();
    const items: [string, import('../Icon').IconName][] = [
        ['acct.profile', 'user'],
        ['acct.usage', 'chart'],
        ['acct.theme', 'moon'],
        ['acct.signout', 'signOut'],
    ];
    return (
        <>
            <div className="fixed inset-0 z-[79]" onClick={() => shell.setAccountPopOpen(false)} />
            <div
                className="pop-in absolute bottom-1 left-1.5 z-[80] w-[188px] rounded-[10px] p-1"
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
            >
                <div className="px-2.5 pb-2 pt-2">
                    <div className="text-[12px] font-medium text-[color:var(--fg-primary)]">{t('acct.name')}</div>
                    <div className="mt-0.5 text-[10.5px] text-[color:var(--fg-muted)]">{t('acct.mail')}</div>
                </div>
                <div className="my-1 h-px bg-[color:var(--border-hairline)]" />
                {items.map(([k, icon]) => (
                    <button
                        key={k}
                        className="ghost-btn w-full justify-start gap-2.5 rounded-md px-2.5 py-[7px] text-[12px]"
                        onClick={() => {
                            shell.setAccountPopOpen(false);
                            if (k === 'acct.theme') {
                                document.documentElement.classList.toggle('light');
                            } else if (k === 'acct.signout') {
                                shell.hint(t('acct.signout.hint'));
                            } else {
                                shell.openSettings('chat');
                            }
                        }}
                    >
                        <Icon name={icon} size={13} />
                        {t(k)}
                    </button>
                ))}
            </div>
        </>
    );
}

/** 左 chrome:52px rail 常驻 + 224px tree 面板(276-52)滑入 + 底部账户 dock。 */
export function LeftChrome() {
    const shell = useShell();
    const trees = useContribs('sidebar.tree');
    const domain = shell.railTab;
    const domainTrees = trees.filter((tr) => tr.rail === domain);
    return (
        <aside className="left-chrome" data-open={shell.sidebarOpen || undefined}>
            <div className="flex min-h-0 flex-1">
                <Rail />
                <div className="left-tree-pane">
                    <div className="flex h-9 shrink-0 items-center justify-between px-3">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">
                            {domainTrees[0] ? <PaneTitle domain={domain} /> : ''}
                        </span>
                    </div>
                    <div className="scroll-fade-mask min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                        {domainTrees.map((tr) => <tr.Component key={tr.rail + String(tr.order)} />)}
                    </div>
                </div>
            </div>
            <AccountDock />
        </aside>
    );
}

function PaneTitle({ domain }: { domain: string }) {
    const { t } = useI18n();
    return <>{t(`pane.${domain}`)}</>;
}
