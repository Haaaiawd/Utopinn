// App shell — titlebar / rail / sidebar / main / right panel / statusbar
// (IA §14). Owns view state, the server probe, and the shared preview slot
// consumed by both ChatView (render) and RightPanel (diagnostics).
import { useCallback, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import { MOCK_CHATS } from './api/mock';
import { postPreviewWithFallback } from './api/preview';
import type { ChatSummary, PreviewResult, ServerStatus, ViewId } from './types';
import { ActivityRail } from './components/shell/ActivityRail';
import { Sidebar } from './components/shell/Sidebar';
import { StatusBar } from './components/shell/StatusBar';
import { TitleBar } from './components/shell/TitleBar';
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
    const [chats] = useState<ChatSummary[]>(MOCK_CHATS);
    const [activeChat, setActiveChat] = useState(chats[0]?.id ?? '');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [panelHidden, setPanelHidden] = useState(false);
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [hint, setHint] = useState<string | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const chat = useMemo(() => chats.find((c) => c.id === activeChat) ?? null, [chats, activeChat]);

    const showHint = useCallback((msg: string) => {
        setHint(msg);
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

    const tokens = preview?.data?.trace
        ? { used: preview.data.trace.tokenBudget - preview.data.trace.remainingBudget, budget: preview.data.trace.tokenBudget }
        : null;

    const placeholder = PLACEHOLDER_VIEWS[view];

    return (
        <div className="app">
            <TitleBar
                onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
                onTogglePanel={() => setPanelHidden((v) => !v)}
                onNewChat={() => { setView('chat'); showHint(t('status.stub')); }}
                onHint={showHint}
            />
            <div className="shell">
                <ActivityRail view={view} onSelect={setView} />
                <Sidebar
                    view={view}
                    chats={chats}
                    activeChat={activeChat}
                    onSelectChat={(id) => { setActiveChat(id); setView('chat'); }}
                    onNewChat={() => showHint(t('status.stub'))}
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
                            onHint={showHint}
                        />
                    )}
                    {view === 'settings' && <SettingsView />}
                    {placeholder && (
                        <PlaceholderView icon={placeholder.icon} titleKey={placeholder.titleKey} descKey={placeholder.descKey} />
                    )}
                </main>
                {view === 'chat' && <RightPanel preview={preview} hidden={panelHidden} />}
            </div>
            <StatusBar
                server={serverStatus}
                chat={chat}
                tokens={tokens}
                rendererId="uberge.prose"
                hint={hint}
            />
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
