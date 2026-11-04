// TASK-018 写面 E2E:经 kernel 插件通道打真机。
// 每项 = 创建 → 读回断言 → 清理,不留脏数据。
const B = 'http://127.0.0.1:8000';
let cookie = '', token = '';

async function req(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-csrf-token'] = token;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(B + path, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setC = res.headers.getSetCookie?.() ?? [];
    if (setC.length) {
        const jar = new Map((cookie ? cookie + '; ' : '').split('; ').filter(Boolean).map(c => c.split('=')));
        for (const c of setC) {
            const [pair] = c.split(';');
            const [k] = pair.split('=');
            jar.set(k, pair);
        }
        cookie = [...jar.values()].join('; ');
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

const out = [];
function log(name, ok, detail = '') {
    out.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
}

// 0. CSRF/session
{
    const r = await req('GET', '/csrf-token');
    token = r.body?.token ?? '';
    log('csrf-token', !!token);
}

// 1. preset PUT → GET → DELETE
{
    const doc = { temperature: 0.42, test_probe: 'bstep' };
    let r = await req('PUT', '/api/uberge/presets/__e2e_preset__?apiId=openai', doc);
    log('PUT preset', r.status === 200 && r.body?.ok, JSON.stringify(r.body).slice(0, 80));
    r = await req('GET', '/api/uberge/presets/__e2e_preset__?apiId=openai');
    log('GET preset back', r.status === 200 && r.body?.doc?.temperature === 0.42);
    r = await req('DELETE', '/api/uberge/presets/__e2e_preset__?apiId=openai');
    log('DELETE preset', r.status === 204, `status=${r.status}`);
    r = await req('GET', '/api/uberge/presets/__e2e_preset__?apiId=openai');
    log('preset gone (404)', r.status === 404, `status=${r.status}`);
}

// 2. world PUT → GET → DELETE
{
    const doc = { entries: { '0': { uid: 0, key: ['probe'], content: 'e2e', comment: '', enabled: true } } };
    let r = await req('PUT', '/api/uberge/worlds/__e2e_world__', doc);
    log('PUT world', r.status === 200 && r.body?.ok, JSON.stringify(r.body).slice(0, 80));
    r = await req('GET', '/api/uberge/worlds/__e2e_world__');
    log('GET world back', r.status === 200 && !!r.body?.doc?.entries);
    r = await req('DELETE', '/api/uberge/worlds/__e2e_world__');
    log('DELETE world', r.status === 204, `status=${r.status}`);
}

// 3. persona PUT → GET list → DELETE
{
    let r = await req('PUT', '/api/uberge/personas/e2e-probe.png', { name: 'E2E探针', description: 'tmp', position: 1 });
    log('PUT persona', r.status === 200 && r.body?.ok && r.body?.name === 'E2E探针', JSON.stringify(r.body).slice(0, 90));
    r = await req('GET', '/api/uberge/personas');
    const found = (r.body?.items ?? []).some(p => p.avatar === 'e2e-probe.png' && p.name === 'E2E探针');
    log('persona in list', found);
    r = await req('DELETE', '/api/uberge/personas/e2e-probe.png');
    log('DELETE persona', r.status === 204, `status=${r.status}`);
    r = await req('DELETE', '/api/uberge/personas/e2e-probe.png');
    log('persona gone (404)', r.status === 404, `status=${r.status}`);
}

// 4. secrets:PUT → GET masked → DELETE
{
    let r = await req('PUT', '/api/uberge/secrets/api_key_generic', { value: 'sk-e2e-probe-secret-value-1234', label: 'e2e' });
    const id = r.body?.id;
    const entries = r.body?.entries ?? [];
    const masked = entries.find(e => e.id === id)?.value ?? '';
    log('PUT secret', r.status === 200 && !!id, `id=${String(id).slice(0, 8)}`);
    log('masked (no明文)', masked.length > 0 && !masked.includes('e2e-probe'), masked.slice(0, 20));
    r = await req('GET', '/api/uberge/secrets');
    log('GET secrets map', r.status === 200 && 'api_key_generic' in (r.body?.secrets ?? {}));
    r = await req('DELETE', `/api/uberge/secrets/api_key_generic/${id}`);
    log('DELETE secret', r.status === 204, `status=${r.status}`);
    // 坏 key 拒
    r = await req('PUT', '/api/uberge/secrets/not_a_real_key', { value: 'x' });
    log('bad key rejected (400)', r.status === 400, `status=${r.status}`);
}

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
