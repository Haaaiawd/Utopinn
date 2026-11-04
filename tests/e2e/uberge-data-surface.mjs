// uberge-data 插件面 E2E:scan-st 清单 → backup 归档 → UDP 发现。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';

const B = 'http://127.0.0.1:8000';
let cookie = '', token = '';

async function req(method, p, body) {
    const headers = { 'content-type': 'application/json' };
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
    let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 60) }; }
    return { status: res.status, body: json, headers: res.headers };
}

const out = [];
const log = (n, ok, d = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);

// 造一个假 ST 目录结构
const stRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scan-'));
fs.mkdirSync(path.join(stRoot, 'characters'), { recursive: true });
fs.mkdirSync(path.join(stRoot, 'worlds'), { recursive: true });
fs.mkdirSync(path.join(stRoot, 'OpenAI Settings'), { recursive: true });
fs.writeFileSync(path.join(stRoot, 'characters', 'Probe.png'), Buffer.from([0x89, 0x50]));
fs.writeFileSync(path.join(stRoot, 'worlds', 'book.json'), '{}');
fs.writeFileSync(path.join(stRoot, 'OpenAI Settings', 'preset.json'), '{}');
fs.writeFileSync(path.join(stRoot, 'characters', 'skip.txt'), 'x'); // 不该进清单

const r0 = await req('GET', '/csrf-token');
token = r0.body?.token ?? '';
log('csrf', !!token);

// scan-st
let r = await req('POST', '/api/uberge/import/scan-st', { dir: stRoot });
log('scan-st 200', r.status === 200 && r.body?.total === 3, `total=${r.body?.total} counts=${JSON.stringify(r.body?.counts)}`);
log('scan 类别覆盖', r.body?.counts?.character === 1 && r.body?.counts?.world === 1 && r.body?.counts?.preset === 1);

r = await req('POST', '/api/uberge/import/scan-st', { dir: path.join(stRoot, 'nonexistent') });
log('scan-st 404', r.status === 404, `status=${r.status}`);

r = await req('POST', '/api/uberge/import/scan-st', {});
log('scan-st 400 缺 dir', r.status === 400);

// backup
r = await req('POST', '/api/uberge/backup', {});
const isZip = r.body?._raw ? r.body._raw.startsWith('PK') : false;
const zipHdr = (r.headers.get('content-disposition') ?? '').includes('attachment')
    || (r.headers.get('content-type') ?? '').includes('zip');
log('backup 200+zip', r.status === 200 && (isZip || zipHdr), `status=${r.status} ct=${r.headers.get('content-type')}`);

// UDP 发现
const pong = await new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); resolve(null); }, 3000);
    sock.on('message', (msg) => { clearTimeout(timer); sock.close(); resolve(msg.toString()); });
    sock.bind(() => {
        const port = sock.address().port;
        sock.send('uberge-discover', 8000, '127.0.0.1');
        void port;
    });
});
let pongOk = false;
try { pongOk = JSON.parse(pong ?? '').app === 'uberge'; } catch { /* noop */ }
log('udp discover pong', pongOk, (pong ?? '').slice(0, 90));

// 清场
fs.rmSync(stRoot, { recursive: true, force: true });

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - fails}/${out.length} passed`);
process.exit(fails ? 1 : 0);
