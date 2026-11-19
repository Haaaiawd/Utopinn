// Core client smoke tests — mock fetch; construction/session/errors/verb shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = (p) => join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', p);
const {
    UtopinnClient, ApiError,
    isApiError, isNotFound, isIntegrityConflict, isExistsConflict,
    isSessionError, currentIntegrityFrom, retryOnIntegrityConflict,
    StateTargets, asPatchOps,
} = await import(dist('index.js'));
const { JOB_STATUSES, JOB_TERMINAL_STATUSES, IMPORT_KINDS } = await import('@utopinn/protocol');

function mockFetch(routes) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ path: u.pathname + u.search, method: init.method ?? 'GET', body, headers: init.headers });
        const handler = routes[u.pathname] ?? routes[u.pathname + u.search];
        const result = handler ? await handler(body, calls[calls.length - 1]) : {};
        if (result instanceof Response) return result;
        // envelope only when handler explicitly drives status/headers
        const env = result && typeof result === 'object' && ('status' in result || 'headers' in result)
            ? result : { data: result };
        const { status = 200, headers = {}, data } = env;
        return new Response(JSON.stringify(data), { status, headers });
    };
    fn.calls = calls;
    return fn;
}

const csrfRoute = { '/csrf-token': () => ({ token: 'csrf-1' }) };

test('protocol exports: job/import constants are usable at runtime', () => {
    assert.ok(JOB_STATUSES.includes('awaiting_ack'));
    assert.deepEqual([...JOB_TERMINAL_STATUSES], ['completed', 'failed', 'cancelled']);
    assert.deepEqual([...IMPORT_KINDS], ['char', 'world', 'preset', 'persona']);
});

test('construction: domains wired; autoSession fetches csrf once', async () => {
    const f = mockFetch({ ...csrfRoute, '/api/utopinn/characters': () => ({ items: [], total: 0 }) });
    const client = new UtopinnClient({ baseUrl: 'http://x/', fetch: f });
    assert.equal(client.baseUrl, 'http://x');
    for (const d of ['library', 'state', 'generation', 'mvu', 'plugins', 'data', 'script', 'th', 'diag']) {
        assert.ok(client[d], `domain ${d}`);
    }
    await client.library.chars();
    await client.library.chars();
    assert.equal(f.calls.filter(c => c.path === '/csrf-token').length, 1);
    assert.equal(f.calls.find(c => c.path.includes('characters')).headers['X-CSRF-Token'], 'csrf-1');
});

test('autoSession off: no csrf prefetch', async () => {
    const f = mockFetch({ ...csrfRoute, '/api/utopinn/characters': () => ({ items: [], total: 0 }) });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f, autoSession: false });
    await client.library.chars();
    assert.equal(f.calls.filter(c => c.path === '/csrf-token').length, 0);
});

test('autoReauth: 401 resets session and retries once', async () => {
    let n = 0;
    const f = mockFetch({
        '/csrf-token': () => ({ token: `t${++n}` }),
        '/api/utopinn/characters': (b, call) => n === 1
            ? { status: 401, data: { error: 'login' } }
            : { items: [], total: 0 },
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    await client.library.chars();
    const charCalls = f.calls.filter(c => c.path.includes('characters'));
    assert.equal(charCalls.length, 2);
    assert.equal(charCalls[1].headers['X-CSRF-Token'], 't2');
});

test('generate: POST /api/utopinn/generate body passthrough + jobId from header', async () => {
    const body = { charDir: 'char', chatName: 'chat', type: 'normal', stream: true, user: { name: 'U' } };
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/generate': () => new Response('{}', {
            status: 200,
            headers: { 'x-luker-generation-id': 'job-123' },
        }),
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    const r = await client.generation.generate(body);
    assert.equal(r.jobId, 'job-123');
    const call = f.calls.find(c => c.path === '/api/utopinn/generate');
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, body);
});

test('group generate: skipped=no_activated_member body surfaces', async () => {
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/generate': () => ({ ok: true, skipped: 'no_activated_member', group: { groupId: 'g', chatId: 'c', queue: [] } }),
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    const r = await client.generation.generate({ groupId: 'g' });
    assert.equal(r.data.skipped, 'no_activated_member');
});

test('abort stays on legacy /api/generation/:id/abort', async () => {
    const f = mockFetch({ ...csrfRoute, '/api/generation/j1/abort': () => ({ aborted: true }) });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    await client.generation.abort('j1');
    assert.equal(f.calls.at(-1).path, '/api/generation/j1/abort');
    assert.equal(f.calls.at(-1).method, 'POST');
});

test('errors: 404 → not_found;409 integrity → code+current_integrity', async () => {
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/characters/nope': () => ({ status: 404, data: { error: 'not found' } }),
        '/api/utopinn/characters/c/chats/x/document': () => ({ status: 409, data: { error: 'integrity', current_integrity: 'v2' } }),
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });

    await assert.rejects(() => client.library.char('nope'), (e) => isNotFound(e) && isApiError(e));
    await assert.rejects(
        () => client.library.chatPut('c', 'x', { header: {}, messages: [] }, { integrity: 'v1' }),
        (e) => isIntegrityConflict(e) && currentIntegrityFrom(e) === 'v2',
    );
    // 409 without integrity markers → exists/conflict
    const f2 = mockFetch({
        ...csrfRoute,
        '/api/utopinn/characters/c/chats/dup': () => ({ status: 409, data: { error: 'chat already exists' } }),
    });
    const c2 = new UtopinnClient({ baseUrl: 'http://x', fetch: f2 });
    await assert.rejects(() => c2.library.chatCreate('c', 'dup'), (e) => isExistsConflict(e) && !isIntegrityConflict(e));
});

test('retryOnIntegrityConflict: re-anchors from current_integrity, returns new integrity', async () => {
    const seen = [];
    let attempt = 0;
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/characters/c/chats/x/document': (b) => {
            seen.push(b.integrity);
            return ++attempt === 1
                ? { status: 409, data: { error: 'integrity', current_integrity: 'v2' } }
                : { ok: true, integrity: 'v3' };
        },
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    const { result, integrity } = await retryOnIntegrityConflict(
        (i) => client.library.chatPut('c', 'x', { header: {}, messages: [] }, { integrity: i }),
        { initial: 'v1' },
    );
    assert.deepEqual(seen, ['v1', 'v2']);
    assert.equal(result.ok, true);
    assert.equal(integrity, 'v3');
});

test('session error classification: 403 without reauth → session', async () => {
    const f = mockFetch({ '/api/utopinn/characters': () => ({ status: 403, data: {} }) });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f, autoSession: false, autoReauth: false });
    await assert.rejects(() => client.library.chars(), isSessionError);
});

test('state targets + asPatchOps normalization (CLI shapes)', () => {
    assert.deepEqual(StateTargets.chat('dir.png', 'chat.jsonl'), { avatar_url: 'dir.png', file_name: 'chat.jsonl' });
    assert.deepEqual(StateTargets.chat('dir', 'chat'), { avatar_url: 'dir.png', file_name: 'chat.jsonl' });
    assert.deepEqual(StateTargets.groupChat('g1'), { is_group: true, id: 'g1' });
    assert.deepEqual(StateTargets.char('d'), { avatar_url: 'd.png' });
    assert.deepEqual(StateTargets.preset('p'), { apiId: 'openai', name: 'p' });

    const ops = [{ op: 'replace', path: '/a', value: 1 }];
    assert.deepEqual(asPatchOps(ops), ops);
    assert.deepEqual(asPatchOps({ operations: ops }), ops);
    assert.deepEqual(asPatchOps({ operation: ops[0] }), ops);
    assert.deepEqual(asPatchOps(ops[0]), ops);
    assert.equal(asPatchOps({}), null);
});

test('chat verbs wire: chats/chatGet/chatCreate paths + stripExt', async () => {
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/characters/d/chats': () => ({ items: [], total: 0 }),
        '/api/utopinn/characters/d/chats/c': (b, call) => call.method === 'PUT' ? { ok: true, name: 'c', fileName: 'c.jsonl', integrity: 'i1' } : { header: {}, messages: [] },
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    await client.library.chats('d.png');
    await client.library.chatGet('d.png', 'c.jsonl');
    await client.library.chatCreate('d.png', 'c.jsonl');
    const paths = f.calls.map(c => c.path).filter(p => p.includes('chats'));
    // stripExt semantics: server routes take bare charDir/chatName (no .png/.jsonl)
    assert.deepEqual(paths, [
        '/api/utopinn/characters/d/chats',
        '/api/utopinn/characters/d/chats/c',
        '/api/utopinn/characters/d/chats/c',
    ]);
});

test('settings GET ?raw=1 only when requested; PATCH body passthrough', async () => {
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/settings': () => ({ settings: {} }),
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    await client.library.settings();
    await client.library.settings({ raw: true });
    await client.library.settingsPatch({ power_user: { personas: {} } });
    const paths = f.calls.filter(c => c.path.includes('settings')).map(c => c.path);
    assert.equal(paths[0], '/api/utopinn/settings');
    assert.equal(paths[1], '/api/utopinn/settings?raw=1');
    assert.deepEqual(f.calls.at(-1).body, { power_user: { personas: {} } });
});

test('requestBinary: backup zip + content-disposition name', async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/backup': () => new Response(zipBytes, {
            status: 200,
            headers: { 'content-disposition': 'attachment; filename="bk-1.zip"' },
        }),
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    const r = await client.data.backup();
    assert.equal(r.fileName, 'bk-1.zip');
    assert.equal(r.bytes, 4);
    assert.equal(new Uint8Array(r.data)[0], 0x50);
});

test('state verbs wire: chat get/post + preset delete-all/rename', async () => {
    const f = mockFetch({
        ...csrfRoute,
        '/api/utopinn/state/chat/get': () => ({ ok: true, data: { x: 1 } }),
        '/api/utopinn/state/preset/delete-all': () => ({ ok: true, deleted: 3 }),
        '/api/utopinn/state/preset/rename': () => ({ ok: true, renamed: 2 }),
    });
    const client = new UtopinnClient({ baseUrl: 'http://x', fetch: f });
    const g = await client.state.chat.get(StateTargets.chat('d', 'c'), 'ns');
    assert.deepEqual(g.data, { x: 1 });
    const call = f.calls.find(c => c.path.includes('state/chat/get'));
    assert.deepEqual(call.body, { avatar_url: 'd.png', file_name: 'c.jsonl', namespace: 'ns' });
    assert.equal((await client.state.preset.deleteAll(StateTargets.preset('p'))).deleted, 3);
    await client.state.preset.rename('openai', 'p2', 'p3');
    assert.deepEqual(f.calls.at(-1).body, { apiId: 'openai', oldName: 'p2', newName: 'p3' });
});
