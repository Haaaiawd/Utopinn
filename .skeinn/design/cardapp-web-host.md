# CardApp web 宿主设计(TASK-022)

> vs-V2: current

## 定位

TASK-014 已交付服务端面(manifest/CSP/mounts/cdn-proxy/assets,
`/m/<id>/` 挂载点)。本设计是**另一半**:web 端把卡内 HTML 应用真正跑
起来的宿主——iframe 沙箱 + postMessage 桥。MVU 面板(013)、卡内小游
戏/背包/状态栏都依赖它;移动端 TASK-009 复用同一桥协议
(react-native-webview 的 postMessage 与 iframe 同构)。

## 分层

```
apps/web/src/cardapp/
  CardAppFrame.tsx   <iframe sandbox> 壳:加载 /api/card-runtime/m/<id>/,
                     按 mount 能力分级给 sandbox 属性(allow-scripts 必有;
                     allow-same-origin 仅 manifest 声明同源的才给)
  bridge.ts          postMessage 协议处理:{kind:'ctx.call',id,method,args}
                     → api-client → {kind:'ctx.result',id,ok,value|error}
  ctxApi.ts          ctx.* 命名空间 → REST 映射表(getVariables/setVariables/
                     getChatData/substituteParams…对齐 Luker ctx surface)
```

## 桥协议(与移动端共享,protocol 包登记)

- `ctx.call {id, method, args[]}` → `ctx.result {id, ok, value|error}`
- `host.event {name, payload}` — 宿主→面板单向事件(chat 更新/变量回执/
  主题 token 变更)
- `panel.ready` 握手:面板加载完先握手拿 capability 清单(mount 授权集),
  未授权 method 直接 `denied` 错误,不落服务端

## 边界

- iframe `sandbox` 默认最严:`allow-scripts` + 视 manifest `sameOrigin`
  位;`allow-modals`/`allow-downloads` 不给
- 面板**不能**直接 fetch /api/*(无 CSRF);一切走桥
- 旧式戳 `getContext()`/全局的 JS(Luker 已知退化面)桥 shim 尽力兼容,
  不行则面板级 degraded 徽标,不拖死宿主
- 位置:聊天页右面板 tab + stories 域详情页,两处同一组件

## 验收

- GuiXu/airline-mvu 级卡在 web 面板可渲染且能读写变量
- 未授权 mount 的 ctx 调用被拒且有 UI 提示
- CSP violation 在诊断域可见
