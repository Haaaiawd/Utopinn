# 分发形态:桌面/移动软件包与空客户端

- Mode: external_researched
- Authority: agent_provisional
- Scenario: 评估 Utopinn 在「服务端大脑 + 薄客户端」既定架构下,桌面端一键体验包、移动端安装包与跨网空客户端(Hollow Client)的工程可行性、维护成本与安全前置条件(当前阶段结论已拍板挂起,立档防重复推导)。

## Field identity and boundary

客户端与本地服务软件分发工程(Desktop/Mobile Application Packaging & Self-Hosted Distribution):负责裁决 Node 后端与 Web/移动薄壳之间的进程拓扑、原生模块打包边界、移动端驻留可行性及安装渠道策略;不负责应用内 UI 信息架构(`web-spa-stack` / `mobile-app-stack`)或插件微内核协议(`plugin-kernel`)。

## How real practitioners operate

- **桌面端 Launcher/Supervisor 模型(Koishi Desktop)**:面对含动态插件加载与原生 addon 的 Node 服务,成熟实践不把业务服务端塞进 Electron/Tauri 主进程或单文件 VFS,而是由极薄的原生 Supervisor 负责管理独立 Node 运行时目录、端口探活、日志收集与系统托盘,UI 仍走标准 WebView/浏览器连接本地回环端口。 — Source: `https://github.com/koishijs/koishi-desktop` & Koishi Boilerplate 桌面分发架构。
- **单文件可执行体硬约束(KoboldCPP vs Node SEA/pkg)**:C/C++ 单体(如 KoboldCPP)可通过静态链接 + 资源追加做成零依赖单 exe;而 Node 生态一旦引入 `better-sqlite3` 等 N-API 原生 `.node` 二进制与运行时动态 `import()` 插件目录,单文件虚拟文件系统必须将 `.node` 解压落盘并处理 ABI 对齐,复杂度陡增且极易被 Windows Defender 误报。 — Source: `https://github.com/LostRuins/koboldcpp` & Node.js Single Executable Applications 官方限制文档(`https://nodejs.org/api/single-executable-applications.html`)。
- **手机端内嵌 Node 内核真实成本(CoMapeo / Manyverse `nodejs-mobile`)**:在 Android/iOS 进程内嵌 `nodejs-mobile` 需要维护双平台交叉编译链(`better-sqlite3` NDK/iOS 静态库)、后台保活与 OS 杀进程恢复,却只能换取单机离线——对每次生成都必须联网调上游 LLM API 的产品而言投入产出严重倒挂。重度本地用户历来直接使用 Android Termux 跑原版服务端。 — Source: `https://github.com/digidem/comapeo-mobile` (`nodejs-mobile` 迁移与原生编译维护记录) & SillyTavern Termux 官方文档(`https://docs.sillytavern.app/installation/android-(termux)/`)。
- **Sideload 命名空间防御(SillyTavern 社区前车之鉴)**:RP/酒馆类工具因 UGC 内容审查策略难以长期留在商业应用商店,Sideload(GitHub Releases 签名 APK + F-Droid / PWA)本身就是一等分发渠道;官方若不提供明确的签名包与识别入口,应用商店极易出现仿冒套壳收费包(如历史上仿冒 SillyTavern 的 `SliiyTaver` 事件)。 — Source: SillyTavern 官方文档安全声明与 Reddit `r/SillyTavernAI` 仿冒 App 通报记录。

## Reflection for this project

- **What directly fits:**
  - **空客户端(Hollow Client)几乎零协议改造成本**:`@utopinn/api-client` 与 `apps/web` 已完整跑通基于 `baseUrl` + Session/CSRF + `/api/ws-ticket` 的远程通信,客户端本身零 prompt 组装逻辑。只要补齐「连接档案(Server URL + 凭据)切换页」即可连任意自建服务端。
  - **桌面端若打包,选 Launcher/Supervisor 而非重壳改写**:`apps/server` 依赖 `better-sqlite3`、Cordis `profile.yaml` 动态插件与用户数据目录(`data/`),独立 Node 运行时 + 薄启动器完全顺应现有结构。
- **What must be adapted or refused:**
  - **拒绝手机端常驻 Node 内核(`nodejs-mobile`)**:LLM 生成天然在线,手机塞 Node 只省掉一台云主机/局域网电脑,却背上 `better-sqlite3` Android/iOS 双端原生编译与后台保活地狱;本地极客需求直接交由 Termux 自托管兜底。
  - **在公网安全基线补齐前,拒绝鼓励裸奔公网空客户端**:当前 `apps/server` 默认 HTTP、账号体系为个人云轻量模式(`accounts-off` 默认 `default-user`),直接暴露公网存在凭据与存储裸奔风险。
- **Where an ordinary AI would look done yet feel amateur:**
  - 随手用 Electron/pkg 把 `apps/server` 打成伪单文件包,结果首次启动因 `better-sqlite3.node` ABI 或只读虚拟路径崩溃,或把用户 `data/` 写进临时解压目录导致重启丢档。
- **Non-obvious craft / leverage move:**
  - 利用已有 LAN Offer/Import 配对路由做「桌面服务端生成一次性二维码/短链 → 手机空客户端扫码自动写入服务端地址与会话凭据」,省去手机端手敲 URL 与 Token 的摩擦。

## Operational rules and Design delta

- **Quality bar (90 vs 60):** 60 分是套一层 WebView 壳硬编码 `localhost:8000`;90 分是空客户端具备多服务端连接档案、断线诚实降级、LAN 扫码配对,且桌面启动器严格隔离程序目录(只读可升级)与用户 `dataRoot`(持久不丢档)。
- **Tradeoffs & flip conditions:**
  - **Launcher + Node 运行时 vs Tauri/Electron 重壳**:优先独立进程 Supervisor/浏览器直连;仅当确认必须提供系统级全局快捷键、自定义协议唤醒或原生托盘常驻时才引入 Tauri 薄壳。
  - **空客户端连远端 vs 手机本地内核**:坚持空客户端;仅当未来出现纯端侧离线小模型成为主流玩法的实证需求时才重评本地运行时。
- **Anti-patterns (do not do):**
  - 禁止引入 `nodejs-mobile` 将 `apps/server` 塞进移动端进程;
  - 禁止将 `better-sqlite3` 与可变 `data/` 目录打进只读单文件虚拟文件系统;
  - 禁止在未启用 TLS + 强认证闸门时引导用户将默认配置的 `apps/server` 直接暴露公网;
  - 禁止为迎合应用商店审核而在核心协议层阉割本地卡面/世界书自由导入能力。
- **Verification probes:**
  - 检查打包产物升级覆盖时 `dataRoot` 是否零丢失;
  - 检查空客户端跨域/跨网连接远端服务端时 CSRF 握手与 `luker-ws-ticket` WebSocket 升级是否一次通过;
  - 检查公网模式下未授权请求是否 100% 被认证中间件拦截(含静态 `/characters/*` 资源)。
- **Design delta (Before -> After):**
  - **Before**:对桌面端用 Electron/Tauri 单包、移动端是否内嵌 Node 本地跑服务端尚未定性,存在过早投入打包基建的风险。
  - **After**:拍板挂起桌面/移动分发工程,主线集中打磨 Web SPA 与剧场体验;确立「移动端=纯空客户端(Termux 作极客自托管兜底)、桌面端未来走 Supervisor+独立 dataRoot、公网空客户端以 TLS+认证闸门为硬前置」三条红线。
