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
    chain: Promise<unknown>;
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
                chain: Promise.resolve(), timer: null, listeners: new Set(),
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
        e.timer = setTimeout(() => { void flush(key); }, debounceMs);
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

    async function flush(key: string): Promise<void> {
        const e = get(key);
        e.chain = e.chain.then(async () => {
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
                return;
            }
            /* A throwing mutation must not reject the serial chain — that
               would silently brick every later op on this entry. Drop the
               offender (it can never apply cleanly) and keep the rest. */
            let merged = fresh;
            const kept: Array<(doc: T) => T> = [];
            for (const f of e.pending) {
                try {
                    merged = f(merged);
                    kept.push(f);
                } catch (err) {
                    report(key, err);
                }
            }
            if (kept.length !== e.pending.length) {
                e.pending = kept;
                e.appliedIdx = Math.min(e.appliedIdx, kept.length);
            }
            try {
                await opts.save(key, merged);
            } catch (err) {
                /* Rollback to server truth — pending edits are dropped and
                   the UI re-converges on what actually persisted (same
                   semantics as the old studio mutateFor rollback). */
                e.pending = [];
                e.appliedIdx = 0;
                try {
                    e.synced = await opts.load(key);
                    e.doc = e.synced;
                    e.status = 'ready';
                } catch { /* reload failure keeps last doc */ }
                e.saving = false;
                notify(e);
                report(key, err);
                return;
            }
            e.pending = [];
            e.appliedIdx = 0;
            e.synced = merged;
            e.doc = merged;
            e.saving = false;
            notify(e);
        });
        await e.chain;
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
            if (e.status === 'loading') return e.chain.then(() => e.doc);
            e.status = 'loading';
            notify(e);
            e.chain = e.chain.then(() => fetchOrThrow(key, e)).then(() => e.doc);
            return e.chain.then(() => e.doc);
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
               first edits still land in order. */
            e.status = 'loading';
            e.chain = e.chain
                .then(async () => {
                    if (e.doc == null) await fetchOrThrow(key, e);
                    applyPending(e);
                    notify(e);
                    scheduleSave(key, e);
                })
                .catch((err) => {
                    /* Fetch failed → drop the un-appliable tail so it can't
                       be silently replayed later; surface the error. */
                    e.pending = e.pending.filter((f) => f !== fn);
                    e.status = 'error';
                    notify(e);
                    report(key, err);
                });
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
            entries.delete(key);
            notify(e);
        },
    };
    return store;
}
