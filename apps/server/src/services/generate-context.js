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
    addMissingWorldInfoFields,
    checkWorldInfo,
    createInstructEngine,
    GENERATION_TYPE_TRIGGERS,
    getStringHash,
    mergeLoreSources,
    parseDecorators,
    substituteParams,
} from '@utopinn/core';
import { convertEmbeddedBook, primaryWorldName } from './embedded-world.js';
import { createPromptBuilder, resolveTokenizer } from './prompt-builder.js';
import { buildGroupCardFields, collectGroupDepthPrompts } from './group-orchestration.js';
import {
    applyChatFloorsPromptRegex,
    createDepthInjectionProvider,
    createFloorRegexRunner,
    createWorldInfoRegexHook,
    CUSTOM_WI_OUTLET_PREFIX,
    DEPTH_PROMPT_KEY,
    normalizeExtensionPrompts,
    NOTE_MODULE_NAME,
    PERSONA_DESCRIPTION_KEY,
    resolveAuthorsNote,
    resolvePresetInUse,
    roleByName,
    scannableExtensionPrompts,
    SCRIPT_INJECT_KEY_PREFIX,
    extension_prompt_types,
} from './extension-prompts.js';
import { getChatRepo, getPresetRepo, getSettingsRepo, getWorldInfoRepo } from '../storage/index.js';
import {
    hiddenFloorIndexSet,
    IZUMI_INDEX_MARKER,
    IZUMI_INJECT_DEPTH,
    IZUMI_KONATA_KEY,
    IZUMI_NS,
    renderIzumiCatalog,
    renderKonataExtraInformation,
} from './izumi.js';
import {
    readCharacterStateSidecar,
    resolveCharacterFilePath,
    writeCharacterStateSidecar,
} from './character-state.js';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import _ from 'lodash';
import { emit as diagEmit } from './diag-bus.js';

/** 毫秒保留 1 位小数(打表口径) */
const ms = (v) => Math.round(v * 10) / 10;

/** chat_state 命名空间:panel-t0 th.injectPrompts 的持久化位(与 packages/api-client NS_INJECT 同键) */
const TH_INJECT_NS = 'th.inject';
/**
 * char 域变量宏的持久落点:char_state 侧车 ns。
 * 侧车文档 = `{variables:{...}}`(稀疏 overlay:只记宏写过的路径;
 * 读侧与卡面 tavern_helper.variables 种子深合并,数组/标量整体覆盖)。
 */
const TH_CHAR_STATE_NS = 'tavern_helper';
/** mergedExtPrompts 注入键前缀(与 script_inject_* 并列,免撞名) */
const TH_INJECT_KEY_PREFIX = 'th_inject_';
/** chat_state 命名空间:IzumiEdit 信息库(services/izumi.js 写侧落点)。 */
const IZUMI_STATE_NS = IZUMI_NS;

/**
 * [perf] 摘要行。约定:调用方把 endpoint 侧 cardMs 并入 perf.cardMs
 * 与 perf.totalMs 后再打,totalMs = 含卡加载的整段耗时。
 * @param {string} label 端点名(utopinn/preview、utopinn/generate)
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

/**
 * B6(TASK-051)口径:内置 openai/Default 预设的上下文预算。
 * - LEGACY_DEFAULT_OPENAI_MAX_CONTEXT = 上游 gpt-3.5 时代库存值 max_4k;
 *   存量 dataRoot 里未调过的 Default 仍是它,大卡 must-fit 必炸。
 * - DEFAULT_OPENAI_MAX_CONTEXT = 新默认(上游 max_128k,未知模型档的
 *   现代兜底位)。seed 与抬升共用同一数,单点改。
 */
const LEGACY_DEFAULT_OPENAI_MAX_CONTEXT = 4095;
const DEFAULT_OPENAI_MAX_CONTEXT = 128000;

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

/**
 * 数组替换式深合并(同 settle.ts correctlyMerge 语义):overlay 的标量/数组
 * 整体覆盖 base,plain object 递归并入。产出新对象,不写输入 —— 卡面种子
 * 与侧车文档本体都不被请求内宏写污染。
 */
function mergeVariableOverlay(base, overlay) {
    if (overlay === undefined) return base;
    if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay;
    const out = (base !== null && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
    for (const [key, value] of Object.entries(overlay)) {
        out[key] = mergeVariableOverlay(out[key], value);
    }
    return out;
}

/**
 * TH 'character'/'char' 域变量底座 = 卡面种子 ∪ char_state 侧车 overlay(GH#2):
 *   种子   card.data.extensions.tavern_helper.variables(TH setting_field=
 *          'tavern_helper';旧键 TavernHelper_characterScriptVariables 兜底)。
 *   overlay <charFile>.state.tavern_helper.json 的 {variables} —— 服务端
 *          set_char_variable 的持久落点(卡 PNG 不在生成路径重写,侧车是
 *          /api/utopinn/state/char/* 与 CardApp char-state 的同一份读写面)。
 * 卡文件不可解析(directories 缺位或 .png/.webp/.json 全不在)→ 纯种子,
 * 写面在 persist 段如实 volatile。
 */
function resolveCharVariableBase(request, charDir, card) {
    const seed = card?.data?.extensions?.tavern_helper?.variables
        ?? card?.data?.extensions?.TavernHelper_characterScriptVariables
        ?? card?.extensions?.tavern_helper?.variables;
    const seedObj = (seed !== null && typeof seed === 'object' && !Array.isArray(seed)) ? seed : {};
    const filePath = resolveCharacterFilePath(request?.user?.directories?.characters, charDir);
    if (!filePath) return seedObj;
    const overlay = readCharacterStateSidecar(filePath, TH_CHAR_STATE_NS)?.variables;
    if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) return seedObj;
    return mergeVariableOverlay(seedObj, overlay);
}

/** 聊天 JSONL body → ChatMessageInput[](core setOpenAIMessages 入参)。
 * 上游 script.js:7999 过滤:!is_system || 携 tool_invocations 的系统层
 * (工具执行回执)保留;is_system 隐藏层不进 prompt。 */
export function chatBodyToInput(messages) {
    return (Array.isArray(messages) ? messages : [])
        .filter((m) => !m.is_system || m.tool_invocations)
        .map((m) => ({
        is_user: m.is_user,
        is_system: m.is_system,
        name: m.name,
        mes: m.mes,
        send_date: m.send_date,
        swipe_id: m.swipe_id,
        swipes: m.swipes,
        force_avatar: m.force_avatar,
        extra: m.extra,
        // TH/MVU 楼层变量袋透传(引用共享,不拷)——message 域变量宏
        // ({{get/format/set_message_variable}})的楼层快照读源;宏 set 写回
        // 经 variables 活引用同步本请求内读,持久化仍走 variables 写回钉。
        variables: m.variables,
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
    // 生效主书名:显式绑定优先,缺绑带内嵌书时落到派生名(与 import
    // 物化/绑定同名;无书无绑 → null 不加)。issue #10 后存量未物化卡
    // 也走这条路,装配不再漏整本内嵌书。
    const primary = primaryWorldName(card);
    if (primary) names.add(primary);
    for (const b of getCharExtraBooks(worldInfoState, charDir)) if (b) names.add(b);
    // 上游:world_info_settings.world_info.globalSelect = 全局勾选书目
    for (const n of worldInfoState.globalSelect ?? []) if (n) names.add(n);
    return [...names];
}

/**
 * GH#9 lorebookEntries 选择性 WI 注入:把显式圈定的条目解析成
 * force-activated WIEntry[]。ref 三形:
 *   '书名'                    → 该书全部启用(disable!==true)条目
 *   '书名:uid'                → 指定条目(末段冒号+数字)
 *   { lorebook|book|world: <书名>, uid|id|entry_uid: <n> | comment|entry|entry_name: <名> }
 *   { uid|id|comment|entry: <定位> }(无书) → 五层合并池内搜
 * 命中条目克隆为 constant/disable:false/probability:100,并清
 * triggers/characterFilter/定时门禁(sticky/cooldown/delay/
 * delayUntilRecursion);hash 重盖——timed-effects 按 hash 键台账,
 * 新 hash 即豁免历史冷却状态。显式点名的语义就是本轮必注入,
 * position/depth/order/budget 仍全走引擎面(不是绕过组装的塞入)。
 * 未命中 ref 进 unresolved 回执;一个都不中时由调用方判定(本实现
 * 全失败 → 抛 lorebook_entries_unresolved,见 buildGenerationContextImpl)。
 * @param {unknown} rawRefs
 * @param {{entries: object[], getWorldDoc: (name:string)=>Promise<object|null>}} ctx
 * @returns {Promise<{entries: object[], unresolved: string[]}>}
 */
async function resolveLorebookEntryRefs(rawRefs, { entries, getWorldDoc }) {
    const refs = Array.isArray(rawRefs) ? rawRefs : [rawRefs];
    const resolved = [];
    const unresolved = [];
    const seen = new Set();   // world::uid 去重(重复点同一 ref 不重复注入)

    const pick = (e) => {
        const key = `${e.world}::${e.uid}`;
        if (seen.has(key)) return;
        seen.add(key);
        const forced = {
            ...e,
            constant: true, disable: false, probability: 100,
            delayUntilRecursion: 0, sticky: 0, cooldown: 0, delay: 0,
        };
        delete forced.triggers;
        delete forced.characterFilter;
        forced.hash = getStringHash(JSON.stringify(forced));
        resolved.push(forced);
    };
    // 合并池外的书:按 mergeLoreSources 同款归一化(补模板字段/拆装饰器
    // /盖 hash)——直接塞原始书条目会缺 world/hash,引擎台账乱套。
    // uid/world 以解析结果为准(entriesOfWorld 同款剥 uid 再回填)。
    const normalizeBookEntry = (raw, bookName, uid) => {
        const { uid: _u, world: _w, ...rest } = JSON.parse(JSON.stringify(raw));
        const e = { uid, world: bookName, ...addMissingWorldInfoFields([rest])[0] };
        const [decorators, content] = parseDecorators(e.content || '');
        const normed = { ...e, decorators, content };
        normed.hash = getStringHash(JSON.stringify(normed));
        return normed;
    };
    const BOOK_KEYS = ['lorebook', 'book', 'world'];
    const UID_KEYS = ['uid', 'id', 'entry_uid', 'entryUid'];
    const NAME_KEYS = ['comment', 'entry', 'entry_name', 'entryName'];
    const parseRef = (ref) => {
        if (typeof ref === 'string' || typeof ref === 'number') {
            const s = String(ref).trim();
            const m = s.match(/^(.*):(\d+)$/);
            if (m) return { book: m[1].trim(), locator: { uid: Number(m[2]) } };
            return { book: s, locator: null };
        }
        if (ref && typeof ref === 'object') {
            const book = BOOK_KEYS.map((k) => ref[k]).find((v) => typeof v === 'string' && v.trim()) ?? null;
            for (const k of UID_KEYS) {
                if (ref[k] !== undefined && ref[k] !== null && ref[k] !== '') {
                    const n = Number(ref[k]);
                    if (Number.isFinite(n)) return { book: book ? String(book).trim() : null, locator: { uid: n } };
                }
            }
            for (const k of NAME_KEYS) {
                if (ref[k] !== undefined && ref[k] !== null && ref[k] !== '') {
                    const v = String(ref[k]);
                    // 数字 entry/comment 按 uid 解(TH getLorebookEntries 的 uid 域兼容)
                    return /^\d+$/.test(v)
                        ? { book: book ? String(book).trim() : null, locator: { uid: Number(v) } }
                        : { book: book ? String(book).trim() : null, locator: { comment: v } };
                }
            }
            return { book: book ? String(book).trim() : null, locator: null };
        }
        return { book: null, locator: null };
    };

    for (const ref of refs) {
        const { book, locator } = parseRef(ref);
        const label = typeof ref === 'string' ? ref : JSON.stringify(ref);
        if (!book && !locator) { unresolved.push(label); continue; }
        let matched = 0;
        if (!book) {
            // 无书 ref:合并池内按 uid/comment 搜(五层已绑书内)。
            for (const e of entries) {
                if (locator?.uid !== undefined ? e.uid === locator.uid : String(e.comment ?? '') === locator.comment) {
                    pick(e); matched++;
                }
            }
            if (!matched) unresolved.push(label);
            continue;
        }
        // 先搜合并池(已归一化+五层优先级排序);未命中再整书拉取。
        // 条目 uid 域缺席时以对象键为 uid(worlds 文件 {entries:{uid:entry}}
        // 与 [{uid,...}] 两形都要活)。
        const pool = entries.filter((e) => e.world === book);
        const bookPairs = (doc) => {
            const ents = doc?.entries && typeof doc.entries === 'object' ? doc.entries : {};
            return Object.entries(ents).map(([k, raw]) => ({
                key: k,
                raw,
                uid: raw?.uid ?? (/^\d+$/.test(k) ? Number(k) : undefined),
            }));
        };
        if (locator === null) {
            // 整书 ref:合并池有的用池内归一化形;池外书(未绑定)现拉整本。
            if (pool.length) {
                for (const e of pool) { if (e.disable !== true) { pick(e); matched++; } }
            } else {
                const doc = await getWorldDoc(book).catch(() => null);
                for (const { raw, uid } of bookPairs(doc)) {
                    if (raw?.disable === true) continue;
                    pick(normalizeBookEntry(raw, book, uid)); matched++;
                }
            }
        } else {
            const hit = pool.find((e) =>
                locator.uid !== undefined ? e.uid === locator.uid : String(e.comment ?? '') === locator.comment);
            if (hit) { pick(hit); matched++; }
            else {
                const doc = await getWorldDoc(book).catch(() => null);
                const found = bookPairs(doc).find(({ raw, uid }) =>
                    locator.uid !== undefined ? uid === locator.uid : String(raw?.comment ?? '') === locator.comment);
                if (found) { pick(normalizeBookEntry(found.raw, book, found.uid)); matched++; }
            }
        }
        if (!matched) unresolved.push(label);
    }
    return { entries: resolved, unresolved };
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
 * @param {object} [input.overrides] 直接覆盖请求字段(cyclePrompt/quietPrompt/extensionPrompts/
 *   lorebookEntries(GH#9 选择性 WI 注入,ref 形见 resolveLorebookEntryRefs) 等)
 * @param {boolean} [input.dryRun] preview/干跑:true → WI 不写 timed effects、返回值不含持久化义务
 * @param {string} [input.mainApi] 上游 main_api 同位量('openai'|'textgenerationwebui'|…);
 *   影响 substCtx.mainApi → mesExamples 块头/instruct 样例格式化路径(缺省 'openai')
 * @param {object} [input.group] TASK-037 群聊上下文(缺省 = 单卡)。形状:
 *   { id, chatId, doc, mode, members:[{avatar,name}], speakerAvatar,
 *     joinedCardFields:{description,personality,scenario,mesExample}|null,
 *     memberDepthPrompts:[{text,depth,role}] }
 *   chatId = 群聊文件 id(Repo {isGroup:true,groupId} 寻址);doc = 群档
 *   (substCtx.groups 料);card/charDir 入参此时是「发言成员」的卡与目录。
 * @returns {Promise<{builtPrompt, request, trace, sources, perf, chatMetadata, chatIntegrity}>}
 *   perf:cardMs(调用方补)/loadMs/presetMs/wiMs/assembleMs/collectionMs/populateMs/tokenMs/totalMs;
 *   chatMetadata/chatIntegrity 供调用方持久化 timedWorldInfo(仅非 dryRun)。
 */
export async function buildGenerationContext(input) {
    // 诊断面外层:任何组装失败 → generate 错误事件(assemble_failed),
    // 成功路径的阶段时序由 impl 内 inject 事件承担。diagId 认亲规则
    // 见 utopinn-generate 的 request.utopinnDiagId 挂点。
    const { request, charDir, chatName, type = 'normal' } = input ?? {};
    try {
        return await buildGenerationContextImpl(input);
    } catch (error) {
        diagEmit({
            lvl: 'error', kind: 'generate', code: 'assemble_failed',
            msg: `assemble failed ${charDir}/${chatName}: ${String(error?.message ?? error).slice(0, 280)}`,
            ctx: { charDir, chatId: chatName, verb: type, diagId: request?.utopinnDiagId },
        });
        throw error;
    }
}

async function buildGenerationContextImpl({
    request,
    charDir,
    chatName,
    card,
    presetName,
    user,
    type = 'normal',
    overrides = {},
    dryRun = false,
    mainApi = 'openai',
    group = null,
}) {
    // —— perf 打表(server 包裹层,core 签名不动)——
    // cardMs 由调用方补(loadCharacterCard 在 endpoint);totalMs 为 buildGenerationContext 总耗。
    const perf = {
        cardMs: 0, loadMs: 0, presetMs: 0, wiMs: 0,
        assembleMs: 0, collectionMs: 0, populateMs: 0, tokenMs: 0, totalMs: 0,
    };
    const t0 = performance.now();
    let seg = t0;

    // —— 诊断:注入时序事件(kind:'inject',code=stage)——
    // diagId = 本次组装的认亲键:endpoint 提前挂 request.utopinnDiagId
    // (有 job_id 时同值,job 诞生后 trace 面双键合并);缺省现造。
    // 凝练:data 只放计数/条目指针(uid+key+depth),正文与全量明细
    // 由 job.trace/sources 承担。
    const diagId = request.utopinnDiagId ?? (request.utopinnDiagId = randomUUID());
    const diagCtx = { charDir, chatId: group ? String(group.chatId) : chatName, verb: type, diagId };
    const injectEvt = (stage, data = {}) => diagEmit({
        lvl: 'info', kind: 'inject', code: stage,
        msg: `${stage} ${charDir}/${diagCtx.chatId}${dryRun ? ' (dry)' : ''}`,
        ctx: { ...diagCtx, stage },
        data: { stage, ...data },
    });

    const handle = request.user.profile.handle;
    const chatRepo = getChatRepo();
    const presetRepo = getPresetRepo();
    const settingsRepo = getSettingsRepo();
    const worldInfoRepo = getWorldInfoRepo();

    const isGroup = Boolean(group);
    const [chatDoc, settingsDoc, thInjectState, izumiState] = await Promise.all([
        isGroup
            // 群聊文件寻址同 /api/chats/group/*:{charDir:'',name:chatId,isGroup,groupId}
            ? chatRepo.get(handle, '', String(group.chatId), { isGroup: true, groupId: String(group.chatId) })
            : chatRepo.get(handle, charDir, chatName),
        settingsRepo.get(handle),
        // chat_state ns `th.inject` 读侧(TASK-046 段3b):panel-t0 的
        // th.injectPrompts 写 {prompts: ThInjectedPrompt[]} 进该 ns,
        // 这里把它消费进 extension_prompts 面 —— 卡面注入真正影响本轮组装。
        isGroup
            ? chatRepo.getState(handle, '', String(group.chatId), TH_INJECT_NS,
                { isGroup: true, groupId: String(group.chatId) }).catch(() => null)
            : chatRepo.getState(handle, charDir, chatName, TH_INJECT_NS).catch(() => null),
        // chat_state ns `izumi` 读侧:IzumiEdit 解释器在楼层持久化时写,
        // 这里消费成 hiddenFloors 过滤 + KonataExtraInformation 注入。
        isGroup
            ? chatRepo.getState(handle, '', String(group.chatId), IZUMI_STATE_NS,
                { isGroup: true, groupId: String(group.chatId) }).catch(() => null)
            : chatRepo.getState(handle, charDir, chatName, IZUMI_STATE_NS).catch(() => null),
    ]);
    perf.loadMs += performance.now() - seg;
    if (!chatDoc) throw new Error(isGroup ? `Group chat not found: ${group.chatId}` : `Chat not found: ${charDir}/${chatName}`);

    const powerUser = settingsDoc?.power_user ?? {};
    const { engine: worldInfoSettings, state: worldInfoState, raw: wiRaw } = resolveWorldInfoSettings(settingsDoc);
    // 顶层指针 → canonical 兜底同 resolvePresetInUse(顶层 preset_settings_openai
    // 是产品指针,oai_settings 内嵌槽兜底);body.presetName 显式位恒优先。
    const resolvedPresetName = presetName ?? resolvePresetInUse(settingsDoc, 'openai')?.name ?? 'Default';
    seg = performance.now();
    let presetDoc = await presetRepo.get(handle, 'openai', resolvedPresetName);
    perf.presetMs += performance.now() - seg;
    if (!presetDoc) throw new Error(`Preset not found: openai/${resolvedPresetName}`);
    // TASK-051 B6:内置 Default 的 openai_max_context=4095 是 gpt-3.5 时代
    // 库存值(上游 max_4k;浏览器端靠 slider/模型上限放行,API 直生成无
    // slider)——按「未调过的遗物」抬到现代默认 128000(上游 max_128k 兜底)。
    // 口径刻意收窄:仅 openai/Default 名 + ≤4095 遗物值;换名复制的预设
    // 与用户动过的值都视为意图,不碰。新装的 seed Default 已是 128000,
    // 抬升只服务存量 dataRoot。
    if (resolvedPresetName === 'Default'
        && Number(presetDoc.openai_max_context ?? 0) <= LEGACY_DEFAULT_OPENAI_MAX_CONTEXT) {
        presetDoc = { ...presetDoc, openai_max_context: DEFAULT_OPENAI_MAX_CONTEXT };
    }
    injectEvt('preset', {
        injected: 1, name: resolvedPresetName,
        prompts: Array.isArray(presetDoc.prompts) ? presetDoc.prompts.length : 0,
        contextTokens: presetDoc.openai_max_context ?? null,
        responseTokens: presetDoc.openai_max_tokens ?? null,
        ms: ms(perf.presetMs),
    });

    // preset 域 regex 的 in_use 归属(TASK-070):只消费「当前生成 apiId
    // (mainApi)的 selected 预设」的脚本,再叠 preset_allowed_regex 闸
    // (collectRegexScripts)。openai = 组装用 presetDoc 本体;非 openai
    // 派发(text/kobold/novel)各解各的 selected——不拿 openai 预设硬套
    // (koboldhorde→kobold 归一在 resolvePresetInUse 内)。
    let regexPresetApiId = 'openai';
    let regexPresetName = resolvedPresetName;
    let regexPresetDoc = presetDoc;
    if (mainApi !== 'openai') {
        const inUse = resolvePresetInUse(settingsDoc, mainApi);
        regexPresetApiId = inUse?.apiId ?? mainApi;
        regexPresetName = inUse?.name ?? null;
        regexPresetDoc = inUse
            ? await presetRepo.get(handle, inUse.apiId, inUse.name).catch(() => null)
            : null;
    }

    // IzumiEdit 隐藏楼层:被「隐藏 N楼~M楼」标记的 body 下标留在存储、
    // 从本轮组装剔除(预设原文「从此它们不再在提示词里出现」)——WI 扫描
    // 与楼层面共用同一份 chatMessages,两路一致剔除。
    const izumiHidden = hiddenFloorIndexSet(izumiState);
    const chatBodyForPrompt = izumiHidden.size
        ? (chatDoc.body ?? []).filter((_, i) => !izumiHidden.has(i))
        : chatDoc.body;
    const chatMessages = chatBodyToInput(chatBodyForPrompt);
    // 上游 script.js:8000-8002:type==='swipe' 时弹出末层(swipe 槽
    // 重新生成旧楼层);WI 扫描缓冲同步不含该层。
    if (type === 'swipe' && chatMessages.length) chatMessages.pop();
    injectEvt('load', { injected: chatMessages.length, floors: chatMessages.length, ms: ms(perf.loadMs) });
    const chatMetadata = chatDoc.header?.chat_metadata ?? {};

    // —— World Info:先取书名集 → 批量拉书 → mergeLoreSources 一次成型 ——
    const chatBoundWorlds = Array.isArray(chatMetadata.world_info)
        ? chatMetadata.world_info
        : (chatMetadata.world_info ? [chatMetadata.world_info] : []);
    // 生效主书名 = extensions.world 绑定 ‖ 内嵌书派生名(与 collectWorldNames
    // 内同函数同值;物化文件与内存兜底都寻址它)。
    const primaryWorld = primaryWorldName(card);
    const loreInput = {
        selectedWorlds: worldInfoState.globalSelect ?? [],
        characterPrimaryWorld: primaryWorld,
        characterExtraBooks: getCharExtraBooks(worldInfoState, charDir),
        chatWorlds: chatBoundWorlds,
        personaWorld: powerUser.persona_description_lorebook,
        // 上游 world_info_character_strategy 默认 character_first(1)
        insertionStrategy: wiRaw.world_info_character_strategy ?? 1,
    };
    const worldNames = collectWorldNames({ powerUser, card, chatMetadata, worldInfoState, charDir });
    seg = performance.now();
    const worldCache = new Map();
    // 上游 importEmbeddedWorldInfo 语义:卡内嵌 character_book 但
    // worlds/<主书名> 尚未物化时,内存里即时转换顶上(v2 卡书→world
    // 文件形,uid/keys 归位——直接塞原始卡书会让全本共享
    // "world.undefined" 去重键,整本书塌成一条)。对未物化的存量卡
    // (缺绑、库无书)这同样是唯一的供给路径。
    const embeddedDoc = convertEmbeddedBook(card);
    await Promise.all(worldNames.map(async (name) => {
        const doc = await worldInfoRepo.get(handle, name).catch(() => null);
        if (!doc && name === primaryWorld && embeddedDoc) {
            worldCache.set(name, embeddedDoc);
            return;
        }
        worldCache.set(name, doc?.doc ?? doc ?? undefined);
    }));
    let entries = mergeLoreSources({
        ...loreInput,
        getWorldData: (name) => worldCache.get(name),
    });
    // GH#9 lorebookEntries 选择性 WI 注入(语义/形参见 resolveLorebookEntryRefs):
    // 显式圈定本轮注入的条目,整表替换合并池——quiet 链 skipWIAN 默认空 WI,
    // 这个口是唯一「只要这几条进组装」的供给;全部 ref 未命中时按调用方
    // 显式选择的失败语义抛 lorebook_entries_unresolved(组装失败面同 B5:
    // assemble_failed diag + failed job 登记,不静默跑空上下文)。
    let lorebookSelection = null;
    if (overrides?.lorebookEntries !== undefined) {
        lorebookSelection = await resolveLorebookEntryRefs(overrides.lorebookEntries, {
            entries,
            getWorldDoc: async (name) => {
                if (worldCache.get(name)) return worldCache.get(name);
                if (name === primaryWorld && embeddedDoc) return embeddedDoc;
                const doc = await worldInfoRepo.get(handle, name).catch(() => null);
                return doc?.doc ?? doc ?? null;
            },
        });
        entries = lorebookSelection.entries;
        if (!lorebookSelection.entries.length && lorebookSelection.unresolved.length) {
            const err = new Error(`lorebookEntries unresolved: ${lorebookSelection.unresolved.join(', ')}`);
            err.code = 'lorebook_entries_unresolved';
            err.detail = lorebookSelection.unresolved;
            throw err;
        }
    }
    perf.wiMs += performance.now() - seg;
    injectEvt('charbook', {
        injected: entries.length,
        books: worldNames.length,
        loaded: [...worldCache.values()].filter(Boolean).length,
        entries: entries.length,
        ms: ms(perf.wiMs),
    });

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
            // 楼层快照活引用 —— TH message 域读口径
            // (findLastIndex(m => isObject(m.variables?.[m.swipe_id ?? 0])))。
            variables: m.variables,
        })),
        chatMetadata,
        globalVariables: settingsDoc?.extension_settings?.variables?.global ?? {},
        // TH 'character'/'char' 域:卡面种子 ∪ char_state 侧车 overlay
        // (resolveCharVariableBase)。活引用绑给宏;set_char_variable 写它,
        // 持久化回侧车见 persistMacroVariableWrites 的 char 段。
        charVariables: resolveCharVariableBase(request, charDir, card),
        // TH 'preset' 域:presetDoc.extensions.tavern_helper.variables
        // (TH store/settings/preset.ts —— 预设 extensions.tavern_helper)。
        presetVariables: presetDoc?.extensions?.tavern_helper?.variables ?? {},
        // 变量写回钉:宏 set 家族每写一次 push {domain,path,value};装配末
        // persistMacroVariableWrites 按域落盘/记 volatile diag。
        variableWrites: [],
        currentChatId: isGroup ? String(group.chatId) : chatName,
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
    substCtx.mainApi = mainApi;
    substCtx.contextTemplate = powerUser?.context;
    substCtx.formatInstructExamples = instructEngine.formatInstructExamples;
    injectEvt('instruct', {
        injected: powerUserInstruct.enabled ? 1 : 0,
        enabled: !!powerUserInstruct.enabled,
        instructPresets: instructPresetDocs.length,
        contextPresets: contextPresetDocs.length,
    });
    // {{banned}} 宏收集槽(textgen banned words 通道,evaluate.ts ctx.bannedWords)。
    // 收集范围 = 本次组装内所有 substituteParams 调用;非 textgen 派发读了也不用。
    const bannedInMacros = [];
    substCtx.bannedWords = { collect: true, push: (w) => bannedInMacros.push(w) };
    let substCount = 0; // macro 阶段观测:本侧 subst 调用次数(core 内部替换不计)
    const subst = (content) => { substCount++; return substituteParams(content, substCtx); };

    // —— TASK-037 group seams ——
    // deps.group(assemble.ts:selected/botNames)+ substCtx.groups/{{group}}/
    // {{notChar}}/{{groupNotMuted}} + textgen 群成员 stop 串 + cardFields。
    // joinedCardFields/memberDepthPrompts 必须由 substCtx 派生(逐成员
    // name2 宏替换),只能在 subst 就位后计算——故放这里而非入参处。
    let groupCardFields = null;
    let groupDepthPrompts = [];
    if (isGroup) {
        const roster = Array.isArray(group.members) ? group.members : [];
        const substForMember = (text, memberName) =>
            substituteParams(String(text ?? ''), substCtx, { name2Override: memberName });
        groupCardFields = buildGroupCardFields({
            group: group.doc ?? group,
            roster,
            speakerAvatar: group.speakerAvatar,
            chatMetadata,
            substForMember,
            substGlobal: subst,
        });
        groupDepthPrompts = collectGroupDepthPrompts({
            group: group.doc ?? group,
            roster,
            speakerAvatar: group.speakerAvatar,
            substForMember,
        });
        substCtx.selectedGroup = String(group.id);
        substCtx.groups = [{
            id: String(group.id),
            members: group.doc?.members ?? [],
            disabled_members: group.doc?.disabled_members ?? [],
        }];
        const nameByAvatar = new Map(roster.map((m) => [String(m.avatar), m.name]));
        substCtx.characterNameForAvatar = (avatar) => nameByAvatar.get(String(avatar)) ?? '';
        // getStoppingStrings 群分支原料(textgen-body buildStoppingStrings
        // 用它补 \n<成员名>: 停止串;发言者名在消费侧按 name2 排除)。
        substCtx.groupMemberNames = roster.map((m) => m.name).filter(Boolean);
    }
    // getCharacterCardFields 等价面(substitute.ts cardFields seam):
    // {{description}}/{{personality}}/{{scenario}}/{{mesExamples}}/{{charPrompt}}/
    // {{charJailbreak}}/{{charDepthPrompt}}/{{creatorNotes}} 宏数据源。
    // APPEND 模式 4 字段取联合卡(已逐成员预替换);SWAP/单卡取发言成员字段
    // (全局 subst 一次,等价 legacy baseChatReplace)。
    const cardDescText = groupCardFields?.description ?? subst(String(card?.data?.description ?? card?.description ?? '').trim());
    const cardPersonalityText = groupCardFields?.personality ?? subst(String(card?.data?.personality ?? card?.personality ?? '').trim());
    const cardScenarioText = groupCardFields?.scenario ?? subst(String(card?.data?.scenario ?? card?.scenario ?? '').trim());
    const cardMesExampleText = groupCardFields?.mesExample ?? subst(String(card?.data?.mes_example ?? card?.mes_example ?? '').trim());
    const memberSystemPrompt = String(chatMetadata.system_prompt || card?.data?.system_prompt || card?.system_prompt || '');
    substCtx.cardFields = {
        system: powerUser.prefer_character_prompt ? subst(memberSystemPrompt.trim()) : '',
        jailbreak: powerUser.prefer_character_jailbreak
            ? subst(String(card?.data?.post_history_instructions ?? card?.post_history_instructions ?? '').trim())
            : '',
        description: cardDescText,
        personality: cardPersonalityText,
        scenario: cardScenarioText,
        mesExamples: cardMesExampleText,
        persona: subst(String(powerUser.persona_description ?? '').trim()),
        version: String(card?.data?.character_version ?? card?.character_version ?? ''),
        charDepthPrompt: subst(String(card?.data?.extensions?.depth_prompt?.prompt ?? '').trim()),
        creatorNotes: subst(String(card?.data?.creator_notes ?? card?.creator_notes ?? '').trim()),
        firstMessage: String(card?.data?.first_mes ?? card?.first_mes ?? ''),
        alternateGreetings: Array.isArray(card?.data?.alternate_greetings ?? card?.alternate_greetings)
            ? (card?.data?.alternate_greetings ?? card?.alternate_greetings)
            : [],
    };

    // —— extension prompts:settings 顶层 extension_prompts + chat_metadata.script_injects
    //    重挂为 script_inject_* 键(processChatSlashCommands 语义,每次生成重建)——
    const mergedExtPrompts = { ...(settingsDoc?.extension_prompts ?? {}) };
    for (const [id, inject] of Object.entries(chatMetadata.script_injects ?? {})) {
        if (inject && typeof inject === 'object') {
            mergedExtPrompts[`${SCRIPT_INJECT_KEY_PREFIX}${id}`] = inject;
        }
    }
    // chat_state ns `th.inject` → extension_prompts(TASK-046 段3b 读侧):
    // ThInjectedPrompt {id,position:'in_chat'|'none',depth,role,content,should_scan}
    // 映射 = 上游 extension_prompts 条目形 {value,position,depth,scan,role}。
    // 'none' → NONE(占位不注入,uninject 前保留语义);filter 字段不落地
    // (同 normalizeExtensionPrompts 注释 —— 服务端无闭包求值,shim 端已预过滤)。
    const thInjectPrompts = Array.isArray(thInjectState?.prompts) ? thInjectState.prompts : [];
    for (const p of thInjectPrompts) {
        if (!p || typeof p !== 'object' || p.content == null) continue;
        const key = `${TH_INJECT_KEY_PREFIX}${String(p.id ?? thInjectPrompts.indexOf(p))}`;
        mergedExtPrompts[key] = {
            value: String(p.content),
            position: p.position === 'in_chat'
                ? extension_prompt_types.IN_CHAT
                : extension_prompt_types.NONE,
            depth: Number.isFinite(Number(p.depth)) ? Number(p.depth) : 4,
            scan: !!p.should_scan,
            role: roleByName(p.role ?? 'system'),
        };
    }
    if (thInjectPrompts.length) {
        injectEvt('th_inject', {
            injected: thInjectPrompts.length,
            ids: thInjectPrompts.map((p) => p?.id).filter(Boolean).slice(0, 8),
        });
    }
    // chat_state ns `izumi` → KonataExtraInformation 注入(TH 悬浮窗脚本的
    // setExtensionPrompt IN_CHAT depth 4 同语义;条目目录 + enabled 正文,
    // 关闭条目不进;scan=false 信息库不喂 WI 触发)。worldSystemClosed /
    // 无可注入条目 → renderKonataExtraInformation 回 null,整块不注入。
    const izumiKonata = renderKonataExtraInformation(izumiState);
    if (izumiKonata) {
        mergedExtPrompts[IZUMI_KONATA_KEY] = {
            value: izumiKonata,
            position: extension_prompt_types.IN_CHAT,
            depth: IZUMI_INJECT_DEPTH,
            scan: false,
            role: roleByName('system'),
        };
        injectEvt('izumi', {
            injected: 1, key: IZUMI_KONATA_KEY, depth: IZUMI_INJECT_DEPTH,
            entries: Object.keys(izumiState?.entries ?? {}).length,
            hiddenFloors: izumiState?.hiddenFloors?.length ?? 0,
        });
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
    // depth_prompt 注入(script.js:8209-8220 同位):
    // 群 APPEND/APPEND_DISABLED → DEPTH_PROMPT_${i} 逐成员注入(文本已按
    // 各成员名预替换,互斥单键 DEPTH_PROMPT);SWAP/单卡 → 发言成员单键。
    const depthPromptExt = card?.data?.extensions?.depth_prompt ?? {};
    if (isGroup && groupDepthPrompts.length > 0) {
        groupDepthPrompts.forEach((dp, i) => {
            mergedExtPrompts[`DEPTH_PROMPT_${i}`] = {
                value: String(dp.text ?? ''),
                position: extension_prompt_types.IN_CHAT,
                depth: Number(dp.depth ?? 4),
                scan: !!noteSettings.allowWIScan,
                role: roleByName(dp.role ?? 'system'),
            };
        });
    } else {
        mergedExtPrompts[DEPTH_PROMPT_KEY] = {
            value: String(depthPromptExt.prompt ?? ''),
            position: extension_prompt_types.IN_CHAT,
            depth: Number(depthPromptExt.depth ?? 4),
            scan: !!noteSettings.allowWIScan,
            role: roleByName(depthPromptExt.role ?? 'system'),
        };
    }
    mergedExtPrompts[PERSONA_DESCRIPTION_KEY] = {
        value: '',
        position: extension_prompt_types.IN_PROMPT,
        depth: 0,
    };

    const extPromptSource = { ...(settingsDoc ?? {}), extension_prompts: mergedExtPrompts };

    // skipWIAN(上游 generateQuietPrompt 契约:quiet 任务不进 WI/AN):
    // 扫描输入清空 → checkWorldInfo 走空结果短路,不激活不推进 timed;
    // AN 槽位整键删除 → base AN 与 WI→AN/persona→AN 合并一并失效
    // (extPromptSource 持 mergedExtPrompts 引用,删除即贯通全注入面)。
    // GH#9:lorebookEntries 显式圈定的条目不受 skipWIAN 影响——它的语义
    // 本就是「这轮 quiet 只用这几条」,不是「恢复全部 WI」。
    if (overrides?.skipWIAN) {
        if (!lorebookSelection) entries = [];
        delete mergedExtPrompts[NOTE_MODULE_NAME];
    }

    // WI 扫描:chat 必须新到旧序(engine 约定 index 0 = newest);
    // globalScanData 是卡/人设字段,进扫描缓冲(原版 scanState 同位)
    // 上游 scanState 的卡字段走 getCharacterCardFields —— APPEND 模式
    // 即联合卡(groupCardsLazy 覆盖 4 字段),与 cardFields seam 同源取数。
    const globalScanData = {
        trigger: GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
        personaDescription: user?.description ?? powerUser.persona_description ?? '',
        characterDescription: cardDescText,
        characterPersonality: cardPersonalityText,
        characterDepthPrompt: card?.data?.extensions?.depth_prompt?.prompt ?? '',
        scenario: cardScenarioText,
        creatorNotes: card?.data?.creator_notes ?? card?.creator_notes ?? '',
    };
    seg = performance.now();
    // 上游 world_info_include_names(默认 true):扫描行带 `name: ` 前缀
    const wiScanLines = (wiRaw.world_info_include_names !== false
        ? chatMessages.map((m) => `${m.name}: ${String(m.mes ?? '')}`)
        : chatMessages.map((m) => String(m.mes ?? ''))
    ).reverse();
    // WI 正则钩子 + 观测计数:scriptCount 由 createWorldInfoRegexHook 暴露,
    // applied = 实际改写内容的次数(hook 幂等时原样返回不计)。
    const wiRegexHookRaw = createWorldInfoRegexHook(extPromptSource, substCtx, {
        card, charDir, presetDoc: regexPresetDoc, presetName: regexPresetName, apiId: regexPresetApiId,
    });
    let regexApplied = 0;
    const wiRegexHook = (content, regexOpts = {}) => {
        const out = wiRegexHookRaw(content, regexOpts);
        if (out !== content) regexApplied++;
        return out;
    };
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
                applyWorldInfoRegex: wiRegexHook,
                // characterFilter.names/tags(engine.ts 钩子):单卡 = 卡目录名;
                // 群 = 发言成员目录名(getCharaFilename(this_chid) 同位)。
                getCharacterFilename: () => charDir,
                getCharacterTags: () => (card?.data?.tags ?? card?.tags ?? []),
                // WI 预算与 prompt 同 tokenizer(上游 Tokenizers.openai);
                // len/4 会把 CJK 世界书高估 2-4 倍,预算提前溢出丢条目。
                countTokens: (t) => resolveTokenizer(presetDoc.openai_model).encode(String(t)).length,
            },
        )
        : { worldInfoBeforeEntries: [], worldInfoAfterEntries: [], WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {} };
    perf.wiMs += performance.now() - seg;
    const wiActivatedList = Array.from(wiActivated.allActivatedEntries ?? [])
        .map((e) => ({ world: e.world, uid: e.uid, key: e.key, depth: e.depth, position: e.position }))
        .sort((a, b) => String(a.world ?? '').localeCompare(String(b.world ?? '')) || Number(a.uid) - Number(b.uid));
    injectEvt('worldinfo', {
        injected: wiActivatedList.length,
        scanned: entries.length,
        // GH#9 选择性注入回执:圈定 ref 数/命中条目数/未命中名单(部分
        // 命中继续跑,不装死)。
        selective: lorebookSelection ? {
            requested: (Array.isArray(overrides.lorebookEntries) ? overrides.lorebookEntries : [overrides.lorebookEntries]).length,
            resolved: lorebookSelection.entries.length,
            unresolved: lorebookSelection.unresolved,
        } : undefined,
        before: wiActivated.worldInfoBeforeEntries?.length ?? 0,
        after: wiActivated.worldInfoAfterEntries?.length ?? 0,
        depthFloors: (wiActivated.WIDepthEntries ?? []).length,
        em: (wiActivated.EMEntries ?? []).length,
        an: (wiActivated.ANBeforeEntries ?? []).length + (wiActivated.ANAfterEntries ?? []).length,
        entries: wiActivatedList,
        ms: ms(perf.wiMs),
    });
    // —— 楼层出参 regex 车道(issue #3;上游 script.js:8014-8022 coreChat 映射)——
    // 历史楼层进 prompt 前的 persisted→isPrompt 串接:卡自带 promptOnly
    // 脚本(MVU「对AI隐藏MVU标签」/「去除变量更新」)与 plain 脚本在此生效;
    // depth 同上游 coreChat 口径(continue 末层 = -1)。落盘原文不动,
    // chatPromptMessages 只喂组装面 —— WI 扫描与 substCtx.chat 仍持原文。
    const floorRegexRunner = createFloorRegexRunner(extPromptSource, substCtx, {
        card, charDir, presetDoc: regexPresetDoc, presetName: regexPresetName, apiId: regexPresetApiId,
    });
    let promptRegexApplied = 0;
    let chatPromptMessages = chatMessages;
    if (floorRegexRunner.scriptCount) {
        const r = applyChatFloorsPromptRegex(chatMessages, floorRegexRunner, { isContinue: type === 'continue' });
        chatPromptMessages = r.floors;
        promptRegexApplied = r.applied;
    }
    injectEvt('regex', {
        injected: regexApplied + promptRegexApplied,
        scripts: floorRegexRunner.scriptCount ?? wiRegexHookRaw.scriptCount ?? 0,
        applied: regexApplied + promptRegexApplied,
        wiApplied: regexApplied,
        promptApplied: promptRegexApplied,
    });

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
    // APPEND 联合卡的 mesExample 段(groupCardsLazy.mesExamples 同位,
    // 已逐成员预替换 + <START> 头补齐);SWAP/单卡 = 发言成员字段。
    const cardMesExample = groupCardFields?.mesExample ?? (card?.data?.mes_example ?? card?.mes_example ?? '');
    const mergedMesExample = [...emBefore, cardMesExample, ...emAfter].filter(Boolean).join('\n<START>\n');

    // [[IZUMI_CHAT_INDEX_V1]] 目录占位(预设「🌏Izumi世界系统」的
    // 「可整理的条目:…」一行):TH 脚本原生目录的等价物 —— 换上实时
    // 条目名表,模型照抄目录里的完整操作名才能引用条目。
    // 信息库为空 → '(无)',语义上等同「还没有可整理条目」。
    const izumiCatalogText = renderIzumiCatalog(izumiState);
    const presetPromptsRaw = Array.isArray(presetDoc.prompts) ? presetDoc.prompts : [];
    const assemblyPrompts = presetPromptsRaw.some((p) => String(p?.content ?? '').includes(IZUMI_INDEX_MARKER))
        ? presetPromptsRaw.map((p) => {
            const content = String(p?.content ?? '');
            return content.includes(IZUMI_INDEX_MARKER)
                ? { ...p, content: content.split(IZUMI_INDEX_MARKER).join(izumiCatalogText) }
                : p;
        })
        : presetPromptsRaw;

    const assemblyRequest = {
        card: {
            name: substCtx.name2,
            // 卡 4 字段:APPEND 联合卡(逐成员预替换文本)覆盖,SWAP/单卡
            // 发言成员原值——与 getCharacterCardFieldsLazy 的字段级覆盖同语义。
            description: groupCardFields?.description ?? card?.data?.description ?? card?.description ?? '',
            personality: groupCardFields?.personality ?? card?.data?.personality ?? card?.personality ?? '',
            scenario: groupCardFields?.scenario ?? card?.data?.scenario ?? card?.scenario ?? '',
            mesExample: mergedMesExample,
            systemPromptOverride: card?.data?.system_prompt ?? card?.system_prompt,
            jailbreakOverride: card?.data?.post_history_instructions ?? card?.post_history_instructions,
        },
        user: { name: substCtx.name1, description: user?.description ?? powerUser.persona_description ?? '' },
        chat: chatPromptMessages,
        prompts: assemblyPrompts,
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
        // 上游 continue:cyclePrompt = 被续写楼层当前文本(script.js:8656;
        // 上游取的是已走 regex 的 coreChat 文本 → 用 chatPromptMessages 同口径)。
        // 服务端按末层推导;调用方仍可 overrides.cyclePrompt 显式覆盖。
        ...(type === 'continue' ? { cyclePrompt: chatPromptMessages.at(-1)?.mes ?? '' } : {}),
        ...overrides,
    };

    const builder = createPromptBuilder({
        model: presetDoc.openai_model,
        depthInjection: createDepthInjectionProvider(extPromptSource, subst),
    });
    seg = performance.now();
    // deps.group seam(assemble.ts):selected → groupNudge/new_group_chat_prompt;
    // botNames(getGroupNames 同形,含 disabled)→ 名字前缀行为/他成员
    // reasoning 抑制/示例解析。单卡传 undefined 不触任何群分支。
    const builtPrompt = await builder(assemblyRequest, {
        substCtx,
        ...(isGroup
            ? { group: { selected: String(group.id), botNames: (group.members ?? []).map((m) => m.name).filter(Boolean) } }
            : {}),
    });
    perf.assembleMs = performance.now() - seg;
    // collection/populate/token 分段由 prompt-builder 的 builtPrompt.perf 提供;
    // 缺省(非服务端 builder)时全记 collection、token 记 0。
    perf.collectionMs = builtPrompt.perf?.collectionMs ?? perf.assembleMs;
    perf.populateMs = builtPrompt.perf?.populateMs ?? 0;
    perf.tokenMs = builtPrompt.perf?.tokenMs ?? 0;
    perf.totalMs = performance.now() - t0;

    const usedTokens = builtPrompt.trace ? (builtPrompt.trace.tokenBudget ?? 0) - (builtPrompt.trace.remainingBudget ?? 0) : null;
    injectEvt('assemble', {
        injected: builtPrompt.messages.length,
        messages: builtPrompt.messages.length,
        tokens: usedTokens,
        injectedCollections: builtPrompt.trace?.injectedCount ?? null,
        droppedChat: builtPrompt.trace?.droppedChatCount ?? null,
        ms: ms(perf.assembleMs),
    });
    injectEvt('macro', { injected: substCount, substitutions: substCount, banned: bannedInMacros.length });

    // —— 变量宏写回落盘(issue#2):宏 set 家族(set_*_variable / setvar 系)在
    //    装配期间往 substCtx.variableWrites 推 {domain,path,value};这里按域
    //    persist。展开照常发生在请求内对象上,落盘走各域持久通道 ——
    //    char 域落 char_state 侧车;卡文件缺席时如实记 volatile diag。
    const macroVarPersist = await persistMacroVariableWrites({
        chatRepo, settingsRepo, presetRepo,
        handle, charDir, chatName,
        directories: request.user?.directories,
        isGroup, groupChatId: isGroup ? String(group.chatId) : null,
        chatIntegrity: chatDoc.integrity ?? null,
        chatMetadata, settingsDoc,
        presetName: resolvedPresetName, presetDoc,
        writes: substCtx.variableWrites,
        dryRun,
        diagId,
        chatId: diagCtx.chatId,
    });
    if (macroVarPersist) {
        injectEvt('macro_vars', macroVarPersist);
    }
    diagEmit({
        lvl: 'info', kind: 'generate', code: dryRun ? 'preview' : 'assembled',
        msg: `${dryRun ? 'preview' : 'generate'} ${charDir}/${diagCtx.chatId}: ${builtPrompt.messages.length}msg ${usedTokens ?? '?'}tok ${ms(perf.totalMs)}ms`,
        ctx: diagCtx,
        data: {
            preset: resolvedPresetName, model: presetDoc.openai_model,
            messages: builtPrompt.messages.length, tokens: usedTokens,
            wiActivated: wiActivatedList.length, dryRun, perf,
        },
    });

    return {
        builtPrompt,
        perf,
        request: assemblyRequest,
        presetDoc,
        oaiSettings: settingsDoc?.oai_settings ?? {},
        tgSettings: settingsDoc?.textgenerationwebui_settings ?? {},
        instructEngine,
        substCtx,
        // textgen 派发塑形输入(TASK-037):power_user 开关面、amount_gen 响应长度、
        // 组装期 {{banned}} 宏收集串
        powerUser,
        amountGen: settingsDoc?.amount_gen ?? null,
        bannedInMacros,
        trace: builtPrompt.trace,
        sources: {
            presetName: resolvedPresetName,
            model: presetDoc.openai_model,
            // 与下方 worldInfo.activated 同源(allActivatedEntries):字段名
            // 是「激活条目数」,就得等于明细数组长度。不能靠分桶加总近似——
            // 桶面漏 AN/EM/outlet 位,atDepth 桶按 depth+role 合并(桶数≠
            // 条目数),regex 抹空内容的条目激活了但不进任何桶。
            worldInfoActivated: wiActivatedList.length,
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
                // TASK-034:st-context 快照(getActiveWorldInfoPromptFields 等价物)——
                // 浏览器短路后由 job.sources 重建 activeWorldInfoPromptSnapshot;
                // 与 activated 不同,这里要的是注入本体内容(string[])。
                beforeEntries: wiActivated.worldInfoBeforeEntries ?? [],
                afterEntries: wiActivated.worldInfoAfterEntries ?? [],
                // GH#9 选择性注入回执(th.generate lorebook 段消费):
                // 圈定命中/未命中明细。
                selective: lorebookSelection ? {
                    resolved: lorebookSelection.entries.map((e) => ({ world: e.world, uid: e.uid, comment: e.comment })),
                    unresolved: lorebookSelection.unresolved,
                } : undefined,
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
 * 变量宏写回落盘(issue#2 MagVarUpdate 变量宏家族)。
 *
 * 装配期 evaluate.ts 把 set_X_variable / setvar 家族的写推进
 * `substCtx.variableWrites`(op 日志形,message 域带 path+value 可重放)。
 * 这里在装配末按域持久化;每域独立 try,单域失败不拖垮生成:
 *
 *   message → chat RMW(repo.get → 最新快照楼层逐条重放 _.set +
 *             chat_metadata.variables 顶层并入 → repo.save CAS×3)。
 *             楼层快照与镜像一次写齐 —— 下次生成 message 域读回的是
 *             同一投影;只写镜像会造成「快照还旧、镜像写丢」的假持久。
 *   chat    → updateChatMetadata({variables}) CAS(与
 *             persistWorldInfoTimedEffects 同语义;冲突重读做顶层键并集再写)。
 *             message 写存在时镜像随 RMW 一并落,chat 通道跳过防双写。
 *   global  → settingsRepo 整档回写(与 stscript persistSettings 同约定,
 *             上游 saveSettingsDebounced 同位)。
 *   preset  → presetRepo.patch /extensions/tavern_helper/variables,
 *             父键缺席时逐级降级建枝(TH store/settings/preset.ts 契约)。
 *   char    → char_state 侧车 RMW:<charFile>.state.tavern_helper.json 的
 *             {variables} 稀疏 overlay,逐写 _.set 折叠(services/
 *             character-state.js 同 /state/char/* 一份读写面)。卡文件
 *             不可解析 → 退回 volatile diag,不假装落了盘。
 *   dryRun  → 一律不落盘,记 dry 摘要(preview 无写副作用)。
 *
 * @returns {object|null} diag 摘要;无写 → null(不发空事件)。
 */
export async function persistMacroVariableWrites({
    chatRepo, settingsRepo, presetRepo,
    handle, charDir, chatName,
    directories,
    isGroup = false, groupChatId = null,
    chatIntegrity, chatMetadata, settingsDoc,
    presetName, presetDoc,
    writes, dryRun = false,
    diagId, chatId,
}) {
    const list = Array.isArray(writes) ? writes : [];
    if (list.length === 0) return null;
    const domains = [...new Set(list.map((w) => w?.domain).filter(Boolean))];
    const summary = { writes: list.length, domains, persisted: [], volatile: [], failed: [], dry: !!dryRun };
    const diagCtx = { charDir, chatId: chatId ?? chatName, verb: 'macro_vars', diagId };
    const warn = (code, msg, data = {}) => diagEmit({
        lvl: 'warn', kind: 'generate', code,
        msg: `macro_vars ${charDir}/${diagCtx.chatId}: ${msg}`,
        ctx: diagCtx, data,
    });
    if (dryRun) {
        warn('macro_vars_dry', `${list.length} variable write(s) suppressed (dry run)`, { domains });
        return summary;
    }

    const repoOpts = isGroup ? { isGroup: true, groupId: String(groupChatId) } : {};
    const targetCharDir = isGroup ? '' : charDir;
    const targetName = isGroup ? String(groupChatId) : chatName;
    /** ourVars = 请求内已被宏改写的 chat_metadata.variables(并入 fresh 顶层键)。 */
    const ourChatVars = (chatMetadata?.variables && typeof chatMetadata.variables === 'object' && !Array.isArray(chatMetadata.variables))
        ? chatMetadata.variables : {};

    // —— message 域:楼层快照 + 镜像一次写齐(repo.save CAS RMW)——
    if (domains.includes('message')) {
        const msgWrites = list.filter((w) => w?.domain === 'message' && typeof w?.path === 'string' && w.path);
        let persisted = false;
        let lastError = null;
        for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
            try {
                const fresh = await chatRepo.get(handle, targetCharDir, targetName, repoOpts);
                const body = Array.isArray(fresh?.body) ? fresh.body.slice() : null;
                if (!fresh || !body) break;
                // 与宏读侧同一口径:findLastIndex(isObject(variables[swipe_id]))
                let snapshot = null;
                for (let i = body.length - 1; i >= 0; i--) {
                    const candidate = body[i]?.variables?.[body[i]?.swipe_id ?? 0];
                    if (candidate !== null && typeof candidate === 'object') { snapshot = candidate; break; }
                }
                if (snapshot) {
                    for (const w of msgWrites) {
                        _.set(snapshot, w.path, w.value);
                    }
                }
                const header = {
                    ...(fresh.header ?? {}),
                    chat_metadata: {
                        ...(fresh.header?.chat_metadata ?? {}),
                        variables: {
                            ...(fresh.header?.chat_metadata?.variables && typeof fresh.header.chat_metadata.variables === 'object'
                                ? fresh.header.chat_metadata.variables : {}),
                            ...ourChatVars,
                        },
                    },
                };
                await chatRepo.save(handle, targetCharDir, targetName, header, body, fresh.integrity ?? chatIntegrity, repoOpts);
                persisted = true;
            } catch (error) {
                lastError = error;
                if (error?.code !== 'integrity_mismatch') break;
            }
        }
        if (persisted) {
            summary.persisted.push('message');
        } else {
            summary.failed.push('message');
            warn('macro_vars_persist_failed', `message domain writes did not persist: ${String(lastError?.message ?? lastError)}`, { writes: msgWrites.length });
        }
    }

    // —— chat 域:message 已把镜像并入 RMW 时跳过防双写 ——
    if (domains.includes('chat') && !summary.persisted.includes('message')) {
        try {
            await chatRepo.updateChatMetadata(handle, targetCharDir, targetName, { variables: ourChatVars }, chatIntegrity, repoOpts);
            summary.persisted.push('chat');
        } catch (error) {
            if (error?.code === 'integrity_mismatch') {
                try {
                    const fresh = await chatRepo.get(handle, targetCharDir, targetName, repoOpts);
                    if (!fresh) throw new Error('chat vanished');
                    const freshVars = fresh.header?.chat_metadata?.variables;
                    await chatRepo.updateChatMetadata(handle, targetCharDir, targetName, {
                        variables: {
                            ...(freshVars && typeof freshVars === 'object' ? freshVars : {}),
                            ...ourChatVars,
                        },
                    }, fresh.integrity, repoOpts);
                    summary.persisted.push('chat');
                } catch (retryError) {
                    summary.failed.push('chat');
                    warn('macro_vars_persist_failed', `chat domain writes did not persist: ${String(retryError?.message ?? retryError)}`);
                }
            } else {
                summary.failed.push('chat');
                warn('macro_vars_persist_failed', `chat domain writes did not persist: ${String(error?.message ?? error)}`);
            }
        }
    }

    // —— global 域:settings 整档(与 stscript persistSettings 同约定)——
    if (domains.includes('global')) {
        try {
            await settingsRepo.save(handle, settingsDoc);
            summary.persisted.push('global');
        } catch (error) {
            summary.failed.push('global');
            warn('macro_vars_persist_failed', `global domain writes did not persist: ${String(error?.message ?? error)}`);
        }
    }

    // —— preset 域:/extensions/tavern_helper/variables 逐级补丁建枝 ——
    if (domains.includes('preset')) {
        const vars = (presetDoc?.extensions?.tavern_helper?.variables && typeof presetDoc.extensions.tavern_helper.variables === 'object')
            ? presetDoc.extensions.tavern_helper.variables : {};
        let persisted = false;
        let lastError = null;
        for (const [patchPath, value] of [
            ['/extensions/tavern_helper/variables', vars],
            ['/extensions/tavern_helper', { variables: vars }],
            ['/extensions', { tavern_helper: { variables: vars } }],
        ]) {
            try {
                await presetRepo.patch(handle, 'openai', presetName, [{ op: 'add', path: patchPath, value }]);
                persisted = true;
                break;
            } catch (error) {
                lastError = error;
                if (error?.code !== 'patch_missing_parent') break;
            }
        }
        if (persisted) {
            summary.persisted.push('preset');
        } else {
            summary.failed.push('preset');
            warn('macro_vars_persist_failed', `preset domain writes did not persist: ${String(lastError?.message ?? lastError)}`);
        }
    }

    // —— char 域:char_state 侧车 RMW(GH#2)。overlay 稀疏折叠 —— 只记
    //    宏写过的路径;读侧与卡面种子深合并(resolveCharVariableBase)。
    //    卡文件不可解析(directories 缺位/.png|.webp|.json 全不在)→
    //    请求内生效仍成立,但如实 volatile,不冒充持久。
    if (domains.includes('char')) {
        const charWrites = list.filter((w) => w?.domain === 'char' && typeof w?.path === 'string' && w.path);
        const charFilePath = resolveCharacterFilePath(directories?.characters, charDir);
        if (!charFilePath) {
            summary.volatile.push('char');
            warn('macro_vars_volatile', 'char domain writes are request-scoped (character file not resolvable); not durable across generations');
        } else {
            try {
                const sidecar = readCharacterStateSidecar(charFilePath, TH_CHAR_STATE_NS) ?? {};
                const vars = (sidecar.variables && typeof sidecar.variables === 'object' && !Array.isArray(sidecar.variables))
                    ? sidecar.variables : {};
                for (const w of charWrites) {
                    _.set(vars, w.path, w.value);
                }
                writeCharacterStateSidecar(charFilePath, TH_CHAR_STATE_NS, { ...sidecar, variables: vars });
                summary.persisted.push('char');
            } catch (error) {
                summary.failed.push('char');
                warn('macro_vars_persist_failed', `char domain writes did not persist: ${String(error?.message ?? error)}`, { writes: charWrites.length });
            }
        }
    }

    return summary;
}

/**
 * WI timed effects(sticky/cooldown/delay)写回 chat_metadata。
 * CAS 一次;integrity 冲突 = 生成期间会话被并发推进 → 重读最新再写
 * (与上游 saveChatConditional last-write-wins 等价);二次失败=NotFound 等,
 * 交由下个生成周期自愈。fire-and-forget 不可——dispatch 写楼层必须排在它后面。
 */
export async function persistWorldInfoTimedEffects({ request, charDir, chatName, chatMetadata, expectedIntegrity, groupChatId = null }) {
    const timedWorldInfo = chatMetadata?.timedWorldInfo;
    if (!timedWorldInfo || typeof timedWorldInfo !== 'object') return null;
    const handle = request.user.profile.handle;
    const chatRepo = getChatRepo();
    // 群聊文件同一 CAS 语义,寻址换 {isGroup,groupId}(同 /api/chats/group/*)。
    const repoOpts = groupChatId ? { isGroup: true, groupId: String(groupChatId) } : {};
    const targetCharDir = groupChatId ? '' : charDir;
    const targetName = groupChatId ? String(groupChatId) : chatName;
    try {
        return await chatRepo.updateChatMetadata(handle, targetCharDir, targetName, { timedWorldInfo }, expectedIntegrity, repoOpts);
    } catch (error) {
        if (error?.code !== 'integrity_mismatch') throw error;
        const fresh = groupChatId
            ? await chatRepo.get(handle, '', String(groupChatId), { isGroup: true, groupId: String(groupChatId) })
            : await chatRepo.get(handle, charDir, chatName);
        if (!fresh) return null;
        return chatRepo.updateChatMetadata(handle, targetCharDir, targetName, { timedWorldInfo }, fresh.integrity, repoOpts);
    }
}
