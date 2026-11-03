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
