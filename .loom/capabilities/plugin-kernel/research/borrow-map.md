# 借用地图:cordis 生态 / DSH / dsh-tavern / pi-mono

> 结论:三层借用——npm 直接依赖(免移植)、AGPL 区移植(dsh-tavern)、模式借用(DSH 包/pi-mono,看不依赖)。

## License 与可得性

| 源 | License | 可得形态 | 借用方式 |
|---|---|---|---|
| cordis(npm cordiverse) | MIT | `cordis@4.0.0-rc.12` 已发布 | **直接依赖** |
| schemastery | MIT | `schemastery@3.18` 已发布 | **直接依赖**(插件 Config 校验) |
| @cordisjs/loader 等 | MIT | npm 有,rc 系 | 候选;我们 profile/patch 语义上游没有,loader 倾向自写 |
| deepseek-harness | MIT | **未发布**,私有 workspace,依赖网深 | **模式借用/移植**,不可 npm |
| dsh-tavern | AGPL-3.0 | 源在 ref/(Luker 同族) | **移植进 AGPL 区**(server/插件);packages/{protocol,api-client,formats} 保持干净留 MIT 空间 |
| pi-mono(pi harness) | MIT | npm(@mariozechner/pi-ai 等) | 模式借用 provider 抽象形状 |

## Layer 1:npm 直接依赖

- `cordis@rc.12` — Context/events/effects/registry。注意 DSH vendored 是 **4.0.6-alpha.1 分叉线**(24 处本地改动:volatile config、ctx.hmr、module namespace、profile 语义,见 vendor/cordis-rc11-upgrade-plan.md)——npm 版没有这些,缺的语义由我们自写 loader 层补。
- `schemastery` — cordis 自家声明式 schema 库,正是 StandardSchemaV1 的出处;插件 Config/设置卡表单校验用它,不引 zod 进内核。

## Layer 2:dsh-tavern 移植(AGPL 区)

dsh-tavern 架构=**把 ST 前端引擎嵌 frame 挂进 DSH host**,引擎没重实现——所以它没有可搬的服务端引擎(我们 TASK-005/006 仍自己移植)。但它的外围全是可搬资产:

| 资产 | 位置 | 去向 |
|---|---|---|
| magvarupdate vendored | `tavern-plugin/lib/vendor/magvarupdate` | mvu-runtime settle 参考/直接 vendor(TASK-013) |
| gal-* 渲染器族 | `src/client/gal-*.js`(14+文件:entry/looks/choices/backlog/effects/history/config) | TASK-015 精读;可能改写为渲染器插件 |
| mod + settingsSchema | mods 自动生成设置页机制 | plugin-kernel C2 settingsCard 实现模板 |
| card-stage-scheme | `card-stage.js`,`[data-dsh-card-stage-scheme]` | stageScheme 实现(TASK-015 C3) |
| 状态板服务端渲染 | status board 模板渲染 | mvu-runtime C3 实现模板 |
| helper-facade | `runtime/helper-facade.js` | TH-shim 语义参考(层不同,我们的 shim 更薄) |
| frame-*/asset-pack-* | 沙箱 frame 与卡资产包 | sandboxed-card-apps 参考 |

## Layer 3:模式借用(不依赖)

- **DSH 包**:settings/jobs/session/session-query/credentials/llm——私有未发布、互相咬死(dsh-brand/内部cordis/测试基建)。借语义:settings→设置卡持久化;jobs→生成任务持久化+断线重连;session→聊天日志事件流(model-visible⟺logged)。
- **DSH loader/hmr**:profile 装载/热替换/补丁层语义,vendored 源可精读;我们自写小 loader。
- **pi-mono**:非 cordis。`pi-ai` 的 provider 抽象(model/request/stream event 形状)小而美——`ctx.generation` 的 provider seam 抄这个形状即可;OpenAI-compat 单面验证圈不需要 DSH llm 全家桶。

## 不能借的(硬边界)

- 服务端引擎:谁都替不了 TASK-006——prompt 组装必须我们自己从 Luker 移植+golden-diff 判卷。
- koishi 插件生态:服务面(ctx.database 等)不同,不承诺兼容;纯 cordis 插件理论可装。
- DSH host/client GUI:他们的 GUI 体系与我们 web/mobile 完全不同构。

## 对任务图的影响

- TASK-011:`pnpm add cordis schemastery`;loader 自写但精读 vendor/loader + rc11-upgrade-plan。
- TASK-015:gal-*.js 精读升级为"移植评估"——哪些文件可直接改写成渲染器插件。
- TASK-013:先读 lib/vendor/magvarupdate 决定 vendor or 重新实现。
- packages/{protocol,api-client,formats}:禁引 AGPL 码,保持 MIT-able。
EOF
cat >> .loom/DECISIONS.md <<'EOF'

## D-016: 借用三层策略——npm 依赖 / AGPL区移植 / 模式借用

- Current decision: (1)直接依赖 cordis@rc.12 + schemastery(schema校验,不引zod进内核);(2)dsh-tavern(AGPL-3.0,与Luker同族)逻辑可移植进 server/插件 AGPL 区——magvarupdate vendor、gal-*渲染器、mod settingsSchema、card-stage-scheme、状态板、helper-facade 全是可搬资产;packages/{protocol,api-client,formats} 保持干净留 MIT-able;(3)DSH 包(MIT但未发布,依赖网深)只借语义不依赖——settings/jobs/session 语义进对应 seam;pi-mono 的 pi-ai provider 抽象形状供 ctx.generation provider seam 参考;(4)DSH vendored cordis 是 4.0.6-alpha 分叉线(24处本地改动),npm 版缺的 volatile config/hmr/profile 语义由自写 loader 层补;(5)dsh-tavern 无服务端引擎可搬(其架构=嵌ST前端frame),TASK-006 移植不可省。
- Rationale: 同 cordis 底座+MIT/AGPL 兼容带使"借用"可分三层落地;dsh-tavern 是同一题目在 DSH 上的成品,外围资产直接省掉大量设计/实现;但引擎、GUI、koishi 生态不可借,边界必须写死防漂。
- Source: conversation + ref/dsh-tavern LICENSE + vendor/cordis-rc11-upgrade-plan.md
- Supersedes: none
- Affects: TASK-011/013/015 及包 license 边界
- Recorded: 2026-11-03T07:40:00.000Z
EOF
node -e 'const fs=require("fs");const t=JSON.parse(fs.readFileSync(".loom/tasks.json","utf8"));
const x=t.tasks.find(y=>y.id==="TASK-011");x.reads.push(".loom/capabilities/plugin-kernel/research/borrow-map.md","ref/deepseek-harness/vendor/cordis-rc11-upgrade-plan.md");
const y=t.tasks.find(z=>z.id==="TASK-013");y.reads.push("ref/dsh-tavern/tavern-plugin/lib/vendor/magvarupdate");
fs.writeFileSync(".loom/tasks.json",JSON.stringify(t,null,1)+"\n");console.log("ok");' && loom check 2>&1 | sed -n '/"errors"/,/]/p' | head -5
## 耦合度分级(D-018 实证,grep getContext|SillyTavern|jQuery 判据)

| 档 | 资产 | 处置 |
|---|---|---|
| 解耦可搬 |  全族零命中(~500行,DSH host原生码)、(MVU上游库) | 移植/改写成渲染器插件与MVU settle |
| 只读参考 | 、、、(全命中,存在目的=伺候嵌入的ST前端) | 读语义(TH API面/shim行为),不搬码 |
| 不采用 | dsh-tavern 架构本体(嵌ST前端frame) | 路线拒绝;我们=服务端引擎移植 |

**移植前纪律**:每个 dsh-tavern 文件先过 grep 判据;命中 ST 内部 API 的一律只读。ST 恶果(jQuery/DOM引擎/前端组装)由 TASK-005/006 服务端移植+golden-diff 对冲,不靠借用解决。
