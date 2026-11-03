# 插件核心架构:内核薄、插件即产品(DSH 形态)

- Kind: system
- Status: draft
- 方向来源:用户拍板——"像 dsh 那样子,以插件为核心,而且插件感觉要好"

## 1. 定位

DSH 的形态:内核只做 agent 运行时,酒馆本身是 `dsh plugin` 装的插件,
其他能力(手机访问/认证/语音)作为正交插件组合。
**我们采用同一形态**:内核不认识"世界书/角色卡/正则"——这些全是插件。
区别:我们的"内容侧插件生态"= 卡本身(卡脚本/世界书/正则),
"能力侧插件生态"= 服务端插件。两个面都正式化。

## 2. 边界划分

**内核(薄,apps/server 主干)**:
- 存储引擎/Repo、用户/鉴权、settings、HTTP+WS 传输
- 生成编排骨架(任务排队/取消/持久化——不含 prompt 组装语义)
- 插件宿主:manifest 生命周期、服务注册表、管线钩子、权限强制

**内置插件(产品本体)**:
| 插件 | 职责 | 依赖包 |
|---|---|---|
| `tavern-core` | WI/正则/宏/prompt 组装管线——注册 `generation.build` 服务 | `@uberge/core` |
| `tavern-formats` | 卡/世界书/聊天导入导出 + analyzeCardRuntime | `@uberge/formats` |
| `card-runtime` | TH-shim 分发、CardApp 资产、面板桥端点、CDN 代理 | `@uberge/panel-shim` |
| `tavern-presets` | 预设/采样参数管理 | — |

**第三方插件**:主题、TTS、翻译、认证、移动端辅助、调试工具……
装第三方 ST 扩展仍不支持(D-003),但**我们的插件面让社区能直接写 Uberge 插件**。

**关键拆分**:`packages/*` 保持纯库(可测、无 fs/DOM);
插件是库到内核的**薄适配层**。脑子和插头分开——这是整个形态能成立的前提。

## 3. 插件 API(比 ST 模型要好的地方)

ST/Luker 契约是裸 `{info, init(router), exit}`——插件拿到整台服务器,
无权限边界、无服务发现、无管线钩子。我们升级为:

```ts
interface PluginManifest {
  id: string;            // 命名空间,路由挂载点 /api/plugins/<id>
  name: string; version: string;
  engines: { uberge: string };          // 内核版本兼容声明
  permissions: Permission[];            // 声明式:network/fs/users/chatWrite/...
  services?: string[];                  // 本插件提供的服务名
  requires?: string[];                  // 依赖的服务名(缺失→明确降级,不静默)
}

interface UbergePlugin {
  manifest: PluginManifest;
  init(ctx: PluginContext): void | Promise<void>;
  exit?(): void | Promise<void>;
}

interface PluginContext {
  router: express.Router;               // 挂 /api/plugins/<id>/*,带权限中间件
  events: EventBus;                     // 服务端+生成生命周期事件
  hooks: PipelineHooks;                 // 管线钩子注册(见 §4)
  services: ServiceRegistry;            // register/get,跨插件服务发现
  storage: ScopedStorage;               // 每插件数据目录 + settings 命名空间
  log: Logger;
}
```

**服务注册表是核心**:插件暴露命名服务,其他插件按名消费——
`tavern-core` 注册 `promptBuilder`/`variableStore`;`card-runtime` 消费
`chatState`/`injectedPrompts`;第三方插件可注册自己的 settle 步骤、
替代 WI 引擎、加导出格式。**"插件生态强于我们本身"就发生在这层**。

**权限模型**:manifest 声明,内核强制(网络出口/fs 范围/用户数据)。
ST 插件无此约束——这是我们的改进口(卡代码不可信的经验同源)。

## 4. 管线钩子(生成管线的插件接缝)

```
generation.preBuild   → 插件可改写/追加 prompt 段(injectPrompts 的消费者在这)
generation.build      → tavern-core 注册服务:产出 messages[]
generation.settle     → MVU <UpdateVariable> 解析、状态栏渲染(状态栏固化在这)
chat.messagePersisted → 楼层应用/事件推送
card.imported         → analyzeCardRuntime、世界书物化
```

DSH 的"分步生成"在这里落地:`build` 服务可以有多个 stage,
settle/candidates 都是钩子点——v1 单阶段,接口按 stage 序列设计。

## 5. 安装与 DX

- 安装源:目录/npm/git/zip(Luker plugin-loader 已有 git/npm/file,沿用)
- 版本钉:manifest engines 声明,不兼容→拒绝+明确日志
- **兼容性日志**(DSH 的 DX 好实践):装了哪些、加载成功/失败、
  哪些功能被降级——插件管理页全列出,不静默吞错
- 热重载:v2 目标;v1 重启加载,exit() 钩子必须存在
- 内置插件跟随发布版 pinned;第三方装到 `plugins/` 目录

## 6. 迁移顺序(对现有任务图的影响)

1. **现在**:把 PluginContext/ServiceRegistry 骨架立进 apps/server
   (T1 触发器、panel-shim 路由、CDN 代理都将是第一批插件消费者)
2. TASK-006/007:regex+prompt 管线先按"即将被插件化"设计接口——
   `generation.build` 服务签名今天定,插件壳后补
3. 后补:tavern-core/tavern-formats/card-runtime 逐个套上插件壳
   (纯适配工作,库不动)
4. D-005 更新:Luker 插件面保留且升级——从"兼容遗留"升为"产品主架构"

## 7. 明确不做

- 不在客户端做插件执行环境(移动端插件=服务端插件+面板内容,不跑任意 RN 代码)
- 不保证 ST 前端扩展兼容(那些是 DOM 插件,我们的客户端不是 DOM)
- 内核不放任何酒馆语义——WI/正则/卡的概念在内核层不存在

## Verification

- 插件骨架冒烟:写一个 hello 插件,manifest+router+service 注册/消费全链路
- 权限负测试:未声明 network 的插件触网→403+日志
- 服务缺失降级:requires 未满足→插件标 degraded,日志写明,不启动失败
