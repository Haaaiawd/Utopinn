# 管理面板(Admin Surface):SPA 第五域该管什么

- Kind: design / system(含 experience IA)
- Status: draft v1
- 缘起:apps/web/dist 已由 :8000 直供(SPA=产品主面),但服务端一整套
  admin/账号/同步/存储路由在 SPA 侧零消费——「管理面板」需要一次归位设计,
  而不是在设置模态里继续糊 tab。
- 基线:users.js multi-handle(accounts-off 全请求=default-user)、
  users-admin.js 27+ 管理路由、/api/sync/v1 配对+后端注册表、
  storage 引擎迁移(runner+lock+state)、utopinn-data 的 backup/lan 薄包、
  legacy public/ admin.html 十 tab(参照面,不照搬)。
- 边界:v2-stack-decisions「不造账号系统」;PROJECT.md「个人云为主,
  ST 式多用户隔离沿用不深化」「高级功能仅 web 可见」。

> vs-V2: current

## 0. 定位一句话

**管理面板 = SPA 第五个 rail 域「管理」,管「这台服务器」;设置模态继续管
「我的」。**

判据很简单:设置模态里的每一项(外观/聊天渲染/API 连接/我的账号)换一台
服务器、换一个 handle 都得重设;管理域里的每一项(handle 表/config.yaml/
存储引擎/备份/配对后端/服务插件)是实例级、跟着这台服务器走。ST/Luker 也是
这么切的(user settings vs admin panel),我们只是把它在新壳里补上。

## 1. 现状盘点:SPA 的"管理"都散在哪

| 面 | 位置 | 管什么 | 接线 |
|---|---|---|---|
| 设置·api | SettingsModal tab | 连接源 pills/BaseURL/secrets 脱敏 | secrets 已接;source/baseURL **C1/C2 disabled**(oai 写面不在 PATCH 白名单) |
| 设置·chat | 同上 | 渲染偏好(楼层数/流式帧率/字号/think) | 本地壳态,无服务端面 |
| 设置·appearance | 同上 | 全局背景+自定义 CSS | 本地壳态 |
| 设置·plugins | 同上 | =PluginsSections(cordis 插件三段) | 已接 /api/utopinn/plugins |
| 设置·diagnostics | 同上 | 仅两个链接→diag/stats 板块 | — |
| 设置·account | 同上 | **stub 占位**(写死 haa@local) | 未接,应接 /api/users/me |
| plugins 视图 | rail 4 | cordis profile 插件启停/reload/详情 | 已接 |
| studio 视图 | rail 3 | 卡库/全局书/世界书/预设/persona/regex | 部分接(预设/世界书/persona 写面在) |
| diag/stats 板块 | 工作台 panel | jobs/trace/errors/logs、生成统计/WI 命中 | 已接 |
| 导入 overlay | 拖放 veil+模态 | 卡/书导入 + ST 目录扫描 | 已接 /api/utopinn/import/* |

**结论:SPA 现在管的是"内容"与"我的偏好",实例级管理为零。**
`apps/web/src/api/*` 只调 `/api/utopinn/*` + `/api/chats/append`;
`/api/users`、`/api/sync/v1`、`/api/storage`、`/api/backups`、
`/api/assets`、`/api/backgrounds` 在 SPA 侧没有一个调用点。

## 2. 服务端管理面全量盘点(已备,SPA 零消费)

全部 `requireAdminMiddleware`;accounts-off 时 default-user 天生 admin,
即**这些路由今天就能被 SPA 直调**,登录门只是后续形态。

### 2.1 实例与账号(/api/users,admin 族,全 POST)

| 路由 | 语义 |
|---|---|
| `/overview` | 聚合首页:server(node/uptime)+totals(用户/启用/admin/总字节)+security(admin 无密码/disabled 名单)+adminSettings |
| `/get` | handle 清单(avatar/name/admin/enabled/password/quota/oauthProviders) |
| `/create` `/delete` `/enable` `/disable` `/promote` `/demote` `/slugify` | handle 生命周期;delete 支持 `purge` 连数据目录一起清 |
| `/set-quota` | 单 handle 存储配额(字节,-1/空=无限) |
| `/settings/get` `/settings/save` | admin settings:新用户默认配额、注册开关、GitHub/Discord OAuth 配置 |
| `/config/get` `/config/save` | config.yaml 原文读写;save 内置 YAML 校验+**安全闸**(listen 无认证、双栈全关会拒存) |
| `/import/config` `/import/global-extensions` | 上传 config.yaml 覆盖 / zip 装全局扩展 |
| `/plugins/list|install|update|install-dependencies|delete` | **Luker server plugins**(plugins/ 目录,git 装,enableServerPlugins 开关,装完建议重启)——与 cordis 插件是两套体系 |
| `/storage/status|migrate|migrate/reset|inspect-any` | 引擎状态/迁移(fs/sqlite/mysql/postgres,带 lock+断点续跑)/任意 handle 存储浏览 |
| `/logs/get` `/logs/clear` | 进程内捕获日志(log-capture.js,区别于 diag 事件总线) |
| `/update/status|start|apk-latest|desktop-latest` | git 更新检查/执行/最新 release |
| `/announcements/list|create|update|delete` | 全站公告(info/warning/critical) |

### 2.2 当前 handle 自助(/api/users,private 族)

| 路由 | 语义 |
|---|---|
| `/me` `/logout` `/change-avatar` `/change-password` `/change-name` | 账户 dock 该接的;accounts-off 也返回 default-user 视图 |
| `/backup` | 数据类目勾选 → ZIP 流式下载(=utopinn/backup 同源) |
| `/restore-backup/probe|uploads|chunks|finalize|执行` | ZIP 恢复管线(探测→分片上传→执行,支持进度流) |
| `/lan-migration/offer` `/lan-migration/import` | 一次性搬家链接(10min TTL)→ 对端拉 ZIP 恢复;utopinn/lan/* 是薄包 |
| `/import/data-zip` `/reset-settings` `/reset-step1|2` | 数据包导入/自助重置 |
| `/storage/inspect` | 自己 handle 的存储浏览(admin 有 inspect-any) |
| `/announcements/me/list|mark-read` | 公告消费(账户 dock 小红点) |

### 2.3 多设备同步(/api/sync/v1,注册表面全备)

`session/*` 是 peer 协议(token 闸,不做 UI);下面这些是为 UI 准备的
本地注册表路由——**服务端已写明"for the LAN Sync UI",SPA 还没接**。

| 路由 | 语义 |
|---|---|
| `GET /health` `GET /availability` `GET /categories` | 协议版本/可用性/可同步类目(characters/chats/worlds/card-apps/presets/instruct…15+ 类) |
| `POST /pair/start` | 生成配对链接+一次性 pairCode(带 candidateBaseUrls 供选可达地址) |
| `POST /pair/accept` | 消费对端链接:健康检查→offer 换 durable secret→首同步 |
| `GET /backends` `POST /backends/:id` `DELETE /backends/:id` `DELETE /backends/:id/auth` | 后端清单(LAN peer/S3)/改类目/移除/清凭据 |
| `POST /backends/:id/sync` `POST /backends/:id/undo` | 手动同步/回滚上次 |
| `GET /status` `POST /conflicts/resolve` `POST /notices/dismiss` | 运行态+冲突+通知 |
| `POST /schedule` `GET /device` `POST /backends/s3|/backends/:id/s3|unlock` | 调度/本机设备名/S3 后端 |

### 2.4 其余散落面

| 面 | 路由 | 判定 |
|---|---|---|
| 存储健康 | `GET /api/storage/health`(公共) | 总览区取数 |
| 聊天自动备份 | `POST /api/backups/chat/{get,delete,download}` | 备份区二级 |
| 用户资产 | `/api/backgrounds/*` `/api/assets/*` `/api/files/*` | 资产区 |
| 孤儿媒体/数据巡检 | `/api/media/*` `/api/data-maid/*` | 资产区 |
| 全局 third-party 扩展 | `/api/extensions/*`(install/update/delete/discover) | 资产区只读陈列——**V2 已拍板 legacy 前端扩展不兼容**,只给文件管理不给启用语义 |
| 版本 | `GET /version` `POST /api/system/update-check` | 系统区 |
| 连接测试/模型清单 | `/api/utopinn/connection/test` `GET /api/utopinn/models` | **服务端已备,SPA C1/C2 未接**——归设置·api,不归 admin |
| renderer 捕获 | `/api/debug/capture`(isAdmin 门) | diag 面附属,不进 admin |

## 3. 缺口清单(逐域判定:路由?SPA?归谁管?)

| 域 | 服务端 | SPA | 归位 |
|---|---|---|---|
| 多 handle 账号 | 全备(§2.1) | 零 | **admin·账号区** —— 用户点名诉求 |
| 我的账号 | /me+change-* | stub | 设置·account tab 接真,不进 admin |
| config.yaml | 全备+安全闸 | 零 | **admin·配置区** |
| admin settings(配额默认/注册/OAuth) | 全备 | 零 | admin·配置区访问桶 |
| 存储引擎+迁移 | 全备(含只读闸/断点/锁) | 零 | **admin·存储区** |
| 备份/恢复 | 全备(ZIP 类目+分片) | 零 | **admin·备份区** |
| LAN 搬家 | 全备(offer+import) | 零 | admin·备份区 |
| ST 迁移 | scan-st 已接 | 导入 overlay 有 tab | 保持原位,admin 只给入口链 |
| LAN 配对+同步后端 | 全备(§2.3) | 零 | **admin·同步区** |
| cordis 插件 | 全备 | plugins 视图已接 | 不动;admin 只挂入口 |
| Luker server plugins | 全备 | 零 | **admin·服务插件区** |
| 观测 diag/stats | 全备 | 板块已接 | 不动;admin 总览只链回 |
| 连接/secrets | 全备 | 设置·api 半接(C1/C2) | 设置·api 补接,不进 admin |
| 背景/用户资产/文件 | 全备 | 零 | admin·资产区 |
| 全局 third-party 扩展 | 全备 | 零 | admin·资产区(只读陈列) |
| 服务端日志 | 全备 | 零(diag logs 是事件总线,非进程日志) | admin·系统区 |
| 版本/更新 | 全备 | 零 | admin·系统区 |
| 公告 | 全备 | 零 | admin·系统区写;账户 dock 读 |
| settings 写面白名单缺口 | —— | C1/C2/C3/C7 标记在 | **不是 admin 的事**:oai/globalSelect/preset 默认的 PATCH 白名单是 utopinn settings 插件的账,别借 admin 绕道 |

## 4. 形态拍板:admin 是 rail 第五域,不是设置模态第七 tab

候选形态对比:

- **设置模态加 tab** —— 否。模态是 760px 两栏小窗,塞得下偏好塞不下
  账号表格/迁移进度/存储浏览器;且语义上设置模态=「我的」,admin=「这台
  服务器的」,混在一个模态里用户会以为这些是跟着浏览器走的。
- **独立页(/admin 路由)** —— 否。壳的贡献点体系就是干这个的
  (nav.rail/view/sidebar.tree 三件套注册即成域,与 studio/plugins 同权),
  独立页要重造 i18n/chrome/弹层宿主,纯浪费。
- **并进 plugins 视图改名「系统」** —— 否。cordis 插件是高频运营面,
  admin 是低频部署面;且 server plugins 区放进 plugins 域会和 cordis
  插件视觉混淆(两套体系名字就撞)。

**拍板:rail order 50「管理」(view:'admin'),复刻 studio 域结构——
sidebar.tree 贡献分区索引,view 体按 adminNav 状态切分区。** 移动端不
出现该 rail 项;直达时落 `mob.view.noMobile` 占位(高级功能仅 web 可见,
PROJECT.md 边界;移动端管理需求=连上就行,不做)。

```
┌──┬──────────────┬──────────────────────────────────────────────┐
│r │ 管理          │ ┌ 总览 ──────────────────────────────────┐  │
│a │ ▸ 总览        │ │ [实例] v0.x · node v24 · uptime 3d      │  │
│i │ ▸ 账号        │ │ [存储] fs · ping 12ms · 可写            │  │
│l │ ▸ 服务端配置   │ │ [账号] 3 handle · 2 启用 · ⚠1 admin 无  │  │
│  │ ▸ 存储        │ │        密码                             │  │
│  │ ▸ 备份与搬家   │ │ [同步] 0 后端 · 未配对                  │  │
│  │ ▸ 多设备同步   │ │ [备份] 上次 ZIP 2026-11-20             │  │
│  │ ▸ 服务插件    │ └──────────────────────────────────────────┘ │
│  │ ▸ 资产清理    │  ── 桶:实例 / 访问 / 数据 / 扩展 ──          │
│  │ ▸ 系统        │  侧栏分组:总览;账号·服务端配置;存储·备份   │
└──┴──────────────┴──与搬家·同步·资产;服务插件·系统──────────┘
```

侧栏九区按四桶排,不是平铺:

| 桶 | 区 | 一句话 |
|---|---|---|
| 实例 | 总览 | 这台服务器现在的状态一眼面 |
| 访问 | 账号 / 服务端配置 | 谁能进、进成谁、实例怎么配 |
| 数据 | 存储 / 备份与搬家 / 多设备同步 / 资产清理 | 数据在哪、怎么保命、怎么流动 |
| 扩展 | 服务插件 / 系统 | Luker 兼容扩展装载器;日志·更新·公告 |

## 5. 分区设计

每区给「管什么 / 区块表 / 关键路由 / 复用件」。**九区不等于九个新页面:**
账号表、YAML 编辑、类目选择器、配对向导是仅有的四个有分量的组件,
其余是 inset-group 行集。

### 5.1 总览 Overview(默认落点)

```
┌ 实例卡 ──────────────┐ ┌ 存储卡 ──────────────┐ ┌ 账号卡 ──────────────┐
│ Utopinn v0.x         │ │ 引擎 fs(建议 sqlite)│ │ 3 handle · 2 启用    │
│ node v24.x · linux   │ │ ping 12ms · 可写      │ │ 存储 13.7GB / ∞      │
│ uptime 3d 4h         │ │ 数据根 ./data         │ │ ⚠ admin 无密码 ×1    │
└──────────────────────┘ └──────────────────────┘ └──────────────────────┘
┌ 待办(security+notice 聚合)───────────────────────────────────────────┐
│ ⚠ listen 公网但无认证层 —— 去 服务端配置 ▸ 访问                        │
│ ⚠ 从未备份 —— 去 备份与搬家 ▸ 下载 ZIP                                │
│ ℹ 未配对同步设备 —— 去 多设备同步 ▸ 配对                              │
└───────────────────────────────────────────────────────────────────────┘
```

- 数据:`POST /api/users/overview`(一把梭)+`GET /api/storage/health`
  +`GET /version`+`GET /api/sync/v1/status`。
- 待办条 = overview.security 名单 + sync notices + 「上次备份」前端本地记。
- 复用:`inset-group`/`WiredBadge` 样式;每条待办是 `adminNav` 深链。

### 5.2 账号 Users

```
┌ 账号 ─────────────────────────────────────────────────────────────────┐
│ [+ 新建 handle]                        3 handle · 2 启用 · 1 admin      │
│ ℹ 未开登录门(enableUserAccounts=off):所有流量=default-user;           │
│   建 handle=预建隔离数据空间,经登录门或 perUserBasicAuth 触达 —— 配置▸ │
│ ┌──────────────────────────────────────────────────────────────────┐  │
│ │ ● default-user  admin·启用·当前  🔒无密码   12.4GB/∞   2026-11-02  │  │
│ │   haa ── 操作带:改名│配额│降权│改密│备份│(default 不可删)         │  │
│ │ ○ test-dummy    启用             🔑      88MB/2GB ▓▓░░           │  │
│ │ ○ old-alt       已停用           🔑      1.2GB/∞                  │  │
│ └──────────────────────────────────────────────────────────────────┘  │
│ 新建抽屉:显示名 / handle(slugify 实时预览)/ 密码(可空)/ admin 勾选     │
└────────────────────────────────────────────────────────────────────────┘
```

- 数据:`POST /get`(行)+`POST /overview`(配额用量)+行内动作
  `enable|disable|promote|demote|set-quota|create|delete|change-name`。
- 删除二级确认:输入 handle 原文;`purge` 勾选=连数据目录删。
- default-user 不可删/不可停(服务端已闸,UI 置灰给原因)。
- 「admin/启用/密码锁」用状态点不用徽章墙——一行一行的表格,层级靠
  列对齐不靠色块。
- **不做**:handle 切换浏览、代登录、会话管理——那是账号系统,不在边界内。

### 5.3 服务端配置 Config

形态:**访问组做表单(高频+互相牵制),其余全量走 YAML 编辑**。
不逐字段表单化——config.yaml 几十个键,表单化是追不完的漂移;安全闸在
服务端 save 里,表单只是快捷入口。

```
┌ 服务端配置 ────────────────────────────────────────────────────────────┐
│ ┌ 访问(谁能进、进成谁)──────────────────────────────────────────────┐ │
│ │ 公网监听 listen        [○]  ·  白名单 whitelistMode      [●]        │ │
│ │ BasicAuth basicAuthMode[○]  ·  逐用户 perUserBasicAuth   [○]        │ │
│ │ 登录门 enableUserAccounts[○]                                        │ │
│ │ → 当前态:仅本机可达 · 全部流量=default-user                        │ │
│ │   开登录门后:登录页选 handle;配 perUserBasicAuth 时薄客户端可        │ │
│ │   handle:密码直连(手机端进指定数据空间的路径)                        │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌ admin settings ────────────────────────────────────────────────────┐  │
│ │ 新用户默认配额 [____ MB] · 开放注册 [○] · OAuth(GitHub/Discord)▸  │  │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌ 实例 YAML ─────────────────────────────────────────────────────────┐ │
│ │ config.yaml · ./config.yaml                          [重载] [保存]  │ │
│ │ ┌──────────────────────────────────────────────────────────────┐   │ │
│ │ │ <textarea mono 全文>                                          │   │ │
│ │ └──────────────────────────────────────────────────────────────┘   │ │
│ │ 保存即校验;被拒时列出安全闸原因。改后建议重启。                      │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

- 访问组五个开关读写走 `/config/get|save` 的 YAML 解析/回写(前端只改
  这几个键,不全量重组),互斥提示靠「当前态」一行推导文本,不做联动禁
  逻辑——服务端安全闸兜底。
- admin settings(配额默认/注册开关/OAuth)走 `/settings/get|save`,
  OAuth 字段收进折叠组(个人云大概率用不到,别糊脸)。
- 数据:`/config/get|save`、`/settings/get|save`。
- **公网暴露与认证硬边界(`distribution-forms` 编译)**:公网监听(`listen: true`)必须以 TLS + 强认证闸门(`enableUserAccounts` 或 `basicAuthMode`/`perUserBasicAuth`)为硬前置,禁止引导默认无认证实例暴露公网;未授权请求拦截范围必须覆盖 `/characters/*` 等静态用户资产路由。

### 5.4 存储 Storage

```
┌ 存储 ───────────────────────────────────────────────────────────────────┐
│ 当前引擎 [ fs ● ]  健康 ping 12ms · 可写 · 数据根 ./data                  │
│ ┌ 切换引擎 ───────────────────────────────────────────────────────────┐ │
│ │ ○ fs(现状)  ●→sqlite(推荐:多客户端/同步场景的真事务)               │ │
│ │ ○ mysql  ○ postgres(共享 schema,需连接串)                         │ │
│ │ [mysql://…] [pool 10]   [迁移前必读▸]   [开始迁移]                  │ │
│ │ 迁移会全量复制 + 切活;快照留 <dataRoot>/_storage-migrations/ 不自动删 │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ 迁移现场:handle 3/3 · 阶段 chats · 4127 条 …(断点续跑/reset)           │
│ ┌ 存储浏览 ───────────────────────────────────────────────────────────┐ │
│ │ [handle▾] users · chats · presets · worlds …(aggregate 只读树)     │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

- 数据:`/storage/status|migrate|migrate/reset|inspect-any`+`/api/storage/health`。
- 迁移是写中只读窗口:发起后顶部常驻进度条(读 `/storage/status` 轮询),
  其他分区照常用,写面由服务端 readOnly 闸挡。
- 推荐位明示 fs→sqlite(v2-stack-decisions:sqlite=部署推荐);mysql/pg
  折叠进「大部署逃生位」子组。

### 5.5 备份与搬家 Backup & Move

三区一选择器——类目勾选是共享组件(全选/默认/清空+九类:
settings/secrets/characters/chats/worlds/presets/assets/user-extensions/
vector-indexes;admin 多一类 global-extensions)。

```
┌ 备份与搬家 ─────────────────────────────────────────────────────────────┐
│ 数据类目(下三项共用):[全选][默认][清空]  ☑settings ☑卡 ☑聊天 …        │
│ ┌ 本机 ZIP ──────────────────────┐ ┌ 恢复 ────────────────────────────┐ │
│ │ [下载备份 ZIP]                 │ │ [选 ZIP→探测→分片上传→执行]      │ │
│ │ 上次:11-20 · 内含 secrets      │ │ 模式:○合并 ○覆盖(二次确认)     │ │
│ └────────────────────────────────┘ └──────────────────────────────────┘ │
│ ┌ LAN 搬家(一次性链接,10min)───────────────────────────────────────┐  │
│ │ 迁出:选 handle(自 handle 默认)→ [生成搬家链接] → 可复制 URL      │  │
│ │ 迁入:粘贴对端链接 + 类目 + ○合并 ○覆盖 → [开始迁入](进度流)       │  │
│ └────────────────────────────────────────────────────────────────────┘  │
│ 聊天自动备份(backups/chat)收本区底部;ST 迁移入口 → 导入 overlay。       │
└──────────────────────────────────────────────────────────────────────────┘
```

- 数据:`/api/users/backup`(或 `/api/utopinn/backup`)、
  `/restore-backup/{probe,uploads,chunks/:offset,finalize,执行}`、
  `/lan-migration/offer|import`(或 utopinn/lan/*)、`/api/backups/chat/*`。
- ZIP 下载是流式响应:fetch blob → a[download];恢复进度走 NDJSON 流
  (`wantsRestoreProgressStream` 已内建)。
- LAN 搬家 = 整机换机;LAN 同步 = 常驻配对——两区并排但文案分清,
  用户分不清这个就会拿搬家当同步用。

### 5.6 多设备同步 Sync

```
┌ 多设备同步 ─────────────────────────────────────────────────────────────┐
│ 本机设备名 [desk-haa______] [保存]    调度:写后 60s / 轮询 300s [保存]   │
│ ┌ 后端(2)───────────────────────────────────────────────────────────┐  │
│ │ ● phone-haa   LAN peer · 手机    上次 2h 前 · ok   [同步][▾]        │  │
│ │   ▾:改类目│撤销上次│清对端凭据│移除                                │  │
│ │ ● s3-ebox     S3 · 加密远端      从未同步 · ⚠锁定  [解锁][▾]        │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ ⚠ 冲突 2 条 [去处理]   ℹ 通知 1 条 [查看]                                 │
│ ┌ 配对 ───────────────────────────────────────────────────────────────┐  │
│ │ [生成配对链接 ▸] 对端设备名+类目→链接(+可选二维码)                  │  │
│ │ [加入已有设备 ▸] 粘贴链接(或 baseURL+peerId+pairCode)+对端凭据      │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

- 数据:§2.3 全族。`GET /categories` 动态渲类目(不抄死表)。
- pairCode 是一次性耗材:链接泄露即废;accept 表单把 pairCode 字段
  收进「粘贴链接自动解析」路径,手动填是降级路径。
- 冲突 resolve 是双栏选择器(本地/远端版本),第一版可做简单版:
  列冲突+选一边;diff 预览挂 C-级 backlog。
- S3 后端表单(endpoint/bucket/key)收折叠组——个人云 LAN 才是主线。

### 5.7 服务插件 Server Plugins

与 cordis 插件是两回事,必须视觉分家:

```
┌ 服务插件(Luker 兼容装载器)─────────────────────────────────────────────┐
│ 全局开关 enableServerPlugins [○](config.yaml;装完/改开关需重启)       │
│ ┌ 已安装 ────────────────────────────────────────────────────────────┐  │
│ │ st-server-plugin-x  v1.2 · deps ✓   [更新][装依赖][移除]           │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ 从 git 仓库安装:[https://…________________] [安装]                    │
│ ⚠ server plugin=服务端代码执行;只装可信仓库。                          │
│ ── cordis 插件(utopinn-*,profile.yaml 声明)去 插件域 ▸               │
└──────────────────────────────────────────────────────────────────────────┘
```

- 数据:`/plugins/list|install|update|install-dependencies|delete`。
- 与 plugins 视图互挂入口,别做成一个面——两套体系的「插件」同名不同物。

### 5.8 资产清理 Assets

```
┌ 资产清理 ───────────────────────────────────────────────────────────────┐
│ [背景 12] [用户图片 3] [文件 1] [向量索引 0]   —— 按目录分页格图+删      │
│ ┌ 孤儿媒体 ────────────────────────────┐ ┌ 全局扩展(legacy,只读)──┐  │
│ │ 未被引用的附件 17 项 · 23MB [审查删] │ │ third-party×4 —— V2 不   │  │
│ │ (media deletion-candidates)        │ │ 兼容,仅文件管理;装新扩展 │  │
│ └──────────────────────────────────────┘ │ 走 server plugins/cordis │  │
│                                          └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

- 数据:`/api/backgrounds/{all,folders,delete}`、`/api/assets/{get,delete}`、
  `/api/files/*`、`/api/media/{deletion-candidates,delete}`、
  `/api/extensions/discover`(只读)。
- 这是「看得见占地方的」区,不是编辑器——删比改重要,预览图给足。

### 5.9 系统 System

```
┌ 系统 ───────────────────────────────────────────────────────────────────┐
│ 版本 v0.x · 更新:已是最新 / 有可更新 [检查] [git 更新(危险·需重启)]    │
│ ┌ 服务端日志 ────────────────────────────────────────────────────────┐  │
│ │ [复制] [导出] [清空视图] —— 进程捕获日志(log-capture)              │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ ┌ 公告 ──────────────────────────────────────────────────────────────┐  │
│ │ [+ 新建] info/warning/critical · 已发 2 条                          │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

- 数据:`/update/{status,start,apk-latest,desktop-latest}`、
  `/api/system/update-check`、`/version`、`/logs/{get,clear}`、
  `/announcements/*`。
- git 更新是破坏性最高的操作:确认框写清「会拉上游覆盖工作树+重启」。
- 公告消费端(账户 dock 小红点)不在本区——dock 接 `/announcements/me/*`。

## 6. 多 handle 的形态:handle 管理 ≠ 账号系统

这是本档唯一需要想清楚的语义层,先拍死:

- **现实**:accounts-off 时 `setUserDataMiddleware` 把所有请求钉死在
  default-user;多 handle 此时是**数据命名空间**,不是身份。建了 handle
  也没法「以它游玩」——数据空间存在,但 API 流量过不去。
- **触达 handle 的三条路**:
  1. `enableUserAccounts`——登录页选 handle+密码(session 形态);
  2. `perUserBasicAuth`——薄客户端 handle:密码 直连(RN/CLI 进指定
     数据空间的正路);
  3. admin 面本身——备份/inspect/删除等管理操作以管理员身份跨 handle。
- **所以管理面板做的是**:handle 的**可视化生命周期**——列出(头像/名/
  admin/启用/锁/用量/配额)、创建(slugify 预览)、启停、升降 admin、
  配额、改密、备份、删除(purge 选项)。以及把「账号门」开关放进配置区
  访问桶,让「建 handle → 开门 → 客户端以 handle 进」成闭环。
- **明确不做**:注册体系(OAuth 字段只陈列不主推)、「以该 handle 身份
  预览」、会话/设备管理、handle 间数据互转(sync/restore 已能间接做到,
  不另造)。
- accounts-off 下该区仍然有用:列表照常(default-user 一行)、可建
  handle(预建空间+配额)、可做跨 handle 备份/inspect。顶部放一条
  「未开登录门」提示链到配置区访问桶——把语义讲清而不是把功能禁掉。

## 7. 优先级与切刀

| 刀 | 区 | 理由 |
|---|---|---|
| **刀1(P0)** | 总览 + 账号 + 服务端配置 | 用户点名:multi-handle + 各种配置;三把全吃现成路由,无新服务端活;总览是「这面板值得存在」的第一印象 |
| **刀2(P1)** | 存储 + 备份与搬家 | 数据保命面:sqlite 迁移是个人云部署正路;备份/搬家路由全备只差 UI |
| **刀3(P2)** | 多设备同步 + 服务插件 | 配对/后端注册表服务端全备但流程最长(配对向导+冲突面),单独一刀;server plugins 面小,搭车 |
| **刀4(P3)** | 资产清理 + 系统 | 低频nice-to-have;日志/公告/更新先给最小版 |

刀1 落地后管理面板已能交差:看状态、管 handle、改配置。刀2 之后
「换引擎/换机器」闭环。每刀独立可用,不互相阻塞。

## 8. 给构建方(agy gemini neon)的实现指引

**架构沿用 contribution 壳,不新造页面骨架:**

- 新 feature `features/admin.tsx`:`ctx.add('nav.rail', {view:'admin',
  icon, order:50})` + `ctx.add('view', …)` + `ctx.add('sidebar.tree',
  {rail:'admin', …})`;分区索引走 `adminNav` 壳态(照抄 `studioNav`
  模式,App.tsx 加一个 useState 注进 ShellCtx);locale 全量 zh/en
  词条走 `ctx.locale`。
- 新 api 薄层:`api/admin.ts`(users-admin 族)、`api/account.ts`
  (users-private me/change-*/announcements me)、`api/sync.ts`、
  `api/storage.ts`、`api/assets-admin.ts`;**全走 `apiFetch`**
  (CSRF/403 重试已内建)。注意 `/api/users/*` 是 POST-only 风格
  (连读面 get/list/overview 都是 POST),`/api/sync/v1` 是 REST 风格
  GET/POST/DELETE 混。
- **可直接复用**:`inset-group`/`inset-row`/`sh-switch` 样式语、
  `useRemote`(拉数+reload)、`WiredBadge`、`Icon`/`UtopinnIcons`、
  `mono`/ghost-btn 类;`PluginsSections` 是「设置页签↔view 共享组件」
  的现成范式——账号区行内操作带、类目选择器照这个拆。
- **要新做**(按分量排):
  1. handle 表组件(行+操作带+新建抽屉+删除确认);
  2. YAML 编辑块(textarea+保存/重载+错误条;访问组表单读写同一
     content 字段,注意并发改丢);
  3. 类目选择器(九类 checkbox+全选/默认/清空,备份三区共享;
     admin 可见 global-extensions 一类);
  4. 配对向导(生成链接/粘贴解析两栏,candidateBaseUrls 下拉);
  5. 迁移进度条(轮询 /storage/status)+恢复进度(NDJSON 流读取)。
- **危险动作纪律**:删除 handle(purge)/覆盖恢复/引擎迁移/git 更新
  全部二次确认,删除类要求输入目标原文;迁移发起后壳级常驻进度条。
- **两态兼容**:accounts-off 全通;accounts-on 非 admin → admin 路由
  403——`api/admin.ts` 统一把 403 映射成「需要 admin handle」空态,
  rail 项按 `/api/users/me` 的 admin 字段显隐(off 时恒 true)。
- **不要碰**:`/api/users` public 族(login/register/oauth——登录页
  自带,SPA 不重造);`/api/sync/v1/session/*`(peer 协议);
  ui.contrib 水合(admin 区是内建面,不走插件声明)。

## 9. 边界(不做清单)

- 不造账号系统/注册体系/会话管理(v2-stack-decisions 拍板);
- 不做「以 handle 身份预览/切换」——触达 handle 是登录门的事;
- 不重造登录页(public/login.html 现有);
- 不把 oai/globalSelect/preset 写面缺口塞进 admin——那是 utopinn
  settings PATCH 白名单的账(C1/C2/C3/C7),admin 不绕路;
- 不给 legacy third-party 前端扩展做启用语义(V2 已拍不兼容,只陈列);
- 不做移动端 admin 形态(高级功能仅 web;移动 rail 不出 admin 项);
- cordis 插件管理不动(plugins 视图已是正主,admin 只挂入口)。

## 10. 验收

- 刀1 后:admin 域能从零看到实例/账号/配置三面,建 handle→配额→启停→
  删除全流程在 UI 走完;config.yaml 表单+YAML 双写一致,安全闸拒存有文。
- 刀2 后:fs→sqlite 迁移可从 UI 发起并看进度;ZIP 备份下载+恢复
  (合并/覆盖)跑通;LAN 搬家链接生成→对端迁入闭环。
- accounts-off 全功能可用;accounts-on 非 admin handle 登录后 admin
  rail 不显示、直达 403 友好空态。
- 无一路由绕过 admin 闸;所有写操作走 apiFetch(CSRF 齐)。
