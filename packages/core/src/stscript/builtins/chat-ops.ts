/**
 * 楼层/会话操作族 — 移植自 ref/Luker:
 * - power-user.js: doDelMode(/del) / doMesCut(/cut)
 * - slash-commands.js: /swipe /delswipe /addswipe /hide /unhide /delname
 *   /messages /message-role /message-name /reroll-pick /go
 * - script.js: swipe/syncSwipeToMes/syncMesToSwipe/getOverswipeBehavior/
 *   deleteSwipe/getMessageDeletionStartId
 * - chats.js: hideChatMessageRange
 * - authors-note 之外的 T3 工作令面(inject×3 另归 /inject 族)。
 *
 * 写面纪律(TASK-064):命令 = web 楼层 UI 操作的脚本化 —— 全部副作用
 * 先改 env.macro.chat 活数组(与上游 chat[] 同语义),再经
 * env.host.patchChat(JSON-Patch,/body/<i> 命名空间)落盘 —— 与 web
 * opsOf/PATCH ops 同一服务端写面(repo.patch),不造平行实现。
 * 持久化宿主缺席时只改内存(与 appendMessage 降级一致),ops 回执照记。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandEnumValue, enumTypes, enumIcons, booleanEnumProvider } from '../types.js';
import { extractMessageBias, getMessageTimeStamp, isFalseBoolean, isTrueBoolean, stringToRange } from '../util.js';
import type { StscriptEnv, StscriptMessage, StscriptPatchOp } from '../env.js';
import { addCommandObject } from '../registry.js';
import { getNameAndAvatarForMessage, SYSTEM_MESSAGE_TYPES } from './common.js';

type ChatFloor = StscriptMessage;

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

function chatOf(env: StscriptEnv): ChatFloor[] {
    return env.macro.chat as unknown as ChatFloor[];
}

/** 楼层写回执:patchChat seam + chat-patch op receipt(单点)。 */
async function patchFloors(env: StscriptEnv, ops: StscriptPatchOp[]): Promise<void> {
    if (!ops.length) return;
    await env.host.patchChat?.(ops);
    env.ops.push({ type: 'chat-patch', ops });
}

/** 整楼替换 op(上游 patchMessagesByIndex/deleteSwipe 同形 —— 多字段联动时用它)。 */
const floorReplace = (i: number, floor: ChatFloor): StscriptPatchOp => ({ op: 'replace', path: `/body/${i}`, value: floor });

/** 楼层取址 — 仅供已经做过 bounds 校验的调用点(noUncheckedIndexedAccess 收敛)。 */
function floorAt(chat: ChatFloor[], i: number): ChatFloor {
    const m = chat[i];
    if (!m) throw new Error(`STscript: no message at index ${i}`);
    return m;
}

// ---------------------------------------------------------------------------
// 删除面 — doMesCut/doDelMode/deleteMessage(toolcall 级联)
// ---------------------------------------------------------------------------

/**
 * 删 [startIdx..endIdx] 楼层(doMesCut):逐条切下并累计正文;
 * toolcalls=true 时删 AI 楼会级联吃掉前面连续的
 * is_system+extra.tool_invocations 楼(getMessageDeletionStartId)。
 * 返回被删楼在删除前镜像(preImage)中的下标集合 + 切下文本。
 */
async function deleteFloorsRange(env: StscriptEnv, startIdx: number, endIdx: number, deleteToolCalls: boolean): Promise<{ removed: number[]; cutText: string }> {
    const chat = chatOf(env);
    const preImage = [...chat];
    const removed = new Set<number>();
    let cutText = '';
    const victims = preImage.slice(startIdx, endIdx + 1);
    for (const msg of victims) {
        const i = chat.indexOf(msg);
        if (i === -1) continue; // 已被级联吃掉
        cutText += (msg?.mes || '') + '\n';
        // toolcall 级联(script.js getMessageDeletionStartId):仅对 AI 楼
        let start = i;
        if (deleteToolCalls && !msg.is_user && !msg.is_system) {
            while (start > 0) {
                const prev = chat[start - 1];
                if (!prev?.is_system || !Array.isArray(prev?.extra?.tool_invocations)) break;
                start--;
            }
        }
        for (let k = start; k <= i; k++) {
            const idx = preImage.indexOf(floorAt(chat, k));
            if (idx !== -1) removed.add(idx);
        }
        chat.splice(start, i - start + 1);
    }
    return { removed: [...removed], cutText };
}

/** 被删集合 → remove ops(preImage 下标降序,逐条删除后下标语义恒成立)。 */
const removeOpsFor = (removed: number[]): StscriptPatchOp[] =>
    [...removed].sort((a, b) => b - a).map(i => ({ op: 'remove' as const, path: `/body/${i}` }));

export async function doMesCut(args: NamedArguments, text: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const range = stringToRange(Array.isArray(text) ? text.join(' ') : text, 0, chat.length - 1);
    const deleteToolCalls = args?.toolcalls === undefined || isTrueBoolean(args.toolcalls);
    if (!range) {
        await env.host.notify?.('warning', undefined, 'Must provide a Message ID or a range to cut.');
        return '';
    }
    const { removed, cutText } = await deleteFloorsRange(env, range.start, range.end, deleteToolCalls);
    await patchFloors(env, removeOpsFor(removed));
    return cutText;
}

export async function doDelMode(args: NamedArguments, text: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const value = Array.isArray(text) ? text.join(' ') : text;
    if (value && isNaN(Number(value))) {
        await env.host.notify?.('warning', undefined, 'Must enter a number or nothing.');
        return '';
    }
    if (!value) {
        // 无参 = 上游进删除模式(UI-only);服务端等价物是显式 N 或 /cut,如实返回
        return '';
    }
    const count = Number(value);
    if (count < 1) return '';
    if (count > chat.length) {
        await env.host.notify?.('warning', undefined, `Cannot delete more than ${chat.length} messages.`);
        return '';
    }
    const range = `${chat.length - count}-${chat.length - 1}`;
    return doMesCut(args, range);
}

export async function deleteMessagesByNameCallback(args: NamedArguments, name: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    let nameStr = String(Array.isArray(name) ? name.join(' ') : name ?? '').trim();
    if (!nameStr) {
        console.warn('WARN: No name provided for /delname command');
        return '';
    }
    const character = env.host.resolveCharacter?.(nameStr) ?? null;
    nameStr = character?.name || nameStr;
    const preImage = [...chat];
    const victims = preImage.filter(m => m.name === nameStr);
    if (!victims.length) {
        console.debug('/delname: Nothing to delete');
        return '';
    }
    const removed: number[] = [];
    for (const msg of victims) {
        const i = chat.indexOf(msg);
        if (i === -1) continue;
        removed.push(preImage.indexOf(msg));
        chat.splice(i, 1);
    }
    env.macro.chatMetadata['tainted'] = true;
    await patchFloors(env, removeOpsFor(removed));
    await env.host.persistChat?.();
    await env.host.notify?.('info', undefined, `Deleted ${victims.length} messages from ${nameStr}`);
    return '';
}

// ---------------------------------------------------------------------------
// /hide /unhide — hideChatMessageRange
// ---------------------------------------------------------------------------

async function hideMessageCallback(args: NamedArguments, value: UnnamedArguments, unhide: boolean): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const str = Array.isArray(value) ? value.join(' ') : value;
    const range = str ? stringToRange(str, 0, chat.length - 1) : { start: chat.length - 1, end: chat.length - 1 };
    if (!range) {
        console.warn(`WARN: Invalid range provided for /${unhide ? 'unhide' : 'hide'} command: ${str}`);
        return '';
    }
    const nameFilter = String(args.name ?? '').trim();
    const hidden = !unhide;
    const ops: StscriptPatchOp[] = [];
    for (let i = range.start; i <= range.end; i++) {
        const m = chat[i];
        if (!m) continue;
        if (nameFilter && m.name !== nameFilter) continue;
        m.is_system = hidden;
        ops.push({ op: 'replace', path: `/body/${i}/is_system`, value: hidden });
    }
    await patchFloors(env, ops);
    return '';
}

// ---------------------------------------------------------------------------
// /swipe /delswipe /addswipe — swipe/syncSwipeToMes/syncMesToSwipe/deleteSwipe
// ---------------------------------------------------------------------------

const OVERSWIPE = { NONE: 'none', LOOP: 'loop', PRISTINE_GREETING: 'pristine_greeting', REGENERATE: 'regenerate', EDIT_GENERATE: 'edit_generate' } as const;

/** getOverswipeBehavior(script.js:18053)。 */
function overswipeBehavior(env: StscriptEnv, mesId: number, m: ChatFloor): string {
    const isPristine = !env.macro.chatMetadata?.['tainted'];
    const isGreeting = mesId === 0;
    if (typeof m?.extra?.overswipe_behavior === 'string') return String(m.extra.overswipe_behavior);
    if (m?.extra?.swipeable === false) return OVERSWIPE.NONE;
    if (m?.extra?.isSmallSys) return OVERSWIPE.NONE;
    if (isGreeting && isPristine) return OVERSWIPE.PRISTINE_GREETING;
    if (!m?.is_user && !m?.is_system) return OVERSWIPE.REGENERATE;
    return OVERSWIPE.LOOP;
}

/** clearMessageData:切版前剥掉上一版的展示/生成痕迹。 */
function clearSwipeFloorData(m: ChatFloor): void {
    if (m.extra && typeof m.extra === 'object') {
        for (const k of ['memory', 'display_text', 'media', 'inline_image', 'files', 'fileLength', 'generationType', 'negative', 'title', 'append_title', 'var_ops']) {
            delete m.extra[k];
        }
    }
    delete m.gen_started;
    delete m.gen_finished;
}

/** swipe_id 落地 + mes/extra/send_date/gen_* 从 swipe_info[sid] 同步(syncSwipeToMes)。 */
function applySwipeIndex(m: ChatFloor, sid: number): void {
    m.swipe_id = sid;
    const si = Array.isArray(m.swipe_info) ? m.swipe_info[sid] : undefined;
    m.mes = typeof m.swipes?.[sid] === 'string' ? m.swipes[sid] as string : m.mes;
    if (si && typeof si === 'object') {
        const rec = si as Record<string, unknown>;
        if (rec.send_date !== undefined) m.send_date = rec.send_date as string;
        if (rec.gen_started !== undefined) m.gen_started = rec.gen_started;
        if (rec.gen_finished !== undefined) m.gen_finished = rec.gen_finished;
        m.extra = structuredClone(rec.extra ?? {}) as Record<string, unknown>;
    } else {
        m.extra = {};
    }
}

/** syncMesToSwipe:切走前把当前 mes 与 gen_started/gen_finished/extra 写回 swipe 槽(防编辑丢失)。 */
function syncMesToSwipe(env: StscriptEnv, m: ChatFloor): void {
    const sid = Number(m.swipe_id ?? 0);
    if (!Array.isArray(m.swipes) || !Array.isArray(m.swipe_info)) return;
    if (typeof m.swipes[sid] !== 'string' || typeof m.swipe_info[sid] !== 'object') return;
    const si = m.swipe_info[sid] as Record<string, unknown>;
    // 上游门控:chat_metadata.tainted || chat.length>1 才写回正文(保 pristine 问候宏)
    if (env.macro.chatMetadata['tainted'] || chatOf(env).length > 1) {
        m.swipes[sid] = m.mes;
    }
    si.send_date = m.send_date;
    if (m.gen_started !== undefined) si.gen_started = m.gen_started; else delete si.gen_started;
    if (m.gen_finished !== undefined) si.gen_finished = m.gen_finished; else delete si.gen_finished;
    si.extra = structuredClone(m.extra);
}

export async function swipeChatCallback(args: NamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    if (!chat.length) {
        await env.host.notify?.('warning', undefined, 'Swipe was called on an empty chat.');
        return '';
    }
    const direction = String(args?.direction ?? 'right') === 'left' ? 'left' : 'right';
    const shouldAwait = isTrueBoolean(args?.['await']);
    const mesId = chat.length - 1;
    const m = floorAt(chat, mesId);

    // 无 swipe 结构的楼:初始化槽位(上游 swipe() 同形)
    if (typeof m.swipe_id !== 'number') {
        m.swipe_id = 0;
        m.swipes = [String(m.mes ?? '')];
        m.swipe_info = [{
            send_date: m.send_date,
            gen_started: m.gen_started,
            gen_finished: m.gen_finished,
            extra: structuredClone(m.extra ?? {}),
        }];
    }
    const originalSwipeId = Number(m.swipe_id);
    syncMesToSwipe(env, m);

    let newSwipeId = originalSwipeId;
    if (direction === 'left') {
        newSwipeId--;
        if (newSwipeId < 0) newSwipeId = Math.max(0, m.swipes!.length - 1);
        if (newSwipeId > m.swipes!.length - 1) {
            await env.host.notify?.('warning', undefined, `The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to ${m.swipes!.length - 1}.`);
            newSwipeId = m.swipes!.length - 1;
        }
    } else {
        newSwipeId++;
        if (newSwipeId < 0) {
            await env.host.notify?.('warning', undefined, `The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to zero.`);
            newSwipeId = 0;
        }
        if (newSwipeId >= m.swipes!.length) {
            const behavior = overswipeBehavior(env, mesId, m);
            if (behavior === OVERSWIPE.REGENERATE || behavior === OVERSWIPE.EDIT_GENERATE) {
                // = Generate('swipe'):整生成链,与 /trigger 同类(TASK-069)。
                // seam 缺席不静默 —— 明确 warn + revert(上游 OVERSWIPE.NONE 同归路)。
                if (!env.host.generateSwipe) {
                    m.swipe_id = originalSwipeId;
                    await env.host.notify?.('warning', undefined, '/swipe: overswipe regeneration requires host.generateSwipe — not bound on this host (swipe reverted)');
                    return '';
                }
                m.swipe_id = m.swipes!.length;
                clearSwipeFloorData(m);
                m.mes = '';
                if (m.extra && typeof m.extra === 'object') {
                    m.extra['reasoning'] = '';
                    for (const k of ['reasoning_duration', 'reasoning_signature', 'reasoning_blocks', 'reasoning_details', 'token_count']) delete m.extra[k];
                }
                const ops = [floorReplace(mesId, m)];
                await patchFloors(env, ops);
                const gen = env.host.generateSwipe(mesId);
                if (shouldAwait) await gen;
                return '';
            } else if (behavior === OVERSWIPE.NONE) {
                m.swipe_id = originalSwipeId;
                return '';
            } else {
                // LOOP / PRISTINE_GREETING → 回第一版
                newSwipeId = 0;
            }
        }
    }

    // 上游顺序:swipe_id= → clearMessageData(剥旧版痕迹) → syncSwipeToMes(载入新版)
    clearSwipeFloorData(m);
    applySwipeIndex(m, newSwipeId);
    // 持久化:整楼替换(swipe_id+mes+extra+swipes/swipe_info 全部联动)
    await patchFloors(env, [floorReplace(mesId, m)]);
    return '';
}

export async function deleteSwipeCallback(args: NamedArguments, arg: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const m = chat[chat.length - 1];
    if (!m || !Array.isArray(m.swipes) || !m.swipes.length) {
        await env.host.notify?.('warning', undefined, 'No messages to delete swipes from.');
        return '';
    }
    if (m.swipes.length <= 1) {
        await env.host.notify?.('warning', undefined, "Can't delete the last swipe.");
        return '';
    }
    const argStr = Array.isArray(arg) ? arg.join(' ') : arg;
    // 上游 arg 为 1-based;未给/非数字 → 当前版
    let swipeId = argStr && !isNaN(Number(argStr)) ? Number(argStr) - 1 : Number(m.swipe_id ?? 0);
    const currentSwipeId = Math.min(Math.max(Number(m.swipe_id ?? 0), 0), m.swipes.length - 1);
    if (!Number.isInteger(swipeId) || swipeId < 0 || swipeId >= m.swipes.length) {
        await env.host.notify?.('warning', undefined, `Invalid swipe ID: ${swipeId + 1}`);
        return '';
    }
    m.swipes.splice(swipeId, 1);
    if (Array.isArray(m.swipe_info) && m.swipe_info.length) m.swipe_info.splice(swipeId, 1);

    let newSwipeId: number;
    if (swipeId < currentSwipeId) newSwipeId = currentSwipeId - 1;
    else if (swipeId > currentSwipeId) newSwipeId = currentSwipeId;
    else newSwipeId = Math.min(swipeId, m.swipes.length - 1);

    env.macro.chatMetadata['tainted'] = true;
    if (swipeId === currentSwipeId) {
        clearSwipeFloorData(m);
        applySwipeIndex(m, newSwipeId);
    } else {
        m.swipe_id = newSwipeId;
    }

    await patchFloors(env, [floorReplace(chat.length - 1, m)]);
    await env.host.persistChat?.();
    return String(newSwipeId);
}

export async function addSwipeCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const m = chat[chat.length - 1];
    if (!m) {
        await env.host.notify?.('warning', undefined, 'No messages to add swipes to.');
        return '';
    }
    const text = String(Array.isArray(value) ? value.join(' ') : value ?? '');
    if (!text) {
        console.warn('WARN: No argument provided for /addswipe command');
        return '';
    }
    if (m.is_user) {
        await env.host.notify?.('warning', undefined, "Can't add swipes to user messages.");
        return '';
    }
    if (m.is_system) {
        await env.host.notify?.('warning', undefined, "Can't add swipes to system messages.");
        return '';
    }
    if (!Array.isArray(m.swipes)) {
        m.swipes = [String(m.mes ?? '')];
        m.swipe_info = [{}];
        m.swipe_id = 0;
    }
    if (!Array.isArray(m.swipe_info)) {
        m.swipe_info = m.swipes.map(() => ({}));
    }
    m.swipes.push(text);
    m.swipe_info.push({
        send_date: getMessageTimeStamp(),
        gen_started: null,
        gen_finished: null,
        extra: {
            bias: extractMessageBias(text),
            gen_id: Date.now(),
            api: 'manual',
            model: 'slash command',
        },
    });
    const newSwipeId = m.swipes.length - 1;
    if (isTrueBoolean(args['switch'])) {
        applySwipeIndex(m, newSwipeId);
    }
    await patchFloors(env, [floorReplace(chat.length - 1, m)]);
    return String(newSwipeId);
}

// ---------------------------------------------------------------------------
// /messages /message-role /message-name /reroll-pick /go
// ---------------------------------------------------------------------------

export async function getMessagesCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const includeNames = !isFalseBoolean(args?.names);
    const includeHidden = isTrueBoolean(args?.hidden);
    const role = args?.role;
    const range = stringToRange(Array.isArray(value) ? value.join(' ') : value, 0, chat.length - 1);
    if (!range) {
        console.warn(`WARN: Invalid range provided for /messages command: ${value}`);
        return '';
    }
    const filterByRole = (mes: ChatFloor) => {
        if (!role) return true;
        const isNarrator = mes.extra?.type === SYSTEM_MESSAGE_TYPES.NARRATOR;
        if (role === 'system') return isNarrator && !mes.is_user;
        if (role === 'assistant') return !isNarrator && !mes.is_user;
        if (role === 'user') return !isNarrator && mes.is_user;
        throw new Error(`Invalid role provided. Expected one of: system, assistant, user. Got: ${role}`);
    };
    const out: string[] = [];
    for (let i = range.start; i <= range.end; i++) {
        const msg = chat[i];
        if (!msg) { console.warn(`WARN: No message found with ID ${i}`); continue; }
        if (role && !filterByRole(msg)) continue;
        if (!includeHidden && msg.is_system) continue;
        out.push(includeNames ? `${msg.name}: ${msg.mes}` : String(msg.mes ?? ''));
    }
    return out.join('\n\n');
}

/** at= 负值(depth 语义)折算 —— 上游 message-role/name 同款。 */
function resolveModifyAt(args: NamedArguments, chatLength: number): number {
    let at = Number(args?.['at'] ?? (chatLength - 1));
    if (!isNaN(at) && (at < 0 || Object.is(at, -0))) at = chatLength + at;
    return at;
}

export async function messageRoleCallback(args: NamedArguments, role: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const at = resolveModifyAt(args, chat.length);
    const message = chat[at];
    if (!message) {
        await env.host.notify?.('warning', undefined, 'No message found at the specified index.');
        return '';
    }
    const roleStr = String(Array.isArray(role) ? role.join(' ') : role ?? '').trim().toLowerCase();
    if (!roleStr || !['user', 'assistant', 'system'].includes(roleStr)) {
        return message?.extra?.type === SYSTEM_MESSAGE_TYPES.NARRATOR
            ? 'system'
            : message.is_user ? 'user' : 'assistant';
    }
    message.extra = (message.extra ?? {}) as Record<string, unknown>;
    if (roleStr === 'system') message.extra['type'] = SYSTEM_MESSAGE_TYPES.NARRATOR;
    else delete message.extra['type'];
    message.is_user = roleStr === 'user';
    await patchFloors(env, [floorReplace(at, message)]);
    return roleStr;
}

export async function messageNameCallback(args: NamedArguments, name: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const at = resolveModifyAt(args, chat.length);
    const message = chat[at];
    if (!message) {
        await env.host.notify?.('warning', undefined, 'No message found at the specified index.');
        return '';
    }
    const nameStr = String(Array.isArray(name) ? name.join(' ') : name ?? '').trim();
    if (!nameStr) return String(message.name ?? '');

    const defaultAvatar = env.host.defaultAvatar ?? 'img/logo.png';
    if (message.is_user) {
        const persona = env.host.findPersona?.(nameStr) ?? null;
        if (persona) {
            message.name = persona.name;
            message.force_avatar = env.host.avatarUrl?.('persona', persona.avatar ?? '') ?? persona.avatar;
            message.original_avatar = persona.avatar;
        } else {
            message.name = nameStr;
            message.force_avatar = defaultAvatar;
            message.original_avatar = defaultAvatar;
        }
    } else {
        const character = env.host.resolveCharacter?.(nameStr) ?? null;
        if (character) {
            const info = getNameAndAvatarForMessage(env, character, nameStr);
            message.name = info.name ?? nameStr;
            message.force_avatar = info.force_avatar;
            message.original_avatar = info.original_avatar;
        } else {
            message.name = nameStr;
            message.force_avatar = defaultAvatar;
            message.original_avatar = defaultAvatar;
        }
    }
    await patchFloors(env, [floorReplace(at, message)]);
    return String(message.name ?? '');
}

export function rerollPickCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    const currentSeed = Number(env.macro.chatMetadata['pick_reroll_seed'] ?? 0) || 0;
    const parsed = value ? parseInt(String(Array.isArray(value) ? value.join(' ') : value), 10) : NaN;
    const next = !isNaN(parsed) ? parsed : currentSeed + 1;
    env.macro.chatMetadata['pick_reroll_seed'] = next;
    env.host.persistMetadata?.();
    return String(next);
}

/**
 * /swap a b — Utopinn 扩展(上游无此命令;TASK-064 工作令点名)。
 * 对换两个楼层:双 replace op,等价于 UI 拖拽换序的脚本化。
 */
export async function swapFloorsCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = chatOf(env);
    const parts = String(Array.isArray(value) ? value.join(' ') : value ?? '').trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 2 || parts.some(p => isNaN(Number(p)))) {
        await env.host.notify?.('warning', undefined, 'Usage: /swap <indexA> <indexB>');
        return '';
    }
    let a = Number(parts[0]), b = Number(parts[1]);
    // 负值 = depth 语义(与 message-role/name 的 at= 一致)
    if (a < 0 || Object.is(a, -0)) a = chat.length + a;
    if (b < 0 || Object.is(b, -0)) b = chat.length + b;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= chat.length || b >= chat.length) {
        await env.host.notify?.('warning', undefined, `Invalid message indexes for /swap (chat has ${chat.length} messages).`);
        return '';
    }
    if (a === b) return '';
    const fa = floorAt(chat, a), fb = floorAt(chat, b);
    chat[a] = fb;
    chat[b] = fa;
    env.macro.chatMetadata['tainted'] = true;
    await patchFloors(env, [floorReplace(a, fb), floorReplace(b, fa)]);
    await env.host.persistChat?.();
    return '';
}

export async function goToChatCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const name = String(Array.isArray(value) ? value.join(' ') : value ?? '').trim();
    if (!name) {
        console.warn('WARN: No character name provided for /go command');
        return '';
    }
    if (typeof env.host.resolveChatTarget !== 'function') {
        throw new Error('/go requires host.resolveChatTarget seam — not bound on this host');
    }
    const target = await env.host.resolveChatTarget(name);
    if (!target) {
        await env.host.notify?.('warning', undefined, `No matches found for name "${name}"`);
        return '';
    }
    env.ops.push({ type: 'go', target: target.name, charDir: target.charDir, chatName: target.chatName });
    return target.name;
}

// ---------------------------------------------------------------------------
// 注册 — T3 楼层/会话操作族(首批;inject×3 另归 /inject 族)
// ---------------------------------------------------------------------------

export function registerChatOpsCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'del',
        callback: (args, value) => doDelMode(args, value),
        aliases: ['delete', 'delmode'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'toolcalls',
                description: 'also delete associated tool-call messages',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('optional number', [ARGUMENT_TYPE.NUMBER], false),
        ],
        returns: 'The text of the deleted messages.',
        helpString: 'Enter message deletion mode, and auto-deletes last N messages if numeric argument is provided.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'cut',
        callback: (args, value) => doMesCut(args, value),
        returns: 'the text of cut messages separated by a newline',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'toolcalls',
                description: 'also delete associated tool-call messages',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'number or range',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: true,
                acceptsMultiple: true,
            }),
        ],
        helpString: 'Cuts the specified message or continuous chunk from the chat. Ranges are inclusive! Example: /cut 0-10',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'delname',
        callback: (args, value) => deleteMessagesByNameCallback(args, value),
        aliases: ['cancel'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name - or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Deletes all messages from the chat that were sent by the specified character.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'hide',
        callback: (args, value) => hideMessageCallback(args, value, false),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'name filter — only hide messages sent by this name',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'message index or range (default: last message)',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: false,
            }),
        ],
        helpString: 'Hides a message or range of messages from the prompt (marks it as system/hidden).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'unhide',
        callback: (args, value) => hideMessageCallback(args, value, true),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'name filter — only unhide messages sent by this name',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'message index or range (default: last message)',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: false,
            }),
        ],
        helpString: 'Unhides a previously hidden message or range of messages.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'swipe',
        callback: (args) => swipeChatCallback(args),
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'direction', 'Swipe direction', [ARGUMENT_TYPE.STRING], false, false, 'right',
                [
                    new SlashCommandEnumValue('right', 'Swipe to the next reply', enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('left', 'Swipe to the previous reply', enumTypes.enum, enumIcons.default),
                ],
                [], null, true,
            ),
            new SlashCommandNamedArgument(
                'await', 'Whether to await for the swipe action before proceeding', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
        ],
        helpString: 'Swipes the latest reply. Defaults to direction=right; use direction=left to go to the previous reply. Overswipe at the last version regenerates when the host supports it.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'delswipe',
        callback: (args, value) => deleteSwipeCallback(args, value),
        returns: 'the new active swipe index (0-based)',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'swipe number to delete (1-based; default: current swipe)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: 'Deletes a swipe version from the last message. Cannot delete the last remaining swipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'addswipe',
        callback: (args, value) => addSwipeCallback(args, value),
        returns: 'the new swipe index (0-based)',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'switch',
                description: 'switch to the newly added swipe',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'swipe text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Adds a new swipe version to the last message.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'messages',
        callback: (args, value) => getMessagesCallback(args, value),
        aliases: ['message'],
        returns: 'the specified message or range of messages as a string',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'names', 'show message author names', [ARGUMENT_TYPE.BOOLEAN], false, false, 'on', booleanEnumProvider('onOff')(),
            ),
            new SlashCommandNamedArgument(
                'hidden', 'include hidden messages', [ARGUMENT_TYPE.BOOLEAN], false, false, 'off', booleanEnumProvider('onOff')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'role',
                description: 'filter messages by role',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('assistant', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('user', null, enumTypes.enum, enumIcons.user),
                ],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'message index (starts with 0) or range',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: true,
            }),
        ],
        helpString: 'Returns the specified message or range of messages as a string. hidden=off excludes hidden; role= filters system|assistant|user.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'message-role',
        callback: (args, value) => messageRoleCallback(args, value),
        returns: 'The role of the message sender',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'the ID of the message to modify (index-based). Negative values count back from the end.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Role to set for the message sender (user, assistant, system)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Changes the role of a message sender. If no role is provided, gets the current role.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'message-name',
        callback: (args, value) => messageNameCallback(args, value),
        returns: 'The name of the message sender',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'the ID of the message to modify (index-based). Negative values count back from the end.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Persona name, character name, or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Changes the name on a message at a given index. If no name is provided, gets the current name.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'reroll-pick',
        callback: (args, value) => rerollPickCallback(args, value),
        returns: 'The new reroll seed value.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Optional seed value to set. If not provided, increments current seed by 1.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        helpString: 'Rerolls all {{pick}} macro choices in the current chat by changing the pick seed.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'swap',
        callback: (args, value) => swapFloorsCallback(args, value),
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'two message indexes (negative = depth from end), space or comma separated',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: true,
            }),
        ],
        helpString: 'Swaps two messages by index. Utopinn extension (no upstream equivalent). Example: /swap 3 5 or /swap -2 -1',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'go',
        callback: (args, value) => goToChatCallback(args, value),
        returns: 'The character/group/chat name',
        aliases: ['char'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name, group name, or "last" for the most recent chat',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Opens up a chat with the character or group by its name ("last" = most recent chat). Emits a go op receipt for the client to navigate.',
    }));
}
