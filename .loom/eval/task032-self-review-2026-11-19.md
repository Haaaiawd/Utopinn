# TASK-032 写盘面统一——自查记录(替代丢失的 explore 审查)

子代理 explore 无法写文件,审查报告未落盘;以下为逐项手动核查结果。

## 核查项

| # | 疑点 | 结论 | 证据 |
|---|------|------|------|
| 1 | op 内嵌 gen-id 被 `sanitizeOperationsAgainstLukerGenerationId` 剥除,显式 ack 是否失效 | **不失效**——`acknowledgeGenerationFromValueOrPersistTarget(writeReq, ops, …)` 扫的是未消毒的原始 `ops`(uberge-library.js:869),与 legacy 完全同构(chats.js:2482/2560 同样传原始 operations)。sanitize 只剥「写进楼层」的副本,防伪造存储侧 gen-id;ack 侧收集照旧 | chats.js:1989-2004 |
| 2 | repo.patch 的 op 命名空间 | `/body/<i>`——repo.patch 对 `{header,body}` doc applyJsonPatch;CLI 已切 `/body/` 前缀,`hitsLast` 门兼容两种前缀 | chat-repo.js:123-125, cli:563-600 |
| 3 | writeReq `{...request, body:{...}}` 丢字段 | ack/settle 只消费 `request.body` + `request.user`,展开保留;不触 prototype 方法 | uberge-library.js:806,856 |
| 4 | repo.append(extra.gen_id) vs sidecar(extra.luker_generation_id) 双去重撞车 | 不撞——两个不同字段;repo 内部 gen_id 是普通楼层去重,sidecar 是生成重试去重,语义正交 | chat-repo.js:80-95 |
| 5 | gen-id sidecar 与存储引擎 | sidecar 是独立文件(chatFilePath 旁),不依赖 engine 形态;FS/SQL 引擎下都一致 | chats.js:825-840 |
| 6 | swipe 显式 ack 端到端 | **实证**——job e6f3e46d:gen-id 嵌 swipe_info op → ack → completed;409 重锚重试通过 | 实弹 2026-11-19 |
| 7 | kind:'none' hint-ack | kind:'none' job chatKey='' 永不匹配 hint(需 chatKey 相等)——只有显式 gen-id ack 有效,这正是设计意图 | luker-generation.js:1043-1067 |
| 8 | kind:'none' persist_target 身份字段 | **已回退**——avatar_url/file_name 会让 getPersistChatKey 产出真 chatKey,服务端替 swipe 写整楼→failed;恢复纯 {kind:'none'} | cli:504-509,实弹失败→修复→复验 |
| 9 | 时序:poll-then-write vs grace | **已修**——先前 20s poll 会让 15s grace 先触发兜底失败;现在 breakOn:['awaiting_ack'] 即到即写 | cli:543-548 |
| 10 | append dedup while-loop | 与 legacy 同语义:只剥队首与 sidecarLast 匹配的消息;重试安全 | uberge-library.js:809-814 |

## 已知限制(登记)

- **显式 ack 的防伪造缝与 legacy 相同**(ack 扫未消毒 ops)——上游既有行为,parity 保持,不在本任务收紧
- kind:'none' job 超时仍标 failed(文案已诚实化为 client-owned);15s grace 对慢盘 patch 紧张但 CLI 实测 ~2s 内落盘
- group 聊天 uberge 写盘面未接(TASK-037 范围)
- legacy `/api/chats` 端点暂未标 deprecated(done_when 第 4 条未完成)——过渡期内双面共存,浏览器仍走 legacy

## 结论

safe-to-proceed。机制移植忠实 legacy 语义,实弹 send/swipe 全链闭环;无新增阻塞项。
