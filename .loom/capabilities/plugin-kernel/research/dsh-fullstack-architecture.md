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
  (register + registerUpgrade),`apps/server` 的 /api/uberge/*
  逐面迁成插件,legacy Express 收 legacy-adapter。
- web 侧:B′ 步补 inject/effect/locale 三层;C 步 bundle 化时
  平台表按 seed.ts 清单(react/cordis/store/slots/…)冻结共享。
