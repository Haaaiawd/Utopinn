# 形态×插件面规划(TASK-044 前瞻)

> 缘起:壳落地后发现缺口不止前端——四种舞台形态+统计面的**数据源在插件层就不存在**。
> 本文档梳理「每种形态需要服务端/插件补什么」,作为后续插件调整/新建的排期依据。
> vs-V2: partially-stale

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

<!-- V2.1 校准(2026-11-21):方向重定义为「剧场小说」壳(stagepack
     TheaterBody)——下方服务端面清单仍成立,但渲染语义变了:
     · 立绘双人位废除 → assets 清单面降为可选(cast 头像用
       /characters/<avatar>.png 卡面图+persona 图,不需要表情差分);
     · choices 契约 = 楼层 extra.choices({text}[] 宽松解析)不变;
     · scene sidecar 落点 = 楼层 extra.scene.bg 不变;
     · 新增旁白契约 = 楼层 extra.narrator(或 system/无名楼自动判);
     · 物品栏(hotbar)读楼层 variables 快照(MVU stat_data 投影,
       多键探测 inventory/items/物品栏/背包/物品/行囊/道具/装备),
       不需要新面 —— set_message_variable 宏族写进快照即生效;
     · stToView 已透传 extra/variables 进 FloorMsg(此前是死钩位)。 -->

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

<!-- V2 校准:stats 并入 diag、ui.contrib 已水合;余量=novel 章目录+galgame -->

数据源已经全在:jobs 带 perf(ms)/trace(tokens)/status,diag 总线有 inject 事件
(WI 命中条目/时序)。缺的只是**聚合视图**:
- `GET /api/utopinn/stats/summary?range=&by=char|model|day`
  → {generations, tokensIn/Out, failRate, p50/p95 ms}
- `GET /api/utopinn/stats/by-char/:id` → 该卡游玩量/消息数/WI 命中频次
- `GET /api/utopinn/stats/inject` → 各注入源(worldinfo/macro/regex)的注入率+token 占比
  ——制卡调试刚需:世界书哪些条目从来不中、预算被谁吃掉
- 实现:纯读面,扫 job store + diag ring;不写存储(冷数据再谈持久化)

### 6. 插件声明 UI(架构层,最值得想的一条)

<!-- V2 校准:stats 并入 diag、ui.contrib 已水合;余量=novel 章目录+galgame -->

前端 kernel 已是贡献点模型;服务端插件将来应该能**声明自己贡献的 UI**:
`ctx.add('ui.panel'|'ui.stageForm'|'ui.nav', {…元数据})` → kernel 汇成
`GET /api/utopinn/contrib` manifest → 前端启动拉一次,面板/形态/导航自动出现。
收益:加插件 = 加服务端文件,前端零改;移动端同理(DSH 思路)。
**风险**:贡献元数据里不能塞 React 组件——只能塞「面板类型+数据路由+图标名」级别的
声明,真正渲染仍归前端注册的 panel.type。这条先记决策点,形态稳了再做。

## 服务端残留面(binding-matrix §5a 尾巴)
插件市场、模型清单、/attach 写面、正则专属面 —— 随对应形态/面板用到再补,
不提前建。

## 附:CLI 人体工学整合层(构想,TASK-044 旁挂)

现状:CLI 动词按 Cordis 插件域切(library/generate/mvu/th/state/diag…)——
覆盖全但导航粒度偏机械。Agent/人在工作流里要的是**任务型动词**:
- `utopinn play <card>` = use+chat-new(无聊天时)一步到位
- `utopinn card-doctor <card>` = doctor+char+scripts+WI 命中预检聚合
- `utopinn watch` = logs tail -f + jobs 活跃轮询合一
实现方向:CLI 内部加一层「编排动词」——不动域动词,只在它之上组合
(ctx 感知+流程闭环+next 提示链)。待观测面落地后做,届时 watch/logs 都有了底座。

## 排期建议
1. TASK-043 观测面(在飞)→ stats 插件有了数据底座
2. 壳还原完 → novel 章目录 sidecar(轻,先做)
3. stats 插件(制卡调试刚需,优先于 galgame)
4. galgame 三件套(choices 字段+assets 面+scene sidecar)——形态定稿后动
5. ui.contrib manifest —— 最后,等贡献面真实需求出现

## V3 落地记录(TASK-044 余量,ns 约定 + 偏差)

<!-- V3 校准(2026-11-22):余量已落地,与上文草拟面的差异逐条记录。 -->

### novel 章目录 —— 已落地
- **ns 约定**:chat_state `chapters` ns,文档形 `{items:[{from,to?,title?,num?}]}`
  (from=章起始 body 楼号;to 缺省=下一条 from-1/末楼,越界钳到末楼)。
  读写走通用 `/api/utopinn/state/chat/*` 面 —— 不设专用写路由。
- **聚合视图**(实际落点,非草拟的 `/chats/:id/chapters`):
  `GET /api/utopinn/characters/:charDir/chats/:chatName/chapters`
  → `{chat,charDir,floors,source,strategy,items[],total,skipped?}`。
  sidecar 清单优先(source:'sidecar'),缺席时按 stagepack 同规则推导
  (source:'derived',strategy: markers|segmented|single|empty)——
  system 楼=分章标记,无标记 4 楼一节,再兜底单章。
  章项 `{index,kind,num,title,range:[from,to]|null,floors,snippet,markerFloor?}`。
- **`regen --range <from:to>`**:落点在 CLI 编排侧(patch 删区间→type:'regenerate'
  续生成),不是草拟的「generate 插件加 range 参数」——本格 utopinn-generate.js
  不在文件域。楼号=body 下标含两端,与章项 range 同口径;群聊不支持(群 regen
  是追加语义);区间不在尾部时新楼落末尾(续生成,非原位回填)。

### theater 三件套 —— 已落地
- **assets 清单面**(实际落点,非草拟的 `/chars/:id/assets`):
  `GET /api/utopinn/characters/:charDir/assets`
  → `{charDir,name,sprites[],backgrounds[],bgm[],empty}`。
  落盘约定沿用既有位:sprites=`characters/<名>/` 顶层图(label 同
  /api/sprites/get 正则),backgrounds=`characters/<名>/backgrounds/`(charx
  落点)+全局 `backgrounds/`。**新约定**:bgm=`characters/<名>/bgm/`+全局
  `assets/bgm/`(charx 不产音频,此为本格新立乐库位)。卡不在→404,
  目录缺席→空数组+empty(不静默造数据)。
- **scene sidecar ns 定名 `scene`**(非草拟的 `galgame`)——ns 名跟着
  floor.extra.scene 取值域走。文档形 `{bg?,bgm?,cast?:[{name,sprite?}],floor?,updatedAt?}`,
  全字段稀疏可选。语义分层:floor `extra.scene` 仍是单楼场景引用(持久契约),
  sidecar `scene` 是「当前场」运行态 —— 客户端切场后写、进场读最新。
  读写通用 state 面,无专用路由。
- choices/narrator 楼层契约(extra.choices / extra.narrator / extra.type)不变;
  结构化产出保持 opt-in(luker_generation.theater|structured)。

### 仍未做
- novel 导出(txt/md)——优先级低,未动。
- generate 插件原生 range 参数——文件域解冻后可视需要把删区间下沉服务端
  (语义不变,CLI 侧可退化为单请求)。
