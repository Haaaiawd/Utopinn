# 浮窗体系调研 —— 右工作台 FloatingWin × 卡应用 overlay/全屏需求

> 纯调研产物。回答:卡的 overlay API 到底要什么、我们宿主链在哪断、
> TH/生态真契约是什么、壳浮窗/卡内浮窗/全屏三层怎么关。

## TL;DR

`ctx.openOverlay/closeOverlay` 不是宿主 API——Luker 源码里不存在,是掌门卡自己的
约定(自己赋值、自己消费)。我们 shim 里的空桩对掌门卡无害,但对「卡想让壳帮
我开/收表面」这个意图是全链死路:shim 不转发、wire 无此方法、host dispatch 无
此 case。卡真正要的是「我的表面在聊天上方可开可收 + 一个常驻入口」,这与壳
FloatingWin 是两套不交通的体系;全屏是设计稿点了名但没落的第三层。

---

## 1. 卡的 overlay API 实际用法(掌门卡实证)

### 1.1 `ctx.openOverlay`/`ctx.closeOverlay` = 零参「卡表面开关」,卡自产自销

**Luker 原生 ctx 没有这两个方法。** `ref/Luker` 全树 grep 零命中——
`context.js`(1407 行 ctx 工厂)里没有这两个键。Luker CardApp 的模型是**整屏
接管**:`loader.js:12 ELEMENTS_TO_HIDE = ['#chat','#form_sheld','#qr--bar']`,
`createContainer()`(loader.js:150-187)藏聊天 UI、容器 `width:100%;height:100%`。

掌门卡的做法是**自己发明这对方法**:

- `cardapp/index.js:2207-2274 adoptOverlayMode(ctx)`——init 时
  `if (ctx.charId && !ctx.parentDoc)`(index.js:2397)触发。注释:「Luker 的
  CardApp 是整屏接管(激活即隐藏 #chat/输入栏)。本卡的戏在聊天里——接管后
  立刻把聊天还回来,容器改可收放浮层」。做法:还原 `#chat/#form_sheld/
  #qr--bar` → 容器加 `.zb-ovl`(fixed inset 0、z-30000、`.open` 才吃
  pointer-events 并罩 `rgba(10,8,6,.55)` 暗幕)→ 容器抬到 body 级 → 造
  `#zb-launch` 浮钮(78px 线装书,可拖,位置存 localStorage)+ `#zb-fold`
  收起钮 → `setOpen(true)` → 4s 看门狗 + MutationObserver 收尸。
- **关键行 index.js:2254-2255**:`ctx.closeOverlay = () => setOpen(false);
  ctx.openOverlay = () => setOpen(true);`——卡把方法**赋值到 ctx 上**,自己消费。
- **唯一调用点 index.js:926-931 sendMsg**:`try { ctx.closeOverlay?.(); } catch {}`
  → `ctx.sendMessage`。注释:「发言先收层——戏在聊天里演,案头别挡着」。
  `?.` 防御说明卡早知道宿主可能没有。
- `ctx._zbOff`(index.js:2613)是卡内事件解绑助手,与 overlay 无关。
- `dressLaunch`(index.js:2184-2195)在 `ctx.container.ownerDocument` 和
  `ctx.parentDoc` 两个文档里各找 `#zb-launch` 上皮。

**这对 API 的语义 = 「开/收我的面板表面」,零参数,不传尺寸/内容/位置。
卡没有第二层请求——它就是表面本身。**

### 1.2 JSR 面:卡在父文档里自建真浮窗

`cardapp/jsr/shim.js`(JS-Slash-Runner 宿主适配):

- shim 在 **`window.parent.document`** 注入 `#zb-wrap > #zb-overlay`——
  `position:fixed;inset:4% 4% 6% 4%` 的可拖浮窗(style.css:583-587,拖柄
  `#zb-drag` pointer-capture,shim.js:42-54)+ `#zb-launch` 浮钮 +
  `#zb-close` 收起钮。
- ctx 赋值(shim.js:308-309):`openOverlay: () => wrap.classList.add('open'),
  closeOverlay: () => wrap.classList.remove('open')`——同语义,切 `.open`。
- 移动退化(style.css:596-601):`@media(max-width:699px)` → `inset:0` 去圆角
  = **事实全屏**,拖柄隐藏,收起钮变右下浮丸。
- 双通道去重:Luker card_app 在场 → JSR 让位;pid 探针防 webview 僵尸 DOM。

### 1.3 卡内第二层弹层:openSheet 族(全在 ctx.container 内)

- `openSheet(ctx,title,bodyHtml,onBind)`(index.js:1414-1436):通用条子,
  `.zb-review.zb-sheet` div append 进 ctx.container,单实例,role=dialog,
  Esc/遮罩/「先放着」关。调用面:区域/人物/山门建筑/账册条子。
- `openReview`(index.js:877-899):「今日拟办总览」同族。
- 这层**完全卡内自治**,容器多大弹层多大。

### 1.4 有没有「全屏」诉求?

**没有向宿主请求全屏的语义,反而是反向的**:卡在 Luker 里拿到的是全屏接管,
它主动改成浮层。窄屏(<700px)时卡**自己**把浮窗 inset:0 成全屏态。读报/舆图/
名册这些大内容面也没有单独的全屏请求——它们就是案头 tab 页 + openSheet 条子。

`ui.test.cjs:319-341` 把 `adoptOverlayMode` 列入 16 个受保护函数 sha256 钉死
——卡的浮层逻辑**不许被 UI 改造改动**。

---

## 2. 我们宿主链实况 —— 断点表

### 2.1 API 调用在哪断

| 卡侧调用 | 卡要什么 | shim | wire | host | 结果 |
|---|---|---|---|---|---|
| `ctx.openOverlay()` | 打开/聚焦我的表面 | ctx-shim.js:426 **本地空函数** | panels.ts 无此法 | ctxHost 无 case | **死在 shim**;掌门卡自覆写故无感 |
| `ctx.closeOverlay()` | 收起表面(发言前) | 同上 | 同上 | 同上 | **死在 shim**;卡覆写后只能收起 iframe 矩形内的层 |
| `window.parent.document` 注入 | 宿主级浮窗/FAB | opaque 沙箱抛 SecurityError → parentDoc null | — | — | 不可能;sameOrigin manifest 才给真值 |
| `adoptOverlayMode` | 容器变宿主级浮层 | 在 iframe 内照跑(charId 真值+parentDoc null 命中) | — | — | 降级可跑:fixed inset:0 变成 iframe 盒 |
| `openSheet/.zb-review` | 面板内弹层 | 容器内 DOM | — | — | 可用,被 iframe 尺寸裁剪 |
| `requestFullscreen` | 真全屏 | iframe 无 `allowfullscreen` | — | — | 不可用 |
| `localStorage`(浮钮位置) | 位置持久 | opaque origin 下抛错→卡 safeGet 吞 | — | — | 静默失效 |

### 2.2 CardApp iframe 实际挂在哪、多大

- 挂载:`SpecPanels.tsx CardAppMount`——`ledger` 与 `cardapp` 两 panel.type
  共用,取 `s.chat.charDir/chatName`,无 chat → 引导空态;不消费 panelParams。
- iframe:`.cardapp-frame` flex:1 填满 `.cardapp-host`(spec.css:288-291);
  模块壳 `#card-app-container` **零几何 CSS**(assets.js:139)——容器尺寸
  全靠卡自己(掌门卡靠 zb-ovl fixed 自救)。
- 尺寸三态:工作台 290–min(680,56vw) 默认 410;FloatingWin 380px ≤76vh;
  移动 sheet snap closed/half/full(openPanel → half)。
- sandbox:`allow-scripts` opaque;`allow-same-origin` 仅 manifest
  `permissions.sameOrigin===true`;**无 allowfullscreen/popups/modals**。
- `sameOrigin:true` 的卡在宿主里 `ctx.parentDoc` = 宿主主文档,真可挂 DOM
  ——能力真给,值得记录边界。

### 2.3 FloatingWin(壳浮窗)实况

- Workbench.tsx:234-282 + App.tsx:373-386。单实例 `floatingType`。
- 标题栏拖动,夹取边界;钮 = dockBack + closeFloat。**无 resize、无
  minimize、无持久化**。
- `detachPanel`:floatingType=type + openTabs 移除 → PanelBody 在 FloatingWin
  重挂 → **cardapp iframe 整树 remount = 卡完整重启**(chat_state 不丢;
  DOM 现场/草稿/拖拽位置蒸发)。dockBack 同病反向。
- 移动端不存在(仅桌面分支);mobile 面板落底 sheet。

### 2.4 MessageIframe(楼层帧)

- 宽=聊天列 100%,autoheight postMessage 自适应(32–4000px);
  `sandbox="allow-scripts"` 恒 opaque;无 overlay 通路——楼层 iframe 永远
  是楼层矩形内内容。(C13 生态本就禁「iframe 里假装宿主浮窗」,一致。)

### 2.5 移动端(apps/mobile)

- 面板 = 底导航 PanelWebView flex:1 全屏 WebView;ctx-only manifest →
  degraded 徽标。浮窗无对应物——移动端形态天然 = 全屏页。

---

## 3. TH/生态真契约

### 3.1 JSR/TH 侧:没有 overlay API,浮窗 = window.parent DOM 注入

`ref/extensions/JS-Slash-Runner` overlay 命中全是它自己设置面板的
Popup/Dialog,不给卡 API。生态做法(TavernWeave 制卡库 C13 浮窗式状态栏):

- 浮窗 = 在 **ST 宿主 document** 建的独立 content surface:相对可视视口
  定位、可拖可缩放、内容常由 iframe 承载、关闭后可由 Wand/悬浮球/页面钮
  重开、刷新可恢复 rect。明令「**不在消息 iframe 内写 position:fixed 假装
  宿主浮窗**」——正是我们沙箱强加的形态。
- 双状态机:壳(closed→opening→visible→dragging/resizing/collapsed→
  failed→destroyed)× 内容(idle→loading→ready→stale→refreshing);
  几何绝对像素持久化,MIN 280×320、EDGE_GAP 8,挂宿主 localStorage;
  `hostWindow()` 从 `window.parent` 取宿主窗;视口过小 → 转抽屉。
- C11 悬浮球:常驻可拖 launcher(掌门卡 #zb-launch 即此型),入口/命令/
  外壳/内容四层;「悬浮球消失时已打开的浮窗仍可独立存在」。

掌门卡 JSR shim 是这套契约的标准实现。**生态没有「openOverlay 方法调用」
协议,卡要的是一块宿主文档级的挂载面**。opaque origin 下 DOM 注入本质不通,
我们的对应物只能是「壳替卡开一个表面」。

### 3.2 dsh-tavern `ctx.tavernUi.openOverlay`(另一种契约,跨不了桥)

- API:`openOverlay({gameId?, render, dismissible?, onClose?})` → 「打开一层
  盖住整个页面的插件界面,适合战斗、地图这类需要大空间的玩法」,返回
  `{close}`;Esc 关;卸载自动关。
- 实现:body 挂 `.dsh-tavern-plugin-overlay`,fixed inset-0 z-2000,
  role=dialog。
- **形态 = 整页覆盖层,不是可拖浮窗**;插件与宿主同 realm、返回 React
  element——**签名过不了 postMessage 桥**。它证明「卡有合法的全屏覆盖诉求」,
  不是可抄的线协议。

### 3.3 GuiXu 参照

`ref/cards/GuiXu/js/components/intro-modal.js:114` 的 `closeOverlay` 是组件
内部局部函数,与 ctx API 无关——归墟卡不用这对方法。

---

## 4. 设计稿既有表述

- **D-022**(DECISIONS.md):CardApp/TH 兼容形态 = 悬浮窗 + 右侧栏(整体优先,
  兼容后置);移动端落底 sheet。
- **规范稿 web-ui-mockup.html**:L421 本局面板卡内条目「▸ 背包(卡应用)→
  全屏打开」;L692 ST 对照表「CardApp/面板 → **本局面板→全屏**;应用列表→
  沉浸容器」——**全屏容器是设计稿点名的形态,未落**。
- **web-slots-architecture.md**:明确否决 dockkit 全量 split 树/浮窗——多浮窗
  是有意 descope。
- **cardapp-web-host.md**:宿主设计没提浮窗/全屏。

---

## 5. 三层关系分析

```
L0 卡内弹层     .zb-sheet/.zb-review(openSheet/openReview)
              │ 容器内 DOM,零宿主依赖;被 iframe 矩形裁剪 → 可用
L1 卡表面开关   ctx.openOverlay/closeOverlay(卡发明的零参语义)
              │ = 「显示/收起我的表面」;真实用途:发言前收层看戏
              │ 现状:shim 死桩+wire 无此法;卡自行在 iframe 内模拟
L2 壳浮窗      FloatingWin(detachPanel→floatingType→PanelBody 重挂)
              │ = 板块级「拆出去」,卡无发起权
              │ 现状:单窗/380定宽/无resize·min·持久化/detach=卡重启
L3 全屏/沉浸    theater z-[78] portal + requestFullscreen
              │ 现状:仅剧场舞台私有;设计稿「本局面板→全屏」未落
```

- L0→L1 的缝:卡的层只能在 iframe 盒内。「收层看戏」收不掉工作台壳,
  聊天仍被面板挡。
- L1↔L2 错位:卡的 open/close 管「表面可见性」,壳的 detach/dock 管
  「表面挂哪个容器」。卡要「收」≈ 工作台折叠/sheet snap,不是 detach。
- L2↔L3 缺梯度:380px 与整屏之间没有中间档;theater `fixed inset-0 z-[78]`
  portal 形态与浮窗(z-70)/抽屉(z-50)/toast(≥80) z 序兼容——可复用。
- 移动端退化一致:浮窗→底 sheet,全屏→专属页/portal;C12/C13 共识:
  手机不强保浮窗。

---

## 6. 设计建议(⚠️ 建议,不是事实)

1. **`ctx.openOverlay/closeOverlay` 定成「表面可见性」线协议**(非 dsh render
   回调,不可序列化):open → openPanel/聚焦;close → 工作台收起/sheet
   snap closed——「发言收层」这才兑现。
2. **detach/dock 不杀卡**:不搬组件,把整个工作台 aside 变浮窗壳——同一
   React 子树+同一 iframe,零 remount。
3. **卡入口 manifest 声明**:`card_app.surface:{launcher,preferred,minWidth}`
   → 壳给一等入口;卡 FAB 出不了 iframe 是事实非缺陷。
4. **全屏档复用 theater portal**:CardApp 面板头「全屏」钮 → portal 提升
   `.cardapp-host`(同树不 remount);iframe 补 allowfullscreen。
5. **楼层帧保持封闭**:生态 C13 同向,文档化为接受降级。
6. ~~多浮窗维持否决~~ **已被用户需求推翻(2026-11-22)**:逐板块多浮窗
   落地——Pool 槽位同 DOM 换 class,浮出/收档 iframe 零 remount;
   `WbLayout` v3 {openTabs, activeTab, floatOrder, floatRects} 按会话
   持久化,v2 档自动迁移;z 序只改 zIndex 不搬 DOM(池序 append/
   remove-only 是隐性不变量——以后给池子加重排逻辑会 reload iframe)。

## 7. 未决/待验证

- `sameOrigin:true` manifest 卡挂宿主 DOM 的边界要不要收紧。
- 浮窗 380px vs 卡 minWidth 声明的协商口。
- `panelParams`(hotbar → openPanel 定位)并入 surface payload 的机会。
