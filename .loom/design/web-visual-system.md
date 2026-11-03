# web-visual-system — 视觉体系设计稿(TASK-010)

> 状态:骨架,等调研回填。此前 UI 迭代靠拍脑袋调像素,用户指出
> loom 缺这块调研与设计——本稿就是那笔欠账。调研代理产出
> 实测规范表后,把"采用值"落到 §规范表,未采用项记 §否决。

## 约束(已定,不随调研变)

- 表面 GPT 双色:dark 侧栏/rail 近黑(#171717)、主面 #212121、浮层 #2f2f2f;
  light #f7f7f8/#fff。灰只用于 hover/发丝线/次级文字。
- 强调色中华琥珀 #CA6924,极少数点睛:发送钮/未读点/mock 徽标/流式光标。
- 语义色:ok 绿(已应用)/err 红(失败、destructive hover)/warn(不可信数据)。
- 无渐变、无 emoji 图标;图标三级制(L1 域标复杂/L2 操作标简/L3 行内标朴素)。
- i18n 文案走 t(),组件级硬编码文案禁止。

## IA(已定,DSH/GPT 混合)

```
rail(52px,常设) | 内容栏(240-460 可拖) | 主区(域视图) | 右面板(track)
rail = 品牌标 + 域标 + 底部 settings/theme
内容栏 = 品牌行 → 醒目新会话 → 搜索 → 分组嵌套列表 → 用户脚
域视图:chat=阅读流+预览;stories=卡格库;rules/extensions=管理页;
       diagnostics=诊断页;settings=设置页
沉浸模式 = 内容栏+右面板同收,只留 rail+阅读列(ctbar focus 钮)
```

## 规范表(待调研回填)

| 维度 | 采用值 | 依据 |
|---|---|---|
| sidebar 行高/缩进阶梯 | ? | 待填 |
| rail 宽度/icon 尺寸/hit area | 52px / 19px / 36px(暂定) | 待核 |
| 字号阶梯(title/body/caption) | ? | 待填 |
| spacing 页 padding/段距 | ? | 待填 |
| radius 阶梯 | ? | 待填 |
| icon 尺寸分级 | ? | 待填 |
| 卡片 vs 扁平列表选用 | ? | 待填 |
| hover/focus/active 三态 | ? | 待填 |

## 否决记录

- activity-rail+menubar+statusbar 全栈(VS Code 式):推翻于 DSH 骨架重构(ac5f90b)。
- 暖墨/纸面材质:用户否决,回中性双色。
- 底部域导航:用户否决,GPT/DSH 均导航在顶/轨。
- nav 选中态用强调色:否决,回中性灰。

## 验收

- dark/light 双主题截图走 look-and-fix。
- typecheck/build 绿;侧栏拖拽/折叠、沉浸进出、卡格筛选、管理页 chips 可用。
