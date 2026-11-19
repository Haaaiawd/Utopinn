/**
 * utopinn-generate —— kernel 插件:服务端全组装生成面(TASK-007 首迁 POST)。
 *
 * POST /generate  全组装 → runLukerDispatch(与 chat-completions 同派发路径)
 * POST /preview   干跑组装,回 messages+trace+sources+perf(prompt viewer 数据源)
 *
 * handler 原样搬自 endpoints/utopinn-generate.js;path 补全 /api/utopinn 前缀,
 * 注册进 webServer pattern 表。request.body 由上游 express.json() 就位
 * (dispatcher 挂在全部路由中间件之后、legacy 挂载之前)。
 */
import { buildGenerationContext, logPerfLine, persistWorldInfoTimedEffects } from '../services/generate-context.js';
import {
    avatarToCharDir,
    buildRosterEntry,
    deriveActivationInput,
    memberAvatarThumbnailUrl,
    selectActivatedMembers,
} from '../services/group-orchestration.js';
import { getChatRepo, getGroupRepo } from '../storage/index.js';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { buildTextgenDispatchBody, resolveTextgenModel, resolveTextgenServer, unescapeMacroBraces } from '../services/textgen-body.js';
import { selectChatCompletionDispatch } from '../endpoints/backends/chat-completions.js';
import { dispatchTextCompletions } from '../luker-dispatch/providers/text-completions/dispatch.js';
import { TEXTGEN_TYPES } from '../constants.js';
import { runLukerDispatch } from '../luker-dispatch/runner.js';
import { listGenerationJobsForRequest, getGenerationJobForRequest } from '../endpoints/backends/luker-generation.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getPromptNames, postProcessPrompt } from '../prompt-converters.js';
import { flattenSchema } from '../util.js';
import { safeName, sendError } from './utopinn-library.js';
import { emit as diagEmit } from '../services/diag-bus.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

export const inject = ['webServer'];

/** 角色卡加载:avatar 目录名 → 卡数据(data.* + name)。read() 返回 JSON 字符串 */
async function loadCharacterCard(directories, charDir) {
    const dir = directories.characters;
    const pngPath = path.join(dir, `${charDir}.png`);
    const jsonPath = path.join(dir, `${charDir}.json`);
    try {
        const raw = await fs.readFile(pngPath);
        const dataString = readCharacterCard(raw);
        return JSON.parse(dataString);
    } catch {
        const raw = await fs.readFile(jsonPath, 'utf8').catch(() => null);
        return raw ? JSON.parse(raw) : null;
    }
}

// —— TASK-037 group 生成编排(第一刀:每请求一成员一楼)——

/** legacy generateType 映射:group wrapper 只保留下列动词,其余(含 regenerate)走 'normal' */
const GROUP_MEMBER_VERBS = new Set(['swipe', 'impersonate', 'quiet', 'continue']);

/**
 * body.member → roster avatar。接受三种形:avatar 文件名('X.png')、
 * 目录名('X')、显示名(卡 name)。legacy force_chid 是下标;
 * 服务端用 avatar 做稳定键,宽松解析减少调用方负担。
 */
function resolveMemberAvatar(roster, member) {
    const needle = String(member ?? '').trim();
    if (!needle) return null;
    const byAvatar = roster.find((m) => m.avatar === needle);
    if (byAvatar) return byAvatar.avatar;
    const byDir = roster.find((m) => m.charDir === needle || m.avatar === `${needle}.png`);
    if (byDir) return byDir.avatar;
    const byName = roster.find((m) => m.name === needle);
    return byName?.avatar ?? null;
}

/**
 * 群生成计划:群 doc → 群聊文件 → roster(卡可加载成员)→ 成员选择。
 * 返回 { doc, groupId, chatId, roster, activated, speaker, generateType };
 * activated 空 = legacy「activatedMembers 空 → 只落用户楼」分支(调用方短路)。
 */
async function resolveGroupGenerationPlan({ request, body }) {
    const handle = request.user.profile.handle;
    const groupId = safeName(body.groupId, 'groupId');
    const doc = await getGroupRepo().get(handle, groupId);
    if (!doc) throw new NotFoundError(`Group not found: ${groupId}`);
    // 寻址沿用 /api/chats/group/* 约定:id = 群聊文件名(≠ 群 doc id 时可多聊);
    // 调用方带 .jsonl 后缀时先剥(group/get 的 stripJsonlExt 同款)
    const rawChatId = String(body.chatId ?? body.chat_id ?? body.id ?? doc.chat_id ?? doc.id ?? groupId);
    const chatId = safeName(rawChatId.replace(/\.jsonl$/i, ''), 'chatId');
    const chatDoc = await getChatRepo().get(handle, '', chatId, { isGroup: true, groupId: chatId });
    if (!chatDoc) throw new NotFoundError(`Group chat not found: ${chatId}`);

    const roster = [];
    for (const avatar of doc.members ?? []) {
        // legacy unshallowGroupMembers:找不到的成员跳过(findIndex===-1 过滤)
        const card = await loadCharacterCard(request.user.directories, avatarToCharDir(avatar));
        if (card) roster.push(buildRosterEntry(String(avatar), card));
    }
    if (roster.length === 0) {
        throw new InvalidArgumentError(`Group ${groupId} has no loadable member cards`);
    }

    const verb = String(body.type ?? 'normal');
    const chatBody = Array.isArray(chatDoc.body) ? chatDoc.body : [];
    const { isUserInput, activationText } = deriveActivationInput(chatBody, Boolean(body.automatic_trigger));

    let forceAvatar = null;
    if (body.member !== undefined && body.member !== null && String(body.member).trim() !== '') {
        forceAvatar = resolveMemberAvatar(roster, body.member);
        if (!forceAvatar) {
            throw new InvalidArgumentError(`member not in group or card unloadable: ${body.member}`);
        }
    }
    const { activated } = selectActivatedMembers({
        group: doc,
        roster,
        chat: chatBody,
        type: verb,
        isUserInput,
        activationText,
        forceAvatar,
    });
    if ((verb === 'swipe' || verb === 'continue') && activated.length === 0) {
        // legacy: toastr.warning('Deleted group member swiped') + throw
        throw new InvalidArgumentError('Deleted group member swiped');
    }

    const speakerAvatar = activated[0] ?? null;
    return {
        doc,
        groupId,
        chatId,
        roster,
        activated,
        speaker: speakerAvatar ? roster.find((m) => m.avatar === speakerAvatar) : null,
        // legacy:成员内 Generate 的 type 映射(其余动词都按 normal 生成)
        generateType: GROUP_MEMBER_VERBS.has(verb) ? verb : 'normal',
        verb,
    };
}

/**
 * presetDoc → chat-completions 派发 body 参数段(透传生成参数,
 * 与前端发往 /generate 的 oai_settings 子集同构)。
 */
function presetToDispatchParams(presetDoc, { includeConnection = false } = {}) {
    const d = presetDoc ?? {};
    const passthrough = {};
    for (const [k, v] of Object.entries(d)) {
        if (['prompts', 'prompt_order', 'extensions'].includes(k)) continue;
        if (!includeConnection && CONNECTION_KEYS.has(k)) continue;
        passthrough[k] = v;
    }
    return passthrough;
}

/**
 * textgen(TASK-020):messages[] → 单串 prompt,instruct 壳。
 *   user/assistant 消息经 engine.formatChat 包 input/output 序列;
 *   system 段(WI/作者注/jailbreak)原样并入 story(ST 同款);
 *   尾段 engine.formatPrompt 接 output_sequence + name2 前缀。
 * tgSettings 剥离连接层 + 塑形产物同键的设置态字段(防原始值混进 wire;
 * 塑形字段清单见 textgen-body.js,与前端 createTextGenGenerationData 对齐)。
 */
const TEXTGEN_CONN_KEYS = new Set(['type', 'server_urls', 'server', 'preset', 'legacy']);

/**
 * 设置态键 → wire 形由 buildTextgenDispatchBody 产出,这里只防透传撞键:
 * 门控型(type 分流才上行)、改名型(stopping_strings→stop 等)、加工型
 * (logit_bias 设置形 {text,value}[] ≠ wire 形;dry_sequence_breakers 串→数组)。
 * 其余同名同值的采样键(top_p/rep_pen/…)继续透传,与上游 pickBy 自滤互补。
 */
const TEXTGEN_SETTINGS_ONLY_KEYS = new Set([
    'stopping_strings', 'stop', 'logit_bias', 'seed', 'n', 'min_length',
    'epsilon_cutoff', 'eta_cutoff', 'no_repeat_ngram_size', 'penalty_alpha',
    'encoder_rep_pen', 'do_sample', 'early_stopping', 'num_beams', 'length_penalty',
    'negative_prompt', 'speculative_ngram', 'spaces_between_special_tokens',
    'temperature_last', 'dry_sequence_breakers', 'guidance_scale', 'grammar_string',
    'sampler_priority', 'samplers', 'samplers_priorities', 'sampler_order',
    'json_schema', 'banned_tokens', 'global_banned_tokens',
]);

function messagesToTextgenPrompt(messages, engine, substCtx) {
    const { name1, name2 } = substCtx;
    const instructOn = !!substCtx.instruct?.enabled;
    const parts = [];
    for (const m of messages) {
        const content = String(m?.content ?? '');
        if (!content) continue;
        if (m?.role === 'user') {
            parts.push(instructOn
                ? engine.formatChat(name1, content, true, false, false, name1, name2)
                : `${name1}: ${content}\n`);
        } else if (m?.role === 'assistant') {
            // legacy formatMessageHistoryItem 用楼层自身 name —— 群聊里每楼
            // 都可能来自不同成员;单卡路 name===name2,语义不变。
            const floorName = m?.name || name2;
            parts.push(instructOn
                ? engine.formatChat(floorName, content, false, false, false, name1, name2)
                : `${floorName}: ${content}\n`);
        } else {
            // system/narration 段原样并入 story(jailbreak/WI 段不包 instruct 壳)
            parts.push(content.endsWith('\n') ? content : `${content}\n`);
        }
    }
    // 尾段:output_sequence+name2 前缀;instruct 关 → 裸 "name2:" 续写锚。
    // TODO(storystring):instruct-off 原版还会经 context 模板整包
    // (formatStoryString),更深一层 fidelity 随 TASK-020 后续切片。
    parts.push(instructOn ? engine.formatPrompt(name2, false, '', name1, name2) : `${name2}:`);
    return parts.join('');
}

/**
 * 连接层字段:URL/密钥代理/模型名/自定义进出体 + source。
 * 这些产品语义上属"当前连接配置"而非"生成预设"——ST 选预设会整体重写
 * oai_settings(连 URL 一起洗掉是出名的坑),我们把连接面固定在
 * settings.oai_settings,preset 只贡献生成参数。
 */
const CONNECTION_KEYS = new Set([
    'chat_completion_source', 'reverse_proxy', 'proxy_password',
    'custom_url', 'custom_model', 'custom_include_body',
    'custom_exclude_body', 'custom_include_headers',
    'chat_completion_custom_models', 'show_external_models',
    'kimi_partial_name_source',
    'openrouter_group_models', 'openrouter_sort_models',
    'chutes_sort_models', 'electronhub_sort_models', 'electronhub_group_models',
]);

export function apply(ctx) {
    const reg = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));
    const regGet = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'GET', path, handler }));

    // —— TASK-017 生成任务监视/回放 ——
    /** GET /jobs —— 本 handle 全部生成任务摘要(新→旧),监视面数据源。 */
    regGet('/api/utopinn/jobs', async function (request, response) {
        return response.send({ items: listGenerationJobsForRequest(request) });
    });

    /**
     * GET /jobs/:id —— 单 job 详情:状态/文本/trace(组装 token 分块)
     * /sources(WI 激活轨迹)/事件数。events 不回传(走 WS resume 通道)。
     */
    regGet('/api/utopinn/jobs/:id', async function (request, response) {
        const job = getGenerationJobForRequest(request, request.params.id);
        if (!job) {
            return response.status(404).send({ error: 'Job not found.' });
        }
        return response.send({
            id: job.id,
            status: job.status,
            verb: job.requestMeta?.verb ?? null,
            model: job.modelName || job.requestMeta?.model || '',
            chatKey: job.chatKey ?? null,
            text: job.text ?? '',
            error: job.error || null,
            persisted: Boolean(job.persisted),
            lastSeq: job.lastSeq ?? 0,
            eventCount: Array.isArray(job.events) ? job.events.length : 0,
            trace: job.trace ?? null,
            sources: job.sources ?? null,
            // TASK-034 生成后 reconcile:派发 messages 快照 + timed effects 落库态。
            // 可空 —— legacy 派发与补件前创建的老 job 恒 null,消费方按缺省处理。
            promptMessages: job.promptMessages ?? null,
            timedWorldInfo: job.timedWorldInfo ?? null,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
        });
    });

    reg('/api/utopinn/generate', async function (request, response) {
        try {
            const body = request.body ?? {};
            // 认亲键:与 runner 的 requestId 同源(job_id > x-luker-request-id >
            // 现造 uuid)——组装期 inject 事件比 job 先出生,靠它挂回 job。
            request.utopinnDiagId = String(
                body.luker_generation?.job_id
                || request.headers?.['x-luker-request-id']
                || randomUUID(),
            );
            const directories = request.user.directories;
            const cardStart = performance.now();

            // —— 目标解析:body.groupId 存在 → 群路(群 doc→群聊文件→成员
            //    选择→发言成员卡);否则单卡路。两路收敛成同一组局部量
            //    (charDir=发言成员目录 / chatName=群聊文件 id / card=发言
            //    成员卡 / generateType=成员内生成动词),共用下方派发尾 ——
            let charDir, chatName, card, groupPlan = null;
            if (body.groupId !== undefined && body.groupId !== null && String(body.groupId).trim() !== '') {
                groupPlan = await resolveGroupGenerationPlan({ request, body });
                if (!groupPlan.speaker) {
                    // legacy:activatedMembers 空 = 只落用户楼、无成员生成。
                    // 服务端契约里用户楼已由调用方 append —— 回报空队列,不派发。
                    return response.send({
                        ok: true,
                        skipped: 'no_activated_member',
                        group: { groupId: groupPlan.groupId, chatId: groupPlan.chatId, queue: [] },
                    });
                }
                charDir = groupPlan.speaker.charDir;
                chatName = groupPlan.chatId;
                card = groupPlan.speaker.card;
            } else {
                charDir = safeName(body.charDir, 'charDir');
                chatName = safeName(body.chatName, 'chatName');
                card = await loadCharacterCard(directories, charDir);
            }
            const cardMs = performance.now() - cardStart;
            if (!card) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            // 群路动词 = 成员内 Generate 语义(legacy generateType 映射:
            // regen→normal;swipe/impersonate/quiet/continue 原样)
            const generateType = groupPlan ? groupPlan.generateType : String(body.type ?? 'normal');

            const { builtPrompt, presetDoc, oaiSettings, tgSettings, instructEngine, substCtx, powerUser, amountGen, bannedInMacros, trace, sources, perf, chatMetadata, chatIntegrity } = await buildGenerationContext({
                request,
                charDir,
                chatName,
                card,
                presetName: body.presetName,
                user: body.user ?? { name: request.user.profile.name },
                type: generateType,
                overrides: body.overrides ?? {},
                // text 派发时 main_api 同位量为 'textgenerationwebui'
                // (mesExamples 块头/instruct 样例走 instruct 形态,design TASK-037 §1.8)
                mainApi: String(body.api ?? 'chat') === 'text' ? 'textgenerationwebui' : 'openai',
                ...(groupPlan
                    ? {
                        group: {
                            id: groupPlan.groupId,
                            chatId: groupPlan.chatId,
                            doc: groupPlan.doc,
                            members: groupPlan.roster,
                            speakerAvatar: groupPlan.speaker.avatar,
                        },
                    }
                    : {}),
            });
            perf.cardMs = cardMs;
            perf.totalMs += cardMs;
            request.utopinnPerf = perf; // runner 挂 job.perf → trace 面回放
            logPerfLine('utopinn/generate', perf, { charDir, chatName });
            // WI timed effects 写回必须排在 dispatch 写楼层之前(effects 锚定的是
            // 生成前楼层计数);失败不阻断生成——下个周期自愈。
            try {
                await persistWorldInfoTimedEffects({
                    request, charDir, chatName, chatMetadata,
                    expectedIntegrity: chatIntegrity,
                    groupChatId: groupPlan?.chatId ?? null,
                });
                // TASK-034:落库后快照挂 job(GET /jobs/:id 回传),浏览器生成后
                // 回同步 chat_metadata.timedWorldInfo。只在 persist 成功后挂 ——
                // 失败时回灌会让浏览器拿得比服务端还"新";不挂,下个周期自愈语义不变。
                request.utopinnTimedWorldInfo = chatMetadata?.timedWorldInfo ?? null;
            } catch (persistErr) {
                console.warn('utopinn/generate timedWorldInfo persist skipped:', persistErr?.message);
            }

            // —— persist_target 兜底:单卡填 avatar/file_name;群填 kind:group +
            //    发言成员楼层字段(name/original_avatar/force_avatar/gen_id)——
            let persistTargetDefault;
            if (groupPlan) {
                persistTargetDefault = {
                    kind: 'group',
                    id: groupPlan.chatId,
                    char_name: groupPlan.speaker.name,
                    original_avatar: groupPlan.speaker.avatar,
                    force_avatar: memberAvatarThumbnailUrl(groupPlan.speaker.avatar),
                    gen_id: Date.now(),
                    chat_metadata: chatMetadata ?? {},
                };
                // 成员选择轨迹挂 job(sources)与响应头——客户端对账/回放用,
                // 无需再查群 doc 即知本次发言者与完整激活队列。
                sources.group = {
                    groupId: groupPlan.groupId,
                    chatId: groupPlan.chatId,
                    mode: Number(groupPlan.doc.generation_mode ?? 0),
                    strategy: Number(groupPlan.doc.activation_strategy ?? 0),
                    member: { avatar: groupPlan.speaker.avatar, name: groupPlan.speaker.name },
                    queue: groupPlan.activated,
                };
                response.setHeader('x-utopinn-group', JSON.stringify(sources.group));
            } else {
                persistTargetDefault = {
                    kind: 'character',
                    avatar_url: `${charDir}.png`,
                    file_name: `${chatName}.jsonl`,
                };
            }

            // ---- TASK-020 textgen 分叉:body.api==='text' → 单串 prompt + text-completions 派发 ----
            // 塑形语义对照前端 createTextGenGenerationData(textgen-settings.js:1664):
            // 停止串四层/dynatemp/rep_pen 系/per-type 袋/禁词与 logit_bias 编码
            // 全部由 textgen-body.js 同构实现;这里只解连接面(api_server/model/
            // api_type)+ 响应长度/上下文上限,再按「透传 → 塑形 → 显式覆盖 → 固定键」合并。
            if (String(body.api ?? 'chat') === 'text') {
                const apiType = body.api_type ?? tgSettings?.type;
                if (!apiType || !Object.values(TEXTGEN_TYPES).includes(apiType)) {
                    return response.status(400).send({
                        error: `api_type must be one of TEXTGEN_TYPES (got: ${apiType ?? 'none'})`,
                    });
                }
                // getTextGenServer 语义:六家托管源走常量端点(server_urls 对它们无效),
                // 其余读 server_urls;body.api_server 显式传入优先(代理/自建兼容层)
                const apiServer = body.api_server
                    ?? resolveTextgenServer(apiType, tgSettings)
                    ?? tgSettings?.server;
                if (!apiServer) {
                    return response.status(400).send({ error: 'api_server missing (body.api_server or settings.textgenerationwebui_settings.server_urls)' });
                }
                // getTextGenModel 语义:ollama 缺模型前端抛错 → 这里转 400;
                // body.model / overrides.model 显式覆盖(settings.json api_type_model 兜底)
                let model = body.model ?? body.overrides?.model ?? null;
                if (model === null) {
                    try {
                        model = resolveTextgenModel(apiType, tgSettings) ?? null;
                    } catch (modelErr) {
                        return response.status(400).send({ error: modelErr?.message ?? String(modelErr) });
                    }
                }
                const prompt = unescapeMacroBraces(messagesToTextgenPrompt(builtPrompt.messages, instructEngine, substCtx));
                const tgParams = Object.fromEntries(
                    Object.entries(tgSettings ?? {}).filter(([k]) => !TEXTGEN_CONN_KEYS.has(k) && !TEXTGEN_SETTINGS_ONLY_KEYS.has(k)),
                );
                // maxTokens=前端 amount_gen(settings.amount_gen 全局响应长度);
                // maxContext=前端 max_context(oai_settings.openai_max_context 活值,预设兜底)
                const maxTokens = body.overrides?.maxTokens ?? amountGen ?? tgSettings?.max_tokens ?? tgSettings?.genamt;
                const maxContext = oaiSettings?.openai_max_context ?? presetDoc?.openai_max_context;
                const shaped = await buildTextgenDispatchBody({
                    tgSettings,
                    apiType,
                    apiServer,
                    prompt,
                    model,
                    maxTokens,
                    maxContext,
                    powerUser,
                    substCtx,
                    instructEngine,
                    type: generateType,
                    bannedInMacros,
                });
                request.body = {
                    ...tgParams,
                    ...shaped,
                    ...(body.generation_overrides ?? {}),
                    api_type: apiType,
                    api_server: apiServer,
                    prompt,
                    // 前端:isStreamingEnabled() 时 data.stream=true,否则该键不上行
                    // (≠false);tgSettings.streaming 是开关源,body.stream 显式覆盖
                    stream: body.stream ?? tgSettings?.streaming ?? false,
                    luker_generation: {
                        ...(body.luker_generation ?? {}),
                        persist_target: body.luker_generation?.persist_target ?? persistTargetDefault,
                    },
                };
                request.utopinnTrace = trace;
                request.utopinnSources = sources;
                // TASK-034:textgen 派发体是单串 prompt,组装 messages 另挂快照 ——
                // runner 的 job.promptMessages 兜底源(chat 路在 body.messages 上)。
                request.utopinnPromptMessages = builtPrompt.messages;
                response.setHeader('x-utopinn-perf', JSON.stringify(perf));
                return runLukerDispatch(request, response, {
                    endpoint: 'utopinn-generate',
                    select: () => dispatchTextCompletions,
                });
            }

            // 派发体 = 连接层 oai_settings(custom_url/reverse_proxy/source 等)
            //  ← 预设生成参数覆盖(ST 选预设=重写 oai_settings)← 调用方显式字段
            const chatSource = body.chat_completion_source
                ?? oaiSettings?.chat_completion_source
                ?? presetDoc?.chat_completion_source ?? 'openai';
            const dispatchBody = {
                ...presetToDispatchParams(oaiSettings, { includeConnection: true }),
                ...presetToDispatchParams(presetDoc),
                chat_completion_source: chatSource,
                // verb 落 job.requestMeta——jobs/status、attach 写盘重建都靠它;
                // provider pickBy 自滤,不会发给上游。群路 = 成员内动词
                // (generateType),与 legacy 成员 Generate 语义同位。
                type: generateType,
                messages: builtPrompt.messages,
                stream: (generateType === 'quiet' ? false : body.stream)
                    ?? ((oaiSettings?.stream_openai ?? presetDoc?.stream_openai) !== false),
                // 客户端可传 job_id(回放对齐);persist_target 兜底按本次 char/chat 填
                luker_generation: {
                    ...(body.luker_generation ?? {}),
                    persist_target: body.luker_generation?.persist_target ?? persistTargetDefault,
                },
            };
            // 上游 getChatCompletionModel(source→{source}_model)+
            // openai_max_tokens→max_tokens:provider 只认 canonical 键;
            // generation_overrides 仍可显式盖掉。
            dispatchBody.model ??= dispatchBody[`${chatSource}_model`] ?? null;
            dispatchBody.max_tokens ??= dispatchBody.openai_max_tokens ?? null;
            if (body.generation_overrides) Object.assign(dispatchBody, body.generation_overrides);

            // 与 /generate 原版派发前处理同序(chat-completions.js:1161-1172)
            if (Array.isArray(dispatchBody.messages) && dispatchBody.custom_prompt_post_processing) {
                dispatchBody.messages = postProcessPrompt(
                    dispatchBody.messages,
                    dispatchBody.custom_prompt_post_processing,
                    getPromptNames(request));
            }
            if (dispatchBody.json_schema?.value) {
                dispatchBody.json_schema.value = flattenSchema(dispatchBody.json_schema.value, dispatchBody.chat_completion_source);
            }

            request.body = dispatchBody;
            request.utopinnTrace = trace; // 诊断面挂点(request inspector 可摘)
            request.utopinnSources = sources; // WI 激活轨迹等来源明细,runner 挂 job 供回放
            // /generate 响应体是 runner 立即 flush 的 {}(真实结果走 job 事件/WS),
            // perf 挂响应头——需在 runLukerDispatch 的 response.json() 之前 set。
            response.setHeader('x-utopinn-perf', JSON.stringify(perf));

            return runLukerDispatch(request, response, {
                endpoint: 'utopinn-generate',
                select: (b) => selectChatCompletionDispatch(b),
            });
        } catch (error) {
            diagEmit({
                lvl: 'error', kind: 'generate', code: 'generate_failed',
                msg: `generate failed: ${String(error?.message ?? error).slice(0, 280)}`,
                ctx: {
                    charDir: request.body?.charDir, chatId: request.body?.chatName,
                    groupId: request.body?.groupId, verb: request.body?.type,
                    diagId: request.utopinnDiagId, route: '/api/utopinn/generate',
                },
            });
            sendError(response, error, 'utopinn/generate');
        }
    });

    /** POST /preview —— 干跑组装,只回 messages+trace+sources+perf(prompt viewer 数据源) */
    reg('/api/utopinn/preview', async function (request, response) {
        try {
            const body = request.body ?? {};
            request.utopinnDiagId ??= randomUUID(); // 干跑无 job,认亲键独立
            const directories = request.user.directories;
            const cardStart = performance.now();

            // 与 /generate 同形的目标解析:groupId → 发言成员预览;否则单卡
            let charDir, chatName, card, groupPlan = null;
            if (body.groupId !== undefined && body.groupId !== null && String(body.groupId).trim() !== '') {
                groupPlan = await resolveGroupGenerationPlan({ request, body });
                charDir = groupPlan.speaker?.charDir ?? null;
                chatName = groupPlan.chatId;
                card = groupPlan.speaker?.card ?? null;
            } else {
                charDir = safeName(body.charDir, 'charDir');
                chatName = safeName(body.chatName, 'chatName');
                card = await loadCharacterCard(directories, charDir);
            }
            const cardMs = performance.now() - cardStart;
            if (!card) {
                if (groupPlan) {
                    // 预览同样回报空队列语义,不 404(群本身存在,只是没人可说)
                    return response.send({
                        messages: [], trace: null,
                        sources: { group: { groupId: groupPlan.groupId, chatId: groupPlan.chatId, queue: [] } },
                        perf: null, skipped: 'no_activated_member',
                    });
                }
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            const { builtPrompt, trace, sources, perf } = await buildGenerationContext({
                request,
                charDir,
                chatName,
                card,
                presetName: body.presetName,
                user: body.user ?? { name: request.user.profile.name },
                dryRun: true,
                type: groupPlan ? groupPlan.generateType : (body.type ?? 'normal'),
                overrides: body.overrides ?? {},
                ...(groupPlan
                    ? {
                        group: {
                            id: groupPlan.groupId,
                            chatId: groupPlan.chatId,
                            doc: groupPlan.doc,
                            members: groupPlan.roster,
                            speakerAvatar: groupPlan.speaker.avatar,
                        },
                    }
                    : {}),
            });
            perf.cardMs = cardMs;
            perf.totalMs += cardMs;
            if (groupPlan) {
                sources.group = {
                    groupId: groupPlan.groupId,
                    chatId: groupPlan.chatId,
                    mode: Number(groupPlan.doc.generation_mode ?? 0),
                    strategy: Number(groupPlan.doc.activation_strategy ?? 0),
                    member: { avatar: groupPlan.speaker.avatar, name: groupPlan.speaker.name },
                    queue: groupPlan.activated,
                };
            }
            logPerfLine('utopinn/preview', perf, { charDir, chatName });
            return response.send({ messages: builtPrompt.messages, trace, sources, perf });
        } catch (error) {
            sendError(response, error, 'utopinn/preview');
        }
    });
}
