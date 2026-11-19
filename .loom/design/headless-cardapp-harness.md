# Headless CardApp Harness —— CLI/Node 玩轻前端卡

- Kind: architecture
- Status: draft
- 目标:让 CLI/Node 环境能挂载并操作卡内嵌 HTML/JS 应用(CardApp/TH 面板)。
  卡 JS 以为自己跑在 iframe 里,桥另一头是 api-client 打真服务端。
  本 harness 同时是 web/RN iframe 宿主的**协议参照实现**:同一份 nonce+白名单
  wire 校验、同一 dispatch 表,只换传输层。

## 0. 结论速览

| 决策点 | 选择 | 一句话理由 |
|---|---|---|
| DOM | **jsdom** | 真选择器引擎(nwsapi)+ parse5 innerHTML + 真 MutationObserver + `beforeParse` 注入点 + vm realm 隔离;实测卡 DOM 面 ~50 个 API,jsdom 原生盖九成,余 ~15 个桩补齐 |
| 加载 | 双流:document 入口 `runScripts:'dangerously'`+`beforeParse` 注 shim;module 入口 esbuild bundle→`init(ctx)` | 对齐 `?shim=t0` 拼接序(bootstrap→shim→卡码)与 Luker loader(`import→init(ctx)`)双契约 |
| 桥 | 进程内传输(shim 自带 `__utopinnPanelPost/Receive` 钩子)+ 复用 PanelBridge wire 校验 | runtime.js:26/64 已留头——传输层退化为函数调用,nonce/白名单/requestId 语义原样保留 |
| dispatch | **复合**:api-client `createPanelT0Handler` 主、`/api/utopinn/th/call` 兜底 | 服务端 th 表不含 eventOn/injectPrompts 等 → 纯透传会让半张 T0 表报 unsupported;panel-t0 是客户端侧全量 T0 实现 |
| CLI | `utopinn cardapp mount|eval|call|op|status|unmount` | 每动词一次性进程(mount→settle→act→exit)即可玩;`--daemon` 留交互态多步会话 |
| 沙箱 | jsdom vm realm(无 node 全局)+ fetch/XHR 收成 mount-space 解析器 + worker_thread 可选隔离 | CSP `connect-src` 语义的 headless 对应物;凭据永不出宿主 realm |

**调研中发现的三处既有缺口(本设计之外,但要登记)**:

1. **module 入口没人调 init**:`card-runtime/assets.js:110` 的 `buildModuleShell`
   只发 `<script type="module" src>`,而 Luker 约定卡(掌门卡 index.js:2389
   `export async function init(ctx)`,无自执行)全靠 loader 调 init——
   **module 入口卡在当前 web 宿主上是惰的**(module-probe 的 e2e 只断言
   shell 含 bootstrap+module 标签,tests/e2e/utopinn-cardapp.mjs:82-84,
   未断言 init 被调用)。harness 必须自带 init-caller;web 宿主同需补这一课。
2. **dispatch 两表不一**:web ctxApi.ts 纯透传 `/api/utopinn/th/call`,但
   utopinn-th.js METHODS 只有 11 个方法——T0 表里的 eventOn/eventEmit/
   injectPrompts/uninjectPrompts/waitGlobalInitialized/initializeGlobal/
   insertVariables/updateVariablesWith 全部 `{unsupported:true}`。
   api-client panel-t0.ts 在客户端实现了整表。**harness 采复合 dispatch,
   建议 web ctxApi 跟进同一实现**,否则真宿主比参照宿主还残。
3. **`th.inject` 有写无读**:panel-t0 的 injectPrompts 落 chat_state ns
   `th.inject`(panel-t0.ts:38,186),但 generate 管线只消费
   `settings.extension_prompts`+`chat_metadata.script_injects`
   (generate-context.js:404-408)——injectPrompts 今天写了不进 prompt。
   掌门卡的门线喂送走 `setExtensionPrompt`(settings 面,有消费),不受影响;
   TH 卡调 injectPrompts 则静默空转——生成管线需补读 `th.inject` ns。

## 1. DOM 层选型:jsdom

### 实测卡 DOM 面(决定证据)

`work/掌门卡/02_card_工作区/cardapp/index.js`(2635 行,ctx 面 module 卡):

```
document  : getElementById×7 createElement×3 body/head/documentElement
            activeElement ownerDocument defaultView dispatchEvent
element   : querySelector×54 querySelectorAll×39 addEventListener×45
            classList×30 dataset×68 innerHTML×18 outerHTML×2 textContent×13
            appendChild×8 remove×24 closest×4 matches×1 contains×3
            setAttribute×2 focus×7 scrollTop getBoundingClientRect×1
            firstElementChild style.*(大量)
window    : innerWidth/innerHeight matchMedia×3 getComputedStyle×2
            localStorage×4 MutationObserver×1 Event('input',{bubbles})
            setTimeout/setInterval/clearInterval removeEventListener
```

`ref/cards/GuiXu/js/*`(~20k 行,TH 面重型卡)增量:

```
+ document.fullscreenElement/exitFullscreen/webkitExitFullscreen×13
+ ResizeObserver×1 requestAnimationFrame×3 requestIdleCallback×2
+ visualViewport CustomEvent×8 createTextNode readyState location
+ sessionStorage Image fetch×1 parent.* SillyTavern.getContext window._
```

### 判定

| 候选 | 判 |
|---|---|
| **jsdom** | **选。** 选择器是 nwsapi(CSS3 全集,`[data-act="advance"]`/`.zb-pane.on`/`button[data-tab]` 这类全对);innerHTML/outerHTML 是 parse5 真解析;MutationObserver 真实现;`beforeParse(window)` 是所有卡脚本执行**之前**的唯一注入点——比字符串拼接 HTML 更干净的 `?shim=t0` 等价物;`runScripts:'dangerously'` 把卡码关进独立 V8 realm(无 require/process);`VirtualConsole` 收 console+jsdomError;`resources` ResourceLoader 子类 = 出网收口点(CSP 的 headless 对应);localStorage 有(origin 内存态)。 |
| happy-dom | 弃。轻、快,自带 matchMedia/ResizeObserver,但选择器与 HTML 解析保真度历史欠账;harness 兼任**协议参照**——保真 > 速度。 |
| 迷你自造 DOM | 弃。卡真实用到的是最难的 20%:CSS 组合选择器、innerHTML 解析、事件冒泡+委托(`e.target.closest`)。自造一个"差不多"的 DOM 是吞时间的无底洞,且参照意义为零。 |

### jsdom 缺口桩表(卡码运行前注入,~80 行)

- `matchMedia(q)` → `{matches:false, media:q, addEventListener(){}, …}`
  (jsdom 无此 API;恒不匹配 = 桌面布局,卡的窄屏分支进不去——op 级玩耍可接受,
  像素级回归本来就该走 `cardapp/ui.browser.test.cjs` 那套 Playwright)
- `ResizeObserver`/`IntersectionObserver` → 注册不回调的 no-op 类(GuiXu 各 1 处)
- `requestAnimationFrame/cancelAnimationFrame` → `setTimeout(fn,16)`(jsdom 仅在
  `pretendToBeVisual:true` 才有 rAF——直接开这个选项也行,二选一)
- `requestIdleCallback` → `setTimeout(fn,0)`
- `Element.prototype.scrollIntoView`/`window.scrollTo/scrollBy` → no-op
- `visualViewport` → `{width:innerWidth,height:innerHeight,addEventListener(){}}`
- `document.fullscreenElement`=null、`requestFullscreen`/`exitFullscreen` → resolve 的 no-op
- `alert/confirm/prompt/open` → 确定性桩(alert 记日志,confirm 恒 false,open 返 null)
- `getBoundingClientRect` → jsdom 默认全 0,够用(拖拽定位退化但函数存在)
- `navigator.sendBeacon`/`clipboard` → 缺席即可,不补

## 2. 加载管线

两条卡源、两种入口,正交组合:

```
卡源 A(server charDir):POST /api/card-runtime/mounts {charId}
   → {mountId, entryUrl, bridgeNonce, manifest, warnings}
   资产经 http://server/card-runtime/m/<id>/<path> 拉取(能力 URL,无会话)
卡源 B(本地文件):PNG → @utopinn/formats readCardFromPng → card JSON
   → data.extensions.card_app.files {path:content} 内存图
   (charx → CharXParser;data:URL 值 → base64 解码回字节,
    语义同 mounts.js:129-131)
   manifest 本地 parseCardAppManifest 复算;bridgeNonce 自铸
```

`AssetResolver` 统一接口:`resolve(relPath) → {bytes, contentType} | null`;
`resolveExternal(url)` 仅放行 manifest `permissions.network.allowlist`
(归一化规则复用 manifest.js `normalizeAllowlistEntry`,语义=命中走
`/card-runtime/m/<id>/cdn?url=` 代理;未命中→null=拒绝,等价 CSP 拦截)。
jsdom `resources` 挂一个 `class MountResourceLoader extends ResourceLoader`,
`fetch(url)` → 相对路径进 AssetResolver,`http(s)` 进 resolveExternal——
**这就是 headless 的 CSP `connect-src`/`script-src` 执行点**。

### 2a. document 入口(`entry:*.html`,TH 面)

```
1. manifest 校验(parseCardAppManifest 或 server bundle.manifest)
2. expandApiGrants(manifest.permissions.api) → allowed 集合
3. html = resolver.resolve(manifest.entry)
4. new JSDOM(html, {
     url: entryUrl(或 'https://card-runtime.local/m/<id>/'),
     runScripts: 'dangerously',
     resources: mountLoader,
     pretendToBeVisual: true,
     virtualConsole,                    // console/jsdomError 全捕获
     beforeParse(window) {
       window.__UTOPINN_PANEL_NONCE__ = nonce;
       window.__UTOPINN_PANEL_BOOTSTRAP__ = {face:'th', mountId, charId,
         stateNamespaces, initializedGlobals:[]};   // 同 assets.js:53-59
       window.__utopinnPanelPost = (m) => transport.cardToHost(m);
       installDomStubs(window);          // §1 桩表
       window.eval(shimRuntimeSource);   // @utopinn/panel-shim src/runtime.js
     }})
5. 卡内 <script>(inline 与 src 经 mountLoader)按文档序执行——
   序与 assets.js injectShimTag 等价:bootstrap→shim→卡码,全在 beforeParse 后
6. dom.window.document 'DOMContentLoaded' + 自定义 settle 探测 → ready
```

### 2b. module 入口(`entry:*.js`,ctx 面)

jsdom 不执行 `type="module"`(not-implemented),绕开:

```
1-3 同上;doc = 合成壳(复刻 buildModuleShell 语义:
    #card-app-container + style.css <link>,不引远程)
4. new JSDOM(shell, {runScripts:'dangerously', beforeParse 同上})
   —— ctx 面卡不吃 shim 全局,但 nonce/transport/桩照装(统一面)
5. 模块源 = resolver.resolve(manifest.entry)
6. esbuild.build({stdin:{contents:src, resolveDir:assetDir, loader:'js'},
     bundle:true, format:'cjs', write:false})
   → code;window.eval(`(function(){var module={exports:{}},exports=module.exports;
     ${code};window.__cardapp_exports=module.exports})()`)
   —— bundle 内相对 import 走 mountLoader 的 resolveDir,全资产离线可解
7. exports.init?(ctx) —— ctx 由 §3c ctx-builder 造
   exports.init 缺席 → 降级为自执行模块(只跑 bundle 副作用)
8. ready = init resolve + settle
```

与前端挂载序的对齐:web `CardAppFrame` = mount→iframe src?shim=t0→卡码;
headless document 流等价。module 流对齐的是 **Luker loader**
(`card-app/loader.js` `import(url)→init(ctx)` + `buildContext(container,charId)`),
web 宿主补上 init-caller 之前,headless 就是它的参照。

## 3. 桥接线

### 3a. 传输退化:postMessage → 函数调用

shim(runtime.js)已内建两条传输回退,headless 直接用第一条:

```
卡→宿主:window.__utopinnPanelPost(msg)            // runtime.js:26 首选路径
宿主→卡:window.__utopinnPanelReceive(msg)         // runtime.js:64 注入钩子
```

宿主侧做一个 `WindowAdapter` 喂给 PanelBridge(bridge.ts 原类复用):

```ts
const cardWin = { postMessage: (msg) => domWindow.__utopinnPanelReceive(clone(msg)) };
// inbound:shim 调 __utopinnPanelPost → 宿主包 {source:cardWin, data:clone(msg)}
//          → bridge.onMessage(syntheticEvent)
const bridge = new PanelBridge({ nonce, allowed, getWindow: () => cardWin, dispatch });
```

- `clone = JSON.parse(JSON.stringify(v))`:两边都过——
  ① postMessage 本是 structured-clone 语义,JSON 往返是保真近似且
  顺带执行了"wire 可序列化"约束(RN 真桥就是 JSON 串);
  ② 斩断跨 realm 引用:卡 realm 的 Proxy/getter/原型不渗进宿主。
- `PanelBridge` 是 React-free 纯 TS(bridge.ts:72-138),headless 直接消费。
  **建议把它和 `expandApiGrants` 从 apps/web/src/cardapp/ 抬到
  `packages/panel-host/`(或 protocol)**,web 与 harness 共用一份实现——
  "协议参照"才不裂成两份。
- `push(event,payload)` → `__utopinnPanelReceive({direction:'push',…})`,
  shim 只对 `th.event` 分发(runtime.js:59-61)——与 web 一致。

### 3b. nonce/source 在 headless 的退化

| web 语义 | headless 对应 | 保真度 |
|---|---|---|
| `ev.source===iframe.contentWindow` | `source===cardWin` 传输唯一性——能调 `__utopinnPanelPost` 的只有被注入了该函数的 window | 弱化但不空:恶意卡伪造 inbound 仍过不了 nonce 门;与 webview-bridge-security 结论一致(nonce+白名单才是真鉴权,source 是辅助) |
| mount-scoped bridgeNonce | 同源:server mount → 用 bundle.bridgeNonce;本地文件 → `crypto.randomBytes(16)` 自铸注入 | 语义不变:shim 读 `__UTOPINN_PANEL_NONCE__` 回显,bridge 比对(bridge.ts:87) |
| manifest api grants → allowed | `expandApiGrants` 原样复用 | 不变:'th'→全 T0,'ctx'→ctxFace,'th.x'→单方法 |
| opaque-origin `postMessage('*')` | 无 origin 概念;`__utopinnPanelReceive` 是定向投递,等价 | 语义不变 |

### 3c. dispatch:复合表(关键设计)

```
dispatch(method,args):
  method ∈ PANEL_METHODS_TH_T0 → panelT0Handler(method,args)
      (api-client createPanelT0Handler;
       deps={client, avatarUrl:`${charDir}.png`, chatFileName:`${chatName}.jsonl`,
             mountMessageId:0, emitToPanels:(ev,a)=>pushToAllMounts(ev,a),
             getCharacterCard:()=>client.th.call('getCharacter',{target}).then(r=>r.result)})
  method ∈ PANEL_METHODS(ctx.*) → ctxDispatch(ctx-face mounts;见 3d)
  其余 th.*(T1+:triggerSlash/getEmbeddedScripts/setChatMessages/…)
      → client.th.call(method.slice(3),{target:{charDir,chatName},args})
        unsupported → throw 'unsupported_method'(与 ctxApi.ts:44 同码)
```

理由:服务端 th 表(utopinn-th.js:140-247)只有
getVariables/replaceVariables/insertOrAssignVariables/deleteVariable/
getChatMessages/triggerSlash/getCharacter/getCurrentCharacterName/
getLastMessageId/getCurrentMessageId/getEmbeddedScripts——**T0 缺 9 个**。
纯透传 = 卡调 `eventOn` 拿 unsupported,harness 连 probe 卡都跑不满 T0。
panel-t0 handler 在客户端把整表立在通用端点之上(变量→chat_metadata/
settings/message.data/chat_state;injectPrompts→chat_state ns;事件→宿主订阅簿),
是当前生态里唯一的"全 T0"实现——harness 采它为 T0 主路,服务端表兜底 T1+,
`unsupported_method` 语义原样透传到 wire 错误码(bridge.ts:58)。

### 3d. ctx 面(module 卡,Luker init(ctx) 约定)

协议 `PANEL_METHODS` 的 ctx.* 子集(ctx.sendMessage/getChatState/…15 个)
走同一条 wire——harness 造一个 ctx 适配层:**可序列化的方法经桥**,
**不可序列化的成员本地实体化**:

```
经桥(=协议参照的价值):sendMessage swipe regenerate getChatState
  updateChatState getCharacterState updateCharacterState getWorldBook
  updateWorldBookEntry getCharacter getChat on off setTimer dispose
本地实体化(DOM/宿主对象,wire 装不下):
  container   = dom.document.getElementById('card-app-container')
  charId      = mount.charId
  assetBase   = `/card-runtime/m/${mountId}/`(语义对齐 Luker /api/card-app/<id>/;
                headless 不渲图,但字符串契约要真)
  parentDoc   = 缺省不提供(null)——掌门卡全 `?.` 防御且对 !parentDoc 有分支
                (index.js:2391,2605);--with-parent-doc 旗再挂个伪 host 文档
                (#send_textarea + matchMedia,验证「倒入输入框」路径)
  eventSource = Node EventEmitter 瘦身适配(on/emit/removeListener);
                泵(§3e)喂 tavern 事件名(GENERATION_STARTED 等)
  lukerContext= 能力代理,只放实测用到的子集:
                chat(只读 getHistory 快照) eventTypes{...} 
                setExtensionPrompt→settingsPatch(/extension_prompts/<key>,
                  语义=generate-context.js:404 消费面)
                worldInfoEntry.getSorted→worldGet 排序视图
                is_send_press:false generate()→generation API
                未列入方法 → 显式 throw `unsupported in headless ctx: <name>`
                (不静默 undefined——同 unsupported_method 精神)
  onDispose/registerRenderer/addEventListener/executeSlashCommand/
  getVariable/setVariable/getChatList/getWorldBooks/getWorldBookEntries/
  getHistory/editMessage/openOverlay/closeOverlay/getCharaFilename/
  setInterval/setTimeout(带 dispose 跟踪)
    → 宿主本地实现,后端各落 client 端点
    (getVariable→chat_metadata.variables;setVariable→patchChatMetadata;
     updateChatState→stateGet+reducer+statePatch,reducer 在宿主 realm
     JSON 出入;executeSlashCommand→th.triggerSlash→core stscript env)
```

掌门卡实测 ctx 面(index.js 调用频度):container×58 setVariable×24
getVariable×19 eventSource×18 lukerContext×14 parentDoc×8(全防御)
charId assetBase editMessage×2 openOverlay/closeOverlay onDispose
getWorldBooks getWorldBookEntries getHistory getChatState updateChatState
sendMessage registerRenderer addEventListener executeSlashCommand
getCharaFilename —— **全部在上表内**。卡自带 dev 桩
(`cardapp/preview.html:160-190`)就是这个 ctx 形状的手写版,可对拍。

### 3e. 事件泵(完整期)

服务端无 tavern 事件总线(ws-delivery 是 job 级流:head/chunk/end/ping),
泵在宿主侧合成:

- `generation_started/stopped/ended`:`streamJob(jobId)` 帧映射(head→started,
  chunk→streaming,end→ended;attach 已跑 job 也行)
- `message_sent/received/edited/deleted/swiped`:harness 自知 op(CLI send/
  ctx.sendMessage 触发)发直接事件;外部变化靠 mount 后 chat 快照 diff
  (body.length/末楼 swipe_id/mes 哈希;低频轮询或 op 触发时顺带 diff)
- `chat_changed`:CLI 层行为(use/chat-rename)由动词面显式发
- 投递:TH 面 → `bridge.push('th.event',{name,args})`;ctx 面 →
  `eventSource.emit(eventTypes名)` + `ctx.on` 订阅簿
- `th.eventOn` 订阅登记在 panel-t0 handler 的 `subscribedEvents()` 里,
  泵按集合过滤推送——与 bridge.ts:120-124 的 TODO 注释同一接缝,
  harness 先把它做实,web 可抄

## 4. CLI 暴露形态

`utopinn cardapp <sub>`(apps/cli 新懒加载模块 `cmdCardApp`,
保 utopinn-cli.mjs 零依赖启动;实现落 `packages/cardapp-harness`,
jsdom/esbuild 是它的 deps,不进 CLI 文件本体):

```
cardapp mount [--card <png|charx|json>] [--char d] [--chat n] [--daemon]
    → 装载:{mountId, face(th|ctx), entry, warnings[], grants, domReady}
    缺省卡源 = ctx.char(use 绑定);--card 换本地文件(资产源替换,
    ctx 目标仍指服务端 charDir——不一致时 warn 不拦)
cardapp eval <expr|--file f>      卡 window realm 里求值,回 {result,console[]}
    例:utopinn cardapp eval "TavernHelper.getVariables({type:'chat'})"
        utopinn cardapp eval "document.querySelectorAll('.zb-pane').length"
cardapp call <method> [args-json] 直打 dispatch(绕卡码,验宿主实现)
cardapp op <sub>                  DOM 操作面:
    click '<selector>'            dispatchEvent click(带 bubbles)
    dom '<selector>'              outerHTML/textContent 截读
    dump [--out f.html]           document.documentElement.outerHTML 落盘
    push <event> [args-json]      宿主→卡 push(th.event/ctx emit)
    wait <expr> [--timeout ms]    轮询直到表达式真(等卡异步收敛)
cardapp status                    mount 信息+console 尾+pending 请求
cardapp unmount                   dispose(ctx disposeCallbacks+bridge.dispose)
```

**会话绑定**:复用 `use` 的 `state.char.dir`+`state.chat.name`,与 `th` 动词
同构(cmdTh 1939-1943);`--char/--chat` 覆盖。**持久性**:卡真相在服务端
(chat_metadata.variables/chat_state/chat body),一次性进程玩卡无损——
`eval`/`op` 每次新 mount,init 重跑重读状态,等价"重开面板"。
`--daemon` 把 harness 挂成 detached 进程+loopback 控制口
(state.cardapp={pid,port,token}),多步交互/事件泵持续监听用;
unmount 杀进程清状态。proto 只做一次性,daemon 进完整期。

**JSON 输出**:`{ok,mount:{mountId,face,entry,warnings},result,console:[]}`
——agent 消费的契约;console 捕获(VirtualConsole)默认 `--full` 才全量。

## 5. 沙箱边界

| 面 | headless 姿态 | 对照依据 |
|---|---|---|
| Node 全局 | jsdom `runScripts:'dangerously'` 把卡码关独立 V8 realm——**无 process/require/Buffer/fs/global**;`dom.window.eval` 的宿主注入脚本同 realm 受限 | jsdom vm 语义;同 isolate 两 global |
| 出网 | 不给 fetch;window.XMLHttpRequest 包成"仅 mount-space"解析器(同 connect-src 语义);外链走 mountLoader 白名单 | csp.js:57 `connect-src {runtime}`;webview-bridge-security「卡片出网压自由度」 |
| 凭据 | UtopinnClient/CSRF/cookie 只活宿主 realm;桥消息仅 PanelWireMessage——卡 realm 无任何 session 抓手 | webview-bridge-security 硬约束②:注入对象绝不含凭据,只放白名单转发壳 |
| 桥注入面 | 仅 `__utopinnPanelPost`(单参数取 wire msg)+ bootstrap 常量——等价 `addJavascriptInterface` 的反例正解 | 同上①③:nonce+白名单自验 |
| 跨 realm 对象 | 出入皆 JSON 克隆;卡异常经 shim reject→wire error,宿主异常经 VirtualConsole+eval 捕获——不裸传 Error 实例 | postMessage structured-clone 语义 |
| localStorage | jsdom origin 内存态,mount 死即焚 | 恢复优先级:localStorage 本就是兜底第 3 位(card-runtime-ecosystem.md §1C);--persist-storage 旗可选快照 |
| DOM 能力 | 无渲染:不载 CSS 布局、不拉图、无 canvas(getContext→null)、media 无声;`parent===self`(顶层) | 卡戳 `window.parent` 拿到自己 → TH 宿主戳法自然降级 |
| CPU/内存 | 同进程:卡 `while(1)` 冻宿主——proto 接受(本地可信卡),`--isolate` 完整期 worker_thread 化:jsdom+卡跑 worker,父进程 `terminate()`+`--timeout` 看门 | dev 工具定位,非生产边界 |

**收紧建议**:默认可再降——`--strict` 把 inline `<script>` 之外的一切 src
也拦(`permissions.inlineScript=false` 的语义对应)、localStorage 换空实现、
`window.eval`/`new Function` 禁掉(cover eval 型卡变体)。proto 不做,登记。

## 6. 验收方案

### P0 冒烟(cardapp-probe,纯 TH 面)

1. `tests/corpus/cards/cardapp-probe.json` → `utopinn use <char> <chat>`
   (或 `--card` 直给文件)
2. `cardapp mount` → `{face:'th', entry:'index.html'}` ready
3. `cardapp eval "window.__probeResult"` → `JSON.stringify(chat vars)`
4. **对拍**:`cardapp call getVariables '{"type":"chat"}'` 与
   `utopinn th getVariables '{"type":"chat"}'` 结果逐字段等 ——
   证明 harness dispatch 与服务端真值一致;再跑 `replaceVariables` 写-读回环
5. 未授权:伪造 `nonce:'x'` 的卡内 post → `denied/bad_nonce` wire 错误;
   manifest 收 `'th.getVariables'` 单方法时调别的 → `denied`

### P1 端到端(掌门卡,ctx 面真 op)

1. v31 PNG `import-commit` 入库 → `utopinn use <dir> <chat>`
   (chat 内 stat_data 变量已沉底,或先 `mvu settle` 产账)
2. `cardapp mount` → face='ctx',`init` 跑完:
   VirtualConsole 含 `[总簿] mounted · day=…`;
   `eval "ctx.container.dataset.init"` → `'1'`
3. **读**:`eval "document.querySelectorAll('.zb-pane.on, .zb-pane').length"` ≥1;
   `eval "document.querySelector('.zb-page').textContent.includes('灵石')"` → true
   (stat_data 四页渲染;空态卡 → 「账房誊抄中」也算就绪分支)
4. **写变量**:`eval "ctx.getVariable('stat_data').day"` 读值 →
   `setVariable('stat_data', {...v, day:v.day+1})` →
   `utopinn th getVariables` 见 day+1(落进服务端 chat vars)
5. **真 op**:`op click '[data-act="advance"]'`(或任一拟办按钮)→
   `eval "ctx.container.__drafts.length"` >0 →
   `op click '[data-tray="send"]'`(先发这些)→ ctx.sendMessage 触发 →
   `utopinn history -n 1` 见新 user 楼(真服务端落盘)
6. **事件**:`utopinn send '…'` 另一进程触发生成 → 泵推
   `message_sent/generation_ended` → 卡 `eventSource` 监听链触发 refresh
   (`eval` 断言 `__zbfails` 计数或 DOM 翻日)
7. **降级路径**:`--with-parent-doc` 挂伪 `#send_textarea` →「倒入输入框」
   op 后 textarea.value 含托盘文本且不发送

GuiXu 级拉伸(可选):document 入口 + 远程 js/css 经 cdn 解析器 +
TH `getChatMessages`×43 频度压测 → dispatch 耗时分布,顺便给 T1
(setChatMessages/lorebook 写)挂 unsupported 或真实现的清单账。

## 7. 工作量切分

### Proto(能 mount + 一个 op)

| 块 | 内容 | 量级 |
|---|---|---|
| 包骨架 | `packages/cardapp-harness/`(exports `mountCardApp` + `bin`) | 小 |
| DOM | jsdom dep + `beforeParse` 注入 + §1 桩表 | 中(~150 行) |
| 资产 | AssetResolver(server mount-space fetch + 本地 files 图) | 中 |
| 管线 | document 入口流(§2a)+ settle 探测 | 中 |
| 桥 | PanelBridge/expandApiGrants 抬共享(packages/panel-host 或 protocol)+ WindowAdapter 传输 | 小(web 改 import 一行) |
| dispatch | panel-t0 handler + th/call 兜底(§3c) | 小(api-client 现成) |
| CLI | `cardapp mount/eval/call/status/unmount`(一次性进程) | 中 |
| 验收 | P0 冒烟脚本 | 小 |

**不含**:module/ctx 面、事件泵、daemon、cdn 外网、worker 隔离。

### Full(全 T0 面 + 事件泵 + ctx 面)

| 块 | 内容 | 量级 |
|---|---|---|
| module 管线 | esbuild bundle + init-caller(§2b) | 中 |
| ctx 面 | §3d 全表:桥 15 法 + 本地 ~20 成员 + lukerContext 代理(掌门卡实测面) | **最大块**——lukerContext 逃口取舍是判断题不是体力题 |
| 事件泵 | streamJob 帧映射 + chat diff + eventOn 订阅过滤(§3e) | 中 |
| daemon | `--daemon` detached + loopback 控制 + state.cardapp | 中 |
| ops | click/dom/dump/push/wait 全动词 | 小 |
| 外网 | cdn 代理解析 + allowlist 执行(manifest.js 归一化复用) | 小-中 |
| 硬化 | worker_thread 隔离、--strict 面、localStorage 快照 | 中 |
| 验收 | P1 掌门卡端到端 + GuiXu 拉伸 | 中 |

### 建议顺序

1. proto 一次过(document 入口 + TH 面)— 1 个 PR
2. **先补 web 宿主 init-caller 缺口**(§0-1):`buildModuleShell` 的 shell 里塞
   `<script type="module">import(m).then(m=>m.init&&m.init(ctx))` 的等效件——
   否则 headless 成了唯一能让 module 卡活的宿主,参照意义倒挂
3. ctx 面 builder + 掌门卡 P1 — 第二个 PR
4. 泵/daemon/外网/隔离 — 按需拆

## 附:调研出处

- 桥契约:`packages/protocol/src/panels.ts`(T0 表 73-94、wire 211-259)
- 宿主三件套:`apps/web/src/cardapp/{bridge.ts,ctxApi.ts,CardAppFrame.tsx}`
- shim:`packages/panel-shim/src/runtime.js`(传输回退 25-33、收口 64-69)
- 服务端:mounts.js(createMount 170/publicMount 273)、
  assets.js(injectShimTag 50/buildModuleShell 81/entryHandler 138)、
  manifest.js(面缺省 218)、csp.js、utopinn-th.js(METHODS 140)
- api-client:`panel-t0.ts`(全 T0 handler + scope 映射头注)
- 卡实证:`work/掌门卡/02_card_工作区/cardapp/index.js`+
  `preview.html:160-190`(作者手写 ctx 桩,ctx 面契约实物)、
  `ref/cards/GuiXu/`(TH 面重型卡)、`tests/corpus/cards/cardapp*-probe.json`
- 既有设计:`.loom/design/cardapp-web-host.md`、`mobile-panels.md`、
  `capabilities/sandboxed-card-apps/research/{webview-bridge-security,
  card-runtime-ecosystem}.md`
