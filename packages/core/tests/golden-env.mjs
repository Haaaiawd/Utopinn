/**
 * Golden-diff 适配层 —— 把捕获的 ST/Luker golden 输入还原成 PromptBuildRequest,
 * 喂给 packages/core/dist 的 buildPromptMessages,与 golden wire messages 逐条对比。
 *
 * 数据源与填充假设(逐条标注):
 * - golden.wireRequests[0].messages 是权威对比目标(capture-golden.mjs 记的就是
 *   发给 /api/backends/chat-completions/generate 的完整请求体)。
 * - 聊天:golden.chatSnapshot.messages 里 mock 回复 <GOLDEN_REPLY_TURN_n> 是
 *   生成后才追加的,剔除后剩余即 Generate() 时的 chat(chat[0].mes 已被原版
 *   substituteParams 过一次,属于输入事实,直接采用)。
 * - 预设:capture 环境用的是 apps/server/data/default-user/OpenAI Settings/
 *   Default.json(prompts + prompt_order + oai_settings)。golden 未内嵌快照,
 *   这里内联同一组常量(DEFAULT_PRESET_*),并注明来源文件。
 * - prompt_order 用 character_id=100000 的默认序(100001 序多一个
 *   personaDescription marker,因 persona_description 为空,二者 wire 等价,
 *   差异仅体现在空消息上;选 100000,差异记在报告假设里)。
 * - 用户 persona:last_user_persona?.name ?? 'User';description 捕获为空。
 * - 正则:character_allowed_regex=[]、extension_settings.regex=[] →
 *   捕获时无出站正则生效,适配层不重放正则。
 * - tokenizer:capture 源为 openai→'o1'(o200k_base);wire 侧计数公式
 *   encode+5/getTokenCountAsync 与 wi-trace.test.mjs 一致。
 * - WI:embedded book + bound world 经 @uberge/formats 转成 worldData,
 *   mergeLoreSources 出 sortedEntries,checkWorldInfo 用捕获环境设置。
 *   已知边界差:高中生活模拟 1 条预算边界容差(见 wi-trace 注释)。
 * - depth 注入:extension_prompts 面(IN_CHAT)经 deps.depthInjection 回调
 *   复刻原版 getExtensionPrompt(IN_CHAT, depth, '\n', role) 行为。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
    buildPromptMessages,
    checkWorldInfo,
    mergeLoreSources,
    substituteParams,
    world_info_insertion_strategy,
} from '../dist/index.js';
import {
    readCardFromPng,
    convertCharacterBook,
    getEmbeddedBook,
    getBoundWorldName,
    cardData,
} from '@uberge/formats';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GOLDEN_DIRS = [
    join(REPO, 'tests', 'golden-diff', 'golden'),
    join(REPO, 'tests', 'golden-diff', 'golden-private'),
];
// 卡解析顺序:公开语料 → 私有语料 → Luker 内置默认内容(default_Seraphina 只在这)
const CARD_DIRS = [
    join(REPO, 'tests', 'corpus', 'cards'),
    join(REPO, 'tests', 'corpus-private', 'cards'),
    join(REPO, 'apps', 'server', 'default', 'content'),
];

const requireFromServer = createRequire(join(REPO, 'apps', 'server', 'package.json'));
const { encodingForModel } = requireFromServer('js-tiktoken');
const o1Encoding = encodingForModel('o1');
/** 端点计数公式:getTokenCountAsync = encode+3/msg+3padding,前端 full 模式再 -1。 */
export const countTokens = (t) => (t && t.length ? o1Encoding.encode(t).length + 5 : 0);

export const REPLY_PLACEHOLDER = /^<GOLDEN_REPLY_TURN_\d+>$/;

/** 捕获环境 oai_settings(来源:apps/server/data/default-user/OpenAI Settings/Default.json)。 */
export const CAPTURED_OAI_SETTINGS = {
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',
    group_nudge_prompt: '[Write the next reply only as {{char}}.]',
    impersonation_prompt:
        "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
    new_chat_prompt: '[Start a new Chat]',
    new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
    new_example_chat_prompt: '[Example Chat]',
    continue_nudge_prompt: '[Continue your last message without repeating its original content.]',
    continue_prefill: false,
    assistant_prefill: '',
    send_if_empty: '',
    names_behavior: 0,
    squash_system_messages: false,
    pin_examples: false,
};

/** 捕获环境 Default 预设的 prompts(与 preset JSON 一致)。 */
export const CAPTURED_PROMPTS = [
    { name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.", identifier: 'main' },
    { name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '', identifier: 'nsfw' },
    { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
    { name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', identifier: 'jailbreak' },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
    { identifier: 'enhanceDefinitions', role: 'system', name: 'Enhance Definitions', content: "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.", system_prompt: true, marker: false },
    { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
    { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
    { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
    { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
];

/** character_id=100000 默认序(假设;100001 多 personaDescription,空 persona 下 wire 等价)。 */
export const CAPTURED_PROMPT_ORDER = [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'charPersonality', enabled: true },
    { identifier: 'scenario', enabled: true },
    { identifier: 'enhanceDefinitions', enabled: false },
    { identifier: 'nsfw', enabled: true },
    { identifier: 'worldInfoAfter', enabled: true },
    { identifier: 'dialogueExamples', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
];

/** 捕获环境 world_info_settings(settings.json)。 */
export const CAPTURED_WI_SETTINGS = {
    worldInfoDepth: 2,
    worldInfoBudget: 25,
    worldInfoBudgetCap: 0,
    worldInfoCaseSensitive: false,
    worldInfoMatchWholeWords: true,
    worldInfoUseGroupScoring: false,
    worldInfoRecursive: true,
    worldInfoOverflowAlert: false,
    worldInfoMinActivations: 0,
    worldInfoMinActivationsDepthMax: 0,
    worldInfoMaxRecursionSteps: 0,
};

export const CAPTURED_MAX_CONTEXT = 4095;
export const CAPTURED_MAX_TOKENS = 300;

// extension_prompt_types
const EXT_IN_PROMPT = 0;
const EXT_IN_CHAT = 1;
const EXT_BEFORE_PROMPT = 2;
const ROLE_NAME = ['system', 'user', 'assistant'];

export function listGoldens() {
    const out = [];
    for (const dir of GOLDEN_DIRS) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter((x) => x.endsWith('.golden.json'))) {
            out.push({ dir, file: f, path: join(dir, f) });
        }
    }
    return out;
}

export function findCardPath(cardFile) {
    for (const dir of CARD_DIRS) {
        const p = join(dir, cardFile);
        if (existsSync(p)) return p;
    }
    return null;
}

/**
 * 组装单个 golden 的 PromptBuildRequest + deps。
 * 返回 { golden, cardPath, req, deps, expected, meta }
 */
export async function buildFixture(goldenPath) {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
    const cardFile = golden.card?.file;
    const cardPath = cardFile ? findCardPath(cardFile) : null;
    if (!cardPath) return { golden, cardPath: null };

    const card = JSON.parse(readCardFromPng(readFileSync(cardPath)));
    const d = cardData(card);
    const meta = golden.chatSnapshot?.metadata ?? {};
    const name1 = meta.last_user_persona?.name ?? 'User';
    const name2 = d.name ?? golden.card?.name ?? '';

    // Generate() 时刻的 chat:剔除 mock 回复占位(Seraphina 含 user turn,私有卡不含)
    const genChat = (golden.chatSnapshot?.messages ?? [])
        .filter((m) => !REPLY_PLACEHOLDER.test(m.mes ?? ''));

    // —— substCtx:与 getCharacterCardFields 同构;card 字段先走 baseChatReplace ——
    // baseChatReplace = substituteParams(replaceCharacterCard:false,skipSideEffects)
    // + \r 剥离(collapse_newlines=false 捕获环境)。core 无 skipSideEffects
    // seam,setvar 副作用差异记入假设(语料卡字段无 setvar)。
    const baseReplace = (v) => {
        if (typeof v !== 'string' || !v.length) return '';
        return substituteParams(v, { name1, name2, chat: genChat, chatMetadata: meta, globalVariables: {} }, { replaceCharacterCard: false }).replace(/\r/g, '');
    };
    const rawFields = {
        system: d.system_prompt ?? '',
        mesExamples: d.mes_example ?? '',
        description: d.description ?? '',
        personality: d.personality ?? '',
        persona: '', // power_user.persona_description 捕获为空
        scenario: d.scenario ?? '',
        jailbreak: d.post_history_instructions ?? '',
        version: d.character_version ?? '',
        charDepthPrompt: d.extensions?.depth_prompt?.prompt ?? '',
        creatorNotes: d.creator_notes ?? '',
        firstMessage: d.first_mes ?? '',
    };
    const cardFields = Object.fromEntries(Object.entries(rawFields).map(([k, v]) => [k, baseReplace(v)]));

    const substCtx = {
        name1,
        name2,
        chat: genChat,
        chatMetadata: structuredClone(meta),
        globalVariables: {},
        cardFields,
        model: golden.wireRequests?.[0]?.model ?? '',
        mainApi: 'openai',
    };

    // —— extension_prompts 复刻 Generate() 的注入面 ——
    /** @type {Record<string,{value:string,position:number,depth:number,scan:boolean,role:number}>} */
    const extensionPrompts = {};

    // 卡 depth_prompt → DEPTH_PROMPT(IN_CHAT @ depth,scan=true)
    const dp = d.extensions?.depth_prompt;
    if (dp?.prompt) {
        extensionPrompts.DEPTH_PROMPT = {
            value: baseReplace(dp.prompt),
            position: EXT_IN_CHAT,
            depth: Number(dp.depth ?? 4),
            scan: true,
            role: Number(dp.role ?? 0),
        };
    }

    // Author's Note:note_prompt + WI anBefore/anAfter(原版 applyFinalizedAuthorsNoteInjections
    // 把 WI AN 条目合并进 2_floating_prompt,位置/深度/角色取 chat metadata)
    // 捕获环境 note_prompt='',先占位,WI 结果回填。
    const notePrompt = String(meta.note_prompt ?? '');

    // —— WI 引擎(与原版 checkWorldInfo 同输入)——
    const book = getEmbeddedBook(card);
    const boundWorld = getBoundWorldName(card) ?? '_embedded';
    const worldData = book ? convertCharacterBook(book) : null;
    const sortedEntries = worldData
        ? mergeLoreSources({
            selectedWorlds: [],
            characterPrimaryWorld: boundWorld,
            chatWorlds: [],
            insertionStrategy: world_info_insertion_strategy.character_first,
            getWorldData: (n) => (n === boundWorld ? worldData : undefined),
        })
        : [];

    const chatForWI = genChat.map((m) => `${m.name}: ${m.mes}`).reverse();
    const globalScanData = {
        trigger: 'normal',
        personaDescription: cardFields.persona,
        characterDescription: cardFields.description,
        characterPersonality: cardFields.personality,
        characterDepthPrompt: cardFields.charDepthPrompt,
        scenario: cardFields.scenario,
        creatorNotes: cardFields.creatorNotes,
    };

    // scannable extension prompts(scan=true 的会进 WI buffer,值为 substituteParams 后)
    const scannable = () => Object.values(extensionPrompts)
        .filter((p) => p.scan && p.value)
        .map((p) => substituteParams(p.value, substCtx));

    const wiResult = sortedEntries.length
        ? await checkWorldInfo(chatForWI, CAPTURED_MAX_CONTEXT, false, globalScanData, {
            sortedEntries,
            chatMetadata: structuredClone(meta),
            settings: CAPTURED_WI_SETTINGS,
            substituteParams: (s) => substituteParams(s, substCtx),
            countTokens,
            scannableExtensionPrompts: scannable(),
        })
        : {
            worldInfoBeforeEntries: [], worldInfoAfterEntries: [], worldInfoBefore: '', worldInfoAfter: '',
            WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {}, allActivatedEntries: new Set(),
        };

    // WI depth 条目 → customDepthWI_{depth}_{role}
    for (const g of wiResult.WIDepthEntries ?? []) {
        extensionPrompts[`customDepthWI_${g.depth}_${g.role}`] = {
            value: (g.entries ?? []).join('\n'),
            position: EXT_IN_CHAT,
            depth: g.depth,
            scan: false,
            role: g.role,
        };
    }

    // AN 合并(anBefore + note + anAfter → 2_floating_prompt)
    const anMerged = [
        ...(wiResult.ANBeforeEntries ?? []),
        notePrompt,
        ...(wiResult.ANAfterEntries ?? []),
    ].map((x) => String(x ?? '').trim()).filter(Boolean).join('\n').trim();
    if (anMerged) {
        extensionPrompts['2_floating_prompt'] = {
            value: anMerged,
            position: Number(meta.note_position ?? EXT_IN_PROMPT),
            depth: Number(meta.note_depth ?? 4),
            scan: true, // extension_settings.note.allowWIScan
            role: Number(meta.note_role ?? 0),
        };
    }

    // WI EM 条目 → 并入 mesExample(before unshift / after push,parseMesExamples 的
    // <START> 切块语义用原样文本拼接等价表达:每块保留其 <START> 标记)
    let mesExample = cardFields.mesExamples;
    const emBefore = (wiResult.EMEntries ?? []).filter((e) => Number(e.position) === 0).map((e) => e.content).filter(Boolean);
    const emAfter = (wiResult.EMEntries ?? []).filter((e) => Number(e.position) !== 0).map((e) => e.content).filter(Boolean);
    if (emBefore.length || emAfter.length) {
        const emBlock = (s) => `<START>\n${s.replace(/\r/gm, '').trim()}\n`;
        mesExample = [...emBefore.map(emBlock), mesExample, ...emAfter.map(emBlock)].filter(Boolean).join('');
    }

    // depthInjection:原版 getExtensionPrompt(IN_CHAT, depth, '\n', role, wrap=false)
    const depthInjection = async (depth, role) => {
        const roleNum = ROLE_NAME.indexOf(role);
        const values = Object.keys(extensionPrompts).sort()
            .map((k) => extensionPrompts[k])
            .filter((p) => p.position === EXT_IN_CHAT && p.value)
            .filter((p) => p.depth === undefined || p.depth === depth)
            .filter((p) => p.role === undefined || p.role === roleNum)
            .map((p) => String(p.value).trim());
        return values.join('\n');
    };

    // BEFORE_PROMPT / IN_PROMPT 的扩展提示进 req.extensionPrompts(原版 preparePrompts 同款过滤)
    const reqExtensionPrompts = {};
    for (const [k, p] of Object.entries(extensionPrompts)) {
        if (p.value && [EXT_BEFORE_PROMPT, EXT_IN_PROMPT].includes(p.position)) {
            reqExtensionPrompts[k] = { value: p.value, role: p.role, position: p.position, depth: p.depth, scan: p.scan };
        }
    }

    const req = {
        card: {
            name: name2,
            description: cardFields.description,
            personality: cardFields.personality,
            scenario: cardFields.scenario,
            mesExample,
            systemPromptOverride: '',
            jailbreakOverride: cardFields.jailbreak,
        },
        user: { name: name1, description: '' },
        chat: genChat,
        prompts: CAPTURED_PROMPTS.map((p) => ({ ...p })),
        promptOrder: CAPTURED_PROMPT_ORDER.map((o) => ({ ...o })),
        settings: { ...CAPTURED_OAI_SETTINGS },
        contextTokens: CAPTURED_MAX_CONTEXT,
        responseTokens: CAPTURED_MAX_TOKENS,
        worldInfo: {
            beforeEntries: wiResult.worldInfoBeforeEntries ?? [],
            afterEntries: wiResult.worldInfoAfterEntries ?? [],
        },
        extensionPrompts: reqExtensionPrompts,
        type: 'normal',
        api: 'custom',
        model: golden.wireRequests?.[0]?.model ?? 'mock-gpt-4o',
    };

    const deps = {
        substCtx,
        depthInjection,
        maxDepth: 10000, // MAX_INJECTION_DEPTH
        warn: () => {},
    };

    return {
        golden,
        cardPath,
        req,
        deps,
        expected: golden.wireRequests?.[0]?.messages ?? [],
        meta: { d, genChat, wiResult, extensionPrompts, cardFile },
    };
}

export async function runFixture(goldenPath) {
    const fx = await buildFixture(goldenPath);
    if (!fx.cardPath) return { fixture: fx, built: null, diffs: [] };
    const built = await buildPromptMessages(fx.req, fx.deps);
    const diffs = diffMessages(fx.expected, built.messages, fx);
    return { fixture: fx, built, diffs };
}

// ———————————————————— 对比与分类 ————————————————————

const tsRe = /\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?/g;
const idRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** 合法归一化:时间戳/UUID 中性化 + 水平空白压缩 + 去 \r。逐字差异仍判 CONTENT_DIFF。 */
export const normalizeContent = (s) => String(s ?? '')
    .replace(tsRe, '<TS>').replace(idRe, '<UUID>')
    .replace(/[ \t]+|\r\n?/g, ' ')
    .trim();

const roleOf = (m) => m?.role ?? 'system';
const contentOf = (m) => typeof m?.content === 'string' ? m.content : String(m?.content ?? '');

const RANDOM_MACRO_RE = /\{\{\s*(random|pick|roll|dice|randint|randChar)\b/i;

/** joined 串内是否含 part 作为完整条目(边界感知,防止短条目误配长文本内嵌串)。 */
function isContainedEntry(joined, part) {
    if (!part) return false;
    if (joined === part) return true;
    const j = String(joined), p = String(part);
    return j.startsWith(p + '\n') || j.endsWith('\n' + p) || j.includes('\n' + p + '\n');
}
const isContainedEntryNorm = (joined, part) =>
    isContainedEntry(normalizeContent(joined), normalizeContent(part));

/**
 * 对齐 + 分类。golden 为权威:
 *  - WI_SPLIT:一条 actual 承载 ≥1 条 golden 同 role 消息的合并桶(core 把 WI 桶
 *    join 成单条,原版 formatSplitWorldInfoEntries 逐条发出)。
 *  - WI_ENTRY_EXTRA:桶内多出 golden 没有的 fixture 激活条目(预算/计词边界)。
 *  - WI_ENTRY_MISSING:golden 有 WI 条目但 core 未产出(欠产边界)。
 *  - EMPTY_EXTRA:actual 存在 golden 没有的空 content 消息(原版 getChat 丢空消息,
 *    core flatten 保留)。
 *  - MACRO_NONDET:内容差异但输入含随机类宏(重掷是预期行为)。
 *  - ROLE_DIFF / CONTENT_DIFF / CONTENT_NORM / EXTRA_MSG / MISSING_MSG。
 */
export function diffMessages(expected, actual, fx = null) {
    const diffs = [];
    const g = (expected ?? []).map((m) => ({ role: roleOf(m), content: contentOf(m) }));
    const a = (actual ?? []).map((m) => ({ role: roleOf(m), content: contentOf(m) }));

    // fixture 的 WI 激活条目内容集合(知道哪些 actual 消息是 WI 桶)
    const wiEntryContents = fx?.meta?.wiResult
        ? [
            ...(fx.meta.wiResult.worldInfoBeforeEntries ?? []),
            ...(fx.meta.wiResult.worldInfoAfterEntries ?? []),
        ].map(String)
        : [];

    // 0) actual 空消息 → EMPTY_EXTRA(先从对齐面剔除)
    const aWork = a.filter((m) => {
        if (m.content === '' || m.content === null || m.content === undefined) {
            diffs.push({ cls: 'EMPTY_EXTRA', role: m.role, actual: m, idx: null });
            return false;
        }
        return true;
    });

    const gClaimed = new Set();
    const aClaimed = new Set();

    // 1) WI 桶:actual 消息内容覆盖 ≥1 条 fixture WI 条目 → WI 桶消息
    for (let j = 0; j < aWork.length; j++) {
        const am = aWork[j];
        if (am.role !== 'system' || !wiEntryContents.length) continue;
        const covered = wiEntryContents.filter((e) => e && isContainedEntryNorm(am.content, e));
        if (!covered.length) continue;
        // golden 侧:同 role、未认领、内容是 covered 条目之一(或与之归一化相等)
        const coveredNorm = new Set(covered.map(normalizeContent));
        const gMembers = [];
        g.forEach((gm, gi) => {
            if (gClaimed.has(gi) || gm.role !== am.role) return;
            if (coveredNorm.has(normalizeContent(gm.content))) gMembers.push(gi);
        });
        const extras = covered.filter((e) => !gMembers.some((gi) => normalizeContent(g[gi].content) === normalizeContent(e)));
        for (const gi of gMembers) gClaimed.add(gi);
        aClaimed.add(j);
        diffs.push({
            cls: 'WI_SPLIT', role: am.role, actual: am,
            expected: gMembers.map((gi) => g[gi]),
            goldenRange: gMembers.length ? [gMembers[0], gMembers[gMembers.length - 1]] : null,
        });
        for (const e of extras) {
            diffs.push({ cls: 'WI_ENTRY_EXTRA', role: am.role, actual: { role: am.role, content: e }, bucketActual: am });
        }
        // actual 桶里非 fixture 条目的残余内容(理论上不该有)→ CONTENT_EXTRA
        let residual = am.content;
        for (const e of covered) {
            // 逐个剥离('\n' 边界)
            residual = residual.split('\n' + e + '\n').join('\n');
            residual = residual.startsWith(e + '\n') ? residual.slice(e.length + 1) : residual;
            residual = residual.endsWith('\n' + e) ? residual.slice(0, residual.length - e.length - 1) : residual;
            if (residual === e) residual = '';
        }
        if (residual.trim()) {
            diffs.push({ cls: 'CONTENT_EXTRA', role: am.role, actual: { role: am.role, content: residual }, bucketActual: am });
        }
    }

    // 2) 对齐剩余:g↔a 贪心(归一化相等优先,其次同 role 原位)
    const pairs = [];
    let ai = 0;
    const aFree = aWork.map((m, j) => ({ m, j })).filter((x) => !aClaimed.has(x.j));
    for (let i = 0; i < g.length; i++) {
        if (gClaimed.has(i)) continue;
        let found = -1;
        for (let t = ai; t < aFree.length; t++) {
            if (aFree[t].m.role === g[i].role && normalizeContent(aFree[t].m.content) === normalizeContent(g[i].content)) { found = t; break; }
        }
        if (found === -1) {
            for (let t = ai; t < aFree.length; t++) {
                if (aFree[t].m.role === g[i].role) { found = t; break; }
            }
        }
        if (found === -1) {
            // golden 消息本身是 WI 条目 → WI_ENTRY_MISSING(欠产)
            const isWi = wiEntryContents.length && wiEntryContents.some((e) => normalizeContent(e) === normalizeContent(g[i].content));
            diffs.push({ cls: isWi ? 'WI_ENTRY_MISSING' : 'MISSING_MSG', role: g[i].role, expected: g[i], goldenIdx: i });
            continue;
        }
        for (let t = ai; t < found; t++) {
            diffs.push({ cls: 'EXTRA_MSG', role: aFree[t].m.role, actual: aFree[t].m });
        }
        pairs.push({ gi: i, am: aFree[found].m });
        ai = found + 1;
    }
    for (let t = ai; t < aFree.length; t++) {
        diffs.push({ cls: 'EXTRA_MSG', role: aFree[t].m.role, actual: aFree[t].m });
    }

    // 3) 配对分类
    const chatForMacroScan = (fx?.meta?.genChat ?? []).map((m) => m.mes ?? '').join('\n');
    for (const { gi, am } of pairs) {
        const gm = g[gi];
        const eq = gm.content === am.content;
        const eqNorm = normalizeContent(gm.content) === normalizeContent(am.content);
        if (eq) { diffs.push({ cls: 'PASS', role: gm.role, goldenIdx: gi }); continue; }
        if (eqNorm) {
            diffs.push({ cls: 'CONTENT_NORM', role: gm.role, goldenIdx: gi, expected: gm, actual: am });
            continue;
        }
        if (gm.role !== am.role) {
            diffs.push({ cls: 'ROLE_DIFF', role: `${gm.role}→${am.role}`, goldenIdx: gi, expected: gm, actual: am });
            continue;
        }
        // GOLDEN_CORRUPT:golden 含 U+FFFD 而源数据(卡面/快照)与 actual 一致 → 采集侧
        // 编码损坏,非引擎差异(高中生活:经 → ��,raw/snap 均为 U+7ECF)。
        if (gm.content.includes('�') && !am.content.includes('�')) {
            diffs.push({ cls: 'GOLDEN_CORRUPT', role: gm.role, goldenIdx: gi, expected: gm, actual: am });
            continue;
        }
        const cls = RANDOM_MACRO_RE.test(chatForMacroScan) ? 'MACRO_NONDET' : 'CONTENT_DIFF';
        diffs.push({ cls, role: gm.role, goldenIdx: gi, expected: gm, actual: am });
    }

    return diffs;
}

/** 摘要统计:{pass, diffsByClass, counts} */
export function summarizeDiffs(diffs, expectedCount, actualCount) {
    const by = {};
    for (const d of diffs) by[d.cls] = (by[d.cls] ?? 0) + 1;
    return {
        golden: expectedCount,
        actual: actualCount,
        pass: by.PASS ?? 0,
        byClass: by,
    };
}
