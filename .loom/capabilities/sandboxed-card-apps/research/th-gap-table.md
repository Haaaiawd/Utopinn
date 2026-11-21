# TavernHelper API 面对照表(TASK-049)

数据源:
- API 面清单:`./tavern-helper-api-surface.md` §API 面清单(L15-23)
- server 实现:`apps/server/src/plugins/utopinn-th.js` METHODS(L238-,11+10 法;event 家族 L350-466,信箱/影子 L137-236)
- host T0:`packages/api-client/src/panel-t0.ts` handle(事件段 L229-281;订阅记账 L49-65;影子转发 L70-77)
- TH shim:`packages/panel-shim/src/runtime.js` api(L110-,事件族 L135-186)
- ctx shim:`packages/panel-shim/src/ctx-shim.js`(ctx.eventOn 家族 L229-295;th.* 未授权回落 ctx.on)
- 协议面:`packages/protocol/src/panels.ts` PANEL_METHODS_TH(L53-96)/ T0(L101-127)
- 宿主泵:`apps/web/src/cardapp/ctxHost.ts` diffAndEmitChat/emitTh/pollEventLog/recordThEvent/runCardGeneration;`apps/cli/cardapp-host.mjs` 同名件

标注:**实**=已实现的语义;**影**=本格落的影子注册/信箱;**缺**=未实现;**降**=接受降级(生态不兼容面);**宿主**=宿主侧记账(不过 server)。

## 事件家族(本格落地)

| TH 法 | 卡内 shim | 桥方法 | 宿主 | server 语义 | 状态 |
|---|---|---|---|---|---|
| eventOn | runtime.js:135 本地注册+上报(realm lid);ctx-shim:229 | th.eventOn(T0) | panel-t0 subscribed(lid 集) | th.events 影子注册(L350) | **实**(本格前)/影子(本格) |
| eventOnce | runtime.js:140 once 位;ctx-shim:236 | th.eventOnce(T0) | 同上 | 影子 once 位(L361) | **实**/影子 |
| eventEmit | runtime.js:176 dispatchLocal+上报;ctx-shim:281 | th.eventEmit(T0) | emitToPanels→mailbox | 信箱日志+once 影子消费(L442) | **实**/信箱(本格) |
| eventEmitAndWait | runtime.js:181;ctx-shim:288 | th.eventEmitAndWait(T0) | 同上 | 同 eventEmit 转发(L457,不真等卡 listener) | **实**/信箱 |
| eventMakeLast | runtime.js:145;ctx-shim:243 | th.eventMakeLast(T0) | T0 转发 | priority→尾(L372) | **本格新增** |
| eventMakeFirst | runtime.js:150;ctx-shim:249 | th.eventMakeFirst(T0) | T0 转发 | priority→首(L382) | **本格新增** |
| eventRemoveListener | runtime.js:155;ctx-shim:255 | th.eventRemoveListener(T0) | subscribed−(by lid) | 影子摘除(L392) | **实**/影子 |
| eventClearEvent | runtime.js:160;ctx-shim:263 | th.eventClearEvent(T0) | T0 带本 mount lids+过滤同步 | 影子清 event(带 lids 只清本 mount;L409) | **本格新增** |
| eventClearListener | runtime.js:164;ctx-shim:269 | th.eventClearListener(T0) | T0 转发+过滤同步 | 影子清 listener_ids(L421) | **本格新增** |
| eventClearAll | runtime.js:172;ctx-shim:277 | th.eventClearAll(T0) | T0 带全 lids+过滤同步 | 影子清空(带 lids 只清本 mount;L432) | **本格新增** |
| (getEventLog) | — | th.getEventLog | 宿主轮询消费(ctxHost.pollEventLog / cardapp-host.pollMailbox) | 信箱读 since 分页(L461) | **本格新增**(非 TH 面,宿主泵协议) |

事件名:TH 双命名空间——`tavern_events.*` 值是小写蛇形('message_received'),
`iframe_events.*` 值是大写蛇形('GENERATION_ENDED')。**不做大小写归一**——
两族同名不同义,注册表/信箱按字面存(utopinn-th.js 注释锚定)。

宿主→卡通道:ctxHost.diffAndEmitChat / cardapp-host.diffAndEmitChat 楼层 diff
→ emitTh(name,args) → subscribed 过滤 → PanelPush 'th.event' {name,args} →
shim dispatchLocal。本格扩展:message_edited/message_updated/mes 内容 diff、
swipe_id diff→message_swiped、任何 diff→chat_changed;生成生命周期
(generation_started/ended/stopped)+ 卡 eventEmit 经 mailbox 扇出到同聊其它
mount(origin 去重,不回流本 mount)。

## 变量家族(已实)

| TH 法 | 位置 | 状态 |
|---|---|---|
| getVariables | server:239 + T0:135 | **实**(chat/global/message 三域;server 另有 lodash path 读;T0 另有 script 域) |
| replaceVariables | server:243 + T0:137 | **实** |
| insertOrAssignVariables | server:253 + T0:140 | **实**(server 支持路径合写) |
| insertVariables | T0:143 | **实**(existing wins) |
| updateVariablesWith | T0:146(shim 本地求值 ship result) | **实** |
| deleteVariable | server:262 + T0:152 | **实** |
| getMvuData / replaceMvuData | — | **缺**(T1 列名在 protocol:87-88;语义=变量面薄封,下格随消息写一起做) |

## 消息家族

| TH 法 | 位置 | 状态 |
|---|---|---|
| getChatMessages | server:269(start/end 形)+ T0:163(TH range 形) | **实**(两形并存——server start/end;T0 range/role/hide/swipes) |
| getLastMessageId | server:323 + T0:174 | **实** |
| getCurrentMessageId | server:328 + T0:178 | **实**(语义=数组下标/挂载楼层) |
| setChatMessages | —(protocol T1:76) | **缺**(消息写面,下格) |
| createChatMessages | —(T1:77) | **缺** |
| deleteChatMessages | —(T1:78) | **缺** |
| rotateChatMessages | — | **缺**(未列 protocol;同下格消息写面) |
| setChatMessage | — | **缺**(单楼写,下格) |
| refreshOneMessage | —(T1:79) | **缺**(宿主重渲信号,随 displayed_message) |
| formatAsDisplayedMessage | —(T1:85) | **缺**(displayed_message 渲染本体,下格结构项) |
| retrieveDisplayedMessage | — | **缺**(同上) |

## 注入提示词(已实)

| TH 法 | 位置 | 状态 |
|---|---|---|
| injectPrompts | T0:182(chat_state th.inject) | **实** |
| uninjectPrompts | T0:192 | **实** |

## 全局/身份(已实+缺)

| TH 法 | 位置 | 状态 |
|---|---|---|
| waitGlobalInitialized | T0:220 | **实** |
| initializeGlobal | T0:224 | **实** |
| getCharacter | T0:228 + server:311 | **实** |
| getCurrentCharacterName | T0:230 + server:317 | **实** |
| getEmbeddedScripts | server:333 | **实** |
| getCharacterNames / getCharacterIds | — | **缺**(角色清单面,小) |
| createOrReplaceCharacter / deleteCharacter / replaceCharacter / updateCharacterWith | — | **缺**(角色写面;写卡目录,风险面单列下格) |
| getCurrentCharacter*(其余成员) | — | **缺** |

## 世界书家族(缺,下格)

`lorebook.ts + lorebook_entry.ts` 全套(get/create/update/delete book 与 entry):
protocol 已列 th.getLorebook / th.getLorebookEntries / th.setLorebookEntries(T1:80-82),
server 尚无。**缺**——走 worldInfo repo + 五层来源模型,下格。

## 正则家族(缺,下格)

`tavern_regex.ts`(读/写/执行 regex 脚本)。**缺**——server 侧有
utopinn-regex.js 管线可锚(TH 面 = regex 脚本 CRUD+run,下格)。

## 生成家族(缺,下格)

`function/generate/*`(触发/停止/流式回调)。protocol 已列
th.generate / th.stopGeneration(T1:83-84);server 有 /api/utopinn/generate
job 面可锚。**缺**(卡→生成+流式回推;本格只落生命周期事件通道)。

## 其他

| TH 法 | 状态 |
|---|---|
| triggerSlash | **实**(server:297,共享 stscript-env) |
| substituteMacros | **缺**(T1:86;core 宏面可锚) |
| displayed_message 渲染本体 | **缺**(结构项:卡 HTML 渲进消息位 iframe;TASK-049 done_when 第五条,下格) |
| audio | **降**(TH 音效面,宿主 chrome 生态,不追) |
| presets / personas / import_raw / render_character | **降**(宿主管理面,卡 API 语境不成立) |
| third_party_message/script.html、predefine.js、_eventOnButton | **缺**(iframe 基建;与 displayed_message 同属下格) |

## 汇总

- 研究档 ~50 法面:本格前 **实 11(server)+ 8(host T0 独有)≈ 19/50**。
- 本格落地:事件家族 10 法全齐(shim 本地语义 + T0 记账 + server 影子/信箱),
  宿主→卡通道真事件(message_received/edited/swipe/chat_changed/generation_*)。
- 下格:消息写面(6)、世界书(3+)、正则、生成(2)、宏、MVU 薄封、
  角色写/清单面、displayed_message+iframe 基建。
