
## 验收记录(2026-11-19 浏览器真弹)

- Generate('normal') → /preview + /generate 双发,服务端 assemble=19.4ms(vs preset=20s 新瓶颈,另立项)
- 全文本产出 + 持久化落地;WS 流式正常
- 上游间歇空响应(job ee3884ce no-output)非回归,重试即恢复
- 【语义裁定】CLI+浏览器双写同聊天触发 FE-wins 409 恢复(script.js:14567):浏览器过期整文档覆写吞服务端楼层=上游既定语义,非回归;多端并发写属后续范畴
- 【已知 wart】失败 job 的空占位层会被下次 doc-save 持久化——上游同款行为,parity 保留
- 037a 已提交 4750223

## Perf 发现:preset=~20s 是新的绝对大头(2026-11-19)

- perf 行:assemble=19ms 而 preset=20238ms,占 total 99%+
- 病灶:generate-context.js:301 presetRepo.listWithDocs(instruct)+listWithDocs(context) 每次生成**串行打开全部预设文档**(scratch 实测 41 instruct+34 context=75 个 JSON),WSL DrvFS 上每次 ~20s
- 修法:只需要 active 的 powerUser.instruct.preset + powerUser.context.preset 两份(listWithDocs→get),或跨生成 memoize;engine 只用 active 预设做 formatInstructExamples
- 影响面:generate-context.js(TASK-037b 格在飞,待其落地后补刀)

## TASK-034c 验收(2026-11-19,047f9c1)

- 双推进源确诊:simulateWorldInfoActivation 非 dryRun 时原地推进 chat_metadata.timedWorldInfo(事件payload/st-context/扩展三路可达)
- 修复:utopinn 托管时换克隆跑真扫描+finally 还原(扫描语义保真,推进权归服务端);reconcile 前移到 onFinishStreaming 存档前;onError 补 reconcile
- takeover 供料验证:仅 takeover 监听存在时打 /preview(dryRun 不推进),GENERATE_TAKEOVER_DISPATCH 前落 generate_data.prompt

## 遗留结构性问题:每轮生成必一次 409

- 服务端 persistWorldInfoTimedEffects/updateChatMetadata 每轮生成轮 doc integrity → 浏览器下一次写必 CAS 失败 → refresh+快照失效降级整文档 PUT(自愈但大聊天偏重,多付一次 GET+全量写)
- 根治方向:job 携带新 integrity 让浏览器直接采纳(服务端改动,037b 格域,待其落地后收)
- takeover 回合插件自持派发无 utopinn job → timed effects 不推进(行为差,非双写,记录)
