/**
 * Invite-create form parsing — extracted pure so both the admin block and the
 * node --test suite share the exact contract the server enforces in
 * invites.js normalizeMaxUses/normalizeExpiresAt:
 *   · maxUses: ''/'0' → 0 (unlimited); otherwise a positive integer.
 *     Negatives, fractions and non-numbers are rejected — never silently
 *     clamped into "unlimited" (the review hole this closes).
 *   · days:   ''/'0' → null (never expires); otherwise a positive number of
 *     days (fractional allowed — the server takes the ms timestamp).
 */

export type InviteCreateParse =
    | { ok: true; maxUses: number; expiresAt: number | null }
    | { ok: false; badMaxUses: boolean; badDays: boolean };

export function parseInviteCreateInput(
    maxUsesInput: string,
    daysInput: string,
    now: number = Date.now(),
): InviteCreateParse {
    let badMaxUses = false;
    let badDays = false;

    const rawUses = maxUsesInput.trim();
    let maxUses = 0;
    if (rawUses !== '' && rawUses !== '0') {
        const n = Number(rawUses);
        if (!Number.isInteger(n) || n <= 0) {
            badMaxUses = true;
        } else {
            maxUses = n;
        }
    }

    const rawDays = daysInput.trim();
    let expiresAt: number | null = null;
    if (rawDays !== '' && rawDays !== '0') {
        const d = Number(rawDays);
        if (!Number.isFinite(d) || d <= 0) {
            badDays = true;
        } else {
            expiresAt = now + d * 86400000;
        }
    }

    if (badMaxUses || badDays) {
        return { ok: false, badMaxUses, badDays };
    }
    return { ok: true, maxUses, expiresAt };
}
