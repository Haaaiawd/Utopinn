// repro-close.mjs — 最小复现 + CDP 事件全转录,定位页面 target 被谁销毁
process.env.E2E_SCRATCH_ROOT ||= '/tmp/utopinn-e2e-scratch';
process.env.E2E_READY_TIMEOUT_MS ||= '300000';
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']) delete process.env[k];

import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
const ROOT = resolve(import.meta.dirname, '..', '..');
const LIB = join(ROOT, 'apps/server/tests/e2e/_lib');
const imp = (m) => import(pathToFileURL(join(LIB, m)).href);
const { startServer, tearDownServer } = await imp('server.js');
const { startMockLLM } = await imp('mockLLM.js');
const { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } = await imp('fixtures.js');
const { awaitMainUI, selectCharacterByName } = await imp('page.js');
const { createRequire } = await import('node:module');
const { chromium } = createRequire(join(LIB, 'index.js'))('@playwright/test');

const card = process.argv[2] || 'apps/server/default/content/default_我没想当掌门啊.png';
const mock = await startMockLLM({ scriptedReplies: ['<X>'] });
const server = await startServer({ batchKey: 'chat', scenarioId: 'repro' });
const userDir = join(server.dataRoot, 'default-user', 'characters');
mkdirSync(userDir, { recursive: true });
copyFileSync(card, join(userDir, card.split('/').pop()));
markOnboarded({ dataRoot: server.dataRoot });
bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
for (const ev of ['Inspector.detached','Inspector.targetCrashed','Page.frameNavigated','Page.windowOpen']) {
    try { cdp.on(ev, p => console.error('[cdp]', ev, JSON.stringify(p).slice(0, 300))); } catch {}
}
try { await cdp.send('Inspector.enable'); } catch {}
page.on('close', () => console.error('!! PAGE CLOSE'));
page.on('crash', () => console.error('!! PAGE CRASH'));
page.on('dialog', d => { console.error('[dialog]', d.type(), d.message().slice(0,120)); d.dismiss().catch(()=>{}); });
page.on('download', d => console.error('[download]', d.suggestedFilename()));
browser.on('disconnected', () => console.error('!! BROWSER DISCONNECT'));

await awaitMainUI(page, server.baseURL);
console.error('>> UI up, selecting char...');
const { extractCard } = await import('./extract-card.mjs');
const name = extractCard(card).card.data?.name || '我没想当掌门啊';
await selectCharacterByName(page, name);
const chk = (tag) => console.error(`>> ${tag} isClosed=${page.isClosed()}`);
chk('after select');
await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 15_000 }).catch(e => console.error('>> .mes wait timeout:', String(e).slice(0,120)));
chk('after .mes wait');
// 模拟 sendMessageAndAwaitReply 的 evaluate —— 逐个试,找出杀页凶手
try {
    const r = await page.evaluate(() => typeof window.Luker + ' / ' + typeof window.Luker?.getContext);
    chk('eval1 ok: ' + r);
} catch (e) { console.error('>> eval1 threw:', String(e).slice(0, 200)); chk('eval1 after'); }
try {
    await page.locator('#send_textarea').fill('你好');
    chk('fill ok');
    await page.locator('#send_but').click({ timeout: 5000 }).catch(e => console.error('>> click err:', String(e).slice(0,120)));
    chk('after click');
} catch (e) { console.error('>> fill/click threw:', String(e).slice(0, 200)); chk('fill/click after'); }
console.error('>> waiting 30s...');
for (let i = 0; i < 60; i++) {
    if (page.isClosed()) { console.error('!! closed at tick', i); break; }
    await new Promise(r => setTimeout(r, 500));
}
console.error('>> final isClosed:', page.isClosed());
await browser.close().catch(()=>{});
await tearDownServer(server);
await mock.stop();
process.exit(0);
