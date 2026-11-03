# 对话渲染器 seam(conversationRenderer)

> 状态:IA v3 认可(D-015)。对话呈现=可替换产品面;数据语义永远服务端唯一。

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
或经宿主批准的声明式组件(DSL)在安全域运行——**实现路线是开放问题,见 §6-R2**。

## 5. 渲染器分类学与场景

| 形态 | 交互语义 | 代表 | 状态 |
|---|---|---|---|
| 小说流 | 线性阅读,弱框 | 默认 prose | V1 内置 |
| 气泡 | 即时通讯,强边界 | WeChat/QQ/TG | V1 内置(备选) |
| 论坛体 | 楼层+引用+主题串 | NGA/贴吧/Discourse | 观察项(R1) |
| galgame | 立绘+对话框+选项+backlog | dsh-tavern gal-* | 观察项(R2) |
| 直播流 | 弹幕叠加+时间轴 | 直播回放 | 远期 |

## 6. 调研挂账(research items)

- **R1 论坛体**:楼层编号/引用链/只看楼主/回复通知如何映射到 chat 树与 swipe?引用回复是否产生 branch?需要真实论坛体卡样例验证必要性。
- **R2 galgame**:dsh-tavern `gal-*.js` 精读(scene/choices/backlog/looks/sprites/effects/auto/voice/BGM)。关键问:立绘状态是不是 stat_data 的一种投影?选项(choices)走候选管线还是注入回复?galgame 是"渲染器"还是"面板"的边界——可能更接近卡应用舞台而非对话渲染器。
- **R3 安全面**:第三方渲染器代码执行模型(DSL vs 沙箱 iframe vs 宿主审核清单)。
- **R4 bubble 细节**:合并连续消息/时间分隔线/已读态在 RP 语境是否成立。
- **R5 流式协议**:renderer 对 streaming token 的重排权(增量插入 vs 段落替换),气泡形态下"打字中"指示。

## 7. 验收锚点

- prose/bubble 双渲染器共用 props,切渲染器不丢 swipe/回执/操作
- 卡声明 scheme 生效且用户可覆盖;渲染器缺失回退有提示
- 第三方渲染器注册路径在 TASK-011 插件骨架上可演示(hello-renderer 冒烟)