# utopinn-acceptance — CLI 验收矩阵(TASK-038 收尾件)

单文件 runner,零新依赖。起一台 scratch 服务端(e2e `_lib/server.js` 同款
harness:克隆 `data/` 种子 + OS 空端口 + 就绪轮询,`LUKER_PREBUILT_BUNDLES_DIR`
命中时跳过 webpack 编译),预置最小语料(1 张卡、2 个预设、1 本世界书、
settings 探针),随后按域逐个跑 `apps/cli/utopinn-cli.mjs` 动词,断言
rc + `--json` envelope。

## 用法

```bash
node apps/server/tests/utopinn-acceptance/run.mjs [--keep] [--verbose]
UTOPINN_E2E_SCRATCH_ROOT=/tmp/xyz node apps/server/tests/utopinn-acceptance/run.mjs
```

- `--keep`:保留 scratch dataRoot / CLI state / backup 产物,便于排查。
- `--verbose`:PASS 也逐条打印(默认只打 FAIL 与分组头)。
- `E2E_READY_TIMEOUT_MS` 默认已拉到 600s;/mnt 盘冷起一次约 2–10min。
- 退出码:全过 0,有 FAIL 1。

## 覆盖面

kernel/doctor(66 named,`capability coverage` 必须报 `raw-only 0`)·
library 读面(chars/char/chats/chat-get/presets/worlds/wi/personas/recent/
settings 脱敏两态/secrets 写删)· chat 写面(chat-create 重名 rc3、
chat-put CAS 正常 + 陈旧 integrity 409 自动重锚、服务端 CAS 409 实证、
chat-rename/chat-delete)· generate 干跑 preview(messages 非空)·
jobs(jobs 列表、inspect 真 job + not_found)· mvu state · plugins 列表 ·
backup zip 产物 · settings-set PATCH→回读+白名单拒 · state sidecar 三族全链
(get→patch→get→get-batch→delete→空读,char 加 set,preset 加
delete-all/rename)· 冲突路径(preset rename 撞档 rc3、三族 patch
test-fail rc3)· 错误面(unknown verb rc2、not_found rc1)。

## 不覆盖(任务边界)

真 LLM 生成(外部密钥)——`generate` 实弹派发仅用于在 job store 造一条
job 供 jobs/inspect 断言,上游指向 runner 内挂的 hang-server(收连接
永不回包,job 常驻 `running`,teardown 收掉),零外部依赖;
WS 流式面(head/chunk/end 帧)留待后续切片。doctor 自身的 ws-ticket
握手探针是 doctor 契约一部分,在覆盖内。

## 已知 CLI 缺陷与绕法

- **大 envelope 被截断**:`utopinn-cli.mjs` 末尾 `process.exit(exitCode)`
  在 `console.log(envelope)` 未 drain 完时先退,~140KB 级载荷(settings
  /raw 大响应体)stdout 被截成非法 JSON。rc 不受影响(仍是 0),只丢
  stdout 尾部。验收绕法:`settings --out <file>`(CLI 进程内同步落盘,
  文件完整)做脱敏/回读内容断言;`raw` 只断言 envelope 前缀的
  `"status":200`;raw=1 明文键断言走 runner 直连 `/csrf-token`+cookie
  握手(同一 /api/utopinn 面,仅绕开 CLI stdout 传输层)。**后续修 CLI
  时应把 `process.exit` 换成 `process.exitCode=` 或等 stdout flush。**
- **`inspect` 对 failed job 误报 not_found**:`cmdInspect` 把 job 自带
  `error` 字段当成「job 不存在」,故本矩阵只对 running 态 job 断言
  inspect(上游 hang-server 保证 job 不落地成 failed)。
