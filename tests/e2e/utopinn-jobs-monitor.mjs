// TASK-017 生成任务监视/回放 E2E:
// SSE stub → /generate(stream) → GET /api/utopinn/jobs 摘要列表
// → GET /jobs/:id 详情(job.trace=组装 token 分块,sources=WI 激活轨迹)
// → 越权/不存在 job 404。
import http from 'node:http';
const B = 'http://127.0.0.1:8000';
const STUB_PORT = 18767;
const CHAR = 'default_我没想当掌门啊';
const CHAT = 'e2e-jobs-probe';
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
            const wantStream = JSON.parse(buf || '{}').stream === true;
            if (!wantStream) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ text: PIECES.join(''), index: 0, finish_reason: 'stop' }] }));
                return;
            }
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
await req('POST', `${base}/${CHAT}/messages`, { messages: [{ name: 'You', is_user: true, send_date: Date.now(), mes: 'hello', extra: {} }] });

// 1. 发一次生成(textgen 路径,stub SSE 流式)
const gen = await req('POST', '/api/utopinn/generate', {
    charDir: CHAR, chatName: CHAT, api: 'text',
    api_type: 'generic', api_server: `http://127.0.0.1:${STUB_PORT}`,
    stream: true,
});
const jobId = gen.headers.get('x-luker-generation-id') ?? gen.body?.request_id;
log('generate 建 job', gen.status === 200 && !!jobId, `status=${gen.status} job=${String(jobId).slice(0, 8)}`);

// 等 job 跑到终态
let job = null;
for (let i = 0; i < 60; i++) {
    const r = await req('GET', `/api/utopinn/jobs/${jobId}`);
    if (r.status === 200 && ['awaiting_ack', 'persisted', 'completed', 'done'].includes(r.body?.status)) { job = r.body; break; }
    if (r.status === 200 && r.body?.status === 'error') { job = r.body; break; }
    await new Promise((r) => setTimeout(r, 500));
}
if (!job) { const r = await req('GET', `/api/utopinn/jobs/${jobId}`); job = r.body; }

// 2. GET /jobs 摘要列表:本 job 在列,摘要字段齐
const list = await req('GET', '/api/utopinn/jobs');
log('jobs 列表 200', list.status === 200 && Array.isArray(list.body?.items), `status=${list.status}`);
const mine = (list.body?.items ?? []).find((j) => j.id === jobId);
log('本 job 在列表', !!mine, mine ? `status=${mine.status}` : 'missing');
log('摘要字段', !!mine && typeof mine.eventCount === 'number' && typeof mine.created_at === 'number' && 'hasTrace' in mine,
    mine ? `events=${mine.eventCount} hasTrace=${mine.hasTrace}` : '');

// 3. GET /jobs/:id 详情:trace(token 分块)+sources(WI 轨迹)回放
log('详情 200', !!job && typeof job === 'object', `status=${job?.status}`);
const collections = job?.trace?.collections;
log('trace.collections token 分块', Array.isArray(collections) && collections.length > 0
    && collections.every((c) => typeof c.identifier === 'string' && typeof c.tokens === 'number'),
    Array.isArray(collections) ? `n=${collections.length} ids=${collections.slice(0, 4).map((c) => c.identifier).join(',')}` : JSON.stringify(job?.trace ?? {}).slice(0, 120));
log('trace 预算字段', typeof job?.trace?.tokenBudget === 'number' && typeof job?.trace?.remainingBudget === 'number',
    `budget=${job?.trace?.tokenBudget} remain=${job?.trace?.remainingBudget}`);
const src = job?.sources;
log('sources.preset/model/chatCount', !!src && typeof src.presetName === 'string' && typeof src.chatCount === 'number',
    src ? `preset=${src.presetName} model=${src.model} chats=${src.chatCount}` : '');
log('sources.worldInfo.activated 数组', Array.isArray(src?.worldInfo?.activated),
    Array.isArray(src?.worldInfo?.activated) ? `n=${src.worldInfo.activated.length}` : '');
log('文本回放', typeof job?.text === 'string' && job.text.includes('stars'), JSON.stringify((job?.text ?? '').slice(0, 60)));

// 3b. GH#8 trace 面(= CLI `utopinn trace --json` 消费的路由):
// sources.worldInfoActivated 必须等于 worldInfo.activated 明细长度 ——
// 全位置口径(AN/EM/outlet/atDepth 桶数≠条目数,见 generate-context.js:1093)。
const trace = await req('GET', `/api/utopinn/diag/jobs/${encodeURIComponent(jobId)}/trace`);
const tsrc = trace.body?.sources;
log('diag trace 200', trace.status === 200 && !!tsrc, `status=${trace.status}`);
log('trace worldInfoActivated === worldInfo.activated.length',
    typeof tsrc?.worldInfoActivated === 'number' && tsrc.worldInfoActivated === (tsrc.worldInfo?.activated ?? []).length,
    `activated=${tsrc?.worldInfoActivated} entries=${(tsrc?.worldInfo?.activated ?? []).length}`);

// 4. 越权面:不存在的 job 404
const missing = await req('GET', '/api/utopinn/jobs/no-such-job-id');
log('不存在 job → 404', missing.status === 404, `status=${missing.status}`);

await req('DELETE', `${base}/${CHAT}`);
stub.close();
log('清理', true);

console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
