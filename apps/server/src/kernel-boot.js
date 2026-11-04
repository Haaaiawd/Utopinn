/**
 * kernel-boot —— 服务端 Cordis 装配点(B 步首迁)。
 *
 * createAppContext() 立根 context + ServiceCatalog;
 * webServer 服务立在这里:plugins 经 inject:['webServer'] 等位,
 * apply 里 register() 贡献路由,disposer 由插件生命周期收回。
 *
 * 对外只出两样:
 *   webServer.middleware()   → server-startup.js 挂进 Express
 *                              (放在 legacy 挂载前:命中即接管,
 *                               未命中 next() 落回 legacy —— 按面切)
 *   webServer.upgradeListener() → server-main.js 挂 httpServer 'upgrade'
 *                              (未命中不动 socket,ws-delivery 共存)
 */
import { createAppContext, WebServer } from '@uberge/kernel';
import * as ubergeLibrary from './plugins/uberge-library.js';

export const appCtx = createAppContext();

appCtx.provide('webServer', new WebServer());
export const webServer = appCtx.webServer;

appCtx.plugin(ubergeLibrary);
