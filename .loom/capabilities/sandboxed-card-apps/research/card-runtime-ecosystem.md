# 卡运行时生态机制图谱(2026-11-03 调研)

> 目标:不是适配某几张卡,是把整个酒馆卡生态的**运行机制**拆成可枚举的面,
> 我们的宿主实现这些面 = 兼容生态本身。
> 主要来源:ref/TavernWeave(LiarMTTT,TW 制卡手册库,带置信度标注)、
> ref/extensions/JS-Slash-Runner、MagicalAstrogy/MagVarUpdate、
> lolo-desu/lolocard、Anastasia2372/sillytavern-cardforge、本地语料卡解剖。

## 1. 卡运行时的四个机制面

### A. 提示词面(server-side,packages/core 域)
- WI 条目(全部位置/选择性/递归/预算/TimedEffects)
- 正则管线(USER_INPUT/AI_OUTPUT/SLASH_COMMAND 各放置位 + 仅格式显示/仅格式提示词)
- 宏/STscript({{var}}/{{getvar}} 等 + /命令)
- depth_prompt / AN / extension prompts(可带 scan 参与 WI 扫描)
- **MVU 更新协议**:LLM 输出 `<UpdateVariable>` 块,`_.set('path',old,new);//reason` 方言
  (beta 分支为 JSONPatch RFC6902 方言)→ 服务端消息后处理,产出 stat_data 写入 chat 变量。
  显示正则 `/<UpdateVariable>[\s\S]*?</UpdateVariable>/gm` 负责从显示剥离。
- EJS 模板(CardForge 等工具生成的模板脚本,运行时 eval —— 待确认范围)

### B. 显示面(client-side,面板宿主域)
- **正则→HTML 状态栏**:AI 输出标记被正则替换成 HTML,渲染在消息体内
  (最轻形态,诡异修仙即此类)
- **TH 楼层 iframe**:消息内 `<script>` 被 TH 包进 `TH-message--{楼层}--{idx}` iframe,
  生命周期随楼层渲染/销毁
- **TH 脚本 iframe**:`TH-script--{name}--{id}` 后台常驻脚本,跨楼层存活
- **同层前端(C5)**:0 号楼 shell 闭合完整玩法(教主卡 galgame 即此类)——
  真实聊天继续生成,shell 只做镜像/输入/路由。**这正是我们"面板页"的生态对应物**
- **宿主 DOM 挂载**:脚本经 window.parent 把 UI 挂进 ST 主页面(#extensionsMenu 等)
  —— 我们的客户端无此面,需优雅降级

### C. 状态面(bridge 域)
- 变量作用域:`chat`(跨楼层共享,最常用总线)/`global`(跨卡)/
  `message`(单楼层,可负索引)/`script`(脚本绑定)/`preset`/`extension`(v4.6+)
- `getVariables`/`replaceVariables`(同步,全量替换)/`insertOrAssignVariables`/
  `insertVariables`/`updateVariablesWith`/`deleteVariable`(dot-path)
- `getAllVariables` 合并序:全局→角色卡→聊天→0号楼→当前楼层
- MVU MvuData:`stat_data`(注入回 LLM)/`display_data`(纯渲染)/
  `initialized_lorebooks`;VWD[值,描述]已废弃,zod schema+.describe()承接
- 消息 `data` 字段(楼层快照),`$`前缀键对 AI 不可见
- 恢复优先级:真实聊天 > chat/message 变量 > localStorage > iframe 内存

### D. 控制面(bridge 域)
- 事件总线:eventOn/eventMakeFirst/eventMakeLast/eventOnce/eventEmit/
  eventEmitAndWait/stop();iframe 销毁自动卸载;tavern_events(80+)+
  iframe_events(6 个生成/渲染生命周期)
- `injectPrompts({id,position:'in_chat'|'none',depth,role,content,should_scan,filter})`
  → 服务端生成管线注入点等价物(GENERATION_AFTER_COMMANDS →
  BEFORE_COMBINE → CHAT_COMPLETION_PROMPT_READY 三个时机)
- 消息操作:getChatMessages(range/role/hide_state/include_swipes)、
  createChatMessages、setChatMessages(refresh:none|affected|all)、
  deleteChatMessages、rotateChatMessages、refreshOneMessage
- **主链路铁律**:玩家动作 → createChatMessages(真 user 楼) → /trigger 生成 →
  真 assistant 楼 → 变量管线 → 镜像。`generate()` 不产生楼层,不能当正常回合。
- **is_hidden 铁律**:绝不为视觉效果把真实消息设 is_hidden(改变 LLM 上下文语义);
  显示适配只能藏视觉。

## 2. 远程供应链(jsdelivr 生态)

真实卡脚本普遍 `import 'https://*.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>.js'`:

| URL 模式 | 缓存语义 | 风险 |
|---|---|---|
| `gh@semver-tag` / `@commit` | 永久不变 | 低 |
| `gh@branch`(main/master) | ~12h 滚动 | 中(内容漂移) |
| `npm@version` | 永久 | 低 |
| `npm` 无版本 / `@latest` | ~7d | 高 |
| `testingcf.jsdelivr.net` | 社区常用镜像,同内容 | 同源不同域 |

已知生态级远程依赖:
- `MagicalAstrogy/MagVarUpdate/artifact/bundle.js`(MVU 引擎本体)
- `lolo-desu/lolocard/dist/变量管理器/index.js`(Vue3+Pinia 变量调试面板,
  再引 pinia/klona 的 npm +esm)
- 素材库/地图插件/战斗引擎等卡内大附件(荒野求生 30MB 级)

**机制层设计推论 — 服务端 CDN 代理缓存**:
面板的 WebView 不直接出网,远程模块经 `/api/cdn-proxy/<url-hash>?url=…` 由服务端
拉取+缓存+完整性校验(SHA-256)+来源白名单。收益:统一出口控制(CSP 只放行
我们的源)、离线可用、版本指纹可审计、对**任意**卡生效(不是逐卡适配)。
卡声明 `card_app.resources.allowlist` 时按声明放行;未声明时按域名级
(jsdelivr/unpkg/cdnjs 等已知 CDN)+ 逐 URL 审批准入。

## 3. TH-shim 的 API 面分层(T0/T1/T2)

按生产卡实测频率分层实现(来源:C1 文档置信度标注 + 语料解剖):

**T0 必须(缺了面板就是废的)**
- getVariables/replaceVariables/insertOrAssignVariables(chat/global/message/script)
- eventOn/eventOnce/eventEmit + tavern_events/iframe_events 常量 + stop() disposer
- getChatMessages/getLastMessageId/getCurrentMessageId
- injectPrompts/uninjectPrompts(→ 服务端注入点)
- waitGlobalInitialized/initializeGlobal(跨 iframe 接口共享)
- getCurrentMessageId 楼层语义(面板宿主按"楼层 0 shell"身份上报)

**T1 高价值**
- setChatMessages/deleteChatMessages/refreshOneMessage → 消息写回 + 事件
- createChatMessages + triggerSlash('/trigger') → 我们的生成 API
- substituteMacros、errorCatched、getScriptId
- 变量宏 {{get_chat_variable::}} / {{format_chat_variable::}}(core 宏层)
- MVU 面:Mvu.getMvuData/replaceMvuData/parseMessage + Mvu.events
  (含 `initiailized` 拼写 bug,必须按 bug 复刻字符串值)

**T2 生态长尾**
- lodash `_`、zod `z`、jQuery `$`、YAML、toastr、builtin(uuidv4/renderMarkdown)
- window.SillyTavern getContext() 子集(chat/chatMetadata/name1/name2/
  substituteParams/setExtensionPrompt/loadWorldInfo)
- window.parent 宿主访问 → 返回代理空对象/降级 no-op(C1 范式都带 try/catch,
  卡自己会防御)
- Vue/VueRouter/PIXI(有卡的素材库用,可后置)

## 4. 与 C5 同层前端的架构映射(面板页定案)

```
TW-C5: 真实消息层(ST chat) → bridge 常驻脚本 → 0号楼 shell iframe
我们 : 真实消息层(server chat+chat_state) → api-client/WS → 面板页 WebView
```

- 面板页 = shell 宿主:加载卡的入口(短标记/声明式 mount),注入 TH-shim
- 玩家动作 = createChatMessages+trigger(走我们的 generate API)→ WS 推送
  MESSAGE_SENT/GENERATION_*/MESSAGE_RECEIVED 事件 → 面板镜像
- 显示适配天然简化:我们的聊天页本来就不内嵌渲染卡 HTML,
  "只显示面板"不需要 ST 那种 DOM 折叠 hack,is_hidden 铁律自然满足
- 恢复语义:面板重绘 = WebView 重载 + 从 server chat_state/变量重读,
  iframe 内存不视为持久(与 C5 一致)

## 5. 待验证悬案(继承 TW 未决项 + 我们特有)

- U-E4:高中生活模拟 golden 中 E4(作息表)边界预算差 2 token —— 需 WI debug
  日志再捕获实证;测试已挂账单条容差
- U-CSP:卡的远程脚本 import 图探测策略(静态扫描 script 内容 vs 运行时
  声明 vs 代理层观察学习)
- U-MVU:bundle.js 原样代理执行 vs 服务端原生实现 <UpdateVariable> 解析
  (前者兼容面最大,后者可控;决策见 design/mobile-panels)
- U-SWIPE:TH swipe API 与我们 swipe 模型的字段映射(include_swipes 形态)
- U-EJS:EJS 模板运行时范围(哪些卡/场景真的 eval EJS)
