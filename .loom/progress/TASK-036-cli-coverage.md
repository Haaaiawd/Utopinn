# TASK-036 — CLI kernel 路由全覆盖(具名动词补面)

**结果:`doctor` capability coverage = 47 routes · named 47 · raw-only 0(此前 16/47)。**
`apps/cli/uberge-cli.mjs` v0.2.0 → **v0.3.0**。

## 新增动词(21 个 + 1 个 mvu 子命令)

| 动词 | 路由 | 备注 |
|---|---|---|
| `char <name>` | GET /characters/:charDir | 模糊名→resolveChar→目录名;卡全文 |
| `chat-get [chat]` | GET /characters/:charDir/chats/:chatName | uberge doc {header,messages,integrity};刷新 state |
| `chat-create <name>` | PUT …/chats/:chatName | 立即建空文件(chat-new 仍是懒建坐标) |
| `world-edit <name>` | PUT /worlds/:name | `--json-file|--stdin|inline json`,需 {entries:{}};upsert |
| `world-delete <name>` | DELETE /worlds/:name | 显式名 |
| `preset-get <name>` | GET /presets/:name?apiId | 缺省=state.preset;`--out` 写 doc |
| `preset-edit <name>` | PUT /presets/:name?apiId | doc upsert;`--api` 换族 |
| `preset-delete <name>` | DELETE /presets/:name?apiId | 删 ctx 绑定预设时清 state.preset |
| `personas` | GET /personas | avatar/name/title/default 表 |
| `persona-edit <avatar>` | PUT /personas/:avatar | JSON doc 或 `--set k=v`(name/description/position/title/is_default) |
| `persona-delete <avatar>` | DELETE /personas/:avatar | 双表摘除 |
| `settings` | GET /settings | 服务端脱敏视图,顶层段摘要 |
| `settings-set` | PATCH /settings | 本地先挡白名单外顶层段(只放 power_user/extension_settings) |
| `secrets` | GET /secrets | **客户端再打码**:即使服务端 allowKeysExposure 也只露末 2 位 |
| `secret-set <key> --value|--stdin [--label l]` | PUT /secrets/:key | 服务端铸 id;**--id 显式报错**(PUT 无 id 语义);stdin 防密钥进 shell 历史 |
| `secret-delete <key> <id>` | DELETE /secrets/:key/:id | |
| `mvu panel <tpl|--file|--stdin>` | POST /mvu/panel/render | scope 缺省=ctx chat 变量;`--out`/`--html` |
| `import-scan <dir>` | POST /import/scan-st | 服务端路径(admin) |
| `import-preview <f|--file|--stdin>` | POST /import/preview | 本地文件→{name,dataBase64};422 hints 透出 |
| `import-commit <f> [--conflict p] [--as n] [--kind k]` | POST /import/commit | 409 → `--conflict rename|overwrite|skip` next-hint |
| `backup [--out f|dir] [--set cat=bool]` | POST /backup | zip attachment 自管 fetch;content-disposition 文件名 |
| `lan-offer [--set|--json-file sel]` | POST /lan/offer | 一次性 url+expiresAt |
| `lan-import <url|--code>` | POST /lan/import | 代理 legacy 恢复;`--mode merge|overwrite`;240s 超时 |

## 顺手切到 kernel 路由的既有动词

- `chat-rename` → POST …/chats/:chatName/rename `{newName}`(弃 legacy /api/chats/rename)
- `chat-delete` → DELETE …/chats/:chatName(弃 legacy /api/chats/delete)
- `presets` → kernel GET /presets(缺 items 回退 legacy /api/presets/list)
- `chats` → kernel GET …/chats(messageCount/updatedAt;缺 items 回退 legacy。**修了一个真 bug**:kernel `lastMessage` 是整楼层对象,直接 trunc 出 `[object Object]`,已摘 `.mes`)
- `chars` → kernel GET /characters 合入 `tags`/`readable`(不可读卡标 `!`);chat 指针仍取 legacy all(kernel 无此字段,故双源合并)

## 新 flag

`--json-file f`(JSON 文档源)/ `--file f`(二进制/模板载荷)/ `--name` `--id` `--value` `--label` `--code` `--dir` `--html` `--api` `--kind` `--conflict` `--as` `--mode` `--handle`

## 注意点

- **`backup` 不走 `req()`**:响应是 zip 二进制 attachment,`req()` 会 JSON.parse 毁数据;自管 fetch + arrayBuffer。
- **`secret-set` 与任务规格的偏差**:规格写 `--id`,但 PUT /secrets/:key 服务端固定 `writeSecret` 铸 uuid,无 id 入参——给 --id 显式 fail 并指路 secret-delete,防「以为改了 X 实际建了 Y」。
- **`import-scan`/`lan-*` 是服务端侧路径/远端 URL**,schema desc 已注明。
- settings-set 冒烟后 `power_user.__cli_probe__` 残留为 `null`(PATCH 只合不删,最净残留;scratch server)。

## 验证(全程未 send/generate/swipe,未碰 live chat)

- `node --check` ✓;`schema` 62 命令解析 ✓;doctor ✓(47/47)
- 往返验证:world-edit→wi→world-delete ✓;preset-edit→preset-get→preset-delete ✓;persona-edit→personas→persona-delete ✓;chat-create→chats→chat-delete ✓;secret-set→secrets(掩码)→secret-delete ✓;import-commit(建卡)→chars→legacy delete 清理 ✓;settings-set merge+白名单拒绝 ✓
- backup 实下载 18MB zip(服务端文件名)✓;lan-offer url+过期 ✓;mvu panel 模板渲染+--out ✓
- 错误路径:secret-set 非法键 400、settings-set 越权段、import-scan 404、lan-import bogus url、import-commit 409→--conflict hint,全部规整 fail envelope + rc。

## 剩余 raw-only:**0**(kernel HTTP 面全绑;`upgrade|/api/ws-delivery` 由 streamJob/attach 走 WS,不在差集)

capability.md 组件面表已同步(原来写着 worlds/presets 写面要走 raw,已换成具名动词)。
