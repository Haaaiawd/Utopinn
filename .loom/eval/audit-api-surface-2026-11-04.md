# 后端 Audit:API 面(代理 2612fb1a,2026-11-04)

## 总评
- 认证/CSRF/能力模型:健康(全部插件路由在 requireLogin+CSRF 后;WS ticket 32B/30s/单次/绑handle 教科书级)
- 路径安全:基本健康,全库 safeName 习惯好,**generate 是唯一漏点**
- 最弱环节=契约层:protocol 包与实际 wire 脱节
- 多用户面系统性 admin 缺失(单用户期可降级,开 accounts 前必修)

## 🔴 HIGH
- **H1 路径穿越** `uberge-generate.js:146`:charDir 无 safeName→`loadCharacterCard` path.join 读任意 *.json→/preview 外带文件内容+存在性 oracle。一行 safeName 可修(chatName 下游有 normalizePersistJsonlFileName 兜底)
- **H2 原型链污染** `uberge-th.js:47-73`:setPath/delPath 无 `__proto__`/`constructor`/`prototype` 防护→`Object.prototype.admin=true` 提权(绕过 uberge-data.js:85 admin 门)+DoS(delete toString);**CardApp 桥可达**(manifest api:['th']→dispatchPanelCall 原样转发)。修法:pathSegs 出口加黑名单
- **H3 跨用户 job 劫持** `luker-generation.js:493-531`:generationJobs.get(jobId) 后不查 owner→abort+清 events+换 persistTarget/requestMeta;job_id 客户端可控(body.luker_generation.job_id 或 x-luker-request-id)

## 🟠 MEDIUM
- M1 `uberge-data.js:126` scan-st 任意路径枚举(无 admin 门/路径约束,多用户下数据外泄)
- M2 `uberge-plugins.js:30-42` enable/disable/reload 无 admin 门→非 admin 可断全员流(自锁只挡 uberge-plugins)
- M3 500mb JSON body+500mb multer→登录用户内存 DoS;建议按面收紧(import≤50MB/chat≤5MB)
- M4 错误体 5 种形状 vs protocol.ApiError 一种;mvu 两处发裸 `{error:true}` 无 message
- **M5 `protocol/generation.ts` 是死规范**:请求/job handle/事件帧/订阅消息全与实际 wire 对不上;两客户端都本地重声明 wire 类型——「唯一事实源」名存实亡,须拍板谁迁就谁
- M6 TH 桥契约漂移:panels.ts 声明 20 个 T0 方法服务端只实现 11(unsupported 还回 200);ThVariableScope 'script' 服务端拒收;ThChatMessageView is_hidden 服务端无

## 🟡 LOW
- L1 `/_kernel` 泄全路由表+服务目录(建议 admin 门)
- L2 UDP 发现绑 0.0.0.0(listen:false 也对外 pong;匹配过宽 `includes('"uberge"')`)
- L3 personas `avatar='__proto__'` setter 怪癖→静默不落盘(自伤型)
- L4 `webserver.ts:105` decodeURIComponent 非法%→URIError 500(噪音级)
- L5 preview/panel 的 escape_html:false 调用方可控(自我 XSS,属设计)

## E2E 缺口
未钉:/characters/:charDir 单卡、GET/PATCH settings、全部 4 个 /mvu/*、th/call 方法粒度、WS forbidden/心跳/ticket过期、abort+active、card-runtime CDN/资产穿越/过期/跨owner、legacy sync+users 面;**H1/H2/H3 修复应各补一条回归**

## 修复优先级
H2 > H1 > H3 > M1/M2 > M5(拍板事实方向) > 其余
