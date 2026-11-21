# 前端占位全量审计(2026-11-21)

来源:explore 格静态审计(未做运行时验证;`wired` 旗标以服务端 `ui/contrib` 水合后为准)。
范围:`apps/web` 全部 MOCK 消费点、占位标记、面板注册表、舞台形态、设置面、斜杠/菜单。

## 一眼全景

**完成度约 65–70%**。主干全真(楼层读写/生成任务流/MVU/预设与世界书/persona/插件/secrets/导入/诊断/统计/管理/CardApp 宿主)。三大债:

1. **设置写面集体未接**:`patchSettings()` 全代码库零调用死函数;服务端 PATCH 白名单早已放行 `oai_settings`/`world_info_settings`/`preset_settings_openai`——连接段/全局栈开关/预设默认全部 disabled,文案「不在白名单(protocol pending)」**失实**。
2. **舞台预演轨 + 三块 wired:false 面板**:messenger 频道、剧场 VN 种子、novel 章节种子、lore/chapters/channels 面板全吃 stageData mock。
3. **假身份**:模型清单(服务端 `GET /api/utopinn/models` 存在)永远显示 MOCK_MODELS;顶栏预设选择器永远 MOCK_PRESETS;账户 dock 写死 `haa`(getMe 存在没接);插件市场整段 MOCK_MARKET_PLUGINS。

## MOCK_* 逐条(api/mock.ts 24 导出)

| 导出 | 分类 |
|---|---|
| MOCK_CHATS / MOCK_CARDS / MOCK_MESSAGES | 已接真 API,仅 fallback |
| MOCK_PERSONAS / MOCK_BUILTIN_PLUGINS / MOCK_REPLY_CONTINUE / MOCK_REPLY_REGEN | **死导出,删** |
| MOCK_MODELS | 纯 mock:服务端端点存在,前端无 client |
| MOCK_PRESETS | 纯 mock:真列表在 studio 用 listPresets,顶栏选择器是摆设 |
| MOCK_PRESET_BLOCKS | 纯本地态,开关无持久 |
| MOCK_GLOBAL_LORE / MOCK_WORLDBOOK | 纯 mock(真面走 settings.globalSelect 与 /worlds) |
| MOCK_MARKET_PLUGINS | 纯 mock(安装面未备) |
| MOCK_STAGE_SESSIONS | 刻意 demo(`st-*` 预演),设计内 |
| MOCK_MVU | **写而无人读**,删字段 |
| MOCK_NOVEL_CHAPTERS / MOCK_IM_CHANNELS / MOCK_VN | 预演种子 |
| MOCK_NOTES_TEXT | 死(NotesPanel 走 chat_state) |
| MOCK_REPLY_NOVEL/IM/VN/CHAT / MOCK_IMPERSONATE_DRAFT / mockPreviewResponse | 离线 fallback,诚实可留(mockPreview 死链除外) |

## 该做(API 已备前端没接,按性价比)

1. **连接段接线**(Overlays.tsx:691-745):source/BaseURL/连接测试 → `patchSettings({oai_settings})` + `probeUpstreamConnection`;文案失实需改。**小**
2. **全局栈开关**(studio.tsx:381):toggle → `patchSettings({world_info_settings:{world_info:{globalSelect}}})`。**小**
3. **预设设为默认**(studio.tsx:672):→ `patchSettings({preset_settings_openai:name})`。**小**
4. **模型清单水合**(App.tsx:506):新 api/models.ts → `GET /api/utopinn/models`。**小**
5. **预设清单水合**(App.tsx:507):`listPresets('openai')`,`activePresetId` 对齐真值。**小**
6. **正则管理面**(studio RegexPage):服务端 `/api/utopinn/regex` 4 端点全备,新建 api/regex.ts + 启停/编辑。**中**
7. **上下文弹层+LorePanel 换真**(StageFrame:127, SpecPanels:614):全球栈 ← settings.globalSelect,命中条目 ← stats/inject。**中**
8. **messenger 频道**(stagepack:361+SpecPanels:692):chat_state 侧车承载,或砍形态。**中-大**
9. **剧场选项协议**(stagepack:618):`message.extra.choices` wire 协议 + 服务端产出 + 写回通道。**大**
10. **账户身份接真**(Chrome.tsx:107+Overlays:841):`getMe()`。**小**
11. **persona 选择器**(App.tsx:112):`s.persona` 永远 null → body.user 只有兜底名;listPersonas 全真。**中**
12. **preview 面**:api/preview.ts 整文件零消费——做 prompt 预览面板或删。**中**
13. **listRecentChats**:home「继续故事」hero 或删。**小**
14. **renderMvuPanel**:MVU 面板加渲染子面或删。**小**
15. api/state.ts 冗余导出家族:保留公共面或删。**小**

## 该删(假数据/死控件/死状态)

1. MOCK_PERSONAS / MOCK_BUILTIN_PLUGINS / MOCK_REPLY_CONTINUE/REGEN —— 死导出
2. `s.notesText`/`selectedLoreId`/`s.mvu` 全局袋+MOCK_MVU —— 写而无人读(剧场选项 bridgeOp 打进无人消费)
3. context.tsx 的 `contextOpen`/`composerMenuOpen`/`presetPopOpen` —— 零消费
4. 五个无效设置项:`renderCount`/`streamFps`/`customCss`/`apiTab`/`endpoint`(含硬编码 gcli.ggchan.dev 残留)—— 删或接真(customCss → `<style>` 一行即真)
5. `/attach` slash 项(disabled+协议未备徽标,可留徽标或删)
6. locale 死键:acct.profile/usage/signout、composer.attach
7. ChaptersPanel「+新章」:写内存假持久 —— 接 chat_state 或去掉按钮留目录跳转
8. types.ts VIEW_IDS 六个旧视图 id(foyer/stories/rules/import/extensions/settings)清理

## 不完善待补

- PresetPanel:读真写只读(滑杆不可拖)—— `PATCH /presets/:name` 写面
- NovelStage:章节写回/新章持久化 → chat_state 或楼层 append
- TheaterStage:choices 协议 + 选项写回(swipe 分支当选项已半真)
- plugins 市场段:目录全真结构数据假——等服务端市场面(C12 之后)
- CharEditorModal:全控件只读 C3——卡文档写面缺口
- chats 的 `pinned`/`unread`/`stage` 字段无服务端源 —— chat_state 侧车
- renameChat 走 legacy `/api/chats/rename` —— 迁原生面
- 斜杠:/continue /regen /impersonate 真,/attach 死;楼层操作条全真

## 面板注册表快照

wired:false 三块:`lore`/`chapters`/`channels`(hydratePanelTypes 机制可自动翻正)。preset 读真写只读。其余全真(含隐藏 messageframe)。

## 最高性价比三步

1. 三处 patchSettings 接线(连接段+全局栈+预设默认,各几十行,服务端全备)
2. `GET /api/utopinn/models` 水合进 App(消灭最显眼的「在线播假数据」)
3. 删 MOCK_MVU 全局袋+五个无效设置项(零风险减负)

---

## 附录:壳层 chrome 演进史与悬案(v3 思考面)

顶栏一天迭代四版后被用户判删,历史与遗留问题记此:

**演进**:假红绿灯点+重复字标 → 活面包屑(面·会话) → 放大 LogoU+字标撑栏
→ (用户:顶栏 logo 与侧栏 logo 叠两层,「上面干脆别放东西」)→ 左侧清空
→ (用户:Desktop/Mobile 分段「也没必要」)→ **整条 top-chrome-bar 拆除**
(36px 回收)。品牌唯一例现在左栏头 `brand-header-row`(LogoU 钮=侧栏开关,
字标仅在 sidebar open 时淡入)。

**悬案(留给 v3 判断)**:

1. **壳层现在没有全局位**:连接状态/当前会话上下文/全局动作无家可归。
   面包屑方案已被用户否过一次——若要状态指示,候选面是左栏头、
   account-dock、或舞台头,别再复活顶条。
2. **workspace-inset 边界**:`.workspace-inset` 原为嵌在外 chrome 内的
   圆角卡(2px border + radius 12);顶条消失后它顶到窗口边缘,
   视觉接缝需实看(可能要把外 chrome 背景与 inset 关系重调)。
3. **vpMode 只剩 `?vp=` URL 入口**(截图 harness 用),UI 无消费;
   setVpMode 在 ShellCtx 是半死 API——保留给 harness 或收成内部态。
4. **brand-header-row 字标仅 open 态可见**:收起时品牌只剩一枚
   图标钮;若用户再提品牌存在感,方向是让字标在收起态也常驻
   (或干脆接受极简)。
5. **左轨图标已 1.3x(46px 钮/26px 图标)**,字阶整体抬档
   (ui 基准 13px)——后续若嫌密度降,微调用 token 别回写死值。

**用户反馈基调**(供校准):讨厌纯装饰占位(假红点)、讨厌重复元素
(双层 logo)、偏好「不放就不如删干净」、对小字号零容忍
(字阶地板 11px 起)。

---

## 收摊回执(TASK-053,2026-11-23)

设计档:`.skeinn/design/web-v3-frontier.md`。以下按原表逐条核销。

### 该做 · 已接

| 原条目 | 兑现 |
|---|---|
| 1 连接段接线 | Settings 连接段走 `patchSettings({oai_settings})` + `probeUpstreamConnection`;「不在白名单」失实文案已删 |
| 2 全局栈开关 | Studio/ContextPop/LorePanel 三处统一 `toggleGlobalLore` → PATCH globalSelect,**保留 charLore**(新增服务端单测断言) |
| 3 预设设为默认 | `patchSettings({preset_settings_openai})` + pickPreset 同步 |
| 4 模型清单水合 | `api/connection.ts` → `GET /api/utopinn/models`;modelsError/空态诚实,MockModels 不再进在线态 |
| 5 预设清单水合 | `listPresets('openai')` 水合进壳,activePresetId 对齐 |
| 6 正则管理面 | `api/regex.ts` 四端点全接;RegexPage 三域启停/新增/删除 |
| 7 上下文弹层+LorePanel | ContextPop 真人设快切+全局栈;LorePanel 读卡绑书+statsInject 命中,`wired:true` |
| 10 账户身份 | `getMe()` 水合 AccountDock/生成请求;状态点随 live 变色 |
| 11 persona 选择器 | listPersonas 水合;ContextPop 快切;`send`/`runGenerate` 带真 user/presetName |
| 卡编辑写面(C3) | CharEditorModal 可编辑:name/desc/first_mes/extensions.world → PATCH |
| renameChat | 原生 `/chats` 路由;sidebar 真会话行挂 rename/delete/新建 |
| renderCount/customCss | localStorage 持久化;楼层窗口化+「展开更早楼层」真实生效 |
| 预设调参写回 | PresetPanel/PresetPop 滑杆防抖 PUT `/presets/:name` |

### 该删 · 已删

- `MOCK_PERSONAS`/`MOCK_BUILTIN_PLUGINS`/`MOCK_REPLY_CONTINUE`/`MOCK_REPLY_REGEN`/`MOCK_MVU`/`MOCK_NOTES_TEXT` 死导出清除(grep 零命中)
- `s.mvu`/`s.setMvu` 写而无人读全局袋:改为 `setPanelParams('mvu',{rev})` 信号,MvuPanel remote key 消费
- `contextOpen`/`composerMenuOpen`/`presetPopOpen` 零消费 ctx 状态、`notesText`/`selectedLoreId` 字段清除
- 无效设置项 `streamFps`/`apiTab`/`endpoint`(含 gcli.ggchan.dev 残留)清除
- locale 死键:acct.profile/usage/signout/mail、composer.attach、studio.global.unwired、studio.presets.defaultUnwired、panel.preset.readonly、ov.char.badge、st.conn.unwired、studio.regex.badge/note、st.renderCount 失实串全部改写
- ChaptersPanel「+新章」内存假持久已去按钮(目录只读,honest)

### 仍开(登记债务,不造假)

- **剧场 choices 协议**:wire 协议+服务端产出=「大」量级,独立任务,用户深度参与设计
- **messenger 频道后端**:chat_state 侧车方案待立,形态维持预演态
- **plugins 市场**:目录真结构,安装面待服务端 C12 后
- **`st-*`/MOCK_STAGE_SESSIONS 预演轨**:刻意保留,与真会话视觉/行为区分已落实
- **`preview.ts` 零消费面**:`listRecentChats`/`renderMvuPanel` 已删;preview.ts(prompt 预览客户端)零调用,建议下一轮「接面板或删」
- **浏览器实机走查**:Studio toggle/PresetPop/头像切换的手感未实测,tsc+build+单测为准,实机验证留给人

### 验证证据

- `apps/web`: `tsc --noEmit` 0 错;`vite build` 成功(4683 modules)
- `apps/server`: `utopinn-library.test.mjs` 11/11(含新 charLore 断言);`utopinn-generate-context`/`utopinn-chat-regex` 全绿;`utopinn-generate-e2e` 6/6(E2E_READY_TIMEOUT_MS=300s + /tmp scratch —— 首次 60s 超时是 /mnt/d 9P 起服慢,非回归)
- `packages/protocol/src/api.ts`:SettingsPatch 白名单注释已对齐服务端实际(oai/world_info/preset_settings_openai)

### Red Team 复审(2026-11-23,对抗格 16 条核销 + FINDINGS)

16 条核心核销全过(写面真走服务端、charLore 保留有单测、MVU rev 信号非死写)。咬出 8 条诚实性缺口,已逐一处理:

| 发现 | 处置 |
|---|---|
| 移动抽屉账户行硬编码「已连接」+固定头像 | 已接 `currentUser`/`persona`/`live`,与 AccountDock 同链路 |
| `status.stub`「骨架阶段」失实、`stage.offline.banner`「只读」失实 | 改「服务端连接中不可用」/「离线演示,改动不落库」 |
| 文件头注释残留「只读 C3」「lore 未接」 | Overlays/SpecPanels 头注已更正 |
| mock 路径 `haa` 残留打进离线演示楼 | mkMock/messenger sender 改用 `persona?.name ?? currentUser?.name`;mock.ts 演示数据改「旅人」 |
| 离线态模型/预设/全球栈播 MOCK 名且无标记 | 下拉与开关加 `stage.demoData` 演示标记 + live 门控;全球栈开关离线 disabled |
| 侧栏 demo 行无视觉区分 | `chat.demo` 徽标 + 降透明度 |
| 死导出 `listRecentChats`/`renderMvuPanel`/`common.mockData`/`'mock'` union | 全删,tsc 零残留 |
| `worldInfoBaseRef` 空窗竞态(低风险) | 服务端 `world_info` 二层合并兜底(utopinn-library.js:713),登记不修 |

遗留已知缺口:**浏览器实机走查未做**(Studio toggle/PresetPop/头像切换手感),交付人验收;chapters/channels 面板维持 `wired:false` 与 UnwiredNote,待 chat_state 侧车协议立项。
