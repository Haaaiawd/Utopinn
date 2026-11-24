// CardApp (台账) mount e2e: real server + built SPA + Playwright.
//
// Boots apps/server on a scratch dataRoot, seeds a chat for the bundled
// 掌门卡, mounts its CardApp via the SPA launcher, and asserts:
//   - .cardapp-host iframe mounts with real size (no 0-height regression)
//   - /card-runtime/m/<id>/?shim=ctx doc loads, init(ctx) sentinel ok
//   - embedded lorebook is served through GET /worlds/:name?char=<charDir>
//   - card assets resolve via /api/card-app/<charId>/ (lazy extraction +
//     CORP cross-origin for opaque-origin sandbox consumers)
//   - container-width breakpoints: <760px narrow band vs ≥760px wide band
//     (fullscreen pop exercises the wide band on desktop)
//
// Viewports: desktop 1440x900 + mobile 390x844 (?vp=mobile forces isMobile).
//
// Usage:
//   UTO_ROOT=<repo> UTO_PREBUILT_BUNDLES_DIR=<webpack output dir> \
//   LD_LIBRARY_PATH=~/.cache/utopinn-pw-libs/usr/lib/x86_64-linux-gnu \
//   node apps/server/tests/cardapp-mount.e2e.mjs
//
// UTO_ROOT defaults to the repo root two levels above this file.
// UTO_PREBUILT_BUNDLES_DIR skips webpack compile (output dir containing
// lib.core/lib.optional/codemirror.bundle.js — see tests/.e2e-scratch).
// UTO_PORT overrides the server port (default 8000), UTO_OUT the shots dir.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, 'package.json'));
const { chromium } = require('playwright');

const ROOT = process.env.UTO_ROOT || path.resolve(HERE, '..', '..', '..');
const DATA = process.env.UTO_DATA || '/tmp/cardapp-mount-e2e-data';
const OUT = process.env.UTO_OUT || '/tmp/cardapp-mount-e2e-shots';
const PORT = process.env.UTO_PORT || '8000';
const BASE = `http://127.0.0.1:${PORT}`;
const CHAR = 'default_我没想当掌门啊';
const CHAT = 'verify-ledger-001';
const PREBUILT = process.env.UTO_PREBUILT_BUNDLES_DIR || process.env.LUKER_PREBUILT_BUNDLES_DIR || '';

const results = { checks: [], failures: [] };
const ok = (n, v, extra = '') => {
    results.checks.push({ n, v, extra });
    console.log(`${v ? 'PASS' : 'FAIL'} ${n} ${extra}`);
    if (!v) results.failures.push(n);
};

let sessionCookie = '';
let csrfToken = '';
function req(method, url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const headers = { 'content-type': 'application/json' };
        if (sessionCookie) headers.cookie = sessionCookie;
        if (csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;
        const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
            const sc = res.headers['set-cookie'];
            if (sc && sc.length) sessionCookie = sc.map((c) => c.split(';')[0]).join('; ');
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        r.on('error', reject);
        if (body) r.write(JSON.stringify(body));
        r.end();
    });
}
const get = (u) => req('GET', u);
const post = (u, b) => req('POST', u, b);

async function waitHealth(tries = 120) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await get(`${BASE}/api/storage/health`);
            if (r.status === 200) return true;
        } catch {}
        await new Promise((s) => setTimeout(s, 500));
    }
    return false;
}

async function runViewport(browser, name, ctxOpts, path, mobile) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const hits = { worldsChar: [], mounts: [], cardAppAssets: 0, corpBlocked: 0, consoleErr: [] };
    page.on('response', async (r) => {
        const u = r.url();
        if (u.includes('/worlds/') && u.includes('char=')) {
            let j = null;
            try {
                j = await r.json();
            } catch {}
            hits.worldsChar.push({
                status: r.status(),
                embedded: j && j.embedded,
                entries: j && j.doc && j.doc.entries ? Object.keys(j.doc.entries).length : null,
            });
        }
        if (u.includes('/card-runtime/mounts')) {
            let j = null;
            try {
                j = await r.json();
            } catch {}
            hits.mounts.push({
                status: r.status(),
                entryUrl: j && j.entryUrl,
                sameOrigin: j && j.manifest && j.manifest.permissions && j.manifest.permissions.sameOrigin,
            });
        }
        if (u.includes(`/api/card-app/${encodeURIComponent(CHAR)}`)) hits.cardAppAssets++;
    });
    page.on('console', (m) => {
        if (m.type() === 'error') hits.consoleErr.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => hits.consoleErr.push('PAGEERR ' + String(e).slice(0, 200)));
    page.on('requestfailed', (r) => {
        const t = `${r.url().slice(0, 140)} ${r.failure()?.errorText ?? ''}`;
        if (t.includes('NotSameOrigin')) hits.corpBlocked++;
        hits.consoleErr.push(`REQFAIL ${t}`);
    });
    await page.goto(`${BASE}/${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const rowSel = `button:has-text("${CHAT}")`;
    try {
        await page.waitForSelector(rowSel, { timeout: 25000, state: 'attached' });
    } catch (e) {
        await page.screenshot({ path: `${OUT}/${name}-nosidebar.png`, fullPage: true });
        ok(`${name} sidebar chat row`, false, 'chat row not rendered');
        await ctx.close();
        return null;
    }
    const row = page.locator(rowSel).first();
    await row.click({ timeout: 8000 }).catch((e) => console.log('row click failed', String(e).slice(0, 120)));
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${name}-after-select.png`, fullPage: true });

    if (mobile) {
        // close overlay (session info) then open panels via 面板 nav
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        for (const sel of ['button:has-text("面板")', 'text=面板']) {
            const b = page.locator(sel).first();
            if (await b.isVisible().catch(() => false)) {
                await b.click().catch(() => {});
                await page.waitForTimeout(500);
                break;
            }
        }
        await page.screenshot({ path: `${OUT}/${name}-panels.png`, fullPage: true });
    }
    // open the cardapp panel via the launcher entry ("卡面应用" = cardapp 宿主)
    for (const sel of ['text=卡面应用', 'text=panel.type.ledger', 'text=panel.type.cardapp']) {
        const b = page.locator(sel).first();
        if (await b.isVisible().catch(() => false)) {
            await b.click().catch(() => {});
            await page.waitForTimeout(600);
            if ((await page.locator('.cardapp-host iframe').count()) > 0) break;
        }
    }

    try {
        await page.waitForSelector('.cardapp-host iframe', { timeout: 15000 });
    } catch (e) {
        await page.screenshot({ path: `${OUT}/${name}-noiframe.png`, fullPage: true });
        ok(`${name} cardapp iframe`, false, 'no .cardapp-host iframe');
        await ctx.close();
        return null;
    }
    ok(`${name} cardapp iframe mounted`, true);
    const hostBox = await page.locator('.cardapp-host').first().boundingBox();
    ok(
        `${name} cardapp-host size`,
        !!hostBox && hostBox.width > 200 && hostBox.height > 200,
        hostBox ? `${Math.round(hostBox.width)}x${Math.round(hostBox.height)}` : 'none',
    );

    const srcs = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src)).catch(() => []);
    let frame = null;
    for (let i = 0; i < 40; i++) {
        frame = page
            .frames()
            .find((f) => f !== page.mainFrame() && (f.url().includes('/card-runtime/') || (srcs[0] && f.url() === srcs[0])));
        if (frame) break;
        await page.waitForTimeout(500);
    }
    if (!frame && srcs.length) frame = page.frames().find((f) => f !== page.mainFrame());
    ok(`${name} card-runtime frame`, !!frame, frame ? frame.url().slice(0, 140) : 'no frame');
    if (!frame) {
        await ctx.close();
        return null;
    }

    try {
        await frame.waitForSelector('#card-app-container', { timeout: 15000 });
        ok(`${name} #card-app-container`, true);
    } catch (e) {
        ok(`${name} #card-app-container`, false);
    }
    await page.waitForTimeout(6000);
    const initState = await frame.evaluate(() => window.__CARDAPP_INIT__ ?? null).catch((e) => 'EVALERR ' + String(e).slice(0, 120));
    ok(`${name} card init`, !!initState && initState.ok === true, JSON.stringify(initState).slice(0, 400));
    const gate = await frame
        .evaluate(() => document.getElementById('card-app-container')?.dataset.gate)
        .catch(() => null);
    ok(`${name} gate flag`, gate === 'on' || gate === 'init', `gate=${gate} (init=intro on empty model)`);
    const kids = await frame
        .evaluate(() => document.getElementById('card-app-container')?.children.length ?? 0)
        .catch(() => 0);
    ok(`${name} card rendered content`, kids > 0, `children=${kids}`);
    const fails = await frame.evaluate(() => window.__zbfails ?? null).catch(() => null);
    ok(
        `${name} portrait/asset failures`,
        fails === null || fails === 0 || (Array.isArray(fails) && fails.length === 0),
        `__zbfails=${JSON.stringify(fails)}`,
    );

    const checkBand = async (hostW) => {
        const d = await frame
            .evaluate(() => {
                const el = document.querySelector('.zb-desk');
                if (!el) return null;
                const cs = getComputedStyle(el);
                return { maxWidth: cs.maxWidth, borderLeft: cs.borderLeftWidth };
            })
            .catch(() => null);
        if (!d) return { pass: false, d };
        // card CSS: @container zb-layout (max-width:760px) → max-width:100% + border:0;
        // ≥760 → max-width:min(1180px,94vw) + border-left ~1.5px.
        const pass = hostW < 760
            ? d.maxWidth === '100%' && d.borderLeft === '0px'
            : d.maxWidth.endsWith('px') && d.borderLeft !== '0px';
        return { pass, d };
    };
    const desk = await frame.evaluate(() => !!document.querySelector('.zb-desk')).catch(() => false);
    if (desk) {
        const hostW = hostBox ? hostBox.width : 0;
        const band = await checkBand(hostW);
        ok(`${name} container band (${Math.round(hostW)}px)`, band.pass, `desk=${JSON.stringify(band.d)}`);
    } else {
        console.log(`${name} .zb-desk not present (intro screen — empty model)`);
    }
    // ≥900 band via fullscreen pop (wb.fs「全屏」→ .cardapp-host-fs fixed inset-0)
    if (!mobile && desk) {
        const fsBtn = page.locator('button[title="全屏"]').first();
        let fsOk = false;
        if (await fsBtn.isVisible().catch(() => false)) {
            await fsBtn.click().catch(() => {});
            await page.waitForTimeout(600);
            fsOk = (await page.locator('.cardapp-host-fs').count()) > 0;
        }
        if (fsOk) {
            const fsBox = await page.locator('.cardapp-host-fs').first().boundingBox();
            const fsW = fsBox ? fsBox.width : 0;
            const band = await checkBand(fsW);
            ok(`${name} container band fs (${Math.round(fsW)}px)`, band.pass, `desk=${JSON.stringify(band.d)}`);
            await page.screenshot({ path: `${OUT}/${name}-cardapp-fs.png`, fullPage: true });
            await page.locator('.cardapp-fs-exit').first().click().catch(() => {});
        } else {
            console.log(`${name} fs toggle not found — skipping ≥900 band check`);
        }
    }
    await page.screenshot({ path: `${OUT}/${name}-cardapp.png`, fullPage: true });

    ok(`${name} mounts POST ok`, hits.mounts.length > 0 && hits.mounts[0].status >= 200 && hits.mounts[0].status < 300, JSON.stringify(hits.mounts[0] ?? null));
    ok(
        `${name} ?char= worlds`,
        hits.worldsChar.length > 0 && hits.worldsChar.every((w) => w.status === 200 && w.embedded === true),
        JSON.stringify(hits.worldsChar.slice(0, 3)),
    );
    ok(`${name} CORP-blocked assets`, hits.corpBlocked === 0, `blocked=${hits.corpBlocked} cardAppAssets=${hits.cardAppAssets}`);
    if (hits.consoleErr.length) console.log(`${name} console errors:`, JSON.stringify(hits.consoleErr.slice(0, 5)));

    await ctx.close();
    return hits;
}

async function main() {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const srvLog = fs.openSync('/tmp/cardapp-mount-e2e-server.log', 'w');
    const env = { ...process.env };
    if (PREBUILT) env.LUKER_PREBUILT_BUNDLES_DIR = PREBUILT;
    const srv = spawn(process.execPath, ['server.js', '--dataRoot', DATA, '--port', PORT], {
        cwd: ROOT + '/apps/server',
        env,
        stdio: ['ignore', srvLog, srvLog],
    });
    process.on('exit', () => {
        try {
            srv.kill();
        } catch {}
    });
    try {
        ok('server health', await waitHealth());
        const tok = await get(`${BASE}/csrf-token`);
        try {
            csrfToken = JSON.parse(tok.body).token ?? '';
        } catch {}
        ok('csrf token', !!csrfToken, `status=${tok.status}`);
        const cr = await post(
            `${BASE}/api/utopinn/characters/${encodeURIComponent(CHAR)}/chats/${encodeURIComponent(CHAT)}/messages`,
            {
                chat_metadata: {},
                message: { name: '', is_user: false, is_system: true, mes: '', send_date: new Date().toISOString(), extra: {} },
            },
        );
        ok('create chat', cr.status === 200 || cr.status === 201 || cr.status === 204, `status=${cr.status}`);

        // seed stat_data so the card mounts the desk shell (gate='on') and renders .zb-desk
        const statData = {
            day: 1,
            ['宗名']: '云栖宗',
            ['开场']: '毕',
            ['名册']: [{ ['名']: '掌门真人', ['差事']: '掌门', ['状态']: '在宗', ['信任']: 80, ['像']: '掌门_男' }],
            ['资源']: { ['灵石']: 120, ['灵田']: 2 },
            ['主线']: { ['重振山门']: '序' },
            ['行囊']: {},
        };
        const pr = await new Promise((resolve) => {
            const u = new URL(`${BASE}/api/utopinn/characters/${encodeURIComponent(CHAR)}/chats/${encodeURIComponent(CHAT)}`);
            const r = http.request(
                { host: u.hostname, port: u.port, path: u.pathname, method: 'PATCH', headers: { 'content-type': 'application/json', cookie: sessionCookie, 'x-csrf-token': csrfToken } },
                (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); },
            );
            r.on('error', () => resolve({ status: 0, body: '' }));
            r.write(JSON.stringify({ ops: [{ op: 'replace', path: '/header/chat_metadata/variables', value: { stat_data: statData } }] }));
            r.end();
        });
        ok('stat_data seeded', pr.status >= 200 && pr.status < 300, `status=${pr.status} ${String(pr.body).slice(0, 160)}`);

        const browser = await chromium.launch({ headless: true });
        await runViewport(browser, 'desktop', { viewport: { width: 1440, height: 900 } }, '', false);
        await runViewport(
            browser,
            'mobile',
            {
                viewport: { width: 390, height: 844 },
                hasTouch: true,
                isMobile: true,
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            },
            '?vp=mobile',
            true,
        );
        await browser.close();
    } finally {
        srv.kill();
    }
    fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    const passes = results.checks.filter((c) => c.v).length;
    console.log(`\n== ${passes}/${results.checks.length} pass; failures: ${results.failures.join(',') || 'none'}`);
    process.exit(results.failures.length ? 1 : 0);
}
main().catch((e) => {
    console.error('FATAL', e);
    process.exit(2);
});
