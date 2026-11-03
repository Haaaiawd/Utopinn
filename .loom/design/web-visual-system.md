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

## 规范表(调研回填 2026-11-03,来源 GPT/Claude/Linear/Geist/VS Code 实测惯例)

| 维度 | 采用值 | 依据 |
|---|---|---|
| rail 宽度/icon/hit | **48px / 20px / 40-48px** | VS Code ACTIVITYBAR_WIDTH=48;L1 复合剪影用 20(细节多,24 糊)。52 是非标,压回 48 |
| rail active 态 | 图标后圆角 wash(--sel)+提亮 | Discord/Slack 式;左指示条偏编辑器口音,弃 |
| 行高 | **34-36px**(列表行/组头同高) | GPT 33-36、Claude ~33;长文阅读产品不取 Linear 28 |
| 行 padding/radius | 纵 8-10、横 10-12、radius 8-10 | GPT 6/10 r10、Claude r8 |
| 组内缩进 | 子行比组头 +~24px,只一档 | GPT Projects;再深用面包屑 |
| section label | **12px/500/ink3/非 caps**;caps 只留管理页表单 | GPT"Today"式;11px caps 是编辑器口音,聊天区弃 |
| 行内字 | **14px/400-500**,ink2→ink hover | GPT 14/500;Linear 13 是工具密度特例 |
| 字号阶梯 | title 16-17/600 · 区块 14-15/500-600 · UI 正文 **14** · **新增 --fs-ui-sm 13**(设置/诊断/表格,消灭游离 12.5) · caption 12/ink3 | Geist copy-14/label-13/label-12 |
| 阅读正文 | 16-17.5/lh1.6-1.9(当前 17.5/1.9 保,可加 16/1.8 紧凑档) | GPT 16/1.5 |
| spacing | 4px 基;页 padding 24-32;段距 16-24;行内 gap 8-10;卡 padding 14-16;阅读栏 max 700-768(当前 760✓) | Geist 4px 基实测 |
| radius | **6/10/14/22+pill 保持不动** | shadcn base 10 兼容 |
| icon 三档纪律 | **L1=20(rail)/ L2=16(工具钮)/ L3=12(行内)** | VS Code codicon 16/12 两级制 + rail 一档;消灭 15/17/19 游离值 |
| 状态点 | 6px | 现状✓ |
| 卡片 vs 扁平 | 卡=浏览异质(Library 卡库);行=扫描同质(会话/规则/诊断);同质套卡=边框噪音红线 | NN/g cards 定义 |
| hover | #fff@7-10%(dark)/#000@4-6%(light) wash | 现 --bubble ✓ |
| selected | wash ~11% + 字 ink2→ink、wt 400→500 | 现 --sel ✓ |
| focus ring | ring-2/40 只给键盘焦点 | shadcn v4 ✓(Tailwind v4 ring 默认 1px,写死宽度正确) |
| 危险态 | 只文字/图标转 err,不着底 | GPT/Linear ✓现状 |
| 禁用 | opacity .45 + pointer-events:none | ✓ |
| 过渡 | ≤150ms transition-colors | Linear snappy ✓ |
| tooltip | **delay 700→400ms**(Provider 级),rail 标配、行内不配 | NN/g 300-500;Radix 默认偏慢 |
| tabular-nums | **非全局**——只数字列:sb-group-count/时间戳/诊断表格/token 计数 | Sentry 惯例 |
| hit area | 桌面最小 24、实用 28-32;icon-sm 26 仅限行内,独立钮 ≥28 | WCAG 2.2 |
| 双色分配铁律 | 全 app 只允许 2 底色+1 浮起色+2 档覆盖灰+发丝线;新颜色=bug | GPT --sidebar-surface 17/--main 21/--elevated 2f |
| 待补样式清单 | `.rail` `.rail-mark` `.rail-btn` `.sb-new` `.sb-group-head` `.sb-group-ava` `.sb-sect` `.sb-item-title` `.sb-fold` `.sb-foot-ava` 全部零定义 | 调研报告实测 styles/ 下缺席 |

## 否决记录

- activity-rail+menubar+statusbar 全栈(VS Code 式):推翻于 DSH 骨架重构(ac5f90b)。
- 暖墨/纸面材质:用户否决,回中性双色。
- 底部域导航:用户否决,GPT/DSH 均导航在顶/轨。
- nav 选中态用强调色:否决,回中性灰。

## 验收

- dark/light 双主题截图走 look-and-fix。
- typecheck/build 绿;侧栏拖拽/折叠、沉浸进出、卡格筛选、管理页 chips 可用。
