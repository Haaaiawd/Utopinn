#!/usr/bin/env node
// capture-golden.mjs — 驱动原版 Luker 前端引擎,对语料卡产出 golden 捕获:
//   wireRequest(mockLLM 收到的完整请求体 = 前端组装产物)
//   chatSnapshot(ctx.chat,含 swipe/变量痕迹)
//   inspector(POST /api/debug/export 的 requestInspector,含 fullMessages+wireRequest)
// 用法: node capture-golden.mjs <card.png> [--out dir] [--turn "文本"] [--preset preset.json]
// 依赖 apps/server/tests/e2e/_lib 的成熟 harness(server/mockLLM/page)。
import { writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');
const LIB = join(ROOT, 'apps/server/tests/e2e/_lib');
const imp = (m) => import(pathToFileURL(join(LIB, m)).href);

// WSL /mnt/d 慢盘:scratch 挪到原生 fs,超时放宽——必须在 server.js 模块加载前设置
process.env.E2E_SCRATCH_ROOT ||= '/tmp/uberge-e2e-scratch';
process.env.E2E_READY_TIMEOUT_MS ||= '300000';
// 本机环境代理会把 127.0.0.1 请求转发到死代理(502)——本地链路全直连
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']) delete process.env[k];

const { startServer, tearDownServer } = await imp('server.js');
const { startMockLLM } = await imp('mockLLM.js');
const { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } = await imp('fixtures.js');
const { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } = await imp('page.js');
// playwright 装在 apps/server/tests/node_modules,从那里解析
const { createRequire } = await import('node:module');
const req = createRequire(join(LIB, 'index.js'));
const { chromium } = req('@playwright/test');

const cardPath = resolve(process.argv[2]);
const outIdx = process.argv.indexOf('--out');
// 私有语料的 golden 含卡面全文,默认落 golden-private/(gitignore);
// 公开语料(tests/corpus/)才进 golden/ 随仓库分发。
const isPrivate = /corpus-private|assets/.test(cardPath);
const outDir = resolve(outIdx > -1 ? process.argv[outIdx + 1]
    : join(ROOT, 'tests/golden-diff', isPrivate ? 'golden-private' : 'golden'));
const turnIdx = process.argv.indexOf('--turn');
const userTurn = turnIdx > -1 ? process.argv[turnIdx + 1] : '你好,我们开始吧。';
const slug = basename(cardPath).replace(/\.png$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_');

mkdirSync(outDir, { recursive: true });

const mock = await startMockLLM({ scriptedReplies: ['<GOLDEN_REPLY_TURN_1>'] });
const server = await startServer({ batchKey: 'chat', scenarioId: 'golden-' + slug });
// 浏览器策略:优先原生 chromium(WSL 系统库已用 dpkg -x 解到 /tmp/pw-libs,
// 调用方传 LD_LIBRARY_PATH 即可);不可用时退回 Windows Chrome CDP 兜底。
const WIN_CHROME = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.GOLDEN_CDP_PORT || 9225);
const CDP_HOST = process.env.WIN_HOST || '127.0.0.1';
const CDP_BASE = `http://${CDP_HOST}:${CDP_PORT}`;
let browser, chromeProc;
const execPath = process.env.CHROME_PATH;
let nativeOk = false;
if (execPath && existsSync(execPath)) {
    browser = await chromium.launch({ executablePath: execPath });
    nativeOk = true;
} else {
    try {
        // headless_shell 未下载,走完整版 chromium 的 headless 模式
        browser = await chromium.launch({ channel: 'chromium' });
        nativeOk = true;
    } catch (e) {
        console.error('native chromium launch failed, falling back to Windows CDP:', String(e).split('\n')[0]);
    }
}
if (!nativeOk && existsSync(WIN_CHROME)) {
    // 已有 CDP 实例就直接复用(上一轮残留的 headless chrome)
    let reused = false;
    try { reused = (await fetch(`${CDP_BASE}/json/version`)).ok; } catch { /* 没有 */ }
    if (!reused) {
    const { spawn } = await import('node:child_process');
    // cmd /c start 把 chrome 完全挂离 WSL 进程组,避免随父进程退出
    chromeProc = spawn('/mnt/c/Windows/System32/cmd.exe', [
        '/c', 'start', '/b', '', `"${WIN_CHROME.replace(/\//g, '\\')}"`,
        `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=0.0.0.0',
        '--remote-allow-origins=*', '--headless=new', '--no-first-run',
        '--disable-gpu', '--user-data-dir=C:\\Users\\11341\\AppData\\Local\\Temp\\uberge-pw',
    ].map(a => a.includes(' ') ? `"${a}"` : a), { stdio: 'ignore', detached: true });
    chromeProc.unref();
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
        try { const r = await fetch(`${CDP_BASE}/json/version`); ok = r.ok; } catch { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!ok) throw new Error('Windows Chrome CDP 未就绪');
    }
    browser = await chromium.connectOverCDP(CDP_BASE);
} else if (!nativeOk) {
    browser = await chromium.launch();
}

try {
    // fs 级导入:卡直接落 data/<user>/characters/,跳过 UI 上传更稳
    const userDir = join(server.dataRoot, 'default-user', 'characters');
    mkdirSync(userDir, { recursive: true });
    copyFileSync(cardPath, join(userDir, basename(cardPath)));

    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const ctx = browser.contexts?.()[0] || await browser.newContext();
    const page = await ctx.newPage();
    // 实测发现:挂着 CDP session 时页面不会被神秘销毁(repro 验证),
    // 不挂则在选卡后 ~几秒内 target 被关。先挂上保命,根因后续再追。
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Inspector.enable').catch(() => {});
    page.on('crash', () => console.error('!! PAGE CRASH'));
    page.on('close', () => console.error('!! PAGE CLOSE'));
    page.on('pageerror', e => console.error('!! PAGEERROR', String(e).slice(0, 300)));
    page.on('console', m => { const t = m.text(); if (t.length < 500) console.error('[con]', t.slice(0, 200)); });
    page.on('response', r => { if (r.status() >= 400) console.error('[http]', r.status(), r.url().slice(0, 120)); });
    page.on('requestfailed', r => console.error('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));
    ctx.on('page', p => console.error('[newpage]', p.url()));
    page.on('close', () => console.error('!! remaining pages:', ctx.pages().length));
    page.on('framenavigated', f => { if (f === page.mainFrame()) console.error('NAV ->', f.url().slice(0, 90)); });
    browser.on('disconnected', () => console.error('!! BROWSER DISCONNECT'));
    await awaitMainUI(page, server.baseURL);

    // 卡名 = 文件名去扩展;导入后 selectCharacterByName 用显示名(读卡内 name 更稳)
    const { extractCard } = await import('./extract-card.mjs');
    const { card } = extractCard(cardPath);
    const charName = card.data?.name || slug;
    // 物化内嵌世界书:卡绑定了 ex.world 且带 character_book 时,模拟
    // importEmbeddedWorldInfo 把书写进 worlds/<bound>.json —— 否则 WI
    // 扫描永远空转,golden 保真度不够。映射照抄 world-info.js:convertCharacterBook。
    const boundWorld = card.data?.extensions?.world;
    const embedded = card.data?.character_book;
    if (boundWorld && Array.isArray(embedded?.entries) && embedded.entries.length) {
        const worldsDir = join(server.dataRoot, 'default-user', 'worlds');
        mkdirSync(worldsDir, { recursive: true });
        const entries = {};
        embedded.entries.forEach((e, i) => {
            const x = e.extensions || {};
            entries[e.id ?? i] = {
                uid: e.uid ?? e.id ?? i,
                key: e.keys || [],
                keysecondary: e.secondary_keys || [],
                comment: e.comment || '',
                content: e.content ?? '',
                constant: e.constant || false,
                selective: e.selective || false,
                order: e.insertion_order ?? i,
                position: x.position ?? (e.position === 'before_char' ? 0 : 1),
                disable: !e.enabled,
                displayIndex: x.display_index ?? i,
                probability: x.probability ?? 100,
                useProbability: x.useProbability ?? true,
                depth: x.depth ?? 4,
                selectiveLogic: x.selectiveLogic ?? 0,
                outletName: x.outlet_name ?? '',
                group: x.group ?? '',
                groupOverride: x.group_override ?? false,
                groupWeight: x.group_weight ?? 100,
                scanDepth: x.scan_depth ?? null,
                caseSensitive: x.case_sensitive ?? null,
                matchWholeWords: x.match_whole_words ?? null,
                useGroupScoring: x.use_group_scoring ?? null,
                automationId: x.automation_id ?? '',
                role: x.role ?? 0,
                vectorized: x.vectorized ?? false,
                sticky: x.sticky ?? null,
                cooldown: x.cooldown ?? null,
                delay: x.delay ?? null,
                excludeRecursion: x.exclude_recursion ?? false,
                preventRecursion: x.prevent_recursion ?? false,
                delayUntilRecursion: x.delay_until_recursion ?? false,
                addMemo: !!e.comment,
                useRegex: e.use_regex ?? x.use_regex ?? false,
                triggers: x.triggers || [],
                ignoreBudget: x.ignore_budget ?? false,
                extensions: x,
            };
        });
        const worldFile = join(worldsDir, boundWorld + '.json');
        writeFileSync(worldFile, JSON.stringify({ entries, originalData: embedded }, null, 1));
        console.error('[wi] materialized embedded book ->', worldFile, '| entries:', embedded.entries.length);
    }
    // 先连通 API:#send_but 挂在 online_status 上,未连接时保持 displayNone。
    // 主动点 openai 连接钮(custom 源→mock 的 status 检查走服务器代理)。
    const conn = await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const btn = document.querySelector('#api_button_openai');
        btn?.click();
        return { hasBtn: !!btn, mainApi: ctx?.mainApi, source: ctx?.chatCompletionSettings?.chat_completion_source };
    });
    console.error('[connect]', JSON.stringify(conn));
    await page.waitForSelector('#send_but:not(.displayNone)', { state: 'visible', timeout: 30_000 })
        .then(() => console.error('[connect] send_but visible'))
        .catch(async () => {
            const st = await page.evaluate(() => ({
                online: window.Luker?.getContext?.()?.onlineStatus,
                sendClass: document.querySelector('#send_but')?.className,
            }));
            console.error('[connect] still no send_but:', JSON.stringify(st));
        });
    await selectCharacterByName(page, charName);
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 15_000 }).catch(() => {});

    await sendMessageAndAwaitReply(page, userTurn);
    const chatSnapshot = await getChatSnapshot(page);

    // inspector 导出(双保险:fullMessages 是组装产物,wireRequest 是上线体)
    let inspector = null;
    try {
        const t = await page.evaluate(async () => (await fetch('/csrf-token')).json());
        const r = await page.evaluate(async (tok) => {
            const r = await fetch('/api/debug/export', { method: 'POST', headers: { 'X-CSRF-Token': tok } });
            return r.ok ? r.json() : { status: r.status };
        }, t.token);
        inspector = r;
    } catch (e) { inspector = { error: String(e) }; }

    const wireRequests = mock.requests
        .filter(r => /chat\/completions/.test(r.url || ''))
        .map(r => r.body);

    const golden = {
        card: { file: basename(cardPath), name: charName },
        cardBook: card.data?.character_book ?? null,
        capturedAt: new Date().toISOString(),
        userTurn,
        wireRequests,
        chatSnapshot,
        inspector,
    };
    const out = join(outDir, slug + '.golden.json');
    writeFileSync(out, JSON.stringify(golden, null, 1));
    console.log('GOLDEN ->', out, '| wireRequests:', wireRequests.length, '| messages:', wireRequests[0]?.messages?.length ?? '?');
} finally {
    if (chromeProc) { await browser.close().catch(() => {}); chromeProc.kill('SIGTERM'); }
    else await browser.close().catch(() => {});
    await tearDownServer(server);
    await mock.stop();
}
