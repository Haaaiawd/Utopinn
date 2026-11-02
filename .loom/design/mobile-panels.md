# 移动端重UI面板页:CardApp/状态栏 WebView沙箱专属页

- Kind: experience
- Status: frozen

## Responsibility in the whole

"重UI"= 卡里预设的 HTML 应用与状态面板(背包、任务卡、好感度/属性栏、交互小游戏)。在移动端它们不混进聊天流,而是收进底导航的"面板"专属页;状态持久在服务端,客户端零真相。

## Inputs, outputs, and boundaries

- 输入:当前激活聊天的角色卡(CardApp 声明:`data.extensions.card_app {enabled, entry}` + 服务端每角色 CardApp 目录代码)、regex 产出的状态栏 HTML、chat_state/variables
- 输出:面板页中可交互的 app 实例;app 的读写经 API 落到服务端
- 边界:app 代码不可信(社区卡)——必须沙箱;不做卡片代码审计责任

## Components and control flow

- 底导航:`对话` / `角色` / `面板` / `我的`
- 面板页 = 当前聊天的 CardApp 聚合。每个 app 一个 `react-native-webview` 沙箱容器,注入最小 DOM 壳 + `ctx` 桥
- **ctx 桥**:WebView 内 `ctx.*` 调用 → postMessage → RN 侧 → `@uberge/api-client` → 服务端(`/api/chats/state/*`、`/api/worldinfo/*`、事件订阅经 WS)。API 面与 Luker web 端 CardApp ctx 一一对应,同一份卡片代码两端可跑
- **老卡兼容**:非 CardApp 的正则状态栏(服务端正则管线产出的 HTML)同样注入 WebView 壳渲染;需要一层 shim 兜住常见 ST 全局(`getContext()`、`eventSource`、jQuery 片段),戳不动的降级为静态渲染
- 事件:服务端 WS 推 `chat.state.changed`/`message.*` → RN → 注入 WebView `eventSource` 派发

## Data and state

- 面板状态:服务端 chat_state sidecar(`<chat>.luker-state.<ns>.json`)+ `chat_metadata.variables`,经 api-client 读写;无设备端真相
- CardApp 代码资产:服务端每角色目录,按 ETag/版本缓存到设备(仅缓存,可清)

## Interfaces and dependencies

- react-native-webview(已在 apps/mobile 依赖)
- @uberge/api-client、@uberge/protocol(ctx 方法签名、事件名)
- 服务端 CardApp 资产路由 + state API(Luker 已有)

## Failure, safety, and recovery

- WebView 崩溃/JS 异常 → 单卡片容器降级为占位卡(灰显+重载按钮),不拖垮面板页
- postMessage 消息白名单校验;webview `originWhitelist`/`javaScriptEnabled` 限定;不允许 app 代码直接触网(经桥)
- 卡片无面板 → 面板页空态(可列出该卡绑定世界书做只读浏览)

## Implementation constraints

- 首版目标:能跑通 Luker docs 自带 CardApp 示例 + 归墟(GuiXu)级复杂度的交互卡
- 不追求移动端原生重绘面板——WebView 保兼容,原生渲染是以后的锦上添花
- 选型已固化(见 capabilities/mobile-app-stack + sandboxed-card-apps):expo-router 底导航、LegendList 聊天列表、TanStack Query+WS ticket、streamdown 流式 markdown、NativeWind 共享 tokens;沙箱=独立 WebView+nonce 白名单桥+CSP+shim 降级

## Verification strategy

- 用 `tests/corpus/cards/` 中的 CardApp 卡与状态栏卡做设备端冒烟:挂载→状态读写→切 swipe 后状态回放正确
- 桥 API 与 web ctx 的契约测试(方法名/签名/异步语义一致)

## Related documents and capabilities

- core-engine(regex/变量管线产出面板数据)
- generation-api(事件推送通道)
- ref/Luker docs/features/{cardapp,state-system}.md(既有规范)
- ref/cards/GuiXu(参考卡)
