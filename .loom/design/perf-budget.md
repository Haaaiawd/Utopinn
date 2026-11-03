# 性能预算:为什么老酒馆/Luker 卡死,以及我们怎么结构性解决

- Kind: experience
- Status: draft
- 动机:用户实测——原版 SillyTavern 与 Luker 在手机和桌面端都卡顿严重。
  本节把卡顿拆成机制级原因清单,并给出对应的架构级对策与可测预算。

## 1. 原版卡顿的机制级归因

| # | 病因 | 机制 | 量级 |
|---|------|------|------|
| P1 | 每楼层一个 iframe | TH 楼层应用/`<pre>` HTML 文档按消息逐帧挂载;百层聊天 = 百个 iframe | 移动端致命:每 iframe ~30-100MB RSS |
| P2 | 客户端跑 WI/正则/宏 | 每次生成前 WI 全量扫描+正则管线跑在 UI 线程 | 主线程阻塞,输入卡顿 |
| P3 | jQuery 全量 DOM 重渲 | 消息更新 → 整个聊天 DOM 重建;无虚拟化 | O(N) DOM 节点常驻 |
| P4 | 流式逐 token 全量重解析 | markdown + 正则 + sanitize 每个 token 重跑 | 生成期间 UI 掉帧 |
| P5 | 卡资源全量驻留 | 30MB 卡(base64 素材/地图库)一次进内存 | 启动慢 + 持续占用 |
| P6 | 轮询式刷新 | 卡脚本 setInterval 轮询变量/DOM | 后台常驻 CPU |
| P7 | 移动端零优化 | 1000px 断点硬凑,DOM 结构为桌面设计 | 布局抖动+触控延迟 |
| P8 | 字体/素材无预算 | 卡内嵌大图原样渲染,无懒加载/缩放 | 首屏卡顿 |

## 2. 我们的结构性对策(架构内建,不是优化项)

| 病因 | 对策 | 落点 |
|------|------|------|
| P2 | WI/正则/宏/prompt 组装全在服务端 | `packages/core` 已就位;客户端零计算 |
| P3 | 聊天列表虚拟化(只挂可见楼层) | LegendList(已选定,apps/mobile) |
| P4 | 流式增量渲染 + 服务端一次性正则 | streamdown 增量 markdown;正则只跑在 persisted 消息上 |
| P1 | 楼层应用预算制:同屏可见楼层才挂载 WebView,滚动卸载;`render.depth` 语义保留(T0 默认挂 0) | floor-mount 调度器(待建) |
| P1 | 后台脚本合并:多个 headless 卡脚本共享一个隐藏 WebView(worker 化候选) | 面板宿主 |
| P5 | 服务端 CDN 代理 + 卡资产按需取;素材不进消息流 | `/api/cdn-proxy` + assets 路由 |
| P6 | 事件驱动替代轮询:变量更新经 WS 推送,卡代码只响应事件 | `th.event` 推送通道已建 |
| P7 | 移动原生壳:NativeWind/RN 原生组件,无 DOM hack | apps/mobile |
| P8 | 卡资产清单懒加载;profile 阶段就拆出资源表 | `analyzeCardRuntime.remoteResources` |

## 3. 性能预算(验收指标,后续任务要对着这些数字跑)

- **冷启动**:移动端正屏聊天页可见 < 3s(4G,面板不阻塞)
- **聊天滚动**:500 楼层列表滚动 60fps(LegendList 虚拟化,挂载≤视窗+缓冲)
- **楼层应用**:同屏活动 WebView ≤ 3(超出的楼层应用降级为"点击展开"占位);WebView 总数硬上限 8(滚动卸载)
- **面板页**:单 WebView;takeover 卡冷启白屏 < 2s(远程资源经代理缓存)
- **流式**:token→屏幕延迟 < 150ms 增量渲染;服务端不做逐 token 正则(只在 final persist)
- **内存**:面板+后台脚本 WebView 合计 < 400MB(移动端,超 budget 触发降级卸载)
- **服务端**:WI+正则+宏 全管线 < 50ms/生成(4095 ctx 典型负载)

## 4. 明确不做的事

- 不做客户端 WI/正则引擎"快速路径"——双引擎必然发散,直接不做
- 不做楼层应用的同层 DOM 注入——WebView 沙箱就是边界,性能代价用预算控制
- 不卡 TH 脚本数量上限——卡声明多少挂多少,但全部共享 headless 容器+事件驱动

## 5. 测量与验收

- golden 管线扩展:断言不止"内容一致",也断言"管线耗时"—服务端计时进 trace
- 移动端冒烟脚本:固定卡+500 层合成聊天,录滚动 fps 与内存
- 面板页冷启计时纳入 E2E

## Related

- design/mobile-panels.md(挂载面分层)
- design/core-engine.md(服务端管线)
- capabilities/sandboxed-card-apps/research/card-runtime-ecosystem.md(机制图谱)
