// 群聊(TASK-062)—— /api/utopinn/groups/* 薄壳 + 群生成。
//
// 服务端契约(apps/server):
//   plugins/utopinn-library.js 群段 —— 群文档 CRUD + 群会话 get/create/
//   append/patch/delete(与单聊同一 JSON-Patch 命名空间 /body/<i>/…)。
//   plugins/utopinn-generate.js —— body.groupId 入群路:服务端纯函数层
//   (services/group-orchestration.js)选员;本文件唯一「编排感知」是透传
//   force-member(body.member)与读回执 —— 前端不挑成员、不组卡。
//
// 生成回执:
//   POST /api/utopinn/generate {groupId,chatId,type,member?}
//     → 200 + x-luker-generation-id(有活干) + x-utopinn-group JSON 头
//       ({groupId,chatId,mode,strategy,member:{avatar,name},queue:avatar[]});
//     → 200 {skipped:'no_activated_member'} = 编排层空激活
//       (legacy MANUAL+用户输入空成员同义)—— 无 job,调用方诚实展示。
//   服务端 persist:normal/regenerate 恒有默认 kind:'group' 写盘目标
//   (成员楼层字段服务端自带);swipe/continue/impersonate/quiet 走
//   persist_target:{kind:'none'} + 客户端 PATCH 写回(单聊同构)。
import { ApiError, apiFetch, apiGet, apiPost, assertOk } from './client';
import { stToView } from './chats';
import type { ChatPatchOp, ChatPatchResult, FloorMsg, GenerateVerb, StChatMessage } from './chats';
import type { ChatSummary } from '../types';

/* ——— 服务端 group-orchestration.js 枚举的 wire 镜像(值对齐,非 import)——— */
export const GROUP_ACTIVATION_STRATEGY = {
    /** 自然顺序:talkativeness 洗牌 + allow_self_responses 过滤。 */
    NATURAL: 0,
    /** 名单顺序:启用成员依 members[] 序挨个说。 */
    LIST: 1,
    /** 手动:用户输入后不自动应答(MANUAL+isUserInput → 空激活短路)。 */
    MANUAL: 2,
    /** 池化:NATURAL 变体,跳过已说成员直到全员说过一轮。 */
    POOLED: 3,
} as const;
export const GROUP_GENERATION_MODE = {
    /** 每成员独立组装(成员卡字段替换主卡位)。 */
    SWAP: 0,
    /** 群卡合并:成员字段 join 进一张合成卡。 */
    APPEND: 1,
    /** 群卡合并 + 停用成员字段也进合成卡。 */
    APPEND_DISABLED: 2,
} as const;

/** 群成员解析项(GET /groups/:gid 的 roster[])。 */
export interface GroupMember {
    /** 成员头像文件名('X.png')—— 服务端 roster 稳定键。 */
    avatar: string;
    /** 卡目录名(avatar 剥扩展名)。 */
    charDir: string;
    /** 卡显示名。 */
    name: string;
    /** disabled_members 命中 → 不参与编排(可点名单独指定发言)。 */
    disabled: boolean;
    /** 卡可载(找不到卡的成员服务端跳过,UI 诚实标灰)。 */
    loadable: boolean;
}

/** 群文档 + 解析位(GET /groups/:gid 回形;list 行的 roster 可能缺席)。 */
export interface GroupDoc {
    id: string;
    name: string;
    /** 成员 avatar 文件名表(roster 的键源)。 */
    members: string[];
    /** 服务端解析成员表(仅 GET/:gid 与 PATCH/:gid 回执带)。 */
    roster?: GroupMember[];
    /** chats[] 在 GET/:gid 被展成元信息对象;create 回执是 id 串数组。 */
    chats: (string | { id: string; messageCount?: number; updatedAt?: string | null; current?: boolean })[];
    /** 当前会话 id(默认 = 群 id)。 */
    chat_id: string;
    activation_strategy: number;
    generation_mode: number;
    disabled_members: string[];
    allow_self_responses: boolean;
    generation_mode_join_prefix?: string;
    generation_mode_join_suffix?: string;
    auto_mode_delay?: number;
    avatar_url?: string;
    fav?: boolean;
    /* listWithChatStats 行级附带 */
    chat_size?: number;
    date_last_chat?: number | string;
}

/** 建群入参(字段名同服务端 create 契约)。 */
export interface GroupCreateBody {
    name: string;
    members: string[];
    activation_strategy?: number;
    generation_mode?: number;
    allow_self_responses?: boolean;
    generation_mode_join_prefix?: string;
    generation_mode_join_suffix?: string;
}

/** 群编辑入参(服务端白名单浅合并;数组键整体替换)。 */
export type GroupPatchBody = Partial<Pick<GroupDoc,
    'name' | 'members' | 'activation_strategy' | 'generation_mode' | 'disabled_members'
    | 'allow_self_responses' | 'generation_mode_join_prefix' | 'generation_mode_join_suffix'
    | 'auto_mode_delay' | 'chat_id' | 'chats' | 'avatar_url' | 'fav'
>>;

const groupsUrl = '/api/utopinn/groups';
const groupUrl = (gid: string) => `${groupsUrl}/${encodeURIComponent(gid)}`;
const groupChatUrl = (gid: string, chatId: string) => `${groupUrl(gid)}/chats/${encodeURIComponent(chatId)}`;

/* ——— 群文档 CRUD ——— */

/** 群列表(listWithChatStats;无群 → [])。 */
export async function listGroups(): Promise<GroupDoc[]> {
    const d = await apiGet<{ items?: GroupDoc[] }>(groupsUrl);
    return d.items ?? [];
}

/** 群详情(含 roster 解析与 chats 元信息);404 抛 ApiError。 */
export async function getGroup(groupId: string): Promise<GroupDoc> {
    return apiGet<GroupDoc>(groupUrl(groupId));
}

/** 建群 → 201 群文档(无 roster;用 getGroup 取解析表)。 */
export async function createGroup(body: GroupCreateBody): Promise<GroupDoc> {
    return apiPost<GroupDoc>(groupsUrl, body);
}

/** 群编辑 → 合并后文档(带 roster)。 */
export async function patchGroup(groupId: string, patch: GroupPatchBody): Promise<GroupDoc> {
    const res = await apiFetch(groupUrl(groupId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    await assertOk(res);
    return (await res.json()) as GroupDoc;
}

/** 删群(级联群聊天文件)。 */
export async function deleteGroup(groupId: string): Promise<void> {
    const res = await apiFetch(groupUrl(groupId), { method: 'DELETE' });
    await assertOk(res);
}

/* ——— 群会话读写(与单聊同一 FloorMsg/写面契约) ——— */

/** 群会话楼层读取:首开空聊服务端播种成员问候;corrupted → ApiError。 */
export async function getGroupChat(
    groupId: string,
    chatId: string,
): Promise<{ header: Record<string, unknown>; messages: FloorMsg[]; raw: StChatMessage[] }> {
    const d = await apiGet<{ name?: string; header?: Record<string, unknown>; messages?: StChatMessage[]; corrupted?: boolean }>(groupChatUrl(groupId, chatId));
    if (d.corrupted) throw new ApiError('corrupted_chat');
    const raw = d.messages ?? [];
    return { header: d.header ?? {}, messages: raw.map(stToView), raw };
}

/** 建群会话(成员问候播种 + 群文档 chats/chat_id 绑定)。 */
export async function createGroupChat(groupId: string, chatId: string): Promise<{ name: string; integrity?: string }> {
    return apiPost(groupChatUrl(groupId, chatId), {});
}

/** 删群会话(文件 + 群文档 chats[] 解绑)。 */
export async function deleteGroupChat(groupId: string, chatId: string): Promise<void> {
    const res = await apiFetch(groupChatUrl(groupId, chatId), { method: 'DELETE' });
    await assertOk(res);
}

/** 群会话追加楼层(「缺失即建」+ ack/gen-id 去重,与 legacy group/append 逐义)。 */
export async function appendGroupChatMessages(
    groupId: string,
    chatId: string,
    body: { message?: Record<string, unknown>; messages?: Record<string, unknown>[]; integrity?: string; lukerGenerationId?: string; chatMetadata?: Record<string, unknown> },
): Promise<{ appended: number; created?: boolean; integrity?: string }> {
    return apiPost(`${groupChatUrl(groupId, chatId)}/messages`, {
        ...(body.message ? { message: body.message } : {}),
        ...(body.messages ? { messages: body.messages } : {}),
        ...(body.integrity ? { integrity: body.integrity } : {}),
        ...(body.lukerGenerationId ? { luker_generation_id: body.lukerGenerationId } : {}),
        ...(body.chatMetadata ? { chat_metadata: body.chatMetadata } : {}),
    });
}

/** 群会话 JSON-Patch(命名空间 /body/<i>/…|/header/…,integrity 冲突 → 409)。 */
export async function patchGroupChat(
    groupId: string,
    chatId: string,
    ops: ChatPatchOp[],
    opts?: { integrity?: string; lukerGenerationId?: string; chatMetadata?: Record<string, unknown> },
): Promise<ChatPatchResult> {
    const res = await apiFetch(groupChatUrl(groupId, chatId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            ops,
            ...(opts?.integrity ? { integrity: opts.integrity } : {}),
            ...(opts?.lukerGenerationId ? { luker_generation_id: opts.lukerGenerationId } : {}),
            ...(opts?.chatMetadata ? { chat_metadata: opts.chatMetadata } : {}),
        }),
    });
    await assertOk(res);
    return (await res.json()) as ChatPatchResult;
}

/** 群会话 swipe 切版(等价 patchSwipe 群分支)。 */
export async function patchGroupSwipe(groupId: string, chatId: string, index: number, swipeId: number): Promise<void> {
    await patchGroupChat(groupId, chatId, [{ op: 'replace', path: `/body/${index}/swipe_id`, value: swipeId }]);
}

/** 用户楼追加(生成前必落 —— deriveActivationInput 靠它判 isUserInput)。 */
export async function appendGroupUserMessage(groupId: string, chatId: string, name: string, text: string): Promise<void> {
    await appendGroupChatMessages(groupId, chatId, {
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
 * 群成员楼消息体(服务端 group persist_target 楼层字段同构:
 * name/original_avatar/force_avatar;swipes 组与单聊 mkAssistantFloor 同形)。
 * `member` 取 x-utopinn-group 回执里的发言者。
 */
export function mkGroupAssistantFloor(
    member: { avatar: string; name: string },
    text: string,
    opts?: { jobId?: string; aborted?: boolean },
): Record<string, unknown> {
    const send_date = new Date().toISOString();
    return {
        name: member.name,
        is_user: false,
        is_system: false,
        mes: text,
        send_date,
        swipes: [text],
        swipe_id: 0,
        swipe_info: [{ send_date, gen_started: null, gen_finished: null, extra: {} }],
        original_avatar: member.avatar,
        force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(member.avatar)}`,
        extra: {
            ...(opts?.jobId ? { luker_generation_id: opts.jobId } : {}),
            ...(opts?.aborted ? { aborted: true } : {}),
        },
    };
}

/* ——— 群生成(x-utopinn-group 回执 + jobId) ——— */

/** x-utopinn-group 响应头解析形 —— 本次发言者 + 完整激活队列(avatar[])。 */
export interface GroupGenerateReport {
    groupId: string;
    chatId: string;
    mode: number;
    strategy: number;
    member: { avatar: string; name: string } | null;
    /** 本拍激活队列(avatar[]);queue[0] = 刚发言者,尾部 = 待链成员。 */
    queue: string[];
}

export interface GroupGenerateResult {
    /** 派发 jobId(x-luker-generation-id);skipped 时空。 */
    jobId: string | null;
    /** 服务端空激活短路(legacy「只落用户楼」同义)—— 诚实态判据。 */
    skipped: boolean;
    /** 发言报告(成员名/头像 + 激活队列);skipped 时也回(queue 空)。 */
    group: GroupGenerateReport | null;
}

/**
 * POST /api/utopinn/generate 群路。`opts.member` = 指定发言(avatar/目录/
 * 显示名服务端都认 → roster avatar);`opts.clientWriteBack` 为真时挂
 * persist_target:{kind:'none'}(swipe/continue/impersonate/quiet —— 楼层
 * 落盘由调用方 PATCH,与单聊 writeBackGeneration 同构)。
 */
export async function postGroupGenerate(body: {
    groupId: string;
    chatId: string;
    type?: GenerateVerb | string;
    member?: string;
    presetName?: string;
    user?: { name: string; description?: string };
    /** 客户端写回动词(kind:'none' 挂 persist_target)。 */
    clientWriteBack?: boolean;
}): Promise<GroupGenerateResult> {
    const res = await apiFetch('/api/utopinn/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            groupId: body.groupId,
            chatId: body.chatId,
            type: body.type ?? 'normal',
            ...(body.member ? { member: body.member } : {}),
            ...(body.presetName ? { presetName: body.presetName } : {}),
            ...(body.user ? { user: body.user } : {}),
            ...(body.clientWriteBack ? { luker_generation: { persist_target: { kind: 'none' } } } : {}),
            stream: true,
        }),
    });
    if (!res.ok) {
        const unreachable = res.status === 502 && res.headers.has('x-utopinn-proxy-error');
        const text = await res.text().catch(() => '');
        throw new ApiError(unreachable ? 'upstream_unavailable' : (text || res.statusText), res.status);
    }
    let group: GroupGenerateReport | null = null;
    const groupHeader = res.headers.get('x-utopinn-group');
    if (groupHeader) {
        /* 服务端 encodeURIComponent 过(成员名可含 CJK,裸 JSON 进头会
           ERR_INVALID_CHAR)——先 decode 再 parse;旧服务端直出 JSON 时也兼容
           (decodeURIComponent 对纯 ASCII JSON 幂等,% 序列不合法才落原串)。 */
        try {
            group = JSON.parse(decodeURIComponent(groupHeader)) as GroupGenerateReport;
        } catch {
            try { group = JSON.parse(groupHeader) as GroupGenerateReport; } catch { /* 头不可解析 → null */ }
        }
    }
    const jobId = res.headers.get('x-luker-generation-id');
    if (!jobId) {
        /* skipped/no-job 回执:正文 {skipped:'no_activated_member', group:{…}};
           其余无 jobId 的 200 形也照实透传 skipped:false(group 头兜底)。 */
        const text = await res.text().catch(() => '');
        let skipped = false;
        try {
            const j = JSON.parse(text) as { skipped?: string; group?: { groupId?: string; chatId?: string; queue?: string[] } };
            skipped = j?.skipped === 'no_activated_member';
            if (!group && j?.group) {
                group = { groupId: String(j.group.groupId ?? ''), chatId: String(j.group.chatId ?? ''), mode: -1, strategy: -1, member: null, queue: Array.isArray(j.group.queue) ? j.group.queue.map(String) : [] };
            }
        } catch { /* 非 JSON 回执 */ }
        return { jobId: null, skipped, group };
    }
    return { jobId, skipped: false, group };
}

/* ——— 侧栏会话行:群 → ChatSummary[](每 chat_id 一行,groupId 标志位) ——— */

/** 群会话 → 侧栏行(charDir='' + groupId —— 单聊键面不混)。 */
export async function listGroupChatSummaries(): Promise<ChatSummary[]> {
    const groups = await listGroups();
    const out: ChatSummary[] = [];
    for (const g of groups) {
        /* listWithChatStats 的 chats[] 可能是 id 串,也可能是 {id,…} 元信息对象
           —— 两种形都收,兜底 chat_id。 */
        const ids = Array.isArray(g.chats) && g.chats.length
            ? g.chats.map((c) => (typeof c === 'string' ? c : String(c.id)))
            : [String(g.chat_id ?? g.id)];
        for (const cid of ids) {
            /* 群聊文件多为 Date.now 时间戳串(与 ST 同惯)—— 行题转成
               可读的短日期;非时间戳名原样。 */
            const ts = /^\d{10,}$/.test(cid) ? new Date(Number(cid)) : null;
            const title = ts && Number.isFinite(ts.getTime())
                ? `${ts.getMonth() + 1}/${ts.getDate()} ${ts.toTimeString().slice(0, 5)}`
                : String(cid);
            out.push({
                id: `group/${g.id}/${cid}`,
                title,
                charDir: '',
                chatName: String(cid),
                group: g.name ?? String(g.id),
                groupId: String(g.id),
                updatedAt: typeof g.date_last_chat === 'string' ? g.date_last_chat : undefined,
            });
        }
    }
    return out;
}
