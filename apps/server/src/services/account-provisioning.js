/**
 * account-provisioning — the starter payload every new account must get.
 *
 * A new account is provisioned by TWO passes, always in this order:
 *
 *   1. checkForNewContent — the scaffold/content index pass: delivers
 *      index-declared single files (the release starter card PNG lands in
 *      characters/, settings seeds via SettingsRepo, etc.).
 *   2. seedUserDirectories — the `<dataRoot>/_seed` pool pass: delivers the
 *      directory payloads scaffold cannot carry (card-apps/<name>/ trees,
 *      world books). Copy-only, never overwrites — user edits always win.
 *
 * Every account-creation site calls this exactly once: invite-code
 * registration, OAuth signup, admin account creation, and the bootstrap
 * default-user (guarded there by "just created" so restarts never re-seed).
 * Deliberate backfill for pre-existing accounts stays with
 * scripts/seed-accounts.js — that is a maintenance action, not creation.
 *
 * Failure posture: provisioning must never fail account creation. Both
 * passes are isolated — a broken pack or a failed card copy warns and the
 * account still works; missing pieces are recoverable by the backfill
 * script on the next deliberate run.
 */

import path from 'node:path';

import { checkForNewContent, CONTENT_TYPES } from '../endpoints/content-manager.js';
import { checkUserStorageQuota } from '../users.js';
import { seedUserDirectories } from './seed-content.js';

/**
 * Provisions a just-created account with the scaffold content pass and the
 * `_seed` pool pass, in that order. Never throws — a provisioning failure
 * is logged, not propagated, because it must not fail account creation.
 * @param {import('../users.js').UserDirectoryList} directories The new account's directories
 * @param {object} [options]
 * @param {object} [options.profile] The account record just created — used to
 *   build the quota reservation shared-card installation applies
 *   (checkUserStorageQuota with { fresh: true }), so starter entries that
 *   would push the account over quota are skipped whole and reported, never
 *   partially copied. A missing profile degrades to no accounting.
 * @param {(bytes: number) => Promise<{usageBytes:number, quotaBytes:number, message:string}|null>} [options.checkQuota]
 *   Explicit quota reservation override — wins over the profile-derived
 *   guard when both are given (tests, and callers with their own guard).
 * @returns {Promise<{copied: string[], skipped: string[], quotaSkipped: object[], errors: object[]} | null>}
 *   The pool report; null when the pool pass itself failed outright.
 */
export async function provisionNewAccount(directories, { profile = null, checkQuota } = {}) {
    const handle = path.basename(directories?.root ?? '');

    // Content check failures are already contained inside checkForNewContent
    // (it reports and continues); the wrap here keeps that posture structural —
    // account creation must not hinge on a content pack.
    try {
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
    } catch (error) {
        console.error(`Content provisioning failed for ${handle}:`, error);
    }

    const quotaGuard = checkQuota ?? (profile
        ? (bytes) => checkUserStorageQuota({ profile, directories }, bytes, { fresh: true })
        : null);

    try {
        const seedReport = await seedUserDirectories(directories, { checkQuota: quotaGuard });
        for (const skipped of seedReport.quotaSkipped) {
            console.warn(`Seed entry skipped for ${handle} (over quota, ${skipped.bytes} B): ${skipped.destination}`);
        }
        for (const failure of seedReport.errors) {
            console.error(`Seed content copy failed for ${handle}: ${failure.source}:`, failure.error);
        }
        return seedReport;
    } catch (error) {
        console.error(`Seed content copy failed for ${handle}:`, error);
        return null;
    }
}
