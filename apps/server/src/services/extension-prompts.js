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
import { substituteParams, applyWorldInfoRegex as applyWorldInfoRegexCore } from '@uberge/core';

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
// @uberge/core regex(engine.js:placement/minDepth/maxDepth/promptOnly 门控
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

    // character_allowed_regex 存的是 avatar 文件名(带 .png);charDir 是目录名,两者都试。
    const allowedChars = ext.character_allowed_regex;
    if (charDir && Array.isArray(allowedChars)
        && (allowedChars.includes(charDir) || allowedChars.includes(`${charDir}.png`))) {
        scripts.push(...(Array.isArray(card?.data?.extensions?.regex_scripts) ? card.data.extensions.regex_scripts : []));
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
    return function applyWorldInfoRegex(content, regexOpts = {}) {
        if (typeof content !== 'string') return '';
        if (!content || !scripts.length) return content;
        return applyWorldInfoRegexCore(scripts, content, { depth: regexOpts.depth, role: regexOpts.role }, substCtx);
    };
}
