# Decision History

Current truth belongs in PROJECT.md and linked design documents. This file preserves consequential superseding decisions.

## D-001: All-cloud thin-client architecture

- Current decision: Brain (prompt assembly, WI engine, regex, macros) ports to packages/core consumed only by apps/server. Mobile/web are thin clients; shared packages limited to protocol + formats + api-client.
- Rationale: No offline scenario (LLM calls need network); matches ChatGPT/Claude native thin-client model; single source of truth on server simplifies sync.
- Source: conversation
- Supersedes: none
- Affects: AGENTS.md, packages/core, apps/mobile, apps/web
- Recorded: 2026-11-02T08:48:37.672Z

## D-002: Luker as codebase base

- Current decision: apps/server starts from ref/Luker, not upstream SillyTavern.
- Rationale: Storage Engine/Repo abstraction, sync service, generation jobs + WS delivery, CardApp state system already built; porting them to vanilla ST would redo hard work.
- Source: conversation
- Supersedes: none
- Affects: apps/server
- Recorded: 2026-11-02T08:48:37.674Z

## D-003: Heavy UI as dedicated mobile pages via WebView sandbox

- Current decision: CardApp/status-bar HTML renders in a dedicated '面板' bottom-nav page inside react-native-webview; ctx API bridged over postMessage to api-client; state in server chat_state sidecars.
- Rationale: Byte-level compat with existing card HTML/JS; dedicated pages match user's UX ask (not mixed into chat); state system already exists server-side.
- Source: conversation
- Supersedes: none
- Affects: apps/mobile
- Recorded: 2026-11-02T08:48:37.682Z

## D-004: Golden-diff 验收阈值

- Current decision: 通过线 = LLM 消息序列相等 + WI 注入轨迹等价 + regex 应用记录一致;容忍白名单:时间戳、gen_id、同优先级条目排序。diff 分级:致命(消息序列)/重要(WI 增删位置)/可忍(白名单内)。
- Rationale: 逐字节相等不可达(含随机与时间);轨迹等价已能抓住一切真实行为分叉;白名单外出现系统差异时阈值升级而非放宽。
- Source: conversation
- Supersedes: none
- Affects: .loom/design/compat-golden-diff.md, .loom/capabilities/st-engine-compat/capability.md
- Recorded: 2026-11-02T08:57:13.114Z

## D-005: 保留 Luker 服务端插件与 skills/orchestrator 功能

- Current decision: 不剥离。服务端插件、skills、orchestrator 保留在 apps/server 原样继承。
- Rationale: 它们纯服务端运行,不影响移动端兼容目标;剥离是纯成本且无收益;若以后成为维护负担再单独决策。
- Source: conversation
- Supersedes: none
- Affects: apps/server
- Recorded: 2026-11-02T08:57:13.115Z

## D-006: 面板 shim 双面策略

- Current decision: 沙箱 shim 提供两个 API 面:Luker CardApp ctx(card_app 声明时)+ TavernHelper 兼容全局(默认);共享同一 nonce 白名单桥,协议白名单按 TavernHelper 清单扩展
- Rationale: 最大化'绝大多数卡'覆盖率:CardApp 卡走原生面,面向酒馆助手写的卡(占社区大头)走兼容面,均不满足降级静态 HTML
- Source: conversation
- Supersedes: none
- Affects: .loom/design/mobile-panels.md, .loom/capabilities/sandboxed-card-apps/capability.md, packages/protocol/src/panels.ts
- Recorded: 2026-11-02T09:18:53.743Z

## D-007: D-009 插件核心架构(DSH 形态)

- Current decision: 产品形态定为'插件核心':内核薄(存储/鉴权/传输/编排,无酒馆语义),tavern-core/tavern-formats/card-runtime/tavern-presets 为内置插件,第三方经 PluginManifest+PluginContext(权限声明+服务注册表+管线钩子 generation.preBuild/build/settle/chat.messagePersisted/card.imported)接入。packages/* 保持纯库,插件是薄适配层。Luker 插件面保留并升级为产品主架构(D-005 语义升级)。
- Rationale: 用户拍板:像 DSH 一样以插件为核心且插件体验要好;插件生态强于我们本身——服务注册表+管线钩子让社区能替换/扩展引擎而不分叉产品
- Source: conversation
- Supersedes: none
- Affects: .loom/design/plugin-architecture.md, .loom/design/core-engine.md, .loom/design/generation-api.md
- Recorded: 2026-11-03T05:46:58.777Z

## D-008: D-010 骨架直接仿 DSH/Cordis(修订 D-009 实现语义)

- Current decision: 插件骨架一字不改仿 Cordis:函数插件命名导出 name/inject/Config/apply(ctx);服务插件 default-export Service 类;ctx.effect(fn,label) 全注册带 disposer;ctx.on/emit 事件;ctx.<name> 注入代理+ctx.get() 可选服务;profile 有序 plugins[] 装载;capability seam 三元组(Definition/Provider/Consumer)。内核几十行自写不引 cordis。第一约束:酒馆生态兼容凌驾一切架构选择。
- Rationale: 用户拍板'骨架可以很直接地仿照 DSH,酒馆生态第一要位';DSH 源码实证契约(acp:inject 数组+apply(ctx,config)+ctx.effect disposer;DshManifest:bundles 有序 profile;能力接缝必须三角齐备)
- Source: conversation
- Supersedes: none
- Affects: .loom/design/plugin-architecture.md
- Recorded: 2026-11-03T05:59:40.659Z

## D-009: 内核引入真 cordis,V1=聊天+完整管理端,预设=数据无损+生成等价

- Current decision: 四项产品决议:(1)内核用 npm 真 cordis(MIT,Koishi底座),只用 Context/events/effects/registry core,loader/profile/patch 层自写;骨架任务先验证,立不住退回自写但保持 cordis 语义接口;(2)V1 边界=聊天核心+完整web管理端,要能做酒馆完全替代;图片/TTS/群聊/向量库走插件位不占V1;(3)预设=导入导出字段无损+生成行为等价(golden裁判),UI呈现重设计不复刻;(4)用户模型=个人云为主,Luker已有user handle/多用户目录隔离保留不深化。
- Rationale: cordis 语义深读后发现细节坑多(waterfall outermost-first/bail判定/effect依赖通知),自写易抄形丢神,真包久经考验且MIT;V1对齐DSH初版'开发者好开发+用户没负担';预设拆三层后两硬指标+UI自由是最优解;ST生态主体是个人自部署。
- Source: conversation
- Supersedes: D-010 部分:自写内核改为真 cordis
- Affects: project-wide or not yet classified
- Recorded: 2026-11-03T06:15:17.296Z

## D-010: 生态细节拍板:MVU完整支持/TH T1进V1/群聊插件位/DSH式插件管理/中英双字典/旧插件适配器

- Current decision: (1)LLM golden 验证圈=OpenAI兼容单面,其余provider靠不回归;(2)MVU 完整支持进V1:服务端解析UpdateVariable→stat_data投影持久化+状态栏模板渲染;(3)TH T1(消息写/triggerSlash/生成控制)V1内做,生成API后紧跟;(4)移动端=Expo dev build dogfood;(5)群聊=generation seam插件,V1不含;(6)插件管理=DSH plugin-manager简化版web页(安装/启禁/npm+git);(7)i18n=中英双字典起步,全部文案走locale字典;(8)写ST旧服务端插件适配器(init→ctx.route,exit→effect,info→manifest);客户端扩展JS不兼容,旧UI内仍可用;(9)默认:QR/图片/TTS插件位,online-first缓存只读,沿用fs存储,深色优先主题,URL导入V1支持,ST式账号密码。
- Rationale: MVU是现代卡事实标准不做则生态破;群聊是生成编排变体恰是seam用例;插件管理是'插件生态强于本体'的产品门面;adapter成本几十行换生态延续性;i18n双字典起步避免后期重构。
- Source: conversation
- Supersedes: none
- Affects: project-wide or not yet classified
- Recorded: 2026-11-03T06:19:32.114Z

## D-011: 端形态与生态收尾:web含完整聊天/客户端纯容器/主题设置服务端同步/卡资产全量编辑

- Current decision: (1)web SPA=完整产品(聊天+管理),移动端是同协议另一壳;(2)插件全在服务端,客户端不留插件点;用户偏好(主题/字号/语言等)存服务端设置,客户端只缓存——天然多端同步;(3)移动端导航:先做完 design/web-ia.md(ST全部UI面信息架构重排:一级/次级/默认折叠)再定,web优先;(4)登录=URL+密码两端通用,web端出二维码供手机扫码连服务端;(5)移动端面板页=应用列表→全屏WebView(多tab留v1.1);(6)TH深度=T0+T1即目标,T2按需补;(7)卡内资产(TH脚本/正则/内嵌WI)web端全量编辑,对齐ST编辑能力,关注制卡工具导出兼容;(8)ST前端扩展不兼容,热门项(QR/表情等)官方插件重实现。
- Rationale: 桌面聊天是ST主流场景,web必须含聊天;服务端权威下客户端插件点引入的是复杂度而非能力——主题/设置走服务端设置同步反而更贴合全云;面板列表→全屏是'重前端专属页'的最简实现;ST扩展热门官方重实现保住生态功能面。
- Source: conversation
- Supersedes: none
- Affects: project-wide or not yet classified
- Recorded: 2026-11-03T06:32:46.851Z
