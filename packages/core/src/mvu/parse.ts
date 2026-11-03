/**
 * MVU 更新命令解析 — `_.set()/_.insert()/_.remove()/_.add()` 与 <json_patch> 块。
 * 语义基准:
 * - `update_variables.ts` L24-28 (trimQuotesAndBackslashes)
 * - `update_variables.ts` L87-174 (parseCommandValue)
 * - `update_variables.ts` L204-276 (path→命令路径翻译)
 * - `update_variables.ts` L291-410 (extractCommands 状态机)
 * - `update_variables.ts` L424-525 (findMatchingCloseParen / parseParameters)
 * - `update_variables.ts` L527-603 (pathFix)
 * - `util.ts` L48-62 (isJsonPatch)
 * - `util/common.ts` parseString(YAML→JSON5→jsonrepair→YAML 回退链)
 *
 * 已知的、有意为之的偏离:
 * 1. parseCommandValue 中 upstream 用 `new Function()` 兜底 JS 字面量;
 *    服务端执行模型输出的任意 JS 不可接受 → 改用 JSON5.parse
 *   (同覆盖未加引号 key / 单引号 / 尾逗号这一输入面)。
 * 2. substitudeMacros 变为注入点(options.substitute),默认原样。
 */
import { parseDocument as yamlParseDocument, parse as yamlParse } from 'yaml';
import JSON5 from 'json5';
import { jsonrepair } from 'jsonrepair';
import * as math from 'mathjs';
import { isObjectLike, toPath as toPathLite } from './lodash.js';
import type { MvuCommand, MvuCommandType } from './types.js';

/** upstream `trimQuotesAndBackslashes` (update_variables.ts L24-28)。 */
export function trimQuotesAndBackslashes(str: unknown): unknown {
    if (typeof str !== 'string') return str;
    return str.replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, '$1');
}

/**
 * `parseString` 等价物(util/common.ts):先按内容首字符决定是否跳过首轮 YAML;
 * YAML.parseDocument(merge)→JSON5→JSON.parse(jsonrepair)→YAML 四级回退。
 * 用于 <json_patch> / <initvar> 内容解析。
 */
export function parseMvuString(content: string): unknown {
    const jsonFirst = /^[[{]/s.test(content.trimStart());
    try {
        if (jsonFirst) {
            throw new Error('expected error');
        }
        return yamlParseDocument(content, { merge: true }).toJS();
    } catch (yamlError1) {
        try {
            return JSON5.parse(content);
        } catch {
            try {
                return JSON.parse(jsonrepair(content));
            } catch (jsonError) {
                try {
                    if (!jsonFirst) {
                        throw new Error('expected error');
                    }
                    return yamlParseDocument(content, { merge: true }).toJS();
                } catch (yamlError2) {
                    const toMessage = (error: unknown) =>
                        error instanceof Error ? error.message : String(error);
                    throw new Error(
                        `MVU parse failed: content=${JSON.stringify(content.slice(0, 200))} ` +
                        `yaml=${toMessage(jsonFirst ? yamlError2 : yamlError1)} json=${toMessage(jsonError)}`,
                    );
                }
            }
        }
    }
}

/** upstream `isJsonPatch` (util.ts L48-62):op/path 形态校验。 */
export function isJsonPatch(patch: unknown): patch is Record<string, unknown>[] {
    if (!Array.isArray(patch)) {
        return false;
    }
    if (patch.length === 0) {
        return true;
    }
    return patch.every(
        op =>
            isObjectLike(op) &&
            typeof (op as Record<string, unknown>).op === 'string' &&
            (typeof (op as Record<string, unknown>).path === 'string' ||
                ((op as Record<string, unknown>).op === 'move' &&
                    typeof (op as Record<string, unknown>).to === 'string')),
    );
}

/** upstream `pathSegmentsToLodashPath` (update_variables.ts L204-208)。 */
export function pathSegmentsToLodashPath(pathSegments: string[]): string {
    return pathSegments
        .map(segment => `["${segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
        .join('');
}

/** upstream `jsonPatchPathToCommandPath` (update_variables.ts L210-217)。 */
export function jsonPatchPathToCommandPath(path: string | undefined): string {
    if (!path) return '';
    const pathWithoutRoot = path.startsWith('/') ? path.substring(1) : path;
    const pathSegments = pathWithoutRoot
        .split('/')
        .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    return pathSegmentsToLodashPath(pathSegments);
}

/**
 * upstream `extractJsonPatch` (update_variables.ts L219-276):
 * replace→set / delta→add / insert|add→insert / remove→delete / move→move。
 * 注意 move 命令在上游执行 switch 中没有 case —— 解析了但不会生效。
 */
export function extractJsonPatch(patch: Record<string, unknown>[]): MvuCommand[] {
    const translated: MvuCommand[] = [];
    for (const op of patch) {
        const path = jsonPatchPathToCommandPath((op.path ?? op.to) as string | undefined);
        switch (op.op) {
            case 'replace':
                translated.push({
                    type: 'set',
                    full_match: JSON.stringify(op),
                    args: [path, JSON.stringify(op.value)],
                    reason: 'json_patch',
                });
                break;
            case 'delta':
                translated.push({
                    type: 'add',
                    full_match: JSON.stringify(op),
                    args: [path, JSON.stringify(op.value)],
                    reason: 'json_patch',
                });
                break;
            case 'insert':
            case 'add': {
                const pathParts = toPathLite(path);
                const lastPart = pathParts[pathParts.length - 1] ?? '';
                const containerPath = pathSegmentsToLodashPath(pathParts.slice(0, -1));
                const keyOrIndexArg = /^\d+$/.test(lastPart) ? lastPart : JSON.stringify(lastPart);
                translated.push({
                    type: 'insert',
                    full_match: JSON.stringify(op),
                    args: [containerPath, keyOrIndexArg, JSON.stringify(op.value)],
                    reason: 'json_patch',
                });
                break;
            }
            case 'remove':
                translated.push({
                    type: 'delete',
                    full_match: JSON.stringify(op),
                    args: [path],
                    reason: 'json_patch',
                });
                break;
            case 'move':
                translated.push({
                    type: 'move',
                    full_match: JSON.stringify(op),
                    args: [jsonPatchPathToCommandPath(op.from as string | undefined), path],
                    reason: 'json_patch',
                });
                break;
        }
    }
    return translated;
}

/** upstream `findMatchingCloseParen` (update_variables.ts L424-460)。 */
export function findMatchingCloseParen(str: string, startPos: number): number {
    let parenCount = 1;
    let inQuote = false;
    let quoteChar = '';
    for (let i = startPos; i < str.length; i++) {
        const char = str[i]!;
        const prevChar = i > 0 ? str[i - 1]! : '';
        if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
            if (!inQuote) {
                inQuote = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuote = false;
            }
        }
        if (!inQuote) {
            if (char === '(') {
                parenCount++;
            } else if (char === ')') {
                parenCount--;
                if (parenCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}

/** upstream `parseParameters` (update_variables.ts L464-525)。 */
export function parseParameters(paramsString: string): string[] {
    const params: string[] = [];
    let currentParam = '';
    let inQuote = false;
    let quoteChar = '';
    let bracketCount = 0;
    let braceCount = 0;
    let parenCount = 0;

    for (let i = 0; i < paramsString.length; i++) {
        const char = paramsString[i]!;
        if (
            (char === '"' || char === "'" || char === '`') &&
            (i === 0 || paramsString[i - 1] !== '\\')
        ) {
            if (!inQuote) {
                inQuote = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuote = false;
            }
        }
        if (!inQuote) {
            if (char === '(') parenCount++;
            if (char === ')') parenCount--;
            if (char === '[') bracketCount++;
            if (char === ']') bracketCount--;
            if (char === '{') braceCount++;
            if (char === '}') braceCount--;
        }
        if (
            char === ',' &&
            !inQuote &&
            parenCount === 0 &&
            bracketCount === 0 &&
            braceCount === 0
        ) {
            params.push(currentParam.trim());
            currentParam = '';
            continue;
        }
        currentParam += char;
    }
    if (currentParam.trim()) {
        params.push(currentParam.trim());
    }
    return params;
}

/**
 * upstream `extractCommands` (update_variables.ts L291-410):
 * 先收 <json_patch> 块,再状态机扫 _.cmd( 调用,最后按 $index 归序。
 */
export function extractCommands(inputText: string): MvuCommand[] {
    const results: (MvuCommand & { $index: number })[] = [];
    for (const match of inputText.matchAll(
        /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gim,
    )) {
        const index = match.index ?? 0;
        try {
            const patch = parseMvuString(match[2]!.trim());
            if (isJsonPatch(patch)) {
                for (const command of extractJsonPatch(patch)) {
                    results.push({ $index: index, ...command });
                }
            }
        } catch {
            /* ignore — 上游同样吞掉解析失败 */
        }
    }

    let i = 0;
    while (i < inputText.length) {
        const setMatch = inputText
            .substring(i)
            .match(/_\.(set|insert|assign|remove|unset|delete|add)\(/);
        if (!setMatch || setMatch.index === undefined) {
            break;
        }
        const commandType = setMatch[1] as MvuCommandType;
        const setStart = i + setMatch.index;
        const openParen = setStart + setMatch[0].length;

        const closeParen = findMatchingCloseParen(inputText, openParen);
        if (closeParen === -1) {
            i = openParen;
            continue;
        }
        let endPos = closeParen + 1;
        if (endPos >= inputText.length || inputText[endPos] !== ';') {
            i = closeParen + 1;
            continue;
        }
        endPos++;

        let comment = '';
        const potentialComment = inputText.substring(endPos).match(/^\s*\/\/(.*)/);
        if (potentialComment) {
            comment = potentialComment[1]!.trim();
            endPos += potentialComment[0].length;
        }

        const fullMatch = inputText.substring(setStart, endPos);
        const paramsString = inputText.substring(openParen, closeParen);
        const params = parseParameters(paramsString);

        let isValid = false;
        if (commandType === 'set' && params.length >= 2) isValid = true;
        else if (commandType === 'assign' && params.length >= 2) isValid = true;
        else if (commandType === 'insert' && params.length >= 2) isValid = true;
        else if (commandType === 'remove' && params.length >= 1) isValid = true;
        else if (commandType === 'unset' && params.length >= 1) isValid = true;
        else if (commandType === 'delete' && params.length >= 1) isValid = true;
        else if (commandType === 'add' && params.length === 2) isValid = true;

        if (isValid) {
            results.push({
                $index: setStart,
                type: commandType,
                full_match: fullMatch,
                args: params,
                reason: comment,
            });
        }
        i = endPos;
    }

    return results
        .sort((a, b) => a.$index - b.$index)
        .map(({ $index: _index, ...command }) => command);
}

/** upstream `pathFix` (update_variables.ts L527-603) — 模型手写路径归一。 */
export function pathFix(path: string): string {
    if (!path) return path;

    const fixedBrackets = path.replace(/\[([^\]]*)\]/g, (_match, rawInner: string) => {
        let inner = rawInner.trim();
        if (!inner) {
            return '[]';
        }
        let wasQuoted = false;
        const first = inner[0]!;
        const last = inner[inner.length - 1]!;
        if (inner.length >= 2 && (first === '"' || first === "'") && first === last) {
            wasQuoted = true;
            inner = inner.slice(1, -1);
        }
        const isPureDigits = /^\d+$/.test(inner);
        const hasWhitespace = /\s/.test(inner);
        if (isPureDigits) {
            if (!wasQuoted) {
                return `[${inner}]`;
            }
            const escaped = inner.replace(/"/g, '\\"');
            return `["${escaped}"]`;
        }
        if (hasWhitespace) {
            const escaped = inner.replace(/"/g, '\\"');
            return `["${escaped}"]`;
        }
        return `[${inner}]`;
    });

    const fixedDots = fixedBrackets.replace(
        /(^|\.)(["'])([^"']*)\2(?=\.|\[|$)/g,
        (_match, prefix: string, _quote: string, name: string) => {
            const hasWhitespace = /\s/.test(name);
            const hasSpecial = /[.[\]]/.test(name);
            if (!hasWhitespace && !hasSpecial) {
                return prefix + name;
            }
            const escaped = name.replace(/"/g, '\\"');
            if (prefix === '.') {
                return `["${escaped}"]`;
            }
            return `${prefix}["${escaped}"]`;
        },
    );

    return fixedDots;
}

/**
 * upstream `parseCommandValue` (update_variables.ts L87-174):
 * true/false/null/undefined → JSON.parse → {}/[] 字面量 → mathjs → YAML → 裸字符串。
 * 偏离:`new Function` 字面量兜底改 JSON5(禁服务端 eval 模型输出)。
 */
export function parseCommandValue(valStr: unknown): unknown {
    if (typeof valStr !== 'string') return valStr;
    const trimmed = valStr.trim();

    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (trimmed === 'undefined') return undefined;

    try {
        return JSON.parse(trimmed);
    } catch {
        if (
            (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
            try {
                const result = JSON5.parse(trimmed);
                if (isObjectLike(result) || Array.isArray(result)) {
                    return result;
                }
            } catch {
                /* 继续往下走 */
            }
        }
    }

    try {
        const scope = {
            Math: Math,
            math: math,
        };
        const result = math.evaluate(trimmed, scope);
        if (math.isComplex(result) || math.isMatrix(result)) {
            return result.toString();
        }
        if (result === undefined && !/^[a-zA-Z_]+$/.test(trimmed)) {
            return trimmed;
        }
        if (result !== undefined) {
            return parseFloat(result.toPrecision(12));
        }
    } catch {
        /* 不是合法表达式 → 普通字符串 */
    }

    try {
        return yamlParse(trimmed);
    } catch {
        /* empty */
    }

    return trimQuotesAndBackslashes(valStr);
}
