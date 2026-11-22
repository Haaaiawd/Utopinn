/**
 * utopinn-script —— STscript/QuickReply 服务端 runner(TASK-019)。
 *
 *   POST /api/utopinn/script/run
 *   body:{charDir?, chatName?, script}
 *
 * env 构造在 services/stscript-env.js(与 utopinn-th 的 triggerSlash 共享,
 * seam 语义单点)。ops/UI sink 回执随响应返回。
 */
import {
    executeSlashCommandsWithOptions,
    registerBuiltinCommands,
    SlashCommandParser,
} from '@utopinn/core';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { safeName, sendError } from './_shared/http-utils.js';
import { buildStscriptEnv } from '../services/stscript-env.js';

export const inject = ['webServer'];

export function apply(ctx) {
    registerBuiltinCommands();

    const reg = (path, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));
    const regGet = (path, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'GET', path, handler }));

    /* 注册表读面(TASK-060):composer `/` 补全的数据源 —— 前端不抄词表,
       直接消费 core builtins 注册表快照(含参数名提示)。
       parser 伪命令(// 注释、break、breakpoint、parser-flag)由 parser 构造器
       补注册,实例化一次让清单与「实际可解析的命令集」一致。 */
    regGet('/api/utopinn/script/commands', async function (request, response) {
        try {
            new SlashCommandParser();
            const commands = [];
            for (const [key, cmd] of Object.entries(SlashCommandParser.commands)) {
                if (key !== cmd.name) continue; // 别名键指向同一 command,只取规范名
                commands.push({
                    name: cmd.name,
                    aliases: Array.isArray(cmd.aliases) ? [...cmd.aliases] : [],
                    // helpString 上游含 <code>/<div> 标记,压平成纯文本供菜单渲染
                    help: String(cmd.helpString ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                    args: (cmd.namedArgumentList ?? []).map((a) => ({
                        name: a.name,
                        required: a.isRequired === true,
                        def: typeof a.defaultValue === 'string' ? a.defaultValue : null,
                    })),
                    unnamed: (cmd.unnamedArgumentList ?? []).map((a) => a.description).filter(Boolean),
                    ...(cmd.returns ? { returns: cmd.returns } : {}),
                });
            }
            commands.sort((a, b) => a.name.localeCompare(b.name));
            return response.send({ ok: true, commands });
        } catch (error) {
            console.error('utopinn/script commands failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    reg('/api/utopinn/script/run', async function (request, response) {
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
                return sendError(response, error, 'utopinn/script run');
            }
            console.error('utopinn/script run failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });
}
