# web-slots-architecture — 客户端贡献式架构(TASK-010 深化)

> 状态:定稿方向。用户拍板 2026-11-04:"就这么做,仿 DSH 把路走彻底"。
> 参照:dsh `packages/client/ui-slots`(槽注册表)与 `ui-dockkit`
> (纯引擎+React 表面两层)。本稿定 A 步契约——应用内微内核,
> 不吞 Cordis-进-浏览器那档工程。

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

## 与 server cordis 的边界

- 内核语义对齐(effect→disposer、注册表、merge 声明),不共享运行时。
  Web 端是 React 宿主,Cordis 跑在 server;两者经 API/manifest 对接。
- B 步:apps/server 的 /api/uberge 端点逐迁移为 packages/kernel 插件;
  legacy express 收进 legacy-adapter,按面切不是一次翻桌。
- C 步:服务端插件 manifest 声明客户端贡献(panel.type/renderer/ns),
  壳启动时拉清单 hydrate 进 registry —— 本稿的契约就为那一刻设计:
  贡献体本身序列化无关,注册体是组件引用不是数据。

## 不抄的部分(记录否决)

- ui-dockkit 全量:split 树/浮窗/op 序列重放 —— v1 面板是单列 tabs,
  等真要多 split 再引;面板宿主已按 kinded-opaque 设计,届时可换芯。
- 74 包物理拆分:贡献点在内存里,不必包在物理里。
  单 feature 需要独立版本节奏再说,现在分包=散件管理成本净负。
- Cordis-in-browser:语义借鉴,运行时不引 —— 引了要把 ctx 生命周期、
  effect 图、服务定位全搬进 SPA,收益付不出成本。
