/**
 * Shared pure utilities ported from Luker `public/scripts/utils.js`.
 * No DOM, no fs, no Node-specific APIs.
 */

/**
 * String hash (cyrb53-style). Must stay byte-identical to
 * `utils.js getStringHash` — WI timed-effects metadata stores
 * entry hashes computed with this function.
 */
export function getStringHash(str: string, seed = 0): number {
    if (typeof str !== 'string') {
        return 0;
    }

    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Escapes special regex characters in a string.
 */
export function escapeRegex(string: string): string {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Normalize an array of strings: trim, drop empties, dedupe.
 */
export function normalizeArray(arr: unknown[] | null | undefined): string[] {
    return [...new Set((arr ?? []).map(s => typeof s === 'string' ? s.trim() : s).filter(Boolean))] as string[];
}

/**
 * Strict mode deep clone equivalent of the original's `structuredClone`.
 */
export function clone<T>(value: T): T {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

/**
 * Checks if a string only contains digits.
 */
export function isDigitsOnly(str: string): boolean {
    return /^\d+$/.test(str);
}
