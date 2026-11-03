# 导入导出与迁移(import/export center)

> 导入导出是用户的"安装仪式"——普通用户支柱之一。

## Field identity and boundary

万能导入手势、逐对象无损导入导出、备份/同步、迁移向导。不含:编解码实现(formats 包)、同步协议细节。

## Project scenario

用户装卡/书/预设/主题主要靠导入;换端/换机要能整体搬家;ST 老用户一键迁移。

## Decision tree

### C1: 万能导入手势

- entry_when: 设计导入 UX
- options:
  - A: 拖文件到任意页面 + 贴 URL 任意输入位 + 设置·数据中心兜底 → leads_to: C2
  - B: 只在各对象页设导入钮 → leads_to: 找不到入口(ST 病)
- decide_by: 用户手里永远是"一个文件/一个链接",不该先想"这是什么类型" → A;类型由 formats 自动嗅探(PNG tEXt/charx/json/byaf/URL)
- source: design/web-ia.md §12 合并裁决+实证痛点清单
- output: 全局 drop-zone + URL 解析器 + 类型路由到对应库;批量导入进队列显示进度

### C2: 无损与预览

- entry_when: 导入流程
- options:
  - A: 导入前预览(卡面/标签/冲突)→ 保留原文件(不规范化重写)→ 冲突给选项 → leads_to: C3
  - B: 静默写入 → leads_to: 丢字段/误覆盖
- source: Luker character-card-parser/charx 导入保留原文件行为
- output: import preview sheet;data-lossless=原始字节保留,导出回写优先原格式

### C3: 备份与同步

- entry_when: 设置·数据设计
- options:
  - A: 一节收编:全量备份 zip/自动快照/LAN/S3 → leads_to: C4
  - B: 分散各处 → leads_to: ST 的 4 层深病
- source: Luker sync 端点(LAN/S3)实证 §7
- output: 设置·数据=单一入口;LAN 发现+S3 端点;快照保留策略可配

### C4: 迁移与首启

- entry_when: 首次启动/从 ST 迁入
- options:
  - A: 三步向导(连源→导卡→开聊)+ "从 SillyTavern 目录导入"扫描 → leads_to: 老用户零学习
  - B: 空控制台 → leads_to: 流失
- source: design/web-ia.md §9 入门三步原则
- output: onboarding wizard;ST data 目录扫描器(卡/书/预设/主题/聊天历史可选导入)
