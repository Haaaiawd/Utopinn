// App-local view types. Wire/resource types come from '@utopinn/protocol'
// (import type only — protocol ships types + guards, the SPA must not
// re-declare server contracts).

/** Primary navigation domains — 规范稿四 rail 域(home/chat/studio/plugins)
 *  + 旧 IA v3 视图(stories/rules/import/extensions/settings/foyer,保留可达)
 *  + 'hub'(移动端资产工坊页)。rail 域 = 左轨 nav.rail 贡献点直接映射。 */
export const VIEW_IDS = ['home', 'chat', 'studio', 'plugins', 'hub', 'foyer', 'stories', 'rules', 'import', 'extensions', 'settings'] as const;
export type ViewId = (typeof VIEW_IDS)[number];

/** 左轨四域(规范稿 railTab);非 rail 视图回落 'chat' 侧栏树。 */
export const RAIL_VIEWS = ['home', 'chat', 'studio', 'plugins'] as const;
export type RailId = (typeof RAIL_VIEWS)[number];

/** 舞台形态 —— s.stage,聊天之外留给 stage 插件占位(utopinn 市场件 u-stage-*)。 */
export type StageKind = 'chat' | 'novel' | 'messenger' | 'galgame' | (string & {});

/** Sidebar chat entry. `charDir`/`chatName` are the /api/utopinn/* call params. */
export interface ChatSummary {
    id: string;
    title: string;
    /** Character directory name (avatar basename, no extension). */
    charDir: string;
    /** Chat file name without .jsonl. */
    chatName: string;
    group?: string;
    updatedAt?: string;
    unread?: boolean;
    /** 规范稿 s.pinned —— 侧栏「置顶」分区的会话。 */
    pinned?: boolean;
    /** 舞台形态绑定;缺省 'chat'。SPEC-DATA: 待接 —— 卡面 extensions 声明位未定。 */
    stage?: StageKind;
    /** 规范稿 s.defaultTabs —— 选中会话时工作台自动开出的板块类型列表。 */
    defaultTabs?: string[];
}

/** Server reachability — drives status bar + mock badge. */
export type ServerStatus = 'checking' | 'online' | 'mock' | 'offline';

/** POST /api/utopinn/preview response (apps/server/src/endpoints/utopinn-generate.js). */
export interface PreviewMessage {
    role: string;
    content: unknown;
    name?: string;
}

export interface PreviewTrace {
    collections: { identifier: string; tokens: number; count: number }[];
    tokenBudget: number;
    remainingBudget: number;
    droppedChatCount: number;
    injectedCount: number;
}

export interface PreviewSources {
    presetName?: string;
    model?: string;
    worldInfoActivated?: number;
    chatCount?: number;
}

export interface PreviewResponse {
    messages: PreviewMessage[];
    trace?: PreviewTrace;
    sources?: PreviewSources;
}

export interface PreviewRequestBody {
    charDir: string;
    chatName: string;
    presetName?: string;
    type?: string;
    user?: { name: string; description?: string };
    overrides?: Record<string, unknown>;
}

/** Result wrapper so the UI can label mock data honestly. */
export interface PreviewResult {
    data: PreviewResponse | null;
    /** True when the server was unreachable and `data` is mock. */
    mock: boolean;
    error?: string;
}
