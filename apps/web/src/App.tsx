// App shell — 薄壳:状态与服务经 ShellProvider 下发,表面全部走
// 贡献点(nav.rail / view / panel.type / ctbar.chat / renderer)。
// 壳不认识任何具体域:加域/加板块/换渲染器 = 一次 feature 注册。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import { MOCK_CHATS } from './api/mock';
import { postPreviewWithFallback } from './api/preview';
import { listAllChats, createChat, renameChat, deleteChat } from './api/chats';
import type { ChatSummary, PreviewResult, ServerStatus, ViewId } from './types';
import { Sidebar } from './components/shell/Sidebar';
import { RightPanel } from './components/shell/RightPanel';
import { TooltipProvider } from './components/ui/tooltip';
import { ShellProvider, useContribs, useShell, type ShellCtx } from './kernel/context';
import { Registry } from './kernel/registry';
import type { PanelInst } from './kernel/contributions';
import { applyChatFeature } from './features/chat';
import { applyPanelsFeature } from './features/panels';
import { applyDomainsFeature } from './features/domains';

/** 内建 feature 注册 —— 壳启动时装配,registry 即壳的全部表面。 */
const registry = new Registry();
applyChatFeature(registry);
applyPanelsFeature(registry);
applyDomainsFeature(registry);

/** 主区出口:按当前 view 从 view 贡献点找组件,壳不 if/switch。 */
function ViewOutlet() {
    const { view } = useShell();
    const views = useContribs('view');
    const C = views.find((v) => v.view === view)?.Component;
    return C ? <C /> : null;
}

function Shell() {
    const { t } = useI18n();
    const [view, setView] = useState<ViewId>('chat');
    const [chats, setChats] = useState<ChatSummary[]>(MOCK_CHATS);
    const [activeChat, setActiveChat] = useState(chats[0]?.id ?? '');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    // 右栏没有"收起"钮 —— hidden 只由沉浸模式驱动;板块清空时整条自动消失。
    const [panelHidden, setPanelHidden] = useState(false);
    const [panels, setPanels] = useState<PanelInst[]>([
        { id: 'p-diag', type: 'diag' },
        { id: 'p-session', type: 'session' },
    ]);
    const [activePanel, setActivePanel] = useState<string | null>('p-diag');
    const panelSeq = useRef(0);
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [hintState, setHint] = useState<{ msg: string; err?: boolean } | null>(null);
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

    const addPanel = useCallback((type: string) => {
        const id = `p-${++panelSeq.current}-${type}`;
        setPanels((prev) => [...prev, { id, type }]);
        setActivePanel(id);
        // 加板块 = 展开右栏的入口;沉浸藏栏时也顺势唤回。
        setPanelHidden(false);
    }, []);

    const closePanel = useCallback((id: string) => {
        setPanels((prev) => {
            const next = prev.filter((p) => p.id !== id);
            setActivePanel((a) => (a === id ? (next[next.length - 1]?.id ?? null) : a));
            return next;
        });
    }, []);

    const shell = useMemo<ShellCtx>(() => ({
        registry,
        view, setView,
        chats, activeChat, chat,
        selectChat: (id) => { setActiveChat(id); setView('chat'); },
        newChat: onNewChat,
        renameChat: onRenameChat,
        deleteChat: onDeleteChat,
        sidebarCollapsed,
        toggleSidebar: () => setSidebarCollapsed((v) => !v),
        panels, activePanel, panelHidden,
        selectPanel: setActivePanel, closePanel, addPanel,
        immersive: () => {
            const next = !(sidebarCollapsed && panelHidden);
            setSidebarCollapsed(next);
            setPanelHidden(next);
        },
        preview, previewLoading, runPreview,
        hint: showHint,
        live: serverStatus === 'online',
        serverStatus,
    }), [
        view, chats, chat, activeChat, sidebarCollapsed, panels, activePanel,
        panelHidden, preview, previewLoading, runPreview, showHint, serverStatus,
        onNewChat, onRenameChat, onDeleteChat, closePanel, addPanel,
    ]);

    /* 三栏:sidebar | main(view 出口) | rightbar。壳不认识域。 */
    return (
        <ShellProvider value={shell}>
            <div className="frame">
                <Sidebar />
                <main className="main"><ViewOutlet /></main>
                <RightPanel />
                {hintState && <div className={`hint-pill${hintState.err ? ' err' : ''}`}>{hintState.msg}</div>}
            </div>
        </ShellProvider>
    );
}

export default function App() {
    return (
        <I18nProvider>
            <TooltipProvider delayDuration={400}>
                <Shell />
            </TooltipProvider>
        </I18nProvider>
    );
}
