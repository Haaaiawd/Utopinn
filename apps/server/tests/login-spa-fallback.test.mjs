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
 * Hermeticity: the child is spawned with --configPath pointing at a minimal
 * config this file writes into the scratch dir (enableUserAccounts: true;
 * every other key is filled from default/config.yaml by addMissingConfigValues).
 * Without it the child would resolve ./config.yaml from its cwd — a gitignored
 * developer-local file — and the accounts-on assertions below would silently
 * depend on whatever that machine happens to have.
 *
 * Run: node --test apps/server/tests/login-spa-fallback.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const serverDir = path.resolve(import.meta.dirname, '..');
const WEB_INDEX = path.join(serverDir, '..', 'web', 'dist', 'index.html');
const LEGACY_LOGIN = path.join(serverDir, 'public', 'login.html');

const hasSpa = fs.existsSync(WEB_INDEX);
const hasLegacyLogin = fs.existsSync(LEGACY_LOGIN);

/** Reported as a real skip (not a silent pass) when the SPA build is absent. */
const SKIP_NO_SPA = hasSpa ? false : 'apps/web/dist not built — run pnpm --filter @utopinn/web build first';

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

/** Extract the Cookie request-header value from a response's Set-Cookie headers. */
function sessionCookieOf(res) {
    const setCookies = res.headers.getSetCookie();
    assert.ok(setCookies.length > 0, 'expected the auto-login response to set a session cookie');
    return setCookies.map(c => c.split(';')[0]).join('; ');
}

/**
 * Write an admin-settings document into a not-yet-booted dataRoot's
 * node-persist store — each record is one file named by the sha256 of its
 * key, JSON {key, value} (same trick as multi-account-isolation's
 * seedStoredItem). Must run before the server spawns: initUserStorage
 * loads the store once at boot.
 * @param {string} dataRoot Scratch data root (must already exist)
 * @param {object} settings Document stored under the admin-settings key
 */
function seedAdminSettings(dataRoot, settings) {
    const storageDir = path.join(dataRoot, '_storage');
    fs.mkdirSync(storageDir, { recursive: true });
    const key = 'luker:admin-settings:v1';
    const file = crypto.createHash('sha256').update(key).digest('hex');
    fs.writeFileSync(path.join(storageDir, file), JSON.stringify({ key, value: settings }));
}

/**
 * Boot a real server in default (SPA) mode against a throwaway dataRoot and a
 * throwaway --configPath (never the checkout's own ./config.yaml). The config
 * pins enableUserAccounts: true — the accounts-on behaviour under test.
 * fn receives (base, ctx); ctx.log() returns the child's combined output.
 * options.seed(dataRoot) runs after the dataRoot exists but before the
 * server spawns — e.g. to pre-seed admin settings.
 */
async function withRealServer(fn, { seed } = {}) {
    const port = await reservePort();
    const dir = path.join(scratchRoot, `run-${port}`);
    const dataRoot = path.join(dir, 'data');
    const configPath = path.join(dir, 'config.yaml');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(configPath, 'enableUserAccounts: true\n');
    if (seed) {
        await seed(dataRoot);
    }

    // Deliberately NOT setting LUKER_SERVE_LEGACY — that is the whole point.
    // SILLYTAVERN_/LUKER_* env vars would override config.yaml values
    // (getConfigValue checks env first), so they are stripped for hermeticity
    // except the ones this suite sets on purpose.
    const env = { ...process.env, LUKER_SKIP_WEBPACK: '1' };
    for (const key of Object.keys(env)) {
        if (/^(SILLYTAVERN_|LUKER_)/.test(key) && key !== 'LUKER_SKIP_WEBPACK') {
            delete env[key];
        }
    }

    const child = spawn(process.execPath, [
        'server.js', '--dataRoot', dataRoot, '--port', String(port), '--configPath', configPath,
    ], {
        cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });

    const base = `http://127.0.0.1:${port}`;
    try {
        await waitReady(base, child);
        await fn(base, { log: () => log, configPath });
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

test('default mode: GET /login?noauto serves the SPA shell, not the legacy page', { skip: SKIP_NO_SPA }, async () => {
    if (!hasLegacyLogin) return;
    await withRealServer(async (base) => {
        // ?noauto=1 is required here: with accounts enabled and a fresh
        // dataRoot the auto-created default-user is passwordless, so a bare
        // GET /login now (correctly, like the legacy page did) auto-logs in
        // and 302s to /. The noauto opt-out is the way to reach the page.
        const res = await fetch(`${base}/login?noauto=1`);
        const body = await res.text();
        assert.equal(res.status, 200);
        assert.ok(isHtml(res));
        assert.doesNotMatch(body, /Welcome to Luker/, 'legacy login page must not be served in default mode');
        assert.match(body, /assets\/index-/, 'must be the SPA shell with a bundled entry');
    });
});

test('default mode: legacy login page assets resolve as real assets, not index.html', { skip: SKIP_NO_SPA }, async () => {
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

test('default mode: a missing asset is 404, never index.html', { skip: SKIP_NO_SPA }, async () => {
    await withRealServer(async base => {
        // The bug was silent precisely because these came back 200 + text/html.
        for (const url of ['/nope.css', '/missing/thing.js', '/img/gone.png', '/fonts/x.woff2']) {
            const res = await fetch(`${base}${url}`);
            assert.equal(res.status, 404, `${url} must 404`);
            assert.ok(!isHtml(res), `${url} must not be text/html`);
        }
    });
});

test('default mode: real file routes registered later are not shadowed by the guard', { skip: SKIP_NO_SPA }, async () => {
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

test('default mode: SPA icons and manifest are not shadowed by legacy public/ files', { skip: SKIP_NO_SPA }, async () => {
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

test('default mode: legacy assets the SPA does not provide are still served', { skip: SKIP_NO_SPA }, async () => {
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

test('default mode: shell routes still fall back to the SPA', { skip: SKIP_NO_SPA }, async () => {
    await withRealServer(async base => {
        for (const url of ['/hub', '/chat', '/studio', '/some/deep/route']) {
            const res = await fetch(`${base}${url}`);
            assert.equal(res.status, 200, `${url} should fall back to the SPA`);
            assert.ok(isHtml(res));
        }
    });
});

test('default mode: the legacy 785KB index.html is not exposed', { skip: SKIP_NO_SPA }, async () => {
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

test('default mode: unauthenticated / serves the SPA shell, not a /login bounce', { skip: SKIP_NO_SPA }, async () => {
    // Regression cover for the anonymous redirect loop: GET / used to 302 to
    // /login while GET /login auto-logged in the passwordless bootstrap user
    // and 302'd back to /. A cookie-less client looped forever; a browser
    // silently signed every visitor in as default-user, so no guest could
    // ever reach the login/register form. In SPA mode the shell IS the auth
    // boundary — AuthGate renders LoginLanding for a guest — so / serves
    // index.html directly, exactly like every history-fallback route.
    await withRealServer(async (base, ctx) => {
        const res = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(res.status, 200, 'anonymous / must serve the SPA directly, not redirect');
        assert.ok(isHtml(res));
        const body = await res.text();
        assert.match(body, /assets\/index-/, 'must be the SPA shell with a bundled entry');

        // Accounts mode must actually be on for this run, or a 200 here would
        // just mean "accounts disabled → open shell". The anonymous /me 403
        // proves it (accounts-off mode answers 200 with the default profile).
        const me = await fetch(`${base}/api/users/me`);
        assert.equal(me.status, 403, 'anonymous /api/users/me must be 403 in accounts mode');
        // Belt-and-suspenders: the child also announces the config path it used.
        assert.match(ctx.log(), new RegExp(`Using config path:.*${ctx.configPath.replace(/[/\\]/g, '[\\\\/]')}`),
            'child must report reading the test-controlled config');
    });
});

test('default mode: registration-enabled instance does not auto-login the bootstrap user', { skip: SKIP_NO_SPA }, async () => {
    // The public-release posture: enableUserAccounts + open registration on a
    // fresh dataRoot whose only account is the passwordless bootstrap
    // default-user. Auto-entering it would sign every visitor into that
    // account — and singleUserLogin stops firing anyway the moment a second
    // account registers — so the gate keeps /login on the form instead.
    await withRealServer(async (base) => {
        const login = await fetch(`${base}/login`, { redirect: 'manual' });
        assert.equal(login.status, 200, '/login must serve the SPA, not bounce via auto-login');
        assert.ok(isHtml(login));
        const loginBody = await login.text();
        assert.match(loginBody, /assets\/index-/, 'must be the SPA shell with a bundled entry');

        const home = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(home.status, 200, '/ must serve the SPA for a guest');
        assert.ok(isHtml(home));

        // Registration must actually be enabled in this run (otherwise the
        // assertion above would also pass with the gate untested).
        const tokenRes = await fetch(`${base}/csrf-token`);
        const { token } = await tokenRes.json();
        const cookie = tokenRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
        const infoRes = await fetch(`${base}/api/users/registration/info`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie },
            body: '{}',
        });
        assert.equal(infoRes.status, 200);
        const info = await infoRes.json();
        assert.equal(info.enabled, true, 'seeded admin settings must have registration enabled');
    }, {
        seed: (dataRoot) => seedAdminSettings(dataRoot, {
            accountRegistration: { enabled: true, requireInviteCode: false },
        }),
    });
});

test('default mode: GET /login auto-logs in and the session cookie authenticates', { skip: SKIP_NO_SPA }, async () => {
    // Review comment #4: the SPA branch bypassed tryAutoLogin entirely, so a
    // fresh dataRoot (single passwordless default-user) could not establish a
    // session from /login the way the legacy page could. The single-user
    // auto-login is a deliberate feature and must keep working while
    // registration stays disabled (this instance has no admin-settings doc,
    // so accountRegistration.enabled resolves to its default: false).
    await withRealServer(async base => {
        const res = await fetch(`${base}/login`, { redirect: 'manual' });
        assert.equal(res.status, 302, 'auto-login should redirect home');
        assert.equal(res.headers.get('location'), '/');
        const cookie = sessionCookieOf(res);

        const home = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie } });
        assert.equal(home.status, 200, 'session from auto-login must authenticate /');
        const body = await home.text();
        assert.match(body, /assets\/index-/, 'authenticated / must serve the SPA shell');

        // / now serves the SPA to guests too, so a 200 alone no longer proves
        // the session took — /api/users/me is the authentication oracle.
        const me = await fetch(`${base}/api/users/me`, { headers: { cookie } });
        assert.equal(me.status, 200, 'auto-login session must authenticate API calls');
        const profile = await me.json();
        assert.equal(profile.handle, 'default-user');
    });
});

test('default mode: GET / auto-logs in a lone passwordless account', { skip: SKIP_NO_SPA }, async () => {
    // Regression cover for the auto-login drop: when '/' started serving the
    // SPA shell directly it bypassed tryAutoLogin entirely, and since the
    // SPA's /login bounces to '/' on success, a single-operator instance
    // (registration off, one passwordless account) could never establish a
    // session. The shell and the session cookie must arrive on the SAME
    // response — no redirect round-trip.
    await withRealServer(async base => {
        const res = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(res.status, 200, 'GET / serves the SPA shell');
        assert.ok(isHtml(res));
        const cookie = sessionCookieOf(res);

        const me = await fetch(`${base}/api/users/me`, { headers: { cookie } });
        assert.equal(me.status, 200, 'session established by GET / must authenticate API calls');
        const profile = await me.json();
        assert.equal(profile.handle, 'default-user');
    });
});

test('default mode: GET / with registration enabled does not auto-login', { skip: SKIP_NO_SPA }, async () => {
    // The singleUserLogin registration guard applies on '/' too: an
    // open-registration instance must leave visitors on the shell (LoginLanding
    // renders the register form) rather than signing them into the bootstrap
    // account. Whatever cookie the response sets must not authenticate.
    await withRealServer(async base => {
        const res = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(res.status, 200);
        assert.ok(isHtml(res));
        const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

        const me = await fetch(`${base}/api/users/me`, { headers: { cookie } });
        assert.equal(me.status, 403, 'registration-enabled instance must not auto-login on /');
    }, {
        seed: (dataRoot) => seedAdminSettings(dataRoot, {
            accountRegistration: { enabled: true, requireInviteCode: false },
        }),
    });
});

test('default mode: GET /?noauto does not auto-login', { skip: SKIP_NO_SPA }, async () => {
    // The operator opt-out is honoured on the SPA root the same as on the
    // login page: ?noauto must leave the visitor without a session.
    await withRealServer(async base => {
        const res = await fetch(`${base}/?noauto=1`, { redirect: 'manual' });
        assert.equal(res.status, 200);
        assert.ok(isHtml(res));
        const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

        const me = await fetch(`${base}/api/users/me`, { headers: { cookie } });
        assert.equal(me.status, 403, '?noauto must suppress auto-login on /');
    });
});

test('default mode: GET / does not auto-login when the lone account has a password', { skip: SKIP_NO_SPA }, async () => {
    // singleUserLogin only fires for a PASSWORDLESS lone account — a
    // password-protected default-user must get the shell (LoginGate) with
    // no session, exactly like the legacy login page behaved.
    await withRealServer(async base => {
        const res = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(res.status, 200);
        assert.ok(isHtml(res));
        const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

        const me = await fetch(`${base}/api/users/me`, { headers: { cookie } });
        assert.equal(me.status, 403, 'a passworded account must not auto-login on /');
    }, {
        seed: (dataRoot) => {
            // Pre-seed the account store so initUserStorage does not create a
            // passwordless bootstrap record — same node-persist record shape
            // as seedAdminSettings ({key, value} JSON under sha256(key)).
            const storageDir = path.join(dataRoot, '_storage');
            fs.mkdirSync(storageDir, { recursive: true });
            const key = 'user:default-user';
            const file = crypto.createHash('sha256').update(key).digest('hex');
            fs.writeFileSync(path.join(storageDir, file), JSON.stringify({
                key,
                value: { handle: 'default-user', name: 'User', created: 1, password: 'hashed', salt: 's', admin: false, enabled: true },
            }));
        },
    });
});

test('default mode: POST /api/users/oauth/providers answers for anonymous clients', { skip: SKIP_NO_SPA }, async () => {
    // LoginGate renders OAuth buttons from this endpoint — it must be reachable
    // pre-auth (it is mounted ahead of the login gate). Test config enables no
    // provider, so both flags must be false and LoginGate renders no buttons.
    await withRealServer(async base => {
        const tokenRes = await fetch(`${base}/csrf-token`);
        const { token } = await tokenRes.json();
        const cookie = tokenRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
        const res = await fetch(`${base}/api/users/oauth/providers`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie },
            body: '{}',
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.providers, { github: false, discord: false });
    });
});
