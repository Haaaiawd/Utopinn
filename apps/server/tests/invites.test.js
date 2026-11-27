import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import storage from 'node-persist';

// Lift the register rate-limit ceiling before users-public.js binds it at
// module load — the suite drives more /register attempts than the default
// 3-per-300s budget allows.
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
const { router: adminRouter } = await import('../src/endpoints/users-admin.js');
const invites = await import('../src/invites.js');
const { saveAdminSettings, getAdminSettings } = await import('../src/admin-settings.js');
const { toKey } = await import('../src/users.js');

const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-invites-test-'));

function makeApp({ admin = true, handle = 'admin-user' } = {}) {
    const app = express();
    // Anonymous pre-auth surface: session exists (cookie-session parity) but
    // request.user is only injected for the admin router, mirroring
    // server-main.js's public-then-authenticated mount order.
    app.use((req, _res, next) => {
        req.session = {};
        next();
    });
    app.use('/api/users', publicRouter);
    // Production parses bodies globally between the login gate and the
    // admin routes; the public router carries its own per-route parser.
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle, admin, enabled: true, created: 0 } };
        next();
    });
    app.use('/api/users', adminRouter);
    return app;
}

async function enableRegistration(requireInviteCode) {
    await saveAdminSettings({ accountRegistration: { enabled: true, requireInviteCode } });
}

async function getInvite(code) {
    return (await invites.listInvites()).find(x => x.code === code) || null;
}

beforeAll(async () => {
    globalThis.DATA_ROOT = TEST_DATA_ROOT;
    await storage.init({ dir: path.join(TEST_DATA_ROOT, '_storage'), ttl: false, expiredInterval: 0 });
});

beforeEach(async () => {
    await storage.clear();
    checkForNewContentSpy.mockClear().mockImplementation(async () => false);
});

afterAll(async () => {
    await storage.clear();
    fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

describe('accountRegistration.requireInviteCode normalization', () => {
    test('defaults to false when the field is absent (back-compat)', async () => {
        const settings = await saveAdminSettings({ accountRegistration: { enabled: true } });
        expect(settings.accountRegistration.enabled).toBe(true);
        expect(settings.accountRegistration.requireInviteCode).toBe(false);
    });

    test('round-trips true when explicitly set', async () => {
        const settings = await saveAdminSettings({ accountRegistration: { enabled: true, requireInviteCode: true } });
        expect(settings.accountRegistration.requireInviteCode).toBe(true);
        expect((await getAdminSettings()).accountRegistration.requireInviteCode).toBe(true);
    });
});

// Regression for the silent-gate-drop hole: the legacy admin form
// (public/scripts/user.js collectAuthSettingsForm) posts this exact shape —
// every field EXCEPT requireInviteCode, which it predates. With replace
// semantics each legacy save reset the flag to false; patch semantics must
// keep the stored value instead.
const LEGACY_SETTINGS_PAYLOAD = (enabled) => ({
    storage: { defaultUserQuotaBytes: -1 },
    accountRegistration: { enabled },
    oauth: {
        github: { enabled: false, clientId: '', clientSecret: '', allowAutoCreate: false },
        discord: {
            enabled: false, clientId: '', clientSecret: '', allowAutoCreate: false,
            requireGuildMembership: false, allowedGuildIds: [], requiredRoleIds: [],
            scopes: ['identify', 'email'],
        },
    },
});

describe('saveAdminSettings patch semantics (legacy-save regression)', () => {
    test('a save omitting requireInviteCode preserves the stored flag', async () => {
        await saveAdminSettings({ accountRegistration: { enabled: true, requireInviteCode: true } });
        const saved = await saveAdminSettings(LEGACY_SETTINGS_PAYLOAD(true));
        expect(saved.accountRegistration).toEqual({ enabled: true, requireInviteCode: true });
        expect((await getAdminSettings()).accountRegistration.requireInviteCode).toBe(true);
    });

    test('omitting the whole accountRegistration section preserves both flags', async () => {
        await saveAdminSettings({ accountRegistration: { enabled: true, requireInviteCode: true } });
        const saved = await saveAdminSettings({ storage: { defaultUserQuotaBytes: 1024 } });
        expect(saved.accountRegistration).toEqual({ enabled: true, requireInviteCode: true });
        expect(saved.storage.defaultUserQuotaBytes).toBe(1024);
    });

    test('an explicit false still clears the flag', async () => {
        await saveAdminSettings({ accountRegistration: { enabled: true, requireInviteCode: true } });
        const saved = await saveAdminSettings({ accountRegistration: { enabled: true, requireInviteCode: false } });
        expect(saved.accountRegistration.requireInviteCode).toBe(false);
    });

    test('POST /settings/save with the legacy body keeps the invite gate', async () => {
        const app = makeApp();
        await saveAdminSettings({ accountRegistration: { enabled: true, requireInviteCode: true } });
        const res = await request(app).post('/api/users/settings/save').send(LEGACY_SETTINGS_PAYLOAD(true));
        expect(res.status).toBe(200);
        expect(res.body.accountRegistration.requireInviteCode).toBe(true);

        // And the gate is still real: registration without a code is refused.
        const reg = await request(app)
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw' });
        expect(reg.status).toBe(400);
        expect(reg.body.code).toBe('invite_code_required');
    });
});

describe('POST /api/users/registration/info', () => {
    test('reports requireInviteCode only when both flags are on', async () => {
        const app = makeApp();

        await enableRegistration(false);
        let res = await request(app).post('/api/users/registration/info').send({});
        expect(res.body).toEqual({ enabled: true, requireInviteCode: false });

        await enableRegistration(true);
        res = await request(app).post('/api/users/registration/info').send({});
        expect(res.body).toEqual({ enabled: true, requireInviteCode: true });

        await saveAdminSettings({ accountRegistration: { enabled: false, requireInviteCode: true } });
        res = await request(app).post('/api/users/registration/info').send({});
        expect(res.body).toEqual({ enabled: false, requireInviteCode: false });
    });
});

describe('POST /api/users/register — invite gate', () => {
    test('enabled without requireInviteCode keeps open registration', async () => {
        await enableRegistration(false);
        const res = await request(makeApp())
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw' });
        expect(res.status).toBe(200);
        expect(res.body.handle).toBe('alice');
    });

    test('registration stays fully closed when enabled=false', async () => {
        await saveAdminSettings({ accountRegistration: { enabled: false, requireInviteCode: true } });
        const invite = await invites.createInvite({ createdBy: 'admin-user' });
        const res = await request(makeApp())
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('registration_disabled');
        expect((await getInvite(invite.code)).usedCount).toBe(0);
    });

    test('missing invite code -> 400 invite_code_required', async () => {
        await enableRegistration(true);
        const res = await request(makeApp())
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invite_code_required');
    });

    test('unknown code -> 403 invalid_invite_code', async () => {
        await enableRegistration(true);
        const res = await request(makeApp())
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: 'nope1234' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('invalid_invite_code');
        expect(res.body.error).not.toMatch(/remaining|uses/i);
    });

    test('valid code -> 200, consumes one use, seeds content, signs in', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ maxUses: 2, createdBy: 'admin-user' });
        const app = makeApp();
        const res = await request(app)
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(res.status).toBe(200);
        expect(res.body.handle).toBe('alice');

        const stored = await getInvite(invite.code);
        expect(stored.usedCount).toBe(1);
        expect(stored.usedBy).toEqual(['alice']);
        // Seed-card pipeline must still fire for the new account (#46).
        expect(checkForNewContentSpy).toHaveBeenCalledWith([expect.objectContaining({ root: expect.any(String) })], ['settings']);
        expect(await storage.getItem(toKey('alice'))).toMatchObject({ handle: 'alice', admin: false, enabled: true });
    });

    test('revoked code -> 403 invite_code_revoked', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ createdBy: 'admin-user' });
        await invites.revokeInvite({ code: invite.code });
        const res = await request(makeApp())
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('invite_code_revoked');
        expect((await getInvite(invite.code)).usedCount).toBe(0);
    });

    test('expired code -> 403 invite_code_expired', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ expiresAt: Date.now() - 1000, createdBy: 'admin-user' });
        const res = await request(makeApp())
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('invite_code_expired');
    });

    test('exhausted code -> 403 invite_code_exhausted', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ maxUses: 1, createdBy: 'admin-user' });
        const app = makeApp();

        const first = await request(app)
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(first.status).toBe(200);

        const res = await request(app)
            .post('/api/users/register')
            .send({ handle: 'bob', name: 'Bob', password: 'pw', inviteCode: invite.code });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('invite_code_exhausted');
        expect((await getInvite(invite.code)).usedCount).toBe(1);
    });

    test('unlimited code (maxUses 0) never exhausts', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ maxUses: 0, createdBy: 'admin-user' });
        const app = makeApp();
        for (const handle of ['alice', 'bob', 'carol']) {
            const res = await request(app)
                .post('/api/users/register')
                .send({ handle, name: handle, password: 'pw', inviteCode: invite.code });
            expect(res.status).toBe(200);
        }
        expect((await getInvite(invite.code)).usedCount).toBe(3);
    });

    test('taken handle fails before the invite is touched (no use consumed)', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ createdBy: 'admin-user' });
        await storage.setItem(toKey('alice'), { handle: 'alice', name: 'Alice', created: 0, password: '', salt: '', admin: false, enabled: true });

        const res = await request(makeApp())
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('user_exists');
        expect((await getInvite(invite.code)).usedCount).toBe(0);
    });

    test('account-creation failure refunds the use AND rolls back the account', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ maxUses: 1, createdBy: 'admin-user' });
        checkForNewContentSpy.mockImplementation(async () => { throw new Error('seed boom'); });
        const app = makeApp();

        const res = await request(app)
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(res.status).toBe(500);

        const stored = await getInvite(invite.code);
        expect(stored.usedCount).toBe(0);
        expect(stored.usedBy).toEqual([]);

        // The half-provisioned account must not survive the failure: an
        // enabled record would sign in on an invite use that was already
        // refunded — a free registration. Rollback also frees the handle,
        // which the retry below proves.
        expect(await storage.getItem(toKey('alice'))).toBeUndefined();
        const login = await request(app).post('/api/users/login').send({ handle: 'alice', password: 'pw' });
        expect(login.status).toBe(403);
        expect(login.body.code).toBe('incorrect_credentials');

        checkForNewContentSpy.mockImplementation(async () => false);
        const retry = await request(app)
            .post('/api/users/register')
            .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code });
        expect(retry.status).toBe(200);
    });

    test('two racers on the last use -> exactly one wins', async () => {
        await enableRegistration(true);
        const invite = await invites.createInvite({ maxUses: 1, createdBy: 'admin-user' });
        const app = makeApp();

        const [a, b] = await Promise.all([
            request(app).post('/api/users/register')
                .send({ handle: 'alice', name: 'Alice', password: 'pw', inviteCode: invite.code }),
            request(app).post('/api/users/register')
                .send({ handle: 'bob', name: 'Bob', password: 'pw', inviteCode: invite.code }),
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 403]);
        const loser = a.status === 200 ? b : a;
        expect(loser.body.code).toBe('invite_code_exhausted');
        expect((await getInvite(invite.code)).usedCount).toBe(1);
    });
});

describe('admin invite endpoints', () => {
    test('non-admin gets 403 on list/create/revoke', async () => {
        const app = makeApp({ admin: false });
        for (const verb of ['list', 'create', 'revoke']) {
            const res = await request(app).post(`/api/users/invites/${verb}`).send({});
            expect(res.status).toBe(403);
        }
    });

    test('create generates a 16-char code and list reflects it', async () => {
        const app = makeApp();
        const res = await request(app)
            .post('/api/users/invites/create')
            .send({ maxUses: 5, note: 'for class group' });
        expect(res.status).toBe(200);
        const item = res.body.item;
        expect(item.code).toMatch(/^[A-Za-z0-9_-]{16}$/);
        expect(item).toMatchObject({
            maxUses: 5,
            usedCount: 0,
            usedBy: [],
            note: 'for class group',
            revoked: false,
            createdBy: 'admin-user',
            expiresAt: null,
        });

        const list = await request(app).post('/api/users/invites/list').send({});
        expect(list.status).toBe(200);
        expect(list.body.items.map(x => x.code)).toContain(item.code);
    });

    test('create accepts an admin-chosen code, rejects a duplicate with 409', async () => {
        const app = makeApp();
        const first = await request(app)
            .post('/api/users/invites/create')
            .send({ code: 'class-three' });
        expect(first.status).toBe(200);
        expect(first.body.item.code).toBe('class-three');

        const dup = await request(app)
            .post('/api/users/invites/create')
            .send({ code: 'class-three' });
        expect(dup.status).toBe(409);
        expect(dup.body.code).toBe('invite_code_exists');

        const bad = await request(app)
            .post('/api/users/invites/create')
            .send({ code: 'bad code!' });
        expect(bad.status).toBe(400);
    });

    test('revoke is a soft delete: unknown -> 404, revoked code stops working', async () => {
        const app = makeApp();
        const missing = await request(app).post('/api/users/invites/revoke').send({ code: 'ghost-code' });
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('invite_not_found');

        const { body: { item } } = await request(app)
            .post('/api/users/invites/create')
            .send({});
        const revoked = await request(app).post('/api/users/invites/revoke').send({ code: item.code });
        expect(revoked.status).toBe(204);

        const stored = await getInvite(item.code);
        expect(stored.revoked).toBe(true);
        expect(stored.revokedAt).toBeGreaterThan(0);
    });

    test('invites never leak into the account handle list', async () => {
        const app = makeApp();
        await request(app).post('/api/users/invites/create').send({ code: 'not-a-user' });
        const res = await request(app).post('/api/users/get').send({});
        expect(res.status).toBe(200);
        expect(res.body.map(x => x.handle)).not.toContain('not-a-user');
    });
});
