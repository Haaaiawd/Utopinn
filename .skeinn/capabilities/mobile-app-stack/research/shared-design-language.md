# 跨端统一设计语言:Tailwind 作为共同地基

Source: State of React Native 2025 官方调查(styling/component-libraries 板块)、Tamagui v2 RC 博客、gluestack-ui v4/v5 changelog、React Native Reusables 生态

若 Web 选了 Tailwind+shadcn,移动端存在一条"同语言"路线:NativeWind 把 Tailwind utility class 带入 RN,gluestack-ui v4/v5(shadcn-inspired 设计系统)和 React Native Reusables(shadcn 哲学的 RN 移植)提供对应组件层——即 Web 与移动端共享同一套 design tokens(色板/圆角/间距刻度),各端用自己的实现。State of RN 2025 显示 NativeWind 采纳率 42% 且满意度 50%,gluestack 使用率登顶。

另一条路线是 Tamagui:真 universal 组件库(web+native 同一份组件、编译器优化、SSR 完善),v2 RC(2025-12)成熟度高、口碑最好(59% 正面)。代价:它自成一套范式(typed inline styles + 编译器),与 shadcn/Tailwind 心智不同——选 Tamagui 意味着 Web 端也最好跟它走,否则两套范式并存。本项目 Web 已定 Tailwind/shadcn 方向,故移动端走 NativeWind 系更连贯;Tamagui 作为"若未来想真正合并两端组件层"的备选项记录。
