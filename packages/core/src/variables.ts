/**
 * Variable store ops — ported from `public/scripts/variables.js`
 * (flat + dotted-path subset used by the legacy macro surface).
 * The full op-log replay system is a TASK-006 boundary; this module
 * covers the semantics reachable through {{getvar/setvar/...}} macros.
 */

export type VarStore = Record<string, unknown>;

/** Coerce a value the way `getLocalVariable` returns it: numeric strings become numbers. */
function coerceReturn(value: unknown): string | number {
    const trimmed = (value as string)?.trim?.();
    return (trimmed === '' || isNaN(Number(value))) ? ((value ?? '') as string | number) : Number(value);
}

function splitRootAndPath(name: string): { root: string; path: string | null } {
    const idx = name.indexOf('.');
    if (idx === -1) {
        return { root: name, path: null };
    }
    return { root: name.slice(0, idx), path: name.slice(idx + 1) };
}

function readPath(container: unknown, path: string): unknown {
    let cur = container;
    for (const seg of path.split('.')) {
        if (cur === null || typeof cur !== 'object') {
            return undefined;
        }
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

function writePath(container: Record<string, unknown>, path: string, value: unknown): void {
    const segs = path.split('.');
    let cur: Record<string, unknown> = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i]!;
        const next = cur[seg];
        if (next === null || typeof next !== 'object' || Array.isArray(next)) {
            cur[seg] = {};
        }
        cur = cur[seg] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1]!] = value;
}

/**
 * Reads a variable. Mirrors `getLocalVariable`/`getGlobalVariable`:
 * dotted names do a path read with literal flat-key fallback semantics;
 * numeric-looking values coerce to number on return.
 */
export function getVariable(store: VarStore, name: string, args: { index?: number | string; key?: string } = {}): string | number {
    let variable: unknown;

    if (typeof name === 'string' && name.includes('.') && args.index === undefined && !args.key) {
        const { root, path } = splitRootAndPath(name);
        const rootValue = Object.prototype.hasOwnProperty.call(store, root) ? store[root] : '';
        let parsed: unknown = rootValue;
        if (typeof rootValue === 'string') {
            try {
                parsed = JSON.parse(rootValue);
            } catch {
                parsed = rootValue;
            }
        }
        variable = readPath(parsed, path!);
        if (variable === undefined) {
            variable = '';
        }
        if (typeof variable === 'object') {
            variable = JSON.stringify(variable);
        }
    } else {
        variable = store[args.key ?? name];
        if (args.index !== undefined) {
            try {
                variable = JSON.parse(String(variable));
                const numIndex = Number(args.index);
                if (Number.isNaN(numIndex)) {
                    variable = (variable as Record<string, unknown>)[String(args.index)];
                } else {
                    variable = (variable as unknown[])[Number(args.index)];
                }
                if (typeof variable === 'object') {
                    variable = JSON.stringify(variable);
                }
            } catch {
                // that didn't work
            }
        }
    }

    return coerceReturn(variable);
}

/** Sets a variable. Mirrors `setLocalVariable`/`setGlobalVariable` flat + dotted path ops. */
export function setVariable(store: VarStore, name: string, value: unknown, args: { index?: number | string; key?: string; as?: string } = {}): unknown {
    if (!name) {
        throw new Error('Variable name cannot be empty or undefined.');
    }

    if (typeof name === 'string' && name.includes('.')) {
        const { root, path } = splitRootAndPath(name);
        const raw = store[root];
        let parsed: unknown;
        if (raw !== null && typeof raw === 'object') {
            // 对象根(MVU stat_data 原生对象形态)——直接改,不写回串。
            // TH/MVU 生态经 lodash-path 读对象;JSON.stringify 回写会把
            // 对象降维成串并丢掉其余字段(曾实测会把整棵 stat_data 毁成
            // 单路径的字符串)。
            parsed = raw;
        } else {
            try {
                parsed = JSON.parse(String(raw ?? 'null')) ?? {};
            } catch {
                parsed = {};
            }
            if (parsed === null || typeof parsed !== 'object') {
                parsed = {};
            }
        }
        writePath(parsed as Record<string, unknown>, path!, String(value ?? ''));
        // 已有形态保持:对象根回写对象;字符串/新根按 ST 惯例 JSON 化
        // ({{getvar::root}} 整根读拿到 JSON 串而非 [object Object])。
        store[root] = (raw !== null && typeof raw === 'object') ? parsed : JSON.stringify(parsed);
        return value;
    }

    if (args.index !== undefined) {
        try {
            let variable = JSON.parse(String(store[name] ?? 'null'));
            const numIndex = Number(args.index);
            if (Number.isNaN(numIndex)) {
                if (variable === null) {
                    variable = {};
                }
                (variable as Record<string, unknown>)[String(args.index)] = value;
            } else {
                if (variable === null) {
                    variable = [];
                }
                (variable as unknown[])[numIndex] = value;
            }
            store[name] = JSON.stringify(variable);
        } catch {
            // that didn't work
        }
    } else {
        store[args.key ?? name] = value;
    }
    return value;
}

/** `addLocalVariable`/`addGlobalVariable`: numeric add, string concat, or array push. */
export function addVariable(store: VarStore, name: string, value: unknown): unknown {
    const currentValue = getVariable(store, name) || 0;
    try {
        const parsedValue = JSON.parse(String(currentValue));
        if (Array.isArray(parsedValue)) {
            parsedValue.push(value);
            setVariable(store, name, JSON.stringify(parsedValue));
            return parsedValue;
        }
    } catch {
        // ignore non-array values
    }
    const increment = Number(value);

    if (isNaN(increment) || isNaN(Number(currentValue))) {
        const stringValue = String(currentValue || '') + String(value);
        setVariable(store, name, stringValue);
        return stringValue;
    }

    const newValue = Number(currentValue) + increment;
    if (isNaN(newValue)) {
        return '';
    }

    setVariable(store, name, newValue);
    return newValue;
}

export function incrementVariable(store: VarStore, name: string): unknown {
    return addVariable(store, name, 1);
}

export function decrementVariable(store: VarStore, name: string): unknown {
    return addVariable(store, name, -1);
}

/** `deleteLocalVariable`/`deleteGlobalVariable`. */
export function deleteVariable(store: VarStore, name: string): void {
    if (typeof name === 'string' && name.includes('.')) {
        const { root, path } = splitRootAndPath(name);
        try {
            const parsed = JSON.parse(String(store[root] ?? 'null'));
            if (parsed && typeof parsed === 'object') {
                const segs = path!.split('.');
                let cur = parsed as Record<string, unknown>;
                for (let i = 0; i < segs.length - 1; i++) {
                    cur = cur?.[segs[i]!] as Record<string, unknown>;
                    if (!cur) return;
                }
                delete cur[segs[segs.length - 1]!];
                store[root] = JSON.stringify(parsed);
            }
        } catch {
            // ignore
        }
        return;
    }
    delete store[name];
}
