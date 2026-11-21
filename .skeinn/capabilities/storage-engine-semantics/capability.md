# 存储引擎事务语义(fs/sqlite/mysql/postgres 差异决策树)

> 同一个 Repo API,四种事务真相。选型不选边,定语义分层。

## Field identity and boundary

四引擎(FsEngine/SqliteEngine/MysqlEngine/PgEngine)在统一 Engine/Transaction
接口下的语义差异:事务强度、check-and-write 原子性、名字解析、读侧指标可
比性、落盘/入库边界、迁移副作用。不含:Repo 层资源语义(integrity OCC/
gen_id 去重/patch 幂等——那是 repositories/ 自己的契约)、端点路由迁移
进度(README §Repo coverage)、备份 ZIP 格式。

## Project scenario

fs/sqlite 双引擎语义分层已落地并默认 fs 兼容、sqlite 部署推荐

## Decision tree

### C1: 引擎选择

- entry_when: 部署/运维定 storage.mode
- options:
  - A: fs(默认) → leads_to: C2;代价:事务=进程内串行,非真 ACID
  - B: sqlite → leads_to: C2;真事务兜底,多客户端/并发/同步场景的推荐
  - C: mysql/postgres → leads_to: C2;大部署逃生位,隔离级警告随行
- decide_by: 卡生态零摩擦与人眼可查 vs 真 ACID 需求——v2-stack-decisions 已拍板「不选边,定语义分层」:fs=兼容默认,sqlite=部署推荐,mysql/pg=逃生位
- source: design/v2-stack-decisions.md §存储/数据库;storage/README.md §Layers; research/storage-codebase-evidence.md
- counterexample: 以为 sqlite 是「fs 的升级版可默认」——fs 的字面磁盘约定是兼容资产(rsync/Syncthing/vanilla ST 互开),sqlite 换的是并发安全不是兼容
- output: 引擎=启动期 config;代码不感知引擎,语义差异按 C2-C5 显式登记

### C2: withTransaction 的事务强度分级

- entry_when: 写路径需要多步读-改-写
- options:
  - A: 依赖真事务(失败回滚) → leads_to: 只在 sqlite/mysql/pg 成立;fs 上同代码静默变部分写
  - B: 只用串行化(临界区,不承诺回滚) → leads_to: 四引擎通用下界
- decide_by: 闭包里抛错后「早先写要不要撤」——fs 的 withTransaction 只跑 sequential fn,先成的写**不回滚**(README §What FS mode does NOT provide);sqlite BEGIN IMMEDIATE→COMMIT/ROLLBACK 真事务(sqlite-engine.js:150);mysql/pg 各自租池连开 BEGIN,回滚真但隔离级是驱动默认(InnoDB RR / pg RC)
- source: storage/README.md:112-115、157;engines/sqlite-engine.js:139-162;engines/fs-engine.js:20-29; research/storage-codebase-evidence.md
- counterexample: 以为「withTransaction 同名 = 同事务语义」→ 在 fs 上写多资源改动,中段抛错留半组脏文件,没有任何机制提示你回滚不存在
- output: 写路径按「串行即可」设计;必须回滚的多步写是 sqlite+ 专属能力,不能无条件用

### C3: check-and-write(createIfAbsent 类)原子性分级

- entry_when: 「不存在才建」式写入(resolve→check→put 一单事务)
- options:
  - A: 信任单 withTransaction 原子 → leads_to: fs/sqlite 成立(per-handle promise tail = 真临界区);mysql/pg 不成立
  - B: 容忍 last-writer-wins → leads_to: mysql/pg 上的真实语义
- decide_by: 并发写者撞同一空位时输家的后果——mysql/pg 各租池连、隔离级默认,两个并发 createIfAbsent 都 resolve「absent」→ 都 upsert,输家堵在 PK 后 ON DUPLICATE KEY UPDATE / ON CONFLICT DO UPDATE 覆盖赢家 doc,**两边都报 created:true**
- source: repositories/world-info-repo.js:23-74 createIfAbsent 注释块(实证分级原文);engines/mysql-engine-transaction.js:138-154;engines/postgres-engine-transaction.js:148-157; research/storage-codebase-evidence.md
- counterexample: 以为 createIfAbsent 各引擎同语义 → mysql/pg 双写覆盖,先入书被后入书整 doc 替换且双方都以为自己是创建者;补救要锁读 handle 名集或 serializable,StorageTransaction 面表达不了
- output: createIfAbsent 在 mysql/pg 标「非全原子但仍优于 resolveName()+save() 两事务对」;消费方不许把 created:true 当排他凭证

### C4: 名字解析(resolveName/宽容查找)与 collation 绑定

- entry_when: 资源名有「显示名 vs 存储键」宽容查找需求(worlds/presets/named_docs/chats)
- options:
  - A: 规范化放 JS 层(normalizeLookupText:NFC+变体选择符剥离),db 列等值保持字节级 → leads_to: 四引擎同语义
  - B: 依赖 db collation 做大小写/重音宽容 → leads_to: 引擎间行为分叉
- decide_by: pk 等值是否字节精确——mysql schema 已钉 utf8mb4_bin(对齐 Linux fs 大小写敏感);pg 默认 deterministic collation 天然字节比;**pg 库若被部署成 ICU 非确定 collation,`=` 开始认 locale 规则,resolveWorldName 会把两个视觉不同的名绑到同一行**
- source: engines/postgres-engine-transaction.js:452-468;engines/mysql-schema.js:15(utf8mb4_bin);storage/README.md:185(pg collation 警告); research/storage-codebase-evidence.md
- counterexample: 运维给 pg 集群挂 icu `und-x-icu` 非确定 collation → `name='ABC'` 匹配 `name='abc'` 的行,resolveName 错绑、put 覆盖错书;mysql 侧无此坑(schema 钉死 bin)
- output: resolveName 走 JS 层 normalize,exact 先行;部署文档钉「pg 保持默认 collation 或 COLLATE "C"/"POSIX"」

### C5: 读侧指标跨引擎可比性(chat_size/updatedAt/integrity)

- entry_when: UI/CLI 展示或排序依赖引擎报的元数据
- options:
  - A: 当权威指标跨引擎比较 → leads_to: 数字打架
  - B: 当「粗指标」单引擎内自洽使用 → leads_to: 安全
- decide_by: 指标答的是不是同一个问题——chat_size:fs=statSync(jsonl).size(含换行/JSONL 平铺形),sqlite=length(doc)(canonical JSON 串);updatedAt:fs=mtimeMs(OS 落盘时刻),sqlite=Date.now()(repo 调 save 时刻);两者都是粗指标不是同一把尺
- source: storage/README.md:177-184(§What's intentionally different);migration 语义 §283-284; research/storage-codebase-evidence.md
- counterexample: 拿 updatedAt 跨引擎排序 → fs 的 mtime 是 OS 写盘时间(外部触碰也更新),sqlite 是 save 调用时间,迁移后全员重置成「迁移时刻」,/api/chats/recent 排序乱到下次保存
- output: 指标只在同引擎内排序/展示;迁移文档记「时间戳重置 + integrity slug 旋转 + OCC 重试一次是正常路径」

### C6: 落盘 vs 入库的资源边界

- entry_when: 新资源类型决定存哪
- options:
  - A: 结构化资源(表可查) → leads_to: 进引擎表(chats/settings/presets/worlds/named_docs/groups/stats + sidecar 两族)
  - B: blob/目录树/三方格式/单文件工件 → leads_to: 永远落盘(卡 PNG/头像/背景/扩展树/vectors/secrets/快照备份),任何引擎模式下同
- decide_by: 是否需要跨用户查询 + 驱动 fetch 语义是否适合流/seek——BLOB 列难流难寻址,扩展树要目录语义,vectors 有自有格式,secrets/快照生命周期天然单文件
- source: storage/README.md:316-343(§Where user data lives + §Why some resources stay on disk); research/storage-codebase-evidence.md
- counterexample: 把卡 PNG 也塞进表 → 备份/恢复要重走流式 BLOB,migration 语义表里「fs 目录树即备份」的对称性碎掉;备份 ZIP 双段(_engine_dump.bin + 文件树)正是这条边界的物化
- output: db 模式的备份=引擎 dump + 盘面文件两半;跨引擎恢复必须先 storage-migrate 转格式

### C7: 级联/孤儿语义镜像 fs 而非「更正确」

- entry_when: 给 db schema 定 FK/级联
- options:
  - A: FK 按 fs 行为镜像(chat_states CASCADE 删父清 sidecar;preset_states **不加** FK,孤儿 sidecar 合法) → leads_to: 契约测试 green
  - B: 按关系范式补全 FK → leads_to: 引擎间行为分叉
- decide_by: 端行为是否与 fs 一致——preset rename/delete 的代码路径本就不保证原子清 sidecar,fs 容忍孤儿;sqlite 加 FK 反而制造「sqlite 比 fs 严」的分叉
- source: storage/README.md:175-176(chat_states FK CASCADE vs preset_states 无 FK);tests/storage/repositories/*.contract.js(describe.each 双引擎同套); research/storage-codebase-evidence.md
- counterexample: 给 preset_states 补 FK 想「顺手清理孤儿」→ sqlite 上 preset 删除连带清 state,fs 上孤儿还在,迁移 round-trip 丢数据且两端 UI 表现不同
- output: schema 决策以「fs 端行为」为锚;孤儿数据是语义不是脏数据

### C8: 迁移/只读/多进程边界

- entry_when: 运维迁移引擎或挂只读
- options:
  - A: 单进程内 read-only flag + MigrationRunner(snapshot→copy→verify,destination 走 withReadOnlyBypass) → leads_to: 支持部署形态
  - B: 多进程/负载均衡后直接迁移 → leads_to: flag 不跨进程,半迁移态
- decide_by: flag 住模块态——模块内 readOnly 不传播;verify 剥 integrity(顶层+header.chat_metadata 双处)再比 equality
- source: storage/README.md:196-231、288-290(migration/read-only/multi-process);migration/equality.js stripChatEngineMeta; research/storage-codebase-evidence.md
- counterexample: 两进程后挂 LB 跑迁移 → 源冻结只冻住一个进程,另一进程继续写,verify 过的快照立刻过期;单进程是唯一受支持迁移形态
- output: 迁移=单进程运维动作;backup 落 `<dataRoot>/_storage-migrations/<ts>-<handle>/` 永不自动删

## Stance and rejected defaults

四引擎并存是资产不是包袱:fs 的字面磁盘约定换来 ST 生态零摩擦,sqlite 用
BEGIN IMMEDIATE + per-handle tail 换真事务,mysql/pg 只作逃生位——**不为
「统一」抹平差异,差异全部显式登记成节点**。拒绝:给 fs 加 _journal/_locks
假装事务(破 vanilla ST 兼容);给 mysql/pg 强上 serializable 补
createIfAbsent(面表达不了,收益不抵成本);把粗指标当权威数据用。

## Failure signals

- 「withTransaction 包了就原子」——fs 上部分写无回滚,mysql/pg 上
  check-and-write 撞并发会双 created:true。
- 「resolveName 在 pg 上靠 collation」——ICU 非确定 collation 一上,名字
  错绑、覆盖错书,且只在特定部署复现。
- 「updatedAt/chat_size 排序跨引擎可比」——迁移后排序乱是预期不是 bug。
- 「加 FK 总是更干净」——preset_states 的孤儿是镜像 fs 的合法语义。
- 插件/端点绕 repo 直读文件——「引擎可换」变空话(v2-stack-decisions
  遗留缺口 2,随触碰收编)。

## Relationships without merger

- cli-client:CLI 的 integrity CAS 重试纪律(409→重锚→重试一次)建立在
  C5 的「integrity 旋转/迁移后重试正常」语义上,CLI 卷宗管动词面,本卷管
  引擎侧真相。
- import-export / utopinn-data:备份 ZIP 双段(_engine_dump+文件树)是
  C6 边界的物化;迁移向导 UX 消费 C8 的单进程约束。
- st-engine-compat:fs 模式的字面磁盘约定(JSONL/sidecar 命名)是兼容
  资产,本卷只管它带来的事务代价,编解码归 formats。
