# 移动端新地基:fork IReader(KMP)

> 状态:已拍板(D-020),方案成稿(2026-11 TASK-028 调研轮)
> 关联:mobile-reader-form(UX 目标,仍有效)/ mobile-panels(桥协议,仍有效)/ mobile-ui-foundation(Expo 栈文档,冻结为参照)
> vs-V2: reference(parked)
<!-- V2:mobile 整体 parked -->

## 为什么是 IReader

国内圈子首选 legado 已于 2026-05 被法律核掉(上游删库公告,阅文 IP 诉讼)。替代品对比:

| 候选 | 协议 | 栈 | 死活 | 结论 |
|---|---|---|---|---|
| **IReader** | Apache-2.0 | Kotlin Multiplatform | 周级提交 ✅ | **选中** |
| legado 快照 | GPL-3.0 | Kotlin 安卓 | 死上游+法律云 | 否决 |
| Kototoro | Apache-2.0 | 全 Compose | 太新(2025-10 建) | 备选 |
| Shosetsu | GPL-3.0 | Kotlin 安卓 | 活跃但架构老 | 否决 |

## 地基实况修正(ref/ireader,快照 2026-10-28 upstream `IReaderorg/IReader`)

**重要修正:上游已严重膨胀,不再是当年那个轻量阅读器。** `rootProject.name = "Infinity"`,主线合入了游戏化/社区/AI 插画/TTS/翻译/Supabase 同步一整套副业。规模实测:

```
presentation/  ~1086 kt / ~23.3w 行   CMP UI(nav 骨架+全部屏)
domain/        ~1369 kt / ~20.4w 行   实体+45 个 usecase 目录+仓库接口
data/          ~317  kt / ~5.2w 行    SQLDelight(30+ 表)+仓库实现+Ktor/Supabase
source-api/    ~222  kt               Source 契约+HTTP 栈(cloudflare/headless webview/JS 引擎钩)
plugin-api/    ~53   kt               14 类插件契约(见下)
android/ desktop/ iosApp/             三端壳(iosApp 是真 SwiftUI+Xcode 工程,非脚手架)
core-utils/ i18n/ buildSrc/ config/   公共件
android-compat/ benchmark/            benchmark 在 settings.gradle 里(删)
source-runtime-js/ home/              **孤儿目录——不在 settings.gradle**(JS 源运行时半成品+stray)
supabase/ huggingface_space_coqui/ test_local_novel/ plans/ metadata/ fastlane/ scripts/   外挂赘肉
```

栈确认:Kotlin 2.3.21 K2 / Compose Multiplatform MD3 / Clean Architecture(domain→data→presentation)/ Koin 4.2.1 / Ktor 3.5.0 / SQLDelight 2.3.2 / Ksoup。

**书源契约面(切割缝)实测很小**(`source-api` `ireader.core.source`):

```kotlin
interface Source {                              // ~10 法
    val id/name/lang
    getMangaDetails(manga, commands): MangaInfo     // 书详情
    getChapterList(manga, commands): List<ChapterInfo>  // 章目录(+Paged 变体)
    getPageList(chapter, commands): List<Page>        // 章正文
}
interface CatalogSource : Source {                // +4 法
    getMangaList(listing|filters, page): MangasPageInfo // 书库浏览/搜索
    getListings()/getFilters()/getCommands()
}
// 内容模型
sealed Page = PageUrl | Text | ImageUrl | ImageBase64 | MovieUrl | Subtitle
// 小说正文 = List<Text>;MangaInfo(key/title/cover/author/desc/genres/status)
// ChapterInfo(key/name/number/dateUpload/type)
```

内置源注册位已存在:`CatalogStore.get(-200L)` 特判 `CatalogBundled(localCatalogSource)`——utopinn 源以同机制常驻,不碰扩展体系。

**读者侧结构**(全 commonMain Compose,Android/iOS/Desktop 共享):

- `MainStarterScreen`:5 `AppTab`{Library/Updates/History/Extensions/More} + `ModernBottomNavigationBar`(平板自动 NavigationRail)+ `PersistentTabContainer`(懒初始化+保活)。
- 路由:`androidx.navigation` NavController + `ScreenSpec`→string route;`CommonNavHost` ~70 条(大半是赘肉屏)。
- 阅读器:`ReaderScreenSpec(bookId, chapterId)` → `ReadingScreen`(ReaderScreenViewModel + ~15 子 VM):`ReadingMode` = Page/Continues/InfiniteScroll 三模式;`isReaderModeEnable` 点中央切 chrome;`MainBottomSettingComposable` 底栏(章滑动条+上下章+设置);`ReaderScreenDrawer` 目录抽屉;`ReaderSettingsBottomSheet`(Aa:字号/行距/段距/缩进/边距/字体/主题色板/翻页模式全有);`MainText` 段落级 composable(长按翻译/复制菜单先例);ModalBottomSheet 叠层惯例成熟。
- 内容管线:`Chapter.content: List<Page>` 经 `LoadChapterContentUseCase` 走 **DB 优先→source.getPageList→写回 SQLDelight** 的读穿缓存。
- WebView:headless `WebViewManger` expect/actual 三端齐(iOS 真 WKWebView,desktop HTTP 兜底);**可视嵌入 WebView composable 仅 Android 有**(`ui/reader/custom/CustomWebView.kt` accompanist 式;`ChatGptWebViewImpl` 的 iOS/desktop actual 是占位文案)。

## 切割方案(目录级)

### 保留(地基价值所在)

| 位 | 内容 | 备注 |
|---|---|---|
| `source-api` 契约+model | `Source`/`CatalogSource`/`Page`/`Text`/`MangaInfo`/`ChapterInfo`/`Filter`/`Listing`/`Command` | 切割缝本身,一行不动 |
| `source-api` HTTP 基础设施 | Ktor client/PreferenceStore/cookie | 裁掉 cloudflare/JS/headless webview 子树后保留 |
| `presentation/core` | NavHost/Navigator/MainStarterScreen/IScaffold/主题/DI 骨架 | nav 表瘦身(~70→~15 路由) |
| `presentation/ui/reader` | 全部阅读器屏+VM+Aa 面板 | **裁内部件**:删 TTS/翻译/章节艺术/书评/修复/gamification overlay/plugin 面板,留文本渲染+chrome+进度 |
| `presentation/ui/book` | 书详情屏(=书页) | 删迁移/评论/下载部件 |
| `presentation/ui/home/library` | 书架屏 | 直接就是「书架行=书」形态 |
| `presentation/ui/home/history` | 历史 | 留(会话续读入口) |
| `presentation/ui/home/updates` | 更新 | 待定→先留,可改「有更新」筛选 |
| `presentation/ui/settings` | 设置屏骨架 | 删内部赘肉项(同步/安全/插件/翻译/TTS/仓库),留外观/阅读设置/关于 |
| `domain` 实体+仓库接口 | Book/Chapter/History/Category/Bookmark 等 | 模型形状直接复用 |
| `domain` prefs | `ReaderPreferences`(字号/行距/段距/缩进/边距/主题/翻页全有)+`AppPreferences`/`UiPreferences` | 现成 Aa 持久化 |
| `domain` usecases | book/chapter/history/library/category/local/reader 目录 | 见替换节裁 remote 语义 |
| `data` SQLDelight+repo | book/chapter/history/category/catalog 表+仓库 | 本地读穿缓存+进度 |
| `core-utils` `i18n` | 文件/日志/偏好/资源 | i18n 裁 zh/en 起步 |
| `android/` `desktop/` `iosApp/` | 三端壳+Koin init | flavor 裁一个(standard) |
| `plugin-api` 形状参考 | `ReaderScreenPlugin` 接口形状 | **模块本身待拍板删**,接口形状借给 RendererRegistry |

### 替换(书源层→utopinn 源)

| 位 | 换成 |
|---|---|
| `domain/catalogs`(CatalogLoader/dex 加载/JS plugin/ExtensionManager/仓库同步) | `CatalogStore` 瘦身为「固定两个 CatalogBundled」;装/卸/远端仓库/用户源全删 |
| `domain/usersource` `ui/home/sources` `ui/sourcecreator` `legadoSourceImport` 路由 | `UtopinnChatsSource`+`UtopinnCharactersSource`(见下节) |
| `source-api` 的 `HttpSource`/`SimpleNovelSource`/`ParsedHttpSource` 爬虫基类 | `UtopinnSource`(直接实现 CatalogSource,不走 HTML 解析路) |
| `domain/usecases/remote` 的「远端书源」语义 | 同位改写:远端=utopinn REST;缓存语义见「可变尾章」 |
| `data` 里 Supabase sync/`remote` 仓库 | `UtopinnApi`(api-client 的 Kotlin 移植,见下) |

### 删除(赘肉,估计约占 presentation+domain 的 40-50% 文件量)

- **游戏化/社区全家桶**:usecases{badge,level,reward,spiritstone,donation,leaderboard,quote,review,statistics}, ui{community,readinghub,readingbuddy,spiritstone,reward,leaderboard,quote,popular,featurestore}, data/domain 对应表与仓库
- **书源生态**:extension 加载(dex/apk)、JS plugin 管线、usersource 全部、sourcecreator、pluginrepository、developerportal、migration、`source-runtime-js/`(孤儿)、`plugin-api` 模块(待拍板:或裁剩 ReaderScreenPlugin 形状)
- **爬虫基础设施**:source-api 的 `http/cloudflare/*`、`fingerprint/*`、headless `WebViewManger`/`BrowserEngine`/`JS.*`、`Ksoup*` 解析件、`ParsedHttpSource`
- **Supabase 同步**:domain `sync`/`remote` 鉴权、data supabase client、`supabase/` 目录、`ui/sync`、`wifiSync`/`unifiedSync`/`cloudBackup` 路由、settings 认证屏(`auth`/`profile`/`supabaseConfig`)
- **TTS/翻译子系统**:usecases{tts,translate,translation}, ui/tts+reader 内 TTS*VM+面板,PiperVoice 表,`huggingface_space_coqui/`。**待拍板**:先删干净,后续想要"听书"再回评(plugin-api 的 TTSPlugin 形状可留档)
- **其余**:download/epub/pdf 导出(待拍板留 epub 导出否)、characterart 画廊+上传(其图加载件可借)、chapterHealth/AutoRepair/broken report、glossary、notifications、benchmark/、test_local_novel/、home/、plans/、scripts/、metadata/、fastlane/(评)、`android-compat/`(评)、docs 里副业文档

### 新建(任何阅读器都没有的 RP 件,见「RP 四件」节)

## utopinn 源适配层设计

### 模块落位

新 KMP 模块(建议 `utopinn/` 或 `source-api` 内 `ireader.utopinn.*` 包):

```
UtopinnApi              api-client 的 Kotlin 移植(Ktor client 已在栈内)
UtopinnChatsSource      CatalogBundled —— 「书架/书页/阅读器」数据源
UtopinnCharactersSource CatalogBundled —— 「角色」tab 的卡库浏览源
LibraryHydrator         服务端会话 → 本地 Book(favorite) 水合 usecase
RpChapterPolicy         可变尾章缓存策略(见下)
PanelBridge             CardApp nonce 桥(见 RP 四件)
```

**api-client 移植**:`packages/api-client`(TS)是线协议参照,KMP 侧用 Ktor 重写薄层(~1-2k 行):baseUrl+Session/CSRF、`/api/utopinn/**` REST、`/api/ws-ticket` mint + `wss://…/api/ws-delivery` `luker-ws-ticket.<ticket>` 子协议流式(Ktor `websockets` 插件,KMP 全端可用)。**红线复核**:API key 永在服务端,端上只持 utopinn 服务端凭据——与 distribution-forms 一致。

### CatalogSource 逐项映射

| 契约 | utopinn 实现 |
|---|---|
| `getMangaList(listing)` | `UtopinnChatsSource`:书架=全卡会话聚合(**N+1**:chars→每卡 chats 并行拉取,Expo `listAllChats` 已验证此法;优化项=服务端补聚合端点,待拍板)。`UtopinnCharactersSource`:`/api/utopinn/characters`→MangaInfo{cover=avatar,title=name,author=creator,genres=tags} |
| `getMangaDetails` | chat=书:`/characters/:dir/chats/:chat` header+chatMetadata+卡描述摘要;char=书:卡 doc |
| `getChapterList` | **`GET …/chats/:chat/chapters`(TASK-044 已落!)**——`ChatChapterItem{kind,num,title,range:[from,to],floors,snippet}` 直接映 ChapterInfo{key=range 编码,name=title,number=index}。语义分章服务端做完,端侧零启发式 |
| `getPageList` | `chatGet` 全文档取 `messages[range]` → 一楼一 `Page`。形状选择:**新增 `RpPage : Page` 子类**(fork 内 source-api,sealed 同模块可扩){messageId,role,name,swipes,activeSwipe,reasoning,receipts,hidden,streaming}——把 `MessageViewModel`(protocol/renderers.ts)整楼搬进 Page;或妥协方案 Text+侧信道。**建议 RpPage**,一次到位,`Chapter.content` 序列化 kotlinx 多态需注册(同模块改动可控) |
| `getListings/getFilters` | chats 源:进行中/有更新/全部;chars 源:tag 筛选+title 搜索 |
| `getRecommendations` | 同卡其他会话(自然映射) |

### 可变尾章(RP 与「内容不可变」假定的核心阻抗)

IReader 的内容管线假定章内容 immutable(`LoadChapterContentUseCase`:DB 有即返回)。RP 不符:末章持续长楼(swipe/edit/streaming 改老楼也会发生)。方案:

- **utopinn 章 content 不落 DB**:`RpChapterPolicy` 在 `LoadChapterContentUseCase` 前置——`sourceId==utopinn` 时跳过「DB 有即返回」短路,恒 fetch;且 `chapterRepository.insertChapter` 写回路径对 utopinn 章只写章行不写 content(或写但加 ETag/updatedAt 列做失效)。**手术点小**:一个 UseCase 分支+一个 freshness 判据,不动 schema 是底线;若 content 列强约束再议加列(待拍板)。
- **失效**:WS `message.*`/job 终态 → 本章 content invalidate → refetch;swipe/edit 本地乐观替换单楼。
- **流式尾部**:tail 章 `streaming` 标记楼,WS delta 直进 reader 的 `RendererDelta` 通道(prose renderer 逐字「墨迹」),不经过 Page 重取。
- **进度**:IReader 的 `lastPageRead`/history/bookmark 全本地——v1 阅读进度只存设备,跨端同步待拍板。

### Library 语义对齐

IReader 书架=本地 `favorite` Book 行;utopinn 书架=服务端会话列表。对齐法:**`LibraryHydrator`** 进应用/连上服务端时把全会话水合成 `sourceId=utopinn,favorite=true` 的本地行(幂等 upsert,key=`charDir/chatName`),服务端消失的会话行降 favorite 或标 stale。白赚:分类/置顶/归档/未读计数/历史/搜索全套现成行为。Explore/源浏览屏改作「角色」tab 入口(点卡→其会话列表→开读或新会话)。

## RP 四件嵌入点(逐项可行性)

### 1. 剧场壳(立绘/背景/scene)——可行性:高,服务端契约已齐

- **数据已备**:`GET /characters/:dir/assets`(sprites/backgrounds/bgm)+ `chat_state` ns `scene`(`TheaterSceneState{bg,bgm,cast,floor}`)+ 楼层 `extra.scene` 引用,三件套全是 TASK-044 落现货,零新增协议。
- **嵌入点**:`ReadingScreenContent` 的 content `Box`——`ReaderText` 之下垫 `SceneLayer` composable(bg 全屏+cast 立绘按位摆放);scene 态由 `RpPage.extra.scene`/scene sidecar 驱动,随楼层滚动推进。
- **形态归属**:scene layer 是渲染器实现细节不是宿主 chrome——prose 默认关(弱背景位),galgame renderer 强开(横屏+立绘+对话框,`RendererManifest` 申请 landscape)。
- **风险**:立绘大图加载用 Coil3(已在栈);iOS 端 Compose 大图性能待实测。

### 2. CardApp 面板(WebView 沙箱+ctx 桥)——可行性:Android 高/iOS 中/桌面低

- **线协议零发明**:`packages/protocol/panels.ts` 的 `PANEL_METHODS`/`PANEL_METHODS_TH(T0/T1)`、`PanelRequest/Response/Push`、nonce 闸、grant 展开(`expandApiGrants` 语义,apps/mobile/src/panels/bridge.ts 参照实现在)。
- **宿主槽位**:`AppTab` 加 `Panels`(替掉 Extensions 位,index 3)+ 阅读器 chrome「…」内面板入口(ModalBottomSheet 惯例)。面板页=当前聊天 CardApp 聚合,同 mobile-panels 裁定。
- **WebView 平台差**(实测):
  - Android:`ui/reader/custom/CustomWebView.kt` 现成可视 WebView composable;桥走 `WebMessageListener`/`addJavascriptInterface` 注 `window.__utopinnPanelReceive`+postMessage 回收——**直接可做**。
  - iOS:headless `WebViewManger.ios` 有真 WKWebView,但**无可视 WebView composable**(`ChatGptWebViewImpl` iOS actual 是占位文案)——需新写 `UIKitView`+WKWebView+`WKScriptMessageHandler`,中量新码,模式成熟。
  - Desktop:**无嵌入 webview**(WebViewManger.desktop=HTTP fetch 兜底)——v1 面板空态占位;桌面由 web SPA 承接。**待拍板**(JCEF/JavaFX 引入否,倾向不引)。
- **桥实现**:KMP 重写实测约 300 行(桥内校验链+in-flight ledger+push 泵);`th.*` 面转发 `POST /api/utopinn/th/call`,`ctx.*` 面走对应 REST——**面板桥是四件里协议风险最低、平台风险集中在 webview 层的一件**。
- **沙箱基线照 mobile-panels**:originWhitelist/JS 限定/app 代码不直接触网(经桥)/崩溃降级占位卡;CDN 代理 `/api/cdn-proxy` 走服务端(资源白名单语义不变)。

### 3. MVU/变量状态条——可行性:高

- **数据已备**:`/api/utopinn/mvu/{state,settle,panel/render}`+`state/chat` sidecar;`MessageReceipt{kind,ops}` 线形已在 protocol/renderers.ts。
- **嵌入点**(reader-form §2 既定):章末「作者有话说」位=章 footer composable(`ReaderText` 章末 slot);楼层级变量 op 行进 `RpPage.receipts` → renderer 决定折叠条形态(晋江教训:正文 token 派生色)。「仅格式显示」剥离在服务端管线,端上只渲染。
- **MVU 面板 render**:`/mvu/panel/render` 产 HTML——走 CardApp WebView 壳复用(非独立管线)。

### 4. 聊天交互输入(「你的回合」composer + swipe 候选)——可行性:高,链路全通

- **发送链**:`POST …/chats/:chat/messages`(append 用户楼,integrity CAS)→ `POST /api/utopinn/generate`{type:'normal',persist_target:{kind:'character',avatar_url,file_name}}→ `x-luker-generation-id` → ws-ticket 流(delta→RendererDelta)→ 服务端兜底写盘 → tail 章 append。**全 REST/WS 已落,端侧零 prompt 组装**(服务端大脑红线)。
- **嵌入点**:沉浸正文末虚线占位+右下 FAB(reader-form §2)→ `ModalBottomSheet` 半屏书写层(IReader 全屏惯用 sheet,无缝接入);快捷符 `*` `"` `(`。
- **swipe 候选**:`RpPage.swipes/activeSwipe` → 段尾「✦N稿」角标 → 半屏候选卡;选定=PATCH `/body/<i>/swipe_id`(`RendererActions.swipe` 语义);regen=`generate{type:'swipe'|'regenerate'}`。
- **长按楼菜单**:IReader `MainText` 已有段落长按先例(翻译/复制)→改挂{重写此段/编辑/从此分叉/复制},分叉=chat-create+document 段复制(或待服务端分支端点,待调研 Luker branch 语义对应 REST 是否已开)。

## 渲染器 seam(承接 D-015,用户 2026-11-04 拍板补充)

壳=书,书内呈现=渲染器 seam:**自建轻量 `RendererRegistry`**(KMP 侧 `ConversationRenderer` 契约的 Compose 镜像——`mount(view:ConversationView)/renderMessage/onDelta/onUpdate`,线形抄 protocol/renderers.ts,R4/R5 规则同构)。

- **否决复用 plugin-api `ReaderScreenPlugin`** 作主机制:它是第三方生态插件面(manifest/permission/eventbus/安装生命周期),我们 renderer 是一手内置代码;但其 `screenInfo{name,targetContentTypes,canHandle}`+`createScreen(context)` 形状借为 registry 注册项形制。
- chrome(Aa/void space/底栏/目录抽屉)恒属宿主,渲染器只画楼层流;形态谱 prose→bubble→galgame;CardApp 非渲染器走 WebView sheet 桥。

## 与现有资产的关系

- `apps/mobile`(Expo):冻结为参照。面板桥 nonce 协议、会话流数据形状(`listAllChats` N+1)、阅读器形态(ProseFlow/ComposeSheet/SwipeSheet/AaPanel/ChapterDrawer 分解)继续有效;HeroUI/uniwind 栈不迁移。
- 服务端协议零改动:utopinn 源就是又一个薄客户端,吃同一套 REST/WS;TASK-044 的 chapters/assets/scene 端点恰为本方案备件。
- TASK-008/009/027 已落代码转参照态;验收语义按新地基重排(同一批 done_when 在新栈上重新达成)。

## 工作量粗评(大件排序)

| # | 件 | 量级 | 备注 |
|---|---|---|---|
| 0 | 瘦身删码 | **最大头** | presentation+domain 赘肉 ~40-50% 文件;策略=先整目录删→编译驱动修断链→settings.gradle 摘 module |
| 1 | api-client Kotlin port(REST+CSRF+ws-ticket stream) | 中(~1-2k 行) | Ktor 全端;`luker-ws-ticket` 子协议+seq resume 照 stream.ts |
| 2 | UtopinnChatsSource/CharactersSource+LibraryHydrator | 中 | 契约小;书架 N+1 拉取先跑通 |
| 3 | 可变尾章政策+reader 楼层化 | **中大,核心手术** | RpPage 扩展+content 不落库+WS 失效+楼 footer/长按/swipe 角标 |
| 4 | composer+generate 链路 | 中 | append→generate→ws stream→尾楼落版 |
| 5 | Panels tab+PanelBridge+Android WebView | 中 | Android 先做实;iOS webview 另算 |
| 6 | SceneLayer(theater 壳) | 中小 | 数据全备,纯渲染层 |
| 7 | MVU/receipts 状态条 | 小 | 数据全备,章末 slot |
| 8 | bubble/galgame renderer | 中/个 | seam 落地后逐个增量 |
| 9 | iOS 全线(含 PanelWebView UIKitView) | 大,**后置** | Android 先行验收,iOS 二期 |

建议顺序:0→1→2(能开书架+书页)→3(能读)→4(能写)→6+7(剧场感)→5(面板)→8→9。

## 风险与未决问题(待拍板)

| 项 | 状态 |
|---|---|
| `Chapter.content` 序列化加 `RpPage` 子类 vs Text+侧信道 | **待拍板**(建议 RpPage;影响 chapter.sq content 编解码与 Page sealed 表) |
| utopinn 章 content 不落 DB 的实现位(LoadChapterContentUseCase 分支 vs 专库表) | **待拍板**(倾向前者,schema 不动) |
| 书架聚合:客户端 N+1(现状可行) vs 服务端补 `/api/utopinn/chats` 聚合 | **待拍板**(优化项,不阻塞;会话量上去再议) |
| 群聊→「书」映射(`is_group` 会话在 /characters 面外的枚举面) | **待调研**(API 群聊列表端点形状未核) |
| 分叉/branch 楼操作的 REST 面(chat-create+document 段复制可行否,Luker create-branch 语义对应) | **待调研** |
| 阅读进度存设备本地 vs 服务端 chat_state 同步 | **待拍板**(v1 建议本地,同步=二期) |
| plugin-api 整模块去留(建议删,seam 自建;保留 ReaderScreenPlugin 形状参考) | **待拍板** |
| TTS/翻译子系统删后回引节奏 | **待拍板**(默认先删) |
| Desktop 面板:无嵌入 webview,JCEF/JavaFX 引不引 | **待拍板**(倾向不引,桌面走 web SPA) |
| iOS 端 PanelWebView 新写量+CMPIOS 实际成熟度(reader 三模式在 iOS 的实测) | **待调研**(iosApp 骨架真实,阅读器 iOS 实测未做) |
| 上游跟新策略(fork 后单向摘 vs 跟踪 upstream merge) | **待拍板**(建议单向摘,不承诺 merge) |
| epub 导出/下载离线章 去留 | **待拍板**(RP 导出=web 管理端职责,倾向删) |
| legadoSourceImport/CommunitySource 导入界面残留引用 | 删除时编译驱动清理,不单列 |

## 侦察已闭项(原「开放问题」核销)

- ~~source-api 的 Source 契约具体形状~~ → 极小(~14 法),上文逐项映射完
- ~~presentation 对 source 的耦合点~~ → Explore=getMangaList/BookDetail=getMangaDetails+getChapterList/Reader=getPageList,三层干净
- ~~CMP iOS 成熟度~~ → iosApp 真 SwiftUI+Xcode+160 iosMain kt,非脚手架;阅读器三端 commonMain,但实机未测(列入待调研)
- ~~分页引擎形态~~ → Page/Continues/InfiniteScroll 三模式;RP 用 Continues/InfiniteScroll(滚动楼层流),Page 模式裁为次级
- ~~KMP WebView+JS bridge 等价物~~ → Android 现成;iOS 需新写 UIKitView+WKWebView+ScriptMessageHandler(中量);desktop 无,面板空态
