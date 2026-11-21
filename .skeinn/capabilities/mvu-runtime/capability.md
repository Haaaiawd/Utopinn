# MVU 运行时(stat_data projection/settle/状态板)

> MVU 是对聊天日志的投影,不是解析最新块——服务端结算。

## Field identity and boundary

UpdateVariable→stat_data 投影、settle 管线位、状态栏模板服务端渲染、变量回执/op 日志。不含:TH-shim 其余 API(sandboxed-card-apps)、prompt 注入位(core-engine)。

## Project scenario

MVU 类卡要完整跑:变量随时删改旧楼层仍正确;状态板格式永不掉;用户能看见每次变量变化。

## Decision tree

### C1: stat_data = 投影而非快照

- entry_when: 语义建模
- options:
  - A: stat_data = 对全量聊天事件 fold UpdateVariable 的 projection(chatState.registerProjection) → leads_to: C2
  - B: 存最新消息解析出的变量 → leads_to: 删改旧楼层即漂移
- decide_by: MVU 语义本身=全日志折叠;DSH session projections 同构 → A
- source: design/plugin-architecture.md §3d Session Projection;dsh-tavern vendored magvarupdate
- output: settle = projection fold;isolation 用 ctx.isolate(chatId) 每会话独立变量作用域

### C2: settle 管线位与时机

- entry_when: 生成管线集成
- options:
  - A: 服务端消息持久化后 serial 触发 settle(UpdateVariable 解析→op 应用→回执事件) → leads_to: C3
  - B: 客户端发解析请求 → leads_to: 脑裂
- source: design/plugin-architecture.md 事件五模式(serial)
- output: settle 挂在 chat.messagePersisted(serial);失败重试单步;分步管线可并行候选

### C3: 状态板 = 服务端渲染的系统面板

- entry_when: 状态栏 UI
- options:
  - A: stat_data×卡内固定模板 服务端渲染为面板(HTML/markup) → leads_to: C4
  - B: 模型每轮重输状态板 HTML → leads_to: 格式漂移+费 token(dsh-tavern 已验证服务端渲染)
- output: 状态板模板在卡资产内;渲染产物面板化("状态"tab);模板引擎与 TH 兼容

### C4: 变量回执与 op 日志

- entry_when: 用户可见性
- options:
  - A: 每次 settle 产出回执(op 列表 old→new)内联聊天流 + 诊断页全量 op 日志 → leads_to: 可观测
  - B: 静默更新 → leads_to: 调卡人瞎猜
- output: variable receipt(chat artifact)+mes_var_ops 等价日志;回执含"重新结算"操作
