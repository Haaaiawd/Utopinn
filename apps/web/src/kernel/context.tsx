// Shell context — 壳持有的领域状态 + registry,经 Provider 下发;
// 领域组件(视图/板块/ctbar 动作)无 props,一律 useShell() 取数。
// props 消失是刻意的:接线归注册表,数据归上下文,App 不再做逐件对接。
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
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
    newChat: () => void;
    renameChat: (c: ChatSummary) => void;
    deleteChat: (c: ChatSummary) => void;

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
