// #108 — Standalone split-screen login landing: a guest must get ONLY the
// landing — the app shell never mounts, so nothing user-derived reaches
// document.body.innerText.
//
// Background: LoginGate used to render as a modal overlay INSIDE the shell.
// The shell then mounted the whole app underneath it, and the offline-mock
// fallback painted card names ("归墟", "旧港守灯人"), model ids
// ("gemini-3.8-flash"), context limits ("200k") and chrome copy
// ("本地用户", "服务端连接已断开") straight into body.innerText for any
// unauthenticated visitor. The API layer was already clean (every data
// endpoint 403s) — the leak was purely the guest-visible DOM.
//
// The fix: App.tsx's AuthGate probes /api/users/me before mounting anything;
// a guest gets <LoginLanding/> (brand aside + the same LoginGate form,
// reparented in-flow) and NOTHING else — the shell is not hidden, it is
// absent from the DOM.
//
// This spec seeds its own dataRoot (no clone of the dev seed) so the
// forbidden strings are derived from THE SEED ITSELF — directory names,
// settings leaves, and _storage user records — never hardcoded. It also
// derives the offline-mock strings from apps/web/src/api/mock.ts, the exact
// source that produced the original leak, so the assertion follows the mock
// if its content ever changes.

import { test, expect } from '@playwright/test';
import { createHash, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { grantAdminAccess, E2E_ADMIN_HANDLE, E2E_ADMIN_PASSWORD } from '../_lib/accounts.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.e2e-scratch');
const WEB_INDEX = resolve(REPO_ROOT, '../web/dist/index.html');
const MOCK_TS = resolve(REPO_ROOT, '../web/src/api/mock.ts');
const SHOTS = resolve(SCRATCH_ROOT, 'personas-login-landing-shots');

let server;

// ---------------------------------------------------------------- secrets

// Generic tokens that live inside a dataRoot but are not user content —
// directory basenames, bootstrap records, provider names. Anything else
// found under the user dirs is treated as user data and must not render.
const GENERIC = new Set([
    'default-user', 'Default User', '_storage', 'characters', 'chats',
    'worlds', 'backgrounds', 'settings', 'User Avatars', 'openai',
    'main', 'user', 'assistant', 'system',
]);

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const p = resolve(dir, entry);
        const st = statSync(p);
        yield p;
        if (st.isDirectory()) yield* walk(p);
    }
}

function* jsonLeaves(node) {
    if (typeof node === 'string') yield node;
    else if (Array.isArray(node)) for (const v of node) yield* jsonLeaves(v);
    else if (node && typeof node === 'object') for (const v of Object.values(node)) yield* jsonLeaves(v);
}

/**
 * Every string a guest must never see, harvested from the seeded dataRoot:
 * file/dir basenames under the user dirs (character/chat/worldbook names),
 * string leaves of JSON files (settings model ids, connection profile
 * names), and handle/name leaves of the _storage user records.
 */
function collectDataRootSecrets(dataRoot) {
    const secrets = new Set();
    for (const p of walk(dataRoot)) {
        const base = basename(p).replace(/\.[^.]+$/, '');
        const isFile = statSync(p).isFile();
        // sha256 datum filenames are storage plumbing, not user content.
        if (base.length >= 4 && !/^[0-9a-f]{64}$/.test(base) && !GENERIC.has(base)) secrets.add(base);
        const jsonish = p.endsWith('.json') || (isFile && dirname(p) === resolve(dataRoot, '_storage'));
        if (isFile && jsonish) {
            try {
                const parsed = JSON.parse(readFileSync(p, 'utf8'));
                for (const leaf of jsonLeaves(parsed.value ?? parsed)) {
                    if (leaf.length >= 4 && !GENERIC.has(leaf)) secrets.add(leaf);
                }
            } catch { /* non-JSON fixture — basenames already cover it */ }
        }
    }
    return [...secrets];
}

/**
 * The offline-mock strings — the exact payload that leaked in the original
 * bug. Pulled from mock.ts at spec time so the assertion tracks the fixture.
 * Keep only literals that read as user content: CJK text, or ids/paths that
 * carry a digit (model ids like gemini-3.8-flash, preset files like
 * Meowssiah-2.1.7.json, ctx limits like 200k). Structural tokens
 * ('demo-card', 'ungrouped', 'pb-1') can't false-positive against landing
 * copy anyway, but excluding them keeps the failure message readable.
 */
function collectMockSecrets() {
    const src = readFileSync(MOCK_TS, 'utf8');
    const out = new Set();
    for (const m of src.matchAll(/'([^'\\]{4,})'/g)) {
        const s = m[1];
        if (/[一-鿿]/.test(s) || /\d/.test(s)) out.add(s);
    }
    return [...out];
}

// Shell chrome copy that must never be guest-visible — stable app strings,
// asserted literally (unlike user data, these are ours to hardcode).
const SHELL_CHROME = [
    '选择卡面', '本地用户', '角色卡与会话', '服务端连接已断开', '重新连接',
    '卡面应用', '新标签页', '离线', '置顶',
];

// Data endpoints a guest must never even touch — the landing prefetches
// nothing; its only calls are the auth probe and the login-form probes.
const FORBIDDEN_API_PREFIXES = [
    '/api/utopinn/', '/api/card-runtime/', '/api/chats', '/api/characters',
    '/api/users/list', '/api/admin/',
];

// ------------------------------------------------------------------- seed

/** node-persist stores datums at sha256(key) under _storage. */
const storageFile = (key) => createHash('sha256').update(key).digest('hex');
/** getPasswordHash: scrypt(password.normalize(), salt, 64) -> base64. */
const scryptB64 = (password, salt) => scryptSync(password.normalize(), salt, 64).toString('base64');

const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

/**
 * Minimal dataRoot: a password-protected admin (via grantAdminAccess), a
 * second password-protected account whose handle is itself a probe string,
 * and user dirs carrying distinctive 'Zx9' secrets. Two passworded users →
 * tryAutoLogin has nothing to offer a guest, so /login stays a guest page.
 */
function seedDataRoot() {
    // Unique per worker: playwright fans tests across workers and each
    // beforeAll boots its own server — a shared path would make concurrent
    // first-boot content seeding collide on the same fs destinations.
    const dataRoot = resolve(SCRATCH_ROOT, `personas-login-landing-${process.pid}`);
    mkdirSync(resolve(dataRoot, '_storage'), { recursive: true });
    const u = resolve(dataRoot, 'default-user');
    mkdirSync(resolve(u, 'characters'), { recursive: true });
    mkdirSync(resolve(u, 'chats', 'SecretZx9Card'), { recursive: true });
    mkdirSync(resolve(u, 'worlds'), { recursive: true });
    mkdirSync(resolve(u, 'backgrounds'), { recursive: true });

    writeFileSync(resolve(u, 'characters', 'SecretZx9Card.png'), PNG_1PX);
    writeFileSync(resolve(u, 'chats', 'SecretZx9Card', 'probe-thread-7k2m.jsonl'), '');
    writeFileSync(resolve(u, 'worlds', 'ProbeLorebookZx9.json'), JSON.stringify({ entries: {} }));
    writeFileSync(resolve(u, 'settings.json'), JSON.stringify({
        oai_settings: {
            chat_completion_source: 'openai',
            openai_model: 'probe-model-zx9',
            connection_profiles: [{ name: 'ProbeConnZx9', model: 'probe-model-zx9' }],
        },
    }));

    writeFileSync(
        resolve(dataRoot, '_storage', storageFile('user:default-user')),
        JSON.stringify({
            key: 'user:default-user',
            value: {
                handle: 'default-user', name: 'Default User', created: Date.now(),
                password: '', salt: '', admin: false, enabled: true,
            },
        }),
    );
    writeFileSync(
        resolve(dataRoot, '_storage', storageFile('user:probekeeper')),
        JSON.stringify({
            key: 'user:probekeeper',
            value: {
                handle: 'probekeeper', name: 'Probe Keeper Zx9', created: Date.now(),
                password: scryptB64('probekeeper-pass-zx9', 'probe-salt'),
                salt: 'probe-salt', admin: false, enabled: true,
            },
        }),
    );
    return dataRoot;
}

// ------------------------------------------------------------------- spec

test.beforeAll(async () => {
    test.skip(!existsSync(WEB_INDEX), 'apps/web/dist missing — run the web build first');
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'login-landing',
        extraConfig: { enableUserAccounts: true },
        // SPA mode — the landing lives in the web bundle, not public/login.html.
        extraEnv: { LUKER_SERVE_LEGACY: '0' },
        useExistingDataRoot: seedDataRoot(),
    });
    await grantAdminAccess(server);
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function assertCleanGuestDom(page) {
    const body = await page.evaluate(() => document.body.innerText);
    const dataLeaks = collectDataRootSecrets(server.dataRoot).filter((s) => body.includes(s));
    expect(dataLeaks, 'user data leaked into the guest DOM').toEqual([]);
    const mockLeaks = collectMockSecrets().filter((s) => body.includes(s));
    expect(mockLeaks, 'offline-mock content leaked into the guest DOM').toEqual([]);
    const chromeLeaks = SHELL_CHROME.filter((s) => body.includes(s));
    expect(chromeLeaks, 'shell chrome copy leaked into the guest DOM').toEqual([]);
}

test.describe('#108 — standalone login landing', () => {
    test('front door / -> /login: only the landing mounts, DOM carries zero user data', async ({ page }) => {
        const apiHits = [];
        page.on('request', (r) => {
            const p = new URL(r.url()).pathname;
            if (FORBIDDEN_API_PREFIXES.some((pre) => p.startsWith(pre))) apiHits.push(p);
        });
        await page.goto(server.baseURL + '/');
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.locator('.login-landing')).toBeVisible();

        // The shell is ABSENT — not hidden: nothing for innerText to read.
        await expect(page.locator('.workspace-inset')).toHaveCount(0);
        await expect(page.locator('.rail-btn')).toHaveCount(0);
        await expect(page.locator('.account-dock')).toHaveCount(0);

        await assertCleanGuestDom(page);
        expect(apiHits, 'landing issued data-endpoint requests').toEqual([]);

        // The brand art must be a real public asset — guests have no stBg,
        // and a 404 here would leave a broken brand half.
        const art = await page.request.get(server.baseURL + '/assets/backgrounds/claude-study.png');
        expect(art.ok(), 'brand wallpaper is not publicly reachable').toBe(true);
    });

    test('deep link: guest at /hub signs in and lands back on /hub', async ({ page }) => {
        await page.goto(server.baseURL + '/hub');
        await expect(page.locator('.login-landing')).toBeVisible();
        await page.fill('input[autocomplete="username"]', E2E_ADMIN_HANDLE);
        await page.fill('input[autocomplete="current-password"]', E2E_ADMIN_PASSWORD);
        await page.locator('form.login-card button[type="submit"]').click();
        // LoginGate reloads wholesale to the deep link; now authed, /hub
        // serves the SPA which probes me()=200 and mounts the real shell.
        await page.waitForURL((u) => u.pathname === '/hub', { timeout: 20_000 });
        await expect(page.locator('.login-landing')).toHaveCount(0);
        await expect(page.locator('.workspace-inset')).toBeVisible({ timeout: 30_000 });
    });

    test('wrong password: stable inline error, still nothing but the landing', async ({ page }) => {
        await page.goto(server.baseURL + '/login');
        await expect(page.locator('.login-landing')).toBeVisible();
        await page.fill('input[autocomplete="username"]', E2E_ADMIN_HANDLE);
        await page.fill('input[autocomplete="current-password"]', 'definitely-not-the-password');
        await page.locator('form.login-card button[type="submit"]').click();
        await expect(page.locator('.login-error')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.login-landing')).toBeVisible();
        await assertCleanGuestDom(page);
    });

    test('layouts: split-screen at 1440x900, banner+form at 390x844', async ({ browser }) => {
        mkdirSync(SHOTS, { recursive: true });

        const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const dPage = await desktop.newPage();
        await dPage.goto(server.baseURL + '/login');
        await expect(dPage.locator('.login-landing')).toBeVisible();
        await expect(dPage.locator('form.login-card')).toBeVisible();
        await dPage.screenshot({ path: resolve(SHOTS, 'desktop-1440x900.png') });
        // Wide: the brand aside occupies roughly the left 55%.
        const brandBox = await dPage.locator('.login-brand').boundingBox();
        expect(brandBox.width).toBeGreaterThan(1440 * 0.4);
        await desktop.close();

        const mobile = await browser.newContext({
            viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        });
        const mPage = await mobile.newPage();
        await mPage.goto(server.baseURL + '/login');
        await expect(mPage.locator('.login-landing')).toBeVisible();
        const card = mPage.locator('form.login-card');
        await expect(card).toBeVisible();
        await mPage.screenshot({ path: resolve(SHOTS, 'mobile-390x844.png') });
        // Narrow: brand collapses to a top banner; the form fills below and
        // the submit button stays inside the viewport.
        const brandH = (await mPage.locator('.login-brand').boundingBox()).height;
        expect(brandH).toBeLessThan(844 * 0.45);
        const btn = await mPage.locator('form.login-card button[type="submit"]').boundingBox();
        expect(btn.y + btn.height).toBeLessThan(844);
        await assertCleanGuestDom(mPage);
        await mobile.close();
    });
});
