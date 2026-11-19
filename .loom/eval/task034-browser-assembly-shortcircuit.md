
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
