/**
 * 首批 builtin:变量/控制流/数字命令 — 移植自 ref/Luker/public/scripts/variables.js
 * registerVariableCommands 全量:listvar/setvar/getvar/addvar/setglobalvar/
 * getglobalvar/addglobalvar/incvar/decvar/incglobalvar/decglobalvar/pushvar/
 * popvar/if/while/times/flushvar/flushglobalvar/add/mul/min/max/sub/div/mod/
 * pow/sin/cos/log/round/abs/sqrt/len/rand/var/let/closure-serialize/
 * closure-deserialize/sort + if/while/times 的 else/guard 语义。
 *
 * 存取层差异:chat_metadata.variables → args._env.macro.chatMetadata.variables,
 * extension_settings.variables.global → args._env.macro.globalVariables;
 * saveMetadataDebounced/saveSettingsDebounced → env.host.persistMetadata/
 * persistSettings;写操作同时落 ops 回执。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandEnumValue, enumTypes, enumIcons, booleanEnumProvider, typesEnumProvider } from '../types.js';
import { SlashCommandClosure } from '../closure.js';
import { SlashCommandBreakController } from '../control.js';
import { SlashCommandParser } from '../parser.js';
import { isFalseBoolean } from '../util.js';
import type { StscriptEnv } from '../env.js';
import { addCommandObject, executeSubCommands } from '../registry.js';
import { doReturn, returnEnumList } from './common.js';
import {
    addVar, decrementVar, deleteGlobalVar, deleteVar, evalBoolean,
    getVar, incrementVar, parseBooleanOperands, performOperation,
    popVar, pushVar, setGlobalVar, setVar,
} from '../var-store.js';
import type { VarStore } from '../var-store.js';

const MAX_LOOPS = 100;

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

/** chat_metadata.variables(缺省自动初始化,与原版一致)。 */
function localStore(env: StscriptEnv): VarStore {
    if (!env.macro.chatMetadata.variables) {
        env.macro.chatMetadata.variables = {};
    }
    return env.macro.chatMetadata.variables;
}

/** extension_settings.variables.global。 */
function globalStore(env: StscriptEnv): VarStore {
    return env.macro.globalVariables;
}

function localOp(env: StscriptEnv, key: string, value: unknown): void {
    env.host.persistMetadata?.();
    env.ops.push({ type: 'setvar', scope: 'local', key, value });
}
function localDel(env: StscriptEnv, key: string): void {
    env.host.persistMetadata?.();
    env.ops.push({ type: 'delvar', scope: 'local', key });
}
function globalOp(env: StscriptEnv, key: string, value: unknown): void {
    env.host.persistSettings?.();
    env.ops.push({ type: 'setvar', scope: 'global', key, value });
}
function globalDel(env: StscriptEnv, key: string): void {
    env.host.persistSettings?.();
    env.ops.push({ type: 'delvar', scope: 'global', key });
}

// ---------------------------------------------------------------------------
// callbacks — variables.js 对应实现
// ---------------------------------------------------------------------------

async function listVariablesCallback(args: NamedArguments): Promise<unknown> {
    const env = envOf(args);
    /** @type {SlashCommandReturnType} */
    let returnType = args['return'] as string;

    const scope = String(args?.['scope'] || '').toLowerCase().trim() || 'all';
    const local = localStore(env);
    const global = globalStore(env);

    const includeLocalVariables = scope === 'all' || scope === 'local';
    const includeGlobalVariables = scope === 'all' || scope === 'global';

    const localVariables = includeLocalVariables ? Object.entries(local).map(([name, value]) => `${name}: ${value}`) : [];
    const globalVariables = includeGlobalVariables ? Object.entries(global).map(([name, value]) => `${name}: ${value}`) : [];

    const buildTextValue = (): string => {
        const localVariablesString = localVariables.length > 0 ? localVariables.join('\n\n') : 'No local variables';
        const globalVariablesString = globalVariables.length > 0 ? globalVariables.join('\n\n') : 'No global variables';
        const chatName = env.macro.currentChatId;

        const message = [
            includeLocalVariables ? `### Local variables (${chatName}):\n${localVariablesString}` : '',
            includeGlobalVariables ? `### Global variables:\n${globalVariablesString}` : '',
        ].filter(x => x).join('\n\n');
        return message;
    };

    const jsonVariables = [
        ...Object.entries(local).map(x => ({ key: x[0], value: x[1], scope: 'local' })),
        ...Object.entries(global).map(x => ({ key: x[0], value: x[1], scope: 'global' })),
    ];

    return await doReturn(env, returnType ?? 'popup-html', jsonVariables, { objectToStringFunc: buildTextValue });
}

async function whileCallback(args: NamedArguments, value: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    if (args['guard'] instanceof SlashCommandClosure) throw new Error('argument \'guard\' cannot be a closure for command /while');
    const isGuardOff = isFalseBoolean(args['guard']?.toString());
    const iterations = isGuardOff ? Number.MAX_SAFE_INTEGER : MAX_LOOPS;
    /**@type {string|SlashCommandClosure} */
    let command: string | SlashCommandClosure | undefined;
    if (value) {
        // 原版直接 value[0]/value.join(' ') — 非数组字符串上 join 会
        // TypeError(splitUnnamedArgument 下恒为数组或 ''),照抄
        if ((value as unknown[])[0] instanceof SlashCommandClosure) {
            command = (value as SlashCommandClosure[])[0];
        } else {
            command = (value as (string | SlashCommandClosure)[]).join(' ');
        }
    }

    let commandResult;
    for (let i = 0; i < iterations; i++) {
        const { a, b, rule } = parseBooleanOperands(args, { local: localStore(env), global: globalStore(env) });
        const result = evalBoolean(rule, a, b);

        if (result && command) {
            if (command instanceof SlashCommandClosure) {
                command.breakController = new SlashCommandBreakController();
                commandResult = await command.execute();
            } else {
                commandResult = await executeSubCommands(env, command, args._scope, args._parserFlags ?? null, args._abortController ?? null);
            }
            if (commandResult!.isAborted) break;
            if (commandResult!.isBreak) break;
        } else {
            break;
        }
    }

    if (commandResult) {
        return commandResult.pipe;
    }

    return '';
}

async function timesCallback(args: NamedArguments, value: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    if (args['guard'] instanceof SlashCommandClosure) throw new Error('argument \'guard\' cannot be a closure for command /while');
    let repeats: unknown;
    let command: string | SlashCommandClosure;
    if (Array.isArray(value)) {
        const [r, ...cmd] = value;
        repeats = r;
        if (cmd[0] instanceof SlashCommandClosure) {
            command = cmd[0];
        } else {
            command = cmd.join(' ');
        }
    } else {
        const [r, ...cmd] = String(value).split(' ');
        repeats = r;
        command = cmd.join(' ');
    }
    const isGuardOff = isFalseBoolean(args['guard']?.toString());
    const iterations = Math.min(Number(repeats), isGuardOff ? Number.MAX_SAFE_INTEGER : MAX_LOOPS);
    let result;
    for (let i = 0; i < iterations; i++) {
        if (command instanceof SlashCommandClosure) {
            command.breakController = new SlashCommandBreakController();
            command.scope.setMacro('timesIndex', i);
            result = await command.execute();
        } else {
            result = await executeSubCommands(env, String(command).replace(/\{\{timesIndex\}\}/g, i.toString()), args._scope, args._parserFlags ?? null, args._abortController ?? null);
        }
        if (result!.isAborted) break;
        if (result!.isBreak) break;
    }

    return result?.pipe ?? '';
}

async function ifCallback(args: NamedArguments, value: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    const { a, b, rule } = parseBooleanOperands(args, { local: localStore(env), global: globalStore(env) });
    const result = evalBoolean(rule, a, b);

    /** @type {string|SlashCommandClosure} */
    let command: string | SlashCommandClosure | undefined;
    if (value) {
        // 同 while:照抄 value[0]/value.join(' ') 访问
        if ((value as unknown[])[0] instanceof SlashCommandClosure) {
            command = (value as SlashCommandClosure[])[0];
        } else {
            command = (value as (string | SlashCommandClosure)[]).join(' ');
        }
    }

    let commandResult;
    if (result && command) {
        if (command instanceof SlashCommandClosure) return (await command.execute())!.pipe;
        commandResult = await executeSubCommands(env, command, args._scope, args._parserFlags ?? null, args._abortController ?? null);
    } else if (!result && args['else'] && ((typeof args['else'] === 'string' && args['else'] !== '') || args['else'] instanceof SlashCommandClosure)) {
        if (args['else'] instanceof SlashCommandClosure) return (await (args['else'] as SlashCommandClosure).execute())!.pipe;
        commandResult = await executeSubCommands(env, String(args['else']), args._scope, args._parserFlags ?? null, args._abortController ?? null);
    }

    if (commandResult) {
        return commandResult.pipe;
    }
    return '';
}

function letCallback(args: NamedArguments, value: UnnamedArguments): unknown {
    let valueArr = Array.isArray(value) ? [...value] : [value];
    if (args['key'] !== undefined) {
        const key = args['key'];
        if (typeof key != 'string') throw new Error('Key must be a string');
        if (args._hasUnnamedArgument) {
            const val = typeof valueArr[0] == 'string' ? valueArr.join(' ') : valueArr[0];
            args._scope.letVariable(key, val as string);
            return val;
        } else {
            args._scope.letVariable(key);
            return '';
        }
    }
    const key = valueArr.shift();
    if (typeof key != 'string') throw new Error('Key must be a string');
    if (valueArr.length > 0) {
        const val = typeof valueArr[0] == 'string' ? valueArr.join(' ') : valueArr[0];
        args._scope.letVariable(key, val as string);
        return val;
    } else {
        args._scope.letVariable(key);
        return '';
    }
}

function varCallback(args: NamedArguments, value: UnnamedArguments): unknown {
    let valueArr = Array.isArray(value) ? [...value] : [value];
    if (args['key'] !== undefined) {
        const key = args['key'];
        if (typeof key != 'string') throw new Error('Key must be a string');
        if (args._hasUnnamedArgument) {
            const val = typeof valueArr[0] == 'string' ? valueArr.join(' ') : valueArr[0];
            args._scope.setVariable(key, val as string, args['index'] as number | string | null ?? null, args['as'] as string | null ?? null);
            return val;
        } else {
            return args._scope.getVariable(key, args['index'] as number | string | null ?? null);
        }
    }
    const key = valueArr.shift();
    if (typeof key != 'string') throw new Error('Key must be a string');
    if (valueArr.length > 0) {
        const val = typeof valueArr[0] == 'string' ? valueArr.join(' ') : valueArr[0];
        args._scope.setVariable(key, val as string, args['index'] as number | string | null ?? null, args['as'] as string | null ?? null);
        return val;
    } else {
        return args._scope.getVariable(key, args['index'] as number | string | null ?? null);
    }
}

function closureSerializeCallback(_args: NamedArguments, value: unknown): string | undefined {
    if (!(value instanceof SlashCommandClosure)) {
        throw new Error('unnamed argument must be a closure');
    }
    return value.rawText;
}

function closureDeserializeCallback(args: NamedArguments, value: unknown): SlashCommandClosure {
    const parser = new SlashCommandParser();
    const env = envOf(args);
    parser.env = env;
    const closure = parser.parse(String(value), true, args._parserFlags ?? null, args._abortController ?? null);
    closure.scope.parent = args._scope;
    return closure;
}

function lenValuesCallback(value: unknown): number {
    let parsedValue = value;
    try {
        parsedValue = JSON.parse(String(value));
    } catch {
        // could not parse
    }
    if (Array.isArray(parsedValue)) {
        return parsedValue.length;
    }
    switch (typeof parsedValue) {
        case 'string':
            return parsedValue.length;
        case 'object':
            return Object.keys(parsedValue as object).length;
        case 'number':
            return String(parsedValue).length;
        default:
            return 0;
    }
}

function randValuesCallback(from: number, to: number, args: NamedArguments): number {
    const range = to - from;
    const value = from + Math.random() * range;
    if (args['round'] == 'round') {
        return Math.round(value);
    }
    if (args['round'] == 'ceil') {
        return Math.ceil(value);
    }
    if (args['round'] == 'floor') {
        return Math.floor(value);
    }
    return value;
}

function customSortComparitor(a: unknown, b: unknown): number {
    if (typeof a != typeof b) {
        a = typeof a;
        b = typeof b;
    }
    return (a as number) > (b as number) ? 1 : (a as number) < (b as number) ? -1 : 0;
}

function sortArrayObjectCallback(args: NamedArguments, value: unknown): unknown {
    let parsedValue: unknown;
    if (typeof value == 'string') {
        try {
            parsedValue = JSON.parse(value);
        } catch {
            // return the original input if it was invalid
            return value;
        }
    } else {
        parsedValue = value;
    }
    if (Array.isArray(parsedValue)) {
        // always sort lists by value
        parsedValue.sort(customSortComparitor);
    } else if (typeof parsedValue == 'object') {
        const keysort = args['keysort'];
        if (isFalseBoolean(keysort)) {
            parsedValue = Object.keys(parsedValue as Record<string, unknown>).sort(function (a, b) { return customSortComparitor((parsedValue as Record<string, unknown>)[a], (parsedValue as Record<string, unknown>)[b]); });
        } else {
            parsedValue = Object.keys(parsedValue as Record<string, unknown>).sort(customSortComparitor);
        }
    }
    return JSON.stringify(parsedValue);
}

// ---------------------------------------------------------------------------
// 注册 — registerVariableCommands 移植
// ---------------------------------------------------------------------------

const boolOp = (env: StscriptEnv, args: NamedArguments) => ({ local: localStore(env), global: globalStore(env) });

export function registerVariableCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'listvar',
        callback: (args) => listVariablesCallback(args),
        aliases: ['listchatvar'],
        helpString: 'List registered chat variables. Displays variables in a popup by default. Use the <code>return</code> argument to change the return type.',
        returns: 'JSON list of local variables',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'scope',
                description: 'filter variables by scope',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'all',
                isRequired: false,
                forceEnum: true,
                enumList: [
                    new SlashCommandEnumValue('all', 'All variables', enumTypes.enum, enumIcons.variable),
                    new SlashCommandEnumValue('local', 'Local variables', enumTypes.enum, enumIcons.localVariable),
                    new SlashCommandEnumValue('global', 'Global variables', enumTypes.enum, enumIcons.globalVariable),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'The way how you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'popup-html',
                enumList: returnEnumList({ allowPipe: false, allowObject: true, allowChat: true, allowPopup: true, allowTextVersion: false }),
                forceEnum: true,
            }),
        ],
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'setvar',
        callback: (args, value) => {
            const env = envOf(args);
            const key = String(args['key'] || args['name']);
            const out = String(setVar(localStore(env), key, value, { index: args['index'] as number | string | undefined, key: args['key'] as string | undefined, as: args['as'] as string | undefined }));
            localOp(env, key, localStore(env)[key]);
            return out;
        },
        aliases: ['setchatvar'],
        returns: 'the set variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
            new SlashCommandNamedArgument(
                'index', 'list index', [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING], false,
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'as',
                description: 'change the type of the value when used with index',
                forceEnum: true,
                enumProvider: typesEnumProvider,
                isRequired: false,
                defaultValue: 'string',
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value', [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY], true,
            ),
        ],
        helpString: 'Set a local variable value and pass it down the pipe. The <code>index</code> argument is optional. To convert the value to a specific JSON type when using <code>index</code>, use the <code>as</code> argument.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getvar',
        callback: (args, value) => {
            const env = envOf(args);
            return String(getVar(localStore(env), args['key'] !== undefined ? String(args['key']) : String(value), { index: args['index'] as number | string | undefined, key: args['key'] as string | undefined }));
        },
        aliases: ['getchatvar'],
        returns: 'the variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
            }),
            new SlashCommandNamedArgument(
                'index', 'list index', [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING], false,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'key',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: false,
            }),
        ],
        helpString: 'Get a local variable value and pass it down the pipe. The <code>index</code> argument is optional.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'addvar',
        callback: (args, value) => {
            const env = envOf(args);
            const key = String(args['key'] || args['name']);
            const out = String(addVar(localStore(env), key, value));
            localOp(env, key, localStore(env)[key]);
            return out;
        },
        aliases: ['addchatvar'],
        returns: 'the new variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value to add to the variable', [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Add a value to a local variable and pass the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'setglobalvar',
        callback: (args, value) => {
            const env = envOf(args);
            const key = String(args['key'] || args['name']);
            const out = String(setGlobalVar(globalStore(env), key, value, { index: args['index'] as number | string | undefined, as: args['as'] as string | undefined }));
            globalOp(env, key, globalStore(env)[key]);
            return out;
        },
        returns: 'the set global variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
            new SlashCommandNamedArgument(
                'index', 'list index', [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING], false,
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'as',
                description: 'change the type of the value when used with index',
                forceEnum: true,
                enumProvider: typesEnumProvider,
                isRequired: false,
                defaultValue: 'string',
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value', [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY], true,
            ),
        ],
        helpString: 'Set a global variable value and pass it down the pipe. The <code>index</code> argument is optional. To convert the value to a specific JSON type when using <code>index</code>, use the <code>as</code> argument.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getglobalvar',
        callback: (args, value) => {
            const env = envOf(args);
            return String(getVar(globalStore(env), args['key'] !== undefined ? String(args['key']) : String(value), { index: args['index'] as number | string | undefined, key: args['key'] as string | undefined }));
        },
        returns: 'global variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
            }),
            new SlashCommandNamedArgument(
                'index', 'list index', [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING], false,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'key',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
            }),
        ],
        helpString: 'Get a global variable value and pass it down the pipe. The <code>index</code> argument is optional.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'addglobalvar',
        callback: (args, value) => {
            const env = envOf(args);
            const key = String(args['key'] || args['name']);
            const out = String(addVar(globalStore(env), key, value));
            globalOp(env, key, globalStore(env)[key]);
            return out;
        },
        returns: 'the new variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value to add to the variable', [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Add a value to a global variable and pass the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'incvar',
        callback: (args, value) => {
            const env = envOf(args);
            const out = String(incrementVar(localStore(env), String(value)));
            localOp(env, String(value), localStore(env)[String(value)]);
            return out;
        },
        aliases: ['incchatvar'],
        returns: 'the new variable value',
        unnamedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        helpString: 'Increment a local variable by 1 and pass the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'decvar',
        callback: (args, value) => {
            const env = envOf(args);
            const out = String(decrementVar(localStore(env), String(value)));
            localOp(env, String(value), localStore(env)[String(value)]);
            return out;
        },
        aliases: ['decchatvar'],
        returns: 'the new variable value',
        unnamedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        helpString: 'Decrement a local variable by 1 and pass the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'pushvar',
        callback: (args, value) => {
            const env = envOf(args);
            const key = String(args['key'] || args['name']);
            const out = String(pushVar(localStore(env), key, value) ?? '');
            localOp(env, key, localStore(env)[key]);
            return out;
        },
        returns: 'the new variable value (JSON-stringified)',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name (supports dotted paths into structured values, e.g. "roster.alice.inventory")',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value to push onto the variable array',
                [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY],
                true,
            ),
        ],
        helpString: 'Push a value onto a local variable that holds a JSON array. The variable is auto-created as an array if missing. Supports dotted paths to push onto an array nested inside a structured variable.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'popvar',
        callback: (args, value) => {
            const env = envOf(args);
            const key = String(value);
            const out = String(popVar(localStore(env), key) ?? '');
            localOp(env, key, localStore(env)[key]);
            return out;
        },
        returns: 'the new variable value (JSON-stringified)',
        unnamedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name (supports dotted paths)',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        helpString: 'Pop the last value from a local variable that holds a JSON array. No-op when the variable is missing, empty, or not an array. Supports dotted paths.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'incglobalvar',
        callback: (args, value) => {
            const env = envOf(args);
            const out = String(incrementVar(globalStore(env), String(value)));
            globalOp(env, String(value), globalStore(env)[String(value)]);
            return out;
        },
        returns: 'the new variable value',
        unnamedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        helpString: 'Increment a global variable by 1 and pass the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'decglobalvar',
        callback: (args, value) => {
            const env = envOf(args);
            const out = String(decrementVar(globalStore(env), String(value)));
            globalOp(env, String(value), globalStore(env)[String(value)]);
            return out;
        },
        returns: 'the new variable value',
        unnamedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        helpString: 'Decrement a global variable by 1 and pass the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'if',
        callback: (args, value) => ifCallback(args, value),
        returns: 'result of the executed command ("then" or "else")',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'left',
                description: 'left operand',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'right',
                description: 'right operand',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'rule',
                description: 'comparison rule',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'eq',
                enumList: [
                    new SlashCommandEnumValue('eq', 'a == b (strings & numbers)'),
                    new SlashCommandEnumValue('neq', 'a !== b (strings & numbers)'),
                    new SlashCommandEnumValue('in', 'a includes b (strings & numbers as strings)'),
                    new SlashCommandEnumValue('nin', 'a not includes b (strings & numbers as strings)'),
                    new SlashCommandEnumValue('gt', 'a > b (numbers)'),
                    new SlashCommandEnumValue('gte', 'a >= b (numbers)'),
                    new SlashCommandEnumValue('lt', 'a < b (numbers)'),
                    new SlashCommandEnumValue('lte', 'a <= b (numbers)'),
                    new SlashCommandEnumValue('not', '!a (truthy)'),
                ],
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'else',
                description: 'command to execute if not true',
                typeList: [ARGUMENT_TYPE.CLOSURE, ARGUMENT_TYPE.SUBCOMMAND],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'command to execute if true', [ARGUMENT_TYPE.CLOSURE, ARGUMENT_TYPE.SUBCOMMAND], true,
            ),
        ],
        splitUnnamedArgument: true,
        helpString: 'Compares the value of the left operand <code>a</code> with the value of the right operand <code>b</code>, and if the condition yields true, then execute any valid slash command enclosed in quotes and pass the result of the command execution down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'while',
        callback: (args, value) => whileCallback(args, value),
        returns: 'result of the last executed command',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'left',
                description: 'left operand',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'right',
                description: 'right operand',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'rule',
                description: 'comparison rule',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'eq',
                enumList: [
                    new SlashCommandEnumValue('eq', 'a == b (strings & numbers)'),
                    new SlashCommandEnumValue('neq', 'a !== b (strings & numbers)'),
                    new SlashCommandEnumValue('in', 'a includes b (strings & numbers as strings)'),
                    new SlashCommandEnumValue('nin', 'a not includes b (strings & numbers as strings)'),
                    new SlashCommandEnumValue('gt', 'a > b (numbers)'),
                    new SlashCommandEnumValue('gte', 'a >= b (numbers)'),
                    new SlashCommandEnumValue('lt', 'a < b (numbers)'),
                    new SlashCommandEnumValue('lte', 'a <= b (numbers)'),
                    new SlashCommandEnumValue('not', '!a (truthy)'),
                ],
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'guard',
                description: 'disable loop iteration limit',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'off',
                enumList: booleanEnumProvider('onOff')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'command to execute while true', [ARGUMENT_TYPE.CLOSURE, ARGUMENT_TYPE.SUBCOMMAND], true,
            ),
        ],
        splitUnnamedArgument: true,
        helpString: 'Compares the value of the left operand <code>a</code> with the value of the right operand <code>b</code>, and if the condition yields true, then execute any valid slash command enclosed in quotes.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'times',
        callback: (args, value) => timesCallback(args, value),
        returns: 'result of the last executed command',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'guard', 'disable loop iteration limit', [ARGUMENT_TYPE.STRING], false, false, null, booleanEnumProvider('onOff')(),
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'repeats',
                [ARGUMENT_TYPE.NUMBER],
                true,
            ),
            new SlashCommandArgument(
                'command',
                [ARGUMENT_TYPE.CLOSURE, ARGUMENT_TYPE.SUBCOMMAND],
                true,
            ),
        ],
        splitUnnamedArgument: true,
        splitUnnamedArgumentCount: 1,
        helpString: 'Execute any valid slash command enclosed in quotes <code>repeats</code> number of times.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'flushvar',
        callback: async (args, value) => {
            const env = envOf(args);
            const key = value instanceof SlashCommandClosure ? String((await value.execute())?.pipe ?? '') : String(value);
            const out = deleteVar(localStore(env), key);
            localDel(env, key);
            return out;
        },
        aliases: ['flushchatvar'],
        unnamedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name or closure that returns a variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        helpString: 'Delete a local variable.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'flushglobalvar',
        callback: async (args, value) => {
            const env = envOf(args);
            const key = value instanceof SlashCommandClosure ? String((await value.execute())?.pipe ?? '') : String(value);
            const out = deleteGlobalVar(globalStore(env), key);
            globalDel(env, key);
            return out;
        },
        namedArgumentList: [],
        unnamedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name or closure that returns a variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        helpString: 'Deletes the specified global variable.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'add',
        callback: (args, value) => addValuesCallback(args, value),
        returns: 'sum of the provided values',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to sum',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Performs an addition of the set of values and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'mul',
        callback: (args, value) => mulValuesCallback(args, value),
        returns: 'product of the provided values',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to multiply',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Performs a multiplication of the set of values and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'min',
        callback: (args, value) => minValuesCallback(args, value),
        returns: 'the lowest of the provided values',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to compare',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the lowest of the set of values and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'max',
        callback: (args, value) => maxValuesCallback(args, value),
        returns: 'the highest of the provided values',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to compare',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the highest of the set of values and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'sub',
        callback: (args, value) => subValuesCallback(args, value),
        returns: 'difference of the provided values',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to subtract',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Performs a subtraction of the set of values and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'div',
        callback: (args, value) => divValuesCallback(args, value),
        returns: 'quotient of the provided values',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to divide',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Performs a division of the first value by the second value and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'mod',
        callback: (args, value) => modValuesCallback(args, value),
        returns: 'modulo of the provided values',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to use for the modulo operation',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Performs a modulo operation on the first value by the second value and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'pow',
        callback: (args, value) => powValuesCallback(args, value),
        returns: 'the first value to the power of the second value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'values to use for the power operation',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.LIST],
                isRequired: true,
                acceptsMultiple: true,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Performs a power operation on the first value by the second value and passes the result down the pipe. Can use variable names, or a JSON array consisting of numbers and variables (with quotes).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'sin',
        callback: (args, value) => sinValuesCallback(args, value),
        returns: 'sine of the provided value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                acceptsMultiple: false,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the sine of a value and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'cos',
        callback: (args, value) => cosValuesCallback(args, value),
        returns: 'cosine of the provided value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                acceptsMultiple: false,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the cosine of a value and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'log',
        callback: (args, value) => logValuesCallback(args, value),
        returns: 'natural logarithm of the provided value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                acceptsMultiple: false,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the natural logarithm of a value and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'round',
        callback: (args, value) => roundValuesCallback(args, value),
        returns: 'the provided value rounded to the nearest integer',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                acceptsMultiple: false,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the provided value rounded to the nearest integer and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'abs',
        callback: (args, value) => absValuesCallback(args, value),
        returns: 'absolute value of the provided value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                acceptsMultiple: false,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the absolute value of the provided value and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'sqrt',
        callback: (args, value) => sqrtValuesCallback(args, value),
        returns: 'square root of the provided value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
                acceptsMultiple: false,
                forceEnum: false,
            }),
        ],
        splitUnnamedArgument: true,
        helpString: 'Returns the square root of the provided value and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'len',
        callback: (_args, value) => String(lenValuesCallback(value)),
        aliases: ['length'],
        returns: 'length of the provided value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        helpString: 'Gets the length of a value and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'sort',
        callback: (args, value) => sortArrayObjectCallback(args, value),
        returns: 'the sorted list or dictionary keys',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'keysort',
                description: 'whether to sort by key or value; ignored for lists',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: ['true', 'false'],
                defaultValue: 'true',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY],
                isRequired: true,
                forceEnum: false,
            }),
        ],
        helpString: 'Sorts a list or dictionary in ascending order and passes the result down the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'rand',
        callback: (args, value) => String(randValuesCallback(Number(args['from'] ?? 0), Number(args['to'] ?? (value ? value : 1)), args)),
        returns: 'random number',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'from',
                'starting value for the range (inclusive)',
                [ARGUMENT_TYPE.NUMBER],
                false,
                false,
                '0',
            ),
            new SlashCommandNamedArgument(
                'to',
                'ending value for the range (inclusive)',
                [ARGUMENT_TYPE.NUMBER],
                false,
                false,
                '1',
            ),
            new SlashCommandNamedArgument(
                'round',
                'rounding method for the result',
                [ARGUMENT_TYPE.STRING],
                false,
                false,
                null,
                ['round', 'ceil', 'floor'],
            ),
        ],
        helpString: 'Returns a random number between <code>from</code> and <code>to</code> (inclusive).',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'var',
        callback: (args, value) => varCallback(args, value),
        returns: 'the variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name; forces setting the variable, even if no value is provided',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                forceEnum: false,
            }),
            new SlashCommandNamedArgument(
                'index',
                'optional index for list or dictionary',
                [ARGUMENT_TYPE.NUMBER],
                false, // isRequired
                false, // acceptsMultiple
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'as',
                description: 'change the type of the value when used with index',
                forceEnum: true,
                enumProvider: typesEnumProvider,
                isRequired: false,
                defaultValue: 'string',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                forceEnum: false,
            }),
            new SlashCommandArgument(
                'variable value',
                [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.CLOSURE],
                false, // isRequired
                false, // acceptsMultiple
            ),
        ],
        splitUnnamedArgument: true,
        splitUnnamedArgumentCount: 1,
        helpString: 'Get or set a variable. Use <code>index</code> to access elements of a JSON-serialized list or dictionary. To convert the value to a specific JSON type when using with <code>index</code>, use the <code>as</code> argument.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'let',
        callback: (args, value) => letCallback(args, value),
        returns: 'the variable value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                forceEnum: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'variable name',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME],
                forceEnum: false,
            }),
            new SlashCommandArgument(
                'variable value', [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.CLOSURE],
            ),
        ],
        splitUnnamedArgument: true,
        splitUnnamedArgumentCount: 1,
        helpString: 'Declares a new variable in the current scope.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'closure-serialize',
        callback: (args, value) => closureSerializeCallback(args, value),
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'the closure to serialize',
                typeList: [ARGUMENT_TYPE.CLOSURE],
                isRequired: true,
            }),
        ],
        returns: 'serialized closure as string',
        helpString: 'Serialize a closure as text that can be stored in global and chat variables.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'closure-deserialize',
        callback: (args, value) => closureDeserializeCallback(args, value),
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'serialized closure',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        returns: 'deserialized closure',
        helpString: 'Deserialize a closure from text.',
    }));
}

// numeric ops — variables.js *ValuesCallback,performOperation 已带 stores
function addValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => array.reduce((a, b) => a + b, 0), boolOp(env, args), false, args._scope);
}
function mulValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => array.reduce((a, b) => a * b, 1), boolOp(env, args), false, args._scope);
}
function minValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => Math.min(...array), boolOp(env, args), false, args._scope);
}
function maxValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => Math.max(...array), boolOp(env, args), false, args._scope);
}
function subValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => { const first = array.shift() ?? 0; return array.reduce((a, b) => a - b, first); }, boolOp(env, args), false, args._scope);
}
function divValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => {
        if (array[1] === 0) {
            console.warn('Division by zero.');
            return 0;
        }
        return array[0]! / array[1]!;
    }, boolOp(env, args), false, args._scope);
}
function modValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => {
        if (array[1] === 0) {
            console.warn('Division by zero.');
            return 0;
        }
        return array[0]! % array[1]!;
    }, boolOp(env, args), false, args._scope);
}
function powValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (array) => Math.pow(array[0]!, array[1]!), boolOp(env, args), false, args._scope);
}
function sinValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    // 原版直接传 Math.sin(array):单元素数组经隐式 Number() 协转,多元素 NaN——照抄
    return performOperation(value, (a) => Math.sin(a as unknown as number), boolOp(env, args), true, args._scope);
}
function cosValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (a) => Math.cos(a as unknown as number), boolOp(env, args), true, args._scope);
}
function logValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (a) => Math.log(a as unknown as number), boolOp(env, args), true, args._scope);
}
function roundValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (a) => Math.round(a as unknown as number), boolOp(env, args), true, args._scope);
}
function absValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (a) => Math.abs(a as unknown as number), boolOp(env, args), true, args._scope);
}
function sqrtValuesCallback(args: NamedArguments, value: UnnamedArguments): string {
    const env = envOf(args);
    return performOperation(value, (a) => Math.sqrt(a as unknown as number), boolOp(env, args), true, args._scope);
}
