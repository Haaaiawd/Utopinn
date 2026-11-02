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
const outDir = resolve(outIdx > -1 ? process.argv[outIdx + 1] : join(ROOT, 'tests/golden-diff/golden'));
const turnIdx = process.argv.indexOf('--turn');
const userTurn = turnIdx > -1 ? process.argv[turnIdx + 1] : '你好,我们开始吧。';
const slug = basename(cardPath).replace(/\.png$/, '').replace(/[^\w-]+/g, '_');

mkdirSync(outDir, { recursive: true });

const mock = await startMockLLM({ scriptedReplies: ['<GOLDEN_REPLY_TURN_1>'] });
const server = await startServer({ batchKey: 'chat', scenarioId: 'golden-' + slug });
const browser = await chromium.launch();

try {
    // fs 级导入:卡直接落 data/<user>/characters/,跳过 UI 上传更稳
    const userDir = join(server.dataRoot, 'default-user', 'characters');
    mkdirSync(userDir, { recursive: true });
    copyFileSync(cardPath, join(userDir, basename(cardPath)));

    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const page = await browser.newPage();
    await awaitMainUI(page, server.baseURL);

    // 卡名 = 文件名去扩展;导入后 selectCharacterByName 用显示名(读卡内 name 更稳)
    const { extractCard } = await import('./extract-card.mjs');
    const { card } = extractCard(cardPath);
    const charName = card.data?.name || slug;
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
    await browser.close().catch(() => {});
    await tearDownServer(server);
    await mock.stop();
}
