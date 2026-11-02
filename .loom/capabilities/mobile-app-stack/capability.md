# React Native/Expo 客户端技术栈选型(导航/数据层/列表/Markdown/WS/存储/WebView)

> One dossier covers one recognizable professional field.

## Field identity and boundary

React Native/Expo 应用工程选型:SDK 基线、导航、服务端状态、长列表、Markdown/流式渲染、实时通道、本地存储、组件样式层。UI 视觉语言选型与 web-spa-stack 共享(Tailwind tokens),卡片代码沙箱细节属 sandboxed-card-apps。

## Project scenario

薄客户端聊天App:SDK58+dev build;expo-router;TanStack Query+WS ticket流式;LegendList v3;streamdown;NativeWind+共享tokens

## Decision tree

### C1: Expo SDK 与运行时基线

- entry_when: 初始化 apps/mobile
- options:
  - A: SDK 58 + New Architecture + development build → leads_to: C2
  - B: 旧 SDK + Expo Go → leads_to: 死路(WebView/工作线程不可用)
- decide_by: WebView(worklets)需求是否进 Expo Go——进不了,只能 dev build
- source: research/expo-sdk-baseline.md
- counterexample: 若首版只做"纯聊天无面板",Expo Go 能跑——但 CardApp 是核心需求,此分支不成立
- output: expo@^58 + dev-client 构建流程(EAS 或本地 prebuild)

### C2: 导航

- entry_when: 建路由骨架
- options:
  - A: expo-router(文件式,native-tabs)→ leads_to: C3
  - B: React Navigation 手写 → leads_to: C3
- decide_by: 是否以 app 内结构为主且要 deep link/typed routes——是则 A
- source: research/navigation-and-structure.md
- counterexample: 需要复杂导航状态持久化/恢复现场时选 B
- output: expo-router,底导航 = 对话/角色/面板/我的

### C3: 服务端状态层与实时通道

- entry_when: 接 api-client
- options:
  - A: TanStack Query + WS 事件直写 queryClient.setQueryData → leads_to: C4
  - B: 自写 store + 轮询 → leads_to: 不推荐
- decide_by: 缓存/去重/生命周期是否要现成轮子——要则 A
- source: research/data-layer-and-transport.md
- counterexample: 数据量极小(单屏无列表)时可裸 fetch——本项目聊天/角色/面板全是列表,不成立
- output: TanStack Query + NetInfo onlineManager + AppState focusManager;生成流式走 WS ticket(非 SSE);凭据 expo-secure-store;读缓存 MMKV

### C4: 聊天长列表

- entry_when: 聊天页实现
- options:
  - A: LegendList v3(聊天原语:initialScrollAtEnd/maintainScrollAtEnd.on.dataAppend/双向锚定)→ leads_to: C5
  - B: FlashList v2 / FlatList inverted → leads_to: C5
- decide_by: 是否需要双向分页+流式追加+跟随最新——是则 A
- source: research/list-and-markdown.md
- counterexample: 若消息体极重(每条含复杂 CardApp)超回收策略,退回 FlashList v2 细调
- output: LegendList v3

### C5: Markdown 流式渲染

- entry_when: 消息体渲染
- options:
  - A: react-native-streamdown(不完整 md 后台线程解析)→ leads_to: C6
  - B: nitro-markdown(C++ JSI)/ enriched-markdown 静态 → leads_to: C6
- decide_by: 流式 token 渲染质量与 JS 线程占用——A 专为此生
- source: research/list-and-markdown.md
- counterexample: 若卡性能瓶颈在原生桥接而非解析,nitro 更快;若只要静态渲染,B 更轻
- output: streamdown 主选,enriched-markdown 静态兜底

### C6: 组件与样式层(与 web 同语言)

- entry_when: 立 UI 骨架
- options:
  - A: NativeWind + gluestack-ui/RN Reusables(共享 Tailwind tokens)→ leads_to: 输出
  - B: Tamagui(真 universal)→ leads_to: 输出
- decide_by: 是否与 web(shadcn/Tailwind)共享设计语言——是则 A;若要"一份组件真两端跑"则 B
- source: research/shared-design-language.md
- counterexample: 若最终决定 web 也上 Tamagui,则 B 反超
- output: NativeWind + 组件层(gluestack v4+/Reusables),tokens 与 web 同步
