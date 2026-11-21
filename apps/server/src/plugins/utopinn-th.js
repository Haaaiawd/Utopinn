/**
 * utopinn-th —— TavernHelper 语义兼容层(TASK-025,自写;TH 本体是
 * PolyForm NC 许可,只实现 API 语义不搬代码)。
 *
 *   POST /api/utopinn/th/call
 *   body:{method, args?, target?{charDir?, chatName?}}
 *
 * 已实现的 TH 方法面(其余 → {ok:false,unsupported:true,method}):
 *   变量:getVariables / replaceVariables / insertOrAssignVariables /
 *         deleteVariable(scope:'chat'|'global'|'message', lodash 式路径)
 *         —— chat 域即 chat_metadata.variables,MVU stat_data 原生对象
 *            在里面,{{getvar::stat_data.*}} 与本面读写互通。
 *   消息:getChatMessages(start?, end?)
 *   脚本:triggerSlash(script) —— 共享 services/stscript-env.js
 *
 * 桥接定位:CardApp iframe 的 postMessage 桥调本面(TH 卡的
 * TavernHelper.getVariables 等调用经桥打到这里)。
 *
 * 事件面(TASK-049):真 listener 在卡 realm(shim 本地注册池),宿主
 * panelT0 记 event→lid 订阅做 push 过滤;本面持有的是 **影子注册表 +
 * 信箱日志**,存 chat_state ns `th.events`:
 *   {listeners:[{id,event,priority,once,at}], seq:N,
 *    log:[{seq,at,event,args,origin}]}  (log ring, cap 128)
 *   - 注册面(eventOn 家族):卡侧经 T0 转发到此,供跨端内省/CLI 直查;
 *   - 信箱(eventEmit→log):同聊其它 mount 的宿主泵 getEventLog(since)
 *     拉新条目推给订阅卡;origin=发起宿主 id,泵跳过自己的条目防回流。
 *   - event 名按字面存:tavern_events 值小写蛇形、iframe_events 值大写
 *     蛇形,两族同名不同义,不做归一。
 *   - 无 chat 目标 → 进程会话态 Map(handle 键)——订阅短命不落盘。
 */
import {
    executeSlashCommandsWithOptions,
    registerBuiltinCommands,
    getRegexedString,
    regex_placement,
    substituteParams,
    extractFrontendBlocks,
    isMvuData,
    isObjectSchema,
    validateStatDataAgainstSchema,
} from '@utopinn/core';
import { getChatRepo, getPresetRepo, getSettingsRepo, getStorageEngine, getWorldInfoRepo } from '../storage/index.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { safeName, sendError } from './_shared/http-utils.js';
import { buildStscriptEnv, loadCard } from '../services/stscript-env.js';
import { primaryWorldName } from '../services/embedded-world.js';
import { createFloorRegexRunner, chatFloorRegexPlacement } from '../services/extension-prompts.js';
import { emit as diagEmit } from '../services/diag-bus.js';

export const inject = ['webServer'];

/** TH 调用失败面 → th 事件(unsupported/方法内 error/scope 解析失败/未捕异常)。 */
function thEvent(code, msg, { method, charDir, chatName, status, error } = {}) {
    diagEmit({
        lvl: status >= 500 || code === 'th_error' ? 'error' : 'warn',
        kind: 'th',
        code,
        msg,
        ctx: { charDir, chatId: chatName, verb: method, status },
        data: { method, status, error: error ? String(error).slice(0, 300) : undefined },
    });
}

/** lodash 式路径 → 段数组('a.b[0].c' → ['a','b','0','c'])。 */
function pathSegs(p) {
    return String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}
// proto 污染防线:这些段名会让 set/del 改写 Object.prototype,拒绝一切含段路径。
const FORBIDDEN_SEGS = new Set(['__proto__', 'constructor', 'prototype']);
function unsafeSegs(p) {
    return pathSegs(p).some((s) => FORBIDDEN_SEGS.has(s));
}
function getPath(obj, p) {
    let cur = obj;
    for (const s of pathSegs(p)) {
        // ST 惯例:根可存 JSON 串(setvar 新根序列化)——读到串时尝试解包,
        // 与 core getVariable 的平读语义对齐(TH 卡经 lodash-path 穿透它)。
        if (typeof cur === 'string' && /^[{[]/.test(cur.trim())) {
            try { cur = JSON.parse(cur); } catch { /* 非 JSON 串按字面 */ }
        }
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = cur[s];
    }
    return cur;
}
function setPath(obj, p, v) {
    if (unsafeSegs(p)) return;
    const segs = pathSegs(p);
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        if (typeof cur[s] === 'string' && /^[{[]/.test(cur[s].trim())) {
            try { cur[s] = JSON.parse(cur[s]); } catch { cur[s] = {}; }
        }
        if (cur[s] === null || typeof cur[s] !== 'object') cur[s] = {};
        cur = cur[s];
    }
    cur[segs[segs.length - 1]] = v;
}
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** TH mergeWith 语义:plain-object 深合;数组/标量/异型整体替换(数组非逐位合)。 */
function mergeDeep(dst, src) {
    for (const [k, v] of Object.entries(src)) {
        if (unsafeSegs(k)) continue;
        if (isPlainObj(dst[k]) && isPlainObj(v)) mergeDeep(dst[k], v);
        else dst[k] = v;
    }
    return dst;
}

function delPath(obj, p) {
    if (unsafeSegs(p)) return false;
    const segs = pathSegs(p);
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        let nxt = cur?.[segs[i]];
        if (typeof nxt === 'string' && /^[{[]/.test(nxt.trim())) {
            try { nxt = JSON.parse(nxt); cur[segs[i]] = nxt; } catch { return false; }
        }
        if (nxt === null || typeof nxt !== 'object') return false;
        cur = nxt;
    }
    if (cur === null || typeof cur !== 'object') return false;
    return delete cur[segs[segs.length - 1]];
}

const SCOPES = new Set(['chat', 'global', 'message']);

// ── TH 事件面:影子注册表 + 信箱(chat_state ns 'th.events' / 会话 Map)──
const TH_EVENTS_NS = 'th.events';
const TH_EVENT_LOG_CAP = 128;
const sessionEventDocs = new Map(); // handle -> doc(无 chat 目标的会话态)
let thLidSeq = 0;

function emptyEventDoc() {
    return { listeners: [], seq: 0, log: [] };
}
function normalizeEventDoc(raw) {
    const doc = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : emptyEventDoc();
    if (!Array.isArray(doc.listeners)) doc.listeners = [];
    if (!Array.isArray(doc.log)) doc.log = [];
    if (typeof doc.seq !== 'number' || !Number.isFinite(doc.seq)) doc.seq = 0;
    return doc;
}
/** priority:'first'→首;'last'→尾;'normal'→插到 last 组之前(保序:first→normal→last)。 */
function insertListener(doc, entry) {
    if (entry.priority === 'first') { doc.listeners.unshift(entry); return; }
    if (entry.priority === 'last') { doc.listeners.push(entry); return; }
    const i = doc.listeners.findIndex((l) => l.priority === 'last');
    if (i === -1) doc.listeners.push(entry); else doc.listeners.splice(i, 0, entry);
}
/**
 * RMW:event doc(chat_state / 会话态)读-改-写。
 * chat 目标在 → engine 事务(原子);缺席 → handle 键会话 Map。
 * mutate(doc) → {ok:true,...}|{ok:false,status,error};chat 缺席 → 404。
 */
async function withEventDoc(ctx2, mutate) {
    if (!ctx2.charDir || !ctx2.chatName) {
        const doc = normalizeEventDoc(sessionEventDocs.get(ctx2.handle));
        const out = await mutate(doc);
        sessionEventDocs.set(ctx2.handle, doc);
        return out;
    }
    const engine = getStorageEngine();
    const key = { kind: 'chat', handle: ctx2.handle, charDir: ctx2.charDir, name: ctx2.chatName, isGroup: false };
    return engine.withTransaction(ctx2.handle, async (tx) => {
        if (!(await tx.hasChatResource(key))) {
            return { ok: false, status: 404, error: `chat not found: ${ctx2.charDir}/${ctx2.chatName}` };
        }
        const doc = normalizeEventDoc(await tx.getChatState(key, TH_EVENTS_NS));
        const out = await mutate(doc);
        await tx.putChatState(key, TH_EVENTS_NS, doc);
        return out;
    });
}
/** 只读面:getEventLog 不为缺席 chat 立档。 */
async function readEventDoc(ctx2) {
    if (!ctx2.charDir || !ctx2.chatName) {
        const d = sessionEventDocs.get(ctx2.handle);
        return d ? normalizeEventDoc(d) : null;
    }
    const engine = getStorageEngine();
    const key = { kind: 'chat', handle: ctx2.handle, charDir: ctx2.charDir, name: ctx2.chatName, isGroup: false };
    return engine.withTransaction(ctx2.handle, async (tx) => {
        if (!(await tx.hasChatResource(key))) return null;
        return normalizeEventDoc(await tx.getChatState(key, TH_EVENTS_NS));
    });
}
const eventName = (a) => String(a?.event ?? a?.event_type ?? '').trim();
/**
 * 信箱追加:seq 递增 + 日志截断 + once 影子消费。
 * eventEmit 与 generate 生命周期共用——宿主泵拉 log 推到订阅卡。
 */
function pushMailboxEntry(doc, event, args, origin) {
    doc.seq += 1;
    doc.log.push({ seq: doc.seq, at: Date.now(), event, args: Array.isArray(args) ? args : [args], origin });
    if (doc.log.length > TH_EVENT_LOG_CAP) doc.log.splice(0, doc.log.length - TH_EVENT_LOG_CAP);
    // once 影子:emit 即消费(卡侧 once 由 shim 自销,影子同步摘)
    doc.listeners = doc.listeners.filter((l) => !(l.event === event && l.once));
}
/** 服务端自身事件(生成生命周期等)进信箱——origin 标 'server' 防宿主误判自发。 */
async function recordThEvent(ctx2, event, args) {
    try {
        await withEventDoc(ctx2, (doc) => {
            pushMailboxEntry(doc, event, args, 'server');
            return { ok: true };
        });
    } catch { /* 生命周期事件失败不掩主结果 */ }
}

// ── 消息写助手(TH 字段名 → ST 楼层形) ──────────────────────────────
/** message_id 归一:负数 = 从尾数(TH normalizeMessageId)。 */
function normMessageId(id, len) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return n < 0 ? len + n : n;
}
/**
 * body RMW + CAS:读 doc → mutate(body) → save(header,body,integrity)。
 * integrity 撞车(并发写)→ 409。mutate 返回值进 out。
 */
async function mutateChatBody(ctx2, mutate) {
    if (!ctx2.charDir || !ctx2.chatName) {
        return { error: 'target.charDir + target.chatName required', status: 400 };
    }
    const repo = getChatRepo();
    const doc = await repo.get(ctx2.handle, ctx2.charDir, ctx2.chatName);
    if (!doc) return { error: `chat not found: ${ctx2.charDir}/${ctx2.chatName}`, status: 404 };
    const body = Array.isArray(doc.body) ? structuredClone(doc.body) : [];
    const out = mutate(body);
    try {
        await repo.save(ctx2.handle, ctx2.charDir, ctx2.chatName, doc.header ?? {}, body, doc.integrity);
    } catch (e) {
        if (String(e?.name) === 'ConflictError' || /integrity_mismatch/i.test(String(e?.message))) {
            return { error: 'chat integrity mismatch (concurrent write) — retry', status: 409 };
        }
        throw e;
    }
    return { out };
}
const pad = (arr, len, fill) => Array.from({ length: len }, (_, i) => arr?.[i] ?? (fill && typeof fill === 'object' ? {} : fill));
/** TH setChatMessages 单楼补丁 → ST 楼层字段(镜像 TH modify 语义)。 */
function applyThMessagePatch(m, patch) {
    if (patch.name !== undefined) m.name = patch.name;
    if (patch.role !== undefined) {
        m.is_user = patch.role === 'user';
        if (patch.role === 'system') { (m.extra ??= {}).type = 'narrator'; }
        else if (m.extra && m.extra.type === 'narrator') delete m.extra.type;
    }
    if (patch.is_hidden !== undefined) m.is_system = !!patch.is_hidden;
    const isChatMessage = patch.message !== undefined || patch.data !== undefined;
    if (isChatMessage) {
        if (patch.message !== undefined) {
            m.mes = patch.message;
            if (Array.isArray(m.swipes)) m.swipes[m.swipe_id ?? 0] = patch.message;
        }
        if (patch.data !== undefined) {
            if (!Array.isArray(m.variables)) m.variables = pad([], Math.max(1, m.swipes?.length ?? 1), {});
            m.variables[m.swipe_id ?? 0] = patch.data;
        }
        if (patch.extra !== undefined) {
            if (!Array.isArray(m.swipe_info)) m.swipe_info = pad([], Math.max(1, m.swipes?.length ?? 1), {});
            m.extra = patch.extra;
            m.swipe_info[m.swipe_id ?? 0] = patch.extra;
        }
    } else if (patch.swipe_id !== undefined || patch.swipes !== undefined
        || patch.swipes_data !== undefined || patch.swipes_info !== undefined) {
        // swipe 面写:数组补到 max_length,swipe_id 钳位,mes/extra 同步当前页
        const maxLen = Math.max(
            patch.swipes?.length ?? 0, patch.swipes_data?.length ?? 0,
            patch.swipes_info?.length ?? 0, m.swipes?.length ?? 1, 1);
        const sid = Math.max(0, Math.min(maxLen - 1, patch.swipe_id ?? m.swipe_id ?? 0));
        const swipes = pad(patch.swipes ?? m.swipes ?? [m.mes], maxLen, '');
        const sdata = pad(patch.swipes_data ?? m.variables ?? [{}], maxLen, {});
        const sinfo = pad(patch.swipes_info ?? m.swipe_info ?? [{}], maxLen, {});
        m.swipes = swipes;
        m.variables = sdata;
        m.swipe_info = sinfo;
        m.swipe_id = sid;
        m.mes = swipes[sid] ?? '';
        m.extra = sinfo[sid] ?? {};
    }
}

// ── 世界书助手(TH 平铺字段 ↔ ST entries 原档) ───────────────────────
const LB_POS_TO_TH = {
    0: 'before_character_definition', 1: 'after_character_definition',
    5: 'before_example_messages', 6: 'after_example_messages',
    2: 'before_author_note', 3: 'after_author_note',
};
const LB_POS_TO_ST = {
    before_character_definition: 0, after_character_definition: 1,
    before_example_messages: 5, after_example_messages: 6,
    before_author_note: 2, after_author_note: 3,
    at_depth_as_system: 4, at_depth_as_user: 4, at_depth_as_assistant: 4,
};
const LB_ROLE_TO_ST = { at_depth_as_system: 0, at_depth_as_user: 1, at_depth_as_assistant: 2 };
const LB_LOGIC_TO_TH = { 0: 'and_any', 1: 'not_all', 2: 'not_any', 3: 'and_all' };
const LB_LOGIC_TO_ST = { and_any: 0, not_all: 1, not_any: 2, and_all: 3 };

/** ST 原档 entry → TH 平铺视图(镜像 JSR toLorebookEntry)。 */
function stEntryToTh(e) {
    const uid = Number(e?.uid);
    return {
        uid,
        display_index: e?.displayIndex ?? 0,
        comment: e?.comment ?? '',
        enabled: !e?.disable,
        type: e?.constant ? 'constant' : e?.vectorized ? 'vectorized' : 'selective',
        position: LB_POS_TO_TH[e?.position]
            ?? (e?.role === 1 ? 'at_depth_as_user' : e?.role === 2 ? 'at_depth_as_assistant' : 'at_depth_as_system'),
        depth: e?.position === 4 ? (e?.depth ?? null) : null,
        order: e?.order ?? 100,
        probability: e?.probability ?? 100,
        key: e?.key ?? [],
        keys: e?.key ?? [],
        logic: LB_LOGIC_TO_TH[e?.selectiveLogic] ?? 'and_any',
        filter: e?.keysecondary ?? [],
        filters: e?.keysecondary ?? [],
        scan_depth: e?.scanDepth ?? 'same_as_global',
        case_sensitive: e?.caseSensitive ?? 'same_as_global',
        match_whole_words: e?.matchWholeWords ?? 'same_as_global',
        use_group_scoring: e?.useGroupScoring ?? 'same_as_global',
        automation_id: e?.automationId || null,
        exclude_recursion: !!e?.excludeRecursion,
        prevent_recursion: !!e?.preventRecursion,
        delay_until_recursion: e?.delayUntilRecursion ?? false,
        content: e?.content ?? '',
        group: e?.group ?? '',
        group_prioritized: !!e?.groupOverride,
        group_weight: e?.groupWeight ?? 100,
        sticky: e?.sticky ?? null,
        cooldown: e?.cooldown ?? null,
        delay: e?.delay ?? null,
    };
}
/** TH 平铺 patch → ST 原档 patch(仅提供的字段)。 */
function thPatchToSt(p) {
    const st = {};
    const put = (k, v) => { if (v !== undefined) st[k] = v; };
    if (p.uid !== undefined) put('uid', Number(p.uid));
    if (p.display_index !== undefined) put('displayIndex', p.display_index);
    if (p.comment !== undefined) put('comment', p.comment);
    if (p.enabled !== undefined) put('disable', !p.enabled);
    if (p.type !== undefined) { st.constant = p.type === 'constant'; st.vectorized = p.type === 'vectorized'; }
    if (p.position !== undefined) {
        put('position', LB_POS_TO_ST[p.position] ?? 0);
        if (p.position.startsWith('at_depth_as_')) st.role = LB_ROLE_TO_ST[p.position] ?? 0;
    }
    if (p.depth !== undefined) put('depth', p.depth === null ? 4 : p.depth);
    put('order', p.order);
    put('probability', p.probability);
    if (p.keys !== undefined) put('key', p.keys);
    if (p.logic !== undefined) put('selectiveLogic', LB_LOGIC_TO_ST[p.logic] ?? 0);
    if (p.filters !== undefined) put('keysecondary', p.filters);
    if (p.scan_depth !== undefined) put('scanDepth', p.scan_depth === 'same_as_global' ? null : p.scan_depth);
    if (p.case_sensitive !== undefined) put('caseSensitive', p.case_sensitive === 'same_as_global' ? null : p.case_sensitive);
    if (p.match_whole_words !== undefined) put('matchWholeWords', p.match_whole_words === 'same_as_global' ? null : p.match_whole_words);
    if (p.use_group_scoring !== undefined) put('useGroupScoring', p.use_group_scoring === 'same_as_global' ? null : p.use_group_scoring);
    if (p.automation_id !== undefined) put('automationId', p.automation_id === null ? '' : p.automation_id);
    if (p.exclude_recursion !== undefined) put('excludeRecursion', p.exclude_recursion);
    if (p.prevent_recursion !== undefined) put('preventRecursion', p.prevent_recursion);
    if (p.delay_until_recursion !== undefined) put('delayUntilRecursion', p.delay_until_recursion);
    put('content', p.content);
    if (p.group !== undefined) put('group', p.group);
    if (p.group_prioritized !== undefined) put('groupOverride', p.group_prioritized);
    if (p.group_weight !== undefined) put('groupWeight', p.group_weight);
    if (p.sticky !== undefined) put('sticky', p.sticky === null ? 0 : p.sticky);
    if (p.cooldown !== undefined) put('cooldown', p.cooldown === null ? 0 : p.cooldown);
    if (p.delay !== undefined) put('delay', p.delay === null ? 0 : p.delay);
    return st;
}
/** TH patch 合进 TH 视图 entry(setLorebookEntries 的 _.merge 语义,数组/标量替)。 */
function deepAssignThEntry(dst, patch) {
    for (const [k, v] of Object.entries(patch)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        dst[k] = v;
    }
}
const LB_DEFAULTS = {
    key: [], keysecondary: [], comment: '', content: '', constant: false,
    vectorized: false, selective: true, selectiveLogic: 0, addMemo: true,
    order: 100, position: 0, disable: false, excludeRecursion: false,
    preventRecursion: false, matchPersonaDescription: false,
    matchCharacterDescription: false, matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false, matchScenario: false,
    matchCreatorNotes: false, delayUntilRecursion: 0, probability: 100,
    useProbability: true, depth: 4, group: '', groupOverride: false,
    groupWeight: 100, scanDepth: null, caseSensitive: null,
    matchWholeWords: null, useGroupScoring: null, automationId: '',
    role: 0, sticky: null, cooldown: null, delay: null,
};
/** TH 视图 → {entries:{uid:ST原档}}(collision 消解+display_index 兜底)。 */
function thEntriesToStDoc(thEntries) {
    const used = new Set();
    let nextIndex = Math.max(-1, ...thEntries.map((e) => e.display_index ?? -1)) + 1;
    const doc = { entries: {} };
    for (const e of thEntries) {
        let uid = Number(e.uid);
        if (!Number.isFinite(uid) || used.has(uid)) { uid = 0; while (used.has(uid) && uid < 1_000_000) uid++; }
        used.add(uid);
        const st = { ...LB_DEFAULTS, ...thPatchToSt({ ...e, uid, display_index: e.display_index ?? nextIndex++ }) };
        st.selective = !(st.constant || st.vectorized);
        doc.entries[uid] = st;
    }
    return doc;
}
function lorebookToTh(doc) {
    return Object.values(doc?.entries ?? {})
        .map(stEntryToTh)
        .sort((a, b) => (a.display_index ?? 0) - (b.display_index ?? 0));
}
async function resolveLorebook(ctx2, rawName) {
    const name = String(rawName ?? '').trim();
    if (!name) return { ok: false, status: 400, error: 'args.lorebook required' };
    let safe;
    try { safe = safeName(name, 'args.lorebook'); } catch (e) { return { ok: false, status: 400, error: String(e?.message ?? e) }; }
    const canonical = await getWorldInfoRepo().resolveName(ctx2.handle, safe);
    return { ok: true, name: canonical ?? safe };
}
/**
 * 书 RMW:resolve → get → toTh[] → mutate → toStDoc → save。
 * mutate 返回数组(全量新表)或 {entries, extra}。成功 result 始终含最新 entries。
 */
async function lorebookMutate(ctx2, rawName, mutate) {
    const resolved = await resolveLorebook(ctx2, rawName);
    if (!resolved.ok) return resolved;
    const repo = getWorldInfoRepo();
    const doc = await repo.get(ctx2.handle, resolved.name);
    if (!doc) return { ok: false, status: 404, error: `lorebook not found: ${rawName}` };
    const thEntries = lorebookToTh(doc);
    const r = mutate(thEntries);
    const nextEntries = Array.isArray(r) ? r : r?.entries;
    const extra = Array.isArray(r) ? {} : (r?.extra ?? {});
    if (!Array.isArray(nextEntries)) return { ok: false, status: 400, error: 'mutator must return entries' };
    await repo.save(ctx2.handle, resolved.name, thEntriesToStDoc(nextEntries));
    return { ok: true, result: { name: resolved.name, entries: lorebookToTh(await repo.get(ctx2.handle, resolved.name)), ...extra } };
}

// ── 正则助手(TavernRegex 视图 ↔ RegexScriptData) ──────────────────
/** 'name.png'/'name'/'current' → charDir(TH character 形参同款)。 */
function resolveCharTarget(name) {
    if (!name || name === 'current') return null;
    return String(name).replace(/\.png$/i, '');
}
function toTavernRegexView(s) {
    const placement = Array.isArray(s?.placement) ? s.placement : [];
    const n = (v) => typeof v === 'number' ? v : null;
    return {
        id: s?.id,
        script_name: s?.scriptName ?? '',
        enabled: !s?.disabled,
        find_regex: s?.findRegex ?? '',
        trim_strings: Array.isArray(s?.trimStrings) ? s.trimStrings : [],
        replace_string: s?.replaceString ?? '',
        source: {
            user_input: placement.includes(regex_placement.USER_INPUT),
            ai_output: placement.includes(regex_placement.AI_OUTPUT),
            slash_command: placement.includes(regex_placement.SLASH_COMMAND),
            world_info: placement.includes(regex_placement.WORLD_INFO),
            reasoning: placement.includes(regex_placement.REASONING),
        },
        destination: { display: !!s?.markdownOnly, prompt: !!s?.promptOnly },
        run_on_edit: !!s?.runOnEdit,
        min_depth: n(s?.minDepth),
        max_depth: n(s?.maxDepth),
    };
}
function fromTavernRegexView(r) {
    const src = r?.source ?? {};
    const placement = [
        ...(src.user_input ? [regex_placement.USER_INPUT] : []),
        ...(src.ai_output ? [regex_placement.AI_OUTPUT] : []),
        ...(src.slash_command ? [regex_placement.SLASH_COMMAND] : []),
        ...(src.world_info ? [regex_placement.WORLD_INFO] : []),
        ...(src.reasoning ? [regex_placement.REASONING] : []),
    ];
    const dest = r?.destination ?? {};
    return {
        id: r?.id,
        scriptName: r?.script_name ?? '',
        disabled: !r?.enabled,
        runOnEdit: !!r?.run_on_edit,
        findRegex: r?.find_regex ?? '',
        trimStrings: Array.isArray(r?.trim_strings) ? r.trim_strings : [],
        replaceString: r?.replace_string ?? '',
        placement,
        minDepth: r?.min_depth ?? null,
        maxDepth: r?.max_depth ?? null,
        markdownOnly: !!dest.display,
        promptOnly: !!dest.prompt,
    };
}
/** regex 三域读:global(settings)/character(卡)/preset(preset repo)。 */
async function readRegexScope(ctx2, a) {
    const type = a?.type ?? 'global';
    if (type === 'global') {
        const settings = await getSettingsRepo().get(ctx2.handle) ?? {};
        return { scripts: Array.isArray(settings?.extension_settings?.regex) ? settings.extension_settings.regex : [] };
    }
    if (type === 'character') {
        const charDir = resolveCharTarget(a?.name) ?? ctx2.charDir;
        if (!charDir) return { error: 'character scope requires name or target.charDir', status: 400 };
        try {
            const card = await loadCard(ctx2.directories, charDir);
            if (!card) return { error: `character not found: ${charDir}`, status: 404 };
            const scoped = card?.data?.extensions?.regex_scripts ?? card?.extensions?.regex_scripts;
            return { scripts: Array.isArray(scoped) ? scoped : [] };
        } catch (e) { return { error: String(e?.message ?? e), status: 404 }; }
    }
    if (type === 'preset') {
        const apiId = a?.api_id ?? a?.apiId ?? 'openai';
        const presetName = a?.name === 'in_use' ? a?.preset_in_use ?? a?.name : a?.name;
        if (!presetName || presetName === 'in_use') {
            return { error: "preset scope requires name('in_use' 解析未实——传具体预设名)", status: 400 };
        }
        const doc = await getPresetRepo().get(ctx2.handle, apiId, safeName(String(presetName), 'args.name'));
        if (!doc) return { error: `preset not found: ${apiId}/${presetName}`, status: 404 };
        return { scripts: Array.isArray(doc?.extensions?.regex_scripts) ? doc.extensions.regex_scripts : [] };
    }
    return { error: `type must be global|character|preset`, status: 400 };
}
/** 卡文件写面(.json 原子写;.png 走 writeCharacterData 懒加载;.webp 拒)。 */
async function writeCardRegexScripts(ctx2, charDir, scripts) {
    const dir = ctx2.directories.characters;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const candidates = ['.png', '.webp', '.json'].map((ext) => ({ file: path.join(dir, `${charDir}${ext}`), ext }));
    const target = candidates.find((c) => fs.existsSync(c.file));
    if (!target) return { error: `character file not found: ${charDir}`, status: 404 };
    if (target.ext === '.webp') {
        return { error: `scoped regex write supports .png/.json cards only: ${charDir}.webp`, status: 400 };
    }
    let card;
    if (target.ext === '.json') {
        card = JSON.parse(await fs.promises.readFile(target.file, 'utf8'));
    } else {
        const { readCharacterData } = await import('../endpoints/characters.js');
        card = JSON.parse(await readCharacterData(target.file, 'png'));
    }
    if (!card.data || typeof card.data !== 'object' || Array.isArray(card.data)) card.data = {};
    if (!card.data.extensions || typeof card.data.extensions !== 'object' || Array.isArray(card.data.extensions)) {
        card.data.extensions = {};
    }
    card.data.extensions.regex_scripts = scripts;
    if (card.extensions && typeof card.extensions === 'object') delete card.extensions.regex_scripts;
    if (card.spec === undefined) { card.spec = 'chara_card_v2'; card.spec_version = '2.0'; }
    if (target.ext === '.json') {
        const { sync: writeFileAtomicSync } = await import('write-file-atomic');
        writeFileAtomicSync(target.file, JSON.stringify(card, null, 2), 'utf8');
    } else {
        const { writeCharacterData } = await import('../endpoints/characters.js');
        const fakeReq = { user: { profile: { handle: ctx2.handle, name: ctx2.userName } }, lastWriteCharacterDataError: undefined };
        const ok = await writeCharacterData(target.file, JSON.stringify(card), charDir, fakeReq, undefined,
            { allowMissingInputFallback: false, requireExistingOutput: true });
        if (!ok) return { error: fakeReq.lastWriteCharacterDataError ?? 'character card write failed', status: 500 };
    }
    return { ok: true };
}
async function resolveAvatarName(directories, charDir) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const ext of ['.png', '.webp']) {
        if (fs.existsSync(path.join(directories.characters, `${charDir}${ext}`))) return `${charDir}${ext}`;
    }
    return `${charDir}.json`;
}
/** 真宏上下文:chat/chatMetadata/globalVariables 缺一即炸(getChatIdHash 等)。 */
async function buildSubstCtx(ctx2, settings = null) {
    const s = settings ?? (await getSettingsRepo().get(ctx2.handle)) ?? {};
    let chatDoc = null;
    if (ctx2.charDir && ctx2.chatName) {
        try { chatDoc = await getChatRepo().get(ctx2.handle, ctx2.charDir, ctx2.chatName); } catch { chatDoc = null; }
    }
    return {
        chat: Array.isArray(chatDoc?.body) ? chatDoc.body : [],
        chatMetadata: { ...(chatDoc?.header?.chat_metadata ?? {}) },
        globalVariables: s?.extension_settings?.variables?.global ?? {},
        name1: ctx2.userName ?? 'User',
        name2: ctx2.charDir ?? '',
        currentChatId: ctx2.chatName ?? '',
    };
}

// ── displayed_message 助手(TH displayed_message.ts 对齐) ──────────────
/** TH message_id 解析:'last'|'latest'|'last_user'|'last_char'|number(负从尾)。
 *  命中 → 下标;未命中 → null(TH 抛错面由调用方落成 ok:false)。 */
function resolveFloorId(mid, body) {
    if (mid === undefined || mid === null || mid === 'last' || mid === 'latest') {
        return body.length ? body.length - 1 : null;
    }
    if (mid === 'last_user') {
        for (let i = body.length - 1; i >= 0; i--) {
            if (body[i]?.is_user && !body[i]?.is_system) return i;
        }
        return null;
    }
    if (mid === 'last_char') {
        for (let i = body.length - 1; i >= 0; i--) {
            if (body[i] && !body[i].is_user && !body[i].is_system) return i;
        }
        return null;
    }
    const n = normMessageId(mid, body.length);
    return (n !== null && n >= 0 && n < body.length) ? n : null;
}
/** 展示车道 runner:settings+substCtx+卡作用域脚本(collectRegexScripts
 *  卡域恒放行口径,与 chats 读面 mes_display 同链)。 */
async function displayFloorRunner(ctx2) {
    const settings = (await getSettingsRepo().get(ctx2.handle)) ?? {};
    const substCtx = await buildSubstCtx(ctx2, settings);
    let card = null;
    if (ctx2.charDir) {
        try { card = await loadCard(ctx2.directories, ctx2.charDir); } catch { card = null; }
    }
    return { runner: createFloorRegexRunner(settings, substCtx, { card, charDir: ctx2.charDir }), substCtx };
}
/** 楼层展示深度:非系统楼从尾数(与 projectChatFloorsForDisplay 同口径)。 */
function floorDisplayDepth(body, idx) {
    if (body[idx]?.is_system) return undefined;
    const tail = body.slice(idx).filter((m) => m && !m.is_system).length;
    return tail - 1;
}
/** regex 三域写:global=settings repo.update(原子 RMW);character=卡文件;preset=repo patch。 */
async function writeRegexScope(ctx2, a, scripts) {
    const type = a?.type ?? 'global';
    if (type === 'global') {
        const repo = getSettingsRepo();
        // update:缺席文档落 base、事务内原子 RMW(比 get+patch 干净,免 404)
        await repo.update(ctx2.handle, (doc) => {
            const out = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {};
            if (typeof out.extension_settings !== 'object' || out.extension_settings === null || Array.isArray(out.extension_settings)) {
                out.extension_settings = {};
            }
            out.extension_settings.regex = scripts;
            return out;
        });
        return { ok: true };
    }
    if (type === 'character') {
        const charDir = resolveCharTarget(a?.name) ?? ctx2.charDir;
        if (!charDir) return { error: 'character scope requires name or target.charDir', status: 400 };
        return writeCardRegexScripts(ctx2, charDir, scripts);
    }
    if (type === 'preset') {
        const apiId = a?.api_id ?? a?.apiId ?? 'openai';
        const presetName = a?.name === 'in_use' ? a?.preset_in_use ?? a?.name : a?.name;
        if (!presetName || presetName === 'in_use') {
            return { error: "preset scope requires name('in_use' 解析未实——传具体预设名)", status: 400 };
        }
        const safe = safeName(String(presetName), 'args.name');
        const doc = await getPresetRepo().get(ctx2.handle, apiId, safe);
        if (!doc) return { error: `preset not found: ${apiId}/${presetName}`, status: 404 };
        const ops = [];
        if (typeof doc.extensions !== 'object' || doc.extensions === null || Array.isArray(doc.extensions)) {
            ops.push({ op: 'add', path: '/extensions', value: {} });
        }
        const cur = doc?.extensions?.regex_scripts;
        if (cur === undefined) ops.push({ op: 'add', path: '/extensions/regex_scripts', value: scripts });
        else ops.push({ op: 'test', path: '/extensions/regex_scripts', value: cur }, { op: 'replace', path: '/extensions/regex_scripts', value: scripts });
        await getPresetRepo().patch(ctx2.handle, apiId, safe, ops);
        return { ok: true };
    }
    return { error: 'type must be global|character|preset', status: 400 };
}

/** 监听器定位:listener_id 优先;否则取该 event 最近一条(TH 形参 fn 不可序列化)。 */
function findListenerIndex(doc, a) {
    const lid = String(a?.listener_id ?? '').trim();
    if (lid) return doc.listeners.findIndex((l) => l.id === lid);
    const ev = eventName(a);
    if (!ev) return -1;
    for (let i = doc.listeners.length - 1; i >= 0; i--) {
        if (doc.listeners[i].event === ev) return i;
    }
    return -1;
}

/**
 * 变量域解析:scope → {store, persist}。
 * chat → chatMetadata.variables(活引用,persist=updateChatMetadata)
 * global → settings.extension_settings.variables.global(persist=整档 save)
 * message → chat body 消息对象的 variables 字段(persist=整存 chat)
 */
async function resolveScope({ handle, scope, charDir, chatName, messageId }) {
    const repo = getChatRepo();
    if (scope === 'global') {
        const settings = (await getSettingsRepo().get(handle)) ?? {};
        const vars = (settings.extension_settings ??= {}).variables ??= {};
        if (typeof vars.global !== 'object' || vars.global === null) vars.global = {};
        return {
            store: vars.global,
            settings,
            persist: async () => { await getSettingsRepo().save(handle, settings); },
        };
    }
    if (!charDir || !chatName) {
        return { error: `scope '${scope}' requires target.charDir + target.chatName`, status: 400 };
    }
    const doc = await repo.get(handle, charDir, chatName);
    if (!doc) return { error: `Chat not found: ${charDir}/${chatName}`, status: 404 };
    const header = doc.header ?? {};
    if (typeof header.chat_metadata !== 'object' || header.chat_metadata === null) header.chat_metadata = {};
    if (scope === 'chat') {
        if (typeof header.chat_metadata.variables !== 'object' || header.chat_metadata.variables === null) {
            header.chat_metadata.variables = {};
        }
        return {
            store: header.chat_metadata.variables,
            persist: async () => {
                await repo.updateChatMetadata(handle, charDir, chatName, header.chat_metadata);
            },
        };
    }
    // scope==='message':TH 生态惯例是 message.data 袋(MVU 楼层快照
    // 即 data.stat_data/mvu_data);ST /setvar 的 message 变量走
    // message.variables。读:data 优先、variables 兜底合并;写:进 data。
    const body = Array.isArray(doc.body) ? doc.body : [];
    // TH normalizeMessageId:负数从尾数;'latest'/非整数 → 末楼
    const mid = normMessageId(messageId, body.length) ?? body.length - 1;
    const msg = body[mid];
    if (!msg) return { error: `message ${mid} not found`, status: 404 };
    if (typeof msg.data !== 'object' || msg.data === null) msg.data = {};
    const store = (typeof msg.variables === 'object' && msg.variables !== null)
        ? { ...msg.variables, ...msg.data }
        : msg.data;
    if (store !== msg.data) Object.assign(msg.data, store);
    return {
        store: msg.data,
        persist: async () => {
            await repo.save(handle, charDir, chatName, header, body);
        },
    };
}

const METHODS = {
    async getVariables(a, scope) {
        const v = a?.path ? getPath(scope.store, a.path) : scope.store;
        return { ok: true, result: v ?? (a?.path ? undefined : scope.store) };
    },
    async replaceVariables(a, scope) {
        const vars = a?.variables;
        if (!isPlainObj(vars)) {
            return { ok: false, status: 400, error: 'args.variables must be an object' };
        }
        // 护栏(GH#4):TH 语义就是全量替换(_.set(variables)),但静默丢根是
        // 真事故——顶层根或 stat_data 内根将要消失且未显式确认 → 拒绝+明细。
        // force:true 时照写不误,但把丢根名单回执+warnings 留痕。
        const lostRoots = Object.keys(scope.store).filter((k) => !(k in vars));
        let lostStatRoots = [];
        if (isPlainObj(scope.store.stat_data) && isPlainObj(vars.stat_data)) {
            lostStatRoots = Object.keys(scope.store.stat_data).filter((k) => !(k in vars.stat_data));
        }
        if ((lostRoots.length || lostStatRoots.length) && a?.force !== true) {
            return {
                ok: false, status: 400, code: 'root_loss',
                error: 'replaceVariables 将丢失既有变量根',
                lost_roots: lostRoots,
                lost_stat_data_roots: lostStatRoots,
                hint: '全量覆盖是预期行为则传 args.force:true;否则改用 insertOrAssignVariables(深合)或 updateVariablesWith。',
            };
        }
        // GH#4 结构校验:写 stat_data 且本域存在 schema(变量包自带 schema
        // 优先,否则用域内既有 schema)时,stat_data 必须合 schema——
        // isMvuData 只查顶层键在不在,坏的嵌套值(type 错/缺 required/
        // 非 extensible 下多键)放进去,卡下次读到的是崩掉的世界观。
        // 失败 → 400 + 逐路径错,一字不落盘;force:true 降级为 warnings。
        const schemaNode = isObjectSchema(vars.schema) ? vars.schema
            : (isObjectSchema(scope.store?.schema) ? scope.store.schema : null);
        let schemaErrors = [];
        if (schemaNode && vars.stat_data !== undefined) {
            schemaErrors = validateStatDataAgainstSchema(vars.stat_data, schemaNode);
        }
        if (schemaErrors.length && a?.force !== true) {
            return {
                ok: false, status: 400, code: 'mvu_schema',
                error: `stat_data violates schema (${schemaErrors.length} error${schemaErrors.length > 1 ? 's' : ''})`,
                schema_errors: schemaErrors,
                hint: '逐 path 修正 stat_data;确知在干什么是则传 args.force:true(违规明细会进 warnings 留痕)。',
            };
        }
        const warnings = [];
        if (lostRoots.length) warnings.push(`lost_roots: ${lostRoots.join('/')}`);
        if (lostStatRoots.length) warnings.push(`lost stat_data roots: ${lostStatRoots.join('/')}`);
        if (schemaErrors.length) warnings.push(`schema_errors(force): ${schemaErrors.map((e) => e.path || 'stat_data').join(', ')}`);
        for (const k of Object.keys(scope.store)) delete scope.store[k];
        Object.assign(scope.store, vars);
        await scope.persist();
        return {
            ok: true,
            ...(warnings.length ? { warnings } : {}),
            ...(schemaErrors.length ? { schema_errors: schemaErrors } : {}),
        };
    },
    async insertOrAssignVariables(a, scope) {
        const vars = a?.variables;
        if (!isPlainObj(vars)) {
            return { ok: false, status: 400, error: 'args.variables must be an object' };
        }
        // TH mergeWith 语义:嵌套对象深合、数组/标量整体替换;
        // 带点键名走路径合写(生态扩展,兼容 /setvar 形)。
        for (const [k, v] of Object.entries(vars)) {
            if (k.includes('.')) { setPath(scope.store, k, v); continue; }
            if (unsafeSegs(k)) continue;
            const cur = scope.store[k];
            scope.store[k] = (isPlainObj(cur) && isPlainObj(v)) ? mergeDeep(cur, v) : v;
        }
        await scope.persist();
        return { ok: true };
    },
    /** TH insertVariables:defaultsDeep——只补缺失键,不动既有值。 */
    async insertVariables(a, scope) {
        const vars = a?.variables;
        if (!isPlainObj(vars)) {
            return { ok: false, status: 400, error: 'args.variables must be an object' };
        }
        const fill = (dst, src) => {
            for (const [k, v] of Object.entries(src)) {
                if (unsafeSegs(k)) continue;
                if (dst[k] === undefined) dst[k] = v;
                else if (isPlainObj(dst[k]) && isPlainObj(v)) fill(dst[k], v);
            }
        };
        fill(scope.store, vars);
        await scope.persist();
        return { ok: true };
    },
    /** TH updateVariablesWith:shim 卡侧跑 updater(收全量→返回新全量),
     *  ship result → 全量替换(TH 本体即 replaceVariables(result))。
     *  根护栏只管 replaceVariables 原语;updater 拿的是整文档,删根是其选择。 */
    async updateVariablesWith(a, scope) {
        const vars = a?.result ?? a?.variables;
        if (!isPlainObj(vars)) {
            return { ok: false, status: 400, error: 'args.result must be an object' };
        }
        for (const k of Object.keys(scope.store)) delete scope.store[k];
        Object.assign(scope.store, vars);
        await scope.persist();
        return { ok: true };
    },
    async deleteVariable(a, scope) {
        const path = String(a?.path ?? '');
        if (!path) return { ok: false, status: 400, error: 'args.path required' };
        const existed = delPath(scope.store, path);
        await scope.persist();
        return { ok: true, existed };
    },
    async getChatMessages(a, scope, ctx2) {
        const { handle, charDir, chatName } = ctx2;
        if (!charDir || !chatName) {
            return { ok: false, status: 400, error: 'target.charDir + target.chatName required' };
        }
        const doc = await getChatRepo().get(handle, charDir, chatName);
        if (!doc) return { ok: false, status: 404, error: 'chat not found' };
        const body = Array.isArray(doc.body) ? doc.body : [];
        const start = Math.max(0, Number(a?.start ?? 0));
        const end = a?.end !== undefined ? Number(a.end) : body.length;
        const slice = body.slice(start, end === -1 ? body.length : end);
        return {
            ok: true,
            result: slice.map((m, i) => ({
                message_id: start + i,
                role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
                name: m.name,
                mes: m.mes,
                is_user: !!m.is_user,
                is_system: !!m.is_system,
                swipe_id: m.swipe_id,
                swipes: m.swipes,
                variables: m.variables,
                send_date: m.send_date,
                extra: m.extra,
            })),
        };
    },
    async triggerSlash(a, _scope, ctx2) {
        const script = String(a?.script ?? a?.input ?? '');
        if (!script.trim()) return { ok: false, status: 400, error: 'args.script required' };
        const built = await buildStscriptEnv(ctx2);
        if (built.error) return { ok: false, status: built.status ?? 500, error: built.error };
        const r = await executeSlashCommandsWithOptions(built.env, script);
        return {
            ok: true,
            result: r?.pipe ?? r ?? null,
            ops: built.env.ops,
            notifications: built.sinks.notifications,
        };
    },
    /**
     * 辅助生成(GH#9):TH generate——走 quiet-generation 同链
     * (buildGenerationContext → dispatch → job 终态,persist_target=none,
     * 不落楼层)。TH config 面:user_input(→quietPrompt 系统注入)、
     * max_tokens/responseLength、stop、trimToSentence、timeout_ms、quiet_name;
     * 生命周期经信箱推 generation_requested/started/ended|stopped。
     */
    async generate(a, _scope, ctx2) {
        if (!ctx2.charDir || !ctx2.chatName) {
            return { ok: false, status: 400, error: 'target.charDir + target.chatName required' };
        }
        const prompt = a?.user_input ?? a?.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            return { ok: false, status: 400, error: 'args.user_input (string) required' };
        }
        // 未映射的 TH config 键——收下不装死,回执 warnings 明示被忽略。
        const ignored = ['injects', 'overrides', 'custom_api', 'should_stream', 'image',
            'tools', 'json_schema', 'max_chat_history', 'should_silence']
            .filter((k) => a?.[k] !== undefined);
        const warnings = ignored.length ? [`th.generate 暂未映射参数: ${ignored.join(',')}`] : [];
        // GH#9 lorebookEntries 选择性 WI 注入:圈定本轮参与组装的世界书
        // 条目(ref 形:'书名'|'书名:uid'|{book,uid|comment}——见
        // generate-context.js resolveLorebookEntryRefs)。persist_target
        // 恒 none 不动;全部未命中 → 组装侧 lorebook_entries_unresolved → 400。
        const lorebookEntries = a?.lorebookEntries ?? a?.lorebook_entries;
        if (lorebookEntries !== undefined
            && !Array.isArray(lorebookEntries)
            && (typeof lorebookEntries !== 'object' || lorebookEntries === null)
            && typeof lorebookEntries !== 'string') {
            return {
                ok: false, status: 400,
                error: 'args.lorebookEntries must be an array of refs (book | book:uid | {book,uid|comment})',
            };
        }

        await recordThEvent(ctx2, 'generation_requested', [{ type: 'quiet', via: 'th.generate' }]);
        try {
            // 延迟载入:quiet-generation 顶层 import generate-context → 拖 config
            // 依赖进插件 import 图,单测进程会被拖死(同文件内 loadDispatchLayer 理由)。
            const { runQuietGeneration } = await import('../services/quiet-generation.js');
            await recordThEvent(ctx2, 'generation_started', ['quiet']);
            const r = await runQuietGeneration({
                handle: ctx2.handle,
                directories: ctx2.directories,
                charDir: ctx2.charDir,
                chatName: ctx2.chatName,
                prompt,
                params: {
                    responseLength: Number(a?.max_tokens ?? a?.responseLength ?? 0) || 0,
                    stop: a?.stop,
                    trimToSentence: !!a?.trim_to_sentence || !!a?.trimToSentence,
                    quietName: a?.quiet_name ? String(a.quiet_name) : undefined,
                    ...(lorebookEntries !== undefined ? { lorebookEntries } : {}),
                },
                userName: ctx2.userName ?? 'User',
                timeoutMs: Number(a?.timeout_ms ?? 0) || 180_000,
            });
            // 部分 ref 未命中:跑完但回执点名(全部未命中走 catch → 400)。
            if (r.lorebook?.unresolved?.length) {
                warnings.push(`lorebookEntries 未命中: ${r.lorebook.unresolved.join(', ')}`);
            }
            // TH GENERATION_ENDED 语义:负载=最终文本。
            await recordThEvent(ctx2, 'generation_ended', [r.text ?? '']);
            return {
                ok: true,
                result: {
                    text: r.text ?? '', jobId: r.jobId, status: r.status, diagId: r.diagId,
                    ...(r.lorebook ? { lorebook: r.lorebook } : {}),
                },
                ...(warnings.length ? { warnings } : {}),
            };
        } catch (error) {
            const msg = String(error?.message ?? error ?? 'generate failed');
            await recordThEvent(ctx2, 'generation_stopped', [msg.slice(0, 300)]);
            // GH#9:圈定 ref 全部未命中是调用方参数错(400),不是后端事故(502)。
            const isUnresolved = error?.code === 'lorebook_entries_unresolved'
                || String(msg).startsWith('lorebookEntries unresolved');
            const status = isUnresolved ? 400 : 502;
            // 部分未命中 + 生成事故同发:未命中名单不随事故吞掉(error.lorebook
            // 由 quiet-generation 失败路径回填)。
            if (error?.lorebook?.unresolved?.length) {
                warnings.push(`lorebookEntries 未命中: ${error.lorebook.unresolved.join(', ')}`);
            }
            thEvent('th_generate_failed', `th generate failed: ${msg.slice(0, 200)}`,
                { method: 'generate', charDir: ctx2.charDir, chatName: ctx2.chatName, status, error });
            return {
                ok: false, status, error: msg,
                ...(error?.detail ? { unresolved: error.detail } : {}),
                ...(error?.lorebook ? { lorebook: error.lorebook } : {}),
                ...(warnings.length ? { warnings } : {}),
            };
        }
    },
    /**
     * TH generateRaw:不走当前预设的自定义生成。最小可用面(GH#9):
     * prompt/user_input → quietPrompt 直通(仍经预设参数+组装,但安静注入);
     * ordered_prompts(真自定义消息序)在 quiet 链无映射 → 诚实 unsupported。
     */
    async generateRaw(a, scope, ctx2) {
        if (a?.ordered_prompts !== undefined) {
            return {
                ok: false, unsupported: true, method: 'generateRaw',
                error: 'ordered_prompts(自定义消息序)未映射——quiet 链只接安静注入;请用 prompt/user_input',
            };
        }
        return METHODS.generate(a, scope, ctx2);
    },
    /** 身份面:CardApp 面板的 getCharacter/getCurrentCharacterName。 */
    async getCharacter(_a, _scope, ctx2) {
        if (!ctx2.charDir) return { ok: false, status: 400, error: 'target.charDir required' };
        const card = await loadCard(ctx2.directories, ctx2.charDir);
        if (!card) return { ok: false, status: 404, error: 'card not found' };
        return { ok: true, result: { name: card?.data?.name ?? card?.name, avatar: `${ctx2.charDir}.png`, data: card?.data ?? card } };
    },
    async getCurrentCharacterName(_a, _scope, ctx2) {
        if (!ctx2.charDir) return { ok: false, status: 400, error: 'target.charDir required' };
        const card = await loadCard(ctx2.directories, ctx2.charDir);
        return { ok: true, result: card?.data?.name ?? card?.name ?? ctx2.charDir };
    },
    /** 消息 id 面:TH 语义是数组下标。 */
    async getLastMessageId(_a, _scope, ctx2) {
        if (!ctx2.charDir || !ctx2.chatName) return { ok: true, result: -1 };
        const doc = await getChatRepo().get(ctx2.handle, ctx2.charDir, ctx2.chatName);
        return { ok: true, result: (Array.isArray(doc?.body) ? doc.body.length : 0) - 1 };
    },
    async getCurrentMessageId(_a, _scope, ctx2) {
        return METHODS.getLastMessageId(_a, _scope, ctx2);
    },
    /** 卡嵌脚本面:data.extensions.th_scripts(TH 生态契约;条目兼容
     *  纯字符串与 {name,script} 两形)。 */
    async getEmbeddedScripts(_a, _scope, ctx2) {
        if (!ctx2.charDir) return { ok: false, status: 400, error: 'target.charDir required' };
        const card = await loadCard(ctx2.directories, ctx2.charDir);
        if (!card) return { ok: false, status: 404, error: 'card not found' };
        // 生态里的真实键:TavernHelper_scripts(数组)/tavern_helper.scripts(对象)
        // ——th_scripts 是早期误记的键,保留兜底。
        const ext = card?.data?.extensions ?? {};
        const raw = ext.TavernHelper_scripts ?? ext.tavern_helper?.scripts ?? ext.th_scripts ?? [];
        const list = (Array.isArray(raw) ? raw : [raw])
            .map((s, i) => typeof s === 'string'
                ? { name: `script-${i}`, script: s }
                : { name: s?.name ?? `script-${i}`, script: s?.script ?? s?.content ?? '' })
            .filter(s => s.script);
        return { ok: true, result: list };
    },

    // ── 消息写家族(T1):TH 字段名 → ST 楼层形;写后信箱事件 ──────────
    /** {chat_messages:[{message_id, name?, role?, is_hidden?, message?, data?,
     *  extra?, swipe_id?, swipes?, swipes_data?, swipes_info?}], refresh?} */
    async setChatMessages(a, _scope, ctx2) {
        const list = Array.isArray(a?.chat_messages) ? a.chat_messages : null;
        if (!list?.length) return { ok: false, status: 400, error: 'args.chat_messages must be a non-empty array' };
        const r = await mutateChatBody(ctx2, (body) => {
            const edits = new Set();
            for (const patch of list) {
                const mid = normMessageId(patch?.message_id, body.length);
                if (mid === null || mid < 0 || mid >= body.length) continue;
                const m = body[mid];
                if (!m || typeof m !== 'object') continue;
                applyThMessagePatch(m, patch);
                edits.add(mid);
            }
            return { affected: [...edits] };
        });
        if (r.error) return { ok: false, status: r.status ?? 500, error: r.error };
        for (const mid of r.out.affected) await recordThEvent(ctx2, 'message_edited', [mid]);
        if (r.out.affected.length) await recordThEvent(ctx2, 'chat_changed', [{ chat: ctx2.chatName }]);
        return { ok: true, result: { edited: r.out.affected } };
    },
    /** 单楼便捷写:TH setChatMessage(message, message_id, option)。 */
    async setChatMessage(a, _scope, ctx2) {
        const mid = Number(a?.message_id);
        if (!Number.isInteger(mid)) return { ok: false, status: 400, error: 'args.message_id required' };
        const patch = { message_id: mid };
        if (typeof a?.message === 'string') patch.message = a.message;
        else if (a?.message && typeof a.message === 'object') Object.assign(patch, a.message);
        for (const k of ['name', 'role', 'is_hidden', 'data', 'extra', 'swipes', 'swipe_id', 'swipes_data', 'swipes_info']) {
            if (a?.[k] !== undefined) patch[k] = a[k];
        }
        return METHODS.setChatMessages({ chat_messages: [patch], refresh: a?.refresh }, _scope, ctx2);
    },
    /** {chat_messages:[{role, message, name?, is_hidden?, data?, extra?}],
     *  insert_before?:number|'end', refresh?} — TH role/message 必填。 */
    async createChatMessages(a, _scope, ctx2) {
        const list = Array.isArray(a?.chat_messages) ? a.chat_messages : null;
        if (!list?.length) return { ok: false, status: 400, error: 'args.chat_messages must be a non-empty array' };
        const roles = new Set(['user', 'assistant', 'system']);
        for (const [i, m] of list.entries()) {
            if (!roles.has(m?.role) || typeof m?.message !== 'string') {
                return { ok: false, status: 400, error: `chat_messages[${i}]: role(user|assistant|system) + message(string) required` };
            }
        }
        // 默认名:system→'system' user→persona assistant→卡名(TH convert 同款)。
        let charName = ctx2.charDir;
        try { const c = ctx2.charDir && await loadCard(ctx2.directories, ctx2.charDir); charName = c?.data?.name ?? c?.name ?? charName; } catch { /* 名兜底 */ }
        const insertAt = a?.insert_at ?? a?.insert_before ?? 'end';
        const r = await mutateChatBody(ctx2, (body) => {
            const at = insertAt === 'end' ? body.length
                : Math.max(0, Math.min(body.length, normMessageId(insertAt, body.length) ?? body.length));
            const created = list.map((m) => {
                const msg = {
                    name: m.name ?? (m.role === 'system' ? 'system' : m.role === 'user' ? (ctx2.userName || 'User') : charName),
                    is_user: m.role === 'user',
                    is_system: m.is_hidden ?? false,
                    mes: m.message,
                    send_date: Date.now(),
                };
                if (m.extra) msg.extra = m.extra;
                else if (m.role === 'system') msg.extra = { type: 'narrator' };
                if (m.data) msg.variables = [m.data];
                return msg;
            });
            body.splice(at, 0, ...created);
            return { at, ids: created.map((_, i) => at + i), msgs: created };
        });
        if (r.error) return { ok: false, status: r.status ?? 500, error: r.error };
        // TH:MESSAGE_SENT(自建 user 楼)/MESSAGE_RECEIVED(其它)+ 渲染事件由宿主泵补。
        for (const [i, mid] of r.out.ids.entries()) {
            await recordThEvent(ctx2, r.out.msgs[i].is_user ? 'message_sent' : 'message_received', [mid]);
        }
        await recordThEvent(ctx2, 'chat_changed', [{ chat: ctx2.chatName }]);
        return { ok: true, result: { message_ids: r.out.ids, count: r.out.ids.length } };
    },
    async deleteChatMessages(a, _scope, ctx2) {
        const ids = Array.isArray(a?.message_ids) ? a.message_ids : null;
        if (!ids?.length) return { ok: false, status: 400, error: 'args.message_ids must be a non-empty array' };
        const r = await mutateChatBody(ctx2, (body) => {
            const mids = [...new Set(ids.map((id) => normMessageId(id, body.length)))]
                .filter((m) => m !== null && m >= 0 && m < body.length)
                .sort((x, y) => y - x);
            for (const mid of mids) body.splice(mid, 1);
            return { deleted: mids.sort((x, y) => x - y) };
        });
        if (r.error) return { ok: false, status: r.status ?? 500, error: r.error };
        for (const mid of r.out.deleted) await recordThEvent(ctx2, 'message_deleted', [mid]);
        if (r.out.deleted.length) await recordThEvent(ctx2, 'chat_changed', [{ chat: ctx2.chatName }]);
        return { ok: true, result: { deleted: r.out.deleted } };
    },
    /** [begin,middle)[middle,end) → [middle,end)[begin,middle)。 */
    async rotateChatMessages(a, _scope, ctx2) {
        if (a?.begin === undefined || a?.middle === undefined || a?.end === undefined) {
            return { ok: false, status: 400, error: 'args.begin + args.middle + args.end required' };
        }
        const r = await mutateChatBody(ctx2, (body) => {
            const n = body.length;
            const begin = Math.max(0, normMessageId(a.begin, n) ?? 0);
            const middle = Math.min(n, normMessageId(a.middle, n) ?? n);
            const end = Math.min(n, normMessageId(a.end, n) ?? n);
            if (!(begin < middle && middle <= end)) return { rotated: false, begin, middle, end };
            const head = body.slice(0, begin);
            const first = body.slice(begin, middle);
            const second = body.slice(middle, end);
            const tail = body.slice(end);
            body.length = 0;
            body.push(...head, ...second, ...first, ...tail);
            return { rotated: true, begin, middle, end };
        });
        if (r.error) return { ok: false, status: r.status ?? 500, error: r.error };
        if (r.out.rotated) await recordThEvent(ctx2, 'chat_changed', [{ chat: ctx2.chatName }]);
        return { ok: true, result: r.out };
    },
    /** TH refreshOneMessage:重渲信号——信箱推 refresh_message,宿主侧决定动作。 */
    async refreshOneMessage(a, _scope, ctx2) {
        const mid = Number(a?.message_id);
        if (!Number.isInteger(mid)) return { ok: false, status: 400, error: 'args.message_id required' };
        await recordThEvent(ctx2, 'refresh_message', [mid]);
        return { ok: true };
    },

    // ── 世界书家族(T1):TH 形字段 ↔ ST entries 对象 ────────────────────
    async getLorebooks(_a, _scope, ctx2) {
        return { ok: true, result: await getWorldInfoRepo().listNames(ctx2.handle) };
    },
    async getLorebookEntries(a, _scope, ctx2) {
        const name = await resolveLorebook(ctx2, a?.lorebook ?? a?.name);
        if (!name.ok) return name;
        const doc = await getWorldInfoRepo().get(ctx2.handle, name.name);
        if (!doc) return { ok: false, status: 404, error: `lorebook not found: ${a?.lorebook ?? a?.name}` };
        return { ok: true, result: { name: name.name, entries: lorebookToTh(doc) } };
    },
    /** getLorebook 非 TH 法名(protocol 占位),语义=含原档的整本视图。 */
    async getLorebook(a, scope, ctx2) { return METHODS.getLorebookEntries(a, scope, ctx2); },
    /** {lorebook, entries:[{uid, ...patch}]} merge-by-uid(TH setLorebookEntries)。 */
    async setLorebookEntries(a, _scope, ctx2) {
        const list = Array.isArray(a?.entries) ? a.entries : null;
        if (!list?.length) return { ok: false, status: 400, error: 'args.entries must be a non-empty array' };
        if (list.some((e) => !Number.isFinite(Number(e?.uid)))) {
            return { ok: false, status: 400, error: 'every entry requires uid' };
        }
        return lorebookMutate(ctx2, a?.lorebook ?? a?.name, (thEntries) => {
            for (const patch of list) {
                const cur = thEntries.find((e) => e.uid === Number(patch.uid));
                if (cur) deepAssignThEntry(cur, patch);
            }
            return thEntries;
        });
    },
    /** 全量替换(TH replaceLorebookEntries;uid 冲突消解+display_index 补序)。 */
    async replaceLorebookEntries(a, _scope, ctx2) {
        const list = Array.isArray(a?.entries) ? a.entries : [];
        return lorebookMutate(ctx2, a?.lorebook ?? a?.name, () => list);
    },
    /** shim 本地跑 updater ship 全量结果(TH 本体=replaceLorebookEntries(result))。 */
    async updateLorebookEntriesWith(a, scope, ctx2) {
        return METHODS.replaceLorebookEntries({ ...a, entries: a?.result ?? a?.entries }, scope, ctx2);
    },
    /** {lorebook, entries:[partial]} → {entries, new_uids}(TH createLorebookEntries)。 */
    async createLorebookEntries(a, _scope, ctx2) {
        const list = Array.isArray(a?.entries) ? a.entries : null;
        if (!list?.length) return { ok: false, status: 400, error: 'args.entries must be a non-empty array' };
        return lorebookMutate(ctx2, a?.lorebook ?? a?.name, (thEntries) => {
            const used = new Set(thEntries.map((e) => e.uid));
            let nextUid = 0;
            const freeUid = () => { while (used.has(nextUid) && nextUid < 1_000_000) nextUid++; used.add(nextUid); return nextUid; };
            let nextIndex = Math.max(-1, ...thEntries.map((e) => e.display_index ?? -1)) + 1;
            const newUids = [];
            for (const patch of list) {
                const uid = Number.isFinite(Number(patch.uid)) && !used.has(Number(patch.uid)) ? Number(patch.uid) : freeUid();
                used.add(uid); newUids.push(uid);
                thEntries.push({ ...patch, uid, display_index: patch.display_index ?? nextIndex++ });
            }
            return { entries: thEntries, extra: { new_uids: newUids } };
        });
    },
    /** {lorebook, uids:number[]} → {entries, delete_occurred}。 */
    async deleteLorebookEntries(a, _scope, ctx2) {
        const uids = Array.isArray(a?.uids) ? new Set(a.uids.map(Number)) : null;
        if (!uids?.size) return { ok: false, status: 400, error: 'args.uids must be a non-empty array' };
        return lorebookMutate(ctx2, a?.lorebook ?? a?.name, (thEntries) => {
            const before = thEntries.length;
            const keep = thEntries.filter((e) => !uids.has(e.uid));
            return { entries: keep, extra: { delete_occurred: before !== keep.length } };
        });
    },
    async createLorebook(a, _scope, ctx2) {
        const name = String(a?.lorebook ?? a?.name ?? '').trim();
        if (!name) return { ok: false, status: 400, error: 'args.lorebook required' };
        let safe;
        try { safe = safeName(name, 'args.lorebook'); } catch (e) { return { ok: false, status: 400, error: String(e?.message ?? e) }; }
        const r = await getWorldInfoRepo().createIfAbsent(ctx2.handle, safe, { entries: {} });
        return { ok: true, result: { created: !!r?.created, name: r?.name ?? safe } };
    },
    async deleteLorebook(a, _scope, ctx2) {
        const name = String(a?.lorebook ?? a?.name ?? '').trim();
        if (!name) return { ok: false, status: 400, error: 'args.lorebook required' };
        let safe;
        try { safe = safeName(name, 'args.lorebook'); } catch (e) { return { ok: false, status: 400, error: String(e?.message ?? e) }; }
        const deleted = await getWorldInfoRepo().delete(ctx2.handle, safe);
        return { ok: true, result: { deleted: !!deleted, name: safe } };
    },
    /** 聊天绑定书 = chat_metadata.world_info(原版 METADATA_KEY)。 */
    async getChatLorebook(_a, _scope, ctx2) {
        if (!ctx2.charDir || !ctx2.chatName) return { ok: false, status: 400, error: 'target.charDir + target.chatName required' };
        const doc = await getChatRepo().get(ctx2.handle, ctx2.charDir, ctx2.chatName);
        if (!doc) return { ok: false, status: 404, error: 'chat not found' };
        const w = doc.header?.chat_metadata?.world_info;
        return { ok: true, result: typeof w === 'string' && w ? w : null };
    },
    async setChatLorebook(a, _scope, ctx2) {
        if (!ctx2.charDir || !ctx2.chatName) return { ok: false, status: 400, error: 'target.charDir + target.chatName required' };
        const doc = await getChatRepo().get(ctx2.handle, ctx2.charDir, ctx2.chatName);
        if (!doc) return { ok: false, status: 404, error: 'chat not found' };
        const name = a?.lorebook === null ? null : String(a?.lorebook ?? a?.name ?? '').trim() || null;
        // undefined 显式覆盖旧值(updateChatMetadata 是浅合,序列化丢 undefined → 删键)
        await getChatRepo().updateChatMetadata(ctx2.handle, ctx2.charDir, ctx2.chatName, { world_info: name ?? undefined });
        return { ok: true, result: { lorebook: name } };
    },
    /** TH getOrCreateChatLorebook:绑了就回名;没绑 → 建(或认领)+绑。 */
    async getOrCreateChatLorebook(a, scope, ctx2) {
        const cur = await METHODS.getChatLorebook(a, scope, ctx2);
        if (cur.ok === false) return cur;
        if (cur.result) return cur;
        const name = String(a?.lorebook ?? a?.name ?? '').trim() || `${ctx2.chatName}-lorebook`;
        const cr = await METHODS.createLorebook({ lorebook: name }, scope, ctx2);
        if (cr.ok === false) return cr;
        const bind = await METHODS.setChatLorebook({ lorebook: cr.result.name }, scope, ctx2);
        return bind.ok === false ? bind : { ok: true, result: cr.result.name };
    },
    /** 角色书绑定最小读面:primary=ext.world 外绑书 ‖ 内嵌书派生名
     *  (与装配层 primaryWorldName 同口径 —— 缺绑带书卡回报的就是
     *  实际生效的名字;embedded 仍只报卡面原书名字段)。 */
    async getCharLorebooks(a, _scope, ctx2) {
        const charDir = resolveCharTarget(a?.name ?? a?.charDir ?? ctx2.charDir);
        if (!charDir) return { ok: false, status: 400, error: 'character name required' };
        const card = await loadCard(ctx2.directories, charDir);
        if (!card) return { ok: false, status: 404, error: `character not found: ${charDir}` };
        const ext = card?.data?.extensions ?? {};
        const embedded = card?.data?.character_book?.name ?? null;
        return {
            ok: true,
            result: {
                primary: primaryWorldName(card),
                additional: Array.isArray(ext.additional_books) ? ext.additional_books : [],
                embedded: embedded,
            },
        };
    },

    // ── 正则家族(T1):TavernRegex 视图 ↔ RegexScriptData ─────────────
    async getTavernRegexes(a, _scope, ctx2) {
        const r = await readRegexScope(ctx2, a);
        if (r.error) return { ok: false, status: r.status ?? 500, error: r.error };
        return { ok: true, result: (r.scripts ?? []).map(toTavernRegexView) };
    },
    /** {regexes|TavernRegex[], type, name?} 全量替换(TH:会触发 CHAT_CHANGED)。 */
    async replaceTavernRegexes(a, _scope, ctx2) {
        const list = Array.isArray(a?.regexes) ? a.regexes : null;
        if (!list) return { ok: false, status: 400, error: 'args.regexes must be an array' };
        const scripts = list.map((r) => r && typeof r === 'object'
            ? (r.script_name !== undefined || r.find_regex !== undefined ? fromTavernRegexView(r) : r)
            : r);
        const r = await writeRegexScope(ctx2, a, scripts);
        if (r.error) return { ok: false, status: r.status ?? 500, error: r.error };
        // TH 文档:替换正则触发 CHAT_CHANGED 重载楼层。
        if (ctx2.charDir && ctx2.chatName) await recordThEvent(ctx2, 'chat_changed', [{ chat: ctx2.chatName }]);
        return { ok: true, result: { count: scripts.length } };
    },
    /** shim 本地跑 updater ship 全量结果(TH 本体=replaceTavernRegexes(result))。 */
    async updateTavernRegexesWith(a, scope, ctx2) {
        return METHODS.replaceTavernRegexes({ ...a, regexes: a?.result ?? a?.regexes }, scope, ctx2);
    },
    /** 卡作用域放行表成员判定(character_allowed_regex 含 avatar)。 */
    async isCharacterTavernRegexesEnabled(a, _scope, ctx2) {
        const charDir = resolveCharTarget(a?.name ?? a?.charDir ?? ctx2.charDir);
        if (!charDir) return { ok: false, status: 400, error: 'character name required' };
        const settings = await getSettingsRepo().get(ctx2.handle) ?? {};
        const list = settings?.extension_settings?.character_allowed_regex;
        const avatar = await resolveAvatarName(ctx2.directories, charDir);
        return { ok: true, result: Array.isArray(list) && list.includes(avatar) };
    },
    /** TH formatAsTavernRegexedString(text, source, destination, {depth, character_name})
     *  source: 'user_input'|'ai_output'|'slash_command'|'world_info'|'reasoning'(单值字符串;
     *          宽松兼容 flags 对象形)。destination: 'display'|'prompt'(兼容对象形)。
     *  脚本集=上游 getRegexScripts({allowedOnly:true}) 口径:global 恒入;
     *  character 仅 character_allowed_regex 放行;preset 因 in_use 解析未实不入(见对照表)。
     *  后段对齐 TH:结果再过一遍 substituteParams(正文里的 {{}} 宏)。 */
    async formatAsTavernRegexedString(a, _scope, ctx2) {
        const text = String(a?.text ?? '');
        const srcKey = typeof a?.source === 'string' ? a.source
            : a?.source?.user_input ? 'user_input'
                : a?.source?.slash_command ? 'slash_command'
                    : a?.source?.world_info ? 'world_info'
                        : a?.source?.reasoning ? 'reasoning' : 'ai_output';
        const placement = {
            user_input: regex_placement.USER_INPUT,
            ai_output: regex_placement.AI_OUTPUT,
            slash_command: regex_placement.SLASH_COMMAND,
            world_info: regex_placement.WORLD_INFO,
            reasoning: regex_placement.REASONING,
        }[srcKey];
        const destKey = typeof a?.destination === 'string' ? a.destination
            : a?.destination?.prompt ? 'prompt' : 'display';
        const settings = (await getSettingsRepo().get(ctx2.handle)) ?? {};
        const scripts = [];
        if (Array.isArray(settings?.extension_settings?.regex)) scripts.push(...settings.extension_settings.regex);
        if (ctx2.charDir) {
            const avatar = await resolveAvatarName(ctx2.directories, ctx2.charDir);
            const allowed = Array.isArray(settings?.extension_settings?.character_allowed_regex)
                && settings.extension_settings.character_allowed_regex.includes(avatar);
            if (allowed) {
                try {
                    const card = await loadCard(ctx2.directories, ctx2.charDir);
                    const scoped = card?.data?.extensions?.regex_scripts ?? card?.extensions?.regex_scripts;
                    if (Array.isArray(scoped)) scripts.push(...scoped);
                } catch { /* 卡缺省只过全局 */ }
            }
        }
        const substCtx = await buildSubstCtx(ctx2, settings);
        let out = getRegexedString(text, placement, {
            scripts,
            characterOverride: a?.character_name,
            isMarkdown: destKey === 'display',
            isPrompt: destKey === 'prompt',
            depth: a?.depth,
        }, substCtx);
        out = substituteParams(out, substCtx);
        return { ok: true, result: out };
    },
    /** TH substituteMacros(text):纯宏替换({{user}}/{{char}}/{{getvar}} 等),
     *  与 formatAs 同一 substCtx(chat+chatMetadata+globalVariables 真上下文)。 */
    async substituteMacros(a, _scope, ctx2) {
        const settings = (await getSettingsRepo().get(ctx2.handle)) ?? {};
        const substCtx = await buildSubstCtx(ctx2, settings);
        return { ok: true, result: substituteParams(String(a?.text ?? ''), substCtx) };
    },

    /** TH formatAsDisplayedMessage(text, {message_id}) → 该楼展示车道投影文本。
     *  TH 本体 = messageFormatting(text,name,is_system,is_user,mid)(display
     *  regex 道+宏+hljs);本面 = 同投影文本(持久→展示串接 = mes_display 同链,
     *  末段 substituteParams;hljs 高亮属 DOM 域不仿)。
     *  message_id:'last'|'last_user'|'last_char'|number(负从尾,TH 同形)。 */
    async formatAsDisplayedMessage(a, _scope, ctx2) {
        if (!ctx2.charDir || !ctx2.chatName) return { ok: false, status: 400, error: 'target.charDir + target.chatName required' };
        const doc = await getChatRepo().get(ctx2.handle, ctx2.charDir, ctx2.chatName);
        if (!doc) return { ok: false, status: 404, error: 'chat not found' };
        const body = Array.isArray(doc.body) ? doc.body : [];
        if (!body.length) return { ok: false, status: 400, error: '未找到任何消息楼层' };
        const mid = resolveFloorId(a?.message_id, body);
        if (mid === null) return { ok: false, status: 400, error: `提供的 message_id 无效/越界: ${a?.message_id}` };
        const floor = body[mid];
        const { runner, substCtx } = await displayFloorRunner(ctx2);
        const placement = chatFloorRegexPlacement(floor);
        const depth = floorDisplayDepth(body, mid);
        const projected = runner.displayText(String(a?.text ?? ''), placement, { depth, characterOverride: floor?.name });
        return { ok: true, result: substituteParams(projected, substCtx) };
    },
    /** TH retrieveDisplayedMessage(message_id) → 楼层「当前展示内容」结构化
     *  读回。TH 回 .mes_text jQuery DOM;本面 = 展示投影文本(display_text
     *  覆盖 > 激活 swipe)+ 前端界面块清单(pre>code 含 <body/<head/html>
     *  → 宿主渲成 iframe;extractFrontendBlocks 权威规格在 core)。 */
    async retrieveDisplayedMessage(a, _scope, ctx2) {
        if (!ctx2.charDir || !ctx2.chatName) return { ok: false, status: 400, error: 'target.charDir + target.chatName required' };
        const doc = await getChatRepo().get(ctx2.handle, ctx2.charDir, ctx2.chatName);
        if (!doc) return { ok: false, status: 404, error: 'chat not found' };
        const body = Array.isArray(doc.body) ? doc.body : [];
        const mid = resolveFloorId(a?.message_id, body);
        if (mid === null) return { ok: false, status: 400, error: `提供的 message_id 无效/越界: ${a?.message_id}` };
        const floor = body[mid];
        const { runner } = await displayFloorRunner(ctx2);
        const placement = chatFloorRegexPlacement(floor);
        const depth = floorDisplayDepth(body, mid);
        const override = typeof floor?.extra?.display_text === 'string' ? floor.extra.display_text : null;
        const swipe = Array.isArray(floor?.swipes) ? floor.swipes[Number(floor.swipe_id ?? 0)] ?? floor.swipes[0] : undefined;
        const swipeText = typeof swipe === 'string' ? swipe : swipe?.mes;
        const raw = override ?? swipeText ?? floor?.mes ?? '';
        const projected = typeof raw === 'string'
            ? (override !== null
                ? runner.markdown(raw, placement, { depth, characterOverride: floor?.name })
                : runner.displayText(raw, placement, { depth, characterOverride: floor?.name }))
            : '';
        const split = extractFrontendBlocks(projected);
        return {
            ok: true,
            result: {
                message_id: mid,
                display_text: projected,
                frontend_blocks: split.blocks.map((b) => b.html),
                has_frontend: split.blocks.length > 0,
            },
        };
    },
    /** TH Mvu.getMvuData({type,message_id}) —— 变量面 MVU 薄封:同
     *  getVariables 读域;非 MVU 形(stat_data+schema 缺一)→ 400(TH 抛错面)。 */
    async getMvuData(a, scope) {
        const v = a?.path ? getPath(scope.store, a.path) : scope.store;
        if (!isMvuData(v)) {
            return { ok: false, status: 400, error: 'variables are not MVU data (stat_data + schema required)', mvu: false };
        }
        return { ok: true, result: v };
    },
    /** TH Mvu.replaceMvuData(data,{type,message_id}) —— 同 replaceVariables
     *  (GH#4 丢根护栏 + schema 结构校验同享:stat_data 对自带 schema
     *  走 validateStatDataAgainstSchema,违规 → 400 逐路径错不落盘);
     *  入参非 MVU 形 → 400(TH 校验面)。 */
    async replaceMvuData(a, scope) {
        const vars = a?.data ?? a?.variables;
        if (!isPlainObj(vars)) return { ok: false, status: 400, error: 'args.data must be an object' };
        if (!isMvuData(vars)) {
            return { ok: false, status: 400, error: 'args.data is not MVU data (stat_data + schema required)' };
        }
        return METHODS.replaceVariables({ ...a, variables: vars }, scope);
    },

    /** TH stopGeneration:generation_id → 定点停;缺省 → 停本 chat 活跃 job。 */
    async stopGeneration(a, _scope, ctx2) {
        const jobs = await import('../endpoints/backends/luker-generation.js');
        const fakeReq = { user: { profile: { handle: ctx2.handle, name: ctx2.userName } } };
        if (a?.generation_id) {
            const job = jobs.getGenerationJobForRequest(fakeReq, a.generation_id);
            if (!job) return { ok: false, status: 404, error: `job not found: ${a.generation_id}` };
            const stopped = jobs.abortGenerationJobForInspector(job, 'stopped via th.stopGeneration');
            await recordThEvent(ctx2, 'generation_stopped', [String(a.generation_id)]);
            return { ok: true, result: { stopped, job_id: String(a.generation_id) } };
        }
        const target = ctx2.charDir && ctx2.chatName
            ? { kind: 'chat', avatar_url: `${ctx2.charDir}.png`, file_name: `${ctx2.chatName}.jsonl` }
            : null;
        const active = jobs.getActiveGenerationJobsForRequest(fakeReq, target);
        let cancelled = 0;
        for (const j of active) {
            const job = jobs.getGenerationJobForRequest(fakeReq, j.id);
            if (job && jobs.abortGenerationJobForInspector(job, 'stopped via th.stopGeneration')) cancelled++;
        }
        if (cancelled) await recordThEvent(ctx2, 'generation_stopped', [`${cancelled} jobs`]);
        // quiet 任务 persist_target=none 不在 chatKey 面——如实标注覆盖口径。
        return { ok: true, result: { cancelled, covered: 'chat-persisted jobs; quiet jobs need generation_id' } };
    },

    // ── 事件家族(TASK-049):影子注册表 + 信箱;真 listener 在卡 realm ──
    async eventOn(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const event = eventName(a);
            if (!event) return { ok: false, status: 400, error: 'args.event required' };
            const id = String(a?.listener_id ?? '').trim() || `srv-${++thLidSeq}`;
            doc.listeners = doc.listeners.filter((l) => l.id !== id);
            const priority = a?.priority === 'first' || a?.priority === 'last' ? a.priority : 'normal';
            insertListener(doc, { id, event, priority, once: false, at: Date.now() });
            return { ok: true, result: { listener_id: id, event, count: doc.listeners.length } };
        });
    },
    async eventOnce(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const event = eventName(a);
            if (!event) return { ok: false, status: 400, error: 'args.event required' };
            const id = String(a?.listener_id ?? '').trim() || `srv-${++thLidSeq}`;
            doc.listeners = doc.listeners.filter((l) => l.id !== id);
            const priority = a?.priority === 'first' || a?.priority === 'last' ? a.priority : 'normal';
            insertListener(doc, { id, event, priority, once: true, at: Date.now() });
            return { ok: true, result: { listener_id: id, event, count: doc.listeners.length } };
        });
    },
    async eventMakeLast(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const i = findListenerIndex(doc, a);
            if (i === -1) return { ok: true, result: { moved: false } };
            const [entry] = doc.listeners.splice(i, 1);
            entry.priority = 'last';
            doc.listeners.push(entry);
            return { ok: true, result: { moved: true, listener_id: entry.id } };
        });
    },
    async eventMakeFirst(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const i = findListenerIndex(doc, a);
            if (i === -1) return { ok: true, result: { moved: false } };
            const [entry] = doc.listeners.splice(i, 1);
            entry.priority = 'first';
            doc.listeners.unshift(entry);
            return { ok: true, result: { moved: true, listener_id: entry.id } };
        });
    },
    async eventRemoveListener(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const lid = String(a?.listener_id ?? '').trim();
            if (lid) {
                const before = doc.listeners.length;
                doc.listeners = doc.listeners.filter((l) => l.id !== lid);
                return { ok: true, result: { removed: before - doc.listeners.length } };
            }
            const ev = eventName(a);
            if (!ev) return { ok: true, result: { removed: 0 } };
            // 无 lid 兜底:摘该 event 最近一条(对齐 findListenerIndex 定位语义)
            const i = findListenerIndex(doc, a);
            if (i === -1) return { ok: true, result: { removed: 0 } };
            doc.listeners.splice(i, 1);
            return { ok: true, result: { removed: 1 } };
        });
    },
    async eventClearEvent(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const ev = eventName(a);
            if (!ev) return { ok: false, status: 400, error: 'args.event required' };
            // listener_ids 在场 → 只清该 mount 的条目;缺席 → API 语义清全部该 event
            const ids = Array.isArray(a?.listener_ids)
                ? new Set(a.listener_ids.map((x) => String(x ?? '')).filter(Boolean)) : null;
            const before = doc.listeners.length;
            doc.listeners = doc.listeners.filter((l) => l.event !== ev || (ids && !ids.has(l.id)));
            return { ok: true, result: { removed: before - doc.listeners.length } };
        });
    },
    async eventClearListener(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const ids = new Set(
                (Array.isArray(a?.listener_ids) ? a.listener_ids : [a?.listener_id])
                    .map((x) => String(x ?? '').trim()).filter(Boolean));
            if (!ids.size) return { ok: false, status: 400, error: 'args.listener_id(s) required' };
            const before = doc.listeners.length;
            doc.listeners = doc.listeners.filter((l) => !ids.has(l.id));
            return { ok: true, result: { removed: before - doc.listeners.length } };
        });
    },
    async eventClearAll(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            // listener_ids 在场 → 只清该 mount 的条目;缺席 → 清全部
            const ids = Array.isArray(a?.listener_ids)
                ? new Set(a.listener_ids.map((x) => String(x ?? '')).filter(Boolean)) : null;
            const before = doc.listeners.length;
            doc.listeners = ids ? doc.listeners.filter((l) => !ids.has(l.id)) : [];
            return { ok: true, result: { removed: before - doc.listeners.length } };
        });
    },
    async eventEmit(a, _scope, ctx2) {
        return withEventDoc(ctx2, (doc) => {
            const event = eventName(a);
            if (!event) return { ok: false, status: 400, error: 'args.event required' };
            const args = Array.isArray(a?.args) ? a.args : [];
            const delivered = doc.listeners.filter((l) => l.event === event).length;
            pushMailboxEntry(doc, event, args, a?.origin ? String(a.origin) : undefined);
            return { ok: true, result: { seq: doc.seq, delivered } };
        });
    },
    /** server 无法真等卡 listener 返回——语义=emit 后回执(seq+delivered 计数)。 */
    async eventEmitAndWait(a, scope, ctx2) {
        return METHODS.eventEmit(a, scope, ctx2);
    },
    /** 信箱读面:宿主泵 since 分页拉新(origin 去重在宿主侧)。非 TH API。 */
    async getEventLog(a, _scope, ctx2) {
        const doc = await readEventDoc(ctx2);
        if (!doc) return { ok: true, result: { seq: 0, entries: [] } };
        const since = Number(a?.since ?? 0) || 0;
        return {
            ok: true,
            result: { seq: doc.seq, entries: doc.log.filter((e) => e.seq > since) },
        };
    },
};

export function apply(ctx) {
    registerBuiltinCommands();

    ctx.effect(() => ctx.webServer.register({
        kind: 'pattern',
        method: 'POST',
        path: '/api/utopinn/th/call',
        handler: async function (request, response) {
            try {
                const body = request.body ?? {};
                const method = String(body.method ?? '');
                if (!method) {
                    return response.status(400).send({ ok: false, error: 'body.method required' });
                }
                const target = body.target ?? {};
                const charDir = target.charDir ? safeName(target.charDir, 'target.charDir') : null;
                const chatName = target.chatName ? safeName(stripJsonlExt(target.chatName), 'target.chatName') : null;
                const fn = METHODS[method];
                if (!fn) {
                    thEvent('th_unsupported', `th unsupported: ${method}`, { method, charDir, chatName });
                    return response.send({ ok: false, unsupported: true, method });
                }
                const ctx2 = {
                    handle: request.user.profile.handle,
                    directories: request.user.directories,
                    charDir,
                    chatName,
                    userName: request.user.profile.name,
                };

                let scope = null;
                if (['getVariables', 'replaceVariables', 'insertOrAssignVariables', 'insertVariables', 'updateVariablesWith', 'deleteVariable', 'getMvuData', 'replaceMvuData'].includes(method)) {
                    const scopeName = String(body.args?.type ?? body.args?.scope ?? 'chat');
                    if (!SCOPES.has(scopeName)) {
                        return response.status(400).send({ ok: false, error: `scope must be one of ${[...SCOPES].join('|')}` });
                    }
                    const r = await resolveScope({
                        handle: ctx2.handle,
                        scope: scopeName,
                        charDir, chatName,
                        messageId: body.args?.message_id,
                    });
                    if (r.error) {
                        thEvent('th_scope_failed', `th ${method} scope: ${r.error}`, { method, charDir, chatName, status: r.status });
                        return response.status(r.status ?? 500).send({ ok: false, error: r.error });
                    }
                    scope = r;
                }

                const out = await fn(body.args ?? {}, scope, ctx2);
                if (out.ok === false && out.status) {
                    thEvent('th_call_failed', `th ${method} failed: ${out.error ?? out.status}`, { method, charDir, chatName, status: out.status, error: out.error });
                    return response.status(out.status).send(out);
                }
                return response.send(out);
            } catch (error) {
                thEvent('th_error', `th call threw: ${String(error?.message ?? error).slice(0, 200)}`, { method: request.body?.method, charDir: request.body?.target?.charDir, chatName: request.body?.target?.chatName, status: 500, error });
                return sendError(response, error, 'utopinn/th call');
            }
        },
    }));
}
