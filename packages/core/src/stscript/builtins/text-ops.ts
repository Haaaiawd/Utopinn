/**
 * 文本/匹配工具族 — 移植自 ref/Luker public/scripts/slash-commands.js:
 * /upper /lower /substr /replace /test /match /trimstart /trimend
 * /tokens /fuzzy,与 token-counter 扩展的 /count;
 * utils.js trimToStartSentence/trimToEndSentence 随命令一并移植。
 *
 * 面差异(最小化,全部有出处):
 * - getTokenCountAsync → env.host.countTokens seam;未绑时回退
 *   len/4 估算(与 stscript-env countTokens 桩同式,上游自身也有
 *   估算兜底)。
 * - /fuzzy list= 经 var-store resolveVariable 解析(上游同名),
 *   Fuse 参数/阈值钳制/双模式照抄。
 * - /is-mobile:host.isMobile 未绑恒 'false' —— 服务端非移动设备;
 *   薄客户端的设备判定应在客户端侧求值(env.ts 注释同口径)。
 */
import Fuse from 'fuse.js';
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandEnumValue, enumTypes, enumIcons } from '../types.js';
import { SlashCommandClosure } from '../closure.js';
import { regexFromString } from '../../regex/engine.js';
import { resolveVariable } from '../var-store.js';
import type { VarStores } from '../var-store.js';
import type { StscriptEnv, StscriptMessage } from '../env.js';
import { addCommandObject } from '../registry.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

const unnamed = (value: UnnamedArguments): string =>
    String(Array.isArray(value) ? value.join(' ') : value ?? '');

/** resolveVariable 的 stores 组装:chat_metadata.variables + globalVariables。 */
function storesOf(env: StscriptEnv): VarStores {
    const md = env.macro.chatMetadata;
    return { local: (md.variables ??= {}), global: env.macro.globalVariables };
}

// ---------------------------------------------------------------------------
// utils.js trimToStartSentence/trimToEndSentence —— 逐行照抄
// ---------------------------------------------------------------------------

/** trimToEndSentence:截到最后一个完整句尾(标点/emoji 收尾)。 */
export function trimToEndSentence(input: string): string {
    if (!input) return '';
    const isEmoji = (x: string) => /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu.test(x);
    const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '。', '！', '？', '”', '）', '】', '’', '」', '_']);
    let last = -1;
    const characters = Array.from(input);
    for (let i = characters.length - 1; i >= 0; i--) {
        const char = characters[i]!;
        const emoji = isEmoji(char);
        if (punctuation.has(char) || emoji) {
            if (!emoji && i > 0 && /[\s\n]/.test(characters[i - 1]!)) {
                last = i - 1;
            } else {
                last = i;
            }
            break;
        }
    }
    if (last === -1) return input.trimEnd();
    return characters.slice(0, last + 1).join('').trimEnd();
}

/** trimToStartSentence:截到第一个完整句之后(.!?\n 首个句界)。 */
export function trimToStartSentence(input: string): string {
    if (!input) return '';
    const p1 = input.indexOf('.');
    const p2 = input.indexOf('!');
    const p3 = input.indexOf('?');
    const p4 = input.indexOf('\n');
    let first = p1;
    let skip1 = false;
    if (p2 > 0 && (first < 0 || p2 < first)) { first = p2; }
    if (p3 > 0 && (first < 0 || p3 < first)) { first = p3; }
    if (p4 > 0 && (first < 0 || p4 < first)) { first = p4; skip1 = true; }
    if (first > 0) {
        if (skip1) return input.substring(first + 1);
        return input.substring(first + 2);
    }
    return input;
}

// ---------------------------------------------------------------------------
// token 计数 — getTokenCountAsync → countTokens seam(len/4 兜底)
// ---------------------------------------------------------------------------

const estimateTokens = (text: string): number => Math.ceil(String(text).length / 4);

async function countTokensOf(env: StscriptEnv, text: string): Promise<number> {
    if (typeof env.host.countTokens === 'function') {
        return Number(await env.host.countTokens(text));
    }
    return estimateTokens(text);
}

// ---------------------------------------------------------------------------
// 字符串变换族
// ---------------------------------------------------------------------------

export function upperCallback(_args: NamedArguments, text: UnnamedArguments): string {
    return typeof text === 'string' ? text.toUpperCase() : '';
}

export function lowerCallback(_args: NamedArguments, text: UnnamedArguments): string {
    return typeof text === 'string' ? text.toLowerCase() : '';
}

export function substrCallback(args: NamedArguments, text: UnnamedArguments): string {
    if (typeof text !== 'string') return '';
    const start = Number(args?.['start']);
    // 上游 arg.end && Number(arg.end):falsy(''/undefined/null) → undefined;
    // 真值一律 Number(可能 NaN → slice 出空串,与上游同)。
    const rawEnd = args?.['end'];
    const end = rawEnd ? Number(rawEnd) : undefined;
    return text.slice(isNaN(start) ? 0 : start, end);
}

export function replaceCallback(args: NamedArguments, text: UnnamedArguments): string {
    const mode = String(args?.['mode'] ?? 'literal');
    const pattern = args?.['pattern'];
    if (pattern === undefined || pattern === null || String(pattern) === '') {
        throw new Error(`Argument of 'pattern=' cannot be empty`);
    }
    const replacer = String(args?.['replacer'] ?? '');
    const src = unnamed(text);
    switch (mode) {
        case 'literal':
            return src.replaceAll(String(pattern), replacer);
        case 'regex': {
            const re = regexFromString(String(pattern));
            if (!re) throw new Error(`The value of 'pattern' argument is not a valid regular expression.`);
            return src.replace(re, replacer);
        }
        default:
            throw new Error(`Invalid '/replace mode=' argument specified!`);
    }
}

export function testCallback(args: NamedArguments, text: UnnamedArguments): string {
    const pattern = args?.['pattern'];
    if (pattern === undefined || pattern === null || String(pattern) === '') {
        throw new Error(`Argument of 'pattern=' cannot be empty`);
    }
    const re = regexFromString(String(pattern));
    if (!re) throw new Error(`The value of 'pattern' argument is not a valid regular expression.`);
    return JSON.stringify(re.test(unnamed(text)));
}

export function matchCallback(args: NamedArguments, text: UnnamedArguments): string {
    const pattern = args?.['pattern'];
    if (pattern === undefined || pattern === null || String(pattern) === '') {
        throw new Error(`Argument of 'pattern=' cannot be empty`);
    }
    const re = regexFromString(String(pattern));
    if (!re) throw new Error(`The value of 'pattern' argument is not a valid regular expression.`);
    const src = unnamed(text);
    if (re.flags.includes('g')) {
        return JSON.stringify([...src.matchAll(re)]);
    }
    const match = src.match(re);
    return match ? JSON.stringify(match) : '';
}

export function trimStartCallback(_args: NamedArguments, text: UnnamedArguments): string {
    const value = unnamed(text);
    if (!value) return '';
    return trimToStartSentence(value);
}

export function trimEndCallback(_args: NamedArguments, text: UnnamedArguments): string {
    const value = unnamed(text);
    if (!value) return '';
    return trimToEndSentence(value);
}

export async function tokensCallback(args: NamedArguments, text: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    if (text instanceof SlashCommandClosure || Array.isArray(text)) {
        throw new Error('Unnamed argument cannot be a closure for command /tokens');
    }
    return String(await countTokensOf(env, String(text ?? '')));
}

/** token-counter 扩展 doCount:非系统楼 mes 拼 ' ' 计数。 */
export async function countCallback(args: NamedArguments): Promise<string> {
    const env = envOf(args);
    const chat = env.macro.chat as unknown as StscriptMessage[];
    const all = chat.filter(x => x?.mes && !x.is_system).map(x => x.mes).join(' ');
    return String(await countTokensOf(env, all));
}

/** /fuzzy — Fuse 双模式(first=逐项搜进文本,best=全表搜文本)。 */
export function fuzzyCallback(args: NamedArguments, searchInValue: UnnamedArguments): string {
    const env = envOf(args);
    const needle = unnamed(searchInValue);
    if (!needle) {
        console.warn('WARN: No argument provided for /fuzzy command');
        return '';
    }
    if (!args?.['list']) {
        console.warn('WARN: No list argument provided for /fuzzy command');
        return '';
    }
    try {
        const list = JSON.parse(String(resolveVariable(String(args['list']), storesOf(env), args._scope ?? null)));
        if (!Array.isArray(list)) {
            console.warn('WARN: Invalid list argument provided for /fuzzy command');
            return '';
        }
        const params: { includeScore: boolean; findAllMatches: boolean; ignoreLocation: boolean; threshold: number } = {
            includeScore: true,
            findAllMatches: true,
            ignoreLocation: true,
            threshold: 0.4,
        };
        if ('threshold' in args && args['threshold'] !== undefined) {
            params.threshold = parseFloat(String(args['threshold']));
            if (isNaN(params.threshold)) {
                console.warn('WARN: \'threshold\' argument must be a float between 0.0 and 1.0 for /fuzzy command');
                return '';
            }
            if (params.threshold < 0) params.threshold = 0;
            if (params.threshold > 1) params.threshold = 1;
        }
        const getFirstMatch = (): string => {
            const fuse = new Fuse([needle], params);
            for (const searchItem of list) {
                const result = fuse.search(String(searchItem));
                if (result.length > 0) return String(searchItem);
            }
            return '';
        };
        const getBestMatch = (): string => {
            const fuse = new Fuse(list.map(String), params);
            const result = fuse.search(needle);
            return result.length > 0 ? String(result[0]!.item) : '';
        };
        switch (String(args['mode'] ?? 'first').trim().toLowerCase()) {
            case 'best': return getBestMatch();
            case 'first':
            default: return getFirstMatch();
        }
    } catch {
        console.warn('WARN: Invalid list argument provided for /fuzzy command');
        return '';
    }
}

export function isMobileCallback(args: NamedArguments): string {
    const env = envOf(args);
    return String(env.host.isMobile === true);
}

export function registerTextOpsCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'upper',
        aliases: ['uppercase', 'to-upper'],
        callback: (args, text) => upperCallback(args, text),
        returns: 'uppercase string',
        unnamedArgumentList: [
            new SlashCommandArgument('text to affect', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Converts the provided string to uppercase.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'lower',
        aliases: ['lowercase', 'to-lower'],
        callback: (args, text) => lowerCallback(args, text),
        returns: 'lowercase string',
        unnamedArgumentList: [
            new SlashCommandArgument('text to affect', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Converts the provided string to lowercase.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'substr',
        aliases: ['substring'],
        callback: (args, text) => substrCallback(args, text),
        returns: 'substring',
        namedArgumentList: [
            new SlashCommandNamedArgument('start', 'start index', [ARGUMENT_TYPE.NUMBER], false),
            new SlashCommandNamedArgument('end', 'end index', [ARGUMENT_TYPE.NUMBER], false),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to affect', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Extracts text from the provided string. Negative indexes count from the end.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'replace',
        aliases: ['re'],
        callback: (args, text) => replaceCallback(args, text),
        returns: 'replaced text',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'literal or regex replacement mode',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'literal',
                enumList: ['literal', 'regex'],
            }),
            new SlashCommandNamedArgument('pattern', 'pattern to search with', [ARGUMENT_TYPE.STRING], true),
            new SlashCommandNamedArgument('replacer', 'replacement text for matches', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to affect', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Replaces text within the provided string. mode=literal (default) does literal replaceAll; mode=regex parses pattern as an ECMAScript regular expression (e.g. "/blue/gi").',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'test',
        callback: (args, text) => testCallback(args, text),
        returns: 'true | false',
        namedArgumentList: [
            new SlashCommandNamedArgument('pattern', 'pattern to find', [ARGUMENT_TYPE.STRING], true),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to test', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Tests text for a regular expression match. Returns true if found, false otherwise.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'match',
        callback: (args, text) => matchCallback(args, text),
        returns: 'group array for each match',
        namedArgumentList: [
            new SlashCommandNamedArgument('pattern', 'pattern to find', [ARGUMENT_TYPE.STRING], true),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to match against', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Retrieves regular expression matches in the given text. With /g flag returns nested arrays for each match ([] if none); otherwise returns the match array or an empty string.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'trimstart',
        callback: (args, text) => trimStartCallback(args, text),
        returns: 'trimmed text',
        unnamedArgumentList: [
            new SlashCommandArgument('text', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Trims the text to the start of the first full sentence.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'trimend',
        callback: (args, text) => trimEndCallback(args, text),
        returns: 'trimmed text',
        unnamedArgumentList: [
            new SlashCommandArgument('text', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Trims the text to the end of the last full sentence.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'tokens',
        callback: (args, text) => tokensCallback(args, text),
        returns: 'number of tokens',
        unnamedArgumentList: [
            new SlashCommandArgument('text', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Counts the number of tokens in the provided text.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'count',
        callback: (args) => countCallback(args),
        returns: 'number of tokens',
        helpString: 'Counts the number of tokens in the current chat.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'fuzzy',
        callback: (args, text) => fuzzyCallback(args, text),
        returns: 'matching item',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'list',
                description: 'list of items to match against',
                typeList: [ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.VARIABLE_NAME],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'threshold',
                description: 'fuzzy match threshold (0.0 to 1.0)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '0.4',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'fuzzy match mode',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'first',
                enumList: [
                    new SlashCommandEnumValue('first', 'first match below the threshold', enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('best', 'best match below the threshold', enumTypes.enum, enumIcons.default),
                ],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to search', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Fuzzy-matches the text against a JSON list. mode=first returns the first list item found inside the text; mode=best returns the best list match for the text.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'is-mobile',
        callback: (args) => isMobileCallback(args),
        returns: ARGUMENT_TYPE.BOOLEAN,
        helpString: 'Returns true if the current device is a mobile device, false otherwise. Equivalent to {{isMobile}} macro. Server hosts return false unless they bind host.isMobile.',
    }));
}
