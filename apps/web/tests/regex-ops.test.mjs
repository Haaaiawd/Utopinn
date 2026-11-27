/**
 * api/regex-model.ts content-addressed ops + lib/floorFreshness.ts — the
 * index-addressing bug family (review 🔴4/🔴5) pinned down:
 *
 *   - PATCH/DELETE :id falls back to array INDEX for id-less scripts
 *     server-side — the content transforms locate by deep-equal inside
 *     mutateRegexScope's serial GET→fn→PUT chain (the IO wrappers live
 *     in api/regex.ts; the pure transforms are tested here).
 *   - floorsStaleNow is the transcript's index-addressed-write gate.
 *
 * Run: node --test apps/web/tests/regex-ops.test.mjs
 * (tested .ts rides Node>=22.6 type-stripping; pure logic, zero network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    regexDeepEqual, regexFindByContent, RegexScriptMovedError,
    regexPatchByContent, regexRemoveByContent,
} from '../src/api/regex-model.ts';
import { floorsStaleNow } from '../src/lib/floorFreshness.ts';

test('regexRemoveByContent removes the content match — never the rendered index (🔴4)', () => {
    /* Render-time list was [A, B] with id-less B at index 1; another
       surface inserted X before the op landed — a bare index would now
       hit X. The content transform removes exactly B wherever it sits. */
    const a = { id: 'a', scriptName: 'A' };
    const b = { scriptName: 'B', findRegex: '/b/' }; // id-less — the bug shape
    const inserted = { id: 'x', scriptName: 'X' };
    const fresh = [a, inserted, b];
    const out = regexRemoveByContent(fresh, b);
    assert.deepEqual(out.map((s) => s.scriptName), ['A', 'X'],
        'B removed by content — the shifted index was never sent');
    assert.equal(fresh.length, 3, 'input array not mutated (immutable transform)');
});

test('regexPatchByContent locates the same script on the fresh array', () => {
    const b = { scriptName: 'B', findRegex: '/b/' };
    const fresh = [{ scriptName: 'n0' }, { id: 'a' }, b];
    const out = regexPatchByContent(fresh, b, { disabled: true });
    assert.equal(out[2].disabled, true);
    assert.equal(out[2].scriptName, 'B');
    assert.equal(out[0].disabled, undefined, 'neighbour untouched');
    assert.equal(out[1].disabled, undefined);
});

test('content transforms raise RegexScriptMovedError when the captured script is gone', () => {
    const fresh = [{ id: 'a' }];
    assert.throws(() => regexRemoveByContent(fresh, { scriptName: 'ghost' }), RegexScriptMovedError);
    assert.throws(
        () => regexPatchByContent(fresh, { scriptName: 'ghost' }, { disabled: true }),
        RegexScriptMovedError,
    );
    /* Callers catch this and reload the view — nothing was written. */
});

test('regexFindByContent — first match wins; identical twins are interchangeable', () => {
    const twin = { scriptName: 'dup', findRegex: '/d/' };
    const arr = [{ ...twin }, { ...twin }, { scriptName: 'other' }];
    assert.equal(regexFindByContent(arr, twin), 0);
    assert.equal(regexFindByContent(arr, { scriptName: 'absent' }), -1);
});

test('regexDeepEqual — structural equality behind content addressing', () => {
    assert.equal(regexDeepEqual({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 }), true, 'key order free');
    assert.equal(regexDeepEqual({ a: 1 }, { a: 1, b: 2 }), false, 'key count differs');
    assert.equal(regexDeepEqual([1, 2], { 0: 1, 1: 2 }), false, 'array vs object');
    assert.equal(regexDeepEqual(null, {}), false);
    assert.equal(regexDeepEqual('s', 's'), true, 'primitives by ===');
});

test('floorsStaleNow — the transcript index-addressed write gate (🔴5)', () => {
    /* Transcript ops address floors by position (/body/<m.id>); firing
       them on a pre-mutation list hits a different floor. */
    assert.equal(floorsStaleNow(0, 5, 5), false, 'fetched under current revision, no run in flight');
    assert.equal(floorsStaleNow(1, 5, 5), true, 'script run in flight — /cut may already have shifted indexes');
    assert.equal(floorsStaleNow(0, 4, 5), true, 'mutation bump landed after the fetch committed');
    assert.equal(floorsStaleNow(2, 3, 9), true, 'in-flight + unconsumed bumps — still stale');
    assert.equal(floorsStaleNow(0, 5, 4), true, 'revision only moves forward — any divergence is stale');
});
