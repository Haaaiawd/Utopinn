# 服务端生成管线与流式投递API契约

- Kind: contract
- Status: frozen

> vs-V2: partially-stale

## Responsibility in the whole

定义"客户端发一句话、服务端组装并调 LLM、结果流式回推并可断线续接"的完整链路契约。是薄客户端唯一需要理解的生成协议;旧版 `/api/backends/*/generate`(前端自带组装)在过渡期并存。

## Inputs, outputs, and boundaries

- 输入:`{charRef|groupRef, chatRef, mode: normal|continue|regenerate|swipe|impersonate, userText?, presetRef?, overrides?}` + 可选 ephemeral 文档(临时上传的世界书等,组装用不持久化)
- 输出:job 句柄 → WS 事件流(delta/reasoning/最终消息/trace 摘要/持久化确认)
- 边界:本契约只管"提交+投递";组装细节属 core-engine;存储属 Luker Repo 层

## Components and control flow

```
client → POST /api/generate → generationJob(Luker generationJobs Map,已持久化)
      → core.assemble(ctx) → wireRequest
      → provider dispatch(luker-dispatch)→ LLM(SSE)
      → 事件入 job + WS ticket 广播
      → 完成:消息写 chat(JSONL via ChatRepo)+ variables/regex 后处理 + chat_state 更新
断线:client 持 lastEventId/ack → WS 重连 → job 事件回放(ack grace ~15s,既有)
```

<!-- V2 校准:实名 /api/utopinn/generate+charDir/chatName/type,帧 head/chunk/end/ping/pong -->

- 复用:`src/endpoints/backends/luker-generation.js` 的 job/TTL/ack 机制、`ws-delivery.js` + `ws-ticket-router.js` 的心跳与重连协议
- RN 走 WS 不走 SSE(fetch 分块在 RN 不可靠——已记录为假设 A)

## Data and state

- job:内存 Map + 完成态落 chat;TTL 2h(既有)
- wireRequest 同时喂 request-inspector(诊断/黄金样本来源)

## Interfaces and dependencies

- `packages/protocol`:GenerateRequest、GenerateEvent envelope、job 状态枚举——三端唯一事实源
- 依赖:core-engine、luker-dispatch、ChatRepo、ws-delivery

## Failure, safety, and recovery

- LLM 失败/中止:job 标记 failed,部分已流文本按 swipe 语义保留或丢弃(与原版一致)
- 并发:同 chat 串行(生成锁);abort 经 inspector/job 语义统一
- 限流:沿用 rate-limiter-flexible;ephemeral 文档大小上限

## Implementation constraints

- 契约先行:`protocol` 包先写类型,server 实现与 mobile 消费以它为据
- 过渡并存:新端点上线不破坏旧 `/api/backends/*`(旧 web UI 仍用)

## Verification strategy

- 契约测试:protocol schema ↔ server 实现 ↔ api-client 三方一致
- e2e:假 LLM(mock fetch)下走完全链;断线重连回放测试(ws-delivery 既有测试模式延续)

## Related documents and capabilities

- core-engine、mobile-panels、compat-golden-diff

## Alternatives considered

- **沿用 legacy `/api/backends/*/generate`(前端自组装)**——V1 过渡期并存方案;V2 已判死(大脑必须唯一),保留仅作 harness 兼容面。
- **纯 SSE 而非 WS job 句柄**——考虑过;RN 里 SSE 不稳+断线续接要靠 job 重放,故选 job+WS(events/ticket)。
- **所选**:服务端唯一组装 `/api/utopinn/generate` + job 句柄 + WS 投递,客户端零组装(V2 拍板)。
