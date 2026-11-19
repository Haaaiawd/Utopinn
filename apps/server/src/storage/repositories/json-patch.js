import _ from 'lodash';

import { ConflictError, PatchTestFailedError, PatchMissingParentError, UnsupportedPatchOpError, UnsafePatchPathError } from '../errors.js';

export function applyJsonPatch(doc, ops) {
    const result = _.cloneDeep(doc);
    for (const op of ops) {
        const segs = op.path.split('/').slice(1).map(decode);
        assertSafePath(result, segs, op.path);
        if (op.op === 'test') {
            // 不存在的位置即失败(不能拿 undefined 跟缺省 value 对成 true)
            if (!hasAt(result, segs) || !_.isEqual(getAt(result, segs), op.value)) {
                throw new PatchTestFailedError(op.path);
            }
            continue;
        }
        if (op.op === 'replace') { setAt(result, segs, op.value, op.path); continue; }
        if (op.op === 'add')     { addAt(result, segs, op.value, op.path); continue; }
        if (op.op === 'remove')  { removeAt(result, segs, op.path); continue; }
        throw new UnsupportedPatchOpError(op.op);
    }
    return result;
}

function decode(s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); }
function assertSafePath(doc, segs, path) {
    let current = doc;
    for (const segment of segs) {
        if (segment === '__proto__') {
            throw new UnsafePatchPathError(path);
        }
        if ((segment === 'constructor' || segment === 'prototype')
            && (current === null || typeof current !== 'object'
                || !Object.prototype.hasOwnProperty.call(current, segment))) {
            throw new UnsafePatchPathError(path);
        }
        if (current === null || typeof current !== 'object') {
            return;
        }
        current = current[segment];
    }
}
function getAt(o, segs) { return segs.reduce((c, s) => (c == null ? c : c[s]), o); }
function hasAt(o, segs) {
    let c = o;
    for (const s of segs) {
        if (c === null || typeof c !== 'object' || !(s in c)) return false;
        c = c[s];
    }
    return true;
}
/** 数组下标校验:add 允许 0..len('-' 尾),replace/remove 只允许 0..len-1。 */
function checkIndex(p, k, path, allowAppend) {
    if (k === '-' && allowAppend) return p.length;
    const i = Number(k);
    const ok = Number.isInteger(i) && i >= 0 && (allowAppend ? i <= p.length : i < p.length);
    if (!ok) throw new ConflictError('patch_index_out_of_bounds', { path });
    return i;
}
/** 严格父解析:任何中间段缺失/非对象 → PatchMissingParentError(不自增生)。 */
function strictParent(o, segs, op, path) {
    let c = o;
    for (let i = 0; i < segs.length - 1; i++) {
        if (c === null || typeof c !== 'object') throw new PatchMissingParentError(op, path);
        c = c[segs[i]];
    }
    if (c === null || typeof c !== 'object') throw new PatchMissingParentError(op, path);
    return c;
}
function setAt(o, segs, v, path) {
    const p = strictParent(o, segs, 'replace', path);
    const k = segs[segs.length - 1];
    if (Array.isArray(p)) p[checkIndex(p, k, path, false)] = v; else p[k] = v;
}
function addAt(o, segs, v, path) {
    const p = strictParent(o, segs, 'add', path);
    const k = segs[segs.length - 1];
    if (Array.isArray(p)) p.splice(checkIndex(p, k, path, true), 0, v); else p[k] = v;
}
function removeAt(o, segs, path) {
    const p = strictParent(o, segs, 'remove', path);
    const k = segs[segs.length - 1];
    if (Array.isArray(p)) p.splice(checkIndex(p, k, path, false), 1); else delete p[k];
}
