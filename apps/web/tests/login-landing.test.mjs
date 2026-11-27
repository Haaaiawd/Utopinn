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
import { postLoginTarget, stashOAuthReturnTo, consumeOAuthReturnTo } from '../src/lib/postLoginTarget.ts';

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

// The computed target is handed to window.location.assign() after sign-in,
// so anything the browser would parse as a URL reference must fail closed —
// a crafted same-site link must never become an off-site redirect.
test('URL references fail closed to / — open-redirect guard', () => {
    // '//host' is protocol-relative: assigning it navigates off-site.
    assert.equal(postLoginTarget(loc('//evil.com')), '/');
    assert.equal(postLoginTarget(loc('//evil.com', '?a=b')), '/');
    assert.equal(postLoginTarget(loc('///evil.com/path')), '/');
    // No leading '/' at all — absolute URLs, schemes, bare hosts.
    assert.equal(postLoginTarget(loc('https://evil.com')), '/');
    assert.equal(postLoginTarget(loc('javascript:alert(1)')), '/');
    assert.equal(postLoginTarget(loc('evil.com')), '/');
    // Backslash is a path separator to browsers: '/\evil.com' == '//evil.com'.
    assert.equal(postLoginTarget(loc('/\\evil.com')), '/');
    assert.equal(postLoginTarget(loc('/foo\\bar')), '/');
    // Encoded separators — one decode pass, then the same rules.
    assert.equal(postLoginTarget(loc('/%2F%2Fevil.com')), '/');
    assert.equal(postLoginTarget(loc('/%2f%2fevil.com')), '/');
    assert.equal(postLoginTarget(loc('/%5Cevil.com')), '/');
    // A bare '%' that cannot decode fails closed rather than throwing.
    assert.equal(postLoginTarget(loc('/100%')), '/');
});

test('query/hash stay intact — they cannot move the target off-origin', () => {
    assert.equal(postLoginTarget(loc('/hub', '?next=%2F%2Fevil.com')), '/hub?next=%2F%2Fevil.com');
    assert.equal(postLoginTarget(loc('/hub', '', '#x=//evil.com')), '/hub#x=//evil.com');
});

const memStore = () => {
    const m = new Map();
    return {
        setItem: (k, v) => m.set(k, v),
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        removeItem: (k) => m.delete(k),
    };
};

test('oauth return: stash + consume round-trips the deep link once', () => {
    const store = memStore();
    stashOAuthReturnTo('/hub?vp=mobile', store);
    assert.equal(consumeOAuthReturnTo(store), '/hub?vp=mobile');
    assert.equal(consumeOAuthReturnTo(store), null); // consumed, not replayed
});

test('oauth return: a URL-reference target is never stashed', () => {
    const store = memStore();
    stashOAuthReturnTo('//evil.com', store);
    stashOAuthReturnTo('https://evil.com', store);
    stashOAuthReturnTo('/%2F%2Fevil.com', store);
    assert.equal(consumeOAuthReturnTo(store), null);
});

test('oauth return: a tampered stash is consumed and dropped, not honored', () => {
    const store = memStore();
    store.setItem('utopinn.oauthReturnTo', '//evil.com');
    assert.equal(consumeOAuthReturnTo(store), null);
    assert.equal(store.getItem('utopinn.oauthReturnTo'), null);
});
