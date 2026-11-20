// Library chats via /api/utopinn (TASK-018)。写面同样走 utopinn 孪生:
//   POST /characters/:dir/chats/:name/messages  楼层追加(legacy /append 逐义;
//                       message.extra.luker_generation_id → job ack + 侧车去重)
//   PATCH /characters/:dir/chats/:name          JSON-Patch,doc 形 {header,body}
//                       —— swipe_id/mes/swipes/删楼/截断全部经它。
// ST wire message shape: {name, is_user, is_system, mes, send_date, swipe_id,
// swipes:[...], swipe_info:[...], variables, extra} — mapped here into the
// renderer contract (FloorMsg ⊃ MessageViewModel) so renderers never see
// storage fields.
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
    /** 与 swipes 平行的生成簿记({send_date,gen_started,gen_finished,extra})。 */
    swipe_info?: Record<string, unknown>[];
    /** MVU 楼层快照:{[swipe_id]: stat_data 投影} —— 存在即可回滚。 */
    variables?: Record<string, unknown>;
    extra?: Record<string, unknown>;
}

/** 楼层的舞台态扩展 —— MessageViewModel 之外的 host 私有位。 */
export interface FloorError {
    code: string;
    message: string;
    jobId?: string;
    /** 重试语义:'send' 重发用户楼+续写,动词原样重放生成。 */
    retry?: { type: GenerateVerb | 'send'; text?: string };
}

export interface FloorMsg extends MessageViewModel {
    /** 生成失败楼层(红卡:重试 / 查看 Trace)。 */
    error?: FloorError;
    /** 生成被用户中止,留下半截正文(spec aborted floor)。 */
    aborted?: boolean;
    /** 该楼带 MVU 快照 → 操作条给「回滚」。 */
    snapshot?: boolean;
}

/** /api/utopinn/generate 的 type 动词表(GENERATION_TYPE_TRIGGERS)。 */
export type GenerateVerb = 'normal' | 'regenerate' | 'swipe' | 'continue' | 'impersonate' | 'quiet';

/** postGenerate body:PreviewRequestBody + luker_generation 控制袋(可选)。 */
export interface GenerateBody {
    charDir: string;
    chatName: string;
    presetName?: string;
    type?: GenerateVerb | string;
    user?: { name: string; description?: string };
    overrides?: Record<string, unknown>;
    /** 缺省服务端填本卡 {kind:'character'};客户端持有写盘的动词走默认目标
     *  + hitsLast PATCH ack(见 CenterStage writeBackGeneration)。 */
    luker_generation?: { persist_target?: { kind: 'none' | 'character' | 'group'; [k: string]: unknown } };
}

/** utopinn PATCH chats 的 op(命名空间限 /body/<i>/… 与 /header/…)。 */
export interface ChatPatchOp {
    op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
    path: string;
    value?: unknown;
}

export interface ChatPatchResult {
    ok?: boolean;
    applied?: number;
    total_messages?: number | null;
    integrity?: string | null;
}

interface ChatDetail {
    name: string;
    header: Record<string, unknown>;
    messages: StChatMessage[];
}

/** send_date 兼容:数字戳 / 'YYYY-MM-DD HH:mm' / ISO,解析不出 → undefined。 */
const parseSendDate = (v: number | string | undefined): number | undefined => {
    if (v == null) return undefined;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    const n = Date.parse(v.includes(' ') ? v.replace(' ', 'T') : v);
    return Number.isFinite(n) ? n : undefined;
};

/** ST wire message → renderer view model(附舞台私有位:error/aborted/snapshot)。 */
export function stToView(m: StChatMessage, id: number): FloorMsg {
    const active = Number(m.swipe_id ?? 0);
    const swipes: SwipeView[] | undefined = Array.isArray(m.swipes) && m.swipes.length > 1
        ? m.swipes.map((s, i) => ({
            index: i,
            content: stripStatusPlaceholder(typeof s === 'string' ? s : (s.mes ?? '')),
            timestamp: typeof s === 'object' ? parseSendDate(s.send_date) : undefined,
        }))
        : undefined;
    const base = swipes?.[Math.min(active, swipes.length - 1)];
    return {
        id,
        role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
        name: m.name ?? '',
        content: stripStatusPlaceholder(base?.content ?? m.mes ?? ''),
        timestamp: parseSendDate(m.send_date),
        swipes,
        activeSwipe: swipes ? Math.min(active, swipes.length - 1) : undefined,
        aborted: m.extra?.aborted === true || undefined,
        snapshot: m.variables != null && typeof m.variables === 'object' && Object.keys(m.variables).length > 0 || undefined,
    };
}

/**
 * Load a chat's floors. 404 bubbles up so the caller can show the honest path.
 * `raw` 是未映射的 wire 楼层 —— 写回路径需要原始 swipes/swipe_info 形状。
 */
export async function getChat(charDir: string, chatName: string): Promise<{ header: Record<string, unknown>; messages: FloorMsg[]; raw: StChatMessage[] }> {
    const d = await apiGet<ChatDetail>(
        `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`,
    );
    return { header: d.header, messages: d.messages.map(stToView), raw: d.messages };
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

const chatMessagesUrl = (charDir: string, chatName: string) =>
    `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}/messages`;

/** Create a chat file(server saves header + the seed system message;
 *  utopinn messages 路由「缺失即建」+ autoInit settle)。 */
export async function createChat(charDir: string, chatName: string): Promise<void> {
    await apiPost(chatMessagesUrl(charDir, chatName), {
        chat_metadata: {},
        message: { name: '', is_user: false, is_system: true, mes: '', send_date: new Date().toISOString(), extra: {} },
    });
}

/**
 * PATCH /api/utopinn/characters/:dir/chats/:name —— 通用楼层写面
 * (utopinn-library.js L984;doc 命名空间 /body/<i>/… 与 /header/…,
 * 裸 /<N> 顶层路径服务端拒 400)。写后服务端自动跑 MVU resettle
 * + 命中末楼的 patch 顺带 ack 在途 awaiting_ack job(persistTarget 匹配)。
 * `lukerGenerationId` → 侧车 gen-id 去重记账。
 */
export async function patchChat(
    charDir: string,
    chatName: string,
    ops: ChatPatchOp[],
    opts?: { integrity?: string; lukerGenerationId?: string; chatMetadata?: Record<string, unknown> },
): Promise<ChatPatchResult> {
    const res = await apiFetch(
        `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`,
        {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                ops,
                ...(opts?.integrity ? { integrity: opts.integrity } : {}),
                ...(opts?.lukerGenerationId ? { luker_generation_id: opts.lukerGenerationId } : {}),
                ...(opts?.chatMetadata ? { chat_metadata: opts.chatMetadata } : {}),
            }),
        },
    );
    await assertOk(res);
    return (await res.json()) as ChatPatchResult;
}

/** Persist the active swipe of floor `index` — utopinn PATCH `/body/<i>/swipe_id`。 */
export async function patchSwipe(charDir: string, chatName: string, index: number, swipeId: number): Promise<void> {
    await patchChat(charDir, chatName, [{ op: 'replace', path: `/body/${index}/swipe_id`, value: swipeId }]);
}

export async function appendUserMessage(charDir: string, chatName: string, name: string, text: string): Promise<void> {
    await apiPost(chatMessagesUrl(charDir, chatName), {
        message: {
            name,
            is_user: true,
            is_system: false,
            mes: text,
            send_date: new Date().toISOString(),
            extra: {},
        },
    });
}

/**
 * 新助手楼消息体(normal/regenerate 写回同构:楼一落地即带 swipes[0],
 * 与 legacy saveReply 占位初始化同形)。
 * `jobId` 进 extra.luker_generation_id —— 入库前服务端剥除,
 * 同时 ack 掉 awaiting_ack job(防 15s 兜底二次 persist);
 * `aborted` 留痕 extra.aborted → stToView 重放「已中止」楼层态。
 */
export function mkAssistantFloor(name: string, text: string, opts?: { jobId?: string; aborted?: boolean }) {
    const send_date = new Date().toISOString();
    return {
        name,
        is_user: false,
        is_system: false,
        mes: text,
        send_date,
        swipes: [text],
        swipe_id: 0,
        swipe_info: [{ send_date, gen_started: null, gen_finished: null, extra: {} }],
        extra: {
            ...(opts?.jobId ? { luker_generation_id: opts.jobId } : {}),
            ...(opts?.aborted ? { aborted: true } : {}),
        },
    };
}

/** 追加助手楼(normal 写回;中止楼也可落 partial 文本)。 */
export async function appendAssistantMessage(
    charDir: string,
    chatName: string,
    name: string,
    text: string,
    opts?: { jobId?: string; aborted?: boolean },
): Promise<void> {
    await apiPost(chatMessagesUrl(charDir, chatName), {
        ...(opts?.jobId ? { luker_generation_id: opts.jobId } : {}),
        message: mkAssistantFloor(name, text, opts),
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

/**
 * POST /api/utopinn/chats/recent —— 最近会话(utopinn-library.js L1151,
 * 与 legacy POST /api/chats/recent 同一索引与排序源)。
 * body:{pinned?:[{file_name,avatar?,group?}], max?} → 数组回包:
 * pinned 命中(file_name + avatar|group 同字段判定)置顶 → sort_time desc。
 * home「继续你的故事」与侧栏置顶序的数据源 —— 不用 listAllChats 全量扫。
 */
export interface RecentChatItem {
    file_name: string;
    avatar?: string;
    group?: string;
    sort_time?: number;
    [k: string]: unknown;
}

export async function listRecentChats(opts?: {
    pinned?: Pick<RecentChatItem, 'file_name' | 'avatar' | 'group'>[];
    max?: number;
}): Promise<RecentChatItem[]> {
    return apiPost('/api/utopinn/chats/recent', {
        pinned: opts?.pinned ?? [],
        ...(opts?.max !== undefined ? { max: opts.max } : {}),
    });
}
