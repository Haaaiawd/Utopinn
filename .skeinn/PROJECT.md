# Project Whole and Document Map

## Intended result

**V2(2026-11-20 方向再拍板)= apps/web 新 SPA 即正式前端 + Cordis 插件后端 + CLI 参考客户端。** 11 个 `utopinn-*` 插件管全部服务端域(`profile.yaml` 声明式装载,84 路由),前端 cordis 语义微内核(贡献点:`nav.rail`/`view`/`sidebar.tree`/`stage.form`/`panel.type`/`renderer`/`ctbar.chat`/`locale`)按规范稿高保真还原并经 `/api/utopinn/ui/contrib` 水合对账,CLI 覆盖 83 具名路由(词表派生+加载期对账)。服务端大脑唯一组装路径(`/api/utopinn/generate`),浏览器零组装。

**当前里程碑(post-TASK-053)**:基础真玩通链路(TASK-045~048)、TH 完整事件/写面/消息内嵌 iframe 宿主(TASK-049)与前端占位净身收口(TASK-053)已交付。当前活跃前沿聚焦两条线:
1. **真实复杂卡生态 P0/P1 收口(TASK-054~057)**:修复来自实卡压测的 GitHub issues(MVU 自定义无分号 `_.set`/catgodml 解析、内嵌世界书无 `extensions.world` 静默丢弃、CLI `cardapp op click` 60ms 切断异步生成、TH 辅助生成过滤与 schema 校验、CLI 坐标与自检透明)。
2. **V2 结构演进余量**:legacy 端点收敛(TASK-035)、非 openai 派发补齐(TASK-037)、novel 章目录与 theater 资产/sidecar 余量(TASK-044)、剧场模式 V2.1 单立绘旗舰打磨与配套卡(TASK-050)。

**角色分工**:`apps/web` = 正式全功能管理端+游玩端(React 19+Vite+Tailwind 4,由 `:8000` 直供);`apps/cli` = agent-first 参考客户端与 headless CardApp 验收宿主;`apps/mobile` = 冻结/parked 参照态(Expo 骨架不演进主线,D-020 改判 IReader,未来移动端按 `distribution-forms` 红线走纯空客户端);`apps/server/public` 旧 jQuery UI = 兼容 harness(`LUKER_SERVE_LEGACY=1` 门控,默认不挂载,仅 e2e/golden 用)。

**搁置(非删除)**:移动端主线(TASK-028 停泊)、旧 V1 桌面 RP 形态 P0(TASK-026 停泊)、桌面/移动安装包分发工程(挂起,红线已立档)、群聊/频道(§C C9 砍)、附件(§C C8 砍)。

## People and operating reality

用户:ST 重度玩家(自己跑服务端、攒社区卡、在意复杂卡片生态如 MVU/CardApp/TavernHelper/世界书)。使用场景:当前主战场为桌面浏览器(选卡、游玩、剧场形态、世界书/预设/正则/人设工坊与实例管理一体),配合 CLI(`utopinn`)做自动化与卡生态回归验收;待桌面主链路稳固后再以纯空客户端承接手机日常轻玩。

## Whole experience or behavior

桌面浏览器直连 `:8000` 打开 `apps/web` SPA → 导入或选取角色卡(PNG/charx/JSON,含内嵌世界书、正则、CardApp)→ 中央舞台流式对话(WS ticket、swipe、AI_OUTPUT 正则投影、MVU 实时结算与宏回显、对话/小说/剧场小说多形态)→ 右侧工作台与消息位内嵌 CardApp/TH 沙箱面板(nonce 白名单桥 + `ctx.surfaceOpen/Close` 控层)→ Studio 管理卡库/世界书/预设/人设/正则、Plugins 管 Cordis 启停、Admin 管多 handle/配置/存储引擎。CLI(`utopinn`)消费完全同一套 `/api/utopinn/*` + WS 协议面,无后门接口;移动端薄客户端当前停泊。

## Boundaries and consequential assumptions

- 大脑(prompt 组装/WI/regex/宏/MVU settle)只在服务端(`packages/core`);客户端零组装逻辑(全云化)
- 数据格式与磁盘约定不动(世界书 `{entries:{}}`、JSONL、PNG tEXt、sidecar);存储读写经 Repo 层,fs=兼容默认、sqlite=部署推荐
- 行为兼容以 golden-diff 与字符化单测为判据,不靠读后自信;LLM 验证圈=OpenAI 兼容单面
- 第三方前端扩展不兼容——已接受;旧 ST 服务端插件走兼容装载器/adapter
- 卡片 HTML/JS 不可信——必须独立 iframe/WebView 沙箱 + nonce 白名单桥 + CSP;禁止并入 TavernHelper(PolyForm NC) 源码
- 分发形态红线(`distribution-forms` 编译入 `v2-stack-decisions.md` 与 `admin-surface.md`):移动端=纯空客户端(禁 `nodejs-mobile`,Termux 作极客兜底);桌面端=Supervisor+独立 `dataRoot`(禁将 `.node` 与 `data/` 打入单文件 VFS);公网空客户端=TLS+强认证闸门硬前置(含 `/characters/*` 静态资产鉴权)
- 个人云为主,不造注册/账号系统,ST 式多 handle 隔离沿用不深化;online-first,客户端缓存只读
- i18n=中英双字典起步(feature 级 `ctx.locale` 命名空间);字阶地板 11px,在线态严禁混入未标记 mock
- V2 边界:旧 jQuery UI 仅兼容 harness(`LUKER_SERVE_LEGACY=1`),不再演进;`apps/web` SPA 是唯一演进前端;移动端 Expo 骨架已冻结(D-020)

## Design document map

按 vs-V2 新鲜度分组(档内第一行标了同一分类)。

### current

- `design/v2-stack-decisions.md`(system)— V2 全栈分层拍板:后端双 API 面收敛/存储引擎语义分层/登录不造系统/前端优先级脊骨/分发形态三条红线(`distribution-forms` 编译)
- `design/admin-surface.md`(design)— 管理面板:SPA 第五 rail「管理」域,九区四桶 IA+多 handle 生命周期+公网暴露/认证边界(刀 1 已交付)
- `design/cordis-next.md`(system)— 插件单一声明源:五表收一(路由/CLI 具名/闸表/ui.contrib/profile)+贡献点内核契约
- `design/plugin-domain-map.md`(analysis)— 11 插件域解剖+合并判据+CORE_PLUGINS/profile 对账
- `design/core-engine.md`(system)— 服务端大脑移植的责任、方案权衡(`Alternatives considered`)、边界、副作用分层
- `design/compat-golden-diff.md`(verification)— 语料+golden 捕获+diff 分级机制
- `design/web-slots-architecture.md`(system)— 客户端贡献式架构:槽注册表/manifest 水合/DSH 全形态目标
- `design/cardapp-web-host.md`(design)— CardApp web 宿主:iframe 沙箱+postMessage 桥(TASK-022)
- `design/headless-cardapp-harness.md`(architecture)— CLI/Node CardApp 宿主:nonce 白名单桥协议参照实现(TASK-042 已验收)
- `design/legacy-convergence.md`(analysis)— legacy `/api/*` 双面实测清点、47 文件 compat 标注、12 项补缺与 P2 删减记录(TASK-035 活档)
- `design/web-v3-frontier.md`(experience, frozen)— 前端真接线收口:占位三桶核销边界/v3 壳层悬案基线/剧场 wire 已落与剩余配套卡边界(TASK-053)

### partially-stale

- `design/plugin-architecture.md`(system, 早期草案保留原貌,实装以 `cordis-next.md`/`plugin-domain-map.md` 为准)— cordis 内核+profile/patch 组合+事件五模式+服务四角色+seam 清单
- `design/system-map.md`(navigation)— 端口/CLI/数据流全索引导航(§0 三柱图为 V1 时点)
- `design/client-contract.md`(analysis)— web 前端↔cordis 后端协议边界对账+ui/contrib 声明化路线
- `design/generation-api.md`(contract, V1 早期契约保留原貌,V2 实名路由见 `client-contract.md`/`cli-client`)— /api/generate + WS ticket 生成管线契约
- `design/conversation-renderers.md`(contract)— conversationRenderer seam:宿主契约/prose+bubble 内置/stageScheme/社区渲染器
- `design/web-ia.md`(experience)— ST 全部 UI 面重排:五域 IA/设置八节/实证痛点清单/ST 对照表 29 条(认可稿:web-ui-mockup.html)
- `design/web-visual-system.md`(design)— 视觉体系:色彩/IA/规范表/否决记录
- `design/web-rp-form.md`(design)— 桌面端剧场深化形态(含 V2.1 剧场小说与单立绘裁定,废除双立绘)
- `design/task037-group-textgen-surface.md`(recon)— TASK-037 侦察:group 编排缺口(C9 已砍)+textgen/kobold/novel 派发差距
- `design/perf-budget.md`(verification, 早期性能预算草案含 V1 mobile 指标,保留作基线参照)— 渲染面分层+楼层 WebView 预算+性能预算数字
- `design/plugin-surface-forms.md`(planning)— 形态×插件面规划:四舞台+stats+ui.contrib 缺口排期(TASK-044,含 V2.1 剧场小说校准)

### superseded

- `design/frontend-binding-matrix.md`(audit)— UI↔插件域↔路由↔api 方法绑定矩阵(时点审计已兑现,活档=`client-contract.md`)
- `design/web-ia-wireframe.html`(wireframe)— 早期 IA 线稿单文件原型(已由 `web-ui-mockup.html` 重做)

### reference

- `design/deferred-surgery.md`(design)— cordis 内核五项延期手术(2026-11-20 全部落地)
- `design/task034-browser-assembly-shortcircuit.md`(recon)— 浏览器组装短路侦察(TASK-034 已收账;旧 UI=兼容 harness)
- `design/stscript-engine.md`(design)— STscript/QuickReply 服务端引擎(落地=`POST /api/utopinn/script/run`)
- `design/textgen-instruct.md`(design)— textgen/instruct 派发路径(落地=generate `body.api==='text'` 分叉)
- `design/import-export-center.md`(design)— 导入导出中心三刀(刀 2 export 面未建,走 legacy)
- `design/web-form-v2.md`(research)— Web 形态深研:竞品收敛点/实现体检/v2 建议(体检为时点快照)
- `design/web-ui-mockup.html`(mockup)— 桌面 UI 认可稿 v3(非实现镜像)
- `design/floating-window-research.md`(research)— CardApp 浮窗与三层表面可见性调研(`ctx.surfaceOpen/Close` 依据)

### reference(parked)

- `design/mobile-panels.md`(experience, V1 冻结停泊参照)— 移动端面板页与 CardApp 沙箱 UX
- `design/mobile-reader-form.md`(ux)— 移动端阅读器形态目标稿:会话=书/段落流/语义分章
- `design/mobile-form-v2.md`(research)— IReader 形态学+RP 件映射(深潜产)
- `design/mobile-fork-ireader.md`(decision)— 移动地基 fork IReader(KMP)拍板+侦察(D-020)
- `design/mobile-ui-foundation.md`(design)— Expo/uniwind/Tailwind 底座(冻结参照,D-020 改判 IReader)

## Professional capability map

- `capabilities/web-spa-stack/capability.md` — Vite+React 19+Tailwind 4+桌面壳/主题/i18n(confirmed)
- `capabilities/frontend-microkernel/capability.md` — `apps/web` Cordis 语义微内核:feature 三元组/inject waiters/作用域拆除/八槽契约/`/ui/contrib` 水合对账(provisional, agent-confirmed; 待人工确认)
- `capabilities/st-engine-compat/capability.md` — 特征化移植策略+行为面断言清单+golden-diff 验收阈值(confirmed)
- `capabilities/sandboxed-card-apps/capability.md` — 沙箱容器/nonce 白名单桥/CSP/shim 双面降级/状态面板与渲染器沙箱复用(confirmed)
- `capabilities/storage-engine-semantics/capability.md` — fs/sqlite/mysql/postgres 四引擎事务语义分层:fs 兼容默认/sqlite 部署推荐/check-and-write/collation/迁移边界(provisional, agent-confirmed; 待人工确认)
- `capabilities/distribution-forms.md` — 分发形态红线:移动端纯空客户端(Termux 兜底)/桌面端 Supervisor+独立 `dataRoot`/公网 TLS+认证闸门(已编译入 `v2-stack-decisions.md` 与 `admin-surface.md`)
- `capabilities/cli-client/capability.md` — `utopinn` agent-first 参考客户端与 headless CardApp 宿主契约(84 路由覆盖、写盘时序、WS 顺序硬约束)
- `capabilities/plugin-kernel/capability.md` — cordis core 选型/插件 UI 贡献点/profile+patch 组合/旧 ST 插件 adapter
- `capabilities/conversation-renderers/capability.md` — 宿主契约/内置渲染器集/stageScheme 优先级/注册面
- `capabilities/import-export/capability.md` — 万能导入手势/无损预览/备份同步/ST 迁移向导
- `capabilities/mvu-runtime/capability.md` — stat_data 投影/settle 管线位/状态板服务端渲染/变量回执
- `capabilities/dev-diagnostics/capability.md` — 诊断独立域/model-visible⟺logged/五工具/degraded 可视化
- `capabilities/mobile-app-stack/capability.md` — **(parked, superseded by D-020)** 原 Expo/RN 选型卷宗,D-020 改判 IReader 且移动端整体停泊,仅留档作历史参照

## Project structure

见 `.skeinn/STRUCTURE.md`:pnpm monorepo,`apps/{server,web,cli,mobile(parked)}` + `packages/{core,protocol,formats,api-client,kernel,panel-shim}` + `tests/{corpus,golden-diff}`;`ref/` 为本地参考(gitignore)。

## Work map

见 `.skeinn/tasks.json`:共 56 个任务(46 done, 2 blocked, 8 open;含 `TASK-049` 与 `TASK-053` 已结清)。
- **停泊阻塞(2)**:`TASK-026`(旧桌面 RP 形态 P0)、`TASK-028`(移动端 IReader 地基)——均因 2026-11-10 方向收缩停泊,需方向重开/用户明示解锁。
- **既有活跃前沿(4)**:`TASK-035`(legacy 端点收敛)、`TASK-037`(textgen/kobold/novel 派发接入,原 C9 群聊已退役)、`TASK-044`(novel 章目录 sidecar/聚合/range regen + theater assets/sidecar 余量)、`TASK-050`(剧场模式旗舰打磨 + V2.1 单立绘配套卡)。
- **GitHub issue 生态收口(4,本轮入列)**:`TASK-054`(P0 MVU 无分号 `_.set`/catgodml 解析 + 变量宏/正则实弹闭环,GH#14/#2/#3)、`TASK-055`(P0/P1 CardApp 无头点击等待 + TH 辅助生成过滤与 schema 校验,GH#13/#9/#4)、`TASK-056`(P0/P1 内嵌世界书无 `extensions.world` 兜底与 overwrite 联动,GH#10/#7)、`TASK-057`(P1/P2 CLI 坐标透明/workspace 链接自检/诊断口径收口,GH#11/#5/#6/#8)。

## Decision history

`.skeinn/DECISIONS.md` + `skeinn decision`;已录:全云化架构、Luker 基底、Cordis 插件内核、golden-diff 阈值、V2 正式前端=`apps/web` SPA、CLI 参考客户端、C8/C9 裁定与历史编号勘误。

## Completion and failure

成功证据:
- `apps/web` SPA 全链真接线无失实占位(`tsc` + `vite build` 绿),五域(聊/工坊/插件/管理/设置)真打 `/api/utopinn/*` 与 admin 路由;
- 真实复杂生态卡(如掌门卡、白莺学园都市:内嵌世界书 + MVU 变量解析/宏回显 + AI_OUTPUT 正则投影 + CardApp/TH 沙箱面板)在 SPA 与 CLI 均能完整玩通;
- 语料卡 golden-diff 与服务端/core 单测全绿,世界书导入导出与原版文件级一致;
- `skeinn check` 健康且独立 Keeper 校验通过。

假完整陷阱:
- UI 或生成看似能跑,但内嵌世界书/卡内正则/MVU `_.set` 静默丢失(模型靠卡面硬撑掩盖空转);
- 在线态把空列表回退成未标记 mock、或前端残留「协议未备」失实文案;
- 面板沙箱形同虚设(密钥经桥泄露/卡片自由外传),或在未启用 TLS+认证闸门(含 `/characters/*`)时暴露公网。

## Staged visibility and review

- TASK-053 后展示:`apps/web` 浏览器实机走查(连接探测/模型水合/全局栈与预设写回/人设头像切换/正则 CRUD)
- TASK-054~057 后展示:掌门卡 + 白莺学园都市双卡 CLI 与 SPA 全链实弹复验(内嵌书命中、`_.set` 35 条全落盘、变量宏回显、正则隐藏块、`cardapp op click` 异步推进不中断)
- TASK-050 后展示:剧场模式旗舰配套卡浏览器实测与截图(V2.1 单立绘 + `extra.scene/choices/narrator` 联调)
- 每批任务后 `skeinn check` + 项目测试双绿才算完

## Keeper handoff

`skeinn project ready` 冻结后由新鲜 Agent 走 keeper 校验。
