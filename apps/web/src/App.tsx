// App shell — 薄壳:状态与服务经 ShellProvider 下发,表面全部走贡献点
// (nav.rail / view / sidebar.tree / stage.form / panel.type / ctbar.chat /
// renderer)。壳不认识任何具体域:加域/加板块/换舞台形态 = 一次 feature 注册。
// 规范稿(u_ui_codex)壳层:top-chrome | left-chrome(rail+tree+dock) |
// workspace-inset(view 出口 + workbench)| floating-win | cmdk | settings |
// mobile-frame(hub + drawer + vaul-sheet,≤680px 或 vpMode=mobile)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import {
    MOCK_BUILTIN_PLUGINS, MOCK_CARDS, MOCK_CHATS, MOCK_GLOBAL_LORE,
    MOCK_IM_CHANNELS, MOCK_MARKET_PLUGINS, MOCK_MODELS, MOCK_MVU,
    MOCK_NOTES_TEXT, MOCK_NOVEL_CHAPTERS, MOCK_PRESET_BLOCKS, MOCK_PRESETS,
    MOCK_STAGE_SESSIONS, MOCK_VN, MOCK_WORLDBOOK,
} from './api/mock';
import { listCharacters, type CardItem } from './api/characters';
import { fileToDraft, MAX_IMPORT_BYTES, type ImportDraft } from './api/import';
import type { ActivePersona } from './api/personas';
import { listAllChats, createChat, renameChat, deleteChat } from './api/chats';
import { RAIL_VIEWS, type ChatSummary, type ServerStatus, type ViewId } from './types';
import { Icon } from './components/Icon';
import { TopChrome, LeftChrome } from './components/shell/Chrome';
import { Workbench, FloatingWin } from './components/shell/Workbench';
import { Cmdk, SettingsModal, MobileFrame } from './components/shell/Overlays';
import { TooltipProvider } from './components/ui/tooltip';
import {
    ShellProvider, useContribs, useShell,
    type ChatSettings, type PresetParams, type SheetSnap, type ShellCtx,
    type StageData, type VpMode,
} from './kernel/context';
import { Kernel } from './kernel/kernel';
import type { PanelType } from './kernel/contributions';
import { shellFeature } from './features/shell';
import { chatFeature } from './features/chat';
import { studioFeature } from './features/studio';
import { pluginsFeature } from './features/plugins';
import { panelsFeature } from './features/panels';
import { stagepackFeature } from './features/stagepack';

/** 内建 feature 装配 —— kernel 即壳的全部表面;feature 顺序即词条/导航序。 */
const kernel = new Kernel();
const registry = kernel.registry;
kernel.applyFeature(shellFeature);
kernel.applyFeature(chatFeature);
kernel.applyFeature(studioFeature);
kernel.applyFeature(pluginsFeature);
kernel.applyFeature(panelsFeature);
kernel.applyFeature(stagepackFeature);

/** 主区出口:按当前 view 从 view 贡献点找组件,壳不 if/switch。 */
function ViewOutlet() {
    const { view } = useShell();
    const C = useContribs('view').find((v) => v.view === view)?.Component;
    return C ? <C /> : null;
}

const MOBILE_BP = 680;

function Shell() {
    const { t } = useI18n();
    // 规范稿默认落点:掌门线聊天会话 + 总簿 tab;view=chat,rail 第一域。
    const [view, setView] = useState<ViewId>('chat');
    const [chats, setChats] = useState<ChatSummary[]>([...MOCK_CHATS, ...MOCK_STAGE_SESSIONS]);
    const [activeChat, setActiveChat] = useState('c1');
    const [cards, setCards] = useState<Map<string, CardItem>>(new Map());
    const [cardsMock, setCardsMock] = useState(false);
    const [importDrafts, setImportDrafts] = useState<ImportDraft[]>([]);
    const [dropVeil, setDropVeil] = useState(false);
    const [persona, setPersona] = useState<ActivePersona | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 920);
    const [workbenchOpen, setWorkbenchOpen] = useState(() => window.innerWidth > 1180);
    const [openTabs, setOpenTabs] = useState<PanelType[]>(['ledger']);
    const [activeTab, setActiveTab] = useState<string>('ledger');
    const [panelParams, setPanelParamsMap] = useState<Record<string, unknown>>({});
    const [floatingType, setFloatingType] = useState<PanelType | null>(null);
    const [floatingPos, setFloatingPos] = useState({ x: 96, y: 96 });
    const [launcherSearch, setLauncherSearch] = useState('');
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [hintState, setHint] = useState<{ msg: string; err?: boolean } | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /* ——— 规范稿弹层/chrome 状态 ——— */
    const [contextOpen, setContextOpen] = useState(false);
    const [composerMenuOpen, setComposerMenuOpen] = useState(false);
    const [presetPopOpen, setPresetPopOpen] = useState(false);
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);
    const [accountPopOpen, setAccountPopOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState('api');
    const [cmdkOpen, setCmdkOpen] = useState(false);
    const [mobileDrawer, setMobileDrawer] = useState(false);
    const [sheetSnap, setSheetSnap] = useState<SheetSnap>('closed');
    const [vpMode, setVpMode] = useState<VpMode>('auto');
    const [narrow, setNarrow] = useState(() => window.innerWidth <= MOBILE_BP);
    const [studioNav, setStudioNav] = useState('lore');
    const [pluginsNav, setPluginsNav] = useState<'installed' | 'market'>('installed');

    /* ——— SPEC-DATA 目录态(待接:目录全是 mock 种子,消费面已标) ——— */
    const [activeModel, setActiveModel] = useState(MOCK_MODELS[0]!.id);
    const [activePresetId, setActivePreset] = useState(MOCK_PRESETS[0]!.id);
    const [presetParams, setPresetParams] = useState<PresetParams>({
        temp: 0.85, topP: 0.92, ctxLen: 200000, maxReply: 8192,
        blocks: MOCK_PRESET_BLOCKS.map((b) => ({ ...b })),
    });
    const [globalLore, setGlobalLore] = useState(MOCK_GLOBAL_LORE);
    const [worldbook, setWorldbook] = useState(MOCK_WORLDBOOK);
    const [selectedLoreId, setSelectedLoreId] = useState(MOCK_WORLDBOOK[0]!.id);
    const [builtinPlugins, setBuiltinPlugins] = useState(MOCK_BUILTIN_PLUGINS);
    const [marketPlugins, setMarketPlugins] = useState(MOCK_MARKET_PLUGINS);
    const [notesText, setNotesText] = useState(MOCK_NOTES_TEXT);
    const [mvu, setMvu] = useState<Record<string, string | number>>(MOCK_MVU);
    const [echoMvu, setEchoMvu] = useState(false);
    const [stageData, setStageData] = useState<StageData>({
        chapters: MOCK_NOVEL_CHAPTERS,
        selParaId: null,
        channels: MOCK_IM_CHANNELS,
        activeChannel: MOCK_IM_CHANNELS[0]!.id,
        vn: MOCK_VN,
    });
    const [chatSettings, setChatSettings] = useState<ChatSettings>({
        renderCount: 20, streamFps: 30, autoParseThink: true, autoExpandThink: false,
        showFloorNum: true, confirmDelete: true, fontSize: 14.5, bgMode: 'none',
        customCss: '.msg-bubble { border-radius: 10px; }', apiTab: 'chat',
        endpoint: 'https://gcli.ggchan.dev/',
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
        if (drafts.length) { queueImport(drafts); showHint(t('imp.queued')); }
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

    /** 规范稿 open-panel:补 push + 激活 + 展开工作台(移动端拉起半屏 sheet)。
     *  params 随行 → panelParams[type](板块体自取;不传保留上次现场)。 */
    const openPanel = useCallback((type: PanelType, params?: unknown) => {
        if (params !== undefined) {
            setPanelParamsMap((prev) => ({ ...prev, [type]: params }));
        }
        if (type === 'newtab') {
            setActiveTab('newtab');
        } else {
            setOpenTabs((prev) => (prev.includes(type) ? prev : [...prev, type]));
            setActiveTab(type);
        }
        if (isMobile) setSheetSnap('half');
        else setWorkbenchOpen(true);
        setLauncherSearch('');
    }, [isMobile]);

    const mvuStep = useCallback((key: string, d: number) => {
        setMvu((prev) => ({ ...prev, [key]: typeof prev[key] === 'number' ? (prev[key] as number) + d : prev[key]! }));
        setEchoMvu(true);
        setTimeout(() => setEchoMvu(false), 500);
    }, []);

    /** 规范稿 bridgeOp:总簿三动作 —— 写 MVU 快照 + echo pulse。 */
    const bridgeOp = useCallback((op: string) => {
        if (op === 'repair') mvuStep('大殿耐久', 15);
        else if (op === 'stipend') mvuStep('宗门声望', 2);
        else if (op === 'levy') mvuStep('灵石', 5);
    }, [mvuStep]);

    const shell = useMemo<ShellCtx>(() => ({
        registry,
        view, setView, railTab,
        chats, activeChat, chat,
        selectChat: (id) => {
            setActiveChat(id);
            setView('chat');
            if (window.innerWidth <= 920) setSidebarOpen(false);
            // 规范稿 s.defaultTabs —— 会话自带板块,选中即补开。
            const s = chats.find((c) => c.id === id);
            if (s?.defaultTabs?.length) {
                setOpenTabs((prev) => {
                    const next = [...prev];
                    for (const t of s.defaultTabs!) if (!next.includes(t)) next.push(t);
                    return next;
                });
                setActiveTab(s.defaultTabs[0]!);
                setWorkbenchOpen(true);
            }
        },
        newChat: onNewChat,
        renameChat: onRenameChat,
        deleteChat: onDeleteChat,
        cards, cardsMock, refreshCards,
        importDrafts, queueImport, dismissImportDraft,
        persona, setPersona,
        sidebarOpen,
        toggleSidebar: () => setSidebarOpen((v) => !v),
        workbenchOpen,
        toggleWorkbench: () => setWorkbenchOpen((v) => !v),
        openTabs, activeTab,
        selectTab: (id) => setActiveTab(id),
        openNewTab: () => { setActiveTab('newtab'); setWorkbenchOpen(true); },
        closeTab: (id) => {
            if (id === 'newtab') { setActiveTab((a) => (a === 'newtab' ? (openTabs[openTabs.length - 1] ?? '') : a)); return; }
            setOpenTabs((prev) => {
                const next = prev.filter((x) => x !== id);
                setActiveTab((a) => (a === id ? (next[next.length - 1] ?? '') : a));
                if (floatingType === id) setFloatingType(null);
                return next;
            });
        },
        openPanel,
        panelParams,
        setPanelParams: (type, params) => setPanelParamsMap((prev) => {
            if (params === undefined) {
                const next = { ...prev };
                delete next[type];
                return next;
            }
            return { ...prev, [type]: params };
        }),
        detachPanel: (type) => {
            setFloatingType(type);
            setOpenTabs((prev) => prev.filter((x) => x !== type));
            setActiveTab((a) => (a === type ? '' : a));
        },
        dockBack: () => {
            if (!floatingType) return;
            setOpenTabs((prev) => [...prev, floatingType]);
            setActiveTab(floatingType);
            setFloatingType(null);
            setWorkbenchOpen(true);
        },
        closeFloat: () => setFloatingType(null),
        floatingType, floatingPos, setFloatingPos,
        launcherSearch, setLauncherSearch,
        contextOpen, setContextOpen,
        composerMenuOpen, setComposerMenuOpen,
        presetPopOpen, setPresetPopOpen,
        openDropdown, setOpenDropdown,
        accountPopOpen, setAccountPopOpen,
        settingsOpen, settingsTab,
        openSettings: (tab?: string) => { if (tab) setSettingsTab(tab); setSettingsOpen(true); },
        closeSettings: () => setSettingsOpen(false),
        setSettingsTab,
        cmdkOpen, setCmdkOpen,
        mobileDrawer, setMobileDrawer,
        sheetSnap, setSheetSnap,
        vpMode, setVpMode, isMobile,
        studioNav, setStudioNav, pluginsNav, setPluginsNav,
        models: MOCK_MODELS, activeModel, setActiveModel,
        presets: MOCK_PRESETS, activePresetId,
        pickPreset: (id) => {
            setActivePreset(id);
            const p = MOCK_PRESETS.find((x) => x.id === id);
            if (p) setPresetParams((prev) => ({ ...prev, temp: p.temp, topP: p.topP, ctxLen: p.ctxLen, maxReply: p.maxReply }));
        },
        presetParams,
        setPresetParam: (k, v) => setPresetParams((prev) => ({ ...prev, [k]: v })),
        togglePresetBlock: (id) => setPresetParams((prev) => ({
            ...prev, blocks: prev.blocks.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)),
        })),
        globalLore, toggleGlobalLore: (id) => setGlobalLore((prev) => prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g))),
        worldbook, selectedLoreId, setSelectedLoreId,
        builtinPlugins, toggleBuiltinPlugin: (id) => setBuiltinPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))),
        marketPlugins, toggleMarketPlugin: (id) => setMarketPlugins((prev) => prev.map((m) => (m.id === id ? { ...m, installed: !m.installed } : m))),
        notesText, setNotesText,
        chatSettings,
        setChatSetting: (k, v) => setChatSettings((prev) => ({ ...prev, [k]: v })),
        mvu, setMvu, mvuStep, echoMvu, bridgeOp,
        stageData, patchStageData: (p) => setStageData((prev) => ({ ...prev, ...p })),
        hint: showHint,
        live: serverStatus === 'online',
        serverStatus,
    }), [
        view, railTab, chats, chat, activeChat, sidebarOpen, workbenchOpen,
        openTabs, activeTab, floatingType, floatingPos, launcherSearch, panelParams,
        showHint, serverStatus, onNewChat, onRenameChat, onDeleteChat, openPanel,
        cards, cardsMock, refreshCards, importDrafts, queueImport, dismissImportDraft,
        persona, contextOpen, composerMenuOpen, presetPopOpen, openDropdown,
        accountPopOpen, settingsOpen, settingsTab, cmdkOpen, mobileDrawer,
        sheetSnap, vpMode, isMobile, studioNav, pluginsNav, activeModel,
        activePresetId, presetParams, globalLore, worldbook, selectedLoreId,
        builtinPlugins, marketPlugins, notesText, chatSettings, mvu, mvuStep,
        echoMvu, bridgeOp, stageData,
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
                        {/* 规范稿:inset 画布外裹 pr-[10px] pb-[10px] 呼吸容器 */}
                        <div className="flex min-w-0 flex-1 overflow-hidden pr-[10px] pb-[10px] pl-0 pt-0">
                            <div className="workspace-inset">
                                <main className="flex min-w-0 flex-1 flex-col"><ViewOutlet /></main>
                                <Workbench />
                            </div>
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
