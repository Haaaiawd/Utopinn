# RN WebView 跑不可信卡片代码的安全面

Source: OWASP MASTG-BEST-0035(Prefer Origin Scoped Messaging)、Android Developers "Insecure WebView native bridges"、react-native-webview Reference.md、GHSA-36j3-xxf7-4pqg(UXSS advisory)

三条硬约束:其一,`window.postMessage`(react-native-webview 的 onMessage 通道)不带 origin——社区文档明确警告"任何文档都能 postMessage",所以桥协议必须自己防伪:每个 app 实例挂载时注入一次性 nonce,桥消息须携合法 nonce+方法白名单,缺即丢。其二,`injectedJavaScriptObject` 注入的对象对页面所有 frame(含恶意 iframe)可见——桥对象里绝不放凭据/令牌,只允许调用白名单方法的转发壳。其三,禁用 addJavascriptInterface 式直接注入原生对象(全 frame 暴露且无 origin 校验,OWASP 列为反模式),Android 侧优选是 addWebMessageListener(allowlist-based)——若 react-native-webview 不支持则用 nonce+白名单自验达到同等效果。

次级约束:静态 HTML 要 originWhitelist=['*'] 才能加载,但应同时 baseUrl 置空+setSupportMultipleWindows(false)+onShouldStartLoadWithRequest 拦截一切导航,把 WebView 锁成"单文档只读页";卡片代码的出网不物理禁止(纯 JS 沙箱做不到),用注入 CSP(connect-src 'none' 等)+ 桥代理白名单端点的方式压低自由度;GHSA 教训是跨源 iframe 可注入顶层——我们单文档无 iframe 即规避,但状态栏 HTML 若自带 iframe 要 strip。
