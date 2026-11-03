// App shell — titlebar / rail / sidebar / main / right panel / statusbar
// (IA §14). Owns view state, the server probe, and the shared preview slot
// consumed by both ChatView (render) and RightPanel (diagnostics).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import { MOCK_CHATS } from './api/mock';
import { postPreviewWithFallback } from './api/preview';
import { listAllChats, createChat, renameChat, deleteChat } from './api/chats';
import type { ChatSummary, PreviewResult, ServerStatus, ViewId } from './types';
import { Sidebar } from './components/shell/Sidebar';
import { RightPanel } from './components/shell/RightPanel';
import { ChatView } from './components/chat/ChatView';
import { PlaceholderView } from './components/views/PlaceholderView';
import { SettingsView } from './components/views/SettingsView';
import type { IconName } from './components/Icon';

const PLACEHOLDER_VIEWS: Partial<Record<ViewId, { icon: IconName; titleKey: string; descKey: string }>> = {
    stories: { icon: 'stories', titleKey: 'view.stories.title', descKey: 'view.stories.desc' },
    rules: { icon: 'rules', titleKey: 'view.rules.title', descKey: 'view.rules.desc' },
    extensions: { icon: 'extensions', titleKey: 'view.extensions.title', descKey: 'view.extensions.desc' },
    diagnostics: { icon: 'diagnostics', titleKey: 'view.diagnostics.title', descKey: 'view.diagnostics.desc' },
};

function Shell() {
    const { t } = useI18n();
    const [view, setView] = useState<ViewId>('chat');
    const [chats, setChats] = useState<ChatSummary[]>(MOCK_CHATS);
    const [activeChat, setActiveChat] = useState(chats[0]?.id ?? '');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [panelHidden, setPanelHidden] = useState(false);
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [hint, setHint] = useState<{ msg: string; err?: boolean } | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const chat = useMemo(() => chats.find((c) => c.id === activeChat) ?? null, [chats, activeChat]);

    const showHint = useCallback((msg: string, err?: boolean) => {
        setHint({ msg, err });
        if (hintTimer.current) clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setHint(null), 3200);
    }, []);

    const runPreview = useCallback(async () => {
        if (!chat) return;
        setPreviewLoading(true);
        const result = await postPreviewWithFallback({
            charDir: chat.charDir,
            chatName: chat.chatName,
            type: 'normal',
            user: { name: '旅人' },
        });
        setPreview(result);
        setServerStatus(result.mock ? 'mock' : 'online');
        setPreviewLoading(false);
    }, [chat]);

    // Real sidebar list once the server answers; keeps mock entries for any
    // char that isn't on disk yet (dev/demo chats survive alongside real ones).
    const refreshChats = useCallback(async () => {
        try {
            const real = await listAllChats();
            setChats((prev) => {
                const liveIds = new Set(real.map((c) => c.id));
                return [...real, ...prev.filter((c) => !liveIds.has(c.id))];
            });
            return true;
        } catch { return false; }
    }, []);

    useEffect(() => {
        if (serverStatus === 'online') void refreshChats();
    }, [serverStatus, refreshChats]);

    /** New chat on the active character; name prompt keeps the skeleton honest. */
    const onNewChat = useCallback(() => {
        if (serverStatus !== 'online') { setView('chat'); showHint(t('status.stub')); return; }
        const charDir = chat?.charDir ?? 'default_Seraphina';
        const name = window.prompt(`${t('sidebar.newChat')} (${charDir})`, `chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
        if (!name?.trim()) return;
        void createChat(charDir, name.trim())
            .then(() => refreshChats())
            .then(() => setActiveChat(`${charDir}/${name.trim()}`))
            .then(() => setView('chat'))
            .catch((e) => showHint(t('chat.send.failed') + ': ' + (e instanceof Error ? e.message : e)));
    }, [serverStatus, chat, refreshChats, showHint, t]);

    /**
     * Rename via legacy /api/chats/rename. The local summary is rewritten
     * BEFORE refreshChats so its merge can't resurrect the old id as a ghost
     * row (refresh keeps prev entries missing from the live list — meant for
     * dev/mock chats — and the pre-rename id would linger forever).
     */
    const onRenameChat = useCallback((c: ChatSummary) => {
        if (serverStatus !== 'online') { showHint(t('status.stub')); return; }
        const name = window.prompt(t('chat.rename'), c.chatName);
        if (!name?.trim() || name.trim() === c.chatName) return; // cancel / no-op
        void renameChat(c.charDir, c.chatName, name.trim())
            .then((newName) => {
                const id = `${c.charDir}/${newName}`;
                setChats((prev) => prev.map((x) => (x.id === c.id ? { ...x, id, title: newName, chatName: newName } : x)));
                if (activeChat === c.id) setActiveChat(id);
            })
            .then(() => refreshChats())
            .catch((e) => showHint(t('chat.rename.failed') + ': ' + (e instanceof Error ? e.message : e)));
    }, [serverStatus, activeChat, refreshChats, showHint, t]);

    /**
     * Delete via /api/uberge. If the deleted chat was open, the selection
     * falls back to the first remaining row — never leaves ChatView pointed
     * at a ghost. Same ghost-row purge as rename, applied after the merge.
     */
    const onDeleteChat = useCallback((c: ChatSummary) => {
        if (serverStatus !== 'online') { showHint(t('status.stub')); return; }
        if (!window.confirm(`${t('chat.delete.confirm')}\n${c.chatName}`)) return;
        const fallback = chats.filter((x) => x.id !== c.id)[0]?.id ?? '';
        void deleteChat(c.charDir, c.chatName)
            .then(() => refreshChats())
            .then(() => setChats((prev) => prev.filter((x) => x.id !== c.id)))
            .then(() => { if (activeChat === c.id) setActiveChat(fallback); })
            .catch((e) => showHint(t('chat.delete.failed') + ': ' + (e instanceof Error ? e.message : e)));
    }, [serverStatus, chats, activeChat, refreshChats, showHint, t]);

    const placeholder = PLACEHOLDER_VIEWS[view];

    /* DSH AppFrame 三栏:sidebar | main | rightbar。无 menubar/activity rail/
       statusbar —— 导航在侧栏内,右栏是挂在右缘的 track。 */
    return (
        <div className="frame">
            <Sidebar
                view={view}
                chats={chats}
                activeChat={activeChat}
                onSelectView={setView}
                onSelectChat={(id) => { setActiveChat(id); setView('chat'); }}
                onNewChat={onNewChat}
                onRenameChat={onRenameChat}
                onDeleteChat={onDeleteChat}
                collapsed={sidebarCollapsed}
            />
            <main className="main">
                {view === 'chat' && chat && (
                    <ChatView
                        chat={chat}
                        preview={preview}
                        previewLoading={previewLoading}
                        onRunPreview={runPreview}
                        onTogglePanel={() => setPanelHidden((v) => !v)}
                        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
                        onHint={showHint}
                        live={serverStatus === 'online'}
                    />
                )}
                {view === 'settings' && <SettingsView />}
                {placeholder && (
                    <PlaceholderView icon={placeholder.icon} titleKey={placeholder.titleKey} descKey={placeholder.descKey} />
                )}
            </main>
            {view === 'chat' && <RightPanel preview={preview} hidden={panelHidden} charDir={chat?.charDir} chatName={chat?.chatName} />}
            {hint && <div className={`hint-pill${hint.err ? ' err' : ''}`}>{hint.msg}</div>}
        </div>
    );
}

export default function App() {
    return (
        <I18nProvider>
            <Shell />
        </I18nProvider>
    );
}
