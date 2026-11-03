/**
 * Card asset serving — card-embedded html/css/js/images extracted to the
 * per-card directory, addressed inside the mount space
 * `/card-runtime/m/<id>/<asset path>` so relative references (`./lib/x.js`,
 * `img/a.png`) resolve under the mount without any rewriting.
 *
 * Entry contract:
 *   - document entry (`entry: 'panel.html'`) → served verbatim at its own
 *     path; `/m/<id>/` redirects there.
 *   - module entry (`entry: 'index.js'`, Luker convention) → `/m/<id>/`
 *     serves a synthesized shell: minimal document + optional `style.css`
 *     auto-link + `<script type="module">`. The ctx/TH bridge is NOT injected
 *     here — the host mints the bridge nonce and injects the shim (or passes
 *     `?shim=t0` to have the server splice the shim tag before card code).
 *
 * Every response on this surface carries the per-card CSP + the opaque-origin
 * headers from csp.js — including non-document assets, harmlessly.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { createRequire } from 'node:module';
import { resolveAssetPath, entryFileExists } from './mounts.js';
import { cardRuntimeSecurityHeaders } from './csp.js';

/** Server-shim names the `?shim=` knob may splice into entry documents. */
const SHIM_URLS = new Map([
    ['t0', '/card-runtime/shim/t0.js'],
]);

function selfOrigin(request) {
    return `${request.protocol}://${request.get('host')}`;
}

function setSecurityHeaders(request, response, mount) {
    const headers = cardRuntimeSecurityHeaders({
        selfOrigin: selfOrigin(request),
        permissions: mount.manifest.permissions,
    });
    for (const [k, v] of Object.entries(headers)) response.set(k, v);
}

/**
 * Splice a `<script src>` shim tag as early as possible — before card code.
 * @param {string} html
 * @param {string} shimUrl
 */
export function injectShimTag(html, shimUrl) {
    const tag = `<script src="${shimUrl}" data-card-runtime-shim></script>`;
    const head = html.match(/<head[^>]*>/i);
    if (head) {
        const at = head.index + head[0].length;
        return `${html.slice(0, at)}${tag}${html.slice(at)}`;
    }
    const htmlTag = html.match(/<html[^>]*>/i);
    if (htmlTag) {
        const at = htmlTag.index + htmlTag[0].length;
        return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
    }
    return `${tag}${html}`;
}

/**
 * Synthesized shell for ES-module entries (Luker CardApp convention:
 * module exports init(ctx); style.css in the same folder is auto-loaded).
 * @param {object} mount
 * @param {string} shimUrl|null
 * @param {string} nonceAttr unused for now — host bridges over postMessage
 */
export function buildModuleShell(mount, shimUrl = null) {
    const entryDir = path.posix.dirname(mount.manifest.entry);
    const stylePath = entryDir === '.' ? 'style.css' : `${entryDir}/style.css`;
    const hasStyle = !!resolveAssetPath(mount, stylePath);
    const shim = shimUrl ? `<script src="${shimUrl}" data-card-runtime-shim></script>\n` : '';
    const style = hasStyle ? `<link rel="stylesheet" href="./${stylePath}">` : '';
    return [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="referrer" content="no-referrer">',
        `<title>${escapeHtml(mount.charId)} · card app</title>`,
        shim + style,
        '</head>',
        '<body>',
        '<div id="card-app-container"></div>',
        `<script type="module" src="./${mount.manifest.entry}"></script>`,
        '</body>',
        '</html>',
    ].filter(Boolean).join('\n');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendDocument(request, response, mount, body) {
    setSecurityHeaders(request, response, mount);
    const etag = `W/"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)}"`;
    if (request.headers['if-none-match'] === etag) return response.status(304).end();
    response.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-cache, max-age=1',
        'Vary': 'Cookie',
        'ETag': etag,
    });
    return response.send(body);
}

/**
 * `GET /m/:id/` — entry document: redirect for document entries, synthesized
 * shell for module entries. `?shim=t0` splices the shim tag for web hosts that
 * cannot inject before card scripts.
 */
export function entryHandler(request, response) {
    const mount = request.cardRuntimeMount;
    const shimUrl = SHIM_URLS.get(String(request.query.shim || '')) || null;
    if (mount.manifest.entryKind === 'document') {
        const target = `./${mount.manifest.entry}${shimUrl ? '?shim=' + encodeURIComponent(String(request.query.shim)) : ''}`;
        return response.redirect(302, target);
    }
    if (!entryFileExists(mount)) {
        return response.status(404).json({ error: 'entry_not_found' });
    }
    return sendDocument(request, response, mount, buildModuleShell(mount, shimUrl));
}

/**
 * `GET /m/:id/*` — any file inside the card's asset dir. HTML documents get
 * the document treatment (CSP + optional shim splice); everything else is a
 * byte asset with ETag revalidation.
 */
export function assetHandler(request, response) {
    const mount = request.cardRuntimeMount;
    const relPath = request.params[0] || '';
    if (relPath === 'cdn' || relPath.startsWith('cdn/')) {
        return response.status(404).json({ error: 'reserved_prefix' });
    }
    const fullPath = resolveAssetPath(mount, relPath);
    if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return response.status(404).json({ error: 'asset_not_found' });
    }

    setSecurityHeaders(request, response, mount);
    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
        let body = fs.readFileSync(fullPath, 'utf8');
        const shimUrl = SHIM_URLS.get(String(request.query.shim || '')) || null;
        if (shimUrl) body = injectShimTag(body, shimUrl);
        return sendDocument(request, response, mount, body);
    }

    const contentType = mime.lookup(fullPath) || 'application/octet-stream';
    const stat = fs.statSync(fullPath);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) return response.status(304).end();
    response.set({
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'private, no-cache, max-age=1',
        'Vary': 'Cookie',
        'ETag': etag,
    });
    return response.sendFile(fullPath);
}

// ---------- host-side shim (public, session-free) ----------
// The TH-face T0 runtime from @uberge/panel-shim, re-served on the public
// surface so WebViews without a session can load it (mirrors
// endpoints/panel-shim.js, which stays on the authenticated side for admin use).

let shimCache = null;

function loadShimRuntime() {
    if (shimCache) return shimCache;
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('@uberge/panel-shim/package.json'));
    const source = fs.readFileSync(path.join(pkgDir, 'src', 'runtime.js'), 'utf8');
    const etag = `W/"${crypto.createHash('sha256').update(source).digest('hex').slice(0, 24)}"`;
    shimCache = { source, etag };
    return shimCache;
}

/** `GET /shim/:name` — allowlisted host-side scripts (t0 = TH-face shim). */
export function shimHandler(request, response) {
    if (request.params.name !== 't0.js' && request.params.name !== 't0') {
        return response.status(404).json({ error: 'unknown_shim' });
    }
    try {
        const { source, etag } = loadShimRuntime();
        if (request.headers['if-none-match'] === etag) return response.status(304).end();
        response.set({
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, must-revalidate',
            'ETag': etag,
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        return response.send(source);
    } catch (error) {
        console.error('[card-runtime] shim runtime unavailable:', error);
        return response.status(500).json({ error: 'shim_unavailable' });
    }
}
