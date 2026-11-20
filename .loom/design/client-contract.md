# 客户端契约地图:web 前端 ↔ Cordis 后端的协议边界

- Kind: design / analysis
- Status: draft
- 约束:只出设计文档,不改代码。
- 材料:`apps/web/src/api/*.ts`(19 文件 2205 行)逐函数核对 ·
  `apps/server/src/plugins/utopinn-*.js` 全部 `webServer.register` 注册点 ·
  `packages/api-client` / `packages/protocol` · `apps/mobile/src/api` ·
  `packages/kernel/src/webserver.ts` + `apps/server/src/kernel-boot.js` ·
  `.loom/design/plugin-domain-map.md`(路由口径)与
  `.loom/design/frontend-binding-matrix.md`(早期绑定态)交叉对账。

## 0. 总判断

**协议面在服务端已经基本齐了;问题不是"没有契约",是契约被三份手写
客户端各自抄了一份,抄漏的、抄旧的、抄错的已经落成 bug 和假"未备"
徽标。**

当前事实:服务端 11 个 utopinn 插件(`profile.yaml`;import/stats 已按
domain-map §5.1 分别并入 `utopinn-data`/`utopinn-diag`)注册 **84 条 HTTP
路由 + 1 条 WS upgrade + 1 个 UDP 探头**(library 47 · diag 9 · data 6 ·
generate 5 · plugins 5 · mvu 4 · regex 4 · connection 2 · script 1 · th 1);
`_kernel` 自证、`ui/contrib` 贡献清单、`@utopinn/protocol` 类型包都在。消费侧:

| 客户端 | 契约来源 | 状态 |
|---|---|---|
| `apps/web/src/api/*.ts` | 手抄路径/类型/词表,注释引用服务端行号 | 最全,但 19 文件 2205 行各抄各的 |
| `@utopinn/api-client`(CLI+RN 用) | 同一份手抄,按域分包 | 已覆盖大部分域,但缺 obs/regex/connection/contrib |
| `apps/mobile/src/api/*` | 再抄一遍(session/CSRF 自管) | 薄壳,协议逻辑靠 api-client |

三类错位,按严重度排:

1. **前端假设已过期,落在活代码里** —— 不是文档滞后,是行为错:
   - `streamJob`(`api/generate.ts:81-101`)收到 `{type:'ping'}` 帧不回
     `pong`;服务端应用层心跳 70s 无 pong 即 `terminate()`
     (`utopinn-delivery.js:236-247`)——**任何超过 ~70s 的生成流会被
     服务端主动掐断**。api-client 的 `stream.ts:209-210` 是正确实现,
     web 这份是抄漏的。
   - `SettingsPatch`(`api/settings.ts:15-18`)白名单只有
     `power_user`/`extension_settings`;服务端实际已放
     `oai_settings`/`world_info_settings`/`preset_settings_openai`
     (`utopinn-library.js:290-298`)。连接设置、全局栈、默认预设
     选择**现在就能写**,前端类型把它们挡在门外。
   - `renameChat`(`api/chats.ts:285-291`)走 legacy
     `/api/chats/rename`,注释写"utopinn 没有 rename";实际
     `POST …/chats/:chatName/rename` 已在案(`utopinn-library.js:1166`)。
   - `StageFrame.tsx:686` 绕过 `abortJob()` 直接 `apiFetch` legacy
     `/api/generation/:id/abort`;api-client `generate.ts:125-128` 的
     abort 也走 legacy 且注释"Utopinn 没有原生 jobs abort 面"——
     **同一个动词的三个副本,两个是旧的**。
   - `studio.tsx:13` 注释"regex 服务端无 /regex 面(C7)";实际
     `utopinn-regex.js:447/489/555/589` 注册了 `GET|PUT /regex` +
     `PATCH|DELETE /regex/:id` 四条。
   - `SpecViews.tsx:78` home 画廊硬编码
     `/api/utopinn/characters/:charDir/image` —— **这条路由不存在**,
     正确拼法是 `charImageUrl()` 的 `/characters/<file>` 静态面
     (L48 同一文件里另一处就用对了)。
2. **服务端已声明,前端零消费** —— `GET /ui/contrib`(槽位词表 +
   面板归属 + wired)和 `GET /_kernel`(路由/服务清单)自上线起没有
   任何 web 调用点;面板目录、wired 状态、八槽词表仍写死在
   `panels.tsx`/`contributions.ts`(插件管理视图在工作树已迁
   `views/plugins.tsx` 真接 `/plugins`,这是唯一一块刚水合的面)。
3. **包络/错误/词表各抄一份** —— `{items,total}`、`{items}`、裸数组、
   `{ok,data}`、裸文档、`{settings}`、`{secrets}`、header 回 jobId
   八种应答形状并存;`ApiError` 词表三套(web `message+status` /
   api-client `status+body+code` / mobile 再包一层);枚举词表
   (diag kinds/levels、TH 方法、generate verbs、stats range、
   import kinds)前端手写、服务端另有一套,漂移没有报警机制。

**方向一句话:REST+WS 协议是产品边界;`@utopinn/api-client` 收编成
唯一传输+端点实现,`ui/contrib` 扩一格承担"服务端声明"的运行时面,
web 那 19 个文件按域逐个替换成对 api-client 的薄适配。**

---

## 1. 契约清单:`api/*.ts` 函数 → 路由 → 包络

图例:包络列给服务端**实际应答形状**;"手抄/不一致"列标前端藏下的
服务端知识或与现实的偏差。注册点行号见 `plugin-domain-map.md` §1。

### 1.1 传输层(`client.ts:1-76`)

| 件 | 面 | 说明 |
|---|---|---|
| `fetchCsrfToken()`(模块内私有) | `GET /csrf-token` | `{token}` + Set-Cookie session;`apiFetch` 懒初始化 |
| `apiFetch(path, init)` | 全部 | 注入 `x-csrf-token`;403 → 轮换 token 重试**一次**;无 baseUrl(同源假设) |
| `apiGet/apiPost`(仅这两个 JSON 包装;PUT/PATCH/DELETE 各调用点走 `apiFetch`+`assertOk`) | — | `assertOk` 读 `res.text()` 当 message 抛 |
| `ApiError` | — | `{message, status?}`;web 自创码 `upstream_unavailable`(判 502 + `x-utopinn-proxy-error` vite 代理标记) |

注意点:`assertOk` 把 body text 原样当 message —— 服务端 `{error:...}`
JSON 体会变成字符串 JSON 塞进 `e.message`,`CardAppFrame.tsx:101` 只能
`JSON.parse(e.message)` 二次解。错误契约见 §2.2。

### 1.2 角色卡(`characters.ts`)

| 函数 | 路由 | 请求 | 应答包络 | 手抄/不一致 |
|---|---|---|---|---|
| `listCharacters()` :57 | `GET /api/utopinn/characters` | — | `{items:CardItem[],total}` | — |
| `getCharacter(dir)` :62 | `GET /api/utopinn/characters/:charDir` | — | 裸 CCv2/v1 卡文档 | 404 走 ApiError;**同路径 PATCH 写面(C3)已注册但无方法** |
| `charImageUrl(file)` :53 | `GET /characters/<file>` | — | 静态图 | legacy 静态面;`SpecViews.tsx:78` 另一处拼错成不存在的 `/api/utopinn/characters/:dir/image` |
| `cardData(doc)` :46 | — | 本地 | v2 `data.*` 优先、v1 平铺回落 | "与服务端 cardFields() 同一规则" —— 规则抄在注释里 |

### 1.3 会话(`chats.ts:96-325`)

| 函数 | 路由 | 请求 | 应答包络 | 手抄/不一致 |
|---|---|---|---|---|
| `getChat(dir,name)` :123 | `GET …/characters/:dir/chats/:chatName` | — | `{name,fileName?,header,messages,integrity?,updatedAt?,createdAt?}`;**或 `{corrupted:true}`** | corrupted 分支前端不识,`d.messages` undefined → map 崩;`integrity` 字段类型没列 |
| `listAllChats()` :135 | `GET /characters` + N×`GET …/chats` | — | 两次 `{items,total}` | N+1 拼装;`listRecentChats` 已存在但侧栏/home 没用 |
| `listChatsForChar(dir)` :175 | `GET …/characters/:dir/chats` | — | `{items:CharChatItem[],total}` | — |
| `createChat(dir,name)` :184 | `POST …/chats/:chatName/messages` | `{chat_metadata:{},message:{is_system:true,mes:''}}` | `{ok,appended,created,integrity}`(丢弃) | "缺失即建"语义抄注释;**PUT …/chats/:chatName 显式建面注册了无人用** |
| `appendUserMessage` :226 / `appendAssistantMessage` :265 | `POST …/chats/:chatName/messages` | `{message:{…},luker_generation_id?}` | `{ok,appended,created?,integrity?}`(丢弃) | gen-id 去重记账字段名手抄 |
| `patchChat` :198 / `patchSwipe` :222 | `PATCH …/chats/:chatName` | `{ops:JsonPatch[],integrity?,luker_generation_id?,chat_metadata?}` | `ChatPatchResult{ok,applied?,integrity?}` | 路径词表 `/body/<i>/…`、`/header/chat_metadata/<k>` 手写(注册点 library L980 段) |
| `renameChat` :285 | `POST /api/chats/rename`(**legacy**) | `{avatar_url,original_file,renamed_file}`(带 .jsonl/.png 后缀) | `{ok,sanitizedFileName?}` | **stale**:注释"utopinn 没有 rename"——`POST …/chats/:chatName/rename` 已在案;字段名两套(original_file vs newName) |
| `deleteChat` :295 | `DELETE …/chats/:chatName` | — | `204` | — |
| `listRecentChats` :318 | `POST /api/utopinn/chats/recent` | `{pinned:[{file_name,avatar?,group?}],max?}` | **裸数组**(非 `{items}`) | POST 做读;pinned 同字段判定规则抄注释 |
| `stToView/mkAssistantFloor` :96/:246 | — | 本地 | ST wire → FloorMsg | `extra.luker_generation_id`、`extra.aborted`、swipe_info 结构手抄;`MVU_STATUS_PLACEHOLDER` 走 protocol ✓ |
| `GenerateVerb` :52 | — | `'normal'\|'regenerate'\|'swipe'\|'continue'\|'impersonate'\|'quiet'` | — | protocol 有 `GENERATION_MODES`,这份是平行手抄 |

### 1.4 预设/世界书/人设(`presets.ts` / `worlds.ts` / `personas.ts`)

| 函数 | 路由 | 应答包络 | 手抄/不一致 |
|---|---|---|---|
| `listPresets(apiId='openai')` :28 | `GET /presets?apiId=` | `{items,total,apiId}` | **apiId 默认 `'openai'` 写死**;合法集是服务端 `PRESET_FOLDER_BY_API_ID` 键(11 族),前端无词表 |
| `getPreset(name,apiId)` :33 | `GET /presets/:name?apiId=` | `{name,apiId,doc}` | — |
| `savePreset` :41 | `PUT /presets/:name?apiId=` | `{ok,name,apiId}` | body 整档 doc |
| `deletePreset` :52 | `DELETE /presets/:name?apiId=` | 204 | — |
| `listWorlds` :32 | `GET /worlds` | `{items,total}` | — |
| `getWorld` :36 | `GET /worlds/:name` | `{name,doc:{entries:{}}}` | — |
| `saveWorld` :41 / `deleteWorld` :52 | `PUT` / `DELETE /worlds/:name` | `{ok,name}` / 204 | — |
| `listPersonas` :58 | `GET /personas` | `{items,total,defaultPersona}` | — |
| `savePersona` :63 | `PUT /personas/:avatar` | `{ok,doc,isDefault,avatar}` | position 值域(0/2/3/4/9)抄注释 |
| `deletePersona` :74 | `DELETE /personas/:avatar` | `{ok}` 系 | — |

### 1.5 settings / secrets(`settings.ts` / `secrets.ts`)

| 函数 | 路由 | 应答包络 | 手抄/不一致 |
|---|---|---|---|
| `getSettings({raw})` :24 | `GET /settings?raw=1` | `{settings}` | — |
| `patchSettings(patch)` :33 | `PATCH /settings` | `{settings}`(脱敏整档) | **白名单抄旧版**:类型只许 `power_user`/`extension_settings`;服务端已放 `oai_settings`/`world_info_settings`/标量 `preset_settings_openai`(L290-298)。连接/全局栈/默认预设实际可写 |
| `listSecrets` :18 | `GET /secrets` | `{secrets:{key:SecretEntry[]}}` | — |
| `putSecret` :26 | `PUT /secrets/:key` `{value,label?}` | `{ok,id,key,entries}` | `VALID_SECRET_KEYS` 白名单只在服务端,前端无词表 |
| `deleteSecret` :37 | `DELETE /secrets/:key/:id` | — | — |

### 1.6 state sidecar 三族(`state.ts:50-143`,15 方法打 18 条注册)

| 族 | 路由组 | 应答包络 | 手抄/不一致 |
|---|---|---|---|
| chat ×4 | `POST /state/chat/{get,get-batch,patch,delete}` | `{ok,data}` / `{ok,applied?}` / `{ok,deleted}` | target 形 `{avatar_url,file_name}|{is_group,id}` 手抄;`get` 的 GET+POST 双注册只用 POST |
| char ×5 | `POST /state/char/{…,+set}` | 同上 + `{ok,data:{ns:doc}}` | — |
| preset ×6 | `POST /state/preset/{…,+delete-all,rename}` | 同上 + `{ok,renamed}` | — |

JSON-Patch `test` op 的 CAS 语义(409 = `PatchTestFailedError`)由
`sendError` 集中映射(`utopinn-library.js:112-130`),前端只透传。

### 1.7 生成 / job / WS(`generate.ts` / `jobs.ts`)

| 函数 | 路由 | 请求 | 应答 | 手抄/不一致 |
|---|---|---|---|---|
| `postGenerate(body)` :20 | `POST /api/utopinn/generate` | `{stream:true,type,…}` | **200 空 `{}`;jobId 走 `x-luker-generation-id` 响应头**(`runner.js:101-110`;另带 `x-luker-server-persisted` 初始快照头,终态由 SSE trailer 覆写) | jobId 从 header 抠;上游 502+代理头 → `upstream_unavailable` |
| `streamJob(jobId,h)` :74 | `POST /api/ws-ticket` → `{ticket}`;`WS /api/ws-delivery` 子协议 `luker-ws-ticket.<ticket>` | `onopen` 发 `{type:'resume',request_id,from_seq:1}` | 帧 `{type:head|chunk|end|error|ping}`;chunk.data = base64 SSE 字节,解 `data:` 行 `choices[0].delta.content|.text` | **`ping` 帧收到不回 `pong` → 服务端 70s terminate(实锤 bug)**;`from_seq` 恒 1;`location.protocol/host` 拼 WS URL(浏览器绑定) |
| `listJobs()` :49 | `GET /api/utopinn/jobs` | — | `{items:JobSummary[]}`(无 total) | — |
| `getJob(id)` :53 | `GET /api/utopinn/jobs/:id` | — | 裸 JobDetail 对象(非包络) | `promptMessages` 字段类型漏列 |
| `abortJob(id)` :63 | `POST /api/utopinn/jobs/:id/abort` | — | `{aborted:true}`;404 `{error:'not_found'}`;409 `{error:'not_running'}` | 本方法正确;但 `StageFrame.tsx:686` 绕过它直打 legacy;api-client 同样走 legacy + stale 注释 |

WS 契约细节(服务端 `utopinn-delivery.js`):票验在子协议头;
`resume{from_seq}` 回放缓冲区,`subscribe` 不回放;跨 socket 同
request_id 去重挤旧;**应用层心跳必须回 `{type:'pong',ts}`**;
帧码 `forbidden`/`not_found` 走 `{type:'error',code,message}`。

### 1.8 观测(`diag.ts` / `stats.ts`)

| 函数 | 路由 | 应答包络 | 手抄/不一致 |
|---|---|---|---|
| `listEvents(f)` :82 / `listErrors(f)` :87 | `GET /diag/events` `/diag/errors` | `{items,count,seq,size}` | 过滤参 `kind/lvl/since/seq_gt/code/job/limit` |
| `DIAG_KINDS` :14 / `DIAG_LVLS` :21 | — | — | **词表手抄**:kind 11 值、lvl 4 值,与服务端 `KINDS/LVLS` 两份平行维护 |
| `diagStats()` :103 | `GET /diag/stats` | 裸对象 `{size,byKind,byLvl,…}` | — |
| `getJobTrace(id)` :153 | `GET /diag/jobs/:id/trace` | 裸对象 | — |
| `postClientEvent(ev)` :159 | `POST /diag/client` | `{ok:true,seq}` | fire-and-forget;kind/lvl 服务端再校验 |
| `statsSummary/statsInject/statsByChar` | `GET /stats/{summary,inject,by-char/:id}?range&by` | 各自裸 reply 对象 | `StatsRange`/`StatsBy` 词表手抄(stats 路由已并入 `utopinn-diag.js:520+`);**鉴权姿势不一致**:diag/* 路由 admin 闸(L411-430),stats/* 仅按 handle 切数据(L516 注释) |
| — | `GET /_kernel` | `{routes,services}` | **注册在案,web 无方法、无消费方**(api-client `DiagApi.kernel()` 有) |

### 1.9 导入 / 数据(`import.ts`)

| 函数 | 路由 | 应答包络 | 手抄/不一致 |
|---|---|---|---|
| `previewImport` :152 | `POST /import/preview` | `{kind,name,targetName,avatarKey?,summary,warnings,conflicts:{existingSameName}}` | `ImportKind`/`ImportConflictPolicy` 词表手抄;**两路由已并入 `utopinn-data.js:451/515`** |
| `commitImport` :156 | `POST /import/commit` | `{ok,kind,name,targetName,renamed,skipped?,avatarKey?,warnings}`;422 种不符 / 409 `{error,conflicts}` | `ImportApiError.hints` 接住了 hints —— 全栈唯一消费结构化错误字段的地方 |
| `scanStImport` :183 | `POST /import/scan-st` `{dir}` | `{root,total,counts,items}` | `StScanKind` 6 值词表手抄 |
| `previewImportWithFallback` :292 | 同上 | — | 断网 mock 嗅探回落,不是协议面 |
| — | `POST /backup`、`POST /lan/offer`、`POST /lan/import` | zip 二进制 / `{url,expiresAt}` / `{ok}` | **三条 data 路由 web 无方法**(api-client `DataApi` 全有) |

### 1.10 MVU / TH / Script(`mvu.ts` / `th.ts`)

| 函数 | 路由 | 应答包络 | 手抄/不一致 |
|---|---|---|---|
| `getMvuState` :32 | `GET /mvu/state?target` | `MvuStateResponse`(protocol ✓) | target query 拼装手抄 |
| `settleMvu`/`resettleMvu`/`renderMvuPanel` | `POST /mvu/{settle,resettle,panel/render}` | `{ok,…}` / `{ok,html}` | — |
| `runScript` :41 | `POST /script/run` | `{ok,pipe,isAborted,ops,notifications,popups,inputs}` | — |
| `thCall` :53 | `POST /th/call` `{method,args?,target?}` | `{ok:true,result?}` \| `{ok:false,unsupported:true,method}` \| 非 2xx `{ok:false,error}` | **语义失败不走异常通道**——调用方判 `r.ok`;`ThMethod` 11 项词表手抄(与 `PANEL_METHODS_TH_T0`、服务端 handler 表三处平行);非 JSON 回 `malformed_response` |

### 1.11 插件 / 预览(`plugins.ts` / `preview.ts`)

| 函数 | 路由 | 应答包络 | 手抄/不一致 |
|---|---|---|---|
| `listPlugins` :23 | `GET /plugins` | `{items:PluginItem[]}` | status 词表 `active/disabled/failed/degraded/unknown` 隐含手抄;`views/plugins.tsx`(工作树新件)已真接 |
| `enable/disable/reloadPlugin` :33-35 | `POST /plugins/:id/{verb}` | `{ok,id,status}` 或 pm `{error}` | — |
| `postPreview` :7 | `POST /preview` | `{messages,trace,sources}` | — |
| `postPreviewWithFallback` :17 | 同上 | — | 502/断网 → mockPreviewResponse |

### 1.12 服务端有路由、web 零方法的面

| 面 | 路由 | 注册处 | 本可在哪消费 |
|---|---|---|---|
| 卡面写回 | `PATCH /api/utopinn/characters/:charDir`(字段白名单 `PATCHABLE_CHAR_FIELDS`/`EXTENSIONS_KEYS`,L193-202) | library | CharEditorModal —— 现状"只读(C3)"徽标已过时 |
| 会话整文档 | `PUT …/chats/:chatName/document` | library L1379 | 批量改稿/导入回写;web 只有 PATCH 增量 |
| 会话显式建 | `PUT …/chats/:chatName` | library L1142 | createChat 现用 messages 隐式建(可跑,非缺口;但 api-client `chatCreate` 用的就是 PUT —— 两客户端同动词不同路径) |
| 正则脚本面 | `GET|PUT /api/utopinn/regex`,`PATCH|DELETE /regex/:id`(scope: global/char/preset 三层 + 放行表) | utopinn-regex L447/489/555/589 | studio.regex —— **注释自称"服务端无面"** |
| 连接探测 | `POST /connection/test` → `{ok,response,secret}` | utopinn-connection L460 | 设置·api tab(现状无探针) |
| 模型清单 | `GET /models` → `{items,source,stale?,error?,upstreamStatus?}` | 同上 L487 | 预设面板模型下拉(现用 MOCK_MODELS) |
| 内核自证 | `GET /_kernel` → `{routes,services}` | utopinn-diag L400 | doctor/health 对账;api-client `DiagApi.kernel()` 有,web 无 |
| UI 贡献清单 | `GET /ui/contrib` → `{items,slots}` | utopinn-plugins | 面板目录/wired 态/槽位词表 —— §4 核心 |
| 数据杂面 | `POST /backup`(zip)/ `/lan/offer` / `/lan/import` | utopinn-data | 设置·diagnostics 备份钮、迁移;api-client 全有,web 无 |
| diag 上报口外的读面 | `/diag/events` 等已接;无 | — | — |

### 1.13 web 调了但不在 utopinn 面的 legacy/静态路由

| 路由 | web 调用点 | 备注 |
|---|---|---|
| `GET /csrf-token` | client.ts | session+CSRF 引导,所有客户端必需 |
| `POST /api/ws-ticket` | generate.ts:75 | WS 票,协议一部分 |
| `POST /api/chats/rename` | chats.ts:286 | 应迁 `POST …/chats/:chatName/rename` |
| `POST /api/generation/:id/abort` | StageFrame.tsx:686 | 应迁 `abortJob()`(utopinn 孪生) |
| `GET /characters/<file>` | characters.ts:53 | 卡图静态面,合理保留 |
| `POST /api/card-runtime/mounts` 等 | CardAppFrame/bridge | 独立插件面(card-runtime),不在 `/api/utopinn` 前缀 |

---

## 2. 包络与错误面的不一致

### 2.1 应答包络:现存八种形状

| 形状 | 用在 | 评 |
|---|---|---|
| `{items,total}` | characters、chats 列表、presets、worlds、personas(+`defaultPersona`) | 集合面主流,合理 |
| `{items}` | plugins、jobs、models、ui/contrib | 和上面差一个 `total` —— 有无分页语义不一眼可辨 |
| `{items,count,seq,size}` | diag events/errors | 同族集合面第三种形状 |
| **裸数组** | `POST /chats/recent` | 集合面唯一裸回;扩展(加分页/游标)无落点 |
| `{ok,…}` 成功包 | state 三族、mvu、script、plugins ops、import commit、presets/worlds 写 | 写面主流;`{ok,data}`/`{ok,applied}`/`{ok,deleted}` 细分无统一约定 |
| **裸资源文档** | characters/:dir、jobs/:id、diag/stats、diag trace、worlds/:name、presets/:name、settings/secrets(`{settings}`/`{secrets}` 半包) | 读单资源时包络与裸文档混用,客户端只能逐路由记 |
| **header 承载** | `POST /generate` → `x-luker-generation-id`;`/backup` → Content-Disposition | jobId 不进 body 是已定型事实,但每个新客户端都会踩一遍 |
| WS 帧 | `{type:head|chunk|end|error|ping|pong}` | 独立信封体系,正确;只是 web 实现漏了 pong |

建议(声明化方向,不是迁移命令):**新路由一律 `{items,total?}` 集合 /
`{ok,data}` 写面 / `{error:{code,message,details?}}` 错误**三选一;
存量裸数组(`chats/recent`)和裸文档读面不值得为它破协议,留在
协议类型里逐条标注即可。真正要修的是"客户端不知道形状"——见 §4。

### 2.2 错误契约:`ApiError` 词表 vs 服务端实际

| 层 | 现状 | 问题 |
|---|---|---|
| web `ApiError` | `{message,status?}`;`assertOk` 以 body text 当 message | 服务端 `{error:'…'}` JSON 变字符串 JSON 塞 message;调用方二次 `JSON.parse`(CardAppFrame L101) |
| api-client `ApiError` | `{status,body,code?,headers}` | 词表更全,但与 web 不是同一个类 —— 三端 catch 逻辑各写一遍 |
| web 自创码 | `upstream_unavailable`(vite 代理 502 头) | 浏览器-only;RN/CLI 各自再发明 |
| 服务端结构化码 | `not_found`/`not_running`/`forbidden`(jobs·ws)、`storage_read_only`、`malformed_response`(web 兜底)、`unsupported`/`no_card_app`/`card_app_disabled`(card-runtime)、import 422/409 hints | **大部分是自由文本 `error: string`,不是稳定枚举**;`{error:'job not found'}`(文本)与 `{error:'not_found'}`(码)混用 |
| 语义失败 | th/call `{ok:false,…}` 走 200/非 2xx 双通道;state `{ok:false}`;import `{error,conflicts}` | "业务错不走异常"约定只对 th 域成文,其他域各写各的 |

建议:错误契约先**成文不迁移** —— 在 protocol 包加
`UtError = { code?: string; message: string; details?: unknown }` 类型 +
一张**已知码词表**(把上面散落的码收编为 union);服务端新路由
统一 `{error:{code,message}}`,存量 `{error:string}` 由客户端
适配层归一到 `UtError`,不改线协议。

### 2.3 前端手抄的服务端知识(该由什么供给)

| 手抄项 | 前端位置 | 服务端权威源 | 建议供给 |
|---|---|---|---|
| 每条路由路径模板 | `api/*.ts` 全部 | `webServer.register` 调用点;`_kernel.routes`(字串) | api-client 单源;`_kernel` 只对账不生成 |
| DIAG kinds/lvls | `diag.ts:14-21` | `utopinn-diag.js` KINDS/LVLS | manifest 词表段 |
| TH 方法表(11) | `th.ts:33-38` | `utopinn-th.js` handler 表;`PANEL_METHODS_TH_T0`(protocol) | protocol union + manifest 运行时校验 |
| GenerateVerb | `chats.ts:52` | `GENERATION_MODES`(protocol)+ `utopinn-generate.js` | 删手抄,用 protocol |
| Stats range/by | `stats.ts:10-11` | `RANGE_ALIASES`/`VALID_GROUPS` | manifest 词表 |
| Import kind/conflict/scan kind | `import.ts:9/10/165` | `IMPORT_KINDS`/`CONFLICT_POLICIES` | manifest 词表 |
| 预设 apiId 白名单(11 族)+ 默认 `'openai'` | `presets.ts` | `PRESET_FOLDER_BY_API_ID` | manifest 词表 + 默认值声明 |
| secret key 白名单 | — | `VALID_SECRET_KEYS` | manifest 词表(设置页需要) |
| settings PATCH 段白名单 | `settings.ts:15-18`(**已漂移**) | `PATCHABLE_SETTINGS_SECTIONS`/`SCALAR_KEYS`(L290-298) | manifest 词表 —— **本次漂移事故的直接教训** |
| 卡面 PATCH 字段/extensions 白名单 | —(前端还没接) | `PATCHABLE_CHAR_FIELDS`/`EXTENSIONS_KEYS`(L193-202);400 文案 echo allowed | manifest 词表(编辑器灰键提示) |
| 会话 patch 路径词表 `/body/<i>` `/header/chat_metadata/<k>` | chats.ts 注释 | chats 写路径校验 | protocol 文档化(写协议,适合成文不适合 manifest) |
| state target 三种形 / ns | state.ts 类型 | state 三族 handler | protocol 类型(已有) |
| WS 票协议前缀、`from_seq` 语义、帧型 | generate.ts:77-80 | `utopinn-delivery.js`;`TICKET_PROTOCOL_PREFIX`(protocol) | protocol 常量(已有)+ stream 实现单源 |
| `x-luker-generation-id` 头名、`luker_generation_id`/`extra.aborted`/`extra.luker_generation_id` 字段名 | generate.ts、chats.ts:246-275 | luker-generation 机 | protocol 常量 |
| 面板目录 + wired 态 + 八槽词表 | `panels.tsx:10-34`、`contributions.ts:83-92` | `BUILTIN_CONTRIB`/`KNOWN_SLOTS`(`utopinn-plugins.js`) | **`ui/contrib` 已声明,直接接** |
| CardApp 权限词表(`permissions.api`/`sameOrigin`/`stateNamespaces`)+ 桥 channel/nonce/方法授权 | `cardapp/*` | card-runtime mounts manifest;protocol `panels.ts` | 已有 protocol 类型;桥逻辑下沉共享 |
| stage kind 词表(chat/novel/messenger/galgame) | `features/stagepack.tsx`、`types.ts` | **无服务端源** —— 会话 stage 来自卡面 extensions,"声明位未定" | 这是真正的空白:要么卡面 extensions 字段成文,要么 manifest 词表声明"本实例支持哪些舞台" |

---

## 3. 移动端契约:浏览器绑定点 vs 可复用面

### 3.1 web 写死的浏览器假设(协议无关,但要圈出来)

| 假设 | 位置 | RN 对应物 |
|---|---|---|
| `document.hidden` 跳轮询 | `DiagPanel.tsx:60` | AppState 监听 |
| `window.prompt/confirm` | `App.tsx:236/247/261`、`StageFrame.tsx:730/770`、`studio.tsx:748` | 原生 Alert/对话框 |
| `localStorage` | `i18n/index.tsx:16/52`、`theme.ts:17` | AsyncStorage/SecureStore |
| `navigator.clipboard` | DiagPanel L293/460、StageFrame L724 | expo-clipboard |
| `window.innerWidth` 断点 + pointer 拖拽 | `Workbench.tsx:199-261` | 手势/布局系统 |
| iframe+sandbox+`postMessage`+`ev.source===iframe.contentWindow` 源校验 | `CardAppFrame.tsx:40-104`、`cardapp/bridge.ts` | RN WebView;mobile 版 bridge 已改成"nonce 即全部门槛"(`panels/bridge.ts:8-14`)—— **协议语义同构,宿主认证机制按端实现** |
| `location.protocol/host` 拼 WS、`atob/btoa`、同源 cookie jar | `generate.ts:76-77`、`import.ts` b64、client.ts 隐式凭据 | `wsBaseUrl()` 注入、自带 base64、session.ts 手动收 Set-Cookie |
| vite 代理 502 头 → `upstream_unavailable` | client.ts/jobs.ts/th.ts | 无代理概念,按网络错误归类 |

### 3.2 已验证可跨端复用的协议逻辑

- 全部 REST 路由+动词+JSON 类型(`@utopinn/protocol` 已是三端唯一
  事实源);
- jobId 响应头解析、WS 票握手、`resume{from_seq}` 回放、base64→SSE
  delta 解包、`{type:'pong'}` 心跳回执(api-client `stream.ts` 全部
  实现且**正确**,web 那份是抄漏的);
- state 三族 JSON-Patch/CAS、TH 方法派发语义(unsupported 回执)、
  diag 过滤参、import preview/commit 两段、CardApp mount manifest
  形状与 `permissions.api` 展开规则(web/mobile 两份
  `expandApiGrants` 逐行同构 —— 该下沉进 api-client/panel-t0);
- `stToView`/`stripStatusPlaceholder` 视图映射 —— 当前 web chats.ts
  与 mobile client.ts:255 各抄一份,**这是纯 wire→view 纯函数,该进
  protocol 或 formats**。

### 3.3 `@utopinn/api-client` 边界建议

收编为**唯一**传输+端点层:

- 含:endpoint 方法(按现有 9 域类:`LibraryApi/GenerateApi/StateApi/
  MvuApi/PluginsApi/DataApi/ScriptApi/ThApi/DiagApi`)、稳定 `ApiError`
  (收编 §2.2 `UtError`)、WS stream(pong 已实现)、请求体/应答
  protocol 类型、`expandApiGrants` 这类协议级纯函数。
- 注入:`fetch` 实现、`baseUrl`、session/CSRF 策略(web cookie 同源
  vs RN 手动 cookie jar vs CLI token)、`wsFactory`、clock。
- **不含**:React hooks、`document/window/localStorage`、iframe/
  WebView 宿主、visibility 轮询策略、mock 回落 UX(`mock.ts` 留
  web 本地)、`upstream_unavailable` 这类部署环境特判(交给各端
  adapter 把 502/网络错归一成 `UtError.code`)。
- 待补域:`/diag/events|errors|stats|trace`、`/stats/*`、`/regex/*`、
  `/connection/test|/models`、`/chats/recent`、`PATCH /characters/:dir`、
  `/ui/contrib`。补齐后 web `api/*.ts` 19 文件退化成薄 re-export +
  视图适配。

---

## 4. 声明化路线:服务端声明什么,客户端怎么消费

### 4.1 已有声明面盘点(别再造一套发现机制)

| 面 | 现况 | 够不够 |
|---|---|---|
| `GET /api/utopinn/ui/contrib` → `{items:[{plugin,slot,contribution,core?,disabled?}], slots:KNOWN_SLOTS}`(`utopinn-plugins.js:183-213`,**admin 403 门**) | 八槽词表与前端 `contributions.ts:83-92` 1:1;`BUILTIN_CONTRIB`(L69-89)已把 **7 块 wired 面板全数声明**(diag/stats←diag、mvu、ledger/cardapp←th、notes/preset←library),字段与 `panels.tsx` 本地注册逐项同形;另有 `mod.ui.contrib`/`mod.meta.ui.contrib` 模块 manifest 机(mtime 缓存导入读声明,不跑 apply);未知 slot 放行 | **够做面板/槽位运行时清单**;缺词表段与能力段(见下);admin 门意味着非 admin 会话拿不到 —— 单用户本地实例无碍,多端权限分化时要留意 |
| `GET /api/utopinn/_kernel` → `{routes:string[],services}`(`utopinn-diag.js:400`) | `webServer.list()`(`webserver.ts:157-158`)吐 `GET\|pattern\|/api/…`、`upgrade\|/api/ws-delivery` 字串,连插件归属都没有 | **只是路由注册名**,没有请求/响应 schema、错误码、词表 —— 只能对账不能生成客户端 |
| `GET /plugins` | `{items}` 含 status,admin 门(403) | 插件启停态已有;disable 对 `CORE_PLUGINS`(library/generate/delivery/diag/plugins 五件)路由侧 400 拒 |

### 4.2 最小协议:扩 `ui/contrib` 一格,不新建发现系统

服务端在现有 manifest 上加两段(或并列 `protocol` 对象):

```jsonc
{
  "protocol": { "version": 1, "errorShape": "error-string|error-object" },
  "slots": […八槽,已有],
  "items": […贡献条目,已有],
  "vocab": {                       // 客户端渲染/校验要用的枚举
    "diagKinds": [...], "diagLvls": [...],
    "thMethods": [...], "generateVerbs": [...],
    "statsRanges": [...], "statsBys": [...],
    "importKinds": [...], "conflictPolicies": [...],
    "presetApiIds": [...], "defaultApiId": "openai",
    "secretKeys": [...],
    "settingsPatchSections": [...], "settingsPatchScalars": [...],
    "charPatchFields": [...], "charPatchExtensionKeys": [...],
    "stageKinds": ["chat"],       // 本实例注册的/承诺的舞台种类
    "pluginStatuses": ["active","disabled","failed","degraded","unknown"]
  },
  "features": {                    // 能力/接线态(让 UI 别猜)
    "regexManage": true, "connectionProbe": true, "charWrite": true,
    "chatRename": true, "wsHeartbeat": { "pingMs": 30000, "pongTimeoutMs": 70000 }
  }
}
```

原则:

- **声明"能力+词表+归属",不声明可执行 UI**。贡献条目的 Body/
  Component 仍是前端本地 React/RN 组件;manifest 说"这个槽有这
  个面板、它 wired、它归哪个插件",客户端据此刻灰/显示。
- 未知 slot 现在放行 —— 保留(三方插件前向兼容),但**前端
  消费时只渲染已知槽**,未知贡献进 diag 日志,不静默丢。
- `features` 段替代前端各类"未备"硬编码徽标:服务端声明什么,
  UI 亮什么;没有声明 = 诚实 unwired。
- `vocab` 词表是**运行时校验值**(过滤片、下拉、白名单灰键),
  不是编译期常量 —— 服务端是权威,客户端拿旧词表也不至于写坏,
  只是选项可能少。

### 4.3 运行时 vs 构建时分工

| 层 | 消费方式 | 理由 |
|---|---|---|
| 稳定核心 API(characters/chats/presets/… 请求体、应答、错误) | **构建时**:`@utopinn/protocol` TS 类型 + api-client 方法签名 | 形状钉死进类型才有 IDE/编译保障;不为它们上 OpenAPI 生成器 |
| 词表/枚举/白名单 | **运行时 manifest**:渲染前拉一次,带版本号缓存 | 服务端一改 UI 即跟着改;`settings PATCH 白名单漂移`这类事故绝迹 |
| 面板/槽位/插件态/特性开关 | **运行时 manifest**(`ui/contrib` 现有面) | 插件启停是运行时事实,构建时拿不到 |
| WS 协议常量、票协议、帧型、头名 | **构建时** protocol 常量 + api-client `stream.ts` 单实现 | 已经是,别让 web 再抄一份 |
| 路由清单对账 | `_kernel` 留作诊断;CI 可加"api-client 端点名 vs `_kernel.routes` 覆盖率"检查 | 只生成告警,不生成代码 |

**不做 codegen**:现阶段路由 schema 没有权威机器可读源,
`_kernel` 只有注册字串;等 `vocab`/`features` 落地稳定后再考虑
要不要把请求/响应 shape 也声明出来 —— 现在的收益/成本比不支持。

### 4.4 明确不做

- 不建第二套发现机制(不上独立 `/api/utopinn/manifest` 端点,
  就在 `ui/contrib` 上加段;`_kernel` 保持诊断用)。
- 不让服务端声明 React 组件、布局、可执行逻辑 —— manifest 只出
  JSON-safe 元数据,host 组件永远本地。
- 不为了统一包络去破存量线协议(`chats/recent` 裸数组、
  `{settings}` 半包留着;新路由按 §2.1 约定走)。
- 不把 CardApp 桥协议塞进核心 REST 契约 —— mount manifest +
  `permissions.api` 词表是宿主/桥层契约,`PANEL_METHODS_TH_T0`
  与 TH 方法表共用权威源即可。
- 不动 group chat/附件协议 —— 按架构决定保持 cut,`channels`
  面板继续 unwired。

---

## 5. 磨合缺口清单 + 收益/成本排序

### 5.1 两栏对账

| 前端目前靠猜/手抄(该由声明或单源供给) | 服务端已声明但前端没接 |
|---|---|
| `streamJob` 的 pong 义务(心跳是协议一部分,不在任何类型里) | `ui/contrib`:八槽词表、panel.type 贡献(icon/wired/category/badge)、`core`/`disabled` 标记 —— 面板目录/wired 态可直接水合 |
| settings PATCH 白名单(**已漂移**,设置页三块功能被类型挡死) | `_kernel.routes`:route+plugin 注册名 —— doctor/health 对账可用,web 无一调用点 |
| 预设 apiId 11 族 + 默认 openai;secret key 白名单;stats range/by;import kind/conflict/scan kind;diag kind/lvl;TH 方法表;generate verbs | `PATCH /characters/:charDir` 写面 + 字段白名单 —— CharEditorModal 仍挂"只读(C3)" |
| stage kind 词表(`ChatSummary.stage` 来自卡面 extensions,"声明位未定"—— 唯一真空白) | `GET|PUT /regex` + `PATCH|DELETE /regex/:id` 四面 —— studio 注释自称无面 |
| CardApp 权限授权规则(`permissions.api` 展开、空授权=全 T0、ctx face 降级)web/mobile 两份同构手抄,ctxApi 仍是 stub | `POST /connection/test` + `GET /models` —— 连接 tab 无探针、模型下拉用 mock |
| chat PATCH 路径词表、state target 形、patch CAS 语义(成文于注释,无机器面) | `POST …/chats/:chatName/rename` —— web 还在 legacy `/api/chats/rename` |
| 错误码词表(`not_found`/`not_running`/`unsupported`/…散落) | `POST /api/utopinn/jobs/:id/abort` —— StageFrame 与 api-client 双双走 legacy |
| `chats/recent` 已写但 home/侧栏仍 `listAllChats` N+1 全扫 | `GET /plugins` + 启停 —— `views/plugins.tsx` 工作树已接(mock 退役中) |
| 卡图 URL 两种拼法,一处拼错(`SpecViews.tsx:78`) | `POST /backup`、`/lan/offer`、`/lan/import`、`/import/scan-st` —— api-client 全有,web 零方法 |
| `mvu`/`th`/`state`/`script`/`plugins`/`import`/`stats`/`diag-events` 方法写了**但大量无 UI 调用点**(面板未水合) | PUT `…/chats/:chatName`(显式建)+ `…/document`(整文档替换)—— api-client 在用,web 未绑 |

### 5.2 优先级(声明化收益 ÷ 改动成本)

| 序 | 动作 | 收益 | 成本 | 判 |
|---|---|---|---|---|
| P0 | `streamJob` 补 `pong` 回执;web 直接换成 api-client stream | 修真 bug,>70s 生成不再被掐 | 极小 | 不用讨论,直接修 |
| P0 | `SettingsPatch` 类型对齐服务端白名单;abort/rename 迁 utopinn 路由 | 解锁三个"假未备"功能 + 消两份旧实现 | 极小 | 同上 |
| P1 | `ui/contrib` 加 `vocab`+`features` 段;web 面板目录/设置页/studio 水合 wired/词表 | 一次性消掉 §2.3 表格里 2/3 的手抄;"服务端声明→UI 亮灭"闭环 | 中(服务端加段 + 前端拉一次) | **本设计的核心动作** |
| P1 | api-client 补 `/diag/*`、`/stats/*`、`/regex/*`、`/connection/*`、`chats/recent`、`PATCH /characters/:dir` 域 | web 19 文件可整体换血;CLI 同步受益 | 中 | 与上一条并行 |
| P2 | `UtError` 协议类型 + 错误码 union 成文;web ApiError 归一 | 消三端 catch 差异;新码可枚举 | 小 | 类型先行,线协议不动 |
| P2 | `expandApiGrants`、`stToView` 等纯函数下沉 protocol/api-client | 消 web/mobile 双份同构 | 小 | 顺手 |
| P3 | stage kind 服务端声明位(卡面 extensions 字段成文 或 manifest `stageKinds`) | 唯一真空白,但牵涉数据模型决定 | 中-高 | 值得做,排在 vocab 后 |
| 缓 | OpenAPI/codegen 全量 schema;包络统一迁移;`_kernel` 扩成 schema 面 | 现在投入产出比低 | 高 | **不做**(§4.4) |

---

## 6. 一段话

前后端摩擦的根源不是缺协议 —— REST+WS 面、`@utopinn/protocol` 类型、
`ui/contrib`/`_kernel` 声明机都在;是**协议知识被三个手写客户端各自
抄走一份,且抄完就没人对账**:词表抄在常量里、能力假设抄在注释里、
心跳义务抄漏在实现里,服务端每交付一轮,前端就多几处"假未备"和
旧路径。正确方向也已由仓库自己的架构决定写好:协议是产品边界,
CLI/RN/Web 共用 `api-client` 传输与端点单源,服务端把"词表、能力、
归属"经 `ui/contrib` 运行时声明,前端只贡献本地组件并对账消费。
先做 P0 两处小修,再上 manifest 的 `vocab`/`features` 段,这页里
大部分的"不一致"会在一个迭代内自己消失。
