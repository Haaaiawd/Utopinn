/**
 * ST/Luker 正则引擎纯 TS 移植。
 * 语义基准:`ref/Luker/public/scripts/extensions/regex/engine.js`,
 * 逐行对照,仅移除 DOM/jQuery/存储/toastr,全局状态改为参数注入:
 * - `extension_settings.disabledExtensions` → RegexParams.regexDisabled
 * - `extension_settings.regex_perf_detection` → RegexParams.perfDetection
 * - `getRegexScripts({allowedOnly:true})` → RegexParams.scripts
 *   (未授权的 scoped/preset 脚本由调用方在装入 sources 前过滤)
 * - `substituteParams` 全局上下文 → 所有入口要求传入 SubstituteContext
 * - 持久化槽位读取/写回 → RegexScriptSources(存储层职责,不在此)
 */
import { substituteParams, type SubstituteContext } from '../macros/substitute.js';
import {
    regex_placement,
    substitute_find_regex,
    SCRIPT_TYPES,
    SCRIPT_TYPE_UNKNOWN,
    type RegexParams,
    type RegexScript,
    type RegexScriptParams,
    type RegexScriptSources,
    type RegexPluginLane,
    type ScriptType,
} from './types.js';
import { isRegexScriptPaused, recordRegexExecution } from './redos.js';

const REGEX_SCRIPT_TYPE_LABELS: Readonly<Record<number, string>> = Object.freeze({
    [SCRIPT_TYPES.GLOBAL]: 'global',
    [SCRIPT_TYPES.SCOPED]: 'scoped',
    [SCRIPT_TYPES.PRESET]: 'preset',
    [SCRIPT_TYPE_UNKNOWN]: 'unknown',
});
const warnedInvalidPlacementScripts = new Set<string>();

function isPersistedRegexScriptRecord(script: unknown): script is RegexScript {
    return Boolean(script) && typeof script === 'object' && !Array.isArray(script);
}

/**
 * 等价 sanitizePersistedRegexScriptList:剔除非对象条目并告警。
 * 原版会 splice 原数组并调度一次持久化写回;纯引擎返回过滤后的新数组,
 * 写回由存储层决定。
 */
function sanitizePersistedRegexScriptList(scripts: unknown, scriptType: ScriptType): RegexScript[] {
    if (!Array.isArray(scripts)) {
        return [];
    }

    const invalidEntries: { index: number; type: string }[] = [];
    const out: RegexScript[] = [];
    scripts.forEach((script, index) => {
        if (isPersistedRegexScriptRecord(script)) {
            out.push(script);
            return;
        }
        invalidEntries.push({ index, type: script === null ? 'null' : typeof script });
    });

    if (invalidEntries.length > 0) {
        console.warn('[Regex] Removed invalid persisted regex entries', {
            scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
            invalidEntries,
        });
    }

    return out;
}

/**
 * Normalizes `trimStrings` for scripts handed in at runtime.
 * The regex editor is the only writer that guarantees the field exists;
 * runtime scripts bypass it, and the engine reads the value directly as
 * soon as a replacement references a capture group.
 */
function normalizeRuntimeTrimStrings(trimStrings: unknown): string[] {
    return Array.isArray(trimStrings) ? trimStrings.map(String) : [];
}

/**
 * Warns once per broken script when placement is not a valid array.
 * 原版还会弹 toastr(全局一次),纯引擎只留 console.error。
 */
function warnInvalidRegexPlacement(script: RegexScript, index: number): void {
    const scriptName = String(script?.scriptName || '').trim() || `<unnamed #${index}>`;
    const warningKey = `${scriptName}:${index}`;
    if (warnedInvalidPlacementScripts.has(warningKey)) {
        return;
    }
    warnedInvalidPlacementScripts.add(warningKey);
    console.error(`Regex script "${scriptName}" has invalid placement and will be skipped.`);
}

/**
 * Instantiates a regular expression from a string — `utils.js regexFromString` 移植。
 * 接受 `/pat/flags` 或裸 pattern;flags 非法时整体按字面 pattern 处理。
 */
export function regexFromString(input: string): RegExp | undefined {
    try {
        // Parse input
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
        if (!m) {
            return undefined;
        }

        // Invalid flags
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
            return RegExp(input);
        }

        // Create the regular expression
        return new RegExp(m[2] as string, m[3]);
    } catch {
        return undefined;
    }
}

/**
 * Manages the compiled regex cache with LRU eviction.
 */
export class RegexProvider {
    #cache = new Map<string, RegExp>();
    #maxSize = 1000;

    static instance = new RegexProvider();

    /**
     * Gets a regex instance by its string representation.
     * @returns Compiled regex or null if invalid
     */
    get(regexString: string): RegExp | null {
        const isCached = this.#cache.has(regexString);
        const regex = isCached
            ? this.#cache.get(regexString)
            : regexFromString(regexString);

        if (!regex) {
            return null;
        }

        if (isCached) {
            // LRU: Move to end by re-inserting
            this.#cache.delete(regexString);
            this.#cache.set(regexString, regex);
        } else {
            // Evict oldest if at capacity
            if (this.#cache.size >= this.#maxSize) {
                const firstKey = this.#cache.keys().next().value as string;
                this.#cache.delete(firstKey);
            }
            this.#cache.set(regexString, regex);
        }

        // Reset lastIndex for global/sticky regexes
        if (regex.global || regex.sticky) {
            regex.lastIndex = 0;
        }

        return regex;
    }

    /**
     * Clears the entire cache.
     */
    clear(): void {
        this.#cache.clear();
    }
}

/**
 * 等价 collectRuntimeRegexScripts:浅拷贝、校验 scriptName、补全 trimStrings。
 * 原版脚本来自注册 provider 并打 __runtime_owner 标记;这里由调用方直接给数组。
 */
function collectRuntimeRegexScripts(scripts: readonly RegexScript[] | null | undefined): RegexScript[] {
    const out: RegexScript[] = [];
    for (const script of scripts ?? []) {
        if (!script || typeof script !== 'object') {
            continue;
        }
        const scriptName = String(script.scriptName || '').trim();
        if (!scriptName) {
            console.warn('collectRuntimeRegexScripts: runtime script without scriptName; skipped.');
            continue;
        }
        out.push({ ...script, scriptName, trimStrings: normalizeRuntimeTrimStrings(script.trimStrings) });
    }
    return out;
}

/**
 * 等价 getRegexScripts({allowedOnly:true}):按 SCRIPT_TYPES 声明序
 * (GLOBAL → PRESET → SCOPED)拼接持久化脚本,再追加运行时脚本。
 * 原版 allowedOnly 授权判定(character_allowed_regex / preset_allowed_regex)
 * 由调用方在装入 sources 前完成。
 */
export function getRegexScripts(sources: RegexScriptSources = {}): RegexScript[] {
    return [
        ...Object.values(SCRIPT_TYPES).flatMap(type => getScriptsByType(type, sources)),
        ...collectRuntimeRegexScripts(sources.runtime),
    ];
}

/**
 * Retrieves the regex scripts for a specific type from the given sources.
 */
export function getScriptsByType(scriptType: ScriptType, sources: RegexScriptSources = {}): RegexScript[] {
    switch (scriptType) {
        case SCRIPT_TYPE_UNKNOWN:
            return [];
        case SCRIPT_TYPES.GLOBAL:
            return sanitizePersistedRegexScriptList(sources.global ?? [], SCRIPT_TYPES.GLOBAL);
        case SCRIPT_TYPES.SCOPED:
            return sanitizePersistedRegexScriptList(sources.scoped, SCRIPT_TYPES.SCOPED);
        case SCRIPT_TYPES.PRESET:
            return sanitizePersistedRegexScriptList(sources.preset, SCRIPT_TYPES.PRESET);
        default:
            console.warn(`getScriptsByType: Invalid script type ${scriptType}`);
            return [];
    }
}

function sanitizeRegexMacro(x: string): string {
    return (x && typeof x === 'string') ?
        x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
            switch (s) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\v':
                    return '\\v';
                case '\f':
                    return '\\f';
                case '\0':
                    return '\\0';
                default:
                    return '\\' + s;
            }
        }) : x;
}

const PLUGIN_LANES = new Set<RegexPluginLane>(['request', 'reply']);

/**
 * Resolve the plugin application points for a script.
 * Legacy persisted scripts used `pluginOnly` for both points.
 * @returns The selected plugin lanes
 */
export function getPluginLanes(script: RegexScript | null | undefined): RegexPluginLane[] {
    if (Array.isArray(script?.pluginLanes)) {
        return [...new Set(script.pluginLanes.filter((lane): lane is RegexPluginLane => PLUGIN_LANES.has(lane as RegexPluginLane)))];
    }
    return script?.pluginOnly ? ['request', 'reply'] : [];
}

/**
 * Remove the legacy plugin scope field from a script without mutating it.
 * @returns A copy without the legacy plugin scope field
 */
export function omitLegacyPluginScope<T extends RegexScript | null | undefined>(script: T): T {
    if (!script || typeof script !== 'object') {
        return script;
    }
    const { pluginOnly: _legacyPluginOnly, ...rest } = script;
    return rest as T;
}

/**
 * Normalize a script record so it carries plugin lanes and no legacy field.
 * @returns A copy with `pluginLanes` and without the legacy field
 */
export function normalizePluginScriptRecord<T extends RegexScript | null | undefined>(script: T): T {
    if (!script || typeof script !== 'object') {
        return script;
    }
    return { ...omitLegacyPluginScope(script), pluginLanes: getPluginLanes(script) } as T;
}

/**
 * Parent function to fetch a regexed version of a raw string.
 * @param rawString The raw string to be regexed
 * @param placement The placement of the string(regex_placement 数值)
 * @param params The parameters to use for the regex script
 * @param substCtx 注入的宏上下文,供 findRegex/replaceString/trimStrings 替换
 * @returns The regexed string
 */
export function getRegexedString(
    rawString: string,
    placement: number | undefined,
    { characterOverride, isMarkdown, isPrompt, isPluginInput, isPluginOutput, isEdit, depth, scripts = [], regexDisabled, perfDetection, now = Date.now }: RegexParams = {},
    substCtx: SubstituteContext,
): string {
    // WTF have you passed me?
    if (typeof rawString !== 'string') {
        console.warn('getRegexedString: rawString is not a string. Returning empty string.');
        return '';
    }

    let finalString = rawString;
    if (regexDisabled || !rawString || placement === undefined) {
        return finalString;
    }

    // const 拷贝:原版 placement 此时已非 undefined,闭包里保持窄化
    const targetPlacement = placement;
    const allRegex = scripts;
    const trackPerformance = perfDetection !== false;
    allRegex.forEach((script, index) => {
        if (!script || typeof script !== 'object') {
            return;
        }

        const pluginLanes = getPluginLanes(script);
        const placementList = Array.isArray(script.placement)
            ? script.placement
            : pluginLanes.length > 0 ? [] : null;
        if (!placementList) {
            warnInvalidRegexPlacement(script, index);
            return;
        }

        const hasScopedTarget = Boolean(script.markdownOnly || script.promptOnly || pluginLanes.length > 0);
        const matchesScopedTarget =
            // Script applies to Markdown and input is Markdown
            (script.markdownOnly && isMarkdown) ||
            // Script applies to the main outgoing prompt and input is that prompt
            (script.promptOnly && isPrompt) ||
            // Plugin request lane: text going into a plugin request.
            (pluginLanes.includes('request') && isPluginInput) ||
            // Plugin reply lane: assistant text a plugin request returns.
            (pluginLanes.includes('reply') && isPluginOutput);

        // The reply is always assistant text. Placement describes message
        // kinds within a stream, so it does not gate the reply lane.
        const isReplyLane = isPluginOutput && pluginLanes.includes('reply');

        if ((hasScopedTarget && matchesScopedTarget) ||
            // Script applies to the persisted chat content only when no scoped target is enabled.
            (!hasScopedTarget && !isMarkdown && !isPrompt && !isPluginInput && !isPluginOutput)) {
            if (isEdit && !script.runOnEdit) {
                console.debug(`getRegexedString: Skipping script ${script.scriptName} because it does not run on edit`);
                return;
            }

            // The reply pass has no depth; depth filtering applies to every
            // other lane that reaches this branch.
            if (typeof depth === 'number' && !isReplyLane) {
                const minDepth = script.minDepth;
                if (!isNaN(Number(minDepth)) && minDepth !== null && minDepth !== undefined && minDepth >= -1 && depth < minDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is less than minDepth ${script.minDepth}`);
                    return;
                }

                const maxDepth = script.maxDepth;
                if (!isNaN(Number(maxDepth)) && maxDepth !== null && maxDepth !== undefined && maxDepth >= 0 && depth > maxDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is greater than maxDepth ${script.maxDepth}`);
                    return;
                }
            }

            if (isReplyLane || placementList.includes(targetPlacement)) {
                if (isRegexScriptPaused(script.id)) {
                    return;
                }
                const regexStart = trackPerformance ? now() : 0;
                finalString = runRegexScript(script, finalString, { characterOverride }, substCtx);
                if (trackPerformance) {
                    recordRegexExecution(script, now() - regexStart);
                }
            }
        }
    });

    return finalString;
}

/**
 * Runs the provided regex script on the given string
 * @param regexScript The regex script to run
 * @param rawString The string to run the regex script on
 * @param params The parameters to use for the regex script
 * @param substCtx 注入的宏上下文
 * @returns The new string
 */
export function runRegexScript(
    regexScript: RegexScript,
    rawString: string,
    { characterOverride }: RegexScriptParams = {},
    substCtx: SubstituteContext,
): string {
    let newString = rawString;
    if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
        return newString;
    }

    const getRegexString = (): string => {
        switch (Number(regexScript.substituteRegex)) {
            case substitute_find_regex.NONE:
                return regexScript.findRegex;
            case substitute_find_regex.RAW:
                return substituteParams(regexScript.findRegex, substCtx);
            case substitute_find_regex.ESCAPED:
                return substituteParams(regexScript.findRegex, substCtx, { postProcessFn: sanitizeRegexMacro });
            default:
                console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
                return regexScript.findRegex;
        }
    };
    const regexString = getRegexString();
    const findRegex = RegexProvider.instance.get(regexString);

    // The user skill issued. Return with nothing.
    if (!findRegex) {
        return newString;
    }

    // Run replacement. Currently does not support the Overlay strategy
    newString = rawString.replace(findRegex, (match: string, ...rest: unknown[]) => {
        // 与原版 [...arguments] 下标对齐:[match, p1..pn, offset, string, groups?]
        const args: unknown[] = [match, ...rest];
        const replaceString = regexScript.replaceString.replace(/{{match}}/gi, '$0');
        let matched: unknown = match;
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_m, num, groupName) => {
            if (num) {
                // Handle numbered capture groups ($1, $2, etc.;$0 即 args[0] 全匹配)
                matched = args[Number(num)];
            } else if (groupName) {
                // Handle named capture groups ($<name>)
                const groups = args[args.length - 1];
                matched = groups && typeof groups === 'object' && (groups as Record<string, string>)[groupName];
            }

            // No match found - return the empty string
            if (!matched) {
                return '';
            }

            // Remove trim strings from the match
            const filteredMatch = filterString(matched as string, regexScript.trimStrings, { characterOverride }, substCtx);

            return filteredMatch;
        });

        // Substitute at the end
        return substituteParams(replaceWithGroups, substCtx);
    });

    return newString;
}

/**
 * Filters anything to trim from the regex match
 * @param rawString The raw string to filter
 * @param trimStrings The strings to trim
 * @param params The parameters to use for the regex filter
 * @param substCtx 注入的宏上下文(trim 串里 {{char}} 用 name2Override)
 * @returns The filtered string
 */
function filterString(
    rawString: string,
    trimStrings: string[],
    { characterOverride }: RegexScriptParams = {},
    substCtx: SubstituteContext,
): string {
    let finalString = rawString;
    trimStrings.forEach((trimString) => {
        const subTrimString = substituteParams(trimString, substCtx, { name2Override: characterOverride });
        finalString = finalString.replaceAll(subTrimString, '');
    });

    return finalString;
}

/**
 * 便利封装 — 对应原版 `world-info.js` 的
 * `getRegexedString(entry.content, regex_placement.WORLD_INFO, { depth, isMarkdown: false, isPrompt: true })`。
 * WI 引擎 `ctx.applyWorldInfoRegex` 钩子形状:`(content, {depth, role}) => string`;
 * role 是 @Depth 注入角色,与正则过滤无关,仅透传兼容。
 */
export function applyWorldInfoRegex(
    scripts: readonly RegexScript[],
    content: string,
    { depth }: { depth?: number | null; role?: number } = {},
    substCtx: SubstituteContext,
): string {
    return getRegexedString(content, regex_placement.WORLD_INFO, {
        scripts,
        isMarkdown: false,
        isPrompt: true,
        depth,
    }, substCtx);
}
