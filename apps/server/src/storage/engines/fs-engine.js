import { FsTransaction } from './fs-engine-transaction.js';

export class FsEngine {
    constructor({ directoriesByHandle }) {
        if (typeof directoriesByHandle !== 'function') {
            throw new TypeError('FsEngine requires { directoriesByHandle: (handle) => dirs }');
        }
        this.kind = 'fs';
        this._directoriesByHandle = directoriesByHandle;
        // Per-handle async tail,与 SqliteEngine 同构:fs 没有真事务,
        // read-modify-write(CAS await 窗口)全靠这条链防交错丢写。
        // repo 层无嵌套 withTransaction(扫描确认),故无需可重入。
        this._txTail = new Map();
    }

    // `handle` is accepted but unused by FsTransaction — its per-kind handlers
    // extract `handle` from key.handle / filter.handle themselves. SqliteEngine
    // *does* need it to pick the per-user DB before the transaction begins, so
    // the engine contract takes (handle, fn) uniformly.
    async withTransaction(handle, fn) {
        const tx = new FsTransaction({ directoriesByHandle: this._directoriesByHandle });
        // fn 体即临界区:链上前一个 tail,保证同一 handle 任意时刻只有一个
        // get→check→put 序列在跑(putResourceIfMatch 的 TOCTOU 窗口闭合)。
        const prev = this._txTail.get(handle) || Promise.resolve();
        const run = prev.then(() => fn(tx));
        // 吞掉尾链上的 rejection:失败的事务不毒化下一个调用方。
        this._txTail.set(handle, run.catch(() => {}));
        return run;
    }

    async ping(handle) { /* nothing to do */ }

    /**
     * No-op by design: the fs engine has no engine-internal rows to wipe —
     * every byte of a user's data lives in the on-disk directory tree. The
     * admin `/delete` handler's `purge=true` branch is the single, explicit
     * owner of removing that directory; `deleteUser` here runs unconditionally
     * and must therefore preserve the dir when the admin chose `purge=false`.
     * Idempotent (it does nothing).
     * @param {string} _handle
     */
    async deleteUser(_handle) {
        // intentionally empty — see jsdoc above
    }

    /**
     * The fs engine has no engine-internal rows to dump. The on-disk
     * directory tree (already included by createBackupArchive's
     * file/directory loop) IS the backup. createBackupArchive's
     * `kind !== 'fs'` guard ensures this method is never called in
     * production. Returning null is the documented "nothing to dump"
     * signal.
     * @param {string} _handle
     * @returns {Promise<null>}
     */
    async dumpUser(_handle) {
        return null;
    }

    /**
     * fs restore is a no-op. Backup files for fs mode are
     * regular files inside the ZIP; restoreUserBackupArchive extracts them
     * via fs writes, not via this method. The engine.kind === 'fs' branch
     * in the restore handler does not call this.
     * @param {string} _handle
     * @param {import('node:stream').Readable} _stream
     * @returns {Promise<void>}
     */
    async restoreUser(_handle, _stream) {
        // Intentionally empty.
    }

    async close() { /* nothing to do */ }
}
