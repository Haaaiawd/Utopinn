# 插件内核(cordis core + 组合/生命周期)

> 薄内核,产品全是插件;组合是 config 行+补丁层不是列表。

## Field identity and boundary

cordis Context/事件/作用域语义采用,profile/patch 组合,插件 UI 贡献点,旧 ST 插件适配。不含:具体酒馆 seam 定义(plugin-architecture.md)、生成管线(generation-api)。

## Project scenario

DSH 式全插件骨架;插件可带设置卡/导航页/⌘K命令/渲染器/状态面板;degraded 不静默。

## Decision tree

### C1: 内核实现路线

- entry_when: TASK-011 开工
- options:
  - A: 引入真 cordis(npm,只用 core:Context/events/effects/registry) → leads_to: C2
  - B: 自写同语义内核 → leads_to: 五模式dispatch/isolate/fiber细节易抄形丢神
- decide_by: 语义细节坑多(waterfall outermost-first/bail/effect通知依赖者),真库久经考验 → A;度:不引 cordis 生态周边,loader/profile/patch 自写
- output: pnpm add cordis 实测 → PluginContext 薄包装;立不住回退 B 且保持 cordis 语义接口

### C2: 插件 UI 贡献点清单

- entry_when: 定义插件能往 UI 里加什么
- options:
  - A: 设置卡 / 导航页 / ⌘K命令 / 对话渲染器 / 本局面板项 / 状态面板 → leads_to: C3
  - B: 只给服务端 seam,无 UI 面 → leads_to: 插件生态贫瘠
- source: dsh-tavern mod.settingsSchema 自动生成设置页;DSH settings-card/nav contribution
- output: UI contribution registry 5+1 类,manifest 声明式权限

### C3: 组合语义(config 行+补丁层)

- entry_when: profile 加载器
- options:
  - A: built-in bundles → profile patch → home patch → CLI --patch,每行可按 id 整体替换 → leads_to: C4
  - B: 扁平插件列表 → leads_to: 不可替换/不可回退
- source: design/plugin-architecture.md §组合
- output: 有序装载+patch 语义+--dump-config

### C4: 旧 ST 服务端插件适配器

- entry_when: 生态迁移
- options:
  - A: {info,init(router),exit} → manifest/ctx.route/effect 薄适配 → leads_to: 生态顺滑迁入
  - B: 不适配 → leads_to: 旧插件全死
- output: legacy-st-plugin-adapter 插件(TASK-011 范围);客户端 DOM 扩展不兼容,旧 UI 回退
