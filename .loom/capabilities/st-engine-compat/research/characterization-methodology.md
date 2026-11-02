# 遗产代码移植的标准方法论:特征化测试 + Seam

Source: Michael Feathers《Working Effectively with Legacy Code》第11章(O'Reilly)、Wikipedia "Characterization test" 词条、Ace8/Mozaic Works 遗产重构指南、AST characterization profiling 实践报告

Feathers 的方法论正好适配本项目:对一个没有测试、行为即规格的遗产引擎,不要试图"理解再重写",而是先写特征化测试——用真实输入跑原实现、把真实输出(包括看上去像 bug 的部分)录为期望值;然后找 seam(不改代码就能替换依赖的接缝:接口、可覆盖方法、函数注入点)把外部依赖断开;最后小步重构,每步跑测试。所谓 Golden Master,就是把"整个复杂输出"作为 oracle 对比,而非逐属性断言。

映射到本项目:golden = request-inspector 捕获的 wireRequest(原版前端组装的最终请求),seam = Luker 前端已经把引擎逻辑收口进 ctx 函数(generate-task.js/lukerContext.js)这一层——从 ctx 的签名出发逐函数移植,DOM/网络/存储调用处即 seam,替换为注入端口。Mozaic 的变体值得借鉴:先机械重构向纯函数收敛,再对纯函数写数据驱动测试,最后才谈设计。切记:特征化测试记录的是"现状行为",发现可疑行为也先如实记录、另行修复,不在移植中顺手改。
