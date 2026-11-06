# 后端 Audit:引擎核心(代理 2ad0302c,2026-11-04)

## 总评
移植骨架质量高(集合/Message/ChatCompletion、WI buffer/timed/组评分、正则六档、宏环境、STscript parser 都对得上上游)。**重灾区=接入层 generate-context.js**:想当然猜了三个不存在的 settings 键 + 产出没接到消费端。全是静默失效型 bug——golden-diff 最该抓、也必修。

## 🔴 HIGH
- **H1 WI 设置全静默失效** `generate-context.js:103-105`:读 `power_user.world_info_settings`(不存在)→恒{};且未做 snake→camel 映射(`world_info_depth`→`worldInfoDepth`)。depth/budget/recursive(上游默认true,core默认false)/case_sensitive/whole_words/min_activations/max_recursion/budget_cap/group_scoring/include_names 全落默认 → **递归扫描默认关,激活面直接变**
- **H2 全局勾选书+角色辅书永不加载** `generate-context.js:179/195`+`mvu-settle.js:161`:读 `settings.world_info`(真实在 `settings.world_info_settings.world_info`)+`power_user.selected_world_info`(真实在 `world_info_settings.world_info.globalSelect`)→charLore/globalSelect 两层断链;MVU initvar 同错。五层来源断两层(最常见的两类)
- **H3 timed effects+setvar 写瞬态 chatMetadata 不落盘** `generate-context.js:187/280`:chatMetadata 从 header 拷出后无人写回→sticky/cooldown/delay 每轮从空表起全失效;`{{setvar}}` 跨轮无法累计(MVU/状态栏卡功能级破坏);preview 同路。参照:上游 saveChat/saveMetadata 落盘
- **H4 EM/AN/outlet 注入桶产出后被丢弃** `generate-context.js:310-321`:checkWorldInfo 返回的 EMEntries/ANBefore/ANAfter/outlet 无字段承接无下游消费→EMTop/EMBottom/ANTop/ANBottom 四条 position 静默不进 prompt;`{{outlet::name}}` 恒 ''
- **H5 卡面 depth_prompt 从未注入** `generate-context.js:266`:只进了 WI 扫描缓冲(globalScanData.characterDepthPrompt),没按 depth/role 合入 extension_prompts;extension_settings.note.depth_prompt[] 多条目亦无入口

## 🟠 MEDIUM
- M1 **Author's Note 机制整体缺失**:chat_metadata.note_* 不读,extension_prompts['2_floating_prompt'] 不会产出
- M2 `persona_description_position` 未建模(NONE/IN_PROMPT/TOP_AN/BOTTOM_AN/AT_DEPTH),persona 恒 IN_PROMPT
- M3 WI trigger 硬编码 'normal'(type 传了没接)→trigger 过滤行为反转
- M4 prompt_order 写死 100001/100000/lists[0] 兜底,不按真实 chid 解析→角色自定义顺序失效+可能错序
- M5 substCtx.chat 裁剪丢 is_system/send_date/swipes→`{{lastCharMessage}}` 误算系统楼层、`{{idle_duration}}` 恒 just now、swipeId 宏恒 ''
- M6 token 计数恒 gpt-4o:`openAIRawCount` model 形参默认 ''→encoderFor('')→key ''||'gpt-4o';bindPromptTokenCounter 模块级单例并发串账(修 M6 时一并)
- M7 WI 内 token 计 len/4 vs prompt 真实 tokenizer→CJK 高估 2-4 倍,budget 提前溢出
- M8 空消息双偏移:无条件 count(空消息~5token)+insert 门槛 tokens>0 恒真(上游 content||tool_calls)
- M9 checkTokenBudget 超预算只 WARN 不抛(上游 TokenBudgetExceededError 硬失败)
- M10 injection_depth 上限 100(上游 10000)→深位注入静默丢
- M11 MVU oplog 读后写非原子(并入持久化 audit M2)
- M12 STscript builtins 上游子集:/go/continue/swipe/note/persona/getat/setat/WI命令/QR 未注册(结构化错误非静默,卡脚本会跑不通)
- M13 sendSystemMessage 不写 persistMetadata;stscript repo.save 盲替换 header(待核深合并语义)

## 🟡 LOW
L1 fromPromptAsync 多传 name(+1token);L2 continue_nudge 不替 `{{lastChatMessage}}` 字面残留;L3 getvar 空串返回''(上游 0);L4 variables 静默 catch 无 warn;L5 boundModel 单例(修 M6 时连带)

## 已核对无缺陷(排除)
WI buffer 深度/skew/组评分、matchKeys 整词/regex序、reserveBudget(3)、continue prefill、pin_examples、system squash、媒体/工具 token、canAffordAll 等价性、timed effects 计算本身、STscript registry 并发安全、generate type 透传、Luker 持久化口径

## 修复路线(原报告)
1. settings 路径族一处归一化+snake→camel 映射 → 连带修 H1/H2/MVU init 四面
2. chatMetadata 持久化决策(写回 header vs chat_state;preview 不写)
3. EM/AN/outlet/depth_prompt/AN/persona position 接入 assemble 扩展位
4. M6-M10 计数边界,单行级

## 修复状态(2026-11-05/06 批次)

HIGH 全灭(见各 commit):H1/H2 settings 路径族 5b9b6d2 | H3 timed-effects 持久化 6b9ce49 | H4/H5/M1/M2 注入通道 b9c4dbe | M3 trigger ea9ad9b
MEDIUM:M5 substCtx.chat 字段透传 3325553 | M6-M10 计数边界族 15ef9cf | M11→持久化 M2(设计级)| M4 **修正诊断**:global dummyId 100001 本为上游真语义,真分叉是 lists[0] 错序兜底——已删(3325553)

- **M12 STscript builtins 子集**(/go/continue/swipe/note/persona/getat/setat/WI命令/QR):非 bug 是功能缺口,结构化报错非静默——立为后续任务线。
- **M13** sendSystemMessage persistMetadata + stscript repo.save 深合并:待逐项核实。
- LOW 残余:L1 name 参数 +1token、L2 continue_nudge {{lastChatMessage}} 字面残留、L3 getvar '' vs 0、L4 静默 catch、L5 boundModel 单例竞态(M6 修了语义,并发串账结构仍在——真修=per-build counter 管线化)。

## 逐项核实结论(2026-11-06 批次)

- **M13(a) 已修(053f504)**:真缺口不是 sendSystemMessage 本体(上游 doReturn chat-* 也只 push 不存),而是 `env.host.persistChat` seam 在服务端从未实现——core `insertChatMessage` 在 `appendMessage` 后 `await persistChat?.()`,/sys /sendas /comment 已写 `chatMetadata.tainted=true`,但尾插场景 append 只落 body,tainted 永不上盘。现在 persistChat 经 `updateChatMetadata` 补 header 快照(与上游 saveChatConditional 成对);中插 save 的 header 同步改为上游三键形态 `{user_name:'unused',character_name:'unused',chat_metadata}`(script.js:7425-7429)。
- **M13(b) 验证无误**:上游 `saveChat` 本来就是整 header 直替(构造仅含 chat_metadata/user_name/character_name 三键,不做任何深合并;深合并只发生在独立 metadata 端点)。`repo.save` 全量替换 = 忠实语义,无需改。
- **L1 已修(6408ede)**:上游 `fromPromptAsync`(openai.js:3792)走 3 参 `createAsync`,prompt.name 永不透传——名字只在 names_behavior=COMPLETION 的聊天历史装填经 setName 进计数与 wire。移植版透传导致每条 prompt 消息 +~1token 且 wire 多 name 字段。连带修了同类点:continueNudge 被续消息(上游 917-921 不 setName,与 prefill:1329 相反)。
- **L2 已修(5d04119)**:上游 `substituteParamsExtended(continue_nudge_prompt, {lastChatMessage: String(cyclePrompt).trim()})`(openai.js:909-912);经 dynamicMacros seam 等价注入,字面残留消除。
- **L3 误诊,不改**:上游 `getLocalVariable`/`getGlobalVariable`(variables.js:22-46/48-63)对缺失/空值一律返回 `''`(`coerceReturn`:`trim()===''||isNaN → value||''`);`{{getvar}}` 宏与 `/getvar` 命令同口径。`0` 只出现在 `add/inc/dec` 的算术兜底 `getLocalVariable(name) || 0`(空值按 0 起算),不是 getvar 读侧语义。两侧逐行一致。
- **L4 已修(bc52b0a)**:宏替换循环的 warn(evaluate.ts `Macro content can't be replaced`,对 upstream macros.js:710)早已在;排查整个 substitution/variables 面,唯一缺的上游 warn 是 `substituteParams` 非串入参的 `content will be coerced to string`(script.js:2985)——已补。其余静默 catch(JSON.parse/index 访问)上游同样静默,逐行一致不改。
- **L5 遗留**(同前):boundModel 单例竞态,属管线级改造,不在本批小项范围。
- **附记**:createAsync 对空串 content 仍无条件计数({role,content:''}→~5token,上游空串直接 0 不入计)——M8 当时只修了 insert 门槛半边,此为另一半残余,记入后续。
