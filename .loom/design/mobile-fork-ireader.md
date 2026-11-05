# 移动端新地基:fork IReader(KMP)

> 状态:已拍板(D-020),侦察完成,待切割实施
> 关联:mobile-reader-form(UX 目标,仍有效)/ mobile-panels(桥协议,仍有效)/ mobile-ui-foundation(Expo 栈文档,冻结为参照)

## 为什么是 IReader

国内圈子首选 legado 已于 2026-05 被法律核掉(上游删库公告,阅文 IP 诉讼)。替代品对比:

| 候选 | 协议 | 栈 | 死活 | 结论 |
|---|---|---|---|---|
| **IReader** | Apache-2.0 | Kotlin Multiplatform | 周级提交 ✅ | **选中** |
| legado 快照 | GPL-3.0 | Kotlin 安卓 | 死上游+法律云 | 否决 |
| Kototoro | Apache-2.0 | 全 Compose | 太新(2025-10 建) | 备选 |
| Shosetsu | GPL-3.0 | Kotlin 安卓 | 活跃但架构老 | 否决 |

## 地基实况(ref/ireader,4919 文件)

```
android/  desktop/  iosApp/     三端壳(KMP)
presentation/  domain/  data/   UI/领域/数据三层分离
source-api/  plugin-api/  source-runtime-js/   书源层 = 切割缝
core-utils/  i18n/  buildSrc/  config/
supabase/  huggingface_space_coqui/  benchmark/  test_local_novel/   外挂赘肉
rootProject.name = "Infinity"
```

## 切割方案

**保留**(阅读器质感所在):presentation 全部屏、domain 模型、data 层形状、i18n、三端壳
**切除**:source-runtime-js(JS 爬虫引擎——书源生态本身就是 legado 被告的那块,我们没有也不要)、supabase/、huggingface/、benchmark/、test_local_novel/、plans/
**替换**:`source-api` 的 Source 接口实现 → 「uberge 源」:以我们服务端 api-client 为唯一数据后端(书架=会话列表、书页=角色/会话详情、章节=楼层语义切片)
**新建**(任何阅读器都没有的 RP 件):
- swipe 候选(段尾「✦N稿」→半屏候选卡)
- 书写层(「你的回合」呼出式 composer)
- CardApp WebView 面板(mount/nonce 桥协议已在 packages/protocol + Expo 实现验证过,Kotlin 侧用 Android WebView 重实现同一协议)
- MVU 状态条/变量 op 行渲染

## 与现有资产的关系

- `apps/mobile`(Expo):冻结为参照。面板桥 nonce 协议、会话流数据形状、阅读器形态调研继续有效;HeroUI/uniwind 栈不迁移。
- 服务端协议零改动:uberge 源就是一个客户端,KMP 侧吃同一套 REST/WS。
- TASK-008/009/027 已落代码转参照态;验收语义按新地基重排(同一批 done_when 在新栈上重新达成)。

## 开放问题(侦察待续)

- source-api 的 Source 契约具体形状(接口面多大,uberge 源工作量)
- presentation 层对 source 层的耦合点(书架/详情/阅读器分别从哪个接口取数)
- Compose Multiplatform iOS 实际成熟度(iosApp 是脚手架还是可用)
- 阅读器屏的分页引擎形态(滚动流 vs 分页——RP 楼层流适配哪种)
- KMP 侧 WebView + JS bridge 的等价物(CMP WebView 成熟度,或 android 先 WebView)
