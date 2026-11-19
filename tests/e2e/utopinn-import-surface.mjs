// utopinn-import 插件面 E2E:preview 探测(不落库)→ commit 落卡 → fs 验证 → 清理。
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

const r0 = await req('GET', '/csrf-token');
token = r0.body?.token ?? '';
log('csrf', !!token);

// 最小 v2 JSON 卡
const card = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: 'E2E导入探针', description: 'tmp card for import e2e',
        personality: '', scenario: '', first_mes: 'hi', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: ['e2e'], creator: 'e2e', character_version: '1',
    },
};
const dataBase64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');

// preview
let r = await req('POST', '/api/utopinn/import/preview', { name: 'e2e-probe-card.json', dataBase64 });
log('preview 200', r.status === 200 && r.body?.kind === 'char', `kind=${r.body?.kind} name=${r.body?.name} target=${r.body?.targetName}`);
log('preview 不落库提示', r.body?.conflicts?.existingSameName === false);

// commit
r = await req('POST', '/api/utopinn/import/commit', { name: 'e2e-probe-card.json', dataBase64, kind: 'char' });
log('commit 200', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body).slice(0, 120));
const stem = r.body?.targetName;

// fs 验证 + GET 角色列表可见
r = await req('GET', '/api/utopinn/characters');
const found = (r.body?.items ?? []).find(i => i.charDir === stem);
log('characters 列表可见', !!found, `stem=${stem}`);

// 冲突:同名再 commit → 409(缺 conflict 策略)
r = await req('POST', '/api/utopinn/import/commit', { name: 'e2e-probe-card.json', dataBase64, kind: 'char' });
log('冲突 409', r.status === 409, `status=${r.status}`);

// rename 策略
r = await req('POST', '/api/utopinn/import/commit', { name: 'e2e-probe-card.json', dataBase64, kind: 'char', conflict: 'rename' });
log('rename 落库', r.status === 200 && r.body?.renamed === true, `target=${r.body?.targetName}`);
const stem2 = r.body?.targetName;

// 清理:删两张探测卡文件
import fs from 'node:fs';
import path from 'node:path';
const charsDir = 'apps/server/data/default-user/characters';
for (const s of [stem, stem2]) {
    if (!s) continue;
    for (const ext of ['.png', '.webp', '.json']) {
        const p = path.join(charsDir, `${s}${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
}
log('清理落盘卡', true);

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
