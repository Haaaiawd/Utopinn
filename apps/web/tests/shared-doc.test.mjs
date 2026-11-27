/**
 * lib/sharedDoc.ts — shared document store semantics pinned down:
 * the single-source + fresh-base write protocol that replaces every
 * surface's private doc snapshot. Simulated "other surfaces" write the
 * fake backend directly between load and save — the old bug class was
 * those writes being silently clobbered by a stale-base whole-doc PUT.
 *
 * Run: node --test apps/web/tests/shared-doc.test.mjs
 * (tested .ts rides Node>=22.6 type-stripping; pure logic, zero network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedDocStore } from '../src/lib/sharedDoc.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake backend: an in-memory doc per key + call counters. */
function initBackend(initial = {}) {
    const b = {
        docs: new Map(Object.entries(initial)),
        gets: 0,
        puts: 0,
        failNextGet: 0,
        failNextPut: 0,
        errors: [],
        load: async (key) => {
            b.gets += 1;
            if (b.failNextGet > 0) { b.failNextGet -= 1; throw new Error('get-fail'); }
            if (!b.docs.has(key)) throw new Error('404');
            return structuredClone(b.docs.get(key));
        },
        save: async (key, doc) => {
            b.puts += 1;
            if (b.failNextPut > 0) { b.failNextPut -= 1; throw new Error('put-fail'); }
            b.docs.set(key, structuredClone(doc));
        },
        /** Out-of-lane write — what another surface/server op does. */
        externalWrite: (key, doc) => b.docs.set(key, structuredClone(doc)),
    };
    return b;
}

const makeStore = (b, debounceMs = 20) => createSharedDocStore({
    load: b.load,
    save: b.save,
    debounceMs,
    onError: (key, msg) => b.errors.push(`${key}:${msg}`),
});

test('mutate applies synchronously when doc is loaded (typing never reverts)', async () => {
    const b = initBackend({ k: { text: 'a' } });
    const store = makeStore(b);
    await store.ensure('k');
    /* The controlled-input race the old mutateFor lost: fn must land on
       the rendered doc in the SAME tick, not behind a microtask. */
    store.mutate('k', (d) => ({ ...d, text: 'ab' }));
    assert.equal(store.getDoc('k').text, 'ab', 'optimistic doc updated before any await');
    store.mutate('k', (d) => ({ ...d, text: 'abc' }));
    assert.equal(store.getDoc('k').text, 'abc');
    await sleep(60);
    assert.equal(b.docs.get('k').text, 'abc', 'debounced PUT persisted');
    assert.equal(b.puts, 1, 'burst collapses into a single PUT');
});

test('mutate before load queues behind the fetch and still lands', async () => {
    const b = initBackend({ k: { n: 1 } });
    const store = makeStore(b);
    store.mutate('k', (d) => ({ ...d, n: d.n + 1 }));
    assert.equal(store.getDoc('k'), null, 'no doc until fetch resolves');
    await sleep(60);
    assert.equal(store.getDoc('k').n, 2);
    await sleep(40);
    assert.equal(b.docs.get('k').n, 2);
});

test('external write between load and save is merged, not clobbered (stale-base class)', async () => {
    const b = initBackend({ k: { a: 1, list: ['x'] } });
    const store = makeStore(b);
    await store.ensure('k');
    /* Surface A mutates its own field… */
    store.mutate('k', (d) => ({ ...d, mine: 'A' }));
    /* …surface B writes a different field on the server BEFORE A's
       debounced PUT fires — the fatal window of the old design. */
    b.externalWrite('k', { a: 1, list: ['x', 'B-added'] });
    await sleep(60);
    const doc = b.docs.get('k');
    assert.equal(doc.mine, 'A', 'our pending write landed');
    assert.deepEqual(doc.list, ['x', 'B-added'], 'external write preserved — fresh-base PUT rebased');
});

test('two surfaces alternating writes on the same doc both persist', async () => {
    const b = initBackend({ k: { x: 0 } });
    const store = makeStore(b);
    await store.ensure('k');
    /* Alternate "surfaces" (rail editor vs studio vs sliders) — same
       store, so each mutate builds on the other's optimistic doc. */
    for (let i = 0; i < 5; i++) {
        store.mutate('k', (d) => ({ ...d, x: d.x + 1 }));
    }
    await sleep(60);
    assert.equal(b.docs.get('k').x, 5);
    /* Interleave a foreign PUT mid-flight, then more edits — everything wins. */
    b.externalWrite('k', { x: 5, foreign: true });
    store.mutate('k', (d) => ({ ...d, x: d.x + 10 }));
    await sleep(60);
    assert.equal(b.docs.get('k').x, 15, 'pending rebased onto foreign write');
    assert.equal(b.docs.get('k').foreign, true);
});

test('PUT failure rolls back to server truth and reports the error', async () => {
    const b = initBackend({ k: { v: 'server' } });
    const store = makeStore(b);
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, v: 'optimistic' }));
    b.failNextPut = 1;
    await sleep(60);
    assert.equal(store.getDoc('k').v, 'server', 'optimistic doc rolled back to persisted state');
    assert.equal(b.docs.get('k').v, 'server');
    assert.ok(b.errors.some((m) => m.includes('put-fail')), 'error surfaced via onError');
});

test('reload/invalidate rebases pending edits instead of dropping them', async () => {
    const b = initBackend({ k: { s: 0 } });
    const store = makeStore(b);
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, local: 'pending' }));
    /* External write lands before the pending edit flushes — reload pulls
       it in and the pending fn re-applies on top. */
    b.externalWrite('k', { s: 0, other: 'live' });
    await store.reload('k');
    assert.equal(store.getDoc('k').other, 'live', 'external change visible');
    assert.equal(store.getDoc('k').local, 'pending', 'pending edit survived the rebase');
});

test('invalidate re-pulls live entries; dropped entries stop serving stale docs', async () => {
    const b = initBackend({ k: { s: 1 } });
    const store = makeStore(b);
    await store.ensure('k');
    b.externalWrite('k', { s: 2 });
    store.invalidate('k');
    await sleep(10);
    assert.equal(store.getDoc('k').s, 2);
    store.drop('k');
    assert.equal(store.getDoc('k'), null);
    assert.equal(store.getSnapshot('k').status, 'idle');
});

test('subscribe notifies listeners on every state change with a stable snapshot', async () => {
    const b = initBackend({ k: { s: 0 } });
    const store = makeStore(b);
    let seen = 0;
    const un = store.subscribe('k', () => { seen += 1; });
    await sleep(30);
    assert.ok(seen >= 1, 'subscribe kicked off ensure → notify on load');
    const s1 = store.getSnapshot('k');
    const s2 = store.getSnapshot('k');
    assert.equal(s1, s2, 'snapshot referentially stable between notifies (uSES-safe)');
    store.mutate('k', (d) => ({ ...d, s: 9 }));
    const s3 = store.getSnapshot('k');
    assert.notEqual(s3, s1);
    assert.equal(s3.doc.s, 9);
    un();
});

test('prime seeds a fetched doc and rebases pending fns', async () => {
    const b = initBackend({ k: { v: 'base' } });
    const store = makeStore(b);
    store.mutate('k', (d) => ({ ...d, typed: true }));
    store.prime('k', { v: 'base' });
    assert.deepEqual(store.getDoc('k'), { v: 'base', typed: true });
});

test('ensure dedups concurrent fetches through the serial chain', async () => {
    const b = initBackend({ k: { v: 1 } });
    const store = makeStore(b);
    const [a, c] = await Promise.all([store.ensure('k'), store.ensure('k')]);
    assert.deepEqual(a, c);
    assert.equal(b.gets, 1, 'second ensure rides the in-flight fetch');
});

test('flush lands pending writes immediately and merges foreign base', async () => {
    const b = initBackend({ k: { v: 0 } });
    const store = makeStore(b);
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, v: 1 }));
    b.externalWrite('k', { v: 0, ext: true });
    await store.flush('k');
    assert.deepEqual(b.docs.get('k'), { v: 1, ext: true });
});

test('load failure on first mutate reports error and drops the un-appliable fn', async () => {
    const b = initBackend({});
    const store = makeStore(b);
    store.mutate('missing', (d) => ({ ...d, x: 1 }));
    await sleep(30);
    assert.equal(store.getDoc('missing'), null);
    assert.ok(b.errors.length >= 1, 'reported through onError');
    /* Retry after the failure clears — the dropped fn is not replayed. */
    b.externalWrite('missing', { ok: true });
    store.mutate('missing', (d) => ({ ...d, again: true }));
    await sleep(60);
    assert.deepEqual(b.docs.get('missing'), { ok: true, again: true });
});
