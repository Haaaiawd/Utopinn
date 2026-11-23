/**
 * utopinn-izumi —— kernel 插件:IzumiEdit 信息库的 REST 面。
 *
 *   GET|POST /api/utopinn/izumi/state   读 chat_state ns 'izumi' 视图
 *                                      (entries/hiddenFloors/log + 注入文预览)。
 *   POST     /api/utopinn/izumi/put     面板写面:entries.{opName}.{enabled|content}
 *                                      局部改 + hiddenFloors 整表换 +
 *                                      worldSystemClosed 开关;服务端 RMW 后
 *                                      回同一视图(注入文是 state 派生物,下轮
 *                                      组装自动重建,无需另推)。
 *   POST     /api/utopinn/izumi/reset   清空 ns(调试/重开语义)。
 *
 * target 形与 mvu/state 同源:{avatar_url,file_name} | {is_group,id}
 * (GET 走 query,POST 走 body —— targetArgs 合并两侧)。
 */
import { getStorageEngine } from '../storage/index.js';
import { resolveMvuChatTarget } from '../services/mvu-settle.js';
import { izumiStateView, normalizeIzumiState, IZUMI_NS, splitOpName, joinOpName } from '../services/izumi.js';
import { sendError } from './_shared/http-utils.js';
import { emit as diagEmit } from '../services/diag-bus.js';

export const inject = ['webServer'];

/** query ∪ body → {handle,charDir,name,isGroup,groupId} 资源键原料。 */
function targetArgs(request) {
    const source = { ...(request.body ?? {}), ...(request.query ?? {}) };
    const key = resolveMvuChatTarget(source);
    if (!key) return null;
    return {
        handle: request.user.profile.handle,
        charDir: key.charDir,
        name: key.name,
        isGroup: key.isGroup,
        groupId: key.groupId,
    };
}

const chatKeyOf = (args) => ({
    kind: 'chat', handle: args.handle, charDir: args.charDir,
    name: args.name, isGroup: !!args.isGroup, groupId: args.groupId,
});

async function readView(args) {
    const engine = getStorageEngine();
    const key = chatKeyOf(args);
    return engine.withTransaction(args.handle, async (tx) => {
        if (!(await tx.hasChatResource(key))) return { status: 404 };
        const doc = await tx.getChatState(key, IZUMI_NS);
        return { status: 200, view: izumiStateView(doc) };
    });
}

/**
 * PUT 写面(整体改/开关切换):patch.entries 的键按操作名归一
 * ('资料／x' 与 '资料/x' 同键);改不存在条目 → 404 语义合并进
 * errors[] 但不整单失败(面板逐项回执,不连坐其它改动)。
 */
function applyPutPatch(doc, patch) {
    const errors = [];
    const entriesPatch = patch?.entries;
    if (entriesPatch && typeof entriesPatch === 'object' && !Array.isArray(entriesPatch)) {
        for (const [opName, changes] of Object.entries(entriesPatch)) {
            const { scope, name } = splitOpName(opName);
            const key = joinOpName(scope, name);
            const entry = doc.entries[key];
            if (!entry) { errors.push({ opName, reason: 'not_found' }); continue; }
            if (changes && typeof changes === 'object') {
                if (typeof changes.enabled === 'boolean') entry.enabled = changes.enabled;
                if (typeof changes.content === 'string') entry.content = changes.content;
            }
        }
    }
    if (Array.isArray(patch?.hiddenFloors)) {
        doc.hiddenFloors = patch.hiddenFloors
            .filter((r) => r && Number.isFinite(Number(r.from)) && Number.isFinite(Number(r.to)))
            .map((r) => ({ from: Math.min(Number(r.from), Number(r.to)), to: Math.max(Number(r.from), Number(r.to)) }));
    }
    if (typeof patch?.worldSystemClosed === 'boolean') {
        doc.worldSystemClosed = patch.worldSystemClosed;
    }
    return errors;
}

export function apply(ctx) {
    const ws = ctx.webServer;
    const P = '/api/utopinn/izumi';

    const stateHandler = async function (request, response) {
        const args = targetArgs(request);
        if (!args) {
            return response.status(400).send({ error: 'Expected {avatar_url,file_name} or {is_group,id}.' });
        }
        try {
            const r = await readView(args);
            if (r.status === 404) return response.status(404).send({ error: 'Chat not found.' });
            return response.send({ ok: true, ...r.view });
        } catch (error) {
            return sendError(response, error, 'utopinn/izumi state');
        }
    };
    ctx.effect(() => ws.register({ kind: 'pattern', method: 'GET', path: `${P}/state`, handler: stateHandler }));
    ctx.effect(() => ws.register({ kind: 'pattern', method: 'POST', path: `${P}/state`, handler: stateHandler }));

    const putHandler = async function (request, response) {
        const args = targetArgs(request);
        if (!args) {
            return response.status(400).send({ error: 'Expected {avatar_url,file_name} or {is_group,id}.' });
        }
        const patch = request.body?.patch ?? request.body;
        try {
            const engine = getStorageEngine();
            const key = chatKeyOf(args);
            const out = await engine.withTransaction(args.handle, async (tx) => {
                if (!(await tx.hasChatResource(key))) return { status: 404 };
                const doc = normalizeIzumiState(await tx.getChatState(key, IZUMI_NS));
                const errors = applyPutPatch(doc, patch ?? {});
                await tx.putChatState(key, IZUMI_NS, doc);
                return { status: 200, errors, view: izumiStateView(doc) };
            });
            if (out.status === 404) return response.status(404).send({ error: 'Chat not found.' });
            if (out.errors.length) {
                diagEmit({ lvl: 'warn', kind: 'izumi', code: 'izumi_put_partial', msg: `izumi put ${args.charDir}/${args.name}: ${out.errors.length} 项未应用`, ctx: { charDir: args.charDir, chatId: args.name }, data: { errors: out.errors.slice(0, 8) } });
            }
            return response.send({ ok: true, ...out.view, errors: out.errors });
        } catch (error) {
            return sendError(response, error, 'utopinn/izumi put');
        }
    };
    ctx.effect(() => ws.register({ kind: 'pattern', method: 'POST', path: `${P}/put`, handler: putHandler }));
    // REST 面:PUT 与 POST 同 handler(读=GET /state,写=PUT /put)。
    ctx.effect(() => ws.register({ kind: 'pattern', method: 'PUT', path: `${P}/put`, handler: putHandler }));

    ctx.effect(() => ws.register({ kind: 'pattern', method: 'POST', path: `${P}/reset`, handler: async function (request, response) {
        const args = targetArgs(request);
        if (!args) {
            return response.status(400).send({ error: 'Expected {avatar_url,file_name} or {is_group,id}.' });
        }
        try {
            const engine = getStorageEngine();
            const key = chatKeyOf(args);
            const deleted = await engine.withTransaction(args.handle, async (tx) => {
                if (!(await tx.hasChatResource(key))) return { status: 404 };
                await tx.deleteChatState(key, IZUMI_NS);
                return { status: 200 };
            });
            if (deleted.status === 404) return response.status(404).send({ error: 'Chat not found.' });
            return response.send({ ok: true, deleted: true });
        } catch (error) {
            return sendError(response, error, 'utopinn/izumi reset');
        }
    }}));
}
