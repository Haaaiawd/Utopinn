# 开发者诊断(dev diagnostics)

> 服务调卡人/插件作者/自己——诊断是一等域不是彩蛋。

## Field identity and boundary

prompt 查看、WI 轨迹、变量日志、生成任务、存储检查、golden 界面、degraded 呈现、调试导出。不含:测试 harness 本身(tests/)。

## Project scenario

调卡人要看 WI 为何命中/变量为何变;插件作者要看 inject 为何缺;issue 要打包日志。

## Decision tree

### C1: 诊断独立成域

- entry_when: IA
- options:
  - A: 一级导航「诊断」聚合全部工具 → leads_to: C2
  - B: 散进扩展页杂项(ST 现状) → leads_to: 找不到,等于没有
- source: design/web-ia.md §8 开发者支柱+§11 覆盖审计
- output: 诊断域 8 工具卡;侧栏=诊断项索引;普通用户不打扰(不占聊天面)

### C2: model-visible ⟺ logged

- entry_when: prompt 查看器
- options:
  - A: 上轮 messages[] 完整重建展示(持久化chat+卡+注入轨迹可复算) → leads_to: C3
  - B: 只存最后响应 → leads_to: 无法调试兼容
- source: DSH model-visible⟺logged 原则(AGENTS.md)
- output: prompt viewer 含分块 token 计数+来源标注(WI条目/注入/历史)

### C3: 五件核心工具

- entry_when: V1 诊断面
- options:
  - A: prompt viewer/WI激活轨迹/变量op日志/生成任务监视/存储检查器 → leads_to: C4
  - B: 只做日志导出 → leads_to: 调试仍靠猜
- source: Luker request-inspector/存储检查器/生成任务实证 §7
- output: 五工具+golden-diff 结果页+degraded 面板

### C4: degraded 可视化

- entry_when: 插件降级
- options:
  - A: 状态栏 degraded 徽标→诊断页详情(缺啥/影响啥/怎么修) → leads_to: 不静默不恐慌
  - B: 只写日志 → leads_to: 用户以为坏了
- source: design/plugin-architecture.md degraded 语义
- output: 降级=可见状态+可操作说明(装依赖/禁用/查看日志)
