// App shell — 薄壳:状态与服务经 ShellProvider 下发,表面全部走贡献点
// (nav.rail / view / sidebar.tree / stage.form / panel.type / ctbar.chat /
// renderer)。壳不认识任何具体域:加域/加板块/换舞台形态 = 一次 feature 注册。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n';
import {
    MOCK_CARDS, MOCK_CHATS, MOCK_GLOBAL_LORE,
    MOCK_IM_CHANNELS, MOCK_MODELS,
    MOCK_NOVEL_CHAPTERS, MOCK_PRESET_BLOCKS, MOCK_PRESETS,
    MOCK_VN, MOCK_WORLDBOOK,
    type GlobalLoreItem, type ModelItem, type PresetItem,
} from './api/mock';
import { getMe, type CurrentUser } from './api/account';
import { invalidateCharDocs, listCharacters, type CardItem } from './api/characters';
import { listProfiles, type ActiveModelPointer, type ConnectionProfile } from './api/connection';
import { fileToDraft, MAX_IMPORT_BYTES, type ImportDraft } from './api/import';
import { listPersonas, type ActivePersona, type PersonaItem } from './api/personas';
import { getPreset, listPresets, savePreset, type PresetDocument } from './api/presets';
import { getSettings, patchSettings } from './api/settings';
import { listBackgrounds } from './api/backgrounds';
import { listWorlds } from './api/worlds';
import { listAllChats, createChat, renameChat, deleteChat } from './api/chats';
import { listGroupChatSummaries, deleteGroupChat } from './api/groups';
import { RAIL_VIEWS, type ChatSummary, type ServerStatus, type ViewId } from './types';
import { Icon } from './components/Icon';
import { LeftChrome } from './components/shell/Chrome';
import { Workbench } from './components/shell/Workbench';
import { bumpPanelFreq } from './components/shell/panelFreq';
import { Cmdk, SettingsModal, MobileFrame } from './components/shell/Overlays';
import { openNewChatModal } from './components/shell/overlayBus';
import { TooltipProvider } from './components/ui/tooltip';
import {
    clampFloatRect, DEFAULT_FLOAT_RECT,
    ShellProvider, useContribs, useShell,
    type ChatSettings, type FloatRect, type PresetParams, type SheetSnap, type ShellCtx,
    type StageData, type StBackground, type UiAmbience, type VpMode,
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
    /** v3 逐板块浮窗:浮窗集(z 序 back→front)+ 各板块矩形记忆
     *  (收档/关闭不抹,重浮回原位)。 */
    floatOrder: PanelType[];
    floatRects: Record<PanelType, FloatRect>;
    /** 工作台占满聊天区(右栏吃全 inset)。 */
    expanded?: boolean;
}

const wbStorageKey = (chatKey: string) => `utopinn.wb.${chatKey}`;

const isRect = (v: unknown): v is FloatRect => {
    const r = v as Partial<FloatRect> | null | undefined;
    const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    return !!r && num(r.x) && num(r.y) && num(r.w) && num(r.h);
};

/** 无记忆矩形时的级联落位 —— 每多一扇浮窗右下错 28px,不叠死。 */
const cascadeFloatRect = (n: number): FloatRect =>
    clampFloatRect({
        x: DEFAULT_FLOAT_RECT.x + 28 * n,
        y: DEFAULT_FLOAT_RECT.y + 28 * n,
        w: DEFAULT_FLOAT_RECT.w,
        h: DEFAULT_FLOAT_RECT.h,
    }, window.innerWidth, window.innerHeight);

function loadWbLayout(chatKey: string): WbLayout | null {
    try {
        const raw = localStorage.getItem(wbStorageKey(chatKey));
        if (!raw) return null;
        const j = JSON.parse(raw) as Partial<WbLayout> & {
            /* v2 旧档字段:整台 aside 浮窗(floatingType=发起板块)。 */
            floatingType?: unknown;
            floatingRect?: unknown;
        };
        const str = (v: unknown): v is string => typeof v === 'string';
        const floatOrder = Array.isArray(j.floatOrder) ? j.floatOrder.filter(str) : [];
        const floatRects: Record<string, FloatRect> = {};
        if (j.floatRects && typeof j.floatRects === 'object' && !Array.isArray(j.floatRects)) {
            for (const [k, v] of Object.entries(j.floatRects)) {
                if (isRect(v)) floatRects[k] = v;
            }
        }
        /* v2 → v3 迁移:旧 floatingType/Rect 折成单板块浮窗条目,
           openTabs 同步摘除(v2 不摘、v3 摘 —— 迁移照 v3 语义走)。 */
        if (str(j.floatingType) && j.floatingType) {
            if (!floatOrder.includes(j.floatingType)) floatOrder.push(j.floatingType);
            if (isRect(j.floatingRect)) floatRects[j.floatingType] = j.floatingRect;
        }
        const rawTabs = Array.isArray(j.openTabs) ? j.openTabs.filter(str) : null;
        if (!rawTabs) return null;
        const openTabs = rawTabs.filter((x) => !floatOrder.includes(x));
        const a = str(j.activeTab) ? j.activeTab : '';
        const activeTab = a === 'newtab' || openTabs.includes(a)
            ? a
            : (openTabs[openTabs.length - 1] ?? 'newtab');
        return { openTabs, activeTab, floatOrder, floatRects, expanded: j.expanded === true };
    } catch { return null; }
}

function saveWbLayout(chatKey: string, layout: WbLayout): void {
    try { localStorage.setItem(wbStorageKey(chatKey), JSON.stringify(layout)); } catch { /* storage 不可用就静默 */ }
}

function Shell() {
    const { t } = useI18n();
    const [view, setView] = useState<ViewId>('chat');
    const [charDir, setCharDir] = useState<string | null>(null);
    const [chats, setChats] = useState<ChatSummary[]>([...MOCK_CHATS]);
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
    const [openTabs, setOpenTabs] = useState<PanelType[]>(['cardapp']);
    const [activeTab, setActiveTab] = useState<string>('cardapp');
    const [panelParams, setPanelParamsMap] = useState<Record<string, unknown>>({});
    const [floatOrder, setFloatOrder] = useState<PanelType[]>([]);
    const [floatRects, setFloatRects] = useState<Record<PanelType, FloatRect>>({});
    const [cardappFs, setCardappFs] = useState(false);
    const [wbExpand, setWbExpand] = useState(false);
    const [launcherSearch, setLauncherSearch] = useState('');
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [authExpired, setAuthExpired] = useState(false);
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
    const [connProfiles, setConnProfiles] = useState<ConnectionProfile[]>([]);
    const [models, setModels] = useState<ModelItem[]>(MOCK_MODELS);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [activeModel, setActiveModelState] = useState<ActiveModelPointer | null>(
        { profileId: '', modelId: MOCK_MODELS[0]!.id });
    const [presets, setPresets] = useState<PresetItem[]>(MOCK_PRESETS);
    const [activePresetId, setActivePreset] = useState(MOCK_PRESETS[0]!.id);
    const [presetDoc, setPresetDoc] = useState<PresetDocument | null>(null);
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
       stCss=power_user.custom_css(refreshConnection 水合)。
       uiAmbience=power_user.ui_ambience —— 全局氛围层参数。 */
    const [stBg, setStBg] = useState<StBackground | null>(null);
    const [chatBgLock, setChatBgLock] = useState<string | null>(null);
    const [stCss, setStCss] = useState('');
    const [uiAmbience, setUiAmbience] = useState<UiAmbience>({ bgAlpha: 0.62, glassBlur: 14, texAlpha: 0.06 });
    /* 置顶会话清单 —— accountStorage.pinnedChats(ST 同槽:{file_name,avatar})。 */
    const [pinnedChats, setPinnedChats] = useState<{ file_name: string; avatar?: string; charDir?: string }[]>([]);
    const pinnedRef = useRef<{ file_name: string; avatar?: string; charDir?: string }[]>([]);
    pinnedRef.current = pinnedChats;

    /* 氛围参数 → CSS var:全局 backdrop 浓度/毛玻璃/纹理 即时生效。 */
    useEffect(() => {
        const r = document.documentElement;
        r.style.setProperty('--amb-bg-alpha', String(uiAmbience.bgAlpha));
        r.style.setProperty('--amb-glass-blur', `${uiAmbience.glassBlur}px`);
        r.style.setProperty('--amb-tex-alpha', String(uiAmbience.texAlpha));
    }, [uiAmbience]);

    /* 正文字号 → --chat-font-size:设置滑杆/A± 即时落到 .chat-body-text。 */
    useEffect(() => {
        document.documentElement.style.setProperty('--chat-font-size', `${chatSettings.fontSize}px`);
    }, [chatSettings.fontSize]);

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
    const wbLayoutRef = useRef<WbLayout>({ openTabs, activeTab, floatOrder, floatRects, expanded: wbExpand });
    wbLayoutRef.current = { openTabs, activeTab, floatOrder, floatRects, expanded: wbExpand };
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
            return { openTabs: tabs, activeTab: tabs[0] ?? 'newtab', floatOrder: [], floatRects: {}, expanded: false };
        })();
        setOpenTabs(next.openTabs);
        setActiveTab(next.activeTab);
        setFloatOrder(next.floatOrder);
        const rects = Object.fromEntries(
            Object.entries(next.floatRects).map(([k, v]) => [k, clampFloatRect(v, window.innerWidth, window.innerHeight)]),
        ) as Record<PanelType, FloatRect>;
        /* 缺记忆的活浮窗补级联默认位(畸形档防呆)。 */
        next.floatOrder.forEach((tp, i) => { rects[tp] ??= cascadeFloatRect(i); });
        setFloatRects(rects);
        setCardappFs(false);
        setWbExpand(next.expanded === true);
        if (next.openTabs.length || next.floatOrder.length) setWorkbenchOpen(true);
    }, [wbKey]);

    useEffect(() => {
        if (wbKeyRef.current) saveWbLayout(wbKeyRef.current, { openTabs, activeTab, floatOrder, floatRects, expanded: wbExpand });
    }, [openTabs, activeTab, floatOrder, floatRects, wbExpand]);

    /* 移动端无浮窗(屏小浮窗没意义,面板留工作台)——
       isMobile 翻转时存量浮窗全数收档回 openTabs。 */
    useEffect(() => {
        if (!isMobile || floatOrder.length === 0) return;
        setOpenTabs((prev) => [...prev, ...floatOrder.filter((tp) => !prev.includes(tp))]);
        setFloatOrder([]);
    }, [isMobile, floatOrder]);

    /* 视口收缩 → 活浮窗矩形钳回视口内(防存档出屏/拖没)。 */
    useEffect(() => {
        if (floatOrder.length === 0) return;
        const onResize = () => {
            setFloatRects((prev) => {
                let dirty = false;
                const next = { ...prev };
                for (const tp of floatOrder) {
                    const r = next[tp];
                    if (!r) continue;
                    const c = clampFloatRect(r, window.innerWidth, window.innerHeight);
                    if (c.x !== r.x || c.y !== r.y || c.w !== r.w || c.h !== r.h) { next[tp] = c; dirty = true; }
                }
                return dirty ? next : prev;
            });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [floatOrder]);

    const showHint = useCallback((msg: string, err?: boolean) => {
        setHint({ msg, err });
        if (hintTimer.current) clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setHint(null), 3200);
    }, []);

    const refreshChats = useCallback(async () => {
        try {
            /* 群会话行与单聊同列(TASK-062);群面挂了只少群行,不拖垮单聊清单。 */
            const [charChats, groupChats] = await Promise.all([
                listAllChats(),
                listGroupChatSummaries().catch(() => [] as ChatSummary[]),
            ]);
            const real = [...charChats, ...groupChats];
            const pins = pinnedRef.current;
            const isPinned = (c: ChatSummary) => pins.some(
                (p) => p.file_name === c.chatName && (p.charDir === c.charDir || p.avatar === `${c.charDir}.png`),
            );
            /* st-* 舞台预演演示会话不再注入侧栏清单 —— 会话列以服务端真值为准,
               MOCK_STAGE_SESSIONS 种子仍留给舞台形态离线演示。 */
            setChats(real.map((c) => ({ ...c, pinned: isPinned(c) })));
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
        const [stRes, mdRes, prRes, wlRes, bgRes] = await Promise.allSettled([
            getSettings(),
            listProfiles(),
            listPresets('openai'),
            listWorlds(),
            listBackgrounds(),
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
            /* 死指针容错:backgrounds/ 目录换血后 settings.background 可能仍指向
               已删文件 → 清单在列才认(local url 以文件名判;远端/无法判定的原样保
               留,清单拉取失败则不裁决,宁留勿清)。 */
            const bgKnown = bgRes.status === 'fulfilled'
                ? new Set(bgRes.value.items.map((i) => i.filename)) : null;
            const bgAlive = (name: string, cssUrl: string): boolean => {
                if (!bgKnown) return true;
                const inner = (bgCssInner(cssUrl) || name).trim();
                if (/^https?:\/\//i.test(inner) || inner.startsWith('data:')) return true;
                /* 前端内置静态资产(/assets/*)不受服务端 Backgrounds 清单裁决。 */
                if (inner.startsWith('/assets/')) return true;
                const localFile = /(?:^|\/)backgrounds\/([^/?#]+)\s*$/.exec(inner)?.[1];
                const rawFile = localFile ?? inner.split('/').pop() ?? name;
                let file = rawFile;
                try { file = decodeURIComponent(rawFile); } catch { /* 畸形 % 编码按原名判 */ }
                return file ? bgKnown.has(file) : true;
            };
            setStBg(bg && typeof bg.url === 'string' && bg.url && bgAlive(str(bg.name), String(bg.url))
                ? { name: str(bg.name), url: String(bg.url), fitting: str(bg.fitting) || 'classic' }
                : null);
            const pu = (st.power_user && typeof st.power_user === 'object' && !Array.isArray(st.power_user))
                ? (st.power_user as Record<string, unknown>) : null;
            setStCss(str(pu?.custom_css));
            /* power_user.ui_ambience(snake_case 落盘;camelCase 旧稿兼容读)。 */
            const ua = pu?.ui_ambience;
            if (ua && typeof ua === 'object' && !Array.isArray(ua)) {
                const u = ua as Record<string, unknown>;
                const num = (v: unknown, d: number, lo: number, hi: number) =>
                    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
                setUiAmbience({
                    bgAlpha: num(u.bg_alpha ?? u.bgAlpha, 0.62, 0, 0.9),
                    glassBlur: num(u.glass_blur ?? u.glassBlur, 14, 0, 32),
                    texAlpha: num(u.tex_alpha ?? u.texAlpha, 0.06, 0, 0.3),
                });
            }
            /* accountStorage.pinnedChats —— ST 置顶会话清单槽(welcome-screen 同路径)。 */
            const acct = (st.accountStorage && typeof st.accountStorage === 'object' && !Array.isArray(st.accountStorage))
                ? (st.accountStorage as Record<string, unknown>) : null;
            const pins = Array.isArray(acct?.pinnedChats) ? acct.pinnedChats : [];
            setPinnedChats(pins.filter((p) => p && typeof p === 'object' && typeof (p as { file_name?: unknown }).file_name === 'string') as typeof pinnedChats);
        }

        /* 连接档案制:models = 全启用 profile checked∪manual 并集(每项带
           {profileId,profileName} 属主);activeModel = connection.activeModel
           指针 —— 模型身份 = {profileId,modelId} 二元组,同 id 跨档不撞。
           指针空/悬 → 并集首项补位显示(不落盘,服务端派发链自身也有
           checked[0]→manual[0] 兜底)。 */
        if (mdRes.status === 'fulfilled') {
            const pr = mdRes.value;
            const profs = Array.isArray(pr.profiles) ? pr.profiles : [];
            setConnProfiles(profs);
            const list: ModelItem[] = [];
            for (const p of profs) {
                if (p.disabled) continue;
                const union = [...(p.models?.checked ?? []), ...(p.models?.manual ?? [])];
                for (const mid of union) {
                    if (!mid || list.some((m) => m.id === mid && m.profileId === p.id)) continue;
                    list.push({
                        id: mid, short: shortModelId(mid), provider: p.name, ctx: '',
                        profileId: p.id, profileName: p.name, profileFormat: p.format,
                    });
                }
            }
            const am = pr.activeModel;
            const activeProf = am ? profs.find((p) => p.id === am.profileId && !p.disabled) : null;
            /* 指针只认「模型仍在该档 enabled 并集」—— 取勾后被移出的模型
               不回显不复活(服务端 PUT 已清针,这里是悬指针的最后防线)。 */
            const amValid = !!(am && activeProf
                && list.some((m) => m.id === am.modelId && m.profileId === am.profileId));
            setModels(list);
            setModelsError(null);
            setActiveModelState(amValid
                ? { profileId: am!.profileId, modelId: am!.modelId }
                : (list[0] ? { profileId: list[0].profileId ?? '', modelId: list[0].id } : null));
        } else {
            setConnProfiles([]);
            setModels([]);
            setModelsError(mdRes.reason instanceof Error ? mdRes.reason.message : 'profiles_error');
            setActiveModelState(null);
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
                setPresetDoc(chosenDoc);
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
    /* 登录失效广播(api/client.ts 判死:持续 401/403 且 me() 同挂才发)。
       诚实引导去 legacy /login —— 第一方登录页另案(multi-user.md §3.3)。 */
    useEffect(() => {
        const onExpired = () => setAuthExpired(true);
        window.addEventListener('utopinn:auth-expired', onExpired);
        return () => window.removeEventListener('utopinn:auth-expired', onExpired);
    }, []);
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

    /**
     * 激活预设统一写路 —— fn(curDoc)→nextDoc:ref 换写(save 真值源)、
     * presetDoc 状态水合编辑面、presetParams 投影与 presets 行摘要同步,
     * 450ms 防抖整档 PUT。PresetDocEditor / setPresetParam / togglePresetBlock
     * 全走这一条;ref 链保证连续编辑叠在同一 base 上,末次写赢。
     */
    const mutatePresetDoc = useCallback((fn: (doc: PresetDocument) => PresetDocument) => {
        if (!live || !activePresetDocRef.current) return;
        const { name, doc } = activePresetDocRef.current;
        const nextDoc = fn(doc);
        if (nextDoc === doc) return;
        activePresetDocRef.current = { name, doc: nextDoc };
        setPresetDoc(nextDoc);
        setPresetParams(extractPresetParams(nextDoc));
        setPresets((prev) => prev.map((p) => (p.id === name ? {
            ...p,
            temp: numOr(nextDoc.temperature, p.temp),
            topP: numOr(nextDoc.top_p, p.topP),
            ctxLen: numOr(nextDoc.openai_max_context, p.ctxLen),
            maxReply: numOr(nextDoc.openai_max_tokens, p.maxReply),
        } : p)));
        if (presetSaveTimer.current) clearTimeout(presetSaveTimer.current);
        presetSaveTimer.current = setTimeout(() => {
            void savePreset(name, nextDoc, 'openai').catch((e) => {
                showHint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true);
            });
        }, 450);
    }, [live, showHint, t]);

    /** 外部写面(studio 等)改过激活预设后重拉真值 —— 只读 GET,不动 settings。 */
    const reloadPresetDoc = useCallback(() => {
        const cur = activePresetDocRef.current;
        if (!live || !cur) return;
        void getPreset(cur.name, 'openai').then((res) => {
            activePresetDocRef.current = { name: cur.name, doc: res.doc };
            setPresetDoc(res.doc);
            setPresetParams(extractPresetParams(res.doc));
        }).catch(() => undefined);
    }, [live]);

    const setActiveModel = useCallback((sel: ActiveModelPointer) => {
        setActiveModelState(sel);
        if (!live || !sel?.modelId) return;
        void patchSettings({ oai_settings: { connection: { activeModel: { profileId: sel.profileId, modelId: sel.modelId } } } }).catch((e) => {
            showHint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true);
        });
    }, [live, showHint, t]);

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
            setPresetDoc(res.doc);
            setPresetParams(extractPresetParams(res.doc));
        }).catch((e) => {
            showHint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true);
        });
    }, [live, presets, showHint, t]);

    const setPresetParam = useCallback((k: 'temp' | 'topP' | 'ctxLen' | 'maxReply', v: number) => {
        if (!live) {
            setPresetParams((prev) => ({ ...prev, [k]: v }));
            setPresets((prev) => prev.map((p) => (p.id === activePresetId ? { ...p, [k]: v } : p)));
            return;
        }
        mutatePresetDoc((doc) => ({ ...doc, [PARAM_DOC_KEY[k]]: v }));
    }, [live, activePresetId, mutatePresetDoc]);

    const togglePresetBlock = useCallback((id: string) => {
        if (!live) {
            setPresetParams((prev) => ({
                ...prev,
                blocks: prev.blocks.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)),
            }));
            return;
        }
        /* live:翻 prompt_order.order[].enabled —— blocks 投影由
           mutatePresetDoc 内的 extractPresetParams 重算,不双写。 */
        mutatePresetDoc((doc) => {
            const d = doc as Record<string, unknown>;
            if (!Array.isArray(d.prompt_order)) return doc;
            const nextOrder = d.prompt_order.map((po) => {
                const entry = po as Record<string, unknown>;
                if (!Array.isArray(entry.order)) return po;
                return {
                    ...entry,
                    order: entry.order.map((o) => {
                        const item = o as Record<string, unknown>;
                        return item.identifier === id ? { ...item, enabled: item.enabled === false } : o;
                    }),
                };
            });
            return { ...doc, prompt_order: nextOrder };
        });
    }, [live, mutatePresetDoc]);

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

    /* 会话名沿用 ST 默认格式 YYYY-M-D @HHh MMm SSs —— 自动命名,
       不再走 window.prompt;未指定卡时弹卡选择模态(NewChatModal)。 */
    const createChatFor = useCallback((targetDir: string) => {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const name = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} @${pad(now.getHours())}h ${pad(now.getMinutes())}m ${pad(now.getSeconds())}s`;
        void createChat(targetDir, name)
            .then(() => refreshChats())
            .then(() => setActiveChat(`${targetDir}/${name}`))
            .then(() => setView('chat'))
            .catch((e) => showHint(t('chat.send.failed') + ': ' + (e instanceof Error ? e.message : e)));
    }, [refreshChats, showHint, t]);

    const onNewChat = useCallback((charDir?: string) => {
        if (serverStatus !== 'online') { setView('chat'); showHint(t('status.stub')); return; }
        if (!charDir) { openNewChatModal(); return; }
        createChatFor(charDir);
    }, [serverStatus, createChatFor, showHint, t]);

    /* 置顶切换 —— accountStorage.pinnedChats 浅合并写回(ST wire {file_name,avatar};
       charDir 附键给自家列表用,ST 端无它也不伤)。 */
    const onTogglePin = useCallback((c: ChatSummary) => {
        if (serverStatus !== 'online') { showHint(t('status.stub')); return; }
        /* 群会话 pin 面未接(pinnedChats 是卡域 {file_name,avatar} 键)——
           侧栏群行不画该钮;双保险防外部调用误写。 */
        if (c.groupId) return;
        const isPinned = pinnedRef.current.some(
            (p) => p.file_name === c.chatName && (p.charDir === c.charDir || p.avatar === `${c.charDir}.png`),
        );
        const next = isPinned
            ? pinnedRef.current.filter((p) => !(p.file_name === c.chatName && (p.charDir === c.charDir || p.avatar === `${c.charDir}.png`)))
            : [...pinnedRef.current, { file_name: c.chatName, avatar: `${c.charDir}.png`, charDir: c.charDir }];
        void patchSettings({ accountStorage: { pinnedChats: next } })
            .then(() => {
                pinnedRef.current = next;
                setPinnedChats(next);
                setChats((prev) => prev.map((x) => (x.id === c.id ? { ...x, pinned: !isPinned } : x)));
            })
            .catch((e) => showHint(t('chat.send.failed') + ': ' + (e instanceof Error ? e.message : e)));
    }, [serverStatus, showHint, t]);

    const onRenameChat = useCallback((c: ChatSummary, newName: string) => {
        if (serverStatus !== 'online') { showHint(t('status.stub')); return; }
        /* 群会话 rename 面未接(renameChat 是卡域路由)→ 侧栏群行不画;
           双保险,误调不改名也不写。 */
        if (c.groupId) return;
        const name = newName.trim();
        if (!name || name === c.chatName) return;
        void renameChat(c.charDir, c.chatName, name)
            .then((resolved) => {
                const id = `${c.charDir}/${resolved}`;
                setChats((prev) => prev.map((x) => (x.id === c.id ? { ...x, id, title: resolved, chatName: resolved } : x)));
                if (activeChat === c.id) setActiveChat(id);
            })
            .then(() => refreshChats())
            .catch((e) => showHint(t('chat.rename.failed') + ': ' + (e instanceof Error ? e.message : e)));
    }, [serverStatus, activeChat, refreshChats, showHint, t]);

    const onDeleteChat = useCallback((c: ChatSummary) => {
        if (serverStatus !== 'online') { showHint(t('status.stub')); return; }
        const fallback = chats.filter((x) => x.id !== c.id)[0]?.id ?? '';
        /* 群会话走群域删面(文件 + 群文档 chats[] 解绑);单聊不变。 */
        const del = c.groupId ? deleteGroupChat(c.groupId, c.chatName) : deleteChat(c.charDir, c.chatName);
        void del
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
            if (isMobile) setSheetSnap('half');
            else setWorkbenchOpen(true);
        } else {
            bumpPanelFreq(type);
            if (floatOrder.includes(type)) {
                /* 板块已浮出 → 聚焦置顶它的浮窗,不塞回右栏。 */
                setFloatOrder((prev) => [...prev.filter((x) => x !== type), type]);
            } else {
                setOpenTabs((prev) => (prev.includes(type) ? prev : [...prev, type]));
                setActiveTab(type);
                if (isMobile) setSheetSnap('half');
                else setWorkbenchOpen(true);
            }
        }
        setLauncherSearch('');
    }, [isMobile, floatOrder]);

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
       + 收 drawer;openChar 也走它,'char' 视图无映射直通。
       deep=深导航直通(hub bento/角色页 → studio 编辑页),不套域映射——
       否则 studio→hub 无条件改写会把深导航弹回 hub,移动 studio 全页不可达。 */
    const gotoView = useCallback((v: ViewId, deep = false) => {
        if (isMobile && !deep) {
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
        refreshChats,
        newChat: onNewChat,
        renameChat: onRenameChat,
        deleteChat: onDeleteChat,
        togglePin: onTogglePin,
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
            if (isMobile) return;
            setCardappFs(false);
            setFloatRects((prev) => (prev[type] ? prev : { ...prev, [type]: cascadeFloatRect(floatOrder.length) }));
            setFloatOrder((prev) => [...prev.filter((x) => x !== type), type]);
            const next = openTabs.filter((x) => x !== type);
            if (next.length !== openTabs.length) {
                setOpenTabs(next);
                if (activeTab === type) setActiveTab(next[next.length - 1] ?? 'newtab');
            }
            setWorkbenchOpen(true);
        },
        dockPanel: (type) => {
            setFloatOrder((prev) => prev.filter((x) => x !== type));
            setOpenTabs((prev) => (prev.includes(type) ? prev : [...prev, type]));
            setActiveTab(type);
            setWorkbenchOpen(true);
        },
        closeFloat: (type) => {
            /* 矩形记忆(floatRects[type])刻意不抹 —— 重浮回原位。 */
            setFloatOrder((prev) => prev.filter((x) => x !== type));
        },
        floatToFront: (type) => {
            setFloatOrder((prev) => (prev[prev.length - 1] === type ? prev : [...prev.filter((x) => x !== type), type]));
        },
        floatOrder, floatRects,
        setFloatRect: (type, r) => setFloatRects((prev) => ({
            ...prev,
            [type]: clampFloatRect(r, window.innerWidth, window.innerHeight),
        })),
        cardappFs, setCardappFs,
        wbExpand, setWbExpand,
        collapsePanels: () => {
            setCardappFs(false);
            /* 卡「收表面」:浮窗一并收档回抽屉 —— 留在外面就是没收净;
               矩形记忆保留,工作台重开后重浮仍回原位。 */
            if (floatOrder.length) {
                setOpenTabs((prev) => [...prev, ...floatOrder.filter((tp) => !prev.includes(tp))]);
                setFloatOrder([]);
            }
            setWorkbenchOpen(false);
            setSheetSnap('closed');
        },
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
        connSource, connProfiles,
        models, modelsError, activeModel, setActiveModel,
        presets, activePresetId, pickPreset,
        presetDoc, mutatePresetDoc, reloadPresetDoc,
        presetParams,
        setPresetParam,
        togglePresetBlock,
        globalLore, toggleGlobalLore,
        worldbook,
        refreshConnection,
        chatSettings,
        setChatSetting: (k, v) => setChatSettings((prev) => ({ ...prev, [k]: v })),
        stBg, setStBg, chatBgLock, setChatBgLock, stCss, setStCss,
        uiAmbience, setUiAmbience,
        stageData, patchStageData: (p) => setStageData((prev) => ({ ...prev, ...p })),
        hint: showHint,
        live,
        serverStatus,
    }), [
        view, railTab, chats, chat, activeChat, charDir, gotoView, pickPersona, sidebarOpen, workbenchOpen,
        openTabs, activeTab, floatOrder, floatRects, cardappFs, wbExpand, launcherSearch, panelParams,
        showHint, serverStatus, live, onNewChat, onRenameChat, onDeleteChat, onTogglePin, openPanel, refreshChats,
        cards, cardsMock, refreshCards, importDrafts, queueImport, dismissImportDraft,
        currentUser, refreshCurrentUser, personas, refreshPersonas, persona,
        openDropdown, accountPopOpen, settingsOpen, settingsTab, cmdkOpen, mobileDrawer,
        sheetSnap, vpMode, isMobile, studioNav, pluginsNav, adminNav, selectedPlugin,
        connSource, connProfiles, models, modelsError, activeModel, setActiveModel,
        presets, activePresetId, pickPreset, presetDoc, mutatePresetDoc, reloadPresetDoc, presetParams, setPresetParam, togglePresetBlock,
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
            <AmbientBackdrop />
            <div className="relative flex h-screen flex-col overflow-hidden bg-[color:var(--bg-chrome)]">
                {isMobile ? (
                    <main className="min-h-0 flex-1">
                        <MobileFrame />
                    </main>
                ) : (
                    <div className="flex min-h-0 flex-1">
                        <LeftChrome />
                        <div className="flex min-w-0 flex-1 overflow-hidden py-[8px] pr-[8px] pl-0">
                            <div className="workspace-inset">
                                {/* wbExpand:main 压 0 宽不 unmount —— 楼层/CardApp 挂载不死,
                                    还原即回原样(display:none 会 remount,不用)。 */}
                                <main className={wbExpand && workbenchOpen && !isMobile ? 'flex w-0 min-w-0 flex-col overflow-hidden' : 'flex min-w-0 flex-1 flex-col'}><ViewOutlet /></main>
                                <Workbench />
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <Cmdk />
            {!isMobile && <SettingsModal />}
            {hintState && <div className={`hint-pill spec-toast${hintState.err ? ' err' : ''}`}>{hintState.msg}</div>}
            {authExpired && (
                <div className="auth-expired-bar spec-toast" role="alert">
                    <span>{t('auth.expired')}</span>
                    <button type="button" onClick={() => { window.location.assign('/login'); }}>
                        {t('auth.relogin')}
                    </button>
                </div>
            )}
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

/** CSS url() → 内层地址('url("/backgrounds/x.png")' → '/backgrounds/x.png';
 *  非 url() 形原样返回)。 */
function bgCssInner(css: string): string {
    const m = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/.exec(css);
    return (m?.[1] ?? css).trim();
}

/** 探测 cssUrl 指向的图片是否真实可取(null=进行中/无 url)。Image 预载
 *  对 404/已删文件直接给 verdict,氛围层据此跳过死层或回落次选。 */
function useWallOk(cssUrl: string | null): boolean | null {
    const [ok, setOk] = useState<boolean | null>(null);
    useEffect(() => {
        const src = cssUrl ? bgCssInner(cssUrl) : '';
        if (!src) { setOk(null); return; }
        setOk(null);
        let dead = false;
        const img = new Image();
        img.onload = () => { if (!dead) setOk(true); };
        img.onerror = () => { if (!dead) setOk(false); };
        img.src = src;
        return () => { dead = true; img.onload = img.onerror = null; };
    }, [cssUrl]);
    return cssUrl ? ok : null;
}

/** 全局氛围层 —— App 根 backdrop,整壳半透明 chrome 透上来。
 *  图层:会话锁(chat_metadata.custom_background)> 全局 settings.background,
 *  重模糊压成氛围色场而非照片;bgMode 纹理叠其上;末层暗角保对比。
 *  浓度/模糊量全部由 --amb-* var 控(power_user.ui_ambience)。 */
function AmbientBackdrop() {
    const s = useShell();
    /* 会话锁 > 全局;两源各自预载验证 —— 死文件(清单换血/已删)不渲,
       锁死了回落全局而不是黑掉整层。 */
    const lock = s.chatBgLock;
    const glob = s.stBg?.url ?? null;
    const lockOk = useWallOk(lock);
    const globOk = useWallOk(glob);
    const wall = lockOk ? lock : (globOk ? glob : null);
    return (
        <div className="pointer-events-none fixed inset-0" aria-hidden="true">
            <div className="absolute inset-0" style={{ background: 'var(--amb-base, #08090A)' }} />
            {wall && (
                <div
                    className="absolute inset-0"
                    style={{
                        backgroundImage: wall,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        opacity: 'var(--amb-bg-alpha)',
                        filter: 'blur(10px) saturate(1.15) brightness(0.9)',
                    }}
                />
            )}
            {s.chatSettings.bgMode !== 'none' && (
                <div
                    className="absolute inset-0"
                    style={{
                        background: `url('/assets/backgrounds/${s.chatSettings.bgMode}.png') center/cover no-repeat`,
                        opacity: 'var(--amb-tex-alpha)',
                    }}
                />
            )}
            <div
                className="absolute inset-0"
                style={{ background: 'radial-gradient(130% 110% at 50% 0%, transparent 55%, rgba(0,0,0,0.38) 100%)' }}
            />
        </div>
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
