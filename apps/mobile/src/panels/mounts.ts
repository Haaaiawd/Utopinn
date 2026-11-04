// mounts — card-runtime mount lifecycle API (TASK-009).
//   POST   /api/card-runtime/mounts          {charId} → mount bundle
//   DELETE /api/card-runtime/mounts/:mountId         → owner-scoped revoke
// The minted mountId is the capability that authorizes the session-free
// public surface (/card-runtime/m/<id>/…) the WebView loads; the admin
// endpoints themselves ride the normal session+CSRF api-client.
import { ApiError } from '@uberge/api-client';
import { client } from '../api/client';

/** Mount bundle from POST /api/card-runtime/mounts (mounts.js publicMount). */
export interface MountBundle {
    mountId?: string;
    charId?: string;
    entryUrl: string;
    assetBaseUrl?: string;
    cdnUrl?: string;
    shimUrl?: string;
    bridgeNonce?: string;
    manifest?: {
        enabled?: boolean;
        entry?: string;
        entryKind?: 'document' | 'module';
        permissions?: {
            api?: string[];
            sameOrigin?: boolean;
            stateNamespaces?: string[];
        };
    };
    warnings?: string[];
}

/** Mint a mount for a card's card_app. */
export async function mountCardApp(charId: string): Promise<MountBundle> {
    return client().request<MountBundle>('/api/card-runtime/mounts', {
        method: 'POST',
        body: { charId },
    });
}

/** Revoke a mount (best-effort — callers catch; expiry is server-side too). */
export async function revokeMount(mountId: string): Promise<void> {
    await client().request(`/api/card-runtime/mounts/${encodeURIComponent(mountId)}`, {
        method: 'DELETE',
    });
}

/** Stable server error code ('no_card_app', 'card_app_disabled', …) or null. */
export function mountErrorCode(e: unknown): string | null {
    if (e instanceof ApiError && e.body && typeof e.body === 'object') {
        const code = (e.body as { error?: unknown }).error;
        return typeof code === 'string' ? code : null;
    }
    return null;
}
