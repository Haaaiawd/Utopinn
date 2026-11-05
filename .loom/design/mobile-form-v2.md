# 移动形态 v2:IReader 形态学 + RP 件映射

> 来源:深潜代理 7ce17f5b(2026-11-04)。一手资料=ref/ireader 源码 + 中文 RP app 公开评测。基线=mobile-reader-form.md(深化不推翻)。

## 一、IReader 代码形态学(事实,全部带路径)

**书架**(`presentation/ui/home/library/`):顶栏标题+筛选+搜索+⋯;ScrollableTabRow 分类带(N);HorizontalPager 一分类一页(`beyondViewportPageCount=0` 为 800+ 藏书量刻意关预渲染);分页阈值=距尾≤24项。**4 布局**(CompactGrid 默认/ComfortableGrid/List/OnlyCover),封面 2:3、竖屏3列横屏5;徽标体系(unread primary 数块/downloaded/archived/**GoToLastRead 40dp 叠层▶直接进最新章跳过详情页**);ResumeReadingCard 底部悬浮续读条;筛选 sheet 三页(Filters 三态/Sort 8种/Display 布局+列数+badge开关)。点书→详情页不直接进阅读。

**书详情**(`BookDetailScreen.kt`):250dp 立绘 backdrop(blur30+渐变压暗+primary 8-12%淡染,可关)→120×170 封面卡+状态角标+标题3行/作者/状态来源 → BookStatsCard 三格统计 → 主钮50dp → 简介 → ChapterBar(章名+4 36dp钮) → 过滤chip → **章列表 72dp 行**(已读38%alpha/当前章primary+8%底) → **右下 ExtendedFAB "Resume"/"Start"(滚时收成圆 FAB)=继续阅读CTA,不在正文流**。透明渐变顶栏;**封面取色全局化**(setCurrentCoverUrl)。

**阅读器 chrome = 三层+抽屉**(`ReaderScreen*.kt`):点击中央 toggle(顶栏进出场 100/50ms、底栏 150/100ms——比 v1 拍的 200ms 更激进)。顶栏56dp:返回+章名+**chevron 折叠区**(默认收:书签/查找/报坏/插件/翻译/WebView——二级图标收一个展开箭头而非⋯菜单)。底栏双行:行1=章名+‹Slider(按章序号)›;行2=仅3图标(目录/TTS/Aa)。**Aa=55%屏高 ModalBottomSheet 四 tab**(Reader 排版预设+滑块群/General 阅读模式+开关组/Colors 主题+亮度+自定义色/Fonts)。目录抽屉 90% 宽。

**主题**:14 预设(`ReaderThemePreferences.kt`,**默认是黑底非纸白**)+自定义底色/字色 picker;6 排版预设(`ReadingPreset.kt`:Default 18sp/28sp/缩进8/段距4/Lora 等);默认 fontSize18/lineHeight28/边距左右16。

**分页引擎 3 种**(`ReaderText.kt:530`):Page=HorizontalPager+**TextMeasurer 逐像素分页**;Continues(默认)=单章 LazyColumn 一段一item+上下拉换章;InfiniteScroll=多章串联瀑布,滚过75%预载。**糙点:段缩进=往字符串前塞 `" ".repeat(indent/2)`,段距=塞 `\n`**(ReaderTextCommon.kt:683-725)——绝对空格不随字号缩放,我们要重写段渲染。

**章末 void space**:380dp(`ReaderTextCommon.kt:390`)"CHAPTER COMPLETE"+呼吸三点+下沉箭头——现成的"章末附属内容"挂载位。

**底导航**:5 tab(Library/Updates/History/Extensions/More)+**双击 tab 快捷键**(Library→筛选 sheet/History→续读/More→设置);平板换 NavigationRail。

## 二、RP vs 阅读器结构差(调研事实)

- **输入回合制高频**:所有 RP app(星野/猫箱/CAI)都常驻输入框——选"书"形态=接受输入让位沉浸,呼出式是唯一兼容解但成本要控
- **swipe 是核心循环**:CAI 左滑零成本+「2 of 3」计数;星野「重说」一键进半屏 4 候选——都比长按菜单浅
- **回溯/分叉一等公民**:星野长按气泡回溯续聊、CAI Branch from Here
- **回最新浮钮**(星野常驻右下)、快捷符 `*动作` `"台词` (猫箱标配)、灵感候选(星野灯泡)

## 三、v2 建议(要点)

**IA**:底 tab 4 个=书架(网格默认 ComfortableGrid,List 备选)/角色(库)/面板(保留 tab 待定,降级方案=收进"我的"或仅 chrome)/我的;沿用 IReader tab 框架+双击机制。三级路径不变:书架→书页→阅读器。

**屏要点**:S2 书页全套沿用 BookDetail(backdrop/统计卡/章目录=语义切片列表/FAB 继续阅读+封面取色);S3 角色页=BookDetail 变体(章表换会话列表);S4 阅读器三层沿用,底栏图标行 3→5(目录/排式prose⇄bubble/书写✎/Aa/⋯),顶栏刷新→回最新,chevron 折叠区放 RP 项(书签/楼内查找/角色卡/分支/面板/形态/导出);正文主形态=**InfiniteScroll 楼层流**(流式追加天然尾部追加;Page/TextMeasurer 不投——流式来了要全文重分页,挂起不删)。

**RP 四件映射**:
1. **swipe**→段尾「✦2/5」角标常驻+‹› 快速翻稿+点角标进半屏候选卡(星野"重说"同款:60字预览+时间戳+选定);regen 进长按菜单+候选页底钮
2. **书写层**→呼出式半屏,三召唤位:ChapterVoidSpace「—轮到你落笔—」占位+底栏✎+右下 FAB;层内快捷符+灵感位(v2);发送→层收→段落落版→墨迹写 AI 段。退路=常驻细条(呼出成本过高时),待定
3. **CardApp**→双入口:底 tab+阅读器 chevron「面板」;**IReader 自带 ReaderPluginPanel=ModalBottomSheet 弹插件 UI 的先例**(ReaderScreenSpec.kt:781),直接同构;Android androidx.webkit 重实现 nonce 桥,iOS WKWebView 另写(唯一跨端不一致硬点)
4. **MVU/变量 op**→内联 StatusBlock(跟楼层,弱样式折叠块,晋江"作家说"位)+抽屉二级页查全量

**长对话**:长按段菜单(重写/编辑/**从此分叉**/复制/回溯)+回最新浮钮+slider 按字拉通+拖动浮标"章名+x%"。

**要改 IReader**:段渲染弃塞空格法→TextStyle 首行缩进2em+markdown;slider 按字;ChapterRow 章号→语义章;void space 加落笔占位+面板入口;Aa-General 翻译/TTS 换 RP 项;**默认主题黑底→纸白系默认**(v1 五主题色板映射 readerThemes 槽位)。

**切除**:书源runtime/supabase/翻译/TTS/下载/epub/评论/推荐/游戏化。

**待定**:书=会话(v1 选定,章表偏空)vs 书=角色(章表=会话更饱满)——两案共用 BookDetail 骨架,首版都做原型验证;面板 tab 去留埋点决定;长按段 vs 文本选择手势分工(不可选中态才出菜单);章边界在 InfiniteScroll 只表现 void space+锚点不硬切。

## 四、承接

- mobile-reader-form.md v1 拍板全部保留作 UX 目标;本稿给出 IReader 骨架上的具体落位与改造清单
- source-api/plugin-api 接口面(uberge 源工作量)未深挖,仍是 TASK-028 侦察项
- RP app 交互来自公开评测(非一手实测),按 D-021 保持可修正
