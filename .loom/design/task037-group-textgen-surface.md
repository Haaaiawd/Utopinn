# TASK-037 — group 聊天 + textgen/kobold/novel 源进服务端 cordis 面

> vs-V2: partially-stale

只读侦察(2026-11,explore 子代理产)。对应 tasks.json TASK-037(depends_on TASK-032;
done_when:group 生成走服务端组装(deps.group 接入)+ textgen/kobold/novel 派发接入 + CLI 实弹)。
边界:group UI 交互不重写;非 openai 源只接派发不重写 provider。

## 0. 结论速览

- **派发层已齐**:`dispatchTextCompletions`(15 变体)、`dispatchKobold`、
  `dispatchNovelAI` 都是现成 provider。缺的是 **body 整形**:legacy 前端在
  generate_data 里做了大量 per-source 采样/停止串/token-id 转换,utopinn 分叉只做别名映射。
- **group 持久化已齐**:getPersistChatKey group 分支、persistGeneratedReply group
  分支、chat-state sidecar、MVU settle、ack hint 全部已识别 {is_group,id}——勿重写。
- **group 缺的真核**:没有"成员选择→逐成员组装→逐成员生成"编排器;
  buildGenerationContext 单卡 chat-only;substCtx.groups/deps.group 两个 core seam
  从未被喂;落盘楼层缺 original_avatar/force_avatar/extra.gen_id。
- **顺序**:textgen body 整形(纯增量)→ group 数据面 → group SWAP 生成 →
  APPEND 联合上下文 → kobold classic + novel → CLI 动词。

## 1. Textgen 现状

utopinn-generate.js `body.api==='text'` 分叉已通 dispatchTextCompletions
(TEXTGEN_TYPES 15 值;kobold/novel 不在其中,是独立 main_api 源)。api_server 解析、
TEXTGEN_CONN_KEYS 剥除、4 别名已有。

**与 legacy getTextGenGenerationData 的差距(全缺)**:
1. 停止串四层:names_as_stop_strings(user/char+群其余成员)、instruct stopping
   sequences、custom_stopping_strings、single_line——现状只透传恒空的 stopping_strings。
2. model 解析(getTextGenModel per-type);openrouter/ollama 缺 model 上游会拒。
3. 派生参数:dynatemp 家族、seed、n、logit_bias(array-of-arrays 合并)、
   banned_tokens→custom_token_bans/banned_strings、dry_sequence_breakers、
   grammar/json_schema 互斥。
4. per-type 袋:openrouter provider/quantizations、aphrodite 全量袋、mancer
   epsilon/eta÷1000、koboldcpp grammar/trim_stop、huggingface clamp+seed+stop slice、
   llamacpp 别名(repeat_penalty/n_predict/num_ctx/mirostat/ignore_eos)、CFG。
5. truncation_length/num_ctx=max_context 未设。
6. /api/backends/text-completions status|props 面 utopinn 无等价。
7. 旗标名:textgen 读 body.stream;kobold/novel 派发读 body.streaming。
8. substCtx.mainApi 硬编码 'openai'(影响 mesExamples 块头)。
9. kobold:kai_flags(can_use_*)由 kobold/status 探测;旧上游收不支持字段会拒。
10. novel:stop/bad_words_ids 要 token id 数组——tokenizers.js:251-264 已有
    spp_nerd/spp_nerd_v2/llama3,只需暴露 encode helper;prefix 探测+preamble。
11. horde:无 dispatch provider,建议划出本期。
12. 预设桶 'textgenerationwebui'/'novel'/'kobold' PresetRepo 已存在。
13. 客户端 extractDelta(mobile/web)只解 choices.delta;kobold/novel 的 {token}/
    {results}/{output} 帧客户端无 delta(服务端落盘已对)。

## 2. Group 现状

<!-- V2 校准:group parked(C9 砍);textgen/kobold/novel 余量 open -->

**路由两簇(无 /api/groupchats/*)**:
- 群档 /api/groups/*(groups.js):all/create/edit/delete;members/disabled_members/
  activation_strategy/generation_mode/join prefix-suffix/chat_id/chats[]。
- 群聊 /api/chats/group/*(chats.js):get/info/append(含 CAS/gen-id/备份/ack/MVU)/
  delete/rename/merge/split/import/save/patch/meta/search。
- 持久层:GroupRepo(doc)+ChatRepo{isGroup,groupId}(file)。**persist_target.id=
  群聊文件 id,非群 doc id**。

**已就绪持久化(勿重写)**:getPersistChatKey→group:<id>;persistGeneratedReply
group 分支;resolveChatStateRepoKey/chatStateTargetFromQuery/resolveMvuChatTarget
全支持 {is_group,id};/api/utopinn/state/chat/* 直接可复用。

**生成语义(在浏览器 group-chats.js)**:
- activation_strategy:NATURAL(提及+talkativeness+随机+屏蔽上一位)/LIST/MANUAL/POOLED。
- generation_mode:SWAP(逐成员独立卡)/APPEND(联合卡,join prefix/suffix+
  <FIELDNAME> 模板,群 depth prompts DEPTH_PROMPT_INDEX(i))/APPEND_DISABLED。
- generateGroupWrapper 串行逐成员生成,每成员一层楼。
- group 楼层字段:force_avatar(thumbnail url)、original_avatar(成员 avatar)、
  name=成员名、extra.gen_id(批号)。

**character vs group 差异矩阵**:聊天加载需 {isGroup,groupId} 分支;SWAP=成员卡,
APPEND=联合卡;substCtx.groups/deps.group seam 存在未喂;激活策略+串行逐成员 job;
落盘缺 original_avatar/force_avatar/name/extra.gen_id 透传;WI SWAP 取成员 charLore,
APPEND 取书规则未实证;非 SWAP 需 DEPTH_PROMPT_INDEX(i);其余成员名 stop strings;
新群聊需联动群 doc chats[]/chat_id;服务端需 group:<id> chatKey 生成锁。

## 3. 缺口清单

A. group 数据面:/api/utopinn/groups CRUD + /api/utopinn/group-chats/:chatId
   读/append/patch/document/delete/meta/rename;建聊联动群 doc。
B. group 生成面:target={kind:'group',groupId,chatId};成员解析(显式 member
   或策略);每成员一 job persist_target{kind:'group',id:文件id,member字段};
   APPEND 联合卡+多 depth 提示。
<!-- V2 校准:group parked(C9 砍);textgen/kobold/novel 余量 open -->
C. textgen body 整形:buildTextgenDispatchBody;status/props 面。
D. kobold/novel:api union;kai_flags 探测或传入;novel encode helper+prefix;
   streaming 旗标;客户端 decode 扩展。
E. CLI:group list/get、generate --target group/--member、--api text --api-type、
   kobold/novel 参数面(当前零动词,done_when 硬要求)。

## 4-5. 依赖图与分阶段

textgen body 整形(阶段1)→ group doc CRUD → 群聊读写(阶段2)→ SWAP 生成(阶段3)
→ APPEND(阶段4)→ kobold+novel(阶段5)→ CLI 实弹(阶段6)。

阶段0:核 persistTarget 透传字段集+APPEND WI 取书规则。
阶段3 验收:generate --group --chat --member 落楼含 original_avatar;省略 member 按策略选并回报。

## 6. 不确定项(未实证)

1. APPEND 模式 WI 取书规则(成员书并集?)——读 upstream group-chats getWorldBooks 链再定。
2. kai_flags 服务端等价端点待核。
3. NATURAL 提及正则细节移植时以源码为准。
4. novel preamble/selectPrefix 细节按 nai-settings.js 核。
5. force_avatar 是 thumbnail URL——服务端无 getThumbnailUrl,需定写 URL 还是 avatar 文件名。
6. 每成员一 job(推荐,复用 job/ack/WS)vs 单 job 多成员——未定可辩。
7. textgen n>1 与 swipe 数组联动未确认,首版 n=1。
8. 命名:/api/utopinn/groups(doc)+/api/utopinn/group-chats/:chatId(file)与持久层键形自洽。
