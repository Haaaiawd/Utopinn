# Utopinn

服务端大脑 + 薄客户端的 Tavern 重构:SillyTavern/Luker 的 prompt 组装、世界书、宏、
变量、MVU、CardApp 兼容层全部收进服务端;浏览器/CLI/未来移动客户端只消费同一份
REST+WS 协议。

## 架构

```
浏览器 UI(apps/web)      utopinn CLI(apps/cli)
        │                        │
        └──── REST + WS ─────────┘
                  │
            Cordis 内核(apps/server)
        ┌──────────┬───────────┬──────────┐
        │ library  │ generate  │ delivery │  10 个插件域
        │ mvu/th   │ diag      │ import   │  ~70 HTTP 路由
        └──────────┴───────────┴──────────┘
                  │
        存储引擎(fs/mysql/pg)+ CAS/JSON-Patch
```

- **服务端权威**:prompt 组装/世界书注入/宏与正则管线/变量与 MVU 结算/CardApp+TavernHelper 桥,全在内核
- **CLI 是协议参考客户端**:每个服务端能力都有具名动词(`doctor` 自证 67/67,raw-only 0)
- **前端是壳**:Cordis 式贡献点组织(nav.rail/sidebar.tree/stage.form/panel.type),按插件域挂 UI

## 纯内核启动(CLI/云端场景,无前端编译)

```bash
cd apps/server
LUKER_SKIP_WEBPACK=1 node server.js --dataRoot ./data --port 18997
```

需要前端静态产物时改用预编译目录:
`LUKER_PREBUILT_BUNDLES_DIR=<dataRoot>/_webpack/<hash>/output`

## CLI 速览

```bash
node apps/cli/utopinn-cli.mjs doctor            # 链路体检(含路由覆盖率)
utopinn use <卡名>                              # 绑卡(无聊天不隐式建)
utopinn chat-new main && utopinn send "…"       # 聊天+生成
utopinn swipe / regen / continue / abort        # 生成系
utopinn th getVariables / insertOrAssignVariables
utopinn mvu state|settle|panel                  # MVU 面
utopinn state chat|char|preset <op>             # sidecar 三族(CAS)
utopinn logs / errors / trace <jobId>           # 观测面(在飞)
utopinn schema                                  # 全动词清单
```

## 布局

```
apps/server    内核:Express + Cordis 插件 + 存储引擎(public/ 旧 jQuery UI 过渡保留)
apps/cli       utopinn-cli.mjs 单文件协议参考客户端
apps/web       新前端壳(Vite+React19+Tailwind4+Radix),Cordis 贡献点组织
packages/core  大脑:世界书/宏/instruct/MVU 纯 TS 引擎
packages/protocol   线协议:API 类型+WS 帧+面板契约,三端唯一事实源
packages/api-client typed REST/WS 客户端
.skeinn/         决策/设计/任务账本(DECISIONS·design/·tasks.json)
tests/         兼容语料+golden-diff+utopinn-acceptance 验收矩阵(74 断言)
```

## 状态

- 验收:`node apps/server/tests/utopinn-acceptance/run.mjs` → 74/74
- 掌门卡(复杂 CardApp+TH 脚本)实测:send/swipe/th 变量/state 全链通
- 在飞:观测面(报错/日志/注入时序)、壳高保真复刻、headless CardApp 宿主(TASK-042)
- 环境备忘:WSL 下 `/mnt` 盘高并发 I/O 会楔死 9P——`--dataRoot` 放原生盘,
  dev 服(chokidar)别和后端抢通道,详见 `AGENTS.md`
