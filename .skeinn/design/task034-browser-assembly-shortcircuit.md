# TASK-034 — 浏览器组装短路:chat scope 直调服务端,真性能分离

> vs-V2: reference
<!-- TASK-034 已按架构性达成收账(D-2026-11-20);旧 UI=兼容 harness -->

只读侦察(2026-11,explore 子代理产)。对应 tasks.json TASK-034(depends_on TASK-030/032/033;
done_when:Generate() 在 requestScope===chat 跳过 openai.js 组装;浏览器 CPU 组装耗时归零;
WI/macro/STscript 只在服务端跑;回归+实弹不绿不收)。边界:不删浏览器引擎文件(TASK-035);
非 chat scope / dryRun / group 保留客户端路径。

## 0. 结论速览

- **浏览器组装的最终产物已全部被丢弃**:`buildUtopinnGenerateBody`
  (openai.js:4342-4367)显式 `const { messages: _discarded, ... } = requestBody`——
  组装出的 messages 不上线。所有 tokenize/WI scan/macro 展开的 CPU 开销是纯浪费。
- **推荐方案 = 条件跳过(conditional skip),不是整函数早退**:`generateInternal`
  (script.js:7912-)前 1/3 是楼层写盘/生命周期/UI 状态机,必须保留;后 2/3 是
  纯组装,用单一谓词 `shouldUseUtopinnAssembly()` 分段短路,保留事件发射与
  扩展副作用 carve-out。
- **`/api/utopinn/preview` 已可直接作预览/计数数据源**(utopinn-generate.js:
  返回 {messages, trace, sources, perf}),但**不适合**生成后的 itemize/lastInContext
  重建(状态已漂移)——正解是给 job 记录补挂 `promptMessages`/`timedWorldInfo`,
  生成后 `GET /api/utopinn/jobs/:id` 一次取回全部 UI 面数据。
- **WI timed effects 双写是真风险**:浏览器 `WorldInfoTimedEffects`
  (world-info.js:1320-1608)写 `chat_metadata.timedWorldInfo`,服务端
  `persistWorldInfoTimedEffects`(generate-context.js:172-178)CAS 写回——
  同一次生成两边推进 sticky/cooldown 是 TASK-034 必须掐掉的 bug(当前已在发生)。
- **takeover 插件(orchestrator director)是真消费方**:它读
  `eventData.generateData.prompt`(orchestrator/main.js:8659-8662,空了会 warn)——
  短路后要在 dispatch 前对"有 takeover 监听"的分支跑一次 `/preview` 供料。
- **bias 已是现网回归**:TASK-030 后服务端从未收到 bias(overrides 只传
  quietPrompt);TASK-034 顺手把 `overrides.bias`/`overrides.skipWIAN` 补上
  (服务端 promptBuilder/字段位都已存在,是个位数行的洞)。

## 1. 调用链

```
浏览器                                          服务端
─────────────────────────────────────────────────────────────────
Generate(type, options, dryRun)                 script.js:7898
└─ generateInternal                             script.js:7912
   ├─ [保留段 UI/楼层 7912-8146]
   │   ├─ GENERATION_STARTED emit               7999
   │   ├─ abort/saveReply 清理                   ~8016-8060
   │   ├─ processCommands / sendMessageAsUser    ~8030,8135-8145  → PATCH/append 楼层落服务端
   │   ├─ regenerate 删楼 (patchChatMessages)    8073-8099
   │   ├─ continue 前置                          8101-8130
   │   └─ impersonate 文本框语义                 ~8160 区域
   │
   ├─ [组装段 8147-9289 ← 短路目标]
   │   ├─ getCharacterCardFields + depth prompts 8147-8173
   │   ├─ chat[0].mes subst (keep: UI可见)       8176-8178
   │   ├─ coreChat: filter/regex/appendFile/工具 8183-8336
   │   ├─ runGenerationInterceptors              8343-8351 (keep: abort 语义)
   │   ├─ GENERATION_CONTEXT_READY               8393
   │   ├─ QUIET_PROMPT setExtensionPrompt        8411-8418 (keep: overrides 数据源)
   │   ├─ WI scan 块                             8419-8609
   │   │   ├─ buildWorldInfoChatInput            7690
   │   │   ├─ buildWorldInfoGlobalScanData       7727
   │   │   ├─ getWorldInfoPrompt → checkWorldInfo world-info.js:1774→8968
   │   │   │   └─ WorldInfoTimedEffects → chat_metadata.timedWorldInfo 写!
   │   │   ├─ GENERATION_BEFORE_WORLD_INFO_SCAN  ~8453
   │   │   ├─ GENERATION_AFTER_WORLD_INFO_SCAN   ~8497 (memory-graph recall 钩子)
   │   │   └─ GENERATION_WORLD_INFO_FINALIZED    ~8566
   │   ├─ WIAN 写 / AN 注入                      8606-8719
   │   ├─ instruct/textgen 组装(openai 恒跳过)   8721-8984
   │   ├─ setOpenAIMessages/MessageExamples      8809-8810
   │   ├─ getMessagesTokenCount ×N               8848/8931 (贵!)
   │   ├─ getCombinedPrompt + COMBINE 事件        9105-9217 (openai 早已返回'')
   │   ├─ prepareOpenAIMessages                  9258 → openai.js:2257
   │   │   ├─ preparePromptsForChatCompletion    openai.js:2101
   │   │   └─ populateChatCompletion             openai.js:1896
   │   ├─ parseTokenCounts→promptManager         9281
   │   ├─ setInContextMessages                   9285 → 10649-10666
   │   └─ GENERATE_AFTER_DATA                    9291
   │
   └─ [派发段 9302- finishGenerating,全保留]
       ├─ dryRun 提前返回                        9293-9295
       ├─ GENERATE_TAKEOVER_DISPATCH             ~9363
       ├─ sendStreamingRequest/sendGenerationRequest
       │   └─ GENERATION_BEFORE_API_REQUEST
       └─ sendOpenAIRequest                      openai.js:4599
           └─ requestScope==='chat' →
              buildUtopinnGenerateBody           openai.js:4342-4367
              (messages 丢弃! body={charDir,chatName,type,stream,
               generation_overrides,overrides,luker_generation})
              └─ POST /api/utopinn/generate ──────────────┐
                                                          ▼
                                   utopinn-generate.js ~150-290
                                   └─ buildGenerationContext  generate-context.js
                                      ├─ 卡/聊天/预设/WI 加载
                                      ├─ core checkWorldInfo  ~365-392
                                      ├─ persistWorldInfoTimedEffects(CAS,先写) 172-178
                                      ├─ promptBuilder assemble ~444-489
                                      │   └─ trace{collections,tokenBudget,...} assemble.ts:825-847
                                      └─ runLukerDispatch → luker-generation.js
                                          ├─ persistGeneratedReply(extra.luker_server_persisted)
                                          └─ job.trace/sources 挂载 runner.js:57-58
                                              → GET /api/utopinn/jobs/:id 139-140
```

## 2. 三向分类

### A. 服务端已接管 / 浏览器产物被丢弃(可整段跳)

| 代码位 | 产物 | 现状 |
|---|---|---|
| script.js:8147-8173 | cardFields/depthPrompts | 只进组装 |
| script.js:8183-8336 | coreChat 变换(regex/appendFile/tool merge) | messages 丢弃 |
| script.js:8419-8609 | worldInfoString/depth entries/AN/resolution | 丢弃 + timed 双写 |
| script.js:8606-8719 | WIAN/AN/extensionPrompts 注入值 | 丢弃(服务端同源注入) |
| script.js:8809-8810 | oaiMessages/oaiMessageExamples | 丢弃 |
| script.js:8848/8931 | messagesTokenCount | 丢弃(服务端有 tokenMs) |
| script.js:9066-9100 | checkPromptSize | 丢弃 |
| script.js:9258 prepareOpenAIMessages | 最终 messages | **显式丢弃** openai.js:4345 |
| promptBias→bias prompt | | 已被丢弃(现网回归,见§5.2) |

### B. UI-only 消费方(保留或换服务端数据)

| 代码位 | 消费方 | 替代方案 |
|---|---|---|
| 9281 promptManager.tokenHandler.counts | PromptManager 渲染 | dryRun 保留客户端;live 用 job.trace |
| additionalPromptStuff→itemizedPrompts | promptItemize 弹窗 script.js:5505/5670/8076/9347-9355 | 生成后 GET jobs/:id → promptMessages+trace 重建 |
| 9285 openai_messages_count→setInContextMessages | .lastInContext/lastInContextMessageId 10649-10666 | trace.chatHistoryCount(服务端补导) |
| activeWorldInfoPromptSnapshot | st-context getActiveWorldInfoPromptFields(CardApp/扩展) | sources.worldInfo 补 beforeEntries/afterEntries |
| chat_metadata.timedWorldInfo | WI 编辑器 timed 指示器 | job.timedWorldInfo 生成后回同步 |
| GENERATION_* 事件 ×9 | memory-graph/orchestrator/第三方监听 | 保留发射,payload 加 `serverAssembled:true` |
| GENERATE_TAKEOVER_DISPATCH | orchestrator director 读 generateData.prompt | 有监听时先跑 /preview 供料 |
| QUIET_PROMPT setExtensionPrompt 8418 | buildUtopinnAssemblyOverrides openai.js:4332-4339 | 保留(overrides 数据源) |
| processChatSlashCommands/script_injects | 服务端也从 chatMetadata 读 | 保留 |
| saveReply/swipe/impersonate 回流 | 楼层 UI | 派发段原样保留 |

### C. 既无消费也无副作用(随段跳过即可)

mesExamplesArray、storyString/instruct 配置(openai 分支本来就不走)、
additionalFinalRescanData、world_info_overflow_alert、
power_user.console_log_prompts(可继续 emit,prompt 为空)、
generationResolution 中间态、data.prompt 数组本身。

## 3. /api/utopinn/preview 评估

**够用**:`{messages, trace, sources, perf}` 已覆盖 prompt viewer/token 计数/
分解/WI 快照四项 UI 需求;dryRun 路径零副作用(不推进 timed、不写楼)。

**两个坑**:
1. 生成后补跑 preview ≠ 生成时快照(timed/楼层已漂移)→ 生成后 UI 数据走
   `GET /api/utopinn/jobs/:id`,preview 只服务"用户主动看 prompt"与 takeover 供料。
2. itemizedPrompts 需要 `additionalPromptStuff` 形状(rawPrompt/counts/
   allAnchors)——写一个 30 行的 job→additionalPromptStuff 适配器,别改 UI 组件。

**结论**:dryRun(PromptManager.tryGenerate openai.js:1333 的
`Generate('normal',{},true)`)本期继续走客户端旧路——它本身就是 UI 专用,
不动它回归面最小;preview 给 takeover/主动预览用。

## 4. 短路设计

谓词(与 buildUtopinnGenerateBody 的 null 条件同源,建议 openai.js 导出共用):

```js
shouldUseUtopinnAssembly(type) =>
    !dryRun && main_api === 'openai' && !selected_group
    && GENERATION_TYPE_TRIGGERS.includes(type)   // constants.js:36-43
    && charDir && character?.chat                 // 与 body 构造同条件
```

脚本内分段(8147-9289),保留 carve-out 用 `if (!serverAssembled)` 或显式保留行:

| 区间 | 处理 |
|---|---|
| 8147-8173 cardFields/depth | 跳 |
| 8176-8178 chat[0].mes subst | **保**(UI 可见) |
| 8183-8336 coreChat | 跳;保一份 `coreChat = chat.filter(...)` 素拷贝供拦截器/事件 payload |
| 8343-8351 interceptors | **保**(abort 语义) |
| 8393 CONTEXT_READY | **保**,payload 含 coreChat+maxContext,加 serverAssembled |
| 8411-8418 | 只保 QUIET_PROMPT 一行(overrides 数据源) |
| 8419-8609 WI 块 | 跳;**仍发射** BEFORE/AFTER/FINALIZED 三事件,payload={coreChat, chatForWI(素拷贝), worldInfoResolution:null, serverAssembled:true},dispatch 前发完 |
| 8607 QUIET_PROMPT 清 | **保** |
| 8608-8984 | 跳 |
| 9105-9217 COMBINE | 保 AFTER 事件(openai 今日本来 finalPrompt='',行为平移) |
| 9258-9289 openai 分支 | 跳;generate_data={prompt:previewMessages ?? []} |
| 9291 AFTER_DATA | **保** |
| 9302+ finishGenerating | 不动 |

**takeover 桥**(9363 前):
`eventSource.events[GENERATE_TAKEOVER_DISPATCH]?.length > 0` → POST /preview →
generate_data.prompt = preview.messages → 照常 emit/claim。无监听零成本。

**派发兜底**:sendOpenAIRequest 内 `requestScope==='chat' && !utopinnBody &&
prompt.length===0` → 直接 throw(别让 legacy 带着空 messages 发真上游)。

**生成后 reconcile**(onSuccess/onFinishStreaming 完成处):
`getLastLukerGenerationIdForApi()` → GET /api/utopinn/jobs/:id →
一次性回填 itemizedPrompts(mesId=getNextMessageId 已算好的楼层位)+
setInContextMessages + chat_metadata.timedWorldInfo + WI snapshot。

## 5. 服务端补件(全部增量、可空)

1. `runner.js:57-58`:`job.promptMessages = request.body?.messages`;
   `job.timedWorldInfo`(persist 后快照)。
2. `utopinn-generate.js:139-140`:jobs/:id 响应加两字段。
3. `generate-context.js` sources.worldInfo += `{beforeEntries, afterEntries}`
   (含 content,st-context 快照需要)。
4. `generate-context.js` WI 前加 `if (overrides?.skipWIAN) {entries=[],AN 同门}`
   ——约 5 行,把已死的 skipWIAN 语义接回。
5. 确认 `overrides.bias` 落到 assemblyRequest.bias(assemble.ts 有 'bias'
   identifier 位);`overrides.quietName/quietImage` 列入 TASK-037 缺口。
6. `assemble.ts:~836` trace 加 `chatHistoryCount`(变量已在,只差导出)。

## 6. 残留浏览器依赖(getContext thunk / 扩展副作用)

- `simulateWorldInfoActivation`/`getWorldInfoPrompt`/`buildWorldInfo*`
  (script.js:7690-7762 + st-context)——**保留导出**,扩展/CardApp 自己的
  quiet/internal 流还在用;chat 主路不再调。
- memory-graph AFTER 钩子(safeInjectMemoryPrompts 9042,需 payload.coreChat):
  dispatch 前发射 + 给 coreChat → runtime lorebook 投影写
  (saveWorldInfo ~8022)在服务端 scan 前落库,服务端能扫到 ✓。
  `requestRescan`/`worldInfoResolutionOverride` 语义作废(服务端已扫完)——
  文档化,serverAssembled 标志让插件自行降级。
- generate-task.js(requestScope='extension_internal' ~454/589)、
  generateRaw(7393/7430)、group-chats、dryRun —— 一律不动。
- processChatSlashCommands 的 script_injects ↔ extension_prompts 同步保留。
- stopGeneration(script.js:10019 cancel 端点)/流式/断线恢复不动。

## 7. 实施顺序

1. 服务端补件(§5 六项,先上,可空不破坏旧行为)
2. openai.js 导出 `shouldUseUtopinnAssembly` + sendOpenAIRequest 空 prompt 兜底
3. script.js 分段 guard + 事件兼容 payload + takeover 桥
4. 生成后 reconcile(itemize/lastInContext/timed/WI snapshot)
5. 开关:`localStorage['utopinn.browser_assembly']==='legacy'` 强制旧路(回滚口)
6. perf 插桩:generateInternal 头尾 performance.now →
   `console.info('[perf] browserAssembly=Xms serverAssembled=Y')`,验收证据入库
7. 回归 + 实弹

## 8. 风险矩阵与回滚

| 风险 | 级 | 缓解 |
|---|---|---|
| timed effects 双推进(现状已发生) | 高→消 | 短路后浏览器不扫=单写者;生成后回同步防陈旧 PATCH |
| takeover 插件拿空 prompt | 中 | 监听计数门控 preview;orchestrator 有空值 warn 兜底 |
| memory-graph 投影错过 scan 窗 | 中 | AFTER/FINALIZED 在 dispatch 前发射 |
| 谓词与 body 构造条件漂移 | 中 | 同源导出 + sendOpenAIRequest 空 messages 早错 |
| itemize/lastInContext 断档 | 低 | job 数据回填;懒加载可再退 /preview |
| WI 事件 payload 缩水 | 低 | serverAssembled 标志 + 文档;dryRun 不受影响 |
| 第三方扩展读 generate_data.prompt | 低 | ALREADY DEAD(messages 今已被丢),短路只让它更诚实 |

**回滚**:`localStorage['utopinn.browser_assembly']='legacy'` → 谓词返 false →
全量旧路径;服务端字段新增全可空,无需回退。

## 9. 验收

- 抓包:POST /api/utopinn/generate body 无 messages;x-utopinn-perf 在;
  stream_openai 开/关都通;WS head/chunk/end;abort/断线恢复;
  swipe/continue/impersonate/quiet 不多落楼层,normal/regenerate 落。
- 组装等价:同会话内 dryRun(旧路)vs /preview messages 逐条 diff;
  sources.worldInfo.activated vs 浏览器激活记录。
- timed:连发生成 sticky/cooldown 恰减一次;chat_metadata.timedWorldInfo
  与服务端一致。
- perf:browserAssembly≈0ms 对比基线入库。
- 负例:group/textgen/generate-task/generateRaw/dryRun 全旧路;quiet n>1、
  tools/json schema、custom source exclude-body 已知缺口不回归。
- takeover:orchestrator 开 → director prompt 非空。
