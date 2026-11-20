# Web 端产品形态深度研究(v2)

> 来源:深潜代理 df5e38ec(2026-11-04)。三路产出:竞品实测(全部带源)/实现体检(带文件路径)/v2 建议稿。
> 基线:web-rp-form.md v1 拍板稿 + web-ia.md + web-visual-system.md,本稿深化不推翻。
> 竞品来源:Janitor.AI changelog/docs、Character.AI support/blog、Chub docs+开源镜像 aichub、RisuAI deepwiki/源码、Agnaistic docs、SillyTavern docs/deepwiki、Marinara-Engine docs、ScyllaChat、Rin、Chronicler、Harpy。
> vs-V2: reference
<!-- 体检段为时点快照;剩余挂账=URL 路由/⌘K -->

## 一、生态收敛点(事实)

- **全行业收敛规则:密的是管理面不是聊天面**——聊天区零管理控件(头像+名+swipe+hover 二级),管理动作全收抽屉/页/汉堡。我们当前密度落在中档偏疏,方向对。
- **三级路径收敛**:卡墙→角色页→会话(Janitor/Chub/aichub 同构)——我们的形态已对上。
- **生成配置是唯一获准贴聊天面的管理面**:Janitor 模型钮直达、Chub 汉堡 Configuration、Agnai flyout、ST 左抽屉。
- **Stages(Chub)= 我们右面板宿主唯一同构先例**;我们只多不少(tab 多开+拖宽+贡献点开放)。
- **persona 是标配对象位**(Janitor tab/Chub 页/ST 面板);Janitor 2026-10 My Chats 重设计=「最近会话按今天/本周/更早分组+每行 persona 徽标」,直接可抄。
- **透明度在变成卖点赛道**:Chronicler prompt inspector、NovelAI Context Viewer——我们的 diag/预览已在这条赛道上。
- 新势力注意:Marinara(三栏+编辑器占中区+Roleplay HUD=agent 状态 widget)、NeoTavern(ST 社区自己推翻零路由)、ScyllaChat(节点图生成链)、Risu(块级编辑+自动分支文件夹)。

## 二、实现体检结论(apps/web)

**已对上拍板稿**:门厅/角色页三级路径/舞台头大部/消息四惯例/右面板宿主/导入中心(最完整面)/插件管理。

**断的(按伤害序)**:
- P0-1 消息操作 edit/regenerate/branch/more 全 unwired(ChatView.tsx:179-183),swipe 通
- P0-2 卡编辑器 stub(角色页 edit 只发 hint)
- P0-3 生成配置链全缺(连接/预设/prompt;composer preset 死档)
- P0-4 无停止/排队(streaming 只有发送禁用,abortRef 存在无钮)
- P1:二级栏 hotswap 横排+Janitor 分组;Aa 现场排版(TypingSettings seam 空挂);session 板块占位;对象下钻深链(角色页绑定 chip 不可点);WI 条目只暴露 4/12 字段;舞台头「一行简介」;⌘K;alt greetings 入口
- 架构债:**无 URL 路由**(view=useState,刷新丢态/无深链/无分享)——卡编辑器落地时痛感放大;view 贡献点加 path 可消化
- API 缺口:`bound` 筛选诚实空态背后是**服务端无绑定书列表端点**(R7)

## 三、v2 建议(要点)

1. **IA 不动**,两处配重:import 从 rail 回收(动作流不是域,入口已有全局 drop+页内按钮);生成配置贴聊天面(composer preset 真列表+舞台头 chip 同步,完整编辑走 settings 链)
2. **管理面按对象组织**(全行业一致):补卡→绑定资产闭环(书 chip 深链 RulesView/内嵌书就地编辑);persona 从 settings 移回 stories 域第二 tab(回归 §13 拍板);预设暂留 settings 链
3. **chrome 四级规则**:L0 消息本体/L1 舞台头+composer/L2 二级栏+右面板(沉浸收,现状)/L3 rail(完全体才收)/L4 管理面永不浮 chat;三条出入规则:管理面不浮剧场(已遵守)/离开不丢局(服务端 job+WS 回放是结构优势,要回执)/导航显式跳不做伪栈
4. **独有**:组装透明度一等公民/右面板+CardApp 沙箱(行业最完整)/万能导入手势/renderer seam 契约化
5. **缺失**:消息三件套/卡编辑器/生成配置链/群聊(协议 groupRef 已留位,V1 插件位可接受)/persona 锁定深度(ST 三锁 vs 我们 localStorage)
6. **待定**:URL 路由(import 拍板稿外新项)/import rail 去留/unwired 按钮先改 disabled 诚实态/per-chat persona 服务端位/群聊形态挂账/mock 写操作统一 hint/window.prompt 换 Dialog

## 四、承接关系

- P0 四件直接构成下一阶段实施清单;P1 大部是 web-rp-form 拍板稿内未完成项继续执行
- ⌘K 与真路由是架构性待定项,影响跨 feature/kernel,单独立项讨论
- 竞品事实非一手长期使用(官方 changelog/docs/源码),按 D-021 保持「基线可用不封顶」
