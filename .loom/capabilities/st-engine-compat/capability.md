# SillyTavern 引擎行为兼容方法论(移植策略/行为面清单/特征化测试)

> One dossier covers one recognizable professional field.

## Field identity and boundary

遗产前端引擎的无规格行为移植:行为面枚举、特征化(golden master)测试、seam 切分、验收口径。不含:API 契约设计(generation-api)、前端沙箱(sandboxed-card-apps)。

## Project scenario

无规格遗产引擎移植已实战验证:golden-diff 捕获/分级/KNOWN-GAP 容差挂账跑过多轮,仍是验收闸(用户拍板 2026-11-20)

## Decision tree

### C1: 移植总策略

- entry_when: 启动任一 core 模块移植
- options:
  - A: 特征化优先——先建 golden 出口(request-inspector 捕获 wireRequest),按 Feathers 逐模块 seam 移植,golden-diff 门禁 → leads_to: C2
  - B: 通读源码后按理解重写 → leads_to: 高风险(行为面不可枚举)
- decide_by: 行为面是否可完整枚举——不能,故 A
- source: research/characterization-methodology.md
- counterexample: 若模块本身有完整上游测试(如纯工具函数),可直接重写+单测
- output: golden-diff 先行;移植以 ctx 收口函数(generate-task.js/lukerContext.js)为 seam 边界

### C2: 保真维度清单(必须逐项验证的行为)

- entry_when: 设计 golden-diff 断言与 WI/宏移植
- options:
  - A: 按枚举清单逐项建断言 → leads_to: C3
  - B: 只 diff 最终 prompt 文本 → leads_to: 漏网(轨迹不同但恰好同文)
- decide_by: 行为面清单(见下)是否展开为断言项——必须展开
- source: research/lorebook-semantics-surface.md
- counterexample: 对不经过 WI/宏的极简卡,B 凑合够——但语料库必须含复杂卡
- output: 断言清单——key 匹配(substring/\W 全词/regex key/CJK)、大小写(全局+条目)、次关键字四逻辑门、probability+sticky、scanDepth、递归与 MIN_ACTIVATIONS 触发、八种 position+anchor、@@decorator 系、token 预算与 insertion strategy、向量链接、变量 op-log 回放、regex 应用顺序与作用域、STscript 求值、instruct 序列、深度注入、alternate greetings、群聊 talkativeness

### C3: STscript/宏的副作用分层

- entry_when: 移植宏/STscript 求值器
- options:
  - A: 求值分纯/副作用两级——副作用命令产出意图描述由管线层执行 → leads_to: C4
  - B: core 内直接执行副作用(发消息/写变量/调 API)→ leads_to: core 纯度被破坏
- decide_by: core 硬边界(零 fs/网络)是否守住——必须
- source: research/characterization-methodology.md + .loom/design/core-engine.md
- counterexample: 若验收发现原版行为依赖求值与副作用交错时序,退回局部重构,不改边界
- output: 求值器返回 {text, effects[]};effects 由 generation-api 管线执行并记录

### C4: 验收阈值

- entry_when: golden-diff runner 定稿
- options:
  - A: 消息级相等 + WI 注入轨迹等价 + 白名单容忍(时间戳/gen_id/同优先级排序)→ leads_to: C5
  - B: 全文逐字节相等 → leads_to: 不可达(含随机/时间)
- decide_by: 差异是否可归入白名单——能归则 A
- source: research/characterization-methodology.md
- counterexample: 若白名单外出现系统性差异(如 WI 顺序不同),阈值升级,不放宽
- output: diff 分级(致命/重要/可忍)与通过线;阈值已决(DECISIONS.md D-004:消息序列相等+WI轨迹等价+regex记录一致,白名单=时间戳/gen_id/同优先级排序)

### C5: 语料覆盖矩阵

- entry_when: 收卡入库
- options:
  - A: 按兼容面标注入库(内嵌书/regex/STscript/CardApp/深提/多开场白/群卡/向量)+ 私有卡隔离 → leads_to: 完成
  - B: 只收能跑通的几张 → leads_to: 覆盖假象
- decide_by: 每张卡标注覆盖的兼容面并求并集——矩阵不全则继续收
- source: research/lorebook-semantics-surface.md
- counterexample: 早期可用合成卡(hand-crafted fixtures)补缺口——但真实卡不可缺
- output: tests/corpus/cards/ 标注语料 + corpus-private 隔离
