/**
 * uberge-script —— STscript/QuickReply 服务端 runner(TASK-019)。
 *
 *   POST /api/uberge/script/run
 *   body:{charDir?, chatName?, script}
 *
 * env 构造在 services/stscript-env.js(与 uberge-th 的 triggerSlash 共享,
 * seam 语义单点)。ops/UI sink 回执随响应返回。
 */
import {
    executeSlashCommandsWithOptions,
    registerBuiltinCommands,
} from '@uberge/core';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { safeName, sendError } from './uberge-library.js';
import { buildStscriptEnv } from '../services/stscript-env.js';

export const inject = ['webServer'];

export function apply(ctx) {
    registerBuiltinCommands();

    const reg = (path, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));

    reg('/api/uberge/script/run', async function (request, response) {
        try {
            const body = request.body ?? {};
            const script = String(body.script ?? '');
            if (!script.trim()) {
                return response.status(400).send({ error: 'body.script is required' });
            }
            const charDir = body.charDir ? safeName(body.charDir, 'charDir') : null;
            const chatName = body.chatName ? safeName(stripJsonlExt(body.chatName), 'chatName') : null;

            const built = await buildStscriptEnv({
                handle: request.user.profile.handle,
                directories: request.user.directories,
                charDir,
                chatName,
                userName: request.user.profile.name,
            });
            if (built.error) {
                return response.status(built.status ?? 500).send({ error: built.error });
            }

            const result = await executeSlashCommandsWithOptions(built.env, script);
            return response.send({
                ok: true,
                pipe: result?.pipe ?? result ?? null,
                isAborted: result?.isAborted ?? false,
                ops: built.env.ops,
                notifications: built.sinks.notifications,
                popups: built.sinks.popups,
                inputs: built.sinks.inputs,
            });
        } catch (error) {
            if (error instanceof InvalidArgumentError || error instanceof NotFoundError) {
                return sendError(response, error, 'uberge/script run');
            }
            console.error('uberge/script run failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });
}
