# 形态×插件面规划(TASK-044 前瞻)

> 缘起:壳落地后发现缺口不止前端——四种舞台形态+统计面的**数据源在插件层就不存在**。
> 本文档梳理「每种形态需要服务端/插件补什么」,作为后续插件调整/新建的排期依据。

## 现状插件清单

`library`(45) `generate`(5) `delivery`(WS) `mvu`(4) `plugins`(4) `data`(4) `script`(1) `th`(1) `diag`(1+观测面在飞) `import`(2)

## 形态逐个盘

### 1. chat —— 已齐
generate+delivery+state 三族+mvu+th 覆盖。无结构性缺口,剩 polish。

### 2. novel(小说/阅读器形态)—— 需要轻插件
- **章目录**:楼层→章的映射。方案:sidecar `chapters` ns(章节边界标记,不另起存储);
  服务端给 `GET /api/utopinn/chats/:id/chapters` 聚合视图(floor range+首句摘要)
- **章粒度再生成**:现有 swipe 是楼层粒度。需要 `regen --range <fromFloor:toFloor>`
  语义 = 删区间+续生成——generate 插件加 range 参数,runner 多楼删除已支持
- **导出**:txt/md。data 域加 `GET /export/chat?fmt=` 或 import 插件扩——优先级低

### 3. messenger —— 纯表现层,不需要插件

### 4. galgame(剧场形态)—— 需要真插件(最重的形态)
- **场景资产**:立绘/背景引用。角色卡 extensions 已有 assets 概念,library 域补
  `GET /api/utopinn/chars/:id/assets` 清单面(立绘表情差分)
- **选项分支**:两条路——
  a. 生成时让模型产结构化 choices(prompt 层 schema),delivery 帧带 `choices` 字段;
  b. 服务端候选面 `POST /choices`(N 个候选输入由调用方/世界书给)。
  倾向 a:模型端天然会出选项,协议只需加字段,不落新插件
- **场景状态**:当前立绘/背景/BGM 是运行时态 → sidecar `galgame` ns 存,
  前端渲染时读;正则/世界书可驱动切换(注入管线已有 hook 位)
- **结论**:galgame 需要 `generate` 协议加 choices 字段 + library 加 assets 面 +
  sidecar ns 约定;不建议单开插件,除非选项要走服务端计算

### 5. 统计(stats)—— 新插件 `utopinn-stats`
数据源已经全在:jobs 带 perf(ms)/trace(tokens)/status,diag 总线有 inject 事件
(WI 命中条目/时序)。缺的只是**聚合视图**:
- `GET /api/utopinn/stats/summary?range=&by=char|model|day`
  → {generations, tokensIn/Out, failRate, p50/p95 ms}
- `GET /api/utopinn/stats/by-char/:id` → 该卡游玩量/消息数/WI 命中频次
- `GET /api/utopinn/stats/inject` → 各注入源(worldinfo/macro/regex)的注入率+token 占比
  ——制卡调试刚需:世界书哪些条目从来不中、预算被谁吃掉
- 实现:纯读面,扫 job store + diag ring;不写存储(冷数据再谈持久化)

### 6. 插件声明 UI(架构层,最值得想的一条)
前端 kernel 已是贡献点模型;服务端插件将来应该能**声明自己贡献的 UI**:
`ctx.add('ui.panel'|'ui.stageForm'|'ui.nav', {…元数据})` → kernel 汇成
`GET /api/utopinn/contrib` manifest → 前端启动拉一次,面板/形态/导航自动出现。
收益:加插件 = 加服务端文件,前端零改;移动端同理(DSH 思路)。
**风险**:贡献元数据里不能塞 React 组件——只能塞「面板类型+数据路由+图标名」级别的
声明,真正渲染仍归前端注册的 panel.type。这条先记决策点,形态稳了再做。

## 服务端残留面(binding-matrix §5a 尾巴)
插件市场、模型清单、/attach 写面、正则专属面 —— 随对应形态/面板用到再补,
不提前建。

## 排期建议
1. TASK-043 观测面(在飞)→ stats 插件有了数据底座
2. 壳还原完 → novel 章目录 sidecar(轻,先做)
3. stats 插件(制卡调试刚需,优先于 galgame)
4. galgame 三件套(choices 字段+assets 面+scene sidecar)——形态定稿后动
5. ui.contrib manifest —— 最后,等贡献面真实需求出现
