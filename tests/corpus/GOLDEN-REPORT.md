# Golden-Diff 判卷报告 — prompt 组装层

日期:2026-11-03 · 对比对象:`packages/core/dist` `buildPromptMessages` vs 已捕获 ST/Luker golden
Harness:`packages/core/tests/golden-assemble.test.mjs` + `golden-env.mjs`(适配层)

## Golden 形状结论

`tests/golden-diff/capture-golden.mjs` 捕获的是**发给 `/api/backends/chat-completions/generate`
的完整 wire 请求体**: `golden.wireRequests[0]` = `{messages, model, temperature, max_tokens,
stream, presence_penalty, frequency_penalty, top_p}`。
权威对比目标 = `wireRequests[0].messages[]`(`role` + `content`)。
`inspector.requestInspector[0].fullMessages` 是同一份内容的副本,可交叉验证;
`chatSnapshot` 是发送+回复后的聊天态(`<GOLDEN_REPLY_TURN_n>` 占位为 mock 回复)。
golden 不内嵌预设快照/卡数据,需由适配层从语料卡与捕获环境设置还原输入。

## 适配层方法(`golden-env.mjs`)

- **chat**:`chatSnapshot.messages` 剔除 `<GOLDEN_REPLY_TURN_n>` 占位 → Generate() 时刻的
  chat(`chat[0].mes` 已被原版 `substituteParams` 过一次,作为输入事实直接采用;装配时再
  subst 是幂等路径)。私有卡捕获里 **Generate 时 chat 不含 user turn**(快照只有问候+占位),
  按捕获事实复现,不补发。
- **card**:`@utopinn/formats` 读 PNG → `cardData`;字段经 `baseChatReplace` 等价处理
  (`substituteParams(replaceCharacterCard:false)` + `\r` 剥离;`collapse_newlines=false`)。
  `jailbreakOverride` = `post_history_instructions`,`systemPromptOverride` 空
  (`prefer_character_prompt/jailbreak=true`,卡均无 `system_prompt`)。
- **preset**:内联捕获环境 Default 预设常量(`CAPTURED_PROMPTS`/`CAPTURED_PROMPT_ORDER`/
  `CAPTURED_OAI_SETTINGS`),来源 `apps/server/data/default-user/OpenAI Settings/Default.json`
  (与 `default/content/presets/openai/Default.json` 一致)。`prompt_order` 取
  `character_id=100000` 默认序;`personaDescription` 空 persona 下两序 wire 等价。
- **settings**:`names_behavior=0`、`squash=false`、`pin_examples=false`、
  `contextTokens=4095`、`responseTokens=300`、`wi_format={0}`。
- **WI**:embedded book → `convertCharacterBook` → `mergeLoreSources`(character_first,
  boundWorld=卡 `extensions.world`)→ `checkWorldInfo`(捕获 WI 设置:depth2/budget25/
  mww=true/recursive=true;tokenizer=`js-tiktoken` `o1`,计数 `encode+5`,同 wi-trace)。
  before/after 桶进 `req.worldInfo`;depth 条目 + 卡 `depth_prompt` + AN 合并进
  `extensionPrompts` 面,经 `deps.depthInjection` 复刻原版
  `getExtensionPrompt(IN_CHAT,depth,'\n',role,wrap=false)`;`maxDepth=10000`。
- **deps.substCtx**:`name1`(=`last_user_persona.name` 或 'User')、`name2`、genChat、
  `chatMetadata`(快照克隆)、`globalVariables={}`、`cardFields`(已 subst 字段)、
  `mainApi='openai'`、`model`。
- **未启用面**:正则脚本不重放(捕获 `character_allowed_regex=[]`、`regex=[]`);
  群聊/continue/impersonate/工具/媒体路径未触发。

## 逐卡统计

| 卡 | golden 消息 | actual 消息 | 精确一致 | 差异明细 |
|---|---|---|---|---|
| default_Seraphina | 8 | 10 | 5 | EMPTY_EXTRA×4,WI_SPLIT×1(g[1-3]→1),WI_ENTRY_EXTRA×1 |
| Wilderness_Survival_auto_1101_v2 | 8 | 9 | 4 | EMPTY_EXTRA×4,WI_SPLIT×1(g[2-5]→1) |
| 废材教主的肉身布教计划 ～ v1.1 | 3 | 8 | 3 | EMPTY_EXTRA×5 |
| 诡异修仙人生模拟器 | 4 | 9 | 4 | EMPTY_EXTRA×5(depth WI 注入位置正确,injected=1) |
| 高中生活模拟 | 9 | 9 | 2 | EMPTY_EXTRA×5,WI_SPLIT×1(g[1-6]→1),WI_ENTRY_EXTRA×1,GOLDEN_CORRUPT×1 |

所有实质内容(主提示、卡字段、WI 条目、newChat、问候、user turn、深度注入)逐字一致;
无任何 CONTENT_DIFF/ROLE_DIFF/消息级 EXTRA/MISSING。

## 差异分类

### 1. 结构差异(引擎行为分歧,疑似引擎 bug,未改 src)

- **EMPTY_EXTRA(每卡 4-5 条)**:core `MessageCollection.flatten()`/`buildPromptMessages`
  保留 `content===''` 的消息;原版 `ChatCompletion.getChat()` 以
  `if (message.content || message.tool_calls)` 丢弃。
  空项 = `nsfw`、`jailbreak` 恒为空 + 空卡字段占位(`charPersonality`、`scenario`,
  无 description 的卡还有 `charDescription`)。
  位置:`packages/core/src/prompt/messages.ts` flatten / `assemble.ts` 出口映射。
  建议修法(另行任务):出口按原版 `getChat` 语义过滤空 content。

- **WI_SPLIT(Seraphina/Wilderness/高中生活 各 1 处)**:core
  `getWorldInfoMessageContents` 把 before/after 桶 `join('\n')` 成单条消息;
  原版 `formatSplitWorldInfoEntries` 在 `wi_format` 恰含一个 `{0}`(或为默认格式)时
  **逐条发出**(prefix/suffix 分到首尾条目)。`wi_format='{0}'` 下每条 WI 应各成一条
  system 消息。位置:`packages/core/src/prompt/assemble.ts:194-199`。

### 2. 截断/预算边界

- **WI_ENTRY_EXTRA(高中生活)**:core 多产出 1 条 before 条目
  (`作息时间表…`,ord 69)。与 `wi-trace.test.mjs` 已记录 KNOWN-GAP 同源:
  WI 预算计数在边界处差约 2 token(预算=round(25×4095/100)=1023),
  公式/排序/输入全部复核一致,剩余差源未定位。保持单条容差口径。

- **WI_ENTRY_EXTRA(Seraphina)**:core 多产出 `glade` 条目(951ch)。
  **非预算**(4 条合计 971tok < 1023);该条目 keys(glade/safe haven/refuge)不在
  chat 中,仅能经**递归**命中(eldoria/power 条目内容含 'glade')。已验证 core 关掉
  `worldInfoRecursive` 即与 golden 一致(3 条)。静态复核原版代码,递归应当同样命中
  ——根因未定位,疑捕获环境递归实际行为差异(需下一次 capture 带 `[WI]` debug 日志
  实证),暂与 wi-trace 同族记为 KNOWN-GAP。

### 3. 采集侧缺陷(golden 数据本身)

- **GOLDEN_CORRUPT(高中生活 wire[8])**:golden 问候正文 `已经` 处为
  `已` + `U+FFFD U+FFFD`;卡面 `first_mes` 与 chatSnapshot 均为正常 `经`(U+7ECF)。
  wire 长度差 = 80 个 `\r` + 1 个损坏字符,完全对上 —— 是捕获传输/编码环节的单字符
  损坏,非引擎差异。core 输出与卡面一致,记采集缺陷不回改引擎。

### 4. 字段缺失

无。golden 不含预设/卡快照,全部由适配层按捕获环境还原,无缺失输入导致的差异。

## 适配层假设(全部在 `golden-env.mjs` 头部注释固化)

1. `prompt_order` 用 `character_id=100000`(假设;两序在空 persona 下 wire 等价)。
2. chat = 快照剔除回复占位;私有卡 Generate 时无 user turn,按捕获复现。
3. `cardFields` 预 subst 等价 `baseChatReplace`;core 无 `skipSideEffects` seam,
   字段含 `{{setvar}}` 时副作用语义略异(本语料无此宏)。
4. 卡 `depth_prompt`/AN/`PERSONA_DESCRIPTION`/EM 条目均已接线;本语料 AN/persona 为空、
   无 EM 激活。
5. `world_info_include_names=true` → WI 扫描文本为 `name: mes` 反转序。
6. mock 模型 `mock-gpt-4o` 归一到 `o1`(o200k)计数,同 capture 环境。
7. `api='custom'`、`type='normal'`、`cyclePrompt` 无。
8. tokenizer 差仅能解释 WI/截断边界级差异,消息体逐字比对不做宽松化
   (唯一合法归一化:时间戳/UUID/水平空白/`\r`,见 `normalizeContent`)。

## 疑似引擎问题清单(仅记录,未动 `packages/core/src/**`)

| # | 位置 | 现象 | 判定 |
|---|---|---|---|
| E1 | `prompt/assemble.ts` `getWorldInfoMessageContents` | WI 桶 join 单条 vs 原版逐条 | 引擎行为分歧(高置信 bug) |
| E2 | `prompt/messages.ts` flatten / assemble 出口 | 空 content 消息上线 | 引擎行为分歧(高置信 bug) |
| E3 | `world-info/engine.ts` 递归激活 | Seraphina glade 多激活 1 条 | 未定位,疑捕获环境差异,待 WI debug 日志 |
| E4 | `world-info` 预算计数 | 高中生活 1 条边界 ±2tok | KNOWN-GAP(wi-trace 已记) |

## 剩余问题

- Seraphina `glade` 递归激活差异:需要在 capture 端开 `console_log_prompts`/WI debug
  复抓一次,确认原版递归未命中的真实原因(候选:捕获时 `world_info_recursive` 实际值、
  buffer 递归文本构成、扫描序差异)。
- WI 预算 ±2tok:同 E4,待 tokenizer 端点口径实证。
- 语料:`tests/corpus/cards/` 目前为空,Seraphina 卡从 `apps/server/default/content/`
  兜底解析;`游戏公司老板.png` 无法解析为卡且无 golden,跳过。
