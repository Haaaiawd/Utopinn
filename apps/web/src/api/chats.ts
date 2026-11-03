// Library chats via /api/uberge (TASK-018) + user-message append via
// /api/chats/append (legacy endpoint, still the server's write path).
// ST wire message shape: {name, is_user, is_system, mes, send_date, swipe_id,
// swipes:[...], extra} — mapped here into the renderer contract
// (MessageViewModel) so renderers never see storage fields.
import { apiFetch, apiPost, ApiError } from './client';
import type { MessageViewModel, SwipeView } from '@uberge/protocol';

interface StChatMessage {
    name?: string;
    is_user?: boolean;
    is_system?: boolean;
    mes?: string;
    send_date?: number | string;
    swipe_id?: number;
    swipes?: (string | { mes?: string; send_date?: number | string })[];
    extra?: Record<string, unknown>;
}

interface ChatDetail {
    name: string;
    header: Record<string, unknown>;
    messages: StChatMessage[];
}

async function apiGet<T>(path: string): Promise<T> {
    const res = await apiFetch(path);
    if (!res.ok) {
        const unreachable = res.status === 502 && res.headers.has('x-uberge-proxy-error');
        const text = await res.text().catch(() => '');
        throw new ApiError(unreachable ? 'upstream_unavailable' : (text || res.statusText), res.status);
    }
    return (await res.json()) as T;
}

/** ST wire message → renderer view model. */
export function stToView(m: StChatMessage, id: number): MessageViewModel {
    const active = Number(m.swipe_id ?? 0);
    const swipes: SwipeView[] | undefined = Array.isArray(m.swipes) && m.swipes.length > 1
        ? m.swipes.map((s, i) => ({
            index: i,
            content: typeof s === 'string' ? s : (s.mes ?? ''),
            timestamp: typeof s === 'object' && s.send_date != null ? Number(s.send_date) : undefined,
        }))
        : undefined;
    const base = swipes?.[Math.min(active, swipes.length - 1)];
    return {
        id,
        role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
        name: m.name ?? '',
        content: base?.content ?? m.mes ?? '',
        timestamp: m.send_date != null ? Number(m.send_date) : undefined,
        swipes,
        activeSwipe: swipes ? Math.min(active, swipes.length - 1) : undefined,
    };
}

/** Load a chat's floors. 404 bubbles up so the caller can show the honest path. */
export async function getChat(charDir: string, chatName: string): Promise<{ header: Record<string, unknown>; messages: MessageViewModel[] }> {
    const d = await apiGet<ChatDetail>(
        `/api/uberge/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`,
    );
    return { header: d.header, messages: d.messages.map(stToView) };
}

/**
 * Append one user message to the chat file, then the caller typically fires
 * /api/uberge/generate. Mirrors the old client's /api/chats/append call.
 */
/** Sidebar list: every character's chats flattened to ChatSummary. */
export async function listAllChats(): Promise<import('../types').ChatSummary[]> {
    const { items: chars } = await apiGet<{ items: { charDir: string; name: string; readable: boolean }[] }>('/api/uberge/characters');
    const out: import('../types').ChatSummary[] = [];
    for (const c of chars.filter((x) => x.readable !== false)) {
        try {
            const { items: chats } = await apiGet<{ items: { name: string; messageCount: number; updatedAt: string }[] }>(
                `/api/uberge/characters/${encodeURIComponent(c.charDir)}/chats`,
            );
            for (const ch of chats) {
                out.push({
                    id: `${c.charDir}/${ch.name}`,
                    title: ch.name,
                    charDir: c.charDir,
                    chatName: ch.name,
                    group: c.name,
                    updatedAt: ch.updatedAt,
                });
            }
        } catch { /* per-char chat list failure doesn't kill the sidebar */ }
    }
    return out;
}

/** Create a chat file (server saves header + the seed system message). */
export async function createChat(charDir: string, chatName: string): Promise<void> {
    await apiPost('/api/chats/append', {
        avatar_url: `${charDir}.png`,
        file_name: `${chatName}.jsonl`,
        chat_metadata: {},
        message: { name: '', is_user: false, is_system: true, mes: '', send_date: Date.now(), extra: {} },
    });
}

/** Persist the active swipe of floor `index` (RFC6902 on the message array). */
export async function patchSwipe(charDir: string, chatName: string, index: number, swipeId: number): Promise<void> {
    await apiPost('/api/chats/patch', {
        avatar_url: `${charDir}.png`,
        file_name: `${chatName}.jsonl`,
        force: true,
        operations: [{ op: 'replace', path: `/${index}/swipe_id`, value: swipeId }],
    });
}

export async function appendUserMessage(charDir: string, chatName: string, name: string, text: string): Promise<void> {
    await apiPost('/api/chats/append', {
        avatar_url: `${charDir}.png`,
        file_name: `${chatName}.jsonl`,
        message: {
            name,
            is_user: true,
            is_system: false,
            mes: text,
            send_date: Date.now(),
            extra: {},
        },
    });
}
