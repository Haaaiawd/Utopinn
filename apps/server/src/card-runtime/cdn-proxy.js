/**
 * Mount-scoped CDN proxy — the only way card code reaches remote assets.
 *
 * Two-level admission (research: card-runtime-ecosystem.md §2, capability C3):
 *   1. card-declared `card_app.resources.allowlist` / `permissions.network.
 *      allowlist` — exact URLs or `…/*` prefixes admit verbatim;
 *   2. known ecosystem CDN hostnames (jsdelivr family, unpkg, cdnjs, esm.sh,
 *      raw.githubusercontent.com) — domain-level admission;
 *   everything else is 403. No per-card exceptions in the runtime itself.
 *
 * Cache: content-addressed SHA-256. url → {contentHash, meta} index under
 * `<userRoot>/cache/card-runtime-cdn/`; blob stored once by hash. Index
 * entries older than INDEX_TTL_MS are revalidated upstream (etag/last-modified
 * conditionals when available) because jsdelivr @branch URLs drift (~12h).
 * Optional `?integrity=sha256-<hex>` fails loud on content mismatch.
 *
 * Egress safety: upstream fetches go through the untrusted-request agent
 * (blocks private-IP SSRF on every redirect hop), a size cap, and a timeout.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { getUntrustedRequestAgent } from '../private-request-filter.js';
import { isAdmittedByAllowlist } from './manifest.js';

// Keep in sync with packages/formats/src/runtime-profile.ts KNOWN_CDN_HOSTS —
// the runtime-profile detector flags the same hosts as default-allow
// candidates; here they are the domain-level admission tier.
export const KNOWN_CDN_HOSTS = new Set([
    'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net',
    'testingcf.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
    'esm.sh', 'esm.run', 'raw.githubusercontent.com',
]);

const INDEX_TTL_MS = 12 * 60 * 60 * 1000;  // jsdelivr @branch rolling window
const MAX_BYTES = 32 * 1024 * 1024;        // ecosystem libs reach ~30MB
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'UbergeCardRuntime/1.0 (+card-app cdn-proxy)';

/** Upstream media types the sandbox may receive; others → octet-stream. */
const CONTENT_TYPE_MAP = new Map(Object.entries({
    'application/javascript': 'application/javascript; charset=utf-8',
    'application/ecmascript': 'application/javascript; charset=utf-8',
    'text/javascript': 'application/javascript; charset=utf-8',
    'text/ecmascript': 'application/javascript; charset=utf-8',
    'application/x-javascript': 'application/javascript; charset=utf-8',
    'text/css': 'text/css; charset=utf-8',
    'application/json': 'application/json; charset=utf-8',
    'application/manifest+json': 'application/json; charset=utf-8',
    'text/plain': 'text/plain; charset=utf-8',
    'text/markdown': 'text/plain; charset=utf-8',
    'application/wasm': 'application/wasm',
    'image/svg+xml': 'image/svg+xml',
    'image/png': 'image/png',
    'image/jpeg': 'image/jpeg',
    'image/gif': 'image/gif',
    'image/webp': 'image/webp',
    'image/avif': 'image/avif',
    'image/x-icon': 'image/x-icon',
    'image/vnd.microsoft.icon': 'image/vnd.microsoft.icon',
    'font/woff': 'font/woff',
    'font/woff2': 'font/woff2',
    'application/font-woff': 'application/font-woff',
    'application/font-woff2': 'font/woff2',
    'application/vnd.ms-fontobject': 'application/vnd.ms-fontobject',
    'application/x-font-ttf': 'font/ttf',
    'font/ttf': 'font/ttf',
    'font/otf': 'font/otf',
    'audio/mpeg': 'audio/mpeg',
    'audio/ogg': 'audio/ogg',
    'audio/wav': 'audio/wav',
    'audio/mp4': 'audio/mp4',
    'video/mp4': 'video/mp4',
    'video/webm': 'video/webm',
    'application/octet-stream': 'application/octet-stream',
}));

function mapContentType(upstream) {
    const base = String(upstream || '').split(';')[0].trim().toLowerCase();
    return CONTENT_TYPE_MAP.get(base) || 'application/octet-stream';
}

/**
 * Admission decision for a remote URL under a mount's manifest.
 * @param {string} rawUrl
 * @param {object} manifest normalized card_app manifest
 * @returns {{ allowed: boolean, via: 'card'|'known-cdn'|null, url: string|null, error: string|null }}
 */
export function admitRemoteUrl(rawUrl, manifest) {
    if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > 2048) {
        return { allowed: false, via: null, url: null, error: 'missing or oversized url' };
    }
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return { allowed: false, via: null, url: null, error: 'invalid url' };
    }
    if (url.username || url.password) {
        return { allowed: false, via: null, url: null, error: 'credentials in url not allowed' };
    }
    const normalized = url.toString();
    const allowlist = manifest?.permissions?.network?.allowlist || [];
    // Card-declared entries admit verbatim — including http:// when the card
    // explicitly said so (author-domain file hosts exist in the wild).
    if (isAdmittedByAllowlist(normalized, allowlist)) {
        return { allowed: true, via: 'card', url: normalized, error: null };
    }
    if (url.protocol !== 'https:') {
        return { allowed: false, via: null, url: null, error: 'https required outside the card allowlist' };
    }
    if (KNOWN_CDN_HOSTS.has(url.hostname)) {
        return { allowed: true, via: 'known-cdn', url: normalized, error: null };
    }
    return { allowed: false, via: null, url: null, error: 'host not in allowlist' };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const indexKey = (url) => sha256(Buffer.from(url, 'utf8'));

const pathsFor = (cacheDir) => ({
    indexDir: path.join(cacheDir, 'index'),
    blobDir: path.join(cacheDir, 'blobs'),
});

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

/**
 * Resolve + fetch + cache one admitted URL.
 * @param {object} opts
 * @param {string} opts.url normalized admitted URL
 * @param {'card'|'known-cdn'} opts.via admission tier (recorded in meta)
 * @param {string} opts.cacheDir per-user cache root
 * @param {string} [opts.integrity] expected body sha256 (hex) — fail loud on mismatch
 * @param {number} [opts.now] injectable clock (tests)
 * @param {typeof fetch} [opts.fetchImpl] injectable fetch (tests)
 * @returns {Promise<{ status:number, body:Buffer, headers:Record<string,string>, meta:object }>}
 */
export async function fetchCachedRemote({ url, via, cacheDir, integrity, now = Date.now(), fetchImpl = fetch }) {
    const { indexDir, blobDir } = pathsFor(cacheDir);
    const indexPath = path.join(indexDir, `${indexKey(url)}.json`);
    const index = readJson(indexPath);

    // Fast path: fresh index + blob on disk.
    if (index && typeof index.contentHash === 'string' && now - index.fetchedAt < INDEX_TTL_MS) {
        const blobPath = path.join(blobDir, index.contentHash);
        if (fs.existsSync(blobPath)) {
            return {
                status: 200,
                body: fs.readFileSync(blobPath),
                headers: cacheHeaders(index),
                meta: { cache: 'hit', ...index },
            };
        }
    }

    // Revalidate path: conditional request when we kept validators.
    const headers = { 'User-Agent': USER_AGENT, 'Accept': '*/*' };
    if (index?.etag) headers['If-None-Match'] = index.etag;
    if (index?.lastModified) headers['If-Modified-Since'] = index.lastModified;

    let upstream;
    try {
        upstream = await fetchImpl(url, {
            agent: getUntrustedRequestAgent(),
            redirect: 'follow',
            follow: MAX_REDIRECTS,
            size: MAX_BYTES,
            timeout: FETCH_TIMEOUT_MS,
            headers,
        });
    } catch (error) {
        const expiredIndexUsable = index && fs.existsSync(path.join(blobDir, String(index.contentHash)));
        if (expiredIndexUsable) {
            // Upstream down + stale-but-present cache: serve stale, flag it.
            return {
                status: 200,
                body: fs.readFileSync(path.join(blobDir, String(index.contentHash))),
                headers: cacheHeaders(index),
                meta: { cache: 'stale', upstreamError: String(error?.message ?? error), ...index },
            };
        }
        const status = /private IP|Blocked request/i.test(String(error?.message)) ? 403 : 502;
        return {
            status,
            body: Buffer.from(JSON.stringify({ error: status === 403 ? 'ssrf_blocked' : 'upstream_unreachable', detail: String(error?.message ?? error) })),
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            meta: { cache: 'error' },
        };
    }

    if (upstream.status === 304 && index && fs.existsSync(path.join(blobDir, String(index.contentHash)))) {
        const refreshed = { ...index, fetchedAt: now };
        writeAtomic(indexPath, JSON.stringify(refreshed, null, 2));
        return {
            status: 200,
            body: fs.readFileSync(path.join(blobDir, String(index.contentHash))),
            headers: cacheHeaders(refreshed),
            meta: { cache: 'revalidated', ...refreshed },
        };
    }

    if (!upstream.ok) {
        return {
            status: 502,
            body: Buffer.from(JSON.stringify({ error: 'upstream_status', upstream: upstream.status })),
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            meta: { cache: 'error', upstream: upstream.status },
        };
    }

    let body;
    try {
        body = await upstream.buffer();
    } catch (error) {
        return {
            status: 502,
            body: Buffer.from(JSON.stringify({ error: 'upstream_body', detail: String(error?.message ?? error) })),
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            meta: { cache: 'error' },
        };
    }

    if (body.length > MAX_BYTES) {
        return {
            status: 502,
            body: Buffer.from(JSON.stringify({ error: 'too_large', max: MAX_BYTES })),
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            meta: { cache: 'error' },
        };
    }

    const contentHash = sha256(body);
    if (integrity && integrity !== contentHash) {
        return {
            status: 502,
            body: Buffer.from(JSON.stringify({ error: 'integrity_mismatch', expected: integrity, actual: contentHash })),
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            meta: { cache: 'error' },
        };
    }

    const meta = {
        url,
        via,
        contentHash,
        contentType: mapContentType(upstream.headers?.get?.('content-type')),
        size: body.length,
        fetchedAt: now,
        etag: upstream.headers?.get?.('etag') || null,
        lastModified: upstream.headers?.get?.('last-modified') || null,
    };
    const blobPath = path.join(blobDir, contentHash);
    if (!fs.existsSync(blobPath)) writeAtomic(blobPath, body);
    writeAtomic(indexPath, JSON.stringify(meta, null, 2));

    return { status: 200, body, headers: cacheHeaders(meta), meta: { cache: 'miss', ...meta } };
}

function cacheHeaders(meta) {
    return {
        'Content-Type': meta.contentType || 'application/octet-stream',
        'ETag': `"sha256-${meta.contentHash}"`,
        'Digest': `sha-256=${Buffer.from(meta.contentHash, 'hex').toString('base64')}`,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
    };
}

/** Where a mount's cache lives — inside the owning user's data root. */
export function cacheDirForMount(mount) {
    return path.join(mount.directories.root, 'cache', 'card-runtime-cdn');
}

/**
 * Express handler for `GET /card-runtime/m/:mountId/cdn?url=…`.
 * @param {object} mount resolved MountRecord (req.cardRuntimeMount)
 */
export async function cdnProxyHandler(request, response, mount) {
    const rawUrl = request.query.url;
    const decision = admitRemoteUrl(rawUrl, mount.manifest);
    if (!decision.allowed) {
        response.set('Cache-Control', 'no-store');
        return response.status(decision.error === 'invalid url' || decision.error === 'missing or oversized url' ? 400 : 403)
            .json({ error: 'cdn_url_not_allowed', detail: decision.error });
    }
    let integrity;
    const integrityParam = request.query.integrity;
    if (typeof integrityParam === 'string' && integrityParam.startsWith('sha256-')) {
        integrity = integrityParam.slice(7).toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(integrity)) {
            return response.status(400).json({ error: 'bad_integrity', detail: 'want sha256-<64 hex>' });
        }
    }

    const result = await fetchCachedRemote({
        url: decision.url,
        via: decision.via,
        cacheDir: cacheDirForMount(mount),
        integrity,
        fetchImpl: request.app?.locals?.cardRuntimeFetch || fetch,
    });

    for (const [k, v] of Object.entries(result.headers)) response.set(k, v);
    response.set('X-Card-Runtime-Cache', String(result.meta?.cache || 'miss'));
    if (result.meta?.via) response.set('X-Card-Runtime-Admit', result.meta.via);
    return response.status(result.status).send(result.body);
}
