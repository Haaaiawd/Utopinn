// Secondary sidebar (240px) — per-domain object lists (IA §14: chat domain =
// new-chat + story groups + recent; other domains get their own lists).
// Non-chat sections are honest stubs with per-domain empty-state guidance.
import { useState } from 'react';
import { useI18n } from '../../i18n';
import type { ChatSummary, ViewId } from '../../types';
import { Icon } from '../Icon';

const VIEW_SIDEBAR: Record<Exclude<ViewId, 'chat'>, { sectKey: string; items: string[]; emptyKey: string }> = {
    stories: { sectKey: 'sidebar.characters', items: [], emptyKey: 'sidebar.empty.stories' },
    rules: { sectKey: 'sidebar.books', items: [], emptyKey: 'sidebar.empty.rules' },
    extensions: { sectKey: 'sidebar.extKinds', items: ['plugins', 'regex', 'quick-replies', 'injections', 'card-assets'], emptyKey: 'sidebar.empty.extensions' },
    diagnostics: { sectKey: 'sidebar.diagItems', items: ['prompt-inspector', 'wi-trace', 'gen-jobs', 'storage', 'golden-diff'], emptyKey: 'sidebar.empty.diagnostics' },
    settings: {
        sectKey: 'sidebar.settingsSect',
        items: ['connection', 'presets', 'prompts', 'appearance', 'behavior', 'data', 'account', 'advanced'],
        emptyKey: 'sidebar.empty.settings',
    },
};

export function Sidebar({ view, chats, activeChat, onSelectChat, onNewChat, onRenameChat, onDeleteChat, collapsed }: {
    view: ViewId;
    chats: ChatSummary[];
    activeChat: string;
    onSelectChat: (id: string) => void;
    onNewChat: () => void;
    /** Row hover actions — App owns confirm/prompt + the API round-trip. */
    onRenameChat: (chat: ChatSummary) => void;
    onDeleteChat: (chat: ChatSummary) => void;
    collapsed: boolean;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState('');
    if (collapsed) return null;
    const visibleChats = query.trim()
        ? chats.filter((c) => c.title.includes(query.trim()) || c.charDir.includes(query.trim()))
        : chats;

    const head = (
        <div className="sb-head">
            <span className="ws">{t(`nav.${view}`)}</span>
            <span className="grow" />
            <button type="button" className="ibtn" title={t('sidebar.newChat')} onClick={onNewChat}>
                <Icon name="plus" size={15} />
            </button>
        </div>
    );

    if (view !== 'chat') {
        const cfg = VIEW_SIDEBAR[view];
        return (
            <aside className="sidebar">
                {head}
                <div className="sb-scroll">
                    <div className="sb-sect">{t(cfg.sectKey)}</div>
                    {cfg.items.map((it) => (
                        <div key={it} className="sb-item"><span>{it}</span></div>
                    ))}
                    <div className="sb-empty">{t(cfg.emptyKey)}</div>
                </div>
            </aside>
        );
    }

    return (
        <aside className="sidebar">
            {head}
            <div className="sb-search">
                <div className="search">
                    <Icon name="search" size={13} />
                    <input placeholder={t('sidebar.search')} value={query}
                        onChange={(e) => setQuery(e.target.value)} />
                </div>
            </div>
            <div className="sb-scroll">
                <div className="sb-sect">{t('sidebar.stories')}</div>
                <div className="sb-item"><Icon name="stories" size={14} /><span>{t('sidebar.ungrouped')}</span></div>
                <div className="sb-sect">{t('sidebar.recent')}</div>
                {visibleChats.map((c) => (
                    <div
                        key={c.id}
                        className={`sb-item ${c.id === activeChat ? 'on' : ''}`}
                        onClick={() => onSelectChat(c.id)}
                    >
                        {c.unread && <span className="ind" />}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                        <span className="sub">{c.updatedAt}</span>
                        {/* hover/focus reveal (CSS-only); stopPropagation keeps row select clean */}
                        <span className="row-acts">
                            <button type="button" className="ibtn act" title={t('chat.rename')}
                                onClick={(e) => { e.stopPropagation(); onRenameChat(c); }}>
                                <Icon name="edit" size={12} />
                            </button>
                            <button type="button" className="ibtn act danger" title={t('chat.delete')}
                                onClick={(e) => { e.stopPropagation(); onDeleteChat(c); }}>
                                <Icon name="x" size={12} />
                            </button>
                        </span>
                    </div>
                ))}
            </div>
            <div className="sb-foot">
                <Icon name="user" size={13} />
                <span>default-user</span>
            </div>
        </aside>
    );
}
