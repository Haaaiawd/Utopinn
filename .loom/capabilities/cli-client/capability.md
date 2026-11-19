# CLI 薄客户端(uberge)——agent-first 命令行全操控面

> 设计构思文档 v2(全面重写 v1 草稿)。TASK-031 附产。
> 本文是唯一规格:实现者不需要读任何代码即可按此落地;
> wire 事实均已在 apps/server 源码中核实(见各处引用行号)。

## 定位与动机

**第一个真正的薄客户端 dogfood,第一消费者是 AI Agent 不是人。**
TASK-030 把旧 UI 的 chat 域生成切到 `/api/uberge/generate` 之后,服务端
已是唯一大脑——CLI 是验证「协议面足够撑起一个独立客户端」的最小代价
试验场,同时替代 playwright 做日常驱动/回归。

Agent 场景的成功定义:**零文档查阅、最少往返、最少 token、断链可恢复**。
Agent 用 `uberge` 完成「选卡→看历史→发消息→收流→看轨迹→swipe→诊断」
全链,不需要读 --help,不需要猜下一步命令,不需要担心中途断掉丢上下文。

不做:UI 美化、交互式 TUI(v1 是 unix 风格子命令,不是 ink/blessed 全屏
应用)、REPL、多账号。

## agent-first 设计铁律

1. **无参 `uberge` ≠ help**。裸跑输出「当前状态 + 建议下一步」,不输出
   说明书。Agent 不读 help;状态本身就是导航。
2. **每条命令尾部都有 `next` 建议**。human 模式一行 `· next: …`;JSON 模式
   `next: [{cmd, why}]`。Agent 永远知道现在能干什么,不用回读帮助。
3. **`--json` 是一等公民**。所有输出可解析;生成动词的 JSON 模式是 NDJSON
   帧流(每行一个完整 JSON,流式与结构化兼得)。human 模式是给活人看的,
   不做向后兼容承诺;JSON 契约才钉死。
4. **每个错误自带出路**。错误 envelope 必有 `code` + `hint` + `next`,
   Agent 看 hint 就知道怎么修,不需要试错。模糊匹配失败必须列出候选。
5. **坐标随输出走**。`ctx`(char/chat/floors/integrity/job)出现在每个
   相关输出里——Agent 不维护心智模型,状态文件是唯一事实源。
6. **大载荷落盘不进 stdout**。`--out <file>` 把完整 JSON/文本写文件,
   stdout 只回摘要+路径。Agent 用文件工具按需读,不爆 token。
7. **断链不死,恢复是显式动词**。Ctrl+C 不杀服务端 job(设计如此),
   `attach`/`jobs`/`inspect` 提供恢复面;CAS 冲突自动重锚一次再给提示。

## 架构决定

- **零依赖单文件**:Node ≥22 原生 `fetch` + `WebSocket`(22.4 起稳定),
  不用 ws/node-fetch/extra deps。`apps/cli/uberge-cli.mjs` + 薄
  `package.json`(bin `uberge`)。这个工具要能 `node uberge-cli.mjs …`
  随手跑,不该有构建链。
- **不走 api-client 包**:api-client 当前是骨架(TS,需构建,无 cookie
  罐)。CLI 先自铺薄层;等 api-client 长全(WS 面+cookie)再迁。两者
  消费同一协议,CLI 实现即 api-client 的行为参照。
- **与浏览器同一条 wire**:CSRF cookie 会话 + REST + ws-ticket/ws-delivery
  帧流——不走任何后门接口。CLI 能做的事 = 浏览器能做的事,这是刻意
  约束:协议缺什么就暴露什么,不补私有通道。
- **会话不落盘**:csrf token 与 session cookie 只活在单次进程内——每条
  命令重新握手(`GET /csrf-token` → token + set-cookie,~1 RTT)。状态
  文件永远不存凭证,cookie 罐不持久化。代价可忽略,换零 secret 面。
- **楼层写盘归 CLI**(见「写盘时序」):生成走服务端,落盘走
  `/api/chats/append|patch` 并带 `luker_generation_id` 显式 ack——
  与浏览器「客户端写楼 + 服务端 persist 仅作崩溃兜底」同构,换取
  零 15s 宽限等待 + CAS 链接力 + gen-id 幂等。

## 会话与投递机制(对照浏览器实现)

| 面 | 浏览器 | CLI |
|---|---|---|
| CSRF | `GET /csrf-token` → `X-CSRF-Token` 头 | 同 + `Cookie` 头(set-cookie 罐,内存态) |
| 生成 | `POST /api/uberge/generate` + `x-luker-request-id` 头 | 同;`job_id` 自铸 UUID 放 `luker_generation.job_id` |
| 响应 | 200 + 空 body `{}`;真实结果走 job 帧 | 同;`x-luker-generation-id` 头回显 job id;`x-uberge-perf` 头带组装耗时 |
| 流式 | ws-delivery PROXY 拦截 fetch → POST 后 `subscribe`(实为 `resume from_seq:1`)→ head/chunk/end → 合成 SSE Response | **POST 先返回 200** → `POST /api/ws-ticket` → `new WebSocket(ws://…/api/ws-delivery,'luker-ws-ticket.'+t)` → 发 `{type:'resume',request_id,from_seq:1}` → 同帧 |
| 帧语义 | head=上游 status/headers;chunk=base64 SSE 字节;end=流完;error=结构化错(`code: aborted/forbidden/not_found/internal`) | 同;`ping` 必须回 `{type:'pong',ts}`(30s 心跳,70s 无 pong 服务端 terminate) |
| 落盘 | 客户端 save/patch 聊天 + gen-id ack;服务端 persist_target 仅崩溃兜底(15s grace) | 同语义:append/patch 写楼 + `extra.luker_generation_id` ack |
| 恢复 | `/jobs/events-stream` SSE(status 帧 300ms 节流带全量 text)/ `/jobs/status` 轮询 | attach 用 WS resume;兜底用 `jobs/status` 的 `text` 差分(见下) |

### WS 顺序是硬约束(v0 踩过的坑)

**必须先 `POST /api/uberge/generate` 拿到 200,再取 ticket 连 WS 发
`resume from_seq:1`。** 服务端 `uberge-delivery.js:175-179`:job 不存在
时 subscribe/resume 直接回 `error not_found` 且**不注册订阅**——ticket/
WS/resume 先于 POST 时序 = 永远收不到帧。runner 在 `response.json({})` 前
已 `createGenerationJob`(runner.js:41),dispatch 在 setImmediate——POST
返回后 job 必已存在,`resume from_seq:1` 回放 `job.events` 里已积的帧
(上限 8000 帧/2h TTL),竞态天然闭环。ticket 30s TTL、单次消耗
(ws-ticket-router.js),**每次 generate 现取现用**。

### job 生命周期(写盘策略的依据)

`running → awaiting_ack →(15s grace,LUKER_GENERATION_ACK_GRACE_MS)→
persisting → completed | failed | cancelled`
(luker-generation.js:788-948)

- job `awaiting_ack` 期间若客户端写楼带 gen-id → `acknowledge*`
  标 `completed`,grace 定时器见 `acked` 直接退出——**这就是「客户端
  写楼 + 免服务端 persist」的标准通道**。
- `persist_target:{kind:'character'}` + 无人 ack → grace 到点服务端自己
  append 一条 AI 楼(`persistGeneratedReply`,luker-generation.js:672)
  ——是崩溃兜底不是主路径;对 swipe/continue 这语义还是错的(续写被
  append 成新楼)。
- `persist_target:{kind:'none'}` + 无人 ack → grace 到点落成
  `failed`,error `Generation could not be persisted on server.`
  ——impersonate/quiet 这类「只输出不落盘」的动词会留这个尾巴,
  **属预期,cosmetic**,见命令表。

## 写盘时序(逐 type)

| 动词 | type | persist_target | CLI 写盘动作 | job 终态 |
|---|---|---|---|---|
| `send` | normal | `{kind:'character',avatar_url,file_name,char_name,integrity}`(带缓存 integrity 作崩溃兜底 CAS) | ① append user 楼 ② 生成 ③ append AI 楼(`extra.luker_generation_id`=jobId) | completed(ack) |
| `regen` | regenerate | 同上 | ① patch `remove /N`(末 AI 楼)**先于** POST(浏览器 `script.js:7901` 同序——不删则旧回复仍在 prompt 上下文里,不是真 regen)② 生成 ③ append AI 楼 | completed(ack) |
| `swipe` | swipe | `{kind:'none'}`(服务端组装自弹末楼,generate-context.js:236) | 生成后 patch 末 AI 楼:`swipes/-` push + `swipe_info/-` push + `swipe_id`++ + `mes`=新文本 | completed(ack) |
| `swipe N` | —(不生成) | — | patch `swipe_id`=N + `mes`=`swipes[N]` + 从 `swipe_info[N]` 回填 send_date/gen_*/extra(`syncSwipeToMes` 语义) | — |
| `continue` | continue | `{kind:'none'}` | 生成后 patch 末楼:`mes`=旧文+delta、`swipes[swipe_id]`=同上、更新 `swipe_info[swipe_id]` | completed(ack) |
| `impersonate` | impersonate | `{kind:'none'}` | 默认不写(草稿语义);`--write` 时 append user 楼(persona 名 + gen-id) | 15s 后 failed(预期,cosmetic;`--write` 则 ack 收 completed) |
| `quiet` | quiet | `{kind:'none'}` | 不写 | 同上 |
| `say` | —(不生成) | — | append user 楼 | — |

写楼消息形(assistant 楼,对齐 `persistGeneratedReply` 与浏览器 saveReply):
`{name:<charName>, is_user:false, is_system:false, send_date:<ISO>,
mes:<text>, gen_started:<ISO>, gen_finished:<ISO>,
extra:{api:'cli', model:<job.modelName||''>, luker_generation_id:<jobId>}}`
append body 顶层再放 `luker_generation_id:<jobId>` ——顶层写 sidecar
(gen-id 去重:`matched_existing_generation_id`),`extra` 里的参与
`acknowledgeGenerationIdsFromValue` 收集 → ack。双通道都利用。

幂等:`/api/chats/append` 对「与末楼 deep-equal 的消息」返回
`appended:0, skipped:1`;gen-id sidecar 命中时同样跳过——**网络断在
append 之后重发 send 不会产生双楼**。patch 对顶层 `add /N` 的等值消息
会重写为 `test`(buildIdempotentMessagePatchOperations)。

## 命令面契约表(v1)

通用:`-s/--server <url>`|`UBERGE_SERVER`(默认 `http://127.0.0.1:8000`);
`--state <file>`|`UBERGE_STATE`(默认 `~/.uberge-cli.json`);
`--json`|`UBERGE_JSON=1`;`--timeout <ms>`(单请求,默认 30000);
`--wait <ms>`(生成等待上限,默认 180000);`--full`(不截断);
`--out <file>`(大载荷落盘);`-n N`(条数);`--force`(跳过 integrity CAS);
`--stdin`/位置参数 `-`(从 stdin 读文本,解决多行/转义)。

退出码:`0` ok;`1` 通用/服务端错;`2` 用法错;`3` 冲突
(integrity/ambiguous/patch 409/active-job);`4` 网络/会话错;
`5` 上游生成失败(job failed/cancelled);`6` 超时(job 仍在跑,提示 attach)。

### 定位与状态

| 命令 | 输入 | 正常输出 | 副作用 |
|---|---|---|---|
| `uberge`(裸) | — | 缓存快照:ctx + floors(估算) + lastJob + `next` 建议。**零网络**,瞬时 | 无 |
| `uberge status` | — | 在线刷新:ctx + floors + integrity + active jobs(`jobs/active`)+ preset/persona | 刷新 state.integrity/floors |
| `uberge doctor` | — | 逐项 ✓/✗:server 可达 → csrf/session(打一发 `characters/all`)→ WS(ticket+connect+ping/pong ≤5s)→ ctx 有效(char/chat 存在)→ active-job 泄漏。每 ✗ 带修复 hint | 无 |
| `uberge schema` | — | 自描述 JSON:命令目录(语法/flag/输出契约)+ 错误码表 + 退出码表 + 状态 schema。**Agent 一次读完即可,永远不查 help** | 无 |
| `uberge sync` | — | 重读当前 chat,回 ctx/integrity/floors/末楼 swipe 摘要 | 刷新 state |

### 发现与选择

| 命令 | 输入 | 正常输出 | 错误 | 副作用 |
|---|---|---|---|---|
| `uberge chars` | `-n,--full,--out` | `dir │ name │ 当前 chat │ fav`,每行一卡 | — | 无 |
| `uberge chats [--char d]` | `-n,--full,--out` | `name │ floors │ 末楼摘要(≤80ch) │ 时间`,当前 chat 标 `*` | `no_ctx` | 无 |
| `uberge recent` | `-n` | 跨角色最近聊天:`char │ chat │ 时间` | — | 无 |
| `uberge use <c> [chat]` | 模糊可 | `→ <name> @ <chat> · floors N`(chat 缺省:`char.chat` 服务端指针 → 否则 sort_time 最新) | `not_found`(列候选)/`ambiguous`(列全部候选) | 写 state ctx+floors;**不拉 integrity**(首写时懒取) |
| `uberge persona [name]` | `--desc` | 无参 → 显示;有参 → 设定 | — | 写 state.persona(进 generate `user.name` 与 user 楼 name) |
| `uberge presets` | — | openai apiId 预设名列表(`GET /api/presets/list?apiId=openai` → `{names[]}`) | — | 无 |
| `uberge preset <n>|--off` | 名 | `preset = <name>` | `not_found` | 写 state.preset(进 generate `presetName`;--off 回落服务端 `settings.preset_settings_openai`) |

### 聊天生命周期

| 命令 | 输入 | 正常输出 | 错误 | 副作用 |
|---|---|---|---|---|
| `uberge chat-new <name>` | 名 | `chat = <name>(空,首条 send 建文件)` | `exists`(列相似名) | state.chatName;不建文件(append 自建) |
| `uberge chat-rename <new>` | 新名 | `renamed → <sanitized>` | `no_ctx`/400 | `POST /api/chats/rename {avatar_url,original_file,renamed_file}`;同步 state |
| `uberge chat-delete <name>` | 名(必显式) | `deleted <name>` | `not_found` | `POST /api/chats/delete {avatar_url,chatfile}`;删当前 chat 则清 ctx.chatName |

### 生成动词

| 命令 | 输入 | 正常输出(human) | 错误 | 副作用 |
|---|---|---|---|---|
| `uberge send <text>` | `--empty,--stdin,--no-stream,--quiet,--set k=v,--user n,--preset n,--out` | 流式 AI 文本 → 空行 → footer(`floors/job/chars/elapsed` + `next`) | `no_ctx`/`active_job`/`integrity_conflict`/`upstream` | user 楼 + job + AI 楼;state(lastJob/floors/integrity/lastReplyPreview) |
| `uberge say <text>` | 同 send 文本参 | `→ floor #N` | 同上(无 upstream) | 只 append user 楼 |
| `uberge regen` | `--no-stream,--quiet,--wait` | 流式文本 + footer | `no_ctx`/`no_ai_floor`(末楼非 AI 时 regen=normal,自动降级并提示)/`active_job` | patch remove 末楼 → 生成 → append AI 楼 |
| `uberge swipe [N]` | `--list,--full` | 无参=生成新 swipe(流式);`N`=导航(`swipe N/总, mes 摘要`);`--list`=候选表 | `no_ctx`/`no_swipe`(末楼不可 swipe:user 楼或无 swipes)/`active_job` | patch 末楼 swipes/swipe_id/mes |
| `uberge continue` | `--no-stream` | 流式增量文本 + footer | `no_ctx`/`no_floor`(空聊天;末楼是 user 仍可续——续的是末楼,不卡 user/AI) | patch 末楼 mes/delta |
| `uberge impersonate [--write]` | `--no-stream` | 流式草稿文本 + footer(注明「未落盘,`--write` 或 `say` 提交」) | `no_ctx` | 默认无;`--write` 时 append user 楼 |
| `uberge quiet <prompt>` | 位置参/`--stdin` | 最终文本(quiet 服务端强制非流式)+ footer | `no_ctx`/`usage`(无 prompt) | 无(job 15s 后 cosmetic failed,输出已注明) |

生成动词共享护栏:**任何写盘/POST 之前**先查
`POST /api/backends/chat-completions/jobs/active`
`{persist_target:{avatar_url,file_name}}` ——本 chat 有
`running|queued|persisting|awaiting_ack` job 时**整条命令拒发**
(user 楼也不写,不留半成品),exit 3,
hint = `uberge attach <id>` 或 `uberge abort <id>`。防双楼层并发,
是「链条稳定」的哨兵,不开放跳过。

### 读取与诊断

| 命令 | 输入 | 正常输出 | 错误 | 副作用 |
|---|---|---|---|---|
| `uberge history` | `-n`(默认 5)`--floor i`,`--full`,`--out` | 楼层回放:`#i <name>[user/ai/sys] swipe k/m` + mes(≤300ch 截断标 `…+Nch`) | `no_ctx`/`new_chat` | 刷新 integrity/floors |
| `uberge edit <floor> <text>` | `--stdin`,`--force` | `floor #i updated` | `no_ctx`/`bad_floor`/`integrity_conflict` | patch `replace /i/mes`;楼层有 swipes 时同步 `replace /i/swipes/<swipe_id>`(syncMesToSwipe 语义) |
| `uberge jobs` | `-n`(默认 10)`--out` | `id8 │ status │ chatKey │ textPreview(≤60ch) │ persisted │ age`(`GET /api/uberge/jobs`) | — | 无 |
| `uberge inspect [jobId]` | `--section sources|trace|text`,`--full`,`--out` | 默认摘要:status/persisted/model/preset + WI activated 计数 + 按书直方图 + 条目前 15;`--section` 单面展开;`--full` 全部 | `not_found` | jobId 缺省=state.lastJob |
| `uberge preview` | `--type normal|continue|swipe`(默认 normal)`-n`(默认 8)`--full`,`--out` | `messages: N · perf xMS` + 逐条 `[role:name] ≤150ch` | `no_ctx`/4xx | 无 |
| `uberge attach [jobId]` | `--from <seq>`,`--wait` | job 在跑 → WS resume 流式增量 → footer;已终态 → 直接吐 `status.text` 全文 + footer | `not_found`/`timeout` | 无;末态恒以 `status.text` 对账(events 超 8000 会被裁,帧流可能不全) |
| `uberge abort [jobId]` | — | `aborted <id8>` | `not_found`/`409 not_running` | `POST /api/generation/:id/abort` |

## 上下文链与状态文件

路径:`~/.uberge-cli.json`(`UBERGE_STATE`/`--state` 覆盖;WSL 与
Windows 各写各家 home——跨边界跑时显式 `--state` 共享一份)。
写 = 读-改-写整文件,JSON parse 失败 → 备份 `.bak` 后重建。
**非多进程安全**:并行 agent 各自 `--state` 隔离。

```jsonc
{
  "version": 1,
  "server": "http://127.0.0.1:8000",
  "char":  { "dir": "诡异修仙人生模拟器", "name": "诡异修仙人生模拟器" },
  "chat":  { "name": "live-fire" },
  "persona": "User",
  "preset": null,                      // generate body.presetName;null=服务端默认
  "integrity": "a1b2c3d4",             // 缓存 CAS 令牌,只作「期望值」非权威
  "floors": 9,                         // body 楼层数(不含 header),估算值
  "lastJob": { "id": "uuid", "type": "normal", "status": "completed",
               "at": 1730000000000, "chars": 1234 },
  "lastReplyPreview": "前 80 字…",
  "recent": [ { "t": 1, "cmd": "send", "job": "uuid", "rc": 0 } ]  // 最近命令环,cap 10
}
```

铁律 5 的落地:**integrity/floors 是缓存不是权威**。每次写响应
(`append`/`patch`/`save` 回 `{integrity}`)接力更新;`use/status/sync/
history` 顺手刷新;写时拿缓存值发 CAS,409 → 自动 `chats/get` 重锚
+ 重试**一次**;再 409 → exit 3 + hint(`--force` 或 `sync` 后重试)。

上下文链断点自检:任何需要 ctx 的命令在 state 缺 char/chat 时报
`no_ctx` + hint `uberge use <char> [chat]`,不猜。

## 输出契约

### human 模式

- 结构:`<主内容>` + 空行 + footer 块:
  ```
  ── <charName> @ <chatName> · floors N · job <id8>:<status> · <extra>
  · next: uberge <cmd> · uberge <cmd> · uberge <cmd>
  ```
- `next` 单行 ≤3 条,按可能性排序,**整条可粘贴执行**(含 `uberge` 前缀)。
- 流式:delta 原文写 stdout(markdown 不渲染);诊断/警告写 stderr
  (`[cli] …`),不混进文本流。
- 截断一律标 `…+Nch`,且给出放大路径(`--full`/`--out`/`--floor`)。

### `--json` 模式

- 非生成命令:stdout 单个 envelope:
  ```jsonc
  { "ok": true, "cmd": "chats", "data": { /* 命令专属 */ },
    "ctx": { "server","charDir","charName","chatName","floors",
             "integrity","persona","preset","job":{"id","status","type"} },
    "next": [ { "cmd": "uberge send \"…\"", "why": "…" } ] }
  ```
- 生成动词:NDJSON,每行一帧:
  ```
  {"type":"meta","cmd":"send","job_id":"…","ctx":{…}}
  {"type":"delta","text":"…"}                       // 仅 --stream 时
  {"type":"write","op":"append","appended":1,"integrity":"…","floor":9}
  {"type":"status","status":"awaiting_ack"}
  {"type":"done","ok":true,"data":{"job_id","text","floor","status","persisted","elapsed_ms"},"ctx":{…},"next":[…]}
  ```
  `done.data.text` 恒含完整回复(即使 delta 帧已流过——done 是
  唯一事实源,agent 可以只读末行)。`--stream` 是增量帧开关,默认关。
- 错误:同 envelope 形(`ok:false` + `error{code,message,status,detail,hint}`
  + `ctx` + `next`),**stdout**(agent 一次读取即全),exit≠0。

### 错误码表(envelope `error.code`)

`usage`(参数错,带正确语法)/ `no_ctx` / `not_found`(char|chat|job) /
`ambiguous`(列候选)/ `exists` / `integrity_conflict`(409 CAS) /
`active_job`(有在跑 job,带 id)/ `no_floor` / `no_swipe` /
`new_chat` / `upstream`(job failed;detail 带 job.error+head.status) /
`session`(csrf/登录)/ `network` / `timeout` / `server`(5xx/未分类)。

## 大载荷进出

| 面 | 默认(human) | 放大 |
|---|---|---|
| history | 末 5 楼,mes ≤300ch | `-n`、`--floor i` 单楼全文、`--full`、`--out` |
| preview | 条数+roles+前 8 条 ≤150ch | `-n`、`--full`、`--out`(原始 JSON 落盘) |
| inspect | 摘要+WI 直方图+前 15 条 | `--section`、`--full`、`--out` |
| send/生成 | 全文流(回复本体不截) | `--quiet`(只留 footer+next)、`--out` 落 text |
| jobs/chats/chars | 全列,单行截断 | `--full`、`--out` |

`--out` 语义:原始 JSON(读类命令)或纯文本(send)写指定文件,
stdout 只回 `wrote <path> (<bytes>B)` + footer。文件是 agent 的
二级读取面,不进上下文窗口。

## 恢复与重试语义

- **Ctrl+C / 进程被杀**:job 服务端存活(runner 刻意不绑 close→abort,
  runner.js:62-77)。CLI 捕获 SIGINT → 打
  `job <id> still running — uberge attach <id>` 后退出(exit 6),
  **不**调 abort。中止是显式 `uberge abort`。
- **WS 中断**:自动重连一次(新 ticket + `resume from_seq:lastSeq+1`);
  再失败 → 降 `jobs/status` 轮询(1s),按 `status.text` 差分补增量,
  直到终态或 `--wait`。链路不因为 socket 抖一下断掉。
- **REST `/jobs/events` 陷阱**(实现注意):该端点回 `job.events` 原始
  envelope,chunk 的 `data.data` 是 Buffer/Uint8Array,JSON 序列化成
  `{"type":"Buffer","data":[…]}` 或 `{0:..,1:..}`——不是 base64。
  attach 主路用 WS resume(base64),兜底用 `status.text`,别踩这个面。
- **生成后落盘 wait**:末帧 `end` → CLI 自己 append/patch 写楼 + ack →
  轮 `jobs/status` 到 `completed` 或 `--wait` 超时。不走 15s grace。
- **SSE 尾帧**:`data: {"luker":{"generation_id","persisted","status"}}`
  会混在 chunk 字节里(runner.js:296)——delta 提取器认 `parsed.luker`
  字段跳过(它就是 `extractTextFromStreamingFrameData` 的同款判断),
  顺手把 `persisted/status` 抄进 meta。
- **head 帧非 200**:上游 4xx/5xx 经 head.status 透传 → 直接走
  `upstream` 错,body 取后续 chunk 文本,不重试。
- **integrity 409**:一次自动重锚重试(见上);`--force` 跳过 CAS 是
  人工裁决,不自动用。
- **active-job 冲突**:exit 3 + `next:[attach, abort]`。

## 安全边界

- **不落盘的**:csrf token、session cookie、任何密钥(每进程重握手)。
- **落盘的**:server url、charDir/chatName、persona、preset 名、integrity
  slug、job id、回复预览、命令环——全是坐标,无凭证。
- **网络面**:v1 只承诺 loopback/白名单会话。`--server` 指非 loopback →
  stderr 一次性警告「未测远端/无登录面,建议 SSH tunnel 或白名单」。
  需要登录的部署 → `session` 错 + 同 hint。**不做密码/basic-auth flag**
  ——那等于把凭证写进命令行历史。
- **写操作**:全部走 `/api/chats/*` 既有 CAS/校验;`--force` 是 opt-in;
  delete 必须显式点名。CLI 不直接碰数据目录。

## v1 明确不做(登记,不实现)

- REPL / TUI / 交互选择器(一切状态化,无交互问答)
- swipe 的非末楼操作、per-floor 多 swipe 管理 UI
- group 聊天(服务端 `/api/uberge/generate` 未接,buildUbergeGenerateBody
  selected_group → null 即弃)
- 多 handle/多用户、登录流、远端部署凭证
- persona description 写入面(persona 只带 name;description 走服务端
  `power_user.persona_description`,CLI 不碰 settings)
- `wi`/`books` 专查(WI 明细已在 inspect/preview sources 里;专查端点
  留给 web 管理端需求驱动)
- `panel`(chat_state sidecar,`/api/chats/state/*` 已存在——CardApp
  联调面,归 CardApp 任务)
- `th`(TH-compat `/api/uberge/th/call` 直连,酒助脚本调试)
- api-client 包迁移(等包长全,CLI 届时变纯壳)

## 实现自检清单(照此做不踩坑)

1. **WS 顺序**:POST generate → 200+`x-luker-generation-id` → ticket →
   WS → `resume from_seq:1`。反了 = 收不到任何帧。
2. ticket 30s TTL 单次用,每次生成现取。
3. ping 必须回 pong,否则 70s 被 terminate。
4. `send` 的 integrity 用缓存值,409 → 自动重取重试一次;WI timed
   effects 会在 generate 内 CAS 推进 integrity(generate-context.js:546),
   生成后的 AI 楼 append 撞一次 409 是**正常路径**,不算 bug。
5. regen 必须先 patch remove 再 POST;swipe/continue 不删楼(服务端自处理)。
6. impersonate/quiet 的 job 尾巴会翻 `failed` —— 输出里要标注
   「cosmetic,非真错」。
7. SSE 解析按 `\n\n` 分帧、CRLF→LF、`data:` 行 `.slice(5)`,尾帧
   `[DONE]`/`{"luker":…}` 跳过(同 runner.js:146-161 注释的解析纪律)。
8. `chats/get` 返回 `[header, ...floors]`;integrity 在
   `header.chat_metadata.integrity`;patch 的 `/i` 是 body 下标
   (header 不算),`history` 的 `#i` 同下标对齐。
9. `characters/chats` 默认形有 `chat_items/mes/sort_time`;`simple:true`
   只有名——列目录用前者,`use` 的 chat 缺省用 `char.chat` 指针优先。
10. jobs 面:`/api/uberge/jobs/:id` 有 trace/sources;`/jobs/status`、
    `/jobs/events`(REST 陷阱见上)、`/jobs/active` 在
    `/api/backends/chat-completions/` 下;abort 在 `/api/generation/:id/abort`。
11. floor `send_date`/`gen_*` 用 ISO 字符串(与 `persistGeneratedReply`
    同格式),moment 解析兼容。
12. `use` 不许隐式建聊天(打错字 = not_found + 候选,新聊天走
    `chat-new` 显式)——agent 侧最怕「typo 变成新文件」。

## v1 之后的生长方向(登记,不做)

- `panel` 命令:chat_state sidecar 读写(CardApp/掌门卡状态面联调)
- `th` 命令:TH-compat `/api/uberge/th/call` 直连(酒馆助手脚本调试)
- 交互 REPL 模式(readline 逐轮对话,比一次性 send 更像「玩」)
- `wi`/`books` 世界书专查与启停
- api-client 包补齐后迁移,CLI 变纯壳
