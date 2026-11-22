# 前端贡献点微内核(apps/web kernel,cordis 语义)

> 壳不枚举 feature;feature 向类型化贡献点注册自己。谁的贡献谁拆。

## Field identity and boundary

apps/web/src/kernel 的微内核语义:feature 装载模型({name,inject,apply})、
服务 provide/inject/waiters、effect 作用域拆除、registry 贡献点表、八槽
贡献契约、/ui/contrib 服务端水合对账。不含:服务端插件内核
(plugin-kernel 卷宗,@utopinn/kernel + cordis)、领域数据结构
(ShellCtx 字段语义归 web-ia/规范稿)、具体面板实现。

## Project scenario

web SPA 微内核已多轮实战:TASK-026 三级路由+卡画廊瀑布流+工作台面板体系在产线验证

## Decision tree

### C1: feature 装载模型

- entry_when: 新加一个前端域(视图/面板包/舞台形态包)
- options:
  - A: {name, inject?, apply(ctx)} 三元组,applyFeature→inject → leads_to: C2
  - B: 壳里 import + if/switch 枚举 → leads_to: 回到 ST 壳枚举病,贡献点白搭
- decide_by: 域是否需要依赖等待与可逆拆除——inject 声明的服务未齐时 feature 排入 waiters,某 provide 落地时 flush 重评(kernel.ts:61-82);壳永远不直接 import 域组件
- source: apps/web/src/kernel/kernel.ts:27-49(Feature 三元组 + applyFeature); research/codebase-evidence.md
- counterexample: 在 App.tsx/壳组件里 `import { DiagPanel }` 直挂 → 该域从此不可卸载不可水合,registry 订阅机制对它失效
- output: 域=feature 文件(features/*.tsx),apply 里只做 ctx.add/provide/effect/inject

### C2: 服务 vs 贡献点分层

- entry_when: 决定新能力走 provide 还是 ctx.add
- options:
  - A: 对象级依赖(api client/壳能力/共享句柄) → leads_to: ctx.provide(name, svc) + 消费方 inject/get
  - B: 表面注册(视图/面板类型/舞台形态/词条) → leads_to: ctx.add(point, contrib)
- decide_by: 消费方式是「拿到对象调用」还是「壳按槽渲染清单」——服务是对象级依赖,贡献点是表面注册(kernel.ts 头注:4);两者不混用:provide 的 svc 不参与 registry 排序/水合,add 的贡献不经 inject 门
- source: apps/web/src/kernel/kernel.ts:1-7 头注;contributions.ts:1-4; research/codebase-evidence.md
- counterexample: 把面板 Body 组件 provide 成服务 → 服务槽无 order/wired/category 元数据,launcher 网格与水合对账全部够不着
- output: 服务清单小(named string→object);贡献点八槽见 C5

### C3: inject 依赖等待(waiters 语义)

- entry_when: feature 需要某服务才能 apply
- options:
  - A: inject:['svc'] 声明,齐了才 fire → leads_to: 乱序装载安全
  - B: apply 里直接 ctx.get('svc') 判空 → leads_to: 时序竞态,缺服务时静默半装
- decide_by: 缺依赖该等还是该崩——waiters 排队(kernel.ts:35-40,61-70),provide 时 flush;等待中 dispose 会标 disposed 且拒 fire(kernel.ts:65-69,84-87)
- source: apps/web/src/kernel/kernel.ts:61-87; research/codebase-evidence.md
- counterexample: apply 里裸 get + if(!svc) return → provide 晚到时该 feature 永远缺装,没有任何机制通知它重评;waiter 才是等位机制
- output: 依赖一律走 inject 声明;get 只用于「可选服务,缺席也成立」的场景

### C4: 作用域拆除(谁的贡献谁拆)

- entry_when: 写 apply 或做任何动态重注册
- options:
  - A: 一切注册经作用域 ctx(add/effect/inject/provide 全部 collect 进 cleanups),卸载一刀全拆 → leads_to: C5
  - B: 跨作用域替别的 feature 拆贡献 → leads_to: 违 fiber 语义
- decide_by: disposer 的持有方——apply 拿到的 ctx 把本 feature 全部注册收进一个作用域(scope() 的 collect,kernel.ts:89-104);嵌套 inject 的清理同样计入。**拆别人注册的贡献没有合法入口**:你只能动自己作用域里 collect 过的 disposer
- source: apps/web/src/kernel/kernel.ts:89-104;features/contrib.tsx:1-7 头注(「不建第二真值通道……在注册的持有方作用域里 dispose + 重注册」); research/codebase-evidence.md
- counterexample: 水合层拿 registry.add 的返回值去拆 panelsFeature 的条目 → 跨 feature 拆别人贡献 = 违 fiber 语义;正确做法=注册方把自己的 disposer 句柄传进来,水合在 owning scope 内 dispose+重注册(contrib.tsx RegisteredPanel 持柄模式)
- output: 任何「对账/替换」都由 owning feature 在自己作用域内执行;外部只递数据与句柄

### C5: 贡献点八槽与新槽扩容

- entry_when: 新表面类型出现
- options:
  - A: 命中现有八槽(nav.rail/view/sidebar.tree/stage.form/panel.type/renderer/ctbar.chat/locale) → leads_to: 直接 ctx.add
  - B: 新槽 → leads_to: declare module 合并扩 Contributions,不改 contributions.ts 枚举本体
- decide_by: 槽是类型安全映射表不是开放数组——v1 八槽集中声明;将来服务端插件 manifest hydrate 时新点在各 feature 文件里 declare-merge 进来(contributions.ts:1-4);服务端 KNOWN_SLOTS(utopinn-plugins.js:48-52)与八槽 1:1
- source: apps/web/src/kernel/contributions.ts:83-92;apps/server/src/plugins/utopinn-plugins.js:48-52;domain-map §6.2; research/codebase-evidence.md
- counterexample: 往 contributions.ts 加第九槽「备用」→ 空槽没有消费者,与服务端 KNOWN_SLOTS 对账即漂移;槽只在有真实消费方时加
- output: 槽改动=前端 Contributions + 服务端 KNOWN_SLOTS 双处同步

### C6: panel.type 元数据诚信语义

- entry_when: 注册面板类型
- options:
  - A: wired 诚实标 + Body 无 props + 文案走 i18n 键 → leads_to: launcher 网格可信
  - B: wired 恒 true 先上架 → leads_to: 「接线中」诚实语义死掉
- decide_by: 面板体是否真接了数据后端——wired:false 在选择器里诚实标「接线中」、body 给 StubBody(contributions.ts:26-42);Body 无 props,数据一律 useShell()(context.tsx:1-5:接线归注册表,数据归上下文);title/desc/badge 是 i18n 键,t() 回落键名
- source: apps/web/src/kernel/contributions.ts:26-42、75-81;features/panels.tsx:24-34; research/codebase-evidence.md
- counterexample: 给 Body 传 props 定制 → props 一出现,注册表「同类型至多一页」的实例语义碎掉,壳变成逐件对接(App 旧病);定制载荷走 panelParams[type](壳透传不透解,context.tsx:104-107)
- output: 面板贡献={type,icon,wired,Body,title?,desc?,badge?,category?};category 三桶 system/cardapp/suggested

### C7: 服务端水合对账(/ui/contrib → 本地注册表)

- entry_when: panelsFeature apply 尾部 hydratePanelTypes
- options:
  - A: 在注册持有方作用域内 dispose+重注册(注册表=唯一事实源) → leads_to: 水合结果随 feature 卸载
  - B: 建 override store/第二真值通道 → leads_to: 两套真值,卸载不清
- decide_by: 对账五条规则(contrib.tsx:8-25):服务端 live wired:true → 本地整段 dispose 后按原序重注册(保网格序),「待服务端面」badge 摘掉换服务端徽标;desc/badge/category/title 只补本地缺省不覆写(本地文案是前端资产);服务端声明了本地没有 → 占位条目(wired:false+unwired badge+StubBody,就算服务端标 wired:true——占位体本身没接线照实标);服务端没声明的本地类型 → 原样保留;disabled:true 不算 live 但算「声明过」(照样给占位)
- source: apps/web/src/features/contrib.tsx:63-143;design/cordis-next.md(manifest 面); research/codebase-evidence.md
- counterexample: 拉 /ui/contrib 失败后 retry/降级标灰 → 失败就该静默:fetch 失败/超时/非 2xx → null,静态旗标本就是离线真值,console.warn 一次不刷屏(contrib.tsx:27-28);另一个坑:本地已 wired 的提供方被运行时停用,本层不做降级对账——启停是运行时事件,归插件管理面+面板自身空态
- output: 水合只收编 panel.type(其余槽的贡献要真组件,线形 JSON 给不了 Body);icon 不在本地词表兜 'puzzle',category 兜 'suggested'(三方贡献逃生位)

### C8: 已 apply 依赖方不随 unprovide 回滚

- entry_when: 服务被替换/卸载(provide 的 disposer 跑掉)
- options:
  - A: 接受 cordis fiber 语义:依赖方不自动回滚,自行用 effect 处理服务替换 → leads_to: 与服务端内核同语义
  - B: 内核做反向通知/自动重 apply → leads_to: 自造语义,形走神离
- decide_by: cordis 的 fiber 语义(kernel.ts:5-7 头注)——已 apply 的依赖方不随后续 unprovide 回滚;要响应服务替换,feature 在 apply 里用 effect 挂清理/重绑
- source: apps/web/src/kernel/kernel.ts:5-7; research/codebase-evidence.md
- counterexample: 假设 unprovide 会「级联卸载依赖方」写代码 → 服务换掉后旧句柄还被已 apply 的 feature 攥着,没有报错没有重评;要么重新 provide 同名贵粗替换,要么靠 effect 自理
- output: 服务替换是消费方责任;内核只保证 inject 等待与作用域拆除

## Stance and rejected defaults

微内核的全部价值在「壳不枚举」:注册表是运行时唯一事实源,React 侧经
useSyncExternalStore 订阅(registry.ts:32-39),feature 卸载一刀全拆。
拒绝:override store/第二真值通道;跨作用域拆贡献;Body 带 props;
wired 不诚实;为「将来可能」预加空槽。

## Failure signals

- 壳文件出现领域 import/if-switch → 枚举病复发。
- registry.add 的 disposer 被丢弃 → 卸载泄漏,水合/重注册叠双份。
- 水合层直接保有自己的「覆盖表」→ 第二真值,卸载后残留。
- 面板 Body 收 props → 「同类型至多一页」语义碎,壳回到逐件对接。
- apply 里裸 get 判空当依赖门 → 缺服务时装一半,无重评机制。

## Relationships without merger

- plugin-kernel(服务端):同一套 cordis 语义两端各自实现——服务端是
  cordis@rc12 真库 + fiber,前端是 kernel.ts 微内核;共享的概念是
  inject 等待/effect 作用域/「谁的贡献谁拆」,不共享代码。
- sandboxed-card-apps:cardapp 桶面板(cardapp/ledger 类型)是本内核
  panel.type 的一档 category,沙箱细节归该卷。
- conversation-renderers:renderer 槽在本八槽中但当前零注册零消费;
  web 的「渲染形态」落地机制实际是 stage.form(chat/novel/messenger/
  galgame),见该卷一行注。
