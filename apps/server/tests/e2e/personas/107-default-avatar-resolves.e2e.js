// #107a — Login-page default avatar resolves to a real file.
//
// Background: getUserAvatar() falls back to the bundled default for every
// user without a custom avatar (no avatar:<handle> datum, no persona /
// user_avatar in settings). It used to hand back a bare URL — first the
// misspelled '/img/default-user.png', then '/img/user-default.png', which
// only resolved while the legacy public/ tree was mounted; on the default
// SPA/kernel surface /img is not mounted and the URL answered with
// index.html or a 404. The fallback now ships the PNG inline as a data URL,
// which resolves in every serving mode.
//
// The seed data's default-user carries a persona avatar, so this file
// seeds a bare user (no settings.json, no avatar datum — exactly the
// state a fresh OAuth or admin-created user is in) and proves:
//   1. /api/users/list returns a usable avatar for that user.
//   2. The value is a self-contained image payload (data URL of the
//      shipped public/img/user-default.png).

import { test, expect, request as pwRequest } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.e2e-scratch');

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'default-avatar-url',
        extraConfig: { enableUserAccounts: true },
        useExistingDataRoot: await seedDataRoot(),
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

/**
 * Build a scratch dataRoot with one bare user: a user record (node-persist
 * datum, same storage layer the endpoints read) plus a settings.json that
 * has neither a default persona nor a user_avatar, and no avatar datum —
 * the avatarless state the fallback exists for. (A user with NO
 * settings.json gets one auto-seeded on boot, which sets user_avatar —
 * so the fallback state must be seeded explicitly.)
 */
async function seedDataRoot() {
    const dataRoot = resolve(SCRATCH_ROOT, 'personas-default-avatar-url');
    mkdirSync(resolve(dataRoot, '_storage'), { recursive: true });
    mkdirSync(resolve(dataRoot, 'bare-user'), { recursive: true });

    writeFileSync(
        resolve(dataRoot, '_storage', storageFile('user:bare-user')),
        JSON.stringify({
            key: 'user:bare-user',
            value: {
                handle: 'bare-user',
                name: 'Bare User',
                created: Date.now(),
                password: '',
                salt: '',
                admin: false,
                enabled: true,
            },
        }),
    );

    // Pre-existing settings with no persona / avatar fields: boot-time
    // content seeding leaves it alone, and getUserAvatar falls through
    // to the bundled default-avatar data URL.
    writeFileSync(resolve(dataRoot, 'bare-user/settings.json'), JSON.stringify({ username: 'Bare User' }));

    return dataRoot;
}

/** node-persist stores datums at sha256(key) under _storage. */
function storageFile(key) {
    return createHash('sha256').update(key).digest('hex');
}

async function newSession() {
    const ctx = await pwRequest.newContext({ baseURL: server.baseURL });
    const csrfRes = await ctx.get('/csrf-token');
    expect(csrfRes.ok(), 'csrf-token request failed').toBe(true);
    const { token } = await csrfRes.json();
    return {
        ctx,
        async post(url, body) {
            return ctx.post(url, {
                data: body ?? {},
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            });
        },
        async dispose() { await ctx.dispose(); },
    };
}

test('avatarless user in /api/users/list serves a default avatar URL that resolves', async () => {
    const s = await newSession();
    try {
        const res = await s.post('/api/users/list');
        expect(res.ok(), `users list failed (${res.status()})`).toBe(true);
        const users = await res.json();
        const bareUser = users.find(u => u.handle === 'bare-user');
        expect(bareUser, 'bare-user missing from users list').toBeTruthy();

        // The fallback is the regression target: an inline data URL of the
        // bundled PNG — resolvable in every serving mode, no mount needed.
        expect(
            bareUser.avatar.startsWith('data:image/png;base64,'),
            'expected the avatarless-user fallback to be a PNG data URL',
        ).toBe(true);

        // And the payload must be real image bytes, not an empty stub.
        const payload = Buffer.from(bareUser.avatar.slice('data:image/png;base64,'.length), 'base64');
        expect(payload.length, 'default avatar payload must not be empty').toBeGreaterThan(1000);
        expect(payload.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'payload must be a PNG').toBe(true);
    } finally {
        await s.dispose();
    }
});

test('the misspelled default-user.png does not exist in the repo', async () => {
    // Belt-and-suspenders: the shipped file must be user-default.png.
    expect(existsSync(resolve(REPO_ROOT, 'public/img/user-default.png')), 'public/img/user-default.png must exist').toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'public/img/default-user.png')), 'public/img/default-user.png must not exist').toBe(false);
});
