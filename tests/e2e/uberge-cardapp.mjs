// TASK-014/022 CardApp 服务端面 E2E:
// 夹具卡 card_app.files → POST mounts → entryUrl ?shim=t0 注入 →
// shim/t0.js 公共供给 → 资产服务 → CSP 头 → revoke 后 404。
import fs from 'node:fs';
import path from 'node:path';
const B = 'http://127.0.0.1:8000';
const CARD = 'e2e-cardapp';
let cookie = '', token = '';

async function req(method, p, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers['x-csrf-token'] = token;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(B + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setC = res.headers.getSetCookie?.() ?? [];
    if (setC.length) {
        const jar = new Map((cookie ? cookie + '; ' : '').split('; ').filter(Boolean).map(c => c.split('=')));
        for (const c of setC) { const [pair] = c.split(';'); const [k] = pair.split('='); jar.set(k, pair); }
        cookie = [...jar.values()].join('; ');
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
}

const out = [];
const log = (n, ok, d = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);

token = (await req('GET', '/csrf-token')).body?.token ?? '';
fs.copyFileSync('tests/corpus/cards/cardapp-probe.json', `apps/server/data/default-user/characters/${CARD}.json`);

let mountId = null;
try {
    // 1. mount
    let r = await req('POST', '/api/card-runtime/mounts', { charId: CARD });
    log('mount 201', r.status === 201 && r.body?.entryUrl && r.body?.mountId, JSON.stringify(r.body).slice(0, 200));
    mountId = r.body?.mountId;
    const entryUrl = r.body?.entryUrl;
    const shimUrl = r.body?.shimUrl;

    // 2. entryUrl ?shim=t0 → shim 标签注入 + CSP 头
    r = await req('GET', `${entryUrl}?shim=t0`);
    log('入口含 shim 标签', r.status === 200 && typeof r.body === 'string' && r.body.includes('data-card-runtime-shim'), `status=${r.status}`);
    const csp = r.headers.get('content-security-policy') ?? '';
    log('CSP 头在', csp.length > 10, csp.slice(0, 80));

    // 3. 无 shim 参数 → 不注
    r = await req('GET', entryUrl);
    log('默认不注 shim', r.status === 200 && typeof r.body === 'string' && !r.body.includes('data-card-runtime-shim'), `status=${r.status}`);

    // 4. shim 运行时公共供给(TH 面)
    r = await req('GET', shimUrl ?? '/card-runtime/shim/t0.js');
    log('shim t0.js', r.status === 200 && typeof r.body === 'string' && r.body.includes('TavernHelper'), `status=${r.status}`);

    // 5. 嵌入资产服务
    r = await req('GET', `${entryUrl.replace(/index\.html$/, '')}style.css`);
    log('资产服务', r.status === 200 && String(r.body).includes('background'), `status=${r.status}`);

    // 6. 无卡 app's 拒绝
    r = await req('POST', '/api/card-runtime/mounts', { charId: 'default_Seraphina' });
    log('无 card_app 拒绝', r.status === 404 && r.body?.error === 'no_card_app', JSON.stringify(r.body).slice(0, 120));

    // 7. revoke → entry 404
    r = await req('DELETE', `/api/card-runtime/mounts/${mountId}`);
    log('revoke 204', r.status === 204, `status=${r.status}`);
    r = await req('GET', entryUrl);
    log('revoke 后 404', r.status === 404, `status=${r.status}`);
} finally {
    if (mountId) await req('DELETE', `/api/card-runtime/mounts/${mountId}`).catch(() => {});
    fs.unlinkSync(`apps/server/data/default-user/characters/${CARD}.json`);
    const assetDir = `apps/server/data/default-user/card-apps/${CARD}`;
    if (fs.existsSync(assetDir)) fs.rmSync(assetDir, { recursive: true, force: true });
    log('清理', true);
}

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
