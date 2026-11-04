// App shell — 薄壳:状态与服务经 ShellProvider 下发,表面全部走
// 贡献点(nav.rail / view / panel.type / ctbar.chat / renderer)。
// 壳不认识任何具体域:加域/加板块/换渲染器 = 一次 feature 注册。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import { MOCK_CARDS, MOCK_CHATS } from './api/mock';
import { postPreviewWithFallback } from './api/preview';
import { listCharacters, type CardItem } from './api/characters';
import type { ActivePersona } from './api/personas';
import { listAllChats, createChat, renameChat, deleteChat } from './api/chats';
import type { ChatSummary, PreviewResult, ServerStatus, ViewId } from './types';
import { Sidebar } from './components/shell/Sidebar';
import { RightPanel } from './components/shell/RightPanel';
import { TooltipProvider } from './components/ui/tooltip';
import { ShellProvider, useContribs, useShell, type ShellCtx } from './kernel/context';
import { Kernel } from './kernel/kernel';
import type { PanelInst } from './kernel/contributions';
import { shellFeature } from './features/shell';
import { chatFeature } from './features/chat';
import { panelsFeature } from './features/panels';
import { domainsFeature } from './features/domains';

/** 内建 feature 装配 —— kernel 即壳的全部表面;feature 顺序即词条/导航序。 */
const kernel = new Kernel();
const registry = kernel.registry;
kernel.applyFeature(shellFeature);
kernel.applyFeature(chatFeature);
kernel.applyFeature(panelsFeature);
kernel.applyFeature(domainsFeature);

/** 主区出口:按当前 view 从 view 贡献点找组件,壳不 if/switch。 */
function ViewOutlet() {
    const { view } = useShell();
    const views = useContribs('view');
    const C = views.find((v) => v.view === view)?.Component;
    return C ? <C /> : null;
}

function Shell() {
    const { t } = useI18n();
    // 门厅 = 有会话历史时的默认落点(TASK-026);零会话直落聊天域。
    const [view, setView] = useState<ViewId>(() => (MOCK_CHATS.length ? 'foyer' : 'chat'));
    const [chats, setChats] = useState<ChatSummary[]>(MOCK_CHATS);
    const [activeChat, setActiveChat] = useState(chats[0]?.id ?? '');
    /** 卡展示面全壳共用(侧栏组头/卡格/门厅/舞台头),一次拉取。 */
    const [cards, setCards] = useState<Map<string, CardItem>>(new Map());
    const [cardsMock, setCardsMock] = useState(false);
    /** 跨视图开角色页的中转位;LibraryView 消费即清。 */
    const [storiesFocus, setStoriesFocus] = useState<string | null>(null);
    /** 当前 persona;舞台头快切写入,生成/预览都携带。 */
    const [persona, setPersona] = useState<ActivePersona | null>(null);
    // 窄屏初值:侧栏/右栏默认收起(rail + 主区先行),需要时再从 rail 唤出。
    // 阈值与 shell.css 媒体查询同源 —— 那里它们退成覆盖层,这里让它们默认不挡。
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 920);
    // 右栏没有"收起"钮 —— hidden 只由沉浸模式驱动;板块清空时整条自动消失。
    const [panelHidden, setPanelHidden] = useState(() => window.innerWidth <= 1180);
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
            // persona 与生成同源 —— 预览装配的就是真实会发出去的用户身份。
            user: persona ?? { name: '旅人' },
        });
        setPreview(result);
        setServerStatus(result.mock ? 'mock' : 'online');
        setPreviewLoading(false);
    }, [chat, persona]);

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

    /** 卡面展示行:在线重拉,离线落 MOCK 并打标。 */
    const refreshCards = useCallback(async () => {
        try {
            const r = await listCharacters();
            setCards(new Map(r.items.map((c) => [c.charDir, c])));
            setCardsMock(false);
        } catch {
            setCards(new Map(MOCK_CARDS.map((c) => [c.charDir, c])));
            setCardsMock(true);
        }
    }, []);

    useEffect(() => { void refreshCards(); }, [refreshCards]);

    useEffect(() => {
        if (serverStatus === 'online') {
            void refreshChats();
            void refreshCards();
        }
    }, [serverStatus, refreshChats, refreshCards]);

    /** 任意视图 → 故事库 + 打开该卡的角色页(门厅大卡/精选格走这里)。 */
    const openCharacter = useCallback((charDir: string) => {
        setStoriesFocus(charDir);
        setView('stories');
    }, []);

    /** New chat; charDir 可由角色页指定,缺省沿用当前会话的卡。 */
    const onNewChat = useCallback((charDir?: string) => {
        const targetDir = charDir ?? chat?.charDir ?? 'default_Seraphina';
        if (serverStatus !== 'online') { setView('chat'); showHint(t('status.stub')); return; }
        const name = window.prompt(`${t('sidebar.newChat')} (${targetDir})`, `chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
        if (!name?.trim()) return;
        void createChat(targetDir, name.trim())
            .then(() => refreshChats())
            .then(() => setActiveChat(`${targetDir}/${name.trim()}`))
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
        selectChat: (id) => {
            setActiveChat(id);
            setView('chat');
            // 抽屉态(≤920px,与 shell.css 媒体查询同阈):选中即收,露出阅读区。
            if (window.innerWidth <= 920) setSidebarCollapsed(true);
        },
        newChat: onNewChat,
        renameChat: onRenameChat,
        deleteChat: onDeleteChat,
        cards, cardsMock,
        storiesFocus, openCharacter,
        clearStoriesFocus: () => setStoriesFocus(null),
        persona, setPersona,
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
        cards, cardsMock, storiesFocus, openCharacter, persona,
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
        <I18nProvider registry={registry}>
            <TooltipProvider delayDuration={400}>
                <Shell />
            </TooltipProvider>
        </I18nProvider>
    );
}
