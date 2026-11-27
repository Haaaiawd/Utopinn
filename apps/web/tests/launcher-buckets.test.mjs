/**
 * launcherBuckets pure-fn unit tests — pins the right-rail launcher's
 * bucket contract:
 *   - 'pinned' contribs land in pinnedItems in registration order and are
 *     NOT usage-freq re-sorted (the recommendation is editorial);
 *   - 'cardapp' items only appear when the current card declares a
 *     card_app manifest (hasCardApp);
 *   - 'system' keeps its freq sort (record → score, none → -1 sinks);
 *   - 'hidden' never enters any bucket;
 *   - the search predicate applies to every bucket.
 * 跑法:node --test apps/web/tests/launcher-buckets.test.mjs
 * (被测 .ts 走 Node>=22.6 type-stripping;纯逻辑零依赖)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketLauncherPanels } from '../src/components/shell/launcherBuckets.ts';

const Stub = () => null;
const contrib = (type, category, extra = {}) => ({
    type, icon: 'puzzle', wired: true, Body: Stub, category, ...extra,
});
const matchAll = () => true;

test('pinned bucket — collects category:pinned, keeps registration order', () => {
    const contribs = [
        contrib('mvu', 'system'),
        contrib('izumi', 'pinned'),
        contrib('lore', 'system'),
        contrib('preset', 'pinned'),
    ];
    const { pinnedItems } = bucketLauncherPanels(contribs, { hasCardApp: false, match: matchAll });
    assert.deepEqual(pinnedItems.map((c) => c.type), ['izumi', 'preset']);
});

test('pinned bucket — excluded from the system bucket and from freq sorting', () => {
    const now = Date.now();
    const freqMap = {
        // preset was used heavily; izumi never. If pinned were freq-sorted
        // the order would flip — it must not.
        preset: { count: 9, lastAt: now },
        lore: { count: 3, lastAt: now },
    };
    const contribs = [
        contrib('izumi', 'pinned'),
        contrib('mvu', 'system'),
        contrib('preset', 'pinned'),
        contrib('lore', 'system'),
    ];
    const { pinnedItems, sysItems } = bucketLauncherPanels(contribs, { hasCardApp: false, match: matchAll, freqMap });
    assert.deepEqual(pinnedItems.map((c) => c.type), ['izumi', 'preset']);
    assert.deepEqual(sysItems.map((c) => c.type), ['lore', 'mvu'], 'system bucket: used panels first, unused sink');
});

test('cardapp bucket — gated by the current card manifest, not by pinned', () => {
    const contribs = [
        contrib('cardapp', 'cardapp'),
        contrib('izumi', 'pinned'),
        contrib('mvu', 'system'),
    ];
    const without = bucketLauncherPanels(contribs, { hasCardApp: false, match: matchAll });
    assert.deepEqual(without.cardItems, []);
    assert.deepEqual(without.pinnedItems.map((c) => c.type), ['izumi'], 'pinned shows even with no CardApp on the card');
    const withApp = bucketLauncherPanels(contribs, { hasCardApp: true, match: matchAll });
    assert.deepEqual(withApp.cardItems.map((c) => c.type), ['cardapp']);
});

test('hidden + suggested + unspecified categories', () => {
    const contribs = [
        contrib('messageframe', 'hidden'),
        contrib('ext-panel', 'suggested'),
        contrib('legacy', undefined),
        contrib('izumi', 'pinned'),
    ];
    const { cardItems, pinnedItems, sysItems, suggested } =
        bucketLauncherPanels(contribs, { hasCardApp: true, match: matchAll });
    assert.deepEqual(cardItems, []);
    assert.deepEqual(pinnedItems.map((c) => c.type), ['izumi']);
    assert.deepEqual(sysItems.map((c) => c.type), ['legacy'], 'category missing → treated as system');
    assert.deepEqual(suggested.map((c) => c.type), ['ext-panel']);
    for (const bucket of [cardItems, pinnedItems, sysItems, suggested]) {
        assert.ok(!bucket.some((c) => c.type === 'messageframe'), 'hidden never listed');
    }
});

test('search predicate filters every bucket uniformly', () => {
    const contribs = [
        contrib('cardapp', 'cardapp'),
        contrib('izumi', 'pinned'),
        contrib('preset', 'pinned'),
        contrib('mvu', 'system'),
    ];
    const onlyPreset = (c) => c.type === 'preset';
    const { cardItems, pinnedItems, sysItems } =
        bucketLauncherPanels(contribs, { hasCardApp: true, match: onlyPreset });
    assert.deepEqual(cardItems, []);
    assert.deepEqual(pinnedItems.map((c) => c.type), ['preset']);
    assert.deepEqual(sysItems, []);
});
