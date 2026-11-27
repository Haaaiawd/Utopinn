/**
 * postLoginTarget pure-model unit tests — the standalone login landing
 * (AuthGate → LoginLanding) passes this to LoginGate so the post-login
 * full reload returns the guest to the URL they were aiming at instead of
 * always booting '/'.
 *
 * Contract: '/login' itself is not a destination ('/'); deep links keep
 * path+query+hash; the OAuth ?error= bounce param is pre-login state and
 * must not replay on the authed boot.
 *
 * Run: node --test apps/web/tests/login-landing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postLoginTarget } from '../src/lib/postLoginTarget.ts';

const loc = (pathname, search = '', hash = '') => ({ pathname, search, hash });

test('/login is not a destination — maps to /', () => {
    assert.equal(postLoginTarget(loc('/login')), '/');
    assert.equal(postLoginTarget(loc('/login/')), '/');
    assert.equal(postLoginTarget(loc('/')), '/');
});

test('deep links keep path + query + hash through the login round-trip', () => {
    assert.equal(postLoginTarget(loc('/hub')), '/hub');
    assert.equal(postLoginTarget(loc('/hub', '?vp=mobile')), '/hub?vp=mobile');
    assert.equal(postLoginTarget(loc('/studio', '', '#sec=worlds')), '/studio#sec=worlds');
    assert.equal(postLoginTarget(loc('/chat', '?chat=c1', '#floor=3')), '/chat?chat=c1#floor=3');
});

test('the OAuth ?error= bounce param is stripped — pre-login state, no replay', () => {
    assert.equal(postLoginTarget(loc('/login', '?error=oauth_user_disabled')), '/');
    assert.equal(postLoginTarget(loc('/hub', '?error=oauth_guild_check_failed')), '/hub');
    assert.equal(postLoginTarget(loc('/hub', '?error=x&vp=mobile')), '/hub?vp=mobile');
});
