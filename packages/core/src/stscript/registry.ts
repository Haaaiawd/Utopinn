/**
 * STscript 引擎入口 — 移植自 ref/Luker/public/scripts/slash-commands.js:
 * executeSlashCommandsWithOptions / executeSlashCommands /
 * getSharedSlashCommandParser / registerSlashCommand,
 * 以及 variables.js 的 executeSubCommands(经 args._env 可达)。
 *
 * 语义差异(最小化,全部有出处):
 * - toastr/callGenericPopup 报错展示 → env.host.notify(可选),缺省静默收进
 *   result.errorMessage / result;handleParserErrors 的 toast 语义替换为
 *   notify seam(无 notify 时仅返回空 SlashCommandClosureResult,与原版一致)。
 * - shared parser 单例 → 每次执行 new SlashCommandParser():parser 的
 *   parse() 本来就是实例态重置,服务端并发下单例反而有竞争,语义不变。
 * - env 通过 parser.env → closure.env 注入,回调经 args._env 取到。
 */
import { SlashCommandParser, PARSER_FLAG } from './parser.js';
import type { ParserFlags } from './parser.js';
import { SlashCommandScope } from './scope.js';
import { SlashCommandAbortController, SlashCommandDebugController } from './control.js';
import { SlashCommandClosureResult, SlashCommandParserError, SlashCommandExecutionError, SlashCommand } from './types.js';
import type { StscriptEnv, StscriptOp } from './env.js';

export { PARSER_FLAG };
export type { ParserFlags };

export interface ExecuteSlashCommandsOptions {
    /** parse 抛 SlashCommandParserError 时是否吞掉并返回空结果(原版走 toast)。 */
    handleParserErrors?: boolean;
    /** 外部 scope,作为脚本顶层 closure.scope.parent。 */
    scope?: SlashCommandScope | null;
    /** 回调抛错时是否吞掉并返回 isError=true 的结果(原版走 toast)。 */
    handleExecutionErrors?: boolean;
    parserFlags?: ParserFlags | null;
    abortController?: SlashCommandAbortController | null;
    debugController?: SlashCommandDebugController | null;
    onProgress?: ((done: number, total: number) => void) | null;
    source?: string | null;
    /** 内部用:QR 编辑器宽校验(false 时容忍未闭合结构)。默认 true。 */
    verifyCommandNames?: boolean;
}

/**
 * Executes slash commands in the provided text and returns their result.
 * @param env 执行环境(宏 ctx / ops / host seams)
 * @param text Slash command text
 * @param options Execution options
 */
export async function executeSlashCommandsWithOptions(env: StscriptEnv, text: string, options: ExecuteSlashCommandsOptions = {}): Promise<SlashCommandClosureResult | null> {
    if (!text) {
        return null;
    }
    options = Object.assign({
        handleParserErrors: true,
        scope: null,
        handleExecutionErrors: false,
        parserFlags: null,
        abortController: null,
        debugController: null,
        onProgress: null,
        source: null,
    }, options);

    const parser = new SlashCommandParser();
    parser.env = env;

    let closure;
    try {
        closure = parser.parse(text, options.verifyCommandNames ?? true, options.parserFlags, options.abortController ?? new SlashCommandAbortController(), options.debugController);
        closure.scope.parent = options.scope ?? env.outerScope ?? null;
        closure.onProgress = options.onProgress ?? undefined;
        closure.debugController = options.debugController ?? undefined;
        closure.source = options.source ?? undefined as unknown as string;
    } catch (e) {
        if (options.handleParserErrors && e instanceof SlashCommandParserError) {
            const ex = e;
            // 原版:toastr.error(详细 toast + 点击弹窗)。替换为 notify seam。
            await env.host.notify?.('error', 'SlashCommandParserError', `${ex.message}\nLine: ${ex.line} Column: ${ex.column}\n${ex.hint}`);
            const result = new SlashCommandClosureResult();
            return result;
        } else {
            throw e;
        }
    }

    try {
        const result = await closure.execute();
        if (result!.isAborted && !result!.isQuietlyAborted) {
            // 原版:toastr.warning(result.abortReason, 'Command execution aborted')
            await env.host.notify?.('warning', 'Command execution aborted', result!.abortReason ?? '');
            closure.abortController!.signal.isQuiet = true;
            env.ops.push({ type: 'abort', reason: result!.abortReason ?? '' });
        }
        return result ?? null;
    } catch (e) {
        if (options.handleExecutionErrors) {
            if (e instanceof SlashCommandExecutionError) {
                const ex = e;
                await env.host.notify?.('error', 'SlashCommandExecutionError', `${ex.message}\nLine: ${ex.line} Column: ${ex.column}\n${ex.hint}`);
            } else {
                await env.host.notify?.('error', undefined, (e as Error).message);
            }
            const result = new SlashCommandClosureResult();
            result.isError = true;
            result.errorMessage = (e as Error).message;
            return result;
        } else {
            throw e;
        }
    }
}

/**
 * @deprecated Use executeSlashCommandsWithOptions instead
 */
export async function executeSlashCommands(env: StscriptEnv, text: string, handleParserErrors = true, scope: SlashCommandScope | null = null, handleExecutionErrors = false, parserFlags: ParserFlags | null = null, abortController: SlashCommandAbortController | null = null, onProgress: ((done: number, total: number) => void) | null = null): Promise<SlashCommandClosureResult | null> {
    return executeSlashCommandsWithOptions(env, text, {
        handleParserErrors,
        scope,
        handleExecutionErrors,
        parserFlags,
        abortController,
        onProgress,
    });
}

/**
 * variables.js executeSubCommands — if/while/times 的子命令通道:
 * 剥一层首尾引号后以 handle*Errors=false 执行;错误向调用方传播。
 */
export async function executeSubCommands(env: StscriptEnv, command: string, scope: SlashCommandScope | null = null, parserFlags: ParserFlags | null = null, abortController: SlashCommandAbortController | null = null): Promise<SlashCommandClosureResult | null> {
    if (command.startsWith('"') && command.endsWith('"')) {
        command = command.slice(1, -1);
    }

    const result = await executeSlashCommandsWithOptions(env, command, {
        handleExecutionErrors: false,
        handleParserErrors: false,
        parserFlags,
        scope,
        abortController: abortController ?? new SlashCommandAbortController(),
    });

    return result;
}

// ---------------------------------------------------------------------------
// 命令注册 — 原版 SlashCommandParser.commands 静态表 + initDefaultSlashCommands
// ---------------------------------------------------------------------------

/** 注册一条命令(reserved 前缀校验同原版)。 */
export function addCommandObject(command: SlashCommand): void {
    SlashCommandParser.addCommandObject(command);
}

/** 查询注册表(含别名解析)。 */
export function getCommand(name: string): SlashCommand | undefined {
    return SlashCommandParser.commands[name];
}

// ---------------------------------------------------------------------------
// runStscript — 设计文档的 server-runner 门面:{script,scope?} → {result,ops,error?}
// ---------------------------------------------------------------------------

export interface StscriptRunOptions extends ExecuteSlashCommandsOptions {
    /** 覆盖默认(注册全局 builtins 后执行);默认 true。 */
    initBuiltins?: boolean;
}

export interface StscriptRunError {
    code: 'unknown_command' | 'parser_error' | 'execution_error' | 'aborted';
    message: string;
    line?: number;
    column?: number;
    hint?: string;
    commandName?: string;
}

export interface StscriptRunOutput {
    /** 管道最终值(字符串;closure 结果不支持的形态已序列化)。 */
    result: string;
    /** 副作用回执。 */
    ops: StscriptOp[];
    /** 错误详情(无错时缺省)。 */
    error?: StscriptRunError;
    /** 执行被 /abort 或 abortController 终止。 */
    aborted: boolean;
    abortReason?: string;
    /** 执行中出现命令级错误(handleExecutionErrors 捕获或抛出后被包装)。 */
    isError: boolean;
    errorMessage?: string;
}

/** 引擎门面:注册 builtins → parse+execute → 归一化 {result,ops,error?}。 */
export async function runStscript(env: StscriptEnv, script: string, options: StscriptRunOptions = {}): Promise<StscriptRunOutput> {
    const { initBuiltins = true, ...execOptions } = options;
    if (initBuiltins) {
        const { registerBuiltinCommands } = await import('./builtins/index.js');
        registerBuiltinCommands();
    }

    const out: StscriptRunOutput = { result: '', ops: env.ops, aborted: false, isError: false };

    try {
        const result = await executeSlashCommandsWithOptions(env, script, {
            // runStscript 语义:默认把错误收进 error 字段而不是 toast/抛出
            handleParserErrors: false,
            handleExecutionErrors: false,
            ...execOptions,
        });
        if (result) {
            out.aborted = result.isAborted;
            out.abortReason = result.abortReason;
            out.isError = result.isError;
            out.errorMessage = result.errorMessage;
            out.result = result.pipe === undefined || result.pipe === null ? '' : typeof result.pipe === 'string' ? result.pipe : String(result.pipe);
            if (result.isAborted) {
                out.error = { code: 'aborted', message: result.abortReason ?? 'aborted' };
            } else if (result.isError) {
                out.error = { code: 'execution_error', message: result.errorMessage ?? 'execution error' };
            }
        }
    } catch (e) {
        if (e instanceof SlashCommandParserError) {
            const isUnknown = e.message.startsWith('Unknown command');
            out.error = {
                code: isUnknown ? 'unknown_command' : 'parser_error',
                message: e.message,
                line: e.line,
                column: e.column,
                hint: e.hint,
            };
            out.isError = true;
            out.errorMessage = e.message;
        } else if (e instanceof SlashCommandExecutionError) {
            out.error = {
                code: 'execution_error',
                message: e.message,
                line: e.line,
                column: e.column,
                hint: e.hint,
                commandName: e.commandName,
            };
            out.isError = true;
            out.errorMessage = e.message;
        } else {
            out.error = { code: 'execution_error', message: (e as Error)?.message ?? String(e) };
            out.isError = true;
            out.errorMessage = (e as Error)?.message ?? String(e);
        }
    }
    return out;
}
