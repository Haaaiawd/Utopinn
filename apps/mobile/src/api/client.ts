// Typed /api/uberge/* surface on top of @uberge/api-client's UbergeClient.
// The package's request() handles JSON + errors (ApiError); transport
// security (session cookie + CSRF + 403 rotation) lives in session.ts and
// is injected as the fetch impl — the package doesn't ship the uberge
// endpoints yet, so they are declared here against the server contract
// (apps/server/src/plugins/uberge-library.js, uberge-generate.js).
import { UbergeClient } from '@uberge/api-client';
import type { MessageViewModel, SwipeView } from '@uberge/protocol';
import { session } from './session';

let cached: UbergeClient | null = null;
let cachedBase = '';

/** Session-bound client; rebuilt when baseUrl changes. */
export function client(): UbergeClient {
    if (!cached || cachedBase !== session.baseUrl) {
        cached = new UbergeClient({ baseUrl: session.baseUrl, fetch: session.fetchBound });
        cachedBase = session.baseUrl;
    }
    return cached;
}

const enc = encodeURIComponent;

// ---------- wire shapes (server: plugins/uberge-library.js) ----------

export interface CharacterItem {
    charDir: string;
    name: string;
    avatar: string | null;
    fileName?: string;
    fileSize?: number;
    tags?: string[];
    readable?: boolean;
}

export interface ChatItem {
    name: string;
    fileName?: string;
    messageCount?: number;
    byteSize?: number;
    lastMessage?: string;
    updatedAt?: string;
}

/** ST wire floor (JSONL row). */
export interface StChatMessage {
    name?: string;
    is_user?: boolean;
    is_system?: boolean;
    mes?: string;
    send_date?: number | string;
    swipe_id?: number;
    swipes?: (string | { mes?: string; send_date?: number | string })[];
    extra?: Record<string, unknown>;
}

export interface ChatDetail {
    name: string;
    header: Record<string, unknown>;
    messages: StChatMessage[];
}

/** Flattened entry for the 对话 tab. */
export interface ChatSummary {
    id: string;
    charDir: string;
    charName: string;
    chatName: string;
    messageCount: number;
    lastMessage?: string;
    updatedAt?: string;
    avatar: string | null;
}

// ---------- endpoints ----------

export async function listCharacters(): Promise<CharacterItem[]> {
    const d = await client().request<{ items: CharacterItem[]; total: number }>('/api/uberge/characters');
    return d.items ?? [];
}

export async function listChats(charDir: string): Promise<ChatItem[]> {
    const d = await client().request<{ items: ChatItem[]; total: number }>(
        `/api/uberge/characters/${enc(charDir)}/chats`,
    );
    return d.items ?? [];
}

/** All chats across all characters (对话 tab). Per-char failure is skipped. */
export async function listAllChats(): Promise<ChatSummary[]> {
    const chars = await listCharacters();
    const out: ChatSummary[] = [];
    await Promise.all(
        chars
            .filter((c) => c.readable !== false)
            .map(async (c) => {
                try {
                    const chats = await listChats(c.charDir);
                    for (const ch of chats) {
                        out.push({
                            id: `${c.charDir}/${ch.name}`,
                            charDir: c.charDir,
                            charName: c.name,
                            chatName: ch.name,
                            messageCount: ch.messageCount ?? 0,
                            lastMessage: ch.lastMessage,
                            updatedAt: ch.updatedAt,
                            avatar: c.avatar,
                        });
                    }
                } catch {
                    /* one char's chat list failing doesn't kill the tab */
                }
            }),
    );
    out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return out;
}

export async function getChat(charDir: string, chatName: string): Promise<ChatDetail> {
    return client().request<ChatDetail>(
        `/api/uberge/characters/${enc(charDir)}/chats/${enc(chatName)}`,
    );
}

/** PUT creates an empty chat (409 if it already exists). */
export async function createChat(charDir: string, chatName: string): Promise<void> {
    await client().request(`/api/uberge/characters/${enc(charDir)}/chats/${enc(chatName)}`, {
        method: 'PUT',
        body: {},
    });
}

export async function appendMessages(
    charDir: string,
    chatName: string,
    messages: { name: string; is_user: boolean; mes: string; send_date: number; extra?: Record<string, unknown> }[],
): Promise<void> {
    await client().request(`/api/uberge/characters/${enc(charDir)}/chats/${enc(chatName)}/messages`, {
        method: 'POST',
        body: { messages },
    });
}

/** Card image URL — same static path the web app uses (`/characters/<file>`). */
export function avatarUrl(avatar: string | null | undefined): string | null {
    return avatar ? session.url(`/characters/${enc(avatar)}`) : null;
}

// ---------- ST wire → view model (same mapping as apps/web/src/api/chats.ts) ----------

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
