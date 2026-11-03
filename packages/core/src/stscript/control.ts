/**
 * 控制类集合 — 移植自 ref/Luker/public/scripts/slash-commands/:
 * AbstractEventTarget / SlashCommandAbortController(+Signal) /
 * SlashCommandBreakController / SlashCommandDebugController /
 * SlashCommandExecutor / SlashCommandBreak / SlashCommandBreakPoint。
 * 原文件均为纯逻辑,无 DOM;照抄。
 */
import { uuidv4 } from './util.js';
import type { SlashCommand } from './types.js';
import type { SlashCommandNamedArgumentAssignment, SlashCommandUnnamedArgumentAssignment } from './types.js';
import type { ParserFlags } from './parser.js';
import { SlashCommandClosure } from './closure.js';

/** AbstractEventTarget — 迷你 EventTarget 实现,原版照抄。 */
export abstract class AbstractEventTarget {
    listeners: Record<string, ((event: { type: string }) => void)[]>;

    constructor() {
        this.listeners = {};
    }

    addEventListener(type: string, callback: (event: { type: string }) => void, _options?: unknown): void {
        if (!this.listeners[type]) {
            this.listeners[type] = [];
        }
        this.listeners[type]!.push(callback);
    }

    dispatchEvent(event: { type: string }): boolean {
        if (!this.listeners[event.type] || this.listeners[event.type]!.length === 0) {
            return true;
        }
        this.listeners[event.type]!.forEach(listener => {
            listener(event);
        });
        return true;
    }

    removeEventListener(type: string, callback: (event: { type: string }) => void, _options?: unknown): void {
        if (!this.listeners[type]) {
            return;
        }
        const index = this.listeners[type]!.indexOf(callback);
        if (index !== -1) {
            this.listeners[type]!.splice(index, 1);
        }
    }
}

export class SlashCommandAbortSignal {
    isQuiet = false;
    paused = false;
    aborted = false;
    reason: string | null = null;
}

/** SlashCommandAbortController — abort/pause/continue 信号源。 */
export class SlashCommandAbortController extends AbstractEventTarget {
    signal: SlashCommandAbortSignal;

    constructor() {
        super();
        this.signal = new SlashCommandAbortSignal();
    }
    abort(reason = 'No reason.', isQuiet = false): void {
        this.signal.isQuiet = isQuiet;
        this.signal.aborted = true;
        this.signal.reason = reason;
        this.dispatchEvent({ type: 'abort' });
    }
    pause(reason = 'No reason.'): void {
        this.signal.paused = true;
        this.signal.reason = reason;
        this.dispatchEvent({ type: 'pause' });
    }
    continue(reason = 'No reason.'): void {
        this.signal.paused = false;
        this.signal.reason = reason;
        this.dispatchEvent({ type: 'continue' });
    }
}

/** SlashCommandBreakController — /break 命中标记,原版照抄。 */
export class SlashCommandBreakController {
    isBreak = false;

    break(): void {
        this.isBreak = true;
    }
}

/**
 * SlashCommandDebugController — 调试步进控制器。
 * 原版已是纯逻辑;服务端默认不传,执行路径全部 `?.` 防御。
 */
export class SlashCommandDebugController {
    stack: SlashCommandClosure[] = [];
    cmdStack: SlashCommandExecutor[] = [];
    stepStack: boolean[] = [];
    isStepping = false;
    isSteppingInto = false;
    isSteppingOut = false;

    namedArguments?: Record<string, unknown>;
    unnamedArguments?: string | SlashCommandClosure | (string | SlashCommandClosure)[];

    continuePromise: Promise<boolean> | null = null;
    continueResolver?: (value: boolean) => void;

    onBreakPoint?: (closure: SlashCommandClosure, executor: SlashCommandExecutor) => Promise<boolean>;

    testStepping(closure: SlashCommandClosure): boolean {
        return this.stepStack[this.stack.indexOf(closure)] ?? false;
    }

    down(closure: SlashCommandClosure): void {
        this.stack.push(closure);
        if (this.stepStack.length < this.stack.length) {
            this.stepStack.push(this.isSteppingInto);
        }
    }
    up(): void {
        this.stack.pop();
        while (this.cmdStack.length > this.stack.length) this.cmdStack.pop();
        this.stepStack.pop();
    }

    setExecutor(executor: SlashCommandExecutor): void {
        this.cmdStack[this.stack.length - 1] = executor;
    }

    resume(): void {
        this.continueResolver?.(false);
        this.continuePromise = null;
        this.stepStack.forEach((_, idx) => this.stepStack[idx] = false);
    }
    step(): void {
        this.stepStack.forEach((_, idx) => this.stepStack[idx] = true);
        this.continueResolver?.(true);
        this.continuePromise = null;
    }
    stepInto(): void {
        this.isSteppingInto = true;
        this.stepStack.forEach((_, idx) => this.stepStack[idx] = true);
        this.continueResolver?.(true);
        this.continuePromise = null;
    }
    stepOut(): void {
        this.isSteppingOut = true;
        this.stepStack[this.stepStack.length - 1] = false;
        this.continueResolver?.(false);
        this.continuePromise = null;
    }

    async awaitContinue(): Promise<boolean> {
        this.continuePromise ??= new Promise(resolve => {
            this.continueResolver = resolve;
        });
        this.isStepping = await this.continuePromise;
        return this.isStepping;
    }

    async awaitBreakPoint(closure: SlashCommandClosure, executor: SlashCommandExecutor): Promise<boolean> {
        this.isStepping = await this.onBreakPoint!(closure, executor);
        return this.isStepping;
    }
}

/**
 * SlashCommandExecutor — 单条已解析命令(`command` 元数据 + 命名/匿名实参)。
 * 字段与原版一一对应。
 */
export class SlashCommandExecutor {
    injectPipe = true;
    start?: number;
    end?: number;
    startNamedArgs?: number;
    endNamedArgs?: number;
    startUnnamedArgs?: number;
    endUnnamedArgs?: number;
    name = '';
    #source: string = uuidv4();
    get source(): string { return this.#source; }
    set source(value: string) {
        this.#source = value;
        for (const arg of this.namedArgumentList.filter(it => it.value instanceof SlashCommandClosure)) {
            (arg.value as SlashCommandClosure).source = value;
        }
        for (const arg of this.unnamedArgumentList.filter(it => it.value instanceof SlashCommandClosure)) {
            (arg.value as SlashCommandClosure).source = value;
        }
    }
    command?: SlashCommand;
    namedArgumentList: SlashCommandNamedArgumentAssignment[] = [];
    unnamedArgumentList: SlashCommandUnnamedArgumentAssignment[] = [];
    parserFlags?: ParserFlags;

    get commandCount(): number {
        return 1
            + this.namedArgumentList.filter(it => it.value instanceof SlashCommandClosure).map(it => (it.value as SlashCommandClosure).commandCount).reduce((cur, sum) => cur + sum, 0)
            + this.unnamedArgumentList.filter(it => it.value instanceof SlashCommandClosure).map(it => (it.value as SlashCommandClosure).commandCount).reduce((cur, sum) => cur + sum, 0)
        ;
    }

    set onProgress(value: ((done: number, total: number) => void) | undefined) {
        const closures = [
            ...this.namedArgumentList.filter(it => it.value instanceof SlashCommandClosure).map(it => it.value as SlashCommandClosure),
            ...this.unnamedArgumentList.filter(it => it.value instanceof SlashCommandClosure).map(it => it.value as SlashCommandClosure),
        ];
        for (const closure of closures) {
            closure.onProgress = value;
        }
    }

    constructor(start?: number) {
        this.start = start;
    }
}

/** SlashCommandBreak — `/break`,value 取匿名实参首位。 */
export class SlashCommandBreak extends SlashCommandExecutor {
    get value() {
        return this.unnamedArgumentList[0]?.value;
    }
}

/** SlashCommandBreakPoint — QR 编辑器断点标记(无调试器时为空转)。 */
export class SlashCommandBreakPoint extends SlashCommandExecutor {}
