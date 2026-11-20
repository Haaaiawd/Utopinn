// sidebar.tree 贡献体 —— 各域左树内容归 feature。
// chat 域:「+ 选择卡面」钮 + 置顶(卡头像环)+ 角色卡与会话分组(规范稿
// PROJECTS 树形:组头=卡头像+名+折角,子会话纯文本挂 hairline 竖线)。
// studio 域:板块目录;plugins 域:installed/market 两段 + 已激活列表。
import { useState } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import type { ChatSummary } from '../../types';
import { charImageUrl } from '../../api/characters';
import { charImgFallback } from '../stage/StageFrame';
import { STUDIO_NAV_META, normStudioNav, useStudioCounts } from '../views/studio';
import { pluginIcon, pluginLabel, useServerPlugins } from '../views/plugins';
import { MOCK_MARKET_PLUGINS } from '../../api/mock';

/** 规范稿段标:text-[11px] font-medium fg-muted(非 caps)。 */
const sect = 'flex items-center justify-between px-2 pb-1 text-[11px] font-medium text-[color:var(--fg-muted)]';

/** 卡圆形头像环(规范稿 char-avatar-ring w-5 h-5):真卡图,无图 → default-char。 */
function CardRing({ charDir, size = 20 }: { charDir: string; size?: number }) {
    const s = useShell();
    const card = s.cards.get(charDir);
    const src = card?.avatar ? charImageUrl(card.avatar) : '/assets/avatars/default-char.png';
    return (
        <span className="char-avatar-ring shrink-0" style={{ width: size, height: size }}>
            <img src={src} alt="" className="h-full w-full object-cover" onError={charImgFallback} />
        </span>
    );
}

/** 会话行时间:服务端 ISO → 同日 HH:mm / 昨天 / 周N / MM-DD(规范稿右列短签)。 */
export function relTime(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const dayMs = 86400000;
    const diff = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / dayMs);
    if (diff === 1) return '昨天';
    if (diff < 7) return `周${'日一二三四五六'[d.getDay()]}`;
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function SessionRow({ s }: { s: ChatSummary }) {
    const shell = useShell();
    const active = shell.activeChat === s.id && shell.railTab === 'chat';
    const rel = relTime(s.updatedAt);
    return (
        <button
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors"
            style={active ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
            onClick={() => shell.selectChat(s.id)}
        >
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            {s.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--brand)' }} />}
            {rel && <span className="shrink-0 font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{rel}</span>}
        </button>
    );
}

/** chat 域树(规范稿 renderSidebarBody 聊天分支逐行对拍)。 */
export function ChatTree() {
    const { t } = useI18n();
    const shell = useShell();
    const pinned = shell.chats.filter((c) => c.pinned);
    const rest = shell.chats.filter((c) => !c.pinned);
    /** 角色卡与会话:按 charDir 分组,组头=卡名。 */
    const groups = new Map<string, ChatSummary[]>();
    for (const c of rest) {
        const g = groups.get(c.charDir) ?? [];
        g.push(c);
        groups.set(c.charDir, g);
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* 桌面:顶部 h-1.5 呼吸位(规范稿无域头);移动 drawer 头部统一管 */}
            {!shell.isMobile && <div className="h-1.5 shrink-0" />}
            <div className="shrink-0 px-2.5 pb-3">
                {/* 规范稿:移动端此钮 = rail→home(卡画廊选面),桌面才直发 newChat */}
                <button
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-[9px] px-3 text-[12.5px] font-medium transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                    style={{ background: 'var(--bg-surface)', border: '1.5px solid var(--border-strong)', boxShadow: 'var(--shadow-card)', color: 'var(--fg-primary)' }}
                    onClick={() => (shell.isMobile ? shell.setView('home') : shell.newChat())}
                >
                    <Icon name="plus" size={15} />
                    <span>{t('tree.pickCard')}</span>
                </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 pb-4">
                {pinned.length > 0 && (
                    <div className="space-y-0.5">
                        <div className={sect}><span>{t('tree.pinned')}</span></div>
                        {pinned.map((s) => {
                            const active = shell.activeChat === s.id && shell.railTab === 'chat';
                            /* 规范稿置顶行:cardName · title 合成标签 */
                            const cardName = shell.cards.get(s.charDir)?.name ?? s.charDir;
                            return (
                                <button
                                    key={s.id}
                                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors"
                                    style={active ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                                    onClick={() => shell.selectChat(s.id)}
                                >
                                    <CardRing charDir={s.charDir} />
                                    <span className="min-w-0 flex-1 truncate">{cardName} · {s.title}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
                <div className="space-y-1.5">
                    <div className={sect}>
                        <span>{t('tree.cardSessions')}</span>
                        <button className="transition-colors hover:text-[color:var(--fg-primary)]" onClick={() => shell.setView(shell.isMobile ? 'hub' : 'studio')}>
                            {t('tree.manage')}
                        </button>
                    </div>
                    {[...groups.entries()].map(([dir, list]) => (
                        <ChatGroup key={dir} dir={dir} list={list} />
                    ))}
                </div>
            </div>
        </div>
    );
}

/** 卡组:头像环 + 卡名 + 折角;展开 → hairline 竖线挂纯文本子会话。 */
function ChatGroup({ dir, list }: { dir: string; list: ChatSummary[] }) {
    const shell = useShell();
    const card = shell.cards.get(dir);
    const [open, setOpen] = useState(true);
    return (
        <div>
            <button
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] font-medium transition-colors hover:bg-[color:var(--bg-surface)]"
                style={{ color: 'var(--fg-primary)' }}
                onClick={() => setOpen(!open)}
            >
                <CardRing charDir={dir} />
                <span className="min-w-0 flex-1 truncate">{card?.name || dir}</span>
                <span
                    className="shrink-0 transition-transform"
                    style={{ color: 'var(--fg-faint)', transform: open ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }}
                >
                    <Icon name="chevronDown" size={14} />
                </span>
            </button>
            {open && (
                <div className="ml-2.5 mt-0.5 space-y-0.5 border-l pl-4" style={{ borderColor: 'var(--border-hairline)' }}>
                    {list.map((s) => <SessionRow key={s.id} s={s} />)}
                </div>
            )}
        </div>
    );
}

/** studio 域树:h-12 域头 + 六类目录(端稿 studio nav;行尾带真实计数)。 */
export function StudioTree() {
    const { t } = useI18n();
    const shell = useShell();
    const counts = useStudioCounts();
    const nav = normStudioNav(shell.studioNav);
    return (
        <div className="flex h-full min-h-0 flex-col">
            {!shell.isMobile && (
                <div className="flex h-12 shrink-0 items-center px-3">
                    <span className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('nav.studio')}</span>
                </div>
            )}
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
                {STUDIO_NAV_META.map(({ id, icon }) => {
                    const act = nav === id;
                    return (
                        <button
                            key={id}
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13px] transition-colors"
                            style={act ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                            onClick={() => shell.setStudioNav(id)}
                        >
                            <span className="flex items-center gap-2.5">
                                <span style={{ color: act ? 'var(--fg-primary)' : 'var(--fg-muted)' }}><Icon name={icon} size={17} active={act} /></span>
                                <span>{t(`studio.nav.${id}`)}</span>
                            </span>
                            <span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{counts[id]}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** plugins 域树:h-12 域头 + installed/market 两键 + 已激活插件列(真清单)。 */
export function PluginsTree() {
    const { t } = useI18n();
    const shell = useShell();
    const plugins = useServerPlugins();
    const activeList = [
        ...(plugins.data?.items ?? [])
            .filter((p) => !p.disabled)
            .map((p) => ({ id: p.id, name: pluginLabel(p.id), icon: pluginIcon(p.id) })),
        ...MOCK_MARKET_PLUGINS.filter((p) => p.installed)
            .map((p) => ({ id: p.id, name: p.name, icon: p.icon as IconName })),
    ];
    return (
        <div className="flex h-full min-h-0 flex-col">
            {!shell.isMobile && (
                <div className="flex h-12 shrink-0 items-center px-3">
                    <span className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('nav.plugins')}</span>
                </div>
            )}
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 pb-4">
                <div className="space-y-0.5">
                    {(['installed', 'market'] as const).map((id) => {
                        const act = shell.pluginsNav === id;
                        return (
                            <button
                                key={id}
                                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13px] transition-colors"
                                style={act ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                                onClick={() => shell.setPluginsNav(id)}
                            >
                                <span>{t(`plugins.nav.${id}`)}</span>
                                <span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">
                                    {id === 'installed' ? activeList.length : MOCK_MARKET_PLUGINS.length}
                                </span>
                            </button>
                        );
                    })}
                </div>
                {activeList.length > 0 && (
                    <div className="space-y-1">
                        <div className={sect}><span>{t('tree.activePlugins')}</span></div>
                        {activeList.map((p) => (
                            <button
                                key={p.id}
                                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[color:var(--bg-surface)]"
                                style={{ color: 'var(--fg-secondary)' }}
                                onClick={() => shell.openSettings('plugins')}
                            >
                                <span
                                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-hairline)]"
                                    style={{ background: 'var(--bg-active)', color: 'var(--fg-primary)' }}
                                >
                                    <Icon name={p.icon} size={12} />
                                </span>
                                <span className="truncate">{p.name}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
