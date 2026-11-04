// App-local view types. Wire/resource types come from '@uberge/protocol'
// (import type only — protocol ships types + guards, the SPA must not
// re-declare server contracts).

/** Primary navigation domains — IA v3 (web-ia.md §13/§14) + 门厅(TASK-026 RP 首页)。 */
export const VIEW_IDS = ['foyer', 'chat', 'stories', 'rules', 'import', 'extensions', 'settings'] as const;
export type ViewId = (typeof VIEW_IDS)[number];

/** Sidebar chat entry. `charDir`/`chatName` are the /api/uberge/* call params. */
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
}

/** Server reachability — drives status bar + mock badge. */
export type ServerStatus = 'checking' | 'online' | 'mock' | 'offline';

/** POST /api/uberge/preview response (apps/server/src/endpoints/uberge-generate.js). */
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
