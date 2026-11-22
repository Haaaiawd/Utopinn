/**
 * textgen-body —— /api/utopinn/generate 非 chat-completions 源派发 body 塑形
 * (TASK-037:api==='text' 阶段1;api==='kobold'/'novel' 阶段5)。
 *
 * 逐字段对照浏览器 textgen-settings.js createTextGenGenerationData(:1664-1918)
 * 及其依赖:getStoppingStrings(script.js:6178)、getInstructStoppingSequences
 * (instruct-mode.js:301,经 core instructEngine)、getCustomStoppingStrings
 * (power-user.js:3883)、getCustomTokenBans(:453)、calculateLogitBias(:532)、
 * getTextGenModel(:1542)、getTextGenServer(:360)。
 * kobold 对照 kai-settings.js getKoboldGenerationData(:178)+ setKoboldFlags(:417);
 * novel 对照 nai-settings.js getNovelGenerationData(:524)+ selectPrefix(:704)
 * + getBadWordIds(:443)+ getLogitBiasListResult(logit-bias.js:104)
 * + getMaxContextTokens(script.js:10709)。
 *
 * 语义约定与浏览器一致:
 *  - undefined 值字段不上行(前端靠 JSON.stringify 丢,这里产出时同样剔除);
 *  - 停止串/instruct 序列/dry breakers 过 substituteParams;
 *  - banned_tokens 三态:[1,2,3] 原样 token id、"..." 转 banned_strings、
 *    裸文本经 tokenizer 编码(编码器按 encoding_tokenizer 设置/模型名启发式选,
 *    前端 API tokenizer 通道服务端暂无等价——回落本地 llama 兜底,见 REVIEW);
 *  - cfgValues(CFG 扩展)无服务端等价,guidance_scale/negative_prompt 只吃
 *    settings 值与 generation_overrides;
 *  - novel 订阅层(tier)服务端无探测通道——getNovelMaxResponseTokens 的
 *    tier→上限映射由调用方给(缺省 150,与 legacy 无 novel_data 兜底一致);
 *  - kai_flags 服务端无主循环探测——body.kai_flags 传入优先,缺省由
 *    probeKoboldFlags 生成时探测(/v1/info/version + /extra/version,
 *    探测失败回落全 false,与前端未连过 status 的初始态同义)。
 */

import { substituteParams } from '@utopinn/core';
import { TEXTGEN_TYPES } from '../constants.js';
import { getOverrideHeaders } from '../additional-headers.js';
import { getSentencepiceTokenizer, getWebTokenizer, getTiktokenTokenizer } from '../endpoints/tokenizers.js';

const {
    GENERIC, MANCER, VLLM, APHRODITE, TABBY, TOGETHERAI, OOBA, OLLAMA,
    LLAMACPP, INFERMATICAI, DREAMGEN, OPENROUTER, KOBOLDCPP, HUGGINGFACE, FEATHERLESS,
} = TEXTGEN_TYPES;

/** index.html dynatemp_block_ooba data-tg-type:支持 dynatemp 的 api_type 集 */
const DYNATEMP_TYPES = [OOBA, MANCER, KOBOLDCPP, TABBY, LLAMACPP, APHRODITE];

/** textgen-settings.js:106 APHRODITE_DEFAULT_ORDER(sampler_priority 非默认才上行) */
const APHRODITE_DEFAULT_ORDER = [
    'dry',
    'penalties',
    'no_repeat_ngram',
    'temperature',
    'top_nsigma',
    'top_p_top_k',
    'top_a',
    'min_p',
    'tfs',
    'eta_cutoff',
    'epsilon_cutoff',
    'typical_p',
    'quadratic',
    'xtc',
];

/** getTextGenServer 的托管常量端点(:124-133;server_urls 对这几型无效) */
const HOSTED_SERVERS = {
    [FEATHERLESS]: 'https://api.featherless.ai/v1',
    [MANCER]: 'https://neuro.mancer.tech',
    [TOGETHERAI]: 'https://api.together.xyz',
    [INFERMATICAI]: 'https://api.totalgpt.ai',
    [DREAMGEN]: 'https://dreamgen.com',
    [OPENROUTER]: 'https://openrouter.ai/api',
};

/**
 * power_user.encoding_tokenizer 数值 id → 本地 tokenizer 名。
 * 与 tokenizers.js tokenizers 枚举 + TOKENIZER_MODELS 同表;远端/None 无本地等价。
 */
const ENCODING_TOKENIZER_NAMES = {
    1: 'gpt2',
    3: 'llama',
    4: 'nerdstash',
    5: 'nerdstash_v2',
    7: 'mistral',
    8: 'yi',
    11: 'claude',
    12: 'llama3',
    13: 'gemma',
    14: 'jamba',
    15: 'qwen2',
    16: 'command-r',
    17: 'nemo',
    18: 'deepseek',
    19: 'command-a',
};

/** utils.js onlyUnique */
function onlyUnique(value, index, array) {
    return array.indexOf(value) === index;
}

/** utils.js arraysEqual */
function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

/** utils.js isObject */
function isObject(x) {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** textgen-settings.js toIntArray(:1529):逗号分隔串 → int[] */
function toIntArray(string) {
    if (!string) {
        return [];
    }
    return String(string).split(',').map(x => parseInt(x)).filter(x => !isNaN(x));
}

/**
 * getTextGenServer(:360):托管型用常量;其余读 server_urls[type]。
 * @param {string} apiType TEXTGEN_TYPES 值
 * @param {object} tgSettings textgenerationwebui_settings
 * @returns {string}
 */
export function resolveTextgenServer(apiType, tgSettings) {
    if (HOSTED_SERVERS[apiType]) {
        return HOSTED_SERVERS[apiType];
    }
    return tgSettings?.server_urls?.[apiType] ?? '';
}

/**
 * getTextGenModel(:1542):按 api_type 取模型名。OLLAMA 缺模型与前端同语义抛错。
 * @param {string} apiType
 * @param {object} tgSettings
 * @returns {string|undefined}
 * @throws {Error} OLLAMA 未选模型(调用方转 400)
 */
export function resolveTextgenModel(apiType, tgSettings) {
    const s = tgSettings ?? {};
    switch (apiType) {
        case OOBA: if (s.custom_model) return s.custom_model; break;
        case GENERIC: if (s.generic_model) return s.generic_model; break;
        case MANCER: return s.mancer_model;
        case TOGETHERAI: return s.togetherai_model;
        case INFERMATICAI: return s.infermaticai_model;
        case DREAMGEN: return s.dreamgen_model;
        case OPENROUTER: return s.openrouter_model;
        case VLLM: return s.vllm_model;
        case APHRODITE: return s.aphrodite_model;
        case OLLAMA:
            if (!s.ollama_model) {
                throw new Error('No Ollama model selected');
            }
            return s.ollama_model;
        case FEATHERLESS: return s.featherless_model;
        case HUGGINGFACE: return 'tgi';
        case TABBY: if (s.tabby_model) return s.tabby_model; break;
        case LLAMACPP: if (s.llamacpp_model) return s.llamacpp_model; break;
        default: return undefined;
    }
    return undefined;
}

/**
 * getTokenizerBestMatch('textgenerationwebui') 的本地化(:459-493):
 * encoding_tokenizer 显式指定优先(数值 id → 本地名);
 * 否则按模型名启发式选,兜底 llama。
 * 远端 API tokenizer(API_CURRENT/API_TEXTGENERATIONWEBUI/OPENAI 等)无进程内等价,
 * 同样回落模型名启发式。
 */
function resolveTextgenTokenizerName(encodingTokenizer, model) {
    if (typeof encodingTokenizer === 'number' && ENCODING_TOKENIZER_NAMES[encodingTokenizer]) {
        return ENCODING_TOKENIZER_NAMES[encodingTokenizer];
    }
    const m = String(model || '').toLowerCase();
    if (m.includes('llama3') || m.includes('llama-3')) return 'llama3';
    if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
    if (m.includes('gemma')) return 'gemma';
    if (m.includes('nemo') || m.includes('pixtral')) return 'nemo';
    if (m.includes('deepseek')) return 'deepseek';
    if (m.includes('yi')) return 'yi';
    if (m.includes('jamba')) return 'jamba';
    if (m.includes('command-r')) return 'command-r';
    if (m.includes('command-a')) return 'command-a';
    if (m.includes('qwen2')) return 'qwen2';
    return 'llama';
}

/**
 * 本地 encode:text → token ids,懒加载(无裸文本禁词/logit-bias 条目的
 * 请求不付出模型加载代价)。加载失败/未知名 → encode 返回 [](前端同款
 * 失败路径:跳过该条)。复用 endpoints/tokenizers.js 的实例缓存。
 */
function createTextgenEncoder(name) {
    /** @type {Promise<Function|null>|null} */
    let pending = null;
    const load = () => pending ??= (async () => {
        try {
            if (name === 'gpt2') {
                const tokenizer = getTiktokenTokenizer('gpt2');
                return (text) => Object.values(tokenizer.encode(text));
            }
            const spp = getSentencepiceTokenizer(name);
            if (spp) {
                const instance = await spp.get();
                return instance ? (text) => instance.encodeIds(text) : null;
            }
            const web = getWebTokenizer(name);
            if (web) {
                const instance = await web.get();
                return instance ? (text) => Array.from(instance.encode(text)) : null;
            }
        } catch (error) {
            console.warn(`textgen-body: tokenizer "${name}" unavailable:`, error?.message ?? error);
        }
        return null;
    })();
    return async (text) => {
        const encoder = await load();
        return encoder ? encoder(text) : [];
    };
}

/**
 * replaceMacrosInList(:1629):JSON 数组串或逗号串逐元素过 substituteParams。
 */
function replaceMacrosInList(str, subst) {
    if (!str || typeof str !== 'string') {
        return str;
    }
    try {
        const array = JSON.parse(str);
        if (!Array.isArray(array)) {
            throw new Error('Not an array');
        }
        for (let i = 0; i < array.length; i++) {
            array[i] = subst(array[i]);
        }
        return JSON.stringify(array);
    } catch {
        const array = str.split(',');
        for (let i = 0; i < array.length; i++) {
            array[i] = subst(array[i]);
        }
        return array.join(',');
    }
}

/**
 * params.parseSequenceBreakers(:1743):dry_sequence_breakers 串 → 数组。
 * JSON 数组串 → parse;否则逗号 split;非串 → undefined。
 */
function parseSequenceBreakers(value) {
    try {
        return JSON.parse(value);
    } catch {
        if (typeof value === 'string') {
            return value.split(',');
        }
        return undefined;
    }
}

/**
 * getCustomStoppingStrings(:3883)常驻段;ephemeral 串无服务端通道,跳过。
 * custom_stopping_strings_macro 为真时逐条 substituteParams。
 */
function getCustomStoppingStrings(powerUser, subst) {
    try {
        if (!powerUser?.custom_stopping_strings) {
            return [];
        }
        let strings = JSON.parse(powerUser.custom_stopping_strings);
        if (!Array.isArray(strings)) {
            return [];
        }
        strings = strings.filter(s => typeof s === 'string' && s.length > 0);
        if (powerUser.custom_stopping_strings_macro) {
            strings = strings.map(x => subst(x));
        }
        return strings;
    } catch (error) {
        console.warn('Error parsing custom stopping strings:', error);
        return [];
    }
}

/**
 * getStoppingStrings(script.js:6178)textgen 分支:
 * names_as_stop_strings(user/char)+instruct 序列+custom 串+single_line。
 * 群成员名 stop 串(script.js:6217):selected_group && (name2 || isImpersonate)
 * 时,roster 里 name2 以外成员的 `\n{name}:` 全部进 stop——防成员互抢话头。
 * roster 名表由 generate-context 挂 substCtx.groupMemberNames。
 */
function buildStoppingStrings({ powerUser, substCtx, instructEngine, subst, isImpersonate, isContinue }) {
    const result = [];
    const name1 = substCtx?.name1 ?? '';
    const name2 = substCtx?.name2 ?? '';

    if (powerUser?.context?.names_as_stop_strings) {
        const charString = `\n${name2}:`;
        const userString = `\n${name1}:`;
        result.push(isImpersonate ? charString : userString);
        result.push(userString);
        if (isContinue && substCtx?.chat?.at(-1)?.is_user) {
            result.push(charString);
        }

        // 群路:其余成员名当停止串(含 disabled —— legacy 遍历 group.members 全集)
        if (Array.isArray(substCtx?.groupMemberNames) && (name2 || isImpersonate)) {
            for (const memberName of substCtx.groupMemberNames) {
                if (memberName && memberName !== name2) {
                    result.push(`\n${memberName}:`);
                }
            }
        }
    }

    result.push(...(instructEngine?.getStoppingSequences?.() ?? []));
    result.push(...getCustomStoppingStrings(powerUser, subst));

    if (powerUser?.single_line) {
        result.unshift('\n');
    }

    return result.filter(x => x).filter(onlyUnique);
}

/**
 * getCustomTokenBans(:453):banned_tokens/global_banned_tokens/宏内 {{banned}} 行
 * 三态处理 → { banned_tokens: 逗号串, banned_strings: string[] }。
 * 裸文本行需要 tokenizer;encodeText 为 null 时按前端失败路径跳过该条。
 */
async function getCustomTokenBans(settings, { subst, bannedInMacros, encodeText }) {
    if (!settings?.send_banned_tokens || (!settings?.banned_tokens && !settings?.global_banned_tokens && !bannedInMacros.length)) {
        return { banned_tokens: '', banned_strings: [] };
    }

    const banned_tokens = [];
    const banned_strings = [];
    const sequences = []
        .concat(String(settings.banned_tokens ?? '').split('\n'))
        .concat(String(settings.global_banned_tokens ?? '').split('\n'))
        .concat(bannedInMacros)
        .filter(x => x.length > 0)
        .filter(onlyUnique)
        .map(x => subst(x));

    for (const line of sequences) {
        if (line.startsWith('[') && line.endsWith(']')) {
            try {
                const tokens = JSON.parse(line);
                if (Array.isArray(tokens) && tokens.every(t => Number.isInteger(t))) {
                    banned_tokens.push(...tokens);
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse bad word token list: ${line}`, err);
            }
        } else if (line.startsWith('"') && line.endsWith('"')) {
            banned_strings.push(line.slice(1, -1));
        } else {
            try {
                const tokens = await encodeText(line);
                banned_tokens.push(...tokens);
            } catch {
                console.log(`Could not tokenize raw text: ${line}`);
            }
        }
    }

    return {
        banned_tokens: banned_tokens.filter(onlyUnique).map(x => String(x)).join(','),
        banned_strings,
    };
}

/**
 * calculateLogitBias(:532)+ getLogitBiasListResult(logit-bias.js:104):
 * logit_bias 条目({text,value})→ {tokenId: bias}。
 * 文本形式:{verbatim} 原样编码 / [ids] 直读 / 普通文本带前导空格编码。
 */
async function calculateLogitBias(settings, encodeText) {
    if (!Array.isArray(settings?.logit_bias) || settings.logit_bias.length === 0) {
        return {};
    }
    const result = {};
    const addBias = (bias, sequence) => {
        for (const logit of sequence ?? []) {
            result[String(logit)] = bias;
        }
    };
    for (const entry of settings.logit_bias) {
        if (!(entry?.text?.length > 0)) {
            continue;
        }
        const text = String(entry.text).trim();
        if (!text.length) {
            continue;
        }
        if (text.startsWith('{') && text.endsWith('}')) {
            const tokens = await encodeText(text.slice(1, -1));
            addBias(entry.value, tokens);
        } else if (text.startsWith('[') && text.endsWith(']')) {
            try {
                const tokens = JSON.parse(text);
                if (Array.isArray(tokens) && tokens.every(t => Number.isInteger(t))) {
                    addBias(entry.value, tokens);
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse logit bias token list: ${text}`, err);
            }
        } else {
            const tokens = await encodeText(` ${text}`);
            addBias(entry.value, tokens);
        }
    }
    return result;
}

/**
 * macros/util/escape.js unescapeMacroBraces:剥一层 \{ \} 反斜杠。
 * 前端在 fetch 边界对 generate_data.prompt 统一执行,服务端在派发前同款。
 */
export function unescapeMacroBraces(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\\([{}])/g, '$1');
}

/**
 * createTextGenGenerationData(:1664)服务端同构塑形。
 * @param {object} input
 * @param {object} input.tgSettings textgenerationwebui_settings(已剥连接键与否均可)
 * @param {string} input.apiType TEXTGEN_TYPES 值
 * @param {string} input.apiServer 已解析端点(写进 body.api_server)
 * @param {string} input.prompt 组装好的单串 prompt
 * @param {string|undefined} input.model 已解析模型名(可 undefined)
 * @param {number|undefined} input.maxTokens amount_gen 同位量
 * @param {number|undefined} input.maxContext openai_max_context 同位量
 * @param {object} input.powerUser settings.power_user(停止串/logprobs/单行等开关源)
 * @param {object} input.substCtx 宏上下文(name1/name2/chat/instruct/contextTemplate)
 * @param {object} input.instructEngine core instruct 引擎(getStoppingSequences)
 * @param {string} input.type 生成类型('normal'|'continue'|'impersonate'|'quiet'|…)
 * @param {string[]} [input.bannedInMacros] 组装期 {{banned}} 宏收集到的串
 * @returns {Promise<object>} 派发体(不含 stream/luker_generation;调用方补)
 */
export async function buildTextgenDispatchBody({
    tgSettings, apiType, apiServer, prompt, model, maxTokens, maxContext,
    powerUser, substCtx, instructEngine, type = 'normal', bannedInMacros = [],
}) {
    const settings = tgSettings ?? {};
    const subst = (content) => substituteParams(content, substCtx);
    const isImpersonate = type === 'impersonate';
    const isContinue = type === 'continue';
    const canMultiSwipe = !isContinue && !isImpersonate && type !== 'quiet';
    const dynatemp = !!settings.dynatemp && DYNATEMP_TYPES.includes(apiType);
    const encodeText = createTextgenEncoder(
        resolveTextgenTokenizerName(powerUser?.encoding_tokenizer, model),
    );
    const { banned_tokens, banned_strings } = await getCustomTokenBans(settings, {
        subst,
        bannedInMacros: Array.isArray(bannedInMacros) ? bannedInMacros : [],
        encodeText,
    });
    const jsonSchema = isObject(settings.json_schema)
        ? settings.json_schema_allow_empty
            ? settings.json_schema
            : Object.keys(settings.json_schema).length > 0 ? settings.json_schema : undefined
        : undefined;
    const stoppingStrings = buildStoppingStrings({
        powerUser, substCtx, instructEngine, subst, isImpersonate, isContinue,
    });
    const wantLogprobs = !!powerUser?.request_token_probabilities;
    const dryBreakersString = replaceMacrosInList(settings.dry_sequence_breakers, subst);

    let params = {
        'prompt': prompt,
        'model': model,
        'max_new_tokens': maxTokens,
        'max_tokens': maxTokens,
        'logprobs': wantLogprobs ? (apiType === VLLM || apiType === INFERMATICAI ? 5 : 10) : undefined,
        'temperature': dynatemp ? ((settings.min_temp ?? 0) + (settings.max_temp ?? 0)) / 2 : settings.temp,
        'top_p': settings.top_p,
        'typical_p': settings.typical_p,
        'typical': settings.typical_p,
        'sampler_seed': settings.seed >= 0 ? settings.seed : undefined,
        'min_p': settings.min_p,
        'repetition_penalty': settings.rep_pen,
        'frequency_penalty': settings.freq_pen,
        'presence_penalty': settings.presence_pen,
        'top_k': settings.top_k,
        'skew': settings.skew,
        'min_length': apiType === OOBA ? settings.min_length : undefined,
        'minimum_message_content_tokens': apiType === DREAMGEN ? settings.min_length : undefined,
        'min_tokens': settings.min_length,
        'num_beams': apiType === OOBA ? settings.num_beams : undefined,
        'length_penalty': apiType === OOBA ? settings.length_penalty : undefined,
        'early_stopping': apiType === OOBA ? settings.early_stopping : undefined,
        'add_bos_token': settings.add_bos_token,
        'dynamic_temperature': dynatemp ? true : undefined,
        'dynatemp_low': dynatemp ? settings.min_temp : undefined,
        'dynatemp_high': dynatemp ? settings.max_temp : undefined,
        'dynatemp_range': dynatemp ? ((settings.max_temp ?? 0) - (settings.min_temp ?? 0)) / 2 : undefined,
        'dynatemp_exponent': dynatemp ? settings.dynatemp_exponent : undefined,
        'smoothing_factor': settings.smoothing_factor,
        'smoothing_curve': settings.smoothing_curve,
        'dry_allowed_length': settings.dry_allowed_length,
        'dry_multiplier': settings.dry_multiplier,
        'dry_base': settings.dry_base,
        'dry_sequence_breakers': dryBreakersString,
        'dry_penalty_last_n': settings.dry_penalty_last_n,
        'max_tokens_second': settings.max_tokens_second,
        'sampler_priority': apiType === OOBA ? settings.sampler_priority : undefined,
        'samplers': apiType === LLAMACPP ? settings.samplers : undefined,
        'stopping_strings': stoppingStrings,
        'stop': stoppingStrings,
        'truncation_length': maxContext,
        'ban_eos_token': settings.ban_eos_token,
        'skip_special_tokens': settings.skip_special_tokens,
        'include_reasoning': settings.include_reasoning,
        'top_a': settings.top_a,
        'tfs': settings.tfs,
        'epsilon_cutoff': [OOBA, MANCER].includes(apiType) ? settings.epsilon_cutoff : undefined,
        'eta_cutoff': [OOBA, MANCER].includes(apiType) ? settings.eta_cutoff : undefined,
        'mirostat_mode': settings.mirostat_mode,
        'mirostat_tau': settings.mirostat_tau,
        'mirostat_eta': settings.mirostat_eta,
        'custom_token_bans': [APHRODITE, MANCER].includes(apiType)
            ? toIntArray(banned_tokens)
            : banned_tokens,
        'banned_strings': banned_strings,
        'api_type': apiType,
        'api_server': apiServer,
        'sampler_order': apiType === KOBOLDCPP ? settings.sampler_order : undefined,
        'xtc_threshold': settings.xtc_threshold,
        'xtc_probability': settings.xtc_probability,
        'nsigma': settings.nsigma,
        'top_n_sigma': settings.nsigma,
        'min_keep': settings.min_keep,
        'adaptive_target': settings.adaptive_target,
        'adaptive_decay': settings.adaptive_decay,
    };

    // 非 aphrodite/vllm/infermaticai 共袋(原版 nonAphroditeParams,:1754-1780)
    const nonAphroditeParams = {
        'rep_pen': settings.rep_pen,
        'rep_pen_range': settings.rep_pen_range,
        'repetition_decay': apiType === TABBY ? settings.rep_pen_decay : undefined,
        'repetition_penalty_range': settings.rep_pen_range,
        'encoder_repetition_penalty': apiType === OOBA ? settings.encoder_rep_pen : undefined,
        'no_repeat_ngram_size': apiType === OOBA ? settings.no_repeat_ngram_size : undefined,
        'penalty_alpha': apiType === OOBA ? settings.penalty_alpha : undefined,
        'temperature_last': [OOBA, APHRODITE, TABBY].includes(apiType) ? settings.temperature_last : undefined,
        'speculative_ngram': apiType === TABBY ? settings.speculative_ngram : undefined,
        'do_sample': apiType === OOBA ? settings.do_sample : undefined,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
        'guidance_scale': settings.guidance_scale ?? 1,
        'negative_prompt': subst(settings.negative_prompt) ?? '',
        'grammar_string': settings.grammar_string || undefined,
        'json_schema': [TABBY, LLAMACPP].includes(apiType) ? jsonSchema : undefined,
        // llama.cpp 别名(LM Studio 当 textgen 用)
        'repeat_penalty': settings.rep_pen,
        'repeat_last_n': settings.rep_pen_range,
        'n_predict': maxTokens,
        'num_predict': maxTokens,
        'num_ctx': maxContext,
        'mirostat': settings.mirostat_mode,
        'ignore_eos': settings.ban_eos_token,
        'n_probs': wantLogprobs ? 10 : undefined,
        'rep_pen_slope': settings.rep_pen_slope,
    };
    const vllmParams = {
        'n': canMultiSwipe ? settings.n : 1,
        'ignore_eos': settings.ignore_eos_token,
        'spaces_between_special_tokens': settings.spaces_between_special_tokens,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
    };
    const aphroditeParams = {
        'n': canMultiSwipe ? settings.n : 1,
        'frequency_penalty': settings.freq_pen,
        'presence_penalty': settings.presence_pen,
        'repetition_penalty': settings.rep_pen,
        'seed': settings.seed >= 0 ? settings.seed : undefined,
        'stop': stoppingStrings,
        'temperature': dynatemp ? ((settings.min_temp ?? 0) + (settings.max_temp ?? 0)) / 2 : settings.temp,
        'temperature_last': settings.temperature_last,
        'top_p': settings.top_p,
        'top_k': settings.top_k,
        'top_a': settings.top_a,
        'min_p': settings.min_p,
        'tfs': settings.tfs,
        'eta_cutoff': settings.eta_cutoff,
        'epsilon_cutoff': settings.epsilon_cutoff,
        'typical_p': settings.typical_p,
        'smoothing_factor': settings.smoothing_factor,
        'smoothing_curve': settings.smoothing_curve,
        'ignore_eos': settings.ignore_eos_token,
        'min_tokens': settings.min_length,
        'skip_special_tokens': settings.skip_special_tokens,
        'spaces_between_special_tokens': settings.spaces_between_special_tokens,
        'guided_grammar': settings.grammar_string || undefined,
        'guided_json': jsonSchema || undefined,
        'early_stopping': false, // hacks(原版注释)
        'include_stop_str_in_output': false,
        'dynatemp_min': dynatemp ? settings.min_temp : undefined,
        'dynatemp_max': dynatemp ? settings.max_temp : undefined,
        'dynatemp_exponent': dynatemp ? settings.dynatemp_exponent : undefined,
        'xtc_threshold': settings.xtc_threshold,
        'xtc_probability': settings.xtc_probability,
        'nsigma': settings.nsigma,
        'custom_token_bans': toIntArray(banned_tokens),
        'no_repeat_ngram_size': settings.no_repeat_ngram_size,
        'sampler_priority': apiType === APHRODITE && !arraysEqual(
            settings.samplers_priorities,
            APHRODITE_DEFAULT_ORDER)
            ? settings.samplers_priorities
            : undefined,
    };

    if (apiType === OPENROUTER) {
        params.provider = settings.openrouter_providers;
        params.quantizations = settings.openrouter_quantizations;
        params.allow_fallbacks = settings.openrouter_allow_fallbacks;
    }

    if (apiType === KOBOLDCPP) {
        params.grammar = settings.grammar_string || undefined;
        params.grammar_retain_state = (settings.grammar_string && isContinue) ? true : undefined;
        params.trim_stop = true;
        params.dry_sequence_breakers = parseSequenceBreakers(params.dry_sequence_breakers);
    }

    if (apiType === HUGGINGFACE) {
        params.top_p = Math.min(Math.max(Number(params.top_p), 0.0), 0.999);
        params.stop = Array.isArray(params.stop) ? params.stop.slice(0, 4) : [];
        nonAphroditeParams.seed = settings.seed >= 0 ? settings.seed : Math.floor(Math.random() * Math.pow(2, 32));
    }

    if (apiType === MANCER) {
        params.n = canMultiSwipe ? settings.n : 1;
        // 原版裸 /=1000:undefined 出 NaN;这里守 number 语义,缺失即不上行
        params.epsilon_cutoff = typeof params.epsilon_cutoff === 'number' ? params.epsilon_cutoff / 1000 : params.epsilon_cutoff;
        params.eta_cutoff = typeof params.eta_cutoff === 'number' ? params.eta_cutoff / 1000 : params.eta_cutoff;
        params.dynatemp_mode = params.dynamic_temperature ? 1 : 0;
        params.dynatemp_min = params.dynatemp_low;
        params.dynatemp_max = params.dynatemp_high;
        delete params.dynatemp_low;
        delete params.dynatemp_high;
        params.dry_sequence_breakers = parseSequenceBreakers(params.dry_sequence_breakers);
    }

    if (apiType === TABBY || apiType === LLAMACPP) {
        params.n = canMultiSwipe ? settings.n : 1;
    }

    switch (apiType) {
        case VLLM:
        case INFERMATICAI:
            params = Object.assign(params, vllmParams);
            break;

        case APHRODITE:
            params = Object.assign(params, aphroditeParams);
            break;

        default:
            params = Object.assign(params, nonAphroditeParams);
            break;
    }

    if (Array.isArray(settings.logit_bias) && settings.logit_bias.length) {
        params.logit_bias = await calculateLogitBias(settings, encodeText);
    }

    if (apiType === LLAMACPP || apiType === OLLAMA) {
        // bias 与 token bans 合并为 [[id,bias],…] 数组形
        const logitBiasArray = (params.logit_bias && typeof params.logit_bias === 'object' && Object.keys(params.logit_bias).length > 0)
            ? Object.entries(params.logit_bias).map(([key, value]) => [Number(key), value])
            : [];
        const tokenBans = toIntArray(banned_tokens);
        logitBiasArray.push(...tokenBans.map(x => [Number(x), false]));
        const sequenceBreakers = parseSequenceBreakers(params.dry_sequence_breakers);
        Object.assign(params, {
            'logit_bias': logitBiasArray,
            // 与 ooba 的 grammar_string 互斥命名
            'grammar': settings.grammar_string,
            'cache_prompt': true,
            'dry_sequence_breakers': sequenceBreakers,
        });
        if (!Array.isArray(sequenceBreakers) || sequenceBreakers.length === 0) {
            delete params.dry_sequence_breakers;
        }
    }

    // grammar 与 json_schema 互斥(原版 :1907-1917)
    if ([LLAMACPP, APHRODITE].includes(apiType)) {
        if (jsonSchema) {
            delete params.grammar_string;
            delete params.grammar;
            delete params.guided_grammar;
        } else {
            delete params.json_schema;
            delete params.guided_json;
        }
    }

    // undefined 不上行(与前端 JSON.stringify 语义一致)
    for (const key of Object.keys(params)) {
        if (params[key] === undefined) {
            delete params[key];
        }
    }
    return params;
}


// ═══════════════════════════════════════════════════════════════════════
// TASK-037 阶段5:api==='kobold' / 'novel' 派发体塑形
// ═══════════════════════════════════════════════════════════════════════

/** kai_flags 默认全集(kai-settings.js:60-70,未探测=全 false 保守形) */
const KAI_FLAGS_DEFAULT = {
    can_use_tokenization: false,
    can_use_stop_sequence: false,
    can_use_streaming: false,
    can_use_default_badwordsids: false,
    can_use_mirostat: false,
    can_use_grammar: false,
    can_use_min_p: false,
};

/**
 * can_use_* 门版本(kai-settings.js:72-78)。src 列:
 * 'united' = /v1/info/version(KoboldAI United),'cpp' = /extra/version(KoboldCpp)。
 */
const KAI_FLAG_GATES = [
    ['can_use_stop_sequence', 'united', '1.2.2'],
    ['can_use_streaming', 'cpp', '1.30'],
    ['can_use_tokenization', 'cpp', '1.41'],
    ['can_use_default_badwordsids', 'united', '1.2.4'],
    ['can_use_mirostat', 'cpp', '1.35'],
    ['can_use_grammar', 'cpp', '1.44'],
    ['can_use_min_p', 'cpp', '1.48'],
];

/**
 * versionCompare(utils.js:3157)服务端简版:
 * 逐段数值比;任一侧不可解析回落 localeCompare(numeric) —— 与前端
 * compareVersionLike 的 fallback 同形。core 相等时 src 带非数字尾巴
 * (rc/日期版)按前端 prerelease 语义视作低于净版本号。
 * @returns {boolean} srcVersion >= minVersion
 */
export function versionGte(srcVersion, minVersion) {
    const parse = (v) => {
        if (v === null || v === undefined) return null;
        const m = String(v).trim().match(/^(\d+(?:\.\d+)*)(.*)$/);
        if (!m) return null;
        return { core: m[1].split('.').map(Number), rest: String(m[2] ?? '') };
    };
    const a = parse(srcVersion);
    const b = parse(minVersion);
    if (!a || !b) {
        return String(srcVersion || '0.0.0')
            .localeCompare(String(minVersion || '0.0.0'), undefined, { numeric: true, sensitivity: 'base' }) >= 0;
    }
    const len = Math.max(a.core.length, b.core.length);
    for (let i = 0; i < len; i++) {
        const av = a.core[i] ?? 0;
        const bv = b.core[i] ?? 0;
        if (av !== bv) return av > bv;
    }
    // core 全等:门版本恒为净版本号;src 带尾巴按 prerelease 语义低一档
    if (a.rest && !b.rest) return false;
    return true;
}

/**
 * setKoboldFlags(kai-settings.js:417)纯函数版:两路版本号 → can_use_* 全集。
 * 缺省/不可解析一律 false —— 与前端 kai_flags 初始态同义(旧上游对
 * 未知字段做白名单校验,乱塞会被拒)。
 */
export function resolveKaiFlags({ koboldUnitedVersion, koboldCppVersion } = {}) {
    const flags = {};
    for (const [flag, src, min] of KAI_FLAG_GATES) {
        flags[flag] = versionGte(src === 'united' ? koboldUnitedVersion : koboldCppVersion, min);
    }
    return flags;
}

/** api_server → {ts, flags} 探测缓存;短 TTL 摊薄每次生成的两次探测请求 */
const kaiFlagsProbeCache = new Map();
const KAI_FLAGS_PROBE_TTL_MS = 60_000;
const KAI_FLAGS_PROBE_CACHE_MAX = 32;

/**
 * kobold 能力探测(/api/backends/kobold/status 的服务端等价):
 * 并行取 /v1/info/version(united)+ /extra/version(koboldcpp)→ resolveKaiFlags。
 * 探测失败/无 api_server → 全 false(保守,旧上游白名单校验不被未知字段炸)。
 * 短 TTL 缓存:前端靠 status 轮询刷 kai_flags,服务端按 api_server 记一分钟。
 * @param {string} apiServer kobold 上游地址(localhost → 127.0.0.1 与 dispatch 同形)
 * @param {object} [opts] { fetchImpl, timeoutMs } —— fetchImpl 注入位(测试/定制)
 * @returns {Promise<object>} can_use_* 全集(恒返回完整七键)
 */
export async function probeKoboldFlags(apiServer, { fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 4000 } = {}) {
    const server = String(apiServer ?? '').replace('localhost', '127.0.0.1');
    const hit = kaiFlagsProbeCache.get(server);
    if (hit && Date.now() - hit.ts < KAI_FLAGS_PROBE_TTL_MS) {
        return hit.flags;
    }
    let flags = { ...KAI_FLAGS_DEFAULT };
    if (server && fetchImpl) {
        const headers = { 'Content-Type': 'application/json' };
        try {
            Object.assign(headers, getOverrideHeaders(new URL(server).host));
        } catch { /* 非法 URL → 无覆盖头(与 dispatch buildKoboldHeaders 同义) */ }
        const get = async (path) => {
            const r = await fetchImpl(`${server}${path}`, {
                headers,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!r.ok) return null;
            const j = await r.json().catch(() => null);
            return j?.result ?? null;
        };
        try {
            const [koboldUnitedVersion, koboldCppVersion] = await Promise.all([
                get('/v1/info/version').catch(() => null),
                get('/extra/version').catch(() => null),
            ]);
            flags = resolveKaiFlags({ koboldUnitedVersion, koboldCppVersion });
        } catch { /* 探测整体失败 → 全 false */ }
    }
    if (kaiFlagsProbeCache.size >= KAI_FLAGS_PROBE_CACHE_MAX) {
        kaiFlagsProbeCache.delete(kaiFlagsProbeCache.keys().next().value);
    }
    kaiFlagsProbeCache.set(server, { ts: Date.now(), flags });
    return flags;
}

/**
 * getKoboldGenerationData(kai-settings.js:178)服务端同构。
 * 只做非 gui 袋;gui_settings=true 的瘦袋由调用方直接组(legacy 同序:
 * preset_settings==='gui' → {prompt,gui_settings,max_length,
 * max_context_length,api_server} 五键,streaming 键不上行)。
 * @param {object} input
 * @param {object} input.kaiSettings settings.kai_settings
 * @param {object|null} [input.presetSettings] 'kobold' 预设档(仅 sampler_order 兜底)
 * @param {string} input.prompt 组装好的单串 prompt
 * @param {number|undefined} input.maxLength amount_gen 同位量
 * @param {number|undefined} input.maxContext max_context 同位量
 * @param {object} input.kaiFlags can_use_* 全集(探测/传入产物)
 * @param {string} [input.type] 生成动词(grammar_retain_state 看 isContinue)
 * @param {object} input.powerUser settings.power_user
 * @param {object} input.substCtx 宏上下文
 * @param {object} input.instructEngine core instruct 引擎
 * @returns {object} 派发体(不含 streaming/can_abort/api_server/type/luker_generation;调用方补)
 */
export function buildKoboldDispatchBody({
    kaiSettings, presetSettings, prompt, maxLength, maxContext,
    kaiFlags, type = 'normal', powerUser, substCtx, instructEngine,
}) {
    const settings = kaiSettings ?? {};
    const flags = { ...KAI_FLAGS_DEFAULT, ...(kaiFlags ?? {}) };
    const subst = (content) => substituteParams(content, substCtx);
    const isImpersonate = type === 'impersonate';
    const isContinue = type === 'continue';
    const stoppingStrings = buildStoppingStrings({
        powerUser, substCtx, instructEngine, subst, isImpersonate, isContinue,
    });

    const params = {
        'prompt': prompt,
        'gui_settings': false,
        'sampler_order': settings.sampler_order || presetSettings?.sampler_order,
        'max_context_length': maxContext === undefined || maxContext === null ? undefined : Number(maxContext),
        'max_length': maxLength,
        'rep_pen': Number(settings.rep_pen),
        'rep_pen_range': Number(settings.rep_pen_range),
        'rep_pen_slope': settings.rep_pen_slope,
        'temperature': Number(settings.temp),
        'tfs': settings.tfs,
        'top_a': settings.top_a,
        'top_k': settings.top_k,
        'top_p': settings.top_p,
        'min_p': flags.can_use_min_p ? settings.min_p : undefined,
        'typical': settings.typical,
        'use_world_info': false,
        'singleline': false,
        'stop_sequence': flags.can_use_stop_sequence ? stoppingStrings : undefined,
        'mirostat': flags.can_use_mirostat ? settings.mirostat : undefined,
        'mirostat_tau': flags.can_use_mirostat ? settings.mirostat_tau : undefined,
        'mirostat_eta': flags.can_use_mirostat ? settings.mirostat_eta : undefined,
        'use_default_badwordsids': flags.can_use_default_badwordsids ? settings.use_default_badwordsids : undefined,
        'grammar': flags.can_use_grammar ? subst(settings.grammar) : undefined,
        'grammar_retain_state': (flags.can_use_grammar && isContinue) ? true : undefined,
        'sampler_seed': settings.seed >= 0 ? settings.seed : undefined,
    };

    // undefined 不上行(与前端 JSON.stringify 语义一致);NaN 保留 —
    // Number(undefined)=NaN 与 legacy 同款,JSON 边界落 null。
    for (const key of Object.keys(params)) {
        if (params[key] === undefined) {
            delete params[key];
        }
    }
    return params;
}

// —— novel ——

/** getTokenizerTypeForModel(nai-settings.js:636):模型名 → 本地 tokenizer 名;无等价 → null */
export function novelTokenizerNameForModel(model) {
    const m = String(model || '');
    if (m.includes('clio')) return 'nerdstash';
    if (m.includes('kayra')) return 'nerdstash_v2';
    if (m.includes('erato')) return 'llama3';
    return null;
}

/**
 * novel 编码器懒加载(与 createTextgenEncoder 同约定,但 llama3 必须走
 * web tokenizer —— getSentencepiceTokenizer('llama3') 会先命中 spp_llama,
 * 不能复用通用工厂)。加载失败 → encode [](前端失败跳过语义)。
 */
function createNovelEncoder(tokenizerName) {
    let pending = null;
    const load = () => pending ??= (async () => {
        try {
            if (tokenizerName === 'llama3') {
                const web = getWebTokenizer('llama3');
                const instance = await web?.get();
                return instance ? (text) => Array.from(instance.encode(text)) : null;
            }
            const spp = getSentencepiceTokenizer(tokenizerName);
            const instance = await spp?.get();
            return instance ? (text) => instance.encodeIds(text) : null;
        } catch (error) {
            console.warn(`textgen-body: novel tokenizer "${tokenizerName}" unavailable:`, error?.message ?? error);
        }
        return null;
    })();
    return async (text) => {
        const encoder = await load();
        return encoder ? encoder(text) : [];
    };
}

/** getBadWordPermutations(nai-settings.js:496):大小写/空格 10 变体 */
function getNovelBadWordPermutations(text) {
    const result = [
        text,
        ` ${text}`,
        text[0].toUpperCase() + text.slice(1),
        ` ${text[0].toUpperCase() + text.slice(1)}`,
        text[0].toLowerCase() + text.slice(1),
        ` ${text[0].toLowerCase() + text.slice(1)}`,
        text.toUpperCase(),
        ` ${text.toUpperCase()}`,
        text.toLowerCase(),
        ` ${text.toLowerCase()}`,
    ];
    return result.filter(onlyUnique);
}

/**
 * getBadWordIds(nai-settings.js:443)异步版:{v}→verbatim 编码、[ids]→
 * 原样 token id、裸文本→变体逐个编码。无服务端缓存层(badWordsCache
 * 前端层;banned_tokens 行数小,缓存收益≈0)。
 */
async function getNovelBadWordIds(bannedTokens, encodeText) {
    const result = [];
    for (const raw of String(bannedTokens ?? '').split('\n')) {
        const token = raw.trim();
        if (!token.length) continue;
        if (token.startsWith('{') && token.endsWith('}')) {
            result.push(await encodeText(token.slice(1, -1)));
        } else if (token.startsWith('[') && token.endsWith(']')) {
            try {
                const tokens = JSON.parse(token);
                if (Array.isArray(tokens) && tokens.every(t => Number.isInteger(t))) {
                    result.push(tokens);
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse bad word token list: ${token}`, err);
            }
        } else {
            for (const variant of getNovelBadWordPermutations(token)) {
                result.push(await encodeText(variant));
            }
        }
    }
    return result;
}

/**
 * getLogitBiasListResult(logit-bias.js:104)+ nai getBiasObject(:672)合体:
 * {text,value}[] → [{bias,sequence,ensure_sequence_finish:false,generate_once:false}]。
 */
async function getNovelLogitBiasExp(biasPreset, encodeText) {
    const result = [];
    const toBiasObject = (bias, sequence) => ({
        bias, sequence,
        ensure_sequence_finish: false,
        generate_once: false,
    });
    for (const entry of Array.isArray(biasPreset) ? biasPreset : []) {
        if (!(entry?.text?.length > 0)) continue;
        const text = String(entry.text).trim();
        if (!text.length) continue;
        if (text.startsWith('{') && text.endsWith('}')) {
            result.push(toBiasObject(entry.value, await encodeText(text.slice(1, -1))));
        } else if (text.startsWith('[') && text.endsWith(']')) {
            try {
                const tokens = JSON.parse(text);
                if (Array.isArray(tokens) && tokens.every(t => Number.isInteger(t))) {
                    result.push(toBiasObject(entry.value, tokens));
                } else {
                    throw new Error('Not an array of integers');
                }
            } catch (err) {
                console.log(`Failed to parse logit bias token list: ${text}`, err);
            }
        } else {
            result.push(toBiasObject(entry.value, await encodeText(` ${text}`)));
        }
    }
    return result;
}

/**
 * selectPrefix(nai-settings.js:704):新模型(clio/kayra/erato)按 prompt
 * 尾部 1500 字符含 '}' 判 instruct → 'special_instruct',否则用设置值;
 * 老模型恒 'vanilla'。
 */
export function selectNovelPrefix(selectedPrefix, finalPrompt, model) {
    const m = String(model || '');
    const isNewModel = m.includes('clio') || m.includes('kayra') || m.includes('erato');
    if (isNewModel) {
        // NAI 自称回看 1000 字符(非 token)找 instruct 括号 —— 前端给 1500 富余,照抄
        const tail = String(finalPrompt ?? '').slice(-1500);
        return tail.includes('}') ? 'special_instruct' : selectedPrefix;
    }
    return 'vanilla';
}

const NOVEL_DEFAULT_ORDER = [1, 5, 0, 2, 3, 4];
const NOVEL_MAXIMUM_OUTPUT_LENGTH = 150;
const NOVEL_MAX_STOP_SEQUENCES = 1024;

/**
 * getNovelGenerationData(nai-settings.js:524)服务端同构。
 * @param {object} input
 * @param {object} input.naiSettings settings.nai_settings
 * @param {object|null} [input.presetSettings] 'novel' 预设档(仅 order 兜底)
 * @param {string} input.prompt 组装好的单串 prompt(preamble 由调用方在转换时插入)
 * @param {string} input.model 已解析模型名(调用方:body.model ?? nai_settings.model_novel)
 * @param {number|undefined} input.maxLength amount_gen 同位量
 * @param {number} [input.maxResponseTokens] tier 响应上限(缺省 150=legacy
 *   maximum_output_length/无订阅数据兜底;Opus(tier3)调用方传 250)
 * @param {string} [input.type] 生成动词
 * @param {object} input.powerUser settings.power_user(num_logprobs 开关源)
 * @param {object} input.substCtx 宏上下文
 * @param {object} input.instructEngine core instruct 引擎
 * @param {Function} [input.encodeText] 测试注入位:text→token ids;缺省按
 *   model 解析(无匹配 tokenizer → 三处 id 数组恒 undefined/[])
 * @returns {Promise<object>} 派发体(不含 streaming/type/luker_generation;调用方补)
 */
export async function buildNovelDispatchBody({
    naiSettings, presetSettings, prompt, model,
    maxLength, type = 'normal',
    powerUser, substCtx, instructEngine,
    maxResponseTokens, encodeText,
}) {
    const settings = naiSettings ?? {};
    const subst = (content) => substituteParams(content, substCtx);
    const isImpersonate = type === 'impersonate';
    const isContinue = type === 'continue';
    const modelName = String(model ?? '');
    const isKayra = modelName.includes('kayra');
    const isErato = modelName.includes('erato');

    const tokenizerName = novelTokenizerNameForModel(modelName);
    const encode = encodeText ?? (tokenizerName ? createNovelEncoder(tokenizerName) : null);

    const stoppingStrings = buildStoppingStrings({
        powerUser, substCtx, instructEngine, subst, isImpersonate, isContinue,
    });

    // erato 追加标点变体(:534-551,llama3 tokenizer 下 '\nX:' 也要 '.\nX:' 等形)
    if (isErato) {
        const additional = [];
        for (const s of stoppingStrings) {
            if (typeof s === 'string' && s.startsWith('\n')) {
                for (const head of ['.', '!', '?', '*', '"', '_', '...', '."', '?"', '!"', '.*', ')']) {
                    additional.push(head + s);
                }
            }
        }
        stoppingStrings.push(...additional);
    }

    const stopSequences = encode
        ? await Promise.all(stoppingStrings.slice(0, NOVEL_MAX_STOP_SEQUENCES).map((s) => encode(s)))
        : undefined;
    const badWordIds = encode
        ? await getNovelBadWordIds(settings.banned_tokens, encode)
        : undefined;
    const logitBias = encode && Array.isArray(settings.logit_bias) && settings.logit_bias.length
        ? await getNovelLogitBiasExp(settings.logit_bias, encode)
        : [];

    const prefix = selectNovelPrefix(settings.prefix, prompt, modelName);

    let finalPrompt = String(prompt ?? '');
    if (isErato) {
        finalPrompt = '<|startoftext|><|reserved_special_token81|>' + finalPrompt;
    }

    const adjustedMaxLength = (isKayra || isErato)
        ? (maxResponseTokens ?? NOVEL_MAXIMUM_OUTPUT_LENGTH)
        : NOVEL_MAXIMUM_OUTPUT_LENGTH;

    const params = {
        'input': finalPrompt,
        'model': modelName,
        'use_string': true,
        'temperature': Number(settings.temperature),
        'max_length': (Number.isFinite(Number(maxLength)) ? Math.min(Number(maxLength), adjustedMaxLength) : adjustedMaxLength),
        'min_length': Number(settings.min_length),
        'tail_free_sampling': Number(settings.tail_free_sampling),
        'repetition_penalty': Number(settings.repetition_penalty),
        'repetition_penalty_range': Number(settings.repetition_penalty_range),
        'repetition_penalty_slope': Number(settings.repetition_penalty_slope),
        'repetition_penalty_frequency': Number(settings.repetition_penalty_frequency),
        'repetition_penalty_presence': Number(settings.repetition_penalty_presence),
        'top_a': Number(settings.top_a),
        'top_p': Number(settings.top_p),
        'top_k': Number(settings.top_k),
        'min_p': Number(settings.min_p),
        'math1_temp': Number(settings.math1_temp),
        'math1_quad': Number(settings.math1_quad),
        'math1_quad_entropy_scale': Number(settings.math1_quad_entropy_scale),
        'typical_p': Number(settings.typical_p),
        'mirostat_lr': Number(settings.mirostat_lr),
        'mirostat_tau': Number(settings.mirostat_tau),
        'phrase_rep_pen': settings.phrase_rep_pen,
        'stop_sequences': stopSequences,
        'bad_words_ids': badWordIds,
        'logit_bias_exp': logitBias,
        'generate_until_sentence': true,
        'use_cache': false,
        'return_full_text': false,
        'prefix': prefix,
        'order': settings.order || presetSettings?.order || NOVEL_DEFAULT_ORDER,
        'num_logprobs': powerUser?.request_token_probabilities ? 10 : undefined,
    };

    // undefined 不上行(与前端 JSON.stringify 语义一致)
    for (const key of Object.keys(params)) {
        if (params[key] === undefined) {
            delete params[key];
        }
    }
    return params;
}
