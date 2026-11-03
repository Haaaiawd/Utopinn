/**
 * SlashCommandClosure — 移植自 ref/Luker/public/scripts/slash-commands/SlashCommandClosure.js。
 * {: ... :} 闭包:scope 帧、argumentList/providedArgumentList、executorList、
 * 生成器式三拍执行(resolve → exec → after)、pipe 值流、abort/break/debug 控制器。
 *
 * 语义差异(已在文件头声明,其余逐行照抄):
 * - `power_user.experimental_macro_engine` 分支(substituteWithMacroEngine,
 *   依赖未移植的新 MacroEngine ~4.7k 行)不移植;恒走 legacy while-loop 路径。
 *   与 packages/core 既有决定一致("experimental macro engine intentionally
 *   NOT ported; goldens were captured on the legacy path")。
 *   两路径对 {{pipe}}/{{var::name}}/scope 宏与 closure 拆分的表面语义一致;
 *   legacy 的 `match.groups.index` 上游即恒为 undefined(疑为上游笔误,
 *   照抄不改,见 substituteParams 注释)。
 * - substituteParams 调 core 的 substituteParams(text, env.macro)。
 * - 全局依赖(substituteParams 全局上下文/toastr/console 之外)经 env 注入。
 */
import { substituteParams } from '../macros/substitute.js';
import { escapeRegex } from '../utils.js';
import { delay, uuidv4 } from './util.js';
import { SlashCommandClosureResult, SlashCommandExecutionError, SlashCommandNamedArgumentAssignment } from './types.js';
import type { NamedArguments, UnnamedArguments } from './types.js';
import { SlashCommandAbortController, SlashCommandBreak, SlashCommandBreakController, SlashCommandBreakPoint, SlashCommandDebugController, SlashCommandExecutor } from './control.js';
import { SlashCommandScope } from './scope.js';
import type { StscriptEnv } from './env.js';
import type { SubstituteContext } from '../macros/substitute.js';

export class SlashCommandClosure {
    scope: SlashCommandScope;
    executeNow = false;
    argumentList: SlashCommandNamedArgumentAssignment[] = [];
    providedArgumentList: SlashCommandNamedArgumentAssignment[] = [];
    executorList: SlashCommandExecutor[] = [];
    abortController?: SlashCommandAbortController;
    breakController?: SlashCommandBreakController;
    debugController?: SlashCommandDebugController;
    onProgress?: (done: number, total: number) => void;
    rawText?: string;
    fullText?: string;
    parserContext?: string;
    /** 执行环境注入(core 扩展;未注入时宏求值用空默认 ctx)。 */
    env?: StscriptEnv;
    #source = uuidv4();
    get source() { return this.#source; }
    set source(value: string) {
        this.#source = value;
        for (const executor of this.executorList) {
            executor.source = value;
        }
    }

    get commandCount(): number {
        return this.executorList.map(executor => executor.commandCount).reduce((sum, cur) => sum + cur, 0);
    }

    constructor(parent: SlashCommandScope | null = null) {
        this.scope = new SlashCommandScope(parent);
    }

    toString() {
        return `[Closure]${this.executeNow ? '()' : ''}`;
    }

    /** env 缺省时的空宏上下文(standalone closure,如测试直接执行)。 */
    #macroCtx(): SubstituteContext {
        return this.env?.macro ?? { chat: [], chatMetadata: {}, globalVariables: {} };
    }

    /**
     * Performs parameter substitution using the macro engine.
     * 原版 experimental_macro_engine 分支 — 新 MacroEngine 未移植,不实现;
     * substituteParams 恒走下方 legacy 路径。保留方法壳以便将来补齐。
     */
    // substituteWithMacroEngine(text, scope, macroList) — NOT PORTED

    substituteParams(text: string, scope: SlashCommandScope | null = null): string | SlashCommandClosure | (string | SlashCommandClosure)[] {
        let isList = false;
        const listValues: (string | SlashCommandClosure)[] = [];
        scope = scope ?? this.scope;
        const escapeMacro = (it: { key: string }, isAnchored = false): string => {
            const regexText = escapeRegex(it.key.replace(/\*/g, '~~~WILDCARD~~~'))
                .replaceAll('~~~WILDCARD~~~', '(?:(?:(?!(?:::|}})).)*)')
            ;
            if (isAnchored) {
                return `^${regexText}$`;
            }
            return regexText;
        };
        const macroList = [...scope.macroList].sort((a, b) => {
            if (a.key.includes('*') && !b.key.includes('*')) return 1;
            if (!a.key.includes('*') && b.key.includes('*')) return -1;
            if (a.key.includes('*') && b.key.includes('*')) return b.key.indexOf('*') - a.key.indexOf('*');
            return 0;
        });
        // experimental_macro_engine 未移植 → 不分支到 substituteWithMacroEngine
        const macros = macroList.map(it => escapeMacro(it)).join('|');
        const re = new RegExp(`(?<pipe>{{pipe}})|(?:{{var::(?<var>[^\\s]+?)(?:::(?<varIndex>(?!}}).+))?}})|(?:{{(?<macro>${macros})}})`);
        let done = '';
        let remaining = text;
        const macroCtx = this.#macroCtx();
        while (re.test(remaining)) {
            const match = re.exec(remaining)!;
            const before = substituteParams(remaining.slice(0, match.index), macroCtx);
            const after = remaining.slice(match.index + match[0].length);
            // 上游此处为 match.groups.index(非 varIndex),恒 undefined——照抄
            const replacer = match.groups!.pipe ? scope.pipe : match.groups!.var ? scope.getVariable(match.groups!.var, match.groups!.index ?? null) : macroList.find(it => it.key == match.groups!.macro || new RegExp(escapeMacro(it, true)).test(match.groups!.macro!))?.value;
            if (replacer instanceof SlashCommandClosure) {
                replacer.abortController = this.abortController;
                replacer.breakController = this.breakController;
                replacer.scope.parent = this.scope;
                replacer.env ??= this.env;
                if (this.debugController && !replacer.debugController) {
                    replacer.debugController = this.debugController;
                }
                isList = true;
                if (match.index > 0) {
                    listValues.push(before);
                }
                listValues.push(replacer);
                if (match.index + match[0].length + 1 < remaining.length) {
                    const rest = this.substituteParams(after, scope);
                    listValues.push(...(Array.isArray(rest) ? rest : [rest]));
                }
                break;
            } else {
                done = `${done}${before}${replacer}`;
                remaining = after;
            }
        }
        if (!isList) {
            text = `${done}${substituteParams(remaining, macroCtx)}`;
        }

        if (isList) {
            if (listValues.length > 1) return listValues;
            return listValues[0]!;
        }
        return text;
    }

    getCopy(): SlashCommandClosure {
        const closure = new SlashCommandClosure();
        closure.scope = this.scope.getCopy();
        closure.executeNow = this.executeNow;
        closure.argumentList = this.argumentList;
        closure.providedArgumentList = this.providedArgumentList;
        closure.executorList = this.executorList;
        closure.abortController = this.abortController;
        closure.breakController = this.breakController;
        closure.debugController = this.debugController;
        closure.rawText = this.rawText;
        closure.fullText = this.fullText;
        closure.parserContext = this.parserContext;
        closure.source = this.source;
        closure.onProgress = this.onProgress;
        closure.env = this.env;
        return closure;
    }

    async execute(): Promise<SlashCommandClosureResult | undefined> {
        // execute a copy of the closure to no taint it and its scope with the effects of its execution
        // as this would affect the closure being called a second time (e.g., loop, multiple /run calls)
        const closure = this.getCopy();
        const gen = closure.executeDirect();
        let step: IteratorResult<SlashCommandExecutor | SlashCommandClosureResult | { closure: SlashCommandClosure; executor: SlashCommandExecutor } | undefined, SlashCommandClosureResult | undefined> | undefined;
        while (!step?.done) {
            step = await gen.next(this.debugController?.testStepping(this) ?? false);
            if (!(step.value instanceof SlashCommandClosureResult) && this.debugController) {
                this.debugController.isStepping = await this.debugController.awaitBreakPoint((step.value as { closure: SlashCommandClosure }).closure, (step.value as { executor: SlashCommandExecutor }).executor);
            }
        }
        return step.value;
    }

    async* executeDirect(): AsyncGenerator<SlashCommandExecutor | { closure: SlashCommandClosure; executor: SlashCommandExecutor } | undefined, SlashCommandClosureResult | undefined, boolean> {
        this.debugController?.down(this);
        // closure arguments
        for (const arg of this.argumentList) {
            let v: string | SlashCommandClosure | (string | SlashCommandClosure)[] | undefined = arg.value;
            if (v instanceof SlashCommandClosure) {
                const closure = v;
                closure.scope.parent = this.scope;
                closure.breakController = this.breakController;
                closure.env ??= this.env;
                if (closure.executeNow) {
                    v = (await closure.execute())?.pipe;
                } else {
                    v = closure;
                }
            } else {
                v = this.substituteParams(v);
            }
            // unescape value
            if (typeof v == 'string') {
                v = v
                    ?.replace(/\\\{/g, '{')
                    ?.replace(/\\\}/g, '}')
                ;
            }
            this.scope.letVariable(arg.name, v as string);
        }
        for (const arg of this.providedArgumentList) {
            let v: string | SlashCommandClosure | (string | SlashCommandClosure)[] | undefined = arg.value;
            if (v instanceof SlashCommandClosure) {
                const closure = v;
                closure.scope.parent = this.scope;
                closure.breakController = this.breakController;
                closure.env ??= this.env;
                if (closure.executeNow) {
                    v = (await closure.execute())?.pipe;
                } else {
                    v = closure;
                }
            } else {
                v = this.substituteParams(v, this.scope.parent);
            }
            // unescape value
            if (typeof v == 'string') {
                v = v
                    ?.replace(/\\\{/g, '{')
                    ?.replace(/\\\}/g, '}')
                ;
            }
            this.scope.setVariable(arg.name, v as string);
        }

        if (this.executorList.length == 0) {
            this.scope.pipe = '';
        }
        const stepper = this.executeStep();
        let step: IteratorResult<SlashCommandExecutor | SlashCommandClosureResult | { closure: SlashCommandClosure; executor: SlashCommandExecutor } | undefined, SlashCommandClosureResult | undefined> | undefined;
        while (!step?.done && !this.breakController?.isBreak) {
            // get executor before execution
            step = await stepper.next();
            if (step.value instanceof SlashCommandBreakPoint) {
                console.log('encountered SlashCommandBreakPoint');
                if (this.debugController) {
                    // resolve args
                    step = await stepper.next();
                    // "execute" breakpoint
                    step = await stepper.next();
                    // get next executor
                    step = await stepper.next();
                    // breakpoint has to yield before arguments are resolved if one of the
                    // arguments is an immediate closure, otherwise you cannot step into the
                    // immediate closure
                    const hasImmediateClosureInNamedArgs = (step.value as SlashCommandExecutor)?.namedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                    const hasImmediateClosureInUnnamedArgs = (step.value as SlashCommandExecutor)?.unnamedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                    if (hasImmediateClosureInNamedArgs || hasImmediateClosureInUnnamedArgs) {
                        this.debugController.isStepping = yield { closure: this, executor: step.value as SlashCommandExecutor };
                    } else {
                        this.debugController.isStepping = true;
                        this.debugController.stepStack[this.debugController.stepStack.length - 1] = true;
                    }
                }
            } else if (!step.done && this.debugController?.testStepping(this)) {
                this.debugController.isSteppingInto = false;
                // if stepping, have to yield before arguments are resolved if one of the arguments
                // is an immediate closure, otherwise you cannot step into the immediate closure
                const hasImmediateClosureInNamedArgs = (step.value as SlashCommandExecutor)?.namedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                const hasImmediateClosureInUnnamedArgs = (step.value as SlashCommandExecutor)?.unnamedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                if (hasImmediateClosureInNamedArgs || hasImmediateClosureInUnnamedArgs) {
                    this.debugController.isStepping = yield { closure: this, executor: step.value as SlashCommandExecutor };
                }
            }
            // resolve args
            step = await stepper.next();
            if (step.value instanceof SlashCommandBreak) {
                console.log('encountered SlashCommandBreak');
                if (this.breakController) {
                    this.breakController?.break();
                    break;
                }
            } else if (!step.done && this.debugController?.testStepping(this)) {
                this.debugController.isSteppingInto = false;
                this.debugController.isStepping = yield { closure: this, executor: step.value as SlashCommandExecutor };
            }
            // execute executor
            step = await stepper.next();
        }

        // if execution has returned a closure result, return that (should only happen on abort)
        if (step!.value instanceof SlashCommandClosureResult) {
            this.debugController?.up();
            return step!.value;
        }
        const result = Object.assign(new SlashCommandClosureResult(), { pipe: this.scope.pipe, isBreak: this.breakController?.isBreak ?? false });
        this.debugController?.up();
        return result;
    }
    /**
     * Generator that steps through the executor list.
     * Every executor is split into three steps:
     *  - before arguments are resolved
     *  - after arguments are resolved
     *  - after execution
     */
    async* executeStep(): AsyncGenerator<SlashCommandExecutor | undefined, SlashCommandClosureResult | undefined, void> {
        let done = 0;
        let isFirst = true;
        for (const executor of this.executorList) {
            this.onProgress?.(done, this.commandCount);
            if (this.debugController) {
                this.debugController.setExecutor(executor);
                this.debugController.namedArguments = undefined;
                this.debugController.unnamedArguments = undefined;
            }
            // yield before doing anything with this executor, the debugger might want to do
            // something with it (e.g., breakpoint, immediate closures that need resolving
            // or stepping into)
            yield executor;
            const args: NamedArguments = {
                _scope: this.scope,
                _parserFlags: executor.parserFlags,
                _abortController: this.abortController,
                _debugController: this.debugController,
                _hasUnnamedArgument: executor.unnamedArgumentList.length > 0,
                _env: this.env,
            };
            if (executor instanceof SlashCommandBreakPoint) {
                // nothing to do for breakpoints, just raise counter and yield for "before exec"
                done++;
                yield executor;
                isFirst = false;
            } else if (executor instanceof SlashCommandBreak) {
                // /break need to resolve the unnamed arg and put it into pipe, then yield
                // for "before exec"
                const value = await this.substituteUnnamedArgument(executor, isFirst, args);
                done += this.executorList.length - this.executorList.indexOf(executor);
                this.scope.pipe = (value ?? this.scope.pipe) as typeof this.scope.pipe;
                yield executor;
                isFirst = false;
            } else {
                // regular commands do all the argument resolving logic...
                await this.substituteNamedArguments(executor, args);
                const value = await this.substituteUnnamedArgument(executor, isFirst, args);

                let abortResult = await this.testAbortController();
                if (abortResult) {
                    return abortResult;
                }
                if (this.debugController) {
                    this.debugController.namedArguments = args;
                    this.debugController.unnamedArguments = value ?? '';
                }
                // then yield for "before exec"
                yield executor;
                // followed by command execution
                executor.onProgress = (subDone: number, subTotal: number) => this.onProgress?.(done + subDone, this.commandCount);
                const isStepping = this.debugController?.testStepping(this) ?? false;
                if (this.debugController) {
                    this.debugController.isStepping = false || this.debugController.isSteppingInto;
                }
                try {
                    this.scope.pipe = (await executor.command!.callback(args, value ?? '')) as typeof this.scope.pipe;
                } catch (ex) {
                    throw new SlashCommandExecutionError(ex, (ex as Error).message, executor.name, executor.start!, executor.end!, this.fullText!.slice(executor.start, executor.end), this.fullText!);
                }
                if (this.debugController) {
                    this.debugController.namedArguments = undefined;
                    this.debugController.unnamedArguments = undefined;
                    this.debugController.isStepping = isStepping;
                }
                this.#lintPipe(executor.command!);
                done += executor.commandCount;
                this.onProgress?.(done, this.commandCount);
                abortResult = await this.testAbortController();
                if (abortResult) {
                    return abortResult;
                }
            }
            // finally, yield for "after exec"
            yield executor;
            isFirst = false;
        }
    }

    async testPaused(): Promise<void> {
        while (!this.abortController?.signal?.aborted && this.abortController?.signal?.paused) {
            await delay(200);
        }
    }
    async testAbortController(): Promise<SlashCommandClosureResult | undefined> {
        await this.testPaused();
        if (this.abortController?.signal?.aborted) {
            const result = new SlashCommandClosureResult();
            result.isAborted = true;
            result.isQuietlyAborted = this.abortController.signal.isQuiet;
            result.abortReason = this.abortController.signal.reason!.toString();
            return result;
        }
    }

    async substituteNamedArguments(executor: SlashCommandExecutor, args: NamedArguments): Promise<void> {
        /**
         * Handles the assignment of named arguments, considering if they accept multiple values
         */
        const assign = (name: string, value: unknown): void => {
            // If an array is supposed to be assigned, assign it one by one
            if (Array.isArray(value)) {
                for (const val of value) {
                    assign(name, val);
                }
                return;
            }

            const definition = executor.command!.namedArgumentList.find(x => x.name == name);

            // Prefer definition name if a valid named args defintion is found
            name = definition?.name ?? name;

            // Unescape named argument
            if (value && typeof value == 'string') {
                value = value
                    .replace(/\\\{/g, '{')
                    .replace(/\\\}/g, '}')
                ;
            }

            // If the named argument accepts multiple values, we have to make sure to build an array correctly
            if (definition?.acceptsMultiple) {
                if (args[name] !== undefined) {
                    // If there already is something for that named arg, make the value is an array and add to it
                    let currentValue = args[name];
                    if (!Array.isArray(currentValue)) {
                        currentValue = [currentValue];
                    }
                    (currentValue as unknown[]).push(value);
                    args[name] = currentValue;
                } else {
                    // If there is nothing in there, we create an array with that singular value
                    args[name] = [value];
                }
            } else {
                args[name] !== undefined && console.debug(`Named argument assigned multiple times: ${name}`);
                args[name] = value;
            }
        };

        // substitute named arguments
        for (const arg of executor.namedArgumentList) {
            if (arg.value instanceof SlashCommandClosure) {
                const closure = arg.value;
                closure.scope.parent = this.scope;
                closure.breakController = this.breakController;
                closure.env ??= this.env;
                if (this.debugController && !closure.debugController) {
                    closure.debugController = this.debugController;
                }
                if (closure.executeNow) {
                    assign(arg.name, (await closure.execute())?.pipe);
                } else {
                    assign(arg.name, closure);
                }
            } else {
                assign(arg.name, this.substituteParams(arg.value));
            }
        }
    }

    async substituteUnnamedArgument(executor: SlashCommandExecutor, isFirst: boolean, args: NamedArguments): Promise<string | SlashCommandClosure | (string | SlashCommandClosure)[]> {
        let value: string | SlashCommandClosure | (string | SlashCommandClosure)[] | undefined;
        // substitute unnamed argument
        if (executor.unnamedArgumentList.length == 0) {
            if (!isFirst && executor.injectPipe) {
                value = this.scope.pipe as SlashCommandClosure | string | undefined;
                args._hasUnnamedArgument = this.scope.pipe !== null && this.scope.pipe !== undefined;
            }
        } else {
            value = [];
            for (let i = 0; i < executor.unnamedArgumentList.length; i++) {
                let v: string | SlashCommandClosure | (string | SlashCommandClosure)[] | undefined = executor.unnamedArgumentList[i]!.value;
                if (v instanceof SlashCommandClosure) {
                    const closure = v;
                    closure.scope.parent = this.scope;
                    closure.breakController = this.breakController;
                    closure.env ??= this.env;
                    if (this.debugController && !closure.debugController) {
                        closure.debugController = this.debugController;
                    }
                    if (closure.executeNow) {
                        v = (await closure.execute())?.pipe;
                    } else {
                        v = closure;
                    }
                } else {
                    v = this.substituteParams(v);
                }
                value[i] = v as unknown as string | SlashCommandClosure;
            }
            if (!executor.command!.splitUnnamedArgument) {
                if (value.length == 1) {
                    value = value[0];
                } else if (!(value as unknown[]).find(it => it instanceof SlashCommandClosure)) {
                    value = (value as unknown[]).join('');
                }
            }
        }
        // unescape unnamed argument
        if (typeof value == 'string') {
            value = value
                ?.replace(/\\\{/g, '{')
                ?.replace(/\\\}/g, '}')
            ;
        } else if (Array.isArray(value)) {
            value = value.map(v => {
                if (typeof v == 'string') {
                    return v
                        ?.replace(/\\\{/g, '{')
                        ?.replace(/\\\}/g, '}');
                }
                return v;
            });
        }

        value ??= '';

        // Make sure that if unnamed args are split, it should always return an array
        if (executor.command!.splitUnnamedArgument && !Array.isArray(value)) {
            value = [value];
        }

        return value;
    }

    /**
     * Auto-fixes the pipe if it is not a valid result for STscript.
     */
    #lintPipe(command: { name: string }): void {
        if (this.scope.pipe === undefined || this.scope.pipe === null) {
            console.warn(`/${command.name} returned undefined or null. Auto-fixing to empty string.`);
            this.scope.pipe = '';
        } else if (!(typeof this.scope.pipe == 'string' || this.scope.pipe instanceof SlashCommandClosure)) {
            console.warn(`/${command.name} returned illegal type (${typeof this.scope.pipe} - ${(this.scope.pipe as unknown as object)?.constructor?.name ?? ''}). Auto-fixing to stringified JSON.`);
            this.scope.pipe = JSON.stringify(this.scope.pipe) ?? '';
        }
    }
}
