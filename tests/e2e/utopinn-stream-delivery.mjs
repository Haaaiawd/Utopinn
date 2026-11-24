// TASK-007 生成→WS 交付→持久化→重连回放 E2E:
// SSE stub → POST /generate stream:true → ws-ticket → subscribe 收
// head/chunk/end → chat 落盘 → resume from_seq:1 全量回放。
import http from 'node:http';
const B = 'http://127.0.0.1:8000';
const STUB_PORT = 18766;
const CHAR = 'default_我没想当掌门啊';
const CHAT = 'e2e-stream-probe';
const PIECES = ['The ', 'garden ', 'blooms.'];
let cookie = '', token = '';

async function req(method, path, body, rawHeaders) {
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
    return { status: res.status, body: json, headers: res.headers };
}

const out = [];
const log = (n, ok, d = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);

// ---- SSE stub:stream:true → text/event-stream 三段 + [DONE] ----
const stub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/completions') {
        let buf = '';
        req.on('data', (c) => (buf += c));
        req.on('end', () => {
            const wantStream = JSON.parse(buf || '{}').stream === true;
            if (!wantStream) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ text: PIECES.join(''), index: 0, finish_reason: 'stop' }] }));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            for (const p of PIECES) {
                res.write(`data: ${JSON.stringify({ choices: [{ text: p, index: 0 }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
    } else {
        res.writeHead(404); res.end();
    }
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

/** 开 WS + 订阅,收集帧直到 end/error/超时。 */
function openJobSocket(ticket, subscribeMsg, ms = 15000) {
    return new Promise((resolve) => {
        const frames = [];
        const ws = new WebSocket(`ws://127.0.0.1:8000/api/ws-delivery`, `luker-ws-ticket.${ticket}`);
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ frames, timedOut: true }); }, ms);
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            frames.push(m);
            if (m.type === 'end' || m.type === 'error') { clearTimeout(timer); ws.close(); resolve({ frames }); }
        };
        ws.onerror = () => { clearTimeout(timer); resolve({ frames, wsError: true }); };
        ws.onopen = () => ws.send(JSON.stringify(subscribeMsg));
    });
}

token = (await req('GET', '/csrf-token')).body?.token ?? '';
const base = `/api/utopinn/characters/${CHAR}/chats`;
await req('DELETE', `${base}/${CHAT}`);
await req('PUT', `${base}/${CHAT}`, {});
await req('POST', `${base}/${CHAT}/messages`, { messages: [{ name: 'You', is_user: true, send_date: Date.now(), mes: 'hello', extra: {} }] });

// 1. ws-ticket(一次一签,POST+CSRF)
const tk = await req('POST', '/api/ws-ticket', {});
log('ws-ticket', tk.status === 200 && typeof tk.body?.ticket === 'string', `status=${tk.status}`);

// 2. POST /generate stream:true → jobId(x-luker-generation-id)
const gen = await req('POST', '/api/utopinn/generate', {
    charDir: CHAR, chatName: CHAT, api: 'text',
    api_type: 'generic', api_server: `http://127.0.0.1:${STUB_PORT}`,
    stream: true,
});
const jobId = gen.headers.get('x-luker-generation-id') ?? gen.body?.request_id ?? gen.body?.job_id;
log('generate 200+jobId', gen.status === 200 && !!jobId, `status=${gen.status} jobId=${String(jobId).slice(0, 8)}`);

// 3. subscribe 收流(subscribe 在 POST 后立刻发,抢回放也认)
const tk2 = await req('POST', '/api/ws-ticket', {});
const s1 = await openJobSocket(tk2.body?.ticket, { type: 'resume', request_id: jobId, from_seq: 1 });
const kinds = s1.frames.map((f) => f.type);
log('head 帧', kinds.includes('head'), kinds.join(','));
const chunks = s1.frames.filter((f) => f.type === 'chunk');
log('chunk 帧≥1', chunks.length >= 1, `n=${chunks.length}`);
const decoded = chunks.map((c) => Buffer.from(c.data ?? '', 'base64').toString('utf8')).join('');
log('chunk 可解码含 data:', decoded.includes('data:'), decoded.slice(0, 60).replace(/\n/g, '\\n'));
log('end 帧', kinds.includes('end'), `last=${kinds[kinds.length - 1]}`);
log('seq 单调', s1.frames.every((f, i) => i === 0 || (f.seq ?? 0) > (s1.frames[i - 1].seq ?? 0)), 'seq');

// 4. persist:轮询 chat 出现 assistant 消息(拼齐三段)
let msgs = [];
for (let i = 0; i < 80; i++) {
    const r = await req('GET', `${base}/${CHAT}`);
    msgs = r.body?.messages ?? [];
    if (msgs.some((m) => !m.is_user && /blooms/.test(m.mes ?? ''))) break;
    await new Promise((r) => setTimeout(r, 250));
}
log('persist 落盘', msgs.some((m) => !m.is_user && /The garden blooms/.test(m.mes ?? '')), msgs.map((m) => (m.mes ?? '').slice(0, 30)).join(' | '));

// 5. 重连回放:resume from_seq:1 → 全量事件重发(job.events 缓冲)
const tk3 = await req('POST', '/api/ws-ticket', {});
const s2 = await openJobSocket(tk3.body?.ticket, { type: 'resume', request_id: jobId, from_seq: 1 }, 8000);
log('回放帧数≥首次', s2.frames.length >= s1.frames.length && s2.frames.length > 0, `first=${s1.frames.length} replay=${s2.frames.length}`);
log('回放含 end', s2.frames.some((f) => f.type === 'end'), '');

// 6. 越权面:别人的 job / 不存在的 job
const tk4 = await req('POST', '/api/ws-ticket', {});
const s3 = await openJobSocket(tk4.body?.ticket, { type: 'subscribe', request_id: 'nonexistent-job-id' }, 5000);
log('不存在 job → not_found', s3.frames.some((f) => f.type === 'error' && f.code === 'not_found'), JSON.stringify(s3.frames).slice(0, 100));

// 清理
await req('DELETE', `${base}/${CHAT}`);
stub.close();
log('清理', true);

console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
