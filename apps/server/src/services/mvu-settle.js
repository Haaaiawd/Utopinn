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
import { settleMvuMessage, isMvuData, initializeMvuVariables, convertCharacterBook } from '@utopinn/core';
import { getChatRepo, getSettingsRepo, getWorldInfoRepo } from '../storage/index.js';
import { ConflictError } from '../storage/errors.js';
import { loadCard } from './stscript-env.js';
import { getCharExtraBooks, resolveWorldInfoSettings } from './generate-context.js';

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
 * floor 的 swipe 槽位 → 待初始化文本序列。
 * upstream 口径:mes 是当前 swipe(swipe_id)的正文,swipes[] 是各候选;
 * swipe_id 槽位优先取 mes(客户端保证 swipes[swipe_id] === mes,防漂移)。
 * @returns {{index:number, text:string}[]}
 */
function floorSwipeInitTargets(floor) {
    const swipeId = Number.isInteger(floor?.swipe_id) ? floor.swipe_id : 0;
    const swipes = Array.isArray(floor?.swipes) ? floor.swipes : null;
    const count = Math.max(swipes?.length ?? 0, swipeId + 1);
    const out = [];
    for (let i = 0; i < count; i++) {
        const text = i === swipeId
            ? String(floor?.mes ?? swipes?.[i] ?? '')
            : String(swipes?.[i] ?? '');
        out.push({ index: i, text });
    }
    return out;
}

/**
 * init 书目解析(upstream initCheck 口径:selected_global + 角色主书 + 辅书;
 * 不含 chat-bound/persona 书 —— 与 generate-context collectWorldNames 五层集合不同)。
 * 顺序即 core initializeMvuVariables 的合并顺序:global → primary → extra。
 * @param {object} args
 * @param {string} args.handle
 * @param {string} [args.charDir] 角色目录名(group 聊天传 '')
 * @param {object} [args.directories] 用户目录集合(需要 .characters 读卡)
 * @returns {Promise<{lorebooks:import('@utopinn/core').MvuInitLorebook[], primaryLorebookName:string}>}
 */
export async function resolveMvuInitLorebooks({ handle, charDir = '', directories } = {}) {
    const settings = await getSettingsRepo().get(handle).catch(() => null);
    // 上游口径:全局勾选在 world_info_settings.world_info.globalSelect,
    // 辅书表在同对象 charLore —— 与 generate-context 共享归一化(audit H2 同族)。
    const { state: worldInfoState } = resolveWorldInfoSettings(settings);

    let card = null;
    if (charDir && directories?.characters) {
        card = await loadCard(directories, charDir).catch(() => null);
    }
    const primaryName = card?.data?.extensions?.world ?? card?.extensions?.world ?? null;

    const names = [];
    for (const n of worldInfoState.globalSelect ?? []) if (n) names.push(String(n));
    if (primaryName) names.push(String(primaryName));
    for (const n of getCharExtraBooks(worldInfoState, charDir)) if (n) names.push(String(n));
    const uniqueNames = [...new Set(names)];

    const worldInfoRepo = getWorldInfoRepo();
    const lorebooks = [];
    for (const name of uniqueNames) {
        const raw = await worldInfoRepo.get(handle, name).catch(() => null);
        let doc = raw?.doc ?? raw;
        // Same fallback as generate-context's worldCache (upstream
        // importEmbeddedWorldInfo semantics): when the primary book has not
        // been materialized yet, convert the card's embedded character_book
        // on the fly — it MUST go through convertCharacterBook (v2 card
        // book → world file shape, uid/keys restored); feeding the raw card
        // book in would leave every entry sharing the "world.undefined"
        // dedupe key and collapse the whole book into a single entry.
        if (!doc && name === primaryName && card?.data?.character_book?.entries) {
            doc = convertCharacterBook(card.data.character_book);
        }
        const entries = Object.values(doc?.entries ?? {})
            .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
            .map((e) => ({
                content: String(e.content ?? ''),
                comment: typeof e.comment === 'string' ? e.comment : undefined,
            }));
        lorebooks.push({ name, entries, isPrimary: name === primaryName });
    }
    return { lorebooks, primaryLorebookName: primaryName ?? 'unknown', card };
}

/** chat_metadata.variables 里 MVU 既存键(镜像过的六件套)。 */
const MVU_VAR_KEYS = ['stat_data', 'mvu_data', 'schema', 'display_data', 'delta_data', 'initialized_lorebooks'];
/** 世界书条目里的 MVU 命令语法:_.set(...)/_.assign(...) 等。 */
const MVU_CMD_RE = /\b_\.\w+\s*\(/;

/**
 * MVU 相关性门控(upstream should_enable 每聊天开关的服务端等价):
 * 满足任一即视为 MVU 上下文,否则 init/settle 跳过——非 MVU 卡不该
 * 长出 stat_data 快照或 StatusPlaceHolder 占位符。
 *   a) chat_metadata.mvu.enabled === true(显式每聊天开关)
 *   b) chat_metadata.variables 已有 MVU 镜像键(已初始化/导入的 MVU 聊天)
 *   c) card.data.extensions.mvu 为真(卡声明)
 *   d) init 书目条目带 [initvar] 注释或 _. 命令语法(MVU 卡的世界书标配)
 *   e) floor-0 正文含 <initvar> 块或 _. 命令(MVU 卡的开场初始化惯例)
 */
function mvuSignalPresent({ card, chatMetadata, lorebooks, floorText } = {}) {
    if (chatMetadata?.mvu?.enabled === true) return true;
    const vars = chatMetadata?.variables;
    if (vars && typeof vars === 'object' && MVU_VAR_KEYS.some((k) => vars[k] !== undefined)) return true;
    if (card?.data?.extensions?.mvu || card?.extensions?.mvu) return true;
    for (const book of lorebooks ?? []) {
        for (const e of book?.entries ?? []) {
            if (e?.comment?.toLowerCase().includes('[initvar]')) return true;
            if (MVU_CMD_RE.test(e?.content ?? '')) return true;
        }
    }
    if (floorText && (/<initvar>/i.test(floorText) || MVU_CMD_RE.test(floorText))) return true;
    return false;
}

/**
 * floor-0 初始化(upstream initCheck):0 层每个 swipe 跑 core
 * initializeMvuVariables → body[0].variables[i] 快照 + chat_metadata.variables
 * 镜像 + 侧车 kind:'init' op 日志。已初始化(variables[swipe_id] 过 isMvuData)早退。
 * @param {object} args
 * @param {string} args.handle
 * @param {string} [args.charDir]
 * @param {string} args.name
 * @param {boolean} [args.isGroup]
 * @param {string} [args.groupId]
 * @param {import('@utopinn/core').MvuInitLorebook[]} [args.lorebooks] 预解书目;
 *   缺省时走 resolveMvuInitLorebooks(需要 args.directories)。
 * @param {string} [args.primaryLorebookName]
 * @param {object} [args.directories]
 * @param {(s:string)=>string} [args.substitute]
 * @param {boolean} [args.updateChatVariables]
 * @returns {Promise<object>} {status:'initialized'|'already_initialized'|'no_chat'|'conflict'}
 */
export async function initializeMvuChat(args) {
    const repo = getChatRepo();
    const opts = { isGroup: !!args.isGroup, groupId: args.groupId };
    const updateChatVariables = args.updateChatVariables !== false;

    let lorebooks = Array.isArray(args.lorebooks) ? args.lorebooks : null;
    let primaryLorebookName = args.primaryLorebookName;
    let card = args.card ?? null;
    if (!lorebooks) {
        const resolved = await resolveMvuInitLorebooks({
            handle: args.handle,
            charDir: args.charDir ?? '',
            directories: args.directories,
        });
        lorebooks = resolved.lorebooks;
        primaryLorebookName ??= resolved.primaryLorebookName;
        card ??= resolved.card;
    }

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
        const chat = await repo.get(args.handle, args.charDir ?? '', args.name, opts);
        const body = Array.isArray(chat?.body) ? chat.body : null;
        if (!chat || !body || body.length === 0) {
            return { status: 'no_chat', initialized: false };
        }
        const floor = body[0];
        const floorText = [floor?.mes, ...(Array.isArray(floor?.swipes) ? floor.swipes : [])]
            .filter((s) => typeof s === 'string').join('\n');
        if (!mvuSignalPresent({ card, chatMetadata: chat.header?.chat_metadata, lorebooks, floorText })) {
            return { status: 'not_mvu', initialized: false };
        }
        const swipeId = Number.isInteger(floor?.swipe_id) ? floor.swipe_id : 0;
        const floorVars = (floor?.variables && typeof floor.variables === 'object' && !Array.isArray(floor.variables))
            ? floor.variables
            : {};
        if (isMvuData(floorVars[swipeId])) {
            return { status: 'already_initialized', initialized: false };
        }

        const variables = { ...floorVars };
        const errors = [];
        let activeVariables = null;
        const swipeTargets = floorSwipeInitTargets(floor);
        for (const { index, text } of swipeTargets) {
            const init = initializeMvuVariables({
                swipeText: text,
                lorebooks,
                primaryLorebookName,
                substitute: args.substitute,
            });
            variables[String(index)] = init.variables;
            errors.push(...init.errors);
            if (index === swipeId) activeVariables = init.variables;
        }

        const nextBody = body.slice();
        nextBody[0] = { ...floor, variables };
        let header = chat.header;
        if (updateChatVariables && activeVariables) {
            header = {
                ...(header ?? {}),
                chat_metadata: mergeChatVariablesPatch(header?.chat_metadata, activeVariables),
            };
        }

        try {
            const saved = await repo.save(args.handle, args.charDir ?? '', args.name, header, nextBody, chat.integrity, opts);
            await appendMvuOpLog(repo, { handle: args.handle, charDir: args.charDir ?? '', name: args.name, ...opts }, {
                ts: Date.now(),
                messageIndex: 0,
                swipeId,
                baselineIndex: -1,
                modified: true,
                ops: [],
                errors,
                kind: 'init',
                swipes: swipeTargets.length,
            });
            return {
                status: 'initialized',
                initialized: true,
                swipes: swipeTargets.length,
                errors,
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
    return { status: 'conflict', initialized: false, attempts: MAX_SAVE_ATTEMPTS };
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
 * @param {boolean} [args.autoInit] no_baseline 且 body[0] 存在时先跑
 *   initializeMvuChat(floor-0 初始化),再重试本 settle;每调用最多触发一次。
 * @param {import('@utopinn/core').MvuInitLorebook[]} [args.lorebooks] autoInit 预解书目。
 * @param {string} [args.primaryLorebookName] autoInit 主书名。
 * @param {object} [args.directories] autoInit 自解书目所需用户目录(.characters 读卡)。
 * @param {(s:string)=>string} [args.substitute] 透传给 init/settle 的宏替换。
 * @returns {Promise<object>} {status, modified, messageIndex, swipeId, baselineIndex, receipt}
 */
export async function settlePersistedMvuMessage(args) {
    const repo = getChatRepo();
    const opts = { isGroup: !!args.isGroup, groupId: args.groupId };
    const updateChatVariables = args.updateChatVariables !== false;
    const autoInit = args.autoInit === true;
    let initAttempted = false;

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
        const chat = await repo.get(args.handle, args.charDir ?? '', args.name, opts);
        const body = Array.isArray(chat?.body) ? chat.body : null;
        if (!chat || !body || body.length === 0) {
            return { status: 'no_chat', modified: false };
        }
        const messageIndex = Number.isInteger(args.messageIndex)
            ? Math.min(Math.max(0, args.messageIndex), body.length - 1)
            : body.length - 1;

        const result = settleMvuMessage({ messages: body, messageIndex, substitute: args.substitute });
        if (result.status !== 'settled') {
            // no_baseline = floor-0 未初始化:autoInit 先补 init 再进下一轮 attempt。
            if (result.status === 'no_baseline' && autoInit && !initAttempted) {
                initAttempted = true;
                const init = await initializeMvuChat({
                    handle: args.handle,
                    charDir: args.charDir ?? '',
                    name: args.name,
                    isGroup: args.isGroup,
                    groupId: args.groupId,
                    lorebooks: args.lorebooks,
                    primaryLorebookName: args.primaryLorebookName,
                    directories: args.directories,
                    substitute: args.substitute,
                    updateChatVariables,
                });
                if (init.status === 'initialized' || init.status === 'already_initialized') {
                    if (init.status === 'initialized' && messageIndex === 0) {
                        // 目标是 floor-0 自身:init 已把开场 swipe 文本 fold 进
                        // 快照(initializeMvuVariables 内 settleMvuVariables),
                        // 再 settle 一遍会把 greeting 的 _. 命令二次应用 → 直接返回。
                        return {
                            status: 'initialized',
                            modified: true,
                            messageIndex,
                            swipeId: result.swipeId,
                            baselineIndex: -1,
                            receipt: result.receipt,
                            init,
                        };
                    }
                    continue;
                }
                // no_chat/conflict:按原 no_baseline 结果返回,不阻塞写路径。
            }
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
        // 幂等短路:楼层文本/快照无变化且无镜像补丁、无命令回执时省掉整写
        // (重放/重复调用不再推高 integrity,避免客户端下次写无谓冲突)。
        const patchNeeded = updateChatVariables && result.modified;
        const floorChanged = JSON.stringify(nextBody[messageIndex]) !== JSON.stringify(body[messageIndex]);
        const receiptQuiet = (result.receipt?.ops?.length ?? 0) === 0 && (result.receipt?.errors?.length ?? 0) === 0;
        if (!floorChanged && !patchNeeded && receiptQuiet) {
            return {
                status: 'settled',
                modified: false,
                messageIndex,
                swipeId: result.swipeId,
                baselineIndex: result.baselineIndex,
                receipt: result.receipt,
                integrity: chat.integrity,
            };
        }
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
        // 非 MVU 聊天直接跳过全量重放(O(n²))——无镜像键且无楼层快照
        // 即无 MVU 参与过,refold 只会有害无益。
        const vars = chat.header?.chat_metadata?.variables;
        const metaMvu = vars && typeof vars === 'object' && MVU_VAR_KEYS.some((k) => vars[k] !== undefined);
        const floorMvu = body.some((m) => {
            const v = m?.variables;
            if (!v || typeof v !== 'object') return false;
            return Object.values(v).some((s) => isMvuData(s));
        });
        if (!metaMvu && !floorMvu) {
            return { status: 'not_mvu', modified: false, floors: body.length };
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

        // 幂等短路:重放结果与现状一致(非 MVU 聊天/已结算聊天)时不整写,
        // 避免每次 /save、/patch 都推高 integrity 让客户端下次写无谓冲突。
        const settledCount = floorResults.filter(r => r.status === 'settled').length;
        if (JSON.stringify(nextBody) === JSON.stringify(body) && header === chat.header) {
            return {
                status: 'settled',
                modified: false,
                floors: body.length,
                settled: settledCount,
                details: floorResults,
                integrity: chat.integrity,
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
