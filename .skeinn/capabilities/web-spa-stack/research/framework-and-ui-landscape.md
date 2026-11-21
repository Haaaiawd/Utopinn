# 框架与 UI 库选型格局(2025-2026)

Source: frontendpatterns 渲染模型指南、dovic《前端选型与实践报告(2025)》、realworld-js-framework-comparison 基准、AppMaster Svelte vs Vue 管理端对比、Semi Design Discussion #2800(与shadcnUI对比)、Lafu Code "ShadCN vs Ant Design"

本项目是"产品型应用"而非企业 CRUD:核心界面是聊天、卡片编辑、面板这些自绘表面,表格密度不高,且要求"好看、简洁、有自己的设计语言",而不是默认管理台风。渲染模型上它也不需要 SEO/SSR——纯 SPA(Vite)就够,Next/Nuxt 的服务端能力属于过剩。

框架三选:React 19(与 RN 端共享心智模型、组件生态最大、Hook 心智一处学两效用);Vue 3(国内生态、模板直观、Naive UI/Element Plus 成熟);Svelte 5(编译期响应最快但生态最小,RisuAI 选的就是它)。决定性证据不是跑分,是"与 RN 端复用同一套设计语言和思维模型"——React 占优。

UI 库对比的本质是"风格化强度"的取舍:Ant Design/Element 是默认管理台风,功能全但"风格化太严重,丑风掉价"(Semi 讨论区原话);Arco/Semi(字节系)精致但同样自带强风格,搭不好易翻车;Material UI 绑定 Emotion+M 系视觉,部分高级组件商业授权。shadcn/ui 是另一范式——组件源码复制进项目,Radix/Base UI 打底 + Tailwind 样式,风格极简不抢戏,B/C 端通吃,改样式直接改代码不用对抗库抽象。代价:组件少、复杂表格要自己组(TanStack Table 补)、更新靠手动同步。
