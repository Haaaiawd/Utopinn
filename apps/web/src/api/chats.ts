// Library chats via /api/utopinn (TASK-018) + user-message append via
// /api/chats/append (legacy endpoint, still the server's write path).
// ST wire message shape: {name, is_user, is_system, mes, send_date, swipe_id,
// swipes:[...], extra} — mapped here into the renderer contract
// (MessageViewModel) so renderers never see storage fields.
import { apiFetch, apiGet, apiPost, assertOk } from './client';
import { MVU_STATUS_PLACEHOLDER } from '@utopinn/protocol';
import type { MessageViewModel, SwipeView } from '@utopinn/protocol';

/** 剥离 MVU 状态占位符 —— 存储层保留(卡 shim 定位用),视图层不渲染。 */
const stripStatusPlaceholder = (s: string) =>
    s.includes(MVU_STATUS_PLACEHOLDER) ? s.replaceAll(MVU_STATUS_PLACEHOLDER, '').trimEnd() : s;

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

/** ST wire message → renderer view model. */
export function stToView(m: StChatMessage, id: number): MessageViewModel {
    const active = Number(m.swipe_id ?? 0);
    const swipes: SwipeView[] | undefined = Array.isArray(m.swipes) && m.swipes.length > 1
        ? m.swipes.map((s, i) => ({
            index: i,
            content: stripStatusPlaceholder(typeof s === 'string' ? s : (s.mes ?? '')),
            timestamp: typeof s === 'object' && s.send_date != null ? Number(s.send_date) : undefined,
        }))
        : undefined;
    const base = swipes?.[Math.min(active, swipes.length - 1)];
    return {
        id,
        role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
        name: m.name ?? '',
        content: stripStatusPlaceholder(base?.content ?? m.mes ?? ''),
        timestamp: m.send_date != null ? Number(m.send_date) : undefined,
        swipes,
        activeSwipe: swipes ? Math.min(active, swipes.length - 1) : undefined,
    };
}

/** Load a chat's floors. 404 bubbles up so the caller can show the honest path. */
export async function getChat(charDir: string, chatName: string): Promise<{ header: Record<string, unknown>; messages: MessageViewModel[] }> {
    const d = await apiGet<ChatDetail>(
        `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`,
    );
    return { header: d.header, messages: d.messages.map(stToView) };
}

/**
 * Append one user message to the chat file, then the caller typically fires
 * /api/utopinn/generate. Mirrors the old client's /api/chats/append call.
 */
/** Sidebar list: every character's chats flattened to ChatSummary. */
export async function listAllChats(): Promise<import('../types').ChatSummary[]> {
    const { items: chars } = await apiGet<{ items: { charDir: string; name: string; readable: boolean }[] }>('/api/utopinn/characters');
    const out: import('../types').ChatSummary[] = [];
    for (const c of chars.filter((x) => x.readable !== false)) {
        try {
            const { items: chats } = await apiGet<{ items: { name: string; messageCount: number; updatedAt: string }[] }>(
                `/api/utopinn/characters/${encodeURIComponent(c.charDir)}/chats`,
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

/**
 * Per-character chat rows for the character page (TASK-026) — richer than
 * the sidebar summary: messageCount/lastMessage/updatedAt ride along.
 * Same route the sidebar flattening uses; kept separate so the char page
 * doesn't depend on sidebar list freshness.
 */
export interface CharChatItem {
    name: string;
    fileName?: string;
    messageCount: number;
    byteSize?: number;
    updatedAt?: string | number;
    createdAt?: string | number;
    lastMessage?: { mes?: string; name?: string; is_user?: boolean };
    integrity?: string;
}

export async function listChatsForChar(charDir: string): Promise<{ items: CharChatItem[]; total: number }> {
    return apiGet(`/api/utopinn/characters/${encodeURIComponent(charDir)}/chats`);
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

/**
 * Rename a chat file. Uses the legacy /api/chats/rename route (the utopinn
 * router has no rename yet) — body fields are `original_file`/`renamed_file`
 * WITH the .jsonl suffix; `avatar_url` carries the charDir + .png, matching
 * append/patch above. Resolves to the server's sanitized new base name so the
 * caller can rebuild the ChatSummary id even when sanitize() rewrote input.
 */
export async function renameChat(charDir: string, oldName: string, newName: string): Promise<string> {
    const res = await apiPost<{ ok: boolean; sanitizedFileName?: string }>('/api/chats/rename', {
        avatar_url: `${charDir}.png`,
        original_file: `${oldName}.jsonl`,
        renamed_file: `${newName}.jsonl`,
    });
    return res.sanitizedFileName ?? newName;
}

/** Delete a chat file via the utopinn library route (204; 404 bubbles as ApiError). */
export async function deleteChat(charDir: string, chatName: string): Promise<void> {
    const res = await apiFetch(
        `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`,
        { method: 'DELETE' },
    );
    await assertOk(res);
}
