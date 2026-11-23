// Multi-account isolation — end-to-end proof that two handles on one
// Utopinn server cannot see or mutate each other's data.
// Design: .skeinn/design/multi-user.md (G1/G3). Requires the server to be
// started with `enableUserAccounts: true` (extraConfig below); the harness
// writes a per-scenario config.yaml so the tracked default is untouched.
//
//   node --test tests/multi-account-isolation.test.mjs
//
// The suite shares ONE spawned server (startServer batches by batchKey) and
// drives it through raw fetch() — no browser. Scratch state lives under
// /tmp (WSL 9P on /mnt/* stalls under concurrent I/O).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './e2e/_lib/server.js';
import { writeCharacter } from './e2e/_lib/fixtures.js';

const BATCH = 'server'; // port batch key (see tests/e2e/_lib/ports.js)
const SCENARIO = 'accounts-on';

// ---------- tiny cookie-jar session ----------

class Session {
    constructor(base) {
        this.base = base;
        this.cookies = new Map();
        this.csrf = '';
    }
    async init() {
        const res = await this.req('GET', '/csrf-token');
        assert.equal(res.status, 200, 'csrf-token should be public');
        this.csrf = (await res.json()).token;
        assert.ok(this.csrf, 'csrf token expected');
        return this;
    }
    absorbCookies(res) {
        const list = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
        for (const sc of list) {
            const pair = String(sc).split(';')[0];
            const i = pair.indexOf('=');
            if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    }
    async req(method, path, body) {
        const headers = {};
        if (this.cookies.size) {
            headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        }
        if (this.csrf) headers['x-csrf-token'] = this.csrf;
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetch(this.base + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
        });
        this.absorbCookies(res);
        return res;
    }
    get(p) { return this.req('GET', p); }
    post(p, b = {}) { return this.req('POST', p, b); }
    delete(p, b) { return this.req('DELETE', p, b); }
    async json(res) {
        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
    }
    async login(handle, password) {
        const res = await this.post('/api/users/login', { handle, password });
        return res;
    }
}

const AVATAR_A = 'ash-the-cartographer.png'; // user A's character
const AVATAR_B = 'bryn-the-lamplighter.png';
const CHAR_ID_A = AVATAR_A.replace('.png', '');
const CHAT_FILE = 'reef-watch.jsonl';

const chatPayload = (text) => [
    { user_name: 'Keeper', character_name: 'Ash', create_date: '2026-11-23', chat_metadata: {} },
    { name: 'Keeper', is_user: true, send_date: 'Nov 23, 2026 8:00pm', mes: text, extra: {} },
    { name: 'Ash', is_user: false, send_date: 'Nov 23, 2026 8:01pm', mes: '*She marks the reef line.*', extra: {} },
];

// ---------- shared server for the HTTP suite ----------

let srv = null;
let dataRoot = '';
let admin = null;
let userA = null;
let userB = null;

test('server boots with enableUserAccounts', async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'uto-ma-'));
    srv = await startServer({
        batchKey: BATCH,
        scenarioId: SCENARIO,
        useExistingDataRoot: dataRoot,
        extraConfig: { enableUserAccounts: true, listen: false },
    });
    assert.ok(srv?.baseURL, 'server url');
});

test('anonymous session has no user; default-user login works', async () => {
    admin = await new Session(srv.baseURL).init();
    const anonMe = await admin.get('/api/users/me');
    assert.equal(anonMe.status, 403, 'no session handle → 403');

    // default-user is bootstrapped passwordless on first boot.
    const login = await admin.login('default-user', '');
    assert.equal(login.status, 200, 'default-user login');
    const me = await admin.get('/api/users/me');
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.handle, 'default-user');
    assert.equal(body.admin, true, 'bootstrapped default-user is admin');
});

test('self-registration is disabled by default', async () => {
    const anon = await new Session(srv.baseURL).init();
    const res = await anon.post('/api/users/register', { handle: 'mallory', name: 'Mallory', password: 'hunter22' });
    assert.equal(res.status, 403, 'accountRegistration.enabled defaults to false');
});

test('admin creates two accounts; each logs in on its own session', async () => {
    for (const [handle, name] of [['peer-a', 'Peer A'], ['peer-b', 'Peer B']]) {
        const res = await admin.post('/api/users/create', { handle, name, password: `pw-${handle}` });
        assert.ok(res.status === 200 || res.status === 204, `create ${handle}: ${res.status}`);
    }
    userA = await new Session(srv.baseURL).init();
    userB = await new Session(srv.baseURL).init();
    const la = await userA.login('peer-a', 'pw-peer-a');
    const lb = await userB.login('peer-b', 'pw-peer-b');
    assert.equal(la.status, 200, 'peer-a login');
    assert.equal(lb.status, 200, 'peer-b login');
    assert.equal((await (await userA.get('/api/users/me')).json()).handle, 'peer-a');
    assert.equal((await (await userB.get('/api/users/me')).json()).handle, 'peer-b');

    // Each user gets their own characters; seed them out-of-band so HTTP
    // assertions below exercise reads, not just writes.
    writeCharacter({ dataRoot, handle: 'peer-a', avatarFile: AVATAR_A });
    writeCharacter({
        dataRoot, handle: 'peer-b', avatarFile: AVATAR_B,
        overrides: { name: 'Bryn the Lamplighter' },
    });
});

test('characters: user A cannot see user B cards', async () => {
    const ra = await userA.post('/api/characters/all', {});
    const rb = await userB.post('/api/characters/all', {});
    assert.equal(ra.status, 200); assert.equal(rb.status, 200);
    const la = await ra.text(); const lb = await rb.text();
    assert.ok(la.includes(CHAR_ID_A), 'A sees own card');
    assert.ok(!la.includes('bryn-the-lamplighter'), 'A does not see B card');
    assert.ok(!lb.includes(CHAR_ID_A), 'B does not see A card');
    assert.ok(lb.includes('bryn-the-lamplighter'), 'B sees own card');
});

test('chats: A saves a chat; B cannot read or list it', async () => {
    const save = await userA.post('/api/chats/save', {
        ch_name: 'Ash the Cartographer',
        file_name: CHAT_FILE,
        avatar_url: AVATAR_A,
        chat: chatPayload('A secret only A may read'),
    });
    assert.equal(save.status, 200, `save chat: ${save.status}`);

    // B asks for A's chat by the same keys — B's dirs have no such chat.
    const getB = await userB.post('/api/chats/get', { avatar_url: AVATAR_A, file_name: CHAT_FILE });
    assert.equal(getB.status, 200);
    const bodyB = await getB.json();
    assert.equal(bodyB.new_chat, true, 'B must get new_chat, not A\'s transcript');

    // A reads it back fine.
    const getA = await userA.post('/api/chats/get', { avatar_url: AVATAR_A, file_name: CHAT_FILE });
    const bodyA = await getA.json();
    assert.ok(Array.isArray(bodyA), 'A reads own chat');
    assert.equal(bodyA.length, 3);
});

test('settings: per-handle settings.json do not cross', async () => {
    const save = await userA.post('/api/settings/save', {
        username: 'a-marker-username',
        user_avatar: 'a-marker.png',
    });
    assert.ok(save.status === 200 || save.status === 204, `save settings: ${save.status}`);

    const getA = await userA.post('/api/settings/get');
    assert.equal(getA.status, 200);
    assert.ok((await getA.text()).includes('a-marker-username'), 'A reads own marker back');

    const getB = await userB.post('/api/settings/get');
    assert.equal(getB.status, 200);
    assert.ok(!(await getB.text()).includes('a-marker-username'), 'B settings must not contain A marker');

    // And on disk: the file lives under peer-a's root only.
    const diskA = join(dataRoot, 'peer-a', 'settings.json');
    assert.ok(existsSync(diskA), 'A settings on disk');
    assert.ok(readFileSync(diskA, 'utf8').includes('a-marker-username'));
    const diskB = join(dataRoot, 'peer-b', 'settings.json');
    if (existsSync(diskB)) {
        assert.ok(!readFileSync(diskB, 'utf8').includes('a-marker-username'));
    }
});

test('secrets: user secrets are per-handle; shared store is ACL-gated', async () => {
    const w = await userA.post('/api/secrets/write', { key: 'api_key_openai', value: 'sk-a-secret', label: 'a-key' });
    assert.equal(w.status, 200, `write secret: ${w.status}`);
    const rA = await userA.post('/api/secrets/read');
    const stA = await rA.json();
    assert.ok(stA.api_key_openai, 'A sees own secret state');

    const rB = await userB.post('/api/secrets/read');
    const stB = await rB.json();
    assert.ok(!stB.api_key_openai, 'B must not see A secret');

    // Shared secrets live at <dataRoot>/_shared/secrets.json — verify A's
    // write did NOT land there (default: no implicit sharing).
    const sharedPath = join(dataRoot, '_shared', 'secrets.json');
    if (existsSync(sharedPath)) {
        const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
        const flat = JSON.stringify(shared);
        assert.ok(!flat.includes('sk-a-secret'), 'A user secret must not leak into shared store');
    }
    // Shared-admin endpoints require admin: a normal user is rejected.
    const denied = await userA.post('/api/users/shared-secrets/list', {});
    assert.ok([403, 404].includes(denied.status), `shared-secrets admin route denied for non-admin: ${denied.status}`);
});

test('izumi chat_state: namespace is per-handle', async () => {
    const okA = await userA.post('/api/utopinn/izumi/state', { avatar_url: AVATAR_A, file_name: CHAT_FILE });
    assert.equal(okA.status, 200, `izumi state for own chat: ${okA.status}`);

    // B targets A's chat key — B's own namespace has no such chat_state.
    const bRes = await userB.post('/api/utopinn/izumi/state', { avatar_url: AVATAR_A, file_name: CHAT_FILE });
    assert.equal(bRes.status, 404, 'B must not resolve A\'s izumi state');
});

test('card-runtime mounts: mint/list/revoke are owner-scoped', async () => {
    // kind:'message' doc mount — exercises the same mounts registry + owner
    // field as card_app mounts without needing a card_app manifest (the
    // fixture PNG's embedded card declares none; PNG metadata wins over the
    // sidecar JSON in mount resolution).
    const mount = await userA.post('/api/card-runtime/mounts', {
        kind: 'message',
        charId: CHAR_ID_A,
        chatName: CHAT_FILE,
        html: '<div data-test="a-doc">peer-a only doc</div>',
    });
    assert.equal(mount.status, 201, `mount: ${mount.status} ${await mount.clone().text().catch(() => '')}`);
    const { mountId } = await mount.json();
    assert.ok(mountId && mountId.length >= 16, 'unguessable mountId');

    // B's mount list must not contain A's mount.
    const listB = await userB.get('/api/card-runtime/mounts');
    const listBBody = await listB.json();
    const ids = (listBBody.mounts ?? []).map((m) => m.mountId ?? m.id);
    assert.ok(!ids.includes(mountId), 'B must not see A mount');

    // B cannot revoke A's mount even with the id in hand.
    const del = await userB.delete(`/api/card-runtime/mounts/${mountId}`);
    assert.ok([403, 404].includes(del.status), `B revoke A mount: ${del.status}`);

    // A can still revoke it.
    const delA = await userA.delete(`/api/card-runtime/mounts/${mountId}`);
    assert.ok([200, 204].includes(delA.status), `A revoke own mount: ${delA.status}`);
});

test('logout invalidates the session; other user unaffected', async () => {
    const out = await userB.post('/api/users/logout');
    assert.ok([200, 204].includes(out.status), `logout: ${out.status}`);
    const meB = await userB.get('/api/users/me');
    assert.equal(meB.status, 403, 'logged-out session loses identity');
    const meA = await userA.get('/api/users/me');
    assert.equal(meA.status, 200, 'A session unaffected');
});

// ---------- generation job_id cross-owner reuse (in-process) ----------

test('generation job: recycled job_id cannot touch another handle\'s job', async () => {
    // getConfig() exits the process when CONFIG_PATH is unset/missing — point
    // it at a scratch yaml before importing the module under test.
    const scratch = mkdtempSync(join(tmpdir(), 'uto-ma-job-'));
    const cfgPath = join(scratch, 'config.yaml');
    writeFileSync(cfgPath, 'enableUserAccounts: true\n');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(cfgPath);

    const { createGenerationJob, getTaskByRequestId } = await import('../src/endpoints/backends/luker-generation.js');
    const req = (handle) => ({ user: { profile: { handle } } });
    const JOB = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    const jobA = createGenerationJob(req('peer-a'), { job_id: JOB });
    assert.ok(jobA, 'A creates job');
    assert.equal(jobA.owner, 'peer-a');

    // B re-POSTs the same job_id (guessable/predictable ids are possible) —
    // must be refused, NOT recycled: recycling would abort A's in-flight
    // upstream request and wipe A's buffered event stream.
    const jobB = createGenerationJob(req('peer-b'), { job_id: JOB });
    assert.equal(jobB, null, 'cross-owner job_id reuse must be refused');
    assert.equal(getTaskByRequestId(JOB, 'peer-a').owner, 'peer-a', 'A job intact');

    // Owner re-POSTs the same id (legit retry) — recycles as before.
    const jobA2 = createGenerationJob(req('peer-a'), { job_id: JOB });
    assert.equal(jobA2, jobA, 'owner retry recycles own job');
});
