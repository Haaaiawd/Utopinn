# 混合 API Key(用户自配 + 服务端共享兜底):现状证据 + 设计

- Kind: design / system(含安全边界)
- Status: draft v1(调研完成,未实现)
- 缘起:同学接入私有部署,可能没 key。宿主想在服务端配一套共享 deepseek/openai key,朋友不填也能玩;用户自填的 key 必须优先。

## 1. 现状证据(文件:行)

### 1.1 secrets 存哪:严格 per-user

| 证据 | 位置 |
|---|---|
| `SecretManager(directories)` → `path.join(directories.root,'secrets.json')` | `apps/server/src/endpoints/secrets.js:118-135` |
| 文件结构:`{key: [{id,value,label,active}]}`,同 key 多条、active 唯一 | `secrets.js:209-228` |
| `SECRET_KEYS` 白名单 ~70 个 `api_key_<source>` + 服务类 key | `secrets.js:10-78` |
| 读:`readSecret(directories,key,id?)` → id 指定槽或 active 槽 | `secrets.js:273-287,433-455` |
| `readProviderSecret(request,key)`:`body.secret_id` 指定槽 → 回落 active | `secrets.js:505-527` |
| 脱敏:`getSecretState()` 只回 `{id,value:masked,label,active}`(末 3 位可见;短 key 全星) | `secrets.js:186-200,348-373` |
| 明文出口仅两处,且都受 `allowKeysExposure`(默认 false)闸:`/view`、`/find` | `secrets.js:113,575-621` |
| 启动迁移:flat 旧格式 → 数组格式,备份落 backups/ | `secrets.js:386-423,533-542` |

**无 env 变量兜底、无 config.yaml 密钥、无跨用户共享——`request.user.directories` 是唯一定位。**

### 1.2 生成/探测时 key 解析顺序(今天)

```
chat 源(status 与 generate 同序):
  apiKey = body.proxy_password || readProviderSecret(request, KEY) || ''   // openai/mistral/openai_responses/deepseek/xai/moonshot/zai/makersuite/azure*/claude
  apiKey = readProviderSecret(request, KEY)                                 // openrouter/custom/cohere/chutes/electronhub/nanogpt/groq/aimlapi/siliconflow/fireworks/cometapi/perplexity
  apiKey = readSecret(directories, KEY, body.secret_id)                     // pollinations/workers_ai/minimax(直读,绕开 secret_id→active 回落)
```
- 证据:`endpoints/backends/chat-completions.js:562-634,689-691,874`;`luker-dispatch/providers/chat-completions/openai-compatible.js:239-688`(每源一行);`luker-dispatch/context.js:137-164`(`ctx.secrets.read` = 同一漏斗,secret_id→active 回落)。
- `/api/utopinn/connection/test` + `/api/utopinn/models` 走同一解析:`plugins/utopinn-connection.js:130-239`。
- `body.secret_id` 选"连接槽位"(connection profile 概念,secrets.js:505-527)。

**结论:优先级今天是 `proxy_password(请求显式) > secret_id 指定槽 > 本人 active`——没有"服务端共享"第四层。**

### 1.3 客户端写入路径

| 面 | 写入位置 | 位置 |
|---|---|---|
| web 连接段 | `PUT /api/utopinn/secrets/:key`({value,label?})→ 本人 secrets.json,应答不回显明文 | `apps/web/src/api/secrets.ts:26-34`;`utopinn-library.js:1484-1505` |
| web 连接 UI | source pills(openai/deepseek/claude/custom)+ Base URL(PATCH settings.oai_settings)+ key 输入行 | `apps/web/src/components/shell/Overlays.tsx:786-999` |
| mobile/CLI | `client.library.secrets()/secret-set/secret-delete` → 同 /api/utopinn/secrets | `packages/api-client/src/library.ts:232-249` |
| 连接参数 | `oai_settings.{chat_completion_source,reverse_proxy,base_url,custom_url,{source}_model}` 存 settings.json | `utopinn-generate.js:763-794`;`Overlays.tsx:802-829` |

### 1.4 已有的安全边界(可直接复用)

- `sanitizeSettingsDoc`:settings GET 自动剥 `api_key*/*secret*/*password*/header` 形字段(`utopinn-library.js:447,473`)——settings 永不回显 key。
- debug-export 全文 redact:`sk-*`/`Bearer`/`api_key|token|secret|password`/`eyJ*`/hex40+(server-main.js:583-597)。
- user backup 只打 `directories.root` 内文件(`users.js:1378-1445,1480+`),`<dataRoot>/_shared/` 天然不进包。
- CardApp/TH/panel ctx 无 secrets 通道(`packages/protocol/src/panels.ts:23-156` PANEL_METHODS 无 secrets;`utopinn-th.js`/`panel-shim.js` 零命中)。
- quota 只管存储字节(users.js:1163-1200)——**不计量 token 消耗**,共享 key 滥用目前只能靠自觉 + 事后看供应商账单(flag)。

### 1.5 ⚠️ 一个现存坑:proxy_password 会明文落盘

`proxy_password` 在 `CONNECTION_KEYS` 里(utopinn-generate.js:266-274),连接层 `oai_settings` 原样持久化 → **若有人在连接配置里填 proxy_password,它以明文躺在 settings.json**。settings GET 已脱敏,但备份/inspect 能看到。共享 key 方案绝不能再走 settings 通道;用户 BYOK 也应引导进 secrets(现 UI 已是如此)。

## 2. 设计

### 2.1 存储:服务端共享 secrets 档

复用 `SecretManager`,零新代码骨架:

```
<dataRoot>/_shared/secrets.json          # SecretManager({root:'<dataRoot>/_shared'})
```
- `_shared/` 与 `_storage`/`_uploads`/`_errors` 同风格,属"实例级"目录,不入任何 user backup。
- 条目结构在现有 `{id,value,label,active}` 上加 ACL 字段:
  ```json
  {"api_key_deepseek":[{"id":"…","value":"sk-…","label":"宿主共享","active":true,
    "share":{"mode":"all|handles|none","handles":["friend-a","friend-b"]}}]}
  ```
  - `mode:'all'` 全体 handle 可用;`'handles'` 白名单;`'none'`(缺省)= 仅 admin 自用(等价"宿主私钥放共享档,但不开放"——不推荐,admin 自己的 key 还是放自己 handle 档,共享档只放"打算共享"的 key)。
  - 内嵌 share 字段而非单独 ACL 文件:原子写沿用 `writeFileAtomicSync`,单文件单事实源。

### 2.2 解析优先级(收口为一个 resolver)

新增 `resolveProviderSecret(request, key)`(放 `endpoints/secrets.js`,与 readProviderSecret 相邻):

```
1. secret_id 指定槽(本人档;命中即用,未命中继续)      ← 现 readProviderSecret 语义
2. 本人档 active                                        ← 现 readSecret 语义
3. 共享档 active 且 share.mode 允许本 handle              ← 新增兜底
4. ''                                                   ← 未配
```
- **`proxy_password` 仍在各 provider 调用点保持最优先**(它是显式 per-request BYOK/代理密码,语义不该被共享档遮蔽)。
- 落地位置:`ctx.secrets.read`(context.js:152-163)改调 resolver —— 一处改动覆盖 generate 全 dispatch;`chat-completions.js` /status、`utopinn-connection.js`、multimodalModels、`text-completions`/`kobold`/`novelai`/sd providers 里所有 `readProviderSecret`/`readSecret(directories, KEY)` 逐点替换为 resolver。
- **绝不能把兜底塞进 `readSecret` 本身**:`getCsrfSecret`(users.js:756-760)也走它,csrfSecret 必须 per-user;STORAGE_KEYS 类内部 key 不经过 provider resolver,天然安全。
- `migrateFlatSecrets`/`getCsrfSecret`/backup 等读的是 `SecretManager(directories)` 实例,与共享档是不同 root,零串扰。

### 2.3 管理面(admin-only,挂 users-admin.js 或新 endpoints/shared-secrets.js)

全 POST、`requireAdminMiddleware`,风格与现 admin 路由一致(204/JSON):

| 路由 | 语义 |
|---|---|
| `/api/users/shared-secrets/list` | `{items:{key:[{id,label,active,masked,share}]}}` —— masked 用现 `getMaskedValue`,admin 也不回明文(查看走 connection/test) |
| `/api/users/shared-secrets/write` | `{key,value,label?}` → `{id}`;key 限 VALID_SECRET_KEYS 白名单 |
| `/api/users/shared-secrets/delete` | `{key,id}` → 204 |
| `/api/users/shared-secrets/rotate` | `{key,id}` → 204(切 active) |
| `/api/users/shared-secrets/visibility` | `{key,id,mode:'all'\|'handles'\|'none',handles?[]}` → 204;mode 与值原子落档 |
| `/api/users/shared-secrets/promote` | `{key,id}` 把**调用者自己** secrets.json 里的某条复制进共享档(不删原条;原条仍在 → 用户侧优先,行为无缝) |

### 2.4 普通用户可见面(只报"可用/不可用",永不回明文)

- `GET /api/utopinn/secrets` 响应扩展:
  ```json
  { "secrets": {…同今…},
    "shared":  {"api_key_deepseek": {"label":"宿主共享","active":true},
                "api_key_openai":   null } }
  ```
  只含「本 handle 可用的共享条目」的 label/active;**不回 masked value,不回 id,不回 handles 名单**(掩码也是信息,私有部署给布尔就够)。
- `POST /api/utopinn/connection/test` 与 `GET /api/utopinn/models` 响应加 `credential:'user'|'shared'|'proxy'|'none'` —— web 连接段据此显示「走你的 key / 走服务端共享 / 未配」。探测本身不需要新参数。
- web 连接段改动:secret 行在无本人 key 但 shared 可用时显示「服务端已提供」徽标;输入框仍可写本人 key 覆盖(写后 credential 变 'user',自然表达优先级)。

### 2.5 安全边界(硬约束,写进验收)

1. **共享明文永不离开进程**:不设 /view /find 等价物;admin list 也只见掩码;唯一"验证"通道是 connection/test 的连通性结果。
2. **ACL 在 resolver 服务端判**,不在读面判——否则用户手填 `chat_completion_source` 就能蹭未开放给自己的 key。
3. **共享档不进**:user backup(目录外,天然)、debug-export(文件外,天然;redact 仍兜底)、settings doc、CardApp ctx、`/api/secrets/*` legacy 面(它绑 request.user.directories,够不到 _shared)。
4. **admin 私钥 ≠ 共享档**:宿主自己的 key 继续放 default-user/secrets.json;共享档只放"有意开放"的 key。promote 动词是显式动作,不会误共享。
5. `allowKeysExposure` 不扩展到共享面——它只松本人档 /view /find,共享面根本不实现明文读。
6. 速率:本期不做 token 计量;私有部署靠自觉。后续若要,可在 job 完成处按 handle 累计 usage(usage 字段已在 normalizeClaudeUsage 等处可用)记 shared-key 消耗表。

### 2.6 数据迁移与回退

- 共享文件不存在 → resolver 第 3 层恒 miss,行为与今天完全一致(零迁移)。
- 宿主已有 deepseek key 在 default-user 档 → admin 用 `/promote` 抬进共享档;原条目保留则宿主继续优先用自己的,删掉则宿主也走共享(等价"只留一份")。
- 用户原本有自配 key → 删掉后透明回落共享,无需提示文案。
- 回退:删 `_shared/secrets.json` 或全量 `mode:'none'` 即恢复今日语义,无 schema 迁移。

### 2.7 实施切片建议(交付顺序)

1. resolver + `_shared` 档 + visibility 判定(纯服务端,行为不可见但已生效)——配 admin 最小写面(write/delete/visibility/list)。
2. `/api/utopinn/secrets` shared 布尔 + connection/test credential 字段 → web 连接段徽标。
3. promote 动词 + admin UI「共享密钥」段(复用 admin.ts 的 adminPost* 模式 + features/admin.tsx users 段旁新增 section)。
4.(可选)shared-key 按 handle 的 usage 计量表。
