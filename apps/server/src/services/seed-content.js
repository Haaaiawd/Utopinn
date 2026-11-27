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
 *   - `.git` entries are skipped, matching the CardApp walk/pack
 *     conventions (a seed card's repo history belongs to the seed, not
 *     to the receiving account).
 *
 * The pool is NOT inside any user root (`getAllUserHandles` enumerates
 * `user:` storage keys, not dataRoot subdirectories) and can never
 * collide with a handle (`sanitizeRequestedHandle` maps `_` to `-`).
 */

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
 * Copies every pool entry into the matching user directory.
 * @param {import('../users.js').UserDirectoryList} directories Target user directories
 * @param {object} [options]
 * @param {boolean} [options.dryRun] Report what would be copied without writing
 * @returns {Promise<{copied: string[], skipped: string[], errors: {source: string, error: Error}[]}>}
 */
export async function seedUserDirectories(directories, { dryRun = false } = {}) {
    const report = { copied: [], skipped: [], errors: [] };
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
            try {
                await fs.promises.mkdir(path.dirname(destination), { recursive: true });
                // force:false keeps any file that materialized between the
                // existsSync check and the copy — a concurrent provisioner
                // can never clobber account content through this path.
                await fs.promises.cp(source, destination, { recursive: true, force: false, errorOnExist: false, filter: seedCopyFilter });
                // Pool files may be read-only; the account's copies must
                // stay user-writable (same convention as content-manager).
                setPermissionsSync(destination);
                report.copied.push(destination);
            } catch (error) {
                report.errors.push({ source, error });
            }
        }
    }

    return report;
}
