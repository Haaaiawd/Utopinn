/**
 * generate-context —— 把存储资源翻译成 PromptBuildRequest。
 * 对应前端 promptManager.getPromptCollection + checkWorldInfo + Generate() 参数组装
 * 整条客户端数据面,现在收敛到服务端。
 *
 * 数据流:
 *   chatRepo/presetRepo/settingsRepo/worldInfoRepo
 *   → chat + card + preset + settings + lorebooks
 *   → mergeLoreSources → checkWorldInfo(core WI 引擎)
 *   → PromptBuildRequest → promptBuilder
 */
import {
    checkWorldInfo,
    createInstructEngine,
    GENERATION_TYPE_TRIGGERS,
    mergeLoreSources,
    substituteParams,
} from '@uberge/core';
import { createPromptBuilder, resolveTokenizer } from './prompt-builder.js';
import {
    createDepthInjectionProvider,
    createWorldInfoRegexHook,
    CUSTOM_WI_OUTLET_PREFIX,
    DEPTH_PROMPT_KEY,
    normalizeExtensionPrompts,
    NOTE_MODULE_NAME,
    PERSONA_DESCRIPTION_KEY,
    resolveAuthorsNote,
    roleByName,
    scannableExtensionPrompts,
    SCRIPT_INJECT_KEY_PREFIX,
    extension_prompt_types,
} from './extension-prompts.js';
import { getChatRepo, getPresetRepo, getSettingsRepo, getWorldInfoRepo } from '../storage/index.js';
import { performance } from 'node:perf_hooks';

/** 毫秒保留 1 位小数(打表口径) */
const ms = (v) => Math.round(v * 10) / 10;

/**
 * [perf] 摘要行。约定:调用方把 endpoint 侧 cardMs 并入 perf.cardMs
 * 与 perf.totalMs 后再打,totalMs = 含卡加载的整段耗时。
 * @param {string} label 端点名(uberge/preview、uberge/generate)
 * @param {object} perf buildGenerationContext 返回的 perf(调用方已补 cardMs)
 * @param {{charDir?:string, chatName?:string}} id
 */
export function logPerfLine(label, perf, { charDir = '?', chatName = '?' } = {}) {
    console.info(
        `[perf] ${label} char=${charDir} chat=${chatName}`
        + ` card=${ms(perf.cardMs ?? 0)}ms load=${ms(perf.loadMs)}ms preset=${ms(perf.presetMs)}ms`
        + ` wi=${ms(perf.wiMs)}ms assemble=${ms(perf.assembleMs)}ms`
        + `(collect=${ms(perf.collectionMs)} populate=${ms(perf.populateMs)} token=${ms(perf.tokenMs)})`
        + ` total=${ms(perf.totalMs)}ms`,
    );
}

/** openai.js promptManager 的全局序 dummyId(openai.js:1319-1324) */
const OPENAI_ORDER_CHARACTER_ID = '100001';

/** extension_prompt_roles:number → string(openai.js getPromptRole 同款) */
const PROMPT_ROLES = ['system', 'user', 'assistant'];

/**
 * 解析预设 prompt_order:openai 路径固定用 global 策略(原版 configuration.promptOrder.strategy='global',
 * getPromptList 按 character_id===100001 找)。audit M4 修正:不可回退 lists[0] ——
 * 预设缺 global 序时那是某角色的自定义序,错当全局序会错序;上游此处返回 [],
 * 由 PromptManager 走默认序。
 * @param {object} presetDoc oai_settings 预设文档
 * @returns {{identifier:string, enabled?:boolean}[]}
 */
export function resolvePromptOrder(presetDoc) {
    const lists = Array.isArray(presetDoc?.prompt_order) ? presetDoc.prompt_order : [];
    const entry = lists.find((l) => String(l.character_id) === OPENAI_ORDER_CHARACTER_ID)
        ?? lists.find((l) => String(l.character_id) === '100000'); // 兼容 PM 默认 dummyId
    return Array.isArray(entry?.order) ? entry.order : [];
}

/** preset → PromptBuildRequest.settings 字段映射(oai_settings 子集) */
export function presetToAssemblySettings(presetDoc, powerUser = {}) {
    const d = presetDoc ?? {};
    return {
        wi_format: d.wi_format,
        scenario_format: d.scenario_format,
        personality_format: d.personality_format,
        group_nudge_prompt: d.group_nudge_prompt,
        impersonation_prompt: d.impersonation_prompt,
        new_chat_prompt: d.new_chat_prompt,
        new_group_chat_prompt: d.new_group_chat_prompt,
        new_example_chat_prompt: d.new_example_chat_prompt,
        continue_nudge_prompt: d.continue_nudge_prompt,
        continue_prefill: d.continue_prefill,
        assistant_prefill: d.assistant_prefill,
        send_if_empty: d.send_if_empty,
        names_behavior: d.names_behavior,
        squash_system_messages: d.squash_system_messages,
        pin_examples: powerUser.pin_examples ?? d.pin_examples,
    };
}

/** 聊天 JSONL body → ChatMessageInput[](core setOpenAIMessages 入参) */
export function chatBodyToInput(messages) {
    return (Array.isArray(messages) ? messages : []).map((m) => ({
        is_user: m.is_user,
        is_system: m.is_system,
        name: m.name,
        mes: m.mes,
        send_date: m.send_date,
        swipe_id: m.swipe_id,
        swipes: m.swipes,
        force_avatar: m.force_avatar,
        extra: m.extra,
    }));
}

/** settings.world_info_settings → { engine: WIEngineSettings(camel), state: {globalSelect,charLore}, raw }。
 * 上游口径:WI 设置全部在顶层 settings.world_info_settings(snake_case;
 * script.js setWorldInfoSettings 读的就是它),其中 .world_info 子对象
 * 装书目状态(globalSelect 全局勾选、charLore 角色辅书表)。
 * power_user 里没有这些键——此前读 powerUser.world_info_settings /
 * power_user.selected_world_info 属路径写错,全部静默失效(audit H1/H2)。 */
const WI_SNAKE_TO_CAMEL = {
    world_info_depth: 'worldInfoDepth',
    world_info_budget: 'worldInfoBudget',
    world_info_budget_cap: 'worldInfoBudgetCap',
    world_info_case_sensitive: 'worldInfoCaseSensitive',
    world_info_match_whole_words: 'worldInfoMatchWholeWords',
    world_info_use_group_scoring: 'worldInfoUseGroupScoring',
    world_info_recursive: 'worldInfoRecursive',
    world_info_overflow_alert: 'worldInfoOverflowAlert',
    world_info_min_activations: 'worldInfoMinActivations',
    world_info_min_activations_depth_max: 'worldInfoMinActivationsDepthMax',
    world_info_max_recursion_steps: 'worldInfoMaxRecursionSteps',
};

export function resolveWorldInfoSettings(settingsDoc = {}) {
    const wis = settingsDoc?.world_info_settings ?? {};
    const engine = {};
    for (const [snake, camel] of Object.entries(WI_SNAKE_TO_CAMEL)) {
        if (wis[snake] !== undefined) engine[camel] = wis[snake];
    }
    return { engine, state: wis.world_info ?? {}, raw: wis };
}

/**
 * 角色 charLore(settings.world_info.charLore,按 avatar 目录名匹配)→ 额外书名。
 * 原版:world-info.js getCharLore `world_info.charLore.find(e => e.name === fileName)`
 * export:mvu-settle resolveMvuInitLorebooks 复用同一口径(init 书目含辅书)。
 */
export function getCharExtraBooks(worldInfoState, charDir) {
    const lore = (worldInfoState?.charLore ?? []).find((l) => l.name === charDir);
    return Array.isArray(lore?.extraBooks) ? lore.extraBooks : [];
}

/**
 * 收集本次要取的 lorebook 名(与 mergeLoreSources 源列表同序)。
 * chat_metadata.world_info 在原版是单字符串(METADATA_KEY),兼容数组形态。
 */
function collectWorldNames({ powerUser, card, chatMetadata, worldInfoState, charDir }) {
    const names = new Set();
    const chatBound = Array.isArray(chatMetadata.world_info)
        ? chatMetadata.world_info : (chatMetadata.world_info ? [chatMetadata.world_info] : []);
    for (const n of chatBound) if (n) names.add(n);
    if (powerUser.persona_description_lorebook) names.add(powerUser.persona_description_lorebook);
    if (card?.data?.extensions?.world) names.add(card.data.extensions.world);
    for (const b of getCharExtraBooks(worldInfoState, charDir)) if (b) names.add(b);
    // 上游:world_info_settings.world_info.globalSelect = 全局勾选书目
    for (const n of worldInfoState.globalSelect ?? []) if (n) names.add(n);
    return [...names];
}

/**
 * 组装完整 PromptBuildRequest 并执行 promptBuilder。
 * @param {object} input
 * @param {object} input.request Express request(取 user.profile.handle)
 * @param {string} input.charDir 角色目录(avatar 目录名)
 * @param {string} input.chatName 聊天名(不带 .jsonl)
 * @param {object} input.card 角色卡数据(data.* 字段)
 * @param {string} [input.presetName] 预设名(默认 settings 里记录的当前预设)
 * @param {object} input.user 用户面 {name, description}
 * @param {string} [input.type] 生成类型
 * @param {object} [input.overrides] 直接覆盖请求字段(cyclePrompt/quietPrompt/extensionPrompts 等)
 * @param {boolean} [input.dryRun] preview/干跑:true → WI 不写 timed effects、返回值不含持久化义务
 * @returns {Promise<{builtPrompt, request, trace, sources, perf, chatMetadata, chatIntegrity}>}
 *   perf:cardMs(调用方补)/loadMs/presetMs/wiMs/assembleMs/collectionMs/populateMs/tokenMs/totalMs;
 *   chatMetadata/chatIntegrity 供调用方持久化 timedWorldInfo(仅非 dryRun)。
 */
export async function buildGenerationContext({
    request,
    charDir,
    chatName,
    card,
    presetName,
    user,
    type = 'normal',
    overrides = {},
    dryRun = false,
}) {
    // —— perf 打表(server 包裹层,core 签名不动)——
    // cardMs 由调用方补(loadCharacterCard 在 endpoint);totalMs 为 buildGenerationContext 总耗。
    const perf = {
        cardMs: 0, loadMs: 0, presetMs: 0, wiMs: 0,
        assembleMs: 0, collectionMs: 0, populateMs: 0, tokenMs: 0, totalMs: 0,
    };
    const t0 = performance.now();
    let seg = t0;

    const handle = request.user.profile.handle;
    const chatRepo = getChatRepo();
    const presetRepo = getPresetRepo();
    const settingsRepo = getSettingsRepo();
    const worldInfoRepo = getWorldInfoRepo();

    const [chatDoc, settingsDoc] = await Promise.all([
        chatRepo.get(handle, charDir, chatName),
        settingsRepo.get(handle),
    ]);
    perf.loadMs += performance.now() - seg;
    if (!chatDoc) throw new Error(`Chat not found: ${charDir}/${chatName}`);

    const powerUser = settingsDoc?.power_user ?? {};
    const { engine: worldInfoSettings, state: worldInfoState, raw: wiRaw } = resolveWorldInfoSettings(settingsDoc);
    const resolvedPresetName = presetName ?? settingsDoc?.preset_settings_openai ?? 'Default';
    seg = performance.now();
    const presetDoc = await presetRepo.get(handle, 'openai', resolvedPresetName);
    perf.presetMs += performance.now() - seg;
    if (!presetDoc) throw new Error(`Preset not found: openai/${resolvedPresetName}`);

    const chatMessages = chatBodyToInput(chatDoc.body);
    const chatMetadata = chatDoc.header?.chat_metadata ?? {};

    // —— World Info:先取书名集 → 批量拉书 → mergeLoreSources 一次成型 ——
    const chatBoundWorlds = Array.isArray(chatMetadata.world_info)
        ? chatMetadata.world_info
        : (chatMetadata.world_info ? [chatMetadata.world_info] : []);
    const loreInput = {
        selectedWorlds: worldInfoState.globalSelect ?? [],
        characterPrimaryWorld: card?.data?.extensions?.world,
        characterExtraBooks: getCharExtraBooks(worldInfoState, charDir),
        chatWorlds: chatBoundWorlds,
        personaWorld: powerUser.persona_description_lorebook,
        // 上游 world_info_character_strategy 默认 character_first(1)
        insertionStrategy: wiRaw.world_info_character_strategy ?? 1,
    };
    const worldNames = collectWorldNames({ powerUser, card, chatMetadata, worldInfoState, charDir });
    seg = performance.now();
    const worldCache = new Map();
    await Promise.all(worldNames.map(async (name) => {
        const doc = await worldInfoRepo.get(handle, name).catch(() => null);
        worldCache.set(name, doc?.doc ?? doc ?? undefined);
    }));
    const entries = mergeLoreSources({
        ...loreInput,
        getWorldData: (name) => worldCache.get(name),
    });
    perf.wiMs += performance.now() - seg;

    const substCtx = {
        name1: user?.name ?? 'User',
        name2: card?.data?.name ?? card?.name ?? 'Assistant',
        // 宏消费面(上游 evaluateMacros 的 chat 形):is_system 丢 → {{lastCharMessage}}
        // 会误算系统楼层;send_date 丢 → {{idle_duration}} 恒 "just now";
        // swipe_id 丢 → swipeId 宏恒 ''。
        chat: chatMessages.map((m) => ({
            mes: m.mes,
            name: m.name,
            is_user: m.is_user,
            is_system: m.is_system,
            send_date: m.send_date,
            swipe_id: m.swipe_id,
            swipes: m.swipes,
        })),
        chatMetadata,
        globalVariables: settingsDoc?.extension_settings?.variables?.global ?? {},
        currentChatId: chatName,
        limits: { maxContext: presetDoc.openai_max_context, maxResponse: presetDoc.openai_max_tokens },
    };

    // instruct seam:引擎绑定 formatInstructExamples 填 substCtx。
    // mainApi==='openai' 时 {{mesExamples}} 不走 instruct 形态(同原版
    // script.js:5890 语义),但 seam 就位后 textgen 路径(TASK-020)直接用。
    const powerUserInstruct = powerUser?.instruct ?? {};
    seg = performance.now();
    const [instructPresetDocs, contextPresetDocs] = await Promise.all([
        presetRepo.listWithDocs(handle, 'instruct').catch(() => []),
        presetRepo.listWithDocs(handle, 'context').catch(() => []),
    ]);
    perf.presetMs += performance.now() - seg;
    const instructEngine = createInstructEngine({
        ...substCtx,
        instruct: powerUserInstruct,
        contextTemplate: powerUser?.context,
        instructPresets: instructPresetDocs.map((d) => ({ name: d?.name, ...(d?.doc ?? {}) })),
        contextPresets: contextPresetDocs.map((d) => ({ name: d?.name })),
        modelTemplatesMappings: powerUser?.model_templates_mappings,
        warn: (m) => console.warn(m),
    });
    substCtx.instruct = powerUserInstruct;
    substCtx.mainApi = 'openai';
    substCtx.formatInstructExamples = instructEngine.formatInstructExamples;
    const subst = (content) => substituteParams(content, substCtx);

    // —— extension prompts:settings 顶层 extension_prompts + chat_metadata.script_injects
    //    重挂为 script_inject_* 键(processChatSlashCommands 语义,每次生成重建)——
    const mergedExtPrompts = { ...(settingsDoc?.extension_prompts ?? {}) };
    for (const [id, inject] of Object.entries(chatMetadata.script_injects ?? {})) {
        if (inject && typeof inject === 'object') {
            mergedExtPrompts[`${SCRIPT_INJECT_KEY_PREFIX}${id}`] = inject;
        }
    }

    // —— Author's Note + 卡 depth_prompt + persona 通道(上游在 WI 扫描前置位,
    //    scan=allowWIScan 的条目参与本轮扫描;AN 合并/persona-AN 合并/outlet 在扫描后)——
    const noteSettings = settingsDoc?.extension_settings?.note ?? {};
    const anState = resolveAuthorsNote({
        chatMetadata,
        userMessageCount: chatMessages.filter((m) => m.is_user).length,
        noteSettings,
        charDir,
    });
    mergedExtPrompts[NOTE_MODULE_NAME] = anState.entry;
    const depthPromptExt = card?.data?.extensions?.depth_prompt ?? {};
    mergedExtPrompts[DEPTH_PROMPT_KEY] = {
        value: String(depthPromptExt.prompt ?? ''),
        position: extension_prompt_types.IN_CHAT,
        depth: Number(depthPromptExt.depth ?? 4),
        scan: !!noteSettings.allowWIScan,
        role: roleByName(depthPromptExt.role ?? 'system'),
    };
    mergedExtPrompts[PERSONA_DESCRIPTION_KEY] = {
        value: '',
        position: extension_prompt_types.IN_PROMPT,
        depth: 0,
    };

    const extPromptSource = { ...(settingsDoc ?? {}), extension_prompts: mergedExtPrompts };

    // WI 扫描:chat 必须新到旧序(engine 约定 index 0 = newest);
    // globalScanData 是卡/人设字段,进扫描缓冲(原版 scanState 同位)
    const globalScanData = {
        trigger: GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
        personaDescription: user?.description ?? powerUser.persona_description ?? '',
        characterDescription: card?.data?.description ?? card?.description ?? '',
        characterPersonality: card?.data?.personality ?? card?.personality ?? '',
        characterDepthPrompt: card?.data?.extensions?.depth_prompt?.prompt ?? '',
        scenario: card?.data?.scenario ?? card?.scenario ?? '',
        creatorNotes: card?.data?.creator_notes ?? card?.creator_notes ?? '',
    };
    seg = performance.now();
    // 上游 world_info_include_names(默认 true):扫描行带 `name: ` 前缀
    const wiScanLines = (wiRaw.world_info_include_names !== false
        ? chatMessages.map((m) => `${m.name}: ${String(m.mes ?? '')}`)
        : chatMessages.map((m) => String(m.mes ?? ''))
    ).reverse();
    const wiActivated = entries.length
        ? await checkWorldInfo(
            wiScanLines,
            presetDoc.openai_max_context ?? 8192,
            dryRun,
            globalScanData,
            {
                settings: worldInfoSettings,
                sortedEntries: entries,
                chatMetadata,
                substituteParams: subst,
                // extension prompts 三面:scan 注入缓冲 + WI 内容正则钩子
                scannableExtensionPrompts: scannableExtensionPrompts(extPromptSource, subst),
                applyWorldInfoRegex: createWorldInfoRegexHook(extPromptSource, substCtx, {
                    card, charDir, presetDoc, presetName: resolvedPresetName,
                }),
                // WI 预算与 prompt 同 tokenizer(上游 Tokenizers.openai);
                // len/4 会把 CJK 世界书高估 2-4 倍,预算提前溢出丢条目。
                countTokens: (t) => resolveTokenizer(presetDoc.openai_model).encode(String(t)).length,
            },
        )
        : { worldInfoBeforeEntries: [], worldInfoAfterEntries: [], WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {} };
    perf.wiMs += performance.now() - seg;

    // —— WI 后注入通道(上游 script.js:4666-4684 同序)——
    // 1) ANTop/ANBottom 合并进 AN(上游 checkWorldInfo 内段,shouldWIAddPrompt 门控)
    if (anState.shouldAdd && mergedExtPrompts[NOTE_MODULE_NAME]) {
        const anTop = (wiActivated.ANBeforeEntries ?? []).join('\n');
        const anBottom = (wiActivated.ANAfterEntries ?? []).join('\n');
        if (anTop || anBottom) {
            mergedExtPrompts[NOTE_MODULE_NAME] = {
                ...mergedExtPrompts[NOTE_MODULE_NAME],
                value: `${anTop}\n${mergedExtPrompts[NOTE_MODULE_NAME].value}\n${anBottom}`.replace(/(^\n)|(\n$)/g, ''),
            };
        }
    }
    // 2) persona 描述:TOP_AN(2)/BOTTOM_AN(3) 合进 AN(shouldAdd 门控);
    //    AT_DEPTH(4) 走独立 IN_CHAT 注入;其余位由 prompt 组装通道负责
    const personaDescRaw = user?.description ?? powerUser.persona_description ?? '';
    const personaPos = Number(powerUser.persona_description_position ?? 0);
    if (personaDescRaw) {
        if ((personaPos === 2 || personaPos === 3) && anState.shouldAdd && mergedExtPrompts[NOTE_MODULE_NAME]) {
            const base = mergedExtPrompts[NOTE_MODULE_NAME].value;
            mergedExtPrompts[NOTE_MODULE_NAME] = {
                ...mergedExtPrompts[NOTE_MODULE_NAME],
                value: personaPos === 2 ? `${personaDescRaw}\n${base}` : `${base}\n${personaDescRaw}`,
            };
        } else if (personaPos === 4) {
            mergedExtPrompts[PERSONA_DESCRIPTION_KEY] = {
                value: String(personaDescRaw),
                position: extension_prompt_types.IN_CHAT,
                depth: Number(powerUser.persona_description_depth ?? 4),
                scan: true,
                role: Number(powerUser.persona_description_role ?? 0),
            };
        }
    }
    // 3) outlet 产物挂回命名 extension_prompts(NONE 位,不进注入,按名取用)
    for (const [key, arr] of Object.entries(wiActivated.outletEntries ?? {})) {
        if (Array.isArray(arr) && arr.length) {
            mergedExtPrompts[`${CUSTOM_WI_OUTLET_PREFIX}${key}`] = {
                value: arr.join('\n'),
                position: extension_prompt_types.NONE,
                depth: 0,
            };
        }
    }
    // 4) EM(示例消息位):before 前置、after 尾置进 mesExample(<START> 块,
    //    上游 parseMesExamples 后 unshift/push 等价)
    const emBefore = (wiActivated.EMEntries ?? []).filter((e) => e?.position === 0).map((e) => e.content);
    const emAfter = (wiActivated.EMEntries ?? []).filter((e) => e?.position === 1).map((e) => e.content);
    const cardMesExample = card?.data?.mes_example ?? card?.mes_example ?? '';
    const mergedMesExample = [...emBefore, cardMesExample, ...emAfter].filter(Boolean).join('\n<START>\n');

    const assemblyRequest = {
        card: {
            name: substCtx.name2,
            description: card?.data?.description ?? card?.description ?? '',
            personality: card?.data?.personality ?? card?.personality ?? '',
            scenario: card?.data?.scenario ?? card?.scenario ?? '',
            mesExample: mergedMesExample,
            systemPromptOverride: card?.data?.system_prompt ?? card?.system_prompt,
            jailbreakOverride: card?.data?.post_history_instructions ?? card?.post_history_instructions,
        },
        user: { name: substCtx.name1, description: user?.description ?? powerUser.persona_description ?? '' },
        chat: chatMessages,
        prompts: Array.isArray(presetDoc.prompts) ? presetDoc.prompts : [],
        promptOrder: resolvePromptOrder(presetDoc),
        settings: presetToAssemblySettings(presetDoc, powerUser),
        contextTokens: presetDoc.openai_max_context ?? 8192,
        responseTokens: presetDoc.openai_max_tokens ?? 300,
        worldInfo: {
            beforeEntries: wiActivated.worldInfoBeforeEntries,
            afterEntries: wiActivated.worldInfoAfterEntries,
            depthEntries: (wiActivated.WIDepthEntries ?? []).map((e) => ({
                identifier: `WIDepth-${e.depth}`,
                role: PROMPT_ROLES[e.role] ?? 'system',
                content: e.entries.join('\n'),
                injection_position: 1,
                injection_depth: e.depth,
                extension: true,
            })),
            format: presetDoc.wi_format,
        },
        extensionPrompts: overrides.extensionPrompts ?? normalizeExtensionPrompts(extPromptSource),
        type,
        api: 'openai',
        model: presetDoc.openai_model,
        ...overrides,
    };

    const builder = createPromptBuilder({
        model: presetDoc.openai_model,
        depthInjection: createDepthInjectionProvider(extPromptSource, subst),
    });
    seg = performance.now();
    const builtPrompt = await builder(assemblyRequest, { substCtx });
    perf.assembleMs = performance.now() - seg;
    // collection/populate/token 分段由 prompt-builder 的 builtPrompt.perf 提供;
    // 缺省(非服务端 builder)时全记 collection、token 记 0。
    perf.collectionMs = builtPrompt.perf?.collectionMs ?? perf.assembleMs;
    perf.populateMs = builtPrompt.perf?.populateMs ?? 0;
    perf.tokenMs = builtPrompt.perf?.tokenMs ?? 0;
    perf.totalMs = performance.now() - t0;

    return {
        builtPrompt,
        perf,
        request: assemblyRequest,
        presetDoc,
        oaiSettings: settingsDoc?.oai_settings ?? {},
        tgSettings: settingsDoc?.textgenerationwebui_settings ?? {},
        instructEngine,
        substCtx,
        trace: builtPrompt.trace,
        sources: {
            presetName: resolvedPresetName,
            model: presetDoc.openai_model,
            worldInfoActivated: (wiActivated.worldInfoBeforeEntries?.length ?? 0)
                + (wiActivated.worldInfoAfterEntries?.length ?? 0)
                + (wiActivated.WIDepthEntries?.length ?? 0),
            // WI 激活轨迹(TASK-017 回放数据源):触发成功的条目级明细,
            // uid/world/key/comment/position/depth 足够客户端重建「哪本书
            // 哪条、被什么键命中、注入在哪个位置」。allActivatedEntries
            // 是 Set<WIEntry>,排序靠 world+uid 稳定化。
            worldInfo: {
                activated: Array.from(wiActivated.allActivatedEntries ?? [])
                    .map((e) => ({
                        uid: e.uid,
                        world: e.world,
                        comment: e.comment,
                        key: e.key,
                        position: e.position,
                        depth: e.depth,
                        outlet: e.outletName,
                    }))
                    .sort((a, b) => String(a.world ?? '').localeCompare(String(b.world ?? '')) || a.uid - b.uid),
            },
            chatCount: chatMessages.length,
        },
        // 持久化义务包:非 dryRun 时调用方把 chatMetadata.timedWorldInfo 写回
        // (WI 引擎原地改 meta;persistence is caller's job — engine.ts 注释契约)
        chatMetadata,
        chatIntegrity: chatDoc.integrity ?? null,
    };
}

/**
 * WI timed effects(sticky/cooldown/delay)写回 chat_metadata。
 * CAS 一次;integrity 冲突 = 生成期间会话被并发推进 → 重读最新再写
 * (与上游 saveChatConditional last-write-wins 等价);二次失败=NotFound 等,
 * 交由下个生成周期自愈。fire-and-forget 不可——dispatch 写楼层必须排在它后面。
 */
export async function persistWorldInfoTimedEffects({ request, charDir, chatName, chatMetadata, expectedIntegrity }) {
    const timedWorldInfo = chatMetadata?.timedWorldInfo;
    if (!timedWorldInfo || typeof timedWorldInfo !== 'object') return null;
    const handle = request.user.profile.handle;
    const chatRepo = getChatRepo();
    try {
        return await chatRepo.updateChatMetadata(handle, charDir, chatName, { timedWorldInfo }, expectedIntegrity);
    } catch (error) {
        if (error?.code !== 'integrity_mismatch') throw error;
        const fresh = await chatRepo.get(handle, charDir, chatName);
        if (!fresh) return null;
        return chatRepo.updateChatMetadata(handle, charDir, chatName, { timedWorldInfo }, fresh.integrity);
    }
}
