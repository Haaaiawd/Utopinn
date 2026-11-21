# Utopinn(乌有馆 / U馆)

重构 SillyTavern:服务端大脑 + 薄客户端。Web 管理端(全功能)+ RN/Expo 手机端(精简 UI + 重 UI 专属页)。

## 架构决定(2026-11-02 拍板)

- **基底**:`ref/Luker`(SillyTavern 激进 fork,已含存储引擎层/多设备同步/服务端生成任务/CardApp 体系)。上游 `ref/SillyTavern` 作行为对照。
- **大脑在服务端**:prompt 组装、世界书引擎、正则管线、宏/STscript 全部跑在 server(`packages/core`)。理由:API 调用必然联网,无离线场景;ChatGPT/Claude 均为原生薄客户端、零共享大脑。
- **手机端**:React Native + Expo,薄客户端。只消费 `@utopinn/protocol`(类型)+ `@utopinn/formats`(导入导出)+ `@utopinn/api-client`。
- **重 UI = CardApp/状态栏面板**:卡里预设的 HTML 应用(背包/任务卡/状态面板)。移动端用底导航"面板"专属页承载,`react-native-webview` 沙箱渲染,ctx API 经 postMessage 桥接到 api-client。状态存服务端 chat_state sidecar(Luker 已有)。

## 布局

```
apps/server     Luker 剥出的后端(Express + 存储引擎 + LLM 代理;public/ 是旧 jQuery UI,暂留作参考/过渡管理端)
apps/mobile     Expo 薄客户端(骨架)
apps/web        新 SPA 管理端(未建,占位)
packages/core   大脑:从 apps/server/public/scripts/* 移植去 jQuery/DOM 化的纯 TS
packages/formats  卡面/世界书/JSONL 编解码(PNG tEXt、charx、byaf),无 fs,双端可用
packages/protocol  线协议:API 类型、WS/SSE 事件、资源 schema,三端唯一事实源
packages/api-client  TS 客户端,WS ticket 流式优先(RN 里 SSE 不稳)
tests/corpus    兼容语料:真实卡样本 + golden 组装结果 diff
ref/            参考代码(Luker 原 fork、SillyTavern 上游、GuiXu 等参考卡)
```

## 兼容策略(世界书/卡面/故事卡)

1. **格式层**:复用 Luker 服务端解析器(`src/{charx,byaf,character-card-parser}.js`、`src/png/`、`validator/TavernCardValidator.js`)移植进 `@utopinn/formats`,fixture 测试钉死。
2. **行为层**:golden-diff 测试——同一卡+聊天,原版 ST 前端引擎产出的组装结果 vs `core` 产出,逐字段 diff。语料在 `tests/corpus/cards/`(丢 .png/.json/.charx)。
3. **HTML/JS 面板**:WebView 沙箱 + 兼容 shim;老式正则状态栏里戳 ST 内部全局(`getContext()` 等)的 JS 会退化,接受并降级处理。
4. **第三方扩展**(`public/scripts/extensions/third-party`):不兼容,接受。
5. 世界书 `{entries:{}}` 文件格式不动;charx 内嵌书、角色主/辅书、聊天绑定书、全局书五层来源模型保留(Luker `ctx.getWorldBooks` 语义)。

## core 移植清单(工作量最大的部分)

从 `apps/server/public/scripts/` 抠纯逻辑、去 jQuery/DOM:

| 源文件 | 职责 | 行数级 |
|---|---|---|
| `openai.js` | chat 补全 prompt 组装 | ~7.4k |
| `world-info.js` | 世界书扫描/注入/预算 | ~6.4k |
| `PromptManager.js` | prompt 项编排 | ~2.1k |
| `macros.js` `slash-commands/` | 宏与 STscript | 大 |
| `instruct-mode.js` `textgen-settings.js` | 文本补全格式化 | 中 |
| `reasoning.js` `variables.js` `regex`(extensions) | 推理/变量/正则管线 | 中 |

参考:`public/scripts/generate-task.js`、`lukerContext.js` 已开始把 context 接口化,顺它抠。

## 命令

```bash
pnpm install
pnpm server        # apps/server(node server.js,需 Node>=24)
pnpm mobile        # apps/mobile(expo start)
pnpm typecheck
```

注意:`apps/server` 自带 package-lock(npm 习惯);workspace 安装用 pnpm 即可,原生依赖 better-sqlite3 需编译环境。

<!-- loom:v2 -->
## LOOM

This project uses LOOM as Agent-only continuity infrastructure. Run `loom context` when entering the
project, after a context reset, before substantial work, and when the human gives feedback or a direction
change. When a Task is active, the command restores its execution protocol, exact state, and declared
context; rerun it before editing after any interruption. Keep project truth, design documents, professional
capability dossiers, and Tasks current through the CLI, and never ask the human to operate LOOM. Do not
rerun LOOM before every tool call: persist and restore at meaningful work boundaries. The installed
`loom` command is the stable project-local invocation. If it is not on PATH in a source checkout, use
the absolute path to that checkout's `cli/bin/loom.js`; do not guess a relative path from this project.

## 提交署名约定(硬性)

- 所有 git commit 必须带双共同作者 trailer,缺一不可:
  ```
  Co-Authored-By: YuFan Luo <129919749+Haaaiawd@users.noreply.github.com>
  Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
  ```
- 历史已整体重写(2026-11-20,281 笔),远端 `backup/pre-coauthor-rewrite` 是重写前备份。子代理产出的 commit 同样适用——收格时若发现漏挂,`git commit --amend` 补上再推。

## 运维备忘

- **WSL 9P 环境病**：/mnt/d 是 9P 挂的 Windows 盘，高并发 I/O 会楔死（进程 D 态 `p9_client_rpc`）。**元凶常是 vite/chokidar 在 /mnt/d 上 watch 几万文件**——CLI 测试前先杀旧 dev 服。稳启配方：`LUKER_SKIP_WEBPACK=1 node server.js --dataRoot /tmp/<快照>`（webpack 整段剥离，`LUKER_PREBUILT_BUNDLES_DIR=<dataRoot>/_webpack/<hash>/output` 亦可）；dataRoot 别放 /mnt/d。
- better-sqlite3 等原生依赖在 pnpm 10+ 下默认不编译：首次 pnpm install 后需 pnpm approve-builds，或在 pnpm-workspace.yaml 配 onlyBuiltDependencies。
- `Cannot find package '@utopinn/*'`（CLI 报 `error[ERR_MODULE_NOT_FOUND]`）：node_modules 残缺、workspace 链接没建——`pnpm install` 在 lockfile 未变时走 up-to-date 快路径，pnpm 11 实测可能不补已缺失的链接（pnpm 10 会自愈）。解法：`pnpm install --force` 或删 node_modules 重装。**根 `node_modules/@utopinn` 本来就是空的**：pnpm isolated 只挂各包声明的依赖，根 package.json 没有 workspace 依赖（与 npm 把全部 workspace 包挂根不同），不是缺链症状；判 CLI 链接看 `apps/cli/node_modules/@utopinn`。
- 兼容语料：tests/corpus/cards/ 进 git（公开卡）；tests/corpus-private/ 已 gitignore（用户私有卡，由用户提供）；ref/cards/GuiXu 为本地参考样本。
- golden 捕获用 `tests/golden-diff/capture.sh <card.png>`（自动备齐 Playwright 缺的系统库、设 LD_LIBRARY_PATH）。私有卡产物自动落 golden-private/(gitignore)。前置条件：server.js 的 E2E_SCRATCH_ROOT/E2E_READY_TIMEOUT_MS 已由脚本内置；前端不会自动连 API，捕获脚本会显式点 #api_button_openai。
- pnpm 布局下 `apps/server/node_modules/base64-js` 不存在（依赖提升），js-tiktoken bundle 合成会 500——已从 .pnpm 实体拷贝兜底；升级依赖时注意复査。
- `packages/protocol/dist/` 是 gitignored 构建产物却在运行时被消费（CLI host/bridge 的 `isPanelMethod` 白名单）——**升级/clone 后必须先 `tsc` build protocol**，否则新 ctx 方法被当 bad_request 拒掉。

## 运维备忘(WSL 环境)

- **9P stall 已实锤**:WSL2 下 /mnt/d 走 9P 协议,高并发 I/O 时进程会 D 态卡死 `p9_client_rpc`(症状:server 启动静默 >60s、ps 显示 Dsl+)。**解法:scratch/dataRoot 放 /tmp**(如 `--dataRoot /tmp/uto-xxx-data`),代码树在 /mnt/d 无妨。
- **免编译启动**:`LUKER_PREBUILT_BUNDLES_DIR=<含 lib.core/lib.optional/codemirror.bundle.js 的 output 目录>` 跳过 webpack 编译,秒级起服。产物在 `tests/.e2e-scratch/*/_webpack/<hash>/output`(hash 寻址,跨 scratch 可互借)。
- **旧 UI 闸刀**:`apps/server/public/` 旧 jQuery UI 默认**不挂载**;`LUKER_SERVE_LEGACY=1` 才恢复(e2e 浏览器 harness/golden-diff 已由 `_lib/server.js` 自动注入)。直开服务端端口看到的是 kernel 状态页。
- 快速拉起:`rsync -a --exclude _webpack <scratch>/ /tmp/data/ && LUKER_PREBUILT_BUNDLES_DIR=<output> node server.js --dataRoot /tmp/data --port 18997`。

## 掌门卡 CardApp 工作区

- 独立工程在 `work/掌门卡/02_card_工作区/`，当前交付源是 `我没想当掌门啊_角色卡_v31.json`；不要按工作区旧 README 的 v29 回退。
- 在该目录运行 `node --check cardapp/index.js`、`node --test cardapp/ui.test.cjs`。浏览器回归用 `node cardapp/ui.browser.test.cjs`，需可解析的 Playwright；也可通过 `PLAYWRIGHT_MODULE` 指定既有安装的绝对路径，`PREVIEW_URL` 默认 `http://localhost:8977`（先运行 `node _srv.cjs`）。截图与检查记录落 `cardapp/_shots/ui-reshape/`。
- 同源双打包顺序：有 Pillow 的 Python 运行 `_prepare_portraits.py`（本机用 `python.exe`，从原图生成 40 张面板立绘）→ `node _opening_news.cjs`（幂等补开局报契约）→ `node _embed_app.cjs`（Luker）→ `node _bundle_jsr.cjs`（JSR）→ Linux/WSL `node _pngcard.cjs`（最终 PNG）。PNG 脚本依赖 `/mnt/c/...` 本机桌面原封面路径；换机器先核实，不要凭空换封面。
- 适配按容器而非视口判断；JSR 在宽视口仍是约 680px 小窗。`ui.test.cjs` 钉住状态读写、门线、拟办、发送和挂载等 16 个受保护函数的散列，纯 UI 改造不应改这些函数。浏览器桩回归不等于真实酒馆/助手的模型端联调。
- 新交互定向回归为 `cardapp/followup.browser.test.cjs` 与 `cardapp/scrollguard.browser.test.cjs`，检查真人 WebP、先写后确认、办事/读报切换保留底稿、精确地图选区和后台刷新不抢滚动。入口回归为 `cardapp/preview-entry.browser.test.cjs`；必须测 `/`，不能只测 `/cardapp/preview.html`。本机浏览器预览代理会在窄屏注入遮挡底栏的工具条，手机指针验证用直连 `:8977`；判断服务状态以实际 Windows 浏览器/`curl.exe` 为准。
