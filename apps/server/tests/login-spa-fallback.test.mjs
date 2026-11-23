/**
 * Login entry point + SPA fallback asset guard — real server, default mode (node:test).
 *
 * Regression cover for the blank grey login screen.
 *
 * With the SPA deployed (the default production mode, LUKER_SERVE_LEGACY unset),
 * GET /login used to be answered with the legacy public/login.html while public/
 * was NOT mounted. The style.css / css/login.css / img/logo.png / webfonts/…
 * that markup references then fell through to the SPA history fallback and were
 * answered with index.html (200 + text/html). Every form control rendered 0x0 —
 * a blank grey screen with nothing to tap, worst on mobile.
 *
 * Note the existing e2e harness sets LUKER_SERVE_LEGACY=1 by default
 * (tests/e2e/_lib/server.js), so it could never observe this. This suite spawns
 * a real server with that variable deliberately unset.
 *
 * Run: node --test apps/server/tests/login-spa-fallback.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const serverDir = path.resolve(import.meta.dirname, '..');
const WEB_INDEX = path.join(serverDir, '..', 'web', 'dist', 'index.html');
const LEGACY_LOGIN = path.join(serverDir, 'public', 'login.html');

const hasSpa = fs.existsSync(WEB_INDEX);
const hasLegacyLogin = fs.existsSync(LEGACY_LOGIN);

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-login-real-'));

async function reservePort() {
    const net = await import('node:net');
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function waitReady(base, child, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited early with code ${child.exitCode}`);
        }
        try {
            const res = await fetch(`${base}/csrf-token`);
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('server did not become ready');
}

/** Boot a real server in default (SPA) mode against a throwaway dataRoot. */
async function withRealServer(fn) {
    if (!hasSpa) {
        console.warn('# web/dist not built — skipping (run the web build first)');
        return;
    }
    const port = await reservePort();
    const dataRoot = path.join(scratchRoot, `data-${port}`);
    fs.mkdirSync(dataRoot, { recursive: true });

    // Deliberately NOT setting LUKER_SERVE_LEGACY — that is the whole point.
    const env = { ...process.env, LUKER_SKIP_WEBPACK: '1' };
    delete env.LUKER_SERVE_LEGACY;

    const child = spawn(process.execPath, ['server.js', '--dataRoot', dataRoot, '--port', String(port)], {
        cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });

    const base = `http://127.0.0.1:${port}`;
    try {
        await waitReady(base, child);
        await fn(base);
    } catch (err) {
        err.message += `\n--- server log ---\n${log.slice(-2000)}`;
        throw err;
    } finally {
        child.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        if (child.exitCode === null) child.kill('SIGKILL');
    }
}

const isHtml = r => /text\/html/.test(r.headers.get('content-type') || '');

test('default mode: GET /login serves the SPA shell, not the legacy page', async () => {
    if (!hasLegacyLogin) return;
    await withRealServer(async base => {
        const res = await fetch(`${base}/login`);
        const body = await res.text();
        assert.equal(res.status, 200);
        assert.ok(isHtml(res));
        assert.doesNotMatch(body, /Welcome to Luker/, 'legacy login page must not be served in default mode');
        assert.match(body, /assets\/index-/, 'must be the SPA shell with a bundled entry');
    });
});

test('default mode: legacy login page assets resolve as real assets, not index.html', async () => {
    if (!hasLegacyLogin) return;
    await withRealServer(async base => {
        // The exact set public/login.html references. manifest.json is absent on
        // purpose: only the legacy pages referenced it, the SPA declares
        // /site.webmanifest, and in SPA mode nothing loads those pages.
        const cases = [
            ['/style.css', /text\/css/],
            ['/css/login.css', /text\/css/],
            ['/css/st-tailwind.css', /text\/css/],
            ['/css/fontawesome.min.css', /text\/css/],
            ['/css/solid.min.css', /text\/css/],
            ['/css/brands.min.css', /text\/css/],
            ['/webfonts/NotoSans/stylesheet.css', /text\/css/],
            ['/webfonts/NotoSansMono/stylesheet.css', /text\/css/],
            ['/img/logo.png', /image\/png/],
            ['/favicon.ico', /image/],
        ];
        for (const [url, expected] of cases) {
            const res = await fetch(`${base}${url}`);
            assert.equal(res.status, 200, `${url} should be served`);
            assert.match(res.headers.get('content-type') || '', expected, `${url} wrong content-type`);
            const body = await res.text();
            assert.doesNotMatch(body.slice(0, 200), /<!DOCTYPE html>/i,
                `${url} must not return the SPA shell — this is the blank-page bug`);
        }
    });
});

test('default mode: a missing asset is 404, never index.html', async () => {
    await withRealServer(async base => {
        // The bug was silent precisely because these came back 200 + text/html.
        for (const url of ['/nope.css', '/missing/thing.js', '/img/gone.png', '/fonts/x.woff2']) {
            const res = await fetch(`${base}${url}`);
            assert.equal(res.status, 404, `${url} must 404`);
            assert.ok(!isHtml(res), `${url} must not be text/html`);
        }
    });
});

test('default mode: real file routes registered later are not shadowed by the guard', async () => {
    // The asset-extension check must live INSIDE the fallback handler. Mounted as
    // its own app.use() above these routes it answered 404 for every one of them,
    // because /backgrounds/*, /characters/*, /thumbnail/* and /card-runtime/* are
    // registered after this block (server-startup.js, further down server-main.js).
    //
    // What proves the route was reached: these handlers reject an unauthenticated
    // request with 403 (and a missing file with 404 served by *their* handler,
    // not our text/plain guard). The signature of the guard preempting them is
    // 404 + `text/plain; charset=utf-8` — our exact body.
    await withRealServer(async base => {
        for (const url of [
            '/backgrounds/does-not-exist.png',
            '/characters/does-not-exist.png',
            '/thumbnail/does-not-exist.png',
            '/card-runtime/does-not-exist.js',
        ]) {
            const res = await fetch(`${base}${url}`, { redirect: 'manual' });
            const body = await res.text();
            assert.ok(!(res.status === 404 && body === 'Not found' && /text\/plain/.test(res.headers.get('content-type') || '')),
                `${url} was short-circuited by the asset guard instead of reaching its handler`);
        }
    });
});

test('default mode: SPA icons and manifest are not shadowed by legacy public/ files', async () => {
    // public/favicon.ico (25140B, Luker) and public/manifest.json ("name":"Luker")
    // used to be served in preference to the SPA's own, so the browser tab showed
    // Luker's icon on a Utopinn deployment. Legacy root files must yield whenever
    // the SPA ships the same name.
    const legacyFavicon = path.join(serverDir, 'public', 'favicon.ico');
    const spaFavicon = path.join(serverDir, '..', 'web', 'dist', 'favicon.ico');
    if (!fs.existsSync(spaFavicon) || !fs.existsSync(legacyFavicon)) return;

    await withRealServer(async base => {
        const res = await fetch(`${base}/favicon.ico`);
        assert.equal(res.status, 200);
        const body = await res.arrayBuffer();
        assert.equal(body.byteLength, fs.statSync(spaFavicon).size,
            '/favicon.ico must be the SPA icon, not the 25140B legacy one');

        const manifest = await fetch(`${base}/manifest.json`, { redirect: 'manual' });
        // Not served at all in SPA mode: only the legacy pages referenced it and
        // the SPA declares /site.webmanifest.
        if (manifest.status === 200) {
            const text = await manifest.text();
            assert.doesNotMatch(text, /"name":\s*"Luker"/, 'legacy manifest must not be served');
        }
    });
});

test('default mode: legacy assets the SPA does not provide are still served', async () => {
    // style.css / css/ / img/ / webfonts/ are referenced by cached pages, old
    // bookmarks and the legacy shell, so they stay reachable in SPA mode.
    await withRealServer(async base => {
        for (const [url, expected] of [
            ['/style.css', /text\/css/],
            ['/css/login.css', /text\/css/],
            ['/webfonts/NotoSans/stylesheet.css', /text\/css/],
            ['/img/logo.png', /image\/png/],
        ]) {
            const res = await fetch(`${base}${url}`);
            assert.equal(res.status, 200, `${url} should still be served`);
            assert.match(res.headers.get('content-type') || '', expected);
        }
    });
});

test('default mode: shell routes still fall back to the SPA', async () => {
    await withRealServer(async base => {
        for (const url of ['/hub', '/chat', '/studio', '/some/deep/route']) {
            const res = await fetch(`${base}${url}`);
            assert.equal(res.status, 200, `${url} should fall back to the SPA`);
            assert.ok(isHtml(res));
        }
    });
});

test('default mode: the legacy 785KB index.html is not exposed', async () => {
    const legacyIndex = path.join(serverDir, 'public', 'index.html');
    if (!fs.existsSync(legacyIndex)) return;
    const legacySize = fs.statSync(legacyIndex).size;
    await withRealServer(async base => {
        const res = await fetch(`${base}/index.html`);
        const body = await res.text();
        assert.notEqual(body.length, legacySize, 'must not expose the legacy index.html');
        assert.doesNotMatch(body, /Welcome to Luker/);
    });
});

test('default mode: unauthenticated / redirects to the (working) /login', async () => {
    await withRealServer(async base => {
        const res = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/login');
        // and that target must now actually render
        const login = await fetch(`${base}${res.headers.get('location')}`);
        const body = await login.text();
        assert.doesNotMatch(body, /Welcome to Luker/);
    });
});
