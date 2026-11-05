# 后端 Audit:持久化与插件内核(代理 6d328289,2026-11-04)

## 总评:中等偏好
骨架认真:JSONL 原子写、repo integrity CAS(sqlite 下为真)、gen_id 去重、restore 快照+回滚、effect 化清理(10/10 插件合规)、degraded 不连坐。失分:报告层谎言、两条直通进程退出路径、门禁缺口。
「插件炸了」:一般不连累宿主;例外=upgrade handler 同步 throw(H3)+管理面全员开放(H1)。
「关机数据」:单文件原子写安全;多文件序列(chat↔sidecar/oplog/restore)可撕裂;内存态(生成任务/订阅/票据)全丢。

## 🔴 HIGH
- **H1 插件管理面无 admin 门** `uberge-plugins.js:30-42`:任意登录用户 disable uberge-delivery→全站断流(对照 isRequestAdmin 先例 server-main.js:571 漏抄)
- **H2 apply 抛错谎报 active**:cordis fiber 异步执行 apply,错进 fiber._error 不外抛;`loader.ts:119-131`/`kernel-boot.js:71-78` 无条件记 active→/plugins 全谎报。重复 enable 可复现 FAILED 仍回 ok:true。修:apply 后 await tick 查 fiber.state
- **H3 upgrade handler 无 catch → 进程退出** `webserver.ts:136-142`:同步抛错→uncaughtException→exitProcess;网络可达(/api/ws-delivery 任意 upgrade)。同类:subscribeToJob 未包、wss.handleUpgrade 未包。修:upgradeListener try/catch destroy socket
- **H4 关机不 drain**:exitProcess 只 cleanupPlugins(legacy 系统)——Cordis fiber 从不 dispose;在途写/生成任务/persistGeneratedReply/备份流不等;15s 宽限内回复丢

## 🟠 MEDIUM
- **M1 fs 引擎 TOCTOU 丢写** `fs-engine.js:16-19`:withTransaction 无互斥;save/append 的 get→check→put 中间留 microtask await→交错双过 CAS 静默丢写(sqlite/mysql/postgres 有真事务,仅 fs 引擎)。修:按 key 串行化或收同步块
- **M2 chat↔sidecar 撕裂** `chat-repo.js:150-158`+`mvu-settle.js:108-126`:两笔独立事务;appendMvuOpLog 侧车本身无 CAS 且 getState catch(()=>null) 把损坏侧车当空→oplog 清零;侧车旧→integrity_mismatch 卡死;孤儿侧车被同名新 chat 继承
- **M3 /api/uberge/* 全绕过 sync 写门** `in-progress-gate.js:70-108`:mvu settle/persistGeneratedReply 不拿 reader 槽→sync 快照拿撕裂对
- **M4 备份流无快照+error 回调二次退出** `users.js:1480-1564`:归档期改文件→撕裂;`archive.on('error')` 在 headersSent 后 send→ERR_HTTP_HEADERS_SENT→uncaughtException→退出。restore 侧好(快照+回滚)但硬崩留截断+残留无清理
- **M5 wss.close 不杀既有 socket** `uberge-delivery.js:252-256`:reload 后旧实例 socket 残留+双订阅(注释防的场景在重载窗口复活)。修:disposer 遍历 clients terminate
- **M6 patch.yaml 非原子+竞态+损坏拒启动** `kernel-boot.js:53-69`:读改写裸 writeFile;且 patch 存整行会永久遮蔽 base profile 后续变更——改存 {id,disabled} 增量

## 🟡 LOW(摘)
L1 jobSubscribers/job 终结后不清(注释撒谎有界);L2 lan/import 全量缓冲+无超时;L3 onRequestClose 版本/传输相关失效风险;L4 rename 三步非原子;L7 profile.yaml 坏=启动失败(预期);L8 全部 job/sub/ticket 进程内存(重启丢,多实例不共享)

## 一致性
profile.yaml 10 行↔10 实物一一对应,无幽灵插件。inject 全有提供方。

## 优先级建议(原报告)
H3 → H1 → H4 → H2 → M1 → M5 → M3 → M6 → 低项顺手清
