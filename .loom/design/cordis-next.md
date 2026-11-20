# 新 cordis:插件单一声明源(5 表收 1)

- Kind: design / system
- Status: draft
- 基线:域图 §5.1 两组合并已落地(2026-11-20)——`utopinn-import`→`utopinn-data`、
  `utopinn-stats`→`utopinn-diag`,**11 插件**;`_shared/http-utils.js` 已立
  (§5.4.1);`CORE_PLUGINS` 补 `utopinn-plugins` 并 export,API 侧 act 闸
  已接,kernel pluginManager 待接。本设计按合并后事实写。
- 缘起:插件声明碎在五处——路由手写注册、CLI 具名表手抄、GATED_ROUTES 手抄、
  ui.contrib BUILTIN 声明、profile.yaml 启停序——已漂移两轮(TASK-036 发现
  18 条 state 路由 raw-only;TASK-038 审计补中;GATED utopinn 块后补;
  CORE_PLUGINS 漏列 utopinn-plugins 至 11-20 才修)。
- 上游语义:cordis 4.0.0-rc.12(Registry `Plugin.Base` = name/Config/inject/
  provide/intercept,fiber 生命周期)+ DSH manifest/contribution 模式
  (`.loom/capabilities/plugin-kernel/research/dsh-fullstack-architecture.md`)。
- 判据对接:`design/plugin-domain-map.md` §3(管理面独立装载可停用、
  管线引擎不进 fiber)落为内核可检契约。

> vs-V2: current

## 0. 现状:五张表,五个真相源

| # | 表 | 位置 | 内容 | 漂移面 |
|---|---|---|---|---|
| T1 | 路由注册 | `plugins/utopinn-*.js` `apply()` 内 `ctx.webServer.register/registerUpgrade` | 实际路由面(82 HTTP + 1 upgrade + 1 UDP socket) | 真相源 #0——其他四张都该由它生,但今天是各抄各的 |
| T2 | CLI 具名表 | `apps/cli/utopinn-cli.mjs:1052` `NAMED_UTOPINN_ROUTES` + `SCHEMA.commands`(:1202)+ dispatch switch(:3100) | `METHOD\|kind\|path` 串集合 + 动词目录 + 分发臂 | 新路由不加→doctor coverage 报 raw-only(TASK-036 实证 18 条);路径改名→具名率掉 |
| T3 | 同步闸表 | `src/sync/in-progress-gate.js:70` `GATED_ROUTES`,utopinn 块 :112-130(19 行) | 写路由 regex → `{categories,dirty,wholesale}` | utopinn 块曾整体缺席——新路由未入闸时 sync writer 可撕半飞写;现仍无机制保证新增写路由入闸 |
| T4 | UI 贡献表 | `plugins/utopinn-plugins.js:48` `KNOWN_SLOTS` + `:59` `CORE_PLUGINS` + `:69` `BUILTIN_CONTRIB`;模块侧 `export const ui` 已存在(diag :65)但只 1/11 用 | panel.type 等八槽贡献 + core 标记 + API 层 core 闸 | BUILTIN 与 diag 自声明重复(去重靠 `seen` key);CORE_PLUGINS 曾漏 `utopinn-plugins`(域图 §2.8,11-20 手修);wired 面板 ledger/cardapp/notes/preset 无归属(§6.2) |
| T5 | profile.yaml | `src/profile.yaml` + `profile.patch.yaml` | 装载序/启停/config(DSH cordis.yml 同形) | 这张是**组合层**不是声明重复——但它不知道插件内部有什么,id/module 全靠人维护一致 |

**刚发生的第二轮漂移实况(域图合并工单,11-20 当日)**:stats→diag、
import→data 两组路由零移动合并,T2/T3 因路径未动幸存——但 T4/T5 仍要
人肉跟:BUILTIN_CONTRIB 的 stats 键搬进 diag、CORE_PLUGINS 补列、
profile 删两行、`utopinn plugins` 输出少两个 id。一次「不碰任何路由」的
纯归属移动仍然摸了三张表。**这就是五表结构的成本:连最守纪律的变更
也要同步 N 处,而不同步不报编译错,只静默漂移。**

漂移的本质:五处表达同一件事的不同切面(这条路由存在/具名/写同步数据/
供了哪块板/属哪个插件),没有任何一处是权威。改一条路由最多要动四个文件,
动少了不报错只是静默漏——T2/T3 的漂移都是「表忘了更」而非「代码改错」。

## 1. 设计总形:一次声明,内核捕获,五处生成

**单一声明源 = 插件模块文件本身。** 两层共居一个文件,不再分表:

- **插件级事实**:`export const manifest`(域名/core/auth 缺省/cli 动词表/
  ui.contrib/副作用登记)——模块顶层静态导出,`importRowModule` 式 mtime
  缓存读取,**不跑 apply 也能读到声明**。
- **路由级事实**:`webServer.register()` 的 route 对象扩字段(name/auth/
  gate/cli/schema)——**元数据与注册点同址书写**,path/handler/meta 挨着,
  不存在「注册在 A 文件、声明在 B 文件」的跨文件漂移。
- **捕获**:loader 在 `applyRow`/`loadProfile` 期间把 register 调用打回
  该插件名下(归属戳),收进内核 **RouteRegistry**;disposer 触发即回收
  ——disable/reload 自动缩表,注册即声明、摘除即撤声明,**构造上不可能
  「注册未声明」**。

cordis 语义对齐:`manifest` 是 `Plugin.Base`(name/inject/provide/intercept/
Config)的 Utopinn 扩展位,不破上游形状——npm cordis 没有 manifest 概念
(borrow-map:profile/loader 本就自写),DSH 用 package.json+contributes
表达同一物,我们用模块导出表达(bundle 化第三方插件时 profile 行内联
`manifest:` 或 `package.json` 同级兜底,见 §6.3)。

## 2. 声明模型 schema 草案

### 2.1 插件级:`export const manifest`

```ts
// utopinn-<id>.js 顶层导出(与 inject/apply 平级;向后兼容 ui.contrib/meta 两形)
export const manifest = {
  // —— 域与生命周期(域地图词表;判据落地见 §5)——
  domain: {
    type: 'resource' | 'capability' | 'protocol' | 'kernel' | 'observability',
    id: 'regex-scripts',                  // 有界上下文名;同 id 两插件 = 该合的信号
    face: 'management' | 'protocol' | 'control' | 'compat',
      // 面细分:management=资源管理面 / protocol=线协议面 / control=引擎控制面 / compat=生态兼容面
  },
  core: false,                           // true = 不可停用(替 CORE_PLUGINS;API 闸+pluginManager 闸两级)

  // —— 权限缺省 ——
  auth: 'user',                          // 'user'(登录即可,缺省)| 'admin' | 'custom'(handler 自判)

  // —— CLI 动词表(D-021 协议参考客户端契约;routes 引路由 name)——
  cli: {
    verbs: [
      { verb: 'mvu settle', routes: ['mvu.settle'], desc: '手动重结算目标楼层', out: '{ok}' },
      { verb: 'state chat get', routes: ['state.chat.get'], desc: '…', out: '…' },
    ],
  },

  // —— UI 贡献(沿用现 ui.contrib 形状,替 BUILTIN_CONTRIB)——
  ui: { contrib: [ { slot: 'panel.type', contribution: { type:'mvu', icon:'database', … } } ] },

  // —— 非 HTTP 副作用登记(纯信息位,doctor/审计可查「这插件除了路由还占什么」)——
  effects: [
    { kind: 'wss', desc: 'WS server + 心跳 timer(delivery)' },
    { kind: 'udp', desc: 'LAN 发现 responder :port' },
    { kind: 'import', desc: '顶层 import 副作用(如 registerBuiltinCommands 幂等表)' },
  ],

  // —— 服务面(预留;今天全空,域图 §0 实证零 provide/inject)——
  provides: [],   // 将来 seam provider 登记(promptBuilder/settle/…)
  consumes: [],   // 将来 inject 语义补注(当前 inject 已够)

  // —— 引擎依赖信息位(§5.2 R6)——
  engineDeps: [], // services/ 层模块名,如 ['stscript-env','mvu-settle']

  // —— 插件 config schema 继续在模块顶层 export Config(StandardSchemaV1),不进 manifest ——
};
```

### 2.2 路由级:`register()` 扩字段

```ts
ctx.effect(() => ctx.webServer.register({
  kind: 'pattern',                       // exact|pattern|prefix(现状不变)
  method: 'POST',
  path: '/api/utopinn/state/chat/patch',
  name: 'state.chat.patch',              // 稳定逻辑名——gate/cli/manifest/审计的引用键
                                         // GET+POST 双形同 endpoint 共享一个 name
  auth: 'user',                          // 覆写插件级缺省;'custom'=handler 自判(lan/offer 同 handle 特例)
  gate: { categories: ['chats'] },       // 同步闸:写路由必声明;
                                         //   {dirty:false}=读了才懒写的读路由
                                         //   {wholesale:true}=重写整 root(restore/import)
                                         //   gate:false=显式不闸(plugins/diag-client/abort 等非数据写)
  cli: 'state chat patch',               // 速写:该路由由 verb X 覆盖;
                                         //   cli:false=显式声明 raw-only(如 --via get 变体、逃生舱直达面)
  schema: { body: 'StatePatchRequest', response: 'OkApplied' },
                                         // protocol 类型名引用(可选,v1 纯元数据不强制校验)
  handler,                               // 函数体照旧——handler 永远手写
}));
```

**词表归属**:`gate.categories` 的 id 词表归 `sync/categories.js`
(SYNC_CATEGORIES 不动,它是同步域自己的真相);`slot` 词表归
`packages/protocol`(KNOWN_SLOTS 上移——贡献槽是线协议词表,三端共享,
前端 contributions.ts 已 declare-merge 可扩);`domain.type`/`face` 词表归
kernel(`packages/kernel/src/plugin.ts` 导出常量,域图 §1 五域 +
management/protocol/control/compat 四面)。

### 2.3 命名规则

- `name` 按 `<域>.<资源>.<动作>` 三段:`library.characters.list`、
  `state.chat.patch`、`mvu.settle`、`diag.kernel`。同名 GET+POST 双形共享
  (name 指逻辑 endpoint,method 区分线形)。
- name 唯一性校验:同 name 多注册只允许 method 或 kind 不同;
  冲突→register throw(同现有 duplicate 规则同管道)。
- name 不是 path 的重复:path 是线契约,name 是内部引用键——CLI verb、
  gate 规则、doctor 输出、未来 permission patch 全部按 name 引用,
  path 改型不炸引用方(域图 §7「路由零移动」迁移纪律的机械基础)。

## 3. 捕获机制:RouteRegistry

### 3.1 归属戳

`webServer.register` 保持现有签名+新字段;**归属不靠插件自己报**——
`packages/kernel` 的 loader(`loadProfile`/`importPluginModule` 调用点)
在 apply 一个插件期间把「当前插件 id」绑到该 fiber 的 register 通道上
(实现形:给 fiber 的 ctx 挂 `webServer` 薄代理,或 AsyncLocalStorage
装配位——插件装载本就串行,enable/disable/reload 同管道)。

每条注册进 Registry 一条:

```ts
interface RouteEntry {
  plugin: string;             // 归属戳——「这路由谁供的」从此机器可查
  name?: string;              // 未命名路由仍入表,doctor 标 undocumented
  kind: 'exact'|'pattern'|'prefix'|'upgrade';
  method?: string;
  path: string;
  auth: 'user'|'admin'|'custom';
  gate: false | { categories: string[]; dirty: boolean; wholesale: boolean } | undefined;
  cli: string | false | undefined;
  schema?: { body?: string; query?: string; response?: string };
  registeredAt: number;       // 诊断序
}
```

`register` 返回的 disposer 同时注销 Registry 条目——**fiber 生命周期
即路由声明的生命周期**,disable→缩表,reload→换表,零额外代码。
delivery 的 `registerUpgrade` 同管道收录(`kind:'upgrade'`,gate 恒 false)。

### 3.2 auth 由内核执行,不由 handler 内联

`auth` 声明进注册面后,`webServer.middleware()` 命中路由时先过权限
(`admin` → `request.user?.profile?.admin` 检查,403 短路),handler 里的
`adminOnly` 内联检查逐个退役。`custom` 显式声明「我自判」(lan/offer 的
handle-or-admin、state 的 account=handle 私有化读),doctor 不误报。
**收益:权限面变成 manifest 可审计数据**,而不是散在 82 个 handler 里的
`if (!request.user?.profile?.admin)` 副本。

### 3.3 dry-run 边界(诚实说不做什么)

捕获**不采用**「离线 dry-run apply 提取路由表」:effect 体里有真副作用
(delivery 建 WSS、data 绑 UDP 端口、th 灌 builtin commands),stub ctx
无法区分「register 调用」和「副作用代码」。静态表生成走另一条路——
**活内核吐快照**(`GET /api/utopinn/manifest`,见 §4.2),离线产物由
scratch server 实跑导出(`LUKER_PREBUILT_BUNDLES_DIR` 秒起配方已有,
运维备忘在案)。

## 4. 生成物清单(声明 → 产物 × 时机)

### 4.1 总表

| 生成物 | 来源字段 | 生成时机 | 消费方 | 今天的手写前身 |
|---|---|---|---|---|
| 路由分发表 | `{kind,method,path,handler}` | **apply 时**(不变,register 即入表) | `webServer.middleware()` | T1(本就是源) |
| `_kernel` 路由+服务清单 | Registry 全量 | **请求时**(现算) | diag `GET /_kernel`、doctor coverage | `webServer.list()` 保留输出形 |
| **GATED 内核面** | `gate{categories,dirty,wholesale}` + path→regex | **增量**:register/dispose 触发重编译(版本戳缓存),非启动一次性——enable/disable/reload 自动跟随 | `syncWriteGateMiddleware` 的内核分支 | T3 的 `/api/utopinn/*` 手抄块(:112-130)整体退役 |
| **CLI 具名集** | `cli` 字段 + 路由 key | **请求时**拉 manifest;**构建旁路**:scratch dump 落 `generated/` 快照 | `NAMED_UTOPINN_ROUTES` 替身、doctor coverage、`utopinn schema` | T2 整张手抄表退役 |
| **CLI 动词目录** | `manifest.cli.verbs` | 同上 | `schema.commands` 合并源、动词-路由绑定断言 | T2 SCHEMA.commands 的路由绑定面 |
| **ui/contrib 清单** | `manifest.ui.contrib` + `core` | **请求时**(现算,已如此) | `GET /ui/contrib` → web panels/mobile 面板页 | T4 BUILTIN_CONTRIB+CORE_PLUGINS 双表退役 |
| **core 闸** | `manifest.core` | **disable() 时** pluginManager 强制 | `POST /plugins/:id/disable` 拒绝面 | CORE_PLUGINS 常量(现为 act 闸半接管,pluginManager 仍裸奔) |
| **doctor manifest 报告** | Registry + manifest 合流 | **请求时** | `GET /api/utopinn/manifest`、doctor 新 step | 无(新产物,见 §4.3) |
| profile 校验 | manifest.domain/id vs profile 行 | **装载时**(warn 不 fail) | boot 日志、`/plugins` | 无(新产物) |

### 4.2 新端面:`GET /api/utopinn/manifest`

内核声明注册表的对外读面(diag 或 plugins 插件供,admin 闸——鉴权级别
见 §9 开放问题):

```jsonc
{
  "plugins": [{
    "id": "utopinn-mvu",
    "status": "active",            // active|degraded|disabled|failed
    "domain": { "type": "capability", "id": "mvu", "face": "control" },
    "core": false,
    "routes": [ { "name": "mvu.settle", "method": "POST",
                  "path": "/api/utopinn/mvu/settle", "kind": "pattern",
                  "auth": "user", "gate": {"categories": ["chats"]},
                  "cli": "mvu settle" } ],
    "cli":   { "verbs": [ … ] },
    "contrib": [ { "slot": "panel.type", "contribution": {…} } ],
    "effects": [ { "kind": "import", "desc": "…" } ],
  }],
  "slots": [...],                  // KNOWN_SLOTS 词表(protocol 家)
  "syncCategories": [...],         // gate.categories 词表(sync/categories 家)
  "drift": {                        // §4.3 对账输出
    "undocumented": [],            // 注册无 name(过渡态允许,硬化期清零)
    "ungatedWrites": [],           // 写方法无 gate 字段且未显式 gate:false
    "cliGaps": [],                 // 注册但 cli 未声明也未 cli:false
    "slotUnknown": [],             // contrib slot 不在词表(warn 不 fail,前兼容)
  }
}
```

**关键性质**:disabled/degraded 插件照样出声明(manifest 走模块顶层
读取不跑 apply——`importRowModule` mtime 缓存机制现成),`routes` 标
`disabled` 态。客户端拿它做「这块板 unwired」的诚实态——这正是
contributions.ts `wired:false` 语义的服务端对等物。

### 4.3 doctor 报告新构

doctor 的 capability coverage 升级成**三面账**(替代今天的「具名率」,
数字为示意):

```
routes 82 · declared 82 · named 70 · raw-only 12(declared) · undocumented 0
gate: writes 41 · gated 41 · explicit-free 5(plugins/diag-client/abort 等)
drift: 0
```

- `named` = 有 cli 声明;`raw-only(declared)` = 显式 `cli:false`(诚实
  声明,不再算缺);`undocumented` = 无 name 裸注册(硬化期清零)。
- `ungatedWrites` 非空 = 真红线——写路由漏闸在今天只能靠人肉对表。
- `slotUnknown` warn 级:slot 词表可扩,未知槽透传照旧(现语义无损)。

## 5. 内核契约:判据怎么落地(域地图 §3 的机器化)

### 5.1 「管理面独立装载可停用」→ 三条可检规则

| 规则 | 声明位 | 检查点 |
|---|---|---|
| R1 `core:false ⇒ 整面可拆` | `manifest.core` | 天生成立(fiber 摘路由),doctor 补报 `disableImpact`(该插件名下将消失的路由/contrib 数)——`/plugins` API 与 CLI `plugins` 输出带此列,管理面「关它会怎样」从域图人肉列变机器报 |
| R2 `core:false ⇒ 不得被兄弟插件模块级 import` | 静态检查 | **域图 §2.7 的洞已堵一半(11-20)**:六插件改 import `_shared/http-utils.js`,`./utopinn-library` 引用清零;library 留私有副本(跨格依赖回避)。剩的是**机制化**:`import … from './utopinn-<noncore>'` 判违例,plugins/ 目录内 import 只允许 `_shared/`、services/、core 插件——lint/测试断言,否则 disable 一面、兄弟面模块层炸 |
| R3 `contrib 随 fiber 同生灭` | `manifest.ui.contrib` | disabled 插件贡献带 `disabled` 位(现语义保留),前端 unwired 态数据源;不得有「插件关了板还 wired」的悬挂态 |

### 5.2 「管线引擎不进 fiber」→ 声明层堵死

| 规则 | 机制 |
|---|---|
| R4 引擎不可声明 | `domain` 词表**没有** `'engine'` 取值——插件只能是五种面。管线引擎(prompt 组装/WI 扫描/regex 应用/settle/STscript 求值/格式编解码)住在 `services/`+`@utopinn/core`,模块引用,永不进 `provide` 词表 |
| R5 `provides` 白名单 | 将来插件 `provides` 只允许 catalog `role:'seam'|'bundle'|'service'` 里已登记名(core 角色只能 kernel-boot 供)——`provideSeam` 现有 role 参数扩校验,引擎名不在 seam 词表即 throw |
| R6 `engineDeps` 信息位 | manifest 可声明 `engineDeps:['stscript-env','mvu-settle']`(services 层模块名)——纯信息,但让 doctor 能报「这个面背后靠着哪个引擎」;域图 §2.4/§2.5 的共享引擎关系从此有据可查 |

### 5.3 一句话版本(写进 kernel 契约注释)

> **fiber 是面的生命周期,不是能力的生命周期。** 可停用的只能是面
> (路由/contrib/CLI 动词/面板归属);引擎活在模块层,谁都能 import,
> 谁都不拥有。声明模型的全部字段都在回答「这块面是谁的、能不能拆、
> 拆了后果是什么」,没有一个字段回答「能力怎么实现」。

## 6. 和客户端契约的衔接

### 6.1 分工(与 client-contract.md 的边界——该档另一格在写,以落地稿为准)

| 面 | 本档(服务端真相源) | client-contract(消费面) |
|---|---|---|
| 声明在哪 | 插件模块 manifest+register meta | — |
| 怎么出 | `GET /api/utopinn/manifest` + `/_kernel` + `/ui/contrib` | 客户端何时拉/怎么缓存/断网退化 |
| 槽词表 | `slots`/`syncCategories` 随响应带出 | 客户端按槽消费(nav/panel/renderer…) |
| 面板归属 | `contrib.items[].plugin/core/disabled` | web `panel.type` 注册、mobile 面板页怎么映射 |
| CLI | verb 声明在 manifest | CLI 实现/分发/输出塑形(CLI 自己的面) |
| mobile 过滤 | manifest 全量出,`?view=` 留裁剪口 | mobile 需要哪几槽/哪些 `face`——由它定义裁剪视图 |

**我这侧的承诺**:manifest 端面给全量、按 `?view=` 留裁剪口、disabled
插件声明照样出(配合 unwired 态);client-contract 定消费节奏与降级。

### 6.2 对 web/mobile 的直接收益

- **web**(apps/web):`/ui/contrib` 已是 hydrate 数据源,迁完后
  BUILTIN 三件之外的归属(ledger/cardapp→th、notes/preset→library
  或拆后 state)也自动出表——域图 §6.2 的缺口顺手补齐。
- **mobile**:面板页(CardApp WebView + 状态板)的「哪些面板存在、
  哪个插件供的、服务端是否 active」全部从 manifest 读,不本地硬编。
- **CLI**(D-021 参考客户端):具名集从手抄表变 manifest 拉取——
  「服务端能力必先有 CLI 动词」这条政策从人肉纪律变机器对账
  (cliGaps 非零即漂移)。

### 6.3 第三方/旧插件的声明通道

- **bundle 化插件**(npm 包形):profile 行内联 `manifest:` 字段,或包内
  `package.json` 的 `utopinn` 段——**不 eval 模块也能读声明**,这是
  「disabled 不跑顶层码」原则在不可信插件上的保留形态。内置 11 件是
  可信件,允许 import-for-manifest(顶层只许声明式代码,lint 守)。
- **legacy ST 插件**(legacy-adapter):`{info}` → 自动 manifest
  `{domain:{type:'compat',id:info.id},face:'compat',core:false}`,
  路由经它自己的 Express router 不进 Registry——manifest 里标
  `unmanaged: true`,doctor 如实报「未纳管面」。

## 7. 三期迁移计划

### 一期:内核账本(对账不改写)

> 目标:**让内核看见自己注册了什么**,旧表一张不动,漂移先被照亮再被消。

1. `webserver.ts`:WebRoute 扩 `name/auth/gate/cli/schema` 可选字段;
   `entries()` 返回富对象(`list()` 保旧形兼容 doctor)。
2. `loader.ts`:apply 期间归属戳(fiber→plugin id)→ RouteRegistry。
3. `in-progress-gate.js`:GATED 分两段——legacy 手写段不动;新增
   「内核段」由 Registry 派生(gate 字段→regex 自动编译,pattern→regex
   转换器与 `compilePattern` 同规则)。**一期先对账不接管**:派生表与
   手写 utopinn 块(:112-130)逐条 diff,不一致 boot warn + doctor 报,
   手写仍生效。
4. `utopinn-diag` 或 `plugins` 出 `GET /api/utopinn/manifest`(§4.2 形)。
5. CLI:`doctor` 新增 `manifest drift` step(拉 manifest 对 NAMED 表/
   webServer.list() 三方账);`NAMED_UTOPINN_ROUTES` 暂留。

出口判据:11 插件零改动上线;`/manifest` 出全量归属表;gate 派生表与
手写表 diff=0(若有 diff,先修手写表——**它就是当前真相的最后机会**)。

### 二期:声明落位(逐插件 manifest + 旧表切收)

> 目标:**每个插件的 manifest 写全,手抄表按插件粒度退役**——一个插件
> 迁完才删它的手写行,永远不缺位。

顺序:小叶先行(script/th/connection/regex/mvu)→ 中件
(data/diag/plugins/delivery)→ library 收尾(45 条+)。

每插件一份工单,内容恒为:

1. `export const manifest` 落位(domain/core/auth/cli.verbs/ui.contrib/
   effects/engineDeps);逐 register 点补 `name`+`gate`/`cli`/`auth` 字段。
2. **切换三连**(声明生效后立刻):
   - GATED 手写行删该插件段(派生表已接管,一期对账=放行闸);
   - `NAMED_UTOPINN_ROUTES` 删该插件行(CLI 改从 manifest 拉具名集,
     一期 doctor 已对账);
   - `BUILTIN_CONTRIB`/`CORE_PLUGINS` 删该插件键(manifest.ui.contrib
     + manifest.core 接管;API act 闸与 kernel 闸同读 manifest)。
3. handler 内 `adminOnly` 内联检查随 `auth:'admin'` 声明逐个摘除
   (lan/offer 等 `custom` 形保留并显式标)。

library 拆单:45 条按域图 §5.2 若先行拆出 `utopinn-state`(18 条 sidecar
族),**迁移顺手做拆分**——state 三族直接以新插件身份出生带 manifest,
不走「先迁后拆」两茬。chats 域(§5.2 第二步)同法可选。

出口判据:GATED_ROUTES 只剩 legacy `/api/*` 段;NAMED 表删除(或
收敛为 manifest 快照文件);BUILTIN_CONTRIB/CORE_PLUGINS 常量删除;
`/ui/contrib` 全量来自模块声明;profile.yaml 行内容不变(组合层本色)。

### 三期:硬化契约(判据变 CI)

1. `pluginManager.disable()` 读 `manifest.core` 强制拒(现为 act() 闸+
   导出常量,机制未沉到 kernel 层——本步收口);reload 放行照旧。
2. `kernel-manifest.test`(node:test 或 e2e scratch):
   - 全量 register 有 name(undocumented=0);
   - 写方法路由 `gate!==undefined`(漏闸即红);
   - `plugins/` 目录无向非 core 插件的模块级 import(R2;`_shared/` 白名单);
   - CLI dispatch 臂 ⊆ manifest cli verbs + 本地动词白名单(schema/help/
     chat-new 等 `local:true`)。
3. `schema` 字段接通 `packages/protocol`:声明的类型名引用进 protocol
   导出表,v1 仅元数据(文档/对账),运行期 schemastery 校验可选后置。
4. legacy-adapter manifest shim(§6.3);域图 §5.2 的 `utopinn-state`/
   `utopinn-chats` 拆分若未在二期顺手做,借新通道执行——声明随模块走,
   拆/合不再需要同步改四张表(11-20 合并已示范成本)。

### 7.4 保持手编的(明确不切)

- **handler 函数体**:永远手写(声明管面不管实现)。
- **复杂副作用体**:delivery 的 WSS+心跳、data 的 UDP——`effects` 字段
  只登记存在性,执行体照写。这类「socket 插件」天生 apply 形,不硬凹
  纯声明。
- **legacy `/api/*` GATED 段**:非内核面(Luker 老 router 的闸表),
  不是本设计的范围;若 legacy 逐面退役,行随面删。
- **CLI 动词实现**:dispatch switch、参数解析、输出塑形——CLI 是自己的
  产品面,manifest 只供「动词↔路由」绑定事实。
- **protocol TS 类型**:仍手工镜像(直到 schema 引用成熟;三期才开始
  接)。
- **profile.yaml**:组合层身份不动——装载序/启停/config 是它的真相,
  不是重复声明。

## 8. 明确不做

- 不做「纯声明式路由」(manifest.routes[] + handler 名引用)——副作用
  重的插件(WSS/UDP/批量 45 handler)凹不进;register-meta 内联已是
  单一声明源,再抽象是把灵活处变表格。
- 不做离线 manifest 静态分析(§3.3)——活内核吐表,不做 AST/干跑。
- 不动 register 的 imperative 形状,不加 `ctx.route(prefix,router)`
  (架构档 §2 提过,本轮不引)——webServer.register 已是最薄契约。
- 不在本步落插件间 provide/inject seam(域图 §7 同名条目)——manifest
  的 provides/consumes 是**占位字段**,等 seam 三角任务填。
- 不把 sync categories 词表搬出 sync/(词汇归属不动,只引用)。

## 9. 开放问题(留给实施裁定)

- `/_kernel` 现无 admin 闸(`utopinn-diag.js:400` 直出 routes+services);manifest
  信息量更大——对齐现状直出,还是统一升 admin?(单机自用无碍,多用户
  部署该升。)
- `gate` 声明的 categories 允许写 `'*'` 速写 ALL_CATEGORY_IDS 吗
  (import/commit、lan/import、restore 类 wholesale 路由三条现例)。
- `cli:false` 的显式 raw-only 集合要不要上限(政策面:raw 是逃生舱,
  不该成为常态——给个 warn 阈值如 >10%)。
- profile 行 `manifest:` 内联 vs 包级 `package.json` 段——第三方插件
  打包形态定了再选(先支持 profile 行内联,成本一行 schema)。
- `utopinn-library.js` 保留了 safeName/sendError 私有副本(`_shared` 注释
  明示「该文件归另一格维护,不引本模块以避免跨格依赖」)——R2 落地时
  统一收编哪一份,届时裁定(两副本语义一致,属清理项非阻塞)。

## Related documents and capabilities

- `.loom/design/plugin-domain-map.md` — 域解剖/合并判据/四问+红线;本文的
  domain/face 词表与 R1-R6 判据直接来源。
- `.loom/design/plugin-architecture.md` — cordis 语义骨架/服务四分/事件五模式;
  manifest 是 `Plugin.Base` 的 Utopinn 扩展位(§1)。
- `.loom/capabilities/plugin-kernel/` — cordis 选型/DSH manifest 模式/
  借用边界;DeepWiki 侧 cordis 上游文档佐证 Plugin.Base 字段语义。
- `.loom/design/client-contract.md`(在写)— 客户端消费面;本文只承诺服务端
  manifest 端面与词表,消费节奏归它。
- `.loom/design/deferred-surgery.md`(若在写)— legacy 面收尾若与本设计
  三期重叠(legacy GATED 段/adapter shim),以该档排期为准。
- `.loom/eval/task038-cli-coverage-audit.md` — 五表漂移的最近一次实证审计。
- `.loom/DECISIONS.md` D-021 — CLI=协议参考客户端,cli 声明的政策依据。
