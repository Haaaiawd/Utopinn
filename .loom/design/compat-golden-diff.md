# 卡面兼容验证:golden-diff语料测试机制

- Kind: verification
- Status: frozen

## Responsibility in the whole

把"兼容绝大多数卡"从口号变成可测的机制:收集真实卡语料,用原版引擎产出 golden 组装结果,与 `@uberge/core` 产出逐字段 diff,作为 core 移植的验收门禁。

## Inputs, outputs, and boundaries

- 输入:`tests/corpus/cards/`(用户与社区收集的 .png/.json/.charx 卡)+ 固定 chat 脚本 + 固定 settings/preset fixtures
- 输出:每卡一份 golden.json(wireRequest + WI 注入轨迹 + regex 应用记录)+ diff 报告
- 边界:验证组装行为,不验证 LLM 输出质量

## Components and control flow

```
Golden 采集:apps/server(含旧 jQuery UI)起服务 + request-inspector 开启
  → Playwright 驱动旧 UI:导入卡→开聊天→发送固定消息
  → inspector 捕获 wireRequest → 落 tests/corpus/golden/<card>.json
Diff 执行:@uberge/core.assemble(同 fixture 输入)→ 规范化 → deep diff → 报告
```

- 关键工具已存在:`src/request-inspector.js` 捕获完整 wireRequest(含 fullMessages);`tests/` 已有 Playwright e2e 设施(eslint-plugin-playwright + e2e 目录)
- 规范化规则:剔除 gen_id/时间戳/随机种子等易变字段后再 diff

## Data and state

- 语料提交进仓库(注意卡版权——只收可再分发的卡或用户私有卡单独目录 `tests/corpus-private/` 进 gitignore)
- golden 由特定版本基准生成,版本号记入文件头;上游行为变更需重采

## Interfaces and dependencies

- apps/server(request-inspector)、Playwright、@uberge/core
- 卡格式解析走 @uberge/formats(顺带验证格式层)

## Failure, safety, and recovery

- diff 报告按严重度分级:致命(消息序列不同)/重要(WI 条目增删/位置不同)/可忍(空白/排序无关差异)
- 私有卡语料不进 git

## Implementation constraints

- 验收阈值已定(DECISIONS.md D-004):通过线 = LLM 消息序列相等 + WI 注入轨迹等价 + regex 应用记录一致;容忍白名单 = 时间戳/gen_id/同优先级排序;白名单外系统差异 → 阈值升级而非放宽
- 每张语料卡标注覆盖的兼容面:内嵌世界书、regex 脚本、STscript、CardApp、深度提示、alternate greetings、群卡

## Verification strategy

本设计即验证。增量门槛:core 每移植一模块,对应语料子集必须通过。

## Related documents and capabilities

- core-engine(被验证对象)
- ref/cards/GuiXu 等语料来源
