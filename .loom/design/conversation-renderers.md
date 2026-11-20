# 对话渲染器 seam(conversationRenderer)

> 状态:IA v3 认可(D-015)。对话呈现=可替换产品面;数据语义永远服务端唯一。
> vs-V2: partially-stale
<!-- V2 校准:落地形态=stage.form 贡献点(stagepack),renderer 槽零注册,prose/bubble 仅在 parked mobile -->

## 0. 第一约束

渲染器只负责**呈现与交互手势**。消息数据、swipe 兄弟链、流式 token、变量回执、操作回调、排版设置全部由宿主供给——渲染器拿不到原始 chat 文件,不能自行解释消息。这样换皮肤不伤兼容,渲染器生态可放生。

## 1. 宿主供给契约(host → renderer)

```
ConversationViewProps {
  messages: MsgTree        // 含 swipe 兄弟链、编辑历史、角色/persona 头像与名
  streaming?: StreamToken  // 增量渲染 token 序列(不重排已渲染块)
  receipts: Receipt[]      // 变量回执/系统产物(MVU op、候选行动)
  actions: { edit, regen, swipe(i), branch, more }   // 宿主回调,渲染器不实现语义
  typing: TypingSettings   // 字号/行距/栏宽/字体(服务端同步的用户排版)
  scheme: StageScheme      // 卡声明的配色/字体 token 覆盖(仅 token)
  on: (evt)=>dispose       // 渲染器可订阅宿主事件(新消息/回执/typing 变更)
}
```

渲染器返回:`{ mount(el), unmount(), capabilities: {threaded?, bubbles?, sprites?} }`。
宿主按 capabilities 决定哪些宿主控件回退渲染(如 swipe 由渲染器自绘或宿主覆盖层)。

## 2. 内置渲染器(V1)

| id | 形态 | 要点 |
|---|---|---|
| `prose` | 小说流(默认) | 衬线单列 680px、32px 头像、hover 二级操作、章节标题、回执内联 |
| `bubble` | 气泡(微信式备选) | 左右气泡+头像+时间戳、swipe 角标、紧凑间距;排版设置仍生效(字号/密度) |

两形态必须**共享同一份 props**——这是 seam 成立的自证。

## 3. stageScheme(卡声明舞台方案)

对齐 dsh-tavern `[data-dsh-card-stage-scheme]`:卡可在 card_app/扩展字段声明
`{ renderer?: "galgame-x", scheme?: { ink, surface, fontReading } }`。
优先级:**用户选择 > 卡声明 > prose 默认**。scheme 只覆盖设计 token 不改布局语义;卡声明的渲染器缺失时回退 prose 并提示(不静默)。

## 4. 社区渲染器(插件注册)

插件 `provide: "conversationRenderer"`,注册 `{id,name,manifest,componentUrl}`。
渲染器代码与卡代码同不可信等级 → 与 CardApp 同沙箱通道渲染(panelBridge 管线内),
或经宿主批准的声明式组件(DSL)在安全域运行——~~实现路线是开放问题~~,**已收账见 §7-R3**。

## 5. 渲染器分类学与场景

| 形态 | 交互语义 | 代表 | 状态 |
|---|---|---|---|
| 小说流 | 线性阅读,弱框 | 默认 prose | V1 内置 |
| 气泡 | 即时通讯,强边界 | WeChat/QQ/TG | V1 内置(备选) |
| 论坛体 | 楼层+引用+主题串 | NGA/贴吧/Discourse | 观察项(R1 已收:v1 可纯皮,缺语料) |
| galgame | 立绘+对话框+选项+backlog | dsh-tavern gal-* | 观察项(R2 已收:形态=渲染器,实现=宿主插件,非 V1 内置) |
| 直播流 | 弹幕叠加+时间轴 | 直播回放 | 远期 |

## 6. 形态定义(renderer / panel / overlay 判定规则)

判定规则:**看输入,不看长相**。输入是整个消息流/可见楼层集的是渲染器;输入是声明式状态切片(命名空间/变量投影)且可写状态的是面板(CardApp);只往宿主 chrome 上挂控件(按钮、通知、状态栏分节)的是 overlay/action。

- **渲染器(renderer)**:宿主信任域代码或声明式 DSL;读 `MessageViewModel[] + streaming + receipts`;不写状态;动作全走宿主回调。证据:dsh stage 插件 `galCoverChat` 盖住承载同一回复的聊天视图(`packages/dsh-tavern-stage/src/client/navigation.cjs:15-36`),`stageViews` 槽位渲染同一 session 数据(`tavern-plugin/src/client/gal-stage.js:2-4,181-305`)。
- **面板(panel)**:卡内沙箱代码,只过 bounded API(ctx/th 面 + 声明投影),"Only visible source text and declared variable projections cross this bridge; never chat/session context"(`tavern-plugin/src/client/widget-sandbox.js:2`);挂载在命名 region/slot;可写声明过的命名空间。证据:`extensions.dsh_stage` iframe + backdrop/hud/takeover regions(`tavern-plugin/src/client/card-stage.js:1-6,35-139,243-298`)。
- **overlay/action**:宿主 chrome 扩展点,作用域小、不进对话流。证据:`registerPanel`/`registerStatusSection`/`messageActions` 一族(`tavern-plugin/src/client/features/plugin-extensions.js`),Luker 消息操作位 `mes_buttons`(`ref/Luker/public/index.html:7808-7838`)。

反推:**渲染器不可能是卡内代码**——卡沙箱拿不到消息流全文,这是 dsh 用真实代码划出的线。卡自带的渲染器在 dsh 里也是**卡域插件**(代码不进卡、不进沙箱,按 card.path 限定可见性,`features/card-plugins.js:26-32` + `plugin-extensions.js:949-956`),卡声明的只是 id。

## 7. 调研收账(R1-R5)

### R1 论坛体——v1 可做成纯皮,模型零改动(缺真实语料验证)

- 楼层=消息。dsh 把消息直接叫"楼层"(`modules/mvu-variables.js:125-135`「楼层 #messageId」);我们的 `MessageViewModel.id` 同理,楼层号是显示计算(playable 序号或 id 皆可,渲染器自选)。
- 引用/回复=**显示层注解,不进模型**。线性带没有 reply-to 字段;如需跳链,宿主在 `receipt`/`extra` 里供 `replyTo: messageId` 提示,渲染器画跳链——与 Luker `extra.display_text` 的显示层先例同级(`ref/Luker/public/script.js:4604,5342`)。
- swipe=该楼层的备选版本,折叠成「N 个版本」角标即可,无语义冲突。
- 只看楼主=渲染器内按 `name` 过滤视图,不改数据流。
- 回复通知=宿主 receipt/通知,不进消息流;另开帖/串分支=已有 branch/fork 能力(`assistant-renderer.js:737-748` 逐楼层 `tavernConversationForkRequests`;Luker `index.html:7823` mes_create_branch)。
- 唯一真正的模型缺口是**多线程主题串**:一条 chat 是一条线性带(回滚/重生成轮次留在节点列表但行隐藏,`features/turn-history.js:70-72`;`regeneratedDshTurns` 把再生成轮映射回剧情轮,`ui/message-frame.js:354-362`),渲染器不能凭空造出模型没有的线程——只能按解析出的正文约定(如 `@topic:` 行,`@bubble` 先例见 `src/client/bubble-line.cjs:24-91`)视觉分组。
- **结论**:论坛 v1=线性带上的皮肤(楼层框+版本角标+名字过滤+可选引用跳链),排期在 bubble 之后;`replyTo`/topic 字段是否进 schema 等真实论坛体卡语料再定(ref/cards 目前只有 GuiXu,无论坛体样本)。

### R2 galgame——形态是渲染器,实现是宿主插件,不是面板

- **归属判定的关键证据**:`gal-stage.js:2-4` 自述 "A presentation of the same reply the chat view shows: it never writes story, variables or prompts. The session runtime owns text…";`navigation.cjs:15-36` `galCoverChat` 用 `content-visibility:hidden` 盖住聊天视图(底层 DOM 保留)。它替换对话呈现——这是渲染器的定义,不是面板(面板写状态、挂 region)。
- **但实现不是卡内代码**:整个 stage 是按需加载的第一方插件包 `dsh-tavern-stage`(`stage-client-loader.cjs:1-11`——卡不开舞台就完全不下载不执行),经 `bindStageViews(createViews)` 把视图绑进 `stageViews` 稳定槽(`gal-stage.js:181-305`),宿主一次注入 ~100 个服务能力。
- **卡声明的是"要不要舞台",不是舞台代码**:`extensions.stage.enabled` 经 `cardStageMode` 投影成 `{dialogue,stage}`(`packages/dsh-presentation-protocol/src/card-stage-mode.cjs:4-8`),服务端 `effectiveCardStage` 按 本卡关闭>全局开启>本卡开启>全局关闭 解析(`lib/domain/card-stage-settings.js:73-99`),发进 `view.stage.{dialogue,stage}` 由客户端消费(`stage-client-loader.cjs:4-11`)。「对话气泡」与「舞台模式」是同一机制的两级(stage 需要 dialogue 在效,`card-stage-settings.js:99`)。
- **立绘状态不是客户端从 stat_data 现算的**:服务端方向投影产出呈现读模型(`getStageDirection`/`getAssetPackPresentation` RPC,`stage-session-binding.js:29`;每轮 `replyProjections`,`message-frame.js:333-345`);卡侧代码只拿声明过的投影(`widget-sandbox.js:2`)。对我们:stat_data 的"舞台投影"应是服务端产物,渲染器消费 typed 读模型,不消费原始变量。
- **选项走候选管线,不是注入回复**:`task.kind==='candidate'` → `task.result.candidates` → `submitCandidateTask`/`rpc('stopChoices')`(`gal-choices.js:5-37`);重生成四类目标(正文/MVU/舞台指导/选项)全部打回宿主 RPC(`gal-regenerate.js:62-97`)。
- **对我们**:galgame 形态属 seam,但所需服务超出 MessageViewModel(方向投影/素材包/音频/节奏等七组,`stage-session-binding.js:23-44`)→ manifest 需 `requires` 声明额外服务面;**V1 只内置 prose/bubble,galgame 家族降为插件域观察项**。舞台还能向普通聊天回挂呈现槽位(`gal-history.js:99-104` StageEnterHere/Paragraph/Markdown)——renderer↔宿主粒度可以到"楼层内一段",不止整视图替换。

### R3 第三方渲染器执行模型——宿主域插件+错误边界+内置回退;沙箱渲染器不做

dsh 的三层执行模型,逐一对照后定路线:

- **插件(宿主 JS 域,可信代码)**:`registerTurnView({id,label,render})` 注册"正文视图",`render(input)` 返回节点,宿主用错误边界包裹、null/异常回退内置渲染(`plugin-extensions.js:888-897,975-985,1011-1018`);stage 插件同构(`ctx.plugin()` + `bindStageViews`)。gal-*.js 的耦合度(~100 项注入服务)证明这类代码必须宿主信任——沙箱化等于把整条消息流+增量管线+操作回执镜像进 iframe,协议成本不成立,且 RN WebView 的输入法/滚动问题未解。
- **mod(声明式+受限 runtime)**:manifest 声明 `permissions`/`provides`/`settingsSchema`,`runtime.js` 只出 `prepare/command/settled/dispose` 纯逻辑,不画 DOM(`mods/timer/runtime.js`、`mods/demo/manifest.json:12-35,82-187`);mod 的舞台视图由 stage 代画(`getModStageViews`,`gal-stage.js:196`)。借鉴点:`settingsSchema` 字段类型(text/toggle/slider/segmented/colour/asset-picker/sound-picker,`packages/dsh-presentation-protocol/src/mod-contract.cjs:10`)可直接复用为渲染器设置面;`provides` 契约形态(`mods/timer/manifest.json:21` contract+operations+resource scope)可借给 renderer manifest 的 `requires`。
- **卡代码(沙箱 iframe)**:TH 面 + 声明投影,永远拿不到 chat/session 上下文(`widget-sandbox.js:2`;`card-stage.js:160` `sandbox="allow-scripts"`)。
- **结论**:第三方 renderer=宿主域插件(`manifest.targets` 限定 web/mobile);渲染器选择记忆按 dsh 先例 用户存储选择 > 卡自带插件视图 > 第一个可用 > 内置(`plugin-extensions.js:941-961`,`TAVERN_VIEW_BUILTIN`);卡只声明 renderer id + scheme tokens(`theme.vars` 是服务端校验过的纯 token,`card-stage.js:131-133`),永不注入渲染代码。**iframe 沙箱渲染器 V1 排除**,沙箱通道留给 CardApp 域。

### R4 bubble 细节——头像/合并/时间线成立,已读态不成立

- **说话人身份三级**:`name` + 每楼层 `force_avatar`(群聊每楼层一头像一名字,Luker `script.js:5402-5419,5580-5593`;群头像拼贴 `index.html:7870-7878`)+ 卡内别名解析(dsh `@bubble:alias|name|mood|[line]`,`bubble-line.cjs:24-34`;alias→头像/颜色查卡设置,未知别名用字母占位,`bubble-line.cjs:165-177`、`bubbles.js:1-5`)。我们的 `name+avatar` 双字段同时覆盖两种模型。
- **合并连续消息**:dsh 的气泡是**消息内**多说话人行(`parseBubbles` 把一条回复切成 markdown+bubble 段,`bubble-line.cjs:37-91`);跨楼层合并会掩盖楼层级操作(swipe/edit 按楼层走)→ 规则:**渲染器可合并 chrome(头像/名字只画一次),楼层身份与操作永不合并**,宿主经 `MessageRenderContext.sameSpeakerAsPrevious` 供给提示。
- **时间戳/分隔线**:每楼层有 `send_date`(`index.html:7805`;title 附 api/model,`script.js:5496`),分隔线是纯显示计算,渲染器自由加。
- **已读态**:RP 单人语境无语义——两份代码库均无对应物,不进契约。
- **气泡尾/紧凑密度**:token 层解决;排版设置(字号/密度)仍全局生效(契约 §2)。
- **thought/内心**:`[*…*]` 行内标记(`bubble-line.cjs:31`),渲染器样式差异项,不进消息 schema。

### R5 流式权力边界——可缓冲/定速/暂存,不可重排/改写/合成

- **宿主侧增量**:Luker 33ms flush 节流喂 DOM(`scripts/message-takeover.js:23`);dsh 每楼层 `data.blocks`(kind text/reasoning,status running/interrupted)整块快照,由 React diff 承担增量(`assistant-renderer.js:522-528,643-674`)——两种都证明 token 粒度契约可以停在"追加文本块",渲染器不需要逐 token 协议。
- **渲染器可以的**:打字机定速回放已落定文本(dsh Typewriter 按 `reading.textSpeed` 逐字,`packages/dsh-tavern-stage/src/client/controller.cjs:1107`、`text.cjs:4`);对**未完结行尾**暂不上屏(流中 `@bub` 半成品行不出屏,`bubble-line.cjs:68-80`);折叠、装饰、按 capabilities 自绘 chrome。
- **渲染器不可以的**:重排块/楼层顺序(块序是宿主权威);改写已落定文本(切 swipe/编辑=宿主整条 `onUpdate` 重发);合成消息;持久化任何东西。
- **切 swipe=整条替换**:dsh 再生成轮留节点列表但行隐藏 + storyTurn 重映射(`turn-history.js:70-72`、`message-frame.js:354-362`);Luker `swipe_id` 换 `swipes[i]` 整条(`script.js:5376-5378`),`swipe_info[i]` 里每 swipe 独立 extra/reasoning/var_ops(`script.js:6813-6819,6895-6897`;`variable-op-log/floor-ops.js:14-36`)——故 `SwipeView` 按 swipe 独立携带 reasoning/receipts。
- **打字中指示**:bubble 下"对方正在输入"= streaming 楼层存在且 text 仍空——view 层供 `streamingMessageId`,不发明状态。

## 8. 验收锚点

- prose/bubble 双渲染器共用 props,切渲染器不丢 swipe/回执/操作
- 卡声明 scheme 生效且用户可覆盖;渲染器缺失回退有提示
- 第三方渲染器注册路径在 TASK-011 插件骨架上可演示(hello-renderer 冒烟)
