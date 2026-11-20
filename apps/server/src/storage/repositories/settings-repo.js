import { NotFoundError } from '../errors.js';
import { assertWritable } from '../read-only-mode.js';
import { decodeJsonPointer } from '../json-pointer.js';
import { applyJsonPatch } from './json-patch.js';

export class SettingsRepo {
    constructor({ engine }) { this._engine = engine; }
    _key(handle) { return { kind: 'settings', handle }; }

    async get(handle) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle)));
    }

    /**
     * Reads one JSON Pointer value without materializing the settings document.
     * @param {string} handle
     * @param {string} pointer RFC 6901 JSON Pointer
     * @returns {Promise<{exists: boolean, value?: unknown, type?: string}>}
     */
    async getField(handle, pointer) {
        const segments = decodeJsonPointer(pointer);
        return this._engine.withTransaction(handle, (tx) => tx.getResourceField(this._key(handle), segments));
    }

    async getFieldType(handle, pointer) {
        const segments = decodeJsonPointer(pointer);
        return this._engine.withTransaction(handle, (tx) => tx.getResourceFieldType(this._key(handle), segments));
    }

    async save(handle, doc) {
        assertWritable();
        await this._engine.withTransaction(handle, (tx) => tx.putResource(this._key(handle), { doc }));
    }

    /**
     * Read-modify-write inside the per-handle transaction critical section:
     * `fn` receives the authoritative doc and its return value is written,
     * serialized against every other writer of the same handle.
     *
     * Concurrency semantics: per-key last-wins ordered by tx arrival —
     * correct for absolute-value merges ("set these keys to these values").
     * No CAS/test anchors, no 409s. fn throwing → nothing is written
     * (fs: put never ran; sqlite: ROLLBACK) — all-or-nothing for free.
     *
     * ⚠ `fn` must be pure computation over the doc: it MUST NOT call back
     * into this repo or engine. The per-handle tail chain is not reentrant
     * (fs-engine.js:10-13); a nested withTransaction on the same handle
     * would deadlock.
     *
     * @param {string} handle
     * @param {(doc: object) => object|Promise<object>} fn merge fn; input is
     *   the stored doc, or `base` when absent / not a plain object
     * @param {{ base?: object }} [options]
     * @returns {Promise<object>} the document that was written
     */
    async update(handle, fn, { base = {} } = {}) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(this._key(handle));
            const doc = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : base;
            const next = await fn(doc);
            await tx.putResource(this._key(handle), { doc: next });
            return next;
        });
    }

    async patch(handle, ops) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(this._key(handle));
            if (existing == null) throw new NotFoundError('settings', { handle });
            const next = applyJsonPatch(existing, ops);
            await tx.putResource(this._key(handle), { doc: next });
            return next;
        });
    }
}
