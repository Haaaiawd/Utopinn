# Utopinn 品牌资产(源件)

官方 favicon/PWA 图标全套,生成自 RealFaviconGenerator。`apps/web/public/` 里的
是部署副本;**这里是源档**,将来做平台包(Android adaptive icon/启动屏、
Windows 磁贴/安装器图标、桌面端窗口图标)从这里取原图裁切,不要从 public 抠。

- `favicon.svg` — 矢量母版(含 light/dark 两套路径,prefers-color-scheme 切换)
- `favicon-96x96.png` / `favicon.ico` — 浏览器标签页
- `apple-touch-icon.png` — iOS 180x180
- `web-app-manifest-{192,512}.png` — maskable 安全区已留(安卓圆角裁切安全)
- `site.webmanifest` — 生成原件;线上用的在 `apps/web/public/site.webmanifest`(字段调过)

Logo 组件本体:`apps/web/src/components/LogoU.tsx`(U 字+星火,描边走 --logo-u-stroke)。
