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
} from '@utopinn/core';
import { getChatRepo, getSettingsRepo, getStorageEngine } from '../storage/index.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { safeName, sendError } from './_shared/http-utils.js';
import { buildStscriptEnv, loadCard } from '../services/stscript-env.js';
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
    const mid = Number.isInteger(messageId) ? messageId : body.length - 1;
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
        const warnings = [];
        if (lostRoots.length) warnings.push(`lost_roots: ${lostRoots.join('/')}`);
        if (lostStatRoots.length) warnings.push(`lost stat_data roots: ${lostStatRoots.join('/')}`);
        for (const k of Object.keys(scope.store)) delete scope.store[k];
        Object.assign(scope.store, vars);
        await scope.persist();
        return { ok: true, ...(warnings.length ? { warnings } : {}) };
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
                },
                userName: ctx2.userName ?? 'User',
                timeoutMs: Number(a?.timeout_ms ?? 0) || 180_000,
            });
            // TH GENERATION_ENDED 语义:负载=最终文本。
            await recordThEvent(ctx2, 'generation_ended', [r.text ?? '']);
            return {
                ok: true,
                result: { text: r.text ?? '', jobId: r.jobId, status: r.status, diagId: r.diagId },
                ...(warnings.length ? { warnings } : {}),
            };
        } catch (error) {
            const msg = String(error?.message ?? error ?? 'generate failed');
            await recordThEvent(ctx2, 'generation_stopped', [msg.slice(0, 300)]);
            thEvent('th_generate_failed', `th generate failed: ${msg.slice(0, 200)}`,
                { method: 'generate', charDir: ctx2.charDir, chatName: ctx2.chatName, status: 502, error });
            return { ok: false, status: 502, error: msg, ...(warnings.length ? { warnings } : {}) };
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
                if (['getVariables', 'replaceVariables', 'insertOrAssignVariables', 'insertVariables', 'updateVariablesWith', 'deleteVariable'].includes(method)) {
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
