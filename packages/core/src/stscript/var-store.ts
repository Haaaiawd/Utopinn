/**
 * 变量存取 — 移植自 ref/Luker:
 * - public/scripts/variables.js:get/set/add/inc/dec/delete(exists)+
 *   push/popLocalVariable/resolveVariable/parseBooleanOperands/evalBoolean/
 *   parseNumericSeries/performOperation
 * - public/scripts/variable-op-log/path-ops.js:dotted-path 结构化写
 * - public/scripts/macros/util/var-path.js:resolveVarPath 读侧回退
 * - public/scripts/utils.js convertValueType
 *
 * Luker 中局部库是 `chat_metadata.variables`、全局库是
 * `extension_settings.variables.global`;core 以 env.macro 注入两者的引用,
 * 本模块全部函数显式收 store 参数,不触任何全局。
 */
import { SlashCommandClosure } from './closure.js';
import type { SlashCommandScope } from './scope.js';
import type { NamedArguments } from './types.js';
import type { VarStore } from '../variables.js';
import { isFalseBoolean, isTrueBoolean } from './util.js';

export type { VarStore };

export interface VarStores {
    /** chat_metadata.variables。 */
    local: VarStore;
    /** extension_settings.variables.global。 */
    global: VarStore;
}

// ---------------------------------------------------------------------------
// utils.js convertValueType — 原版照抄(string→指定类型,pythonista 别名)
// ---------------------------------------------------------------------------

export function convertValueType(value: unknown, type: unknown): unknown {
    if (value instanceof SlashCommandClosure || typeof type !== 'string') {
        return value;
    }

    switch (type.trim().toLowerCase()) {
        case 'string':
        case 'str':
            return String(value);

        case 'null':
            return null;

        case 'undefined':
        case 'none':
            return undefined;

        case 'number':
            return Number(value);

        case 'int':
            return parseInt(String(value), 10);

        case 'float':
            return parseFloat(String(value));

        case 'boolean':
        case 'bool':
            return isTrueBoolean(value);

        case 'list':
        case 'array':
            try {
                const parsedArray = JSON.parse(String(value));
                if (Array.isArray(parsedArray)) {
                    return parsedArray;
                }
                // The value is not an array
                return [];
            } catch {
                return [];
            }

        case 'object':
        case 'dict':
        case 'dictionary':
            try {
                const parsedObject = JSON.parse(String(value));
                if (typeof parsedObject === 'object') {
                    return parsedObject;
                }
                // The value is not an object
                return {};
            } catch {
                return {};
            }

        default:
            return value;
    }
}

// ---------------------------------------------------------------------------
// variable-op-log/path-ops.js — 逐行照抄
// ---------------------------------------------------------------------------

export function splitRootAndPath(name: string): { root: string; path: string } {
    if (typeof name !== 'string' || name.length === 0) {
        return { root: '', path: '' };
    }
    const dot = name.indexOf('.');
    if (dot < 0) return { root: name, path: '' };
    return { root: name.slice(0, dot), path: name.slice(dot + 1) };
}

/** Best-effort JSON parse;只有 object/array/number 结果保持解析态,其余原样返回。 */
export function tryParseValue(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && (typeof parsed === 'object')) return parsed;
        if (typeof parsed === 'number') return parsed;
        return raw;
    } catch {
        return raw;
    }
}

export function lodashSetPath(container: Record<string, unknown> | unknown[], path: string, value: unknown): void {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return;
    let node: Record<string, unknown> | unknown[] = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i]!;
        const next = segs[i + 1];
        const wantArray = segIsArrayIndex(next!);
        const child = (node as Record<string, unknown>)[seg];
        if (child === undefined || child === null || typeof child !== 'object') {
            (node as Record<string, unknown>)[seg] = wantArray ? [] : {};
        }
        node = (node as Record<string, unknown>)[seg] as Record<string, unknown> | unknown[];
    }
    (node as Record<string, unknown>)[segs[segs.length - 1]!] = value;
}

export function lodashDeletePath(container: Record<string, unknown> | unknown[], path: string): boolean {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return false;
    let node: Record<string, unknown> | unknown[] = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i]!;
        const child = (node as Record<string, unknown>)[seg];
        if (child === undefined || child === null || typeof child !== 'object') {
            return false;
        }
        node = child as Record<string, unknown> | unknown[];
    }
    const last = segs[segs.length - 1]!;
    if (Array.isArray(node)) {
        const idx = Number(last);
        if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return false;
        node.splice(idx, 1);
        return true;
    }
    if (!Object.prototype.hasOwnProperty.call(node, last)) return false;
    delete (node as Record<string, unknown>)[last];
    return true;
}

export function pushAtPath(container: Record<string, unknown> | unknown[], path: string, value: unknown): boolean {
    const nav = navigateToParent(container, path);
    if (!nav) return false;
    const { parent, lastSeg } = nav;
    const existing = (parent as Record<string, unknown>)[lastSeg];
    if (existing === undefined || existing === null) {
        (parent as Record<string, unknown>)[lastSeg] = [value];
        return true;
    }
    if (!Array.isArray(existing)) return false;
    existing.push(value);
    return true;
}

export function popAtPath(container: Record<string, unknown> | unknown[], path: string): unknown {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return undefined;
    let node: Record<string, unknown> | unknown[] = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const child = (node as Record<string, unknown>)[segs[i]!];
        if (child === undefined || child === null || typeof child !== 'object') return undefined;
        node = child as Record<string, unknown> | unknown[];
    }
    const last = segs[segs.length - 1]!;
    const arr = (node as Record<string, unknown>)[last];
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    return arr.pop();
}

export interface VarOp {
    op: string;
    key: string;
    path?: string;
    value?: unknown;
}

/** applyPathOp — 结构化路径写;永不抛,失败 console.warn。 */
export function applyPathOp(state: VarStore, op: VarOp): unknown {
    if (!state || typeof state !== 'object') return undefined;
    if (!op || typeof op.key !== 'string' || !op.key) return undefined;

    const path = typeof op.path === 'string' ? op.path : '';
    const segs = parsePathSegments(path);
    const firstSeg = segs[0];

    switch (op.op) {
        case 'setvar': {
            if (segs.length === 0) {
                if (path.length === 0) {
                    state[op.key] = op.value ?? '';
                    return state[op.key];
                }
                console.warn('[variable-op-log] setvar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root } = getOrInitRoot(state, op.key, firstSeg, op);
            lodashSetPath(root, path, tryParseValue(op.value));
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'deletevar': {
            if (segs.length === 0) {
                if (path.length === 0) {
                    delete state[op.key];
                    return undefined;
                }
                console.warn('[variable-op-log] deletevar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root, exists } = getOrInitRoot(state, op.key, firstSeg, op);
            if (!exists) {
                return undefined;
            }
            const ok = lodashDeletePath(root, path);
            if (!ok) {
                console.warn('[variable-op-log] deletevar path not found', op);
                return state[op.key];
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'pushvar': {
            if (segs.length === 0 && path.length > 0) {
                console.warn('[variable-op-log] pushvar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root } = getOrInitRoot(state, op.key, firstSeg, op);
            const value = tryParseValue(op.value);
            if (segs.length === 0) {
                if (!Array.isArray(root)) {
                    console.warn('[variable-op-log] pushvar root is not array', op);
                    return state[op.key];
                }
                root.push(value);
            } else {
                const ok = pushAtPath(root, path, value);
                if (!ok) {
                    console.warn('[variable-op-log] pushvar target is not array', op);
                    return state[op.key];
                }
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'popvar': {
            if (segs.length === 0 && path.length > 0) {
                console.warn('[variable-op-log] popvar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root, exists } = getOrInitRoot(state, op.key, firstSeg, op);
            if (!exists) {
                return undefined;
            }
            if (segs.length === 0) {
                if (!Array.isArray(root)) {
                    console.warn('[variable-op-log] popvar root is not array', op);
                    return state[op.key];
                }
                root.pop();
            } else {
                popAtPath(root, path);
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'incvar':
        case 'decvar': {
            if (segs.length === 0) return undefined;
            const delta = op.op === 'incvar' ? 1 : -1;
            const { root } = getOrInitRoot(state, op.key, firstSeg, op);
            const parentSegs = segs.slice(0, -1);
            const leafKey = segs[segs.length - 1]!;
            let node = root as Record<string, unknown>;
            for (const seg of parentSegs) {
                const next = node[seg];
                if (next === undefined || next === null || typeof next !== 'object') {
                    node[seg] = {};
                }
                node = node[seg] as Record<string, unknown>;
            }
            const current = node[leafKey];
            const numericCurrent = Number(current);
            if (current === undefined || current === null || current === '' || Number.isNaN(numericCurrent)) {
                if (current === undefined || current === null || current === '') {
                    node[leafKey] = delta;
                } else {
                    node[leafKey] = String(current) + String(delta);
                }
            } else {
                node[leafKey] = numericCurrent + delta;
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        default:
            return undefined;
    }
}

// ----- internals -----------------------------------------------------------

function getOrInitRoot(state: VarStore, key: string, firstSeg: string | undefined, op: VarOp): { root: Record<string, unknown> | unknown[]; exists: boolean } {
    const raw = state[key];
    const isPushPopNoPath = (op.op === 'pushvar' || op.op === 'popvar') && (!op.path || op.path.length === 0);
    const wantArrayShape = isPushPopNoPath || (firstSeg !== undefined && segIsArrayIndex(firstSeg));

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object') {
                return { root: parsed, exists: true };
            }
        } catch {
            // fall through
        }
    } else if (raw !== null && typeof raw === 'object') {
        return { root: raw as Record<string, unknown> | unknown[], exists: true };
    }

    return { root: wantArrayShape ? [] : {}, exists: false };
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function parsePathSegments(path: string): string[] {
    if (typeof path !== 'string' || path.length === 0) return [];
    const out: string[] = [];
    for (const seg of path.split('.')) {
        if (seg.length === 0) continue;
        if (FORBIDDEN_SEGMENTS.has(seg)) return [];
        out.push(seg);
    }
    return out;
}

function segIsArrayIndex(seg: string): boolean {
    return /^\d+$/.test(seg);
}

function navigateToParent(container: Record<string, unknown> | unknown[], path: string): { parent: Record<string, unknown> | unknown[]; lastSeg: string } | null {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return null;
    let node: Record<string, unknown> | unknown[] = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i]!;
        const next = segs[i + 1];
        const wantArray = segIsArrayIndex(next!);
        const child = (node as Record<string, unknown>)[seg];
        if (child === undefined || child === null) {
            (node as Record<string, unknown>)[seg] = wantArray ? [] : {};
        } else if (typeof child !== 'object') {
            return null;
        }
        node = (node as Record<string, unknown>)[seg] as Record<string, unknown> | unknown[];
    }
    return { parent: node, lastSeg: segs[segs.length - 1]! };
}

// ---------------------------------------------------------------------------
// macros/util/var-path.js resolveVarPath — 读侧,dotted 名称带字面 key 回退
// ---------------------------------------------------------------------------

export function resolveVarPath(getter: (name: string) => unknown, name: string): unknown {
    if (typeof name === 'string' && name.includes('.')) {
        const [head, ...rest] = name.split('.');
        const raw = getter(head!);
        try {
            const parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            let v = parsed;
            for (const k of rest) {
                if (v == null) {
                    v = undefined;
                    break;
                }
                v = (v as Record<string, unknown>)[k];
            }
            return v;
        } catch {
            // JSON.parse 失败(头是普通字符串)→ 落到字面 key 查找
        }
    }
    return getter(name);
}

// ---------------------------------------------------------------------------
// variables.js — get/set/add/inc/dec/push/pop/delete + exists
// store = chat_metadata.variables(local)或 extension_settings.variables.global(global)
// ---------------------------------------------------------------------------

/** getLocalVariable/getGlobalVariable — args.index 单键读取与 dotted 读侧语义照抄。 */
export function getVar(store: VarStore, name: string, args: { index?: number | string; key?: string } = {}): string | number {
    let variable: unknown;
    if (typeof name === 'string' && name.includes('.') && args.index === undefined && !args.key) {
        variable = resolveVarPath(
            (n) => Object.prototype.hasOwnProperty.call(store, n) ? store[n] : '',
            name,
        );
    } else {
        variable = store[args.key ?? name];
        if (args.index !== undefined) {
            try {
                variable = JSON.parse(variable as string);
                const numIndex = Number(args.index);
                if (Number.isNaN(numIndex)) {
                    variable = (variable as Record<string, unknown>)[args.index];
                } else {
                    variable = (variable as unknown[])[Number(args.index)];
                }
                if (typeof variable == 'object') {
                    variable = JSON.stringify(variable);
                }
            } catch {
                // that didn't work
            }
        }
    }

    return ((variable as string)?.trim?.() === '' || isNaN(Number(variable))) ? ((variable || '') as string | number) : Number(variable);
}

/** setLocalVariable — 带 dotted-path 写;saveMetadataDebounced 由调用方/引擎经 persist seam 做。 */
export function setVar(store: VarStore, name: string, value: unknown, args: { index?: number | string; key?: string; as?: string } = {}): unknown {
    if (!name) {
        throw new Error('Variable name cannot be empty or undefined.');
    }

    if (typeof name === 'string' && name.includes('.')) {
        const { root, path } = splitRootAndPath(name);
        applyPathOp(store, { op: 'setvar', key: root, path, value: String(value ?? '') });
        return value;
    }

    if (args.index !== undefined) {
        try {
            let variable: unknown = JSON.parse(String(store[name] ?? 'null'));
            const numIndex = Number(args.index);
            if (Number.isNaN(numIndex)) {
                if (variable === null) {
                    variable = {};
                }
                (variable as Record<string, unknown>)[args.index] = convertValueType(value, args.as);
            } else {
                if (variable === null) {
                    variable = [];
                }
                (variable as unknown[])[numIndex] = convertValueType(value, args.as);
            }
            store[name] = JSON.stringify(variable);
        } catch {
            // that didn't work
        }
    } else {
        // 原版写侧不看 args.key(读侧才用 args.key ?? name)——不对称怪癖,保留
        store[name] = value;
    }
    return value;
}

/** setGlobalVariable — 与 setVar 相同结构,但 Luker 中 global 没有 dotted-path 分支。 */
export function setGlobalVar(store: VarStore, name: string, value: unknown, args: { index?: number | string; as?: string } = {}): unknown {
    if (!name) {
        throw new Error('Variable name cannot be empty or undefined.');
    }

    if (args.index !== undefined) {
        try {
            let globalVariable: unknown = JSON.parse(String(store[name] ?? 'null'));
            const numIndex = Number(args.index);
            if (Number.isNaN(numIndex)) {
                if (globalVariable === null) {
                    globalVariable = {};
                }
                (globalVariable as Record<string, unknown>)[args.index] = convertValueType(value, args.as);
            } else {
                if (globalVariable === null) {
                    globalVariable = [];
                }
                (globalVariable as unknown[])[numIndex] = convertValueType(value, args.as);
            }
            store[name] = JSON.stringify(globalVariable);
        } catch {
            // that didn't work
        }
    } else {
        store[name] = value;
    }
    return value;
}

/** addLocalVariable/addGlobalVariable — 数组 push / 数字加 / 字符串拼接。 */
export function addVar(store: VarStore, name: string, value: unknown): unknown {
    const currentValue = getVar(store, name) || 0;
    try {
        const parsedValue = JSON.parse(String(currentValue));
        if (Array.isArray(parsedValue)) {
            parsedValue.push(value);
            setVar(store, name, JSON.stringify(parsedValue));
            return parsedValue;
        }
    } catch {
        // ignore non-array values
    }
    const increment = Number(value);

    if (isNaN(increment) || isNaN(Number(currentValue))) {
        const stringValue = String(currentValue || '') + String(value);
        setVar(store, name, stringValue);
        return stringValue;
    }

    const newValue = Number(currentValue) + increment;

    if (isNaN(newValue)) {
        return '';
    }

    setVar(store, name, newValue);
    return newValue;
}

export function incrementVar(store: VarStore, name: string): unknown {
    return addVar(store, name, 1);
}

export function decrementVar(store: VarStore, name: string): unknown {
    return addVar(store, name, -1);
}

/** pushLocalVariable — dotted 路径自动建数组;返回新的顶层值(JSON 串)。 */
export function pushVar(store: VarStore, name: string, value: unknown): unknown {
    if (!name) throw new Error('Variable name cannot be empty or undefined.');
    const { root, path } = splitRootAndPath(name);
    const op: VarOp = { op: 'pushvar', key: root, value: String(value ?? '') };
    if (path) op.path = path;
    return applyPathOp(store, op);
}

/** popLocalVariable — 弹出尾元素;返回新的顶层值(或 undefined)。 */
export function popVar(store: VarStore, name: string): unknown {
    if (!name) throw new Error('Variable name cannot be empty or undefined.');
    const { root, path } = splitRootAndPath(name);
    const op: VarOp = { op: 'popvar', key: root };
    if (path) op.path = path;
    return applyPathOp(store, op);
}

export function existsVar(store: VarStore | undefined, name: string): boolean {
    return !!store && store[name] !== undefined;
}

/** deleteLocalVariable — 含 dotted 分支;Luker 中局部版有,全局版没有。 */
export function deleteVar(store: VarStore, name: string): string {
    if (typeof name === 'string' && name.includes('.')) {
        const { root, path } = splitRootAndPath(name);
        if (!Object.prototype.hasOwnProperty.call(store ?? {}, root)) {
            console.warn(`The local variable "${name}" does not exist.`);
            return '';
        }
        applyPathOp(store, { op: 'deletevar', key: root, path });
        return '';
    }
    if (!existsVar(store, name)) {
        console.warn(`The local variable "${name}" does not exist.`);
        return '';
    }
    delete store[name];
    return '';
}

/** deleteGlobalVariable — 仅平面 key(Luker 中 global 无 dotted 分支)。 */
export function deleteGlobalVar(store: VarStore, name: string): string {
    if (!existsVar(store, name)) {
        console.warn(`The global variable "${name}" does not exist.`);
        return '';
    }
    delete store[name];
    return '';
}

// ---------------------------------------------------------------------------
// variables.js resolveVariable/parseBooleanOperands/evalBoolean/数字序列
// ---------------------------------------------------------------------------

/** resolveVariable — scope → local → global → 字面量。 */
export function resolveVariable(name: string, stores: VarStores, scope: SlashCommandScope | null = null): string | number {
    if (scope?.existsVariable(name)) {
        return scope.getVariable(name) as string;
    }
    if (existsVar(stores.local, name)) {
        return getVar(stores.local, name);
    }
    if (existsVar(stores.global, name)) {
        return getVar(stores.global, name);
    }
    return name;
}

export interface BooleanOperands {
    a: unknown;
    b: unknown;
    rule: string | undefined;
}

/** parseBooleanOperands — 操作数解析顺序:数字字面 → scope 变量 → local → global → 字符串字面。 */
export function parseBooleanOperands(args: NamedArguments, stores: VarStores): BooleanOperands {
    const getOperand = (operand: unknown): unknown => {
        if (operand === undefined) {
            return undefined;
        }
        if (operand === '') {
            return '';
        }

        // Number parses spaces as 0, and parseFloat is weird
        const operandNumber = typeof operand === 'string' && (operand as string).trim().length ? Number(operand) : NaN;

        if (!isNaN(operandNumber)) {
            return operandNumber;
        }

        // 原版把 operand 原样传入 exists/get(Record 下标自行 coercion),不强转 string
        if (args._scope.existsVariable(operand as string)) {
            const operandVariable = args._scope.getVariable(operand as string);
            return operandVariable ?? '';
        }

        if (existsVar(stores.local, operand as string)) {
            const operandLocalVariable = getVar(stores.local, operand as string);
            return operandLocalVariable ?? '';
        }

        if (existsVar(stores.global, operand as string)) {
            const operandGlobalVariable = getVar(stores.global, operand as string);
            return operandGlobalVariable ?? '';
        }

        const stringLiteral = String(operand);
        return stringLiteral || '';
    };

    const left = getOperand(args['a'] ?? args['left'] ?? args['first'] ?? args['x']);
    const right = getOperand(args['b'] ?? args['right'] ?? args['second'] ?? args['y']);
    const rule = args['rule'] as string | undefined;

    return { a: left, b: right, rule };
}

/** evalBoolean — 布尔比较规则评估,照抄。 */
export function evalBoolean(rule: string | undefined, a: unknown, b: unknown): boolean {
    if (a === undefined) {
        throw new Error('Left operand is not provided');
    }

    // If right-hand side was not provided, whe just check if the left side is truthy
    if (b === undefined) {
        switch (rule) {
            case undefined:
            case 'not': {
                const resultOnTruthy = rule !== 'not';
                if (isTrueBoolean(String(a))) return resultOnTruthy;
                if (isFalseBoolean(String(a))) return !resultOnTruthy;
                return a ? resultOnTruthy : !resultOnTruthy;
            }
            default:
                throw new Error(`Unknown boolean comparison rule for truthy check. If right operand is not provided, the rule must not provided or be 'not'. Provided: ${rule}`);
        }
    }

    // If no rule was provided, we are implicitly using 'eq', as defined for the slash commands
    rule ??= 'eq';

    if (typeof a === 'number' && typeof b === 'number') {
        // only do numeric comparison if both operands are numbers
        const aNumber = Number(a);
        const bNumber = Number(b);

        switch (rule) {
            case 'gt':
                return aNumber > bNumber;
            case 'gte':
                return aNumber >= bNumber;
            case 'lt':
                return aNumber < bNumber;
            case 'lte':
                return aNumber <= bNumber;
            case 'eq':
                return aNumber === bNumber;
            case 'neq':
                return aNumber !== bNumber;
            case 'in':
            case 'nin':
                // Fall through to string comparison. Otherwise you could not check if 12345 contains 45 for example.
                console.debug(`Boolean comparison rule '${rule}' is not supported for type number. Falling back to string comparison.`);
                break;
            default:
                throw new Error(`Unknown boolean comparison rule for type number. Accepted: gt, gte, lt, lte, eq, neq. Provided: ${rule}`);
        }
    }

    // otherwise do case-insensitive string comparsion, stringify non-strings
    const aString = (typeof a === 'string') ? a.toLowerCase() : JSON.stringify(a)!.toLowerCase();
    const bString = (typeof b === 'string') ? b.toLowerCase() : JSON.stringify(b)!.toLowerCase();

    switch (rule) {
        case 'in':
            return aString.includes(bString);
        case 'nin':
            return !aString.includes(bString);
        case 'eq':
            return aString === bString;
        case 'neq':
            return aString !== bString;
        default:
            throw new Error(`Unknown boolean comparison rule for type string. Accepted: in, nin, eq, neq. Provided: ${rule}`);
    }
}

/** parseNumericSeries — 空格分隔数字串 / 字符串数组 / 变量名解析为数字数组。 */
export function parseNumericSeries(value: unknown, stores: VarStores, scope: SlashCommandScope | null = null): number[] {
    if (typeof value === 'number') {
        return [value];
    }

    let values: unknown[] = Array.isArray(value) ? value : String(value).split(' ');

    // If an array of strings was provided as the only value, convert it to an array
    if (values.length === 1 && typeof values[0] === 'string') {
        const v0 = values[0] as string;
        if (v0.startsWith('[')) {
            // JSON-style array
            values = convertValueType(v0, 'array') as unknown[];
        } else {
            // Space-separated string
            values = v0.split(' ');
        }
    }

    const array = values.map(i => typeof i === 'string' ? (i as string).trim() : i)
        .filter(i => i !== '')
        .map(i => isNaN(Number(i)) ? Number(resolveVariable(String(i), stores, scope)) : Number(i))
        .filter(i => !isNaN(i));

    return array;
}

/** performOperation — 数字序列聚合回调的公共外壳,照抄。 */
export function performOperation(value: unknown, operation: (array: number[]) => number, stores: VarStores, singleOperand = false, scope: SlashCommandScope | null = null): string {
    function getResult(): number {
        if (!value) {
            return 0;
        }

        const array = parseNumericSeries(value, stores, scope);

        if (array.length === 0) {
            return 0;
        }

        const result = singleOperand ? operation([array[0]!]) : operation(array);

        if (isNaN(result)) {
            return 0;
        }

        return result;
    }

    const result = getResult();
    return String(result);
}
