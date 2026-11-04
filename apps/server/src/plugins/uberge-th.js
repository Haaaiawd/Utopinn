/**
 * uberge-th —— TavernHelper 语义兼容层(TASK-025,自写;TH 本体是
 * PolyForm NC 许可,只实现 API 语义不搬代码)。
 *
 *   POST /api/uberge/th/call
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
 */
import {
    executeSlashCommandsWithOptions,
    registerBuiltinCommands,
} from '@uberge/core';
import { getChatRepo, getSettingsRepo } from '../storage/index.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { safeName, sendError } from './uberge-library.js';
import { buildStscriptEnv, loadCard } from '../services/stscript-env.js';

export const inject = ['webServer'];

/** lodash 式路径 → 段数组('a.b[0].c' → ['a','b','0','c'])。 */
function pathSegs(p) {
    return String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
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
function delPath(obj, p) {
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
    // scope==='message':TH 语义是消息级变量 —— 取 body[message_id].variables
    const body = Array.isArray(doc.body) ? doc.body : [];
    const mid = Number.isInteger(messageId) ? messageId : body.length - 1;
    const msg = body[mid];
    if (!msg) return { error: `message ${mid} not found`, status: 404 };
    if (typeof msg.variables !== 'object' || msg.variables === null) msg.variables = {};
    return {
        store: msg.variables,
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
        if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
            return { ok: false, status: 400, error: 'args.variables must be an object' };
        }
        for (const k of Object.keys(scope.store)) delete scope.store[k];
        Object.assign(scope.store, vars);
        await scope.persist();
        return { ok: true };
    },
    async insertOrAssignVariables(a, scope) {
        const vars = a?.variables;
        if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
            return { ok: false, status: 400, error: 'args.variables must be an object' };
        }
        for (const [k, v] of Object.entries(vars)) setPath(scope.store, k, v);
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
    /** 卡嵌脚本面:data.extensions.th_scripts(TH 生态契约;条目兼容
     *  纯字符串与 {name,script} 两形)。 */
    async getEmbeddedScripts(_a, _scope, ctx2) {
        if (!ctx2.charDir) return { ok: false, status: 400, error: 'target.charDir required' };
        const card = await loadCard(ctx2.directories, ctx2.charDir);
        if (!card) return { ok: false, status: 404, error: 'card not found' };
        const raw = card?.data?.extensions?.th_scripts ?? [];
        const list = (Array.isArray(raw) ? raw : [raw])
            .map((s, i) => typeof s === 'string'
                ? { name: `script-${i}`, script: s }
                : { name: s?.name ?? `script-${i}`, script: s?.script ?? s?.content ?? '' })
            .filter(s => s.script);
        return { ok: true, result: list };
    },
};

export function apply(ctx) {
    registerBuiltinCommands();

    ctx.effect(() => ctx.webServer.register({
        kind: 'pattern',
        method: 'POST',
        path: '/api/uberge/th/call',
        handler: async function (request, response) {
            try {
                const body = request.body ?? {};
                const method = String(body.method ?? '');
                if (!method) {
                    return response.status(400).send({ ok: false, error: 'body.method required' });
                }
                const fn = METHODS[method];
                if (!fn) {
                    return response.send({ ok: false, unsupported: true, method });
                }
                const target = body.target ?? {};
                const charDir = target.charDir ? safeName(target.charDir, 'target.charDir') : null;
                const chatName = target.chatName ? safeName(stripJsonlExt(target.chatName), 'target.chatName') : null;
                const ctx2 = {
                    handle: request.user.profile.handle,
                    directories: request.user.directories,
                    charDir,
                    chatName,
                    userName: request.user.profile.name,
                };

                let scope = null;
                if (['getVariables', 'replaceVariables', 'insertOrAssignVariables', 'deleteVariable'].includes(method)) {
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
                    if (r.error) return response.status(r.status ?? 500).send({ ok: false, error: r.error });
                    scope = r;
                }

                const out = await fn(body.args ?? {}, scope, ctx2);
                if (out.ok === false && out.status) {
                    return response.status(out.status).send(out);
                }
                return response.send(out);
            } catch (error) {
                return sendError(response, error, 'uberge/th call');
            }
        },
    }));
}
