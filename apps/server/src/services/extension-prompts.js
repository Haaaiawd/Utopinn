/**
 * extension-prompts —— ST extension_prompts 三个面的服务端落地。
 *
 * 数据面(查证自 ref/Luker):
 *   - 持久层 = settingsDoc.extension_prompts(settings 顶层)。ST 原版里 extension_prompts
 *     是每次生成由扩展重建的运行时表、随请求体 extensionPrompts 直发;服务端以该键为持久源。
 *   - chat_metadata.script_injects 由调用方并入(script_inject_* 键,
 *     slash-commands.js processChatSlashCommands 语义)。
 *   - 正则脚本:extension_settings.regex(全局)+ presetDoc.extensions.regex_scripts(preset 域,
 *     preset_allowed_regex[apiId] 放行)+ card.data.extensions.regex_scripts(scoped,
 *     character_allowed_regex 放行)。
 *
 * position 编号 = ST extension_prompt_types 原值(NONE=-1/IN_PROMPT=0/IN_CHAT=1/BEFORE_PROMPT=2,
 * ref/Luker/public/script.js:1456-1470),与 core assemble.ts EXT_* 常量同号,规整时透传不重排。
 */
import {
    substituteParams,
    applyWorldInfoRegex as applyWorldInfoRegexCore,
    getRegexedString,
    regex_placement,
} from '@utopinn/core';

/** ST 枚举(ref/Luker/public/script.js:1456-1470;core assemble.ts EXT_* 同号) */
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

/** script injects 重挂前缀(slash-commands.js SCRIPT_PROMPT_KEY) */
export const SCRIPT_INJECT_KEY_PREFIX = 'script_inject_';

const ROLE_BY_NAME = {
    system: extension_prompt_roles.SYSTEM,
    user: extension_prompt_roles.USER,
    assistant: extension_prompt_roles.ASSISTANT,
};

const toFinite = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

// —— preset 域 regex 的 'in_use' 解析(TASK-070)———————————————————————
// 上游:preset 作用域恒=「当前 API 选中预设」(engine.js getScriptsByType
// PRESET → getPresetManager().getSelectedPresetName()),再叠
// preset_allowed_regex[apiId] 放行闸。服务端无 UI 选中态,解析源 =
// settings 文档各 apiId 的 selected 槽(koboldhorde→kobold 同上游
// getPresetManager:322-325)。
//
// openai 的 selected 指针 = 顶层 preset_settings_openai——产品侧唯一可写
// 标量(utopinn-library PATCH 白名单,写时镜像 oai_settings 内嵌槽),前端
// activePreset(App.tsx/studio.tsx)与 generate-context 预设回退都以它为先;
// oai_settings.preset_settings_openai 是上游 canonical 槽(上游文档只有它)
// → 兜底。两槽镜像在场时分叉只可能来自非 PATCH 写(旧版本/导入/手改)——
// 顶层是产品面一致认的「当前启用」,canonical 先行会让 regex 车道静默解到
// 用户从未选过的预设(实测:顶层=Izumi/canonical=Default → 投影全灭)。
//   apiId                 指针(首选)                          兜底
//   openai                preset_settings_openai(顶层)        oai_settings.preset_settings_openai
//   kobold/koboldhorde    kai_settings.preset_settings         preset_settings(顶层)
//   novel                 nai_settings.preset_settings_novel   preset_settings_novel(顶层)
//   textgenerationwebui   textgenerationwebui_settings.preset  —
//
// settings.main_api 不可作 apiId 源:utopinn 无 API 切换写面,该字段
// 恒为默认值(koboldhorde)。TH/展示车道的「当前生成 apiId」取会话楼层
// extra.api(生成侧簿记真值,非前端本地态);生成链直接用 mainApi 入参。

/** regex preset 族 apiId(engine.js getCurrentPresetAPI 语义;REST scope 校验同表)。 */
export const REGEX_PRESET_API_IDS = Object.freeze(['openai', 'textgenerationwebui', 'novel', 'kobold', 'koboldhorde']);

const PRESET_SELECTED_READERS = Object.freeze({
    openai: (s) => s?.preset_settings_openai ?? s?.oai_settings?.preset_settings_openai,
    kobold: (s) => s?.kai_settings?.preset_settings ?? s?.preset_settings,
    novel: (s) => s?.nai_settings?.preset_settings_novel ?? s?.preset_settings_novel,
    textgenerationwebui: (s) => s?.textgenerationwebui_settings?.preset,
});

/**
 * settings → apiId 的 in_use 预设解析。
 * @param {object} settingsDoc 整份 settings 文档
 * @param {string} apiId 生成/查询 apiId('koboldhorde' 归一为 'kobold',上游同)
 * @returns {{apiId:string, name:string}|null} apiId 无预设概念或 selected 为空 → null
 */
export function resolvePresetInUse(settingsDoc, apiId) {
    const id = apiId === 'koboldhorde' ? 'kobold' : String(apiId ?? '').trim();
    const read = PRESET_SELECTED_READERS[id];
    if (!read) return null;
    const name = read(settingsDoc ?? {});
    return (typeof name === 'string' && name.trim()) ? { apiId: id, name: name.trim() } : null;
}

/** 楼层 extra.api 簿记值 → regex preset 族 apiId。
 *  utopinn 生成楼层记 'chat'|'text'|'kobold'|'novel';legacy 楼层记
 *  chat_completion_source/openai 系(全归 openai 预设族)或 kobold/novel/
 *  textgenerationwebui/koboldhorde。 */
const FLOOR_API_TO_PRESET_API_ID = Object.freeze({
    text: 'textgenerationwebui',
    textgenerationwebui: 'textgenerationwebui',
    kobold: 'kobold',
    koboldhorde: 'kobold',
    novel: 'novel',
});

export function floorApiToPresetApiId(api) {
    return FLOOR_API_TO_PRESET_API_ID[String(api ?? '').trim()] ?? 'openai';
}

/** chat body → 「本会话最近生成 apiId」的 preset 域 apiId(无生成记录 → 'openai')。 */
export function chatPresetApiId(body) {
    const list = Array.isArray(body) ? body : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const api = list[i]?.extra?.api;
        if (api) return floorApiToPresetApiId(api);
    }
    return 'openai';
}

/**
 * settingsDoc → 规整后的 {key:{value,position,depth,order,role,scan}}(position 为 ST 原值)。
 * 缺省字段保留 undefined:getExtensionPrompt 对 depth/role 的 undefined 是通配匹配;
 * position 缺失/非数 → -1(NONE,永不注入)。filter 字段不落地(服务端无闭包求值,
 * 持久化 inject 的 filter 是字符串,原版同样按无函数处理)。
 */
export function normalizeExtensionPrompts(settingsDoc) {
    const raw = settingsDoc?.extension_prompts;
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [key, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== 'object') continue;
        out[key] = {
            value: String(entry.value ?? ''),
            position: toFinite(entry.position) ?? extension_prompt_types.NONE,
            depth: toFinite(entry.depth),
            order: toFinite(entry.order),
            role: toFinite(entry.role),
            scan: !!entry.scan,
        };
    }
    return out;
}

/**
 * scan=true 的注入面 → checkWorldInfo ctx.scannableExtensionPrompts。
 * 原版 world-info.js:8977-8984:逐条 getExtensionPromptByName(substituteParams 后)addInject。
 * @param {(content:string)=>string} [subst] 宏替换(缺省恒等)
 */
export function scannableExtensionPrompts(settingsDoc, subst = (x) => x) {
    const prompts = normalizeExtensionPrompts(settingsDoc);
    const out = [];
    for (const p of Object.values(prompts)) {
        if (p.scan && p.value) {
            const v = subst(p.value);
            if (v) out.push(v);
        }
    }
    return out;
}

/**
 * IN_CHAT 深度注入聚合 —— getExtensionPrompt(IN_CHAT, depth, '\n', role, wrap=false)
 * 的服务端等价物(openai.js:1514 调用点 wrap=false):
 *   Object.keys().sort() 字典序(原版无 order 字段,按 key 排序)+ position/depth/role 过滤
 *   + '\n' join + 末端 substituteParams。
 * role 入参为 'system'|'user'|'assistant'(core DepthInjectionProvider 契约)。
 * @param {(content:string)=>string} [subst] 宏替换(缺省恒等)
 * @returns {(depth:number, role:string)=>Promise<string>}
 */
export function createDepthInjectionProvider(settingsDoc, subst = (x) => x) {
    const prompts = normalizeExtensionPrompts(settingsDoc);
    return async function depthInjection(depth, role) {
        const roleNum = typeof role === 'number' ? role : (ROLE_BY_NAME[role] ?? extension_prompt_roles.SYSTEM);
        const values = Object.keys(prompts).sort()
            .map((k) => prompts[k])
            .filter((x) => x.position === extension_prompt_types.IN_CHAT && x.value)
            .filter((x) => x.depth === undefined || x.depth === depth)
            .filter((x) => x.role === undefined || x.role === roleNum)
            .map((x) => String(x.value).trim())
            .join('\n');
        return values.length ? subst(values) : values;
    };
}

// —— WI regex 钩子(getRegexedString(WORLD_INFO,{depth,isPrompt:true}) 等价物)——
// 脚本源收集/放行判(全局/preset/scoped 三层)留服务端,执行引擎走
// @utopinn/core regex(engine.js:placement/minDepth/maxDepth/promptOnly 门控
// + findRegex/replaceString/trimStrings/宏 与原版逐行一致)。

/**
 * 收集 WI 面可用脚本,序 = SCRIPT_TYPES 迭代序 GLOBAL→PRESET→SCOPED
 * (engine.js:13-18 + getRegexScripts;allowedOnly 门控同原版)。
 */
function collectRegexScripts(settingsDoc, { card, charDir, presetDoc, presetName, apiId = 'openai' } = {}) {
    const ext = settingsDoc?.extension_settings ?? {};
    const scripts = [];
    scripts.push(...(Array.isArray(ext.regex) ? ext.regex : []));

    const allowedPresets = ext.preset_allowed_regex?.[apiId];
    if (presetName && Array.isArray(allowedPresets) && allowedPresets.includes(presetName)) {
        scripts.push(...(Array.isArray(presetDoc?.extensions?.regex_scripts) ? presetDoc.extensions.regex_scripts : []));
    }

    // SCOPED(卡自带)收集 —— issue #3 决策:当前卡作用域脚本恒放行。
    //
    // 上游 engine.js:598 口径是 opt-in:character_allowed_regex 含 avatar
    // 文件名才收,默认空表 → 卡内 regex 静默全灭(ST 用户要去设置里手动
    // 勾选「允许此卡正则」,社区卡的 MVU/状态栏脚本因此普遍"装了不生效")。
    //
    // 这里改成卡作用域自动放行,理由:
    //   1) regex 是卡作者自带的内容变换,与 first_mes/system_prompt 同信任级
    //      ——卡说什么就执行什么,是「真玩通卡」的产品预期;
    //   2) 放行写进 settings(extension_settings.character_allowed_regex)是
    //      隐式副作用:换卡残留、多 handle 串味、import 得跟着维护。按卡作用域
    //      在收集面放行是读取期判断,零持久化、可逆;
    //   3) 真要关卡脚本仍有闸:单脚本 PATCH disabled / extension_settings
    //      .disabledExtensions 全灭 'regex'。慢脚本由 core ReDoS 检测自动暂停。
    //
    // character_allowed_regex 表不再充当本卡闸门(REST 面仍如实回报成员
    // 关系);它的剩余语义 = 「显式放行他卡脚本」的跨卡场景留档。
    const scopedScripts = Array.isArray(card?.data?.extensions?.regex_scripts)
        ? card.data.extensions.regex_scripts
        : (Array.isArray(card?.extensions?.regex_scripts) ? card.extensions.regex_scripts : []);
    if (charDir && scopedScripts.length) {
        scripts.push(...scopedScripts);
    }
    return scripts;
}

/**
 * WI 内容正则钩子 → checkWorldInfo ctx.applyWorldInfoRegex。
 * 原版 world-info.js:9727 固定传 {depth, isMarkdown:false, isPrompt:true};
 * 门控/depth/minDepth/maxDepth/promptOnly 由 core getRegexedString 承担,
 * 服务端只负责脚本源收集与 disabledExtensions 全灭。
 * @param {object} settingsDoc 整份 settings 文档
 * @param {object} substCtx substituteParams 上下文(同 generate-context substCtx)
 * @param {object} [opts] {card, charDir, presetDoc, presetName, apiId}
 * @returns {(content:string, opts:{depth:number|null, role?:number})=>string}
 */
export function createWorldInfoRegexHook(settingsDoc, substCtx, opts = {}) {
    const ext = settingsDoc?.extension_settings ?? {};
    const disabledExt = Array.isArray(ext.disabledExtensions) ? ext.disabledExtensions : [];
    const scripts = disabledExt.includes('regex') ? [] : collectRegexScripts(settingsDoc, opts);
    function applyWorldInfoRegex(content, regexOpts = {}) {
        if (typeof content !== 'string') return '';
        if (!content || !scripts.length) return content;
        return applyWorldInfoRegexCore(scripts, content, { depth: regexOpts.depth, role: regexOpts.role }, substCtx);
    }
    // 观测面只读属性:收集到的脚本数(全局+preset+scoped 三层放行后)。
    applyWorldInfoRegex.scriptCount = scripts.length;
    return applyWorldInfoRegex;
}

// —— 楼层 regex 三车道(issue #3:AI_OUTPUT/USER_INPUT/SLASH_COMMAND/REASONING)——
// 上游语义(ref/Luker,引擎门控逐行对账 packages/core/src/regex/engine.ts):
//   持久车道   flagless getRegexedString —— plain 脚本(无 markdownOnly/
//              promptOnly/pluginLanes)在落盘前改写正文(cleanUpMessage
//              script.js:10942、sendMessageAsUser :10244、getFirstMessage
//              :15273;depth 不传 → 不做深度门控)。
//   展示车道   {isMarkdown:true, depth, characterOverride} ——
//              message-formatter.js:4252,markdownOnly 系脚本的展示半边。
//   组装车道   {isPrompt:true, depth} —— Generate() coreChat 映射
//              (script.js:8014-8022),promptOnly 系脚本的出参半边。
//
// 服务端模型 = 落盘保原文、读取/组装时投影:文本先过持久车道再进目标
// 车道,等价上游「已落盘文」再过对应车道(MVU settle/回滚靠原文里的
// <UpdateVariable> 块,写面永不见投影文 —— 这是选读取投影不选落盘
// 前应用的决定性理由)。

/**
 * 楼层 → 展示侧 regex placement(上游 message-formatter getRegexPlacement):
 * user→USER_INPUT;narrator(extra.type==='narrator')→SLASH_COMMAND;
 * 其余→AI_OUTPUT。reasoning 文本走 REASONING,不在此函数职责内。
 */
export function chatFloorRegexPlacement(message) {
    if (message?.is_user) return regex_placement.USER_INPUT;
    if (message?.extra?.type === 'narrator') return regex_placement.SLASH_COMMAND;
    return regex_placement.AI_OUTPUT;
}

/** 单趟封装:非字符串原样返回;空脚本组/空串短路。 */
function runLane(scripts, perfDetection, substCtx, text, placement, params) {
    if (typeof text !== 'string' || !text || !scripts.length) return text;
    return getRegexedString(text, placement, { scripts, perfDetection, ...params }, substCtx);
}

/**
 * 楼层 regex 执行器:收集三层脚本(卡作用域恒放行,见 collectRegexScripts)
 * 一次,三车道复用;disabledExtensions 含 'regex' 时全灭(scriptCount=0,
 * 调用方据此跳过整条投影)。scriptCount 供 trace 报真数。
 * @param {object} settingsDoc 整份 settings 文档
 * @param {object} substCtx substituteParams 上下文
 * @param {object} [opts] {card, charDir, presetDoc, presetName, apiId}
 */
export function createFloorRegexRunner(settingsDoc, substCtx, opts = {}) {
    const ext = settingsDoc?.extension_settings ?? {};
    const killed = Array.isArray(ext.disabledExtensions) && ext.disabledExtensions.includes('regex');
    const scripts = killed ? [] : collectRegexScripts(settingsDoc, opts);
    const perfDetection = ext.regex_perf_detection !== false;

    /** 持久车道(上游落盘前 flagless):无 depth/override(上游 cleanUpMessage 不传)。 */
    const persisted = (text, placement) => runLane(scripts, perfDetection, substCtx, text, placement, {});
    /** 展示车道(上游 message-formatter):isMarkdown + depth + characterOverride。 */
    const markdown = (text, placement, { depth, characterOverride } = {}) =>
        runLane(scripts, perfDetection, substCtx, text, placement, { isMarkdown: true, depth, characterOverride });
    /** 组装车道(上游 coreChat 映射):isPrompt + depth。 */
    const prompt = (text, placement, { depth } = {}) =>
        runLane(scripts, perfDetection, substCtx, text, placement, { isPrompt: true, depth });
    /** 楼层展示正文 = 持久 → 展示(上游 落盘regex → messageFormatting 串接)。 */
    const displayText = (text, placement, displayOpts) =>
        markdown(persisted(text, placement), placement, displayOpts);
    /** 楼层出参正文 = 持久 → 组装(上游 coreChat 拿到的是已落盘文)。 */
    const promptText = (text, placement, promptOpts) =>
        prompt(persisted(text, placement), placement, promptOpts);

    return { scripts, scriptCount: scripts.length, persisted, markdown, prompt, displayText, promptText };
}

/** swipe 元素 → 文本:持久层允许 string 与 {mes} 两种形。 */
const swipeTextOf = (s) => (typeof s === 'string' ? s : (s && typeof s === 'object' ? s.mes : undefined));

/**
 * chats 读面展示投影(issue #3 执行点之一)。
 *
 * 每楼层透出 regex 应用后的展示文本;存储字段(mes/swipes/swipe_info/
 * extra)一律原样 —— 写回/编辑/MVU settle 路径继续看存储真值。
 *   mes_display            激活视图正文的展示文本(等价上游渲染出的消息文本)
 *   swipes_display         string[],与 swipes 平行的各版本展示文本
 *   reasoning_display      extra.reasoning 的展示文本(REASONING placement)
 *   swipe_info[i].extra.reasoning_display  各 swipe 版本推理的展示文本
 *
 * 门控与上游 message-formatter 对齐:
 *   - is_system && name==='Luker System' 才跳过(comment/hidden 楼被强制
 *     isSystem=false → 照常过 regex);
 *   - depth 只在非系统楼层内从尾数(usableMessages 口径,末层 = 0);
 *     系统楼 indexOf=-1 → undefined(不做深度门控);
 *   - extra.display_text 在场时整楼文本被它覆盖(上游 display_text ?? mes),
 *     该字段后置写入、未经持久车道 → 只跑 markdown 车道。
 *
 * @param {object[]} messages 楼层数组(repo body 形)
 * @param {object} runner createFloorRegexRunner 产物
 * @returns {{floors:object[], applied:number}} applied = 至少一处展示文本
 *   被改写的楼层数(diag/测试断言用);floors 是浅拷贝数组。
 */
export function projectChatFloorsForDisplay(messages, runner) {
    const list = Array.isArray(messages) ? messages : [];
    const nonSystem = [];
    for (let i = 0; i < list.length; i++) {
        if (list[i] && !list[i].is_system) nonSystem.push(i);
    }
    const depthOf = new Map();
    nonSystem.forEach((idx, pos) => depthOf.set(idx, nonSystem.length - pos - 1));

    let applied = 0;
    const floors = list.map((m, i) => {
        if (!m || typeof m !== 'object' || (m.is_system && m.name === 'Luker System')) return m;
        const placement = chatFloorRegexPlacement(m);
        const depth = depthOf.get(i);
        const displayTextOverride = typeof m.extra?.display_text === 'string' ? m.extra.display_text : null;
        // display_text 未走持久车道 → markdown-only;常态正文 = 持久 → 展示串接。
        const show = (raw) => typeof raw === 'string'
            ? (displayTextOverride !== null
                ? runner.markdown(raw, placement, { depth, characterOverride: m.name })
                : runner.displayText(raw, placement, { depth, characterOverride: m.name }))
            : raw;
        // reasoning 同链:上游 ParsedReasoning 落盘前过 flagless REASONING
        // (reasoning.js:514),展示再跑 isMarkdown(message-formatter 4252)。
        const showReasoning = (raw) => typeof raw === 'string' && raw
            ? runner.displayText(raw, regex_placement.REASONING, { depth, characterOverride: m.name })
            : undefined;

        let changed = false;
        const out = { ...m };

        // 正文:display_text 覆盖 > 原样 mes(上游 active 视图渲染的就是 mes)。
        const mesBase = displayTextOverride ?? m.mes;
        out.mes_display = show(mesBase);
        if (out.mes_display !== mesBase) changed = true;

        // 各 swipe 版本(display_text 在场时上游对任何 swipe 都渲它)。
        if (Array.isArray(m.swipes) && m.swipes.length) {
            out.swipes_display = m.swipes.map((s) => {
                const raw = displayTextOverride ?? swipeTextOf(s);
                const projected = show(raw);
                if (projected !== raw) changed = true;
                return projected;
            });
        }

        // 推理文本(独立 REASONING 车道;只跑 markdown,与上游一致——
        // cleanUpMessage 不动 reasoning)。
        const rd = showReasoning(m.extra?.reasoning);
        if (rd !== undefined) {
            out.reasoning_display = rd;
            if (rd !== m.extra.reasoning) changed = true;
        }

        // 各 swipe 版本推理:克隆 swipe_info 条目塞 reasoning_display,
        // 原 extra 对象不被写。
        if (Array.isArray(m.swipe_info) && m.swipe_info.length) {
            out.swipe_info = m.swipe_info.map((si) => {
                const r = si?.extra?.reasoning;
                if (typeof r !== 'string' || !r) return si;
                const srd = showReasoning(r);
                if (srd === r) return si;
                changed = true;
                return { ...si, extra: { ...si.extra, reasoning_display: srd } };
            });
        }

        if (changed) applied++;
        return out;
    });
    return { floors, applied };
}

/**
 * 楼层出参 regex(上游 Generate() coreChat 映射,script.js:8014-8022)。
 * 历史楼层进 prompt 前的 persisted → isPrompt 串接;reasoning 走
 * REASONING placement(上游 :8137,只跑 prompt 车道)。
 * depth = list.length - index - (isContinue?2:1)(上游同式,continue 末层=-1)。
 * 调用方传入的数组应是「上游 coreChat 等价物」——is_system 过滤与
 * swipe-pop 已由调用方完成,这里不再判系统楼。
 *
 * @param {object[]} messages ChatMessageInput[]
 * @param {object} runner createFloorRegexRunner 产物
 * @returns {{floors:object[], applied:number}} applied = 正文/推理被改写的楼层数
 */
export function applyChatFloorsPromptRegex(messages, runner, { isContinue = false } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    let applied = 0;
    const floors = list.map((m, index) => {
        if (!m || typeof m !== 'object') return m;
        // 上游 prompt 车道不按 narrator 分:is_user→USER_INPUT,其余→AI_OUTPUT;
        // 持久车道按其落盘时的消息种类(narrator 是 SLASH_COMMAND)。
        const persistedPlacement = chatFloorRegexPlacement(m);
        const promptPlacement = m.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const depth = list.length - index - (isContinue ? 2 : 1);
        const mes = typeof m.mes === 'string'
            ? runner.prompt(runner.persisted(m.mes, persistedPlacement), promptPlacement, { depth })
            : m.mes;
        // 上游 reasoning 落盘前已过 flagless REASONING(reasoning.js:514)
        // → 出参再跑 persisted→prompt 串接,与正文同链。
        const rawReasoning = m.extra?.reasoning;
        const reasoning = typeof rawReasoning === 'string' && rawReasoning
            ? runner.promptText(rawReasoning, regex_placement.REASONING, { depth })
            : rawReasoning;
        if (mes === m.mes && reasoning === rawReasoning) return m;
        applied++;
        return {
            ...m,
            mes,
            ...(reasoning !== rawReasoning ? { extra: { ...(m.extra ?? {}), reasoning } } : {}),
        };
    });
    return { floors, applied };
}

// —— Author's Note / 卡 depth_prompt / persona 注入通道(audit H4/H5/M1/M2)——
// 键名与上游 inject_ids/authors-note.js 对齐;持久源=settingsDoc.extension_prompts。
export const NOTE_MODULE_NAME = '2_floating_prompt';
export const DEPTH_PROMPT_KEY = 'DEPTH_PROMPT';
export const PERSONA_DESCRIPTION_KEY = 'PERSONA_DESCRIPTION';
export const CUSTOM_WI_OUTLET_PREFIX = 'customWIOutlet_';
const MAX_INJECTION_DEPTH = 10000; // script.js:500

/** getExtensionPromptRoleByName(script.js:8942):数字直通,名字映射,非法回落 system。 */
export function roleByName(roleName) {
    if (typeof roleName === 'number' && Object.values(extension_prompt_roles).includes(roleName)) {
        return roleName;
    }
    return ROLE_BY_NAME[String(roleName)] ?? extension_prompt_roles.SYSTEM;
}

/**
 * setFloatingPrompt(authors-note.js:324-384)服务端等价物。
 * chat_metadata.note_* ← extension_settings.note.default* ← 硬编码缺省;
 * interval 对 user 消息数取模;chara 按 charDir(=getCharaFilename)合并。
 * @returns {{shouldAdd:boolean, entry:{value,position,depth,scan,role}}}
 *   shouldAdd=上游 shouldWIAddPrompt(门控 WI→AN 与 persona→AN 合并)。
 */
export function resolveAuthorsNote({ chatMetadata = {}, userMessageCount = 0, noteSettings = {}, charDir = '' } = {}) {
    const note = noteSettings ?? {};
    const interval = Number(chatMetadata.note_interval ?? note.defaultInterval ?? 1);
    const position = Number(chatMetadata.note_position ?? note.defaultPosition ?? extension_prompt_types.IN_CHAT);
    const depth = Number(chatMetadata.note_depth ?? note.defaultDepth ?? 4);
    const role = Number(chatMetadata.note_role ?? note.defaultRole ?? extension_prompt_roles.SYSTEM);
    const scan = !!note.allowWIScan;

    let lastMessageNumber = userMessageCount;
    if (interval === 1) lastMessageNumber = 1;
    if (lastMessageNumber <= 0 || interval <= 0) {
        return { shouldAdd: false, entry: { value: '', position: extension_prompt_types.NONE, depth: MAX_INJECTION_DEPTH, scan, role } };
    }
    const messagesTillInsertion = lastMessageNumber >= interval
        ? lastMessageNumber % interval
        : interval - lastMessageNumber;
    const shouldAdd = messagesTillInsertion === 0;

    let prompt = shouldAdd ? String(chatMetadata.note_prompt ?? note.default ?? '') : '';
    if (shouldAdd && Array.isArray(note.chara)) {
        const charaNote = note.chara.find((e) => e && e.name === charDir);
        if (charaNote && charaNote.useChara) {
            if (charaNote.position === 1) prompt = `${charaNote.prompt}\n${prompt}`;
            else if (charaNote.position === 2) prompt = `${prompt}\n${charaNote.prompt}`;
            else prompt = String(charaNote.prompt ?? '');
        }
    }
    return { shouldAdd, entry: { value: prompt, position, depth, scan, role } };
}
