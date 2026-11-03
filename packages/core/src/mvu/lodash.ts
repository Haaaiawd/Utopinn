/**
 * lodash 语义子集 — MVU settle 引擎的移植底座。
 * 语义基准:lodash 4.17.x 的 `_.toPath`/`_.get`/`_.set`/`_.has`/`_.unset`/
 * `_.merge`/`_.mergeWith`/`_.isEqual`/`_.concat`/`_.isObject`/`_.isEmpty`,
 * 仅覆盖 stat_data 这类 JSON-only 数据(外加 Date 透传)。
 * 上游引用:`ref/dsh-tavern/.../magvarupdate/upstream/src/function/update_variables.ts`
 * 全文件、`schema.ts`、`util/common.ts`(correctlyMerge)、`variable_init.ts`。
 *
 * `_.set` 对 `__proto__`/`constructor`/`prototype` 路径一律拒绝写入:
 * lodash 新版同样拦原型链污染,这里直接固化(模型输出不可信)。
 */

export type PathSegment = string;
export type Path = string | readonly PathSegment[];

/** lodash `isIndex`:`0` 或无前导零的正整数,且在 MAX_SAFE_INTEGER 内。 */
const IS_INDEX_RE = /^(?:0|[1-9]\d*)$/;
export function isIndex(value: unknown): value is string {
    return typeof value === 'string' && IS_INDEX_RE.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `_.toPath` 端口:把 `a.b[0].c`、`a["b c"].d`、`a['x']` 风格路径拆成段数组。
 * 段一律是字符串;是否数字索引由消费方按 isIndex 判定。
 */
export function toPath(path: Path): PathSegment[] {
    if (Array.isArray(path)) {
        return path.slice() as PathSegment[];
    }
    const input = String(path);
    if (input === '') {
        return [];
    }
    const segments: PathSegment[] = [];
    let i = 0;
    let current = '';
    // `a[0].b`:`]` 后紧跟 `.` 不再产出空段(lodash 为 ['a','0','b']);
    // `a..b` 保留空段(lodash 为 ['a','','b'])。
    let justClosedBracket = false;
    const flush = () => {
        segments.push(current);
        current = '';
    };
    while (i < input.length) {
        const char = input[i]!;
        if (char === '.') {
            if (current !== '' || !justClosedBracket) {
                flush();
            }
            justClosedBracket = false;
            i++;
            continue;
        }
        if (char === '[') {
            // 段内出现 '[' 时先把已累积的裸段收掉(lodash 同样允许 a[0] 紧跟写法)。
            if (current !== '') {
                flush();
            }
            justClosedBracket = false;
            i++; // consume '['
            while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
            const first = input[i];
            if (first === '"' || first === "'") {
                const quote = first;
                i++;
                let inner = '';
                while (i < input.length && input[i] !== quote) {
                    if (input[i] === '\\' && i + 1 < input.length) {
                        i++;
                        inner += input[i];
                        i++;
                        continue;
                    }
                    inner += input[i];
                    i++;
                }
                i++; // consume closing quote
                while (i < input.length && input[i] !== ']' && input[i] !== '.') i++;
                if (input[i] === ']') i++;
                segments.push(inner);
                justClosedBracket = true;
                continue;
            }
            // 无引号:取到 ']' 为止,作为字面段(数字段按 isIndex 判定)。
            let inner = '';
            while (i < input.length && input[i] !== ']') {
                inner += input[i];
                i++;
            }
            if (input[i] === ']') i++;
            segments.push(inner.trim());
            justClosedBracket = true;
            continue;
        }
        justClosedBracket = false;
        current += char;
        i++;
    }
    if (current !== '' || segments.length === 0) {
        flush();
    }
    return segments;
}

function toPathKey(segment: PathSegment): string {
    return String(segment);
}

/** `_.get`:逐段读,遇到 null/非对象即 undefined。 */
export function get(object: unknown, path: Path): unknown {
    const segments = toPath(path);
    let current = object;
    for (const segment of segments) {
        if (current === null || current === undefined || (typeof current !== 'object' && typeof current !== 'function')) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[toPathKey(segment)];
    }
    return current;
}

/** `_.has`:每一级都存在(own property;数组段须在界内)。 */
export function has(object: unknown, path: Path): boolean {
    const segments = toPath(path);
    if (segments.length === 0) {
        return false;
    }
    let current = object;
    for (const segment of segments) {
        if (current === null || typeof current !== 'object') {
            return false;
        }
        const key = toPathKey(segment);
        if (Array.isArray(current)) {
            if (!isIndex(key) || Number(key) >= current.length) {
                return false;
            }
        } else if (!Object.prototype.hasOwnProperty.call(current, key)) {
            return false;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return true;
}

/**
 * `_.set` (baseSet):中间层缺失或被原始值占位时,按"下一段是否索引"建 [] / {}。
 * 数组段写入越界索引 = push 到对应下标(lodash 行为)。
 */
export function set(object: unknown, path: Path, value: unknown): void {
    if (object === null || (typeof object !== 'object' && typeof object !== 'function')) {
        return;
    }
    const segments = toPath(path);
    if (segments.length === 0) {
        return;
    }
    let current = object as Record<string, unknown>;
    for (let i = 0; i < segments.length; i++) {
        const key = toPathKey(segments[i]!);
        if (FORBIDDEN_KEYS.has(key)) {
            return;
        }
        if (i === segments.length - 1) {
            if (Array.isArray(current) && isIndex(key)) {
                (current as unknown as unknown[])[Number(key)] = value;
            } else {
                current[key] = value;
            }
            return;
        }
        const nextKey = segments[i + 1]!;
        if (FORBIDDEN_KEYS.has(String(nextKey))) {
            return;
        }
        let child: unknown;
        if (Array.isArray(current) && isIndex(key)) {
            child = (current as unknown as unknown[])[Number(key)];
        } else {
            child = current[key];
        }
        if (child === null || (typeof child !== 'object' && typeof child !== 'function')) {
            child = isIndex(nextKey) ? [] : {};
            if (Array.isArray(current) && isIndex(key)) {
                (current as unknown as unknown[])[Number(key)] = child;
            } else {
                current[key] = child;
            }
        }
        current = child as Record<string, unknown>;
    }
}

/**
 * `_.unset` (baseUnset):删除末段键。与 lodash 一致——数组上按 `delete` 留洞
 * (非 splice);数组元素 splice 由调用方自行决定(上游就是这么做的)。
 */
export function unset(object: unknown, path: Path): boolean {
    const segments = toPath(path);
    if (segments.length === 0) {
        return false;
    }
    const parent = get(object, segments.slice(0, -1));
    if (parent === null || typeof parent !== 'object') {
        return false;
    }
    const key = toPathKey(segments[segments.length - 1]!);
    if (FORBIDDEN_KEYS.has(key)) {
        return false;
    }
    return delete (parent as Record<string, unknown>)[key];
}

export function isObjectLike(value: unknown): value is Record<string, unknown> {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** lodash `_.isObject` 的 JSON 域近似:非 null 的对象(含数组;Date 亦算)。 */
export function isObject(value: unknown): value is Record<string, unknown> {
    return isObjectLike(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return isObjectLike(value) && !Array.isArray(value);
}

export function isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' || Array.isArray(value)) return (value as { length: number }).length === 0;
    if (isObjectLike(value)) return Object.keys(value).length === 0;
    return true;
}

/**
 * `_.merge`:源逐键深合并进目标。数组按下标逐位合并(不是拼接)。
 * 目标被原地修改并返回。
 */
export function merge(target: unknown, ...sources: unknown[]): unknown {
    return mergeWithCustomizer(target, sources, undefined);
}

/**
 * `_.mergeWith`:同 merge,但 customizer(objValue, srcValue) 返回值非 undefined 时
 * 直接采用返回值(上游 correctlyMerge 用它实现"数组替换而非逐位合并")。
 */
export function mergeWith(
    target: unknown,
    sources: unknown[],
    customizer: (objValue: unknown, srcValue: unknown) => unknown,
): unknown {
    return mergeWithCustomizer(target, sources, customizer);
}

function mergeWithCustomizer(
    target: unknown,
    sources: unknown[],
    customizer: ((objValue: unknown, srcValue: unknown) => unknown) | undefined,
): unknown {
    if (!isObjectLike(target)) {
        return target;
    }
    for (const source of sources) {
        if (!isObjectLike(source)) {
            continue;
        }
        mergeInto(target as Record<string, unknown>, source as Record<string, unknown>, customizer);
    }
    return target;
}

function mergeInto(
    target: Record<string, unknown> | unknown[],
    source: Record<string, unknown> | unknown[],
    customizer: ((objValue: unknown, srcValue: unknown) => unknown) | undefined,
): void {
    const sourceKeys = Object.keys(source);
    for (const key of sourceKeys) {
        const srcValue = (source as Record<string, unknown>)[key];
        const dstValue = (target as Record<string, unknown>)[key];
        if (customizer) {
            const custom = customizer(dstValue, srcValue);
            if (custom !== undefined) {
                (target as Record<string, unknown>)[key] = custom;
                continue;
            }
        }
        if (isObjectLike(srcValue) && !(srcValue instanceof Date)) {
            if (Array.isArray(srcValue)) {
                // lodash merge:目标不是数组则新建 [],再逐位合并。
                const base: unknown[] = Array.isArray(dstValue) ? dstValue : [];
                base.length = Math.max(base.length, srcValue.length);
                mergeInto(base, srcValue, customizer);
                (target as Record<string, unknown>)[key] = base;
            } else if (isPlainObject(dstValue) && !(dstValue instanceof Date)) {
                mergeInto(dstValue as Record<string, unknown>, srcValue as Record<string, unknown>, customizer);
            } else if (isPlainObject(srcValue)) {
                const base: Record<string, unknown> = isPlainObject(dstValue) ? (dstValue as Record<string, unknown>) : {};
                mergeInto(base, srcValue as Record<string, unknown>, customizer);
                (target as Record<string, unknown>)[key] = base;
            } else {
                (target as Record<string, unknown>)[key] = srcValue;
            }
        } else {
            (target as Record<string, unknown>)[key] = srcValue;
        }
    }
}

/** `_.concat`:浅拼接(返回新数组)。 */
export function concat(a: readonly unknown[], b: readonly unknown[]): unknown[] {
    return [...a, ...b];
}

/** `_.isEqual` 的 JSON 域深比较(含 Date getTime、NaN)。 */
export function isEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
        return true;
    }
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() === b.getTime();
    }
    if (!isObjectLike(a) || !isObjectLike(b)) {
        return false;
    }
    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray !== bIsArray) {
        return false;
    }
    if (aIsArray && bIsArray) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!isEqual(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) {
            return false;
        }
        if (!isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
            return false;
        }
    }
    return true;
}

/** `klona` 等价:JSON 域深拷贝 + Date 保型。 */
export function deepClone<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as T;
    }
    if (Array.isArray(value)) {
        return value.map(item => deepClone(item)) as T;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
        out[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return out as T;
}
