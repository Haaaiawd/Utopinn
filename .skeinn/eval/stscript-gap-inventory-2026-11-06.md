# STscript 命令缺口清单(代理 12d68096,2026-11-06)

## 计数
上游参考 = apps/server/public/scripts/(Luker 前端,AGENTS.md 行为目标):~307 个 addCommandObject
我们 packages/core/src/stscript/:57 个(variables.ts 39/39 全对等 + messages.ts 14 + parser 4)
**缺口 ~250**。名称层零分叉(我们的 57 全部上游同形)。

## 关键修正
- M12 原清单部分错:/getat /setat 在我们的参考里不存在(ST-1.12+ 新增,fork 后)——非移植缺口,是前向兼容决策项。
- **隐藏 bug**:/gen /trigger 已注册但 host seam 未绑(stscript-env.js:11),静默 no-op。

## 工作令(按性价比)
1. **先绑两个 unbound seam**:host.generateQuiet + host.triggerGeneration → 复用 generate-context + runLukerDispatch。然后 T1 生成控制族(/continue /regenerate /swipe /stop /impersonate /genraw /sysgen /ask)同管线扩 seam + StscriptOp 类型
2. **最便宜批量**:T12 字符串/集合纯函数 ~20 个(upper lower substr replace test match trimstart trimend trimtokens fuzzy array-wrap array-unwrap)+ /tokens(seam 已绑)+ note×5 + reroll-pick —— 零 host 依赖
3. **WI 族 11 个 + QR 族 22 个**:后端齐(engine+endpoints),最大单块工作量;QR 需要 store 抽象
4. **消息/会话操作(T2-T5)**:chat-repo 操作为主,卡脚本高频(/delname /hide /messages /member-* /go)
5. **/inject 族**:core prompt/injections.ts 已有,接 chat_metadata.script_injects
6. **决策项**:(a) getat/setat 要不要为 ST-1.12+ 卡补;(b) DOM 命令走 op-receipt(ui op 类型)还是跳过;(c) /input /popup /buttons 需客户端往返通道或文档化 null 降级
7. **不追**:sampler 命令(Luker 已删)、foreach

## T1 生成控制(最高频,QR 脚本常调)
/continue cont | /regenerate regen | /swipe | /stop generate-stop | /impersonate | /genraw | /sysgen | /ask | (已注册缺 seam: /gen /trigger)
## T2 会话导航 → go/newchat/tempchat/random/closechat/delchat/renamechat/getchatname/forcesave + branch/checkpoint×7(导航类发 op receipt)
## T3 消息操作 → messages/del/cut/hide/unhide/delname/delswipe/addswipe/message-role/message-name/reroll-pick/inject×3
## T4 群聊 → member-* ×9
## T5 卡 CRUD → char-find/create/update/duplicate/get/delete rename-char + tag×5
## T6 AN → note/note-depth/note-frequency/note-position/note-role
## T7 WI → world/getchatbook/getglobalbooks/getpersonabook/getcharbook/findentry/getentryfield/createentry/setentryfield/wi-set-timed-effect/wi-get-timed-effect
## T8 QR → qr/qr-set*/qr-chat-set*/qr-set-list/qr-list/qr-create/qr-get/qr-update/qr-delete/qr-context*/qr-set-create/update/delete/qr-arg/import
## T9 personas → persona-create/update/get/delete/duplicate/lock/set/sync
## T11 设置预设 → instruct×4/context/preset/sysprompt×4/ppp/stop-strings/start-reply-with/model/api-url/tokenizer/proxy + FC/OR 族 + secret×6 + profile×6
## N/A(DOM)→ panels/clipboard/chat-jump/vn/theme/css-var/beep/loader-*/pm-render/show-gallery/db裸/speak/reload-page/expression折叠态(改 op receipt 或跳过)
