# 不可信卡片代码沙箱(WebView隔离/桥接/CSP/shim)

> One dossier covers one recognizable professional field.

## Field identity and boundary

在 RN 与 Web 端运行社区卡片自带 HTML/JS(CardApp、正则状态栏)时的安全与兼容工程:隔离、桥接协议、注入面、降级。不含:CardApp 功能 API 语义本身(属 core/protocol)。

## Project scenario

卡面 HTML 应用沙箱宿主已落地:PanelBridge nonce 闸/白名单、card-runtime CSP/mounts、CLI headless 复用 wire 契约(用户拍板 2026-11-20)

## Decision tree

### C1: 隔离容器

- entry_when: 面板页/web CardApp 容器实现
- options:
  - A: 每 app 独立 WebView(RN)/iframe(web)沙箱,单文档只读页 → leads_to: C2
  - B: 直接渲染进主页面 DOM → leads_to: 拒绝(无隔离)
- decide_by: app 代码是否需要完整 DOM+JS——需要,且不可信,故隔离容器
- source: research/webview-bridge-security.md
- counterexample: 纯数据面板(无 JS)可直接原生渲染——未来 RN 原生面板的路径,不在此节点
- output: 独立沙箱容器;锁定导航(baseUrl null、拦截加载、禁多窗口)

### C2: 桥接协议防伪

- entry_when: ctx 桥实现
- options:
  - A: postMessage + 每挂载 nonce + 方法白名单 + schema 校验 → leads_to: C3
  - B: 注入 addJavascriptInterface 式原生对象/注入含凭据对象 → leads_to: 拒绝
- decide_by: postMessage 无 origin——必须自验(nonce+白名单);注入对象对全 frame 可见——不得含密
- source: research/webview-bridge-security.md
- counterexample: 若平台支持 addWebMessageListener(allowlist)可替代 nonce 自验——RNV 暂不,自验兜底
- output: 桥协议:{nonce, method, args, id}→RN 校验→api-client;返回经 id 对账

### C3: 出网与资源控制

- entry_when: app 代码资源加载
- options:
  - A: CSP(connect-src/img-src 白名单)+ 桥代理服务端端点;iframe 标签 strip → leads_to: C4
  - B: 放任 app 自由 fetch → leads_to: 隐私/外传风险
- decide_by: 卡片是否可能有外传数据动机——不可排除,故 A
- source: research/webview-bridge-security.md
- counterexample: CardApp 正经需求(加载卡内图片/字体)经 baseUrl/asset 路由白名单放行
- output: CSP 头注入 + 资源路由白名单

### C4: 老式状态栏兼容 shim

- entry_when: 非 CardApp 的正则 HTML 面板渲染
- options:
  - A: 注入 ST 全局 shim 子集(getContext/eventSource/$ 只读壳)→ 失败降级静态 HTML → leads_to: C5
  - B: 原样注入(无 shim)→ leads_to: 部分卡 JS 报错
- decide_by: 老卡 JS 依赖 ST 全局的普遍度——普遍,需 shim;shim 兜不住时静态渲染仍可读
- source: research/webview-bridge-security.md + .skeinn/design/mobile-panels.md
- counterexample: 卡内 JS 若直接改写宿主 DOM——沙箱内无碍,无需更高 shim
- output: shim 层 + 静态降级路径 + 错误上报;shim 双面:Luker CardApp ctx(card_app 声明时)+ TavernHelper 兼容全局(默认面,见 research/tavern-helper-api-surface.md;PolyForm NC 许可不并入代码,只再实现 API 面),同 nonce 桥,白名单补 variables/getChatMessages/lorebook/triggerSlash 系列

### C5: 资产缓存与版本

- entry_when: CardApp 代码/资源下发
- options:
  - A: 服务端版本号/ETag + 设备缓存(可清)→ leads_to: 完成
  - B: 每次全量拉取 → leads_to: 慢
- decide_by: 面板页打开频率——高频,要缓存
- source: research/webview-bridge-security.md
- counterexample: 调试期关闭缓存避免旧代码假象
- output: ETag 缓存 + 手动清缓存入口

### C6: 状态面板与渲染器沙箱复用

- entry_when: MVU 状态板/社区对话渲染器落地
- options:
  - A: 状态板=服务端渲染产物,走面板列表(系统面板条目);第三方渲染器复用 CardApp 同沙箱通道(panelBridge)→ leads_to: 完成
  - B: 渲染器/状态板直执客户端 JS → leads_to: 信任域混乱
- source: capabilities/mvu-runtime#C3;design/conversation-renderers.md §4
- output: 面板三类=卡应用/系统面板(状态板)/渲染器舞台;沙箱通道一处实现三处消费
