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

## D-012: 任务图重排:011/006/012并行,首个dogfood=移动薄聊天,新增013/014任务

- Current decision: 顺序重排:TASK-005结清;TASK-011(内核)、TASK-006(prompt组装,纯库先行不依赖内核)、TASK-012(web-ia设计)三线并行→TASK-007(生成API,内核汇流点)→TASK-008(移动薄聊天=首个dogfood)+TASK-013(MVU settle独立,挂生成persist)+TASK-014(card-runtime服务端CDN/资产/CSP)→TASK-009(移动面板)→TASK-010(web全量)。修正:MVU settle从006挪至013;card-runtime服务端从009隐含独立为014;web-ia独立为012喂给008/009/010。
- Rationale: 006是纯函数库不需要等内核;MVU是persist时projection不是prompt组装;CDN/资产服务是移动面板的前置但属服务端工作;首个dogfood应对准用户最痛的手机场景。
- Source: conversation
- Supersedes: none
- Affects: project-wide or not yet classified
- Recorded: 2026-11-03T06:35:36.368Z

## D-015: IA v3 认可 + 对话渲染器升 seam + capability 扩展为9个 + 任务图17任务

- Current decision: (1)桌面应用壳(标题栏/activity rail/二级侧栏/右面板/状态栏)+暗色默认/纸面亮色,web-ui-mockup.html 为认可稿,取代线稿;(2)对话呈现升为 conversationRenderer seam——prose(默认)/bubble 内置,论坛体/galgame/直播流归社区渲染器,卡可声明 stageScheme(用户覆盖优先),渲染器只做呈现,消息语义宿主供给;(3)扩展+插件合并为一域"扩展";作者注/Guide/注入统一为"注入"三作用域;正则一引擎多作用域;状态板=系统面板一种;(4)capability 从4扩到9:新增 plugin-kernel/conversation-renderers/import-export/mvu-runtime/dev-diagnostics;(5)任务图扩到17:新增 TASK-015(渲染器契约+gal/论坛调研)、TASK-016(导入导出中心)、TASK-017(诊断域);TASK-012 结清。(6)正式UI图标=24格stroke SVG禁emoji;i18n=中英双字典;导入导出+开发者诊断为产品两支柱(用户安装仪式/生态引水渠)。
- Rationale: 用户认可桌面壳结构但要求防偏移落档;对话渲染器是社区生态面,必须契约化(宿主供给数据语义)才能放插件生态;两支柱(import-export/diagnostics)是实证痛点,提为一等域。
- Source: conversation
- Supersedes: 无(web-ia-wireframe.html 作废,web-ui-mockup.html 为认可稿)
- Affects: project-wide
- Recorded: 2026-11-03T07:10:00.000Z

## D-017: AI harness 自建薄内核,不站 DSH 当底座

- Current decision: 内核=自建(npm cordis+自写loader/profile/patch,~TASK-011范围),不以 DSH monorepo 为底座也不 vendor 其切片。借用的仅是:cordis npm 包、DSH vendored cordis 的 patch 语义参考(profile/volatile config;module HMR 二期)、dsh-tavern AGPL 资产、DSH 包语义(settings/jobs/session)。若未来需要 DSH 级能力(jobs/session-query/MCP),经 seam 注册 Provider 引入,不重写内核。
- Rationale: (a)产品模型不同构——DSH 是 agent harness(loop/工具/MCP),我们是 RP 聊天管线,用到其表面仅约5%;(b)数据真理冲突——DSH session 事件源 vs ST 兼容 JSONL,适配层是漂移温床;(c)未发布+pre-stable API,vendor 后永久跟其 release cadence(其自身仍在 rc11 升级中);(d)其通用件(settings/jobs/credentials)在我们域均为小实现,Luker 已有可移植版本;(e)dsh-tavern 实践证明 DSH 给的是壳,酒馆语义照样自建——那壳就不值得换整个 monorepo。
- Source: conversation
- Supersedes: 强化 D-010/D-016 立场(harness 自建)
- Affects: project-wide;TASK-011 范围不变
- Recorded: 2026-11-03T07:55:00.000Z

## D-018: dsh-tavern 借用边界实证——解耦可搬/保姆只读

- Current decision: dsh-tavern 资产按 ST 耦合度分级(grep getContext|SillyTavern|jQuery):(a)解耦可搬——gal-*全族(零命中,~500行)、lib/vendor/magvarupdate;(b)只读参考——helper-*/frame-*/session-*/host-*(全命中,是给嵌入ST前端当保姆的机制);(c)其"嵌ST前端frame"架构本身不采用。每个待搬文件先过判据。
- Rationale: dsh-tavern 把 ST 恶果关进 frame 而非解决;我们要的是其现代外围资产,不是收容机制。判据客观可执行,防止移植时把 ST 遗留耦合顺进来。
- Source: grep 实证 + conversation
- Supersedes: none
- Affects: TASK-013/015 及全部 dsh-tavern 移植点
- Recorded: 2026-11-03T08:05:00.000Z

## D-016: 借用三层策略——npm 依赖 / AGPL区移植 / 模式借用(补录,原档丢失)

- Current decision: (1)直接依赖 cordis@rc.12 + schemastery(schema校验,不引zod进内核);(2)dsh-tavern(AGPL-3.0,与Luker同族)逻辑可移植进 server/插件 AGPL 区——magvarupdate vendor、gal-*渲染器、mod settingsSchema、card-stage-scheme、状态板、helper-facade 全是可搬资产;packages/{protocol,api-client,formats} 保持干净留 MIT-able;(3)DSH 包(MIT但未发布,依赖网深)只借语义不依赖——settings/jobs/session 语义进对应 seam;pi-mono 的 pi-ai provider 抽象形状供 ctx.generation provider seam 参考;(4)DSH vendored cordis 是 4.0.6-alpha 分叉线(24处本地改动),npm 版缺的 volatile config/hmr/profile 语义由自写 loader 层补;(5)dsh-tavern 无服务端引擎可搬(其架构=嵌ST前端frame),TASK-006 移植不可省。
- Rationale: 同 cordis 底座+MIT/AGPL 兼容带使借用可分三层落地;dsh-tavern 是同一题目在 DSH 上的成品,外围资产直接省掉大量设计/实现;但引擎、GUI、koishi 生态不可借,边界写死防漂。
- Source: conversation + ref/dsh-tavern LICENSE + vendor/cordis-rc11-upgrade-plan.md
- Supersedes: none
- Affects: TASK-011/013/015 及包 license 边界
- Recorded: 2026-11-03T07:40:00.000Z

## D-019: Agent 能力口子——Pi 式极简 agent,不回 DSH

- Current decision: RP 产品不排除 agent 能力;若需要(工具循环/自动化),按 Pi(pi-mono)极简 agent 形状做成 provider/插件,注册进 seam 体系(provider 级),不作为内核骨架。DSH 的 agent-loop/MCP/subagent 机制不进入 Tavern core(D-017 已决);Pi 的 provider 抽象形状同时参考于 ctx.generation。
- Rationale: 用户明示"角色扮演不代表我们不需要Agent"。Pi 是单文件级极简 loop,与"薄内核+seam"路线同构;能力挂在 provider 位上,内核不背 agent 语义。
- Source: conversation(用户指示)
- Supersedes: none
- Affects: plugin-kernel C-node、ctx.generation seam 设计、后续 agent 类任务
- Recorded: 2026-11-03T09:05:00.000Z

## D-013: 导航形态：单骨架 rail+路由，否决双模式

- Current decision: PC 端固定 rail+keyed 路由；聊天域内部挂酒馆式遮盖 chrome；沉浸键藏 rail 后视觉即纯酒馆。不做顶栏/rail 切换开关。
- Rationale: 抽屉与 rail 租户是两套宿主语义；生态无导航骨架切换先例；Marinara/DSH 已分别验证混合可行。聊天即舞台是视图状态不是导航范式。
- Source: conversation
- Supersedes: none
- Affects: .loom/design/web-ia.md, .loom/design/web-visual-system.md
- Recorded: 2026-11-04T04:23:05.141Z

## D-014: 客户端对齐 DSH 全形态：动态 bundle + 平台模块表

- Current decision: 目标态 = 插件独立 bundle 运行时加载(Loader+manifest)+平台模块表共享单例。分阶段：静态贡献表(已落) → inject/effect/locale(B′) → bundle 装载(C)。manifest hydrate 为过渡。
- Rationale: 用户拍板对 DSH 走彻底；服务端插件带客户端表面时，无 bundle 装载则插件加 UI 必须发版。
- Source: conversation
- Supersedes: none
- Affects: .loom/design/web-slots-architecture.md
- Recorded: 2026-11-04T04:23:05.144Z

## D-015: 内核三件全补：inject + effect + locale

- Current decision: 微内核升级服务层：inject 声明服务等待，effect 按 feature 收作用域，'locale' 贡献点让 i18n 按 feature 命名空间注册，全局字典退役。
- Rationale: 对齐 cordis 语义并为动态装载铺路；locale 拆分本就列在契约表。
- Source: conversation
- Supersedes: none
- Affects: .loom/design/web-slots-architecture.md, apps/web/src/kernel/
- Recorded: 2026-11-04T04:23:05.148Z

## D-016: 服务端路由与 WS 同为贡献点，小面先行

- Current decision: kernel 插件双注册位 register(HTTP)+registerUpgrade(WS)；首批迁只读列表端点，第二波 generate/preview+streamJob；legacy Express 收 legacy-adapter。
- Rationale: webServer.register→disposer 是 DSH 已验证形状；streamJob 是 WS，只收 HTTP 会把最大流量留在 Express。
- Source: conversation
- Supersedes: none
- Affects: .loom/capabilities/plugin-kernel/research/dsh-fullstack-architecture.md, apps/server, packages/kernel
- Recorded: 2026-11-04T04:23:05.151Z

## D-020: 移动端地基改为 fork IReader(KMP),Expo 实现退位为参照

- Current decision: 移动端以 fork `IReaderorg/IReader`(Apache-2.0,Kotlin Multiplatform,android/desktop/iosApp 三端壳)为新地基;切割缝 = `source-api`/`source-runtime-js` 书源爬虫层整块移除,替换为「utopinn 源」=服务端 api-client 的 Kotlin 实现;presentation/domain/data/i18n/壳层保留。现有 `apps/mobile`(Expo)退位为参照实现——其 design 调研(阅读器形态)与面板桥协议仍为有效资产,代码本身不再演进主线。RP 专属件(swipe 候选、书写层、CardApp WebView 面板、MVU 状态)在任何阅读器中均不存在,须在新地基上自建。
- Rationale: (1)legado 上游已被法律核掉(删库公告,2026-05)——「国内圈子最火」选项实质消亡,快照可拿但属死上游+GPL+法律云;(2)Expo 实现 chrome 质感未达产品线(用户明确判定"完全不合格"),且手搓/半迁移组件库路线越补越散;(3)IReader 是当前唯一同时满足:活着(周级提交)、Apache-2.0、小说原生 UX(非 EPUB 错范式)、KMP 三端、模块切缝正好长在书源层的候选;(4)KMP 保留 iOS/桌面回路,不像纯 Kotlin 单体锁死安卓。
- Source: conversation(用户两番拍板"fork是对的")+ GitHub 仓库实证(legado 删库公告 / IReader 模块布局)
- Supersedes: D-008 移动端 Expo 实现路线(架构目标"薄客户端"不变,实现栈 RN/Expo→KMP)
- Affects: apps/mobile(冻结为主线参照), ref/ireader(新地基源), TASK-008/009/027(已落代码转参照态,验收语义按新地基重排), mobile-panels/mobile-reader-form/mobile-ui-foundation 设计稿
- Recorded: 2026-11-04T12:10:00.000Z

## D-021: 产品形态(web+移动)为持续研究线,非一次性裁决

- Current decision: 产品形态调研不设终点。已拍板的形态稿(web-rp-form 剧场深化 / mobile-reader-form 书架→阅读器)作为当前执行基线,但承认两端形态信息不足、需持续研究迭代——新实证(竞品变化、真实使用反馈、fork 代码阅读所得)可随时回写形态稿并重排任务。
- Rationale: 用户观察"无论网页端还是移动端,产品形态都还有待研究"属实——形态稿建立在调研代理二手资料上,缺少真产品长期使用的一手判断;IReader fork 本身就会带来其成熟形态的一手细节(书架信息密度/阅读器菜单组织/主题系统),应当反哺而非固化。
- Source: conversation(用户明示)
- Supersedes: none(限定既有形态稿的"已拍板"语义:基线可用,不封顶)
- Affects: .loom/design/web-rp-form.md, .loom/design/mobile-reader-form.md, 后续形态类任务
- Recorded: 2026-11-04T12:10:00.000Z

## D-017: V1 收缩:旧UI皮 + 服务端脑,一次性全切

- Current decision: apps/server/public 旧 UI 即 V1 正式前端(不再是过渡管理端);所有生成入口一次性改道 /api/utopinn/generate;客户端组装引擎留码停用;apps/mobile、apps/web 标记 parked;utopinn 插件面即产品服务端。
- Rationale: 此前宏大方案(新SPA+RN+CardApp面板)被负责人判定过大;循序渐进=把已验证的服务端大脑接上仍在用的旧UI,立刻兑现真分离+客户端变轻,同时保留向后演化空间(死路径可比对、文档可复用)。
- Source: conversation
- Supersedes: none
- Affects: .loom/PROJECT.md, .loom/design/web-ia.md, .loom/design/web-form-v2.md, .loom/design/web-rp-form.md, .loom/design/web-visual-system.md, .loom/design/web-slots-architecture.md, .loom/design/mobile-fork-ireader.md, .loom/design/mobile-form-v2.md, .loom/design/mobile-reader-form.md, .loom/design/mobile-ui-foundation.md, .loom/design/mobile-panels.md, .loom/tasks.json
- Recorded: 2026-11-10T02:22:28.009Z

## D-2026-11-10-g076: 方向收缩(2026-11-10):V1 = 旧 Luker/酒馆 UI + 服务端大脑一次性全切。所有生成入口改道 /api/utopinn/generate;客户端组装引擎留码停用;apps/web 新SPA、apps/mobile、CardApp 面板、RP/阅读器形态全部 parked(代码保留,文档转 reference)。性能目标=分离本身,不动旧 UI 渲染层。TASK-026/028 停泊,新增 TASK-030 旧UI接线。

- Changed: .loom/PROJECT.md, .loom/tasks.json
- Affected tasks: TASK-026, TASK-028, TASK-030
- At: 2026-11-10T02:23:32.616Z

## D-018: 掌门卡独立 UI 重塑与服务端接线任务分开记录

- Current decision: 本轮按用户当前卡片 UI 请求工作，不改变无关的活跃 TASK-030 状态。保留纸墨公文风，以真实待回话而非活跃主线判来客；期限排序、选项解释、弹窗和容器响应式仅改变呈现。状态读写、门线、拟办、发送、挂载等16个核心函数经 SHA256 锁定不变。
- Rationale: 用户要求便于长期决策的渲染改造，并仅允许开局日报注入微调；不能借美化改变 tick 或世界裁决。
- Source: conversation
- Supersedes: none
- Affects: work/掌门卡/02_card_工作区/cardapp/index.js, work/掌门卡/02_card_工作区/cardapp/style.css, work/掌门卡/02_card_工作区/_opening_news.cjs
- Recorded: 2026-11-16T07:08:03.451Z

## D-019: 掌门卡UI按可表达的决策结构重整，不以测试数量代替体验

- Current decision: 日报是固定的读报视图而不是页尾折叠；宽屏办事页留报刊速览，窄窗用办事/读报切换。人物与建筑详情直接呈现已知事实和具体意图输入；完整脚本选项可直接记拟办，泛动作必须先表达再确认。保留世界裁决、门线、发送等16个核心函数，未改变游戏结算机制。
- Rationale: 用户直接反馈上一轮变化不明显、操作空泛、框选失准和头像未显示；前端结构要解决实际使用，不用更多小标签补上。
- Source: conversation
- Supersedes: none
- Affects: work/掌门卡/02_card_工作区/cardapp/index.js, work/掌门卡/02_card_工作区/cardapp/style.css, work/掌门卡/02_card_工作区/_prepare_portraits.py
- Recorded: 2026-11-16T08:28:08.920Z

## D-020: Cordis 迁移路线重排——写盘面统一优先,按「机制移植→调用改道→组装短路→物理删除」四步退役旧架构

- Current decision: TASK-030/031 done 后,主线改为 TASK-032(ack/integrity/gen-id/settle 机制从 legacy chats.js 移植进 utopinn fiber,三写盘面收成一套)→ TASK-033(浏览器残存调用改道 utopinn REST)→ TASK-034(浏览器组装空跑短路)→ TASK-035(旧端点物理删除)。支线:TASK-036(CLI 具名覆盖 30 raw-only)、TASK-037(group/textgen/kobold 接入)、TASK-038(CLI 验收矩阵+golden-diff 复跑)。TASK-026/028 保持停泊不启动。
- Rationale: 当前最大风险是双写盘面并存——ack/integrity 机制长在 legacy chats.js 里而新 utopinn chat 路由不触发它;任何经新面的写都会绕过结算/去重。必须先统写盘才能谈删旧。TASK-026/028 与 cordis 迁移无关,继续停泊。
- Source: conversation + subagent 审查(34 条,5527db1 已修阻塞项)
- Supersedes: none
- Affects: .loom/tasks.json(TASK-032~038 新建), apps/server/src/endpoints/chats.js, apps/server/src/plugins/, apps/cli/utopinn-cli.mjs
- Recorded: 2026-11-19T06:00:00.000Z

## D-021: CLI = 协议参考客户端(以骨长肉)——服务端能力必须先有 CLI 动词,新前端绑同一协议面

- Current decision: /api/utopinn/* 每条服务端能力必须存在对应 CLI 具名动词(按 Cordis 插件域组织:library/generate/state/mvu/diag/plugins/import/delivery);CLI 动词即协议契约的活文档与回归面。将来新前端 UI 不另起协议,直接消费与 CLI 相同的 REST+WS 面——"以骨长肉":CLI 先把协议骨架跑熟钉死,新 UI 只是骨架上的第二层肉。TASK-036 的 48 动词是第一期,TASK-038 扩展为全覆盖矩阵。
- Rationale: 用户明示"CLI需要覆盖所有的东西,并以Cordis组织;到时候新前端UI需要绑定,或许以CLI同步前端的方式,直接以骨长肉"。浏览器旧 UI 是过渡形态,协议面才是产品本体;CLI 覆盖即契约覆盖,CLI 全绿的面上任何薄客户端(浏览器/移动/新 SPA)都只剩渲染职责。
- Source: conversation
- Supersedes: none
- Affects: apps/cli/utopinn-cli.mjs, apps/server/src/plugins/, .loom/tasks.json(TASK-038 升级)
- Recorded: 2026-11-19T09:30:00.000Z

## D-022 CardApp/酒馆助手兼容形态 = 悬浮窗 + 右侧栏(整体优先,兼容后置)(拍板)

- 先把整体前端(协议绑定/会话/舞台/工作台)做完,再做 CardApp 与酒馆助手兼容层。
- 兼容层宿主形态:右侧栏标签页(wb-tab)+ 可拆出受控悬浮窗(float-win);移动端落底 sheet。
- 设计稿 assets/u_ui_codex_linear_shadcn_ui.html 的 ledger 面板是 mock 复刻——真宿主需 cardapp 面板类型:sandboxed iframe + postMessage ctx 桥 → /api/utopinn/chats/:id/state/chat_state。
- bridgeOp(op) 的"面板→MVU/状态→toast"通道形状即兼容层的目标契约,mock 时先按它接。
