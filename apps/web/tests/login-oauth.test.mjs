/**
 * oauth.ts pure-model unit tests — LoginGate renders an OAuth button per
 * entry of oauthProviderLinks(), so an empty list means "no providers, no
 * buttons" and a populated list must point at the real start endpoints.
 * Covers review comment #2 without needing a live OAuth provider.
 *
 * Run: node --test apps/web/tests/login-oauth.test.mjs
 * (the .ts under test is loaded via Node>=22.6 type-stripping; no fetch, no DOM)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oauthProviderLinks } from '../src/api/oauth.ts';

test('oauthProviderLinks — no providers configured or endpoint unreachable → no buttons', () => {
    assert.deepEqual(oauthProviderLinks(null), []);
    assert.deepEqual(oauthProviderLinks(undefined), []);
    assert.deepEqual(oauthProviderLinks({}), []);
    assert.deepEqual(oauthProviderLinks({ providers: {} }), []);
    assert.deepEqual(oauthProviderLinks({ providers: { github: false, discord: false } }), []);
});

test('oauthProviderLinks — enabled providers → buttons pointing at /api/users/oauth/start/<id>', () => {
    assert.deepEqual(oauthProviderLinks({ providers: { github: true } }),
        [{ id: 'github', href: '/api/users/oauth/start/github' }]);
    assert.deepEqual(oauthProviderLinks({ providers: { discord: true } }),
        [{ id: 'discord', href: '/api/users/oauth/start/discord' }]);
    assert.deepEqual(oauthProviderLinks({ providers: { github: true, discord: true } }), [
        { id: 'github', href: '/api/users/oauth/start/github' },
        { id: 'discord', href: '/api/users/oauth/start/discord' },
    ]);
});

test('oauthProviderLinks — mixed truthiness keeps only enabled providers', () => {
    assert.deepEqual(oauthProviderLinks({ providers: { github: true, discord: false } }),
        [{ id: 'github', href: '/api/users/oauth/start/github' }]);
});
