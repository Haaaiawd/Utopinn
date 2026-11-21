# Project structure

## Source code

- `apps/server/` — 后端(继承 Luker + Cordis 插件体系)。Express 入口 `server.js` → `src/`(11 个 `utopinn-*` 插件在 `src/plugins/`,共享服务在 `src/services/`);旧 jQuery 前端在 `public/`(兼容 harness,由 `LUKER_SERVE_LEGACY=1` 门控、默认不挂载,仅 e2e/golden 使用,勿加新功能)
- `apps/web/` — V2 正式 Web 前端 SPA(React 19 + Vite + Tailwind 4,`src/{features,kernel,components,api,cardapp}/`;贡献点微内核 + `/ui/contrib` 水合,`dist/` 由 `:8000` 直供)
- `apps/cli/` — agent-first 零依赖核心面参考客户端(`utopinn-cli.mjs`,覆盖 84 具名路由)与懒加载 jsdom/esbuild CardApp headless 宿主(`cmd-cardapp.mjs` + `cardapp-host.mjs`)
- `apps/mobile/` — Expo RN 薄客户端骨架(已冻结/parked,D-020 改判 IReader,保留作协议与面板桥参照)
- `packages/core/` — 服务端大脑(纯 TS,零 DOM/fs/网络;prompt/WI/macros/regex/MVU/STscript/instruct/message-frame,外部能力经注入端口)
- `packages/protocol/` — 线协议 schema,三端唯一事实源(运行期消费 `dist/`,修改后须重新 `tsc`)
- `packages/formats/` — 卡面/世界书/JSONL 编解码,纯函数(PNG tEXt/charx/byaf)
- `packages/api-client/` — 客户端 SDK(`UtopinnClient` + WS stream + `panel-t0` 桥处理器)
- `packages/kernel/` — 服务端 Cordis 插件内核适配层(`context`/`loader`/`webserver`/`legacy-adapter`)
- `packages/panel-shim/` — 不可信卡片沙箱双面注入 shim(`ctx-shim.js` CardApp ctx 面 + `runtime.js` TavernHelper 兼容面)

## Tests

- `packages/*/tests/` — 包级单元测试(node:test / 包内自声明 runner)
- `apps/server/tests/` — Luker 继承测试(jest + playwright e2e)
- `tests/corpus/` — 兼容语料卡;`tests/corpus/golden/` golden 样本;`tests/corpus-private/`(gitignore)私有卡
- `tests/golden-diff/` — diff runner 与规范化规则

## Documents

- `AGENTS.md` — 架构决定与移植清单(人读)
- `.skeinn/` — Skeinn 状态:PROJECT/STRUCTURE/DECISIONS、design/、capabilities/、tasks

## Configuration and build

- `pnpm-workspace.yaml`、根 `package.json`、`tsconfig.base.json`
- `apps/server/package.json`(自带 npm package-lock;workspace 用 pnpm)
- `apps/mobile/app.json`、`babel.config.js`

## Assets and fixtures

- `apps/server/default/` — 默认用户数据与内置内容
- `apps/server/public/` — 旧前端资产
- `ref/` — 参考代码(gitignore,仅本地):Luker 原 fork、SillyTavern 上游、参考卡

## Conventions

- 新代码 TypeScript ESM strict;`apps/server` 内继承代码保持原风格(纯 JS + JSDoc),不强转
- core/formats/protocol 为纯库:不 import express/DOM/平台 API
- 存储写入一律经 Repo 层,禁直写 fs(沿用 Luker 约定)
- 测试文件 `*.test.ts`;语料卡放 tests/corpus/cards/ 并标注兼容面
