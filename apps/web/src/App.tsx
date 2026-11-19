// App shell — 薄壳:状态与服务经 ShellProvider 下发,表面全部走贡献点
// (nav.rail / view / sidebar.tree / stage.form / panel.type / ctbar.chat /
// renderer)。壳不认识任何具体域:加域/加板块/换舞台形态 = 一次 feature 注册。
// 规范稿(u_ui_codex)壳层:top-chrome | left-chrome(rail+tree+dock) |
// workspace-inset(view 出口 + workbench)| floating-win | cmdk | settings |
// mobile-frame(hub + drawer + vaul-sheet,≤680px 或 vpMode=mobile)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import {
    MOCK_CARDS, MOCK_CHATS, MOCK_MODELS, MOCK_PRESETS, MOCK_GLOBAL_LORE,
    MOCK_MARKET_PLUGINS, MOCK_MVU,
} from './api/mock';
import { postPreviewWithFallback } from './api/preview';
import { listCharacters, type CardItem } from './api/characters';
import { fileToDraft, MAX_IMPORT_BYTES, type ImportDraft } from './api/import';
import type { ActivePersona } from './api/personas';
import { listAllChats, createChat, renameChat, deleteChat } from './api/chats';
import { RAIL_VIEWS, type ChatSummary, type PreviewResult, type ServerStatus, type ViewId } from './types';
import { Icon } from './components/Icon';
import { TopChrome, LeftChrome } from './components/shell/Chrome';
import { Workbench, FloatingWin } from './components/shell/Workbench';
import { Cmdk, SettingsModal, MobileFrame } from './components/shell/Overlays';
import { TooltipProvider } from './components/ui/tooltip';
import {
    ShellProvider, useContribs, useShell,
    type ChatSettings, type PresetParams, type SheetSnap, type ShellCtx, type VpMode,
} from './kernel/context';
import { Kernel } from './kernel/kernel';
import type { PanelInst, PanelType } from './kernel/contributions';
import { shellFeature } from './features/shell';
import { libraryFeature } from './features/library';
import { chatFeature } from './features/chat';
import { studioFeature } from './features/studio';
import { pluginsFeature } from './features/plugins';
import { panelsFeature } from './features/panels';
import { stagepackFeature } from './features/stagepack';
import { domainsFeature } from './features/domains';

/** 内建 feature 装配 —— kernel 即壳的全部表面;feature 顺序即词条/导航序。 */
const kernel = new Kernel();
const registry = kernel.registry;
kernel.applyFeature(shellFeature);
kernel.applyFeature(libraryFeature);
kernel.applyFeature(chatFeature);
kernel.applyFeature(studioFeature);
kernel.applyFeature(pluginsFeature);
kernel.applyFeature(panelsFeature);
kernel.applyFeature(stagepackFeature);
kernel.applyFeature(domainsFeature);

/** 主区出口:按当前 view 从 view 贡献点找组件,壳不 if/switch。 */
function ViewOutlet() {
    const { view } = useShell();
    const views = useContribs('view');
    const C = views.find((v) => v.view === view)?.Component;
    return C ? <C /> : null;
}

const MOBILE_BP = 680;

function Shell() {
    const { t } = useI18n();
    // 默认落点:home(资产画廊);规范稿落点即 rail 第一域。
    const [view, setView] = useState<ViewId>('home');
    const [chats, setChats] = useState<ChatSummary[]>(MOCK_CHATS);
    const [activeChat, setActiveChat] = useState(chats[0]?.id ?? '');
    const [cards, setCards] = useState<Map<string, CardItem>>(new Map());
    const [cardsMock, setCardsMock] = useState(false);
    const [storiesFocus, setStoriesFocus] = useState<string | null>(null);
    const [importDrafts, setImportDrafts] = useState<ImportDraft[]>([]);
    const [dropVeil, setDropVeil] = useState(false);
    const [persona, setPersona] = useState<ActivePersona | null>(null);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 920);
    const [panelHidden, setPanelHidden] = useState(() => window.innerWidth <= 1180);
    const [launcherOpen, setLauncherOpen] = useState(true);
    const [panels, setPanels] = useState<PanelInst[]>([
        { id: 'p-diag', type: 'diag' },
        { id: 'p-mvu', type: 'mvu' },
    ]);
    const [activePanel, setActivePanel] = useState<string | null>('p-mvu');
    const [floating, setFloating] = useState<PanelInst | null>(null);
    const [floatingPos, setFloatingPos] = useState({ x: 96, y: 96 });
    const panelSeq = useRef(0);
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [hintState, setHint] = useState<{ msg: string; err?: boolean } | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /* ——— 规范稿弹层/chrome 状态 ——— */
    const [contextOpen, setContextOpen] = useState(false);
    const [composerMenuOpen, setComposerMenuOpen] = useState(false);
    const [presetPopOpen, setPresetPopOpen] = useState(false);
    const [accountPopOpen, setAccountPopOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState('chat');
    const [cmdkOpen, setCmdkOpen] = useState(false);
    const [mobileDrawer, setMobileDrawer] = useState(false);
    const [sheetSnap, setSheetSnap] = useState<SheetSnap>('closed');
    const [vpMode, setVpMode] = useState<VpMode>('auto');
    const [narrow, setNarrow] = useState(() => window.innerWidth <= MOBILE_BP);
    const [studioNav, setStudioNav] = useState('library');
    const [pluginsNav, setPluginsNav] = useState<'installed' | 'market'>('installed');

    /* ——— SPEC-DATA 目录态(待接:目录全是 mock 种子,消费面已标) ——— */
    const [activeModel, setActiveModel] = useState(MOCK_MODELS[0]!.id);
    const [activePresetId, setActivePreset] = useState(MOCK_PRESETS[0]!.id);
    const [presetParams, setPresetParams] = useState<PresetParams>({
        temp: 0.9, topP: 0.95, ctxLen: 32768, maxReply: 800,
        blocks: [
            { id: 'b-main', name: '主提示词', enabled: true },
            { id: 'b-world', name: '世界书', enabled: true },
            { id: 'b-author', name: '作者注', enabled: false },
        ],
    });
    const [globalLore, setGlobalLore] = useState(MOCK_GLOBAL_LORE);
    const [marketPlugins, setMarketPlugins] = useState(MOCK_MARKET_PLUGINS);
    const [mvu, setMvu] = useState<Record<string, string | number>>(MOCK_MVU);
    const [echoMvu, setEchoMvu] = useState(false);
    const [chatSettings, setChatSettings] = useState<ChatSettings>({
        renderCount: 50, streamFps: 24, autoParseThink: true, autoExpandThink: false,
        showFloorNum: true, confirmDelete: true, fontSize: 14.5, bgMode: 'default',
        customCss: '', apiTab: 'openai', endpoint: '',
    });

    useEffect(() => {
        const onResize = () => setNarrow(window.innerWidth <= MOBILE_BP);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const isMobile = vpMode === 'mobile' || (vpMode === 'auto' && narrow);

    const railTab = (RAIL_VIEWS as readonly string[]).includes(view) ? view : 'chat';
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
            user: persona ?? { name: '旅人' },
        });
        setPreview(result);
        setServerStatus(result.mock ? 'mock' : 'online');
        setPreviewLoading(false);
    }, [chat, persona]);

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

    const queueImport = useCallback((drafts: ImportDraft[]) => {
        if (!drafts.length) return;
        setImportDrafts((prev) => [...prev, ...drafts]);
        setView('import');
    }, []);
    const dismissImportDraft = useCallback((id: string) => {
        setImportDrafts((prev) => prev.filter((d) => d.id !== id));
    }, []);
    const enqueueFiles = useCallback(async (files: File[]) => {
        const drafts: ImportDraft[] = [];
        let skipped = 0;
        for (const f of files) {
            if (f.size > MAX_IMPORT_BYTES) { skipped += 1; continue; }
            drafts.push(await fileToDraft(f));
        }
        if (skipped) showHint(t('imp.tooLarge'), true);
        if (drafts.length) queueImport(drafts);
    }, [queueImport, showHint, t]);

    useEffect(() => {
        let depth = 0;
        const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
        const onEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; setDropVeil(true); };
        const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
        const onLeave = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) setDropVeil(false);
        };
        const onDrop = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            setDropVeil(false);
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length) void enqueueFiles(files);
        };
        window.addEventListener('dragenter', onEnter);
        window.addEventListener('dragover', onOver);
        window.addEventListener('dragleave', onLeave);
        window.addEventListener('drop', onDrop);
        return () => {
            window.removeEventListener('dragenter', onEnter);
            window.removeEventListener('dragover', onOver);
            window.removeEventListener('dragleave', onLeave);
            window.removeEventListener('drop', onDrop);
        };
    }, [enqueueFiles]);

    const openCharacter = useCallback((charDir: string) => {
        setStoriesFocus(charDir);
        setView('stories');
    }, []);

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

    const onRenameChat = useCallback((c: ChatSummary) => {
        if (serverStatus !== 'online') { showHint(t('status.stub')); return; }
        const name = window.prompt(t('chat.rename'), c.chatName);
        if (!name?.trim() || name.trim() === c.chatName) return;
        void renameChat(c.charDir, c.chatName, name.trim())
            .then((newName) => {
                const id = `${c.charDir}/${newName}`;
                setChats((prev) => prev.map((x) => (x.id === c.id ? { ...x, id, title: newName, chatName: newName } : x)));
                if (activeChat === c.id) setActiveChat(id);
            })
            .then(() => refreshChats())
            .catch((e) => showHint(t('chat.rename.failed') + ': ' + (e instanceof Error ? e.message : e)));
    }, [serverStatus, activeChat, refreshChats, showHint, t]);

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
        setPanelHidden(false);
        setLauncherOpen(false);
    }, []);

    const closePanel = useCallback((id: string) => {
        setPanels((prev) => {
            const next = prev.filter((p) => p.id !== id);
            setActivePanel((a) => (a === id ? (next[next.length - 1]?.id ?? null) : a));
            return next;
        });
        setFloating((f) => (f?.id === id ? null : f));
    }, []);

    /** 面板入口:移动端拉起 vaul-sheet,桌面进工作台。 */
    const openPanelSurface = useCallback((type?: PanelType) => {
        if (isMobile) {
            if (type) addPanel(type);
            setSheetSnap('half');
        } else if (type) addPanel(type);
        else { setPanelHidden(false); setLauncherOpen(true); }
    }, [isMobile, addPanel]);

    const mvuStep = useCallback((key: string, d: number) => {
        setMvu((prev) => ({ ...prev, [key]: typeof prev[key] === 'number' ? (prev[key] as number) + d : prev[key]! }));
        // echo-pulse:跨面板联动的诚实回显(规范稿 echoPulse)
        setEchoMvu(true);
        setTimeout(() => setEchoMvu(false), 500);
    }, []);

    const shell = useMemo<ShellCtx>(() => ({
        registry,
        view, setView, railTab,
        chats, activeChat, chat,
        selectChat: (id) => {
            setActiveChat(id);
            // 会话落点永远是 'chat' 视图 —— CenterStage 按 stage 形态分发。
            setView('chat');
            if (window.innerWidth <= 920) setSidebarCollapsed(true);
        },
        newChat: onNewChat,
        renameChat: onRenameChat,
        deleteChat: onDeleteChat,
        cards, cardsMock, refreshCards,
        importDrafts, queueImport, dismissImportDraft,
        storiesFocus, openCharacter,
        clearStoriesFocus: () => setStoriesFocus(null),
        persona, setPersona,
        sidebarCollapsed,
        toggleSidebar: () => setSidebarCollapsed((v) => !v),
        panels, activePanel, panelHidden,
        selectPanel: (id) => { setActivePanel(id); setLauncherOpen(false); },
        closePanel, addPanel,
        toggleWorkbench: () => setPanelHidden((v) => !v),
        launcherOpen,
        openLauncher: () => { setPanelHidden(false); setLauncherOpen(true); },
        floating, floatingPos, setFloatingPos,
        detachPanel: (id) => {
            const p = panels.find((x) => x.id === id);
            if (!p) return;
            setFloating(p);
            setPanels((prev) => prev.filter((x) => x.id !== id));
            setActivePanel((a) => (a === id ? null : a));
        },
        dockPanel: () => {
            if (!floating) return;
            setPanels((prev) => [...prev, floating]);
            setActivePanel(floating.id);
            setFloating(null);
            setLauncherOpen(false);
        },
        contextOpen, setContextOpen,
        composerMenuOpen, setComposerMenuOpen,
        presetPopOpen, setPresetPopOpen,
        accountPopOpen, setAccountPopOpen,
        settingsOpen, settingsTab,
        openSettings: (tab?: string) => { if (tab) setSettingsTab(tab); setSettingsOpen(true); },
        closeSettings: () => setSettingsOpen(false),
        setSettingsTab,
        cmdkOpen, setCmdkOpen,
        mobileDrawer, setMobileDrawer,
        sheetSnap, setSheetSnap,
        vpMode, setVpMode, isMobile, openPanelSurface,
        studioNav, setStudioNav, pluginsNav, setPluginsNav,
        models: MOCK_MODELS, activeModel, setActiveModel,
        presets: MOCK_PRESETS, activePresetId, setActivePreset,
        presetParams,
        setPresetParam: (k, v) => setPresetParams((prev) => ({ ...prev, [k]: v })),
        togglePresetBlock: (id) => setPresetParams((prev) => ({
            ...prev, blocks: prev.blocks.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)),
        })),
        globalLore, toggleGlobalLore: (id) => setGlobalLore((prev) => prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g))),
        marketPlugins, toggleMarketPlugin: (id) => setMarketPlugins((prev) => prev.map((m) => (m.id === id ? { ...m, installed: !m.installed } : m))),
        chatSettings,
        setChatSetting: (k, v) => setChatSettings((prev) => ({ ...prev, [k]: v })),
        mvu, mvuStep, echoMvu,
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
        view, railTab, chats, chat, activeChat, sidebarCollapsed, panels, activePanel,
        panelHidden, launcherOpen, floating, floatingPos, preview, previewLoading,
        runPreview, showHint, serverStatus, onNewChat, onRenameChat, onDeleteChat,
        closePanel, addPanel, openPanelSurface, cards, cardsMock, refreshCards,
        importDrafts, queueImport, dismissImportDraft, storiesFocus, openCharacter,
        persona, contextOpen, composerMenuOpen, presetPopOpen, accountPopOpen,
        settingsOpen, settingsTab, cmdkOpen, mobileDrawer, sheetSnap, vpMode,
        isMobile, studioNav, pluginsNav, activeModel, activePresetId, presetParams,
        globalLore, marketPlugins, chatSettings, mvu, mvuStep, echoMvu,
    ]);

    return (
        <ShellProvider value={shell}>
            {isMobile ? (
                <MobileFrame />
            ) : (
                <div className="flex h-screen flex-col overflow-hidden bg-[color:var(--bg-chrome)]">
                    <TopChrome />
                    <div className="flex min-h-0 flex-1">
                        <LeftChrome />
                        <div className="workspace-inset m-1.5 ml-0">
                            <main className="flex min-w-0 flex-1 flex-col"><ViewOutlet /></main>
                            <Workbench />
                        </div>
                    </div>
                    <FloatingWin />
                </div>
            )}
            <Cmdk />
            <SettingsModal />
            {hintState && <div className={`hint-pill spec-toast${hintState.err ? ' err' : ''}`}>{hintState.msg}</div>}
            {dropVeil && (
                <div className="drop-veil">
                    <Icon name="import" size={26} />
                    <span>{t('imp.veil')}</span>
                </div>
            )}
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
