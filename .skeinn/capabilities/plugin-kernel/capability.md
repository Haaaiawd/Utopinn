# 插件内核(cordis core + 组合/生命周期)

> 薄内核,产品全是插件;组合是 profile 行+patch 增量不是列表。
> 本卷已按实现事实重写(V2 落地后):原设计期「将如何做」全部被
> 「实际是什么」替换;被现实否决的节点记为已证伪并指明理由。

## Field identity and boundary

cordis Context/事件/作用域语义采用(真库,非自写)、profile/patch 组合、
fiber 生命周期、degraded 语义、插件 UI 贡献面(/ui/contrib)、旧 ST 插件
适配器。不含:插件域边界判据与合/拆案(plugin-domain-map.md)、插件单一
声明源五表收一(cordis-next.md)、具体酒馆引擎(都在 services/+core,不进 fiber)。

## Project scenario

实现基线(V2,2026-11-20):`@utopinn/kernel` 包薄包 cordis **4.0.0-rc.12**
(packages/kernel/package.json:20);`kernel-boot.js` 立根 ctx + webServer +
pluginManager,`profile.yaml` 声明式装载 **11 个 utopinn-* 插件(84 路由)**;
前端 apps/web 另有同语义微内核(见 frontend-microkernel 卷)。

## Decision tree

### C1: 内核实现路线(已落地:A)

- entry_when: TASK-011 开工(已发生)
- options:
  - A: 引入真 cordis(npm,只用 core) → 实际选择
  - B: 自写同语义内核 → 未走
- decide_by: 语义细节坑多(waterfall outermost-first/bail/effect 通知依赖者),真库久经考验 → A 已实证立住;度:不引 cordis 生态周边,loader/profile/patch/webserver 自写(packages/kernel/src/)
- source: packages/kernel/package.json(cordis 4.0.0-rc.12);packages/kernel/src/{context,loader,webserver,legacy-adapter,plugin}.ts
- counterexample: 若 cordis rc 语义再漂(DSH 跟踪记录)升级到稳态前不追小版本——pin 在 rc.12
- output: createAppContext() = cordis Context + ServiceCatalog;`Context/Service/Inject` re-export;DispatchMode 五模式常量(emit/serial/parallel/bail/waterfall,契约化在声明处,context.ts:75-95)

### C2: 插件契约与 fiber 状态(实现事实)

- entry_when: 写插件或读装载结果
- options:
  - A: PluginModule 三形态(function(ctx,config) / {apply} / class extends Service),共享静态 name/Config/inject/provide/intercept → 现行
  - B: 自定义生命周期接口 → 未走
- source: packages/kernel/src/plugin.ts:9-17;loader.ts:22-29(LoadedPlugin)
- output: loader.ts LoadedPlugin.status ∈ **active|degraded|disabled|failed**;active 行携带 fiber(dispose 句柄,管理面靠它拆)+ module(W5 活实例——contrib 读面吃"运行中代码的声明",disabled/failed/degraded 天然无句柄);`ctx.plugin()` 返回 thenable,**必须 await**(async apply 的 reject 在这里抛,不 await = 假 active,loader.ts:130-136);fiber.state 数字面经 FIBER_STATES 映射 pending/loading/active/failed/disposed/unloading(kernel-boot.js:134-135,list() 读活状态不报假 active)

### C3: 组合语义(profile 行 + patch 增量,实现事实)

- entry_when: 启停/装载顺序
- options:
  - A: profile.yaml 有序行 + profile.patch.yaml 增量层 → 现行
  - B: 扁平插件列表 → 未走
- decide_by: patch 行只承载 `{id, disabled}` 增量(2026-11 修正,kernel-boot.js:92-103)——旧整行替换的 module/config 快照会永久遮蔽 base 后续变更,且 enable 面可复活已从 base 删除的插件;base 缺失 id 的 patch 行直接忽略
- source: apps/server/src/kernel-boot.js:92-121(mergedRows/upsertPatchRow,tmp+rename 原子写);packages/kernel/src/loader.ts:30-40(applyPatch 按 id 整行替换/追加/disabled 保位)、157-178(loadProfileFile/dumpConfig)
- counterexample: 以为 patch 行还能整行替换 module/config → 现在只读 .disabled;旧部署遗留整行 patch 兼容读出,下次 upsert 自动落成增量形
- output: 装载顺序=profile 列表序;`dumpConfig(profile, patch)` 出 `+ id <- module` 可视清单(loader.ts:173-178,--dump-config 面);enable/disable 持久化在 patch 不动基座

### C4: degraded 语义(实现事实:不静默、不连坐)

- entry_when: inject 缺失或 import/apply 失败
- options:
  - A: 记原因、不装载该行、继续后续行 → 现行
  - B: 一崩全崩 / 静默跳过 → 未走
- source: packages/kernel/src/loader.ts:96-141(missing inject→degraded;import 失败→failed;apply reject→failed);kernel-boot.js:240-261(每行状态打日志+diagEmit,failed 不 fatal)
- counterexample: 把 degraded 当 failed 处理 → degraded 是「声明的依赖缺席」(可恢复的诚实状态),failed 是「装了炸了」;pluginManager.list() 两者分列,reason 字段记录 `missing inject: <名单>`
- output: degraded/failed 都是可观测状态(kernel 路由 `_kernel` + pluginManager.list()+diag-bus),不是崩溃也不是静默

### C5: 服务面实证——「服务注册表+管线钩子」已证伪

- entry_when: 评估插件间服务/seam
- options:
  - A: 按设计图部署 seam 三角(promptBuilder/variableStore/chatState/generation/conversationRenderer,插件互 provide/inject) → **已证伪,理由见 plugin-domain-map §J(判据 J1–J4 与红线,§3)**
  - B: inject 只认内核三服务,引擎住 services/+core 模块层 → 现实
- decide_by: 实证(domain-map §0):11 插件全是「面」插件(资源域/能力面/协议面/内核面/观测面);**inject 只认 webServer/catalog/pluginManager**;插件之间零 provide/inject——没有一个插件向别的插件提供能力;引擎全部住 services/ 与 @utopinn/core 模块层,不在 fiber 生命周期;seam 三角目前**一处都没有实例化**——plugin 粒度 = 路由域粒度
- source: design/plugin-domain-map.md:29-40(§0 总判断)、166-180(§3 判据+红线「管线引擎不进插件」);apps/server/src/plugins/utopinn-*.js 各 `export const inject`
- counterexample: 想让某插件 provide 一个服务给另一插件 inject → 今天没有先例也没有需求;ServiceCatalog/provideSeam/DispatchMode 基建已在 context.ts 就位,但消费者是未来的 seam 任务——挂账 design/cordis-next.md(单一声明源,provides/consumes 字段预留为空)
- output: 「X 适不适合做插件」=「X 的管理面/协议面/资源面该不该成为独立装载、可停用、可热拔的路由单元」;能力本体永远不该进 fiber(生成路径必须触达的东西挂可停用单元是反向错误)

### C6: 管理面 pluginManager + core 闸(实现事实)

- entry_when: 插件启停/重载 API
- options:
  - A: kernel 服务 pluginManager + profile 行 core 闸 + CORE_PLUGINS 标记 → 现行
  - B: 无管理面,改文件重启 → 未走
- decide_by: disable→patch 落盘 + fiber.dispose(dispose 即摘路由,cordis effect 清理面全跑);enable→importPluginModule 重新 apply;reload→dispose + cache-bust 重导入(`?t=<ts>` 绕 ESM 缓存);core 闸:profile 行 `core: true` → pluginManager.disable 400(kernel-boot.js:174),API 侧 CORE_PLUGINS 同拒(utopinn-plugins.js:233)
- source: apps/server/src/kernel-boot.js:137-218;apps/server/src/plugins/utopinn-plugins.js:59-67(CORE_PLUGINS={library,generate,delivery,diag,plugins});profile.yaml(core: true 行)
- counterexample: 以为 CORE_PLUGINS 只是 UI 置灰标记 → domain-map §2.8 时期确实无闸,现在 profile 行 core:true 进 disable 判定是真闸;但仍注意 disable() 读的是 profile 行的 core 字段,不是 CORE_PLUGINS 常量——两表并存,加 core 插件要双处同步
- output: shutdown 反序 dispose 全部 fiber(shutdownKernelFibers,kernel-boot.js:220-231)

### C7: UI 贡献面 /ui/contrib(实现事实)

- entry_when: 前端需要「谁供了这块面」清单
- options:
  - A: GET /api/utopinn/ui/contrib = BUILTIN_CONTRIB(内核件归属常量)× 活模块 manifest(ui.contrib/meta.ui.contrib) 合并,core 行打 core:true → 现行
  - B: 前端自维护归属表 → 未走(归属是服务端事实)
- source: apps/server/src/plugins/utopinn-plugins.js:44-52(KNOWN_SLOTS 八槽与前端 contributions.ts 1:1)、185-219(合并逻辑)
- counterexample: BUILTIN_CONTRIB 里给面板写第二套文案 → 它是归属映射不是词表,本地文案词是前端资产,水合只补缺省(frontend-microkernel C7)
- output: 前端 features/contrib.tsx 水合对账的数据源;disabled 行仍算「声明过」(占位语义),live 声明才作 wired 升级

### C8: 旧 ST 服务端插件适配(实现事实:薄适配器已备)

- entry_when: 生态迁移
- options:
  - A: {info,init(router),exit} → adaptLegacyPlugin 包成 PluginModule → 现行(packages/kernel/src/legacy-adapter.ts)
  - B: 不适配 → 未走
- decide_by: 不做行为翻译——info→manifest;init(router)→宿主 routerFactory 供 router;exit→ctx.effect disposer;routerFactory 缺席时 apply 空跑(degraded 判定归 loader 的 inject 检查)
- source: packages/kernel/src/legacy-adapter.ts:22-41
- counterexample: 客户端 DOM 扩展塞进同一适配器 → 不适配,旧 ST 客户端扩展依旧 UI 回退面,不在本契约内
- output: 旧服务端插件可挂 profile 行装载;适配器是薄壳不是模拟器

## Stance and rejected defaults

薄内核 + 全面插件的骨架立住了,但「插件生态」的现实比设计图瘦:今天的
插件全是内核自家管理面,seam/provider 机制是建好的空车间。立场:**不为
「将来可能」提前实例化 seam**——管线引擎留在 services/core 是刻意的
(domain-map 红线);provide/inject 生态等三方插件真出现再长
(cordis-next 的 manifest 面已预留字段位)。拒绝:把引擎搬上 fiber;
让插件互建私有依赖通道(要 seam 就走 catalog 明面登记)。

## Failure signals

- `ctx.plugin()` 返回值不 await → async apply 的 reject 被吞,假 active。
- patch 行写整行 module/config → 增量语义下只有 .disabled 被读,其余静默失效。
- CORE_PLUGINS 与 profile core:true 双表只改一处 → 闸与标记漂移。
- 新插件 inject 一个不存在的服务名 → degraded(不崩),但功能面悄悄缺席;`_kernel`/list() 是唯一自证面。
- 插件 import 另一个插件文件当库用 → fiber 边界干净但模块层漏(domain-map §2.7,_shared/ 才是共享件该住的地方)。

## Relationships without merger

- frontend-microkernel:同一 cordis 语义的前端微内核实现(八槽+水合);
  /ui/contrib 是两卷之间的线。
- dev-diagnostics:degraded/failed/plugin 事件经 diag-bus 进观测面,
  `_kernel` 自证端点在 utopinn-diag。
- sandboxed-card-apps:th 插件是 CardApp postMessage 桥的后端(协议面样本)。
