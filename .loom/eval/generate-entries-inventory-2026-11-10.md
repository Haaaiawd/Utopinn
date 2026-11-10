# 旧UI生成入口 → /api/uberge/generate 覆盖矩阵(2026-11-10)

调查格产出(全文见会话记录)。判定:covered=字段+行为等价;partial=可经 overrides/generation_overrides/客户端编排表达;gap=端点不支持。

## 批次 0(阻塞修复,必做)

1. **model/max_tokens 未进派发体**:预设存 `openai_model` 等按源分键 + `openai_max_tokens`,provider 读 `body.model`/`body.max_tokens`(openai-compatible.js:810/812)。修:派发体按 `chat_completion_source` 做 source→`*_model` 映射(等价 openai.js getChatCompletionModel)+ `max_tokens: openai_max_tokens`(可被 generation_overrides 盖)。
2. **stream 不读预设**:`body.stream !== false` 恒 true。改 `body.stream ?? oaiSettings.stream_openai !== false`,`type==='quiet'` 默认 false。
3. **persist_target 无法干净禁用**:缺省强制填楼层目标,显式 null 也命中 `??` 兜底。加 `{kind:'none'}` 识别(impersonate/quiet/swipe/continue 必须禁)。
4. **ws-delivery PROXY_PATTERNS 缺 `/api/uberge/generate`**(ws-delivery.js:550-573):加一行即复用 head/chunk/end→Response、signal→abort、超时→abort。
5. **swipe/is_system**:`chatBodyToInput` 未做上游 `!is_system || tool_invocations` 过滤(script.js:7999),`type==='swipe'` 未 `chat.pop()`(script.js:8000)。

## 入口矩阵(执行点全清单,script.js)

| 入口 | 位置 | 迁移批次 |
|---|---|---|
| sendTextareaMessage(主发送/continue 空输入) | script.js:4153 | 批1 |
| #option_regenerate(先删末层) | 21505 | 批2 |
| #option_impersonate | 21511 | 批2(persist禁,输出→textarea) |
| #option_continue | 21525 | 批2(overrides.cyclePrompt) |
| .swipe_right/left → Generate('swipe') | 19016 | 批2(overrides.chat去末层+禁persist+槽位客户端) |
| generateQuietPrompt(全参数) | 6075 | 批3(quietImage/skipWIAN-outlet/forceChId 受限) |
| 流式/非流 tool_calls+auto-continue 递归 | 9513/9554/9708/9729 | 批4(轮间楼层客户端写回) |
| promptManager.tryGenerate dryRun | openai.js:1332 | →/api/uberge/preview(covered) |
| logprobs addGeneration | logprobs.js:321 | 批2 |
| 群聊成员循环/force_chid | group-chats.js:1338/1343/2275 | 批4 **gap**(group聊天repo+deps.group断) |
| /impersonate /ask /gen /trigger /continue /regenerate /swipe /sysgen /genraw | slash-commands.js 多点位 | 批2-4;genraw=gap(无raw模式) |
| **迁移锚点** | sendGenerationRequest(10501)/sendStreamingRequest(10579) | 在此切流即接管主聊天 |

**不迁移**:generateTask/generateTaskStream(taskMessages/connection-profile 面)、ChatCompletionService/TextCompletionService、orchestrator/iter-tool-calling/memory-graph/CEA 等 task 型调用、novel/kobold/koboldhorde 源(端点无对应派发叉)。

## 服务端缺口(gap 清单)

- group 聊天(chatRepo 只读角色聊天;deps.group/groupNudge/botNames/force_chid 断)
- raw 模式(裸 prompt 不经卡+聊天组装)
- prompt 期 setvar 副作用持久化(仅 timedWorldInfo 回写)
- 楼层 promptOnly regex、append_title/file content、隐藏 tool owner 清理
- WI 扫描含被 swipe 旧层(发散)
- 派生键:stop/logit_bias/include_reasoning/reasoning_effort/verbosity/user_name/group_names
- 楼层 api/model 硬编码 openai(generate-context.js:469)→ 非 openai 源 tokenizer/签名错
- 服务端 STscript 生成缝未绑(stscript-env.js:11 generateQuiet/triggerGeneration 缺 seam → /gen 等静默 no-op)

## 客户端重接点(改道后必须接回)

GENERATION_STARTED/ENDED/STOPPED、MESSAGE_SENT/RECEIVED/SWIPED、IMPERSONATE_READY、GENERATE_AFTER_COMBINE_PROMPTS(组装数据载荷→需 /api/uberge/preview 代餐)、GENERATION_BEFORE_API_REQUEST(载荷形状变 uberge body)、StreamingProcessor 全链、stopGeneration→/api/generation/:id/abort、断线 /api/generation/active+events-stream?after_seq 恢复、saveReply swipe/merge 分支(客户端全权)、luker_generation_id 消重 ack。

## 验证

- preview vs promptManager.tryGenerate 逐消息 diff;sources.worldInfo.activated 对照
- 浏览器冒烟:POST + WS head/chunk/end + x-uberge-perf;流/非流切 stream_openai
- abort/stop、断标签页恢复、15s 兜底楼层(luker_server_persisted)、swipe/continue/impersonate/quiet 断言不新增楼层
- 负例:quiet+n>1 抑制、tools/json_schema、custom source exclude_body
