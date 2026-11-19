// Typed /api/utopinn/* surface on top of @utopinn/api-client's UtopinnClient.
// The package's request() handles JSON + errors (ApiError); transport
// security (session cookie + CSRF + 403 rotation) lives in session.ts and
// is injected as the fetch impl — the package doesn't ship the utopinn
// endpoints yet, so they are declared here against the server contract
// (apps/server/src/plugins/utopinn-library.js, utopinn-generate.js).
import { UtopinnClient } from '@utopinn/api-client';
import { MVU_STATUS_PLACEHOLDER } from '@utopinn/protocol';
import type { MessageViewModel, SwipeView } from '@utopinn/protocol';
import { session } from './session';

let cached: UtopinnClient | null = null;
let cachedBase = '';

/** Session-bound client; rebuilt when baseUrl changes. */
export function client(): UtopinnClient {
    if (!cached || cachedBase !== session.baseUrl) {
        cached = new UtopinnClient({ baseUrl: session.baseUrl, fetch: session.fetchBound });
        cachedBase = session.baseUrl;
    }
    return cached;
}

const enc = encodeURIComponent;

/** Hermes has no Intl/`localeCompare` — plain `</>` compare (number 或 ISO 串都序正确)。 */
const cmpStr = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------- wire shapes (server: plugins/utopinn-library.js) ----------

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
    /** 预览文本 —— wire 上是最后一条楼层对象,listChats 已提取 .mes。 */
    lastMessage?: string;
    /** epoch ms(服务端 info.updatedAt 是 number;老路径可能是 ISO 串)。 */
    updatedAt?: string | number;
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
    updatedAt?: string | number;
    avatar: string | null;
}

// ---------- endpoints ----------

export async function listCharacters(): Promise<CharacterItem[]> {
    const d = await client().request<{ items: CharacterItem[]; total: number }>('/api/utopinn/characters');
    return d.items ?? [];
}

export async function listChats(charDir: string): Promise<ChatItem[]> {
    const d = await client().request<{ items: ChatItemWire[]; total: number }>(
        `/api/utopinn/characters/${enc(charDir)}/chats`,
    );
    // wire lastMessage 是整条楼层对象 —— 这里归一成 mes 文本,UI 统一当 string 用。
    return (d.items ?? []).map((it) => ({ ...it, lastMessage: mesPreview(it.lastMessage) }));
}

type ChatItemWire = Omit<ChatItem, 'lastMessage'> & {
    lastMessage?: string | { mes?: string } | null;
};

function mesPreview(v: ChatItemWire['lastMessage']): string | undefined {
    if (v == null) return undefined;
    if (typeof v === 'string') return v;
    return typeof v.mes === 'string' ? v.mes : undefined;
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
    // ISO 时间戳字典序即时间序;localeCompare 在 Hermes 里未实现(Intl 缺失)。
    out.sort((a, b) => cmpStr(b.updatedAt ?? '', a.updatedAt ?? ''));
    return out;
}

export async function getChat(charDir: string, chatName: string): Promise<ChatDetail> {
    return client().request<ChatDetail>(
        `/api/utopinn/characters/${enc(charDir)}/chats/${enc(chatName)}`,
    );
}

/** PUT creates an empty chat (409 if it already exists). */
export async function createChat(charDir: string, chatName: string): Promise<void> {
    await client().request(`/api/utopinn/characters/${enc(charDir)}/chats/${enc(chatName)}`, {
        method: 'PUT',
        body: {},
    });
}

export async function appendMessages(
    charDir: string,
    chatName: string,
    messages: { name: string; is_user: boolean; mes: string; send_date: number; extra?: Record<string, unknown> }[],
): Promise<void> {
    await client().request(`/api/utopinn/characters/${enc(charDir)}/chats/${enc(chatName)}/messages`, {
        method: 'POST',
        body: { messages },
    });
}

/** Card image URL — same static path the web app uses (`/characters/<file>`). */
export function avatarUrl(avatar: string | null | undefined): string | null {
    return avatar ? session.url(`/characters/${enc(avatar)}`) : null;
}

/** Display fields lifted out of a CCv1/v2 card document. */
export interface CardInfo {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    creatorNotes: string;
    tags: string[];
    firstMes: string;
}

export async function getCharacter(charDir: string): Promise<CardInfo | null> {
    const card = await client().request<Record<string, unknown>>(
        `/api/utopinn/characters/${enc(charDir)}`,
    ).catch(() => null);
    if (!card) return null;
    const data = (card.data && typeof card.data === 'object' && !Array.isArray(card.data)
        ? card.data : card) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
        name: s(data.name) || charDir,
        description: s(data.description),
        personality: s(data.personality),
        scenario: s(data.scenario),
        creatorNotes: s(data.creator_notes),
        tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [],
        firstMes: s(data.first_mes),
    };
}

// ---------- writes (utopinn PATCH / rename / delete / append — TASK-023 surface) ----------

export interface JsonPatchOp {
    op: 'add' | 'remove' | 'replace' | 'test';
    path: string;
    value?: unknown;
}

/**
 * RFC6902-lite ops on the {header, body} chat doc — e.g.
 * swipe switch: {op:'replace', path:'/body/<i>/swipe_id', value:n}.
 * Server: PATCH /api/utopinn/characters/:charDir/chats/:chatName.
 */
export async function patchChatOps(charDir: string, chatName: string, ops: JsonPatchOp[]): Promise<void> {
    await client().request(`/api/utopinn/characters/${enc(charDir)}/chats/${enc(chatName)}`, {
        method: 'PATCH',
        body: { ops },
    });
}

export async function deleteChat(charDir: string, chatName: string): Promise<void> {
    await client().request(`/api/utopinn/characters/${enc(charDir)}/chats/${enc(chatName)}`, {
        method: 'DELETE',
    });
}

export async function renameChat(charDir: string, chatName: string, newName: string): Promise<void> {
    await client().request(
        `/api/utopinn/characters/${enc(charDir)}/chats/${enc(chatName)}/rename`,
        { method: 'POST', body: { newName } },
    );
}

/**
 * 分叉:copy floors [0..uptoIndex] of `chatName` into a fresh chat named
 * `newName` (PUT create + POST append — raw ST wire rows ride along,
 * swipes included). Returns the new chat name for navigation.
 */
export async function branchChat(
    charDir: string,
    chatName: string,
    uptoIndex: number,
    newName: string,
): Promise<string> {
    const detail = await getChat(charDir, chatName);
    const slice = (detail.messages ?? []).slice(0, Math.max(0, uptoIndex + 1));
    await createChat(charDir, newName);
    if (slice.length) {
        await client().request(
            `/api/utopinn/characters/${enc(charDir)}/chats/${enc(newName)}/messages`,
            { method: 'POST', body: { messages: slice } },
        );
    }
    return newName;
}

// ---------- ST wire → view model (same mapping as apps/web/src/api/chats.ts) ----------

/** 剥离 MVU 状态占位符 —— 存储层保留(卡 shim 定位用),视图层不渲染。 */
const stripStatusPlaceholder = (s: string): string =>
    s.includes(MVU_STATUS_PLACEHOLDER) ? s.replaceAll(MVU_STATUS_PLACEHOLDER, '').trimEnd() : s;

/** send_date can be epoch ms OR an ISO string (server persist writes ISO). */
function toMs(v: number | string | undefined): number | undefined {
    if (v == null) return undefined;
    const n = typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isNaN(n) ? undefined : n;
}

export function stToView(m: StChatMessage, id: number): MessageViewModel {
    const active = Number(m.swipe_id ?? 0);
    const swipes: SwipeView[] | undefined = Array.isArray(m.swipes) && m.swipes.length > 1
        ? m.swipes.map((s, i) => ({
            index: i,
            content: stripStatusPlaceholder(typeof s === 'string' ? s : (s.mes ?? '')),
            timestamp: typeof s === 'object' ? toMs(s.send_date) : undefined,
        }))
        : undefined;
    const base = swipes?.[Math.min(active, swipes.length - 1)];
    return {
        id,
        role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
        name: m.name ?? '',
        content: stripStatusPlaceholder(base?.content ?? m.mes ?? ''),
        timestamp: toMs(m.send_date),
        swipes,
        activeSwipe: swipes ? Math.min(active, swipes.length - 1) : undefined,
    };
}
