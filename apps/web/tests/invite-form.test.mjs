/**
 * inviteForm.ts pure-model unit tests — pins the client-side create contract
 * against the server rule (invites.js normalizeMaxUses): blank/'0' is the
 * only path to "unlimited"; negatives, fractions and non-numbers are blocked
 * instead of silently minting an unrestricted code.
 *
 * Run: node --test apps/web/tests/invite-form.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInviteCreateInput } from '../src/lib/inviteForm.ts';

const NOW = 1_700_000_000_000;
const DAY = 86400000;

test('blank and "0" maxUses → 0 (unlimited)', () => {
    assert.deepEqual(parseInviteCreateInput('', ''), { ok: true, maxUses: 0, expiresAt: null });
    assert.deepEqual(parseInviteCreateInput(' 0 ', ' '), { ok: true, maxUses: 0, expiresAt: null });
});

test('positive integer maxUses passes through untouched', () => {
    const r = parseInviteCreateInput('5', '');
    assert.deepEqual(r, { ok: true, maxUses: 5, expiresAt: null });
    assert.deepEqual(parseInviteCreateInput('5.0', ''), { ok: true, maxUses: 5, expiresAt: null });
});

test('fractional / negative / non-numeric maxUses are blocked, never clamped to unlimited', () => {
    for (const bad of ['0.5', '0.01', '-1', '-3', '2.5', 'abc']) {
        const r = parseInviteCreateInput(bad, '');
        assert.equal(r.ok, false, `input ${bad} must be rejected`);
        if (!r.ok) assert.equal(r.badMaxUses, true);
    }
});

test('blank/"0" days → null (never expires); positive days → now + d*86400e3; fractional days allowed', () => {
    assert.deepEqual(parseInviteCreateInput('', '', NOW), { ok: true, maxUses: 0, expiresAt: null });
    assert.deepEqual(parseInviteCreateInput('', '0', NOW), { ok: true, maxUses: 0, expiresAt: null });
    assert.deepEqual(parseInviteCreateInput('', '7', NOW), { ok: true, maxUses: 0, expiresAt: NOW + 7 * DAY });
    assert.deepEqual(parseInviteCreateInput('', '0.5', NOW), { ok: true, maxUses: 0, expiresAt: NOW + 0.5 * DAY });
});

test('negative / non-numeric days are blocked', () => {
    for (const bad of ['-1', 'abc']) {
        const r = parseInviteCreateInput('', bad);
        assert.equal(r.ok, false, `days ${bad} must be rejected`);
        if (!r.ok) assert.equal(r.badDays, true);
    }
});

test('both fields bad → both flags reported for per-input marking', () => {
    const r = parseInviteCreateInput('-2', 'xyz');
    assert.deepEqual(r, { ok: false, badMaxUses: true, badDays: true });
});
