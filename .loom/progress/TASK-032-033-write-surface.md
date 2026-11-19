# TASK-032/033 写盘面收束 + 改名 — 2026-11-19

## 落地
- 9caa2eb 写盘面收束:append/PATCH/document 三原语 legacy 逐义;state
  sidecar 三族 18 路由;json-patch 严格化(add缺父/OOB/test不存在→错);
  sanitize 深剥 gen-id(数组嵌套洞修复);job 暴露 verb/model;
  CLI writeClientOwnedFloor 抽取+attach 断流/超期补写;浏览器 Top-10 改道。
- 0e8f122 全仓改名 Uberge→Utopinn(乌有馆/U馆):/api/utopinn/*、utopinn-*
  插件、@utopinn/* 包、utopinn-cli;luker_* 兼容契约不动;旧 state/env 兜底读。

## 实证
- 11/11 utopinn-library 测试(改名后复跑仍绿)
- send 全链 completed persisted;swipe 409 重锚+补写
- doc round-trip 26 层字节级一致
- attach 救回 grace-expired swipe job(swipe_id:2/swipes:3)
- 改名后服务起 Utopinn 2.8.0,10 插件激活

## 遗留
- 浏览器 state-sidecar ~15 调用点仍 legacy(新路由已就绪可改道)
- TASK-033a 真浏览器点验未跑(改道格未做浏览器测试)
- 浏览器组装空跑未砍(TASK-034)
- group/textgen/kobold 未接(TASK-037)
