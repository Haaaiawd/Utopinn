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

test('PUT failure keeps the optimistic doc and pending edits for retry', async () => {
    const b = initBackend({ k: { v: 'server' } });
    const store = makeStore(b);
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, v: 'optimistic' }));
    b.failNextPut = 1;
    await sleep(60);
    /* Old behaviour rolled doc back to 'server' — that was the silent
       data-loss shape (the user's form vanished with no way to retry). */
    assert.equal(store.getDoc('k').v, 'optimistic', 'edit retained, not rolled back');
    assert.equal(b.docs.get('k').v, 'server');
    assert.ok(b.errors.some((m) => m.includes('put-fail')), 'error surfaced via onError');
    /* The retained pending tail rides the next save — nothing is lost. */
    store.mutate('k', (d) => ({ ...d, more: 1 }));
    await sleep(60);
    assert.equal(b.docs.get('k').v, 'optimistic', 'retained edit lands on retry');
    assert.equal(b.docs.get('k').more, 1);
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

/* ---------- Round-2 review pins (the resurrected bug shapes) ---------- */

test('flush keeps edits queued while its PUT is in flight (typing during autosave, 🔴1)', async () => {
    const b = initBackend({ k: { v: 'a' } });
    /* Gate the PUT so a keystroke lands strictly mid-flight. */
    let releaseSave; let saveStarted;
    const gate = new Promise((r) => { releaseSave = r; });
    const started = new Promise((r) => { saveStarted = r; });
    const store = createSharedDocStore({
        load: b.load,
        save: async (key, doc) => { saveStarted(); await gate; return b.save(key, doc); },
        debounceMs: 60000, // autosave never self-fires — flush drives explicitly
        onError: (key, msg) => b.errors.push(`${key}:${msg}`),
    });
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, v: 'a1' }));
    const fl = store.flush('k');
    await started; // PUT is now in flight carrying only v:'a1'
    /* The reported loss: this keystroke used to be wiped by the resolve
       path (pending cleared wholesale) and never reached the server. */
    store.mutate('k', (d) => ({ ...d, typed: true }));
    releaseSave();
    await fl;
    assert.deepEqual(b.docs.get('k'), { v: 'a1' }, 'in-flight write covers only its own batch');
    assert.equal(store.getDoc('k').typed, true, 'mid-flight edit survives in the optimistic doc');
    await store.flush('k');
    assert.deepEqual(b.docs.get('k'), { v: 'a1', typed: true }, 'next write persists the tail');
});

test('flush REJECTS on save failure — optimistic doc + pending retained for retry (🟡8)', async () => {
    const b = initBackend({ k: { v: 'server' } });
    const store = makeStore(b, 60000);
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, v: 'typed' }));
    b.failNextPut = 1;
    await assert.rejects(() => store.flush('k'), /put-fail/, 'caller must see the failure');
    assert.equal(store.getDoc('k').v, 'typed', 'form content is not discarded');
    assert.ok(b.errors.some((m) => m.includes('put-fail')), 'still reported via onError');
    await store.flush('k');
    assert.equal(b.docs.get('k').v, 'typed', 'plain retry lands the same edits');
});

test('flush rejects on load failure; serial lane stays usable afterwards', async () => {
    const b = initBackend({ k: { v: 1 } });
    const store = makeStore(b, 60000);
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, v: 2 }));
    b.failNextGet = 1;
    await assert.rejects(store.flush('k'), /get-fail/);
    /* A rejected op must not brick the entry's serial chain. */
    await store.flush('k');
    assert.equal(b.docs.get('k').v, 2, 'lane unblocked, retained edit persisted');
});

test('ensure publishes the fetched doc to subscribers — no loading-snapshot limbo (🔴2)', async () => {
    const b = initBackend({ k: { v: 'real' } });
    const store = makeStore(b);
    const seen = [];
    const un = store.subscribe('k', () => seen.push(store.getSnapshot('k').status));
    const doc = await store.ensure('k');
    const snap = store.getSnapshot('k');
    assert.equal(doc.v, 'real');
    assert.equal(snap.status, 'ready');
    assert.equal(snap.doc?.v, 'real', 'subscribers converge on the real doc');
    assert.ok(seen.includes('loading'), 'loading phase was observable');
    assert.equal(seen.at(-1), 'ready');
    un();
});

test('a concurrent first-mutate and ensure ride one fetch; failed loads retry (🔴2)', async () => {
    const b = initBackend({ k: { v: 1 } });
    const store = makeStore(b);
    store.mutate('k', (d) => ({ ...d, plus: 1 }));
    const doc = await store.ensure('k');
    assert.equal(b.gets, 1, 'ensure rode the mutate in-flight fetch');
    assert.equal(doc.v, 1);
    assert.equal(doc.plus, 1, 'queued mutation applied on the fetched doc');

    /* A failed fetch must not poison the entry — next call retries. */
    const b2 = initBackend({});
    b2.failNextGet = 1;
    const store2 = makeStore(b2);
    await assert.rejects(store2.ensure('m'), /get-fail/);
    b2.externalWrite('m', { ok: true });
    const d2 = await store2.ensure('m');
    assert.equal(d2.ok, true);
});

test('a mutation that throws on the fresh base is dropped by index — not replayed forever', async () => {
    const b = initBackend({ k: { v: 0 } });
    const store = makeStore(b, 60000);
    await store.ensure('k');
    store.mutate('k', (d) => ({ ...d, v: 1 })); // healthy
    /* Applies fine on the optimistic doc but throws on the fresh base. */
    store.mutate('k', (d) => {
        if (d.poison) throw new Error('boom');
        return { ...d, ok: true };
    });
    b.externalWrite('k', { v: 0, poison: true });
    await store.flush('k');
    assert.equal(b.docs.get('k').v, 1, 'healthy mutation still landed');
    assert.equal(b.docs.get('k').ok, undefined, 'poisoned fn dropped out of the batch');
    assert.ok(b.errors.some((m) => m.includes('boom')), 'dead fn reported');
    const gets = b.gets;
    await store.flush('k');
    assert.equal(b.gets, gets, 'dead fn is gone — flush is a no-op');
});
