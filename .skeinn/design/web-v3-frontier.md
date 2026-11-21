# Web SPA v3: 前端真接线收口与剧场/壳层演进边界

- Kind: experience
- Status: shaping

## Experience intent

把「能玩的 SPA」推进成「诚实的 SPA」:前端每一个可见控件要么连着真 `/api/utopinn/*` 路由,要么被删除,要么被诚实标注为预览态;消灭「在线播假数据 + 文案谎称协议未备」这一整类失实占位。同时给 v3 壳层的遗留悬案(全局状态位、workspace-inset 接缝、剧场 choices 协议)立下判断基线,让下一轮形态深化有据可依,而不是继续在装饰层堆补丁。

## Users and contexts

- 单人重度 RP 玩家(主要使用者=项目所有者):在桌面浏览器上进行「选卡→聊天→调预设/世界书/人设」的完整循环,对假数据、死控件、小字号零容忍。
- 剧场模式玩家(旗舰方向):读剧情、做选择;选项卡由用户高度参与设计,前端必须能诚实表达「choices 协议未备」而不造假按钮。
- 离线/服务端未连场景:允许 demo 会话与预演轨道存在,但必须在视觉与文案上与真实数据可区分,不允许在线态混入 mock。

## Applied capabilities

- `capabilities/web-spa-stack`:薄客户端消费 `@utopinn/protocol` 契约,浏览器端禁止任何 prompt 组装;所有写操作走 api/* 客户端薄封装,不直接 fetch。
- `capabilities/sandboxed-card-apps`:CardApp 宿主 iframe 沙箱经 ctx 桥通信,`ctx.surfaceOpen/surfaceClose` 已通;面板 detach 不得重建 iframe(本任务已兑现)。
- 审计纪律(自 `.skeinn/eval/audit-frontend-placeholders-2026-11-21.md` 沉淀):「该做/该删/待补」三桶分类法;wired 旗标以服务端路由存在性为准,不以 UI 好看程度为准。

## Alternatives considered

1. **「先接真后打磨」单线推进(选定)**:按审计性价比排序,先把三处 patchSettings、models 水合、死态清理落掉,再顺势把同族写面(预设调参、正则 CRUD、卡编辑、上下文弹层)一次收完。优点是每一步都能用 tsc/服务端单测立即证伪,不留半真半假的中间态;代价是视觉打磨滞后到接真完成之后才做。
2. **「壳层大改版优先」**:先重做全局 chrome(复活顶条或新建状态栏)再放真数据。被否:用户已两次否决顶条方案(双层 logo、Desktop/Mobile 分段),全局位悬案的候选面是左栏头/account-dock/舞台头——在没有真数据可显示之前重排 chrome 是拿装饰当结构。
3. **「剧场 choices 协议插队」**:先做 `message.extra.choices` 服务端 wire 再回头收前端占位。被否:剧场卡由用户高度参与设计,choices 属于「大」量级协议工作,与本轮去占位的「消灭失实」目标不同层;插队会让两个半成口同时存在。
4. **非常规角度——「删掉 Studio 整个域,只用面板」**:把设置/世界书/正则管理全部塞进右侧 workbench 浮窗。被否:Studio 的整页密度对批量管理(几十条世界书条目、正则清单)是必要的,工作台浮窗适合边聊边调,不适合盘点;两者是互补不是冗余。

## Journey and information architecture

信息层级按「聊」优先:中央舞台>左侧会话导航>右侧工作台>Studio 域>Settings 模态。本轮接线后:

- 舞台区:楼层渲染受 `chatSettings.renderCount` 窗口化,超限显「展开更早楼层」按钮;楼层操作条(swipe/编辑/删除/回滚)全真走 `/chats/*` 与 `settleMvu`。
- 舞台头弹层:ContextPop = 人设快速切换 + 全局栈开关 + 卡绑书;PresetPop = 模型/预设清单 + 采样调参,全部从水合态读,离线诚实降级。
- 左栏:会话按卡分组,真会话行带 rename/delete/新建,`st-*`/`c1`/`c2` 预演行视觉降级且不暴露持久化控件。
- Studio 五页:卡库(编辑器模态已可写)/全局栈(globalSelect 真开关)/作品世界书(条目启停写回+命中统计)/预设(默认切换 PATCH + 调参 PUT)/人设(内置头像库+真 CRUD)/正则(三域启停增删)。
- Settings 模态:连接段 source/BaseURL/探测真接 `oai_settings`+`/connection/test`;secrets 增删走 `/secrets`;`renderCount`/`customCss` 落地 localStorage 且真实生效。

## Interaction states and transitions

- 水合序:`getSettings` → `listPresets` → `getMe`+`listPersonas` → `getModels`(失败进 `modelsError` 态,PresetPop 显「未获取到模型+前往配置 API」而非假清单)。
- 写回语义:globalSelect/preset 默认/settings 走 PATCH 后刷新壳水合;预设调参滑杆防抖 PUT 整档;卡编辑保存后刷新卡列表与连接态。
- MVU 联动:生成/swipe/删除/编辑/回滚/结算后通过 `setPanelParams('mvu',{rev})` 发信号,MvuPanel 以 rev 为 remote key 重拉快照——替代原「写而无人读的 s.mvu 全局袋」。
- 离线态:所有面板保留 demo/mock fallback 但经 `s.live` 门控,预演数据不伪装成服务端数据。

## Content, visual, and accessibility direction

- 字阶地板 11px:SpecPanels 全部 9.5–10.5px 文本抬到 11–12.5px;不设更小字号的「注释灰」层级,次要信息靠空间与对比度降噪。
- 顶条已拆除不复活;品牌唯一例在左栏 `brand-header-row`;状态指示优先栖身 account-dock 与舞台头弹层。
- 卡库网格采用更高竖比卡片+渐变遮罩层级,hover 显编辑入口;空态给单一明确导入动作,不堆说明文字。
- 人设头像用 Utopinn 内置库(redpanda/fox/owl),不用酒馆式外链头像;头像选择器即选即预览。

## Errors, empty states, and recovery

- 连接失败:PresetPop/Settings 显 modelsError 与「前往配置 API」入口,不回退到 MOCK_MODELS。
- 写回失败:全局栈开关、预设默认、条目启停、卡保存均 hint 报错并保持原态(可重试),不静默吞错。
- 空态:无模型=配置引导;无人设=新建入口;无世界书条目=明示「暂无条目」;旧楼层被窗口化=显式展开按钮而非偷偷截断。
- 会话操作失败(rename/delete)回滚本地态并提示。

## How this could look done yet fail

- **假水合**:模型清单在服务端无密钥时返回空数组,若前端把空数组渲染成「演示模型」则在线态继续播假数据——已用 modelsError/空态诚实处理规避。
- **PATCH 浅合并吃字段**:`world_info_settings.world_info` 二层合并若写成整层覆盖会冲掉 `charLore`——已加服务端单测(globalSelect 与 charLore 共存断言)钉死。
- **MVU 面板假刷新**:StageFrame 原 `s.setMvu` 写而无人读,看似「MVU 已同步」实则 MvuPanel 从不更新——已改为 setPanelParams rev 信号+MvuPanel remote key 消费,grep 确认 `setMvu`/`mvu` 字段零残留。
- **预演轨冒充真会话**:sidebar demo 行若暴露 rename/delete 会让用户以为操作了真数据——已按 id 前缀区分,预演行不挂持久化控件。
- **「协议未备」文案残留**:接线后忘记删失实文案是最大的自欺——已全量 grep `白名单`/`unwired`/`protocol pending` 并逐条改写。

## Usability verification

- `apps/web`: `pnpm exec tsc -p tsconfig.json --noEmit` 零错误;`vite build` 产物成功(dist 由服务端静态直供)。
- `apps/server`: `node --test tests/utopinn-library.test.mjs`(11/11,含 charLore 保留新断言)、`utopinn-generate-context.test.mjs`、`utopinn-chat-regex.test.mjs` 全绿。
- 残留验证:grep `MOCK_PERSONAS|MOCK_BUILTIN_PLUGINS|MOCK_MVU|s\.mvu|setMvu|不在.*白名单|protocol pending` 于 apps/web/src 零命中。
- 浏览器实测(本轮未做,登记为 TASK-053 验收的已知缺口):Studio 各页 toggle、PresetPop 模型下拉、人设头像切换的实机手感待真环境走查。

## Related documents

- `.skeinn/eval/audit-frontend-placeholders-2026-11-21.md` — 本设计的失实清单源头与收摊回执地。
- `.skeinn/design/v2-stack-decisions.md#前端` — 服务端权威/薄客户端脊骨,TASK-053 implements 指向。
- `.skeinn/capabilities/distribution-forms.md` — 分发形态拍板(本轮补齐),与前端壳层的「无原生壳」边界互证。
- `.skeinn/design/cardapp-web-host.md` — CardApp 宿主契约,surface 协议接线参照。
- `.skeinn/design/web-ui-mockup.html` — v3 桌面认可稿;壳层演进史见审计附录。
