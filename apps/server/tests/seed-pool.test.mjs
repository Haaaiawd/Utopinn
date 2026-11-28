/**
 * Seed pool hardening — staged publish, quota reservation, dry-run honesty,
 * and starter-card visibility (node:test).
 *
 * Coverage for the PR review findings on seedUserDirectories / the
 * seed-accounts maintenance script:
 *
 *  - A failed nested copy must not leave a partial destination directory
 *    behind: the copy stages into a sibling `.seed-*` directory and publishes
 *    only a complete entry, so a repaired source is picked up by the next
 *    backfill pass instead of being skipped forever.
 *  - Starter entries reserve quota through checkUserStorageQuota (the same
 *    accounting shared-card installation uses). An entry that would push the
 *    account over quota is skipped and reported — registration still
 *    succeeds and the account never ends up over quota.
 *  - `seed-accounts.js --dry-run` must be truly read-only: no config file is
 *    created or migrated, no `_storage` directory is created, and no
 *    bootstrap `default-user` is inserted into an empty store.
 *  - The release seed pool actually delivers a usable card: the freshly
 *    registered user sees the character document in the library list and can
 *    open it — not just have a `card-apps/` asset directory on disk.
 *
 * The in-process tests drive services/seed-content.js directly against a
 * scratch DATA_ROOT; the quota test additionally boots node-persist +
 * checkUserStorageQuota on a scratch store. The end-to-end tests spawn a
 * real `node server.js` (same harness as login-spa-fallback.test.mjs) and
 * the script tests spawn the CLI itself.
 *
 * Run: node --test apps/server/tests/seed-pool.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const serverDir = path.resolve(import.meta.dirname, '..');
const WEB_INDEX = path.join(serverDir, '..', 'web', 'dist', 'index.html');
const SEED_ACCOUNTS_SCRIPT = path.join(serverDir, 'scripts', 'seed-accounts.js');
const DEFAULT_CONTENT_DIR = path.join(serverDir, 'default', 'content');

const hasSpa = fs.existsSync(WEB_INDEX);
const SKIP_NO_SPA = hasSpa ? false : 'apps/web/dist not built — run pnpm --filter @utopinn/web build first';

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-seed-pool-'));

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

/** Minimal UserDirectoryList shape seedUserDirectories consumes — keys are USER_DIRECTORY_TEMPLATE keys. */
function makeUserDirs(root) {
    return {
        root,
        characters: path.join(root, 'characters'),
        worlds: path.join(root, 'worlds'),
        cardApps: path.join(root, 'card-apps'),
    };
}

/** Write a seed pool entry under <dataRoot>/_seed/<subdir>/<name>. */
function makeSeedEntry(dataRoot, subdir, name, files) {
    const dir = path.join(dataRoot, '_seed', subdir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return dir;
}

function listRelativeFiles(dir) {
    const out = [];
    const walk = (current, prefix) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(path.join(current, entry.name), rel);
            } else {
                out.push(rel);
            }
        }
    };
    walk(dir, '');
    return out.sort();
}

/** node-persist record: one file named sha256(key), JSON {key, value}. */
function seedStoredItem(dataRoot, key, value) {
    const storageDir = path.join(dataRoot, '_storage');
    fs.mkdirSync(storageDir, { recursive: true });
    const file = crypto.createHash('sha256').update(key).digest('hex');
    fs.writeFileSync(path.join(storageDir, file), JSON.stringify({ key, value }));
}

function seedAdminSettings(dataRoot, settings) {
    seedStoredItem(dataRoot, 'luker:admin-settings:v1', settings);
}

function storageFiles(dataRoot) {
    const storageDir = path.join(dataRoot, '_storage');
    return fs.existsSync(storageDir) ? fs.readdirSync(storageDir) : [];
}

/** Recursive byte total, same walk semantics as getDirectorySizeBytes. */
function dirSizeBytes(dir) {
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!fs.existsSync(current)) continue;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile()) {
                total += fs.statSync(full).size;
            }
        }
    }
    return total;
}

// ---------------------------------------------------------------------------
// Service-level tests (in-process, no server)
// ---------------------------------------------------------------------------

test('staged publish: a failed nested copy leaves no partial directory, and backfill completes after the source is repaired', async () => {
    const dataRoot = path.join(scratchRoot, 'svc-atomic');
    fs.mkdirSync(dataRoot, { recursive: true });
    makeSeedEntry(dataRoot, 'card-apps', '卡A', {
        'index.js': 'export const x = 1;',
        'assets/立绘/掌门.webp': crypto.randomBytes(256),
    });
    const dirs = makeUserDirs(path.join(dataRoot, 'tester'));

    globalThis.DATA_ROOT = dataRoot;
    const { seedUserDirectories } = await import('../src/services/seed-content.js');

    // Force the nested copy to fail mid-way: the implementation stages with
    // fs.promises.cp, so rejecting its first call is the deterministic
    // equivalent of the unreadable-asset failure from the report — and works
    // regardless of uid / filesystem permission semantics.
    const realCp = fs.promises.cp;
    let first = true;
    fs.promises.cp = async (...args) => {
        if (first) {
            first = false;
            throw Object.assign(new Error('simulated nested copy failure'), { code: 'EACCES' });
        }
        return realCp.apply(fs.promises, args);
    };
    let report;
    try {
        report = await seedUserDirectories(dirs);
    } finally {
        fs.promises.cp = realCp;
    }

    const dest = path.join(dirs.cardApps, '卡A');
    assert.equal(report.errors.length, 1, 'the failed entry must be reported');
    assert.equal(report.copied.length, 0);
    assert.ok(!fs.existsSync(dest), 'no partial destination may be published');
    const residue = fs.existsSync(dirs.cardApps)
        ? fs.readdirSync(dirs.cardApps).filter(n => n.startsWith('.seed-'))
        : [];
    assert.deepEqual(residue, [], 'failed staging copies must be cleaned up');

    // After the source is repaired the same call completes the card — this is
    // the backfill property fs.cp's early mkdir broke.
    const second = await seedUserDirectories(dirs);
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.copied, [dest]);
    assert.deepEqual(listRelativeFiles(dest), ['assets/立绘/掌门.webp', 'index.js']);
});

test('staged publish: an unreadable nested source directory publishes nothing (skipped when the FS ignores permission bits)', async (t) => {
    const dataRoot = path.join(scratchRoot, 'svc-eacces');
    fs.mkdirSync(dataRoot, { recursive: true });
    const entryDir = makeSeedEntry(dataRoot, 'card-apps', '卡B', {
        'index.js': 'x',
        'assets/secret.bin': 'secret',
    });
    const dirs = makeUserDirs(path.join(dataRoot, 'tester'));
    globalThis.DATA_ROOT = dataRoot;
    const { seedUserDirectories } = await import('../src/services/seed-content.js');

    const nested = path.join(entryDir, 'assets');
    fs.chmodSync(nested, 0o000);
    let report;
    try {
        // Some filesystems (and uid 0) ignore permission bits — probe before
        // asserting so the case degrades to a skip instead of a false fail.
        fs.readdirSync(nested);
        t.skip(`permission bits not enforced here (uid ${typeof process.geteuid === 'function' ? process.geteuid() : '?'})`);
    } catch {
        report = await seedUserDirectories(dirs);
    } finally {
        fs.chmodSync(nested, 0o755);
    }
    if (!report) return;

    const dest = path.join(dirs.cardApps, '卡B');
    assert.equal(report.errors.length, 1);
    assert.ok(!fs.existsSync(dest), 'no partial destination may be published');

    const second = await seedUserDirectories(dirs);
    assert.deepEqual(second.errors, []);
    assert.deepEqual(listRelativeFiles(dest), ['assets/secret.bin', 'index.js']);
});

test('quota: an entry that would exceed the account quota is skipped, reported, and never lands', async () => {
    const dataRoot = path.join(scratchRoot, 'svc-quota');
    const storageDir = path.join(dataRoot, '_storage');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'config.yaml'), 'enableUserAccounts: true\n');
    makeSeedEntry(dataRoot, 'card-apps', 'fits', { 'a.bin': crypto.randomBytes(70_000) });
    makeSeedEntry(dataRoot, 'card-apps', 'too-big', { 'b.bin': crypto.randomBytes(70_000) });

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(dataRoot, 'config.yaml'));
    const { default: storage } = await import('node-persist');
    await storage.init({ dir: storageDir, ttl: false, expiredInterval: 0 });

    globalThis.DATA_ROOT = dataRoot;
    const { checkUserStorageQuota } = await import('../src/users.js');
    const { seedUserDirectories } = await import('../src/services/seed-content.js');

    const dirs = makeUserDirs(path.join(dataRoot, 'quota-user'));
    const user = {
        profile: { handle: 'quota-user', admin: false, storageQuotaBytes: 100_000 },
        directories: dirs,
    };
    const report = await seedUserDirectories(dirs, {
        checkQuota: (bytes) => checkUserStorageQuota(user, bytes, { fresh: true }),
    });

    assert.deepEqual(report.copied, [path.join(dirs.cardApps, 'fits')]);
    assert.equal(report.quotaSkipped.length, 1, 'the oversized entry must be reported');
    assert.equal(report.quotaSkipped[0].destination, path.join(dirs.cardApps, 'too-big'));
    assert.equal(report.quotaSkipped[0].bytes, 70_000);
    assert.match(report.quotaSkipped[0].message, /[Qq]uota/);
    assert.ok(!fs.existsSync(report.quotaSkipped[0].destination));
    assert.deepEqual(report.errors, []);
    assert.ok(dirSizeBytes(dirs.root) <= 100_000, 'seeding must never push the account over quota');
});

test('file entries publish whole via link and never clobber user content; dryRun reports without writing', async () => {
    const dataRoot = path.join(scratchRoot, 'svc-files');
    fs.mkdirSync(dataRoot, { recursive: true });
    const seedFile = path.join(dataRoot, '_seed', 'worlds');
    fs.mkdirSync(seedFile, { recursive: true });
    fs.writeFileSync(path.join(seedFile, 'atlas.json'), '{"entries":{}}');
    fs.mkdirSync(path.join(dataRoot, '_seed', 'characters'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, '_seed', 'characters', 'atlas.png'), 'PNG-BYTES');

    const dirs = makeUserDirs(path.join(dataRoot, 'tester'));
    globalThis.DATA_ROOT = dataRoot;
    const { seedUserDirectories } = await import('../src/services/seed-content.js');

    const report = await seedUserDirectories(dirs);
    assert.equal(report.errors.length, 0);
    assert.equal(report.copied.length, 2);
    const destFile = path.join(dirs.worlds, 'atlas.json');
    assert.equal(fs.readFileSync(destFile, 'utf8'), '{"entries":{}}');
    assert.equal(fs.readFileSync(path.join(dirs.characters, 'atlas.png'), 'utf8'), 'PNG-BYTES');

    // Existing destination always wins — user content is never replaced.
    fs.writeFileSync(destFile, '{"user":true}');
    const second = await seedUserDirectories(dirs);
    assert.equal(second.copied.length, 0);
    assert.equal(second.skipped.length, 2);
    assert.equal(fs.readFileSync(destFile, 'utf8'), '{"user":true}');

    // dryRun reports the same plan while writing nothing.
    const freshDirs = makeUserDirs(path.join(dataRoot, 'dry'));
    const dry = await seedUserDirectories(freshDirs, { dryRun: true });
    assert.equal(dry.copied.length, 2);
    assert.ok(!fs.existsSync(freshDirs.root), 'dryRun must not create the account tree');
});

// ---------------------------------------------------------------------------
// Script-level tests: --dry-run honesty
// ---------------------------------------------------------------------------

function runSeedAccounts(args) {
    return spawnSync(process.execPath, [SEED_ACCOUNTS_SCRIPT, ...args], {
        cwd: serverDir,
        encoding: 'utf8',
        env: { ...process.env },
    });
}

test('--dry-run creates nothing: no config file, no _storage, no account tree', () => {
    const dataRoot = path.join(scratchRoot, 'script-dry-nostore');
    fs.mkdirSync(dataRoot, { recursive: true });
    makeSeedEntry(dataRoot, 'card-apps', '卡X', { 'index.js': 'x' });
    const configPath = path.join(dataRoot, 'config.yaml');

    const run = runSeedAccounts(['--dry-run', '--dataRoot', dataRoot, '--configPath', configPath]);
    assert.equal(run.status, 0, `dry run must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

    // The store was absent, so there was nothing to enumerate — and dry-run
    // must not have initialized it or inserted the bootstrap default-user.
    assert.ok(!fs.existsSync(path.join(dataRoot, '_storage')), 'no _storage dir may be created');
    assert.ok(!fs.existsSync(configPath), 'no config file may be created');
    const leftovers = fs.readdirSync(dataRoot).filter(n => n !== '_seed');
    assert.deepEqual(leftovers, [], `unexpected writes: ${leftovers.join(', ')}`);
});

test('--dry-run reports the plan against an existing store but writes nothing', () => {
    const dataRoot = path.join(scratchRoot, 'script-dry-store');
    fs.mkdirSync(dataRoot, { recursive: true });
    makeSeedEntry(dataRoot, 'card-apps', '卡X', { 'index.js': 'x', 'assets/a.bin': 'aa' });
    seedStoredItem(dataRoot, 'user:alice', { handle: 'alice', name: 'Alice', admin: false, enabled: true });
    const configPath = path.join(dataRoot, 'config.yaml');
    const before = storageFiles(dataRoot);

    const run = runSeedAccounts(['--dry-run', '--dataRoot', dataRoot, '--configPath', configPath]);
    assert.equal(run.status, 0, `dry run must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /would copy/, 'the plan must be reported');
    assert.match(run.stdout, /alice/);
    assert.match(run.stdout, /dry run/i);

    // Nothing landed: no account tree, no config, no bootstrap user record.
    assert.ok(!fs.existsSync(path.join(dataRoot, 'alice')), 'dry run must not create the account tree');
    assert.ok(!fs.existsSync(configPath), 'dry run must not create the config file');
    assert.deepEqual(storageFiles(dataRoot).sort(), before.sort(), 'no records may be added to the store');

    // Control: the real run DOES deliver the entry — the dry-run assertions
    // above mean something only because the write path is actually exercised.
    const real = runSeedAccounts(['--dataRoot', dataRoot, '--configPath', configPath]);
    assert.equal(real.status, 0, `real run must exit 0\nstdout:\n${real.stdout}\nstderr:\n${real.stderr}`);
    assert.match(real.stdout, /copied/);
    assert.ok(fs.existsSync(path.join(dataRoot, 'alice', 'card-apps', '卡X', 'index.js')));
    assert.ok(fs.existsSync(configPath), 'a real run creates the missing config as before');
});

test('--dry-run does not create or migrate a config — a minimal file stays byte-identical', () => {
    const dataRoot = path.join(scratchRoot, 'script-dry-nomig');
    fs.mkdirSync(dataRoot, { recursive: true });
    makeSeedEntry(dataRoot, 'card-apps', '卡Y', { 'index.js': 'y' });
    const configPath = path.join(dataRoot, 'config.yaml');
    const minimal = `dataRoot: ${JSON.stringify(dataRoot)}\nenableUserAccounts: true\n`;
    fs.writeFileSync(configPath, minimal);

    const run = runSeedAccounts(['--dry-run', '--configPath', configPath]);
    assert.equal(run.status, 0, `dry run must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(fs.readFileSync(configPath, 'utf8'), minimal, 'dry run must not rewrite the config');
});

// ---------------------------------------------------------------------------
// End-to-end: real server
// ---------------------------------------------------------------------------

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

/**
 * Same harness as login-spa-fallback.test.mjs: spawn `node server.js` in SPA
 * mode against a scratch dataRoot + --configPath. options.seed(dataRoot) runs
 * before boot; fn receives (base, {log, configPath, dataRoot}).
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
        await fn(base, { log: () => log, configPath, dataRoot });
    } catch (err) {
        err.message += `\n--- server log ---\n${log.slice(-2000)}`;
        throw err;
    } finally {
        child.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        if (child.exitCode === null) child.kill('SIGKILL');
    }
}

/** Minimal cookie jar for the register → authenticated-GET flow. */
class Session {
    cookies = new Map();
    absorb(res) {
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(';');
            const eq = pair.indexOf('=');
            if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
        }
    }
    header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    async request(base, url, init = {}) {
        const headers = { ...(init.headers || {}), cookie: this.header() };
        const res = await fetch(`${base}${url}`, { ...init, headers, redirect: 'manual' });
        this.absorb(res);
        return res;
    }
}

async function registerUser(base, handle, password = 'test-pass-1234') {
    const session = new Session();
    const tokenRes = await session.request(base, '/csrf-token');
    const { token } = await tokenRes.json();
    const res = await session.request(base, '/api/users/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ handle, name: handle, password }),
    });
    return { session, res };
}

test('e2e: registration skips an over-quota seed entry, reports it, and keeps the account under quota', { skip: SKIP_NO_SPA }, async () => {
    // defaultUserQuotaBytes leaves ~512KB of headroom over the content the
    // registration flow itself provisions (default/content minus index.json,
    // plus a slack allowance for settings/content.log). The 200KB card fits;
    // the 2MB one does not.
    const indexSize = fs.statSync(path.join(DEFAULT_CONTENT_DIR, 'index.json')).size;
    const contentBytes = dirSizeBytes(DEFAULT_CONTENT_DIR) - indexSize;
    const quota = contentBytes + 512_000;

    await withRealServer(async (base, ctx) => {
        const { session, res } = await registerUser(base, 'seedquota');
        assert.equal(res.status, 200, `registration must succeed even when a seed entry does not fit\n${await res.text()}`);

        const accountRoot = path.join(ctx.dataRoot, 'seedquota');
        assert.ok(fs.existsSync(path.join(accountRoot, 'card-apps', '小卡', 'index.js')),
            'the entry that fits must be delivered');
        assert.ok(!fs.existsSync(path.join(accountRoot, 'card-apps', '大卡')),
            'the over-quota entry must be skipped entirely — no partial publish');
        assert.ok(dirSizeBytes(accountRoot) <= quota,
            'the account must not end up over its quota after seeding');
        assert.match(ctx.log(), /over quota/i, 'the skip must be logged');
    }, {
        seed: (dataRoot) => {
            seedAdminSettings(dataRoot, {
                accountRegistration: { enabled: true, requireInviteCode: false },
                storage: { defaultUserQuotaBytes: quota },
            });
            makeSeedEntry(dataRoot, 'card-apps', '小卡', { 'index.js': 'x', 'assets/p.png': crypto.randomBytes(200_000) });
            makeSeedEntry(dataRoot, 'card-apps', '大卡', { 'index.js': 'x', 'assets/p.png': crypto.randomBytes(2_000_000) });
        },
    });
});

test('e2e: a newly registered user sees the starter card in the library and can open it', { skip: SKIP_NO_SPA }, async () => {
    // The release seed pool pairs `_seed/card-apps/<name>/` (the CardApp
    // assets, copied by seedUserDirectories at registration) with a matching
    // character document shipped via default/content/. Assert the pool really
    // supplies that document — if this check fails it is a product decision,
    // not something a test may silently paper over.
    const index = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONTENT_DIR, 'index.json'), 'utf8'));
    const charEntry = index.find(e => e.type === 'character');
    assert.ok(charEntry, 'default/content must ship a character document for the starter card');
    assert.ok(fs.existsSync(path.join(DEFAULT_CONTENT_DIR, charEntry.filename)),
        `the character document ${charEntry.filename} must exist in default/content`);
    const charDir = path.basename(charEntry.filename, path.extname(charEntry.filename));

    await withRealServer(async (base) => {
        const { session, res } = await registerUser(base, 'cardviewer');
        const registerBody = await res.text();
        assert.equal(res.status, 200, `registration failed\n${registerBody}`);

        const list = await session.request(base, '/api/utopinn/characters');
        const listBody = await list.text();
        assert.equal(list.status, 200, `character list failed\n${listBody}`);
        const { items } = JSON.parse(listBody);
        const card = items.find(i => i.charDir === charDir);
        assert.ok(card, `${charDir} must appear in the new user's character list`);
        assert.equal(card.readable, true, 'the card must parse, not just be listed');

        const detail = await session.request(base, `/api/utopinn/characters/${encodeURIComponent(charDir)}`);
        const detailBody = await detail.text();
        assert.equal(detail.status, 200, `opening the card failed\n${detailBody}`);
        const doc = JSON.parse(detailBody);
        assert.ok(doc.name || doc.data?.name, 'the opened card must carry a name');
    }, {
        seed: (dataRoot) => {
            seedAdminSettings(dataRoot, {
                accountRegistration: { enabled: true, requireInviteCode: false },
            });
            // The CardApp asset side of the release pool — same directory the
            // release ships for the 掌门 card (name matches the card's own).
            makeSeedEntry(dataRoot, 'card-apps', '我没想当掌门啊', {
                'index.js': 'export default {};',
                'style.css': 'body{margin:0}',
                'assets/立绘/掌门.webp': crypto.randomBytes(64),
            });
        },
    });
});
