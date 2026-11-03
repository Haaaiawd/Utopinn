/**
 * STscript 数据类型层 — 移植自 ref/Luker/public/scripts/slash-commands/ 下的
 * 纯数据类:SlashCommandArgument / SlashCommandNamedArgument / SlashCommandEnumValue /
 * SlashCommand(Named|Unnamed)ArgumentAssignment / SlashCommandClosureResult /
 * SlashCommandParserError / SlashCommandExecutionError / SlashCommand。
 *
 * 删减:所有 DOM 渲染方法(renderHelpItem/renderHelpDetails/helpCache)、
 * autocomplete 专用类的运行时行为;字段形状与原类保持一致。
 */
import type { SlashCommandClosure } from './closure.js';
import type { SlashCommandExecutor, SlashCommandAbortController, SlashCommandDebugController } from './control.js';
import type { SlashCommandScope } from './scope.js';
import type { StscriptEnv } from './env.js';
import type { ParserFlags } from './parser.js';

/** @readonly 参数类型枚举,与 ARGUMENT_TYPE 一致。 */
export const ARGUMENT_TYPE = {
    STRING: 'string',
    NUMBER: 'number',
    RANGE: 'range',
    BOOLEAN: 'bool',
    VARIABLE_NAME: 'varname',
    CLOSURE: 'closure',
    SUBCOMMAND: 'subcommand',
    LIST: 'list',
    DICTIONARY: 'dictionary',
} as const;
export type ArgumentType = (typeof ARGUMENT_TYPE)[keyof typeof ARGUMENT_TYPE];

/** 匿名(管道)实参的取值形态:string、closure 或两者的数组。 */
export type UnnamedArgumentValue = string | SlashCommandClosure;
export type UnnamedArguments = string | SlashCommandClosure | (string | SlashCommandClosure)[];

/** 命名实参捕获表(命令回调收到的 args)。 */
export interface NamedArgumentsCapture {
    [id: string]: string | SlashCommandClosure | (string | SlashCommandClosure)[] | unknown;
}

/**
 * 命令回调收到的完整命名实参,含引擎注入的 `_` 前缀通道。
 * `_env` 为本仓扩展: Luker 靠全局单例拿到 host 依赖,core 以注入 env 替代。
 */
export interface NamedArguments extends NamedArgumentsCapture {
    _scope: SlashCommandScope;
    _parserFlags?: ParserFlags;
    _abortController?: SlashCommandAbortController;
    _debugController?: SlashCommandDebugController;
    _hasUnnamedArgument: boolean;
    _env?: StscriptEnv;
}

/**
 * 命令回调签名。原版 JS 回调实际返回任意值(数字/对象/undefined 等),
 * 由 SlashCommandClosure.#lintPipe 归一化进管道,这里如实标为 unknown。
 */
export type SlashCommandCallback = (
    namedArguments: NamedArguments,
    unnamedArguments: UnnamedArguments,
) => unknown;

export type EnumType = 'enum' | 'command' | 'namedArgument' | 'variable' | 'qr' | 'macro' | 'number' | 'name' | 'type';

/** enumTypes — 与 SlashCommandEnumValue.js 一致(自动补全着色元数据)。 */
export const enumTypes = {
    enum: 'enum',
    command: 'command',
    namedArgument: 'namedArgument',
    variable: 'variable',
    qr: 'qr',
    macro: 'macro',
    number: 'number',
    name: 'name',
    type: 'type',
    getBasedOnIndex(index?: number): EnumType {
        // 原版把 'getBasedOnIndex' 自身也计入 keys(返回类型因此可能取到函数);
        // 仅作自动补全图标用,照抄。
        const keys = Object.keys(this);
        return this[keys[(index ?? 0) % keys.length] as keyof typeof enumTypes] as EnumType;
    },
} as const;

/** enumIcons — SlashCommandCommonEnumsProvider.js 中本切片用到的子集,原值照抄。 */
export const enumIcons = {
    default: '◊',
    true: '✔️',
    false: '❌',
    boolean: '🔲',
    string: '📝',
    number: '1️⃣',
    array: '[]',
    enum: '📚',
    dictionary: '{}',
    variable: '🔠',
    localVariable: '📦',
    globalVariable: '🌐',
    message: '✉️',
    popup: '🗔',
    qr: '⚡',
    system: '⚙️',
    user: '👤',
    assistant: '🤖',
    character: '👤',
    type: '🏷️',
    macro: '📦',
    name: '🔤',
} as const;

/** SlashCommandEnumValue — 枚举值元数据(仅作注册表/文档用,无运行时行为)。 */
export class SlashCommandEnumValue {
    value: string;
    description: string | null;
    type: EnumType;
    typeIcon: string;
    matchProvider?: ((input: string) => boolean) | null;
    valueProvider?: ((input: string) => string) | null;
    makeSelectable: boolean;

    constructor(
        value: string,
        description: string | null = null,
        type: EnumType | null = 'enum',
        typeIcon = '◊',
        matchProvider: ((input: string) => boolean) | null = null,
        valueProvider: ((input: string) => string) | null = null,
        makeSelectable = false,
    ) {
        this.value = value;
        this.description = description;
        this.type = type ?? 'enum';
        this.typeIcon = typeIcon;
        this.matchProvider = matchProvider;
        this.valueProvider = valueProvider;
        this.makeSelectable = makeSelectable;
    }

    toString() {
        return this.value;
    }
}

export type EnumProvider = (executor: SlashCommandExecutor, scope: SlashCommandScope) => SlashCommandEnumValue[];

/**
 * commonEnumProviders.boolean — 原版照抄(autocomplete 元数据,非执行路径)。
 * mode: 'onOff'|'onOffToggle'|'trueFalse'。
 */
export function booleanEnumProvider(mode: 'onOff' | 'onOffToggle' | 'trueFalse' = 'trueFalse'): () => SlashCommandEnumValue[] {
    return () => {
        switch (mode) {
            case 'onOff': return [new SlashCommandEnumValue('on', null, 'macro', enumIcons.true), new SlashCommandEnumValue('off', null, 'macro', enumIcons.false)];
            case 'onOffToggle': return [new SlashCommandEnumValue('on', null, 'macro', enumIcons.true), new SlashCommandEnumValue('off', null, 'macro', enumIcons.false), new SlashCommandEnumValue('toggle', null, 'macro', enumIcons.boolean)];
            case 'trueFalse': return [new SlashCommandEnumValue('true', null, 'macro', enumIcons.true), new SlashCommandEnumValue('false', null, 'macro', enumIcons.false)];
            default: throw new Error(`Invalid boolean enum provider mode: ${mode}`);
        }
    };
}

/** commonEnumProviders.types — 'as' 参数的枚举,原版照抄。 */
export function typesEnumProvider(): SlashCommandEnumValue[] {
    return [
        new SlashCommandEnumValue('string', null, 'type', enumIcons.string),
        new SlashCommandEnumValue('number', null, 'type', enumIcons.number),
        new SlashCommandEnumValue('int', null, 'type', enumIcons.number),
        new SlashCommandEnumValue('float', null, 'type', enumIcons.number),
        new SlashCommandEnumValue('boolean', null, 'type', enumIcons.boolean),
        new SlashCommandEnumValue('array', null, 'type', enumIcons.array),
        new SlashCommandEnumValue('list', null, 'type', enumIcons.array),
        new SlashCommandEnumValue('object', null, 'type', enumIcons.dictionary),
        new SlashCommandEnumValue('dict', null, 'type', enumIcons.dictionary),
        new SlashCommandEnumValue('dictionary', null, 'type', enumIcons.dictionary),
        new SlashCommandEnumValue('null', null, 'type', enumIcons.false),
        new SlashCommandEnumValue('undefined', null, 'type', enumIcons.false),
        new SlashCommandEnumValue('none', null, 'type', enumIcons.false),
    ];
}

export interface SlashCommandArgumentProps {
    description: string;
    typeList?: ArgumentType | ArgumentType[];
    isRequired?: boolean;
    acceptsMultiple?: boolean;
    defaultValue?: string | SlashCommandClosure | null;
    enumList?: (string | SlashCommandEnumValue)[];
    enumProvider?: EnumProvider | null;
    forceEnum?: boolean;
}

/** SlashCommandArgument(匿名参数定义)— 字段照抄,无运行差异。 */
export class SlashCommandArgument {
    static fromProps(props: SlashCommandArgumentProps): SlashCommandArgument {
        return new SlashCommandArgument(
            props.description,
            props.typeList ?? [ARGUMENT_TYPE.STRING],
            props.isRequired ?? false,
            props.acceptsMultiple ?? false,
            props.defaultValue ?? null,
            props.enumList ?? [],
            props.enumProvider ?? null,
            props.forceEnum ?? false,
        );
    }

    description: string;
    typeList: ArgumentType[] = [];
    isRequired = false;
    acceptsMultiple = false;
    defaultValue: string | SlashCommandClosure | null;
    enumList: SlashCommandEnumValue[] = [];
    enumProvider: EnumProvider | null = null;
    forceEnum = false;

    constructor(
        description: string,
        types?: ArgumentType | ArgumentType[],
        isRequired = false,
        acceptsMultiple = false,
        defaultValue: string | SlashCommandClosure | null = null,
        enums: (string | SlashCommandEnumValue)[] = [],
        enumProvider: EnumProvider | null = null,
        forceEnum = false,
    ) {
        this.description = description;
        this.typeList = types ? (Array.isArray(types) ? types : [types]) : [];
        this.isRequired = isRequired ?? false;
        this.acceptsMultiple = acceptsMultiple ?? false;
        this.defaultValue = defaultValue;
        this.enumList = (enums ? (Array.isArray(enums) ? enums : [enums]) : []).map(it => {
            if (it instanceof SlashCommandEnumValue) return it;
            return new SlashCommandEnumValue(it);
        });
        this.enumProvider = enumProvider;
        this.forceEnum = forceEnum;

        // 布尔单类型参数默认补 true/false 枚举(原版行为)
        if (!this.enumList.length && this.typeList.length === 1 && this.typeList.includes(ARGUMENT_TYPE.BOOLEAN)) {
            this.enumList = booleanEnumProvider()();
        }
    }
}

export interface SlashCommandNamedArgumentProps extends SlashCommandArgumentProps {
    name: string;
    aliasList?: string[];
}

/** SlashCommandNamedArgument(命名参数定义)— 字段照抄。 */
export class SlashCommandNamedArgument extends SlashCommandArgument {
    static fromProps(props: SlashCommandNamedArgumentProps): SlashCommandNamedArgument {
        return new SlashCommandNamedArgument(
            props.name,
            props.description,
            props.typeList ?? [ARGUMENT_TYPE.STRING],
            props.isRequired ?? false,
            props.acceptsMultiple ?? false,
            props.defaultValue ?? null,
            props.enumList ?? [],
            props.aliasList ?? [],
            props.enumProvider ?? null,
            props.forceEnum ?? false,
        );
    }

    name: string;
    aliasList: string[] = [];

    constructor(
        name: string,
        description: string,
        types?: ArgumentType | ArgumentType[],
        isRequired = false,
        acceptsMultiple = false,
        defaultValue: string | SlashCommandClosure | null = null,
        enums: (string | SlashCommandEnumValue)[] = [],
        aliases: string[] = [],
        enumProvider: EnumProvider | null = null,
        forceEnum = false,
    ) {
        super(description, types, isRequired, acceptsMultiple, defaultValue, enums, enumProvider, forceEnum);
        this.name = name;
        this.aliasList = aliases ? (Array.isArray(aliases) ? aliases : [aliases]) : [];
    }
}

/** SlashCommandNamedArgumentAssignment — 解析产物:name=value。 */
export class SlashCommandNamedArgumentAssignment {
    start?: number;
    end?: number;
    name = '';
    value: string | SlashCommandClosure = '';
}

/** SlashCommandUnnamedArgumentAssignment — 解析产物:匿名/管道实参片段。 */
export class SlashCommandUnnamedArgumentAssignment {
    start?: number;
    end?: number;
    value: string | SlashCommandClosure = '';
}

/** SlashCommandClosureResult — 执行结果容器,字段照抄。 */
export class SlashCommandClosureResult {
    interrupt = false;
    pipe?: string | SlashCommandClosure;
    isBreak = false;
    isAborted = false;
    isQuietlyAborted = false;
    abortReason?: string;
    isError = false;
    errorMessage?: string;
}

export interface SlashCommandProps {
    name?: string;
    callback?: SlashCommandCallback;
    helpString?: string;
    splitUnnamedArgument?: boolean;
    splitUnnamedArgumentCount?: number;
    rawQuotes?: boolean;
    aliases?: string[];
    returns?: string;
    namedArgumentList?: SlashCommandNamedArgument[];
    unnamedArgumentList?: SlashCommandArgument[];
}

/**
 * SlashCommand — 仅保留数据形状与 fromProps;
 * 原版 renderHelpItem/renderHelpDetails/helpCache(DOM)不移植。
 */
export class SlashCommand {
    static fromProps(props: SlashCommandProps): SlashCommand {
        const instance = Object.assign(new this(), props);
        return instance;
    }

    name = '';
    callback: SlashCommandCallback = () => '';
    helpString?: string;
    splitUnnamedArgument = false;
    splitUnnamedArgumentCount?: number;
    /** true 时不剥匿名实参的字面引号(可用 raw=false 命名参数覆盖)。 */
    rawQuotes = false;
    aliases: string[] = [];
    returns?: string;
    namedArgumentList: SlashCommandNamedArgument[] = [];
    unnamedArgumentList: SlashCommandArgument[] = [];

    isExtension = false;
    isThirdParty = false;
    source?: string;
}

/** SlashCommandParserError — 解析错误,带 line/column/hint。 */
export class SlashCommandParserError extends Error {
    text: string;
    index: number;

    get line(): number {
        return this.text.slice(0, this.index).replace(/[^\n]/g, '').length;
    }
    get column(): number {
        return this.text.slice(0, this.index).split('\n').pop()!.length;
    }
    get hint(): string {
        const lineOffset = this.line.toString().length;
        let lineStart = this.index;
        let start = this.index;
        let end = this.index;
        let offset = 0;
        let lineCount = 0;
        while (offset < 10000 && lineCount < 3 && start >= 0) {
            if (this.text[start] == '\n') lineCount++;
            if (lineCount == 0) lineStart--;
            offset++;
            start--;
        }
        if (this.text[start + 1] == '\n') start++;
        offset = 0;
        while (offset < 10000 && this.text[end] != '\n') {
            offset++;
            end++;
        }
        const hint: string[] = [];
        const lines = this.text.slice(start + 1, end - 1).split('\n');
        let lineNum = this.line - lines.length + 1;
        let tabOffset = 0;
        for (const line of lines) {
            const num = `${' '.repeat(lineOffset - lineNum.toString().length)}${lineNum}`;
            lineNum++;
            const untabbedLine = line.replace(/\t/g, ' '.repeat(4));
            tabOffset = untabbedLine.length - line.length;
            hint.push(`${num}:  ${untabbedLine}`);
        }
        hint.push(`${' '.repeat(this.index - lineStart + lineOffset + 1 + tabOffset)}^^^^^`);
        return hint.join('\n');
    }

    constructor(message: string, text: string, index: number) {
        super(message);
        this.text = text;
        this.index = index;
    }
}

/** SlashCommandExecutionError — 回调抛错的包装,带命令位置/文本。 */
export class SlashCommandExecutionError extends Error {
    commandName: string;
    start: number;
    end: number;
    commandText: string;
    text: string;

    get index() { return this.start; }
    get line(): number {
        return this.text.slice(0, this.index).replace(/[^\n]/g, '').length;
    }
    get column(): number {
        return this.text.slice(0, this.index).split('\n').pop()!.length;
    }
    get hint(): string {
        const lineOffset = this.line.toString().length;
        let lineStart = this.index;
        let start = this.index;
        let end = this.index;
        let offset = 0;
        let lineCount = 0;
        while (offset < 10000 && lineCount < 3 && start >= 0) {
            if (this.text[start] == '\n') lineCount++;
            if (lineCount == 0) lineStart--;
            offset++;
            start--;
        }
        if (this.text[start + 1] == '\n') start++;
        offset = 0;
        while (offset < 10000 && this.text[end] != '\n') {
            offset++;
            end++;
        }
        const hint: string[] = [];
        const lines = this.text.slice(start + 1, end - 1).split('\n');
        let lineNum = this.line - lines.length + 1;
        let tabOffset = 0;
        for (const line of lines) {
            const num = `${' '.repeat(lineOffset - lineNum.toString().length)}${lineNum}`;
            lineNum++;
            const untabbedLine = line.replace(/\t/g, ' '.repeat(4));
            tabOffset = untabbedLine.length - line.length;
            hint.push(`${num}:  ${untabbedLine}`);
        }
        hint.push(`${' '.repeat(this.index - lineStart + lineOffset + 1 + tabOffset)}^^^^^`);
        return hint.join('\n');
    }

    constructor(cause: unknown, message: string | undefined, commandName: string, start: number, end: number, commandText: string, fullText: string) {
        super(message ?? '', { cause });
        this.commandName = commandName;
        this.start = start;
        this.end = end;
        this.commandText = commandText;
        this.text = fullText;
    }
}
