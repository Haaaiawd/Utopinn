# 聊天长列表与流式 Markdown 渲染

Source: LegendList v3 官方 guides(含 Chat Interfaces 专章)、Shopify FlashList v2 工程博客、software-mansion-labs react-native-streamdown README、JoaoPauloCMarra nitro-markdown README

聊天消息列表是 RN 里最难做对的组件:动态高度、双向分页(向前翻历史)、流式追加、inverted hack。LegendList v3 把这套做成一等公民:`initialScrollAtEnd`、`maintainScrollAtEnd.on.dataAppend`(只在追加时跟随,prepend/编辑不触发)、`maintainVisibleContentPosition`、双向 onStartReached/onEndReached、anchoredEndSpace——几乎是"AI 聊天列表"特化。FlashList v2(Shopify 重写的回收式列表,新架构限定,JS-only)是更通用的备选,`maintainVisibleContentPosition` 也有,但聊天特化原语少于 LegendList。

流式 Markdown 的难点是"不完整 token 输入"和"JS 线程卡顿"。react-native-streamdown(SWM labs)基于 enriched-markdown + remend + worklets Bundle Mode:不完整 markdown 后台线程解析,逐 token 更新不抖,原生渲染,LaTeX 也支持。nitro-markdown 走 C++(md4c over JSI)更快但更重。两者都需要 dev build(不适用 Expo Go——与 SDK 基线结论一致)。降级方案:静态 enriched-markdown 或 markdown-it 自渲,流式期间显示纯文本、完成后整渲。
