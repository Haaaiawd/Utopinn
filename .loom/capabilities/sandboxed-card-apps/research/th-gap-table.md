# TavernHelper API 面对照表(TASK-049)

数据源:
- API 面清单:`./tavern-helper-api-surface.md` §API 面清单(L15-23)
- server 实现:`apps/server/src/plugins/utopinn-th.js` METHODS(~50 法;变量 :690-780,
  生成 :825-930 + stopGeneration :1267,消息写 :931-1051,世界书 :1052-1178,
  正则 :1179-1266,event 家族 :1292-1440,信箱/影子 L137-236)
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
| getVariables | server:249 + T0:187 | **实**(chat/global/message 三域;server 另有 lodash path 读;T0 另有 script 域) |
| replaceVariables | server:253 + T0:190 | **实** + GH#4 护栏(全量替换语义保留;丢根/stat_data 内丢根且无 force → 400 明细不写盘,force:true 放行+warnings;server 与 T0 双端同款) |
| insertOrAssignVariables | server:284 + T0:209 | **实**(TH mergeWith 深合:嵌套对象递归合、数组整替;带点键=路径合写生态扩展) |
| insertVariables | server:321 + T0:212 | **实**(defaultsDeep 深补缺,既有不动) |
| updateVariablesWith | server:340 + T0:216(shim 本地求值 ship result) | **实**(TH 本体=replaceVariables(result) 全量回写) |
| deleteVariable | server:350 + T0:221 | **实** |
| getMvuData / replaceMvuData | —(T1:87-88) | **缺**(MVU 语义薄封;message 域变量+丢根护栏已铺底,下格) |

## 消息家族

| TH 法 | 位置 | 状态 |
|---|---|---|
| getChatMessages | server:269(start/end 形)+ T0:163(TH range 形) | **实**(两形并存——server start/end;T0 range/role/hide/swipes) |
| getLastMessageId | server:323 + T0:174 | **实** |
| getCurrentMessageId | server:328 + T0:178 | **实**(语义=数组下标/挂载楼层) |
| setChatMessages | server:931(克隆体 mutate+CAS 落盘;message/data/swipes/swipe_id/is_hidden 面;越界楼静默跳过=TH no-op;信箱 message_edited+chat_changed) | **实** |
| createChatMessages | server:965(role→is_user/narrator extra.type;data→variables[0];insert_before 归一;user→message_sent、余→message_received+chat_changed 信箱) | **实** |
| deleteChatMessages | server:1005(负 id 归一;message_deleted+chat_changed) | **实** |
| rotateChatMessages | server:1021(begin/middle/end 三段旋转;chat_changed) | **实** |
| setChatMessage | server:952(单楼薄封→setChatMessages;mes 与 swipes[swipe_id] 同步=TH 语义) | **实** |
| refreshOneMessage | server:1044(信箱 refresh_message;真重渲仍随 displayed_message) | **实**(信号面) |
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

## 世界书家族(本格落地)

`lorebook.ts + lorebook_entry.ts` 全套——worldInfo repo 承载,TH 平铺视图⇄ST
条目双向往返(uid/keys/type/position/depth/order/enabled/概率系):

| TH 法 | server 位置 | 状态 |
|---|---|---|
| getLorebooks | :1052(书名清单) | **实** |
| getLorebook / getLorebookEntries | :1055/:1063(TH 视图读) | **实** |
| setLorebookEntries | :1065(uid merge,未带字段不动) | **实** |
| replaceLorebookEntries | :1080(全量替换) | **实** |
| updateLorebookEntriesWith | :1085(shim 求值 result 全量回写=TH) | **实** |
| createLorebookEntries | :1089(uid 分配+new_uids 回执) | **实** |
| deleteLorebookEntries | :1107 | **实** |
| createLorebook / deleteLorebook | :1116/:1124 | **实** |
| getChatLorebook / setChatLorebook | :1133/:1140(chat_metadata.world_info;null 解绑走 undefined 覆键) | **实** |
| getOrCreateChatLorebook | :1150 | **实** |
| getCharLorebooks | :1161(primary=ext.world∨embedded char book) | **实**(辅书槽读面;写入未列) |

## 正则家族(本格落地)

`tavern_regex.ts` 三域读/写/执行——global(settings.extension_settings.regex,
repo.update 原子 RMW)/character(卡 extensions.regex_scripts,.json 原子写
+.png writeCharacterData;.webp 拒)/preset(repo patch;'in_use' 解析未实,
传名可用):

| TH 法 | server 位置 | 状态 |
|---|---|---|
| getTavernRegexes | :1179(TH 视图往返) | **实** |
| replaceTavernRegexes | :1185 | **实** |
| updateTavernRegexesWith | :1198(result 全量=TH) | **实** |
| isCharacterTavernRegexesEnabled | :1202(character_allowed_regex 成员判定) | **实** |
| formatAsTavernRegexedString | :1216(签名 text/source字符串/destination字符串;
  脚本集=上游 allowedOnly 口径:global 恒入+character 仅放行;preset 因 in_use
  未实不入;末段再过 substituteParams=TH) | **实** |
| substituteMacros | :1260(chat/chatMetadata/globalVariables 真宏上下文) | **实** |

## 生成家族(GH#9 已实最小面)

`function/generate/*`(触发/停止/流式回调)。protocol 已列
th.generate / th.generateRaw / th.stopGeneration(T1:89-91)。
- `generate(config)` | server:825 + shim api.generate | **实**(走 quiet-generation
  同链:quietPrompt 系统注入 + skipWIAN,persist_target=none 不落楼层;
  config 面 user_input/prompt、max_tokens|responseLength、stop、trimToSentence、
  timeout_ms、quiet_name;未映射 TH 键(injects/overrides/custom_api/
  should_stream/image/tools/json_schema/max_chat_history)→ 回执 warnings 明示;
  生命周期 generation_requested/started/ended|stopped 经 th.events 信箱扇出,
  GENERATION_ENDED 负载=最终文本;失败 ok:false+diag th_generate_failed)。
- `generateRaw(config)` | server:880 + shim | **实**(prompt/user_input 直通同链;
  ordered_prompts 自定义消息序无 quiet 映射 → 诚实 unsupported)。
- `stopGeneration` | server:1267 + shim stopGeneration/stopGenerationById | **实**
  (generation_id 定点停 job→404 未命中;缺省停本 chat 活跃 job,
  chat-persisted 键 avatar_url/file_name 寻址;quiet 任务 persist_target=none
  不在 chatKey 面→回执 covered 如实标注)。
- `should_stream` / 流式回推 | — | **缺**(下格)。

## 其他

| TH 法 | 状态 |
|---|---|
| triggerSlash | **实**(server,共享 stscript-env) |
| substituteMacros | **实**(server:1260;buildSubstCtx 真宏上下文) |
| getMvuData / replaceMvuData | **缺**(T1:87-88;MVU 薄封——getVariables message 域 + 丢根护栏已铺底,语义封层随下格) |
| displayed_message 渲染本体 | **缺**(结构项:卡 HTML 渲进消息位 iframe;TASK-049 done_when 第五条,下格) |
| audio | **降**(TH 音效面,宿主 chrome 生态,不追) |
| presets / personas / import_raw / render_character | **降**(宿主管理面,卡 API 语境不成立) |
| third_party_message/script.html、predefine.js、_eventOnButton | **缺**(iframe 基建;与 displayed_message 同属下格) |

## 汇总

- 研究档 ~50 法面:本格前 **实 11(server)+ 8(host T0 独有)≈ 19/50**。
- 本格落地:事件家族 10 法全齐(shim 本地语义 + T0 记账 + server 影子/信箱),
  宿主→卡通道真事件(message_received/edited/swipe/chat_changed/generation_*);
  变量 GH#4 护栏双端;generate/generateRaw(GH#9)+stopGeneration;
  **消息写 6 法**(set/setOne/create/delete/rotate/refresh 信号);
  **世界书 13 法**;**正则 5 法 + substituteMacros**。
- 实测:tests/utopinn-th-events.test.mjs 18/18(事件+变量+生成+消息写+
  lorebook+regex+stopGeneration 全绿)。
- 下格:displayed_message 渲染本体+iframe 基建(formatAsDisplayedMessage/
  retrieveDisplayedMessage/third_party_*)、MVU 薄封(getMvuData/replaceMvuData)、
  流式 should_stream、角色写/清单面、generateRaw ordered_prompts。
