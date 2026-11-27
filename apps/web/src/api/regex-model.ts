// Regex-script pure model — the content-addressing layer behind
// api/regex.ts's IO wrappers. Zero imports: node --test can drive it
// directly (same split as quickreplies.ts / quickreplies-model.ts).
//
// The PATCH/DELETE routes resolve :id by exact id first, then by array
// index. For scripts WITHOUT an id the only address left is the index —
// computed from whichever snapshot the view rendered, so once the list
// changed server-side the write lands on the wrong script (review 🔴4).
// These transforms locate the script by deep-equal CONTENT — never by
// position — and run inside mutateRegexScope's serial GET→fn→PUT chain
// so the lookup always happens on the freshest array.
import type { RegexScriptData } from '@utopinn/protocol';

/** Structural equality behind content addressing (key order free). */
export function regexDeepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
        regexDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Thrown when the script captured at render time no longer exists in
    the scope (edited/deleted elsewhere) — callers reload the view. */
export class RegexScriptMovedError extends Error {
    readonly code = 'regex_script_moved';
    constructor() { super('regex script changed or removed since the view loaded'); }
}

/** First content match, or -1 (identical twins are interchangeable). */
export const regexFindByContent = (arr: RegexScriptData[], script: RegexScriptData): number =>
    arr.findIndex((sc) => regexDeepEqual(sc, script));

/** DELETE-equivalent transform: drop the content match from `arr`. */
export const regexRemoveByContent = (arr: RegexScriptData[], script: RegexScriptData): RegexScriptData[] => {
    const i = regexFindByContent(arr, script);
    if (i < 0) throw new RegexScriptMovedError();
    return [...arr.slice(0, i), ...arr.slice(i + 1)];
};

/** PATCH-equivalent transform: merge `set` onto the content match. */
export const regexPatchByContent = (
    arr: RegexScriptData[],
    script: RegexScriptData,
    set: Partial<RegexScriptData>,
): RegexScriptData[] => {
    const i = regexFindByContent(arr, script);
    if (i < 0) throw new RegexScriptMovedError();
    return arr.map((sc, j) => (j === i ? { ...sc, ...set } : sc));
};
