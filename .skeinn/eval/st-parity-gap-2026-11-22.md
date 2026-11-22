# Utopinn × SillyTavern 能力缺口报告（2026-11-22，只读调研）

**判断基准**:字段存得住 ≠ 生成链消费 ≠ 前端可操作，三层分开判定。

**总判断**:服务端大脑(prompt 组装/WI/正则/变量/TH)完成度远高于旧审计预期,真实可用;**主要缺口集中在前端暴露面**:群聊、分支/书签、世界书条目编辑、STscript 自由输入、表情包、大批 STscript 命令族。**会话起手 greeting 播种缺失**是影响每张卡的语义缺口。

## 1. 角色卡字段

- v1/v2/v3 识别转换:**有**(formats toV2 + validator)
- description/personality/scenario/first_mes/mes_example:**有**
- creator_notes/system_prompt/post_history_instructions:**有**(prefer_character_prompt/jailbreak 门控与 ST 一致)
- alternate_greetings:**半有** —— 存取/宏源有,**新会话起手不播种 first_mes/alternate;POST chats 只建空 system floor,web createChat 不补开场楼**
- group_only_greetings:**没有**
- extensions.depth_prompt / world / regex_scripts:**有**
- 其他 extensions(talkativeness/fav 等):**半有**(透传不丢,语义消费无;PATCH 只放行 3 子键)
- CCv3 data.assets:**半有**(保留+素材清单路由;无 icon 链接/内嵌渲染)
- 卡创建/删除/复制:**半有**(仅 import commit;legacy 有)
- tags:**有**

## 2. World Info(引擎完整度很高)

- 五层来源/内嵌书物化/position/depth/order/probability/selectiveLogic/常量/recursive/case/wholeWords/scanDepth:**有**
- sticky/cooldown/delay timed-effects:**有(服务端权威,落盘已修)**
- group scoring/budget/minActivations/recursion/decorators/AN/EM/outlet/script_injects/th.inject:**有**
- chat 绑定书:**服务端有(TH getChatLorebook/setChatLorebook);web UI 无**
- **世界书编辑器:半有** —— studio WorldbookPage 只能看+启停+JSON 只读;**缺条目内容/关键词/深度/位置/order/递归组编辑、新建/删除条目、新建/删除书、chat 绑定 UI**
- 全局书开关:**有**(world_info.globalSelect)

## 3. 正则管线

- 七放置位语义覆盖:**有**(display+prompt 双投影等价实现)
- 三作用域 global/character/preset:**服务端有**(preset 'in_use' 未实)
- 字段面/ephemerality:**有**
- ⚠️ 语义偏差(设计决定):卡内 regex **自动放行**,上游是 character_allowed_regex opt-in;TH 读面在,生成链不按 allowlist 过滤
- 前端:**半有**(preset in_use 解析缺、按楼层/放置位分面弱)

## 4. STscript / slash

- 执行链:**有**(/api/utopinn/script/run + stscript-env)
- 已注册命令:**~53 条(上游 ~307)**,只挂 messages+variables 两模块
- /send /sendas /sys /sysname /comment /echo /gen:**有**
- /trigger:**显式报错不绑**(诚实)
- /del /swipe /regen /continue /impersonate /go:**UI 有等价,命令无**
- 缺失命令族:导航/消息操作(del/swap/cut)/群成员/卡 CRUD/AN(note-set/get)/WI/QR 管理/persona/设置预设/secret/profile/DOM/媒体
- **Web 自由输入:没有(关键)** —— composer 不路由 `/` 前缀,手打 /sys 当普通消息发出;slash 菜单仅 5 项;/script/run 唯一入口是 QR chip

## 5. 会话/楼层

- 发送/流式/中止/重试/swipe(切版+末版触发生成)/编辑/删除/rewind/regenerate/continue/impersonate/quiet:**有**
- **开场问候播种:没有**(全卡语义缺口)
- **分支/书签:没有**(merge/split 仅 legacy)
- **群聊:服务端半有(group-orchestration+disabled_members+MVU group target),web 零 UI**
- token 胶囊/trace/jobs:**有(强于 ST)**

## 6. 生成/provider/预设

- chat-completions 16 provider + preset passthrough:**有**
- textgen/kobold/novel + instruct/context/sysprompt 9 apiId 预设目录:**服务端有**
- horde:**没有**(out-of-scope)
- raw prompt:**半有**(generateRaw 有,ordered_prompts unsupported)
- **预设管理:半有** —— web 只碰 openai 4 滑杆;缺 prompt manager/其余采样/instruct/context/sysprompt 编辑器/导入导出/复制/删除 UI
- 非 openai tokenizer/model:**半有**(ctxLen 只认 openai_max_context)

## 7. 杂项

- Persona:大半有;缺自定义头像上传(legacy 有)、per-chat 绑定持久化
- Quick Replies:**半有(只读最小面)** —— 只读第一册 12 chip;缺册切换/编辑器/启停/写面
- **Emotes/立绘:没有(SPA)**;legacy /api/sprites 在
- TH:**~45/50**;缺流式 should_stream、角色清单写面、ordered_prompts、'in_use';预设/persona/audio/render_character 宿主降(设计)
- CardApp ctx/th 双端:**有**(openOverlay/message-frame 嵌帧全链)
- 导入:**有**(char/world/preset/persona;QR/theme 可扫不可导)
- **导出:没有**(chat/card/world/preset 均无 utopinn 路由)
- 备份/LAN/多账户 admin:**有(legacy 承载)**

## 8. UI/交互

- 悬浮窗:**半有**(moving-ui 只读桶;web 用 workbench 替代,无自由拖浮窗)
- 快捷键:基本没有(差距不大)
- 右键菜单:hover ops 条替代(半有)
- 通知:hint 单条;**STscript popup/input 无真回执 UI(/input 断)**
- ST theme JSON 导入:无
- 移动端:面窄于 web

## 排期建议

**P0**:①开场问候播种(first_mes/alternate 落开场楼+swipes 槽)②STscript 自由输入(composer `/` 路由 runScript+补全)③世界书条目编辑器(结构化表单+新建/删除)

**P1**:④群聊端到端 UI ⑤QR 完整面(册/编辑/启停/写面)⑥指令集分批补齐(del/swap/cut、note-set/get、WI/QR/persona/preset 族)⑦分支/书签决策(做或钉死不做)

**P2**:⑧preset 全 apiId 编辑面+prompt manager+instruct/context/sysprompt ⑨emotes/persona 头像/导出/group_only_greetings/talkativeness ⑩/trigger 绑定+popup/input 回执+theme 导入+preset regex in_use

**设计偏差(钉死即可,不是缺)**:卡 regex 自动放行 vs ST opt-in;QR/主题/moving-ui 只读是刻意 named-doc 面。
