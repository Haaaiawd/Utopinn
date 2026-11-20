# Project Whole and Document Map

## Intended result

**V2(2026-11-20 方向再拍板)= apps/web 新 SPA 即正式前端 + Cordis 插件后端 + CLI 参考客户端。** 方向已回暖:11 个 utopinn-* 插件管全部服务端域(profile.yaml 声明式装载,84 路由),前端 cordis 语义微内核(贡献点:nav.rail/view/sidebar.tree/panel.type/renderer/ctbar/locale)按规范稿高保真还原,CLI 覆盖 83 具名路由(词表派生+加载期对账)。服务端大脑唯一组装路径(/api/utopinn/generate),浏览器零组装。

**当前里程碑 = 真玩通卡**:正经导入→大厅显图→连接→生成→MVU 结算→CardApp 宿主,端到端验收(TASK-045~048)。之后才是形态深化(novel/galgame)与移动端。

**角色分工**:apps/web = 全功能管理端+游玩端;apps/cli = 参考客户端/验收面;apps/mobile = 薄客户端(Expo,chat 主+资产工坊+设置收一切);apps/server/public 旧 jQuery UI = 兼容 harness(LUKER_SERVE_LEGACY,仅 e2e/golden 用)。

**搁置(非删除)**:RN 真机端、RP 形态/阅读器形态 P0(TASK-026/028 停泊)、群聊/频道(§C C9 砍)、附件(§C C8 砍)。

## People and operating reality

用户:ST 重度玩家(自己跑服务端、攒社区卡、在意卡片生态)。使用场景:桌面浏览器做卡/世界书/预设等重度管理;手机端日常玩——聊天、选卡、看面板,不被高级功能糊脸。

## Whole experience or behavior

手机上打开 App → 连自己服务端 → 角色列表选卡 → 聊天页清爽对话(流式、swipe)→ 底导航"面板"页承载卡里预设的 HTML 应用(背包/任务卡/状态栏)→ 高级功能只在浏览器管理端出现或收进移动端深层设置。卡从手机导入 PNG/charx 即可用,世界书在各端行为一致。

## Boundaries and consequential assumptions

- 大脑(prompt组装/WI/regex/宏)只在服务端;客户端零组装逻辑(已确认全云化)
- 数据格式与磁盘约定不动(世界书 `{entries:{}}`、JSONL、PNG tEXt、sidecar)
- 行为兼容以 golden-diff 为判据,不靠读后自信;LLM 验证圈=OpenAI 兼容单面
- 第三方前端扩展不兼容——已接受;旧 ST 服务端插件走 adapter 插件
- 卡片 HTML/JS 不可信——必须沙箱化运行
- 高级功能不得挤占移动端主界面——藏进设置或仅 web 可见
- 个人云为主,ST 式多用户隔离沿用不深化;online-first,客户端缓存只读
- i18n=中英双字典起步(locale-owned 文案纪律);移动端=Expo dev build
- V2 边界:旧 jQuery UI 仅兼容 harness,不再演进;SPA 是唯一演进前端;移动端收敛 chat+hub+设置一套导航

## Design document map

- `design/v2-stack-decisions.md`(system)— V2 全栈分层拍板:后端双API面收敛/存储引擎语义分层/登录不造系统/前端优先级脊骨+执行序
- `design/plugin-architecture.md`(system)— cordis 内核+profile/patch组合+事件五模式+服务四角色+seam 清单+插件UI贡献点
- `design/core-engine.md`(system)— 服务端大脑移植的责任、边界、副作用分层
- `design/generation-api.md`(contract)— /api/generate + WS ticket 生成管线契约
- `design/mobile-panels.md`(experience)— 移动端面板页与 CardApp 沙箱 UX
- `design/perf-budget.md`(verification)— 渲染面分层+楼层WebView预算+性能预算数字
- `design/compat-golden-diff.md`(verification)— 语料+golden 捕获+diff 分级机制
- `design/web-ia.md`(experience)— ST 全部UI面重排:五域IA/故事=卡·规则=书心智/设置八节/实证痛点清单/ST对照表29条(认可稿:web-ui-mockup.html)
- `design/conversation-renderers.md`(contract)— conversationRenderer seam:宿主契约/prose+bubble内置/stageScheme/社区渲染器/R1-R5调研挂账

## Professional capability map

- `capabilities/mobile-app-stack/capability.md` — SDK58/expo-router/Query+WS/LegendList/streamdown/NativeWind 选型(决定 TASK-008/009)
- `capabilities/web-spa-stack/capability.md` — Vite+React19+Tailwind4+shadcn/RHF+Zod/CM6+桌面壳/主题/i18n(决定 TASK-010)
- `capabilities/st-engine-compat/capability.md` — 特征化移植策略+行为面断言清单+验收阈值(决定 TASK-004/005/006/007)
- `capabilities/sandboxed-card-apps/capability.md` — 沙箱容器/nonce白名单桥/CSP/shim降级/状态面板+渲染器沙箱复用(决定 TASK-009/014)
- `capabilities/plugin-kernel/capability.md` — cordis core选型/插件UI六贡献点/profile+patch组合/旧ST插件adapter(决定 TASK-011)
- `capabilities/conversation-renderers/capability.md` — 宿主契约/内置渲染器集/stageScheme优先级/注册面(决定 TASK-015)
- `capabilities/import-export/capability.md` — 万能导入手势/无损预览/备份同步/ST迁移向导(决定 TASK-016)
- `capabilities/mvu-runtime/capability.md` — stat_data投影/settle管线位/状态板服务端渲染/变量回执(决定 TASK-013)
- `capabilities/dev-diagnostics/capability.md` — 诊断独立域/model-visible⟺logged/五工具/degraded可视化(决定 TASK-017)

## Project structure

见 `.loom/STRUCTURE.md`:pnpm monorepo,apps/{server,mobile,web} + packages/{core,protocol,formats,api-client} + tests/{corpus,golden-diff};ref/ 为本地参考(gitignore)。

## Work map

见 `.loom/tasks.json`:17 个任务。主序:005(完)→ 011内核+006管线+015渲染器契约 并行 → 007生成API → 008首个dogfood+013MVU+014card-runtime → 009面板 → 010 web全量(含016导入导出面/017诊断域)。V1=聊天+完整管理端+MVU+TH T0/T1。

## Decision history

`.loom/DECISIONS.md` + `loom decision`;已录:全云化架构、Luker 基底、面板页沙箱、golden-diff 阈值、保留 Luker 服务端功能。

## Completion and failure

成功证据:手机上完成"选卡→流式对话→面板页可操作状态卡"全链;语料卡 golden diff 全绿;世界书导入导出与原版文件级一致。
假完整陷阱:UI 能跑但 prompt 与原版系统性不同(兼容假象);或面板沙箱形同虚设(密钥经注入对象泄露/卡片自由外传)。

## Staged visibility and review

- TASK-001 后展示:服务端跑通,浏览器开旧 UI
- TASK-008 后展示:手机上第一轮流式对话(录屏)
- TASK-009 后展示:面板页跑真实 CardApp 卡
- 每批任务后 `loom check` + 项目测试双绿才算完

## Keeper handoff

`loom project ready` 冻结后由新鲜 Agent 走 keeper 校验。
