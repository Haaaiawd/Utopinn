/**
 * CDN proxy: two-level allowlist admission + SHA256 cache (node:test).
 * 跑法:node --test tests/card-runtime-cdn-proxy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitRemoteUrl, fetchCachedRemote, cacheDirForMount, KNOWN_CDN_HOSTS } from '../src/card-runtime/cdn-proxy.js';
import { parseCardAppManifest } from '../src/card-runtime/manifest.js';

const manifestOf = (allowlist = []) => parseCardAppManifest({
    data: { extensions: { card_app: { entry: 'a.html', permissions: { network: { allowlist } } } } },
}).manifest;

const textResponse = (body, { status = 200, contentType = 'application/javascript', etag = null, lastModified = null } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => ({ 'content-type': contentType, etag, 'last-modified': lastModified })[k.toLowerCase()] ?? null },
    buffer: async () => Buffer.from(body),
});

test('admission: bad/oversized URLs rejected', () => {
    const m = manifestOf();
    for (const url of [null, '', 'not-a-url', 'ftp://x', 'https://user:pw@h/x', 'x'.repeat(3000)]) {
        const d = admitRemoteUrl(url, m);
        assert.equal(d.allowed, false, String(url));
    }
});

test('admission: known CDN hosts pass at domain level (https only)', () => {
    const m = manifestOf();
    for (const host of KNOWN_CDN_HOSTS) {
        const d = admitRemoteUrl(`https://${host}/gh/u/r@1/lib.js`, m);
        assert.equal(d.allowed, true, host);
        assert.equal(d.via, 'known-cdn');
    }
    // non-CDN host rejected
    assert.equal(admitRemoteUrl('https://evil.example.com/x.js', m).allowed, false);
    // plain http to a known CDN is rejected unless card-declared
    assert.equal(admitRemoteUrl('http://cdn.jsdelivr.net/x.js', m).allowed, false);
});

test('admission: card allowlist admits exact + prefix, incl author http domain', () => {
    const m = manifestOf(['https://files.author.dev/lib/*', 'http://files.author.dev/exact.js']);
    assert.equal(admitRemoteUrl('https://files.author.dev/lib/a/b.js', m).via, 'card');
    assert.equal(admitRemoteUrl('https://files.author.dev/other.js', m).allowed, false);
    assert.equal(admitRemoteUrl('http://files.author.dev/exact.js', m).allowed, true);
    assert.equal(admitRemoteUrl('http://files.author.dev/other.js', m).allowed, false);
});

function tmpCache() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cardrt-cdn-'));
}

test('fetch: admitted URL cached content-addressed, second call hits', async () => {
    const dir = tmpCache();
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push(url);
        return textResponse('export const x = 1;', { etag: 'W/"v1"' });
    };
    const url = 'https://cdn.jsdelivr.net/gh/u/r@1.0.0/lib.js';
    const r1 = await fetchCachedRemote({ url, via: 'known-cdn', cacheDir: dir, fetchImpl });
    assert.equal(r1.status, 200);
    assert.equal(r1.meta.cache, 'miss');
    assert.equal(r1.body.toString(), 'export const x = 1;');
    const hash = crypto.createHash('sha256').update(r1.body).digest('hex');
    assert.equal(r1.meta.contentHash, hash);
    assert.equal(r1.headers['ETag'], `"sha256-${hash}"`);
    assert.ok(fs.existsSync(path.join(dir, 'blobs', hash)));

    const r2 = await fetchCachedRemote({ url, via: 'known-cdn', cacheDir: dir, fetchImpl });
    assert.equal(r2.meta.cache, 'hit');
    assert.equal(calls.length, 1, 'cache hit must not refetch');
});

test('fetch: integrity mismatch fails loud and does not cache', async () => {
    const dir = tmpCache();
    const r = await fetchCachedRemote({
        url: 'https://cdn.jsdelivr.net/x.js',
        via: 'known-cdn',
        cacheDir: dir,
        integrity: 'f'.repeat(64),
        fetchImpl: async () => textResponse('real'),
    });
    assert.equal(r.status, 502);
    assert.match(r.body.toString(), /integrity_mismatch/);
    const indexDir = path.join(dir, 'index');
    assert.ok(!fs.existsSync(indexDir) || fs.readdirSync(indexDir).length === 0, 'mismatch must not write cache index');
});

test('fetch: content-type allowlist maps/drops', async () => {
    const dir = tmpCache();
    const r = await fetchCachedRemote({
        url: 'https://cdn.jsdelivr.net/style.css',
        via: 'known-cdn',
        cacheDir: dir,
        fetchImpl: async () => textResponse('a{}', { contentType: 'text/css; charset=utf-8' }),
    });
    assert.equal(r.headers['Content-Type'], 'text/css; charset=utf-8');

    const r2 = await fetchCachedRemote({
        url: 'https://cdn.jsdelivr.net/b.exe',
        via: 'known-cdn',
        cacheDir: dir,
        fetchImpl: async () => textResponse('MZ', { contentType: 'application/x-msdownload' }),
    });
    assert.equal(r2.headers['Content-Type'], 'application/octet-stream');
});

test('fetch: stale index revalidates with If-None-Match → 304 refreshes', async () => {
    const dir = tmpCache();
    let call = 0;
    const fetchImpl = async (url, opts) => {
        call++;
        if (call === 1) return textResponse('v1', { etag: 'W/"v1"' });
        assert.equal(opts.headers['If-None-Match'], 'W/"v1"');
        return { ok: false, status: 304, headers: { get: () => null }, buffer: async () => Buffer.alloc(0) };
    };
    const url = 'https://cdn.jsdelivr.net/gh/u/r@main/lib.js';
    await fetchCachedRemote({ url, via: 'known-cdn', cacheDir: dir, fetchImpl, now: 1000 });
    // force index staleness by advancing the clock past TTL
    const r = await fetchCachedRemote({ url, via: 'known-cdn', cacheDir: dir, fetchImpl, now: 1000 + 13 * 3600 * 1000 });
    assert.equal(r.status, 200);
    assert.equal(r.meta.cache, 'revalidated');
    assert.equal(r.body.toString(), 'v1');
    assert.equal(call, 2);
});

test('fetch: upstream failure with stale cache → serves stale; without → 502', async () => {
    const dir = tmpCache();
    const url = 'https://cdn.jsdelivr.net/lib.js';
    await fetchCachedRemote({ url, via: 'known-cdn', cacheDir: dir, fetchImpl: async () => textResponse('cached') });
    const stale = await fetchCachedRemote({
        url, via: 'known-cdn', cacheDir: dir,
        now: Date.now() + 13 * 3600 * 1000,
        fetchImpl: async () => { throw new Error('network down'); },
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.meta.cache, 'stale');
    assert.equal(stale.body.toString(), 'cached');

    const dir2 = tmpCache();
    const miss = await fetchCachedRemote({
        url, via: 'known-cdn', cacheDir: dir2,
        fetchImpl: async () => { throw new Error('network down'); },
    });
    assert.equal(miss.status, 502);
    assert.match(miss.body.toString(), /upstream_unreachable/);
});

test('fetch: upstream non-2xx → 502, not cached', async () => {
    const dir = tmpCache();
    const r = await fetchCachedRemote({
        url: 'https://cdn.jsdelivr.net/missing.js', via: 'known-cdn', cacheDir: dir,
        fetchImpl: async () => textResponse('nope', { status: 404 }),
    });
    assert.equal(r.status, 502);
    assert.match(r.body.toString(), /upstream_status/);
});

test('fetch: SSRF-shaped upstream error → 403 ssrf_blocked', async () => {
    const dir = tmpCache();
    const r = await fetchCachedRemote({
        url: 'https://cdn.jsdelivr.net/x.js', via: 'known-cdn', cacheDir: dir,
        fetchImpl: async () => { throw new Error('Blocked request to private IP address: 169.254.169.254'); },
    });
    assert.equal(r.status, 403);
    assert.match(r.body.toString(), /ssrf_blocked/);
});

test('cacheDirForMount nests under the owning user root', () => {
    const dir = cacheDirForMount({ directories: { root: '/data/u1' } });
    assert.equal(dir, path.join('/data/u1', 'cache', 'card-runtime-cdn'));
});
