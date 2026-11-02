# 酒馆助手(JS-Slash-Runner / TavernHelper)调研

来源:`ref/extensions/JS-Slash-Runner`(github.com/N0VI028/JS-Slash-Runner,depth-1 clone)
定位:中文 ST 社区事实标准扩展——多数"前端交互卡"的 HTML/JS 实际跑在它建的 iframe 沙箱里,调 `TavernHelper` 全局 API。

## 许可与并入结论

- **License: PolyForm NonCommercial 1.0.0** — 仅限非商业。不可把代码并入产品分发;
  且它的工作方式是"酒馆前端插件",hook jQuery 前端全局,与我们新 SPA/移动端架构不匹配。
- **结论:不并入代码。改为 API 面兼容**:在自家沙箱 shim 里实现 TavernHelper 同名全局,
  让面向它写的卡不改代码就能跑。文档化 API 的再实现不受其许可限制。

## API 面清单(shim 模拟目标,按家族)

- 事件:`eventOn / eventEmit / eventEmitAndWait / eventOnce / eventMakeLast / eventMakeFirst / eventRemoveListener / eventClearEvent / eventClearListener / eventClearAll`
- 变量:`getVariables / replaceVariables / insertOrAssignVariables / deleteVariable`(chat/global 域,即 MVU 变量通路)
- 消息:`getChatMessages / setChatMessages / createChatMessages / deleteChatMessages / rotateChatMessages / setChatMessage / formatAsDisplayedMessage / retrieveDisplayedMessage`
- 角色:`getCharacterNames/Ids / getCurrentCharacter* / getCharacter / createOrReplaceCharacter / deleteCharacter / replaceCharacter / updateCharacterWith`
- 世界书:`lorebook.ts + lorebook_entry.ts`(get/create/update/delete lorebook 与 entry 全套)
- 正则:`tavern_regex.ts`(读/写/执行 regex 脚本)
- 生成:`function/generate/*`(触发/停止生成、流式回调)
- 其他:`triggerSlash`(执行 STscript)、macros、audio、presets、personas、import_raw、render_character、displayed_message(把卡 HTML 渲染进消息 iframe——"渲染"本体)
- iframe 基建:`third_party_message.html / third_party_script.html / predefine.js`(卡代码的宿主页)、按钮事件 `_eventOnButton`

## 与 Luker CardApp 的关系

两套 API 面并存:
- Luker CardApp:`init(ctx)` 拿上下文对象,服务端 namespace state 已支持
- TavernHelper:无 init 生命周期,直接全局函数 + iframe message 事件,变量/事件机制是"MVU 式"

兼容策略:面板页同一个 WebView 容器里,shim 层按卡声明选择注入面——`card_app` 声明 → Luker ctx 桥;
否则注入 TavernHelper 兼容全局,经同一个 nonce+白名单 postMessage 桥打到宿主。两套面共用底层桥,
方法名映射到 PANEL_METHODS 白名单(TavernHelper 面需要在白名单补:variables/triggerSlash/getChatMessages 等)。

## 对协议包的影响

`panels.ts` 的 PANEL_METHODS 目前按 CardApp ctx 命名;需要扩成"方法面 v2"——
按 TavernHelper 清单补(variables 系列、chatMessages 系列、lorebook 系列、generate、triggerSlash)。
协议修订属 TASK-009 范围内的工作,不破坏现有结构(数组扩展即可)。
