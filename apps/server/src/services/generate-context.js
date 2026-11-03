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
    mergeLoreSources,
    substituteParams,
} from '@uberge/core';
import { createPromptBuilder } from './prompt-builder.js';
import {
    createDepthInjectionProvider,
    createWorldInfoRegexHook,
    normalizeExtensionPrompts,
    scannableExtensionPrompts,
    SCRIPT_INJECT_KEY_PREFIX,
} from './extension-prompts.js';
import { getChatRepo, getPresetRepo, getSettingsRepo, getWorldInfoRepo } from '../storage/index.js';

/** openai.js promptManager 的全局序 dummyId(openai.js:1319-1324) */
const OPENAI_ORDER_CHARACTER_ID = '100001';

/** extension_prompt_roles:number → string(openai.js getPromptRole 同款) */
const PROMPT_ROLES = ['system', 'user', 'assistant'];

/**
 * 解析预设 prompt_order:openai 路径固定用 global 策略(原版 configuration.promptOrder.strategy='global')。
 * @param {object} presetDoc oai_settings 预设文档
 * @returns {{identifier:string, enabled?:boolean}[]}
 */
export function resolvePromptOrder(presetDoc) {
    const lists = Array.isArray(presetDoc?.prompt_order) ? presetDoc.prompt_order : [];
    const entry = lists.find((l) => String(l.character_id) === OPENAI_ORDER_CHARACTER_ID)
        ?? lists.find((l) => String(l.character_id) === '100000') // 兼容 PM 默认 dummyId
        ?? lists[0];
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
        force_avatar: m.force_avatar,
        extra: m.extra,
    }));
}

/** settings.power_user → WIEngineSettings 相关字段(其余字段走 core 默认) */
export function powerUserToWISettings(powerUser = {}) {
    return { ...(powerUser.world_info_settings ?? {}) };
}

/**
 * 角色 charLore(settings.world_info.charLore,按 avatar 目录名匹配)→ 额外书名。
 * 原版:world-info.js getCharLore `world_info.charLore.find(e => e.name === fileName)`
 */
function getCharExtraBooks(worldInfoState, charDir) {
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
    for (const n of powerUser.selected_world_info ?? []) if (n) names.add(n);
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
 * @returns {Promise<{builtPrompt, request, trace, sources}>}
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
}) {
    const handle = request.user.profile.handle;
    const chatRepo = getChatRepo();
    const presetRepo = getPresetRepo();
    const settingsRepo = getSettingsRepo();
    const worldInfoRepo = getWorldInfoRepo();

    const [chatDoc, settingsDoc] = await Promise.all([
        chatRepo.get(handle, charDir, chatName),
        settingsRepo.get(handle),
    ]);
    if (!chatDoc) throw new Error(`Chat not found: ${charDir}/${chatName}`);

    const powerUser = settingsDoc?.power_user ?? {};
    const worldInfoState = settingsDoc?.world_info ?? {};
    const resolvedPresetName = presetName ?? settingsDoc?.preset_settings_openai ?? 'Default';
    const presetDoc = await presetRepo.get(handle, 'openai', resolvedPresetName);
    if (!presetDoc) throw new Error(`Preset not found: openai/${resolvedPresetName}`);

    const chatMessages = chatBodyToInput(chatDoc.body);
    const chatMetadata = chatDoc.header?.chat_metadata ?? {};

    // —— World Info:先取书名集 → 批量拉书 → mergeLoreSources 一次成型 ——
    const worldInfoSettings = powerUserToWISettings(powerUser);
    const chatBoundWorlds = Array.isArray(chatMetadata.world_info)
        ? chatMetadata.world_info
        : (chatMetadata.world_info ? [chatMetadata.world_info] : []);
    const loreInput = {
        selectedWorlds: powerUser.selected_world_info ?? [],
        characterPrimaryWorld: card?.data?.extensions?.world,
        characterExtraBooks: getCharExtraBooks(worldInfoState, charDir),
        chatWorlds: chatBoundWorlds,
        personaWorld: powerUser.persona_description_lorebook,
        insertionStrategy: worldInfoSettings.worldInfoInsertStrategy ?? 0,
    };
    const worldNames = collectWorldNames({ powerUser, card, chatMetadata, worldInfoState, charDir });
    const worldCache = new Map();
    await Promise.all(worldNames.map(async (name) => {
        const doc = await worldInfoRepo.get(handle, name).catch(() => null);
        worldCache.set(name, doc?.doc ?? doc ?? undefined);
    }));
    const entries = mergeLoreSources({
        ...loreInput,
        getWorldData: (name) => worldCache.get(name),
    });

    const substCtx = {
        name1: user?.name ?? 'User',
        name2: card?.data?.name ?? card?.name ?? 'Assistant',
        chat: chatMessages.map((m) => ({ mes: m.mes, name: m.name, is_user: m.is_user })),
        chatMetadata,
        globalVariables: settingsDoc?.extension_settings?.variables?.global ?? {},
        currentChatId: chatName,
        limits: { maxContext: presetDoc.openai_max_context, maxResponse: presetDoc.openai_max_tokens },
    };
    const subst = (content) => substituteParams(content, substCtx);

    // —— extension prompts:settings 顶层 extension_prompts + chat_metadata.script_injects
    //    重挂为 script_inject_* 键(processChatSlashCommands 语义,每次生成重建)——
    const mergedExtPrompts = { ...(settingsDoc?.extension_prompts ?? {}) };
    for (const [id, inject] of Object.entries(chatMetadata.script_injects ?? {})) {
        if (inject && typeof inject === 'object') {
            mergedExtPrompts[`${SCRIPT_INJECT_KEY_PREFIX}${id}`] = inject;
        }
    }
    const extPromptSource = { ...(settingsDoc ?? {}), extension_prompts: mergedExtPrompts };

    // WI 扫描:chat 必须新到旧序(engine 约定 index 0 = newest);
    // globalScanData 是卡/人设字段,进扫描缓冲(原版 scanState 同位)
    const globalScanData = {
        trigger: 'normal',
        personaDescription: user?.description ?? powerUser.persona_description ?? '',
        characterDescription: card?.data?.description ?? card?.description ?? '',
        characterPersonality: card?.data?.personality ?? card?.personality ?? '',
        characterDepthPrompt: card?.data?.extensions?.depth_prompt?.prompt ?? '',
        scenario: card?.data?.scenario ?? card?.scenario ?? '',
        creatorNotes: card?.data?.creator_notes ?? card?.creator_notes ?? '',
    };
    const wiActivated = entries.length
        ? await checkWorldInfo(
            chatMessages.map((m) => String(m.mes ?? '')).reverse(),
            presetDoc.openai_max_context ?? 8192,
            false,
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
                countTokens: (t) => Math.ceil(String(t).length / 4), // WI 内部计数:guesstimate 口径
            },
        )
        : { worldInfoBeforeEntries: [], worldInfoAfterEntries: [], WIDepthEntries: [], EMEntries: [] };

    const assemblyRequest = {
        card: {
            name: substCtx.name2,
            description: card?.data?.description ?? card?.description ?? '',
            personality: card?.data?.personality ?? card?.personality ?? '',
            scenario: card?.data?.scenario ?? card?.scenario ?? '',
            mesExample: card?.data?.mes_example ?? card?.mes_example ?? '',
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
    const builtPrompt = await builder(assemblyRequest, { substCtx });

    return {
        builtPrompt,
        request: assemblyRequest,
        presetDoc,
        oaiSettings: settingsDoc?.oai_settings ?? {},
        trace: builtPrompt.trace,
        sources: {
            presetName: resolvedPresetName,
            model: presetDoc.openai_model,
            worldInfoActivated: (wiActivated.worldInfoBeforeEntries?.length ?? 0)
                + (wiActivated.worldInfoAfterEntries?.length ?? 0)
                + (wiActivated.WIDepthEntries?.length ?? 0),
            chatCount: chatMessages.length,
        },
    };
}
