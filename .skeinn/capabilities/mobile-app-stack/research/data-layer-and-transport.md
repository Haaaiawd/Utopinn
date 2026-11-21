# 服务端状态层与实时传输

Source: TanStack Query 官方 React Native 文档、tanstackship "TanStack Query + WebSocket real-time" 模式文、Neon Realtime RN 注意点(Origin header)、OWASP/RN SSE 已知限制(RN fetch 流式分块不可靠)

标准答案分层清晰:服务端状态交给 TanStack Query(缓存/去重/refetch 生命周期),RN 侧两个适配点官方文档写明——`onlineManager` 接 NetInfo 做断网感知、`focusManager` 接 AppState 做回前台刷新。WebSocket 事件不请求、直接 `queryClient.setQueryData` 写缓存——这是有文档依据的实时模式,正好对接 Luker 已有的 ws-ticket/generation-job 体系:WS 推 delta → 写进 chat 查询缓存 → UI 只读缓存。

流式通道上,RN fetch 的 ReadableStream 分块行为两端不一致是社区共识(SSE 在 RN 基本要 react-native-sse 之类的原生模块兜底),而 RN 自带 WebSocket 稳定且支持自定义 header/子协议(Luker ws-ticket 用 `sec-websocket-protocol` 传 ticket,RN 可用第三参 headers)。结论:生成流式走 WS,不走 SSE。密钥/凭据:expo-secure-store;高频小对象缓存:MMKV(比 AsyncStorage 快);仅缓存可丢数据,真相永远在服务端。
