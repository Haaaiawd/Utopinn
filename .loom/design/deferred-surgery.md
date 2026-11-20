# 延期手术设计 — Cordis 插件内核五项

合规审查留下的五个工程项。每项：**现状证据 → 方案对比 → 推荐 → 风险/回退 → 工作量级**。
文末给实施顺序建议。

证据基线：当前工作区代码（行号以 HEAD 为准）。涉及的核心不变量先钉死：

- **引擎串行化**：`withTransaction(handle, fn)` 的 `fn` 整体是临界区，per-handle 尾链串行
  （fs-engine.js:10-29 `_txTail`，sqlite-engine.js:139-160 `BEGIN IMMEDIATE`/COMMIT/ROLLBACK）。
  即 `repo.patch` 的 `getResource → applyJsonPatch → putResource` 三步在同一 tx 内对同 handle 不交错
  （settings-repo.js:35-44）。**但 ops 是在 tx 外基于可能过期的快照算好的** —— test-op 的作用
  就是检测这个窗口。
- **applyJsonPatch 语义**（repositories/json-patch.js:5-84）：
  - `test`：`hasAt` 缺失即失败 + `_.isEqual` 深比对，失败抛 `PatchTestFailedError`（→ sendError 409，
    utopinn-library.js:117-119）；`path:''` 时 segs=[]，`getAt` 返回整文档 —— RFC 6901 的整文档锚可用。
  - `add`/`replace` 对**对象成员**语义相同（`p[k]=v` 无条件写），仅数组下标行为不同
    （add 插入/replace 覆写，checkIndex:53-59）。
  - `strictParent`（61-69）：任何中间段缺失/非对象 → `PatchMissingParentError`（→409），**不自增生**。
    所以 `/S/k` 写前必须保证 `/S` 父段存在。
  - JSON-Patch **无法 test "键不存在"** —— 并发加同名键是 op 表达力的固有盲区。
- **Repo 家族已有的并发原语**：`repo.patch`（settings/preset/named-doc）、
  `ChatRepo.patch(handle, charDir, name, ops, expectedIntegrity)`（chat-repo.js:107，integrity 锚），
  `putResourceIfMatch`（fs-engine-transaction.js:60，chat 专用）。
- **kernel 路由表可枚举**：`webServer.list()` → `["METHOD|kind|path", …]`（webserver.ts:157-159，
  key 格式见 :62），HTTP 面 = `GET /api/utopinn/_kernel`（utopinn-diag.js:100-110，admin 闸）。

---

## W1 settings PATCH 全 CAS 化

### 现状证据

`PATCH /api/utopinn/settings`（utopinn-library.js:630-709）：

```
662  const existing = await repo.get(handle);        // ← tx 外读
663  const base = existing ?? {};
664  const next = { ...base };
668      next[key] = { ...section, ...sanitizeSettingsDoc(patch[key]) };  // 逐段浅合并
674-701  preset_settings_openai 顶层↔oai_settings 双向镜像（同 patch 顶层优先）
704  await repo.save(handle, next);                  // ← 整文档覆写，last-wins
```

`get→内存合并→save` 之间没有任何锚：并发 PATCH 互相整文档覆写，**写 power_user 的会丢
对方写的 oai_settings**。regex 插件写 settings 走 `repo.patch` + `test` 锚
（utopinn-regex.js:193-198 casReplaceOps、632），撞车 → 409。同一个 settings.json，
两种并发语义并存。

合并规则细节（必须在任何方案里保真）：
- 白名单段：`power_user / extension_settings / oai_settings / world_info_settings`
  （PATCHABLE_SETTINGS_SECTIONS:288）；标量键 `preset_settings_openai`（:296）。
- 非对象段基值按 `{}` 处理（:667）；`null` 标量 = 删键（:693-695）。
- `sanitizeSettingsDoc`（:267-280）**只作用于传入 patch 的段对象**（:668），
  盘上已有的 api_key_* 字段不受影响；响应面再整体脱敏（:705）。

### 方案 A：`SettingsRepo.update(handle, fn)` —— tx 内合并（推荐）

在 repo 加一个方法：把"读→改→写"整体挪进 `withTransaction` 临界区：

```js
// settings-repo.js 新增
async update(handle, fn, { base = {} } = {}) {
    assertWritable();
    return this._engine.withTransaction(handle, async (tx) => {
        const existing = await tx.getResource(this._key(handle));
        const doc = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : base;
        const next = await fn(doc);                       // fn 必须纯计算，不得回调 repo
        await tx.putResource(this._key(handle), { doc: next });
        return next;
    });
}
```

handler 里 :662-704 的合并代码**原样搬进 fn**（spread 合并、镜像、sanitize 顺序全不动），
只是 `base` 变成 tx 内的权威文档。

**为什么这是最正确的形式**：
- 合并输入是**绝对值**（"把这些键写成这些值"），不是增量变换（"x+=1"）。对绝对值写，
  正确的并发语义就是 per-key last-wins —— ops/test 锚在这里不产生任何额外正确性，
  只会制造需要客户端重试的 409。
- 串行化后两个并发 PATCH `{power_user:{a:1}}` 与 `{power_user:{b:2}}` **都落地**
  （今天必丢一个）；同键竞争仍是 last-wins，且赢者由 tx 顺序决定，确定。
- 不引入 409 —— 端点响应契约不变（仍是 `{settings}` 全文档），客户端零适配。
- 缺文档语义自然：`existing==null → fn({}) → putResource` 建文件，与今天 `?? {}`+save
  的行为一致（`put` 是 upsert，fs settings handler mkdir+atomic write，
  fs-engine-transaction.js:515-520）。
- 全或无天然成立：fn 抛错 → fs 侧 put 未执行、sqlite 侧 ROLLBACK —— 不需要任何补偿。

### 方案 B：静态 JSON-Patch ops + 逐键 test 锚（regex 式）

保持 `repo.patch(handle, ops)` 签名，tx 外 get → 按基值算 ops：

```js
// 段存在且键在场:  test /S/k = old + add /S/k = new
// 段存在键缺省:    add /S/k = new          // "不存在"无 test 可锚 → 并发加同名键互丢(固有盲区)
// 段缺失/非对象:   add /S = {} + 逐键 add   // 并发创建 /S → 我们的 add {} 抹掉对方整段(真洞)
// 标量镜像:        add /preset_settings_openai、add /oai_settings/preset_settings_openai(置最后,顶层优先)
```

对比 A：
- **优点**：不动 repo 接口；拿到真冲突检测（同键被并发改 → 409 而非静默 last-wins）。
- **缺点**：①"键缺省→add"和"段缺失→add {}"两个盲区补不上 —— 要么接受小窗口互丢
  （同键新增）要么接受大窗口抹段（段新建），要么退回方案 C 整文档锚；②为绝对值写引入
  409 重试语义，前端/CLI 得定义"409 之后怎么办"（重读重发 = 变回 last-wins，白绕一圈）；
  ③ops 方言是合并逻辑的第二份实现（浅合并的边界规则 —— 非对象段、null 删键、
  sanitize 剥键 —— 都要在 ops 生成器里重演一遍，双写漂移风险）。

### 方案 C：整文档 test 锚（`{op:'test', path:'', value: 旧文档}`）

利用 `path:''` → segs=[] → `_.isEqual(整文档, expected)` 的 RFC 6901 根锚：
ops = 整文档 test + 无条件 `add /S {}`（缺段时）+ 逐键 add + 镜像 ops。
正确性等价于"乐观锁 CAS"：任何并发写（哪怕不相干键）→ 409。
- **优点**：实现最简单，无盲区，不改 repo。
- **缺点**：把并发粒度从"文档"降到"文档"—— 没有进展。settings 是高频低冲突面，
  两个 tab 各改一段就互相 409，等于把今天静默丢写变成吵着丢写。

### 部分失败语义裁决

**单 tx 全或无，不逐段独立 tx。** 理由：
- `preset_settings_openai` 镜像是一个原子对（顶层指针 + oai_settings 内嵌槽），
  拆开可能写一半 —— 正是镜像机制要消灭的不一致。
- 逐段独立 tx 的"部分成功"响应需要新契约（哪些段落了哪些没落），前端按 200 处理的
  现有契约会被静默部分应用悄悄破坏。
- 校验（400/422）全部前置在 tx 外，进 tx 后唯一失败源是存储故障 —— 那种情况全滚才是对的。

### sanitize 剥键顺序

任何方案都保持：**先 `sanitizeSettingsDoc(patch[key])` 剥传入段的密钥形键，再参与合并/生成 ops**。
剥键只作用于传入值（同 :668）；不扫盘（盘上的旧密钥字段不归这个端点管）。

### 推荐与落地

**方案 A**。改动面：
1. `settings-repo.js` 加 `update`（~15 行）；JSDoc 注明 **fn 不可回调 repo**
   （尾链不可重入，fs-engine.js:12 已声明该约束 —— 嵌套会死锁）。
2. handler 把 :662-704 换成 `const next = await repo.update(handle, doc => {/* 现合并代码，base→doc */})`。
3. 可选后续：regex 的 global PUT（utopinn-regex.js:510-511）同样是 tx 外算 ops 无 test 锚
   （putGlobalOps 纯 add），可顺手换 `update` —— 但**不在本次范围**，单列。

**风险/回退**：行为变化只在并发窗口（丢写 → 正确合并），无 API 契约变化；
回退 = handler 改回 get+save（`update` 留着无人用也无害）。测试要补：并发 PATCH
两段不互丢、同 patch 顶层标量优先于 oai 内嵌、null 删键、缺 settings.json 自动建。

**工作量级**：S（repo+handler 各一处，测试新写 4-6 例）。

---

## W3 regex 全量视图性能 —— 卡正则索引

### 现状证据

`GET /api/utopinn/regex` 无 scope → `fullView`（utopinn-regex.js:392-435）：

```
399-406  readdir → 所有 .png/.webp/.json 归并 stem
407-413  每 stem → scopedCharView(378-389)
           → loadRegexCard(301-316):readFile(整个 PNG,常 1-5MB)
             + readCharacterCard(png-chunks-extract + base64 卡 JSON 解码)
             + JSON.parse
           → resolveAvatarFileName(289-298):每卡最多 3 次 fs.access 探测
```

**N 张卡 = N 次整文件读+PNG 解析+大 JSON.parse**，只为掏出 `card.data.extensions.regex_scripts`
一个数组。预设半边已有缓存（preset-repo.js:20-25、157-176 `listWithDocs` 60s TTL），不用管。

已有可复用基础设施：
- `readCharacterData`（endpoints/characters.js:189-217）：`memoryCache`（MemoryLimitedMap）
  按 `card-v2:${path}-${mtimeMs}` 键缓存解析后卡串 + `diskCache` 持久层（:167、194-215）；
  `writeCharacterData` 写时主动失效+回填 `preferredData`（:239-249、297-308）。
  legacy `/edit`、library PATCH 都走这条管线 —— **这是现成的、经生产验证的卡读缓存**。
- `characterResourceView` 派生视图缓存（characters.js:2157-2272）：按 handle+avatar 缓存
  卡投影的先例。

写正则的已知路径（失效面全集）：
- `mutateCharScripts`（utopinn-regex.js:324-359，`withCardWriteLock` keyed 互斥 →
  `writeCharacterData`(.png)/`writeFileAtomicSync`(.json)）。
- library `PATCH /characters/:charDir` —— extensions 白名单含 `regex_scripts`
  （utopinn-library.js:200），经 `writeCharacterData`。
- legacy `/api/characters/*`（edit/merge-attributes/import/delete，仍挂载）、
  utopinn-import 提卡、**文件系统直接改**（用户往 characters/ 丢 PNG）。

结论先行：**失效不能靠写路径挂钩枚举**（枚举不全且永远追赶新路径），必须落到
文件事实（stat）上做惰性失效。

### 方案 A（最小修复）：`loadRegexCard` 换 `readCharacterData`

把 :303-316 的 `readFile + readCharacterCard(raw)` 换成
`JSON.parse(await readCharacterData(file, 'png'))`。mtime 键派生失效天然正确，
写路径经 `writeCharacterData` 自动回填；`mutateCharScripts` 写路径同样受益。
剩余成本：每卡每请求一次 JSON.parse（卡 JSON 可达 MB 级）+ 探测 fs.access。
**~10 行改动拿掉最重的一段（文件读+chunk 提取+base64），但每请求仍 O(N·parse)。**

### 方案 B（推荐形态）：正则专用 slim index

进程内 `Map<absPath, entry>`（挂 handle 进 key 防多用户路径歧义，模块作用域与
`_cardWriteTails` 同级，utopinn-regex.js:267 附近）：

```js
entry = {
  mtimeMs, ctimeMs, size,          // 失效键:stat 三元组
  avatar, name,                    // 视图所需投影(resolveAvatarFileName + card name)
  scripts,                         // cardRegexScripts(card) 的数组 —— 只读契约
  // scripts === null 表示"已判不可解析"(.webp/坏 PNG) —— 负缓存,同键失效
}
```

**读路径（fullView / scopedCharView 共用）**：
1. `readdir(withFileTypes)` 一次拿全文件名 → stem→候选文件列表在内存里归组
   （消灭 resolveAvatarFileName 的逐卡 access 探测；选文件顺序严格保持
   `.png > .webp > .json` = `resolveCharFile` :281-287 语义）。
2. 每张候选文件一次 `fs.stat`（µs 级）：命中且三元组匹配 → 直接用 entry；
   未中/不匹配/负缓存 → `loadRegexCard`（内部已换 readCharacterData）解析 → 回填 entry。
3. 并发 miss：per-path in-flight promise 归并（同 recentChatIndex `buildPromise`
   模式，endpoints/chats.js:343-353），两个并发 fullView 不重复解析。
4. mark-and-sweep：fullView 每轮见到 readdir 全集，清掉不在列的 characters/ 下条目
   （卡删除/改名/换扩展名自然回收）；另加条目数硬上限（如 4096）防爆。

**写路径维护**：`mutateCharScripts` 在 `withCardWriteLock` 内写完后
`fs.statSync` 重取三元组 → 直接回填 `{…stat, scripts: next, name: 从 loaded.card 取}`
（`next` 是刚落盘的数组，免一次重解析）。**这是优化不是正确性依赖** ——
不写这步也只是下次 stat 不匹配走 lazy reparse。

**失效正确性分析（本项的雷区）**：
- tmp+rename 写（writeFileAtomicSync/writeCharacterData）必改 mtime+ctime —— 可靠失效。
- 同源 heisenbug：同 mtimeMs+size+ctimeMs 的内容改写 —— 需要亚毫秒同尺寸覆写或
  刻意 utimes 操作，实际不可能；加 ctimeMs 已把"元数据变内容也变"的边角盖住。
- 库 PATCH 改 `regex_scripts`/legacy edit/外部丢文件：无 hook，纯靠 stat 不匹配 →
  惰性重解析 —— **正确性不依赖任何写路径通知**。
- `.webp`：今天 parse 失败 → 落到 .json/null 链；索引用负缓存条同款 stat 键保持语义，
  坏卡不会每请求重复尝试解析。
- `scripts` 条目的**只读契约**：响应直接序列化不拷贝（每卡省一次深拷贝）；
  所有写都经 `mutateCharScripts` 的 mutator → `scripts.slice()` 产新数组
  （:577、597 已有此纪律）——索引条永不被原地改，文档里钉死这条。

**冷启动**：slim index 本身不持久化 —— 重启后首个 fullView 全扫一次（同今天）；
但重解析走 `readCharacterData` 时 diskCache 已摊掉 PNG 解析成本（开启时），
剩下的 JSON.parse 是一次性成本。持久化 slim index 到 user root（如 `.utopinn/regex-index.json`）
列为可选 Phase 3：注意 **characters/ 目录本身是同步内容**，索引文件不能写进去
（会被当卡/被同步），要放 root 下非 characters 子径；收益有限（省一次启动扫），建议先不做。

### 推荐

**A+B 一起**：A 是 B 的 miss 路径基础（也顺手修了 mutateCharScripts/scoped 读的重复解析），
B 是"索引"本体的最终形态。预设侧不动。

**风险/回退**：
- 最大风险 = 失效漏一条写路径 → 索引出旧 scripts。防线：stat 三元组是唯一事实源，
  写路径回填只是优化；测试要覆盖"外部直接改 PNG 文件 → 下一发全量视图必须反映"。
- `entry.scripts` 只读契约被未来代码原地改 → 在 JSDoc 钉死 + mutator 已 slice。
- 回退 = fullView 改回逐卡 loadRegexCard（索引 Map 无人读即死代码）。

**工作量级**：M-（索引结构+失效+负缓存+归并发 ~150 行 + 测试 6-8 例）。

---

## W5 contrib 双 ESM 实例

### 现状证据

`utopinn-plugins.js` 的 `importRowModule`（:137-158）为读 manifest
**第二次 import 插件模块**：相对 specifier 走 `importPluginModule(row, SRC_DIR, `${mtimeMs}`)`
→ `?t=mtime` cache-bust（loader.ts:61-75 拼 `?t=` 查询串强制新实例）。后果：

- 每个被列出的 enabled 插件存在**两个 ESM 实例**：fiber 里跑的活实例 +
  manifestCache（:136）里躺的只读实例。顶层副作用跑两次（模块顶层挂的
  Map/侦听/建表全双份）。
- manifest 语义"跟盘不跟运行时"（:130-133 注释明说）：文件编辑后 contrib 显示的
  是**盘上新版 manifest**，而跑着的还是旧代码 —— 观测面与运行面漂移。
- `<inline>`/裸 specifier 行走普通 import（:139-141），无 bust —— 反而是单实例。
- mtime 缓存把实例数控制在"每文件版本一个"（而非每请求一个）—— 已经修过
  按请求 bust 的慢性漏（:131-133 注释），但双实例本体没修。

活实例在哪：kernel-boot 的 `applyRow`（:122-131）拿到 `mod` 后只存 `fiber` 进
`fibers`/`results` Map（:82-83），`mod` 对象随即丢弃；kernel `loadProfile`
（loader.ts:96-131）同样只在 `results.push({id,status,fiber})`（:131）里留 fiber，
`LoadedPlugin`（:14-21）没有 module 字段。

### 方案 A：`pluginManager.module(id)` 活句柄（推荐）

最小形状三步：
1. `packages/kernel/src/loader.ts`：`LoadedPlugin` 加 `module?: PluginModule`，
   `loadProfile` 在 `results.push` 处带上 `module: mod`（:131）。
2. `kernel-boot.js`：`applyRow` 的 results.set 带 `module: mod`（:127）；
   `pluginManager` 加 `module(id)` → `results.get(id)?.module`。
   disable/失败路径 `results.set(id, {id, status})` 天然丢句柄（:170、:185、:203）。
3. `utopinn-plugins.js` `importRowModule`：`const live = ctx.pluginManager.module?.(row.id);
   if (live) return live;` 优先吃活实例，**文件导入兜底保留**（failed/degraded 插件
   没有活实例但 contrib 仍要列它们的 manifest）。

顺带收益：`<inline>` 行与裸 specifier 行第一次也能拿到 manifest（文件导入根本
碰不到 inline 模块对象，:139-141 直接 return null）。

### 方案 B：取消 manifest 侧 bust（只读共享实例）

`importPluginModule(row, SRC_DIR)` 不带 bust → Node ESM 缓存命中活实例。
- 优点：一行改动，零新增 API。
- 缺点：**等于方案 A 的子集但语义更糟** —— 插件文件编辑后 reload 用 `?t=Date.now()`
  造了新实例，而 manifest 无 bust import 拿到的是**旧缓存实例**（ESM 缓存按
  specifier 不含 query 键），contrib 永远滞后一代；且对 failed 插件仍然要多一份
  兜底逻辑。不可控，否。

### 推荐

**A**。语义变化要声明：contrib 从"跟盘"改"跟活实例" —— 编辑文件后 `/ui/contrib`
显示的是**运行中插件的 manifest**（更真实：面板声明应该反映正在跑的代码；
想看新声明 → reload，行为自洽）。`manifestCache` 保留给无活实例的兜底路径。

**风险/回退**：kernel 是 TS 包要重 build（`pnpm -F @utopinn/kernel build`）；
`module` 句柄让外部代码能摸到插件模块对象 —— 只读使用是约定（utopinn-plugins
只 `readManifestContrib`，不改状态）；回退 = importRowModule 去掉 live 分支。

**工作量级**：S（三处小改 + contrib 回归一眼）。

---

## 闸表 × 路由表覆盖测试

### 现状证据

`GATED_ROUTES` 手抄表（in-progress-gate.js:70-131），utopinn 面在 :108-130。
`syncWriteGateMiddleware`（:389-431）只对 `WRITE_METHODS`（:38）且
`matchGatedRoute` 命中的请求拿 reader 槽（:397-399）。

当前漏管枚举（我把 13 个插件的全部非 GET 注册对账了一遍 —— 与审查"漏 5 条"口径
略有出入，实际更多）：

| 路由 | 性质 | 裁决 |
|---|---|---|
| `POST /api/utopinn/chats/recent`（library :1439） | 读 ChatRepo+内存索引（ensureRecentChatIndex 纯内存，endpoints/chats.js:215/337） | **补闸 dirty:false**（读用户数据，sync writer 换文件时不能撕裂读） |
| `POST /api/utopinn/state/{chat,char,preset}/get` `get-batch`（library :1532/1558/1744/1764/1972/1994） | 纯读 state sidecar | **补闸 dirty:false**（6 条路由 3 条 pattern） |
| `POST /api/utopinn/jobs/:id/abort`（generate :274） | 纯内存：failGenerationJob 先清 persistTimer（luker-generation.js:705），不写盘 | 豁免 |
| `POST /api/utopinn/connection/test`（connection :460） | 上游探针，无写 | 豁免 |
| `POST /api/utopinn/plugins/:id/{enable,disable,reload}`（plugins :235-237） | 写 `src/profile.patch.yaml` —— 服务配置不是用户数据根 | 豁免（理由注释钉死：闸护的是 user root） |
| `POST /api/utopinn/diag/client`（diag :162） | 内存 diag-bus | 豁免 |

既有 `dirty:false` 先例完整吻合该语义（"reads that may lazily write"，:27-28）：
preview/mvu panel render/import preview·scan-st/backup/lan offer 都是这挂法。

### 测试设计

在 `apps/server/tests/sync/in-progress-gate.test.js` 的 `describe('gate coverage')`
（:521-583，已有 category 覆盖对账的先例）加一节：**枚举 kernel 路由表对账**。

**路由表获取（推荐：进程内真装载，确定性版）**：

```js
import { createAppContext, WebServer, loadProfileFile } from '@utopinn/kernel';
// workspace dep 已在 apps/server/package.json:50
const ctx = createAppContext();
const ws = new WebServer();
ctx.provide('webServer', ws);
ctx.provide('pluginManager', {/* 最小 stub: list/row/enable/disable/reload */});
const loaded = await loadProfileFile(ctx, new URL('../../src/profile.yaml', import.meta.url).pathname);
// 不传 patchPath → 只装 base profile;profile.patch.yaml 已 gitignore(开发本地文件),
// 走 kernel-boot 会把 dev 私有 patch 混进路由表 —— 必须绕开。
// 收尾:for (const r of loaded) await r.fiber?.dispose();
```

- `catalog` 是 `createAppContext` 自带（kernel-boot.js:70 用法佐证），diag 的
  inject 检查只验存在性（loader.ts:104-117）→ 不用 stub。
- 副作用评估：delivery 的 effect 建 `noServer` WSS + unref'd heartbeat interval
  （utopinn-delivery.js:90、236-250）—— 不占端口、不挂进程，dispose 即清；
  generate/stats/script/th 的 apply 只注册路由+命令表。storage 未 init ——
  handler 永不执行，只枚举注册。

**判定逻辑**：
1. `ws.list()` 逐条解 `METHOD|kind|path`；跳过 `upgrade|`、非写方法、非 `/api/utopinn/`。
2. `:param` 段实例化为固定探针（如 `zzz`）。
3. `matchGatedRoute(实例化路径)` 命中 → 通过；未中 → 必须在豁免表。

**豁免表放 src**：`in-progress-gate.js` 旁加 `export const UTOPINN_GATE_EXEMPTIONS =
[pattern → reason]` —— 闸决议集中在闸文件里，reason 注释即"显式豁免"的可审查形态；
测试另断言**反向**：每条豁免 pattern 至少命中一条真实未闸路由（死豁免回收）+
可选断言每条 GATED `/api/utopinn` pattern 至少命中一条活路由（死 pattern 提示）。

### 方案 B（备选）：HTTP 对账

e2e harness 起真 server → `GET /api/utopinn/_kernel` → 同判定。
优点：测的是部署形态；缺点：需要起全套服务+admin session，慢且重，
route 枚举在单元层就能拿真表。否。

**工作量级**：S（豁免表 + 一个 describe；装载 harness ~40 行是一次性资产 ——
CLI 具名表测试直接复用）。

---

## 插件路由 → CLI 具名表自动同步

### 现状证据

`NAMED_UTOPINN_ROUTES`（utopinn-cli.mjs:1052-1146）唯一消费者是 `cmdDoctor`
的 capability coverage 差集（:1185-1191）：`_kernel` 拉全表减具名集 = "raw-only" 待补面。
手抄漂移已发生 —— 而且三种路径形态注定了它必然继续漂：

| 形态 | 例 | 覆盖难度 |
|---|---|---|
| 字面量 | `req('POST', '/api/utopinn/generate')`（:689） | 可扫 |
| 模板插值 | `` `/api/utopinn/characters/${encodeURIComponent(d)}/chats` ``（:1321） | `${}`→`*` 归一可扫 |
| 程序化构造 | `route(tail) = /api/utopinn/state/${family}/${tail}`（:3016）× `STATE_OPS`（:2943-2947）；`plugins/${id}/${verb}`（:2101）；`mvu/${sub}`（:2161） | **扫字面量必然漏** —— 当前表里 18 条 state 路由全是这族 |

### 方案 A：加载期派生表 + 覆盖测试（推荐）

改表不如改生成。**具名集在模块加载时从"命令实现自己用的常量"派生**：

```js
const NAMED_UTOPINN_ROUTES = new Set([
    ...LITERAL_NAMED,                                   // 一次性字面路由(缩到只剩真·单例)
    ...expandStateOps(STATE_OPS),                       // family × ops → /state/<f>/<op>(+GET get)
    ...expandPluginVerbs(PLUGIN_VERBS),                 // enable|disable|reload
    ...expandMvuSubs(MVU_SUBS),                         // settle|resettle(+panel/render 单列)
]);
```

关键：把 `verb`/`sub`/`op` 的**合法词表从命令实现里提取成常量**（STATE_OPS 已是），
具名表与命令实现共用同一词表 —— 加 `state preset foo` 自动进表，结构上无法漂。

**归一化**：两侧都归一成 `METHOD + 段序列`（kernel `:param` 与 CLI `${…}` 段都 → `*`），
`kind`（exact/pattern）不参与比较 —— 消掉"路由 kind 改了表就假阴"的假漂移。
匹配是 segment-wise pattern 覆盖（CLI 的 `plugins/*/*` 能盖住 kernel 的
`plugins/:id/enable`），不是纯集合包含。

**兜底的机械化对账**（真正治漂的那一刀）：复用闸表测试的 kernel 装载 harness，
加一条断言 —— **每条 kernel 路由必须 ∈ 具名集 ∪ `RAW_ONLY` 显式豁免表**
（raw-only = 刻意没有动词的内部面，逐条注释理由）。doctor 的运行时差集保留现状
（它测的是"服务端 vs CLI 版本"的真实漂移，仍是有效信号）。

### 方案 B：插件 manifest 声明路由（任务提示里的原案）

插件在 `ui.contrib` 或新 manifest 字段声明 `cli: {named: [...]}`，CLI 拉 `/ui/contrib`
拼装。**否决**：
- "有没有 CLI 动词"的知识在 CLI 不在插件 —— 让插件声明跨仓库事实，方向反了；
  CLI 加了命令还要回插件 manifest 登记，等于把一张手抄表拆成十三张。
- 路由存在性 `_kernel` 已有，manifest 再声明一遍是纯冗余。
- 唯一合理内核是"插件声明自己供了哪些路由"，但那是 `ws.register` 已经做完的事。

### 方案 C：codegen 写文件

脚本扫 CLI 源码 → 生成 `named-routes.gen.mjs` 入库；测试 assert 与提交一致。
可行但多一套生成物管线（标记区、生成脚本、 freshness 测试）去维护一份
本来就能在加载期算出来的表 —— 除非未来 CLI 被打包/混淆导致自扫描不可行，
否则不必要。列为 B 计划。

### 推荐与工作量

**A**。落地：①命令侧把动词词表提常量（STATE_OPS 已有，补 PLUGIN_VERBS/MVU_SUBS）；
②NAMED 表改生成式；③共享 kernel-route 枚举 harness 加对账测试（含 RAW_ONLY 豁免）。
**工作量级**：S（半天量级，大头是逐命令核对词表）。

---

## 实施顺序建议

依赖链：闸表测试的 kernel-route 装载 harness 是 CLI 对账测试的前置；其余互相独立。
按"先建安全网、风险递增"排：

| 序 | 项 | 理由 |
|---|---|---|
| 1 | **闸表×路由表覆盖测试 + 补闸/豁免** | 纯测试+表项，零运行时风险；立刻闭合审查抓出的缺口；产出 route-enumerator harness 供 #5 复用。顺手套上缺的 1 条 GATED + 3 条 state-get + 豁免表。 |
| 2 | **W5 pluginManager.module** | 三处小改，语义无风险面（contrib 输出更真实）；kernel 包改动先落，后续动 kernel 的其他活不堵在 build 上。 |
| 3 | **W1 settings update-in-tx** | 改的是热端点写语义（并发窗口行为），需要并发测试钉住；`update` API 后续 regex global PUT 可复用。 |
| 4 | **W3 卡正则索引** | 纯性能项但失效正确性最费 review 心思 —— stat 三元组惰性失效 + 写路径回填两层；放 W1 后做，repo/缓存知识热。先落 readCharacterData 换路径（止血），再上 slim index。 |
| 5 | **CLI 具名表派生 + 对账** | 只影响 doctor 观测面，零业务风险；用 #1 的 harness。 |

一条总原则贯穿全表：**把"手抄对账"全部替换成"派生+机械化对账"** —— 五个项里
四个的病根都是同一份事实在两处手抄（settings 合并规则、卡扫描、闸表、具名表）。
设计里每个推荐案都朝着"事实只有一处，其他由它派生或被迫对账"的方向走。
