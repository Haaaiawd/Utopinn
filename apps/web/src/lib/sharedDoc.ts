// Shared document store — single source of truth for server-backed docs
// that several edit surfaces read and write at once (preset docs, QR
// binding settings, per-chat QR config).
//
// The bug class this kills: every surface used to hold its own snapshot
// and write back blind whole-doc PUTs — whoever wrote last silently
// reverted the others. Here each key has ONE optimistic doc (what the UI
// shows), ONE synced copy (last state confirmed on the server), and a
// FIFO of mutation fns not yet persisted.
//
// Write semantics:
//   mutate(key, fn)  — fn is recorded in pending and applied to `doc`
//                      synchronously when the doc is loaded (controlled
//                      inputs never get reverted by a microtask race);
//                      without a doc it queues behind a fetch. A debounced
//                      flush then does GET → re-apply pending onto the
//                      FRESH doc → PUT, so a write that landed since our
//                      last sync is never clobbered (fresh-base write).
//   reload(key)      — GET → synced=fresh, doc=pending(fresh). External
//                      writes become visible without dropping local edits.
//   subscribe/getSnapshot — useSyncExternalStore-compatible; every surface
//                      reading a key converges on the same object.
//
// Pure module (no React, no fetch beyond the injected load/save) so
// node --test can drive it directly.
export interface SharedDocSnapshot<T> {
    /** Optimistic doc (pending mutations applied). null = not loaded / dropped. */
    doc: T | null;
    status: 'idle' | 'loading' | 'ready' | 'error';
    saving: boolean;
    /** Bumped on every notify — lets subscribers distinguish doc resets. */
    version: number;
}

export interface SharedDocStore<T> {
    /** React-compatible subscribe. First subscriber kicks off ensure(). */
    subscribe: (key: string, listener: () => void) => () => void;
    /** Stable snapshot object — replaced only when entry state changes. */
    getSnapshot: (key: string) => SharedDocSnapshot<T>;
    /** Non-hook read: optimistic doc or null. */
    getDoc: (key: string) => T | null;
    /** Fetch if not loaded (dedup'd through the entry's serial chain). */
    ensure: (key: string) => Promise<T | null>;
    /** Seed an entry with an already-fetched doc (skips the GET). Pending
        mutations are re-applied on top — same rebase as reload. */
    prime: (key: string, doc: T) => void;
    /** Record + apply a mutation; schedules a debounced fresh-base save. */
    mutate: (key: string, fn: (doc: T) => T) => void;
    /** Immediate GET → rebase pending → PUT. Queued on the serial chain. */
    flush: (key: string) => Promise<void>;
    /** GET → synced=fresh, doc=rebased pending. Queued on the serial chain. */
    reload: (key: string) => Promise<void>;
    /** Mark entry stale and re-pull it (call after out-of-lane writes). */
    invalidate: (key: string) => void;
    /** Invalidate every entry that currently holds a doc. */
    invalidateAll: () => void;
    /** Drop the entry entirely (document deleted / irrelevant). */
    drop: (key: string) => void;
}

interface Entry<T> {
    doc: T | null;
    synced: T | null;
    /** Mutations not yet persisted — in call order. */
    pending: Array<(doc: T) => T>;
    /** How many leading pending fns are already folded into `doc`. */
    appliedIdx: number;
    status: SharedDocSnapshot<T>['status'];
    saving: boolean;
    version: number;
    snap: SharedDocSnapshot<T>;
    /** Serial op queue. INVARIANT: this promise NEVER rejects — every
        op reports through onError and returns its outcome on a separate
        caller-facing promise; a rejected chain would silently brick
        every later op queued onto the entry. */
    chain: Promise<unknown>;
    /** In-flight initial-load task — shared so concurrent ensure()/first
        mutate() callers ride one fetch instead of queueing another. */
    inflight: Promise<T | null> | null;
    timer: ReturnType<typeof setTimeout> | null;
    listeners: Set<() => void>;
}

const EMPTY_SNAP: SharedDocSnapshot<never> = { doc: null, status: 'idle', saving: false, version: 0 };

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSharedDocStore<T>(opts: {
    load: (key: string) => Promise<T>;
    save: (key: string, doc: T) => Promise<unknown>;
    debounceMs?: number;
    /** Save/load failures surface here (the store itself never throws sync). */
    onError?: (key: string, message: string) => void;
}): SharedDocStore<T> {
    const debounceMs = opts.debounceMs ?? 450;
    const entries = new Map<string, Entry<T>>();

    const get = (key: string): Entry<T> => {
        let e = entries.get(key);
        if (!e) {
            e = {
                doc: null, synced: null, pending: [], appliedIdx: 0,
                status: 'idle', saving: false, version: 0,
                snap: { ...EMPTY_SNAP } as SharedDocSnapshot<T>,
                chain: Promise.resolve(), inflight: null,
                timer: null, listeners: new Set(),
            };
            entries.set(key, e);
        }
        return e;
    };

    const notify = (e: Entry<T>) => {
        e.version += 1;
        e.snap = { doc: e.doc, status: e.status, saving: e.saving, version: e.version };
        for (const l of [...e.listeners]) l();
    };

    const applyPending = (e: Entry<T>) => {
        while (e.doc != null && e.appliedIdx < e.pending.length) {
            const f = e.pending[e.appliedIdx]!;
            try {
                e.doc = f(e.doc);
            } catch {
                /* Drop a mutation that throws — it can never apply and
                   leaving it in pending would poison every later apply. */
                e.pending.splice(e.appliedIdx, 1);
                continue;
            }
            e.appliedIdx += 1;
        }
    };

    const report = (key: string, e: unknown) => opts.onError?.(key, errMsg(e));

    const scheduleSave = (key: string, e: Entry<T>) => {
        if (e.timer) clearTimeout(e.timer);
        /* flush() rejects on save failure — the debounced path has no
           caller, so swallow here (onError already reported it). */
        e.timer = setTimeout(() => { void flush(key).catch(() => undefined); }, debounceMs);
    };

    const fetchInto = async (key: string, e: Entry<T>) => {
        const fresh = await opts.load(key);
        e.synced = fresh;
        e.doc = fresh;
        e.appliedIdx = 0;
        applyPending(e);
        e.status = 'ready';
    };

    const fetchOrThrow = (key: string, e: Entry<T>) =>
        fetchInto(key, e).catch((err) => { e.status = 'error'; notify(e); throw err; });

    /* flush() — queued on the serial chain but RETURNS a caller-facing
       task that rejects on load/save failure (the chain itself stays
       resolved so a failed write never bricks the lane). On success it
       retires exactly the pending batch it wrote; mutations queued while
       the request was in flight survive for the next write — clearing
       them here would erase typing that raced the PUT (review 🔴1). */
    function flush(key: string): Promise<void> {
        const e = get(key);
        const task = e.chain.then(async (): Promise<void> => {
            if (!e.pending.length) return;
            if (e.timer) { clearTimeout(e.timer); e.timer = null; }
            e.saving = true;
            notify(e);
            /* Fresh base: pull the doc as it exists on the server RIGHT NOW
               and re-apply our pending fns onto it — an external write that
               landed since our last sync is merged, not clobbered. */
            let fresh: T;
            try {
                fresh = await opts.load(key);
            } catch (err) {
                /* Keep pending — the next mutate/flush retries the save. */
                e.saving = false;
                notify(e);
                report(key, err);
                throw err;
            }
            /* The batch this write covers — sliced BEFORE building merged,
               so anything queued during the awaits belongs to the next
               write, never to `pending = []` (that was the data loss). */
            const batch = e.pending.slice();
            let merged = fresh;
            const dead = new Set<number>();
            for (const [i, f] of batch.entries()) {
                try {
                    merged = f(merged);
                } catch (err) {
                    /* A mutation that can't apply would poison every retry —
                       drop it (by batch index) and keep the rest. */
                    dead.add(i);
                    report(key, err);
                }
            }
            if (dead.size) {
                const lost = [...dead].filter((i) => i < e.appliedIdx).length;
                e.pending = e.pending.filter((_, i) => !dead.has(i));
                e.appliedIdx -= lost;
            }
            try {
                await opts.save(key, merged);
            } catch (err) {
                /* Keep pending + keep the optimistic doc — the caller sees
                   the rejection and the user's edits survive for a retry.
                   (Dropping them + rolling back was silent data loss.) */
                e.saving = false;
                notify(e);
                report(key, err);
                throw err;
            }
            /* Retire exactly the surviving batch prefix; later-queued
               mutations stay pending and are re-applied onto merged. */
            e.pending.splice(0, batch.length - dead.size);
            e.synced = merged;
            e.doc = merged;
            e.appliedIdx = 0;
            applyPending(e);
            e.saving = false;
            notify(e);
        });
        e.chain = task.then(() => undefined, () => undefined);
        return task;
    }

    const store: SharedDocStore<T> = {
        subscribe(key, listener) {
            const e = get(key);
            e.listeners.add(listener);
            if (e.doc == null && e.status !== 'loading') void store.ensure(key).catch(() => undefined);
            return () => { e.listeners.delete(listener); };
        },
        getSnapshot(key) {
            return (entries.get(key)?.snap ?? EMPTY_SNAP) as SharedDocSnapshot<T>;
        },
        getDoc(key) {
            return entries.get(key)?.doc ?? null;
        },
        ensure(key) {
            const e = get(key);
            if (e.doc != null) return Promise.resolve(e.doc);
            /* Ride the in-flight load (first mutate/ensure share it);
               a FAILED load leaves inflight null → the next call retries. */
            if (e.inflight) return e.inflight;
            e.status = 'loading';
            notify(e);
            const task: Promise<T | null> = e.chain
                .then(() => fetchOrThrow(key, e))
                .then(() => {
                    /* Publish the real doc — without this notify subscribers
                       stayed on the loading snapshot forever (review 🔴2). */
                    notify(e);
                    return e.doc;
                });
            task.catch(() => undefined);
            e.inflight = task;
            e.chain = task.then(
                /* Identity-guarded clear: a mutate()'s no-doc task can
                   overwrite e.inflight while this one is still queued —
                   settling must not deregister the newer owner. */
                () => { if (e.inflight === task) e.inflight = null; },
                () => { if (e.inflight === task) e.inflight = null; },
            );
            return task;
        },
        prime(key, doc) {
            const e = get(key);
            e.synced = doc;
            e.doc = doc;
            e.appliedIdx = 0;
            applyPending(e);
            e.status = 'ready';
            notify(e);
        },
        mutate(key, fn) {
            const e = get(key);
            e.pending.push(fn);
            if (e.doc != null) {
                applyPending(e);
                notify(e);
                scheduleSave(key, e);
                return;
            }
            /* No doc yet — queue fetch+apply on the serial chain so rapid
               first edits still land in order. The task doubles as the
               entry's inflight load so a concurrent ensure() rides it. */
            e.status = 'loading';
            const task = e.chain.then(async () => {
                if (e.doc == null) await fetchOrThrow(key, e);
                applyPending(e);
                notify(e);
                scheduleSave(key, e);
            });
            const inflight = task.then(() => e.doc);
            /* No guaranteed consumer — suppress unhandled-rejection while
               still letting ensure() callers observe the failure. */
            inflight.catch(() => undefined);
            e.inflight = inflight;
            e.chain = task.then(
                () => { if (e.inflight === inflight) e.inflight = null; },
                (err) => {
                    /* Fetch failed → drop the un-appliable tail so it can't
                       be silently replayed later; surface the error. */
                    if (e.inflight === inflight) e.inflight = null;
                    e.pending = e.pending.filter((f) => f !== fn);
                    e.status = 'error';
                    notify(e);
                    report(key, err);
                },
            );
        },
        flush,
        reload(key) {
            const e = get(key);
            e.chain = e.chain
                .then(() => fetchInto(key, e).then(() => notify(e)))
                .catch((err) => { e.status = 'error'; notify(e); report(key, err); });
            return e.chain.then(() => undefined);
        },
        invalidate(key) {
            const e = entries.get(key);
            if (!e || e.doc == null) return;
            void store.reload(key);
        },
        invalidateAll() {
            for (const [k, e] of entries) {
                if (e.doc != null) void store.reload(k);
            }
        },
        drop(key) {
            const e = entries.get(key);
            if (!e) return;
            if (e.timer) clearTimeout(e.timer);
            e.doc = null;
            e.synced = null;
            e.pending = [];
            e.appliedIdx = 0;
            e.status = 'idle';
            e.inflight = null;
            entries.delete(key);
            notify(e);
        },
    };
    return store;
}
