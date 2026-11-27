/**
 * Ambience degrade trace (issue #60) — pins the "wallpaper vanished
 * silently" fix: a rejected settings hydrate must leave a console line
 * naming the failure, classified like CardAppFrame's authExpired flag
 * (401/403 → the shared auth-expired explanation; anything else → the
 * plain failure), while the wallpaper slot keeps its previous value —
 * hydrate failure never clears applied skin. The image-preload drop
 * (dead file / dead session 403ing /backgrounds/*) gets its own line.
 * 跑法:node --test apps/web/tests/ambience-degrade.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ambienceHydrateFailLog } from '../src/kernel/ambience.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');

/* api/client.ts uses TS parameter properties, which node --test cannot
   strip — the ApiError shape (Error + numeric status) is what the
   classifier reads, so this stand-in carries it. */
const apiError = (status, message = 'err') => Object.assign(new Error(message), { status });

test('401/403 rejections name the shared auth-expired explanation', () => {
    for (const status of [401, 403]) {
        const line = ambienceHydrateFailLog(apiError(status, 'Forbidden'));
        assert.match(line, /^\[ambience\] settings hydrate failed/);
        assert.match(line, new RegExp(`HTTP ${status}`));
        /* same explanation the shell auth-expired flow gives — not a
           bespoke "wallpaper broken" story. */
        assert.match(line, /session rejected|auth-expired/);
        assert.match(line, /kept at previous value/);
    }
});

test('non-auth HTTP failures stay a plain fetch class — no auth wording', () => {
    const line = ambienceHydrateFailLog(apiError(500, 'Internal'));
    assert.match(line, /HTTP 500/);
    assert.doesNotMatch(line, /auth-expired/);
});

test('network/typed errors without a status surface the error message', () => {
    assert.match(ambienceHydrateFailLog(new Error('socket hangup')), /socket hangup/);
    assert.doesNotMatch(ambienceHydrateFailLog(new Error('socket hangup')), /HTTP \d/);
    assert.match(ambienceHydrateFailLog('weird'), /weird/);
    assert.match(ambienceHydrateFailLog(undefined), /undefined/);
});

test('refreshConnection wires the trace into the rejected branch (not silent)', () => {
    /* The warn must fire on stRes rejection — before this fix the branch
       had no statement at all, which was the bug. */
    assert.match(app, /stRes\.status === 'rejected'\) console\.warn\(ambienceHydrateFailLog\(stRes\.reason\)\)/);
});

test('the wallpaper slot still keeps its old value — no clear-on-failure', () => {
    /* setStBg must remain inside the `if (st)` hydrate block only: a
       rejection path that wrote null would turn the trace into a
       user-visible skin wipe. */
    const setCalls = [...app.matchAll(/setStBg\(/g)].length;
    const guarded = [...app.matchAll(/if \(st\) \{[\s\S]*?setStBg\(/g)].length;
    assert.ok(setCalls >= 1 && guarded >= 1, 'setStBg should be called under the st guard');
    assert.doesNotMatch(app, /rejected[\s\S]{0,200}setStBg\(null\)/);
});

test('image preload failure (dead file / dead-session 403) is logged too', () => {
    assert.match(app, /img\.onerror[\s\S]*?\[ambience\] wallpaper image failed to load/);
});
