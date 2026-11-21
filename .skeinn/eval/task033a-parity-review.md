# TASK-033a — Top-10 重路由浏览器侧静态对等性审计

**范围**:`9caa2eb`(浏览器 Top-10 调用点 `/api/uberge/*` → `/api/utopinn/*` 重路由),叠加 `0e8f122`(全局 `uberge` → `utopinn` 改名)后的工作树状态。
**方法**:逐路由对照 `apps/server/src/plugins/utopinn-library.js` 实际契约 vs `apps/server/src/endpoints/{chats,characters,presets,settings}.js` legacy 语义,并追踪 `apps/server/public/**` 全部调用点/适配器。
**限制**:explore 子代理无 shell/写权限,无法执行 `git show 9caa2eb` 与浏览器测试,全部结论为静态证据(父代理复核后修复)。

---

## Blocker

### B1 — `GET /api/utopinn/settings` 返回**脱敏**文档 → 凭据/自定义头在下一次全量保存时被永久清除

**证据(新)**:
- `utopinn-library.js:199` — `SECRET_FIELD_RE = /(^|_)(api_?keys?|secrets?|passwords?|passwds?|credentials?|access_?keys?|private_?keys?|service_?accounts?|auth_?tokens?|session_?tokens?|bearer|headers?)($|_)/i`
- `utopinn-library.js:206-219` — `sanitizeSettingsDoc` 递归剥除命中叶键(含数组元素内)。
- `utopinn-library.js:494` — `response.send({ settings: sanitizeSettingsDoc(doc) })`。
- `settings-resource-read.js:91-106` — `loadUtopinnSettingsEnvelope` 直接取 `payload.settings` 拼进 `settings: JSON.stringify(settingsDocument)`。
- `script.js:16018,16025` — `settings = JSON.parse(data.settings)` → 内存中这些字段**不存在**(不是 `undefined` 占位,是键被删)。

**legacy**:`POST /api/settings/get`(`settings.js` `buildSettingsResponse`)返回**未脱敏**完整 settings 文档,浏览器一直是完整文档消费者。

**实际受害字段(已核实存在于真实 doc)**:
| 字段 | 证据 | 后果 |
|---|---|---|
| `oai_settings.proxy_password` | `openai.js:1061`(默认 `''`),读取于 `openai.js:3837`(`generate_data.proxy_password`)、`7108` | 反代鉴权立即失效;下一次 `/api/settings/save`(`script.js:16385`,keep-legacy 全量写)把 `''`/缺键写回 → **密码永久清除** |
| `oai_settings.custom_include_headers` | `openai.js:1045`,注入 `generate_data.custom_include_headers`(`3941`,textgen `7137`) | 自定义代理头静默丢失 + 同上清除 |
| `settings.proxies[].password` | `openai.js:1106-1111`(`{name,url,password}`)、`9641`(`settings.proxies` 读入) | 所有已存代理预设丢密码;`selected_proxy` 匹配(`9492` 按 url+password)失效 |
| 任意 `extension_settings.*`/`power_user.*` 中含 `api_key`/`secret`/`token`/`bearer`/`credentials`/`access_key`/`private_key`/`service_account`/`passwd`/`header(s)` 段的叶键 | regex 覆盖 | 第三方扩展存的密钥类字段同被剥除并清除 |

**判定**:脱敏是为薄客户端设计的读视图,但旧前端把该视图当作**完整文档**消费并回写——形成 read→sanitized→full-save 的数据删除回路。这是唯一会造成持久数据丢失的发现。

**修复(父代理实施)**:`GET /api/utopinn/settings` 增加 `?raw=1` 返回未脱敏文档;浏览器适配器 `loadUtopinnSettingsEnvelope` 改带 `raw=1`(浏览器与 legacy settings get 同信任级,是管理端不是薄客户端)。

---

## Major

### M1 — `dedicated_personas` 适配产出**错误 schema** → 专属人设对全部 shallow 角色静默失效

**新**:`script.js:3185-3188`
```js
.map(entry => ({ personaName: String(entry.persona_name || entry.personaName || ''), lockName: String(entry.lock_name || entry.lockName || '') }))
```
产出 `{personaName, lockName}`。

**legacy**:`characters.js:436-451` — `toShallow()` 归一化为 `{avatar, name, description, position, depth, role, lorebook, title}` 且 `filter(entry.avatar && entry.name)`。

**消费方**:`personas.js:327-339, 351-358, 419-463, 800-815` 读 `entry.avatar/name/description/position/depth/role/lorebook/title`——adapter 产的键一个都不存在 → dedicated-persona 绑定/描述/深度注入对 shallow 角色全部形同虚设。

### M2 — 角色列表 `date_last_chat`/`date_added` 恒 0,`create_date` 无 ctime 兜底 → "Recent" 排序退化

**新**:`script.js:3196-3199` — `date_added: 0`,`create_date: card?.create_date`(可 `undefined`),`date_last_chat: 0`,`chat_size: 0`。
**legacy**:`characters.js:502-513` — `date_added = charStat.ctimeMs`、`date_last_chat = max(chat updatedAt)`、`create_date` 缺省回退 ctimeMs ISO;`chat_size` 本就是 `+= 0` 占位(`415`)→ 该项**对齐**。
**后果**:`power-user.js:3126-3148` 通用 `first[sort_field]` 比较 + `index.html:6698-6705` 排序项——
- `date_last_chat`("Recent")全 0 → 排序退化为列表序(仅当前会话角色在本地被 `script.js:15011-15013` 写入真值时部分"碰巧正确");
- `create_date` 为 `undefined` 的卡按 epoch 聚堆("Newest/Oldest");
- "Most/Least chats" 在 legacy 就因 `chat_size=0` 无效——非回归,列入已核对。

### M3 — utopinn DELETE chat 缺 state-sidecar 清理 + recent-index 删除

**新**:`utopinn-library.js:506-516` — 仅 `repo.exists` → `repo.delete` → 204。
**legacy**:`chats.js:3161-3164` — `repo.delete` + `deleteAllChatStateSidecars(chatFilePath)` + `deleteRecentChatIndexEntry`。
**后果**:① `<chat>.state.*.json` 残档滞留(CardApp/chat_state 泄漏);② recent-chat 索引保留死条目 → 欢迎页最近会话展示已删会话,点开 404 → `{new_chat:true}` 新建空会话覆盖脏状态。
注:404 vs legacy 400 的差异无害——调用方 `script.js:3560` 只查 `response.ok`。

### M4 — utopinn rename 缺 recent-index 删除/刷新

**新**:`utopinn-library.js:824-834` — 仅 `repo.rename` → `{ok,name,fileName}`。
**legacy**:`chats.js:3124-3128` — `deleteRecentChatIndexEntry(old)` + `refreshRecentChatIndexEntry(new)`。
**后果**:最近会话索引保留旧路径死条目;新名条目不刷新(仅当下次写盘时 `refreshRecentChatIndexEntry` 才补)。
注:冲突/缺失时 utopinn `sendError` 给 409/404 vs legacy 400——调用方 `script.js:19688` 只看 `ok`,兼容。

### M5 — 角色 append 请求缺 `chat_metadata` → append 撞"缺失即建"时 metadata 全丢

**新**:`script.js:14444-14448` — body 仅 `{messages, integrity, luker_generation_id}`;对照同函数 group 分支 `script.js:14382` 明确发送 `chat_metadata: { ...metadata }`。
**服务端**(两端都接受该字段):`utopinn-library.js:881` — `createChatHeader(body.chat_metadata … ?? {})`;legacy append create 分支同样合并 `chat_metadata`(且 append 对**已存在**会话不改 header——两侧一致)。
**后果**:BE 会话文件缺失而 FE 发起 append 时(他端删除/首写竞态),utopinn `!existing` 分支(`880-890`)以 `createChatHeader({})` 建会话——`user_name`/`character_name`/`world_info` 绑定/`tainted`/note 锚点等全部丢失或错值,FE 侧 metadata 快照与存储 header 静默漂移,直到下一次全量 save 才回补。
**置信度**:无法 `git show` 比对旧请求体;但 group 兄弟分支保留了 `chat_metadata`,且两端点均显式接受该字段 → 高度疑似遗漏而非有意省略。

### M6 — 损坏/空 JSONL 会话:legacy 逐行容错恢复 + `{corrupted:true}`,utopinn 整文件 500 → 专用分支死代码 + 无部分恢复

**新**:`fs-engine-transaction.js:230-235` — 空文件 `throw 'Unreadable chat document'`;任一行 `parseChatJson` 抛 → `repo.get` 传播 → `sendError` 500。
**legacy**:`chats.js` chat-get 逐行 `tryParse`,坏行跳过,返回 `{corrupted:true}`(头部行 + 可解析楼层仍可视)。
**调用方**:`script.js:15363-15372` — `!ok` → `throw` → 通用 "Chat could not be loaded" toast;`data?.corrupted` 分支(`15368`)对 utopinn 响应**永不成立**(data 只会是数组或 `{new_chat:true}`)→ 死代码。
**影响**:不再有部分楼层恢复;错误提示从"corrupted"专用文案退化为通用失败;幸而 `throw` 发生在 `chat.splice` 之前,不会覆盖坏文件(防数据丢失层面是安全的)。

---

## Minor

| # | 发现 | 证据 |
|---|---|---|
| N1 | append 注释称 utopinn 返回 `accepted`/`dedupedGenIds`,实际路由返回 `appended`/`matched_existing_generation_id`;`payload?.accepted ?? payload?.appended`(`script.js:14453`)容差正确,仅注释陈旧 | `script.js:14436-14438` vs `utopinn-library.js:889,909,927` |
| N2 | `data.extensions.fav` 被 `Boolean()` 强转,legacy 透传原值(可能 `'true'` 字符串);消费方 `getCharacterExtensions().fav` 容忍两种 → 行为等价,记录在案 | `script.js:3209` vs `characters.js:472` |
| N3 | rename/patch-语义 409/404 经 `sendError` 发 `{error: <message>}`,legacy 发 `{error:true}`/`{error:code}`——状态码与 payload 形状均不同,但所有调用方只查 `ok` → 兼容 | `utopinn-library.js:102-119` vs `chats.js:3104,3110,3120` |
| N4 | `PatchTestFailedError`/`PatchMissingParentError` → 409 `{error:message}` **无** `current_integrity` → `resolveChatWriteConflictForTarget`(`script.js:14193+`)走"空 current → force-overwrite"恢复——恰为期望路径,但 payload 与 `{error:'integrity', current_integrity}` 约定不一致 | `utopinn-library.js:109-113` |
| N5 | chat list `file_size` 用 `humanFileSize` vs legacy `formatBytes`——显示格式可能微差,纯展示 | `script.js:3119` vs `characters.js:2747` |
| N6 | `getCharacters` N+1 扇出(列表 + 每卡 GET)——性能回归而非功能回归,大卡库首屏请求数翻倍 | `script.js:2958-2981` |
| N7 | metadata 键**删除语义**变化:legacy `/meta/patch` merge 永不删键;utopinn `/header/chat_metadata/*` diff-ops 会发 `remove` ——更正确但是行为变化 | `script.js:3166-3171, 14864+` |
| N8 | `/api/chats/search` 保留 legacy(`script.js:17043`,`displayChats` 同时服务 character+group)——utopinn 无等价面,命中同一 chat repo → 数据一致,属正当保留;但 character 域表面因此混合,记录 | — |

## 已核对(无问题清单)

- **chat GET**:`{header,messages,integrity}` → `[header,...messages]` + `doc.integrity` 注入 `header.chat_metadata.integrity`;404 → `{new_chat:true}`(与 legacy 等价)。`script.js:3069-3099`
- **chat list 适配**:全字段 `file_id/file_name/file_size/chat_items/mes/last_mes/sort_time/chat_metadata/integrity/match:true` 与 legacy `characters.js:2744-2756` 逐项对齐。`script.js:3107-3127`
- **PATCH rebase**:消息 ops `/N/…` → `/body/N/…`(`3153-3158`);vendored diff 仅产 add/remove/replace + `test` 守卫,无 move/copy → 无需 `from` 重定向;`/header` 命名空间被服务端放行、`/N` 顶层路径被正确拒绝(`utopinn-library.js:959-966`)。metadata diff → `/header/chat_metadata/*`(`3166-3171`)。
- **document PUT**:兼容 legacy `{chat:[header,…floors]}`(`looksLikeHeader` 判定,`1029-1037`);CAS 取 `body.integrity ?? header.chat_metadata.integrity`(`1053-1056`);`force` 跳过(`1051`);缺文件 + 带 expected → 降级 null 重试(`1062-1063`,覆盖"新会话带本地 minted integrity"场景)。
- **append**:CAS(`874-876`)、队首内容等值去重 + gen-id sidecar 去重(`892-905`)、`acknowledgeGenerationFromValueOrPersistTarget`、`settleMvuAfterAppend`(create 时 autoInit)、backup、`refreshRecentChatIndexEntry` 全部保留(`874-927`);响应字段 `{ok,appended,created,skipped,matched_existing_generation_id,integrity}` 与 legacy 逐义一致。
- **409 完整性冲突**:所有 CAS 路径走 `sendRepoIntegrityConflict`(`875,918,995,1065`)产出 `{error:'integrity', current_integrity}`,与 legacy `chats.js:1120-1134`(`details.actual→current_integrity`)一致;`resolveChatWriteConflictForTarget` 可正常消费。
- **presets**:`{items}`→names、`{doc}`→doc、PUT raw doc(`?apiId=`)、DELETE——`named-resource-read.js:71-87`、`preset-persistence.js:19`、`preset-manager.js:1463` vs `presets.js:65-175`。信封 `openai_settings/bodies`+`openai_setting_names` 及 bootstrap 期"仅选中预设载内容"的 lazy 形态沿用既有 `loadSettingsEnvelope` 行为,非新回归。
- **worlds**:`{items}`/`{doc}` 解包正确;`saveWorldInfoInternal` PUT body=`cloneAsJsonWire(data)`(含 `entries`)满足 `doc.entries` 要求;incremental patch 显式 keep-legacy(`/api/worldinfo/patch`,因 utopinn 无 PATCH);delete→DELETE。`world-info.js:3079,5528,8160-8184,8443`
- **integrity 命名**:写请求统一 `body.integrity`(非 `expectedIntegrity`),与 append(`851`)/patch(`952`)/document(`1054`)一致;写响应 integrity 经 `applyIntegrityFromWritePayloadToTarget` 回写 `chat_metadata`+快照。
- **group 域零误改**:rename(`19676-19686` 仅 character 半支走 utopinn)、append(`14375`)、patch(`14577`)、meta-patch(`14826`)、group get/save、`/api/chats/search`(`17043`,character+group 混合面)全部保留 legacy——utopinn 无 group 面,正确。
- **generation**:`/api/utopinn/generate`(`openai.js:4388`)为独立改动,非本批;top-10 之外;textgen/kobold/custom(`custom-request.js:470`、`openai.js:4448`)保留 `/api/backends/*`——非回归点。
- **state sidecars**:20/20 调用点已迁,共享 handler(见 `.skeinn/eval/task033b-state-sidecar-reroute.md`)。
- **改名残留**:`/api/uberge` 字面量在 `apps/server/public` 下 0 命中。
- **secrets**:`/api/secrets/*` 全部保留 legacy(`secrets.js:300-528`);`/api/utopinn/secrets` 面仅供薄客户端,无浏览器误接。
- **404 兜底**:chat GET 404→`{new_chat:true}`、chat list 非 2xx→`[]`、`renamePastChats` 单会话失败 `continue`——与 legacy 调用方期望等价。
- **chat_size=0**:legacy 服务端本就是 `+= 0` 占位(`characters.js:415`),adapter 置 0 为对齐;"Most/Least chats" 排序在 legacy 已无效。
- **`.png`-only 过滤**:legacy `/api/characters/all` 亦只扫 `.png`,webp/json 卡同样不可见——对齐,非回归(`script.js:2958-2961`)。

## 行动建议(父代理执行状态跟踪)

| # | 建议 | 状态 |
|---|---|---|
| B1 | `GET /api/utopinn/settings` 加 `?raw=1` 未脱敏通道给受信旧前端 | 已修(见下) |
| M1 | adapter 透传 legacy `toShallow` 八字段归一化(含 `avatar && name` 过滤) | 已修 |
| M2 | `/api/utopinn/characters` list 补 dateLastChat/dateAdded/create_date ctime 兜底 | 已修 |
| M3/M4 | DELETE/RENAME 复用 legacy sidecar 清理+recent-index helper | 已修 |
| M5 | character append body 补 `chat_metadata`(对齐 group 分支) | 已修 |
| M6 | repo.get tolerant-read + `{corrupted:true}` | 已修 |
| N4 | PATCH 语义错 409 payload 补 `current_integrity` | 已修 |
