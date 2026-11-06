/**
 * 实弹测试(手动工具,非 CI):真 server + 真上游(aiping.cn 中转)
 * 验证整条链:/api/uberge/generate → 服务端组装 → dispatch → job →
 * WS 帧回放 → 楼层持久化 → jobs/:id trace/sources。
 *
 * 用法:
 *   set -a; source apps/server/.env.local; set +a
 *   node apps/server/tests/live-fire-aiping.mjs
 *
 * key 走 env(UBERGE_TEST_API_URL/KEY/MODEL),不入库。
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { startServer, tearDownServer } from './e2e/_lib/server.js';
import { markOnboarded } from './e2e/_lib/fixtures.js';

const { UBERGE_TEST_API_URL, UBERGE_TEST_API_KEY, UBERGE_TEST_MODEL } = process.env;
if (!UBERGE_TEST_API_URL || !UBERGE_TEST_API_KEY || !UBERGE_TEST_MODEL) {
    console.error('need UBERGE_TEST_API_URL / UBERGE_TEST_API_KEY / UBERGE_TEST_MODEL in env');
    process.exit(2);
}

const HANDLE = 'default-user';
const CHAT = 'live-fire';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// 真预设 + 真卡(用户提供):Meowssiah 预设 × 中字 RP 卡。
const PRESET_SRC = resolve(REPO, 'assets/Meowssiah_1.9.12.json');
const CARD_SRC = resolve(REPO, 'assets/诡异修仙人生模拟器.png');
const CHAR_DIR = '诡异修仙人生模拟器';
const PETBOOK_SRC = resolve(REPO, 'assets/宠物行为世界书.json');
const PETBOOK = '宠物行为世界书';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSession(baseURL) {
    const r = await fetch(`${baseURL}/csrf-token`);
    const { token } = await r.json();
    const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    return { token, cookie: cookies.map((c) => c.split(';')[0]).join('; ') };
}
const post = (baseURL, path, session, body) => fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.token, Cookie: session.cookie },
    body: JSON.stringify(body),
});
const get = (baseURL, path, session) => fetch(`${baseURL}${path}`, {
    headers: { Cookie: session.cookie },
});

const server = await startServer({
    batchKey: 'generation',
    scenarioId: 'aiping-live',
    extraEnv: {
        // 本机出站必须走壳层代理(清掉=EHOSTUNREACH);仅本地回环绕代理。
        NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    },
    // UDP 发现服务绑 config.port;同机有常驻 server(:8000)时 EADDRINUSE 会
    // 被 harness 误判为 HTTP bind 冲突。改绑高位端口避开。
    // requestProxy:本机出站必须走壳层代理(node-fetch 不吃 *_PROXY env,
    // 得走服务端自己的 request-proxy/proxy-agent 机制)。
    extraConfig: {
        port: 18999,
        'requestProxy.enabled': true,
        'requestProxy.url': process.env.HTTPS_PROXY || process.env.https_proxy || '',
    },
});

try {
    console.log(`server up: ${server.baseURL}  dataRoot=${server.dataRoot}`);
    markOnboarded({ dataRoot: server.dataRoot });

    // 连接层 = oai_settings(真实客户端同款:URL/key/model 存 settings,
    // 不进 request body——CONNECTION_KEYS 只在 oai_settings 通道透传)。
    const userRoot = resolve(server.dataRoot, HANDLE);
    const settingsPath = resolve(userRoot, 'settings.json');
    const sdoc = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    sdoc.oai_settings = {
        ...(sdoc.oai_settings ?? {}),
        chat_completion_source: 'openai',
        reverse_proxy: UBERGE_TEST_API_URL,
        proxy_password: UBERGE_TEST_API_KEY,
        model: UBERGE_TEST_MODEL,
        openai_model: UBERGE_TEST_MODEL,
    };
    // WI 四层一次 seed 齐:globalSelect(L1)+ charLore 辅书(L3);
    // L2 主书见下(嵌书物化),L4 聊天绑书写进 JSONL header。
    sdoc.world_info_settings = {
        ...(sdoc.world_info_settings ?? {}),
        world_info: {
            ...(sdoc.world_info_settings?.world_info ?? {}),
            globalSelect: [PETBOOK],
            charLore: [{ name: CHAR_DIR, extraBooks: [PETBOOK] }],
        },
    };
    writeFileSync(settingsPath, JSON.stringify(sdoc, null, 4));

    // 真预设/真卡落 scratch dataRoot(预设目录 = OpenAI Settings/)。
    mkdirSync(resolve(userRoot, 'OpenAI Settings'), { recursive: true });
    mkdirSync(resolve(userRoot, 'characters'), { recursive: true });
    const presetDst = resolve(userRoot, 'OpenAI Settings', 'Meowssiah.json');
    copyFileSync(PRESET_SRC, presetDst);
    // 预设携带的 openai_model 是官方型号名,中转没有——改写为测试模型。
    const presetDoc = JSON.parse(readFileSync(presetDst, 'utf8'));
    presetDoc.openai_model = UBERGE_TEST_MODEL;
    if ('model' in presetDoc) presetDoc.model = UBERGE_TEST_MODEL;
    writeFileSync(presetDst, JSON.stringify(presetDoc, null, 4));
    copyFileSync(CARD_SRC, resolve(userRoot, 'characters', `${CHAR_DIR}.png`));
    const charDir = CHAR_DIR;
    const presetName = 'Meowssiah';

    // —— WI 书目 ——
    // L1/L3/L4:宠物行为世界书(用户给的真书)
    const worldsDir = resolve(userRoot, 'worlds');
    mkdirSync(worldsDir, { recursive: true });
    copyFileSync(PETBOOK_SRC, resolve(worldsDir, `${PETBOOK}.json`));
    // L2:不物化——generate-context 应在 worlds/ 缺书时把卡内嵌
    // character_book 经 convertCharacterBook 内存即时转换顶上
    // (上游 importEmbeddedWorldInfo 语义)。激活明细里出现
    // 人生模拟器2.0 的多 uid 条目即为该路径生效的证据。
    const { read: readCard } = await import('../src/character-card-parser.js');
    const cardDoc = JSON.parse(readCard(readFileSync(CARD_SRC)));
    const embedded = cardDoc?.data?.character_book;
    const boundWorld = cardDoc?.data?.extensions?.world;
    console.log(`card embedded book: ${Object.keys(embedded?.entries ?? {}).length} entries, bound world=${boundWorld} (expect in-memory conversion)`);

    const chatsDir = resolve(server.dataRoot, HANDLE, 'chats', charDir);
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(resolve(chatsDir, `${CHAT}.jsonl`), [
        // L4:chat_metadata.world_info 绑宠物书
        { user_name: 'User', character_name: CHAR_DIR, create_date: Date.now(), chat_metadata: { world_info: PETBOOK } },
        // 发言埋卡书关键词:系统/修仙境界/修行体系 → WI 激活可观测。
        { name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: '系统,帮我看一下修仙境界和修行体系,顺便开始模拟吧。' },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');

    const session = await getSession(server.baseURL);
    const jobId = randomUUID();

    console.log(`→ POST /api/uberge/generate  model=${UBERGE_TEST_MODEL}`);
    const res = await post(server.baseURL, '/api/uberge/generate', session, {
        charDir, chatName: CHAT, presetName,
        stream: true,
        luker_generation: { job_id: jobId },
    });
    console.log(`  status=${res.status}  x-luker-generation-id=${res.headers.get('x-luker-generation-id')}`);
    if (res.status !== 200) {
        console.log('  body:', await res.text());
        process.exit(1);
    }

    // WS 实时挂上去看帧(先 subscribe 再等事件流过)
    const ticketRes = await post(server.baseURL, '/api/ws-ticket', session, {});
    const { ticket } = await ticketRes.json();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws-delivery`, `luker-ws-ticket.${ticket}`);
    const frames = [];
    ws.on('message', (raw) => {
        try {
            const f = JSON.parse(String(raw));
            if (f.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
            frames.push(f);
        } catch { /* ignore */ }
    });
    await new Promise((r) => ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', request_id: jobId }));
        r();
    }));

    // 轮询 job 到 persisted(真上游流式,放宽到 120s)
    let status = null;
    for (let i = 0; i < 240; i++) {
        const s = await post(server.baseURL, '/api/backends/chat-completions/jobs/status', session, { id: jobId });
        if (s.ok) {
            status = await s.json();
            if (status.persisted || status.status === 'failed' || status.status === 'cancelled') break;
        }
        await sleep(500);
    }
    console.log(`\njob: status=${status?.status} persisted=${status?.persisted} error=${status?.error ?? 'none'}`);
    console.log(`text: ${String(status?.text ?? '').slice(0, 300)}`);

    // 详情面:sources 是对象 — {presetName, model, worldInfoActivated,
    // worldInfo:{activated:[{uid,world,comment,key,position,depth,outlet}]}}
    const detail = await (await get(server.baseURL, `/api/uberge/jobs/${jobId}`, session)).json().catch(() => null);
    if (detail?.sources) {
        const src = detail.sources;
        const entries = Array.isArray(src.worldInfo?.activated) ? src.worldInfo.activated : [];
        console.log(`\nsources: preset=${src.presetName} model=${src.model} chat=${src.chatCount}`);
        console.log(`WI 激活=${src.worldInfoActivated}  激活条目明细=${entries.length}`);
        const byWorld = {};
        for (const e of entries) byWorld[e.world ?? '?'] = (byWorld[e.world ?? '?'] ?? 0) + 1;
        for (const [w, n] of Object.entries(byWorld)) console.log(`  ${w}: ${n} 条`);
        for (const e of entries.slice(0, 8)) console.log(`    - [${e.world}] ${String(e.comment ?? e.key ?? '').slice(0, 50)} pos=${e.position} depth=${e.depth ?? '-'}`);
    } else {
        console.log('\nsources: (job detail 无 sources 面)');
    }

    // WS 帧汇总
    await sleep(500);
    const kinds = {};
    for (const f of frames) kinds[f.type] = (kinds[f.type] ?? 0) + 1;
    console.log(`\nWS frames: ${JSON.stringify(kinds)} (${frames.length} total)`);
    const seqs = frames.filter((f) => f.seq != null).map((f) => f.seq);
    console.log(`seq range: ${Math.min(...seqs)}..${Math.max(...seqs)}  monotonic=${seqs.every((v, i) => i === 0 || v > seqs[i - 1])}`);
    ws.close();

    // 楼层持久化验证
    const chatFile = resolve(chatsDir, `${CHAT}.jsonl`);
    const floors = readFileSync(chatFile, 'utf8').trim().split('\n').length - 1;
    console.log(`\nchat floors: ${floors} (seed 1 + assistant ${floors - 1})`);

    console.log('\n=== LIVE-FIRE DONE ===');
} finally {
    await tearDownServer(server);
}
