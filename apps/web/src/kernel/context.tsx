// Shell context — 壳持有的领域状态 + registry,经 Provider 下发;
// 领域组件(视图/板块/舞台形态)无 props,一律 useShell() 取数。
// props 消失是刻意的:接线归注册表,数据归上下文,App 不再做逐件对接。
// 字段语义逐条对齐规范稿(u_ui_codex)单文件 state:openTabs/activeTab/
// workbenchOpen/floatingPanelId/selectedLoreId/notesText/stageData。
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { CardItem } from '../api/characters';
import type { ImportDraft } from '../api/import';
import type { ActivePersona } from '../api/personas';
import type {
    GlobalLoreItem, ImChannel, ModelItem,
    NovelChapter, PresetItem, VnData, WorldbookItem,
} from '../api/mock';
import type { ChatSummary, ServerStatus, ViewId } from '../types';
import type { Contributions, PanelType } from './contributions';
import { Registry } from './registry';

export type SheetSnap = 'closed' | 'half' | 'full';
export type VpMode = 'auto' | 'desktop' | 'mobile';

/** 预设/生成参数(规范稿 state.presetParams;SPEC-DATA: 服务端无持久端点)。 */
export interface PresetParams {
    temp: number;
    topP: number;
    ctxLen: number;
    maxReply: number;
    blocks: { id: string; name: string; enabled: boolean }[];
}

/** 聊天与消息设置(规范稿 stSettings;SPEC-DATA: 本地态)。 */
export interface ChatSettings {
    renderCount: number;
    streamFps: number;
    autoParseThink: boolean;
    autoExpandThink: boolean;
    showFloorNum: boolean;
    confirmDelete: boolean;
    fontSize: number;
    bgMode: string;
    customCss: string;
    apiTab: string;
    endpoint: string;
}

/** 舞台形态会话的展示数据(规范稿 s.chapters/s.channels/s.vn 落地位)。
 *  SPEC-DATA: 待接 —— 内容是 mock 种子;聊天形态不在此列。 */
export interface StageData {
    chapters: NovelChapter[];
    selParaId: string | null;
    channels: ImChannel[];
    activeChannel: string;
    vn: VnData;
}

export interface ShellCtx {
    registry: Registry;

    view: ViewId;
    setView: (v: ViewId) => void;
    /** 当前 railTab —— rail 域视图原值,非 rail 视图回落 'chat'。 */
    railTab: string;

    chats: ChatSummary[];
    /** 当前选中会话的 id(规范稿 activeSessionId);chat 是它解析出的对象。 */
    activeChat: string;
    chat: ChatSummary | null;
    selectChat: (id: string) => void;
    newChat: (charDir?: string) => void;
    renameChat: (c: ChatSummary) => void;
    deleteChat: (c: ChatSummary) => void;

    /** 角色卡展示面(charDir → 行),App 单次拉取供侧栏/主区共用。 */
    cards: Map<string, CardItem>;
    cardsMock: boolean;
    refreshCards: () => Promise<void>;
    importDrafts: ImportDraft[];
    queueImport: (drafts: ImportDraft[]) => void;
    dismissImportDraft: (id: string) => void;

    /** 当前会话生效的 persona(生成时携带进 body.user)。 */
    persona: ActivePersona | null;
    setPersona: (p: ActivePersona | null) => void;

    /** 规范稿 sidebarOpen —— logo 按钮切换。 */
    sidebarOpen: boolean;
    toggleSidebar: () => void;

    /* ——— 右工作台(规范稿 workbenchOpen + openTabs/activeTab + 悬浮窗) ——— */
    workbenchOpen: boolean;
    toggleWorkbench: () => void;
    /** 已开板块类型列表(规范稿 openTabs —— 同类型至多一页)。 */
    openTabs: PanelType[];
    /** 激活页:板块类型或 'newtab'(launcher 页,规范稿 activeTab)。 */
    activeTab: string;
    selectTab: (id: string) => void;
    openNewTab: () => void;
    closeTab: (id: string) => void;
    /** 规范稿 open-panel:补 push + 激活 + 展开工作台(移动端拉起半屏 sheet)。
     *  params 是随行载荷 —— 写进 panelParams[type] 后由板块体自行消费,
     *  如 openPanel('diag', { sub:'trace', job }) 直开某 job 的 trace 页;
     *  不传 params 保留该类型上次的现场(重开=恢复)。 */
    openPanel: (type: PanelType, params?: unknown) => void;
    /** 板块载荷袋(键=板块类型,值=体自释形状;壳不解释,透传不透解)。 */
    panelParams: Record<string, unknown>;
    /** 整包替换某类型的载荷;板块体内部导航也走它(现场跨 tab 切换保持)。 */
    setPanelParams: (type: PanelType, params: unknown) => void;
    /** 拆出为悬浮窗(规范稿 detach-panel)—— v2:整个工作台 aside 提升为
     *  浮窗壳,openTabs 不摘、PanelBody 同一 React 子树,detach/dockBack
     *  全程 iframe 零 remount(嵌卡不重启)。type = 发起板块,记档用。 */
    detachPanel: (type: PanelType) => void;
    /** 浮窗还原为右栏 aside(同树回挂,零 remount)。 */
    dockBack: () => void;
    /** 关浮窗 = 移除发起板块并还原 dock(沿用旧语义「面板丢弃」)。 */
    closeFloat: () => void;
    /** 浮窗态旗标:非 null = 工作台 aside 正以浮窗渲染;值=发起板块类型。 */
    floatingType: PanelType | null;
    /** 浮窗矩形(位置+尺寸);随 WbLayout 按会话存档。 */
    floatingRect: { x: number; y: number; w: number; h: number };
    setFloatingRect: (r: { x: number; y: number; w: number; h: number }) => void;
    /** CardApp 全屏提升:cardapp 类板块激活时 tab 条给「全屏」钮;
     *  .cardapp-host 切 fixed inset-0(同树不 remount),ESC/关闭钮还原。 */
    cardappFs: boolean;
    setCardappFs: (v: boolean) => void;
    /** 跨格契约(卡「收表面」):收起面板区 —— 工作台折叠 + 移动 sheet 归
     *  closed。复用现有「收起工作台」语义,openTabs 不清。 */
    collapsePanels: () => void;
    launcherSearch: string;
    setLauncherSearch: (s: string) => void;

    /* ——— 弹层与全局 chrome 状态(规范稿 overlay flags) ——— */
    contextOpen: boolean;
    setContextOpen: (v: boolean) => void;
    composerMenuOpen: boolean;
    setComposerMenuOpen: (v: boolean) => void;
    presetPopOpen: boolean;
    setPresetPopOpen: (v: boolean) => void;
    /** 预设 popover/panel 共享的下拉态(规范稿 openDropdown:'model'|'preset')。 */
    openDropdown: string | null;
    setOpenDropdown: (v: string | null) => void;
    accountPopOpen: boolean;
    setAccountPopOpen: (v: boolean) => void;
    settingsOpen: boolean;
    settingsTab: string;
    openSettings: (tab?: string) => void;
    closeSettings: () => void;
    setSettingsTab: (t: string) => void;
    cmdkOpen: boolean;
    setCmdkOpen: (v: boolean) => void;

    /* ——— 移动壳(hub/drawer/vaul-sheet + 视口切换) ——— */
    mobileDrawer: boolean;
    setMobileDrawer: (v: boolean) => void;
    sheetSnap: SheetSnap;
    setSheetSnap: (s: SheetSnap) => void;
    vpMode: VpMode;
    setVpMode: (m: VpMode) => void;
    isMobile: boolean;

    /* ——— studio/plugins/admin 域内导航 ——— */
    studioNav: string;
    setStudioNav: (v: string) => void;
    pluginsNav: 'installed' | 'market';
    setPluginsNav: (v: 'installed' | 'market') => void;
    /** 管理域分区索引(overview / users / config)。 */
    adminNav: string;
    setAdminNav: (v: string) => void;
    /** 插件详情卡选中件 —— rail 插件页点行落点(顶部详情卡);
     *  'mkt:' 前缀 = mock 市场目录件,无前缀 = 服务端插件 id。null 回总览。 */
    selectedPlugin: string | null;
    setSelectedPlugin: (id: string | null) => void;

    /* ——— 生成参数目录(SPEC-DATA: 目录数据是 mock,目录见 api/mock) ——— */
    models: ModelItem[];
    activeModel: string;
    setActiveModel: (id: string) => void;
    presets: PresetItem[];
    activePresetId: string;
    /** 规范稿 pick-preset:装载即把 temp/topP/ctxLen/maxReply 倒进 presetParams。 */
    pickPreset: (id: string) => void;
    presetParams: PresetParams;
    setPresetParam: (k: 'temp' | 'topP' | 'ctxLen' | 'maxReply', v: number) => void;
    togglePresetBlock: (id: string) => void;
    globalLore: GlobalLoreItem[];
    toggleGlobalLore: (id: string) => void;
    worldbook: WorldbookItem[];
    selectedLoreId: string;
    setSelectedLoreId: (id: string) => void;
    notesText: string;
    setNotesText: (s: string) => void;
    chatSettings: ChatSettings;
    setChatSetting: <K extends keyof ChatSettings>(k: K, v: ChatSettings[K]) => void;

    /* ——— MVU 快照(规范稿 s.mvu 全局化;SPEC-DATA: 服务端 MVU 端点未出) ——— */
    mvu: Record<string, string | number>;
    setMvu: (m: Record<string, string | number>) => void;
    mvuStep: (key: string, d: number) => void;
    echoMvu: boolean;
    /** 规范稿 bridgeOp:总簿拨款/月俸/征收三动作。 */
    bridgeOp: (op: string) => void;

    /* ——— 舞台形态会话数据(SPEC-DATA:mock 种子,面板与舞台共享) ——— */
    stageData: StageData;
    patchStageData: (p: Partial<StageData>) => void;

    hint: (msg: string, err?: boolean) => void;
    live: boolean;
    serverStatus: ServerStatus;
}

const Ctx = createContext<ShellCtx | null>(null);

export function ShellProvider({ value, children }: { value: ShellCtx; children: ReactNode }) {
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellCtx {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error('useShell outside ShellProvider');
    return ctx;
}

/** 订阅式读贡献点 —— 注册表变动时重渲,挂的是 shell 生命周期。 */
export function useContribs<K extends keyof Contributions>(point: K): readonly Contributions[K][] {
    const { registry } = useShell();
    return useSyncExternalStore(
        registry.subscribe,
        () => registry.list(point),
        () => registry.list(point),
    );
}
