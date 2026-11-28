/**
 * seed-content — instance-level seed pool materialized into accounts.
 *
 * `<dataRoot>/_seed/` is an operator-provisioned skeleton user home: each
 * subdirectory is named after a USER_DIRECTORY_TEMPLATE value and holds
 * entries copied into the matching per-account directory when a new
 * account registers. Example: `_seed/card-apps/我没想当掌门啊/` lands at
 * `<dataRoot>/<handle>/card-apps/我没想当掌门啊/`.
 *
 * Semantics:
 *   - Copy-only: nothing under _seed is reachable by any user-facing API.
 *     It is not a merged-read layer like `_library` (shared characters) —
 *     reads of the pool would bypass per-user isolation, so no endpoint
 *     resolves against it.
 *   - Never overwrites: an already-existing destination entry is skipped
 *     wholesale, so the pass is idempotent and user edits always win.
 *   - Non-fatal: a missing or unreadable pool, and any individual entry
 *     that fails to copy, is reported on the return value instead of
 *     thrown — callers must not let seeding block account creation.
 *   - Atomic publish: entries copy into a staging sibling first and are
 *     linked/moved into place only when complete. A mid-copy failure
 *     never leaves a partial destination behind (which the skip-on-exists
 *     rule would then preserve forever — the poisoned-directory bug).
 *   - `.git` entries are skipped, matching the CardApp walk/pack
 *     conventions (a seed card's repo history belongs to the seed, not
 *     to the receiving account).
 *
 * The pool is NOT inside any user root (`getAllUserHandles` enumerates
 * `user:` storage keys, not dataRoot subdirectories) and can never
 * collide with a handle (`sanitizeRequestedHandle` maps `_` to `-`).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { setPermissionsSync } from '../util.js';

/** Seed pool root directory name (instance-level, not per-user). */
export const SEED_ROOT_DIRNAME = '_seed';

/** Entry names that are never copied out of the pool. */
const SEED_ENTRY_EXCLUSIONS = new Set(['.git']);

/**
 * fs.cp filter — the top-level exclusion only sees the pool's first level;
 * a seed card may still carry its own `.git` (CardApp Studio versioning)
 * deeper in the tree, which must not follow it into the account.
 */
const seedCopyFilter = (source) => !SEED_ENTRY_EXCLUSIONS.has(path.basename(source));

/**
 * `<dataRoot>/_seed`. When DATA_ROOT is unset (pure unit tests) it is
 * derived from `directories.root` (`<dataRoot>/<handle>`) — same strategy
 * as getSharedCharactersDir. Neither available → null, the pool misses.
 * @param {import('../users.js').UserDirectoryList} [directories]
 * @returns {string|null}
 */
export function getSeedRoot(directories) {
    const dataRoot = globalThis.DATA_ROOT
        || (typeof directories?.root === 'string' && directories.root ? path.dirname(directories.root) : '');
    return dataRoot ? path.join(dataRoot, SEED_ROOT_DIRNAME) : null;
}

/**
 * Estimated byte footprint of copying a pool entry — mirrors the copy
 * plan exactly (SEED_ENTRY_EXCLUSIONS never land) so quota enforcement
 * neither over- nor under-counts. Same accounting primitive as
 * checkUserStorageQuota's usage measurement (getDirectorySizeBytes).
 * @param {string} source Pool entry absolute path
 * @returns {Promise<number>} bytes (0 when unreadable — the copy will fail on its own)
 */
async function estimateSeedEntryBytes(source) {
    let stat;
    try {
        stat = await fs.promises.stat(source);
    } catch {
        return 0;
    }
    if (!stat.isDirectory()) {
        return stat.size;
    }
    // Same walk-and-tolerate semantics as admin-settings'
    // getDirectorySizeBytes, plus the copy filter's exclusions.
    let total = 0;
    const stack = [source];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (SEED_ENTRY_EXCLUSIONS.has(entry.name)) {
                continue;
            }
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            try {
                total += (await fs.promises.stat(fullPath)).size;
            } catch {
                // Unreadable files surface as copy errors, not budget.
            }
        }
    }
    return total;
}

/**
 * Copies every pool entry into the matching user directory.
 * @param {import('../users.js').UserDirectoryList} directories Target user directories
 * @param {object} [options]
 * @param {boolean} [options.dryRun] Report what would be copied without writing
 * @param {(bytes: number) => Promise<{usageBytes:number, quotaBytes:number, message:string}|null>} [options.checkQuota]
 *   Optional pre-copy reservation: called with the estimated entry size and
 *   must resolve to a violation descriptor when the write would overflow the
 *   account quota (checkUserStorageQuota with {fresh:true} is the intended
 *   implementation — the same accounting shared-card installation uses).
 *   A violation skips the entry wholesale and reports it on `quotaSkipped`.
 * @returns {Promise<{copied: string[], skipped: string[], quotaSkipped: {destination:string, bytes:number, message:string}[], errors: {source: string, error: Error}[]}>}
 */
export async function seedUserDirectories(directories, { dryRun = false, checkQuota = null } = {}) {
    const report = { copied: [], skipped: [], quotaSkipped: [], errors: [] };
    const seedRoot = getSeedRoot(directories);
    if (!seedRoot || typeof directories !== 'object' || !directories) {
        return report;
    }

    // Probe the pool root once up front: a missing pool is the normal case
    // (empty report), while an unreadable one fails every per-key readdir
    // below — report it once instead of once per template key.
    try {
        await fs.promises.readdir(seedRoot);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            report.errors.push({ source: seedRoot, error });
        }
        return report;
    }

    for (const [key, templateDir] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
        // `root` is '' — joining it would address the pool itself, and the
        // whole point of the pool is that it is NOT the user root.
        if (key === 'root' || !templateDir || typeof directories[key] !== 'string' || !directories[key]) {
            continue;
        }

        const seedDir = path.join(seedRoot, templateDir);
        let entries;
        try {
            entries = await fs.promises.readdir(seedDir, { withFileTypes: true });
        } catch (error) {
            // Missing/empty subdir is the normal case — only a real read
            // failure (ENOTDIR, EACCES, …) is worth reporting.
            if (error?.code !== 'ENOENT') {
                report.errors.push({ source: seedDir, error });
            }
            continue;
        }

        for (const entry of entries) {
            if (SEED_ENTRY_EXCLUSIONS.has(entry.name)) {
                continue;
            }
            const source = path.join(seedDir, entry.name);
            const destination = path.join(directories[key], entry.name);
            if (fs.existsSync(destination)) {
                report.skipped.push(destination);
                continue;
            }
            if (dryRun) {
                report.copied.push(destination);
                continue;
            }
            if (checkQuota) {
                const estimate = await estimateSeedEntryBytes(source);
                const violation = await checkQuota(estimate);
                if (violation) {
                    report.quotaSkipped.push({ destination, bytes: estimate, message: violation.message });
                    continue;
                }
            }

            const parent = path.dirname(destination);
            // Same-filesystem staging sibling — publish is rename/link,
            // never a second copy. `.seed-*` is inert to every reader of
            // the target directory (card libraries address named entries).
            const staging = path.join(parent, `.seed-${entry.name}-${crypto.randomBytes(6).toString('hex')}`);
            // True once the destination name is ours to unwind on failure.
            let claimed = false;
            try {
                await fs.promises.mkdir(parent, { recursive: true });
                // fs.cp materializes the destination before copying its
                // children, so a nested read error would leave a partial
                // directory that the existsSync check above then preserves
                // forever. Copying into staging keeps the failure invisible;
                // the account only ever sees complete entries.
                await fs.promises.cp(source, staging, { recursive: true, force: false, errorOnExist: false, filter: seedCopyFilter });
                // Pool files may be read-only; the account's copies must
                // stay user-writable (same convention as content-manager).
                setPermissionsSync(staging);
                const stagedStat = await fs.promises.stat(staging);
                if (stagedStat.isDirectory()) {
                    // mkdir is the atomic claim: EEXIST means the name was
                    // taken after the check above — user content always wins.
                    await fs.promises.mkdir(destination);
                    claimed = true;
                    for (const child of await fs.promises.readdir(staging)) {
                        await fs.promises.rename(path.join(staging, child), path.join(destination, child));
                    }
                } else {
                    // link(2) is the atomic no-clobber publish for files.
                    await fs.promises.link(staging, destination);
                    claimed = true;
                }
                report.copied.push(destination);
            } catch (error) {
                if (error?.code === 'EEXIST') {
                    // Lost the race for the name — whoever owns it wins.
                    report.skipped.push(destination);
                } else {
                    if (claimed) {
                        // A mid-publish failure leaves our own partial claim
                        // behind — unwind it so the next pass retries clean.
                        await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {});
                    }
                    report.errors.push({ source, error });
                }
            } finally {
                await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    return report;
}
