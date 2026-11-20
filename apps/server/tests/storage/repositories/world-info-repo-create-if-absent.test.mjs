/**
 * Regression for the PR-review race in materializeEmbeddedWorld
 * (src/plugins/utopinn-import.js): two imported cards that bind the same
 * extensions.world used to run resolveName() in one transaction and save()
 * in a second — both checks could observe "absent" and both writes would
 * land, so the second importer silently overwrote the first one's book.
 * WorldInfoRepo.createIfAbsent moves canonical-name resolution + the
 * conditional insert into a single transaction.
 *
 * The single-winner guarantee is asserted only where the engine provides
 * it: FsEngine and SqliteEngine serialize all of a handle's transactions
 * through a per-handle promise tail, so resolve → check → put inside
 * createIfAbsent is a real critical section. On MysqlEngine / PgEngine
 * each withTransaction leases its own pooled connection at the driver's
 * default isolation, where two concurrent creates of a not-yet-existing
 * name can still both observe "absent" — that residual race is documented
 * on createIfAbsent and intentionally not covered here.
 *
 * The docs below stand in for two different embedded character_books
 * (different entry content) materialized under the same world name.
 *
 * Run: node --test tests/storage/repositories/world-info-repo-create-if-absent.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeTempFsEngine } from '../harness/fs-harness.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';

const DOC_A = { entries: { '0': { uid: 0, key: ['alpha'], content: 'alpha-lore' } }, name: 'BoundWorld' };
const DOC_B = { entries: { '0': { uid: 0, key: ['beta'], content: 'beta-lore' } }, name: 'BoundWorld' };

const engines = [{ name: 'FsEngine', make: makeTempFsEngine }];

// SqliteEngine needs the better-sqlite3 native binding; pnpm only builds it
// after `pnpm approve-builds`. Probe with a real Database — the JS wrapper
// imports fine even when the .node binding is missing. The contract-harness
// import stays inside the guard so a missing binding can't break fs tests.
const sqliteAvailable = await import('better-sqlite3')
    .then((m) => {
        const db = new m.default(':memory:');
        db.close();
        return true;
    })
    .catch(() => false);
if (sqliteAvailable) {
    const { makeTempSqliteEngineHarness } = await import('../harness/contract-harness.js');
    engines.push({ name: 'SqliteEngine', make: makeTempSqliteEngineHarness });
}

for (const { name, make } of engines) {
    test(`${name}: createIfAbsent creates the doc when no book resolves and returns the canonical name`, async () => {
        const h = await make();
        try {
            const repo = new WorldInfoRepo({ engine: h.engine });
            const result = await repo.createIfAbsent(h.handle, 'BoundWorld', DOC_A);
            assert.deepEqual(result, { created: true, name: 'BoundWorld' });
            const stored = await repo.get(h.handle, 'BoundWorld');
            assert.equal(stored.entries['0'].content, 'alpha-lore');
        } finally {
            h.cleanup();
        }
    });

    test(`${name}: createIfAbsent does not write and reports the existing canonical name when a book exists`, async () => {
        const h = await make();
        try {
            const repo = new WorldInfoRepo({ engine: h.engine });
            await repo.save(h.handle, 'BoundWorld', { entries: { '0': { uid: 0, content: 'original' } } });
            const result = await repo.createIfAbsent(h.handle, 'BoundWorld', DOC_B);
            assert.deepEqual(result, { created: false, name: 'BoundWorld' });
            // The pre-existing book must be untouched.
            const stored = await repo.get(h.handle, 'BoundWorld');
            assert.equal(stored.entries['0'].content, 'original');
        } finally {
            h.cleanup();
        }
    });

    test(`${name}: createIfAbsent honors the tolerant resolver — a normalized-name match counts as existing`, async () => {
        const h = await make();
        try {
            fs.mkdirSync(h.dirs.worlds, { recursive: true });
            const repo = new WorldInfoRepo({ engine: h.engine });
            // "Two  Spaces" survives sanitize-filename but normalizes to
            // "Two Spaces", so a request for the single-spaced form
            // resolves to the stored book.
            await repo.save(h.handle, 'Two  Spaces', DOC_A);
            const result = await repo.createIfAbsent(h.handle, 'Two Spaces', DOC_B);
            assert.equal(result.created, false);
            assert.equal(result.name, 'Two  Spaces');
            const stored = await repo.get(h.handle, 'Two  Spaces');
            assert.equal(stored.entries['0'].content, 'alpha-lore');
        } finally {
            h.cleanup();
        }
    });

    test(`${name}: createIfAbsent rejects docs that save() would also reject`, async () => {
        const h = await make();
        try {
            const repo = new WorldInfoRepo({ engine: h.engine });
            await assert.rejects(repo.createIfAbsent(h.handle, 'X', {}));
            await assert.rejects(repo.createIfAbsent(h.handle, 'X', { entries: [] }));
            await assert.rejects(repo.createIfAbsent(h.handle, 'X', { entries: null }));
            await assert.rejects(repo.createIfAbsent(h.handle, 'X', null));
            await assert.rejects(repo.createIfAbsent(h.handle, 'X', [1, 2]));
            assert.equal(await repo.resolveName(h.handle, 'X'), null);
        } finally {
            h.cleanup();
        }
    });

    test(`${name}: concurrent materializations of different books under one world name — exactly one wins`, async () => {
        const h = await make();
        try {
            fs.mkdirSync(h.dirs.worlds, { recursive: true });
            const repo = new WorldInfoRepo({ engine: h.engine });
            // Two concurrent import commits whose cards both bind
            // "BoundWorld" but embed different character_books. The
            // per-handle tail makes call order deterministic: the first
            // createIfAbsent's tx completes before the second starts.
            const [first, second] = await Promise.all([
                repo.createIfAbsent(h.handle, 'BoundWorld', DOC_A),
                repo.createIfAbsent(h.handle, 'BoundWorld', DOC_B),
            ]);

            assert.deepEqual(first, { created: true, name: 'BoundWorld' });
            assert.deepEqual(second, { created: false, name: 'BoundWorld' });

            // The stored book is the winner's — docB never overwrote docA.
            const stored = await repo.get(h.handle, 'BoundWorld');
            assert.equal(stored.entries['0'].content, 'alpha-lore');

            // Both "characters" afterwards resolve and read the same single
            // book.
            const nameForA = await repo.resolveName(h.handle, 'BoundWorld');
            const nameForB = await repo.resolveName(h.handle, 'BoundWorld');
            assert.equal(nameForA, 'BoundWorld');
            assert.equal(nameForB, 'BoundWorld');
            const seenByA = await repo.get(h.handle, nameForA);
            const seenByB = await repo.get(h.handle, nameForB);
            assert.deepEqual(seenByB, seenByA);
            assert.equal(seenByA.entries['0'].content, 'alpha-lore');
        } finally {
            h.cleanup();
        }
    });

    test(`${name}: the legacy resolveName+save pair still loses the first writer under the same schedule`, async () => {
        const h = await make();
        try {
            fs.mkdirSync(h.dirs.worlds, { recursive: true });
            const repo = new WorldInfoRepo({ engine: h.engine });
            // Demonstrates the race createIfAbsent closes: checking in one
            // transaction and writing in a SECOND transaction serializes
            // each tx but leaves the check→write gap open, so both
            // importers observe "absent" and both saves land — last write
            // wins.
            const checks = await Promise.all([
                repo.resolveName(h.handle, 'BoundWorld'),
                repo.resolveName(h.handle, 'BoundWorld'),
            ]);
            assert.deepEqual(checks, [null, null]);

            await Promise.all([
                repo.save(h.handle, 'BoundWorld', DOC_A),
                repo.save(h.handle, 'BoundWorld', DOC_B),
            ]);

            const stored = await repo.get(h.handle, 'BoundWorld');
            assert.equal(stored.entries['0'].content, 'beta-lore');
        } finally {
            h.cleanup();
        }
    });
}
