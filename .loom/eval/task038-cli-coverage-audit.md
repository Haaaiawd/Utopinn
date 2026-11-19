# TASK-038 CLI 覆盖审计：utopinn REST 面 × CLI 具名动词对齐矩阵

审计时间：TASK-038 实施前置。只读审计，未改任何文件。
方法：逐文件读 `apps/server/src/plugins/utopinn-*.js` 全部 `webServer.register/registerUpgrade` 调用 + `apps/cli/utopinn-cli.mjs` 的 `NAMED_UTOPINN_ROUTES`/SCHEMA/dispatch，双向 diff。

## 0. TL;DR

| 指标 | 数 |
|---|---|
| kernel 注册面（10 插件） | **65 HTTP + 1 WS upgrade** |
| CLI 具名动词绑定的路由（`NAMED_UTOPINN_ROUTES`） | 47 |
| **GAP（raw-only）** | **18，全部集中在 state sidecar 三族** |
| 其余域 | 全部已绑，零 GAP |

- D-021 结论：**除 `state/{chat|char|preset}/*` 一族 18 条外，协议面已被具名动词钉死**。`doctor` 的 capability-coverage 步骤会把这 18 条如实报为 raw-only（`utopinn-cli.mjs:812-818`）。
- 特别标注：`/api/utopinn/jobs/:id` 的 **abort 不在 utopinn 面上**——它在 legacy `POST /api/generation/:request_id/abort`（`endpoints/generation-control.js:24`），CLI `abort` 动词已绑该 legacy 路由。这是**服务端侧**协议洞，见 §5.3。

## 1. 服务端路由全清单（按插件域）

`profile.yaml`（`apps/server/src/profile.yaml:11-31`）声明式装载全部 10 个插件，无 disabled 行。所有 HTTP 面经 `webServer.middleware()` 挂在 `server-startup.js:143`（`/api/utopinn` 已 100% 插件化，`kernel-boot.js:23` 注释自证）。

### 1.1 utopinn-diag（`plugins/utopinn-diag.js`）— 1 条

| Method | Path | kind | 行号 |
|---|---|---|---|
| GET | `/api/utopinn/_kernel` | exact | :14-24 |

### 1.2 utopinn-generate（`plugins/utopinn-generate.js`）— 4 条

| Method | Path | 行号 | 备注 |
|---|---|---|---|
| GET | `/api/utopinn/jobs` | :133 | 本 handle 全部 job 摘要 |
| GET | `/api/utopinn/jobs/:id` | :141 | 详情：status/text/trace/sources/promptMessages/timedWorldInfo |
| POST | `/api/utopinn/generate` | :168 | 全组装派发；`body.api==='text'` 走 textgen 分叉（:214-289） |
| POST | `/api/utopinn/preview` | :352 | 干跑组装，回 messages+trace+sources+perf |

### 1.3 utopinn-library（`plugins/utopinn-library.js`）— 44 条

基础面（`P='/api/utopinn'`，:230）：

| Method | Path | 行号 |
|---|---|---|
| GET | `/characters` | :241 |
| GET | `/characters/:charDir` | :318 |
| GET | `/characters/:charDir/chats` | :336 |
| GET | `/characters/:charDir/chats/:chatName` | :366 |
| GET | `/presets`（`?apiId`） | :400 |
| GET | `/presets/:name`（`?apiId`） | :415 |
| GET | `/worlds` | :433 |
| GET | `/worlds/:name` | :451 |
| GET | `/personas` | :472 |
| GET | `/settings` | :513 |
| GET | `/secrets` | :773 |
| DELETE | `/characters/:charDir/chats/:chatName` | :532 |
| PUT | `/characters/:charDir/chats/:chatName` | :829 |
| POST | `/characters/:charDir/chats/:chatName/rename` | :853 |
| POST | `/characters/:charDir/chats/:chatName/messages` | :880 |
| PATCH | `/characters/:charDir/chats/:chatName` | :977 |
| PUT | `/characters/:charDir/chats/:chatName/document` | :1066 |
| PATCH | `/settings` | :556 |
| PUT | `/presets/:name`（`?apiId`） | :601 |
| DELETE | `/presets/:name` | :617 |
| PUT | `/worlds/:name` | :635 |
| DELETE | `/worlds/:name` | :654 |
| PUT | `/personas/:avatar` | :672 |
| DELETE | `/personas/:avatar` | :731 |
| PUT | `/secrets/:key` | :786 |
| DELETE | `/secrets/:key/:id` | :807 |

state sidecar 三族（TASK-032 收尾增量，:1141-1821）——**当前 0 动词**：

| Method | Path | 行号 | body/query 形状 |
|---|---|---|---|
| GET | `/state/chat/get` | :1160 | query `is_group`+`id` 或 `avatar_url`+`file_name`，`namespace`，`account`（ETag 私有化读，`?account` 必须=认证 handle） |
| POST | `/state/chat/get` | :1205 | `{avatar_url,file_name|is_group,id, namespace}` |
| POST | `/state/chat/get-batch` | :1231 | `{target…, namespaces[]}` |
| POST | `/state/chat/patch` | :1266 | `{target…, namespace, operations[]|operation}` JSON-Patch，409=test/missing-parent |
| POST | `/state/chat/delete` | :1346 | `{target…, namespace}` 恒 `{deleted:true}` |
| GET | `/state/char/get` | :1387 | query `avatar`+`namespace`+`account` |
| POST | `/state/char/get` | :1417 | `{avatar_url, namespace}`（avatar_url 经 `validateAvatarUrlMiddleware`） |
| POST | `/state/char/get-batch` | :1437 | `{avatar_url, namespaces[]}` |
| POST | `/state/char/set` | :1472 | **char 独有**：`{avatar_url, namespace, data:object}` 整态覆写；卡不在 →404 |
| POST | `/state/char/patch` | :1510 | `{avatar_url, namespace, operations[]|operation}` |
| POST | `/state/char/delete` | :1569 | `{avatar_url, namespace}` 缺失 →`{deleted:false}` |
| GET | `/state/preset/get` | :1603 | query `apiId`+`name`+`namespace`+`account` |
| POST | `/state/preset/get` | :1642 | `{apiId, name, namespace}` |
| POST | `/state/preset/get-batch` | :1664 | `{apiId, name, namespaces[]}` |
| POST | `/state/preset/patch` | :1698 | `{apiId, name, namespace, operations[]|operation}` |
| POST | `/state/preset/delete` | :1746 | `{apiId, name, namespace}` |
| POST | `/state/preset/delete-all` | :1768 | **preset 独有**：`{apiId, name}` 清全 ns →`{deleted:<count>}` |
| POST | `/state/preset/rename` | :1790 | **preset 独有**：`{apiId, oldName, newName}` ns 随名迁移；撞档 →409 |

### 1.4 utopinn-mvu（`plugins/utopinn-mvu.js`）— 4 条

| Method | Path | 行号 |
|---|---|---|
| POST | `/api/utopinn/mvu/settle` | :39 |
| POST | `/api/utopinn/mvu/resettle` | :58 |
| GET | `/api/utopinn/mvu/state` | :75 |
| POST | `/api/utopinn/mvu/panel/render` | :92 |

### 1.5 utopinn-plugins（`plugins/utopinn-plugins.js`）— 4 条

| Method | Path | 行号 |
|---|---|---|
| GET | `/api/utopinn/plugins` | :21-31 |
| POST | `/api/utopinn/plugins/:id/enable` | :46 |
| POST | `/api/utopinn/plugins/:id/disable` | :47 |
| POST | `/api/utopinn/plugins/:id/reload` | :48 |

### 1.6 utopinn-import（`plugins/utopinn-import.js`）— 2 条

| Method | Path | 行号 |
|---|---|---|
| POST | `/api/utopinn/import/preview` | :322 |
| POST | `/api/utopinn/import/commit` | :386 |

### 1.7 utopinn-data（`plugins/utopinn-data.js`）— 4 条 + UDP

| Method | Path | 行号 |
|---|---|---|
| POST | `/api/utopinn/backup` | :70 |
| POST | `/api/utopinn/lan/offer` | :82 |
| POST | `/api/utopinn/lan/import` | :102 |
| POST | `/api/utopinn/import/scan-st` | :126 |
| UDP | 同 HTTP 端口 LAN 发现应答 | :142-159 | 非 HTTP，不在 kernel 路由表 |

### 1.8 utopinn-script（`plugins/utopinn-script.js`）— 1 条

| Method | Path | 行号 |
|---|---|---|
| POST | `/api/utopinn/script/run` | :27 |

### 1.9 utopinn-th（`plugins/utopinn-th.js`）— 1 条

| Method | Path | 行号 |
|---|---|---|
| POST | `/api/utopinn/th/call` | :252-303 |

### 1.10 utopinn-delivery（`plugins/utopinn-delivery.js`）— 1 条 upgrade

| kind | Path | 行号 |
|---|---|---|
| upgrade | `/api/ws-delivery` | :137（ticket 子协议 `luker-ws-ticket.`，帧 head/chunk/end/error + ping/pong + subscribe/resume/unsubscribe） |

## 2. CLI 动词全清单（`apps/cli/utopinn-cli.mjs`，dispatch :2059-2130）

**55 个 case 标签 / ~57 个动词**（含别名、裸命令）：

| 动词 | 绑定的服务端面 | 行号 |
|---|---|---|
| （裸） | 纯本地 state 快照 | cmdBare :665 |
| `status` | legacy `POST /api/chats/get` + `POST /api/backends/chat-completions/jobs/active` | :684 |
| `doctor` | `GET /csrf-token` + legacy `POST /api/characters/all` + WS ticket 探针 + `GET /api/utopinn/_kernel` | :775 |
| `schema` | 本地 SCHEMA 打印 | :828 |
| `chars` | `GET /api/utopinn/characters` + legacy `POST /api/characters/all`（双源合并） | :902 |
| `chats` | `GET …/chats`（kernel 优先，legacy `POST /api/characters/chats` 兜底） | :922 |
| `recent` | legacy `POST /api/chats/recent`（**无 kernel 等价**） | :952 |
| `use` | 本地 ctx 写 + chars/chats 解析 | :965 |
| `chat-new` | 纯本地（懒建坐标） | :980 |
| `chat-create` | `PUT …/chats/:chatName` | :1576 |
| `chat-put` | `PUT …/document` | :1596 |
| `chat-get` | `GET …/chats/:chatName` | :1554 |
| `chat-rename` | `POST …/rename` | :999 |
| `chat-delete` | `DELETE …/chats/:chatName` | :1013 |
| `char` | `GET /api/utopinn/characters/:charDir` | :1534 |
| `history` | legacy `POST /api/chats/get` | :1026 |
| `edit` | `PATCH …/chats/:chatName` | :1056 |
| `jobs` | `GET /api/utopinn/jobs` | :1077 |
| `inspect` | `GET /api/utopinn/jobs/:id` | :1092 |
| `preview` | `POST /api/utopinn/preview` | :1129 |
| `attach` | WS resume + legacy `POST …/jobs/status` | :1225 |
| `abort` | **legacy** `POST /api/generation/:id/abort` | :1253 |
| `persona` | 纯本地（name 绑 ctx） | :1262 |
| `personas` / `persona-edit` / `persona-delete` | `GET`/`PUT`/`DELETE /api/utopinn/personas[/:avatar]` | :1712/:1725/:1747 |
| `presets` / `preset` / `preset-get` / `preset-edit` / `preset-delete` | `GET`/`GET`/`PUT`/`DELETE /api/utopinn/presets[/:name]`；`preset` 本体是本地绑定（校验时查列表） | :1275-1709 |
| `settings` / `settings-set` | `GET`/`PATCH /api/utopinn/settings` | :1761/:1779 |
| `secrets` / `secret-set` / `secret-delete` | `GET`/`PUT`/`DELETE /api/utopinn/secrets[/:key[/:id]]` | :1814/:1836/:1857 |
| `send`/`say`/`regen`/`swipe`/`continue`/`impersonate`/`quiet` | `POST /api/utopinn/generate` + WS resume + `POST …/messages`/`PATCH …`（写盘） + legacy jobs/status、jobs/active | :2096-2107, runGeneration :457 |
| `worlds` / `wi` / `world-edit` / `world-delete` | `GET`/`GET`/`PUT`/`DELETE /api/utopinn/worlds[/:name]` | :1358-1658 |
| `kernel`（别名 `caps`） | `GET /api/utopinn/_kernel` | :1392 |
| `plugins` / `plugin <id> <op>` | `GET`/`POST /api/utopinn/plugins[/:id/<op>]` | :1404/:1415 |
| `mvu [state\|settle\|resettle\|panel]` | mvu 四面 | :1433 |
| `script`（别名 `stscript`） | `POST /api/utopinn/script/run` | :1489 |
| `th <method> [json]` | `POST /api/utopinn/th/call` | :1506 |
| `import-scan` / `import-preview` / `import-commit` | `POST /api/utopinn/import/*` | :1885/:1903/:1926 |
| `backup` | `POST /api/utopinn/backup`（二进制自管 fetch） | :1954 |
| `lan-offer` / `lan-import` | `POST /api/utopinn/lan/*` | :1997/:2014 |
| `raw <M> </path> [json\|--stdin]` | **逃生舱**：任意端点直达 | :2041 |
| `help`/`-h`/`--help` | 本地 | :2125 |

## 3. 对齐矩阵（utopinn 路由 → CLI 动词）

### diag / generate / delivery / plugins / import / data / script / th / mvu —— 全绿

| 路由 | 动词 |
|---|---|
| `GET /_kernel` | `kernel` / `caps` |
| `GET /jobs` | `jobs [-n]` |
| `GET /jobs/:id` | `inspect [jobId] [--section]` |
| `POST /generate` | `send`·`regen`·`swipe`·`continue`·`impersonate`·`quiet` |
| `POST /preview` | `preview [--type t] [-n]` |
| `upgrade /api/ws-delivery` | 间接绑定：`send`/`attach`/`doctor`（streamJob）；无语义缺口 |
| `GET /plugins`，`POST /plugins/:id/{enable,disable,reload}` | `plugins`，`plugin <id> <op>` |
| `POST /mvu/{settle,resettle,panel/render}`，`GET /mvu/state` | `mvu settle/resettle/panel/state` |
| `POST /script/run` | `script` / `stscript` |
| `POST /th/call` | `th <method>` |
| `POST /import/{scan-st,preview,commit}` | `import-scan`/`import-preview`/`import-commit` |
| `POST /backup` | `backup [--out] [--set cat=bool]` |
| `POST /lan/{offer,import}` | `lan-offer`/`lan-import` |
| UDP LAN discover | N/A（非 HTTP；如需动词可 `discover` 发探头收 pong，优先级低） |

### library 基础面 —— 全绿（26/26）

| 路由 | 动词 |
|---|---|
| `GET /characters` | `chars` |
| `GET /characters/:charDir` | `char <name>` |
| `GET …/chats` | `chats [--char]` |
| `GET …/chats/:chatName` | `chat-get` |
| `PUT …/chats/:chatName` | `chat-create <name>` |
| `PUT …/document` | `chat-put` |
| `POST …/rename` | `chat-rename` |
| `DELETE …/chats/:chatName` | `chat-delete` |
| `POST …/messages` | 经 `send`/`say`/`impersonate --write` 写盘路径（`writeOp/appendFloors`） |
| `PATCH …/chats/:chatName` | 经 `edit`/`swipe N`/`continue`/`regen`（`patchFloors`） |
| `GET|PUT|DELETE /presets[/:name]` | `presets`/`preset-edit`/`preset-delete`（+`preset-get`） |
| `GET|PUT|DELETE /worlds[/:name]` | `worlds`/`wi`/`world-edit`/`world-delete` |
| `GET|PUT|DELETE /personas[/:avatar]` | `personas`/`persona-edit`/`persona-delete` |
| `GET|PATCH /settings` | `settings`/`settings-set` |
| `GET`/`PUT`/`DELETE /secrets[…]` | `secrets`/`secret-set`/`secret-delete` |

### library state sidecar 三族 —— **全红（0/18）**

| 路由 | 动词 |
|---|---|
| `GET|POST /state/chat/get` | **GAP** |
| `POST /state/chat/get-batch` | **GAP** |
| `POST /state/chat/patch` | **GAP** |
| `POST /state/chat/delete` | **GAP** |
| `GET|POST /state/char/get` | **GAP** |
| `POST /state/char/get-batch` | **GAP** |
| `POST /state/char/set` | **GAP** |
| `POST /state/char/patch` | **GAP** |
| `POST /state/char/delete` | **GAP** |
| `GET|POST /state/preset/get` | **GAP** |
| `POST /state/preset/get-batch` | **GAP** |
| `POST /state/preset/patch` | **GAP** |
| `POST /state/preset/delete` | **GAP** |
| `POST /state/preset/delete-all` | **GAP** |
| `POST /state/preset/rename` | **GAP** |

## 4. 特别标注（任务点名项）

- **`/api/utopinn/preview`**：✅ 有动词 `preview [--type t] [-n] [--full] [--out]`（:1129）。
- **`/api/utopinn/jobs/:id`**：✅ GET 绑 `inspect`；❌ **abort 不存在于 utopinn 面**——真 abort 在 legacy `POST /api/generation/:request_id/abort`（`generation-control.js:24-67`），CLI `abort` 已绑它。D-021 语义下这是服务端缺口而非 CLI 缺口。
- **state sidecar 三族**：❌ 18 条全 GAP（仅 `raw` 可达）。capability 文档 :369/:403 曾登记 `panel` 动词意图（chat_state 联调面），至今未落地——`panel` 名字被 `mvu panel` 占了一半语义，建议用 `state` 命名域，见 §5。
- **backup/import/diag**：✅ `backup`/`import-scan`/`import-preview`/`import-commit`/`lan-offer`/`lan-import`/`kernel` 全绑。
- **附带发现（CLI 侧的 legacy 依赖，非 kernel GAP）**：`status`/`attach`/`send` 链仍吃 legacy `POST /api/backends/chat-completions/jobs/{status,active}`、`POST /api/chats/get`、`POST /api/characters/all`、`POST /api/chats/recent`——其中 `jobs/active`、`chats/recent` 无 kernel 等价路由（服务端债），`jobs/status`/`chats/get` 的 kernel 等价已存在（`GET /jobs/:id`、`GET …/chats/:chatName`）但 CLI 未迁。

## 5. GAP 动词建议（与现有风格一致：位置参数 + --flags + --stdin/--json-file）

**选 `utopinn state <family> <op>` 两级子动词**（先例：`mvu <sub>`、
`plugin <id> <op>`）。否掉「18 个顶层动词」（`chat-state-get` 等）——动词面会爆，`state` 本身就是内核路由的命名域，照抄最直觉。

```
utopinn state <family> <op> [args] [flags]
  family: chat | char | preset
```

| 新动词 | 绑定路由 | 参数形状 |
|---|---|---|
| `state chat get <ns>` | `POST /state/chat/get` | ctx 目标（`{avatar_url:<charDir>.png, file_name:<chat>.jsonl}`）；`--chat <name>`、`--group <id>` 换目标；`--via get` 走 GET+query 形（带 `--handle` 作 `account`） |
| `state chat get-batch <ns…>` | `POST /state/chat/get-batch` | 位置参余量 = namespaces |
| `state chat patch <ns> [ops\|--json-file f\|--stdin]` | `POST /state/chat/patch` | ops = JSON-Patch 数组；409 → `integrity_conflict` 类 fail |
| `state chat delete <ns>` | `POST /state/chat/delete` | 显式 ns（delete 必须点名，与铁律一致） |
| `state char get <ns> [--char d]` | `POST /state/char/get` | `avatar_url=<char>.png`，ctx.char 兜底 |
| `state char get-batch <ns…> [--char d]` | `POST /state/char/get-batch` | 同上 |
| `state char set <ns> [doc\|--json-file f\|--stdin]` | `POST /state/char/set` | 整态覆写；body.data 必须是对象（CLI 侧先验对象形） |
| `state char patch <ns> [ops\|--json-file f\|--stdin]` | `POST /state/char/patch` | 404 卡不在 →`not_found` |
| `state char delete <ns> [--char d]` | `POST /state/char/delete` | `{deleted:false}` 如实回（不是错误） |
| `state preset get <name> <ns> [--api id]` | `POST /state/preset/get` | `--api` 默认 openai，同 preset-* 族 |
| `state preset get-batch <name> <ns…> [--api id]` | `POST /state/preset/get-batch` | |
| `state preset patch <name> <ns> [ops…] [--api id]` | `POST /state/preset/patch` | |
| `state preset delete <name> <ns> [--api id]` | `POST /state/preset/delete` | |
| `state preset delete-all <name> [--api id]` | `POST /state/preset/delete-all` | 显式名；回 `{deleted:<count>}` |
| `state preset rename <old> <new> [--api id]` | `POST /state/preset/rename` | 409 撞档 →`exists` rc3 |

GET 变体（`GET /state/*/get` ×3）属同能力 alternate wire 形：建议 `get` 默认走 POST body（`?account` 需知 handle，POST 不需要）；`--via get` 留作 ETag 路径演练口。若 D-021 按「路由」严格计，三选一在实现时把 GET 变体也计入 NAMED 集——语义上一条动词绑两条同能力路由是成立的（`mvu` 先例：一动词多子面）。

配套改动（实施时一起做）：
1. `NAMED_UTOPINN_ROUTES`（:720-773）追加 18 条（GET+POST 同路径各算一条，共 18 行）。
2. `SCHEMA.commands`（:830-894）追加 `state` 族条目；`SCHEMA.flags` 加 `--chat`、`--via`、`--group`。
3. argv 解析器加 `--chat`、`--via`、`--group` 三个新 flag（:21-73）。

### 5.3 服务端侧协议债（非本任务动词，建议随 TASK-038 一并裁决）

| 缺口 | 建议 |
|---|---|
| 无 `/api/utopinn/jobs/:id/abort` | 在 utopinn-generate 加 `POST /api/utopinn/jobs/:id/abort`（一行代理 `generation-control` 同逻辑），`abort` 动词改绑 kernel 面；否则 D-021 下「生成控制」永远缺一截 |
| 无 kernel `jobs/active` | `utopinn jobs --active` 客户端过滤 `GET /jobs`，或服务端加 `?active=1` 查询；`checkNoActiveJob`/`status` 迁 kernel |
| 无 kernel `jobs/status` | `pollStatus` 迁 `GET /api/utopinn/jobs/:id`（字段超集） |
| 无 kernel `chats/recent` | 服务端加 `GET /api/utopinn/recent-chats`（跨卡 sort_time 汇总），`recent` 改绑 |
| `history`/`getChat`/`listChars`/`listChats` 仍走 legacy | kernel 等价已存在，渐进迁（非阻塞） |

## 6. legacy `/api/*` 存活且无 utopinn 等价（挂载清单，`server-startup.js:86-220` + `server-main.js`）

仅列组名：**users(私/管/公)**、**moving-ui**、**images**、**media(cleanup)**、**quick-replies**、**avatars**、**themes**、provider 家族（**openai/google/anthropic/azure/volcengine/minimax/nanogpt/openrouter/horde/novelai**）、**tokenizers**、**presets(legacy 写面+restore)**、**secrets(legacy)**、**thumbnail**、**extensions**、**assets**、**files**、**characters(legacy 写面/group/state)**、**chats(legacy save/recent/group/state/backup)**、**panel-shim**、**groups**、**worldinfo(legacy)**、**stats**、**backgrounds**、**sprites**、**content(manager)**、**bootstrap**、**settings(legacy 全量写)**、**sd**、**vector**、**translate/classify/caption/search**、**backends/*(text-completions/kobold/chat-completions 含 jobs/{status,active,events,cancel})**、**speech**、**data-maid**、**backups**、**image-metadata**、**request-inspector**、**card-app/card-runtime**、**docs**、**skills**、**ws-ticket**、**generation(abort+active)**、**storage(health)**、**sync/v1**、**debug/capture**、**/proxy/:url**、**/api/plugins/<id>**（ST 三方插件动态面，D 档已判不兼容）。

## 7. TASK-038 实施单（可直接执行）

1. **动词实现**：`cmdState()` 单函数 + family×op 二级 dispatch（仿 `cmdMvu`/`cmdPlugin`），15 个 op 绑 18 条路由（get 的 GET/POST 变体经 `--via`）。
2. **覆盖集**：`NAMED_UTOPINN_ROUTES` +18 行 → `doctor` 报 `65/65 named`。
3. **裁决 §5.3 五项服务端债**：最少做 `jobs/:id/abort`（一行代理）；`jobs/active`、`recent-chats` 视 D-021 严格度。
4. **验收脚本**：state 族按「get→patch→get 回读→delete→get 空读」链各跑一遍（chat 需 ctx，char 需 `--char`，preset 需 `--api`+名）；冲突路径：patch test-fail 409、char-set 非对象 400、preset rename 撞档 409。
5. **文档同步**：capability.md「v1 明确不做」清单已腐（`th`/`wi` 早实现，`panel` 被 `mvu panel`+`state` 取代）——顺手更新 :358-372/:401-407。
