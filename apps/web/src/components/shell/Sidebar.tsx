// Sidebar — DSH-style single navigation column (IA §14 revised):
// brand/new-chat head → domain list (chat = 会话列表) → bottom domain nav
// → user row. Owns its own width + the border-straddling drag handle.
// Non-chat domains keep honest stub lists until their managers land.
import { useState } from 'react';
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
    { id: 'diagnostics', icon: 'diagnostics' },
    { id: 'settings', icon: 'settings' },
];

const VIEW_LIST: Record<Exclude<ViewId, 'chat' | 'settings'>, { items: string[]; emptyKey: string }> = {
    stories: { items: [], emptyKey: 'sidebar.empty.stories' },
    rules: { items: [], emptyKey: 'sidebar.empty.rules' },
    extensions: { items: ['plugins', 'regex', 'quick-replies', 'injections', 'card-assets'], emptyKey: 'sidebar.empty.extensions' },
    diagnostics: { items: ['prompt-inspector', 'wi-trace', 'gen-jobs', 'storage', 'golden-diff'], emptyKey: 'sidebar.empty.diagnostics' },
};

export function Sidebar({ view, chats, activeChat, onSelectView, onSelectChat, onNewChat, onRenameChat, onDeleteChat, collapsed }: {
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
}) {
    const { t } = useI18n();
    const { theme, toggle } = useTheme();
    const [query, setQuery] = useState('');
    const [width, setWidth] = useState(272);
    if (collapsed) return null;
    const visibleChats = query.trim()
        ? chats.filter((c) => c.title.includes(query.trim()) || c.charDir.includes(query.trim()))
        : chats;

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
        <aside className="sidebar" style={{ width }}>
            <div className="sb-head">
                <span className="ws">{t('app.name')}</span>
                <span className="grow" />
                {view === 'chat' && (
                    <IconButton label={t('sidebar.newChat')} icon={<Icon name="plus" size={16} />} onClick={onNewChat} />
                )}
            </div>

            {view === 'chat' && (
                <div className="sb-search">
                    <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                            <Icon name="search" size={13} />
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
                    visibleChats.map((c) => (
                        <div
                            key={c.id}
                            className={`sb-item ${c.id === activeChat ? 'on' : ''}`}
                            onClick={() => onSelectChat(c.id)}
                        >
                            {c.unread && <span className="ind" />}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                            {/* hover/focus reveal (CSS-only); stopPropagation keeps row select clean */}
                            <span className="row-acts">
                                <IconButton size="icon-sm" label={t('chat.rename')} icon={<Icon name="edit" size={13} />}
                                    onClick={(e) => { e.stopPropagation(); onRenameChat(c); }} />
                                <IconButton size="icon-sm" label={t('chat.delete')} icon={<Icon name="x" size={13} />}
                                    className="hover:text-destructive"
                                    onClick={(e) => { e.stopPropagation(); onDeleteChat(c); }} />
                            </span>
                        </div>
                    ))
                ) : (
                    <>
                        {(VIEW_LIST[view as Exclude<ViewId, 'chat' | 'settings'>]?.items ?? []).map((it) => (
                            <div key={it} className="sb-item"><span>{it}</span></div>
                        ))}
                        <div className="sb-empty">
                            {t(VIEW_LIST[view as Exclude<ViewId, 'chat' | 'settings'>]?.emptyKey ?? 'sidebar.empty.settings')}
                        </div>
                    </>
                )}
            </ScrollArea>

            <nav className="sb-nav">
                {NAV.map((it) => (
                    <button
                        key={it.id}
                        type="button"
                        className={`sb-nav-item ${view === it.id ? 'on' : ''}`}
                        onClick={() => onSelectView(it.id)}
                    >
                        <Icon name={it.icon} size={17} />
                        <span>{t(`nav.${it.id}`)}</span>
                    </button>
                ))}
            </nav>

            <div className="sb-foot">
                <Icon name="user" size={15} />
                <span>default-user</span>
                <span className="grow" />
                <IconButton label={t('menu.view.toggleTheme')} onClick={toggle}
                    icon={<Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />} />
            </div>
            <div className="sb-resizer" onPointerDown={startResize} />
        </aside>
    );
}
