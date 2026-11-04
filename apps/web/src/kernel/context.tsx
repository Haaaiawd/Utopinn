// Shell context — 壳持有的领域状态 + registry,经 Provider 下发;
// 领域组件(视图/板块/ctbar 动作)无 props,一律 useShell() 取数。
// props 消失是刻意的:接线归注册表,数据归上下文,App 不再做逐件对接。
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { CardItem } from '../api/characters';
import type { ActivePersona } from '../api/personas';
import type { ChatSummary, PreviewResult, ServerStatus, ViewId } from '../types';
import type { Contributions, PanelInst, PanelType } from './contributions';
import { Registry } from './registry';

export interface ShellCtx {
    registry: Registry;

    view: ViewId;
    setView: (v: ViewId) => void;

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

    panels: PanelInst[];
    activePanel: string | null;
    panelHidden: boolean;
    selectPanel: (id: string) => void;
    closePanel: (id: string) => void;
    addPanel: (type: PanelType) => void;

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
