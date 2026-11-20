/**
 * card-runtime — the server-side hosting substrate for untrusted card code
 * (CardApp panel apps). Two surfaces:
 *
 * Public surface (`cardRuntimePublicRouter`, mounted at `/card-runtime`
 * BEFORE requireLoginMiddleware — see server-main.js):
 *   GET /card-runtime/m/:mountId/        entry document (redirect for
 *                                        document entries; synthesized shell
 *                                        for module entries; ?shim=t0 splices
 *                                        the TH shim tag before card code)
 *   GET /card-runtime/m/:mountId/cdn     mount-scoped CDN proxy
 *                                        (?url=…&integrity=sha256-…)
 *   GET /card-runtime/m/:mountId/*       card asset inside the mount space
 *   GET /card-runtime/shim/t0.js         TH-face shim runtime (host code)
 *   GET /card-runtime/shim/ctx.js        ctx-face shim runtime (module-entry init(ctx) face)
 *
 *   Authorization = the mountId capability (128-bit random, sliding TTL).
 *   No session cookie is required OR consulted — the WebView never gets user
 *   authority. CSRF does not apply (GET-only surface). Session/CSRF posture:
 *   see mounts.js and csp.js headers.
 *
 * Admin surface (`cardRuntimeApiRouter`, mounted at `/api/card-runtime`
 * inside setupPrivateEndpoints — full session + CSRF):
 *   POST /api/card-runtime/mounts        {charId, ttlMs?} → mount bundle
 *                                        (entryUrl, cdnUrl, csp, manifest…)
 *   GET  /api/card-runtime/mounts        list own mounts
 *   DELETE /api/card-runtime/mounts/:id  revoke own mount
 *   GET  /api/card-runtime/cards/:charId/manifest  dry-run manifest validation
 */

import express from 'express';
import { resolveMount, createMount, revokeMount, listMounts, publicMount, loadCardData, CardRuntimeError } from './mounts.js';
import { getRawCardApp, parseCardAppManifest } from './manifest.js';
import { buildCardRuntimeCsp } from './csp.js';
import { cdnProxyHandler } from './cdn-proxy.js';
import { entryHandler, assetHandler, shimHandler } from './assets.js';
import sanitize from 'sanitize-filename';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Public surface (capability-gated, session-free)
// ---------------------------------------------------------------------------

export const cardRuntimePublicRouter = express.Router();

/** Resolve + slide the mount capability; uniform 404 on failure. */
function useMount(request, response, next) {
    const mount = resolveMount(request.params.mountId);
    if (!mount) {
        response.set('Cache-Control', 'no-store');
        return response.status(404).json({ error: 'mount_not_found' });
    }
    request.cardRuntimeMount = mount;
    next();
}

cardRuntimePublicRouter.get('/shim/:name', shimHandler);
cardRuntimePublicRouter.get('/m/:mountId/cdn', useMount, async (request, response) => {
    try {
        await cdnProxyHandler(request, response, request.cardRuntimeMount);
    } catch (error) {
        console.error('[card-runtime] cdn proxy failed:', error);
        return response.status(502).json({ error: 'cdn_proxy_failed', detail: String(error?.message ?? error) });
    }
});
cardRuntimePublicRouter.get('/m/:mountId', useMount, entryHandler);
cardRuntimePublicRouter.get('/m/:mountId/*', useMount, assetHandler);

// ---------------------------------------------------------------------------
// Admin surface (session + CSRF, mounted inside setupPrivateEndpoints)
// ---------------------------------------------------------------------------

export const cardRuntimeApiRouter = express.Router();

function selfOrigin(request) {
    return `${request.protocol}://${request.get('host')}`;
}

/**
 * POST /mounts — mint a mount for a card's card_app.
 * Body: { charId: string, ttlMs?: number, chatName?: string }
 * → 201 { mountId, entryUrl, assetBaseUrl, cdnUrl, shimUrl, ctxShimUrl, csp, manifest, … }
 */
cardRuntimeApiRouter.post('/mounts', async (request, response) => {
    try {
        const charId = String(request.body?.charId ?? request.body?.charDir ?? '').trim();
        const record = await createMount({
            handle: request.user?.profile?.handle || '',
            directories: request.user.directories,
            charId,
            ttlMs: request.body?.ttlMs,
            chatName: request.body?.chatName,
        });
        const bundle = publicMount(record);
        bundle.csp = buildCardRuntimeCsp({
            selfOrigin: selfOrigin(request),
            permissions: record.manifest.permissions,
        });
        return response.status(201).json(bundle);
    } catch (error) {
        if (error instanceof CardRuntimeError) {
            return response.status(error.status).json({ error: error.code, detail: error.message, ...error.extra });
        }
        console.error('[card-runtime] mount failed:', error);
        return response.status(500).json({ error: 'mount_failed', detail: String(error?.message ?? error) });
    }
});

/** GET /mounts — the caller's live mounts. */
cardRuntimeApiRouter.get('/mounts', (request, response) => {
    return response.json({ mounts: listMounts(request.user?.profile?.handle || '') });
});

/** DELETE /mounts/:mountId — owner-scoped revoke. */
cardRuntimeApiRouter.delete('/mounts/:mountId', (request, response) => {
    const mount = resolveMount(request.params.mountId);
    if (!mount || mount.handle !== (request.user?.profile?.handle || '')) {
        return response.status(404).json({ error: 'mount_not_found' });
    }
    revokeMount(mount.id);
    return response.sendStatus(204);
});

/**
 * GET /cards/:charId/manifest — dry-run manifest validation for card-info UI /
 * debugging. Never mounts anything. 200 with {ok, manifest, errors, warnings}.
 */
cardRuntimeApiRouter.get('/cards/:charId/manifest', async (request, response) => {
    try {
        const charId = sanitize(String(request.params.charId ?? '').trim());
        const avatarPath = path.join(request.user.directories.characters, `${charId}.png`);
        const jsonPath = path.join(request.user.directories.characters, `${charId}.json`);
        if (!charId || path.dirname(avatarPath) !== request.user.directories.characters) {
            return response.status(400).json({ error: 'bad_char_id' });
        }
        if (!fs.existsSync(avatarPath) && !fs.existsSync(jsonPath)) {
            return response.status(404).json({ error: 'character_not_found' });
        }
        const card = await loadCardData(request.user.directories, charId);
        if (!card) return response.status(404).json({ error: 'character_not_found' });
        if (!getRawCardApp(card)) {
            return response.json({ ok: false, errors: ['card has no extensions.card_app declaration'], warnings: [], manifest: null });
        }
        return response.json(parseCardAppManifest(card));
    } catch (error) {
        console.error('[card-runtime] manifest check failed:', error);
        return response.status(500).json({ error: 'manifest_check_failed', detail: String(error?.message ?? error) });
    }
});
