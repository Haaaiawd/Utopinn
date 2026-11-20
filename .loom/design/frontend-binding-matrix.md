# 前端绑定矩阵 —— UI ↔ Cordis 插件域 ↔ 路由 ↔ src/api 方法

> vs-V2: superseded —— 时点审计已兑现,活档=client-contract.md

> 只读调查产物(未改任何代码)。回答一个问题:**设计稿每个 UI 区块,打服务端哪个插件的哪条路由,src/api 里现在有没有方法可调。**
>
> 数据源:
> - 服务端:`apps/server/src/plugins/utopinn-*.js`(10 插件;逐行核对 `webServer.register` 调用点,与 `apps/cli/utopinn-cli.mjs` L1034-1106 `NAMED_UTOPINN_ROUTES` 全量对上)
> - 前端 API:`apps/web/src/api/*.ts`(11 文件)
> - 设计稿:`assets/u_ui_codex_linear_shadcn_ui.html`(1697 行单文件原型)
>
> 状态图例:
> - ✅ **已接** — src/api 有方法直接打该路由
> - 🔶 **走 legacy** — 功能已通,但打的是 legacy `/api/*` 路由;utopinn 孪生路由无方法绑定
> - ❌ **缺方法** — 路由存在,src/api 没有任何方法打它
> - 🟣 **需 mock/无路由** — 设计稿概念在服务端没有对应面(插件化 Stage/市场/本地偏好)
> - ⚪ **纯本地** — 壳层/视图状态,不需要路由

---

## §1 服务端路由总表(67 HTTP + 1 WS upgrade + 1 UDP)

按插件域分组。`register` 调用点行号为实际注册处。

### utopinn-library(45 条,`P='/api/utopinn'` @ L233)— 资源库 + state sidecar 三族

| 方法+路径 | 注册处 | 语义 |
|---|---|---|
| GET `/characters` | L244 | 卡列表(展示元) |
| GET `/characters/:charDir` | L321 | 单卡完整 CCv2 doc |
| GET `/characters/:charDir/chats` | L339 | 卡的会话列表(含 lastMessage/integrity) |
| GET `/characters/:charDir/chats/:chatName` | L369 | 会话全文(header+floors) |
| DELETE `…/chats/:chatName` | L535 | 删会话(204) |
| PUT `…/chats/:chatName` | L832 | **新建**空会话(header 可选;已存在→409) |
| POST `…/chats/:chatName/rename` | L856 | 重命名(newName;占用→409) |
| POST `…/chats/:chatName/messages` | L883 | 追加楼层(缺失即建;gen-id 去重;integrity CAS) |
| PATCH `…/chats/:chatName` | L980 | JSON-Patch 楼体:`/body/<i>/…` + `/header/chat_metadata/<k>`(顶层 /N 拒) |
| PUT `…/chats/:chatName/document` | L1069 | 整文档替换(legacy /save 等价;upsert;MVU resettle) |
| POST `/chats/recent` | L1151 | 最近会话(pinned 置顶 + sort_time desc) |
| GET `/presets?apiId=` | L403 | 预设名列表(apiId 校验,默认 openai) |
| GET `/presets/:name?apiId=` | L418 | 预设全文 doc |
| PUT `/presets/:name?apiId=` | L604 | 整档保存 |
| DELETE `/presets/:name?apiId=` | L620 | 删(连带清 state ns) |
| GET `/worlds` | L436 | 世界书列表 |
| GET `/worlds/:name` | L454 | 单本 {entries:{}} 全文 |
| PUT `/worlds/:name` | L638 | 整档保存(resolveName 归一) |
| DELETE `/worlds/:name` | L657 | 删(204) |
| GET `/personas` | L475 | 人设列表(嵌套合并 personas×descriptions) |
| PUT `/personas/:avatar` | L675 | 新建/更新(缺省字段保持;is_default 设默认) |
| DELETE `/personas/:avatar` | L734 | 删(连带清默认位) |
| GET `/settings?raw=` | L516 | settings 全文(默认脱敏;raw=1 未脱敏) |
| PATCH `/settings` | L559 | 只允许 `power_user`/`extension_settings` 浅合并 |
| GET `/secrets` | L776 | 脱敏 secret 状态 |
| PUT `/secrets/:key` | L789 | 写一条(自动置 active;VALID_SECRET_KEYS 白名单) |
| DELETE `/secrets/:key/:id` | L810 | 按 id 删 |
| GET+POST `/state/chat/get` | L1199/L1244 | chat_state sidecar 读(GET 走 ETag 资源) |
| POST `/state/chat/get-batch` | L1270 | 多 namespace 批量读 |
| POST `/state/chat/patch` | L1305 | chat_state JSON-Patch 写 |
| POST `/state/chat/delete` | L1385 | chat_state 删 ns |
| GET+POST `/state/char/get` | L1426/L1456 | char_state 读(avatar_url+namespace) |
| POST `/state/char/get-batch` | L1476 | 批量读 |
| POST `/state/char/set` | L1511 | char 独有:整态覆写 |
| POST `/state/char/patch` | L1549 | patch 写 |
| POST `/state/char/delete` | L1608 | 删 ns |
| GET+POST `/state/preset/get` | L1642/L1681 | preset_state 读 |
| POST `/state/preset/get-batch` | L1703 | 批量读 |
| POST `/state/preset/patch` | L1737 | patch 写 |
| POST `/state/preset/delete` | L1785 | 删单 ns |
| POST `/state/preset/delete-all` | L1807 | preset 独有:清全部 ns |
| POST `/state/preset/rename` | L1829 | preset 独有:ns 随改名迁移 |

### utopinn-generate(5)— 全组装生成 + job 监视

| 方法+路径 | 注册处 | 语义 |
|---|---|---|
| GET `/jobs` | L232 | job 摘要列表(新→旧) |
| GET `/jobs/:id` | L240 | 详情:状态/落盘文本/trace/sources |
| POST `/jobs/:id/abort` | L272 | 中止(legacy /api/generation/:id/abort 同义) |
| POST `/generate` | L287 | 全组装 → runLukerDispatch;`x-luker-generation-id` 头回 jobId;支持 groupId/member/chatId 群编排(L78-110) |
| POST `/preview` | L536 | 干跑组装 → messages+trace+sources(prompt viewer 数据源) |

### utopinn-mvu(4,`P='/api/utopinn/mvu'` @ L37)

| 方法+路径 | 注册处 | 语义 |
|---|---|---|
| POST `/mvu/settle` | L39 | 对目标楼层(默认末楼)手动重结算 |
| POST `/mvu/resettle` | L58 | 全量重放投影(编辑/删楼/换 swipe 后重建 stat_data) |
| GET `/mvu/state` | L75 | chat_metadata.variables + chat_state 'mvu' 回执日志 |
| POST `/mvu/panel/render` | L92 | 状态栏模板 × 变量字典 → 服务端渲染面板 HTML |

### utopinn-plugins(4)

| 方法+路径 | 注册处 | 语义 |
|---|---|---|
| GET `/plugins` | L24 | 合并态清单(profile×patch×运行时;admin 门) |
| POST `/plugins/:id/enable` `/disable` `/reload` | L46-48 | 启停/热重载(自锁:本插件禁 disable/reload) |

### utopinn-import(2)/ utopinn-script(1)/ utopinn-th(1)/ utopinn-diag(1)

| 方法+路径 | 注册处 | 语义 |
|---|---|---|
| POST `/import/preview` | import L322 | 格式探测+摘要+冲突,不落库 |
| POST `/import/commit` | import L386 | 显式落库(char/world/preset/persona;conflict 必给) |
| POST `/script/run` | script L27 | STscript 服务端 runner;ops/sink 回执随响应 |
| POST `/th/call` | th L255 | TavernHelper 语义桥(getVariables/replaceVariables/insertOrAssignVariables/deleteVariable/getChatMessages/triggerSlash);CardApp postMessage 桥落点 |
| GET `/_kernel` | diag L17 | {routes, services} 自诊断 |

### utopinn-data(4 HTTP + UDP)/ utopinn-delivery(1 upgrade)

| 方法+路径 | 注册处 | 语义 |
|---|---|---|
| POST `/backup` | data L70 | 备份快照(复用 users.js 全量归档机) |
| POST `/import/scan-st` | data L126 | 扫 ST default-user 目录 → 可导入清单 |
| POST `/lan/offer` | data L82 | LAN 迁移 offer {url,expiresAt} |
| POST `/lan/import` | data L102 | loopback 代理到 legacy 流式 import |
| UDP `<httpPort>` | data L13-16 | LAN 发现探头(非 HTTP) |
| WS `/api/ws-delivery` | delivery L137 | upgrade 面:票验(`luker-ws-ticket.*` 子协议)+ subscribe/resume + head/chunk/end 帧 + 30s ping/70s pong 心跳 |

### 非插件面(legacy,前端也在用)

| 路由 | 用处 | 来源 |
|---|---|---|
| GET `/csrf-token` | CSRF 票 + session cookie | client.ts L20 |
| POST `/api/ws-ticket` | WS 一次性票 | generate.ts L75(server-startup.js 挂载) |
| POST `/api/chats/append` `/patch` `/rename` | chats.ts 的 create/patchSwipe/rename | legacy Express router |
| POST `/api/chats/group/{get,append,patch}` | 群聊读写(CLI 在用) | legacy;**无 utopinn 孪生面** |
| GET `/characters/<file>` | 卡图静态资源 | characters.ts L54 |

---

## §2 src/api 现有方法(11 文件)

| 文件 | 导出方法 → 打的路由 |
|---|---|
| `client.ts` | `apiFetch/assertOk/apiGet/apiPost`(CSRF 内置);`/csrf-token` |
| `characters.ts` | `listCharacters`→GET /characters ✅;`getCharacter`→GET /characters/:charDir ✅;`charImageUrl`→/characters/:file 静态;`cardData`(v2/v1 归一) |
| `chats.ts` | `getChat`→GET …/chats/:chatName ✅;`listAllChats`→GET /characters + 每卡 chats(N+1)✅;`listChatsForChar`→GET …/chats ✅;`deleteChat`→DELETE …/chats/:chatName ✅;`createChat`→POST /api/chats/append 🔶;`patchSwipe`→POST /api/chats/patch 🔶;`appendUserMessage`→POST /api/chats/append 🔶;`renameChat`→POST /api/chats/rename 🔶;`stToView`(ST wire→MessageViewModel) |
| `generate.ts` | `postGenerate`→POST /generate ✅;`streamJob`→POST /api/ws-ticket + WS /api/ws-delivery ✅(resume 帧 + base64 chunk → SSE delta 解包) |
| `import.ts` | `previewImport`/`commitImport`→/import/{preview,commit} ✅;`previewImportWithFallback`(离线 mock 嗅探);draft/b64 工具 |
| `jobs.ts` | `listJobs`→GET /jobs ✅;`getJob`→GET /jobs/:id ✅ |
| `personas.ts` | `listPersonas`→GET /personas ✅;`savePersona`→PUT ✅;`deletePersona`→DELETE ✅ |
| `plugins.ts` | `listPlugins`→GET /plugins ✅;`enable/disable/reloadPlugin`→POST /plugins/:id/{verb} ✅ |
| `preview.ts` | `postPreview`→POST /preview ✅;`postPreviewWithFallback`(502/断网 → mockPreviewResponse) |
| `worlds.ts` | `listWorlds`/`getWorld`/`saveWorld`/`deleteWorld`→/worlds 四面 ✅ |
| `mock.ts` | MOCK_CHATS/CARDS/PERSONAS/MESSAGES + `mockPreviewResponse`(纯 mock,无路由) |

---

## §3 设计稿 UI 区块清单(assets/u_ui_codex_linear_shadcn_ui.html)

| 区块 | 行号 | 构成 |
|---|---|---|
| 左托盘 rail | L688-735 | home/chat/studio/plugins 四 tab + cmdk 钮 + logo;底部账户坞(头像+状态点+齿轮→settings) |
| 侧栏树·chat | L781-845 | U馆头 + 新会话钮 + pinned 会话 + 项目(=卡)折叠树→会话(=chat) |
| 侧栏树·studio | L738-759 | 六类:cards/global(全局常驻JSON)/worldbook/presets/persona/regex |
| 侧栏树·plugins | L761-779 | installed/market 导航 + 已激活清单 |
| 上下文栈 popover | L850-876 | 全局 JSON 书开关 + 跳「预设与模型」 |
| 斜杠指令菜单 | L879-896 | /continue /regen /impersonate /mvu sync /attach |
| 舞台·chat | L914-950 | 楼层流:头像+名字+楼层号+think 折叠+正文+复制/回滚+delta 徽标+流式游标 |
| 舞台·novel | L903 | 章节/段落书排,点段→「润色此段」 |
| 舞台·messenger | L905-908 | 频道 pill 条 + 未读角标 + IM 气泡 |
| 舞台·galgame | L909-912 | 全屏背景+场景签+HUD 开关+分支 choices(bridge-op)+台词框 |
| 预设 popover | L953-1033 | composer 上方锚定:模型/预设下拉+采样滑条+提示词开关 |
| composer | L1065-1085 | textarea + /钮 + MVU 值 chip + 模型 chip + 发送 |
| 右工作台壳 | L1235-1256 | tab 条 + 新tab启动页 + 拆出悬浮窗 + 收起 |
| 面板·preset | L1094-1180 | 模型/预设自定义下拉 + temp/topP/ctx/maxReply 滑条 + prompt 块开关 |
| 面板·ledger | L1182-1206 | 卡绑定总簿(灵石/声望/耐久)+ bridge-op 写变量 |
| 面板·mvu | L1207-1209 | 变量快照列表(数值 ± 步进)+ JSON 视图 |
| 面板·lore | L1210 | 生效上下文:全局书 + 世界书命中(priority/tokens) |
| 面板·chapters | L1211 | 章节目录 + 新章 |
| 面板·channels | L1212 | 群聊/私聊列表+未读 |
| 面板·notes | L1213 | 随手笔记 textarea |
| 新tab启动页 | L1216-1233 | PANEL_CATALOG 搜索(7 面板:ledger/preset/mvu/lore/channels/chapters/notes) |
| home 画廊 | L1261-1280 | 「继续你的故事」会话卡格 + 导入角色卡 |
| studio 主区 | L1293-1302 | cards 格 / global 书开关 / worldbook 双栏编辑器 / presets 列表 / persona / regex |
| plugins 主区 | L1304-1310 | 内置插件开关 + 市场插件安装钮 |
| 设置弹窗 | L1318-1342 | 6 tab:api(chat/embed/rerank+endpoint+密钥)/chat(渲染/流式/think/楼层号)/appearance(背景+CSS)/plugins/diagnostics(检查器+日志+备份+清缓存)/account(实例+同步) |
| cmdk | L1347-1356 | 搜会话+面板 |
| 悬浮窗 | L1358-1374 | 工作台 tab 拆出,可拖 |
| 移动 shell | L1376-1489 | 抽屉(侧栏体)+ 底部 sheet(half/full snap)+ mobileHub 资产页 + 全屏设置 |
| 账户 popover | L1312-1316 | 字号/主题/语言/设置入项 |
| 模拟引擎 | L1492-1540 | sendText 定时器假流式;bridgeOp 本地改 MVU 数 |

---

## §4 四方绑定矩阵

### A. 壳层(托盘/侧栏/账户/搜索)

| UI 区块 | 插件域 | 需要的路由 | src/api 方法 | 状态 |
|---|---|---|---|---|
| 左托盘 rail + logo + cmdk 钮 | — | — | — | ⚪ 纯本地 |
| 侧栏树·chat(置顶+卡树+会话) | library | GET /characters;GET …/chats;**POST /chats/recent**(排序+置顶) | `listCharacters` `listChatsForChar` `listAllChats`(N+1 拉全量) | 🔶 列表已接;**置顶/最近序缺方法** |
| 侧栏·新会话钮 | library | PUT …/chats/:chatName(现以 append 隐式建) | `createChat` | 🔶 走 legacy append;utopinn 显式建缺方法 |
| 侧栏树·studio·cards | library | GET /characters(+/:charDir) | `listCharacters` `getCharacter` | ✅ |
| 侧栏树·studio·global(全局常驻 JSON) | library | GET /worlds + PATCH /settings(启用态存 power_user) | `listWorlds`;开关写 → 无 | ❌ 启用开关缺 `patchSettings` |
| 侧栏树·studio·worldbook | library | GET/PUT/DELETE /worlds(/:name) | `listWorlds` `getWorld` `saveWorld` `deleteWorld` | ✅ |
| 侧栏树·studio·presets | library | GET /presets?apiId;GET/PUT/DELETE /presets/:name | — | ❌ **presets.ts 不存在,4 条全缺** |
| 侧栏树·studio·persona | library | GET/PUT/DELETE /personas(/:avatar) | `listPersonas` `savePersona` `deletePersona` | ✅ |
| 侧栏树·studio·regex | — | 无专属面(正则存卡 extensions/全局正则未插件化;char_state ns 可担) | — | 🟣 需 mock;或走 POST /state/char/patch ❌ |
| 侧栏树·plugins(installed) | plugins | GET /plugins;POST …/enable|disable | `listPlugins` `enablePlugin` `disablePlugin` | ✅ |
| 侧栏树·plugins(market) | — | 服务端无市场概念 | — | 🟣 需 mock |
| 账户坞/popover(头像 haa+状态) | library(personas)/— | GET /personas(当前人设);字号/主题/语言本地 | `listPersonas` | ✅ 人设已接;偏好 ⚪ 本地 |
| home 画廊「继续你的故事」 | library | **POST /chats/recent** + GET /characters | — | ❌ recent 缺方法(现只能 listAllChats 全量扫) |
| cmdk(会话+面板搜索) | library | 同侧栏数据面 | `listCharacters` `listAllChats` | ✅(数据面复用) |

### B. 对话主区(舞台×4 + composer + 上下文)

| UI 区块 | 插件域 | 需要的路由 | src/api 方法 | 状态 |
|---|---|---|---|---|
| 舞台·chat 楼层流(读) | library | GET …/chats/:chatName | `getChat`+`stToView` | ✅ |
| 楼层操作·swipe 切换 | library | PATCH …/chats/:chatName(`/body/<i>/swipe_id`) | `patchSwipe` | 🔶 走 legacy /api/chats/patch;utopinn PATCH 缺方法 |
| 楼层操作·回滚/删楼/编辑 | library | PATCH …/chats/:chatName(remove/replace /body/<i>) | — | ❌ 缺通用 `patchChat` |
| 楼层操作·复制 | — | — | — | ⚪ 纯本地 |
| think 折叠/delta 徽标/楼层号 | — | 展示态(think 正则解析在客户端;delta 来自 MVU 回执) | — | 🟣 展示层;delta 数据源 = /mvu/state ❌ |
| 舞台·novel(章节/段落/润色) | generate+library | 润色=POST /generate(type 续写)+ PATCH 写回;章节结构存 chat doc 或 chat_state | `postGenerate` | ❌ 写回缺 `patchChat`;章节存储面待定(state/chat/patch ❌) |
| 舞台·messenger(多频道+未读) | generate+library | 频道=群聊:legacy /api/chats/group/*(无孪生)+ POST /generate{groupId,member} | `postGenerate` | 🔶 群读写在 legacy;**types.ts `PreviewRequestBody` 无 groupId/member/chatId 字段,需扩**;成员点名生成 body.member ✅ 服务端已有 |
| 舞台·galgame(背景/分支/HUD) | generate+library | choices=用户消息→append+generate;背景/立绘=卡内 charx 资产+/characters/:file | `appendUserMessage`🔶+`postGenerate`✅+`charImageUrl`✅ | 🔶 基本可拼;资产面依赖 import 已存 charx |
| composer·发送 | library+generate+delivery | POST …/messages(append)→ POST /generate → WS /ws-delivery | `appendUserMessage`🔶 `postGenerate`✅ `streamJob`✅ | ✅ 链路通;utopinn append 缺方法(🔶) |
| composer·/continue /regen /impersonate | generate | POST /generate `type`=continue/regenerate/impersonate | `postGenerate`(body.type ✅) | ✅ |
| composer·/mvu sync | mvu | POST /mvu/settle | — | ❌ |
| composer·/attach | — | 无附件面 | — | 🟣 |
| composer·MVU chip(实时变量显示) | mvu | GET /mvu/state | — | ❌ |
| composer·模型 chip/预设 popover | library | GET /presets;GET /presets/:name(调参写 PUT);模型清单无路由(在 settings/secret+legacy backends) | — | ❌ presets 全缺;模型列表 🟣 |
| 头部·上下文栈 popover(全局书开关) | library | GET /worlds + PATCH /settings(power_user 挂载位) | `listWorlds` | ❌ 写开关缺 `patchSettings` |
| 流式游标/断线续传 | delivery | WS /api/ws-delivery resume{from_seq} | `streamJob` | ✅ |

### C. 右工作台(7 面板 + 壳)

| UI 区块 | 插件域 | 需要的路由 | src/api 方法 | 状态 |
|---|---|---|---|---|
| 工作台壳(tab/新tab/拆出/悬浮窗/收起) | — | — | — | ⚪ 纯本地 |
| 面板·preset(模型/预设/采样/提示词开关) | library | GET+PUT /presets/:name;GET /presets;模型面🟣 | — | ❌ **整块缺 presets.ts** |
| 面板·ledger(卡绑定面板,bridge-op 写变量) | mvu+th+library | 变量读:GET /mvu/state 或 POST /state/chat/get;写:POST /th/call(replaceVariables/insertOrAssignVariables)或 /state/chat/patch;卡 HTML 面板:POST /mvu/panel/render | — | ❌ **CardApp 桥整块缺:thCall/runScript/state 系全缺** |
| 面板·mvu(快照+±步进+JSON) | mvu+library | GET /mvu/state;手改 → /th/call 或 /state/chat/patch;resettle → POST /mvu/resettle | — | ❌ mvu 4 条全缺 |
| 面板·lore(生效上下文) | library+generate | GET /worlds;命中轨迹 = /preview sources 或 job trace | `listWorlds` `postPreview` `getJob` | ✅ 读可拼;全局开关写 ❌(同上) |
| 面板·chapters | — | 无专属面(章节=卡侧数据;候选 chat_state ns) | — | 🟣/❌ |
| 面板·channels | library(群) | 群聊 doc 读:legacy /api/chats/group/get;成员=卡 | — | 🔶 group 面在 legacy;无 utopinn 孪生 |
| 面板·notes | library | POST /state/chat/get + /state/chat/patch(ns=notes) | — | ❌ state 系缺 |
| 新tab启动页 | — | PANEL_CATALOG 本地 | — | ⚪ |

### D. 管理页(studio/plugins/import/设置/cmdk/移动)

| UI 区块 | 插件域 | 需要的路由 | src/api 方法 | 状态 |
|---|---|---|---|---|
| studio·cards 格 + 导入钮 | library+import | GET /characters;/import/preview+commit | `listCharacters` `previewImport(WithFallback)` `commitImport` | ✅ |
| studio·global | library | GET /worlds + PATCH /settings | `listWorlds` | ❌ 开关写缺 |
| studio·worldbook 双栏 | library | GET/PUT /worlds/:name | `getWorld` `saveWorld` | ✅ |
| studio·presets 列表 | library | GET /presets | — | ❌ |
| studio·persona | library | personas 三面 | `listPersonas` `savePersona` `deletePersona` | ✅ |
| studio·regex | — | 无 | — | 🟣 |
| plugins 主区+设置·plugins tab | plugins | GET /plugins + enable/disable/reload | plugins.ts 全面 | ✅;市场 🟣 |
| 设置·api(端点 URL+密钥状态) | library | GET /settings + PATCH;GET/PUT/DELETE /secrets(:key/:id) | — | ❌ settings+secrets 全缺 |
| 设置·chat/appearance | — | stSettings=本地 UI 偏好 | — | ⚪ |
| 设置·diagnostics·请求检查器 | generate | POST /preview + GET /jobs(/:id) | `postPreview` `listJobs` `getJob` | ✅ |
| 设置·diagnostics·服务端日志 | diag(+delivery) | GET /_kernel(routes+services) | — | ❌ |
| 设置·diagnostics·全量备份 | data | POST /backup | — | ❌ |
| 设置·diagnostics·清缓存 | — | — | — | ⚪ |
| 设置·account(实例/同步) | data(+diag) | 实例切换本地;LAN 同步 = /lan/offer+/lan/import | — | ❌ LAN 缺;切换 ⚪ |
| 导入中心( ImportView 已有) | import+data | /import/preview+commit;**POST /import/scan-st**(ST 目录扫描) | `previewImport` `commitImport` | ✅ 两段已接;scan-st ❌ |
| job 中止(诊断/长任务) | generate | POST /jobs/:id/abort | `abortJob` | ✅ utopinn 孪生已注册(同 legacy 守卫) |
| 移动 shell(抽屉/底sheet/hub) | — | 数据面同桌面 | — | ⚪ |
| 悬浮窗 | — | — | — | ⚪ |

---

## §5a src/api 缺口清单 —— 没有任何前端方法的路由(45/67)

| 插件域 | 缺方法路由 | 量级 |
|---|---|---|
| library·chat 写面 | PUT …/chats/:chatName(显式建)· POST …/rename(孪生)· POST …/messages(utopinn append)· PATCH …/chats/:chatName · PUT …/document · POST /chats/recent | 6 |
| library·presets | GET/GET:/name/PUT/DELETE | 4 |
| library·settings | GET + PATCH | 2 |
| library·secrets | GET + PUT + DELETE | 3 |
| library·state 三族 | chat 5(get/get-batch/patch/delete + GET)get 4 算 5;char 6(+set);preset 7(+delete-all/rename) | 18 |
| generate | POST /jobs/:id/abort | 1 |
| mvu | settle/resettle/state/panel/render | 4 |
| script | /script/run | 1 |
| th | /th/call | 1 |
| data | /backup · /import/scan-st · /lan/offer · /lan/import(UDP 发现不可经 fetch,不计) | 4 |
| diag | /_kernel | 1 |
| **合计** | | **41 路由缺**(+4 条孪生已通 legacy:chat create/rename/append/patch 记 🔶) |

> 说明:chat 的 PUT create / POST rename / POST messages / PATCH 虽有 utopinn 路由,但 chats.ts 走 legacy —— 记 🔶 不计入「完全没方法」;上表 6 条里按「方法不存在」口径它们仍算缺(方法是打 legacy 的)。

**最大缺口 TOP3:**

1. **state sidecar 三族 + th/call + script/run(20 条)** —— 右工作台一半面板(ledger/mvu/notes/regex)与整个 CardApp 桥的数据通道。设计稿把「卡绑定面板读变量、bridge-op 写变量」做成核心交互,而这正是 chat_state/char_state/MVU/TH 语义面 —— 前端目前 0 方法。
2. **presets + settings + secrets(9 条)** —— 「预设与模型」是工作台默认首 tab + composer popover + studio 一类 + 设置·api 页,四处入口共享同一缺口;模型清单连路由都没有(🟣,需 settings 面或新面)。
3. **mvu 域 4 条 + chats/recent + jobs abort(6 条)** —— composer MVU chip、/mvu sync、mvu 面板、home「继续」排序、job 中止,全是高频小面,补起来便宜但一个都没有。

## §5b 建议新增 api 文件/方法签名草案(只签名,不实现)

```ts
// ── api/presets.ts ── 新文件(library·presets 4 条)
export interface PresetListItem { name: string }
export async function listPresets(apiId?: string): Promise<{ items: PresetListItem[]; total: number; apiId: string }>
export async function getPreset(name: string, apiId?: string): Promise<{ name: string; apiId: string; doc: Record<string, unknown> }>
export async function savePreset(name: string, doc: Record<string, unknown>, apiId?: string): Promise<{ ok: boolean; name: string; apiId: string }>
export async function deletePreset(name: string, apiId?: string): Promise<void>

// ── api/settings.ts ── 新文件(library·settings 2 条)
export async function getSettings(opts?: { raw?: boolean }): Promise<{ settings: Record<string, unknown> }>
/** 只许 {power_user?, extension_settings?} 两段浅合并。 */
export async function patchSettings(patch: { power_user?: Record<string, unknown>; extension_settings?: Record<string, unknown> }): Promise<{ settings: Record<string, unknown> }>

// ── api/secrets.ts ── 新文件(library·secrets 3 条)
export interface SecretEntry { id: string; label: string; active: boolean; masked?: string }
export async function listSecrets(): Promise<{ secrets: Record<string, SecretEntry[]> }>
export async function putSecret(key: string, value: string, label?: string): Promise<{ ok: boolean; id: string; key: string; entries: SecretEntry[] | null }>
export async function deleteSecret(key: string, id: string): Promise<void>

// ── api/mvu.ts ── 新文件(utopinn-mvu 4 条)
export type MvuTarget = { charDir: string; chatName: string } | { isGroup: true; id: string }
export interface MvuStateView { ok: boolean; chatVariables: Record<string, unknown>; receiptLog?: unknown[]; status?: string }
export async function getMvuState(target: MvuTarget): Promise<MvuStateView>
export async function settleMvu(target: MvuTarget, opts?: { message_index?: number; update_chat_variables?: boolean }): Promise<{ ok: boolean }>
export async function resettleMvu(target: MvuTarget, opts?: { update_chat_variables?: boolean }): Promise<{ ok: boolean }>
export async function renderMvuPanel(template: string, opts?: { scope?: Record<string, unknown>; target?: MvuTarget; fallback?: string; escape_html?: boolean }): Promise<{ ok: boolean; html: string }>

// ── api/state.ts ── 新文件(library·state 三族 18 条;chat/char/preset 三 target 形)
export type ChatStateTarget = { avatar_url: string; file_name: string; char_name?: string } | { is_group: true; id: string }
export interface JsonPatchOp { op: 'add' | 'replace' | 'remove' | 'test'; path: string; value?: unknown }
export async function getChatState(target: ChatStateTarget, namespace: string): Promise<{ ok: boolean; data: unknown }>
export async function getChatStateBatch(target: ChatStateTarget, namespaces: string[]): Promise<{ ok: boolean; data: Record<string, unknown> }>
export async function patchChatState(target: ChatStateTarget, namespace: string, ops: JsonPatchOp[]): Promise<{ ok: boolean }>
export async function deleteChatState(target: ChatStateTarget, namespace: string): Promise<{ ok: boolean }>
export async function getCharState(avatar_url: string, namespace: string): Promise<{ ok: boolean; data: unknown }>
export async function getCharStateBatch(avatar_url: string, namespaces: string[]): Promise<{ ok: boolean; data: Record<string, unknown> }>
export async function setCharState(avatar_url: string, namespace: string, value: unknown): Promise<{ ok: boolean }>
export async function patchCharState(avatar_url: string, namespace: string, ops: JsonPatchOp[]): Promise<{ ok: boolean }>
export async function deleteCharState(avatar_url: string, namespace: string): Promise<{ ok: boolean }>
export async function getPresetState(apiId: string, preset: string, namespace: string): Promise<{ ok: boolean; data: unknown }>
export async function getPresetStateBatch(apiId: string, preset: string, namespaces: string[]): Promise<{ ok: boolean; data: Record<string, unknown> }>
export async function patchPresetState(apiId: string, preset: string, namespace: string, ops: JsonPatchOp[]): Promise<{ ok: boolean }>
export async function deletePresetState(apiId: string, preset: string, namespace: string): Promise<{ ok: boolean }>
export async function deleteAllPresetState(apiId: string, preset: string): Promise<{ ok: boolean }>
export async function renamePresetState(apiId: string, from: string, to: string): Promise<{ ok: boolean }>

// ── api/bridge.ts ── 新文件(script+th;CardApp/面板桥)
export interface ScriptRunResult { ok: boolean; pipe: unknown; isAborted: boolean; ops: unknown[]; notifications: unknown[]; popups: unknown[]; inputs: unknown[] }
export async function runScript(script: string, ctx?: { charDir?: string; chatName?: string }): Promise<ScriptRunResult>
export type ThMethod = 'getVariables' | 'replaceVariables' | 'insertOrAssignVariables' | 'deleteVariable' | 'getChatMessages' | 'triggerSlash' | string
export async function thCall(method: ThMethod, args?: Record<string, unknown>, target?: { charDir?: string; chatName?: string }): Promise<{ ok: boolean; result?: unknown; unsupported?: boolean }>

// ── api/data.ts ── 新文件(utopinn-data 4 条;LAN/备份管理面)
export async function createBackup(selection?: Record<string, unknown>): Promise<unknown>
export interface StScanItem { kind: 'character' | 'world' | 'quickReply' | 'preset' | 'persona' | 'theme'; name: string; file: string; bytes: number }
export async function scanStDir(dir: string): Promise<{ items: StScanItem[] }>
export async function lanOffer(handle: string, selection?: Record<string, unknown>): Promise<{ url: string; expiresAt: number }>
export async function lanImport(handle: string, url: string, selection?: Record<string, unknown>, mode?: string): Promise<unknown>

// ── api/diag.ts ── 新文件(utopinn-diag 1 条)
export async function getKernelInfo(): Promise<{ routes: string[]; services: unknown[] }>

// ── chats.ts 增补(不换签名,新增方法;存量 legacy 调用逐步切) ──
export async function createChatUtopinn(charDir: string, chatName: string, header?: Record<string, unknown>): Promise<{ ok: boolean; name: string; fileName: string; integrity: string }>
export async function renameChatUtopinn(charDir: string, chatName: string, newName: string): Promise<{ ok: boolean; name: string; fileName: string }>
export interface AppendResult { ok: boolean; appended: number; created: boolean; skipped: number; integrity: string }
export async function appendMessages(charDir: string, chatName: string, body: { messages: StChatMessage[]; integrity?: string; force?: boolean; chat_metadata?: Record<string, unknown>; luker_generation_id?: string }): Promise<AppendResult>
export async function patchChat(charDir: string, chatName: string, ops: JsonPatchOp[], opts?: { integrity?: string; chat_metadata?: Record<string, unknown>; luker_generation_id?: string }): Promise<{ ok: boolean; applied: number; total_messages: number; integrity: string }>
export async function saveChatDocument(charDir: string, chatName: string, body: { header?: Record<string, unknown>; messages: StChatMessage[]; integrity?: string; force?: boolean; luker_generation_id?: string }): Promise<{ ok: boolean; integrity: string }>
export interface RecentChatItem { file_name: string; avatar?: string; group?: string; sort_time?: number; [k: string]: unknown }
export async function listRecentChats(opts?: { pinned?: RecentChatItem[]; max?: number }): Promise<RecentChatItem[]>

// ── jobs.ts 增补 ──
export async function abortJob(id: string): Promise<{ ok: boolean }>

// ── generate.ts/types.ts 增补 ──
// PreviewRequestBody → 共用 GenerateRequestBody 扩字段(群编排):
//   groupId?: string; chatId?: string; member?: string; automatic_trigger?: boolean
```

---

## 附:矩阵速读结论

- **已接通面**(22/67):卡/会话读、会话删、世界书四面、人设三面、插件管理四面、jobs 读、generate、preview、import 两段 —— 对应设计的「读多写少」区(侧栏、studio、plugins、诊断)。
- **走 legacy 面**(4 类 🔶):chat create/append/patch/rename 全在 `/api/chats/*` —— utopinn 孪生路由已存在,前端切换只是改 URL+body 形状(PATCH 用 `/body/<i>` 命名空间而非顶层 `/<i>`),建议随重做顺手切,消掉双轨。
- **群聊是特殊形态**:messenger 舞台的群读写只在 legacy `/api/chats/group/*`(无插件孪生),但 generate 已支持 `groupId/member` 群编排 —— 矩阵里记「🔶 + types 扩字段」。
- **服务端没有的概念**(🟣):插件市场、模型清单(在 settings/legacy backends)、正则脚本专属面、/attach 附件、本地 UI 偏好 —— 设计稿这些区块只能 mock 或另开服务端面。
