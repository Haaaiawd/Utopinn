# 移动端 UI 底座裁决(2026-11-04,调研驱动)

> ⚠️ **冻结为参照**(D-020,2026-11-04):移动端地基已改判 fork IReader(KMP),本稿所述 Expo/uniwind/HeroUI 栈不再演进主线,仅作已验证过的技术参照保留。

## 拍板:uniwind 1.13.0 + Tailwind v4 + 自建原语层

**背景**:TASK-008/027/009 落地时无人拍组件底座 → 全屏裸 StyleSheet。
调研发现依赖自相矛盾:`nativewind@4.2`(只支持 TW3)与 `tailwindcss@4.1`
peer 冲突,从未工作过,属死依赖。

## 裁决

- **底座**:`uniwind@1.13.0`(exact pin)。纯 Metro 插件、零原生代码、
  零 babel——正好消费已装的 tailwindcss@4。WSL/DrvFs 慢盘上最轻。
- **原语层**:`src/ui/` 收 Sheet/Slider/Seg/ToggleRow/Chip/Badge,
  token 化;新增件缺口攒够再评 heroui-native(它建在 uniwind 上,加法不换地基)。
- **书写层键盘**:自研 Sheet 保留 + `react-native-keyboard-controller`
  (Expo 官方捆绑件)。gorhom v5 在 RN0.88 有不开 issue,v6 重写中——不引。
- **阅读主题**:5 套 READER_THEMES 中期映射 CSS vars + `<ScopedVariables>`
  包阅读器子树(双轨:阅读低对比/外层 chrome 高对比)。
- **共存**:className 与 style 混用无惩罚,style 优先——逐屏迁,不大爆炸重写。

## 排除

Tamagui(编译器税/复杂度)、Paper(Material 审美互斥)、Restyle(Shopify
2026-09 退坑已归档)、ui-lib(陈旧+投毒事件史)、nativewind v4/v5-rc(换引擎中,
且要降 TW3+加 reanimated)、Dripsy/twrnc(停更)。

## 顺手修(版本线错位,expo install --fix)

expo-router ~6.0.0→~58.x、screens ~4.16→~4.30、safe-area ~5.6→~5.11、
webview 13.16→~14.0.1、linking ~8→~58、metro-runtime ^6→~58。
(当前 expo-router 装的是 SDK54 版本线,expo-doctor 必报)

## 迁移路径

1. `pnpm remove nativewind`;`pnpm add uniwind@1.13.0`
2. `global.css`(@import tailwindcss + uniwind + @theme 写现有 colors/font token)
3. `metro.config.js`:withUniwindConfig 最外层 wrapper
4. `app/_layout.tsx` 顶部 import '../global.css'(不进 entry,丢热更)
5. 逐屏迁:静态布局/间距/色进 className;动态值(阅读 theme/opacity)留 style
