/**
 * MVU settle seam —— 消息持久化后的串行结算步骤(TASK-013)。
 *
 * 契约(plugin-architecture §3b/§3d):
 *   chat.messagePersisted(serial) → 本文件 settle:
 *   ChatRepo.get → settleMvuMessage(pure core fold) →
 *   messages[i].variables[swipe_id] 快照写回 + chat_metadata.variables 镜像 +
 *   chat_state sidecar('mvu' namespace)收 op 日志/回执。
 *
 * stat_data 是整份聊天日志 fold 的投影,不是"最近一条解析结果":
 * 每个楼层存自身 swipe 槽位的 MvuData 快照,下一层以最近快照为基底续折;
 * 楼层被删改时用 resettleChatMvu 全量重放(投影语义,幂等)。
 *
 * is_hidden 不动:隐藏层照常参与 fold(与 upstream SillyTavern.chat 口径一致),
 * 本文件只改写 mes 与 variables 两个字段。
 *
 * 调用位:luker-generation persistGeneratedReply 在 appendMessagesToChatFile
 * 之后串行 await;将来事件总线落地时本函数就是 settle waterfall 的注册项。
 * 写回失败(integrity 竞争)自动重载重折,最多 MAX_SAVE_ATTEMPTS 次。
 */
import sanitize from 'sanitize-filename';
import path from 'node:path';
import { settleMvuMessage, isMvuData } from '@uberge/core';
import { getChatRepo } from '../storage/index.js';
import { ConflictError } from '../storage/errors.js';

/** chat_state sidecar 命名空间:回执 + op 日志("mes_var_ops" 等价物)。 */
export const MVU_STATE_NAMESPACE = 'mvu';
/** 侧车 op 日志上限(诊断页读全量;超出丢最旧)。 */
const MAX_OP_LOG_ENTRIES = 200;
/** integrity 竞争重试上限:投影幂等,重载重折安全。 */
const MAX_SAVE_ATTEMPTS = 3;

/** {avatar_url, file_name} → {charDir, name}(与 chats.js 路由键口径一致)。 */
export function resolveMvuChatTarget(target) {
    if (!target || typeof target !== 'object') return null;
    if (target.is_group) {
        const groupId = sanitize(String(target.id ?? target.group_id ?? '').trim());
        if (!groupId) return null;
        return { isGroup: true, groupId, name: groupId, charDir: '' };
    }
    const charDir = sanitize(String(target.avatar_url ?? target.char_dir ?? '').replace('.png', '').trim());
    if (!charDir) return null;
    let fileName = String(target.file_name ?? target.chat_name ?? '').trim();
    if (!fileName) return null;
    if (!path.extname(fileName)) fileName = `${fileName}.jsonl`;
    fileName = sanitize(path.basename(fileName));
    const name = fileName.replace(/\.jsonl$/i, '');
    if (!name) return null;
    return { isGroup: false, name, charDir };
}

/**
 * settle 结果 → 楼层对象写回(仅 mes + variables[swipeId],其余字段原样)。
 * @returns 新 body 数组(不原地改)。
 */
function applySettleToBody(body, messageIndex, result) {
    const target = { ...(body[messageIndex] ?? {}) };
    target.mes = result.message;
    const variables = (target.variables && typeof target.variables === 'object' && !Array.isArray(target.variables))
        ? { ...target.variables }
        : {};
    variables[String(result.swipeId)] = result.variables;
    target.variables = variables;
    const next = body.slice();
    next[messageIndex] = target;
    return next;
}

/**
 * 楼层快照 → chat_metadata.variables 镜像补丁。
 * upstream updateVariablesWith(updater,{type:'chat'}):stat_data/schema/
 * display_data/delta_data/initialized_lorebooks 顶层并入聊天变量字典,
 * 供 {{getvar::stat_data.*}} / TH 读取;其余键原样保留。
 */
function mergeChatVariablesPatch(chatMetadata, patch) {
    const metadata = (chatMetadata && typeof chatMetadata === 'object' && !Array.isArray(chatMetadata))
        ? { ...chatMetadata }
        : {};
    const variables = (metadata.variables && typeof metadata.variables === 'object' && !Array.isArray(metadata.variables))
        ? { ...metadata.variables }
        : {};
    for (const key of ['initialized_lorebooks', 'stat_data', 'schema', 'display_data', 'delta_data']) {
        if (patch[key] !== undefined) {
            variables[key] = patch[key];
        }
    }
    metadata.variables = variables;
    return metadata;
}

/** 回执 → 侧车 op 日志条目(诊断页全量;bounded)。 */
function receiptToLogEntry(receipt, extra = {}) {
    return {
        ts: Date.now(),
        messageIndex: extra.messageIndex ?? -1,
        swipeId: extra.swipeId ?? -1,
        baselineIndex: extra.baselineIndex ?? -1,
        modified: receipt?.modified === true,
        ops: Array.isArray(receipt?.ops) ? receipt.ops : [],
        errors: Array.isArray(receipt?.errors) ? receipt.errors : [],
    };
}

/** 回执追加进 chat_state 'mvu' 侧车;父聊天不存在时静默跳过(append 竞态)。 */
async function appendMvuOpLog(repo, key, entry) {
    const opts = { isGroup: key.isGroup, groupId: key.groupId };
    const existing = await repo.getState(key.handle, key.charDir, key.name, MVU_STATE_NAMESPACE, opts)
        .catch(() => null);
    const doc = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
    const ops = Array.isArray(doc.ops) ? doc.ops.slice() : [];
    ops.push(entry);
    if (ops.length > MAX_OP_LOG_ENTRIES) {
        ops.splice(0, ops.length - MAX_OP_LOG_ENTRIES);
    }
    const next = { version: 1, updatedAt: Date.now(), lastReceipt: entry, ops };
    try {
        await repo.setState(key.handle, key.charDir, key.name, MVU_STATE_NAMESPACE, next, opts);
    } catch (error) {
        // NotFoundError:聊天在 get→save 间隙被删 —— 日志可弃。
        if (error?.name !== 'NotFoundError') throw error;
    }
    return next;
}

/**
 * 对已持久化楼层做一次 settle(默认末楼;串行调用点=消息持久化之后)。
 * @param {object} args
 * @param {string} args.handle 用户句柄(ChatRepo 路由键)。
 * @param {string} args.charDir 角色目录名(group 时 '')。
 * @param {string} args.name 聊天名(jsonl basename / groupId)。
 * @param {boolean} [args.isGroup]
 * @param {string} [args.groupId]
 * @param {number} [args.messageIndex] 目标楼层,默认 body 末楼。
 * @param {boolean} [args.updateChatVariables] 是否镜像到 chat_metadata.variables
 *   (upstream 「更新到聊天变量」开关;默认 true——MVU 卡普遍依赖 getvar 读它)。
 * @returns {Promise<object>} {status, modified, messageIndex, swipeId, baselineIndex, receipt}
 */
export async function settlePersistedMvuMessage(args) {
    const repo = getChatRepo();
    const opts = { isGroup: !!args.isGroup, groupId: args.groupId };
    const updateChatVariables = args.updateChatVariables !== false;

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
        const chat = await repo.get(args.handle, args.charDir ?? '', args.name, opts);
        const body = Array.isArray(chat?.body) ? chat.body : null;
        if (!chat || !body || body.length === 0) {
            return { status: 'no_chat', modified: false };
        }
        const messageIndex = Number.isInteger(args.messageIndex)
            ? Math.min(Math.max(0, args.messageIndex), body.length - 1)
            : body.length - 1;

        const result = settleMvuMessage({ messages: body, messageIndex });
        if (result.status !== 'settled') {
            // skipped(<5字/无楼层)/no_baseline(未 init)——均无需写回。
            return {
                status: result.status,
                modified: false,
                messageIndex,
                swipeId: result.swipeId,
                baselineIndex: result.baselineIndex,
                receipt: result.receipt,
            };
        }

        const nextBody = applySettleToBody(body, messageIndex, result);
        let header = chat.header;
        if (updateChatVariables && result.modified) {
            header = {
                ...(header ?? {}),
                chat_metadata: mergeChatVariablesPatch(header?.chat_metadata, result.chatVariablesPatch),
            };
        }

        try {
            const saved = await repo.save(args.handle, args.charDir ?? '', args.name, header, nextBody, chat.integrity, opts);
            const entry = receiptToLogEntry(result.receipt, {
                messageIndex,
                swipeId: result.swipeId,
                baselineIndex: result.baselineIndex,
            });
            await appendMvuOpLog(repo, { handle: args.handle, charDir: args.charDir ?? '', name: args.name, ...opts }, entry);
            return {
                status: 'settled',
                modified: result.modified,
                messageIndex,
                swipeId: result.swipeId,
                baselineIndex: result.baselineIndex,
                receipt: result.receipt,
                integrity: saved.integrity,
            };
        } catch (error) {
            // integrity_mismatch:persist/编辑与本写回竞争 → 重载重折(投影幂等)。
            if (error instanceof ConflictError || error?.name === 'ConflictError') {
                continue;
            }
            throw error;
        }
    }
    return { status: 'conflict', modified: false, attempts: MAX_SAVE_ATTEMPTS };
}

/**
 * 全量重放 settle(旧楼层被编辑/删除/换 swipe 后的投影重建)。
 * 逐层 settleMvuMessage(楼层快照就地更新,供后续层作基底),末尾单次 save。
 * @returns {Promise<object>} {status, floors, settled, modified, receipts}
 */
export async function resettleChatMvu(args) {
    const repo = getChatRepo();
    const opts = { isGroup: !!args.isGroup, groupId: args.groupId };
    const updateChatVariables = args.updateChatVariables !== false;

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
        const chat = await repo.get(args.handle, args.charDir ?? '', args.name, opts);
        const body = Array.isArray(chat?.body) ? chat.body : null;
        if (!chat || !body || body.length === 0) {
            return { status: 'no_chat', modified: false, floors: 0 };
        }

        let nextBody = body.slice();
        let lastPatch = null;
        let lastModified = false;
        const floorResults = [];
        for (let i = 0; i < nextBody.length; i++) {
            const result = settleMvuMessage({ messages: nextBody, messageIndex: i });
            floorResults.push({ index: i, status: result.status, modified: result.modified });
            if (result.status !== 'settled') continue;
            nextBody = applySettleToBody(nextBody, i, result);
            lastPatch = result.chatVariablesPatch;
            lastModified = lastModified || result.modified;
        }

        let header = chat.header;
        if (updateChatVariables && lastModified && lastPatch) {
            header = {
                ...(header ?? {}),
                chat_metadata: mergeChatVariablesPatch(header?.chat_metadata, lastPatch),
            };
        }

        try {
            const saved = await repo.save(args.handle, args.charDir ?? '', args.name, header, nextBody, chat.integrity, opts);
            const settled = floorResults.filter(r => r.status === 'settled');
            await appendMvuOpLog(repo, { handle: args.handle, charDir: args.charDir ?? '', name: args.name, ...opts }, {
                ts: Date.now(),
                messageIndex: -1,
                swipeId: -1,
                baselineIndex: -1,
                modified: lastModified,
                ops: [],
                errors: [],
                kind: 'refold',
                floors: nextBody.length,
                settledFloors: settled.length,
            });
            return {
                status: 'settled',
                modified: lastModified,
                floors: nextBody.length,
                settled: settled.length,
                details: floorResults,
                integrity: saved.integrity,
            };
        } catch (error) {
            if (error instanceof ConflictError || error?.name === 'ConflictError') {
                continue;
            }
            throw error;
        }
    }
    return { status: 'conflict', modified: false, attempts: MAX_SAVE_ATTEMPTS };
}

/** 读取 chat 当前 MVU 视图(stat_data + 侧车日志),面板/诊断页用。 */
export async function getMvuChatView(args) {
    const repo = getChatRepo();
    const opts = { isGroup: !!args.isGroup, groupId: args.groupId };
    const chat = await repo.get(args.handle, args.charDir ?? '', args.name, opts);
    if (!chat) return { status: 'no_chat' };
    const chatVariables = chat.header?.chat_metadata?.variables ?? {};
    const state = await repo.getState(args.handle, args.charDir ?? '', args.name, MVU_STATE_NAMESPACE, opts)
        .catch(() => null);
    const body = Array.isArray(chat.body) ? chat.body : [];
    const lastFloor = body.length > 0 ? body[body.length - 1] : null;
    const floorVariables = lastFloor?.variables?.[lastFloor?.swipe_id ?? 0];
    return {
        status: 'ok',
        chatVariables,
        statData: chatVariables.stat_data ?? (isMvuData(floorVariables) ? floorVariables.stat_data : undefined),
        floorVariables: isMvuData(floorVariables) ? floorVariables : undefined,
        state: state ?? null,
    };
}
