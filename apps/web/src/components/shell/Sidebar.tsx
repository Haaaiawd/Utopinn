// Sidebar — 48px rail(品牌标 + 收起钮 + 域导航 + 账户菜单)+ 聊天域专属
// 内容栏(品牌行 → 新会话 → 搜索 → charDir 折叠分组嵌套)。非聊天域不画
// 内容栏 —— 管理面在主区整页展开,分类走页内 chips 不走侧栏列表。
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { apiGet } from '../../api/client';
import { MOCK_CARDS, type CardItem } from '../../api/mock';
import type { ChatSummary, ViewId } from '../../types';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuLabel, DropdownMenuTrigger,
} from '../ui/dropdown-menu';

const SB_MIN = 240, SB_MAX = 460;

const NAV: { id: ViewId; icon: IconName }[] = [
    { id: 'chat', icon: 'chat' },
    { id: 'stories', icon: 'stories' },
    { id: 'rules', icon: 'rules' },
    { id: 'extensions', icon: 'extensions' },
];

/** 组头卡面:有图放卡面(卡文件本身是 PNG 时直接当脸用),404/无图回落首字母。 */
function CharFace({ dir, card }: { dir: string; card?: CardItem }) {
    const [err, setErr] = useState(false);
    const face = card?.avatar ?? (card?.fileName?.endsWith('.png') ? card.fileName : undefined);
    if (!face || err) {
        return <span className="sb-group-ava">{(card?.name ?? dir).slice(0, 1)}</span>;
    }
    return (
        <span className="sb-group-ava">
            <img src={`/characters/${encodeURIComponent(face)}`} alt="" loading="lazy"
                onError={() => setErr(true)} />
        </span>
    );
}

function ChatRow({ c, active, onSelect, onRename, onDelete, t }: {
    c: ChatSummary; active: boolean; t: (k: string) => string;
    onSelect: () => void; onRename: () => void; onDelete: () => void;
}) {
    return (
        <div className={`sb-item ${active ? 'on' : ''}`} onClick={onSelect}>
            {c.unread && <span className="ind" />}
            <span className="sb-item-title">{c.title}</span>
            <span className="row-acts">
                <IconButton size="icon-sm" label={t('chat.rename')} icon={<Icon name="edit" size={12} />}
                    onClick={(e) => { e.stopPropagation(); onRename(); }} />
                <IconButton size="icon-sm" label={t('chat.delete')} icon={<Icon name="x" size={12} />}
                    className="hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); onDelete(); }} />
            </span>
        </div>
    );
}

export function Sidebar({ view, chats, activeChat, onSelectView, onSelectChat, onNewChat, onRenameChat, onDeleteChat, collapsed, onToggleCollapsed }: {
    view: ViewId;
    chats: ChatSummary[];
    activeChat: string;
    onSelectView: (v: ViewId) => void;
    onSelectChat: (id: string) => void;
    onNewChat: () => void;
    /** Row hover actions — App owns confirm/prompt + the API round-trip. */
    onRenameChat: (chat: ChatSummary) => void;
    onDeleteChat: (chat: ChatSummary) => void;
    collapsed: boolean;
    onToggleCollapsed: () => void;
}) {
    const { t } = useI18n();
    const { theme, toggle } = useTheme();
    const [query, setQuery] = useState('');
    const [width, setWidth] = useState(272);
    /** charDir → folded; 默认全展开。 */
    const [folded, setFolded] = useState<Set<string>>(new Set());
    /** charDir → 卡元(名字/卡面)。离线回落 MOCK,再落不到就裸 dir。 */
    const [cards, setCards] = useState<Map<string, CardItem>>(new Map());

    useEffect(() => {
        let dead = false;
        apiGet<{ items: CardItem[] }>('/api/uberge/characters')
            .then((r) => { if (!dead) setCards(new Map(r.items.map((c) => [c.charDir, c]))); })
            .catch(() => { if (!dead) setCards(new Map(MOCK_CARDS.map((c) => [c.charDir, c]))); });
        return () => { dead = true; };
    }, []);

    const visibleChats = query.trim()
        ? chats.filter((c) => c.title.includes(query.trim()) || c.charDir.includes(query.trim()))
        : chats;

    /** GPT 式嵌套:角色组(charDir) → 会话行;无 charDir 的落"最近"扁平段。 */
    const { groups, loose } = useMemo(() => {
        const g = new Map<string, ChatSummary[]>();
        const loose: ChatSummary[] = [];
        for (const c of visibleChats) {
            if (!c.charDir) { loose.push(c); continue; }
            (g.get(c.charDir) ?? g.set(c.charDir, []).get(c.charDir)!).push(c);
        }
        return { groups: [...g.entries()], loose };
    }, [visibleChats]);

    const toggleFold = (dir: string) => setFolded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) next.delete(dir); else next.add(dir);
        return next;
    });

    const startResize = (e: React.PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        const move = (ev: PointerEvent) =>
            setWidth(Math.min(SB_MAX, Math.max(SB_MIN, startW + ev.clientX - startX)));
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    return (
        <>
            {/* ——— 域轨:品牌标 + 收起钮(唯一位) + L1 域标(duotone) + 主题 ——— */}
            <nav className="rail">
                <span className="rail-mark" aria-hidden="true">U</span>
                <IconButton
                    label={t('menu.view.toggleSidebar')}
                    tooltipSide="right"
                    className="rail-btn"
                    icon={<Icon name="sidebarLeft" size={20} mirrored={collapsed} />}
                    onClick={onToggleCollapsed}
                />
                {NAV.map((it) => (
                    <IconButton
                        key={it.id}
                        label={t(`nav.${it.id}`)}
                        tooltipSide="right"
                        className={`rail-btn ${view === it.id ? 'on' : ''}`}
                        icon={<Icon name={it.icon} size={20} weight="duotone" />}
                        onClick={() => onSelectView(it.id)}
                    />
                ))}
                <span className="grow" />
                {/* 账户菜单 = user+settings 合并位;主题切换收进菜单,不占地 */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <span>
                            <IconButton label={t('menu.user')} tooltipSide="right"
                                className={`rail-btn ${view === 'settings' ? 'on' : ''}`}
                                icon={<Icon name="user" size={20} weight="duotone" />} />
                        </span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="end" sideOffset={8}>
                        <DropdownMenuLabel>default-user</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => onSelectView('settings')}>
                            <Icon name="settings" size={12} /> {t('nav.settings')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={toggle}>
                            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={12} /> {t('menu.view.toggleTheme')}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </nav>

            {/* ——— 内容栏;只有聊天域有,折叠/其他域时 rail 独行 ——— */}
            {view === 'chat' && !collapsed && (
            <aside className="sidebar" style={{ width }}>
                <div className="sb-head">
                    <span className="ws">{t('app.name')}</span>
                    <span className="grow" />
                </div>

                <button type="button" className="sb-new" onClick={onNewChat}>
                    <Icon name="plus" size={16} />
                    <span>{t('sidebar.newChat')}</span>
                </button>

                {view === 'chat' && (
                    <div className="sb-search">
                        <div className="relative">
                            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                <Icon name="search" size={12} />
                            </span>
                            <Input
                                className="h-8 rounded-full border-transparent bg-bubble pl-8 text-[13px]"
                                placeholder={t('sidebar.search')}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </div>
                    </div>
                )}

                <ScrollArea className="sb-scroll">
                    <>
                        {groups.map(([dir, items]) => {
                                const isFolded = folded.has(dir);
                                return (
                                    <div key={dir} className="sb-group">
                                        <button type="button" className="sb-group-head" onClick={() => toggleFold(dir)}>
                                            <Icon name="chevronRight" size={12} className={`sb-fold ${isFolded ? '' : 'open'}`} />
                                            <CharFace dir={dir} card={cards.get(dir)} />
                                            <span className="sb-group-name">{cards.get(dir)?.name ?? dir}</span>
                                            <span className="sb-group-count">{items.length}</span>
                                        </button>
                                        {!isFolded && items.map((c) => (
                                            <ChatRow key={c.id} c={c} t={t}
                                                active={c.id === activeChat}
                                                onSelect={() => onSelectChat(c.id)}
                                                onRename={() => onRenameChat(c)}
                                                onDelete={() => onDeleteChat(c)} />
                                        ))}
                                    </div>
                                );
                            })}
                        {loose.length > 0 && (
                            <>
                                <div className="sb-sect">{t('sidebar.recent')}</div>
                                {loose.map((c) => (
                                    <ChatRow key={c.id} c={c} t={t}
                                        active={c.id === activeChat}
                                        onSelect={() => onSelectChat(c.id)}
                                        onRename={() => onRenameChat(c)}
                                        onDelete={() => onDeleteChat(c)} />
                                ))}
                            </>
                        )}
                    </>
                </ScrollArea>

                <div className="sb-resizer" onPointerDown={startResize} />
            </aside>
            )}
        </>
    );
}
