# Utopinn 系统地图——端口 / CLI / 数据流 全索引

> 2026-11-19 TASK-030/031 实弹期整理。唯一事实源是代码;本文当导航。
> 端口面以 `apps/server` 实跑为准;CLI 契约以 `.skeinn/capabilities/cli-client/capability.md` 为准。
> vs-V2: partially-stale

## 0. 一张图

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 浏览器旧 UI   │   │ utopinn CLI   │   │ (未来)手机端  │   ← 薄客户端,无大脑
│ public/*.js  │   │ apps/cli/    │   │ apps/mobile/ │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ 同一套 wire:CSRF cookie + REST + WS 帧流 │
       └──────────────────┼──────────────────┘
                          ▼
        ┌─────────────────────────────────────┐
        │  apps/server (Express + cordis 内核) │  唯一大脑
        │                                      │
        │  ┌─ cordis 新面 /api/utopinn/* ─────┐ │
        │  │ generate / preview / jobs      │ │  ← 生成编排
        │  │ library (characters/presets/   │ │  ← 资产 CRUD
        │  │   worlds/personas/settings/    │ │
        │  │   secrets/chats REST)          │ │
        │  │ mvu / script / th / import     │ │  ← 能力插件
        │  │ plugins / _kernel / data       │ │  ← 内核管理
        │  └────────────────────────────────┘ │
        │  ┌─ legacy 面 /api/<58 routers> ──┐ │
        │  │ chats characters settings      │ │  ← 写盘/读档(CAS)
        │  │ presets secrets groups …       │ │  ← 资产(旧)
        │  │ backends/chat-completions      │ │  ← jobs/active|status|events
        │  │ /api/generation/:id/abort      │ │  ← 生成控制
        │  │ /api/ws-ticket                 │ │  ← WS 票据
        │  └────────────────────────────────┘ │
        │         ▲ registerUpgrade           │
        │  WS /api/ws-delivery (ticket 子协议) │
        └──────────────┬───────────────────────┘
                       │ dispatch(runner → provider resolver)
                       ▼
              LLM 上游(OpenAI 兼容/自定义/各源)
```

<!-- V2 校准:V2:apps/web 正式前端、旧 UI=LUKER_SERVE_LEGACY 兼容闸、手机端 parked -->

分层记忆:**会话 → 实体 → 生成 → 投递 → 写盘 → 诊断**。客户端只需要这六层。

---

## 1. 会话层(进门三件套)

| 端点 | 方法 | 用途 | 谁在用 |
|---|---|---|---|
| `/csrf-token` | GET | 拿 `{token}` + `set-cookie`;后续全链要带 `X-CSRF-Token` 头 + `Cookie` | 浏览器/CLI/未来端 |
| `/login` `/api/users/*` | GET/POST | 多 handle 登录;loopback 白名单可跳过 | 部署形态 |
| `/api/ping` | POST | 存活探测 | doctor |

**CSRF+cookie 是进程内会话**,CLI 每条命令重握手(~1 RTT),不落盘凭证。

## 2. 实体层(角色/聊天/资产)

### 2a. legacy 读面(浏览器同款,CLI 现用)

| 端点 | 方法 | 入参要点 | 返回 |
|---|---|---|---|
| `/api/characters/all` | POST | `{}` | `[{avatar,name,chat,chat_items,mes,sort_time,…}]`(`chat`=服务端当前聊天指针) |
| `/api/characters/chats` | POST | `{avatar_url:'<dir>.png',simple:false}` | `[{file_name,chat_items,mes,sort_time}]` |
| `/api/chats/recent` | POST | `{}` | 跨角色最近聊天 |
| `/api/chats/get` | POST | `{avatar_url,file_name:'<n>.jsonl'}` | `[header, ...floors]`;新聊天 `{new_chat:true}`;**`header.chat_metadata.integrity` = CAS 令牌** |

### 2b. cordis library 新面(`/api/utopinn`,REST 风格)

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/utopinn/characters` `/:charDir` | GET | 角色列表/详情 |
| `/api/utopinn/characters/:charDir/chats` `/…/:chatName` | GET/PUT/PATCH/DELETE/POST | 聊天 CRUD + `…/rename` + `…/messages` |
| `/api/utopinn/presets` `/:name` | GET/PUT/DELETE | 预设 |
| `/api/utopinn/worlds` `/:name` | GET/PUT/DELETE | 世界书 |
| `/api/utopinn/personas` `/…` | GET/PUT/DELETE | 人设 |
| `/api/utopinn/settings` | GET/PATCH | settings |
| `/api/utopinn/secrets` `/:key` `/:key/:id` | GET/PUT/DELETE | 密钥库(dispatch `ctx.secrets` 读这里) |
| `/api/presets/list?apiId=openai` | GET | `{names[]}`(CLI `presets` 用这个 legacy 口) |

**两套资产面并存是过渡态**:library 面是给新客户端的,cordis 插件;legacy 面是旧 UI 遗产。CLI v1 混用——读走 legacy(形状直接可用),写走 chats(带 CAS)。

## 3. 生成层(cordis,服务端大脑)

| 端点 | 方法 | 用途 | 关键字段 |
|---|---|---|---|
| `/api/utopinn/generate` | POST | **主口**:组装→dispatch→job | `charDir,chatName,type,stream,presetName,user,generation_overrides,overrides,luker_generation{job_id,persist_target}` |
| `/api/utopinn/preview` | POST | 干跑组装,不派发不写盘 | 同上;回 `{messages[],sources,perf}` |
| `/api/utopinn/jobs` | GET | job 列表(running 面) | |
| `/api/utopinn/jobs/:id` | GET | job 明细:trace/sources/WI 激活/perf | CLI `inspect` |
| `/api/utopinn/script/run` | POST | STscript 执行 | |
| `/api/utopinn/th/call` | POST | 酒馆助手 TH-compat 直连 | |
| `/api/utopinn/mvu/settle` `/resettle` `/state` `/panel/render` | POST/GET | MVU 结算/状态/面板渲染 | |
| `/api/utopinn/import/preview` `/commit` | POST | 卡/资产导入 | |
| `/api/utopinn/backup` `/lan/offer` `/lan/import` `/import/scan-st` | POST | 数据迁移/局域网互导 | |
| `/api/utopinn/plugins` `/:id/enable|disable|reload` | GET/POST | cordis 插件管理 | |
| `/api/utopinn/_kernel` | GET | 内核自检(插件状态) | |

**generate 的 `type`**:`normal|regenerate|swipe|continue|impersonate|quiet`——服务端组装语义各不相同(swipe 自弹末楼、continue 接 cycle prompt、quiet 强制非流)。

**`generation_overrides`**:整包并入 dispatchBody(显式>预设>连接层)。已知白名单:provider requestBody 是 canonical 键过滤——非 canonical 键(如 `enable_thinking`)只在 reverse_proxy 网关下透传(2026-11-19 实弹发现 DeepSeek 系 reasoning_content 问题后加的口子)。

**`overrides`**:`{quietPrompt, …}`——组装期语义覆盖,不进派发体。

## 4. 投递层(job → 客户端)

生成请求 `200 {}` 只是回执,**真结果走 job 帧**:

| 通道 | 形态 | 用途 |
|---|---|---|
| `/api/ws-ticket` | POST → `{ticket}` | 30s TTL 单次消耗,每连现取 |
| `/api/ws-delivery` | **WS upgrade**,子协议 `luker-ws-ticket.<ticket>` | head/chunk/end/error 帧 + ping/pong 心跳 |
| `/api/backends/chat-completions/jobs/active` | POST `{persist_target}` | 本聊天在跑 job 查询(并发护栏) |
| `/api/backends/chat-completions/jobs/status` | POST `{id}` | 终态对账:`{status,text,persisted,error}` |
| `/api/backends/chat-completions/jobs/events` | GET | 原始帧回放(**Buffer 序列化陷阱**,别当主流) |
| `/api/backends/chat-completions/jobs/events-stream` | GET SSE | status 节流流(浏览器兜底) |
| `/api/generation/:id/abort` | POST | 中止 job |

### WS 帧协议(硬约束)

```
client → {type:'resume', request_id, from_seq}     ← 必须 POST generate 之后再连
server → {type:'head', seq, data:{status,headers}}  ← 上游响应头
server → {type:'chunk', seq, data:<base64>}         ← SSE 字节(含 reasoning_content)
server → {type:'end',   seq}                        ← 流完
server → {type:'error', seq, code}                  ← aborted/forbidden/not_found/internal
server → {type:'ping', ts}  client → {type:'pong', ts}  ← 30s 心跳,70s 无 pong 断
```

- `resume from_seq:1` 回放 `job.events`(8000 帧上限/2h TTL)并订阅新帧
- **job 不存在时 resume = `error not_found`,不注册订阅**——时序必须是 POST→ticket→WS→resume
- chunk 里会混 `data: {"luker":{generation_id,persisted,status}}` 尾帧,解析要跳过

### job 生命周期

```
running → awaiting_ack →(15s grace)→ persisting → completed | failed | cancelled
```

- 客户端 append/patch 带 `luker_generation_id` → **ack** → awaiting_ack 时直接 completed(免 grace 等待)
- 超时无人 ack → 服务端 `persistGeneratedReply` 兜底 append(**无 CAS**——请求时 integrity 快照在生成中必过期,已修)
- `persist_target:{kind:'none'}`(swipe/continue/impersonate/quiet)→ 兜底落成 failed,**预期 cosmetic**

## 5. 写盘层(legacy `/api/chats/*`,带 CAS)

| 端点 | 方法 | body | 返回 |
|---|---|---|---|
| `/api/chats/append` | POST | `{avatar_url,file_name,messages,integrity?,force?,luker_generation_id?}` | `{appended,skipped,integrity,created?,matched_existing_generation_id?}` |
| `/api/chats/patch` | POST | `{avatar_url,file_name,operations:[JSON-Patch],integrity?,force?,luker_generation_id?}` | `{ok,applied,integrity}` |
| `/api/chats/rename` | POST | `{avatar_url,original_file,renamed_file}` | |
| `/api/chats/delete` | POST | `{avatar_url,chatfile}` | |
| `/api/chats/state/*` | — | chat_state sidecar(MVU/CardApp 面板状态) | |

**integrity CAS**:写时带缓存 slug;`409`→读 `/api/chats/get` 重锚重试一次。
**两类 409 别混**:`integrity 错(可重锚)` vs `Chat patch conflict.`(JSON-Patch op 冲突,如 `replace` 缺键——重试无用,用 `add`)。
**幂等**:append 对末楼 deep-equal 消息 `skipped`;gen-id sidecar 命中也跳过——断网重发不产双楼。
**patch 下标**:`/i` 是 body 下标(header 不算),`history #i` 同基。

## 6. CLI 命令 → 端点映射(`apps/cli/utopinn-cli.mjs`)

| 命令 | 打的端点 | 写盘 |
|---|---|---|
| `utopinn`(裸) | 无(零网络快照) | — |
| `status` | chats/get + jobs/active | 刷新 state |
| `doctor` | csrf-token + characters/all + ws-ticket+WS | — |
| `schema` | 无(自描述 JSON) | — |
| `chars` | POST /api/characters/all | — |
| `chats` | POST /api/characters/chats | — |
| `recent` | POST /api/chats/recent | — |
| `use <c> [chat]` | characters/all + characters/chats | 写 ctx |
| `chat-new` | characters/chats(查重) | 写 ctx |
| `chat-rename` | POST /api/chats/rename | ctx |
| `chat-delete` | POST /api/chats/delete | ctx |
| `history` | POST /api/chats/get | 刷 integrity/floors |
| `edit <i> <t>` | chats/get → POST /api/chats/patch | replace mes+swipes |
| **`send <t>`** | jobs/active → chats/append(user) → **utopinn/generate** → ws-ticket → WS resume → chats/append(AI+gen-id ack) → jobs/status | user+AI 两楼 |
| `say <t>` | chats/append(user) | user 楼 |
| **`regen`** | jobs/active → chats/patch(remove 末楼) → generate(regenerate) → append(AI) | 删+AI 楼 |
| **`swipe`** | jobs/active → chats/get → generate(swipe) → patch(swipes/-,swipe_id,mes) | 末楼 swipe |
| `swipe N` / `--list` | chats/get → patch(swipe_id,mes) | 导航,不生成 |
| **`continue`** | jobs/active → chats/get → generate(continue) → patch(mes 合流,swipes) | 续写同楼 |
| **`impersonate`** | generate(impersonate, persist none) [--write → append user] | 默认不落 |
| **`quiet <p>`** | generate(quiet, persist none, overrides.quietPrompt) | 不落 |
| `jobs` | GET /api/utopinn/jobs | — |
| `inspect [id]` | GET /api/utopinn/jobs/:id | — |
| `preview` | POST /api/utopinn/preview | — |
| `attach [id]` | jobs/status →(跑中)ws-ticket+WS resume | — |
| `abort [id]` | POST /api/generation/:id/abort | — |
| `persona [n]` | — | state.persona |
| `presets` | GET /api/presets/list?apiId=openai | — |
| `preset <n>|--off` | presets/list(校验) | state.preset |

**send 全链时序**(CLI v0.2 修正后):

```
jobs/active 护栏 → append user 楼(CAS)
→ POST /api/utopinn/generate {job_id 自铸, persist_target:character}
   ← 200 + x-luker-generation-id(job 已建,dispatch setImmediate)
→ POST /api/ws-ticket → WS /api/ws-delivery(resume from_seq:1)
→ head/chunk/end 帧,SSE 解析 delta.content(+reasoning_content 展示,不进楼层)
→ 立即 append AI 楼(mes=streamed||status.text,顶层+extra 双 gen-id)
→ jobs/status 轮终态 → footer(ctx+floors+job+elapsed)
```

## 7. 数据模型(磁盘)

```
<dataRoot>/<handle>/
  settings.json              oai_settings(连接/预设指针)+ world_info_settings(五层绑书)
  settings/secrets.json      密钥库(不落客户端)
  chats/<charDir>/<chat>.jsonl   header(chat_metadata.integrity/聊天绑定 WI/变量)+ 楼层*
  chats/<chat>.jsonl.genid   gen-id sidecar(写盘幂等)
  chats/<chat>.jsonl.state   chat_state sidecar(MVU 快照/面板)
  characters/<dir>.png       卡(PNG tEXt chara 数据,可含 character_book/extensions.world)
  worlds/<name>.json         世界书文件形(key/keysecondary/uid/disable)
  presets/openai/<name>.json 预设(生成参数+prompts+prompt_order)
```

**楼层形**(AI 楼):`{name,is_user:false,is_system:false,send_date,mes,gen_started,gen_finished,extra:{api,model,luker_generation_id?},swipes?[],swipe_id?,swipe_info?[]}`
注意:服务端兜底 persist 的楼层**没有 swipe 结构**——patch 要用 `add` 不是 `replace`。

## 8. 运行端口实记(本次实弹环境)

| 口 | 干什么 |
|---|---|
| `:18997` | live-fire-serve 常驻实例(dataRoot=`.e2e-scratch/generation-aiping-live-serve-39611`) |
| `:55483` | 本机梯子 HTTP 代理——上游出站必须经 `requestProxy.url`(config.yaml) |
| aiping.cn/api/v1 | OpenAI 兼容中转(`reverse_proxy`+`proxy_password` Bearer) |
| `:8977` | 掌门卡 CardApp 预览(另一工程) |

## 9. 已知边界(实弹踩出来的,全修过)

| 坑 | 现象 | 修法 |
|---|---|---|
| WS resume 早于 POST | `error not_found` 零帧 | POST→ticket→WS→resume 硬序 |
| generate POST 30s 超时 | 慢盘组装超 30s | generate 用 `--wait` 整窗 |
| persist 兜底 CAS | 请求时 integrity 生成中必过期→job failed | 兜底不做 CAS(服务端自写) |
| `replace` 缺键 op | 兜底楼层无 swipe/gen_finished → `Chat patch conflict.` | 可缺键一律 `add` |
| reasoning_content | DeepSeek 系思考流吃光上游 cap→content 0ch | `--set enable_thinking=false`(reverse_proxy 透传) |
| REST /jobs/events | chunk 是 Buffer 序列化非 base64 | 主流走 WS resume,兜底用 status.text |
| integrity/patch 双 409 | 同是 409 不同语义 | 按 body 含 'integrity' 才重锚 |

## 10. 未接/残余

- group 聊天:`selected_group` → CLI/UI 均回退(服务端 deps.group 未接)
- textgen/kobold/novel 源:generate 路由有 textgen 分支,UI 未接;CLI 未做
- 浏览器组装空跑:wire 权威已是服务端,浏览器那遍是死工(Phase2 短路)
- `swipe` 非末楼、`quiet` 的 skipWIAN/quietImage/quietToLoud 覆盖缺口
- jobs 列表只含 running 面;completed job 明细快速过期(inspect 要趁活)
