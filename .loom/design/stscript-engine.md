# STscript / QuickReply 服务端引擎设计(TASK-019)

## 定位

STscript 是 ST 的命令管线语言(`/send`、`/setvar`、`/if`、`| pipe`),QuickReply
是其最常见载体——大量生态卡内嵌 QR 脚本,是 M3 兼容面的关键短板。
与宏(substituteParams,已移植)的关系:宏是**值内插**,STscript 是**命令执行**;
STscript 内部仍走宏替换做参数求值。

## 参照源

- `ref/Luker/public/scripts/slash-commands/`(解析器+命令注册表,~大)
- `ref/Luker/public/scripts/extensions/quick-reply`(QR 集存储/按钮面)
- dsh-tavern 的 QR 实现可作行为对照(它服务端的 QR 已跑通)

## 分层

```
packages/core/src/stscript/
  parser.ts     命令行解析:引号/转义/管道/嵌套 {{}}
  registry.ts   命令注册表(命令名 → handler(ctx,args)),宿主无关
  runtime.ts    执行器:作用域(局部变量帧)、管道值流、error 收集
  builtins/     按面分批:/send /setvar /getvar /if /else /echo /return …
```

server 侧 `services/stscript-runner.js` 提供 ctx 绑定(变量仓储/发送消息/
触发生成);QR 集存 `data/<handle>/QuickReplies/`(沿用 ST 文件名约定)。

## 端点

- `POST /api/uberge/stscript/run` — `{chatRef?, script, scope?}` → `{result, ops, error?}`(干跑友好)
- QR CRUD 挂在 `/api/uberge` 库面(TASK-018 同族)

## 边界

- **不并发执行写操作**:STscript 可含副作用(setvar/发消息),同一 chat 串行。
- **副作用回执**:ops 数组(setvar/delvar/发送了哪条消息)随响应返回,渲染器
  做 variable receipt 展示——与 MVU receipt 同通道。
- 危险命令(文件/网络类)第一版不实现,注册表白名单制,缺命令报
  `unknown_command` 不静默吞。
- 优先级:QR 高频命令先行(send/setvar/getvar/if/echo/return/input),
  长尾命令按需补——golden 语料卡里的 `thScripts` 面是真实压力来源。

## 验收

- 核心 parser/registry 单测 ≥ QR 常用命令面
- `/run` 端点集成测试:setvar 落库+发送消息落 chat+错误分类
- 语料卡 QR 脚本抽样能跑(不做全兼容承诺,行为差异分级)
