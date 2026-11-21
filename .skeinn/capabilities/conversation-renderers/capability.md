# 对话渲染器(conversationRenderer seam)

> 对话呈现是可替换的产品面:同一份消息数据,不同皮肤与交互形态。

## Field identity and boundary

对话视图渲染器生态:宿主数据契约、渲染器分类、卡级舞台方案、社区渲染器注册。不含:消息数据生产(core-engine)、面板/CardApp(sandboxed-card-apps)、shell 布局(web-ia)。

## Project scenario

用户要"小说流/微信气泡/论坛体/galgame"随便换;大神能发布渲染器;卡可声明自己的舞台方案。

## Decision tree

### C1: 宿主/渲染器职责切分

- entry_when: 定义 seam 契约
- options:
  - A: 渲染器只拿数据做呈现;消息树/swipe/流式/回执/操作 API 全部由宿主供给 → leads_to: C2
  - B: 渲染器拿原始 chat 自理数据逻辑 → leads_to: 逻辑分叉,兼容受损
- decide_by: 渲染器必须不伤兼容——数据语义只有一份(服务端),故 A
- source: design/conversation-renderers.md
- output: 宿主供给契约:message tree(swipe 兄弟链)、streaming token、变量回执、操作回调(编辑/重生成/更多)、用户排版设置;渲染器只输出呈现+交互手势

### C2: 内置渲染器集合

- entry_when: V1 范围
- options:
  - A: prose(小说流,默认)+ bubble(气泡,微信式)两个 → leads_to: C3
  - B: 只做 prose,其余全插件 → leads_to: 用户首日无备选,生态冷启动差
- decide_by: 需要证明"可换"不是口号——内置两个形态不同的才成立
- output: prose=衬线单列头像+hover操作;bubble=气泡+时间戳+左右分列;注册表 renderer registry 同机制产出

### C3: 卡级舞台方案 stageScheme

- entry_when: 卡声明呈现偏好(对齐 dsh-tavern card-stage-scheme)
- options:
  - A: 卡声明 renderer+scheme 建议 → 用户覆盖优先,缺渲染器回退 prose → leads_to: C4
  - B: 卡强制渲染器 → leads_to: 用户失去控制,坏卡劫持体验
- output: 优先级:用户选择 > 卡声明 > 默认 prose;scheme 只改 token(色/字体)不换布局语义

### C4: 渲染器注册与 UI 贡献点

- entry_when: 插件注册渲染器(论坛体/galgame/直播流…)
- options:
  - A: 插件 ctx.extend 注册 {id,name,Component?,manifest};宿主列表化可切换 → leads_to: V1 后生态
  - B: 渲染器写死在内核 → leads_to: 违背"插件强于我们"
- output: 渲染器=plugin UI contribution 的一种;galgame/论坛体为社区观察项,需求验证后官方再做或插件实现
- note(2026-11 落地对账): web 端 `renderer` 贡献槽至今零注册零消费——「形态切换」实际由 `stage.form` 贡献点承载(chat/novel/messenger/galgame,features/{chat,stagepack}.tsx);prose/bubble 两渲染器只活在 parked 的 apps/mobile(reader/ProseFlow+BubbleFlow),renderer 槽留作线协议词表不算缺口
