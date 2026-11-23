/**
 * utopinn-script —— STscript/QuickReply 服务端 runner(TASK-019)。
 *
 *   POST /api/utopinn/script/run
 *   body:{charDir?, chatName?, script}
 *   POST /api/utopinn/script/interact
 *   body:{runId, action:'submit'|'cancel'|'abort', value?}
 *
 * env 构造在 services/stscript-env.js(与 utopinn-th 的 triggerSlash 共享,
 * seam 语义单点)。ops/UI sink 回执随响应返回。
 *
 * TASK-069 挂起回执:撞上 /input /popup /buttons 阻塞 seam 时 run 入册
 * (services/script-runs.js),/run 先回 {awaiting:{runId,kind,...}};
 * 客户端弹层后 POST interact 回传兑现值,响应 = 下一 awaiting 或终态
 * (与 /run 同字段)。超时/取消/TTL/容量语义见 script-runs 头注。
 */
import {
    registerBuiltinCommands,
    runStscript,
    SlashCommandParser,
} from '@utopinn/core';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { safeName, sendError } from './_shared/http-utils.js';
import { buildStscriptEnv } from '../services/stscript-env.js';
import { beginScriptRun, getScriptRun, nextRunState, resolveInteraction } from '../services/script-runs.js';

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

            // runStscript(TASK-064):结构化 error 回执 {code,line,column,hint,
            // commandName} —— 解析/执行错误不再 500 或静默空 pipe,CLI
            // trace/web hint 直接吃这字段;HTTP 仍 200,ok 承载成败。
            // TASK-069 挂起回执:beginScriptRun 把 env 的 requestInput/
            // requestPopup/requestButtons 换成 parked 版 —— 阻塞 seam 撞线
            // → run 入册 + {awaiting} 回执;客户端 interact 兑现后续跑。
            const run = beginScriptRun({
                env: built.env,
                meta: { handle: request.user.profile.handle, charDir, chatName, userName: request.user.profile.name },
                execute: () => runStscript(built.env, script, { abortController: run.abortController }),
            });
            run.sinks = built.sinks;
            const first = await nextRunState(run);
            if (!first.done) {
                return response.send({ ok: true, awaiting: first.awaiting });
            }
            return response.send(scriptResponseOf(built, first.outcome));
        } catch (error) {
            if (error instanceof InvalidArgumentError || error instanceof NotFoundError) {
                return sendError(response, error, 'utopinn/script run');
            }
            console.error('utopinn/script run failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    /** run 终态 → /run 同形响应(outcome 归一:done.output / error.error)。 */
    function scriptResponseOf(built, outcome) {
        const out = outcome?.state === 'done' ? outcome.output : null;
        const runErr = outcome?.state === 'error' ? outcome.error : null;
        return {
            ok: !out?.isError && !runErr,
            pipe: out?.result ?? '',
            isAborted: out?.aborted ?? Boolean(runErr),
            abortReason: out?.abortReason,
            ops: out?.ops ?? built.env.ops,
            error: out?.error ?? (runErr ? { code: 'execution_error', message: String(runErr?.message ?? runErr) } : undefined),
            notifications: built.sinks.notifications,
            popups: built.sinks.popups,
            inputs: built.sinks.inputs,
        };
    }

    /**
     * POST /api/utopinn/script/interact —— 挂起回执兑现。
     * body:{runId, action:'submit'|'cancel'|'abort', value?}
     *   submit:kind 语义值(input→string,popup→1|0|null,buttons→code[])
     *   cancel:取消语义(input→false→onCancel;popup→undefined;buttons→[])
     *   abort :abortController 中止整 run
     * 响应:下一个 awaiting(可连续多轮交互)或终态(同 /run 字段)。
     */
    reg('/api/utopinn/script/interact', async function (request, response) {
        try {
            const body = request.body ?? {};
            const run = getScriptRun(body.runId);
            if (!run) {
                return response.status(404).send({ error: 'script run not found or expired', runId: body.runId ?? null });
            }
            if (run.handle !== request.user.profile.handle) {
                return response.status(403).send({ error: 'script run belongs to another handle' });
            }
            const r = resolveInteraction(run, { action: body.action, value: body.value });
            if (!r.ok) {
                return response.status(r.status ?? 409).send({ error: r.error });
            }
            const next = await nextRunState(run);
            if (!next.done) {
                return response.send({ ok: true, awaiting: next.awaiting });
            }
            const built = { env: run.env, sinks: run.sinks };
            return response.send(scriptResponseOf(built, next.outcome));
        } catch (error) {
            console.error('utopinn/script interact failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });
}
