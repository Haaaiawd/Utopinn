// SPDX-License-Identifier: AGPL-3.0-or-later

// Registration invite codes: admin-minted, use-limited, revocable tokens that
// gate POST /api/users/register when accountRegistration.requireInviteCode is
// on. Records live in the same node-persist account store as users but under
// their own `invite:` prefix — `getAllUserHandles()` scans `user:` only, so
// invites never leak into the account list.
//
// Concurrency: Luker is a single-process server, so read-check-write cycles
// are serialized through `enqueueWrite` (same pattern as announcements.js).
// A use is consumed inside the queue, which makes two simultaneous
// registrations against the last remaining use a first-come-first-served
// race instead of a double-spend. Clustered deployments would need a shared
// store transaction; that is out of scope here.

import crypto from 'node:crypto';

import storage from 'node-persist';

const INVITE_PREFIX = 'invite:';
const CODE_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const GENERATED_CODE_BYTES = 12; // 96 bits → 16 base64url chars
export const INVITE_NOTE_MAX = 200;

/**
 * @typedef {Object} InviteCode
 * @property {string} code - The invite code itself (also the storage key suffix)
 * @property {number} created - Creation timestamp in ms
 * @property {string} createdBy - Handle of the admin who minted it
 * @property {number} maxUses - Use limit; 0 means unlimited
 * @property {number} usedCount - Times the code has been consumed
 * @property {string[]} usedBy - Handles that consumed the code (audit trail)
 * @property {number|null} expiresAt - Optional expiry timestamp in ms; null = never
 * @property {string} note - Admin note (e.g. which group the code was posted to)
 * @property {boolean} revoked - Revoked codes can no longer be consumed
 * @property {number} [revokedAt] - Revocation timestamp in ms
 */

/**
 * @typedef {Object} StorageLike
 * @property {(key: string) => Promise<any>} getItem
 * @property {(key: string, value: any) => Promise<any>} setItem
 * @property {(filter?: (item: {key: string, value: any}) => boolean) => Promise<any[]>} values
 */

function defaultStorage() {
    return storage;
}

class ValidationError extends Error {
    constructor(message, code = 'invalid_invite_payload') {
        super(message);
        this.name = 'InviteValidationError';
        this.code = code;
    }
}

export { ValidationError };

/**
 * Serializes all read-modify-write operations on invite records so two
 * requests racing on the same code cannot interleave getItem/setItem.
 */
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => undefined);
    return next;
}

function inviteKey(code) {
    return `${INVITE_PREFIX}${code}`;
}

function generateCode() {
    return crypto.randomBytes(GENERATED_CODE_BYTES).toString('base64url');
}

function normalizeMaxUses(value) {
    // Use-limit contract: absent/null/'' or exactly 0 mean "unlimited"
    // (the stored canonical value is 0). Every other accepted value must be
    // a positive integer — negative and fractional inputs are rejected
    // rather than silently clamped/floored: `0 < x < 1` used to normalize
    // to 0, i.e. a "5 uses" typo could mint an unlimited code.
    if (value === undefined || value === null || value === '') {
        return 0;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new ValidationError(`Invalid maxUses: ${String(value)}. Must be a number.`);
    }
    if (parsed === 0) {
        return 0;
    }
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new ValidationError(`Invalid maxUses: ${String(value)}. Must be a positive integer, or 0/empty for unlimited.`);
    }
    return parsed;
}

function normalizeExpiresAt(value) {
    if (value === undefined || value === null || value === '' || value === 0) {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ValidationError(`Invalid expiresAt: ${String(value)}. Must be a positive ms timestamp.`);
    }
    return Math.floor(parsed);
}

function normalizeNote(value) {
    const trimmed = String(value || '').trim();
    if (trimmed.length > INVITE_NOTE_MAX) {
        throw new ValidationError(`Note exceeds ${INVITE_NOTE_MAX} characters.`);
    }
    return trimmed;
}

function normalizeStoredInvite(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    return {
        code: String(raw.code || ''),
        created: Number(raw.created) || 0,
        createdBy: String(raw.createdBy || ''),
        maxUses: Number.isFinite(Number(raw.maxUses)) ? Math.max(0, Math.floor(Number(raw.maxUses))) : 0,
        usedCount: Number.isFinite(Number(raw.usedCount)) ? Math.max(0, Math.floor(Number(raw.usedCount))) : 0,
        usedBy: Array.isArray(raw.usedBy) ? raw.usedBy.map(String) : [],
        expiresAt: Number.isFinite(Number(raw.expiresAt)) && Number(raw.expiresAt) > 0 ? Math.floor(Number(raw.expiresAt)) : null,
        note: String(raw.note || ''),
        revoked: Boolean(raw.revoked),
        ...(raw.revokedAt ? { revokedAt: Number(raw.revokedAt) } : {}),
    };
}

/**
 * Lists all invite codes, newest first. Admin-only surface — the records are
 * returned verbatim (usedBy included) since invite codes are meant to be
 * shared with registrants anyway; the only secret-grade field is the code
 * and admins are the ones handing it out.
 * @param {{ store?: StorageLike }} [options]
 * @returns {Promise<InviteCode[]>}
 */
export async function listInvites({ store = defaultStorage() } = {}) {
    const values = await store.values(x => x.key.startsWith(INVITE_PREFIX));
    return values
        .map(normalizeStoredInvite)
        .filter(Boolean)
        .sort((a, b) => b.created - a.created);
}

/**
 * Creates an invite code. Pass `code` to use an admin-chosen code; otherwise
 * a 16-character base64url code is generated with crypto.randomBytes.
 * @param {{ code?: string, maxUses?: number, expiresAt?: number|null, note?: string, createdBy: string, store?: StorageLike }} input
 * @returns {Promise<InviteCode>}
 */
export async function createInvite({ code, maxUses, expiresAt, note, createdBy, store = defaultStorage() }) {
    const cleanMaxUses = normalizeMaxUses(maxUses);
    const cleanExpiresAt = normalizeExpiresAt(expiresAt);
    const cleanNote = normalizeNote(note);
    const cleanCreatedBy = String(createdBy || '').trim() || 'unknown';
    const requestedCode = String(code || '').trim();
    if (requestedCode && !CODE_PATTERN.test(requestedCode)) {
        throw new ValidationError(`Invalid code: must match ${CODE_PATTERN} (4-64 chars of [A-Za-z0-9_-]).`);
    }

    return enqueueWrite(async () => {
        let finalCode = requestedCode;
        if (finalCode) {
            if (await store.getItem(inviteKey(finalCode))) {
                throw new ValidationError(`Invite code already exists: ${finalCode}`, 'invite_code_exists');
            }
        } else {
            // CSPRNG codes are effectively unique; loop anyway so a freak
            // collision retries instead of clobbering an existing record.
            do {
                finalCode = generateCode();
            } while (await store.getItem(inviteKey(finalCode)));
        }

        const invite = {
            code: finalCode,
            created: Date.now(),
            createdBy: cleanCreatedBy,
            maxUses: cleanMaxUses,
            usedCount: 0,
            usedBy: [],
            expiresAt: cleanExpiresAt,
            note: cleanNote,
            revoked: false,
        };
        await store.setItem(inviteKey(finalCode), invite);
        return { ...invite, usedBy: [] };
    });
}

/**
 * Soft-deletes an invite by marking it revoked. Returns the updated record,
 * or null when the code does not exist.
 * @param {{ code: string, store?: StorageLike }} input
 * @returns {Promise<InviteCode|null>}
 */
export async function revokeInvite({ code, store = defaultStorage() }) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) {
        throw new ValidationError('code is required.');
    }

    return enqueueWrite(async () => {
        const invite = normalizeStoredInvite(await store.getItem(inviteKey(cleanCode)));
        if (!invite) {
            return null;
        }
        if (!invite.revoked) {
            invite.revoked = true;
            invite.revokedAt = Date.now();
            await store.setItem(inviteKey(cleanCode), invite);
        }
        return invite;
    });
}

/**
 * Consumes one use of an invite inside the write queue, so the
 * check-and-increment is atomic within the process. Returns a discriminated
 * result instead of throwing so the register route can map each failure to a
 * stable error code without leaking how many uses remain.
 * @param {{ code: string, handle: string, store?: StorageLike, now?: number }} input
 * @returns {Promise<{ ok: true } | { ok: false, code: 'invalid_invite_code' | 'invite_code_revoked' | 'invite_code_expired' | 'invite_code_exhausted' }>}
 */
export async function consumeInvite({ code, handle, store = defaultStorage(), now }) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) {
        return { ok: false, code: 'invalid_invite_code' };
    }

    return enqueueWrite(async () => {
        // Expiry is judged inside the critical section: a consume can wait
        // in the write queue behind another mutation, and a code that was
        // still valid when the call arrived may expire during the wait.
        const at = now ?? Date.now();
        const invite = normalizeStoredInvite(await store.getItem(inviteKey(cleanCode)));
        if (!invite) {
            return { ok: false, code: 'invalid_invite_code' };
        }
        if (invite.revoked) {
            return { ok: false, code: 'invite_code_revoked' };
        }
        if (invite.expiresAt !== null && at > invite.expiresAt) {
            return { ok: false, code: 'invite_code_expired' };
        }
        if (invite.maxUses > 0 && invite.usedCount >= invite.maxUses) {
            return { ok: false, code: 'invite_code_exhausted' };
        }

        invite.usedCount += 1;
        invite.usedBy.push(String(handle || ''));
        await store.setItem(inviteKey(cleanCode), invite);
        return { ok: true };
    });
}

/**
 * Refunds one previously consumed use — used when registration fails after
 * consumption so a failed attempt does not burn the slot. Best-effort and
 * idempotent for a given handle (one consume per handle is guaranteed by the
 * register route's uniqueness check).
 * @param {{ code: string, handle: string, store?: StorageLike }} input
 * @returns {Promise<boolean>} Whether a record was found and adjusted
 */
export async function refundInvite({ code, handle, store = defaultStorage() }) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) {
        return false;
    }

    return enqueueWrite(async () => {
        const invite = normalizeStoredInvite(await store.getItem(inviteKey(cleanCode)));
        if (!invite) {
            return false;
        }
        const idx = invite.usedBy.lastIndexOf(String(handle || ''));
        if (idx === -1) {
            return true;
        }
        invite.usedBy.splice(idx, 1);
        invite.usedCount = Math.max(0, invite.usedCount - 1);
        await store.setItem(inviteKey(cleanCode), invite);
        return true;
    });
}
