/**
 * Ambience surface-alpha contract — pins the two-tier split in tokens.css:
 * underlay/content surfaces keep the wallpaper "window" values while
 * interactive/overlay surfaces (chrome/sidebar/workbench) stay opaque
 * enough that text and wallpaper detail behind them stop being legible.
 * Also guards the JS↔CSS default sync that the override-flag-gated inline
 * write in App.tsx depends on, and the ≤520px bump that mobile bleed
 * requires. The override state machine itself is pinned in
 * ambience-override.test.mjs.
 * 跑法:node --test apps/web/tests/ambience-tokens.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const tokens = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8');
const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
const ambience = readFileSync(join(SRC, 'kernel', 'ambience.ts'), 'utf8');

/** Extract `rgba(r, g, b, A)` alpha for `--name` inside `block` text. */
const alphaOf = (block, name) => {
    const m = new RegExp(`${name}:\\s*rgba\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)\\)`).exec(block);
    return m ? Number(m[1]) : null;
};
/** Extract the raw declaration value for `--name` inside `block` text. */
const declOf = (block, name) => {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
    return m ? m[1].trim() : null;
};
const themeBlock = (theme) => {
    const m = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(tokens);
    assert.ok(m, `[data-theme="${theme}"] block not found`);
    return m[1];
};
const mediaBlock = (() => {
    const m = /@media \(max-width: 520px\)\s*\{([\s\S]*)\}\s*$/.exec(tokens);
    assert.ok(m, 'max-width:520px media block not found');
    return m[1];
})();
const mediaTheme = (theme) => {
    const m = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(mediaBlock);
    assert.ok(m, `media block missing [data-theme="${theme}"]`);
    return m[1];
};

test('dark theme — overlay tier ≥0.80, underlay/content tiers keep the window values', () => {
    const d = themeBlock('dark');
    /* upstream-measured window values must not move (see tokens.css comment). */
    assert.equal(alphaOf(d, '--canvas-bg'), 0.45);
    assert.equal(alphaOf(d, '--surface-1'), 0.50);
    /* tray stays the full-viewport underlay (wallpaper window). */
    assert.equal(declOf(d, '--bg-tray'), 'var(--canvas-bg)');
    assert.equal(declOf(d, '--bg-canvas'), 'var(--surface-1)');
    /* interactive/overlay tier — 0.45 let behind-text ghost through legibly. */
    for (const t of ['--bg-chrome', '--bg-sidebar', '--bg-workbench']) {
        const a = alphaOf(d, t);
        assert.ok(a !== null && a >= 0.8, `${t}=${a} below overlay floor 0.80`);
    }
});

test('light theme — overlay tier ≥0.86, underlay/content tiers unchanged', () => {
    const l = themeBlock('light');
    assert.equal(alphaOf(l, '--bg-tray'), 0.58);
    assert.equal(alphaOf(l, '--bg-canvas'), 0.62);
    for (const t of ['--bg-chrome', '--bg-sidebar', '--bg-workbench']) {
        const a = alphaOf(l, t);
        assert.ok(a !== null && a >= 0.85, `${t}=${a} below overlay floor 0.85`);
    }
});

test('≤520px media — every surface steps up, wallpaper anchor lifts', () => {
    assert.match(mediaBlock, /--amb-wall-pos:\s*center 25%/);
    const d = mediaTheme('dark');
    for (const t of ['--bg-chrome', '--bg-sidebar', '--bg-workbench']) {
        const a = alphaOf(d, t);
        assert.ok(a !== null && a >= 0.85, `mobile dark ${t}=${a}`);
    }
    assert.ok(alphaOf(d, '--bg-canvas') > 0.50, 'mobile dark --bg-canvas must beat the 0.50 default');
    const l = mediaTheme('light');
    for (const t of ['--bg-chrome', '--bg-sidebar', '--bg-workbench']) {
        const a = alphaOf(l, t);
        assert.ok(a !== null && a >= 0.9, `mobile light ${t}=${a}`);
    }
    assert.ok(alphaOf(l, '--bg-canvas') > 0.62, 'mobile light --bg-canvas must beat the 0.62 default');
});

test('ambience defaults stay in sync with tokens.css :root', () => {
    const rootM = /:root\s*\{([\s\S]*?)\n\}/.exec(tokens);
    assert.ok(rootM, ':root block not found');
    const root = rootM[1];
    const m = /UI_AMBIENCE_DEFAULTS:\s*UiAmbience\s*=\s*\{\s*bgAlpha:\s*([\d.]+),\s*glassBlur:\s*(\d+)\s*\}/.exec(ambience);
    assert.ok(m, 'UI_AMBIENCE_DEFAULTS not found in kernel/ambience.ts');
    const cssAlpha = Number(/(--amb-bg-alpha:\s*([\d.]+))/.exec(root)[2]);
    const cssBlur = Number(/(--amb-glass-blur:\s*([\d.]+)px)/.exec(root)[2]);
    assert.equal(Number(m[1]), cssAlpha, 'bgAlpha default drifted from --amb-bg-alpha');
    assert.equal(Number(m[2]), cssBlur, 'glassBlur default drifted from --amb-glass-blur');
    /* the inline write must be gated on the override flag, not the value —
       unconditionally writing (or value-equality gating) either pins
       custom_css dead or hands it a still-warm default (the "slider looks
       dead" bug). */
    assert.match(app, /ambienceInlineVars\(uiAmbience\)/);
    assert.match(app, /removeProperty\(/);
    assert.match(ambience, /bgAlphaOverride === true \? String\(a\.bgAlpha\) : null/);
    assert.match(ambience, /glassBlurOverride === true \? `\$\{a\.glassBlur\}px` : null/);
    /* persisted slot carries the flags (snake_case) so state survives refresh. */
    assert.match(ambience, /bg_alpha_override/);
    assert.match(ambience, /glass_blur_override/);
});

test('app shell paints the underlay token (--bg-tray), not the overlay tier', () => {
    /* The root div covers the whole viewport above AmbientBackdrop: giving it
       an overlay-tier token would smother the wallpaper window everywhere. */
    assert.match(app, /bg-\[color:var\(--bg-tray\)\]/);
    assert.doesNotMatch(app, /bg-\[color:var\(--bg-chrome\)\]/);
});
