import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import storage from 'node-persist';

// Lift the register rate-limit ceiling before users-public.js binds it at
// module load — the suite drives several /register attempts.
process.env.LUKER_RATE_LIMITING_ACCOUNTS_REGISTER_MAX_ATTEMPTS = '0';

const checkForNewContentSpy = jest.fn(async () => false);

jest.unstable_mockModule('../src/endpoints/content-manager.js', () => ({
    checkForNewContent: (...args) => checkForNewContentSpy(...args),
    CONTENT_TYPES: {
        SETTINGS: 'settings',
        CHARACTER: 'character',
        SPRITES: 'sprites',
        BACKGROUND: 'background',
        WORLD: 'world',
        AVATAR: 'avatar',
        THEME: 'theme',
        WORKFLOW: 'workflow',
        KOBOLD_PRESET: 'kobold_preset',
        OPENAI_PRESET: 'openai_preset',
        NOVEL_PRESET: 'novel_preset',
        TEXTGEN_PRESET: 'textgen_preset',
        INSTRUCT: 'instruct',
        CONTEXT: 'context',
        MOVING_UI: 'moving_ui',
        QUICK_REPLIES: 'quick_replies',
        SYSPROMPT: 'sysprompt',
        REASONING: 'reasoning',
        ERROR_PAGE: 'error_page',
        STYLESHEET: 'stylesheet',
    },
    CONTENT_SCOPE: { GLOBAL: 'global', USER: 'user' },
    getContentOfType: () => [],
    getDefaultPresets: () => [],
    getDefaultPresetFile: () => '',
    seedContentForUser: async () => false,
    getUserTargetByType: () => null,
    getGlobalTargetByType: () => null,
    getHostFromUrl: () => '',
    isHostWhitelisted: () => false,
    router: express.Router(),
}));

const { router: publicRouter } = await import('../src/endpoints/users-public.js');
const { getUserDirectories } = await import('../src/users.js');
const { saveAdminSettings } = await import('../src/admin-settings.js');
const { seedUserDirectories, getSeedRoot, SEED_ROOT_DIRNAME } = await import('../src/services/seed-content.js');

const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-seed-test-'));
const PREV_DATA_ROOT = globalThis.DATA_ROOT;

const CARD_NAME = '我没想当掌门啊';

/** Builds a seed card fixture with nested dirs and Chinese file names. */
function makeSeedCard(seedRoot) {
    const cardDir = path.join(seedRoot, 'card-apps', CARD_NAME);
    fs.mkdirSync(path.join(cardDir, 'assets', '立绘'), { recursive: true });
    fs.mkdirSync(path.join(cardDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(cardDir, 'index.js'), 'console.log("card");\n');
    fs.writeFileSync(path.join(cardDir, 'style.css'), 'body{}\n');
    fs.writeFileSync(path.join(cardDir, 'assets', '立绘', '掌门.webp'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(cardDir, 'data-数据.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(cardDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return cardDir;
}

function listFilesRecursive(dir, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
        } else {
            out.push(rel);
        }
    }
    return out;
}

function makeApp() {
    const app = express();
    app.use((req, _res, next) => {
        req.session = {};
        next();
    });
    app.use('/api/users', publicRouter);
    return app;
}

async function register(handle) {
    return request(makeApp()).post('/api/users/register').send({ handle, name: handle, password: 'hunter2' });
}

beforeAll(async () => {
    globalThis.DATA_ROOT = TEST_DATA_ROOT;
    await storage.init({ dir: path.join(TEST_DATA_ROOT, '_storage'), ttl: false, expiredInterval: 0 });
});

beforeEach(async () => {
    await storage.clear();
    checkForNewContentSpy.mockClear().mockImplementation(async () => false);
    await saveAdminSettings({ accountRegistration: { enabled: true } });
    // Reset the pool between tests: entries persist on disk, not in storage.
    fs.rmSync(path.join(TEST_DATA_ROOT, SEED_ROOT_DIRNAME), { recursive: true, force: true });
    fs.rmSync(path.join(TEST_DATA_ROOT, 'tester'), { recursive: true, force: true });
    fs.rmSync(path.join(TEST_DATA_ROOT, 'tester2'), { recursive: true, force: true });
});

afterAll(async () => {
    await storage.clear();
    fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    globalThis.DATA_ROOT = PREV_DATA_ROOT;
});

describe('getSeedRoot', () => {
    test('points at <dataRoot>/_seed', () => {
        expect(getSeedRoot()).toBe(path.join(TEST_DATA_ROOT, '_seed'));
    });
});

describe('seedUserDirectories', () => {
    test('missing pool resolves to an empty report', async () => {
        const report = await seedUserDirectories(getUserDirectories('tester'));
        expect(report).toEqual({ copied: [], skipped: [], quotaSkipped: [], errors: [] });
    });

    test('copies a card tree completely, including nested dirs and Chinese names', async () => {
        makeSeedCard(getSeedRoot());
        const report = await seedUserDirectories(getUserDirectories('tester'));

        const dest = path.join(TEST_DATA_ROOT, 'tester', 'card-apps', CARD_NAME);
        expect(report.copied).toEqual([dest]);
        expect(report.errors).toEqual([]);
        expect(listFilesRecursive(dest).sort()).toEqual([
            'assets/立绘/掌门.webp',
            'data-数据.json',
            'index.js',
            'style.css',
        ]);
        expect(fs.readFileSync(path.join(dest, 'index.js'), 'utf8')).toBe('console.log("card");\n');
        // .git never leaves the pool.
        expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
    });

    test('second run skips existing entries — idempotent, no nesting', async () => {
        makeSeedCard(getSeedRoot());
        await seedUserDirectories(getUserDirectories('tester'));
        const before = listFilesRecursive(path.join(TEST_DATA_ROOT, 'tester', 'card-apps', CARD_NAME)).sort();

        const second = await seedUserDirectories(getUserDirectories('tester'));
        expect(second.copied).toEqual([]);
        expect(second.skipped).toEqual([path.join(TEST_DATA_ROOT, 'tester', 'card-apps', CARD_NAME)]);

        const dest = path.join(TEST_DATA_ROOT, 'tester', 'card-apps', CARD_NAME);
        expect(listFilesRecursive(dest).sort()).toEqual(before);
        // No 卡/卡 nesting from a repeat run.
        expect(fs.existsSync(path.join(dest, CARD_NAME))).toBe(false);
    });

    test('never overwrites user content under an existing destination', async () => {
        makeSeedCard(getSeedRoot());
        const dest = path.join(TEST_DATA_ROOT, 'tester', 'card-apps', CARD_NAME);
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'index.js'), 'user-edited\n');

        const report = await seedUserDirectories(getUserDirectories('tester'));
        expect(report.copied).toEqual([]);
        expect(fs.readFileSync(path.join(dest, 'index.js'), 'utf8')).toBe('user-edited\n');
    });

    test('a failing entry is reported but does not throw or block siblings', async () => {
        const cardDir = makeSeedCard(getSeedRoot());
        const pool = getSeedRoot();
        const otherCardDir = path.join(pool, 'card-apps', '另一张卡');
        fs.mkdirSync(otherCardDir, { recursive: true });
        fs.writeFileSync(path.join(otherCardDir, 'index.js'), '// ok\n');

        // Deterministic copy failure — Node's cp resolves dangling links on
        // some versions and copies them verbatim on others, so stub the call.
        // Fails whichever entry readdir yields first; assert order-agnostically.
        const cpSpy = jest.spyOn(fs.promises, 'cp')
            .mockRejectedValueOnce(Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' }));
        try {
            const report = await seedUserDirectories(getUserDirectories('tester'));
            expect(report.errors).toHaveLength(1);
            expect([cardDir, otherCardDir]).toContain(report.errors[0].source);
            // The failed entry doesn't block the healthy card.
            const survivor = report.errors[0].source === cardDir ? otherCardDir : cardDir;
            expect(report.copied).toEqual([path.join(TEST_DATA_ROOT, 'tester', 'card-apps', path.basename(survivor))]);
        } finally {
            cpSpy.mockRestore();
        }
    });

    test('a non-directory pool subdir is reported, not thrown', async () => {
        fs.mkdirSync(getSeedRoot(), { recursive: true });
        fs.writeFileSync(path.join(getSeedRoot(), 'card-apps'), 'not a dir');
        const report = await seedUserDirectories(getUserDirectories('tester'));
        expect(report.copied).toEqual([]);
        expect(report.errors).toHaveLength(1);
    });
});

describe('POST /register seeding', () => {
    test('new account receives the seed card under card-apps', async () => {
        makeSeedCard(getSeedRoot());
        const res = await register('tester');
        expect(res.status).toBe(200);

        const dest = path.join(TEST_DATA_ROOT, 'tester', 'card-apps', CARD_NAME);
        expect(listFilesRecursive(dest).sort()).toEqual([
            'assets/立绘/掌门.webp',
            'data-数据.json',
            'index.js',
            'style.css',
        ]);
    });

    test('two accounts get independent copies', async () => {
        makeSeedCard(getSeedRoot());
        expect((await register('tester')).status).toBe(200);
        expect((await register('tester2')).status).toBe(200);

        const file1 = path.join(TEST_DATA_ROOT, 'tester', 'card-apps', CARD_NAME, 'index.js');
        const file2 = path.join(TEST_DATA_ROOT, 'tester2', 'card-apps', CARD_NAME, 'index.js');
        expect(fs.existsSync(file1)).toBe(true);
        expect(fs.existsSync(file2)).toBe(true);
        // Mutating one account's copy leaves the other untouched.
        fs.writeFileSync(file2, 'changed\n');
        expect(fs.readFileSync(file1, 'utf8')).toBe('console.log("card");\n');
    });

    test('missing pool: registration still succeeds with no card', async () => {
        const res = await register('tester');
        expect(res.status).toBe(200);
        expect(fs.existsSync(path.join(TEST_DATA_ROOT, 'tester', 'card-apps'))).toBe(true);
    });

    test('unreadable pool: registration still succeeds (failure is logged, not fatal)', async () => {
        // _seed/card-apps as a regular file makes the pool read fail —
        // registration must still complete.
        fs.mkdirSync(getSeedRoot(), { recursive: true });
        fs.writeFileSync(path.join(getSeedRoot(), 'card-apps'), 'not a dir');

        const res = await register('tester');
        expect(res.status).toBe(200);
        expect(res.body.handle).toBe('tester');
    });

    test('seed copy failure does not consume the invite rollback path', async () => {
        // Failure inside the seed copy must not delete the freshly created
        // account record — the user stays registered.
        fs.mkdirSync(getSeedRoot(), { recursive: true });
        fs.writeFileSync(path.join(getSeedRoot(), 'card-apps'), 'not a dir');

        const res = await register('tester');
        expect(res.status).toBe(200);

        const { toKey } = await import('../src/users.js');
        const user = await storage.getItem(toKey('tester'));
        expect(user?.handle).toBe('tester');
        expect(user?.enabled).toBe(true);
    });
});
