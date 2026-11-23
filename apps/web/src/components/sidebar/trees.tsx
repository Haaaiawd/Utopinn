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
import { createGroupChat } from '../../api/groups';
import { openGroupModal } from '../shell/overlayBus';
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

/** relTime 缺省 zh 面 —— 不传 t 的调用点(charpage 行尾)保持中文输出。 */
const REL_ZH: Record<string, string> = {
    'time.m': '{n}分钟前', 'time.h': '{n}h前', 'time.d': '{n}天前',
    'time.w': '{n}周前', 'time.mo': '{n}月前',
};

/** 会话行时间:ISO → 分级相对签(<1h 分 / <24h 时 / <7d 天 / <30d 周 /
 *  <1y 月,更老落 YYYY-MM-DD);mock 短签('3h'/'昨天' 等非 ISO)原样透传。 */
export function relTime(iso: string | undefined, t: (key: string) => string = (k) => REL_ZH[k] ?? k): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    const fmt = (k: string, n: number) => t(k).replace('{n}', String(n));
    if (mins < 60) return fmt('time.m', Math.max(1, mins));
    const hours = Math.floor(mins / 60);
    if (hours < 24) return fmt('time.h', hours);
    const days = Math.floor(hours / 24);
    if (days < 7) return fmt('time.d', days);
    if (days < 30) return fmt('time.w', Math.floor(days / 7));
    if (days < 365) return fmt('time.mo', Math.floor(days / 30));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 会话行 —— ChatGPT 式:「⋮」行菜单(置顶/重命名/删除两步),
 *  重命名走行内输入框,原生 prompt/confirm 全部退场。 */
function SessionRow({ s, showCard }: { s: ChatSummary; showCard?: boolean }) {
    const { t } = useI18n();
    const shell = useShell();
    const active = shell.activeChat === s.id && shell.railTab === 'chat';
    const rel = relTime(s.updatedAt, t);
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
                <button type="button" className={`flex min-w-0 flex-1 items-center gap-1 text-left ${isDemo ? 'opacity-55' : ''}`} onClick={() => shell.selectChat(s.id)}>
                    {s.pinned && <Icon name="pin" size={10} weight="bold" className="shrink-0" />}
                    <span className="min-w-0 truncate">{showCard ? `${cardName} · ${s.title}` : s.title}</span>
                </button>
            )}
            {isDemo && <span className="shrink-0 font-mono-ui text-[10px] uppercase text-[color:var(--fg-faint)]">{t('chat.demo')}</span>}
            {s.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--brand)' }} />}
            {/* 尾序固定 [unread][时间][⋮]:时间常驻,⋮ 用 visibility 占位
                显隐(不切 display)—— hover 不再挤位互换。 */}
            {rel && <span className="shrink-0 font-mono-ui text-[11px] text-[color:var(--fg-faint)]">{rel}</span>}
            {canAct && (
                <button
                    type="button"
                    className={`ghost-btn h-5 w-5 shrink-0 ${shell.isMobile || menuOpen ? 'visible' : 'invisible group-hover/srow:visible'}`}
                    title={t('chat.menu')}
                    onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); setDelArmed(false); }}
                >
                    <Icon name="moreV" size={12} weight="bold" />
                </button>
            )}
            {menuOpen && (
                <div
                    className="absolute right-1 top-full z-30 mt-0.5 w-36 overflow-hidden rounded-lg p-1"
                    style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* 群会话:置顶/重命名无群域写面 —— 诚实隐藏,不挂假动作。 */}
                    {!s.groupId && (
                        <button type="button" className={menuBtn} style={{ color: 'var(--fg-secondary)' }}
                            onClick={() => { setMenuOpen(false); shell.togglePin(s); }}>
                            <Icon name="pin" size={12} weight="bold" />
                            {s.pinned ? t('chat.unpin') : t('chat.pin')}
                        </button>
                    )}
                    {!s.groupId && (
                        <button type="button" className={menuBtn} style={{ color: 'var(--fg-secondary)' }}
                            onClick={() => { setMenuOpen(false); setRenameDraft(s.chatName); setRenaming(true); }}>
                            <Icon name="pencil" size={12} weight="bold" />
                            {t('chat.rename')}
                        </button>
                    )}
                    <button
                        type="button"
                        className={menuBtn}
                        style={{ color: delArmed ? '#fff' : 'var(--status-danger)', background: delArmed ? 'var(--status-danger)' : undefined }}
                        onClick={() => {
                            if (!delArmed && shell.chatSettings.confirmDelete) { setDelArmed(true); return; }
                            setMenuOpen(false); shell.deleteChat(s);
                        }}
                    >
                        <Icon name="trash" size={12} weight="bold" />
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
    /* 群会话与卡会话两列(TASK-062):groupId 行单独成区,不进 charDir 桶
       (charDir='' 会塌成无名组头)。 */
    const charChats = rest.filter((c) => !c.groupId);
    const groupRows = rest.filter((c) => c.groupId);
    /** 角色卡与会话:按 charDir 分组,组头=卡名。 */
    const groups = new Map<string, ChatSummary[]>();
    for (const c of charChats) {
        const g = groups.get(c.charDir) ?? [];
        g.push(c);
        groups.set(c.charDir, g);
    }
    /** 群会话:按 groupId 分组,组头=群名。 */
    const groupMap = new Map<string, ChatSummary[]>();
    for (const c of groupRows) {
        const g = groupMap.get(c.groupId!) ?? [];
        g.push(c);
        groupMap.set(c.groupId!, g);
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* 桌面:顶部 h-1.5 呼吸位(规范稿无域头);移动 drawer 头部统一管 */}
            {!shell.isMobile && <div className="h-1.5 shrink-0" />}
            <div className="shrink-0 px-2.5 pb-3">
                {/* 移动端同样直发 newChat —— NewChatModal 是 in-shell 模态
                    (Overlays.tsx 有 mobile 变体);旧链 setView('home') 会被
                    gotoView 映射回 chat,等于没有「+新会话」入口(P0-3)。 */}
                <button
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-[9px] px-3 text-[12.5px] font-medium transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                    style={{ background: 'var(--bg-surface)', border: '1.5px solid var(--border-strong)', boxShadow: 'var(--shadow-card)', color: 'var(--fg-primary)' }}
                    onClick={() => shell.newChat()}
                >
                    <Icon name="plus" size={15} />
                    <span>{t('tree.pickCard')}</span>
                </button>
                {/* 建群入口(TASK-062):成员多选 + 编排设置的独立模态;
                    离线时同 stub(不假装能建)。 */}
                {shell.live && (
                    <button
                        className="mt-1.5 flex h-8 w-full items-center justify-center gap-2 rounded-[9px] px-3 text-[12px] font-medium transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                        style={{ background: 'transparent', border: '1px dashed var(--border-strong)', color: 'var(--fg-secondary)' }}
                        onClick={() => openGroupModal()}
                    >
                        <Icon name="users" size={14} />
                        <span>{t('tree.newGroup')}</span>
                    </button>
                )}
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-2.5 pb-4">
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
                {groupMap.size > 0 && (
                    <div className="space-y-1.5">
                        <div className={sect}>
                            <span>{t('tree.groupSessions')}</span>
                            {shell.live && (
                                <button type="button" className="ghost-btn h-4.5 w-4.5" title={t('tree.newGroup')} onClick={() => openGroupModal()}>
                                    <Icon name="plus" size={12} />
                                </button>
                            )}
                        </div>
                        {[...groupMap.entries()].map(([gid, list]) => (
                            <GroupCluster key={gid} gid={gid} list={list} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/** 群聊簇(TASK-062):组头 = 群名 + 群图标;单会话群组头即会话行,
 *  多会话群展开列子会话。hover 「+」= 该群下新建群聊文件
 *  (服务端名 = 时间戳串,与 ST getTime() 命名同惯)。 */
function GroupCluster({ gid, list }: { gid: string; list: ChatSummary[] }) {
    const { t } = useI18n();
    const shell = useShell();
    const [open, setOpen] = useState(true);
    const [busy, setBusy] = useState(false);
    const groupName = list[0]?.group ?? gid;
    const single = list.length === 1;
    const active = list.some((c) => c.id === shell.activeChat && shell.railTab === 'chat');
    const newChat = () => {
        if (busy || !shell.live) return;
        setBusy(true);
        const name = String(Date.now());
        void createGroupChat(gid, name)
            .then(() => shell.refreshChats())
            .then(() => shell.selectChat(`group/${gid}/${name}`))
            .catch((e) => shell.hint(t('chat.send.failed') + ': ' + (e instanceof Error ? e.message : e), true))
            .finally(() => setBusy(false));
    };
    return (
        <div>
            <div className="group/cgroup flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-[color:var(--bg-surface)]" style={{ color: 'var(--fg-primary)' }}>
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    style={active && single ? { color: 'var(--brand)' } : undefined}
                    onClick={() => (single ? shell.selectChat(list[0]!.id) : setOpen(!open))}
                >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--bg-active)', color: 'var(--fg-secondary)' }}>
                        <Icon name="users" size={11} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{groupName}</span>
                    {!single && <span className="shrink-0 font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{list.length}</span>}
                </button>
                {shell.live && (
                    <button type="button" className="ghost-btn hidden h-5 w-5 shrink-0 group-hover/cgroup:inline-flex" title={t('sidebar.newChat')} disabled={busy} onClick={newChat}>
                        <Icon name="plus" size={12} />
                    </button>
                )}
                {!single && (
                    <button type="button" className="ghost-btn h-5 w-5 shrink-0" onClick={() => setOpen(!open)} style={{ color: 'var(--fg-faint)' }}>
                        <span style={{ transform: open ? 'none' : 'rotate(-90deg)', display: 'inline-flex' }} className="transition-transform">
                            <Icon name="chevronDown" size={14} />
                        </span>
                    </button>
                )}
            </div>
            {!single && open && (
                <div className="ml-[13px] mt-0.5 space-y-0.5 border-l pl-2" style={{ borderColor: 'var(--border-hairline)' }}>
                    {list.map((s) => <SessionRow key={s.id} s={s} />)}
                </div>
            )}
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
                <div className="ml-[13px] mt-0.5 space-y-0.5 border-l pl-2" style={{ borderColor: 'var(--border-hairline)' }}>
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
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2 pb-4">
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
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-2 pb-4">
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
