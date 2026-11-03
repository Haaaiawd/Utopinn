# 导入导出中心设计(TASK-016)

## 定位

酒馆生态的流通单位:卡(png/json/charx/byaf)、世界书、预设、persona、
主题、扩展、资产。薄客户端模式下,导入导出是"把别人的东西搬进我的
实例"的第一入口,必须一等公民——这也是 M2 最重的单任务。

## 切三刀(粒度收敛,别一次全做)

**刀 1 — 导入管线(服务端)**
`POST /api/uberge/import` multipart → 格式探测
(@uberge/formats:PNG tEXt/charx zip/byaf/json)→ 预览
`{kind:'char|world|preset|persona|theme', summary, warnings}` → 确认落库
(对应 repo + 文件面)。批量=逐条管线循环,不做事务(逐条独立成败)。

**刀 2 — 导出管线**
`GET /api/uberge/export/:kind/:name` → 原始格式回出(卡→png 保留
tEXt;世界书→json;预设→json)。聊天导出为 jsonl+可选 txt 渲染。

**刀 3 — web 拖放中心**
stories 域内页:拖放区(多文件)+ 预览卡(类型/名称/书条目数/regex 面/
风险标记)+ 逐项入库回执 + 最近导入列表。URL 导入(给链接拉卡)同管线
预取后预览。

## 边界

- **预览先行**:任何导入先出 preview 再确认——防错类型/防覆盖;同名
  冲突显式选 rename|overwrite|skip
- 恶意面:卡内 regex/HTML 只做清单展示不执行(执行是 card-runtime 的事)
- ST 数据迁移(settings.json+目录树)是单独的"迁移向导",不在本刀,
  记 TASK-016 挂账后续
- 备份/同步不做(多端同步是存储引擎层的事)

## 验收

- 语料 10 张卡经导入管线全数入库且可开聊
- charx/byaf/纯 json 三格式各有 1 个真实样本通过
- 预览展示 regex/depth_prompt/embedded book 面清单
