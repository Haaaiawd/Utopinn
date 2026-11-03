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

## 3. Profile/Bundle 组合(对齐 DshProfileManifest)

DSH:profile 目录 manifest 声明 `bundles[]` 有序列表,launcher 按序装载。
**我们**:`profile.yaml`(或 settings)声明 `plugins[]` 有序装载列表;
内置插件是默认 profile 的组成,用户/部署可加第三方插件或 overlay 替换。
`no-hmr` vs HMR 语义照搬:服务端插件默认重启生效,HMR 作为 dev flag。

Manifest 落点(DSH 是 `package.json.dsh` 字段):
```yaml
# 插件包 package.json
uberge:
  plugin: true
  engines: { uberge: ">=0.1.0" }
  platforms: [node]          # 可选
  permissions: [network, fs] # 声明式权限,内核强制(比 cordis 严,ST 生态需要)
```

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
