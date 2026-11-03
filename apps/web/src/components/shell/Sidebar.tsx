// Sidebar — GPT-desktop 双级:极左 52px rail(品牌标 + 域导航 + 主题)
// + 内容栏(品牌行 → 醒目新会话 → 搜索 → charDir 折叠分组嵌套 → user 脚)。
// Owns the border-straddling drag handle. 非聊天域保持诚实的 stub 列表。
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import type { ChatSummary, ViewId } from '../../types';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';

const SB_MIN = 240, SB_MAX = 460;

const NAV: { id: ViewId; icon: IconName }[] = [
    { id: 'chat', icon: 'chat' },
    { id: 'stories', icon: 'stories' },
    { id: 'rules', icon: 'rules' },
    { id: 'extensions', icon: 'extensions' },
];

const VIEW_LIST: Record<Exclude<ViewId, 'chat' | 'settings'>, { items: string[]; emptyKey: string }> = {
    stories: { items: [], emptyKey: 'sidebar.empty.stories' },
    rules: { items: [], emptyKey: 'sidebar.empty.rules' },
    extensions: { items: ['plugins', 'regex', 'quick-replies', 'injections', 'card-assets'], emptyKey: 'sidebar.empty.extensions' },
};

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
            {/* ——— 域轨:品牌标 + L1 域标 + 主题 ——— */}
            <nav className="rail">
                <span className="rail-mark" aria-hidden="true">U</span>
                {NAV.map((it) => (
                    <IconButton
                        key={it.id}
                        label={t(`nav.${it.id}`)}
                        tooltipSide="right"
                        className={`rail-btn ${view === it.id ? 'on' : ''}`}
                        icon={<Icon name={it.icon} size={20} />}
                        onClick={() => onSelectView(it.id)}
                    />
                ))}
                <span className="grow" />
                <IconButton
                    label={t('nav.settings')}
                    tooltipSide="right"
                    className={`rail-btn ${view === 'settings' ? 'on' : ''}`}
                    icon={<Icon name="settings" size={20} />}
                    onClick={() => onSelectView('settings')}
                />
                <IconButton label={t('menu.view.toggleTheme')} tooltipSide="right" className="rail-btn"
                    icon={<Icon name={theme === 'dark' ? 'sun' : 'moon'} size={20} />} onClick={toggle} />
            </nav>

            {/* ——— 内容栏;折叠时 rail 仍在(域轨是常设导航) ——— */}
            {!collapsed && (
            <aside className="sidebar" style={{ width }}>
                <div className="sb-head">
                    <span className="ws">{t('app.name')}</span>
                    <Icon name="chevronDown" size={12} className="mut" />
                    <span className="grow" />
                    <IconButton label={t('menu.view.toggleSidebar')} icon={<Icon name="sidebarLeft" size={16} />}
                        onClick={onToggleCollapsed} />
                </div>

                {view === 'chat' && (
                    <button type="button" className="sb-new" onClick={onNewChat}>
                        <Icon name="plus" size={16} />
                        <span>{t('sidebar.newChat')}</span>
                    </button>
                )}

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
                    {view === 'chat' ? (
                        <>
                            {groups.map(([dir, items]) => {
                                const isFolded = folded.has(dir);
                                return (
                                    <div key={dir} className="sb-group">
                                        <button type="button" className="sb-group-head" onClick={() => toggleFold(dir)}>
                                            <Icon name="chevronRight" size={12} className={`sb-fold ${isFolded ? '' : 'open'}`} />
                                            <span className="sb-group-ava">{dir.slice(0, 1)}</span>
                                            <span className="sb-group-name">{dir}</span>
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
                    ) : (
                        <>
                            {(VIEW_LIST[view as Exclude<ViewId, 'chat' | 'settings'>]?.items ?? []).map((it) => (
                                <div key={it} className="sb-item"><span className="sb-item-title">{it}</span></div>
                            ))}
                            <div className="sb-empty">
                                {t(VIEW_LIST[view as Exclude<ViewId, 'chat' | 'settings'>]?.emptyKey ?? 'sidebar.empty.settings')}
                            </div>
                        </>
                    )}
                </ScrollArea>

                <div className="sb-foot">
                    <span className="sb-foot-ava">U</span>
                    <span>default-user</span>
                </div>
                <div className="sb-resizer" onPointerDown={startResize} />
            </aside>
            )}
        </>
    );
}
