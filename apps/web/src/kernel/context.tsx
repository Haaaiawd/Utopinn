// Shell context — 壳持有的领域状态 + registry,经 Provider 下发;
// 领域组件(视图/板块/舞台形态)无 props,一律 useShell() 取数。
// props 消失是刻意的:接线归注册表,数据归上下文,App 不再做逐件对接。
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { CurrentUser } from '../api/account';
import type { CardItem } from '../api/characters';
import type { ImportDraft } from '../api/import';
import type { ActivePersona, PersonaItem } from '../api/personas';
import type { PresetDocument } from '../api/presets';
import type {
    GlobalLoreItem, ImChannel, ModelItem,
    NovelChapter, PresetItem, VnData, WorldbookItem,
} from '../api/mock';
import type { ActiveModelPointer, ConnectionProfile } from '../api/connection';
import type { ChatSummary, ServerStatus, ViewId } from '../types';
import type { Contributions, PanelType } from './contributions';
import { Registry } from './registry';

export type SheetSnap = 'closed' | 'half' | 'full';
export type VpMode = 'auto' | 'desktop' | 'mobile';

/** 浮窗矩形(视口内 fixed 定位,单位 px)。 */
export interface FloatRect { x: number; y: number; w: number; h: number }

/** 无记忆矩形时的默认落位;多窗级联偏移由调用方加。 */
export const DEFAULT_FLOAT_RECT: FloatRect = { x: 96, y: 96, w: 420, h: 480 };

/** 浮窗最小尺寸(拖拽/缩放/水合/视口钳位共用下界)。 */
export const FLOAT_MIN_W = 320;
export const FLOAT_MIN_H = 240;

/** 矩形钳回视口内:尺寸不小于下界、四边不出屏 ——
 *  拖/缩/存档水合/视口 resize 共用(纯函数,视口尺寸由调用方给)。 */
export function clampFloatRect(r: FloatRect, vw: number, vh: number): FloatRect {
    const w = Math.min(Math.max(FLOAT_MIN_W, r.w), Math.max(FLOAT_MIN_W, vw - 16));
    const h = Math.min(Math.max(FLOAT_MIN_H, r.h), Math.max(FLOAT_MIN_H, vh - 16));
    const x = Math.min(Math.max(0, r.x), Math.max(0, vw - w));
    const y = Math.min(Math.max(0, r.y), Math.max(0, vh - h));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** 预设/生成参数(由当前选中预设 doc 水合,调参防抖写回 PUT /presets/:name)。 */
export interface PresetParams {
    temp: number;
    topP: number;
    ctxLen: number;
    maxReply: number;
    blocks: { id: string; name: string; enabled: boolean }[];
}

/** 聊天与外观设置(本地持久化 utopinn.chatSettings)。 */
export interface ChatSettings {
    renderCount: number;
    autoParseThink: boolean;
    autoExpandThink: boolean;
    showFloorNum: boolean;
    confirmDelete: boolean;
    fontSize: number;
    /** 内置氛围纹理(本地滤镜,叠加于酒馆背景之上)。 */
    bgMode: string;
    customCss: string;
}

/** ST settings.background 槽({name,url,fitting};url 是 CSS url() 字符串)。 */
export interface StBackground {
    name: string;
    url: string;
    fitting: string;
}

/** 全局氛围层参数 —— power_user.ui_ambience 服务端槽(snake_case 落盘):
 *  bg_alpha 壁纸浓度(0~0.9) / glass_blur 毛玻璃 px(0~32) / tex_alpha 纹理浓度(0~0.3)。 */
export interface UiAmbience {
    bgAlpha: number;
    glassBlur: number;
    texAlpha: number;
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
    setView: (v: ViewId, deep?: boolean) => void;
    /** 当前 railTab —— rail 域视图原值,非 rail 视图回落 'chat'。 */
    railTab: string;

    chats: ChatSummary[];
    /** 当前选中会话的 id(规范稿 activeSessionId);chat 是它解析出的对象。 */
    activeChat: string;
    chat: ChatSummary | null;
    selectChat: (id: string) => void;
    /** 会话清单重拉(外部建会话后导航前置 —— selectChat 的 id 需在列里)。 */
    refreshChats: () => Promise<boolean>;
    /** 角色页(view==='char')当前展示的 charDir —— TASK-026 三级路径中层。 */
    charDir: string | null;
    /** 打开某卡的角色页(视图切 'char',会话选择不变 —— 页内选会话才落聊天)。 */
    openChar: (charDir: string) => void;
    newChat: (charDir?: string) => void;
    /** 行内重命名提交 —— newName 为最终名;实现侧 trim/同名贵任由调用方先行。 */
    renameChat: (c: ChatSummary, newName: string) => void;
    deleteChat: (c: ChatSummary) => void;
    /** 置顶切换 —— accountStorage.pinnedChats 服务端槽(ST 同槽)。 */
    togglePin: (c: ChatSummary) => void;

    /** 角色卡展示面(charDir → 行),App 单次拉取供侧栏/主区共用。 */
    cards: Map<string, CardItem>;
    cardsMock: boolean;
    refreshCards: () => Promise<void>;
    importDrafts: ImportDraft[];
    queueImport: (drafts: ImportDraft[]) => void;
    dismissImportDraft: (id: string) => void;

    /** 当前 handle 账户画像(GET /api/users/me;离线时为 null)。 */
    currentUser: CurrentUser | null;
    refreshCurrentUser: () => Promise<void>;

    /** 服务端人设目录 + 当前会话生效的 persona(生成时携带进 body.user)。 */
    personas: PersonaItem[];
    refreshPersonas: () => Promise<void>;
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
    /** 拆出为悬浮窗(规范稿 detach-panel)—— v3 逐板块浮窗:
     *  板块从 openTabs 摘除进 floatOrder,PoolSlot 同 React 子树 class 换
     *  floating-win 壳 —— detach/dock 全程 iframe 零 remount(嵌卡不重启)。
     *  已浮出的 type 再调 = 置顶。 */
    detachPanel: (type: PanelType) => void;
    /** 浮窗收档回右栏:摘出浮窗集、补回 openTabs 尾并激活(矩形记忆保留)。 */
    dockPanel: (type: PanelType) => void;
    /** 关浮窗 = 摘出浮窗集不收档;矩形记忆保留,重浮回原位。 */
    closeFloat: (type: PanelType) => void;
    /** 点击浮窗置顶 —— floatOrder 末尾=最顶(只改 zIndex,不搬 DOM)。 */
    floatToFront: (type: PanelType) => void;
    /** 当前浮窗集,数组序 = z 序(back→front)。 */
    floatOrder: PanelType[];
    /** 各板块浮窗矩形记忆(type → rect):收档/关闭不抹,重浮/刷新回原位;
     *  随 WbLayout 按会话存档。 */
    floatRects: Record<PanelType, FloatRect>;
    setFloatRect: (type: PanelType, r: FloatRect) => void;
    /** CardApp 全屏提升:cardapp 类板块激活时 tab 条给「全屏」钮;
     *  .cardapp-host 切 fixed inset-0(同树不 remount),ESC/关闭钮还原。 */
    cardappFs: boolean;
    setCardappFs: (v: boolean) => void;
    /** 工作台占满聊天区:右栏吃整个 workspace-inset 宽(main 压 0 宽但
     *  不 unmount —— 楼层/挂载不死),还原回原宽。按会话随 WbLayout 记档;
     *  移动端不出钮(小屏无意义)。 */
    wbExpand: boolean;
    setWbExpand: (v: boolean) => void;
    /** 跨格契约(卡「收表面」):收起面板区 —— 工作台折叠 + 移动 sheet 归
     *  closed + 浮窗一并收档回 openTabs(矩形记忆保留,重浮回原位)。 */
    collapsePanels: () => void;
    launcherSearch: string;
    setLauncherSearch: (s: string) => void;

    /* ——— 弹层与全局 chrome 状态 ——— */
    /** 预设 popover/panel 共享的下拉态('model'|'preset')。 */
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
     *  值为服务端插件 id(mock 市场目录 'mkt:' 件已随假数据令撤除)。null 回总览。 */
    selectedPlugin: string | null;
    setSelectedPlugin: (id: string | null) => void;

    /* ——— 生成连接/模型/预设/全局世界书(在线水合自 /settings /models /presets /worlds) ——— */
    connSource: string;
    /** 全 profile 勾选模型的并集(每项带 profileId/profileName 属主)。 */
    models: ModelItem[];
    modelsError: string | null;
    /** 生效模型指针 —— 同 id 模型可属不同 profile,必须带属主判同一。 */
    activeModel: ActiveModelPointer | null;
    /** 选模型 = 写 oai_settings.connection.activeModel;离线只动本地态。 */
    setActiveModel: (sel: ActiveModelPointer) => void;
    /** 连接配置档案目录(oai_settings.connection_profiles;refreshConnection 水合)。 */
    connProfiles: ConnectionProfile[];
    presets: PresetItem[];
    activePresetId: string;
    /** 切换激活预设:写回 settings.preset_settings_openai 并装载采样/条目参数。 */
    pickPreset: (id: string) => void;
    /** 激活预设(openai 家族)的整档 doc —— PresetDocEditor 直接读;
     *  离线或档未拉到为 null(编辑器禁用,不写假档)。 */
    presetDoc: PresetDocument | null;
    /** 激活预设统一写路:fn(doc)→next —— 同步重算 presetParams 投影与
     *  presets 行摘要,防抖整档 PUT;编辑面一律走它,不另开写路。 */
    mutatePresetDoc: (fn: (doc: PresetDocument) => PresetDocument) => void;
    /** 外部写面(studio 页/其他端)改过激活预设档后,重拉服务端真值
     *  回灌 presetDoc/presetParams —— 双编辑面收敛位。 */
    reloadPresetDoc: () => void;
    presetParams: PresetParams;
    setPresetParam: (k: 'temp' | 'topP' | 'ctxLen' | 'maxReply', v: number) => void;
    togglePresetBlock: (id: string) => void;
    globalLore: GlobalLoreItem[];
    toggleGlobalLore: (id: string) => void;
    worldbook: WorldbookItem[];
    refreshConnection: (opts?: { freshModels?: boolean }) => Promise<void>;
    chatSettings: ChatSettings;
    setChatSetting: <K extends keyof ChatSettings>(k: K, v: ChatSettings[K]) => void;

    /* ——— 酒馆外观(ST settings 槽)———
       stBg:settings.background 全局聊天背景;chatBgLock:当前会话
       chat_metadata.custom_background 锁(CSS url 或 null);stCss:
       power_user.custom_css。三者均由 refreshConnection 的 settings 拉取水合,
       写回走 PATCH /settings 与 chats PATCH(chat_metadata)。 */
    stBg: StBackground | null;
    setStBg: (b: StBackground | null) => void;
    chatBgLock: string | null;
    setChatBgLock: (url: string | null) => void;
    stCss: string;
    setStCss: (css: string) => void;
    /** 全局氛围层(power_user.ui_ambience)—— 壁纸/纹理浓度 + 毛玻璃量。 */
    uiAmbience: UiAmbience;
    setUiAmbience: (a: UiAmbience) => void;

    /* ——— 舞台形态会话数据(SPEC-DATA:预演种子,面板与舞台共享) ——— */
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
