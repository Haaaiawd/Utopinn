# web-slots-architecture — 客户端贡献式架构(TASK-010 深化)

> 状态:定稿方向。用户拍板 2026-11-04:"就这么做,仿 DSH 把路走彻底";
> 同日 clarify 加码:**目标态 = DSH 全形态**(动态 bundle + 平台模块表
> + inject/effect/locale 全补),manifest hydrate 是过渡不是终点。
> 参照:dsh `packages/client/ui-slots`(槽注册表)、`ui-dockkit`
> (纯引擎+React 表面两层)、`client/web`(Loader+BootManifest 插件树)、
> `host/webserver`(路由即贡献的服务端同款)。
> vs-V2: current

## 为什么

`App.tsx` 已成接线板:view/NAV/PANEL_TYPES/ctbar/渲染器全硬编码,
加一个板块类型要改三个文件。DSH 证明的形态:**壳不认识 feature,
feature 通过类型化贡献点注册自己**。服务端插件将来也要贡献客户端
表面(C 步),契约从现在就得是贡献式。

## 核心机制(仿 ui-slots,裁剪版)

- `Contributions` 映射表:declare-merge 风格,贡献点 id → 贡献类型。
  新贡献点=各 feature 文件里 `declare module './registry'` 合并,
  不靠中心文件枚举(槽位类型安全照样有)。
- `Registry.add(point, contrib) → Disposer`:注册即拿拆卸器,
  cordis `ctx.effect` 语义——feature 模块卸载时一刀全拆。
- `<SlotOutlet name>`:React 槽口组件,按注册序渲染某点的全部贡献。
- store 位:feature 级私有 state 容器(`createSeat<T>(init)`),
  壳只持 registry,不持 feature 状态 —— App 不再 useState 开会。

## 贡献点清单(v1)

| 点 | 贡献 | 挂谁 |
|---|---|---|
| `nav.rail` | {id, icon, t-key, order} | chat/stories/rules/extensions |
| `view` | {id, Component} | 各域视图组件 |
| `sidebar.chat` | {Component} | chat 列表(暂只此一种 sidebar 内容) |
| `panel.type` | {type, icon, wired, Body} | session/diag/cardapp/analysis |
| `renderer` | {id, Component, order} | prose(默认)/未来的 bubble 等 |
| `ctbar.chat` | {Component} | 对话/预览 tabs、"+"、沉浸钮 |
| `settings.section` | {id, Component} | 设置页各节(账户菜单进的整页) |
| `i18n.ns` | {ns, dict} | 各 feature 自带词条,按 ns 合并进 t() |

## 目录形态

```
apps/web/src/
  kernel/      registry.ts(槽+disposer) slots.tsx(Outlet) seat.ts(store 位)
  shell/       rail/sidebar/main/panel-host 只渲槽口,无业务 import
  features/
    chat/      nav+view+sidebar+ctbar+panels(session,diag)+composer+i18n
    library/   nav+view(stories)
    rules/     nav+view
    extensions/ nav+view
    cardapp/   panel.type cardapp + CardAppFrame
    panels/    analysis stub
    renderers/ prose 注册为默认 renderer
  App.tsx      组装:建 registry → apply(features) → <Shell registry>
```

## 目标态(clarify 2026-11-04 拍板:DSH 全形态)

A 步落地的微内核是起点不是终点。DSH 的完整形态由五层构成,
我们的 adopt 路径按序铺开:

| 层 | DSH 实物 | 我们的状态 |
|---|---|---|
| 贡献点表 + disposer + 订阅 | ui-slots | ✅ A 步已落(kernel/registry.ts) |
| locale 命名空间按插件注册 | ctx.locale.register(ns, dict) | 🎯 B′ 步:i18n.ns 贡献点已在契约表,全局字典退役进 feature 词条 |
| inject 服务等待 + effect 作用域 | `export const inject` + ctx.effect 纤程 | 🎯 B′ 步:feature apply(ctx) 升级 inject 声明;registry 按 feature 收 effect 域 |
| 服务端路由/WS 即贡献 | host/webserver: register + registerUpgrade → disposer | 🎯 B 步:见下节 |
| 动态 bundle + 平台模块表 | Loader + BootManifest + seed.ts 单例表 | 🎯 C 步终态:插件打独立 bundle 运行时加载;manifest hydrate 是过渡 |

## 服务端同款(B 步,clarify 拍板)

- 形状照 `dsh-host-webserver`:内核暴露 `webServer` 服务,
  `register(route) → disposer`(HTTP)+ `registerUpgrade(route) →
  disposer`(WS)双注册位;插件 `inject(['webServer'], ctx => …)` 挂端点。
- **小面先行**:首批迁 chats/characters/worlds 只读列表趟熟形状,
  第二波 generate/preview + streamJob(WS 一起走,只收 HTTP 会把最大
  流量留在 Express 层)。
- legacy Luker Express 收编进 legacy-adapter 插件保留,按面切不翻桌。

## C 步终态:动态 bundle

- 插件 = 独立 bundle + manifest 行(Loader.create 一条一个),
  运行时装载;平台模块表(react/cordis/store/slots/…)做单例共享,
  bundle 经 externals 解析——**插件加 UI 不再要发版**。
- manifest hydrate(服务端插件声明 panel.type/renderer/ns,壳启动
  hydrate)是过渡路径:贡献体已序列化无关,契约不换。

## 不抄的部分(记录否决)

- ui-dockkit 全量:split 树/浮窗/op 序列重放 —— v1 面板是单列 tabs,
  等真要多 split 再引;面板宿主已按 kinded-opaque 设计,届时可换芯。
- 74 包物理拆分:贡献点在内存里,不必包在物理里。
  单 feature 需要独立版本节奏再说;bundle 化是装载边界,不强制 = 包边界。
- mount-as-service:壳仍持 React 入口,uiRenderer 服务化的收益
  (换渲染器整树重挂)在 RP 聊天域用不上。
