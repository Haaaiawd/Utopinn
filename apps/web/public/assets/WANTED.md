# 素材清单(已交付 AIRP 包 2025-11;生成后按路径投放)

命名即契约——文件名/路径不动,前端按这些键引用,PNG 优先。

- 主题色:**珊瑚星火 #FF6B5B**;深色底基调 #141414→#1c1c20
- 头像类:中心构图、留出圆形裁切安全区、深色底、不要文字
- 背景类:**毛玻璃友好** = 低对比渐变+柔光斑,避免高频细节/文字/具象主体,不然玻璃下会脏

---

## avatars/ —— 用户头像预选(3 选 1,全做)

用户头像不做"回退一张",做成**三只可选小动物**——同插画风、同深底、同一枚星火点缀,气质各一,凑成一套"乌有馆住民"。

### `avatars/user-redpanda.png` · 512×512

小熊猫是首选:它天生橘红毛色和我们的 #FF6B5B 几乎同构,不点色也已经"很我们"。设想是正面半身像,圆脸微歪,眼神好奇但安静;耳尖与脸颊绒毛带一点珊瑚色高光,像被星火照亮了一侧——品牌色是从它身上"长出来"的,不是涂上去的。

```
cute red panda head portrait, slight head tilt, curious calm expression,
dark charcoal background, soft coral-orange rim light on one side (#FF6B5B),
fluffy fur detail, minimalist digital illustration, centered composition
with circular crop safe area, no text, 512x512
```

### `avatars/user-fox.png` · 512×512

狐狸给"更机敏"的用户气质:尖耳竖立,微眯眼带一点笑,像刚想出一个坏主意。毛色用深棕灰压暗(别做全橘不然和小熊猫撞色),珊瑚星火色只落在耳内绒毛和一缕尾尖上——构图仍是正面,但表情要更"有主意"。

```
clever fox head portrait, upright ears, sly subtle smile, half-lidded eyes,
dark charcoal background, muted brown-grey fur with coral accent (#FF6B5B)
on inner ears and tail-tip wisp, minimalist digital illustration, centered
composition with circular crop safe area, no text, 512x512
```

### `avatars/user-owl.png` · 512×512

夜枭是安静档:大眼睛直视,羽毛层叠,气质偏"深夜还在写卡的人"。整体更冷(墨蓝灰羽),只有一枚小小的星火色圆点停在胸前或眼角——像徽章,暗示它来自乌有馆。三张里它应该一眼"最冷静"。

```
small owl head portrait, large round eyes looking forward, layered feathers,
dark charcoal background, cool blue-grey plumage, single tiny coral glow
accent (#FF6B5B) near chest like a badge, minimalist digital illustration,
centered composition with circular crop safe area, no text, 512x512
```

## avatars/ —— 卡面回退(1 张)

### `avatars/default-char.png` · 512×512

卡无立绘/加载失败时的回退,要和人头那三只**能区分又不违和**——用小灵兽而非普通动物:半透明的小精灵龙/雾团兽,轮廓柔和,体内浮着星火色光点,像"尚未被写成角色的存在"。它出现在画廊卡面和楼层头像位,频次最高,必须耐看。

```
tiny translucent spirit creature, soft rounded silhouette like mist
and a small dragon, faint glowing coral sparks (#FF6B5B) floating inside
its body, dark charcoal background, ethereal minimalist illustration,
centered composition with circular crop safe area, no text, 512x512
```

---

## backgrounds/ —— 背景(毛玻璃层下方)

### `backgrounds/app-dark.png` · 2560×1440

主壳深色底,全应用出现率最高的一张。设想是"深夜书房的深空":近黑的墨蓝径向渐变,左下角和右上有两团极淡的珊瑚色光晕,像远处门缝里漏出的光;再撒一层稀疏微星尘,密度要低——玻璃面板压上去后只剩一层隐约的"深度感"。

```
dark atmospheric abstract background, deep ink-blue to near-black radial
gradient, two faint coral light glows (#FF6B5B) in lower-left and upper-right
corners like light through a doorway, sparse subtle star-dust particles,
very low contrast, glassmorphism-friendly, smooth gradients only,
no objects, no text, no sharp details, 2560x1440
```

### `backgrounds/app-light.png` · 2560×1440

浅色主题同款构图:雾白到暖灰的缓渐变,光斑换成低饱和珊瑚色(像晨光透过纸窗),星尘改成几乎不可见的浮尘。原则是"看起来几乎是纯色,但仔细看有空气感"。

```
light atmospheric abstract background, mist-white to warm-grey soft gradient,
very faint desaturated coral light patches like morning sun through paper,
nearly invisible dust particles, extremely low contrast, clean and airy,
glassmorphism-friendly, no objects, no text, 2560x1440
```

### `backgrounds/drawer-dark.png` · 1080×1920

移动抽屉/bottom sheet 的竖版底:app-dark 的竖构图变体,光源位置移到顶部(抽屉从底滑出,光在上方才自然),下半部可以更暗——给 sheet 内容留干净的阅读区。

```
vertical dark atmospheric background, deep ink gradient darker toward
bottom, faint coral glow (#FF6B5B) from top edge like light from above,
sparse star-dust, very low contrast, glassmorphism-friendly,
no objects, no text, 1080x1920
```

### `backgrounds/aurora-dark.png` · 2560×1440(可选,第二备选)

如果 app-dark 太素,这张是"有主题叙事"的备选:一道极淡的极光弧从左上扫到右下,带一点珊瑚色边缘光——呼应"门/portal"的品牌意象,但弧光透明度要低,仍服从玻璃层。

```
dark abstract background with a faint aurora arc sweeping diagonally,
subtle coral-pink edge light (#FF6B5B) on the arc, deep ink-blue base,
sparse star-dust, very low contrast and soft focus, portal-like luminous
quality, glassmorphism-friendly, no objects, no text, 2560x1440
```

### `backgrounds/stage-galgame.png` · 1920×1080(可选)

galgame 形态的默认幕布(卡没带背景时):虚化的剧场/室内景深,暗部多、亮部集中中部偏下(立绘站的位置),像舞台灯打在一小块区域。不用具象场景,色块+光就够。

```
blurred theatrical stage backdrop, dark ambiance with a warm soft spotlight
pool in lower-center area, faint coral warmth (#FF6B5B) in the light,
heavy bokeh, out-of-focus interior depth, no recognizable objects,
no text, 1920x1080
```

---

## empty/ —— 空态插画(可选)

### `empty/gallery.png` · ~1200×800

画廊无卡时的空态:一面空展架或一扇还没点亮的"门",构图留大量负空间给文案,色调跟壳一致(深底+一点星火色微光从门缝/架位里透出来)——暗示"你的第一张卡会住在这里"。

```
empty display shelf or an unlit doorway in a dark minimal room,
faint coral light (#FF6B5B) seeping from door crack or shelf slot,
large negative space for text overlay, melancholic but inviting mood,
flat minimalist illustration, no text, ~1200x800
```
