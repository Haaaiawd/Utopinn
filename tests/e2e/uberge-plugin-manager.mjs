// uberge-plugins 管理面 E2E:list → disable(路由实时消失)→ enable(路由恢复)
// → reload → 自锁拒绝。结束后删 profile.patch.yaml 还原。
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

// 1. 清单
let r = await req('GET', '/api/uberge/plugins');
const items = r.body?.items ?? [];
log('plugins 清单', r.status === 200 && items.length >= 7, `count=${items.length} ids=${items.map(i => i.id).join(',')}`);
log('全 active', items.every(i => i.status === 'active'));

// 2. disable uberge-import → 其路由应实时消失
r = await req('POST', '/api/uberge/plugins/uberge-import/disable');
log('disable 200', r.status === 200 && r.body?.status === 'disabled');
r = await req('POST', '/api/uberge/import/preview', { name: 'x.json', dataBase64: 'e30=' });
log('disable 后路由消失', r.status === 404 || r.status === 405, `status=${r.status}`);
r = await req('GET', '/api/uberge/plugins');
const imp = r.body?.items?.find(i => i.id === 'uberge-import');
log('清单回读 disabled', imp?.status === 'disabled' && imp?.disabled === true, JSON.stringify(imp));
log('patch 文件落盘', fs.existsSync('apps/server/src/profile.patch.yaml'));

// 3. enable → 路由恢复
r = await req('POST', '/api/uberge/plugins/uberge-import/enable');
log('enable 200', r.status === 200 && r.body?.status === 'active');
const card = { spec: 'chara_card_v2', data: { name: 'X', description: '', first_mes: '' } };
r = await req('POST', '/api/uberge/import/preview', { name: 'x.json', dataBase64: Buffer.from(JSON.stringify(card)).toString('base64') });
log('enable 后路由恢复', r.status === 200 && r.body?.kind === 'char', `status=${r.status}`);

// 4. reload diag(无害目标)
r = await req('POST', '/api/uberge/plugins/uberge-diag/reload');
log('reload 200', r.status === 200 && r.body?.status === 'active');
r = await req('GET', '/api/uberge/_kernel');
log('reload 后 diag 仍活', r.status === 200 && Array.isArray(r.body?.routes));

// 5. 自锁
r = await req('POST', '/api/uberge/plugins/uberge-plugins/disable');
log('自锁 400', r.status === 400, `status=${r.status}`);

// 6. 不存在插件 404
r = await req('POST', '/api/uberge/plugins/nonexistent/disable');
log('未知插件 404', r.status === 404, `status=${r.status}`);

// 还原:patch 文件删掉(基座全启用,运行态不受影响)
try { fs.unlinkSync('apps/server/src/profile.patch.yaml'); log('patch 清理', true); } catch { log('patch 清理', false); }

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
