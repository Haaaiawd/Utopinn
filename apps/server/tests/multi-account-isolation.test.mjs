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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

test('passwordless accounts cannot authenticate via the password path', async () => {
    const anon = await new Session(srv.baseURL).init();
    const anonMe = await anon.get('/api/users/me');
    assert.equal(anonMe.status, 403, 'no session handle → 403');

    // default-user is seeded with NO password. Previously the
    // `user.password && user.password !== hash` guard skipped the whole
    // comparison for a falsy stored password — ANY submitted password
    // (empty included) authenticated (GH #38). Now a passwordless account
    // must be unreachable through /login until a password is set.
    const missing = await anon.post('/api/users/login', {});
    assert.equal(missing.status, 400, 'missing handle → 400');
    const empty = await anon.login('default-user', '');
    assert.equal(empty.status, 403, 'empty password must not log in');
    const any = await anon.login('default-user', 'literally-anything');
    assert.equal(any.status, 403, 'arbitrary password must not log in');
    const body = await any.json();
    assert.match(String(body.error || ''), /no password/i,
        'passwordless rejection must carry clear semantics (not a misleading credential error)');
});

test('operator bootstrap: seeded default-user is not admin; recoverPassword --admin grants it', async () => {
    // A fresh multi-account install has ZERO admins — the seeded
    // default-user is a plain shell, so the first admin can only be
    // granted out-of-band. This drives the same function the
    // `node recover.js <handle> <password> --admin` boot warning prints.
    const { DEFAULT_USER } = await import('../src/constants.js');
    assert.equal(DEFAULT_USER.admin, false, 'seeded DEFAULT_USER must not ship admin');

    const cfgDir = mkdtempSync(join(tmpdir(), 'uto-ma-cfg-'));
    const cfgPath = join(cfgDir, 'config.yaml');
    writeFileSync(cfgPath, `enableUserAccounts: true\ndataRoot: ${JSON.stringify(dataRoot)}\n`);
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(cfgPath);
    const { recoverPassword } = await import('../src/recover-password.js');
    await recoverPassword(cfgPath, 'default-user', 'boot-pw-A1', { admin: true });

    admin = await new Session(srv.baseURL).init();
    const login = await admin.login('default-user', 'boot-pw-A1');
    assert.equal(login.status, 200, 'post-recover login with the real password');
    const me = await (await admin.get('/api/users/me')).json();
    assert.equal(me.handle, 'default-user');
    assert.equal(me.admin, true, 'recoverPassword --admin granted admin');
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
        const body = await res.json();
        assert.equal(body.passwordSet, true, 'create with password → passwordSet:true');
    }
    // Passwordless create stays allowed (SSO-bound, invite-then-set) but
    // must be flagged and must NOT authenticate via the password path.
    const nopw = await admin.post('/api/users/create', { handle: 'no-pass', name: 'No Password' });
    assert.equal(nopw.status, 200, `create no-pass: ${nopw.status}`);
    const created = await nopw.json();
    assert.equal(created.passwordSet, false, 'create without password → passwordSet:false');

    const ghost = await new Session(srv.baseURL).init();
    for (const attempt of ['', 'whatever']) {
        const res = await ghost.login('no-pass', attempt);
        assert.equal(res.status, 403, `no-pass login must be rejected (tried ${JSON.stringify(attempt)})`);
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

test('Basic Auth: passwordless accounts never resolve, passworded accounts do', async () => {
    // resolveUserFromBasicAuth backs perUserBasicAuth — the second
    // password-credential surface. It already required a truthy stored
    // password before comparing, but pin it: an empty stored password
    // must resolve NO credential (the same falsy-shortcut class of bug
    // GH #38 hit in /login). Storage in this process was initialized by
    // the recoverPassword call above and shares the server's dataRoot.
    const { resolveUserFromBasicAuth } = await import('../src/users.js');
    // Success resolution also builds getUserDirectories(handle), which
    // joins paths off globalThis.DATA_ROOT — point it at the same root
    // the spawned server uses.
    globalThis.DATA_ROOT = dataRoot;
    const req = (handle, password) => ({
        headers: { authorization: `Basic ${Buffer.from(`${handle}:${password}`).toString('base64')}` },
    });
    for (const attempt of ['', 'whatever', 'pw-peer-a']) {
        const resolved = await resolveUserFromBasicAuth(req('no-pass', attempt));
        assert.equal(resolved, null, `passwordless no-pass must not resolve (tried ${JSON.stringify(attempt)})`);
    }
    const ok = await resolveUserFromBasicAuth(req('peer-a', 'pw-peer-a'));
    assert.ok(ok && ok.profile.handle === 'peer-a', 'peer-a real credential resolves');
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

test('login rate limit: a wrong password burns exactly one attempt', async () => {
    // loginLimiter: 5/min per IP, consumed BEFORE credentials are checked
    // (users-public.js:654-664). If the client replays a failed login POST
    // (e.g. the apiFetch CSRF-rotate retry treating credential-403 as a stale
    // token), each wrong try burns two slots and the THIRD wrong attempt
    // would already answer 429 instead of 403 — and the real password would
    // be locked out within the same window.
    const s = await new Session(srv.baseURL).init();
    for (let i = 0; i < 4; i++) {
        const res = await s.post('/api/users/login', { handle: 'peer-a', password: 'wrong' });
        assert.equal(res.status, 403,
            `wrong-password attempt ${i + 1} must be 403, not 429 — replayed logins double-burn the 5/min budget`);
    }
    // 5th slot: the correct password still fits and its success resets the bucket.
    const ok = await s.login('peer-a', 'pw-peer-a');
    assert.equal(ok.status, 200, 'correct password after 4 wrong attempts must not be rate-limited');
});

test('web client: login path cannot double-fire; gate handles passwordless + OAuth inline', async () => {
    // Source-pinned assertions for the SPA fix — the web bundle has no
    // browser test harness here, so pin the code points that caused the
    // review findings. Post-6459cd0 the SPA owns /login entirely: OAuth
    // buttons, recovery-code flow and the passwordless notice all live
    // inside LoginGate (no legacy page to escape to).
    const webRoot = resolve(import.meta.dirname, '../../web/src');
    const accountSrc = readFileSync(join(webRoot, 'api/account.ts'), 'utf8');
    const clientSrc = readFileSync(join(webRoot, 'api/client.ts'), 'utf8');
    const gateSrc = readFileSync(join(webRoot, 'components/shell/LoginGate.tsx'), 'utf8');
    const i18nSrc = readFileSync(join(webRoot, 'features/shell.ts'), 'utf8');

    // 1) loginAccount must opt OUT of apiFetch's 403 replay — that retry is
    //    for stale CSRF tokens; on /api/users/login a 403 IS the answer.
    assert.match(accountSrc, /apiFetch\('\/api\/users\/login'[\s\S]*?retryOn403:\s*false/,
        'loginAccount must pass retryOn403:false so a wrong password issues exactly one POST');
    assert.match(clientSrc, /retryOn403 !== false/,
        'apiFetch must honor the retryOn403 opt-out');

    // 2) Passwordless accounts: the server 403 carries code:'passwordless'
    //    (users-public.js) — the gate must recognise it, pin the handle and
    //    render localized recovery/SSO guidance. The pin is one-shot:
    //    submit() consumes it so a retried POST (e.g. after an admin reset)
    //    is never locked out, and the submit button must not stay disabled.
    assert.match(clientSrc, /public readonly code\?:/, 'ApiError must carry the machine-readable code');
    assert.match(accountSrc, /new ApiError\(text, res\.status, code\)/, 'loginAccount must propagate code');
    assert.match(gateSrc, /e\.code === 'passwordless'/, 'LoginGate must recognise the passwordless code');
    assert.match(gateSrc, /h === passwordlessFor\) setPasswordlessFor\(''\)/,
        'submit() must consume the pin one-shot so a stale marker cannot lock the handle');
    assert.doesNotMatch(gateSrc, /disabled=\{[^}]*isPasswordless/,
        'submit button must not stay disabled on the passwordless pin (admin reset would be unreachable)');
    assert.match(gateSrc, /isPasswordless/, 'gate must render the passwordless state');
    assert.match(gateSrc, /t\('login\.passwordless'\)/, 'passwordless notice must be localized');
    assert.ok(i18nSrc.includes('\'login.passwordless\''), 'i18n login.passwordless key must exist');
    assert.ok(i18nSrc.includes('\'login.passwordless.hint\''), 'i18n login.passwordless.hint key must exist');

    // 3) OAuth-bound accounts have no local password — the gate renders the
    //    discovered provider buttons so SSO stays reachable.
    assert.match(gateSrc, /login-oauth-btn/, 'OAuth provider buttons must render for SSO/passwordless accounts');
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

// ---------- single-user auto-login escape hatch ----------

test('single passwordless user still auto-logs in — but only as non-admin', async () => {
    // Deliberate escape hatch: a single-user install with no password
    // auto-authenticates /login visitors (otherwise the account could
    // never be entered to set a password). The fix pins that this session
    // is NOT admin — exposure stays bounded to that user's own data and
    // the admin surface remains closed.
    const soloRoot = mkdtempSync(join(tmpdir(), 'uto-ma-solo-'));
    const solo = await startServer({
        batchKey: BATCH,
        scenarioId: 'accounts-solo',
        useExistingDataRoot: soloRoot,
        extraConfig: { enableUserAccounts: true, listen: false },
    });
    try {
        const s = await new Session(solo.baseURL).init();
        const res = await s.get('/login');
        assert.equal(res.status, 302, 'single passwordless user → auto-login redirect');
        const me = await s.get('/api/users/me');
        assert.equal(me.status, 200);
        const body = await me.json();
        assert.equal(body.handle, 'default-user');
        assert.equal(body.admin, false, 'auto-logged default-user must NOT be admin');
    } finally {
        await solo.stop();
    }
});

// ---------- exposed-listen auto-provisioning + recover.js CLI ----------
//
// These drive verifySecuritySettings() in-process against throwaway data
// roots (the spawned-server harness always passes --whitelist, which would
// gate the insecure-listen branch off) and run `node recover.js` in real
// subprocesses so argv parsing is exercised end-to-end.

const SERVER_DIR = resolve(import.meta.dirname, '..');
const RECOVER_JS = join(SERVER_DIR, 'recover.js');

/** node-persist file path for a user record inside a data root. */
function storedUserPath(root, handle) {
    return join(root, '_storage', createHash('sha256').update(`user:${handle}`).digest('hex'));
}

function readStoredUser(root, handle) {
    const p = storedUserPath(root, handle);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')).value;
}

function seedStoredUser(root, user) {
    mkdirSync(join(root, '_storage'), { recursive: true });
    writeFileSync(storedUserPath(root, user.handle), JSON.stringify({ key: `user:${user.handle}`, value: user }));
}

/** Seeds an arbitrary node-persist record (e.g. luker:admin-settings:v1). */
function seedStoredItem(root, key, value) {
    mkdirSync(join(root, '_storage'), { recursive: true });
    writeFileSync(join(root, '_storage', createHash('sha256').update(key).digest('hex')), JSON.stringify({ key, value }));
}

function writeScratchConfig(dataRoot, extra = '') {
    const dir = mkdtempSync(join(tmpdir(), 'uto-ma-cfg-'));
    const cfg = join(dir, 'config.yaml');
    writeFileSync(cfg, `enableUserAccounts: true\ndataRoot: ${JSON.stringify(dataRoot)}\n${extra}`);
    return cfg;
}

function runRecover(...args) {
    return spawnSync('node', [RECOVER_JS, ...args], { cwd: SERVER_DIR, encoding: 'utf8', timeout: 120000 });
}

test('insecure listen: passwordless accounts get provisioned passwords — anonymous auto-login dies', async () => {
    // GH#38 review follow-up: accounts-on + listen + no whitelist/basicAuth
    // used to leave singleUserLogin able to hand an anonymous visitor a
    // session. verifySecuritySettings now provisions a random password for
    // EVERY passwordless account and prints the credentials to stderr —
    // the same first-boot semantics the Docker entrypoint documents (#44).
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-exposed-'));
    // users.js resolves config.yaml at import time; under --test-name-pattern
    // the earlier in-process tests may not have run, so point it at a
    // scratch config only when nothing set one yet.
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { initUserStorage, verifySecuritySettings, tryAutoLogin } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const prevRoot = globalThis.DATA_ROOT;
    const captured = [];
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        globalThis.DATA_ROOT = root;
        await initUserStorage(root); // seeds the passwordless default-user
        console.error = (...a) => captured.push(a.join(' '));
        console.warn = (...a) => captured.push(a.join(' '));
        globalThis.COMMAND_LINE_ARGS = { listen: true, basicAuthMode: false, whitelistMode: false };
        await verifySecuritySettings();
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
        globalThis.DATA_ROOT = prevRoot;
    }

    const stored = readStoredUser(root, 'default-user');
    assert.ok(stored.password, 'passwordless account must get a provisioned password on an exposed listen');
    assert.ok(captured.some(l => /user:\s*default-user/.test(l)), 'credential banner names the handle on stderr');
    assert.ok(captured.some(l => /pass:\s*\S+/.test(l)), 'credential banner prints the password on stderr');
    // The zero-admin warning must name the actual parsed data root so the
    // printed recover command targets THIS instance (recover.js --dataRoot).
    assert.ok(captured.some(l => l.includes('recover.js') && l.includes(root)),
        'no-admin warning prints a recover.js command with the resolved data root');

    // The anonymous visitor path is now impossible: the only account HAS a
    // password, so singleUserLogin has nothing passwordless to key on.
    const req = { session: {}, query: {} };
    assert.equal(await tryAutoLogin(req, false), false, 'anonymous visitor must not auto-login after provisioning');
    assert.equal(req.session.handle, undefined, 'no session handle established');
});

test('exposed-listen provisioning is idempotent — a second boot does not re-provision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-exposed2-'));
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { initUserStorage, verifySecuritySettings } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        await initUserStorage(root);
        console.error = () => {};
        console.warn = () => {};
        globalThis.COMMAND_LINE_ARGS = { listen: true, basicAuthMode: false, whitelistMode: false };
        await verifySecuritySettings();
        const first = readStoredUser(root, 'default-user').password;
        assert.ok(first, 'first boot provisions a password');
        await verifySecuritySettings();
        const second = readStoredUser(root, 'default-user').password;
        assert.equal(second, first, 'second boot must not rotate the provisioned password');
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
    }
});

test('protected listen: passwordless sole account is NOT provisioned — local auto-login preserved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-protected-'));
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { initUserStorage, verifySecuritySettings, tryAutoLogin } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        await initUserStorage(root);
        console.error = () => {};
        console.warn = () => {};
        globalThis.COMMAND_LINE_ARGS = { listen: true, basicAuthMode: false, whitelistMode: ['127.0.0.1'] };
        await verifySecuritySettings();
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
    }
    const stored = readStoredUser(root, 'default-user');
    assert.equal(stored.password, '', 'a whitelisted deployment must not auto-provision');
    const req = { session: {}, query: {} };
    assert.equal(await tryAutoLogin(req, false), true, 'protected single-user auto-login stays');
    assert.equal(req.session.handle, 'default-user');
});

test('recover.js: --admin is parsed as a flag — it grants admin and never becomes the password', () => {
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-rc1-'));
    seedStoredUser(root, { handle: 'cli-victim', name: 'V', enabled: true, admin: false, password: '', salt: '' });
    const cfg = writeScratchConfig(root);
    const r = runRecover('--configPath', cfg, 'cli-victim', '--admin');
    assert.equal(r.status, 0, `recover exited ${r.status}: ${r.stderr}`);
    const u = readStoredUser(root, 'cli-victim');
    assert.equal(u.admin, true, '--admin flag granted admin');
    assert.equal(u.password, '', 'the flag token must NOT end up as the stored password');
});

test('recover.js: "-- --admin" sets the literal password --admin without granting admin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-rc2-'));
    seedStoredUser(root, { handle: 'dash-fan', name: 'D', enabled: true, admin: false, password: '', salt: '' });
    const cfg = writeScratchConfig(root);
    const r = runRecover('--configPath', cfg, 'dash-fan', '--', '--admin');
    assert.equal(r.status, 0, `recover exited ${r.status}: ${r.stderr}`);
    const u = readStoredUser(root, 'dash-fan');
    assert.equal(u.admin, false, 'an escaped --admin is data, not the flag');
    assert.ok(u.password, 'a password was actually set');
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { getPasswordHash } = await import('../src/users.js');
    assert.equal(u.password, getPasswordHash('--admin', u.salt), 'stored hash must be the literal password "--admin"');
});

test('recover.js: a leading-dash password without "--" aborts with guidance', () => {
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-rc3-'));
    seedStoredUser(root, { handle: 'dash-victim', name: 'D', enabled: true, admin: false, password: '', salt: '' });
    const cfg = writeScratchConfig(root);
    const r = runRecover('--configPath', cfg, 'dash-victim', '-secret');
    assert.notEqual(r.status, 0, 'leading-dash password must abort, not be reinterpreted');
    assert.match(r.stderr, /--/, 'error output must point at the -- separator');
    const u = readStoredUser(root, 'dash-victim');
    assert.equal(u.password, '', 'rejected run must not have touched the account');
    assert.equal(u.admin, false, 'rejected run must not have granted admin');
});

test('recover.js --dataRoot targets the override root, not the config.yaml one', () => {
    // The live server may run with --dataRoot X while ./config.yaml still
    // says ./data — recovery must hit X. Seed the same handle in both roots
    // and prove only the override one changes.
    const cfgRoot = mkdtempSync(join(tmpdir(), 'uto-ma-rcA-'));
    const realRoot = mkdtempSync(join(tmpdir(), 'uto-ma-rcB-'));
    seedStoredUser(cfgRoot, { handle: 'dual', name: 'D', enabled: true, admin: false, password: '', salt: '' });
    seedStoredUser(realRoot, { handle: 'dual', name: 'D', enabled: true, admin: false, password: '', salt: '' });
    const cfg = writeScratchConfig(cfgRoot); // config.yaml points at cfgRoot
    const r = runRecover('--configPath', cfg, '--dataRoot', realRoot, 'dual', 'new-pass-9');
    assert.equal(r.status, 0, `recover exited ${r.status}: ${r.stderr}`);
    const inOverride = readStoredUser(realRoot, 'dual');
    const inCfg = readStoredUser(cfgRoot, 'dual');
    assert.ok(inOverride.password, 'override root user got the new password');
    assert.equal(inCfg.password, '', 'config.yaml root user untouched — a wrong-instance write would set this');
});

test('recover.js --configPath resolves the dataRoot from the named config file', () => {
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-rc4-'));
    seedStoredUser(root, { handle: 'cfg-victim', name: 'C', enabled: true, admin: false, password: '', salt: '' });
    const cfg = writeScratchConfig(root);
    const r = runRecover('--configPath', cfg, 'cfg-victim', 'pw-from-cfg');
    assert.equal(r.status, 0, `recover exited ${r.status}: ${r.stderr}`);
    const u = readStoredUser(root, 'cfg-victim');
    assert.ok(u.password, 'user inside the named config\'s dataRoot was recovered');
});

test('no-admin warning echoes --configPath only when a custom config was passed', async () => {
    // The printed recover command must be runnable verbatim: a server
    // started with --configPath /elsewhere/cfg.yaml would otherwise print a
    // command whose recover.js loads ./config.yaml and exits.
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(mkdtempSync(join(tmpdir(), 'uto-ma-warn-'))));
    const { initUserStorage, verifySecuritySettings } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const prevRoot = globalThis.DATA_ROOT;
    const captured = [];
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        console.error = (...a) => captured.push(a.join(' '));
        console.warn = (...a) => captured.push(a.join(' '));

        // Custom config → the flag must be echoed.
        const customCfg = join(mkdtempSync(join(tmpdir(), 'uto-ma-wcfg-')), 'config.yaml');
        globalThis.DATA_ROOT = mkdtempSync(join(tmpdir(), 'uto-ma-wroot-'));
        await initUserStorage(globalThis.DATA_ROOT);
        globalThis.COMMAND_LINE_ARGS = { listen: false, configPath: customCfg };
        await verifySecuritySettings();
        const withCustom = captured.filter(l => l.includes('recover.js'));
        assert.ok(withCustom.some(l => l.includes(`--configPath "${customCfg}"`)),
            'custom --configPath must be echoed in the printed recover command');
        captured.length = 0;

        // Default config → the flag is redundant and must be omitted.
        globalThis.COMMAND_LINE_ARGS = { listen: false, configPath: './config.yaml' };
        await verifySecuritySettings();
        const withDefault = captured.filter(l => l.includes('recover.js'));
        assert.ok(withDefault.some(l => l.includes('--dataRoot')),
            'recover command still prints --dataRoot');
        assert.ok(withDefault.every(l => !l.includes('--configPath')),
            'default ./config.yaml must not add a --configPath flag');
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
        globalThis.DATA_ROOT = prevRoot;
    }
});

test('recoverPassword resolves dataRoot from its own configPath, not the process-global config', async () => {
    // initStorage used to read the process-global CONFIG_PATH/CACHED_CONFIG
    // and ignore its configPath argument — a second in-process recovery
    // would silently reuse the FIRST instance's dataRoot (and exit 1 when
    // the handle was not there). The passed path must win.
    const { getConfigFilePath, setConfigFilePath } = await import('../src/util.js');
    let globalCfg = getConfigFilePath();
    if (!globalCfg) {
        // Self-contained when run in isolation: pin a FIRST instance's
        // config ourselves so "global ≠ passed" is exercised regardless
        // of which tests ran before this one.
        globalCfg = writeScratchConfig(mkdtempSync(join(tmpdir(), 'uto-ma-first-')));
        setConfigFilePath(globalCfg);
    }
    const rootB = mkdtempSync(join(tmpdir(), 'uto-ma-second-'));
    seedStoredUser(rootB, { handle: 'second-inst', name: 'B', enabled: true, admin: false, password: '', salt: '' });
    const cfgB = writeScratchConfig(rootB);
    // The global path points at a DIFFERENT dataRoot — if it wins, the
    // recover below targets that root, finds no 'second-inst' and exits.
    assert.notEqual(globalCfg, cfgB);
    const { recoverPassword } = await import('../src/recover-password.js');
    await recoverPassword(cfgB, 'second-inst', 'pw-second-1', {});
    assert.ok(readStoredUser(rootB, 'second-inst').password,
        'the passed --configPath must resolve ITS dataRoot, not the global one');
    assert.equal(getConfigFilePath(), globalCfg,
        'an already-pinned global config path must not be clobbered');
});

test('recover.js honours LUKER_DATA_ROOT env over the config.yaml dataRoot', () => {
    // Server resolution order is --dataRoot > env > config.yaml — the CLI
    // must match, otherwise a server started with LUKER_DATA_ROOT gets its
    // recovery written into the wrong store.
    const cfgRoot = mkdtempSync(join(tmpdir(), 'uto-ma-envcfg-'));
    const envRoot = mkdtempSync(join(tmpdir(), 'uto-ma-envroot-'));
    seedStoredUser(cfgRoot, { handle: 'env-victim', name: 'E', enabled: true, admin: false, password: '', salt: '' });
    seedStoredUser(envRoot, { handle: 'env-victim', name: 'E', enabled: true, admin: false, password: '', salt: '' });
    const cfg = writeScratchConfig(cfgRoot); // config points at cfgRoot
    const r = spawnSync('node', [RECOVER_JS, '--configPath', cfg, 'env-victim', 'env-pass-1'], {
        cwd: SERVER_DIR,
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, LUKER_DATA_ROOT: envRoot },
    });
    assert.equal(r.status, 0, `recover exited ${r.status}: ${r.stderr}`);
    assert.ok(readStoredUser(envRoot, 'env-victim').password, 'env-root user got the password');
    assert.equal(readStoredUser(cfgRoot, 'env-victim').password, '', 'config-root user untouched');
});

test('recover.js resolves a relative --dataRoot against the server dir, not the caller cwd', () => {
    // server.js chdir()s into the server directory before opening storage,
    // so `--dataRoot x` always means <server>/x — running recover.js from a
    // different cwd must produce the same resolution.
    const relRoot = `_test-rel-root-${Date.now()}`;
    const absRoot = join(SERVER_DIR, relRoot);
    try {
        seedStoredUser(absRoot, { handle: 'rel-victim', name: 'R', enabled: true, admin: false, password: '', salt: '' });
        const cfg = writeScratchConfig(mkdtempSync(join(tmpdir(), 'uto-ma-relcfg-')));
        const elsewhere = mkdtempSync(join(tmpdir(), 'uto-ma-elsewhere-'));
        const r = spawnSync('node', [RECOVER_JS, '--configPath', cfg, '--dataRoot', relRoot, 'rel-victim', 'rel-pass-1'], {
            cwd: elsewhere, // deliberately NOT apps/server
            encoding: 'utf8',
            timeout: 120000,
        });
        assert.equal(r.status, 0, `recover exited ${r.status}: ${r.stderr}`);
        assert.ok(readStoredUser(absRoot, 'rel-victim').password,
            'relative --dataRoot must resolve against the server dir like server.js does');
        assert.equal(existsSync(join(elsewhere, relRoot)), false,
            'no stray data root may be created under the caller cwd');
    } finally {
        rmSync(absRoot, { recursive: true, force: true });
    }
});

test('loopback-only bind does NOT provision — local auto-login preserved', async () => {
    // `listen` + a loopback bind on both families is still a local-only
    // deployment; provisioning there would break the single-user
    // convenience for no security gain.
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-loopback-'));
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { initUserStorage, verifySecuritySettings, tryAutoLogin } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        await initUserStorage(root);
        console.error = () => {};
        console.warn = () => {};
        globalThis.COMMAND_LINE_ARGS = {
            listen: true,
            basicAuthMode: false,
            whitelistMode: false,
            listenAddressIPv4: '127.0.0.1',
            listenAddressIPv6: '::1',
        };
        await verifySecuritySettings();
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
    }
    const stored = readStoredUser(root, 'default-user');
    assert.equal(stored.password, '', 'loopback-only bind must not trigger provisioning');
    const req = { session: {}, query: {} };
    assert.equal(await tryAutoLogin(req, false), true, 'local single-user auto-login stays');
    assert.equal(req.session.handle, 'default-user');
});

test('disabled IPv6 family does not break loopback judgement — local auto-login preserved', async () => {
    // enableIPv6:false means no v6 socket ever opens (ServerStartup
    // useIPv6) — its configured address must not enter the exposure
    // judgement. With v4 bound to loopback this is a local-only
    // deployment; provisioning would only break single-user auto-login.
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-nov6-'));
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { initUserStorage, verifySecuritySettings, tryAutoLogin } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        await initUserStorage(root);
        console.error = () => {};
        console.warn = () => {};
        globalThis.COMMAND_LINE_ARGS = {
            listen: true,
            basicAuthMode: false,
            whitelistMode: false,
            enableIPv4: true,
            listenAddressIPv4: '127.0.0.1',
            enableIPv6: false,
            listenAddressIPv6: '[::1]', // configured but never bound — family disabled
        };
        await verifySecuritySettings();
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
    }
    const stored = readStoredUser(root, 'default-user');
    assert.equal(stored.password, '', 'a disabled family\'s configured address must not read as exposure');
    const req = { session: {}, query: {} };
    assert.equal(await tryAutoLogin(req, false), true, 'local single-user auto-login stays');
    assert.equal(req.session.handle, 'default-user');
});

test('loopback-looking address that fails bind validation still provisions — wildcard fallback is exposed', async () => {
    // '127.0.0.1 ' (trailing space) looks loopback to a naive trimmed check
    // but fails ipRegex — getIPv4ListenUrl() falls back to 0.0.0.0, so the
    // socket is actually exposed. Provisioning must judge the EFFECTIVE
    // bind host, not the configured string.
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-fallback-'));
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { initUserStorage, verifySecuritySettings, tryAutoLogin } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        await initUserStorage(root);
        console.error = () => {};
        console.warn = () => {};
        globalThis.COMMAND_LINE_ARGS = {
            listen: true,
            basicAuthMode: false,
            whitelistMode: false,
            listenAddressIPv4: '127.0.0.1 ', // invalid per ipRegex → binds 0.0.0.0
            listenAddressIPv6: '::1',
        };
        await verifySecuritySettings();
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
    }
    const stored = readStoredUser(root, 'default-user');
    assert.ok(stored.password, 'a configured address that binds as wildcard must provision');
    const req = { session: {}, query: {} };
    assert.equal(await tryAutoLogin(req, false), false, 'anonymous auto-login stays closed on the wildcard-bound instance');
});

test('OAuth-bound accounts are provisioned but their passwords are never printed', async () => {
    // Printing a usable password for an OAuth account would hand every log
    // reader a bypass around the provider's identity check. The password is
    // still stored (a sole OAuth account must not stay anonymous-auto-login
    // bait) — it is simply not disclosed on stderr. The guidance also has
    // to match reality: a bound provider that is not enabled on this
    // instance must not be recommended as a sign-in path.
    const root = mkdtempSync(join(tmpdir(), 'uto-ma-oauth-'));
    // Instance SSO settings: github enabled+configured, discord absent —
    // same predicate /api/users/oauth/providers reports on.
    seedStoredItem(root, 'luker:admin-settings:v1', {
        oauth: { github: { enabled: true, clientId: 'cid', clientSecret: 'csec' } },
    });
    // Pre-seed so initUserStorage does not also drop a default-user in —
    // three passwordless users: enabled-provider-bound, disabled-provider-
    // bound, and plain.
    seedStoredUser(root, { handle: 'sso-user', name: 'S', enabled: true, admin: false, password: '', salt: '', oauth: { github: { id: '42' } } });
    seedStoredUser(root, { handle: 'sso-orphan', name: 'O', enabled: true, admin: false, password: '', salt: '', oauth: { discord: { id: '7' } } });
    seedStoredUser(root, { handle: 'plain-user', name: 'P', enabled: true, admin: false, password: '', salt: '' });
    const { setConfigFilePath, getConfigFilePath } = await import('../src/util.js');
    if (!getConfigFilePath()) setConfigFilePath(writeScratchConfig(root));
    const { initUserStorage, verifySecuritySettings } = await import('../src/users.js');
    const prevArgs = globalThis.COMMAND_LINE_ARGS;
    const prevRoot = globalThis.DATA_ROOT;
    const captured = [];
    const origErr = console.error;
    const origWarn = console.warn;
    try {
        globalThis.DATA_ROOT = root;
        await initUserStorage(root);
        console.error = (...a) => captured.push(a.join(' '));
        console.warn = (...a) => captured.push(a.join(' '));
        globalThis.COMMAND_LINE_ARGS = { listen: true, basicAuthMode: false, whitelistMode: false };
        await verifySecuritySettings();
    } finally {
        console.error = origErr;
        console.warn = origWarn;
        globalThis.COMMAND_LINE_ARGS = prevArgs;
        globalThis.DATA_ROOT = prevRoot;
    }
    assert.ok(readStoredUser(root, 'sso-user').password, 'OAuth account still gets a stored password (auto-login stays closed)');
    assert.ok(readStoredUser(root, 'sso-orphan').password, 'disabled-provider account still gets a stored password');
    assert.ok(readStoredUser(root, 'plain-user').password, 'plain passwordless account provisioned');
    assert.ok(captured.some(l => /user:\s*sso-user/.test(l)), 'OAuth handle appears in the banner');
    assert.ok(captured.some(l => /OAuth-bound/.test(l)), 'OAuth-bound marker printed instead of the secret');
    const passLines = captured.filter(l => /pass:\s*\S+/.test(l));
    assert.equal(passLines.length, 1, 'only the non-OAuth account may have its password printed');
    // Guidance filter: the enabled provider is named for sso-user, while
    // sso-orphan (discord bound but not configured here) gets the
    // admin/recover.js fallback instead of a dead-end pointer.
    assert.ok(captured.some(l => /github/i.test(l) && /provider button/.test(l)),
        'enabled provider is recommended by name');
    assert.ok(captured.some(l => /No enabled SSO provider/.test(l)),
        'bound-but-disabled provider falls back to admin/recover.js guidance');
    assert.ok(captured.every(l => !(/discord/i.test(l) && /provider button/.test(l))),
        'a provider that is not enabled must never be recommended');
});
