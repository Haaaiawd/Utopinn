# Web 管理端 SPA 选型(框架/UI库/构建/状态)

> One dossier covers one recognizable professional field.

## Field identity and boundary

浏览器端 SPA 工程与 UI 选型。不含:移动原生选型(mobile-app-stack)、卡片沙箱(sandboxed-card-apps)、引擎移植(st-engine-compat)。

## Project scenario

产品型管理端:Vite+React19+Tailwind4+shadcn/ui;RHF+Zod+TanStack Query;CM6+TanStack Table

## Decision tree

### C1: 应用形态与构建

- entry_when: apps/web 初始化
- options:
  - A: Vite SPA(纯静态,由 apps/server 托管或独立)→ leads_to: C2
  - B: Next/Nuxt SSR → leads_to: C2
- decide_by: 是否需要 SEO/服务端渲染——本项目是登录后工具,不需要
- source: research/framework-and-ui-landscape.md
- counterexample: 若未来做公开卡片广场/落地页,那块另起 SSR 站点,不污染本 SPA
- output: Vite + React(见 C2)

### C2: 框架

- entry_when: 技术栈定稿
- options:
  - A: React 19(与 RN 端同心智)→ leads_to: C3
  - B: Vue 3 / Svelte 5 → leads_to: C3
- decide_by: 与 RN 端复用思维与组件模型的价值 vs 团队偏好——本项目同团队双端,A
- source: research/framework-and-ui-landscape.md
- counterexample: 若主开发者 Vue 经验压倒性且 RN 端外包,B 可赢;RisuAI 用 Svelte 是另一存在证明
- output: React 19 + TS

### C3: UI 库与样式

- entry_when: UI 骨架
- options:
  - A: Tailwind v4 + shadcn/ui(Radix/Base UI primitives,源码自持)→ leads_to: C4
  - B: Arco Design / Semi Design(字节)/ Ant Design 6 / MUI 9 → leads_to: C4
- decide_by: "好看简洁+自有语言"诉求强度 vs 要现成全家桶——本项目核心面是自绘(聊天/编辑器),要不被库风格绑架,A
- source: research/framework-and-ui-landscape.md
- counterexample: 若团队 Tailwind 经验为零且追求开箱即用,B 中 Arco(字节系,简洁)是最近似的替代
- output: Tailwind v4 + shadcn/ui + TanStack Table(重表格处)

### C4: 表单/校验/数据

- entry_when: 编辑器实现
- options:
  - A: React Hook Form + Zod(schema 与 @uberge/protocol 共享)→ leads_to: C5
  - B: Formik/自写 → leads_to: C5
- decide_by: schema 复用与类型安全——protocol 包已是 Zod 风格契约,A 顺接
- source: research/framework-and-ui-landscape.md
- counterexample: 若编辑器以"画布式自由布局"为主(表单很少),B 无意义但不亏
- output: RHF + Zod + TanStack Query(经 api-client)

### C5: 代码/富文本编辑与重组件

- entry_when: WI 编辑器/regex 编辑器/CardApp Studio 类界面
- options:
  - A: CodeMirror 6(Luker 依赖已内置)+ TanStack Table + dnd-kit(排序)→ leads_to: 输出
  - B: Monaco(重)/自绘 → leads_to: 输出
- decide_by: 继承生态与体积——CM6 已在 Luker 依赖且为 Studio 所用,A
- source: apps/server/package.json deps + research/framework-and-ui-landscape.md
- counterexample: 若要做完整 IDE 体验(多文件/智能感知)则 Monaco;CardApp Studio 二期再说
- output: CM6 + TanStack Table + dnd-kit

### C6: 桌面应用壳与 i18n/主题

- entry_when: TASK-010 骨架实现
- options:
  - A: ChatGPT 桌面式壳(标题栏/activity rail/二级侧栏/右面板/状态栏)+ CSS token 主题(暗色默认/纸面亮色)+ 服务端同步排版 + locale-owned 中英字典 → leads_to: 完成
  - B: 网页式布局 + 客户端本地主题 → leads_to: 不像应用,主题不同步
- decide_by: 用户拍板"不要像网页"(D-015);i18n=中英双字典起步(D-013);排版设置属用户数据应多端同步
- source: design/web-ia.md §13/§14;design/web-ui-mockup.html(认可)
- output: shell 组件 + 主题 token 表 + t() 字典基建;正式 UI 图标=24格 stroke SVG,禁 emoji
