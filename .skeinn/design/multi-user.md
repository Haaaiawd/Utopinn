# 多用户(私有部署):现状证据 + 差距 + 推荐方案

- Kind: design / system
- Status: draft v1(调研完成,未实现)
- 缘起:宿主想把服务开给同学用(LAN/私网部署,非公网 SaaS)。需要多账户 + 数据隔离。
- 结论先行:**服务端多用户栈已完整继承 Luker/ST,不需要造。要补的是薄客户端登录动词、SPA 登录页、以及「开关怎么翻」的操作路径。**

## 1. 现状证据(文件:行)

### 1.1 账户模型与目录隔离

| 证据 | 位置 |
|---|---|
| `ENABLE_ACCOUNTS = getConfigValue('enableUserAccounts', false)` 模块加载期定死 | `apps/server/src/users.js:31` |
| `DEFAULT_USER = {handle:'default-user', admin:true, enabled:true}` | `apps/server/src/constants.js:73-81` |
| `USER_DIRECTORY_TEMPLATE`:root='' + 26 个子目录(characters/chats/worlds/secrets 等) | `apps/server/src/constants.js:34-67` |
| `getUserDirectories(handle)` → `<dataRoot>/<handle>/<subdir>`,带缓存 | `apps/server/src/users.js:781-795` |
| 账户 store:node-persist @ `<dataRoot>/_storage`,key=`user:<handle>` | `apps/server/src/users.js:29,654-668` |
| 首启无用户时自动创建 DEFAULT_USER | `apps/server/src/users.js:664-667` |
| accounts-off:每请求 `request.user = DEFAULT_USER`(隐式 admin) | `apps/server/src/users.js:1078-1085` |
| `isRequestAdmin`:accounts-off → 任何人都是 admin | `apps/server/src/users.js:1323-1328` |

**即:`default-user/` 不是"写死单用户",它是 default-user 这个 handle 的目录;开 accounts 后新 handle 各自拿到 `<dataRoot>/<handle>/` 全套目录(建号时 `ensurePublicDirectoriesExist` + `checkForNewContent` 播种默认 SETTINGS,users-admin.js:924-928)。**

### 1.2 认证链(HTTP)

中间件顺序(`apps/server/src/server-main.js`):
```
helmet → compression → CORS(:245-270)
→ basicAuth(仅 listen&&basicAuthMode 时挂载,:272-274)
→ whitelist IP 白名单(:276-279) → hostWhitelist(:281) → accessLog(:283-285)
→ cookieSession(session-<hostname hash>,secret 存 <dataRoot>/cookie-secret.txt,:287-293;users.js:675-715)
→ setUserDataMiddleware(session.handle→request.user+directories;version 校验,密码变更即踢 session,users.js:1076-1140)
→ CSRF csrfSync(:298-351,豁免 /proxy/* 与 /api/sync/v1/session/*)
→ 公共路由:/api/users(public)、/api/storage(health)、/api/sync/v1、/card-runtime(:533-553)
→ requireLoginMiddleware(:556;无 request.user → 403)
→ enforceUserQuotaMiddleware(:557;写路径配额,users.js:1148-1200,前缀表 :37-64)
→ bodyParser 500mb(:566) → 全部私有路由(server-startup.js:64-179)
```

| 机制 | 位置 | 状态 |
|---|---|---|
| `POST /api/users/login`(scrypt 校验,限流 5/min,OAuth-only 账户拒密码登录) | `users-public.js:654-713` | ✅ 现成 |
| `POST /api/users/list`(登录页用户清单;`enableDiscreetLogin` 隐藏) | `users-public.js:620-652` | ✅ |
| `POST /api/users/register`(限流;`adminSettings.accountRegistration.enabled` 门控) | `users-public.js:353-420` | ✅ 默认关 |
| `POST /api/users/recover-step1/2`(6 位码打到服务端 console) | `users-public.js:715-816` | ✅ |
| OAuth GitHub/Discord(start/callback,auto-create 可控) | `users-public.js:422-618` | ✅ 默认关 |
| `tryAutoLogin`:单用户无密码自动登录 + Authelia/Authentik SSO 头 + perUserBasicAuth | `users.js:849-895,903-991` | ✅ |
| `GET /login` → `public/login.html`(旧 jQuery 页,恒可服务,不依赖 LUKER_SERVE_LEGACY) | `server-main.js:394` + `users.js:1215-1233` | ✅ |
| `GET /` 未登录 → `shouldRedirectToLogin` → /login | `server-main.js:369-380` + `users.js:838-840` | ✅ |

**注意:`resolveUserFromBasicAuth`(users.js:1002-1036)只被 `basicUserLogin` 经 `tryAutoLogin` 消费,即只在 `GET /login` 路径上把 Basic 头翻译成 session.handle。裸 Basic 头调 API 不会鉴权——薄客户端必须走「先 login 拿 cookie」路径。**

### 1.3 WS / 生成任务隔离

| 证据 | 位置 |
|---|---|
| `POST /api/ws-ticket` 铸一次性 256-bit 票,TTL 30s,绑 `req.user.profile.handle` | `ws-ticket-router.js:22-46,86-92` |
| WS `/api/ws-delivery` upgrade:`Sec-WebSocket-Protocol: luker-ws-ticket.<t>` → `verifyWsTicket` → `ws.userHandle` | `plugins/utopinn-delivery.js:38-46,108-135` |
| 订阅任务经 `getTaskByRequestId(requestId, ws.userHandle)` 按 handle 校验 owner | `utopinn-delivery.js:166-179` + `luker-generation.js:480-489` |
| generationJobs 按 `job.handle` 过滤(list/get/active 全路径) | `luker-generation.js:511-512,1508-1529,1535-1559` |

### 1.4 管理面(admin)与自助面(private)

| 面 | 路由(`POST /api/users/*`) | 位置 |
|---|---|---|
| 生命周期 | `/get /create /delete(purge) /enable /disable /promote /demote /set-quota /slugify` | `users-admin.js:705-994` |
| 总览 | `/overview`(用户+存储字节+配额+security 告警) | `users-admin.js:323-381` |
| 实例设置 | `/settings/get|save`(默认配额/注册开关/OAuth 配置) | `users-admin.js:383-401` + `admin-settings.js:9-36` |
| config.yaml | `/config/get|save`(YAML 校验 + 安全闸:liste 无认证层拒存) | `users-admin.js:403-512` |
| 自助 | `/me /logout /change-avatar /change-password /change-name /backup /restore-backup /lan-migration/* /announcements/me/* /storage/inspect` | `users-private.js:977-1875` |
| 安全启动闸 | listen && 无任何认证层 → exit(1);admin 无密码 → 自动铸随机密码打 stderr | `users.js:182-281` |

Web SPA 已接:`apps/web/src/api/admin.ts`(285-373 全动词)+ `account.ts`(getMe/changeName/changePassword);`features/admin.tsx` i18n 已含 "Login gate ON/OFF" 横幅与 handle 管理文案。

### 1.5 数据隔离度

- **目录级**:characters/chats/groups/worlds/presets(instruct/context/sysprompt/reasoning/novelAI/koboldAI/openAI/textGen)/settings.json/secrets.json/extensions/vectors/themes/backups/user(图片/文件)/thumbnails —— 全部 `<dataRoot>/<handle>/` 下,互不可见。
- **存储引擎**:sqlite = `<handle>/luker-storage.sqlite`;mysql/postgres = 单库 `handle` 列隔离(`default/config.yaml:8-21`)。
- **secrets**:每 handle 独立 `secrets.json`(`endpoints/secrets.js:118-135`)。
- **缓存键**:diskCache/ETag 的 `?account=<handle>` 参数只是隐私校验(characters.js:2444),不是越权通道。
- **card-runtime**:public 面靠不可猜 mountId 能力(server-main.js:546-553),不带 session 权限,天然不跨户。

## 2. 差距(Gap)

| # | 缺口 | 影响 | 证据 |
|---|---|---|---|
| G1 | ~~**薄客户端无 login 动词**~~ **已补(TASK-071)**:api-client 长出 `account` 域 + 真 cookie 罐;mobile session.ts login/logout/me + SecureStore jar;CLI `login/logout/whoami` + 0600 session 档 | 剩余:mobile 登录屏 UI(api 层已通) | `packages/api-client/src/account.ts`;`apps/mobile/src/api/session.ts:260-311`;`apps/cli/utopinn-cli.mjs:1205-1287` |
| G2 | **SPA 无登录页**:依赖 `shouldRedirectToLogin` → 旧 `public/login.html`(jQuery) | 短期接受:auth-expired 条引导去 /login(TASK-071);第一方页仍待另案 | `server-main.js:394`;`public/login.html`;`apps/web/src/App.tsx`(auth-expired bar) |
| G3 | **default-user 仍是 admin 且无密码**;listen+accounts 首次启动会自动铸随机密码打 stderr(安全闸已有),但宿主体验是"密码在日志里" | 首次开放部署的操作摩擦 | `users.js:200-263` |
| G4 | **新 handle 从空目录开始**:朋友的账户看不到宿主的卡/书/预设 | 体验缺口(不是 bug):要么接受(各自导入卡),要么做"播种" | `users-admin.js:924-928` 只播 SETTINGS |
| G5 | 账户开关是**模块加载期常量**,config/save 热更后必须重启进程 | admin UI 改 enableUserAccounts 需重启 | `users.js:31`;users-admin.js:500-504 已标 restartRecommended |
| G6 | HTTP 明文:LAN 可接受,公网/校园网必须 TLS 或隧道 | secret/密码/聊天内容过路明文 | `ssl.enabled:false` 默认;`default/config.yaml:91-100` |

## 3. 推荐方案

### 3.1 部署配置(私有部署推荐基线)

```yaml
listen: true
enableUserAccounts: true       # 主开关
whitelistMode: false           # 同学 IP 不固定就关;固定可留 true + 加段
basicAuthMode: false           # 不需要
perUserBasicAuth: false        # 不需要(cookie+login 更顺)
enableDiscreetLogin: true      # 不向外广播用户清单
sessionTimeout: 604800         # 7 天,-1=400 天也行
securityOverride: false        # 保留安全闸
ssl: 或交给 frp/cloudflared/Caddy 终结
```
改 config 需重启(G5)。admin UI `/api/users/config/save` 有安全闸,不会写出自杀配置。

### 3.2 开户流程(私有部署,不要自助注册)

- `accountRegistration.enabled` 保持 **false**;宿主在管理视图 `/api/users/create` 逐人建号(handle+显示名+初始密码),可选 `set-quota`。
- `default-user`:开 accounts 后仍是首个 admin + 兜底(不可删,users-admin.js:948-950)。**建议宿主给它设密码**(`/api/users/change-password`,或接受首次 listen 启动自动铸密码打 stderr 的路径——能用但糙)。
- 朋友登录:浏览器 → `http://host:port/` → 自动 302 /login(旧 jQuery 页,功能完整)→ handle+密码 → 回 `/` 进 SPA。**短期零开发可用。**

### 3.3 客户端补齐(按优先级)——TASK-071 落地状态

> **已落地(TASK-071,2026-11-22)**:1-3 完成并实弹验证(:18998 隔离实例,
> 双 handle 隔离 + perm-403 保活全过);4 走「legacy /login 兜底 + SPA
> auth-expired 条诚实引导」短路版,第一方登录页仍为后续任务。
> 实现时纠出的隐藏坑:**`/csrf-token` 必须带当前 cookie 去取**(cookie-session
> 把 csrfToken 存 session 内,不带 cookie 就换了匿名 session——perm-403 的
> autoReauth 会把登录态登出)。三家客户端(api-client/mobile/CLI)已同款修法。

1. **api-client 加 account 域**(所有薄客户端受益):
   ```
   client.account.login(handle, password)  // GET /csrf-token(autoSession 已有)
                                           // → POST /api/users/login {handle,password}
                                           // → 响应 Set-Cookie 收入 jar(已有)
   client.account.logout()                 // POST /api/users/logout
   client.account.me()                     // GET /api/users/me
   ```
   要点:login 是 CSRF 保护的 POST —— `fetchCsrfToken` 必须先跑(index.ts:140-152 已有);login 成功后**同一 cookie jar 直接可用**,无需额外动作。403 时 autoReauth 重试逻辑已就位。
2. **mobile**:session.ts 已有 jar + CSRF 轮换;补 login 屏(server URL 已有 SecureStore 持久化,加 handle+password 字段;cookie 也落 SecureStore 免重登)。403→重登录。
3. **CLI**:`utopinn-cli.mjs` 同款握手,加 `--login/--handle/--password` 或交互式 login 子命令。
4. **Web SPA**(中期):`/login` 路由做第一方登录页(POST /api/users/login + 错误态);短期接受 legacy login.html 即可,不阻塞。

### 3.4 数据播种(可选,建议做轻量版)

新账户空库体验冷。推荐 admin 动词而非"共享库"概念:

```
POST /api/users/seed {handle, fromHandle, sections:['characters','worlds','presets']}
```
- 只复制内容资产(characters/worlds/各 presets 目录),**不复制 secrets/chats/settings**(聊天与密钥是私域)。
- 注意 storage engine≠fs 时, chats/settings 等在 DB 里,种子只拷 fs 目录也够(种子本就不该带 chats)。
- 不做也行:朋友各自导入卡更符合"各自的小酒馆"语义。

### 3.5 安全边界提醒

- **accounts-off 时人人 admin**(`isRequestAdmin` users.js:1324)——listen 开给同学前 `enableUserAccounts` 必须 true,否则朋友能读 config.yaml、管插件、看任意 handle 存储。
- recover 流程把 6 位码打到**服务端 console**——私有部署下只有宿主能看到,等于"找宿主要重置码",可接受。
- `/api/users/list` 公开列用户 → `enableDiscreetLogin: true`。
- `session.version` 随密码/salt 变化失效(users.js:1063-1068,1114-1126)——改密即踢全端,自然正确。
- sync(`/api/sync/v1`)是独立 bearer-token 体系,跨设备同步按 handle 作用域,不受 accounts 影响;`/card-runtime` mountId 能力制同理,无需改动。
- 公告 `/announcements`(admin 发,用户 `/announcements/me/*` 收)可当"宿主通知栏"顺手用。

### 3.6 迁移注意

- 现有 `default-user/` 数据零迁移——handle 机制本来就活在,只是开闸。
- 若 dataRoot 里已有手工建的 `<handle>/` 目录但 `_storage` 无 `user:<handle>` 记录 → 该目录不会被认领;admin `/create` 建同名 handle 时会复用目录(ensurePublicDirectoriesExist 幂等),旧数据直接归该账户——可作为"把 default-user 数据迁给新账户"的手工路径:`mv default-user myhandle` + admin create `myhandle`。**但 settings.json/secrets.json 会随之过户,接受即合理。**
- 切换 storage.mode 后这套隔离语义不变(handle 列),无需额外处理。
