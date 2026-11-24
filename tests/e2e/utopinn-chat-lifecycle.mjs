// TASK-023 聊天生命周期 E2E:
// 建 → 追加(带 swipes)→ PATCH swipe_id(切换持久化)→ integrity 冲突 409
// → rename → 读回验证 → delete。目标卡用真实 我没想当掌门啊。
import fs from 'node:fs';
const B = 'http://127.0.0.1:8000';
const CHAR = 'default_我没想当掌门啊';
const CHAT = 'e2e-chat-probe';
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

const base = `/api/utopinn/characters/${CHAR}/chats`;

// 预清理:可能残留的上次探测
await req('DELETE', `${base}/${CHAT}`);
await req('DELETE', `${base}/${CHAT}-renamed`);

// 1. 建
let r = await req('PUT', `${base}/${CHAT}`, {});
log('建会话 201', r.status === 201 && r.body?.ok, `status=${r.status} integrity=${r.body?.integrity?.slice(0, 8)}`);
const i0 = r.body?.integrity;

// 2. 重名 → 409
r = await req('PUT', `${base}/${CHAT}`, {});
log('重名 409', r.status === 409, `status=${r.status}`);

// 3. 追加两条消息:用户问 + 角色答(带 2 个 swipe,swipe_id=0)
r = await req('POST', `${base}/${CHAT}/messages`, {
    integrity: i0,
    messages: [
        { name: 'You', is_user: true, is_system: false, send_date: Date.now(), mes: 'hello probe', extra: {} },
        { name: '我没想当掌门啊', is_user: false, is_system: false, send_date: Date.now(), mes: 'swipe-A', swipes: ['swipe-A', 'swipe-B'], swipe_id: 0, extra: { gen_id: 'g1' } },
    ],
});
log('追加 accepted=2', r.status === 200 && r.body?.accepted === 2, JSON.stringify(r.body).slice(0, 100));
const i1 = r.body?.integrity;

// 4. gen_id 重发去重
r = await req('POST', `${base}/${CHAT}/messages`, {
    messages: [{ name: '我没想当掌门啊', mes: 'dup', extra: { gen_id: 'g1' } }],
});
log('gen_id 去重', r.status === 200 && r.body?.dedupedGenIds?.includes('g1') && r.body?.accepted === 0, JSON.stringify(r.body));

// 5. PATCH swipe_id → 1(swipe 切换持久化)
r = await req('PATCH', `${base}/${CHAT}`, {
    ops: [{ op: 'replace', path: '/body/1/swipe_id', value: 1 }],
});
log('PATCH swipe_id', r.status === 200 && r.body?.integrity, `status=${r.status}`);

// 6. 读回验证 swipe_id=1
r = await req('GET', `${base}/${CHAT}`);
const m1 = r.body?.messages?.[1];
log('swipe 持久化读回', m1?.swipe_id === 1 && m1?.swipes?.[1] === 'swipe-B', `swipe_id=${m1?.swipe_id}`);

// 7. integrity 乐观锁 → 409(用旧 i0)
r = await req('POST', `${base}/${CHAT}/messages`, { integrity: i0, messages: [{ name: 'x', mes: 'stale' }] });
log('integrity 冲突 409', r.status === 409, `status=${r.status}`);

// 8. 非法 op → 400
r = await req('PATCH', `${base}/${CHAT}`, { ops: [{ op: 'frobnicate', path: '/body/0/x' }] });
log('非法 op 400', r.status === 400, `status=${r.status}`);

// 9. rename
r = await req('POST', `${base}/${CHAT}/rename`, { newName: `${CHAT}-renamed` });
log('rename', r.status === 200 && r.body?.name === `${CHAT}-renamed`, `status=${r.status}`);

// 10. 旧名 404 / 新名可读
r = await req('GET', `${base}/${CHAT}`);
log('旧名 404', r.status === 404, `status=${r.status}`);
r = await req('GET', `${base}/${CHAT}-renamed`);
log('新名可读', r.status === 200 && r.body?.messages?.length === 2, `msgs=${r.body?.messages?.length}`);

// 11. 删除
r = await req('DELETE', `${base}/${CHAT}-renamed`);
log('删除 204', r.status === 204, `status=${r.status}`);

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
