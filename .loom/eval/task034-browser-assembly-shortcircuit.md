
## 验收记录(2026-11-19 浏览器真弹)

- Generate('normal') → /preview + /generate 双发,服务端 assemble=19.4ms(vs preset=20s 新瓶颈,另立项)
- 全文本产出 + 持久化落地;WS 流式正常
- 上游间歇空响应(job ee3884ce no-output)非回归,重试即恢复
- 【语义裁定】CLI+浏览器双写同聊天触发 FE-wins 409 恢复(script.js:14567):浏览器过期整文档覆写吞服务端楼层=上游既定语义,非回归;多端并发写属后续范畴
- 【已知 wart】失败 job 的空占位层会被下次 doc-save 持久化——上游同款行为,parity 保留
- 037a 已提交 4750223
