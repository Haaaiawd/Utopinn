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
