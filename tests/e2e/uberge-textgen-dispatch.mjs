// TASK-020 textgen 分叉 E2E:stub LLM 抓真 prompt + persist 回环。
// 建会话 → POST /generate api:'text' → stub 收 prompt → 验证 instruct-off
// 裸格式 + name2 续写锚 → 轮询 chat 看持久化 → 清理。
import http from 'node:http';
const B = 'http://127.0.0.1:8000';
const STUB_PORT = 18765;
const CHAR = 'default_Seraphina';
const CHAT = 'e2e-textgen-probe';
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

// ---- stub LLM:GENERIC → /v1/completions ----
let captured = null;
const stub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/completions') {
        let buf = '';
        req.on('data', (c) => (buf += c));
        req.on('end', () => {
            captured = JSON.parse(buf);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'stub-1', choices: [{ text: 'stub says: understood.', index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
        });
    } else {
        res.writeHead(404); res.end();
    }
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

token = (await req('GET', '/csrf-token')).body?.token ?? '';
const base = `/api/uberge/characters/${CHAR}/chats`;
await req('DELETE', `${base}/${CHAT}`);

// 1. 建探测会话 + 塞一条历史
let r = await req('PUT', `${base}/${CHAT}`, {});
log('建会话', r.status === 201, `status=${r.status}`);
r = await req('POST', `${base}/${CHAT}/messages`, {
    messages: [{ name: 'You', is_user: true, send_date: Date.now(), mes: 'describe your garden', extra: {} }],
});
log('塞历史', r.status === 200 && r.body?.accepted === 1);

// 2. 参数错误面
r = await req('POST', '/api/uberge/generate', { charDir: CHAR, chatName: CHAT, api: 'text', api_type: 'bogus' });
log('非法 api_type 400', r.status === 400, `status=${r.status}`);
r = await req('POST', '/api/uberge/generate', { charDir: CHAR, chatName: CHAT, api: 'text', api_type: 'generic' });
log('缺 api_server 400', r.status === 400, `status=${r.status}`);

// 3. 真分叉:GENERIC + stub server
r = await req('POST', '/api/uberge/generate', {
    charDir: CHAR, chatName: CHAT, api: 'text',
    api_type: 'generic', api_server: `http://127.0.0.1:${STUB_PORT}`,
    stream: false,
});
log('/generate 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 80)}`);

// 4. stub 抓到 prompt(等一下,dispatch 是异步 job)
for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 200));
log('stub 抓到 prompt', !!captured?.prompt, captured ? `len=${captured.prompt.length}` : 'no capture');
if (captured) {
    const p = captured.prompt;
    log('转录含用户行', /describe your garden/.test(p));
    log('尾锚 name2:', /Seraphina:\s*$/.test(p) || p.trimEnd().endsWith('Seraphina:'), p.slice(-60).replace(/\n/g, '\\n'));
    log('角色内容在场', p.length > 200);
    log('生成参数透传', captured.temperature !== undefined, `temp=${captured.temperature}`);
}

// 5. persist 回环:轮询 chat 出现 assistant 消息
let msgs = [];
for (let i = 0; i < 60; i++) {
    r = await req('GET', `${base}/${CHAT}`);
    msgs = r.body?.messages ?? [];
    if (msgs.length >= 2) break;
    await new Promise((r) => setTimeout(r, 250));
}
log('persist 回写', msgs.some((m) => !m.is_user && /stub says/.test(m.mes ?? '')), `msgs=${msgs.length} ${msgs.map((m) => (m.mes ?? '').slice(0, 30)).join(' | ')}`);

// 6. 清理
r = await req('DELETE', `${base}/${CHAT}`);
log('清理', r.status === 204);
stub.close();

console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
