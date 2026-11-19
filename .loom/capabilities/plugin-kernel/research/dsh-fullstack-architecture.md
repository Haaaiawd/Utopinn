# DSH 全栈插件架构深扫(2026-11-04)

> 用途:plugin-kernel 能力 dossier 的服务端侧实证 + 客户端动态化终态参照。
> 来源:ref/deepseek-harness 源码直读。

## 客户端 = cordis 插件树(client/web)

`packages/client/web/src/boot.ts` AppWebEntry:

- `new Context()` → `ctx.plugin(Loader)` → BootManifest 每行一个
  `loader.create({name})` → **每个 ui-* 包是运行时动态 bundle**,
  boot 页逐条报加载态,单插件炸 ≠ 壳死(boot-client.ts assertEntriesActive)。
- `mount.ts`:连 React 挂载都是服务——`ctx.inject(['uiRenderer'],
  scope => scope.effect(() => scope.uiRenderer.mount(container)))`;
  壳不 import react,服务替换即重挂。
- `seed.ts` 平台模块表:react/react-dom/cordis/zod/client-store/
  ui-slots/ui-primitives/ui-dockkit 以单例喂给所有 bundle 的 externals。

## 插件解剖(ui-sidebar 实测)

```ts
export const inject = ['slots','layout','uiWorkspace','locale','shortcuts']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('sidebar', {zh, en, …}))   // 词条按命名空间注册
  ctx.slots.inject('sidebar', () => ctx.slots.register({…}))       // 条件注册:依赖到位才评
}
```

`declare module '@deepseek-ai/dsh-client-ui-slots'` 合并
LocaleNamespaceMap/槽表——类型安全且不动中心文件。

## 服务端同款(host/webserver + api/*)

- `packages/host/webserver`: `class WebServer extends Service`,
  `register(route) → disposer`(exact/prefix 两表,重名即 throw),
  `registerUpgrade(route) → disposer`(WS 升级位),node:http 直连。
- 事件面:`'webserver/index-inject'` —— 各插件往 index 注入表推
  {kind:'global',name,value}(remote-access 用此注 access 快照)。
- `packages/api/gateway` 等:`ctx.inject(['webServer'], webCtx =>
  { yield webCtx.webServer.registerUpgrade(route) })`——yield 在
  effect 生成器里即 disposer。

## 对我们的映射

- kernel 侧:`packages/kernel` 需给 `webServer` 服务同款注册位
  (register + registerUpgrade),`apps/server` 的 /api/utopinn/*
  逐面迁成插件,legacy Express 收 legacy-adapter。
- web 侧:B′ 步补 inject/effect/locale 三层;C 步 bundle 化时
  平台表按 seed.ts 清单(react/cordis/store/slots/…)冻结共享。

---

## B 步落地记录(首迁,已入库)

- `packages/kernel/webserver.ts`:`register(route)→disposer`(exact/pattern `:param`/prefix 三表)+ `registerUpgrade`;`middleware()` 挂 Express(插在 legacy 挂载前,未命中 `next()` 落回 —— 按面切不翻桌);`upgradeListener()` 挂 http `'upgrade'`,未命中不动 socket 与 ws-delivery 共存。
- `apps/server/src/kernel-boot.js`:createAppContext + `provide('webServer')` + `catalog.register` 归属登记 + 插件装配。
- 首迁插件 `plugins/utopinn-library.js`:10 个只读 GET(characters/chats/presets/worlds/personas/settings)全迁;DELETE/PATCH 留 legacy。
- 自证插件 `plugins/utopinn-diag.js`:`GET /api/utopinn/_kernel` 吐 routes+services —— seam 服务自己,多插件并行贡献成立。
- 第二面已迁:plugins/utopinn-generate.js(POST /generate+/preview)+ utopinn-mvu.js(4 条),legacy 端点文件删除;E2E 真机验证 17 路由齐、POST /preview 全组装 200。
- 现状:/api/utopinn/* 仅剩 DELETE chat + PATCH settings 走 legacy router(写路径第二波);CSRF 在 dispatcher 之前,插件面与 legacy 同栈同规。
- 三面全收(真机 E2E):写路径迁入 → /api/utopinn/* 100% 插件供给,utopinn-library.js 删除;WS 面 ws-delivery.js → plugins/utopinn-delivery.js 走 registerUpgrade(ctx.effect 挂 WSS+心跳,可逆拆);profile.yaml 声明式清单接 loadProfileFile,boot 日志 [kernel] plugin ×5 active。
- kernel-boot.js = 服务端 AppWebEntry.run() 对应物;plugins/ = api-* 包对应物;webServer.register/registerUpgrade + inject 等位 + catalog 归属 —— DSH 路由即贡献形状完整落地。
- 遗留面(下一波):/api/* 其余 legacy 域(characters/chats/worldinfo/settings 等老端点)按同法逐面迁;services 层(generate-context/mvu-settle/storage repos)提为 core/seam 服务后插件 inject 化;wsTickets 票据服务提 seam;客户端清单 hydrate(C 步,动态 bundle 目标态见 clarify round-1)。
