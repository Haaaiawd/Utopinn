# 服务端大脑:prompt组装/世界书/正则/宏 的纯TS移植

- Kind: system
- Status: frozen

> vs-V2: current

## Responsibility in the whole

把当前活在 `apps/server/public/scripts/`(jQuery/DOM 耦合,~30k+ 行)里的生成大脑——prompt 组装、世界书引擎、正则管线、宏/STscript、instruct 格式化、reasoning、变量系统——移植为 `packages/core` 的纯 TypeScript 库。服务端是唯一运行者;web/mobile 客户端只拿结果。这是整个重构里工作量最大、兼容风险最高的单点。

## Alternatives considered

1. **从 Luker 前端剥离 + 特征化渐进移植到纯 TS `packages/core`(选定)**:以 `generate-task.js`/`lukerContext.js` 的 ctx 收口为 seam,逐模块将 `apps/server/public/scripts/*` 去 jQuery/DOM 化迁入纯函数库(零 DOM/fs/网络),以真实语料卡的 golden-diff(`compat-golden-diff.md`)作为行为裁判。代价是初期必须承接原版隐式约定与边界怪癖;收益是复杂社区卡(WI 八位置/次关键字四逻辑门/递归与装饰器/宏求值序/正则三车道/MVU)可验证兼容,且纯库天然支持快速单测与服务端唯一事实源。
2. **抛开原版源码按理解全量重写新引擎**:设计更干净的全新 prompt/lorebook/macro 抽象。被否:SillyTavern 引擎 ~30k+ 行不存在正式规格书,WI 触发顺序、token 预算截断、宏嵌套与正则车道语义均靠历史实现定义;全量重写必然在社区卡上制造系统性隐蔽行为漂移,事后逐卡排查成本远高于特征化移植(见 `capabilities/st-engine-compat` C1)。
3. **纯协议复刻 / 服务端无头跑原版前端引擎(如 dsh-tavern 嵌 ST 前端 frame 或 headless Chromium 执行原版 JS)**:保留原版前端引擎不移植,仅在外围包 REST/WS 协议。被否:引入重浏览器运行态或强耦合 ST DOM 全局,直接破坏性能预算与单进程 Node 服务端架构,无法做确定性毫秒级组装、多端轻量化或 Cordis 插件级管线钩子(见 `DECISIONS.md` D-017/D-018)。

## Inputs, outputs, and boundaries

- 输入:chat(messages + metadata)、角色卡、预设、用户设置、世界书集(角色主/辅/聊天绑定/全局)、正则脚本集、生成模式(normal/continue/regenerate/swipe/impersonate)
- 输出:组装好的 wire 请求(messages[] 或 text prompt)+ 组装元数据(token 预算、WI 注入轨迹、被丢弃的条目、应用的 regex 记录)
- 硬边界:**零 DOM、零网络、零 fs**。外部能力全部经注入端口:tokenizer、密钥、存储读取、时钟。这既是可测试性要求,也是未来(若需要)塞进 RN/其他运行时的保险。

## Components and control flow

```
生成请求 → GenerationContext(数据装配:卡+聊天+设置+书+脚本)
  → variables/floor-state 解析(沿 swipe 路径回放 op-log)
  → regex 管线(input/output 两侧,按 scope:global/card/chat)
  → macros/STscript 求值(消息正文与注入内容两侧)
  → world-info 引擎(扫描→触发→预算→递归/向量化链接)
  → prompt 组装(chat-completions:消息数组编排+顺序/深度注入;text: instruct 模板)
  → token 预算与截断
  → AssembledPrompt + trace
```

移植源对照(见 AGENTS.md 清单):`openai.js`、`world-info.js`、`PromptManager.js`、`macros.js`+`slash-commands/`、`instruct-mode.js`、`textgen-settings.js`、`reasoning.js`、`variables.js`、extensions 内 regex。Luker 的 `generate-task.js`/`lukerContext.js` 已把这些接口化成 ctx 函数,作为抽取骨架。

## Data and state

- 只读输入:protocol schema 定义的资源类型
- 可变状态:chat_metadata.variables(setvar/getvar)、floor-state op-log、chat_state sidecar——经存储 Repo 接口读写,core 本身不碰 fs
- 世界书来源五层:角色主书、角色辅书、聊天绑定、全局激活、内嵌 character_book(格式 `{entries:{}}` 不动)

## Interfaces and dependencies

- 被 `apps/server` 的 generation-api 管线调用
- 依赖 `packages/protocol`(schema)、`packages/formats`(卡片解析)、注入的 tokenizer 端口(apps/server 已有 tiktoken 等)
- 不依赖:express、DOM、jquery、任何 UI

## Failure, safety, and recovery

- 逐卡片降级:坏正则/坏宏 → 跳过该条 + trace 记录,不炸整次生成
- STscript 含命令执行语义(/send、/echo 等有副作用),服务端化后:**求值分纯/副作用两级**,副作用命令在 core 内只产生"意图描述"由管线层执行,防止 core 直接触网/触存储
- 输出上界:token 预算与扫描深度硬上限

## Implementation constraints

- 纯 ESM TS,strict;禁 any-heavy 移植——宁可分阶段移植并维持行为测试
- 行为兼容优先于代码优雅:与原版有出入处按原版为准(golden 说了算)
- 不引入新数据格式;一切读写走现有文件格式
- **缓存稳定不变式(DSH 调研后新增)**:prompt 组装的稳定段顺序恒定——
  卡字段/系统提示/WI 常量条目固定在前,易变段(深度注入/最近消息)在后;
  同卡同聊天重复生成的前缀应逐字节一致(provider prompt cache 命中的前提,
  golden 可断言)
- **消息结算管线(DSH 分步模式的服务端对应)**:`<UpdateVariable>` 块在
  persist 前由服务端解析 → stat_data 写 chat 变量;状态栏模板 × 变量可
  服务端渲染为 display-only 内容(状态栏固化,模型不再重输 HTML)。
  v1 先做单阶段 settle,stage 序列(stream→settle→candidates)接口留位

## Verification strategy

主验证 = compat-golden-diff(见对应设计):同一卡+聊天+设置下,request-inspector 捕获的原版 wireRequest 与 core 产出逐字段 diff。辅以:WI 引擎单元测试(触发/预算/递归表)、宏求值快照测试、regex 管线顺序测试。

## Related documents and capabilities

- compat-golden-diff(验证机制)
- generation-api(调用方契约)
- AGENTS.md 移植清单
