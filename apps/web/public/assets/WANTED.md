# 素材需求清单(生成后按路径投放)

命名即契约——文件名/路径不动,前端按这些键引用。PNG 优先;
毛玻璃友好背景请给**低对比渐变+光斑/星尘**,避免高频细节和文字。

## avatars/ —— 头像回退

| 文件 | 用途 | 规格 | 风格建议 |
|---|---|---|---|
| `default-user.png` | persona/用户无头像回退(账户坞、消息头像) | 512×512 | Portal Spark 星火变体,深色底,#FF6B5B 点亮;中心构图,留裁圆安全区 |
| `default-char.png` | 卡无图/加载失败回退(画廊卡面、楼层头像) | 512×512 | 同族异色(比如冷青/雾紫星火),与 user 一眼可辨 |
| `empty-persona.png` | persona 列表空槽位 | 512×512 | 剪影式,可选,低优先 |

## backgrounds/ —— 背景(毛玻璃层下方)

| 文件 | 用途 | 规格 | 风格建议 |
|---|---|---|---|
| `app-dark.png` | 主壳底(深色主题) | 2560×1440 | 深空墨蓝→墨黑径向,角落 #FF6B5B 弱光斑+微星尘 |
| `app-light.png` | 主壳底(浅色主题) | 2560×1440 | 雾白→暖灰渐变,同构光斑降饱和 |
| `drawer-dark.png` | 移动抽屉/底 sheet 底 | 1080×1920 | app-dark 竖版变体,光源上移 |
| `stage-galgame.png` | 剧场形态默认幕布 | 1920×1080 | 舞台幕/景深虚化,可选 |

## empty/ —— 空态插画

| 文件 | 用途 | 规格 | 风格建议 |
|---|---|---|---|
| `gallery.png` | 画廊无卡空态 | ~1200×800 | 空展架/一扇没点亮的门,留负空间 |
| `no-sessions.png` | 侧栏会话空态 | ~800×600 | 可选,极简线条 |

## 图标补位(v3.1 未含,画 icon 用)

高:`user` `plus` `check` `more` `chevronDown` `arrowRight`
中:`import` `trash` `pencil` `list`
低:`paperclip` `eye`/`eyeClosed` `cpu` `stories` `penNib` `minus`
规格同 v3.1:24 viewBox,1.85px 主描边,base/-active 双变体。
