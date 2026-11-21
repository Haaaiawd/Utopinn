# V2 分层决策(2026-11-20)

> vs-V2: current

跨层方向面:V2 方向再拍板(见 DECISIONS)后的全栈判断。每层记「现状事实 / 决策 / 不做
什么」——新会话进来按此对齐,不重新推导。本档与 system-map(结构图)、cordis-next
(声明源唯一)、plugin-domain-map(插件边界)互补:它们画形,本档拍板。

## 后端

**现状**:11 utopinn-* 插件管全域(84 路由,profile.yaml 声明式),cordis fiber 语义真活
(dispose 即摘路由),存储四引擎抽象+真事务,闸表×路由表对账测试,@utopinn/formats
纯 TS 编解码(PNG tEXt/charx/byaf 双端可用)。

**遗留缺口(如实)**:

1. **双 API 面并存** —— legacy `/api/characters/*` 等与 `/api/utopinn/*` 平行。短期必
   须(兼容 harness 靠它跑 golden/e2e)。收敛路径 = TASK-035:harness 专用端点标注
   compat 面、utopinn 可覆盖的删减、其余定退役序。**判断:不做大爆炸删除,先标注分
   层再分批退。**
2. **插件散落 JS 直读** —— 部分插件绕 repo/formats 直摸文件。收编方向:存储读写一律
   过 repo 层,卡/书编解码一律过 @utopinn/formats——否则"引擎可换"是空话。随触碰
   逐步收,不开专项。

## 存储/数据库

**决策:不选边,定语义分层。**

- **fs-engine = 兼容默认**:JSONL/JSON 落盘、人眼可查、ST 磁盘约定一字不差,卡生态
  零摩擦。代价:事务是进程内串行,非真 ACID。
- **sqlite = 部署推荐**:多客户端/并发/同步场景的真事务兜底。mysql/pg 为大部署逃
  生位(已知隔离级警告:createIfAbsent 类"检查+写"在那俩引擎非全原子,代码注释已记)。
- **待办(文档级,不开任务)**:引擎语义对照表——哪些操作在哪个引擎真原子。以
  world-info-repo createIfAbsent 的注释为雏形扩成单档。

## 登录/账户

**决策:不造账号系统。** 个人云边界(PROJECT.md),注册体系是另一个产品。

- 账户 dock 接真 handle/session(现在 "haa" 硬编码);
- LAN 配对补完(offer/import 半成品)——手机扫码进自己服务端;
- 可选单密码闸,仅当服务端暴露公网;
- 多 handle 隔离沿用 ST 现成实现,不深化。

## 前端

**脊骨(已定)**:贡献点内核 + 服务端声明面(/ui/contrib)水合 + 谁的贡献谁拆
(cordis fiber 语义)。插件详情卡是第一红利消费者。

**优先级序**:

1. TASK-045~048 真玩通卡(显图/MVU/连接/CardApp 宿主)——"能玩"底线;
2. 形态深化(novel/galgame 舞台,TASK-044 余量)——差异化;
3. C 步动态 bundle 装载(cordis-next)——等三方插件真出现再做,现在做是空转;
4. RN 手机端——桌面玩顺再起,薄端契约已备。

**纪律**:接下来修"能玩"不修"好看"。

## 移动端形态(已定,重申)

视图收敛 chat + hub(资产工坊)两个;plugins→设置页签、studio→hub、home→chat
重映射已落地(App.tsx setView)。插件管理经 MobileSettingsSheet plugins 页签
(共享 PluginsSections),不单列视图。

## 执行顺序建议

TASK-047(卡图显,vite 代理行级)→ TASK-045(MVU autoInit,判断一处)→
TASK-048(连接端到端门票)→ TASK-046(CardApp 宿主,新面,最重)。

## 分发形态红线(distribution-forms 编译)

来源:`.skeinn/capabilities/distribution-forms.md`。桌面/移动分发工程当前挂起,主线集中 Web SPA 与生态闭环;后续任何打包或远端连接工作必须遵守以下三条硬红线与验证探针:

1. **移动端 = 纯空客户端(Termux 兜底)**:禁止引入 `nodejs-mobile` 将 `apps/server` 塞进 Android/iOS 进程(`better-sqlite3` 双端交叉编译 + 后台保活与天然在线 LLM 场景投入产出倒挂)。本地极客自托管由 Android Termux 跑标准服务端兜底;移动端空客户端消费 `@utopinn/protocol` + `@utopinn/api-client`,具备多服务端连接档案与 LAN 扫码配对(复用 offer/import 一次性短链/二维码),禁止硬编码 `localhost:8000` 或为迎合商店审核阉割本地卡面/世界书自由导入。
2. **桌面端 = Supervisor + 独立 dataRoot**:禁止将 `better-sqlite3` 等 N-API `.node` 原生二进制与可变 `data/` 目录打进只读单文件虚拟文件系统(Node SEA/pkg 或 Electron 伪单包)。未来桌面体验包采用 Koishi Desktop 式极薄 Launcher/Supervisor 管理独立 Node 运行时目录(只读可升级)、端口探活与外部持久 `dataRoot`,UI 仍连接本地回环端口。
3. **公网空客户端 = TLS + 认证闸门硬前置**:禁止在未启用 TLS 与强认证闸门(`enableUserAccounts` 或 `basicAuthMode`/`perUserBasicAuth`)时引导用户将默认配置的 `apps/server` 直接暴露公网。公网模式下认证中间件必须 100% 拦截未授权请求(**含 `/characters/*` 等静态用户资产路由**),与 `admin-surface.md` §5.3 访问配置安全闸互为防线。

**验证探针**:
- 打包产物升级覆盖程序目录时,独立 `dataRoot` 零丢失;
- 空客户端跨网连接远端服务端时,CSRF 握手与 `luker-ws-ticket` WebSocket 升级一次通过;
- 公网模式下未授权请求 100% 被认证中间件拦截(含静态 `/characters/*` 资源)。
