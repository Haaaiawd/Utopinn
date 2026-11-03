# DSH Tavern 调研(2026-11-03)

来源:flizzywine/dsh-tavern(AGPLv3,1.2k★)+ XCNXNXNX/dsh-portable-tavern。
DSH = DeepSeek Harness,agent 内核;酒馆本身只是内核上的一个插件。
用户方向原话:"参考 dsh,做到轻量,以依靠插件生态强于我们本身,看看内核"。

## 1. 内核+插件模型(最值得抄的组织形态)

- DSH 内核只做 agent 运行时(profile/工具/任务调度),酒馆是 `dsh plugin` 装的插件
- 其他插件(手机访问 dsh-pocket、认证 dsh-webui-auth、语音朗读)与酒馆**正交组合**
- **我们的对应物**:Luker 服务端插件/skills/orchestrator 已在 D-005 保留——
  决策强化:卡兼容层(TH-shim/MVU/正则管线)应是"内置兼容插件"的角色,
  内核(api/protocol/storage)保持薄;未来第三方能力走同一插件面进来
- 生态位区分:我们不支持"任意 ST 扩展"(老路,D-003 已定),
  但**卡本身就是我们的插件生态**——卡脚本/世界书/正则就是内容侧插件,
  服务端插件面是能力侧插件。两个面都要留

## 2. 分步生成管线(质量+性能双赢,Phase-后期候选)

DSH 把一轮拆成任务:前台模型写正文 / 后台模型结算变量(MVU)/ 生成候选项。
收益:正文不分心、失败单步重试、候选项格式硬校验。
**对我们的含义**:`generation` 管线设计成 stage 化(stream:正文 →
settle:变量结算 → candidates:候选项),v1 可先单阶段,接口留 stage 序列。
记入 core-engine 待办,非本轮实现。

## 3. 状态栏固化(直接可用的兼容+性能优化)

DSH:MVU 版状态栏 = **固定模板 × 服务端变量渲染**,模型不重复输出 HTML。
收益:格式永不掉 + 每轮省模板 token。
**对我们的含义**:服务端变量管线里,`display_data`/状态栏模板可作为
"模板渲染"服务提供——面板/楼层应用拿变量+模板服务端渲染结果,
而不是让 LLM 反复生成 HTML。与 `<UpdateVariable>` 服务端解析同管线。
记入 design/core-engine(见下)。

## 4. 缓存命中 95%(组装顺序的硬约束)

DSH 靠稳定内容前置拿 prompt cache。
**对我们的含义**:core prompt 组装必须保证**稳定段顺序恒定**——
卡字段/系统提示/WI 常量条目在前,易变段(深度注入/最近消息)在后;
同卡同聊天重复生成的 prompt 前缀应逐字节一致。
把这条写成 core-engine 的组装不变式(golden 可断言)。

## 5. 已被独立验证的我们自己的决策

- **HTML 渲染深度**:DSH 也有"限制历史楼层 HTML 渲染数"设置——
  和我们 perf-budget 的楼层 WebView 可见性调度同构 ✓
- **手机连服务端**(扫码远程玩)= 我们全云模型 ✓
- **变量后台结算保留更新结果+失败重试** = 我们的 MVU 服务端解析语义 ✓
- **内置关键兼容件**(DSH 内置酒馆助手/MVU/提示词模板)= 我们 T0/T1/T2 shim 分层 ✓

## 6. 文字舒适度("文字部分都要做到舒适")

DSH 的"正文排版"设置(字号/行距/字距,玩家/角色消息统一字号)说明
读感是显式功能,不是顺带产物。**我们的清单**:
- 排版设置:fontSize/lineHeight/letterSpacing/fontFamily/消息密度/气泡vs流式
- 流式增量渲染不跳动(token 到达不打乱已渲染段落)
- CJK 友好:中西文混排间距、标点悬挂、字体 fallback
- 深色/浅色主题与面板主题 token 共享(NativeWind tokens 已定)
- 长文分页/折叠选项(DSH 有"文字分页";长回复折叠为可选)

## 7. 许可注意

dsh-tavern 是 AGPLv3——只学架构模式,不抄代码。
dsh-portable-tavern 是 MIT,可参考其"卡生成器"产品形态(我们的 web 端
编辑器以后可对位)。
