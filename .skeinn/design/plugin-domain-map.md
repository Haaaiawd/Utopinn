# 插件域地图:13 个内核插件的域解剖与合并判据

- Kind: design / analysis
- Status: draft
- 缘起:用户提问——「概念区分不明确:正则这种东西适合做插件吗?要不要合并?」
- 材料:`apps/server/src/plugins/utopinn-*.js` 全读 + `src/profile.yaml` +
  `src/kernel-boot.js` + 前端 `apps/web/src/kernel/contributions.ts` /
  `features/panels.tsx` + CLI `apps/cli/utopinn-cli.mjs` 具名路由表 +
  `.skeinn/capabilities/plugin-kernel/` 既有研究。

> vs-V2: current
<!-- V2 校准:标题"13 个"现为 11(import→data、stats→diag 已合);§5.1 已落地、§2.7 半落地(_shared/http-utils.js)、§6.1 CORE_PLUGINS 已补 plugins -->

## 0. 总判断(先答问题)

**「正则适不适合做插件」是个错位问题——引擎从来不在插件里。**

现状其实已经把概念分开了,只是命名没说清:

- 正则**引擎**(管线能力)在 `@utopinn/core`(`packages/core/src/index.ts:24-26`
  导出 `regex/types`、`regex/engine`、`regex/redos`;WI 用变体在
  `world-info/regex.js`),由 `services/generate-context.js:539-587` 在
  prompt 组装时直接调用,`services/extension-prompts.js` 读三层脚本存储。
  它不是插件,也**不该**是——golden-diff 钉死的组装行为不能挂在可被
  disable 的 fiber 上。
- `utopinn-regex` 插件 = 正则**脚本资源的管理面**:global(settings
  `extension_settings.regex`)/ char(卡 `data.extensions.regex_scripts`)/
  preset(`doc.extensions.regex_scripts`)三层 CRUD + 放行表
  (`character_allowed_regex` / `preset_allowed_regex` / `disabledExtensions`)。
  数据域插件,完全合规。

**13 个插件的真实身份:全部是「面」(surface)插件。** inject 只认三个内核
服务(`webServer` / `catalog` / `pluginManager`,见各文件 `export const inject`),
插件之间**零 provide/inject**——没有一个插件向别的插件提供能力。
引擎全部住在 `services/` 与 `@utopinn/core` 的模块层,不在 fiber 生命周期里。
plugin-architecture §4 设计的 seam 三角(promptBuilder / variableStore /
chatState / generation …)目前一处都没有实例化——今天的插件粒度 = 路由域粒度。

所以判据的正确翻译:

> 「X 适不适合做插件」=「X 的管理面 / 协议面 / 资源面该不该成为独立装载、
> 可停用、可热拔的路由单元」。**能力本体永远不该进 fiber**——fiber 生命周期
> ≠ 引擎生命周期;生成路径必须触达的东西挂在可停用单元上是反向错误。

## 1. 域地图

域类型(本文档词表):
- **资源域** —— 拥有一类持久资源的读写语义(CRUD/校验/并发)
- **能力面** —— 把 services/core 引擎暴露成 REST(引擎不驻插件)
- **协议面** —— 为某类消费者提供一份线协议(WS 流 / 兼容 API / 探测契约)
- **内核面** —— 内核自身的管理/自证
- **观测面** —— 对 job store / diag-bus / inspector 的聚合读模型

| 插件 | 一句话职责 | 域类型 | 路由数 | inject | 关掉它的后果 |
|---|---|---|---|---|---|
| `utopinn-library` | 酒馆数据面:characters/chats/presets/worlds/personas/settings/secrets CRUD + chat 写路径 + state sidecar 三族 | 资源域(**多个**) | **45** | webServer | 产品死(无任何资源读写) |
| `utopinn-generate` | 全组装生成编排(/generate /preview)+ 生成 job 监视/中止 | 能力面 | 5 | webServer | 产品死(不能生成) |
| `utopinn-delivery` | WS 交付通道 `/api/ws-delivery`:ticket 握手/订阅去重/应用层心跳 | 协议面 | 1 upgrade | webServer | 失去流式(客户端挂起,doctor 红) |
| `utopinn-diag` | `_kernel` 自证 + diag-bus 读面(events/errors/stats/trace)+ 客户端上报口 | 内核面 + 观测面 | 6 | webServer, catalog | 失去观测与内核自省 |
| `utopinn-stats` | 生成/注入聚合统计(summary / by-char / inject) | 观测面 | 3 | webServer | 失去统计面板数据 |
| `utopinn-mvu` | MVU settle/resettle 手动面 + 变量视图 + 状态板模板渲染 | 能力面 | 4 | webServer | 自动 settle 仍在(在 chats 写路径),失手动重结算/面板渲染/状态读 |
| `utopinn-connection` | 上游连接探测(/connection/test)+ 模型清单(/models,30s 缓存) | 协议面(探测契约) | 2 | webServer | 失「连接测试」与模型下拉数据源;生成照走 |
| `utopinn-regex` | 正则脚本三层存储 CRUD + 放行表管理 | 资源域 | 4 | webServer | 引擎照跑,失脚本管理面 |
| `utopinn-script` | STscript 服务端 runner(POST /script/run) | 能力面 | 1 | webServer | 失脚本执行面;th.triggerSlash 独立存活 |
| `utopinn-th` | TavernHelper 语义兼容面(/th/call,CardApp postMessage 桥的后端) | 协议面(兼容契约) | 1 | webServer | CardApp 面板失变量/消息读写 |
| `utopinn-import` | 导入管线:格式探测 preview → commit 落库(char/world/preset/persona) | 资源域(数据进入) | 2 | webServer | 失导入落库 |
| `utopinn-data` | 数据进出杂面:备份快照 + ST 目录扫描 + LAN 迁移/UDP 发现 | 资源域(数据进出,**三个子域**) | 4 + UDP | webServer | 失备份/LAN 迁移/发现/scan-st |
| `utopinn-plugins` | 插件管理 API(list/enable/disable/reload)+ `/ui/contrib` 贡献清单 | 内核面 | 5 | webServer, pluginManager | 失插件管理面与 UI 贡献 hydrate |

### 路由清单(注册在案,方法|路径)

- **library(45)**:`GET /characters` · `GET|PATCH /characters/:charDir` ·
  `GET|PUT|PATCH|DELETE /characters/:charDir/chats/:chatName` ·
  `GET /characters/:charDir/chats` · `POST …/messages` `POST …/rename`
  `PUT …/document` · `POST /chats/recent` · `GET /presets`
  `GET|PUT|DELETE /presets/:name` · `GET /worlds` `GET|PUT|DELETE /worlds/:name` ·
  `GET /personas` `PUT|DELETE /personas/:avatar` · `GET|PATCH /settings` ·
  `GET /secrets` `PUT /secrets/:key` `DELETE /secrets/:key/:id` ·
  state chat:`GET|POST /state/chat/get` + `get-batch|patch|delete`(5)·
  state char:同上 + `set`(6)· state preset:同上 + `delete-all|rename`(7)
  ——注册点 `utopinn-library.js:304-2151`
- **generate(5)**:`GET /jobs` `GET /jobs/:id` `POST /jobs/:id/abort`
  `POST /generate` `POST /preview`(`utopinn-generate.js:234/242/274/296/562`)
- **diag(6)**:`GET /_kernel` · `GET /diag/events|errors|stats` ·
  `POST /diag/client` · `GET /diag/jobs/:id/trace`(`utopinn-diag.js:100-216`)
- **stats(3)**:`GET /stats/summary|by-char/:id|inject`(`utopinn-stats.js:311/348/404`)
- **mvu(4)**:`POST /mvu/settle|resettle` `GET /mvu/state` `POST /mvu/panel/render`
- **regex(4)**:`GET|PUT /regex` `PATCH|DELETE /regex/:id`(`utopinn-regex.js:447-605`)
- **connection(2)**:`POST /connection/test` `GET /models`(`utopinn-connection.js:460/487`)
- **script(1)**:`POST /script/run` · **th(1)**:`POST /th/call`
- **import(2)**:`POST /import/preview|commit`
- **data(4+UDP)**:`POST /backup` `POST /lan/offer` `POST /lan/import`
  `POST /import/scan-st` + UDP 发现 socket(`utopinn-data.js:142-159`)
- **plugins(5)**:`GET /plugins` `POST /plugins/:id/{enable,disable,reload}`
  `GET /ui/contrib`(`utopinn-plugins.js:145-212`)
- **delivery**:`upgrade /api/ws-delivery`(`utopinn-delivery.js:137`)

全部与 CLI `NAMED_UTOPINN_ROUTES`(`utopinn-cli.mjs:1052-1146`)一一对应——
**这张表是路由移动的破坏面之一**:doctor 的 capability coverage 步按
`METHOD|kind|path` 串比对,路径变则具名率掉。

## 2. 重叠与暧昧地带(逐条查实)

### 2.1 `data` ↔ `import` —— 同一个域,命名空间被切两刀
`/api/utopinn/import/*` 三个路由分属两个插件:`scan-st` 在 data
(`utopinn-data.js:126`),`preview`/`commit` 在 import
(`utopinn-import.js:322/386`)。扫描→预览→落库是**同一条管线的三个顺序
阶段**,被切在两个 fiber 里:单独 disable import → scan 能跑、commit 不能;
单独 disable data → scan 死、preview 可跑(但对不上流程)。备份/LAN 迁移
也和「数据过实例边界」同域。**该合。**

### 2.2 `diag` ↔ `stats` —— 同一个观测域,按路由数切的两个插件
同数据源(diag-bus 环 + luker-generation job store + request-inspector
ledger),同消费者(观测面板 + CLI logs/stats 动词),同读模型。diag 多担了
两件东西:`_kernel` 自证(内核面)和 `diag/client` 上报口(协议面)。stats
没有新域,只是更高阶的聚合。**该合;`_kernel` 与上报口留在原地即可。**

### 2.3 `library` —— 一个插件管四个资源域
45 条路由里至少四个有界上下文:资源浏览(characters/presets/worlds/
personas)、settings/secrets、**会话读写**(chats 列表/get + 写路径 ——
带 integrity/gen-id/settle 生成邻接机器,`utopinn-library.js:37-68` 直接
复用 `endpoints/chats.js` 的全套写件)、**state sidecar 三族**(18 条
注册,JSON-patch 机制与资源 CRUD 不同物)。api-client 早已按
`library.ts`/`generate.ts`/`state.ts`/`misc.ts` 四域建模——**服务端边界
比客户端自己的划分粗**。**该拆,至少把 state 三族拆出去。**

### 2.4 `th` ↔ `script` —— 共享引擎,不同契约(不该合)
两者都是 `services/stscript-env.js` 之上的薄壳,都调
`registerBuiltinCommands()`(script L22 / th L266,幂等但重复)。但域不同:
script 是**原生执行面**(CLI/前端直跑 STscript);th 是**兼容协议面**
(TavernHelper 方法表,CardApp iframe postMessage 桥的后端,自带 PolyForm NC
规避注释)。一个跟着 TH 生态契约走、一个跟着我们自己 API 走——**共享的
部分已经正确沉到 services,壳保持分开是对的。**

### 2.5 `connection` ↔ `generate`(↔ legacy `/status`)—— 上游解析两份半
`connection` 的 `resolveConnection`(`utopinn-connection.js:114-253`)逐支
镜像 `endpoints/backends/chat-completions.js` /status 的 source→url/key/
headers 逻辑,注释自己承认「只能照抄……必须与 /status 保持同步漂移」
(L46-47);`generate` 的 `CONNECTION_KEYS`(L218-226)又维护一份
「什么字段属连接层不属预设」的第三处枚举。**这不是插件边界问题,是
service 层缺一个 `connection-resolve` 共享模块**——探测与派发吃同一份
source→{apiUrl,apiKey,headers,query} 解析才是终点态(可顺势升级为
`ctx.connection` seam,三方消费:connection 插件、chat-completions /status、
generate 派发塑形)。

### 2.6 jobs 读模型散在三处(可接受,记录在案)
`/jobs*` 在 generate(L234-294),`/diag/jobs/:id/trace` 在 diag(L183),
stats 整个读 job store。同一聚合根的三种视图分属三个前缀——读模型
共享不算抢地盘,但「job 自省面」确实散。diag+stats 合并后收敛为两处。

### 2.7 跨插件模块 import —— 边界在 fiber 层干净、在模块层漏
六个插件直接 `import { safeName, sendError } from './utopinn-library.js'`:
connection:42、generate:30、script:16、stats:31、th:25、regex:45。
library 实际兼作「共享 HTTP 工具模块」。纯函数无所谓 fiber 卸载,但方向是反的:
**最大的插件被六家当库用**。safeName/sendError 应上移到
`services/`(如 `http-helpers.js`),plugins/ 目录回归纯路由面。
同理 diagEmit 由 connection/generate/th 直接 import diag-bus 模块——
观测总线是共享模块不是 inject 服务,可接受但值得记录(将来 `ctx.diag`
成 seam 时一起收)。

### 2.8 CORE_PLUGINS 只有标记、没有闸(重要发现)
`utopinn-plugins.js:50-52` 的 CORE_PLUGINS={library,generate,delivery,diag}
只用于给 `/ui/contrib` 条目打 `core:true` 供前端置灰。**`pluginManager
.disable()`(kernel-boot.js:161-172)不查这张表**——POST
`/plugins/utopinn-library/disable` 会真把数据面拆了。目前唯一的真实自锁
是 plugins 对自己的 400(L202)。要么 core 组进 pluginManager 强制层,
要么承认「锁定只是 UI 提示」并靠 patch 文件做最终闸。

## 3. 插件边界判据(四问 + 一条红线)

参照 Cordis 语义(fiber/effect/disposer、profile patch 可换行)与本仓实践:

| # | 判据 | 操作化检查 |
|---|---|---|
| J1 | **独立生命周期** | 它是否 own 需要可逆拆除的东西?(路由表项/定时器/socket/WSS)——有则插件形态有实际收益。 |
| J2 | **可停用降级** | 关掉它,产品是「诚实退化」(路由 404、面板 unwired)还是「静默坏掉」(生成链断、存储错乱)?后者 = 归 core/services,不配当可停用插件。 |
| J3 | **单一有界域** | 一句话说清「它拥有什么数据 / 服务什么契约」。需要「和」才能讲完 = 该拆;两个插件同答一句话 = 该合。 |
| J4 | **seam/可替换面** | 它是不是一个别人可能想换实现的契约面?(协议面天然是;资源域次之一可整体 patch 换面) |

**红线(凌驾四问):管线引擎不进插件。** 组装/正则应用/WI 扫描/settle/
STscript 求值/格式编解码这类「生成路径必须触达」的能力住在
`services/` + `@utopinn/core`,由模块引用,不走 inject。插件可以做它的
管理面/调试面/参数面,不能把引擎本体搬进 fiber。

## 4. 逐件评审

| 插件 | J1 | J2 | J3 | J4 | 结论 |
|---|---|---|---|---|---|
| library | ✓(45 路由) | ✗ 核心面 | **✗ 四域** | 资源面 | **保留但拆**:state 三族、chat 读写各成一域(§5.2) |
| generate | ✓ | ✗ 核心面 | ✓ 生成编排+job 控制 | 可换编排器(§4b 预留) | **合规,core 锁定正确**;engine 在 services 正确 |
| delivery | ✓✓(WSS+心跳,socket 范本) | 半:关了无流式 | ✓ 单一协议 | ✓ WS 契约 | **合规,core 锁定正确**;wsTickets 升 seam 的 TODO 合理 |
| diag | ✓ | ✗(观测底座) | 半:内核自证+观测两职 | 上报协议 | **合规;与 stats 合并后域更干净** |
| stats | ✓ | ✓ 可停用 | 与 diag 同域 | — | **并入 diag**(§5.1) |
| mvu | ✓ | ✓(引擎在 chats 写路径,`endpoints/chats.js`+`luker-generation.js` 自调 settle,插件只管手动面) | ✓ MVU/变量域 | 状态板渲染 seam | **合规;是「引擎在 services、插件是控制面」的标准样本** |
| connection | ✓ | ✓ 可停用 | ✓ 上游探测契约 | 探测协议 | **合规保留**;待解的是 §2.5 的共享解析模块,不是边界 |
| regex | ✓ | ✓ 可停用 | ✓ 正则脚本资源域 | — | **合规保留**。问题只是命名:它管的是「脚本数据」不是「正则能力」——名字建议随注释明示,或改名 `utopinn-regex-scripts` 时顺手 |
| script | ✓ | ✓ 可停用 | ✓ 原生执行面 | STscript 契约 | **合规保留**;与 th 的共享已在 stscript-env |
| th | ✓ | 半(CardApp 生态面) | ✓ TH 兼容契约 | ✓ 桥协议 | **合规保留**;但 CardApp 面板的插件归属未声明(§6.2) |
| import | ✓ | ✓ 可停用 | 与 data 同域(管线被切) | — | **并入 data**(§5.1) |
| data | ✓✓(路由+UDP socket) | ✓ 可停用 | 半:备份/LAN/scan 三子域可同归「数据进出」 | — | **收编 import,统一成数据进出域** |
| plugins | ✓ | ✗(管理面,自锁已自认核心) | ✓ 插件域自身 | — | **合规;应入 core 组**(§6.1) |

## 5. 合并/拆分建议

### 5.1 合并(域相同、仅路由分散)

| 动作 | 结果插件 | 理由 | 破坏面 |
|---|---|---|---|
| `utopinn-import` + `utopinn-data` → `utopinn-data`(数据进出域) | 备份/LAN/scan-st/preview/commit 六件一面 | §2.1:同管线三阶段被切两刀;「数据过实例边界」是一个域。**路由零移动**——只改哪个插件注册 | profile.yaml 删一行;profile.patch.yaml 里 `utopinn-import` 行失效(被忽略,不炸);`/plugins` API 与 `utopinn plugins` CLI 输出少一个 id;无前端/协议破坏 |
| `utopinn-stats` + `utopinn-diag` → `utopinn-diag`(观测域) | `_kernel`/events/errors/stats(原)/trace/client + summary/by-char/inject | §2.2:同源同消费者。**路由零移动** | `utopinn-stats` id 消失(同上 profile/patch/API 三面);`BUILTIN_CONTRIB['utopinn-stats']` 键并入 `'utopinn-diag'`(ui/contrib 响应里 stats 面板的 `plugin` 字段变);**语义变化:stats 面板随 diag 进 core 组、不可单独停用**——可接受(纯读面,停用价值低) |

### 5.2 拆分(一插件多域)

| 动作 | 拆出插件 | 范围(路由零移动) | 破坏面 |
|---|---|---|---|
| library → `utopinn-state` | `/api/utopinn/state/{chat,char,preset}/*` 18 条注册 | sidecar 三族是独立机制(JSON-patch 文档 + ns),api-client 已有独立 `state.ts` 域 | profile.yaml 加一行;新 id 进 CORE 组(数据面核心);`safeName/sendError` 共享件随 §2.7 上移 services 后三方都不依赖 library 模块 |
| (可选,第二步)library → `utopinn-chats` | `/characters/:dir/chats/*` 全部 + `/chats/recent`(约 10 条) | 会话读写带 integrity/gen-id/settle 机器,是「会话域」不是「资源浏览域」;CLI/api-client 的 chats 动词本就独立 | 同上;library 收编为纯资源+settings+secrets 面(~18 条) |

不拆的理由也说清:resources/settings/secrets/personas/presets/worlds 留在
library 是因为它们同归「酒馆资源浏览面」一个域,45→18 条后体量合理;
再往下按资源类型拆就是过碎(六个一资源插件,每个 3-5 路由,profile 行爆炸,
跨资源引用还得互 import)。

### 5.3 不动的(评审后确认边界正确)

- `th` / `script` 不合(§2.4);`generate`/`delivery`/`connection`/`mvu`/
  `regex`/`plugins`/`script` 单域成立(§4)。
- `regex` 不并入 library:它的三层存储语义(CAS 写、卡写锁、放行表)是
  完整有界上下文,正是「管理面插件」的正确尺寸。

### 5.4 附带清理(非插件边界,但顺手记在案)

1. `safeName`/`sendError` 从 `utopinn-library.js` 上移到
   `services/http-helpers.js`,六个插件改 import(§2.7)。
2. `connection` 的 `resolveConnection` 抽 `services/connection-resolve.js`,
   chat-completions /status 逐步对齐共用(§2.5)——消「两份半」漂移。
3. `pluginManager.disable()` 加 core 闸或文档承认无闸(§2.8)。
4. script/th 的 `registerBuiltinCommands()` 重复调用去重(挪到
   stscript-env 模块级,或 core 注册表幂等化)。

## 6. core 组与前端贡献槽一致性

### 6.1 CORE_PLUGINS 现状 vs 建议

现状(`utopinn-plugins.js:50-52`):`{library, generate, delivery, diag}`

判据:**关掉它产品就死或管理面失联 → core**。逐件:

- 现状四件全对:library=数据面,generate=生成,delivery=流式,diag=观测+内核自证。
- **应加 `utopinn-plugins`**:它是唯一管理入口,API 层已自认不可关
  (self-lock L202)——表里没有它纯属漏列。disable 它之后连「再 enable」
  的 API 都没了(只能手改 profile.patch.yaml),这正是 core 的定义场景。
- 其余(mvu/connection/regex/script/th/import/data/stats→并入diag后不存在)
  均可停用组:关了诚实退化,产品主循环不死。
- 若 §5.2 落地:`utopinn-state`/`utopinn-chats` 继承 core(数据面);
  `utopinn-data`(收编 import 后)仍可选。
- **闸的强度问题另算**:当前 core 组只影响 contrib 标记,pluginManager
  不强制(§2.8)。建议让 pluginManager 读同一份 CORE 集拒 disable,
  比「再加一个 id 表」便宜——CORE_PLUGINS 已在 plugins.js,唯一权威源。

建议终态:`{library, chats*, state*, generate, delivery, diag, plugins}`
(*若 5.2 落地)。

### 6.2 前端贡献槽映射

服务端 `KNOWN_SLOTS`(`utopinn-plugins.js:44-47`)与前端
`contributions.ts:83-92` 八槽 **1:1 一致**:nav.rail / view / sidebar.tree /
stage.form / panel.type / renderer / ctbar.chat / locale。

`panel.type` 归属对照(BUILTIN_CONTRIB vs `features/panels.tsx`):

| 面板 | 前端注册(panels.tsx) | 服务端归属(BUILTIN_CONTRIB) | 实际数据后端 |
|---|---|---|---|
| diag | code/wired/system | utopinn-diag ✓ | diag 插件 |
| stats | compass/wired/system | utopinn-stats ✓(合后归 diag) | stats→diag |
| mvu | database/wired/system | utopinn-mvu ✓ | mvu 插件 |
| ledger/cardapp | cardapp 桶,wired | **未声明** | th/call 桥 + state sidecar |
| notes | note/wired/system | **未声明** | library 的 state/chat(ns='notes') |
| preset | sliders/wired/system | **未声明** | library 的 /presets |
| lore/chapters/channels | wired:false | — | 服务端面无(诚实 unwired,正确) |

- 已声明三件与前端逐字段一致(icon/wired/badge/category/desc 全对得上)✓
- **缺口**:wired 面板里 ledger/cardapp/notes/preset 无服务端归属——
  「谁供了这块板」清单不完整。建议:cardapp/ledger 归 `utopinn-th`
  (+将来的 card-runtime),notes/preset 归 `utopinn-library`(或拆后的
  `utopinn-state`/`utopinn-library`)。一行 BUILTIN_CONTRIB 一条,顺手。
- 其余七槽服务端暂无贡献(nav.rail/view/renderer 等只有声明机制,
  没有实际贡献者——等三方插件出现,符合预期,不算缺口)。

## 7. 明确不做

- 不把任何引擎(regex 应用、settle、STscript 求值、WI 扫描、prompt 组装)
  移进插件 fiber——§3 红线。
- 不改任何路由路径:本建议的全部合/拆只动「哪个插件注册这条路由」,
  wire 协议、CLI 具名表、api-client 域文件零触碰。
- 不动 `generate`/`delivery`/`connection`/`mvu`/`regex`/`script`/`th`/`plugins`
  的存在性。
- 不在本步引入插件间 provide/inject seam(架构 §4 的 seam 三角落地是
  另一个任务;本文档只划现状 13 件的域)。

## 8. 迁移顺序建议(零破面先行)

1. §5.4.1 上移 http-helpers(无行为变化,先消模块层漏)。
2. §5.1 两组合并(plugins.js 的 BUILTIN_CONTRIB/CORE_PLUGINS 同步改)。
3. §2.8 core 闸进 pluginManager(读 plugins.js 的 CORE 集,唯一权威源)。
4. §5.2 state 拆出(量最大但仍是纯移动;chats 拆分看心情,可后置)。
5. §6.2 补齐 wired 面板的 BUILTIN_CONTRIB 归属。
6. §2.5 connection-resolve 共享模块(service 层,独立排期)。

每步独立可回退;除第 2 步外 profile.yaml 行内容不变,只增删行。
