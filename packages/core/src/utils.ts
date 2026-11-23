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

/** `utils.js parseStringArray` — JSON 数组或逗号分隔串 → string[]。 */
export function parseStringArray(value: unknown): string[] {
    if (!value || typeof value !== 'string') return [];
    try {
        const parsedValue = JSON.parse(value);
        if (!Array.isArray(parsedValue)) {
            throw new Error('Not an array');
        }
        return parsedValue.map(x => String(x));
    } catch {
        return value.split(',').map(x => x.trim()).filter(x => x);
    }
}

/** `utils.js setValueByPath` — 点分路径写值,中间对象缺失即建。 */
export function setValueByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keyParts = path.split('.');
    let currentObject = obj;
    for (let i = 0; i < keyParts.length - 1; i++) {
        const part = keyParts[i]!;
        if (!Object.hasOwn(currentObject, part)) {
            currentObject[part] = {};
        }
        currentObject = currentObject[part] as Record<string, unknown>;
    }
    currentObject[keyParts[keyParts.length - 1]!] = value;
}

/** `utils.js getUniqueName` — 重名时追加 " (n)" 后缀。 */
export function getUniqueName(baseName: string, exists: (name: string) => boolean, { nameBuilder = null as null | ((base: string, i: number) => string), maxTries = 1000, startIndex = 0 } = {}): string | null {
    nameBuilder ??= (base, i) => i === 0 ? base : `${base} (${i})`;
    let i = startIndex;
    let name: string | null;
    while (i < maxTries + startIndex) {
        name = nameBuilder(baseName, i);
        if (!exists(name)) {
            return name;
        }
        i++;
    }
    return null;
}

/** `utils.js onlyUnique` — Array.filter 去重回调。 */
export function onlyUnique<T>(value: T, index: number, array: T[]): boolean {
    return array.indexOf(value) === index;
}

const LOOKUP_VARIATION_SELECTORS_RE = /[\uFE0E\uFE0F\u{E0100}-\u{E01EF}]/gu;

/** `utils.js normalizeLookupText` — 宽容查找归一化(trim + NFC + 变体选择符剥离)。 */
export function normalizeLookupText(value: unknown): string {
    const text = String(value ?? '').trim();
    if (!text) {
        return '';
    }
    return text.normalize('NFC').replace(LOOKUP_VARIATION_SELECTORS_RE, '');
}

/** `utils.js areLookupNamesEqual` — 宽容名相等(精确优先,回退归一化比较)。 */
export function areLookupNamesEqual(a: unknown, b: unknown): boolean {
    const left = String(a ?? '').trim();
    const right = String(b ?? '').trim();
    if (!left || !right) {
        return left === right;
    }
    if (left === right) {
        return true;
    }
    return normalizeLookupText(left) === normalizeLookupText(right);
}

/** `utils.js findCanonicalNameInList` — 从清单解析 canonical 名(精确 → 宽容)。 */
export function findCanonicalNameInList(list: unknown, name: unknown): string {
    const requested = String(name ?? '').trim();
    if (!requested || !Array.isArray(list)) {
        return '';
    }
    return (list as unknown[]).find(item => String(item ?? '').trim() === requested) as string | undefined
        || (list as unknown[]).find(item => areLookupNamesEqual(item, requested)) as string | undefined
        || '';
}
