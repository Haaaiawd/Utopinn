# textgen / instruct 派发路径设计(TASK-020)

## 定位

chat-completions 路径(`/api/uberge/generate` 现成)只覆盖 openai 系;
textgen(kobold/llamacpp/ooba 系)与 instruct-mode 是另一条组装线,
`instruct/engine.ts` 已移植就位,缺的是派发分支与格式化入口。

## 分叉点

`/api/uberge/generate` 的 `body.chat_completion_source`:
- `openai`/`custom`(chat API)→ 现有 messages 组装管线
- textgen 系 → **prompt 字符串**组装线:instruct preset(context/instruct
  两个 JSON)→ `formatInstructExamples`(seam 已接 substCtx)→ 拼历史 →
  单一 `prompt` 字段发给上游

## 落点

- `generate-context.js` 增加 `buildTextgenContext()`:加载
  `data/<handle>/instruct/<preset>.json` + `context/<preset>.json`(repo
  `instructRepo`/`contextRepo` 已有 `listWithDocs`)
- 端点在 dispatchBody 前判源:chat 源走现路;textgen 源产出
  `{prompt, ...sampling}` 直接进 `runLukerDispatch` 的 textgen 后端
  (Luker `textgen-settings.js` 的服务端面已有,照抄 prompt 拼装顺序)
- instruct preset 的 `system_prompt`/`wrap`/`names_behavior` 等位按 ST
  `formatInstruct` 语义,不做简化版

## 边界

- golden-diff 面:textgen 组装结果也可出 golden(语料管线复用,
  wireRequests 存 prompt 字符串而非 messages)
- 不在第一版做:NovelAI/Kobold 专属 tokenizer 差异(沿用 tiktoken 近似,
  差异记假设)
