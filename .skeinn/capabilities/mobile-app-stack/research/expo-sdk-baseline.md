# Expo SDK 基线与运行时边界

Source: expo.dev SDK 页 + "How to upgrade to SDK 58" 官方博客 + New Architecture 指南(2026-11 时点)

2026 年 11 月时点,最新稳定为 SDK 58(RN 0.88 / React 19.3);SDK 55 起 New Architecture 不可关闭(Fabric/TurboModules),旧架构冻结。含义:新项目没有理由不从 SDK 58 + 新架构起步;任何选型库都必须兼容新架构(FlashList v2、worklets、Nitro 皆为新架构产物)。

第二个边界是 Expo Go:需要 react-native-webview(CardApp 沙箱)和 worklets/Nitro(Markdown 加速)这类原生模块的项目,Expo Go 装不下——必须走 development build(`expo prebuild` + EAS/本地构建)。官方自己的建议也是"ship 生产 App 本来就该用 dev build"。这不是缺陷而是常态,但意味着开发期就要建 EAS/dev-client 流程,不能依赖扫码即跑。
