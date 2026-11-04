/**
 * kernel-boot —— 服务端 Cordis 装配点(B 步)。
 *
 * createAppContext() 立根 context + ServiceCatalog;
 * webServer 服务立在这里,插件清单经 profile.yaml + loadProfileFile
 * 声明式装载(DSH cordis.yml 同形):每行状态(active/degraded/
 * disabled/failed)打到日志,degraded 不静默不连坐。
 *
 * 顶层 await:ESM TLA,server-startup import 本模块时自然等插件就绪
 * —— Express 挂载 dispatcher 之前路由表已就位,无启动竞态。
 *
 * 对外只出两样:
 *   webServer.middleware()   → server-startup.js 挂进 Express
 *                              (/api/uberge 面已 100% 插件化;未命中
 *                               next() 继续向后走)
 *   webServer.upgradeListener() → server-main.js 挂 httpServer 'upgrade'
 *                              (/api/ws-delivery 经 registerUpgrade 贡献)
 */
import { createAppContext, WebServer, loadProfileFile } from '@uberge/kernel';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const appCtx = createAppContext();

appCtx.provide('webServer', new WebServer());
// cordis provide 管注入语义,catalog 管归属可见性 —— 两个都要
appCtx.catalog.register({ role: 'core', name: 'webServer', providedBy: 'kernel-boot' });
export const webServer = appCtx.webServer;

const here = dirname(fileURLToPath(import.meta.url));
const loaded = await loadProfileFile(appCtx, join(here, 'profile.yaml'));
for (const row of loaded) {
    const line = `[kernel] plugin ${row.id}: ${row.status}${row.reason ? ` (${row.reason})` : ''}`;
    if (row.status === 'active') console.info(line);
    else console.warn(line);
}
const failed = loaded.filter((r) => r.status === 'failed');
if (failed.length) {
    console.warn(`[kernel] ${failed.length} plugin(s) failed to load — degraded surface, not fatal`);
}
