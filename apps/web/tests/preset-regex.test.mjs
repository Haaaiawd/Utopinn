/**
 * presetRegex.ts 纯件单测 —— 预设档 extensions.regex_scripts 读写语义钉死:
 * 读面过滤畸形条目、写面 extensions/顶键其余键透传不丢、启停/删除/补丁/新增
 * 全走同一条 doc 变换(与调参同一写路,无第二通道)。
 * 跑法:node --test apps/web/tests/preset-regex.test.mjs
 * (被测 .ts 走 Node>=22.6 type-stripping;纯逻辑零网络)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    addPresetRegex, findPresetRegexIndex, newPresetRegexScript, patchPresetRegex,
    patchPresetRegexByKey, presetExtBag, presetRegexKeyOf, presetRegexScripts,
    removePresetRegex, removePresetRegexByKey, togglePresetRegex, togglePresetRegexByKey,
    withPresetRegexScripts,
} from '../src/components/panels/presetRegex.ts';

const docWith = (scripts, extra = {}) => ({
    temperature: 0.9,
    custom_key: 'keep-me',
    ...extra,
    extensions: { depth_prompt: { role: 'system' }, ...(extra.extensions ?? {}), regex_scripts: scripts },
});

test('presetRegexScripts — 读面:非数组/缺 extensions → [];畸形条目不渲', () => {
    assert.deepEqual(presetRegexScripts({}), []);
    assert.deepEqual(presetRegexScripts({ extensions: 'nope' }), []);
    assert.deepEqual(presetRegexScripts({ extensions: { regex_scripts: 'nope' } }), []);
    const docs = docWith([
        { id: 'a', scriptName: 'A' },
        'garbage',
        null,
        [1, 2],
        { scriptName: 'B' },
    ]);
    assert.deepEqual(presetRegexScripts(docs).map((s) => s.scriptName), ['A', 'B']);
});

test('presetExtBag — extensions 非对象/数组 → 空袋', () => {
    assert.deepEqual(presetExtBag({}), {});
    assert.deepEqual(presetExtBag({ extensions: [] }), {});
    assert.deepEqual(presetExtBag({ extensions: 'x' }), {});
    assert.deepEqual(presetExtBag({ extensions: { a: 1 } }), { a: 1 });
});

test('withPresetRegexScripts — extensions 其余键 + doc 顶键原样透传', () => {
    const d = docWith([{ id: 'a' }]);
    const next = withPresetRegexScripts(d, (arr) => [...arr, { id: 'b' }]);
    assert.equal(next.temperature, 0.9);
    assert.equal(next.custom_key, 'keep-me');
    assert.deepEqual(next.extensions.depth_prompt, { role: 'system' });
    assert.deepEqual(next.extensions.regex_scripts.map((s) => s.id), ['a', 'b']);
    /* 原档不被原地改 */
    assert.equal(d.extensions.regex_scripts.length, 1);
});

test('togglePresetRegex — disabled===true→false;缺省/false→true;只动目标位', () => {
    const d = docWith([{ id: 'a', disabled: true }, { id: 'b' }, { id: 'c', disabled: false }]);
    const off = togglePresetRegex(d, 0);
    assert.equal(presetRegexScripts(off)[0].disabled, false);
    const on = togglePresetRegex(d, 1);
    assert.equal(presetRegexScripts(on)[1].disabled, true, '缺省视为启用 → 翻成 disabled');
    const on2 = togglePresetRegex(d, 2);
    assert.equal(presetRegexScripts(on2)[2].disabled, true);
    assert.equal(presetRegexScripts(on2)[0].disabled, true, '他位不动');
});

test('removePresetRegex — 按下标删,余序不变', () => {
    const d = docWith([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const next = removePresetRegex(d, 1);
    assert.deepEqual(presetRegexScripts(next).map((s) => s.id), ['a', 'c']);
});

test('patchPresetRegex — 字段合并,未列字段(placement 等)保活', () => {
    const d = docWith([{ id: 'a', findRegex: '/x/g', placement: [2], minDepth: 1 }]);
    const next = patchPresetRegex(d, 0, { scriptName: 'N', replaceString: 'R' });
    const sc = presetRegexScripts(next)[0];
    assert.equal(sc.scriptName, 'N');
    assert.equal(sc.replaceString, 'R');
    assert.equal(sc.findRegex, '/x/g', '未补丁字段不丢');
    assert.deepEqual(sc.placement, [2]);
    assert.equal(sc.minDepth, 1);
});

test('newPresetRegexScript — 与 studio RegexPage 全局新增同基线', () => {
    const sc = newPresetRegexScript('rx-test');
    assert.equal(sc.id, 'rx-test');
    assert.equal(sc.scriptName, '');
    assert.equal(sc.findRegex, '');
    assert.equal(sc.replaceString, '');
    assert.deepEqual(sc.placement, [2], 'placement:[2] = AI 输出车道');
    assert.equal(sc.disabled, false);
    assert.equal(sc.markdownOnly, true);
    assert.equal(sc.promptOnly, false);
    assert.equal(sc.runOnEdit, true);
});

test('addPresetRegex — 追加尾位,先写后进生成链可放行', () => {
    const d = docWith([{ id: 'a' }]);
    const next = addPresetRegex(d, newPresetRegexScript('rx-1'));
    assert.deepEqual(presetRegexScripts(next).map((s) => s.id), ['a', 'rx-1']);
    /* 空档起步:extensions 缺省也能落成 {regex_scripts:[…]} */
    const fromEmpty = addPresetRegex({}, newPresetRegexScript('rx-0'));
    assert.equal(presetRegexScripts(fromEmpty).length, 1);
});

/* ---------- Stable (non-index) addressing — the wrong-target class ---------- */

test('key ops — delete/toggle by id survives list reorder (the reported bug)', () => {
    /* Reported failure: right rail deletes A; studio's stale list still
       shows [A,B]; the write lands on fresh doc [B] — index 0 deleted B.
       Key addressing makes the captured target follow the script, not
       the slot: deleting A on a doc that no longer has A is a no-op. */
    const a = { id: 'a', scriptName: 'A', findRegex: '/a/' };
    const bSc = { id: 'b', scriptName: 'B', findRegex: '/b/' };
    const rendered = docWith([a, bSc]);
    const keyA = presetRegexKeyOf(presetRegexScripts(rendered)[0]);
    const current = docWith([bSc]); // A already gone on the server
    const after = removePresetRegexByKey(current, keyA);
    assert.equal(presetRegexScripts(after).length, 1, 'stale key → no-op, B preserved');
    assert.equal(presetRegexScripts(after)[0].id, 'b');

    /* Reorder between capture and apply — the key still hits A. */
    const reordered = docWith([bSc, a]);
    const del = removePresetRegexByKey(reordered, keyA);
    assert.deepEqual(presetRegexScripts(del).map((s) => s.id), ['b']);

    /* Toggle by id through the same reorder. */
    const tog = togglePresetRegexByKey(reordered, keyA);
    assert.equal(presetRegexScripts(tog)[1].disabled, true);
    assert.equal(presetRegexScripts(tog)[0].disabled, undefined, 'only the keyed entry flips');
});

test('findPresetRegexIndex — id first, deep-equal ref, `at` last resort', () => {
    const a = { scriptName: 'A', findRegex: '/a/' };
    const bSc = { scriptName: 'B', findRegex: '/b/' };
    const d = docWith([a, bSc]);
    assert.equal(findPresetRegexIndex(d, { ref: bSc }), 1);
    assert.equal(findPresetRegexIndex(d, { ref: { scriptName: 'Z' } }), -1);
    assert.equal(findPresetRegexIndex(d, { ref: { scriptName: 'Z' }, at: 1 }), 1, 'at fills the ref-miss');
    assert.equal(findPresetRegexIndex(d, { at: 9 }), -1, 'out-of-range at → -1');
    assert.equal(findPresetRegexIndex(d, { id: 'none' }), -1);
});

test('patchPresetRegexByKey — ref fallback mints an id so later edits stay keyed', () => {
    const legacy = { scriptName: 'old', findRegex: '/x/' };
    const d = docWith([legacy]);
    const next = patchPresetRegexByKey(d, presetRegexKeyOf(legacy), { scriptName: 'new' }, () => 'rx-minted');
    const sc = presetRegexScripts(next)[0];
    assert.equal(sc.scriptName, 'new');
    assert.equal(sc.id, 'rx-minted', 'id-less script gains a stable id on first patch');
    /* Subsequent writes address the minted id — ref staleness no longer matters. */
    const again = patchPresetRegexByKey(next, { id: 'rx-minted' }, { findRegex: '/y/' });
    assert.equal(presetRegexScripts(again)[0].findRegex, '/y/');
});

test('patchPresetRegexByKey — rapid typing race: stale ref still lands via `at`', () => {
    /* Keystroke 1 patched the ref'd script (id minted + name changed);
       keystroke 2 arrives with the PRE-patch closure — ref no longer
       deep-equals, `at` resolves the same slot. */
    const legacy = { scriptName: '', findRegex: '/x/' };
    const d = docWith([legacy]);
    const after1 = patchPresetRegexByKey(d, { ref: legacy, at: 0 }, { scriptName: 'a' }, () => 'rx-1');
    const after2 = patchPresetRegexByKey(after1, { ref: legacy, at: 0 }, { scriptName: 'ab' }, () => 'rx-2');
    const sc = presetRegexScripts(after2)[0];
    assert.equal(sc.scriptName, 'ab', 'second keystroke landed, not dropped');
    assert.equal(sc.id, 'rx-1', 'minted id persists — subsequent writes stay id-keyed');
});
