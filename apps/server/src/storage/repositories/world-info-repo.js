import _ from 'lodash';

import { assertWritable } from '../read-only-mode.js';
import { applyJsonPatch } from './json-patch.js';

export class WorldInfoRepo {
    constructor({ engine }) { this._engine = engine; }

    _key(handle, name) { return { kind: 'world', handle, name }; }

    async get(handle, name) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle, name)));
    }

    async save(handle, name, doc) {
        assertWritable();
        if (!_.isObjectLike(doc) || Array.isArray(doc) || !_.isObjectLike(doc.entries) || Array.isArray(doc.entries)) {
            throw new Error('WorldInfoRepo.save: doc must be an object with an entries object');
        }
        await this._engine.withTransaction(handle, (tx) => tx.putResource(this._key(handle, name), { doc }));
    }

    /**
     * Create `doc` under `name` only when no book resolves to it — canonical
     * name resolution and the conditional write run inside ONE transaction,
     * so the check cannot observe a different snapshot than the insert.
     *
     * Atomicity by engine:
     *   - fs / sqlite: fully atomic (single process). Both engines serialize
     *     every transaction for a handle through a per-handle promise tail,
     *     so the resolve → check → put sequence is a real critical section.
     *   - mysql / postgres: NOT fully atomic. Each `withTransaction` leases
     *     its own pooled connection at the driver's default isolation
     *     (InnoDB REPEATABLE READ / Postgres READ COMMITTED), so two
     *     concurrent calls for a name that does not exist yet can both
     *     resolve "absent" and both upsert the same new row — the loser
     *     blocks on the PK, then its ON DUPLICATE KEY UPDATE /
     *     ON CONFLICT DO UPDATE overwrites the winner's doc
     *     (last-writer-wins; both report `created: true`). Closing that
     *     hole needs a locking read over the handle's name set or a
     *     serializable transaction — neither is expressible through the
     *     StorageTransaction surface repos see. It is still strictly
     *     better than a resolveName() + save() pair, which can also
     *     overwrite a book committed between the two separate
     *     transactions.
     *
     * @param {string} handle
     * @param {string} name
     * @param {object} doc World doc — same contract as save(): an object with an `entries` object.
     * @returns {Promise<{created: boolean, name: string}>}
     *   `created` reports whether this call wrote the doc. `name` is the
     *   canonical name the book is addressable by — the pre-existing
     *   book's name when `created` is false, the stored name otherwise.
     */
    async createIfAbsent(handle, name, doc) {
        assertWritable();
        if (!_.isObjectLike(doc) || Array.isArray(doc) || !_.isObjectLike(doc.entries) || Array.isArray(doc.entries)) {
            throw new Error('WorldInfoRepo.createIfAbsent: doc must be an object with an entries object');
        }
        return this._engine.withTransaction(handle, async (tx) => {
            const key = this._key(handle, name);
            const existing = await tx.resolveWorldName(key);
            if (existing != null) {
                return { created: false, name: existing };
            }
            await tx.putResource(key, { doc });
            // putResource re-runs canonical resolution; inside this same tx
            // no book exists, so it writes under the requested name (fs may
            // sanitize it, sql stores the trimmed name). Re-resolve to
            // report the name the doc is actually addressable by.
            const canonical = await tx.resolveWorldName(key);
            return { created: true, name: canonical ?? String(name ?? '').trim() };
        });
    }

    async delete(handle, name) {
        assertWritable();
        return this._engine.withTransaction(handle, (tx) => tx.deleteResource(this._key(handle, name)));
    }

    async exists(handle, name) {
        return this._engine.withTransaction(handle, async (tx) => {
            const canonical = await tx.resolveWorldName(this._key(handle, name));
            return canonical != null;
        });
    }

    async patch(handle, name, ops) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const key = this._key(handle, name);
            const existing = await tx.getResource(key);
            const seed = (_.isObjectLike(existing) && !Array.isArray(existing)) ? existing : { entries: {} };
            const next = applyJsonPatch(seed, ops);
            if (!_.isObjectLike(next) || Array.isArray(next)) {
                throw new Error('World info patch must produce an object root.');
            }
            if (!('entries' in next) || !_.isObjectLike(next.entries) || Array.isArray(next.entries)) {
                throw new Error('World info patch must keep a valid entries object.');
            }
            await tx.putResource(key, { doc: next });
            return next;
        });
    }

    async list(handle) {
        return this._engine.withTransaction(handle, (tx) => tx.listResources({ kind: 'world', handle }));
    }

    // Convenience: just the canonical names, sorted. Used by buildSettingsResponse
    // and the resource directory. Reads names without opening or parsing every book.
    async listNames(handle) {
        const names = await this._engine.withTransaction(handle, (tx) => tx.listWorldNames(handle));
        return names
            .filter((name) => typeof name === 'string' && name.length > 0)
            .sort((a, b) => a.localeCompare(b));
    }

    async resolveName(handle, requested) {
        return this._engine.withTransaction(handle, (tx) => tx.resolveWorldName(this._key(handle, requested)));
    }
}
