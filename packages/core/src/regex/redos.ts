/**
 * ReDoS 防护 — 移植自 `extensions/regex/redos-reporter.js` 的非 DOM 部分。
 * 暂停集合/统计/阈值语义不变;原版弹窗(callGenericPopup)替换为注入回调。
 * 会话级模块状态,服务端即为进程级。
 */

/**
 * Threshold in milliseconds for declaring a single regex execution catastrophic.
 * Anything longer than this on one script is treated as ReDoS-suspect and the script
 * is paused for the rest of the session.
 */
export const REGEX_HARD_THRESHOLD_MS = 500;

/** Script ids paused for the rest of this session. */
const pausedScripts = new Set<string>();

/**
 * Session cache of script ids the user has explicitly opted into running slowly.
 * The authoritative decision is persisted on the script itself (`allowSlow`); this
 * set keeps the decision effective immediately, before the persistence round-trip
 * completes, and covers runtime scripts that have no persisted storage.
 */
const userAllowedSlowScripts = new Set<string>();

export interface RegexScriptStats {
    hits: number;
    totalMs: number;
    peakMs: number;
    name: string;
    pattern: string;
}

const stats = new Map<string, RegexScriptStats>();

/** 慢脚本通知(替代原版 DOM 弹窗);由应用层注入,返回 void。 */
export type RegexSlowScriptHandler = (scriptId: string, entry: RegexScriptStats) => void;

let slowScriptHandler: RegexSlowScriptHandler | null = null;
const popupShownScripts = new Set<string>();

/** 注入慢脚本处理回调;传 null 解除。 */
export function setRegexSlowScriptHandler(handler: RegexSlowScriptHandler | null): void {
    slowScriptHandler = handler;
}

export function isRegexScriptPaused(scriptId: string | null | undefined): boolean {
    if (!scriptId) return false;
    return pausedScripts.has(String(scriptId));
}

export function pauseRegexScript(scriptId: string | null | undefined): void {
    if (!scriptId) return;
    pausedScripts.add(String(scriptId));
}

/** @returns true if the script was paused before */
export function unpauseRegexScript(scriptId: string | null | undefined): boolean {
    if (!scriptId) return false;
    return pausedScripts.delete(String(scriptId));
}

/** 等价原版 "Allow anyway":本会话内不再自动暂停该脚本。 */
export function allowSlowRegexScript(scriptId: string | null | undefined): void {
    if (!scriptId) return;
    userAllowedSlowScripts.add(String(scriptId));
    pausedScripts.delete(String(scriptId));
}

/**
 * Clears all session state for the given script id: pause, shown flag,
 * user-accepted-slow cache, and stats. Call this when a script is edited and
 * saved, since the stored pattern may have changed and the previous evaluation
 * no longer applies. The persisted `allowSlow` decision lives on the script
 * itself and is intentionally not touched here.
 */
export function resetRegexScriptState(scriptId: string | null | undefined): void {
    if (!scriptId) return;
    const id = String(scriptId);
    pausedScripts.delete(id);
    popupShownScripts.delete(id);
    userAllowedSlowScripts.delete(id);
    stats.delete(id);
}

/** Clears session detection state for every script(原版在关闭检测时调用)。 */
export function resetAllRegexScriptState(): void {
    pausedScripts.clear();
    popupShownScripts.clear();
    stats.clear();
}

export function getRegexScriptStats(scriptId: string | null | undefined): RegexScriptStats | undefined {
    if (!scriptId) return undefined;
    return stats.get(String(scriptId));
}

/**
 * Records a single regex execution. If the elapsed time crosses the hard threshold,
 * the script is auto-paused and the injected handler is notified(每会话每脚本一次)。
 */
export function recordRegexExecution(
    script: { id?: string; scriptName?: string; findRegex?: string; allowSlow?: boolean } | null | undefined,
    elapsedMs: number,
): void {
    if (!script || !script.id) return;
    const id = String(script.id);
    let entry = stats.get(id);
    if (!entry) {
        entry = { hits: 0, totalMs: 0, peakMs: 0, name: '', pattern: '' };
        stats.set(id, entry);
    }
    entry.hits += 1;
    entry.totalMs += elapsedMs;
    if (elapsedMs > entry.peakMs) entry.peakMs = elapsedMs;
    if (script.scriptName) entry.name = String(script.scriptName);
    if (script.findRegex) entry.pattern = String(script.findRegex);

    if (elapsedMs >= REGEX_HARD_THRESHOLD_MS && !pausedScripts.has(id)) {
        if (script.allowSlow || userAllowedSlowScripts.has(id)) {
            // The user has explicitly accepted that this script is slow. Track
            // stats but do not auto-pause and do not surface a popup.
            return;
        }
        pausedScripts.add(id);
        console.warn('[Regex] Pausing script due to slow execution', {
            id,
            name: entry.name,
            elapsedMs: Math.round(elapsedMs),
            peakMs: Math.round(entry.peakMs),
            totalMs: Math.round(entry.totalMs),
            hits: entry.hits,
        });
        if (!popupShownScripts.has(id)) {
            popupShownScripts.add(id);
            try {
                slowScriptHandler?.(id, entry);
            } catch (error) {
                console.warn('[Regex] Slow-script handler failed', { id, error });
            }
        }
    }
}
