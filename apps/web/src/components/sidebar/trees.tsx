// 侧栏树体 —— sidebar.tree 贡献,按归属 rail 由 LeftChrome 渲染。
// 树内容归 feature,壳只认 rail 字符串。
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon } from '../Icon';
import { charImageUrl } from '../../api/characters';
import { MOCK_STAGE_SESSIONS } from '../../api/mock';
import type { ChatSummary } from '../../types';

function SessionRow({ c }: { c: ChatSummary }) {
    const { activeChat, selectChat, cards, deleteChat, renameChat } = useShell();
    const card = cards.get(c.charDir);
    const active = c.id === activeChat;
    return (
        <div role="button" tabIndex={0} onClick={() => selectChat(c.id)}
            onKeyDown={(e) => e.key === 'Enter' && selectChat(c.id)}
            className={`group flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-left ${active ? 'bg-[color:var(--bg-active)]' : 'hover:bg-[color:var(--bg-surface-hover)]'}`}>
            <span className="char-avatar-ring flex h-6 w-6 items-center justify-center overflow-hidden text-[10px] text-[color:var(--fg-muted)]">
                {card?.avatar || card?.fileName ? <img src={charImageUrl(card.avatar ?? card!.fileName)} alt="" className="h-full w-full object-cover" /> : (card?.name ?? c.title).slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
                <span className={`block truncate text-[13px] ${active ? 'text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)]'}`}>{c.title}</span>
                {c.updatedAt && <span className="block truncate text-[10px] text-[color:var(--fg-faint)]">{c.updatedAt}</span>}
            </span>
            {c.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--brand)]" />}
            <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                <button type="button" className="ghost-btn h-5 w-5" onClick={(e) => { e.stopPropagation(); renameChat(c); }}><Icon name="edit" size={11} /></button>
                <button type="button" className="ghost-btn h-5 w-5" onClick={(e) => { e.stopPropagation(); deleteChat(c); }}><Icon name="trash" size={11} /></button>
            </span>
        </div>
    );
}

/** chat/home 域共用树:会话列表(真)+ 舞台形态会话(mock 位)+ 新建入口。 */
export function PlayTree() {
    const { t } = useI18n();
    const { chats, newChat, cardsMock } = useShell();
    const realChats = chats.filter((c) => !c.stage);
    const stageSessions = [...chats.filter((c) => c.stage && c.stage !== 'chat'), ...MOCK_STAGE_SESSIONS.filter((m) => !chats.some((c) => c.id === m.id))];
    return (
        <div>
            <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-[11px] font-medium text-[color:var(--fg-muted)]">{t('tree.sessions')}</span>
                <button type="button" className="ghost-btn h-6 w-6" title={t('sidebar.newChat')} onClick={() => newChat()}>
                    <Icon name="plus" size={13} />
                </button>
            </div>
            <div className="space-y-0.5">
                {realChats.map((c) => <SessionRow key={c.id} c={c} />)}
                {realChats.length === 0 && <p className="px-2 py-3 text-[11px] text-[color:var(--fg-faint)]">{t('tree.empty')}</p>}
            </div>
            <div className="mb-1 mt-4 px-1 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('tree.stages')}</div>
            <div className="space-y-0.5">
                {stageSessions.map((c) => <SessionRow key={c.id} c={c} />)}
            </div>
            {cardsMock && <p className="mt-3 px-2 text-[10px] text-[color:var(--fg-faint)]">{t('tree.mockNote')}</p>}
        </div>
    );
}

const STUDIO_ITEMS = [
    { id: 'library', icon: 'book' as const },
    { id: 'presets', icon: 'sliders' as const },
    { id: 'worlds', icon: 'globe' as const },
    { id: 'secrets', icon: 'shield' as const },
    { id: 'recent', icon: 'clock' as const },
];

export function StudioNav() {
    const { t } = useI18n();
    const { studioNav, setStudioNav, cards, importDrafts } = useShell();
    return (
        <div>
            <div className="space-y-0.5">
                {STUDIO_ITEMS.map((s) => (
                    <button key={s.id} type="button" onClick={() => setStudioNav(s.id)}
                        className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[13px] ${studioNav === s.id ? 'bg-[color:var(--bg-active)] text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-surface-hover)]'}`}>
                        <Icon name={s.icon} size={15} />
                        <span className="flex-1">{t(`studio.${s.id}`)}</span>
                        {s.id === 'library' && <span className="text-[10px] text-[color:var(--fg-faint)]">{cards.size}</span>}
                        {s.id === 'recent' && importDrafts.length > 0 && <span className="rounded-full bg-[color:var(--brand-soft)] px-1.5 text-[10px] text-[color:var(--brand)]">{importDrafts.length}</span>}
                    </button>
                ))}
            </div>
        </div>
    );
}

export function PluginsNav() {
    const { t } = useI18n();
    const { pluginsNav, setPluginsNav, marketPlugins } = useShell();
    const installedCount = marketPlugins.filter((m) => m.installed).length;
    return (
        <div className="space-y-0.5">
            {([
                { id: 'installed' as const, icon: 'grid' as const, n: installedCount },
                { id: 'market' as const, icon: 'sparkles' as const, n: marketPlugins.length },
            ]).map((s) => (
                <button key={s.id} type="button" onClick={() => setPluginsNav(s.id)}
                    className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[13px] ${pluginsNav === s.id ? 'bg-[color:var(--bg-active)] text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-surface-hover)]'}`}>
                    <Icon name={s.icon} size={15} />
                    <span className="flex-1">{t(`plugins.${s.id}`)}</span>
                    <span className="text-[10px] text-[color:var(--fg-faint)]">{s.n}</span>
                </button>
            ))}
        </div>
    );
}
