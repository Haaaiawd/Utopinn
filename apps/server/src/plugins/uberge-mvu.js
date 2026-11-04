/**
 * uberge-mvu —— kernel 插件:MVU settle/状态板 seam 的 REST 面(TASK-013)。
 *
 *   POST /settle        对目标楼层(默认末楼)跑一次 settle;
 *                       生成管线已在持久化后自动调用,本端点供手动重结算/调试。
 *   POST /resettle      全量重放投影(旧楼层编辑/删除/换 swipe 后重建 stat_data)。
 *   GET  /state         读 chat_metadata.variables + chat_state 'mvu' 回执日志。
 *   POST /panel/render  状态栏固定模板 × 变量字典 → 服务端渲染面板 HTML。
 *
 * handler 原样搬自 endpoints/uberge-mvu.js;4 条全迁,legacy 文件删除。
 */
import { renderMvuStatusPanel } from '@uberge/core';
import {
    resolveMvuChatTarget,
    settlePersistedMvuMessage,
    resettleChatMvu,
    getMvuChatView,
} from '../services/mvu-settle.js';

export const inject = ['webServer'];

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

export function apply(ctx) {
    const ws = ctx.webServer;
    const P = '/api/uberge/mvu';

    ctx.effect(() => ws.register({ kind: 'pattern', method: 'POST', path: `${P}/settle`, handler: async function (request, response) {
        const args = targetArgs(request);
        if (!args) {
            return response.status(400).send({ error: 'Expected {avatar_url,file_name} or {is_group,id}.' });
        }
        const messageIndex = Number.isInteger(request.body?.message_index) ? request.body.message_index : undefined;
        try {
            const result = await settlePersistedMvuMessage({
                ...args,
                messageIndex,
                updateChatVariables: request.body?.update_chat_variables !== false,
            });
            return response.send({ ok: true, ...result });
        } catch (error) {
            console.error('[mvu] settle failed:', error);
            return response.status(500).send({ error: true, detail: String(error?.message ?? error) });
        }
    }}));

    ctx.effect(() => ws.register({ kind: 'pattern', method: 'POST', path: `${P}/resettle`, handler: async function (request, response) {
        const args = targetArgs(request);
        if (!args) {
            return response.status(400).send({ error: 'Expected {avatar_url,file_name} or {is_group,id}.' });
        }
        try {
            const result = await resettleChatMvu({
                ...args,
                updateChatVariables: request.body?.update_chat_variables !== false,
            });
            return response.send({ ok: true, ...result });
        } catch (error) {
            console.error('[mvu] resettle failed:', error);
            return response.status(500).send({ error: true, detail: String(error?.message ?? error) });
        }
    }}));

    ctx.effect(() => ws.register({ kind: 'pattern', method: 'GET', path: `${P}/state`, handler: async function (request, response) {
        const args = targetArgs(request);
        if (!args) {
            return response.status(400).send({ error: 'Expected {avatar_url,file_name} or {is_group,id}.' });
        }
        try {
            const view = await getMvuChatView(args);
            if (view.status === 'no_chat') {
                return response.status(404).send({ error: 'Chat not found.' });
            }
            return response.send({ ok: true, ...view });
        } catch (error) {
            console.error('[mvu] state read failed:', error);
            return response.status(500).send({ error: true });
        }
    }}));

    ctx.effect(() => ws.register({ kind: 'pattern', method: 'POST', path: `${P}/panel/render`, handler: async function (request, response) {
        const template = request.body?.template;
        if (typeof template !== 'string' || template.length === 0) {
            return response.status(400).send({ error: 'Expected body.template string.' });
        }
        // scope 未给时从目标聊天的 chat_metadata.variables 取(模板 seam 的真实用例)。
        let scope = request.body?.scope;
        if (scope === undefined) {
            const args = targetArgs(request);
            if (!args) {
                return response.status(400).send({ error: 'Expected body.scope or chat target ({avatar_url,file_name}|{is_group,id}).' });
            }
            try {
                const view = await getMvuChatView(args);
                scope = view.chatVariables ?? {};
            } catch (error) {
                console.error('[mvu] panel scope read failed:', error);
                return response.status(500).send({ error: true });
            }
        }
        if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
            return response.status(400).send({ error: 'body.scope must be an object.' });
        }
        const html = renderMvuStatusPanel(template, scope, {
            fallback: typeof request.body?.fallback === 'string' ? request.body.fallback : '',
            escapeHtml: request.body?.escape_html !== false,
        });
        return response.send({ ok: true, html });
    }}));
}
