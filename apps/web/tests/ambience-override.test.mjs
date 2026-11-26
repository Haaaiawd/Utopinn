/**
 * Ambience override state machine — pins the explicit-flag model behind
 * the "slider looks dead" fix: an OVERRIDDEN param writes its CSS var
 * inline (even AT the stylesheet default), while FOLLOW-CSS/unset hands
 * the var to the cascade so tokens.css / power_user.custom_css decide.
 * Covers the PR #62 review repro (custom_css 0.45 + slider dragged onto
 * the 0.62 default must render 0.62), persistence across refresh, and
 * pre-flag document degradation.
 * 跑法:node --test apps/web/tests/ambience-override.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    UI_AMBIENCE_DEFAULTS, ambienceInlineVars, ambiencePinned,
    hydrateUiAmbience, pinAmbience, uiAmbienceSlot, unpinAmbience,
} from '../src/kernel/ambience.ts';

const D = UI_AMBIENCE_DEFAULTS; // { bgAlpha: 0.62, glassBlur: 14 }
const NO_INLINE = { '--amb-bg-alpha': null, '--amb-glass-blur': null };

test('review repro — override AT the stylesheet default still pins inline', () => {
    /* custom_css :root { --amb-bg-alpha: 0.45 }; slider dragged onto the
       0.62 default → the inline pin must be written, else the cascade
       falls back to 0.45 and the slider looks dead. */
    const a = pinAmbience({ ...D }, 'bgAlpha', D.bgAlpha);
    assert.equal(ambienceInlineVars(a)['--amb-bg-alpha'], String(D.bgAlpha));
    /* the untouched param stays cascade-owned. */
    assert.equal(ambienceInlineVars(a)['--amb-glass-blur'], null);
});

test('unset / follow-CSS writes nothing inline — custom_css owns the var', () => {
    assert.deepEqual(ambienceInlineVars({ ...D }), NO_INLINE);
    /* persisted value present but flag absent (never explicitly pinned):
       kept as slider position, not applied. */
    const a = hydrateUiAmbience({ bg_alpha: 0.45, glass_blur: 8 });
    assert.equal(a.bgAlpha, 0.45);
    assert.deepEqual(ambienceInlineVars(a), NO_INLINE);
});

test('pre-flag documents degrade to unset without errors', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}]) {
        const a = hydrateUiAmbience(raw);
        assert.equal(a.bgAlpha, D.bgAlpha);
        assert.equal(a.glassBlur, D.glassBlur);
        assert.equal(a.bgAlphaOverride, false);
        assert.equal(a.glassBlurOverride, false);
        assert.deepEqual(ambienceInlineVars(a), NO_INLINE);
    }
});

test('slot roundtrip preserves values and flags across a refresh', () => {
    let a = pinAmbience({ ...D }, 'bgAlpha', 0.7);
    a = pinAmbience(a, 'glassBlur', 20);
    a = unpinAmbience(a, 'bgAlpha');
    const slot = uiAmbienceSlot(a);
    /* the whole slot is rewritten per PATCH — flags ride along explicitly. */
    assert.deepEqual(slot, {
        bg_alpha: 0.7, glass_blur: 20,
        bg_alpha_override: false, glass_blur_override: true,
    });
    const rehyd = hydrateUiAmbience(slot);
    assert.equal(rehyd.glassBlurOverride, true);
    assert.equal(rehyd.bgAlphaOverride, false);
    assert.deepEqual(ambienceInlineVars(rehyd), {
        '--amb-bg-alpha': null, '--amb-glass-blur': '20px',
    });
});

test('unpin is the exit back to follow-CSS; last value stays as slider position', () => {
    let a = pinAmbience({ ...D }, 'glassBlur', 22);
    assert.equal(ambiencePinned(a, 'glassBlur'), true);
    a = unpinAmbience(a, 'glassBlur');
    assert.equal(ambiencePinned(a, 'glassBlur'), false);
    assert.equal(a.glassBlur, 22);
    assert.deepEqual(ambienceInlineVars(a), NO_INLINE);
});

test('hydrate clamps ranges, ignores non-boolean flags, reads camelCase legacy', () => {
    const a = hydrateUiAmbience({
        bg_alpha: 9, glass_blur: -3,
        bg_alpha_override: 'yes', glass_blur_override: 1,
    });
    assert.equal(a.bgAlpha, 0.9);
    assert.equal(a.glassBlur, 0);
    /* flags coerce via === true only — junk never becomes an override. */
    assert.equal(a.bgAlphaOverride, false);
    assert.equal(a.glassBlurOverride, false);
    const legacy = hydrateUiAmbience({ bgAlpha: 0.4, glassBlur: 18, glassBlurOverride: true });
    assert.equal(legacy.bgAlpha, 0.4);
    assert.equal(legacy.glassBlur, 18);
    assert.equal(legacy.glassBlurOverride, true);
});
