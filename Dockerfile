# syntax=docker/dockerfile:1
#
# Utopinn all-in-one 镜像:服务端内核(apps/server) + 已构建 SPA(apps/web/dist)。
# 参照 ref/Luker/Dockerfile,但按 pnpm monorepo 重写:
#   - node:24-bookworm-slim:与 engines(>=24)对齐;better-sqlite3 在 musl 下
#     无预编译才不走 alpine
#   - corepack pnpm + manifest 分层缓存;install 过滤到服务端闭包,
#     mobile/cli 只喂 manifest 保 lockfile 一致,其依赖树不进镜像
#   - LUKER_SKIP_WEBPACK=1:旧 jQuery UI 的 webpack 编译链不进镜像;
#     SPA dist 由内核按 ../web/dist 相对路径同源挂载(server-main.js)
#
# 运行时布局:
#   /app/apps/server    内核源码 + prod node_modules(pnpm 链接树原样平移)
#   /app/packages/*     workspace 包(src + dist;dist 是 gitignored 产物,必须镜像内构建)
#   /app/apps/web/dist  SPA 产物
#   /data               唯一状态卷:config.yaml/账号/卡/聊天/secrets 全在里面
#                       (WORKDIR 钉在 /data——内核把 config.yaml/whitelist.txt/backups/
#                        plugins/public 兼容目录全部解析到 process.cwd() 下)

########## manifest 底座:build / proddeps 两 stage 共用 ##########
# 只喂 manifest + lockfile(+ file: 依赖实体):这层只在依赖面变化时失效。
# mobile/cli 的 manifest 保 lockfile importer 一致,其源码/依赖树都不进镜像。
FROM node:24-bookworm-slim AS manifests

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

# 旧 corepack 可能撞 npm 签名 key 轮换,先升最新再 pin pnpm 版本
RUN npm install -g corepack@latest \
    && corepack enable \
    && corepack prepare pnpm@10.24.0 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/server/eslint-rules apps/server/eslint-rules/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY packages/kernel/package.json packages/kernel/
COPY packages/formats/package.json packages/formats/
COPY packages/protocol/package.json packages/protocol/
COPY packages/api-client/package.json packages/api-client/
COPY packages/panel-shim/package.json packages/panel-shim/

########## prod 依赖:独立 stage,与 build 并行 ##########
# `...` 后缀 = 连带 workspace 依赖闭包(@utopinn/* 全带上)。
# 分离原因:build 阶段删了 node_modules 再原地重装,同层 I/O 翻倍会压死 buildkit
FROM manifests AS proddeps

# store 挂 cache:prod 这层与 build 的 dev 安装共享下载产物,不重复拉包。
# fetch 先行:lockfile → store 的纯下载层,与源码变更解耦;install 只负责链接
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store \
    && pnpm install --frozen-lockfile --prod --prefer-offline --store-dir /pnpm/store --filter "@utopinn/server..."

########## 构建 ##########
FROM manifests AS build

# better-sqlite3 兜底:预编译包拉不到时退 node-gyp,需要编译链(仅构建期);
# git 给 simple-git/isomorphic-git 的插件安装探测用
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# 装服务端 + web + 全部 packages 的依赖(tsc/vite 构建需要 devDeps);
# `...` 后缀 = 连带 workspace 依赖闭包。mobile/cli 不装
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store \
        --filter "@utopinn/server..." \
        --filter "@utopinn/web..." \
        --filter "./packages/**"

COPY . .

# packages 的 dist 是 gitignored 但运行时被消费(server 直接 import dist/*.js);
# -r 按拓扑序跑:formats/protocol → core/api-client/kernel(panel-shim 无 build,跳过)
RUN pnpm --filter "./packages/*" -r build

# SPA 产物 → apps/web/dist
RUN pnpm --filter @utopinn/web build

# 卸掉构建期 node_modules——runtime 的依赖树由 proddeps stage 供给,
# devDeps(eslint/@types/typescript)与 web 构建链一个都不进运行时
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules

########## 运行时 ##########
FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Haaaiawd/Utopinn" \
      org.opencontainers.image.description="Utopinn server kernel + web SPA (all-in-one)" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
    LUKER_SKIP_WEBPACK=1

# tini:PID1 信号转发(docker stop → 内核优雅退出,SQLite WAL 正常收拢);
# git:服务端插件/三方扩展的运行时安装能力
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pnpm 依赖图是相对路径 symlink,整树平移即可用。
# 顺序:先 proddeps 的依赖树(node_modules + manifest),再叠 build 的源码/产物
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=proddeps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=proddeps /app/packages ./packages
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./

COPY --chmod=0755 docker/docker-entrypoint.sh /docker-entrypoint.sh
# Windows 检出(core.autocrlf)可能把 CRLF 带进上下文,shell 解释器不吃 \r —— 归一
RUN sed -i 's/\r$//' /docker-entrypoint.sh

# /data 是唯一状态卷。注意内核启动即 process.chdir(serverDirectory)
# (server.js:11)——CWD 相对路径锚的是 /app/apps/server,所以所有可配置的
# 状态路径都在 CMD 里显式指进 /data,不靠 WORKDIR
WORKDIR /data
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8000/').then(() => process.exit(0)).catch(() => process.exit(1))"

# 入口以 root 进:entrypoint 修正 /data 属主、首启播种 config.yaml 后降权到 node
ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]
CMD ["node", "/app/apps/server/server.js", \
     "--configPath", "/data/config.yaml", \
     "--dataRoot", "/data", \
     "--backupsPath", "/data/backups", \
     "--serverPluginsPath", "/data/plugins", \
     "--globalExtensionsPath", "/data/extensions", \
     "--port", "8000", "--listen"]
