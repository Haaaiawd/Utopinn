# 插件核心架构:仿 DSH/Cordis 骨架,酒馆生态第一

- Kind: system
- Status: draft(v2:改为直接仿 DSH Cordis 骨架)
- 方向来源:用户拍板——"骨架可以很直接地仿照 DSH;遵从酒馆生态永远是第一要位"

## 0. 第一约束(凌驾于本设计一切条目之上)

**酒馆生态兼容永远是第一要位。** 插件形态的选择、内核边界的划定、
任何架构"优雅性"只要和"跑通真实酒馆卡/世界书/正则/MVU/TH/预设"冲突,
一律让位。骨架仿 DSH,语义服从 ST。

## 1. 形态:全插件内核(Cordis 语义)

DSH = "all-plugin Cordis agent harness"——内核只做 Context/事件/注册表/
服务解析,一切能力是插件。我们直接仿照这个骨架:

- **Kernel**:cordis 式 Context(fiber/effect/disposer)、事件总线、
  服务注册表、profile 装载器。不认识 WI/卡/正则——酒馆语义零存在
- **内置插件**:`tavern-core`(WI/宏/正则/prompt 组装)、`tavern-formats`
  (导入导出+analyzeCardRuntime)、`card-runtime`(TH-shim/CardApp/CDN代理)、
  `tavern-presets`(预设管理)
- **第三方插件**:走同一契约,manifest+inject+apply

## 2. 插件契约(直接映射 Cordis)

DSH 实证契约(`packages/acp/acp/src/index.ts` 等):
```ts
// 函数插件形态——命名导出,无 default
export const name = 'acp';
export const inject = ['agents', 'llm', 'sessionPersistence'];  // 声明服务注入
export const Config = z.object({...});                          // cordis.yml 校验
export function apply(ctx: Context, config: Config): void {
    ctx.effect(() => cleanup, 'label');   // 所有注册都是 effect,带 disposer
    ctx.on('event', handler);
}

// 服务插件形态——default export Service 类
export default class PromptBuilder extends Service { ... }
```

**我们的一字不改契约**:
```ts
// packages/server-plugin 契约(对插件作者)
export interface UbergePlugin {
  name: string;
  inject?: string[];           // 声明依赖的服务名;缺失→启动失败(显式)
  optional?: string[];         // 可选依赖,ctx.get() 取用
  Config?: ZodSchema;          // 配置 schema,uber.yaml 校验
  apply(ctx: PluginContext, config: unknown): void | Promise<void>;
}
```

`PluginContext` 提供(对齐 cordis):
- `ctx.effect(fn, label)` — 注册带 disposer 的副作用(HMR/卸载的核心)
- `ctx.on(event, handler)` / `ctx.emit` — 事件总线
- `ctx.<name>` — 已 inject 的服务代理;`ctx.get(name)` — 可选服务
- `ctx.route(prefix, router)` — HTTP 端点(等效 `app.use`)
- `ctx.storage` — 插件数据命名空间(chat_state ns + 每插件目录)
- `ctx.log` — 命名空间化日志
- `ctx.config` — 校验过的插件配置

## 3. 组合机制:config 行 + 补丁层(对齐 DSH,不只是插件列表)

DSH 的组合语义(architecture.md §Profiles):profile = 有序 bundle 层 +
`cordis.patch.yml` + home patch + `--patch` overlay;**每一层把补丁行按 id
整体替换或插入**——任何一层都能换掉下面任何一行。

**我们的对等物**:
```yaml
# profile.yaml(内核唯一直接读的东西)
plugins:
  - id: tavern-core
    config: { recursive: true, budget: 25 }
  - id: tavern-formats
  - id: card-runtime
    config: { floorDepth: 8 }
  - id: tavern-presets
```
- **bundle** = 插件包(代码 + 它默认挂载的补丁行),`package.json.uberge.plugin`
  声明 manifest
- **patch** = 用户对行的替换:`- id: tavern-core\n  disabled: true` +
  `- id: my-wi-engine\n  provides: promptBuilder` —— 替换 WI 引擎不需要分叉
- 层序:内置 bundles → profile patch → 部署 patch → `--patch` CLI
- HMR:dev flag,默认重启生效(同 DSH `no-hmr` 语义)
- `pnpm uberge --profile tavern --dump-config` 能 dump 出实际装载树(DSH 同款调试)

## 3b. 事件三域 + dispatch 模式(架构上最容易做错的一层)

DSH 事件按域分(architecture.md §Events),我们照搬:

| 域 | 性质 | 我们的事件 |
|---|---|---|
| **持久** | 进聊天/状态日志,重启可重建 | `chat/messagePersisted`、`chat/metadataChanged`、`generation/persisted` |
| **实时** | 生成中的拦截点,不持久 | `generation/preBuild`(**waterfall**)、`generation/stream`、`generation/preStep` |
| **能力** | seam 策略/适配器,不进口子 | `cdn/request`、`panel/mount`、`fs/access` |

**dispatch 模式必须显式**(cordis 语义):
- **waterfall**:监听器签名 `(acc, next)`,必须 `next(acc)` 才传递——
  `generation.preBuild`(prompt 组装链)、`settle`(变量结算链)
- **serial**:按序执行无 next——`chat/messagePersisted` 副作用
- **broadcast**:并行,无返回值语义——生命周期通知

写错域或写错模式 = 架构 bug(persist 事件不能是 waterfall,
preBuild 不能是 broadcast——第三方监听器改写 prompt 需要链式语义)。

## 3c. "Model-visible means logged"(不变式)

DSH 硬约定:到达模型的每个请求必须能从日志重建。**我们的版本**:
- 发给 LLM 的 messages[] 必须可从 `chat文件 + chat_metadata + 卡 +
  chat_state` 重建(golden-diff 就是它的可执行形式)
- 新的模型可见输入必须先进持久存储:`th.inject` 已落 chat_state ✓
- 任何让 prompt 依赖易失内存的插件写法 = 设计缺陷

## 3d. Session Projection 机制(MVU 的正确模型)

DSH `ctx.sessionProjections`:注册 fold 单元,把持久事件折成视图。
**MVU 的正确模型就是 projection**:`stat_data` = 对整个聊天日志 fold
`<UpdateVariable>` 块得到的当前态——不是"解析最近一块"而是"折叠全量"。
这解释了为什么 MVU 能随时隐藏/删除旧楼层(变量不依赖楼层本身)。
`chatState` seam 提供 `registerProjection(id, fold)` 供插件注册视图
(MVU/状态栏模板/任务卡都是 projection)。

## 4. 能力接缝(Capability Seam)三元组

DSH 硬约定:Seam = Service Definition / Provider / Consumer,三个角色必须齐备。
**我们的 seam 清单**(酒馆语义全在这里,内核零感知):

| Seam | Definition(谁定契约) | Provider | Consumer |
|---|---|---|---|
| `promptBuilder` | protocol+tavern-core | tavern-core | generation 管线 |
| `variableStore` | core | tavern-core | card-runtime/MVU settle |
| `injectedPrompts` | protocol | card-runtime | tavern-core(WI scan buffer) |
| `chatState` | protocol | 内核 | card-runtime/tavern-core |
| `cardAssets` | formats | tavern-formats | card-runtime(资产服务) |
| `cdnProxy` | card-runtime | card-runtime | panel WebView CSP |
| `panelBridge` | protocol | card-runtime | RN/Web 宿主 |
| `settle` | core | tavern-core(MVU 解析器) | generation persist |

**seam 的意义**:第三方插件可注册 Provider 替换实现(比如更好的 WI 引擎、
新的 settle 步骤)——"插件生态强于我们本身"的机制位。

## 4b. "No privileged core"——生成编排器本身也是插件

DSH 把 agent-loop、session log、model adapter 全做成插件——**没有特权核心
可以 patch,你通过在旁边挂插件来扩展**。我们的映射:

- `ctx.generation`(任务编排:排队/取消/持久化)注册为 seam provider——
  tavern-core 实现默认,第三方可挂替代编排器
- `ctx.tools`-equivalent 暂不需要(我们无工具循环)
- 每层都可 patch:WI 引擎、settle 步骤、状态栏渲染、CDN 策略

## 4c. 扩展速查表(对齐 architecture.md "Where new behavior goes")

| 目标 | 机制 |
|---|---|
| 换 WI/匹配引擎 | patch `tavern-core` 行 → 注册替代 `promptBuilder` provider |
| 加 settle 步骤 | 注册 `settle` waterfall 监听器(MVU 解析器就是一个) |
| 加注入源 | `injectedPrompts` seam 写入(经 panel-bridge 或直接) |
| 加导出格式 | `cardAssets` 注册 exporter |
| 拦截/改写 prompt | `generation.preBuild` waterfall 监听器(必须 next) |
| 观察生成流 | `generation/stream` 实时事件订阅 |
| 加面板资产 | `cardAssets` + `cdnProxy` 白名单行 |
| 加持久状态 | `chatState` projection 注册(fold 语义,不是裸写) |
| 加角色卡能力检测 | `tavern-formats` 的 analyzeCardRuntime 信号扩展 |
| 换生成编排 | patch `generation` provider(整编排器都是 seam) |

## 5. 迁移顺序(任务图对齐,不返工)

1. **本步**:写 `PluginContext`/`Registry`/loader 骨架 + hello 插件冒烟
   (T1 触发器、panel-shim、CDN 代理是第一批消费者)
2. TASK-006/007:regex/prompt 管线接口按 seam 签名设计(`promptBuilder`
   服务今天定形,tavern-core 插件壳后补)
3. tavern-* 逐个套壳(纯适配,packages/* 纯库不动)
4. D-005→D-009:Luker 插件面保留并升级为产品主架构

## 6. 明确不做

- 不引入 cordis 本体——契约仿照,实现自写(内核几十行核心就够,
  不为 IoC 框架背依赖)
- 客户端不跑插件代码(移动端插件=服务端插件+面板内容)
- 不保证 ST 前端 DOM 扩展兼容(D-003)
- 酒馆语义不进内核:kernel 代码里出现 `worldInfo`/`character` 即设计缺陷

## Verification

- hello 插件:inject 声明缺失→启动失败;ctx.effect 清理在 exit 时执行
- seam 替换测试:注册第二个 `promptBuilder` provider 可被消费者使用
- profile 装载:有序 plugins[] 按序 apply,失败插件标 degraded 不静默
