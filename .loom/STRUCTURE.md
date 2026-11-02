# Project structure

## Source code

- `apps/server/` — 后端(继承 Luker)。Express 入口 `server.js` → `src/`;旧 jQuery 前端在 `public/`(过渡管理端,勿在它之上加新功能)
- `apps/mobile/` — Expo RN 薄客户端
- `apps/web/` — 新 Web 管理端 SPA(待建)
- `packages/core/` — 服务端大脑(纯 TS,零 DOM/fs/网络;外部能力经注入端口)
- `packages/protocol/` — 线协议 schema,三端唯一事实源
- `packages/formats/` — 卡面/世界书/JSONL 编解码,纯函数
- `packages/api-client/` — 客户端 SDK

## Tests

- `packages/*/tests/` — 包级单元测试(node:test / 包内自声明 runner)
- `apps/server/tests/` — Luker 继承测试(jest + playwright e2e)
- `tests/corpus/` — 兼容语料卡;`tests/corpus/golden/` golden 样本;`tests/corpus-private/`(gitignore)私有卡
- `tests/golden-diff/` — diff runner 与规范化规则

## Documents

- `AGENTS.md` — 架构决定与移植清单(人读)
- `.loom/` — Loom 状态:PROJECT/STRUCTURE/DECISIONS、design/、capabilities/、tasks

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
