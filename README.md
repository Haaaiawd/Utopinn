# Utopinn

服务端大脑 + 薄客户端的 Tavern 重构:SillyTavern/Luker 的 prompt 组装、世界书、宏、
变量、MVU、CardApp 兼容层全部收进服务端;浏览器/手机/CLI 只消费同一份
REST+WS 协议。API key 只在服务端。

## 架构

```
浏览器 UI(apps/web)   手机端(apps/mobile)   utopinn CLI(apps/cli)
        │                    │                    │
        └──────────── REST + WS(共享 protocol)──┘
                          │
                  Cordis 内核(apps/server)
        ┌──────────┬───────────┬──────────┐
        │ library  │ generate  │ delivery │  插件域
        │ mvu/th   │ diag      │ import   │  ~70+ HTTP 路由
        └──────────┴───────────┴──────────┘
                          │
        存储引擎(fs/mysql/pg,per-user 隔离)+ CAS/JSON-Patch
```

- **服务端权威**:prompt 组装/世界书注入/宏与正则管线/变量与 MVU 结算/CardApp+TavernHelper 桥/IzumiEdit 结构化块解释,全在内核
- **CLI 是协议参考客户端**:每个服务端能力都有具名动词(`doctor` 自证)
- **前端是壳**:Cordis 式贡献点组织(nav.rail/sidebar.tree/stage.form/panel.type),桌面+移动双形态
- **CardApp 协议三端共享**:`packages/protocol` 的 `ctx.*/th.*` wire + `api-client` 的 PanelBridge——web iframe/移动 WebView/CLI headless 同一套授权与校验

## 多账号

Luker 底子自带多账号基建,开 `enableUserAccounts` 即可:

- 注册/登录/admin 管理面;SPA 自带 `LoginGate`(会话过期原地登录,OAuth 走 /login)
- 聊天/预设/secrets/变量/jobs/chat_state **按 handle 主键级隔离**,WS 订阅与任务归属绑 handle
- `enableUserAccounts` 开之前,**人人是 admin**——对外开服必须先开它

## 连接档案(取代单源槽)

`oai_settings.connection_profiles[]` —— 一等公民的多份连接配置:

- 默认档 + 任意新增;每档选 OpenAI 兼容或 Anthropic 格式
- 预设供应商(DeepSeek 等)或自定义 endpoint;key 存服务端 secrets 池(`secretId` 指针)
- 测试探测真实端点 → 拉模型清单 → 勾选入可用集
- 聊天框选择器 = 所有已存档的启用模型并集;生成派发由服务端统一解析 profile→覆盖袋
- 旧单槽配置自动迁移(仅可映射的 source),迁移不掉的走 legacy 兜底,不丢数据

## 共享卡库

`<dataRoot>/_library/characters/` —— 实例级只读卡池:

- 列表/详情合并「私有 + 池」双源,同名私有遮蔽;`shared` 徽标
- 任何写操作(PATCH/世界书/改名/regex)**先物化**:字节级拷入用户目录再改,撞干名 `Foo→Foo1`
- 符号链接 realpath 监禁、配额闸、state sidecar 不混进卡列表、池更新自动重解包 CardApp 资产
- 运行时数据(聊天/变量/secrets)永远 per-user,不出共享域

## 生成链路特性

- **IzumiEdit 吸收**:楼层落库时解释 `新建/追加/前置/重写/替换/开启/关闭/删除/隐藏楼层` 九操作 → chat_state 信息库 → `<KonataExtraInformation>` 回注 prompt(depth 4);隐藏楼层从楼层与 WI 双侧剔除;幂等指纹防重放
- **STscript**:`/inject` 族(ephemeral 在生成终态 CAS 消费)、文本/匹配/power-user/会话生命周期命令;用户正则有 ReDoS 护栏
- **群聊**:问候播种(talkativeness/group_only_greetings 挑选+原子落库)、队链、regen 剥批、CJK 头
- **正则管线**:预设 display 正则真跑(渲染时投影,正典存原文,swipe 不失真)

## 部署速查

### Docker(推荐路径)

```bash
docker compose up -d        # 构建 + 起服
docker logs utopinn         # 拿一次性凭据:user: default-user / pass: <首启自动配的随机密码>
# → http://127.0.0.1:8000 登录后立刻改密
```

- `./data` 单卷全状态:`config.yaml`/账号/卡/聊天/secrets/共享卡库——**备份此目录=备份一切**
- 首启自动播种 `config.yaml`(容器友好默认:`dataRoot:/data`、`enableUserAccounts:true`、`whitelistMode:false`、`browserLaunch` 关);端口只绑 `127.0.0.1`,公网走前置 TLS
- 账号默认即开:内核闸刀检测到无防护 listen 会拒起;账号体系是最小防护面。`default-user` 首启自动配随机密码打在日志里(**只在首次出现,改密后不再打印**)
- compose 附注释掉的 Caddy 块 + `docker/Caddyfile.example`(`{$DOMAIN}` + `reverse_proxy app:8000`),取消注释即 `https://<域名>`
- 账号恢复/设密:`docker exec -u node utopinn node /app/apps/server/recover.js <handle> <新密码>`

### 裸机

```bash
pnpm install
pnpm --filter "./packages/*" -r build    # packages 的 dist 是 gitignored 产物,首装必跑
pnpm --filter @utopinn/web build          # SPA,内核按 apps/web/dist 同源挂载
cd apps/server
LUKER_SKIP_WEBPACK=1 node server.js --dataRoot <原生盘数据目录> --port 8000 --listen
```

配置文件与数据根是两件事:`config.yaml` 默认落在 `apps/server/config.yaml`(启动即 `process.chdir(serverDirectory)`;`--configPath` 可另指),`--dataRoot` 只定数据根(账号/卡/聊天/secrets/插件 patch)。裸机改配置就编辑 `apps/server/config.yaml`;docker 是 CMD 显式 `--configPath /data/config.yaml` 才把配置也收进数据卷。

### config.yaml checklist(裸机:`apps/server/config.yaml`;docker:`/data/config.yaml`)

| 项 | 值 | 说明 |
|---|---|---|
| `enableUserAccounts` | `true` | **对外开服必须先开**——关掉时人人是 admin,无任何隔离 |
| `whitelistMode` | 见下 | 与反代组合有坑(#39),三种自洽形态选一,别混搭 |
| `basicAuthMode`/`perUserBasicAuth` | 视部署面 | SSO/前置认证场景用 |
| `dataRoot` | 云机原生盘 | docker 下固定 `/data`(种子配置已写好) |

### 反代 × whitelistMode(#39)

`whitelistMode:true` 会同时校验 socket IP 和(`enableForwardedWhitelist:true` 时)`forwardedHeaders` 声明的真实 IP:反代后 socket IP=代理地址(能过),`X-Forwarded-For`=访客公网 IP(不在默认白名单)→ **全站 403,连 SPA 和登录页都渲染不出**。三种自洽形态:

| 形态 | 配置 | 适用 |
|---|---|---|
| 直连 + 应用层白名单 | `whitelistMode:true`,白名单写访客真实 IP | 无反代;socket IP 即真实 IP |
| 反代 + 边缘 ACL(**推荐**) | `whitelistMode:false`;IP 白名单在 Caddy/cloudflared 做 | docker 首启播种即此形态;过滤职责归边缘,应用层只看账号体系 |
| 反代 + 应用层白名单 | `whitelistMode:true` + `forwardedHeaders.xForwardedFor:true` + 白名单写**访客真实 IP** | 要在应用层限流/日志记真实 IP 时;**必须保证应用端口只有代理可达**,否则伪造 XFF 即可绕过 |

边缘 ACL 样例(`docker/Caddyfile.example` 已带注释版):

```caddy
{$DOMAIN} {
    @blocked not remote_ip 203.0.113.7 10.0.0.0/8
    respond @blocked 403
    reverse_proxy app:8000
}
```

### 首次登录与建号(#40)

`enableUserAccounts:true` 只开多账号隔离,**不开放注册**(`accountRegistration.enabled` 默认 false,admin 面板可开)。首个 admin 凭据按部署路径分两种:

- **Docker**:种子配置已开账号。首启内核检测到 `default-user` 是「无密码 admin + 无其他防护」,**自动配随机密码打 stderr**(`docker logs utopinn` 拿,只出现一次)→ 登录 → 立刻改密。
- **裸机**:手动开 `enableUserAccounts` 时同样触发自动配密;但若账号开着、白名单/basicAuth 也开着(闸刀跳过配密路径),`default-user` 保持出厂**空密码**——#38 修复落地前**任意密码都能登它**,必须手动设密:
  - SPA/admin 面改密,或 `POST /api/users/change-password`
  - `cd apps/server && node recover.js default-user <新密码>`(容器里:`docker exec -u node utopinn node /app/apps/server/recover.js default-user <新密码>`;recover.js 从 `./config.yaml` 读 dataRoot,容器 WORKDIR=/data + 种子 `dataRoot:/data` 已对齐)

之后再给朋友建号,两条路:

1. **admin 面板**:`default-user` 登录 → 管理面建号。一律 `admin:false`;`password` **必填**——漏掉会造出空密码账号(#38 同款坑)。
2. **API**:admin 会话下 `POST /api/users/create`,body `{"handle","name","password","admin"}`。注意路径是 `/api/users/create`(不是 `/api/users/admin/create`);非 GET 走 CSRF——先 `GET /csrf-token` 拿 token,之后请求带 `X-CSRF-Token` 头 + 会话 cookie。

### 运维备忘

- **TLS 必做**(secure cookie + 移动端都要):Caddy 或 `cloudflared` 免费隧道均可
- web SPA 由服务端同源挂载,手机浏览器直接开 `https://<域名>` 即玩,无需装包
- 每人各管各的连接档案与 key(`secretId` 隔离);管理员可投共享 key 到 `_shared` 层
- 共享卡往 `<dataRoot>/_library/characters/` 一丢全实例可见,编辑自动物化不污染池
- 配置项也认 `LUKER_*`/`SILLYTAVERN_*` 环境变量(如 `LUKER_WHITELIST_MODE`),但 `config.yaml` 才是持久事实源
- scratch/dataRoot 别放高延迟挂载盘(WSL `/mnt` 9P 会楔死,见 AGENTS.md)

## CLI 速览

```bash
node apps/cli/utopinn-cli.mjs doctor            # 链路体检(含路由覆盖率)
utopinn use <卡名>                              # 绑卡(无聊天不隐式建)
utopinn chat-new main && utopinn send "…"       # 聊天+生成
utopinn swipe / regen / continue / abort        # 生成系
utopinn th getVariables / insertOrAssignVariables
utopinn mvu state|settle|panel                  # MVU 面
utopinn state chat|char|preset <op>             # sidecar 三族(CAS)
utopinn logs / errors / trace <jobId>           # 观测面
utopinn schema                                  # 全动词清单
```

## 布局

```
apps/server    内核:Express + Cordis 插件 + 存储引擎(public/ 旧 jQuery UI 过渡保留)
apps/cli       utopinn-cli.mjs 单文件协议参考客户端
apps/web       SPA 壳(Vite+React19+Tailwind4+Radix),移动形态:sheet/抽屉/键盘适配
apps/mobile    Expo/React Native 薄客户端(连接/认证/流式/阅读器/CardApp WebView)
packages/core  大脑:世界书/宏/instruct/MVU/STscript 纯 TS 引擎
packages/protocol   线协议:API 类型+WS 帧+面板契约(ctx/th/MSGFRAME 授权集)
packages/api-client typed REST/WS 客户端+共享 PanelBridge
packages/panel-shim CardApp 沙箱内运行时(TH 兼容面)
.skeinn/        决策/设计/任务账本(DECISIONS·design/·tasks.json)
tests/          兼容语料+golden-diff+utopinn-acceptance 验收矩阵
```

## 状态

- 验收:`node apps/server/tests/utopinn-acceptance/run.mjs`
- 掌门卡(复杂 CardApp+TH 脚本)实测:send/swipe/th 变量/state/izumi 全链通
- 多账号端到端隔离:`node --test apps/server/tests/multi-account-isolation.test.mjs`(14 断言,真起服双 session)
- 共享卡库:`node --test apps/server/tests/shared-library.test.mjs`(25 断言)
- 环境备忘:WSL 下 `/mnt` 盘高并发 I/O 会楔死 9P——`--dataRoot` 放原生盘,
  dev 服(chokidar)别和后端抢通道,详见 `AGENTS.md`
