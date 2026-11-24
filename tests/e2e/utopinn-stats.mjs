// utopinn-stats 聚合面 E2E(矩阵 case):
// SSE stub → /generate 一次 → /api/utopinn/stats/{summary,by-char,inject}
// 断言:总表分组、单卡视图、注入源命中+WI 条目、404/empty 语义。
import http from 'node:http';
const B = 'http://127.0.0.1:8000';
const STUB_PORT = 18768;
const CHAR = 'default_我没想当掌门啊';
const CHAT = 'e2e-stats-probe';
const PIECES = ['The ', 'stars ', 'align.'];
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
    return { status: res.status, body: json, headers: res.headers };
}

const out = [];
const log = (n, ok, d = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);

const stub = http.createServer((req2, res) => {
    if (req2.method === 'POST' && req2.url === '/v1/completions') {
        let buf = '';
        req2.on('data', (c) => (buf += c));
        req2.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            for (const p of PIECES) res.write(`data: ${JSON.stringify({ choices: [{ text: p, index: 0 }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        });
    } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

token = (await req('GET', '/csrf-token')).body?.token ?? '';
const base = `/api/utopinn/characters/${CHAR}/chats`;
await req('DELETE', `${base}/${CHAT}`);
await req('PUT', `${base}/${CHAT}`, {});
// 种子消息带掌门卡内嵌书关键词(灵石/贡献点/俸禄),worldinfo 必激活——
// 保证条目级命中断言吃到真数据,不是空表兜底。
await req('POST', `${base}/${CHAT}/messages`, { messages: [{ name: 'You', is_user: true, send_date: Date.now(), mes: '账本里的灵石俸禄和贡献点对不上', extra: {} }] });

// 一次生成(textgen stub),产出 job + inject 事件序列
const gen = await req('POST', '/api/utopinn/generate', {
    charDir: CHAR, chatName: CHAT, api: 'text',
    api_type: 'generic', api_server: `http://127.0.0.1:${STUB_PORT}`,
    stream: true,
});
const jobId = gen.headers.get('x-luker-generation-id');
log('generate 建 job', gen.status === 200 && !!jobId, `status=${gen.status} job=${String(jobId).slice(0, 8)}`);
for (let i = 0; i < 60; i++) {
    const r = await req('GET', `/api/utopinn/jobs/${jobId}`);
    if (['awaiting_ack', 'completed', 'persisting', 'failed', 'cancelled'].includes(r.body?.status)) break;
    await new Promise((r) => setTimeout(r, 500));
}

// 1. summary:totals 出表 + by=char 分组含本卡
const sum = await req('GET', '/api/utopinn/stats/summary?by=char&range=all');
const sumTotals = sum.body?.totals ?? {};
const sumGroup = (sum.body?.groups ?? []).find((g) => g.key === CHAR);
log('summary 200+totals', sum.status === 200 && typeof sumTotals.generations === 'number' && sumTotals.generations >= 1
    && 'p50ms' in sumTotals && 'tokensIn' in sumTotals,
    `status=${sum.status} gen=${sumTotals.generations} p50=${sumTotals.p50ms} tokIn=${sumTotals.tokensIn}`);
log('summary by=char 含本卡', !!sumGroup && sumGroup.generations >= 1,
    sumGroup ? `gen=${sumGroup.generations} fail=${sumGroup.failed}` : 'missing');

// 2. by-char:charDir 解析 + floors/generations/wiHits 字段
const bc = await req('GET', `/api/utopinn/stats/by-char/${encodeURIComponent(CHAR)}`);
log('by-char 200+字段', bc.status === 200 && bc.body?.charDir === CHAR
    && typeof bc.body.floors === 'number' && typeof bc.body.generations === 'number'
    && bc.body.generations >= 1 && 'wiHits' in bc.body,
    `status=${bc.status} floors=${bc.body?.floors} gen=${bc.body?.generations} wi=${bc.body?.wiHits}`);

// 3. inject?chat:六源在位 + worldinfo 源有事件/条目
const inj = await req('GET', `/api/utopinn/stats/inject?chat=${encodeURIComponent(`${CHAR}/${CHAT}`)}`);
const srcs = inj.body?.sources ?? [];
const srcNames = srcs.map((s) => s.source);
const wi = srcs.find((s) => s.source === 'worldinfo');
log('inject?chat 六源在位', inj.status === 200
    && ['preset', 'charbook', 'worldinfo', 'regex', 'instruct', 'macro'].every((k) => srcNames.includes(k)),
    `status=${inj.status} sources=${srcNames.join(',')}`);
log('inject 事件计数+shape', (inj.body?.events ?? 0) >= 1 && srcs.every((s) => 'injectedTotal' in s && 'hitRate' in s && 'tokensAvg' in s && 'msAvg' in s),
    `events=${inj.body?.events} wiEvents=${wi?.events} wiInjected=${wi?.injectedTotal}`);
// WI 种子词已埋:worldinfo 必须注入≥1 且条目级命中表非空
log('worldinfo 条目级 hits', !!wi && (wi.injectedTotal ?? 0) >= 1
    && Array.isArray(wi.entries) && wi.entries.length >= 1 && wi.entries.every((e) => e.hits >= 1),
    wi ? `entries=${wi?.entries?.length ?? '-'} injected=${wi?.injectedTotal} share=${wi?.tokenShare ?? '-'}` : 'no wi src');

// 4. 语义:未知卡 404;无数据会话 empty:true 不 500
const nf = await req('GET', '/api/utopinn/stats/by-char/__no_such_char_zzz__');
log('by-char 未知→404', nf.status === 404 && typeof nf.body?.error === 'string', `status=${nf.status}`);
const emp = await req('GET', `/api/utopinn/stats/inject?chat=${encodeURIComponent(`${CHAR}/no-such-chat-zzz`)}`);
log('inject 无数据→empty', emp.status === 200 && emp.body?.empty === true && (emp.body?.events ?? -1) === 0, `status=${emp.status} empty=${emp.body?.empty}`);

stub.close();
const fails = out.filter((l) => l.startsWith('FAIL'));
console.log(out.join('\n'));
console.log(`\n${out.length - fails.length}/${out.length} PASS${fails.length ? ' — FAILS!' : ''}`);
process.exit(fails.length ? 1 : 0);
