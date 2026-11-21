# 掌门卡 TH 依赖面实测(2026-11-19)

卡:我没想当掌门啊_最终卡_v1.png —— extensions 三件:card_app(Luker 宿主格
式 1.64MB)+ tavern_helper.scripts / TavernHelper_scripts(同内容双写 1.67MB,
"云栖宗总簿 JSR 版",是把 Luker ctx API 映射到 TH 全局的 shim)。

## 卡脚本实际调用的宿主全局(全文 grep)
eventOn x1 · eventEmit x1 · eventRemoveListener x1 · getChatMessages x1
getLastMessageId x1 · triggerSlash x1 · Mvu.parseMessage x2

## CLI th 动词实弹(18997)
- getChatMessages / getVariables / insertOrAssignVariables / getLastMessageId /
  getCurrentMessageId / getCharacter / triggerSlash → 全通,数据面闭环
- getEmbeddedScripts → 原查错键 th_scripts,已修真键双写+兜底(7219a1b)
- eventOn → unsupported(合理:事件订阅是宿主侧原语,REST 无法传回调——
  TASK-042 设计已裁定复合 dispatch:宿主事件面+th/call 数据面)
- Mvu.parseMessage → TH 生态里 Mvu 是宿主注入全局(变量解析库),不在 th 表;
  服务端有 utopinn-mvu 插件,宿主侧待补 Mvu 面或卡内退化(卡全是 try/catch 容错)

## 结论
- CLI 玩卡的数据契约面:全通(卡所有读写操作=th/call+state sidecar)
- 卡的 JS 自治(事件驱动更新/MVU解析/DOM):需宿主(iframe 或 headless harness)
- 兼容面缺口排序:①宿主事件面(eventOn/Emit)②Mvu.parseMessage 暴露 ③module
  入口 init(ctx) 调用器(042 格发现:Luker buildModuleShell 从不调 init)
