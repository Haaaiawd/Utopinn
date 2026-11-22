// App shell — 薄壳:状态与服务经 ShellProvider 下发,表面全部走贡献点
// (nav.rail / view / sidebar.tree / stage.form / panel.type / ctbar.chat /
// renderer)。壳不认识任何具体域:加域/加板块/换舞台形态 = 一次 feature 注册。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import {
    MOCK_CARDS, MOCK_CHATS, MOCK_GLOBAL_LORE,
    MOCK_IM_CHANNELS, MOCK_MODELS,
    MOCK_NOVEL_CHAPTERS, MOCK_PRESET_BLOCKS, MOCK_PRESETS,
    MOCK_STAGE_SESSIONS, MOCK_VN, MOCK_WORLDBOOK,
    type GlobalLoreItem, type ModelItem, type PresetItem,
} from './api/mock';
import { getMe, type CurrentUser } from './api/account';
import { invalidateCharDocs, listCharacters, type CardItem } from './api/characters';
import { listModels } from './api/connection';
import { fileToDraft, MAX_IMPORT_BYTES, type ImportDraft } from './api/import';
import { listPersonas, type ActivePersona, type PersonaItem } from './api/personas';
import { getPreset, listPresets, savePreset, type PresetDocument } from './api/presets';
import { getSettings, patchSettings } from './api/settings';
import { listWorlds } from './api/worlds';
import { listAllChats, createChat, renameChat, deleteChat } from './api/chats';
import { RAIL_VIEWS, type ChatSummary, type ServerStatus, type ViewId } from './types';
import { Icon } from './components/Icon';
import { LeftChrome } from './components/shell/Chrome';
import { Workbench } from './components/shell/Workbench';
import { bumpPanelFreq } from './components/shell/panelFreq';
import { Cmdk, SettingsModal, MobileFrame } from './components/shell/Overlays';
import { TooltipProvider } from './components/ui/tooltip';
import {
    ShellProvider, useContribs, useShell,
    type ChatSettings, type PresetParams, type SheetSnap, type ShellCtx,
    type StageData, type StBackground, type VpMode,
} from './kernel/context';
import { Kernel } from './kernel/kernel';
import type { PanelType } from './kernel/contributions';
import { shellFeature } from './features/shell';
import { chatFeature } from './features/chat';
import { studioFeature } from './features/studio';
import { pluginsFeature } from './features/plugins';
import { adminFeature } from './features/admin';
import { panelsFeature } from './features/panels';
import { stagepackFeature } from './features/stagepack';

/** 内建 feature 装配 —— kernel 即壳的全部表面;feature 顺序即词条/导航序。 */
const kernel = new Kernel();
const registry = kernel.registry;
kernel.applyFeature(shellFeature);
kernel.applyFeature(chatFeature);
kernel.applyFeature(studioFeature);
kernel.applyFeature(pluginsFeature);
kernel.applyFeature(adminFeature);
kernel.applyFeature(panelsFeature);
kernel.applyFeature(stagepackFeature);

/** 主区出口:按当前 view 从 view 贡献点找组件,壳不 if/switch。 */
function ViewOutlet() {
    const { view } = useShell();
    const C = useContribs('view').find((v) => v.view === view)?.Component;
    return C ? <C /> : null;
}

const MOBILE_BP = 680;
const CHAT_SETTINGS_KEY = 'utopinn.chatSettings';

const DEFAULT_CHAT_SETTINGS: ChatSettings = {
    renderCount: 30,
    autoParseThink: true,
    autoExpandThink: false,
    showFloorNum: true,
    confirmDelete: true,
    fontSize: 15,
    bgMode: 'none',
    customCss: '',
};

function loadChatSettings(): ChatSettings {
    try {
        const raw = localStorage.getItem(CHAT_SETTINGS_KEY);
        if (!raw) return DEFAULT_CHAT_SETTINGS;
        const j = JSON.parse(raw) as Partial<ChatSettings>;
        const num = (v: unknown, def: number, min: number, max: number) =>
            typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
        const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
        return {
            renderCount: num(j.renderCount, DEFAULT_CHAT_SETTINGS.renderCount, 5, 200),
            autoParseThink: bool(j.autoParseThink, DEFAULT_CHAT_SETTINGS.autoParseThink),
            autoExpandThink: bool(j.autoExpandThink, DEFAULT_CHAT_SETTINGS.autoExpandThink),
            showFloorNum: bool(j.showFloorNum, DEFAULT_CHAT_SETTINGS.showFloorNum),
            confirmDelete: bool(j.confirmDelete, DEFAULT_CHAT_SETTINGS.confirmDelete),
            fontSize: num(j.fontSize, DEFAULT_CHAT_SETTINGS.fontSize, 12, 18),
            bgMode: typeof j.bgMode === 'string' && j.bgMode ? j.bgMode : DEFAULT_CHAT_SETTINGS.bgMode,
            customCss: typeof j.customCss === 'string' ? j.customCss : DEFAULT_CHAT_SETTINGS.customCss,
        };
    } catch {
        return DEFAULT_CHAT_SETTINGS;
    }
}

/** per-chat persona 选择态的本地键(服务端无 per-chat persona 端点,
 *  选择态诚实存 localStorage;生效路径 = 生成 body.user 携带,TASK-026)。 */
const personaKey = (chatId: string | null | undefined) => `utopinn.persona.${chatId ?? 'default'}`;

function shortModelId(id: string): string {
    const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
    return tail.length > 28 ? `${tail.slice(0, 26)}…` : tail;
}

const numOr = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function extractPresetParams(doc: PresetDocument | null | undefined): PresetParams {
    const d = (doc ?? {}) as Record<string, unknown>;
    const enabledMap = new Map<string, boolean>();
    if (Array.isArray(d.prompt_order)) {
        for (const po of d.prompt_order) {
            const order = (po as { order?: unknown })?.order;
            if (!Array.isArray(order)) continue;
            for (const o of order) {
                const id = (o as { identifier?: unknown })?.identifier;
                if (typeof id === 'string' && id) {
                    enabledMap.set(id, (o as { enabled?: unknown }).enabled !== false);
                }
            }
        }
    }
    const blocks: { id: string; name: string; enabled: boolean }[] = [];
    if (Array.isArray(d.prompts)) {
        for (const p of d.prompts) {
            const o = p as { identifier?: unknown; name?: unknown; marker?: unknown };
            const id = typeof o.identifier === 'string' && o.identifier ? o.identifier : '';
            if (!id || o.marker === true || !enabledMap.has(id)) continue;
            const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id;
            blocks.push({ id, name, enabled: enabledMap.get(id)! });
        }
    }
    return {
        temp: numOr(d.temperature, 0.85),
        topP: numOr(d.top_p, 0.92),
        ctxLen: numOr(d.openai_max_context, 128000),
        maxReply: numOr(d.openai_max_tokens, 4096),
        blocks,
    };
}

const PARAM_DOC_KEY: Record<'temp' | 'topP' | 'ctxLen' | 'maxReply', string> = {
    temp: 'temperature',
    topP: 'top_p',
    ctxLen: 'openai_max_context',
    maxReply: 'openai_max_tokens',
};

/* ——— 右工作台布局按会话持久化 ——— */
interface WbLayout {
    openTabs: PanelType[];
    activeTab: string;
    floatingType: PanelType | null;
    floatingRect?: { x: number; y: number; w: number; h: number };
}

const wbStorageKey = (chatKey: string) => `utopinn.wb.${chatKey}`;
const DEFAULT_FLOAT_RECT = { x: 96, y: 96, w: 420, h: 480 };

function loadWbLayout(chatKey: string): WbLayout | null {
    try {
        const raw = localStorage.getItem(wbStorageKey(chatKey));
        if (!raw) return null;
        const j = JSON.parse(raw) as Partial<WbLayout>;
        const openTabs = Array.isArray(j.openTabs) ? j.openTabs.filter((x): x is string => typeof x === 'string') : null;
        if (!openTabs) return null;
        const r = j.floatingRect;
        const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
        return {
            openTabs,
            activeTab: typeof j.activeTab === 'string' ? j.activeTab : (openTabs[0] ?? 'newtab'),
            floatingType: typeof j.floatingType === 'string' ? j.floatingType : null,
            floatingRect: r && num(r.x) && num(r.y) && num(r.w) && num(r.h)
                ? { x: r.x, y: r.y, w: r.w, h: r.h }
                : undefined,
        };
    } catch { return null; }
}

function saveWbLayout(chatKey: string, layout: WbLayout): void {
    try { localStorage.setItem(wbStorageKey(chatKey), JSON.stringify(layout)); } catch { /* storage 不可用就静默 */ }
}

function Shell() {
    const { t } = useI18n();
    const [view, setView] = useState<ViewId>('chat');
    const [charDir, setCharDir] = useState<string | null>(null);
    const [chats, setChats] = useState<ChatSummary[]>([...MOCK_CHATS, ...MOCK_STAGE_SESSIONS]);
    const [activeChat, setActiveChat] = useState('c1');
    const [cards, setCards] = useState<Map<string, CardItem>>(new Map());
    const [cardsMock, setCardsMock] = useState(false);
    const [importDrafts, setImportDrafts] = useState<ImportDraft[]>([]);
    const [dropVeil, setDropVeil] = useState(false);
    const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
    const [personas, setPersonas] = useState<PersonaItem[]>([]);
    const [persona, setPersona] = useState<ActivePersona | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 920);
    const [workbenchOpen, setWorkbenchOpen] = useState(() => window.innerWidth > 1180);
    const [openTabs, setOpenTabs] = useState<PanelType[]>(['ledger']);
    const [activeTab, setActiveTab] = useState<string>('ledger');
    const [panelParams, setPanelParamsMap] = useState<Record<string, unknown>>({});
    const [floatingType, setFloatingType] = useState<PanelType | null>(null);
    const [floatingRect, setFloatingRect] = useState(DEFAULT_FLOAT_RECT);
    const [cardappFs, setCardappFs] = useState(false);
    const [launcherSearch, setLauncherSearch] = useState('');
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [hintState, setHint] = useState<{ msg: string; err?: boolean } | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /* ——— 弹层与全局 chrome 状态 ——— */
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);
    const [accountPopOpen, setAccountPopOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState('api');
    const [cmdkOpen, setCmdkOpen] = useState(false);
    const [mobileDrawer, setMobileDrawer] = useState(false);
    const [sheetSnap, setSheetSnap] = useState<SheetSnap>('closed');
    const [vpMode, setVpMode] = useState<VpMode>(() => {
        const v = new URLSearchParams(window.location.search).get('vp');
        return v === 'mobile' || v === 'desktop' ? v : 'auto';
    });
    const [narrow, setNarrow] = useState(() => window.innerWidth <= MOBILE_BP);
    const [studioNav, setStudioNav] = useState('lore');
    const [pluginsNav, setPluginsNav] = useState<'installed' | 'market'>('installed');
    const [adminNav, setAdminNav] = useState('overview');
    const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null);

    /* ——— 连接/模型/预设/全局世界书(离线=MOCK 兜底;online 水合真数据) ——— */
    const [connSource, setConnSource] = useState('openai');
    const [models, setModels] = useState<ModelItem[]>(MOCK_MODELS);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [activeModel, setActiveModelState] = useState(MOCK_MODELS[0]!.id);
    const [presets, setPresets] = useState<PresetItem[]>(MOCK_PRESETS);
    const [activePresetId, setActivePreset] = useState(MOCK_PRESETS[0]!.id);
    const [presetParams, setPresetParams] = useState<PresetParams>({
        temp: 0.85, topP: 0.92, ctxLen: 200000, maxReply: 8192,
        blocks: MOCK_PRESET_BLOCKS.map((b) => ({ ...b })),
    });
    const [globalLore, setGlobalLore] = useState<GlobalLoreItem[]>(MOCK_GLOBAL_LORE);
    const [worldbook] = useState(MOCK_WORLDBOOK);
    const [stageData, setStageData] = useState<StageData>({
        chapters: MOCK_NOVEL_CHAPTERS,
        selParaId: null,
        channels: MOCK_IM_CHANNELS,
        activeChannel: MOCK_IM_CHANNELS[0]!.id,
        vn: MOCK_VN,
    });
    const [chatSettings, setChatSettings] = useState<ChatSettings>(loadChatSettings);
    /* 酒馆外观 ST 槽:stBg=settings.background;chatBgLock=会话锁;
       stCss=power_user.custom_css(refreshConnection 水合)。 */
    const [stBg, setStBg] = useState<StBackground | null>(null);
    const [chatBgLock, setChatBgLock] = useState<string | null>(null);
    const [stCss, setStCss] = useState('');

    const activePresetDocRef = useRef<{ name: string; doc: PresetDocument } | null>(null);
    const presetSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const worldInfoBaseRef = useRef<Record<string, unknown>>({});

    useEffect(() => {
        try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch { /* ignore */ }
    }, [chatSettings]);

    useEffect(() => {
        const onResize = () => setNarrow(window.innerWidth <= MOBILE_BP);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const isMobile = vpMode === 'mobile' || (vpMode === 'auto' && narrow);
    const live = serverStatus === 'online';

    const railTab = (RAIL_VIEWS as readonly string[]).includes(view) ? view : 'chat';
    const chat = useMemo(() => chats.find((c) => c.id === activeChat) ?? null, [chats, activeChat]);

    const wbKey = chat?.charDir && chat?.chatName ? `${chat.charDir}/${chat.chatName}` : null;
    const wbKeyRef = useRef(wbKey);
    const wbFirstRef = useRef(true);
    const wbLayoutRef = useRef<WbLayout>({ openTabs, activeTab, floatingType, floatingRect });
    wbLayoutRef.current = { openTabs, activeTab, floatingType, floatingRect };
    const chatRef = useRef(chat);
    chatRef.current = chat;

    useEffect(() => {
        const prevKey = wbKeyRef.current;
        const first = wbFirstRef.current;
        wbFirstRef.current = false;
        if (prevKey === wbKey && !first) return;
        if (prevKey !== wbKey) {
            if (prevKey) saveWbLayout(prevKey, wbLayoutRef.current);
            wbKeyRef.current = wbKey;
        }
        const stored = wbKey ? loadWbLayout(wbKey) : null;
        const next: WbLayout = stored ?? (() => {
            const tabs = [...(chatRef.current?.defaultTabs ?? [])];
            return { openTabs: tabs, activeTab: tabs[0] ?? 'newtab', floatingType: null };
        })();
        setOpenTabs(next.openTabs);
        setActiveTab(next.activeTab);
        setFloatingType(next.floatingType);
        setFloatingRect(next.floatingRect ?? DEFAULT_FLOAT_RECT);
        setCardappFs(false);
        if (next.openTabs.length || next.floatingType) setWorkbenchOpen(true);
    }, [wbKey]);

    useEffect(() => {
        if (wbKeyRef.current) saveWbLayout(wbKeyRef.current, { openTabs, activeTab, floatingType, floatingRect });
    }, [openTabs, activeTab, floatingType, floatingRect]);

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
                const stageDemos = prev.filter((c) => c.id.startsWith('st-') && !liveIds.has(c.id));
                return [...real, ...stageDemos];
            });
            return true;
        } catch { return false; }
    }, []);

    const refreshCards = useCallback(async () => {
        try {
            const r = await listCharacters();
            setCards(new Map(r.items.map((c) => [c.charDir, c])));
            setCardsMock(false);
            /* 卡清单重拉 = 外部改动可能已发生(导入覆盖/其他端写盘),
               卡文档缓存整桶清掉 —— 角色页/舞台头 chip 不读陈旧真值。 */
            invalidateCharDocs();
            if (serverStatus === 'offline') setServerStatus('online');
        } catch {
            setCards(new Map(MOCK_CARDS.map((c) => [c.charDir, c])));
            setCardsMock(true);
        }
    }, [serverStatus]);

    const refreshCurrentUser = useCallback(async () => {
        try {
            const me = await getMe();
            setCurrentUser(me);
        } catch { /* accounts endpoint unreachable → null */ }
    }, []);

    const refreshPersonas = useCallback(async () => {
        try {
            const r = await listPersonas();
            /* 生效 persona 的推导统一归下方 [chat?.id, personas] effect —
               存值 → 默认 → 首条 单一路径,这里只搬目录。 */
            setPersonas(r.items);
        } catch { /* ignore */ }
    }, []);

    const refreshConnection = useCallback(async (opts?: { freshModels?: boolean }) => {
        const [stRes, mdRes, prRes, wlRes] = await Promise.allSettled([
            getSettings(),
            listModels({ fresh: opts?.freshModels }),
            listPresets('openai'),
            listWorlds(),
        ]);

        const st = stRes.status === 'fulfilled' ? stRes.value.settings : null;
        const oai = (st?.oai_settings && typeof st.oai_settings === 'object' && !Array.isArray(st.oai_settings))
            ? (st.oai_settings as Record<string, unknown>)
            : {};
        const wiOuter = (st?.world_info_settings && typeof st.world_info_settings === 'object' && !Array.isArray(st.world_info_settings))
            ? (st.world_info_settings as Record<string, unknown>)
            : {};
        const wiObj = (wiOuter.world_info && typeof wiOuter.world_info === 'object' && !Array.isArray(wiOuter.world_info))
            ? (wiObjCopy(wiOuter.world_info as Record<string, unknown>))
            : {};
        worldInfoBaseRef.current = wiObj;

        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
        const src = str(oai.chat_completion_source) || 'openai';
        setConnSource(src);

        /* 酒馆外观水合:settings.background(#bg1 全局背景槽)+
           power_user.custom_css。settings 拉取失败 → 槽位留旧值不动
           (水合失败不清已有皮肤,与 conn 字段同策略)。 */
        if (st) {
            const bg = (st.background && typeof st.background === 'object' && !Array.isArray(st.background))
                ? (st.background as Record<string, unknown>) : null;
            setStBg(bg && typeof bg.url === 'string' && bg.url
                ? { name: str(bg.name), url: String(bg.url), fitting: str(bg.fitting) || 'classic' }
                : null);
            const pu = (st.power_user && typeof st.power_user === 'object' && !Array.isArray(st.power_user))
                ? (st.power_user as Record<string, unknown>) : null;
            setStCss(str(pu?.custom_css));
        }

        const cfgModel = str(oai[`${src}_model`]) || str(oai.openai_model);
        if (mdRes.status === 'fulfilled') {
            const mr = mdRes.value;
            const list: ModelItem[] = mr.items.map((m) => ({
                id: m.id,
                short: shortModelId(m.id),
                provider: m.owned_by || mr.source || src,
                ctx: '',
            }));
            if (cfgModel && !list.some((m) => m.id === cfgModel)) {
                list.unshift({ id: cfgModel, short: shortModelId(cfgModel), provider: src, ctx: '' });
            }
            setModels(list);
            setModelsError(mr.error ? (mr.detail || mr.error) : null);
            setActiveModelState(cfgModel || list[0]?.id || '');
        } else {
            setModels(cfgModel ? [{ id: cfgModel, short: shortModelId(cfgModel), provider: src, ctx: '' }] : []);
            setModelsError(mdRes.reason instanceof Error ? mdRes.reason.message : 'models_error');
            setActiveModelState(cfgModel);
        }

        if (prRes.status === 'fulfilled') {
            const names = prRes.value.items.map((x) => x.name);
            const cfgPresetRaw = str(st?.preset_settings_openai) || str(oai.preset_settings_openai);
            const cfgPreset = cfgPresetRaw.replace(/\.json$/i, '');
            const chosen = (cfgPreset && names.includes(cfgPreset) ? cfgPreset : names[0]) ?? '';
            const docs = await Promise.all(names.slice(0, 24).map(async (n) => {
                try { return { name: n, doc: (await getPreset(n, 'openai')).doc }; }
                catch { return { name: n, doc: null }; }
            }));
            const builtPresets: PresetItem[] = docs.map(({ name, doc }) => {
                const d = (doc ?? {}) as Record<string, unknown>;
                return {
                    id: name,
                    temp: numOr(d.temperature, 1),
                    topP: numOr(d.top_p, 1),
                    ctxLen: numOr(d.openai_max_context, 128000),
                    maxReply: numOr(d.openai_max_tokens, 4096),
                };
            });
            setPresets(builtPresets);
            setActivePreset(chosen);
            const chosenDoc = docs.find((x) => x.name === chosen)?.doc
                ?? (chosen ? await getPreset(chosen, 'openai').then((r) => r.doc).catch(() => null) : null);
            if (chosenDoc) {
                activePresetDocRef.current = { name: chosen, doc: chosenDoc };
                setPresetParams(extractPresetParams(chosenDoc));
            }
        }

        if (wlRes.status === 'fulfilled') {
            const globalSel = new Set(
                Array.isArray(wiObj.globalSelect)
                    ? wiObj.globalSelect.filter((x): x is string => typeof x === 'string')
                    : [],
            );
            setGlobalLore(wlRes.value.items.map((w) => ({
                id: w.name,
                name: w.displayName || w.name,
                file: `${w.name}.json`,
                enabled: globalSel.has(w.name) || globalSel.has(w.displayName),
                tokens: 0,
                desc: w.name,
            })));
        }
    }, []);

    useEffect(() => { void refreshCards(); }, [refreshCards]);
    useEffect(() => {
        if (serverStatus !== 'checking') return;
        let dead = false;
        void refreshChats().then((ok) => { if (!dead) setServerStatus(ok ? 'online' : 'offline'); });
        return () => { dead = true; };
    }, [serverStatus, refreshChats]);
    useEffect(() => {
        if (serverStatus === 'online') {
            void refreshChats();
            void refreshCards();
            void refreshCurrentUser();
            void refreshPersonas();
            void refreshConnection();
        }
    }, [serverStatus, refreshChats, refreshCards, refreshCurrentUser, refreshPersonas, refreshConnection]);

    /* persona per-chat 选择态(ST 语义:人设绑会话,不绑全局)。
       会话切换/人设目录水合 → 本会话存值 → 默认人设 → 目录首条;
       写回面 = pickPersona 落 localStorage,生成时以 body.user 携带。 */
    useEffect(() => {
        if (!personas.length) { setPersona(null); return; }
        let stored = '';
        try { stored = localStorage.getItem(personaKey(chat?.id)) ?? ''; } catch { /* storage 不可用 */ }
        const hit = personas.find((p) => p.avatar === stored)
            ?? personas.find((p) => p.isDefault)
            ?? personas[0];
        setPersona(hit ? { avatar: hit.avatar, name: hit.name, description: hit.description } : null);
    }, [chat?.id, personas]);

    /* 在线首次拉到真会话且当前指针指向不存在的 mock c1 → 自动切首个真会话 */
    useEffect(() => {
        if (!live) return;
        const real = chats.filter((c) => !c.id.startsWith('st-') && c.id !== 'c1' && c.id !== 'c2');
        if (real.length > 0 && (activeChat === 'c1' || activeChat === 'c2') && !chats.some((c) => c.id === activeChat && c.charDir !== 'demo-card')) {
            const hasC1Real = real.some((c) => `${c.charDir}/${c.chatName}` === 'default_Seraphina/demo-chat');
            if (!hasC1Real) setActiveChat(real[0]!.id);
        }
    }, [live, chats, activeChat]);

    const schedulePresetSave = useCallback((mutator: (doc: PresetDocument) => PresetDocument) => {
        if (!live || !activePresetDocRef.current) return;
        const { name, doc } = activePresetDocRef.current;
        const nextDoc = mutator(doc);
        activePresetDocRef.current = { name, doc: nextDoc };
        if (presetSaveTimer.current) clearTimeout(presetSaveTimer.current);
        presetSaveTimer.current = setTimeout(() => {
            void savePreset(name, nextDoc, 'openai').catch((e) => {
                showHint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true);
            });
        }, 450);
    }, [live, showHint, t]);

    const setActiveModel = useCallback((id: string) => {
        setActiveModelState(id);
        if (!live || !id) return;
        const src = connSource || 'openai';
        void patchSettings({ oai_settings: { [`${src}_model`]: id } }).catch((e) => {
            showHint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true);
        });
    }, [live, connSource, showHint, t]);

    const pickPreset = useCallback((id: string) => {
        const clean = id.replace(/\.json$/i, '');
        setActivePreset(live ? clean : id);
        if (!live) {
            const p = presets.find((x) => x.id === id);
            if (p) setPresetParams((prev) => ({ ...prev, temp: p.temp, topP: p.topP, ctxLen: p.ctxLen, maxReply: p.maxReply }));
            return;
        }
        void Promise.all([
            patchSettings({ preset_settings_openai: clean }),
            getPreset(clean, 'openai'),
        ]).then(([, res]) => {
            activePresetDocRef.current = { name: clean, doc: res.doc };
            setPresetParams(extractPresetParams(res.doc));
        }).catch((e) => {
            showHint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true);
        });
    }, [live, presets, showHint, t]);

    const setPresetParam = useCallback((k: 'temp' | 'topP' | 'ctxLen' | 'maxReply', v: number) => {
        setPresetParams((prev) => ({ ...prev, [k]: v }));
        setPresets((prev) => prev.map((p) => (p.id === activePresetId ? { ...p, [k]: v } : p)));
        schedulePresetSave((doc) => ({ ...doc, [PARAM_DOC_KEY[k]]: v }));
    }, [activePresetId, schedulePresetSave]);

    const togglePresetBlock = useCallback((id: string) => {
        let nextEnabled = true;
        setPresetParams((prev) => ({
            ...prev,
            blocks: prev.blocks.map((b) => {
                if (b.id !== id) return b;
                nextEnabled = !b.enabled;
                return { ...b, enabled: nextEnabled };
            }),
        }));
        schedulePresetSave((doc) => {
            const d = doc as Record<string, unknown>;
            if (!Array.isArray(d.prompt_order)) return doc;
            const nextOrder = d.prompt_order.map((po) => {
                const entry = po as Record<string, unknown>;
                if (!Array.isArray(entry.order)) return po;
                return {
                    ...entry,
                    order: entry.order.map((o) => {
                        const item = o as Record<string, unknown>;
                        return item.identifier === id ? { ...item, enabled: nextEnabled } : o;
                    }),
                };
            });
            return { ...doc, prompt_order: nextOrder };
        });
    }, [schedulePresetSave]);

    const toggleGlobalLore = useCallback((id: string) => {
        setGlobalLore((prev) => {
            const next = prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g));
            if (live) {
                const nextSel = next.filter((g) => g.enabled).map((g) => g.id);
                const nextWi = { ...worldInfoBaseRef.current, globalSelect: nextSel };
                worldInfoBaseRef.current = nextWi;
                void patchSettings({ world_info_settings: { world_info: nextWi } }).catch((e) => {
                    showHint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true);
                });
            }
            return next;
        });
    }, [live, showHint, t]);

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

    const openPanel = useCallback((type: PanelType, params?: unknown) => {
        if (params !== undefined) {
            setPanelParamsMap((prev) => ({ ...prev, [type]: params }));
        }
        if (type === 'newtab') {
            setActiveTab('newtab');
        } else {
            bumpPanelFreq(type);
            setOpenTabs((prev) => (prev.includes(type) ? prev : [...prev, type]));
            setActiveTab(type);
        }
        if (isMobile) setSheetSnap('half');
        else setWorkbenchOpen(true);
        setLauncherSearch('');
    }, [isMobile]);

    const openSettings = useCallback((tab?: string) => {
        if (tab) setSettingsTab(tab);
        setSettingsOpen(true);
        setMobileDrawer(false);
    }, []);

    /* 舞台头/ctx 弹层的 persona 快切 —— 选择态写回本会话 localStorage 槽
       (chat 为 null 时落 'default' 桶,不影响任何会话记忆)。 */
    const pickPersona = useCallback((p: ActivePersona | null) => {
        setPersona(p);
        try { localStorage.setItem(personaKey(chatRef.current?.id), p?.avatar ?? ''); } catch { /* storage 不可用 */ }
    }, []);

    /* setView 统一入口:移动端域映射(plugins→settings / studio→hub / home→chat)
       + 收 drawer;openChar 也走它,'char' 视图无映射直通。 */
    const gotoView = useCallback((v: ViewId) => {
        if (isMobile) {
            if (v === 'plugins') { openSettings('plugins'); return; }
            if (v === 'studio') v = 'hub';
            else if (v === 'home') v = 'chat';
        }
        setView(v);
        setMobileDrawer(false);
    }, [isMobile, openSettings]);

    const shell = useMemo<ShellCtx>(() => ({
        registry,
        view,
        setView: gotoView,
        railTab,
        chats, activeChat, chat,
        charDir,
        /* 三级路径中层:卡格 → 角色页(view 'char') → 页内选会话 → 聊天。
           charDir 记「最近看过的角色页」,selectChat 不清 —— 回看回同一页。 */
        openChar: (d: string) => { setCharDir(d); gotoView('char'); },
        selectChat: (id) => {
            setActiveChat(id);
            setView('chat');
            if (window.innerWidth <= 920) setSidebarOpen(false);
            setMobileDrawer(false);
            setStageData((prev) => ({ ...prev, selParaId: null }));
        },
        newChat: onNewChat,
        renameChat: onRenameChat,
        deleteChat: onDeleteChat,
        cards, cardsMock, refreshCards,
        importDrafts, queueImport, dismissImportDraft,
        currentUser, refreshCurrentUser,
        personas, refreshPersonas,
        persona, setPersona: pickPersona,
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
            setActiveTab(type);
            setWorkbenchOpen(true);
        },
        dockBack: () => { setFloatingType(null); },
        closeFloat: () => {
            const tp = floatingType;
            if (!tp) return;
            setFloatingType(null);
            setOpenTabs((prev) => {
                const next = prev.filter((x) => x !== tp);
                setActiveTab((a) => (a === tp ? (next[next.length - 1] ?? 'newtab') : a));
                return next;
            });
        },
        floatingType, floatingRect, setFloatingRect,
        cardappFs, setCardappFs,
        collapsePanels: () => { setCardappFs(false); setWorkbenchOpen(false); setSheetSnap('closed'); },
        launcherSearch, setLauncherSearch,
        openDropdown, setOpenDropdown,
        accountPopOpen, setAccountPopOpen,
        settingsOpen, settingsTab,
        openSettings,
        closeSettings: () => setSettingsOpen(false),
        setSettingsTab,
        cmdkOpen, setCmdkOpen,
        mobileDrawer, setMobileDrawer,
        sheetSnap, setSheetSnap,
        vpMode, setVpMode, isMobile,
        studioNav,
        setStudioNav: (v: string) => { setStudioNav(v); setMobileDrawer(false); },
        pluginsNav,
        setPluginsNav: (v: 'installed' | 'market') => { setPluginsNav(v); setMobileDrawer(false); },
        adminNav,
        setAdminNav: (v: string) => { setAdminNav(v); setMobileDrawer(false); },
        selectedPlugin, setSelectedPlugin,
        connSource,
        models, modelsError, activeModel, setActiveModel,
        presets, activePresetId, pickPreset,
        presetParams,
        setPresetParam,
        togglePresetBlock,
        globalLore, toggleGlobalLore,
        worldbook,
        refreshConnection,
        chatSettings,
        setChatSetting: (k, v) => setChatSettings((prev) => ({ ...prev, [k]: v })),
        stBg, setStBg, chatBgLock, setChatBgLock, stCss, setStCss,
        stageData, patchStageData: (p) => setStageData((prev) => ({ ...prev, ...p })),
        hint: showHint,
        live,
        serverStatus,
    }), [
        view, railTab, chats, chat, activeChat, charDir, gotoView, pickPersona, sidebarOpen, workbenchOpen,
        openTabs, activeTab, floatingType, floatingRect, cardappFs, launcherSearch, panelParams,
        showHint, serverStatus, live, onNewChat, onRenameChat, onDeleteChat, openPanel,
        cards, cardsMock, refreshCards, importDrafts, queueImport, dismissImportDraft,
        currentUser, refreshCurrentUser, personas, refreshPersonas, persona,
        openDropdown, accountPopOpen, settingsOpen, settingsTab, cmdkOpen, mobileDrawer,
        sheetSnap, vpMode, isMobile, studioNav, pluginsNav, adminNav, selectedPlugin,
        connSource, models, modelsError, activeModel, setActiveModel,
        presets, activePresetId, pickPreset, presetParams, setPresetParam, togglePresetBlock,
        globalLore, toggleGlobalLore, worldbook, refreshConnection,
        chatSettings, stageData, openSettings,
    ]);

    return (
        <ShellProvider value={shell}>
            {/* 自定义 CSS:服务端 power_user.custom_css 为主(ST 槽);
               本地 chatSettings.customCss 是上线前遗留的本地槽,非空也照渲
               (叠加层,不静默丢用户旧稿)。 */}
            {stCss.trim() && (
                <style id="utopinn-st-css">{stCss}</style>
            )}
            {chatSettings.customCss.trim() && (
                <style id="utopinn-custom-css">{chatSettings.customCss}</style>
            )}
            <div className="flex h-screen flex-col overflow-hidden bg-[color:var(--bg-chrome)]">
                {isMobile ? (
                    <main className="min-h-0 flex-1">
                        <MobileFrame />
                    </main>
                ) : (
                    <div className="flex min-h-0 flex-1">
                        <LeftChrome />
                        <div className="flex min-w-0 flex-1 overflow-hidden py-[8px] pr-[8px] pl-0">
                            <div className="workspace-inset">
                                <main className="flex min-w-0 flex-1 flex-col"><ViewOutlet /></main>
                                <Workbench />
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <Cmdk />
            {!isMobile && <SettingsModal />}
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

function wiObjCopy(raw: Record<string, unknown>): Record<string, unknown> {
    return { ...raw };
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
