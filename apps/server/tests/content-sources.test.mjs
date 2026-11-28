/**
 * Configurable content sources (node:test).
 *
 * content-manager.js used to hard-code exactly two source roots
 * (default/content + default/scaffold); adding a release content root meant
 * editing server source. The `contentSources` config key now lists
 * additional roots as data:
 *
 *   - A configured source is picked up and its index entries are merged
 *     (and actually seeded into a new account).
 *   - Precedence is declaration order — a later-declared source overrides
 *     same-named entries from earlier ones: configured sources > scaffold >
 *     upstream content. The merged index puts the highest-precedence source
 *     first because the seed pipeline copies the first match and skips
 *     same-filename duplicates.
 *   - A missing dir, malformed index, escaping path, or bad config shape is
 *     skipped with a warning — never a crash, never silently swallowed.
 *
 * The in-process tests inject sources through LUKER_CONTENT_SOURCES (env
 * overrides config.yaml in getConfigValue and is read per call, so each
 * case gets its own source list without re-seeding the cached config).
 * The e2e spawns a real `node server.js` whose config.yaml sets the key —
 * the operator-facing path.
 *
 * Run: node --test apps/server/tests/content-sources.test.mjs
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
const hasSpa = fs.existsSync(WEB_INDEX);
const SKIP_NO_SPA = hasSpa ? false : 'apps/web/dist not built — run pnpm --filter @utopinn/web build first';

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-content-sources-'));
const dataRoot = path.join(scratchRoot, 'data');
fs.mkdirSync(dataRoot, { recursive: true });
const configPath = path.join(scratchRoot, 'config.yaml');
fs.writeFileSync(configPath, 'enableUserAccounts: false\n');

globalThis.DATA_ROOT = dataRoot;
const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(configPath);
const contentManager = await import('../src/endpoints/content-manager.js');

const ENV_KEY = 'LUKER_CONTENT_SOURCES';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

/** Run fn with LUKER_CONTENT_SOURCES set; restore the prior value after. */
function withSources(sources, fn) {
    const prev = process.env[ENV_KEY];
    if (sources === undefined) {
        delete process.env[ENV_KEY];
    } else {
        process.env[ENV_KEY] = JSON.stringify(sources);
    }
    try {
        return fn();
    } finally {
        if (prev === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = prev;
        }
    }
}

/** Capture console.warn lines produced while fn runs. */
function captureWarn(fn) {
    const lines = [];
    const orig = console.warn;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
        return { lines, result: fn() };
    } finally {
        console.warn = orig;
    }
}

/** Create a content source dir under the scratch data root with an index + files. */
function makeSource(name, { entries, files = {}, indexName = 'index.json', rawIndex = null }) {
    const dir = path.join(dataRoot, 'packs', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, indexName), rawIndex ?? JSON.stringify(entries));
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return dir;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

test('built-ins work with no configured sources: upstream index entries and the scaffold card are merged', () => {
    withSources(undefined, () => {
        const settings = contentManager.getContentOfType('settings', 'json');
        assert.ok(settings.length >= 1, 'default/content settings.json must still merge');

        const characters = contentManager.getContentOfType('character', 'raw');
        assert.equal(characters.length, 1, 'default/scaffold still supplies the starter card');
    });
});

test('a configured source under dataRoot is picked up and its entries are returned', () => {
    const pack = makeSource('atlas', {
        entries: [{ filename: 'worlds/atlas.json', type: 'world' }],
        files: { 'worlds/atlas.json': '{"entries":{"atlas":{"uid":1}}}' },
    });

    withSources([{ path: pack }], () => {
        const worlds = contentManager.getContentOfType('world', 'json');
        assert.deepEqual(worlds, [{ entries: { atlas: { uid: 1 } } }]);
    });
});

test('a bare string entry is shorthand for { path } and a relative path resolves against the server dir', () => {
    // default/scaffold is a real source under the server dir — declaring it
    // again exercises relative resolution without writing into the repo.
    withSources(['default/scaffold'], () => {
        const { lines } = captureWarn(() => {
            const characters = contentManager.getContentOfType('character', 'raw');
            assert.equal(characters.length, 2, 'the scaffold index is merged once per declaring source');
            assert.ok(characters[0].equals(characters[1]));
        });
        assert.deepEqual(lines, []);
    });
});

test('precedence: a later-declared source sorts ahead of earlier ones (first match wins at seed time)', () => {
    const older = makeSource('older', {
        entries: [{ filename: 'worlds/dup.json', type: 'world' }],
        files: { 'worlds/dup.json': '{"from":"older"}' },
    });
    const newer = makeSource('newer', {
        entries: [{ filename: 'worlds/dup.json', type: 'world' }],
        files: { 'worlds/dup.json': '{"from":"newer"}' },
    });
    // A source that shadows the scaffold starter card, declared last.
    const shadow = makeSource('shadow', {
        entries: [{ filename: 'characters/我没想当掌门啊.png', type: 'character' }],
        files: { 'characters/我没想当掌门啊.png': 'SHADOW-PNG' },
    });

    withSources([{ path: older }, { path: newer }, { path: shadow }], () => {
        const worlds = contentManager.getContentOfType('world', 'json');
        assert.deepEqual(worlds, [{ from: 'newer' }, { from: 'older' }],
            'the last-declared source must come first — the seed pipeline copies the first match');

        const characters = contentManager.getContentOfType('character', 'string');
        assert.equal(characters[0], 'SHADOW-PNG', 'a configured source shadows even the scaffold card');
    });
});

test('getDefaultPresetFile searches all sources in precedence order', () => {
    const pack = makeSource('presets', {
        entries: [{ filename: 'presets/openai/Pack.json', type: 'openai_preset' }],
        files: { 'presets/openai/Pack.json': '{"from":"pack"}' },
    });

    withSources([{ path: pack }], () => {
        assert.deepEqual(contentManager.getDefaultPresetFile('presets/openai/Pack.json'), { from: 'pack' });
        // Upstream file still resolves through the built-in source.
        assert.ok(contentManager.getDefaultPresetFile('settings.json'));
        assert.equal(contentManager.getDefaultPresetFile('presets/openai/Does-Not-Exist.json'), null);
    });
});

// ---------------------------------------------------------------------------
// Failure handling: warn + skip, never crash
// ---------------------------------------------------------------------------

test('a missing source directory warns and is skipped', () => {
    const missing = path.join(dataRoot, 'packs', 'not-there');
    withSources([{ path: missing }], () => {
        const { lines, result } = captureWarn(() => contentManager.getContentOfType('world', 'json'));
        assert.deepEqual(result, [], 'the merge continues with the remaining sources');
        assert.ok(lines.some(l => l.includes('does not exist')), `expected a missing-index warning, got: ${lines}`);
    });
});

test('a malformed index.json warns and is skipped', () => {
    const pack = makeSource('broken', { entries: [], rawIndex: 'not json{' });
    withSources([{ path: pack }], () => {
        const { lines, result } = captureWarn(() => contentManager.getContentOfType('world', 'json'));
        assert.deepEqual(result, []);
        assert.ok(lines.some(l => l.includes('not valid JSON')), `expected a parse warning, got: ${lines}`);
    });
});

test('a non-array index warns and is skipped', () => {
    const pack = makeSource('object-index', { entries: [], rawIndex: '{"entries":{}}' });
    withSources([{ path: pack }], () => {
        const { lines } = captureWarn(() => contentManager.getContentOfType('world', 'json'));
        assert.ok(lines.some(l => l.includes('not an array')), `expected a shape warning, got: ${lines}`);
    });
});

test('malformed index entries are skipped and counted, valid siblings still merge', () => {
    const pack = makeSource('mixed', {
        entries: [
            'junk-string-entry',
            { filename: 'worlds/ok.json', type: 'world' },
            { filename: 42, type: 'world' },
            { filename: 'worlds/no-type.json' },
        ],
        files: { 'worlds/ok.json': '{"ok":true}' },
    });
    withSources([{ path: pack }], () => {
        const { lines, result } = captureWarn(() => contentManager.getContentOfType('world', 'json'));
        assert.deepEqual(result, [{ ok: true }]);
        assert.ok(lines.some(l => l.includes('skipped 3 malformed')), `expected a count warning, got: ${lines}`);
    });
});

test('a path escaping the server dir and dataRoot is rejected with a warning', () => {
    withSources([{ path: '/etc' }, { path: '../../../../usr/share' }], () => {
        const { lines, result } = captureWarn(() => contentManager.getContentOfType('world', 'json'));
        assert.deepEqual(result, []);
        const escapes = lines.filter(l => l.includes('resolves outside'));
        assert.equal(escapes.length, 2, `each escaping path must warn once, got: ${lines}`);
    });
});

test('an index name that is not a plain file name is rejected with a warning', () => {
    const pack = makeSource('index-escape', { entries: [] });
    withSources([{ path: pack, index: '../outside.json' }], () => {
        const { lines } = captureWarn(() => contentManager.getContentOfType('world', 'json'));
        assert.ok(lines.some(l => l.includes('invalid index name')), `expected an index-name warning, got: ${lines}`);
    });
});

test('a non-list contentSources value warns and falls back to the built-ins', () => {
    const prev = process.env[ENV_KEY];
    process.env[ENV_KEY] = '{"path":"/tmp/x"}';
    try {
        const { lines, result } = captureWarn(() => contentManager.getContentOfType('settings', 'json'));
        assert.ok(result.length >= 1, 'built-in content must still merge');
        assert.ok(lines.some(l => l.includes('must be a list')), `expected a shape warning, got: ${lines}`);
    } finally {
        if (prev === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = prev;
        }
    }
});

// ---------------------------------------------------------------------------
// End-to-end: a config.yaml entry delivers files into a new account
// ---------------------------------------------------------------------------

/** node-persist record: one file named sha256(key), JSON {key, value}. */
function seedStoredItem(dataRootDir, key, value) {
    const storageDir = path.join(dataRootDir, '_storage');
    fs.mkdirSync(storageDir, { recursive: true });
    const file = crypto.createHash('sha256').update(key).digest('hex');
    fs.writeFileSync(path.join(storageDir, file), JSON.stringify({ key, value }));
}

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

test('e2e: a config.yaml contentSources entry seeds files into a new account and shadows the scaffold card', { skip: SKIP_NO_SPA }, async () => {
    const port = await reservePort();
    const dir = path.join(scratchRoot, `run-${port}`);
    const runDataRoot = path.join(dir, 'data');
    const runConfigPath = path.join(dir, 'config.yaml');

    // The pack lives inside the data root — the allowed location for packs
    // that are not shipped with the server tree. It declares a new card and
    // a same-named shadow of the scaffold starter card.
    const pack = path.join(runDataRoot, 'content-pack');
    fs.mkdirSync(path.join(pack, 'characters'), { recursive: true });
    fs.writeFileSync(path.join(pack, 'index.json'), JSON.stringify([
        { filename: 'characters/pack-card.png', type: 'character' },
        { filename: 'characters/我没想当掌门啊.png', type: 'character' },
    ]));
    fs.writeFileSync(path.join(pack, 'characters', 'pack-card.png'), 'PACK-CARD-BYTES');
    fs.writeFileSync(path.join(pack, 'characters', '我没想当掌门啊.png'), 'SHADOW-WINS');

    fs.writeFileSync(runConfigPath, [
        'enableUserAccounts: true',
        'contentSources:',
        `  - path: ${JSON.stringify(pack)}`,
        '',
    ].join('\n'));
    seedStoredItem(runDataRoot, 'luker:admin-settings:v1', {
        accountRegistration: { enabled: true, requireInviteCode: false },
    });

    const env = { ...process.env, LUKER_SKIP_WEBPACK: '1' };
    for (const key of Object.keys(env)) {
        if (/^(SILLYTAVERN_|LUKER_)/.test(key) && key !== 'LUKER_SKIP_WEBPACK') {
            delete env[key];
        }
    }

    const child = spawn(process.execPath, [
        'server.js', '--dataRoot', runDataRoot, '--port', String(port), '--configPath', runConfigPath,
    ], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });

    const base = `http://127.0.0.1:${port}`;
    try {
        await waitReady(base, child);

        const jar = new Map();
        const request = async (url, init = {}) => {
            const headers = { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
            const res = await fetch(`${base}${url}`, { ...init, headers, redirect: 'manual' });
            for (const c of res.headers.getSetCookie()) {
                const [pair] = c.split(';');
                const eq = pair.indexOf('=');
                if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
            }
            return res;
        };
        const tokenRes = await request('/csrf-token');
        const { token } = await tokenRes.json();
        const res = await request('/api/users/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': token },
            body: JSON.stringify({ handle: 'packuser', name: 'packuser', password: 'test-pass-1234' }),
        });
        assert.equal(res.status, 200, `registration failed\n${await res.text()}`);

        const chars = path.join(runDataRoot, 'packuser', 'characters');
        assert.equal(fs.readFileSync(path.join(chars, 'pack-card.png'), 'utf8'), 'PACK-CARD-BYTES',
            'the configured source must seed its declared file');
        assert.equal(fs.readFileSync(path.join(chars, '我没想当掌门啊.png'), 'utf8'), 'SHADOW-WINS',
            'the later-declared source must shadow the scaffold same-named entry');
    } catch (err) {
        err.message += `\n--- server log ---\n${log.slice(-2000)}`;
        throw err;
    } finally {
        child.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        if (child.exitCode === null) child.kill('SIGKILL');
    }
});
