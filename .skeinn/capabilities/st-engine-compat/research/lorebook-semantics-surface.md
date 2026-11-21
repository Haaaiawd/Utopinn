# 世界书引擎行为面清单(跨实现对比证据)

Source: Foreverse "Lorebook Migration Doctor" 跨平台行为表(ST/Chub/RisuAI/Agnai/JanitorAI)、kwaroran/RisuAI `lorebook.svelte.ts`、fount `ccv3-converter.mjs`(CCv3→STv2 映射)、本地 `apps/server/public/scripts/world-info.js` 枚举与入口函数

跨平台对照表证明:世界书语义在各家实现差异极大——RisuAI 把 key 转小写去空格后 substring("ice" 命中 "police"),Agnai 永远 \b 全词+通配符,JanitorAI 有 ASCII 归一化;ST 是 substring 默认+可选 \W 全词(CJK 友好)+/slash/ 正则 key。次关键字逻辑门:ST 支持四种(AND_ANY/NOT_ALL/NOT_ANY/AND_ALL),RisuAI 只有正 AND、排除得靠 @@exclude_keys 装饰器,导入时逻辑模式直接丢。大小写:ST 是全局开关+条目级覆盖;ST 不读 Chub 的 snake_case 字段(写入端兼容≠读取兼容)。这些就是"行为差一点都不兼容"的铁证。

本地代码枚举出的完整行为面(移植 checklist):插入策略 insertion_strategy{evenly,character_first,global_first};逻辑门 logic{AND_ANY,NOT_ALL,NOT_ANY,AND_ALL};扫描状态 scan_state{NONE,INITIAL,RECURSION,MIN_ACTIVATIONS}(递归与"最小激活深度再扫描"是两种触发);位置 position{before,after,ANTop,ANBottom,atDepth,EMTop,EMBottom,outlet} 八种+anchor{before,after};深度默认 4、权重默认 100、扫描深度上限 1000;装饰器 @@activate/@@dont_activate 等;另有 regex key 解析(splitKeywordsAndRegexes/parseRegexFromString)、worldInfoCache(克隆语义)、checkWorldInfo/getWorldInfoPrompt 双入口、convertCharacterBook(旧格式迁移)。引擎输出必须带注入轨迹(dry-run)供 diff。
