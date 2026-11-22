// sidebar.tree 贡献体 —— 各域左树内容归 feature。
// chat 域:「+ 选择卡面」钮 + 置顶(卡头像环)+ 角色卡与会话分组(规范稿
// PROJECTS 树形:组头=卡头像+名+折角,子会话纯文本挂 hairline 竖线)。
// studio 域:板块目录;plugins 域:installed/market 两段 + 已激活列表。
import { useEffect, useRef, useState } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import type { ChatSummary } from '../../types';
import { charImageUrl } from '../../api/characters';
import { builtinCoverSrc } from '../../api/personas';
import { charImgFallback } from '../stage/StageFrame';
import { STUDIO_NAV_META, normStudioNav, useStudioCounts } from '../views/studio';
import { pluginIcon, pluginLabel, useServerPlugins } from '../views/plugins';
import { MOCK_MARKET_PLUGINS } from '../../api/mock';

/** 规范稿段标:text-[11px] font-medium fg-muted(非 caps)。 */
const sect = 'flex items-center justify-between px-2 pb-1 text-[11px] font-medium text-[color:var(--fg-muted)]';

/** 卡圆形头像环(规范稿 char-avatar-ring w-5 h-5):真卡图,无图 → 内置卡面轮换(charDir 定面)。 */
function CardRing({ charDir, size = 20 }: { charDir: string; size?: number }) {
    const s = useShell();
    const card = s.cards.get(charDir);
    const src = card?.avatar ? charImageUrl(card.avatar) : builtinCoverSrc(charDir);
    return (
        <span className="char-avatar-ring shrink-0" style={{ width: size, height: size }}>
            <img src={src} alt="" className="h-full w-full object-cover" onError={charImgFallback} data-cover-key={charDir} />
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

/** 会话行 —— ChatGPT 式:「···」行菜单(置顶/重命名/删除两步),
 *  重命名走行内输入框,原生 prompt/confirm 全部退场。 */
function SessionRow({ s, showCard }: { s: ChatSummary; showCard?: boolean }) {
    const { t } = useI18n();
    const shell = useShell();
    const active = shell.activeChat === s.id && shell.railTab === 'chat';
    const rel = relTime(s.updatedAt);
    const isDemo = s.id.startsWith('st-') || s.id === 'c1' || s.id === 'c2';
    const canAct = !isDemo && shell.live;
    const [menuOpen, setMenuOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState(s.chatName);
    const [delArmed, setDelArmed] = useState(false);
    const rowRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    /* 点外行/菜单外 → 收菜单、弃删除武装;Esc 同理。 */
    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: PointerEvent) => {
            if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
                setMenuOpen(false); setDelArmed(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { setMenuOpen(false); setDelArmed(false); }
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);

    const cardName = showCard ? (shell.cards.get(s.charDir)?.name ?? s.charDir) : '';
    const commitRename = () => {
        setRenaming(false);
        shell.renameChat(s, renameDraft);
    };
    const menuBtn = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[color:var(--bg-active)]';

    return (
        <div
            ref={rowRef}
            className="group/srow relative flex w-full items-center justify-between gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[color:var(--bg-surface)]"
            style={active ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
        >
            {renaming ? (
                <input
                    ref={inputRef}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        else if (e.key === 'Escape') { setRenaming(false); setRenameDraft(s.chatName); }
                    }}
                    onBlur={commitRename}
                    className="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-[12.5px] outline-none"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--fg-primary)', border: '1px solid var(--brand)' }}
                />
            ) : (
                <button type="button" className={`min-w-0 flex-1 truncate text-left ${isDemo ? 'opacity-55' : ''}`} onClick={() => shell.selectChat(s.id)}>
                    {showCard ? `${cardName} · ${s.title}` : s.title}
                </button>
            )}
            {isDemo && <span className="shrink-0 font-mono-ui text-[10px] uppercase text-[color:var(--fg-faint)]">{t('chat.demo')}</span>}
            {s.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--brand)' }} />}
            {canAct && (
                <button
                    type="button"
                    className={`ghost-btn h-5 w-5 shrink-0 ${shell.isMobile || menuOpen ? 'inline-flex' : 'hidden group-hover/srow:inline-flex'}`}
                    title={t('chat.menu')}
                    onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); setDelArmed(false); }}
                >
                    <Icon name="more" size={12} />
                </button>
            )}
            {rel && <span className={`shrink-0 font-mono-ui text-[11px] text-[color:var(--fg-faint)] ${canAct && !shell.isMobile ? 'group-hover/srow:hidden' : ''}`}>{rel}</span>}
            {menuOpen && (
                <div
                    className="absolute right-1 top-full z-30 mt-0.5 w-36 overflow-hidden rounded-lg p-1"
                    style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button type="button" className={menuBtn} style={{ color: 'var(--fg-secondary)' }}
                        onClick={() => { setMenuOpen(false); shell.togglePin(s); }}>
                        <Icon name="pin" size={12} />
                        {s.pinned ? t('chat.unpin') : t('chat.pin')}
                    </button>
                    <button type="button" className={menuBtn} style={{ color: 'var(--fg-secondary)' }}
                        onClick={() => { setMenuOpen(false); setRenameDraft(s.chatName); setRenaming(true); }}>
                        <Icon name="pencil" size={12} />
                        {t('chat.rename')}
                    </button>
                    <button
                        type="button"
                        className={menuBtn}
                        style={{ color: delArmed ? '#fff' : 'var(--status-danger)', background: delArmed ? 'var(--status-danger)' : undefined }}
                        onClick={() => {
                            if (!delArmed && shell.chatSettings.confirmDelete) { setDelArmed(true); return; }
                            setMenuOpen(false); shell.deleteChat(s);
                        }}
                    >
                        <Icon name="trash" size={12} />
                        {delArmed ? t('chat.delete.armed') : t('stage.op.del')}
                    </button>
                </div>
            )}
        </div>
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
                        {pinned.map((s) => <SessionRow key={s.id} s={s} showCard />)}
                    </div>
                )}
                <div className="space-y-1.5">
                    <div className={sect}>
                        <span>{t('tree.cardSessions')}</span>
                    </div>
                    {[...groups.entries()].map(([dir, list]) => (
                        <ChatGroup key={dir} dir={dir} list={list} />
                    ))}
                </div>
            </div>
        </div>
    );
}

/** 卡组:头像环 + 卡名 + 新建会话(+) + 折角;展开 → hairline 竖线挂子会话。 */
function ChatGroup({ dir, list }: { dir: string; list: ChatSummary[] }) {
    const { t } = useI18n();
    const shell = useShell();
    const card = shell.cards.get(dir);
    const [open, setOpen] = useState(true);
    return (
        <div>
            <div className="group/cgroup flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-[color:var(--bg-surface)]" style={{ color: 'var(--fg-primary)' }}>
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)}>
                    <CardRing charDir={dir} />
                    <span className="min-w-0 flex-1 truncate">{card?.name || dir}</span>
                </button>
                {/* 组头二级动作(hover 显现):角色页 → 新会话 —— TASK-026
                    角色=一等对象,侧栏也给入口,不只有卡墙一条路。 */}
                <button
                    type="button"
                    className="ghost-btn hidden h-5 w-5 shrink-0 group-hover/cgroup:inline-flex"
                    title={t('nav.char')}
                    onClick={() => shell.openChar(dir)}
                >
                    <Icon name="user" size={12} />
                </button>
                {shell.live && (
                    <button
                        type="button"
                        className="ghost-btn hidden h-5 w-5 shrink-0 group-hover/cgroup:inline-flex"
                        title={t('sidebar.newChat')}
                        onClick={() => shell.newChat(dir)}
                    >
                        <Icon name="plus" size={12} />
                    </button>
                )}
                <button
                    type="button"
                    className="ghost-btn h-5 w-5 shrink-0"
                    onClick={() => setOpen(!open)}
                    style={{ color: 'var(--fg-faint)' }}
                >
                    <span style={{ transform: open ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }} className="transition-transform">
                        <Icon name="chevronDown" size={14} />
                    </span>
                </button>
            </div>
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
        /* 市场目录件加 'mkt:' 前缀 —— 与服务端插件 id 区分(详情卡按前缀分面)。 */
        ...MOCK_MARKET_PLUGINS.filter((p) => p.installed)
            .map((p) => ({ id: `mkt:${p.id}`, name: p.name, icon: p.icon as IconName })),
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
                        {activeList.map((p) => {
                            const sel = shell.selectedPlugin === p.id;
                            return (
                                <button
                                    key={p.id}
                                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[color:var(--bg-surface)]"
                                    style={sel
                                        ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' }
                                        : { color: 'var(--fg-secondary)' }}
                                    /* 点行落详情卡(不跳设置)—— rail 页 = 详情面,批量开关归 settings 签。 */
                                    onClick={() => { shell.setPluginsNav('installed'); shell.setSelectedPlugin(p.id); }}
                                >
                                    <span
                                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-hairline)]"
                                        style={{ background: 'var(--bg-active)', color: 'var(--fg-primary)' }}
                                    >
                                        <Icon name={p.icon} size={12} />
                                    </span>
                                    <span className="truncate">{p.name}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
