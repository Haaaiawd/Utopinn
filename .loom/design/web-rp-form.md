# web-rp-form — 桌面端「剧场深化」形态(TASK-010 修订)

> 状态:v1 拍板稿(2026-11-04)。调研:ST/RisuAI/c.ai/Chub/Janitor/Agnai/
> Harpy/oobabooga/NovelAI 逐个拆 + 本地 Luker DOM 一手证据。
> 结论:**方案 A——rail+路由骨架不动,把壳填充成 RP 心智**;
> 否决双壳馆/场(IA 附录裁决不变:聊天即舞台是视图态不是导航范式)。
> vs-V2: partially-stale
<!-- V2 校准:P0 大部已在 TASK-040 壳落地,余量随 TASK-026 停泊 -->
<!-- V2.1 修订(2026-11-21,TASK-050 壳):theater 方向重定义 ——
     不做 galgame/VN,是「剧场小说」:聊天楼层演成舞台剧。
     · 台上幕 = 末楼前最近 N 楼:cast 楼 → 头像框+名签+气泡
       (user/persona 归右位,其余 speaker 归左;群聊逐名查卡登台,
       查无此卡 → 首字符圆块,不伪造立绘);旁白楼居中叙述条
       (契约:extra.narrator 显式标 | system 楼 | 无名非 user 楼)。
     · 底条 fixture = extra.choices/swipe 分支 → hotbar(MC 式 9 槽,
       最近楼层 variables 快照多键探测物品数组;点槽 = 退沉浸 +
       openPanel('cardapp'),hotbar 是入口不是全功能背包) → 对话条
       (当前拍 + ▸ advance,推进语义不变)。
     · 左立绘右 persona 的双人位废除;场景契约 extra.scene.bg 不变。
     「形态是渲染器选择,不是平台差异」的判断不受影响。 -->

## 0. 判据

差异化资产(右面板宿主/CardApp 沙箱/renderer seam/诊断域/server-brain)
全部挂在贡献点架构上——换导航范式不伤它们,但也没收益。真正缺的是
**角色=一等对象**的信息呈现。

RP 圈收敛出的底层对象模型只有一棵:**角色 → 会话**(Janitor My Chats
显示 persona、ST select_chat 按角色列、RisuAI SideChatList——我们
charDir 分组已经对了)。

## 1. 该保留(已对齐/独有)

- rail+keyed 路由骨架(已拍板,不动)
- 右面板多板块宿主(Chub Stages 钉位完全同构,我们是行业最完整实现)
- 会话按 charDir 分组
- 沉浸键(收 sidebar+藏 panel→做完全体:收 rail+背景/立绘档位)
- renderer seam(prose 默认)=ST 三态+RisuAI 主题+galgame 的抽象上位
- 预览 tab/diag 板块(行业无人给组装透明度,引水渠)
- Aa 现场排版(不进三层深设置)

## 2. 该补成 RP 心智(P0→P1)

1. **角色页(最大缺口)**:stories 卡格点卡 → **角色页**而非直跳会话。
   封面+greeting 预览+该卡会话列表+编辑/绑定资产(书/预设/面板)入口。
   卡从「文件」变「故事」。c.ai/Chub/Janitor/Harpy/RisuAI 全有这层。
2. **门厅默认落点**:ST 欢迎屏=RP 原生 home——继续上次大卡+故事精选+
   新建/导入快动作。同时服务发现与回访。
3. **舞台头**:ChatView ctbar → 角色头像+名+一行简介+persona 徽标
   (快切,Janitor 输入旁头像先例)+绑定书/预设 chip。
4. **二级栏**:组头脸放大 32px+收藏角色 hotswap 横排(ST HotSwap 先例;
   RisuAI 角色轨的精简取法——吸收方案 B 的精华不做完整轨道)+
   最近段改 Janitor 分组(今天/本周/更早+persona)。
5. **消息惯例进 renderer**:asterisk→muted italic、引号→quote 高亮
   (ST 专色主题已有槽位)、greeting 首条版式待遇(c.ai 居中大字)、
   typing dots。
6. **演出**:stageScheme 落地(卡声明 token)+per-chat 背景入口
   (本局面板)+立绘档(renderer capability sprites 预留位)。

## 3. 形态图(方案 A)

```
┌───┬──────────────┬──────────────────────────────┬──────────────┐
│ U │ ☰            │ ●林澄 雨夜来信 [对话|预览][Aa][⛶]│ 本局│状态│库 │
│   │ 🚪门厅        │ persona:邮递员 ▾ · 书×1 · 预设  │ ┌──────────┐ │
│ 💬 │ + 新会话      │ ◐林澄 greeting(首条版式)      │ │ CardApp  │ │
│   │ 🔍           │ ◑我   "……"(左缘发丝线)       │ │ iframe   │ │
│ 📖 │ ◉林澄    3▸  │ ◐林澄 ▌流式… ◂1/3▸           │ └──────────┘ │
│   │ ★hotswap 横排│ ──轮到你落笔──                  │ 本局注入    │
└───┴──────────────┴──────────────────────────────┴──────────────┘
```

## 4. 与 mobile-reader-form 的关系

同一 seam 两端实例:web 的 prose renderer 与 RN 阅读器共享
`MessageViewModel`/`TypingSettings`/`StageScheme`;移动端把
「小说流」推到极致(零 chrome/章节/书签),桌面端保留舞台头+面板
宿主的管理密度。**形态是渲染器选择,不是平台差异**——同一聊天在
桌面是「剧场」,在手机是「书」,数据零分叉。

## 5. 验收锚点

- 卡格→角色页→会话三级路径;门厅默认落点可关。
- 舞台头 persona 快切生效;绑定资产 chip 真实读数。
- ProseRenderer:italic/quote/greeting/typing 四惯例生效,swipe 不回归。
- stageScheme:卡声明 token 覆盖且用户可覆盖;缺失回退提示。
- 沉浸完全体:收 rail+藏 panel+背景档,进出 <200ms。
