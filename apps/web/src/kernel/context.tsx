// Shell context — 壳持有的领域状态 + registry,经 Provider 下发;
// 领域组件(视图/板块/ctbar 动作/舞台形态)无 props,一律 useShell() 取数。
// props 消失是刻意的:接线归注册表,数据归上下文,App 不再做逐件对接。
// 规范稿 561 行的单文件 state 在这里按域拆开:会话/卡库/导入/persona/
// 板块(工作台)/浮层位/弹层开关/生成参数/mock 目录,各归各的字段。
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { CardItem } from '../api/characters';
import type { ImportDraft } from '../api/import';
import type { ActivePersona } from '../api/personas';
import type { GlobalLoreItem, MarketPluginItem, ModelItem, PresetItem } from '../api/mock';
import type { ChatSummary, PreviewResult, ServerStatus, ViewId } from '../types';
import type { Contributions, PanelInst, PanelType } from './contributions';
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

/** 聊天与消息设置(规范稿 stSettings 子集;SPEC-DATA: 本地态)。 */
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

export interface ShellCtx {
    registry: Registry;

    view: ViewId;
    setView: (v: ViewId) => void;
    /** 当前 railTab —— rail 域视图原值,非 rail 视图回落 'chat'。 */
    railTab: string;

    chats: ChatSummary[];
    /** 当前选中会话的 id(行高亮用);chat 是它解析出的对象。 */
    activeChat: string;
    chat: ChatSummary | null;
    selectChat: (id: string) => void;
    /** charDir 可指定开新会话的角色页上下文;缺省走当前会话的卡。 */
    newChat: (charDir?: string) => void;
    renameChat: (c: ChatSummary) => void;
    deleteChat: (c: ChatSummary) => void;

    /** 角色卡展示面(charDir → 行),App 单次拉取供侧栏/库/舞台头共用。 */
    cards: Map<string, CardItem>;
    /** cards 是 mock 回退时为 true(视图据此挂诚实徽标)。 */
    cardsMock: boolean;
    /** 导入卡后重拉展示面(新卡立刻出现在库/门厅)。 */
    refreshCards: () => Promise<void>;
    /** 导入中心的待办队列:全局拖放/选文件/URL 都落成 draft 往这里塞,ImportView 逐卡消费。 */
    importDrafts: ImportDraft[];
    /** 追加待办并跳导入中心(全局 drop 的唯一入口)。 */
    queueImport: (drafts: ImportDraft[]) => void;
    /** 出队 —— 提交落定或手动移除。 */
    dismissImportDraft: (id: string) => void;
    /** 门厅/库外跳角色页的中转:置位 → stories 视图打开该卡详情后清除。 */
    storiesFocus: string | null;
    openCharacter: (charDir: string) => void;
    clearStoriesFocus: () => void;

    /** 当前会话生效的 persona(舞台头快切;生成时携带进 body.user)。 */
    persona: ActivePersona | null;
    setPersona: (p: ActivePersona | null) => void;

    sidebarCollapsed: boolean;
    toggleSidebar: () => void;
    /** 沉浸:内容栏+右面板同收,只留 rail+阅读列。 */
    immersive: () => void;

    /* ——— 右工作台(规范稿 workbench):板块实例 tabs + launcher + 悬浮窗 ——— */
    panels: PanelInst[];
    activePanel: string | null;
    panelHidden: boolean;
    selectPanel: (id: string) => void;
    closePanel: (id: string) => void;
    addPanel: (type: PanelType) => void;
    toggleWorkbench: () => void;
    /** 「新标签页」启动器页(workbench body 切换到目录面)。 */
    launcherOpen: boolean;
    openLauncher: () => void;
    /** 可拆悬浮窗:非 null 时该板块从 wb tab 移到 floating-win。 */
    floating: PanelInst | null;
    floatingPos: { x: number; y: number };
    detachPanel: (id: string) => void;
    dockPanel: () => void;
    setFloatingPos: (p: { x: number; y: number }) => void;

    /* ——— 弹层与全局 chrome 状态(规范稿 overlay flags) ——— */
    contextOpen: boolean;
    setContextOpen: (v: boolean) => void;
    composerMenuOpen: boolean;
    setComposerMenuOpen: (v: boolean) => void;
    presetPopOpen: boolean;
    setPresetPopOpen: (v: boolean) => void;
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
    /** 派生:vpMode=mobile 或 auto 且窗口 ≤680px。 */
    isMobile: boolean;
    /** 面板入口(移动 = 拉起 vaul-sheet;桌面 = 加板块并展开右栏)。 */
    openPanelSurface: (type?: PanelType) => void;

    /* ——— studio/plugins 域内导航(侧栏树写入,主区读取) ——— */
    studioNav: string;
    setStudioNav: (v: string) => void;
    pluginsNav: 'installed' | 'market';
    setPluginsNav: (v: 'installed' | 'market') => void;

    /* ——— 生成参数目录(SPEC-DATA: 目录数据是 mock,目录见 api/mock) ——— */
    models: ModelItem[];
    activeModel: string;
    setActiveModel: (id: string) => void;
    presets: PresetItem[];
    activePresetId: string;
    setActivePreset: (id: string) => void;
    presetParams: PresetParams;
    setPresetParam: (k: 'temp' | 'topP' | 'ctxLen' | 'maxReply', v: number) => void;
    togglePresetBlock: (id: string) => void;
    globalLore: GlobalLoreItem[];
    toggleGlobalLore: (id: string) => void;
    marketPlugins: MarketPluginItem[];
    toggleMarketPlugin: (id: string) => void;
    chatSettings: ChatSettings;
    setChatSetting: <K extends keyof ChatSettings>(k: K, v: ChatSettings[K]) => void;

    /* ——— MVU 快照(SPEC-DATA: 服务端 MVU 端点未出,种子值见 api/mock) ——— */
    mvu: Record<string, string | number>;
    mvuStep: (key: string, d: number) => void;
    echoMvu: boolean;

    preview: PreviewResult | null;
    previewLoading: boolean;
    runPreview: () => void;

    hint: (msg: string, err?: boolean) => void;
    /** 后端可达(mock/离线时为 false,视图据此给诚实降级)。 */
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
