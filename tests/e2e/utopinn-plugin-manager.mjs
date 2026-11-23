// utopinn-plugins 管理面 E2E:list → disable(路由实时消失)→ enable(路由恢复)
// → reload → core 件 400 → 自锁拒绝。结束后删 profile.patch.yaml 还原。
// 开关目标用 utopinn-diag(可拆观测面;utopinn-data 已锁 core,不可作目标)。
import fs from 'node:fs';
const B = 'http://127.0.0.1:8000';
let cookie = '', token = '';

async function req(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-csrf-token'] = token;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setC = res.headers.getSetCookie?.() ?? [];
    if (setC.length) {
        const jar = new Map((cookie ? cookie + '; ' : '').split('; ').filter(Boolean).map(c => c.split('=')));
        for (const c of setC) { const [pair] = c.split(';'); const [k] = pair.split('='); jar.set(k, pair); }
        cookie = [...jar.values()].join('; ');
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

const out = [];
const log = (n, ok, d = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);

token = (await req('GET', '/csrf-token')).body?.token ?? '';
log('csrf', !!token);

// 1. 清单(含 core 位透出)
let r = await req('GET', '/api/utopinn/plugins');
const items = r.body?.items ?? [];
log('plugins 清单', r.status === 200 && items.length >= 7, `count=${items.length} ids=${items.map(i => i.id).join(',')}`);
log('全 active', items.every(i => i.status === 'active'));
log('core 位透出', items.find(i => i.id === 'utopinn-data')?.core === true
    && items.find(i => i.id === 'utopinn-diag')?.core === false,
    JSON.stringify(items.map(i => `${i.id}:${i.core}`)));

// 2. disable utopinn-diag → 其路由应实时消失(/_kernel 是 diag 供的)
r = await req('POST', '/api/utopinn/plugins/utopinn-diag/disable');
log('disable 200', r.status === 200 && r.body?.status === 'disabled');
r = await req('GET', '/api/utopinn/_kernel');
log('disable 后路由消失', r.status === 404 || r.status === 405, `status=${r.status}`);
r = await req('GET', '/api/utopinn/plugins');
const diag = r.body?.items?.find(i => i.id === 'utopinn-diag');
log('清单回读 disabled', diag?.status === 'disabled' && diag?.disabled === true, JSON.stringify(diag));
log('patch 文件落盘', fs.existsSync('apps/server/src/profile.patch.yaml'));

// 3. enable → 路由恢复
r = await req('POST', '/api/utopinn/plugins/utopinn-diag/enable');
log('enable 200', r.status === 200 && r.body?.status === 'active');
r = await req('GET', '/api/utopinn/_kernel');
log('enable 后路由恢复', r.status === 200 && Array.isArray(r.body?.routes), `status=${r.status}`);

// 4. reload regex(无害可拆目标)
r = await req('POST', '/api/utopinn/plugins/utopinn-regex/reload');
log('reload 200', r.status === 200 && r.body?.status === 'active');
r = await req('GET', '/api/utopinn/regex');
log('reload 后 regex 仍活', r.status === 200, `status=${r.status}`);

// 5. core 闸:data/th/connection/generate 等锁件 disable → 400
r = await req('POST', '/api/utopinn/plugins/utopinn-data/disable');
log('core 件 disable 400', r.status === 400, `status=${r.status} err=${r.body?.error}`);
r = await req('POST', '/api/utopinn/plugins/utopinn-th/disable');
log('th disable 400', r.status === 400, `status=${r.status}`);

// 6. 自锁
r = await req('POST', '/api/utopinn/plugins/utopinn-plugins/disable');
log('自锁 400', r.status === 400, `status=${r.status}`);

// 7. 不存在插件 404
r = await req('POST', '/api/utopinn/plugins/nonexistent/disable');
log('未知插件 404', r.status === 404, `status=${r.status}`);

// 还原:patch 文件删掉(基座全启用,运行态不受影响)
try { fs.unlinkSync('apps/server/src/profile.patch.yaml'); log('patch 清理', true); } catch { log('patch 清理', false); }

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
