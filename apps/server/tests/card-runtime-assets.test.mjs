/**
 * card-runtime routes: mount mint → entry/doc/asset serving → CDN proxy →
 * manifest endpoint → revoke (node:test, real express + real HTTP).
 * 跑法:node --test tests/card-runtime-assets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { writeCardToPng } from '@utopinn/formats';
import { cardRuntimePublicRouter, cardRuntimeApiRouter } from '../src/card-runtime/index.js';
import { __cardRuntimeTestUtils } from '../src/card-runtime/mounts.js';

// 1×1 PNG (IHDR+IDAT+IEND) — the fixture base writeCardToPng embeds card JSON into.
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

const HANDLE = 'u1';
let ROOT;
let DIRECTORIES;
let BASE;
let server;

function cardJson(cardApp) {
    return JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0',
        data: { name: 'Fixture', description: 'card-runtime fixture', extensions: { card_app: cardApp } },
    });
}

function writeAsset(charId, rel, content) {
    const full = path.join(DIRECTORIES.cardApps, charId, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

async function mount(charId) {
    const res = await fetch(`${BASE}/api/card-runtime/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ charId }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cardrt-'));
    DIRECTORIES = {
        root: ROOT,
        characters: path.join(ROOT, 'characters'),
        cardApps: path.join(ROOT, 'card-apps'),
    };
    fs.mkdirSync(DIRECTORIES.characters, { recursive: true });
    fs.mkdirSync(DIRECTORIES.cardApps, { recursive: true });

    // doc-card: HTML document entry, files already extracted on disk.
    fs.writeFileSync(path.join(DIRECTORIES.characters, 'doc-card.json'), cardJson({
        enabled: true,
        entry: 'app/panel.html',
        permissions: {
            network: { allowlist: ['https://files.author.dev/lib/*'] },
            stateNamespaces: ['inventory'],
            media: true,
        },
    }));
    writeAsset('doc-card', 'app/panel.html', '<!doctype html><html><head><title>p</title></head><body><div id="app"></div><script src="./app.js"></script></body></html>');
    writeAsset('doc-card', 'app/app.js', 'export const x = 1;');
    writeAsset('doc-card', 'img/logo.png', PNG_1PX);
    fs.mkdirSync(path.join(DIRECTORIES.cardApps, 'doc-card', '.git'), { recursive: true });
    fs.writeFileSync(path.join(DIRECTORIES.cardApps, 'doc-card', '.git', 'config'), '[core] secret=1');

    // mod-card: module entry, NO assets on disk → lazy extraction from card files.
    fs.writeFileSync(path.join(DIRECTORIES.characters, 'mod-card.json'), cardJson({
        enabled: true,
        entry: 'index.js',
        files: {
            'index.js': 'export function init(ctx) { globalThis.__init = true; }',
            'style.css': '#card-app-container { color: red; }',
            'lib/util.js': 'export const u = 2;',
        },
    }));

    // png-card: real PNG metadata read path via @utopinn/formats writer.
    fs.writeFileSync(
        path.join(DIRECTORIES.characters, 'png-card.png'),
        writeCardToPng(new Uint8Array(PNG_1PX), cardJson({
            enabled: true,
            entry: 'ui/main.js',
            files: { 'ui/main.js': 'export function init() {}' },
        })),
    );

    // no-app card: no card_app → mounts must 404.
    fs.writeFileSync(path.join(DIRECTORIES.characters, 'no-app.json'), cardJson(undefined));

    // broken card: bad manifest → 422.
    fs.writeFileSync(path.join(DIRECTORIES.characters, 'broken.json'), cardJson({
        enabled: true, entry: '../escape.js',
    }));

    const app = express();
    app.locals.cardRuntimeFetch = async (url) => ({
        ok: true, status: 200,
        headers: { get: (k) => ({ 'content-type': 'application/javascript' })[k] ?? null },
        buffer: async () => Buffer.from(`// proxied ${url}`),
    });
    app.use(express.json());
    // Admin surface behaves as if requireLogin+setUserData ran upstream.
    app.use((request, response, next) => {
        request.user = { profile: { handle: HANDLE }, directories: DIRECTORIES };
        next();
    });
    app.use('/api/card-runtime', cardRuntimeApiRouter);
    // Public surface must work WITHOUT request.user — mounted bare.
    app.use('/card-runtime', cardRuntimePublicRouter);

    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    BASE = `http://127.0.0.1:${server.address().port}`;
    __cardRuntimeTestUtils.clear();
});

test.after(() => {
    server?.close();
    __cardRuntimeTestUtils.clear();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- mount minting (admin surface) ----------

test('mount: document-entry card → 201 with bundle', async () => {
    const { status, body } = await mount('doc-card');
    assert.equal(status, 201, JSON.stringify(body));
    assert.match(body.mountId, /^[a-f0-9]{32}$/);
    assert.equal(body.entryKind, 'document');
    assert.equal(body.entryUrl, `/card-runtime/m/${body.mountId}/app/panel.html`);
    assert.equal(body.cdnUrl, `/card-runtime/m/${body.mountId}/cdn`);
    assert.match(body.csp, /sandbox allow-scripts/);
    assert.equal(body.manifest.permissions.media, true);
    assert.deepEqual(body.manifest.permissions.stateNamespaces, ['inventory']);
    globalThis.__docMount = body;
});

test('mount: module-entry card with embedded files → lazy extract + shell', async () => {
    const { status, body } = await mount('mod-card');
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.entryKind, 'module');
    assert.equal(body.entryUrl, `/card-runtime/m/${body.mountId}/`);
    assert.ok(fs.existsSync(path.join(DIRECTORIES.cardApps, 'mod-card', 'index.js')), 'embedded files extracted lazily');
    globalThis.__modMount = body;
});

test('mount: PNG card reads card metadata through the png path', async () => {
    const { status, body } = await mount('png-card');
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.manifest.entry, 'ui/main.js');
});

test('mount: failures fail loud — 404/422 classes', async () => {
    assert.equal((await mount('ghost')).status, 404);
    const noApp = await mount('no-app');
    assert.equal(noApp.status, 404);
    assert.equal(noApp.body.error, 'no_card_app');
    const broken = await mount('broken');
    assert.equal(broken.status, 422);
    assert.equal(broken.body.error, 'invalid_card_app_manifest');
    assert.ok(broken.body.errors.some(e => /unsafe path/.test(e)));
    assert.equal((await mount('')).status, 400);
});

test('manifest endpoint: dry-run validation without mounting', async () => {
    const ok = await fetch(`${BASE}/api/card-runtime/cards/doc-card/manifest`);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.manifest.entry, 'app/panel.html');

    const none = await fetch(`${BASE}/api/card-runtime/cards/no-app/manifest`);
    const noneBody = await none.json();
    assert.equal(noneBody.ok, false);
    assert.match(noneBody.errors[0], /no extensions\.card_app/);

    const bad = await fetch(`${BASE}/api/card-runtime/cards/broken/manifest`);
    assert.equal((await bad.json()).ok, false);
});

// ---------- public surface: entry + assets ----------

test('document entry served verbatim at its own path + CSP + opaque headers', async () => {
    const m = globalThis.__docMount;
    const res = await fetch(`${BASE}${m.entryUrl}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<div id="app"><\/div>/);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /sandbox allow-scripts/);
    assert.match(csp, new RegExp(`connect-src ${BASE.replace(/[.:]/g, c => '\\' + c)}/card-runtime/`));
    assert.match(csp, /frame-src 'none'/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('referrer-policy'), /no-referrer/);
});

test('mount root redirects document entries to their canonical path', async () => {
    const m = globalThis.__docMount;
    const res = await fetch(`${BASE}/card-runtime/m/${m.mountId}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /app\/panel\.html$/);
});

test('module entry shell: synthesized doc w/ module script + auto style.css', async () => {
    const m = globalThis.__modMount;
    const res = await fetch(`${BASE}${m.entryUrl}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<script type="module" src="\.\/index\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\.\/style\.css">/);
    assert.match(html, /id="card-app-container"/);
});

test('asset serving: nested js + png bytes + ETag revalidation', async () => {
    const m = globalThis.__docMount;
    const js = await fetch(`${BASE}${m.assetBaseUrl}app/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(await js.text(), 'export const x = 1;');

    const etag = js.headers.get('etag');
    const again = await fetch(`${BASE}${m.assetBaseUrl}app/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);

    const png = await fetch(`${BASE}${m.assetBaseUrl}img/logo.png`);
    assert.equal(png.status, 200);
    assert.match(png.headers.get('content-type'), /image\/png/);
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG_1PX);
});

test('asset confinement: traversal + .git internals → 404', async () => {
    const m = globalThis.__docMount;
    for (const p of [
        `${m.assetBaseUrl}..%2F..%2Fcharacters%2Fdoc-card.json`,
        `${m.assetBaseUrl}%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
        `${m.assetBaseUrl}.git/config`,
        `${m.assetBaseUrl}app/..%2f.git/config`,
    ]) {
        const res = await fetch(`${BASE}${p}`);
        assert.equal(res.status, 404, p);
    }
});

test('unknown/expired mount → uniform 404 mount_not_found', async () => {
    const res = await fetch(`${BASE}/card-runtime/m/${'0'.repeat(32)}/x.js`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'mount_not_found');

    // expire a throwaway mount — doc-card's mount is reused by later tests
    const { body: tmp } = await mount('doc-card');
    __cardRuntimeTestUtils.forceExpire(tmp.mountId);
    const expired = await fetch(`${BASE}${tmp.assetBaseUrl}app/app.js`);
    assert.equal(expired.status, 404);
});

// ---------- ?shim= splice ----------

test('?shim=t0 splices the shim tag before card scripts', async () => {
    const m = globalThis.__docMount;
    const res = await fetch(`${BASE}${m.entryUrl}?shim=t0`);
    const html = await res.text();
    const shimAt = html.indexOf('data-card-runtime-shim');
    const cardAt = html.indexOf('./app.js');
    assert.ok(shimAt > 0, html.slice(0, 200));
    assert.ok(shimAt < cardAt, 'shim tag must precede card script');
    assert.match(html, /\/card-runtime\/shim\/t0\.js/);

    // module shell too
    const mm = globalThis.__modMount;
    const shell = await (await fetch(`${BASE}${mm.entryUrl}?shim=t0`)).text();
    assert.ok(shell.indexOf('data-card-runtime-shim') < shell.indexOf('type="module"'));
});

test('shim endpoint serves t0 runtime without a session', async () => {
    const res = await fetch(`${BASE}/card-runtime/shim/t0.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const bad = await fetch(`${BASE}/card-runtime/shim/evil.js`);
    assert.equal(bad.status, 404);
});

// ---------- ctx face (TASK-046): ?shim=ctx + public ctx-shim ----------

test('shim endpoint serves ctx runtime without a session', async () => {
    const res = await fetch(`${BASE}/card-runtime/shim/ctx.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const body = await res.text();
    assert.match(body, /__CARDAPP_CTX__/);
    // bare alias works too
    const alias = await fetch(`${BASE}/card-runtime/shim/ctx`);
    assert.equal(alias.status, 200);
});

test('?shim=ctx on module entry: bootstrap + ctx shim + init-caller, no bare module tag', async () => {
    const mm = globalThis.__modMount;
    const shell = await (await fetch(`${BASE}${mm.entryUrl}?shim=ctx`)).text();
    // bootstrap precedes shim; nonce + face=ctx + mountId seeded
    assert.match(shell, /data-card-runtime-bootstrap/);
    assert.match(shell, new RegExp(`__UTOPINN_PANEL_NONCE__=${JSON.stringify(mm.bridgeNonce)}`));
    assert.match(shell, /"face":"ctx"/);
    assert.match(shell, /\/card-runtime\/shim\/ctx\.js/);
    // init-caller imports the entry and invokes init(ctx) — the bare
    // <script type="module" src> path must NOT appear alongside it.
    assert.match(shell, /data-card-runtime-init/);
    assert.match(shell, /await import\("\.\/index\.js"\)/);
    assert.match(shell, /__mod\.init\(__ctx\)/);
    assert.ok(!/<script type="module" src="\.\/index\.js">/.test(shell), 'bare module tag must be replaced by init-caller');
    assert.match(shell, /window\.__CARDAPP_CTX__/);
});

test('?shim=ctx on document entry: bootstrap + ctx shim spliced before card scripts', async () => {
    const m = globalThis.__docMount;
    const res = await fetch(`${BASE}${m.entryUrl}?shim=ctx`);
    const html = await res.text();
    assert.match(html, /"face":"ctx"/);
    assert.match(html, /\/card-runtime\/shim\/ctx\.js/);
    const shimAt = html.indexOf('data-card-runtime-shim');
    const cardAt = html.indexOf('./app.js');
    assert.ok(shimAt > 0 && shimAt < cardAt, 'ctx shim must precede card script');
});

test('mount bundle exposes chatName + ctxShimUrl for the host', async () => {
    const res = await fetch(`${BASE}/api/card-runtime/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ charId: 'mod-card', chatName: 'story-1' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.chatName, 'story-1');
    assert.match(String(body.ctxShimUrl ?? ''), /\/card-runtime\/shim\/ctx\.js/);
    // module default api faces = ctx+th (TASK-046 manifest default)
    assert.deepEqual(body.manifest.permissions.api, ['ctx', 'th']);
    // 不留在注册表里 —— 后续 owner-scope 断言数 mod-card mount 恰好为 1。
    await fetch(`${BASE}/api/card-runtime/mounts/${body.mountId}`, { method: 'DELETE' });
});

// ---------- CDN proxy through the mount ----------

test('cdn proxy: known CDN admitted, cached, ETag; foreign host 403', async () => {
    const m = globalThis.__docMount;
    const url = 'https://cdn.jsdelivr.net/gh/u/r@1/lib.js';
    const res = await fetch(`${BASE}${m.cdnUrl}?url=${encodeURIComponent(url)}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `// proxied ${url}`);
    assert.equal(res.headers.get('x-card-runtime-cache'), 'miss');
    assert.equal(res.headers.get('x-card-runtime-admit'), 'known-cdn');
    assert.match(res.headers.get('etag'), /^"sha256-[a-f0-9]{64}"$/);
    assert.match(res.headers.get('digest'), /^sha-256=/);
    assert.match(res.headers.get('content-type'), /javascript/);

    const hit = await fetch(`${BASE}${m.cdnUrl}?url=${encodeURIComponent(url)}`);
    assert.equal(hit.headers.get('x-card-runtime-cache'), 'hit');

    // card-declared prefix admits author domain
    const authored = await fetch(`${BASE}${m.cdnUrl}?url=${encodeURIComponent('https://files.author.dev/lib/x.js')}`);
    assert.equal(authored.status, 200);
    assert.equal(authored.headers.get('x-card-runtime-admit'), 'card');

    const denied = await fetch(`${BASE}${m.cdnUrl}?url=${encodeURIComponent('https://evil.example.com/x.js')}`);
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.error, 'cdn_url_not_allowed');

    const missing = await fetch(`${BASE}${m.cdnUrl}`);
    assert.equal(missing.status, 400);
});

// ---------- admin: list + revoke ----------

test('mounts list + revoke are owner-scoped', async () => {
    const listed = await (await fetch(`${BASE}/api/card-runtime/mounts`)).json();
    const mine = listed.mounts.filter(x => x.charId === 'mod-card');
    assert.equal(mine.length, 1);
    const id = mine[0].mountId;

    const del = await fetch(`${BASE}/api/card-runtime/mounts/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const gone = await fetch(`${BASE}/card-runtime/m/${id}/`);
    assert.equal(gone.status, 404);
});
