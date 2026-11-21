# legacy 端点收敛面 —— /api/* 双面清点与收口方案(TASK-035 P1)

> 产出类型:清点 + 收口**方案**。不动路由逻辑、不删路由。
> 口径日期:2026-11-21,全部数字为源码实测(非抄旧档)。
> 旧档 frontend-binding-matrix.md(10 插件/67 路由时点)已 superseded;本文档为活档。

## 0. 实测总账

| 面 | 规模 | 挂载方式 |
|---|---|---|
| **utopinn 产品面** | **11 插件,83 HTTP 路由 + 1 WS upgrade + 1 UDP** | `ctx.webServer.register`(kernel-boot 统一缠诊断) |
| **legacy compat 面** | **`src/endpoints/` 64 文件 → 有效挂载 ~519 HTTP 路由**(515 字面注册,含子路由器;named-doc 2 路由 ×3 宿主另计)+ **面外 ~24**:request-inspector 4、ws-ticket 1、card-runtime 8、users.js 静态内容 7 个 `use()`、server-main 散挂 4(csrf-token/api/ping/api/debug/export/api/system/update-check) | `app.use('/api/...', router)` 于 server-startup.js + server-main.js |
| 浏览器引擎死路径 | `public/` 旧 jQuery UI 静态挂载由 `LUKER_SERVE_LEGACY=1` 门控(默认 off);**但全部 legacy /api/* 路由器恒挂载**,与 UI 门无关 | server-main.js L403-428 |

插件面明细:`utopinn-library` 46、`utopinn-diag` 9(含 `/_kernel` 与 `/stats/*` 三)、`utopinn-data` 6、`utopinn-generate` 5、`utopinn-plugins` 5、`utopinn-mvu` 4、`utopinn-regex` 4、`utopinn-connection` 2、`utopinn-script` 1、`utopinn-th` 1、`utopinn-delivery` 0 HTTP + WS `/api/ws-delivery` + UDP LAN 发现。

## 1. 双面总表(legacy /api/* 逐面)

图例 — 孪生列:✅ 有 utopinn 等价 / 🔶 部分覆盖 / ❌ 无 / ⚪ 不适用(基建·新产品面·共享 helper)。
消费方列:**H**=golden/e2e harness、**U**=legacy UI(仅 LUKER_SERVE_LEGACY 下)、**W**=web SPA、**C**=CLI、**A**=api-client(panel-t0)、**M**=mobile、**S**=端点自测(apps/server/tests 只测该端点自身)。
verdict 列:**compat**=已加头注,收口候选;**keep**=产品面/基建不动;**gap**=有产品消费者但无孪生 → 进 §2 补缺清单。

### 1.1 黄金链路核(golden-diff 必经,全部 compat)

| 挂载 | 文件 | 路由数 | utopinn 孪生 | 消费方 | verdict |
|---|---|---|---|---|---|
| `/api/characters` | characters.js | 25 | ✅ `/characters*`(含 PATCH :charDir、state/char 六条) | H U C(`/all`) A(state 系已 deprecated) S | compat |
| `/api/chats` | chats.js | 30 | ✅ chat CRUD+state/chat 五条;❌ `group/*` 12 条无孪生(gap#1) | H U C(group/get) A(deprecated 动词) S W(`/rename`,已漂移) | compat(group 子面见 gap) |
| `/api/settings` | settings.js | 10 | ✅ GET+PATCH(白名单子集);❌ snapshots/field(s)/bootstrap 五条 | H U A(deprecated) S | compat |
| `/api/secrets` | secrets.js | 8 | ✅ GET/PUT/DELETE;❌ view/find/rotate/rename/read/settings 六动词 | U S | compat |
| `/api/presets` | presets.js | 13 | ✅ CRUD+state/preset 七条;❌ /patch /restore | H U S | compat |
| `/api/worldinfo` | worldinfo.js | 10 | ✅ `/worlds` 四;❌ get-batch/list-lite/import/edit/patch | H U S | compat |
| `/api/groups` | groups.js | 4 | ❌ 无 | C(`/all`) U S | **gap** |
| `/api/backends/chat-completions` | backends/chat-completions.js | 18 | ✅ `/generate`+`/jobs`+abort;❌ jobs/status·events·events-stream·active(persist_target 过滤,gap#3)、/bias、/process、`/multimodal-models` 子挂 | H U C(jobs/active) S | compat |
| `/api/backends/text-completions` | backends/text-completions.js | 8 | 🔶 generate→`/generate`;❌ status/props/ollama·llamacpp·tabby 子挂 | H U S | compat |
| `/api/backends/kobold` | backends/kobold.js | 4 | ❌(generate 可走 /generate;status/transcribe-audio/embed 无) | U S | compat |
| `/api/generation` | generation-control.js | 2 | ✅ `:id/abort`→`/jobs/:id/abort`;❌ `/active` | H U S | compat |
| `/api/tokenizers` | tokenizers.js | 36 | ⚪ 不补(组装在服务端,token 数走 /preview trace) | H U S | compat |
| `/api/stats` | stats.js | 3 | ✅ `/stats/summary|by-char|inject`(读面);❌ /update /recreate(无产品需求) | U S | compat |
| `/api/bootstrap` | bootstrap.js | 2 | ❌(metadata 各字段分散在 settings/secrets/plugins 面) | H U S | compat |

### 1.2 旧 UI 壳面(启动/界面资源,compat)

| 挂载 | 文件 | 路由数 | utopinn 孪生 | 消费方 | verdict |
|---|---|---|---|---|---|
| `/api/themes` | themes.js | 2(+named-doc 2) | ❌ | H U S | compat |
| `/api/moving-ui` | moving-ui.js | 1(+named-doc 2) | ❌ | H U S | compat |
| `/api/quick-replies` | quick-replies.js | 2(+named-doc 2) | ❌(gap#2:W 在用 `/list`) | H U **W** S | **gap**(读面有活消费) |
| `/api/backgrounds` | backgrounds.js | 5 | ❌ | H U S | compat |
| `/api/avatars` | avatars.js | 3 | ❌ | H U S | compat |
| `/api/sprites` | sprites.js | 4 | ❌ | H U S | compat |
| `/api/images` | images.js | 4 | ❌ | H U S | compat |
| `/api/files` | files.js | 4 | ❌ | U | compat |
| `/api/assets` | assets.js | 4 | ❌ | U S | compat |
| `/thumbnail` | thumbnails.js | 1 | ❌ | U | compat |
| `/api/extensions` | extensions.js | 8 | ⚪(utopinn /plugins 是另一物:cordis 插件 ≠ ST 扩展) | U S | compat |
| `/api/content` | content-manager.js | 2 | 🔶 `/import/scan-st` 部分同域 | U S | compat |
| `/api/docs` | docs.js | 2 | ❌ | U S | compat |
| `/api/card-app` | card-app.js | 9 | 🔶 产品面走 `/api/card-runtime/*`;卡文件编辑面无孪生 | U S | compat |

### 1.3 ST extras 生态(提供商/工具面,compat;最强删减候选层)

| 挂载 | 文件 | 路由数 | utopinn 孪生 | 消费方 | verdict |
|---|---|---|---|---|---|
| `/api/openai` | openai.js | 17(含 /custom 子挂) | 🔶 connection/test+models 仅覆盖"连接探测"语义 | U | compat |
| `/api/google` | google.js | 7 | 🔶 同上 | U | compat |
| `/api/anthropic` | anthropic.js | 1 | ❌ | U | compat |
| `/api/azure` | azure.js | 2 | ❌ | U | compat |
| `/api/novelai` | novelai.js | 4 | ❌ | U | compat |
| `/api/horde` | horde.js | 11 | ❌ | U | compat |
| `/api/minimax` | minimax.js | 1 | ❌ | U | compat |
| `/api/volcengine` | volcengine.js | 1 | ❌ | U | compat |
| `/api/nanogpt` | nanogpt.js | 2 | ❌ | U | compat |
| `/api/openrouter` | openrouter.js | 6 | ❌ | U | compat |
| `/api/sd` | stable-diffusion.js | 53(17 个子路由器) | ❌ | U S(comfy 三条自测) | compat |
| `/api/translate` | translate.js | 8 | ❌ | U | compat |
| `/api/speech` | speech.js | 11(2 子挂) | ❌ | U | compat |
| `/api/extra/caption` | caption.js | 1 | ❌ | U | compat |
| `/api/extra/classify` | classify.js | 2 | ❌ | U S | compat |
| `/api/search` | search.js | 11 | ❌ | U S | compat |
| `/api/vector` | vectors.js | 11 | ❌(smart-context 域,产品方向未拍板) | U S | compat |
| `/api/data-maid` | data-maid.js | 4 | ❌ | U S | compat |
| `/api/image-metadata` | image-metadata.js | 10 | ❌ | U S | compat |
| `/api/media` | media-cleanup.js | 2 | ❌ | U S | compat |
| `/api/backups` | backups.js | 3 | 🔶 `/backup` 是全量快照(语义不同) | U | compat |

### 1.4 产品/基建面(keep,不标 compat)

| 挂载 | 文件 | 路由数 | 说明 |
|---|---|---|---|
| `/api/users` | users-public.js | 10 | 登录/注册/oauth/recover —— 认证基建 |
| `/api/users` | users-private.js | 21 | 账户/备份/restore;**utopinn `/lan/import` 是 loopback 代理到本文件 lan-migration/import 实现,`/backup` 复用其归档机 → 删前必须先内联实现** |
| `/api/users` | users-admin.js | 35 | 多用户管理/公告/存储迁移 —— 管理面 |
| `/api/sync/v1` | sync.js(12)+sync-backends(11)+sync-s3(4) | 27 | 设备同步域,e2e 活消费;产品方向待定 →「未收编域」,不标不删 |
| `/api/skills` | skills.js | 21 | Luker 新功能面(skills 管理);恰在 /api/* 前缀下,**前缀漂移项**:未来建议挪插件域或显式豁免 |
| `/api/panel-shim` | panel-shim.js | 1 | T0 shim 静态件,面板宿主用 —— 新产品面 |
| `/api/card-runtime` + `/card-runtime` | card-runtime/ | 4+4 | CardApp mount 产品面(W/M/C/e2e 活消费) |
| `/api/storage` | storage-health.js | 1 | 健康检查基建 |
| `/api/debug/capture` | renderer-capture.js | 5 | admin 渲染层捕获 debug 工具(e2e 自测) |
| `/api/request-inspector` | src/request-inspector.js(不在 endpoints/) | 4 | 请求检查器;`/api/debug/export` 的 requestInspector 节数据源 —— golden 捕获间接依赖 |
| `/api/ws-ticket` | src/ws-ticket-router.js | 1 | WS 票基建,W/M/C/A 全在用 —— 传输层,非端点面 |
| `/` | src/users.js | 7 `use()` | `/characters/*` `/backgrounds/*` 等用户内容静态服务 —— W 卡图在用 |
| 散挂 | server-main.js | ~7 | `/csrf-token` `/api/ping` `/api/debug/export` `/api/system/update-check` `/version` `/_kernel` `/proxy/:url` |

### 1.5 不参评文件

`backends/luker-generation.js`(双面共享 job store)、`backends/google-models.js`/`vertex-models.js`(utopinn-connection 的模型拉取 helper)、`media-attribution.js`(helper)、`named-doc-routes.js`(registrar,宿主面已逐一评)。

## 2. utopinn REST 补缺清单(legacy 有·utopinn 无·产品面需要)

| # | 缺口 | legacy 源 | 现消费方 | 难度 | 建议形态 |
|---|---|---|---|---|---|
| 1 | **群聊域**:groups CRUD + group chat 读写(`/api/groups/*` 4 + `/api/chats/group/*` 12) | groups.js、chats.js L2900+ | C(`/groups/all`、`/chats/group/get`);web messenger stage 设计稿需要 | **大**(群存储/成员编排语义与 solo 分叉;/generate 已备 groupId/member,读写面要插件化 ~16 路由) | 新插件 `utopinn-groups`:`/groups` CRUD + `/groups/:id/chat*` |
| 2 | **named-doc 读面**(quick-replies/themes/moving-ui `GET /list|/get`) | named-doc-routes.js ×3 宿主 | W StageFrame `/api/quick-replies/list`(活) | **小** | `utopinn-library` 加 `GET /named-docs/:bucket` 一条通用面(bucket=quick-replies/themes/moving-ui) |
| 3 | **active-job 查询**:`jobs/active` 按 persist_target 过滤 | chat-completions.js `/jobs/active` | C checkNoActiveJob(护栏,写盘/生成前必查) | **小** | `GET /api/utopinn/jobs` 加 `?target=<charDir>/<chatName>&status=active` 过滤参 |
| 4 | **settings 写面放宽**:legacy `/api/settings/patch` 全量 JSON-patch vs utopinn PATCH 仅 `power_user`/`extension_settings` 浅合并 | settings.js `/patch` | A panel-t0 `settingsPatch`(CardApp ctx.setSettings 桥,deprecated) | **中**(语义拍板:放白名单 or panel-t0 限缩到受限语义) | 倾向后者——CardApp 实际需要写的本就落在 extension_settings |
| 5 | **角色卡写面**:create/delete/duplicate/edit-avatar/export/import | characters.js `/create` `/delete` `/duplicate` `/edit-avatar` `/export` `/import` | 无产品调用点(卡编辑器是设计稿目标态);PATCH :charDir 已备 | **中** | library 补 `POST /characters`(建)+`DELETE`+`POST /:charDir/avatar`;export 走 formats 包 |
| 6 | **会话搜索/导出/导入**:`/chats/search`、`/chats/export`、`/chats/import` | chats.js | cmdk 搜索设计稿需要;迁移中心需要 | **中** | library:`GET /chats/search?q=`;export 复用 JSONL 直读;import 挂 /import/commit kind |
| 7 | **worldbook 条目级写面**:`/worldinfo/edit|patch|get-batch|list-lite` | worldinfo.js | studio 双栏编辑器目标态 | **中** | library:`PATCH /worlds/:name`(条目 ops)+ `POST /worlds/get-batch` |
| 8 | **预设条目级 patch**:`/presets/patch`、`/presets/restore` | presets.js | 无活消费 | **小** | 缓做;PUT 整档已够 v2 |
| 9 | **secrets 管理动词**:view/find/rotate/rename | secrets.js | 设置页 secrets tab 目标态 | **小** | library secrets 面扩 `GET /secrets/:key`、POST rotate/rename |
| 10 | **用户资产写面**:avatars/backgrounds/sprites/images/files 上传管理 | 对应五文件 | 无活消费(persona 头像/聊天背景是设计稿目标态) | **中** | 新 `utopinn-assets` 插件或 library 扩面;读面已由 users.js 静态服务覆盖 |
| 11 | **chats/rename 收尾**:utopinn `…/chats/:chatName/rename` 已存在 | — | W chats.ts L289 仍打 legacy | **极小**(纯前端切换) | 改 web chats.ts,非服务端补缺 |
| 12 | **chat PATCH meta-only 通道**:panel-t0 `patchChatMetadata` | chats.js `/meta/patch` | A(deprecated) | **小** | api-client 迁到 utopinn PATCH `/header/chat_metadata` ops,服务端无需补 |

**明确不补(N/A)**:tokenizers(组装服务端化)、`/chats|characters|presets/state/*`(utopinn state 三族已全覆)、`/generation/active` 与 `jobs/status|events|events-stream`(/jobs + ws-delivery 覆盖)、`/chats/recent`(已有)、`stats /update|/recreate`、extras 全系(§1.3,删减候选)、`/characters/fields|field|projection`(old-UI 内部面)、`settings snapshots|field(s)|bootstrap`。

## 3. 删减候选清单(不删,等拍板)

判定轴:消费方=仅 legacy UI(可含端点自测)且不在 golden 必经链路上。删任何一个连带其自测删除。

### 3.A 一层候选(推荐先删 —— extras 生态,产品面明确不继承)

| 文件 | 路由数 | 备注 |
|---|---|---|
| anthropic.js / openai.js / google.js / azure.js / novelai.js / horde.js / minimax.js / volcengine.js / nanogpt.js / openrouter.js | 1+17+7+2+4+11+1+1+2+6 = **52** | 提供商 extras(caption-image/语音/图生/模型单)。utopinn 侧 connection/test+models 已接管产品所需探测语义;其余无消费方 |
| stable-diffusion.js | **53** | SD 图像生成全家,17 子路由器;仅 comfy 三条自测引用 |
| translate.js / speech.js / caption.js / classify.js / search.js | 8+11+1+2+11 = **33** | 翻译/语音/图像描述/分类/网搜 extras |
| files.js / backups.js / thumbnails.js | 4+3+1 = **8** | 用户文件/聊天备份/缩略图;零测试引用零产品引用 |
| data-maid.js / image-metadata.js / media-cleanup.js / docs.js / content-manager.js | 4+10+2+2+2 = **20** | 数据卫生/图元/媒体清理/文档查看/ST 内容站导入,皆有自测无活消费 |

一层合计 **~166 路由 / 24 文件**。风险点:`/api/vector`(11,自测在仓,smart-context 语义是否继承未拍板 → 建议缓到 vectors 决定后并入)、`extensions.js`(old-UI 启动会列第三方扩展,golden 捕获页若启用扩展则触达 → 列 3.B)。

### 3.B 二层候选(harness 迁移后才能动 —— golden 链路核 + 壳面)

harness(golden-diff/e2e 浏览器)仍在跑旧 UI,以下面被启动→生成链路触达;**删除前提是 golden 捕获改走 `/api/utopinn/preview` 直采**(headless-cardapp-harness 方向已立此意),或保留一份只读快照:

`settings.js` `secrets.js` `presets.js` `worldinfo.js` `characters.js` `chats.js` `groups.js` `backends/*` `generation-control.js` `tokenizers.js` `stats.js` `bootstrap.js` `themes.js` `moving-ui.js` `quick-replies.js` `backgrounds.js` `avatars.js` `sprites.js` `images.js` `assets.js` `extensions.js` `card-app.js` `vectors.js`(若判定不继承)`backends/kobold.js` `text-completions.js`(TASK-037 textgen 面归宿待拍板后并入对应层)。

### 3.C 永留面

users-* / sync* / skills / panel-shim / card-runtime / storage-health / renderer-capture / request-inspector / ws-ticket / users.js 静态内容 / server-main 散挂 —— 认证、同步、新功能、基建、debug 工具。

## 4. 头注标注(已落地)

以下 47 个文件顶部加一行 `// compat 面:harness/legacy UI 专用,产品调用走 /api/utopinn/*(收敛:.loom/design/legacy-convergence.md TASK-035)`:

- 黄金链路:characters.js、chats.js、settings.js、secrets.js、presets.js、worldinfo.js、backends/chat-completions.js、backends/text-completions.js、backends/kobold.js、generation-control.js、tokenizers.js、stats.js、bootstrap.js
- 壳面:themes.js、moving-ui.js、backgrounds.js、avatars.js、sprites.js、images.js、files.js、assets.js、thumbnails.js、extensions.js、content-manager.js、docs.js、card-app.js
- extras:openai.js、google.js、anthropic.js、azure.js、novelai.js、horde.js、minimax.js、volcengine.js、nanogpt.js、openrouter.js、stable-diffusion.js、translate.js、speech.js、caption.js、classify.js、search.js、vectors.js、data-maid.js、image-metadata.js、media-cleanup.js、backups.js

**刻意不标**:groups.js、quick-replies.js(有活产品消费+无孪生,标了是假话 → §2 gap)、users-*/sync-*/skills/panel-shim/card-runtime/storage-health/renderer-capture(产品面或基建)、named-doc-routes.js(registrar)、三个 backends helper(无路由共享件)、request-inspector.js(不在 endpoints/ 且是 golden inspector 数据源)。

## 5. 收编序(建议,非本轮执行)

1. **本轮(已做)**:对照表 + 头注 + 两清单 —— 协议边界成文,新代码禁止再绑 legacy 面。
2. **近端(小)**:web `renameChat` 切 utopinn 路由(gap#11);CLI `checkNoActiveJob` 依赖 gap#3 落地后切 `/jobs`;api-client deprecated 动词按 gap#4/#12 迁移。
3. **中端**:gap#1 群聊域插件化(web messenger stage 前置)、gap#2 named-doc 读面(QR 条去 legacy)。
4. **远端(拍板)**:3.A 一层候选连测删;golden 捕获迁 `/preview` 直采后 3.B 逐面退役;`TASK-035 done_when` 的"public/scripts 引擎文件删除"与 3.B 同前提。
