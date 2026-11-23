/**
 * connection-dispatch —— 连接配置档案制(profile-based connection)核心。
 *
 * 数据模型(oai_settings 内,免动 PATCHABLE 白名单):
 *   oai_settings.connection_profiles: ConnectionProfile[]
 *     { id, name, format: 'openai'|'anthropic', baseUrl, secretId,
 *       models: { checked, manual, lastProbe? }, disabled? }
 *   oai_settings.connection: { activeModel: { profileId, modelId } | null }
 *
 * 派发映射(写线键零改动 —— profile 翻译成既有 oai 形覆盖袋):
 *   format=openai     → chat_completion_source 'custom',url 走 custom_url,
 *                        key 走 api_key_custom 池
 *   format=anthropic  → chat_completion_source 'claude',url 走 reverse_proxy
 *                        (空 = 官方默认端点),key 走 api_key_claude 池
 * anti-bleed(参考 public/scripts/extensions/connection-manager/profile-resolver.js
 * buildApiSettingsOverrideFromProfile):另一格式不用的键恒写空串 ——
 * oai_settings 里 legacy custom_url/reverse_proxy/base_url/proxy_password
 * 经 includeConnection 全量透传,不显式压空会漏进 profile 请求。
 *
 * 三处派发点(/api/utopinn/generate、trigger-generation、quiet-generation)
 * 共用 resolveConnectionDispatch:命中 profile → 覆盖袋;未命中(旧客户端/
 * CLI 无 profile_id)→ 完全走旧单槽路径,存量行为不变。
 */
import { SecretManager, SECRET_KEYS, resolveProviderSecretDetailed } from '../endpoints/secrets.js';

/**
 * 连接层字段:URL/密钥代理/模型名/自定义进出体 + source。
 * 这些产品语义上属"当前连接配置"而非"生成预设"——ST 选预设会整体重写
 * oai_settings(连 URL 一起洗掉是出名的坑),我们把连接面固定在
 * settings.oai_settings,preset 只贡献生成参数。
 * connection_profiles/connection/profile_id 同列:预设档不许串载 profile。
 */
export const CONNECTION_KEYS = new Set([
    'chat_completion_source', 'reverse_proxy', 'proxy_password',
    'custom_url', 'custom_model', 'custom_include_body',
    'custom_exclude_body', 'custom_include_headers',
    'chat_completion_custom_models', 'show_external_models',
    'kimi_partial_name_source',
    'openrouter_group_models', 'openrouter_sort_models',
    'chutes_sort_models', 'electronhub_sort_models', 'electronhub_group_models',
    'connection_profiles', 'connection', 'profile_id',
]);

/**
 * presetDoc → chat-completions 派发 body 参数段(透传生成参数,
 * 与前端发往 /generate 的 oai_settings 子集同构)。
 * 从 utopinn-generate.js 迁入(那边只剩 re-export,避免 service→plugin 环)。
 */
export function presetToDispatchParams(presetDoc, { includeConnection = false } = {}) {
    const d = presetDoc ?? {};
    const passthrough = {};
    for (const [k, v] of Object.entries(d)) {
        // model 是 wire 键不是设置键——oai_settings.model 是历史镜像残留,
        // 透传会让 ??= 永远不触达 {source}_model/custom_model 的正典解析
        // (getChatCompletionModel 同义),换源/换模型被旧值静默顶住。
        if (['prompts', 'prompt_order', 'extensions', 'model'].includes(k)) continue;
        if (!includeConnection && CONNECTION_KEYS.has(k)) continue;
        passthrough[k] = v;
    }
    return passthrough;
}

/* ------------------------------------------------------------------ */
/* profile 模型                                                        */
/* ------------------------------------------------------------------ */

export const PROFILE_FORMATS = Object.freeze(['openai', 'anthropic']);

/** format → 派发 source(custom = OpenAI 兼容面;claude = Anthropic 面)。 */
export const FORMAT_TO_SOURCE = Object.freeze({ openai: 'custom', anthropic: 'claude' });

/** format → secrets 池(secret_id 查找域是按池的,跨池引用解不到)。 */
export const FORMAT_TO_SECRET_KEY = Object.freeze({
    openai: SECRET_KEYS.CUSTOM,
    anthropic: SECRET_KEYS.CLAUDE,
});

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const strArr = (v) => Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))] : [];

/**
 * oai_settings.connection_profiles → 归一化 profile[](脏字段容错:
 * 非对象条/空 id 整条丢;格式不识 → 'openai';models 三槽归位)。
 */
export function readConnectionProfiles(oaiSettings) {
    const oai = (oaiSettings && typeof oaiSettings === 'object' && !Array.isArray(oaiSettings)) ? oaiSettings : {};
    const raw = Array.isArray(oai.connection_profiles) ? oai.connection_profiles : [];
    const out = [];
    for (const p of raw) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
        const id = str(p.id);
        if (!id) continue;
        const models = (p.models && typeof p.models === 'object' && !Array.isArray(p.models)) ? p.models : {};
        const lp = (models.lastProbe && typeof models.lastProbe === 'object' && !Array.isArray(models.lastProbe)) ? models.lastProbe : null;
        out.push({
            id,
            name: str(p.name) || id,
            format: PROFILE_FORMATS.includes(p.format) ? p.format : 'openai',
            baseUrl: str(p.baseUrl),
            secretId: str(p.secretId) || null,
            models: {
                checked: strArr(models.checked),
                manual: strArr(models.manual),
                ...(lp ? {
                    lastProbe: {
                        at: Number(lp.at) || 0,
                        ok: !!lp.ok,
                        items: (Array.isArray(lp.items) ? lp.items : [])
                            .map((m) => ({ id: str(m?.id) || str(m) })).filter((m) => m.id),
                    },
                } : {}),
            },
            ...(p.disabled ? { disabled: true } : {}),
        });
    }
    return out;
}

/** connection.activeModel 指针归一化(不校验 profileId 是否实存)。 */
export function readActiveModel(oaiSettings) {
    const conn = (oaiSettings?.connection && typeof oaiSettings.connection === 'object' && !Array.isArray(oaiSettings.connection))
        ? oaiSettings.connection : {};
    const am = (conn.activeModel && typeof conn.activeModel === 'object' && !Array.isArray(conn.activeModel)) ? conn.activeModel : {};
    const profileId = str(am.profileId);
    const modelId = str(am.modelId);
    return (profileId && modelId) ? { profileId, modelId } : null;
}

/**
 * 本次请求生效的 profile:
 *   body.profile_id 显式指档(必须命中未停用档,点名落空 → null 不猜别档)
 *   > connection.activeModel.profileId 指针(悬/停用 → 顺延首个未停用档)
 *   > 无指针 → 首个未停用档(有档才兜底 —— quiet/trigger/CLI 无 profile_id
 *     调用与 web 兜底选择同语义;全停用/无档 → null 走旧单槽)。
 */
export function resolveActiveProfile(oaiSettings, body = {}) {
    const profiles = readConnectionProfiles(oaiSettings);
    if (!profiles.length) return null;
    const explicit = str(body.profile_id);
    if (explicit) return profiles.find((p) => p.id === explicit && !p.disabled) ?? null;
    const wanted = str(readActiveModel(oaiSettings)?.profileId);
    if (wanted) {
        const hit = profiles.find((p) => p.id === wanted && !p.disabled);
        if (hit) return hit;
    }
    return profiles.find((p) => !p.disabled) ?? null;
}

/** profile → oai 形覆盖袋(anti-bleed:另一格式不用的键恒写空串)。 */
export function profileDispatchBag(profile, model) {
    const isOpenai = profile.format !== 'anthropic';
    return {
        chat_completion_source: FORMAT_TO_SOURCE[isOpenai ? 'openai' : 'anthropic'],
        custom_url: isOpenai ? profile.baseUrl : '',
        reverse_proxy: isOpenai ? '' : profile.baseUrl,
        base_url: '',
        proxy_password: '',
        secret_id: profile.secretId || '',
        profile_id: profile.id,
        model: model || null,
    };
}

/**
 * 连接派发段统一解析 —— 三处派发点共用:
 *   命中 profile → base(oai 全量+预设参数)上压覆盖袋,model 兜底序
 *     body.model → connection.activeModel.modelId → checked[0] → manual[0];
 *   未命中 → 旧单槽路径原样(source 解析 + {src}_model 模型解析,
 *     与修前三份同构代码逐字等价)。
 * @returns {{ body: object, profile: object|null }} body 直接展开进派发体。
 */
export function resolveConnectionDispatch(oaiSettings, presetDoc, body = {}) {
    const base = {
        ...presetToDispatchParams(oaiSettings, { includeConnection: true }),
        ...presetToDispatchParams(presetDoc),
    };
    const prof = resolveActiveProfile(oaiSettings, body);
    if (prof) {
        const model = str(body.model)
            || str(readActiveModel(oaiSettings)?.modelId)
            || prof.models.checked[0]
            || prof.models.manual[0]
            || null;
        Object.assign(base, profileDispatchBag(prof, model));
        return { body: base, profile: prof };
    }
    const chatSource = str(body.chat_completion_source)
        || str(oaiSettings?.chat_completion_source)
        || str(presetDoc?.chat_completion_source) || 'openai';
    base.chat_completion_source = chatSource;
    const connModel = oaiSettings?.[`${chatSource}_model`];
    base.model = (typeof connModel === 'string' && connModel.trim() ? connModel.trim() : null)
        ?? base[`${chatSource}_model`]
        ?? null;
    return { body: base, profile: null };
}

/* ------------------------------------------------------------------ */
/* 迁移:旧单槽 → 合成 'default' profile                                 */
/* ------------------------------------------------------------------ */

/**
 * 具名生态源 → 官方端点(openai 兼容面,custom_url 物化值;
 * custom 源必填 url,claude 源空 = 官方默认)。reverse_proxy/base_url 恒优先。
 */
const LEGACY_SOURCE_DEFAULT_URL = Object.freeze({
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    moonshot: 'https://api.moonshot.ai/v1',
    groq: 'https://api.groq.com/openai/v1',
    mistralai: 'https://api.mistral.ai/v1',
    xai: 'https://api.x.ai/v1',
    siliconflow: 'https://api.siliconflow.com/v1',
    aimlapi: 'https://api.aimlapi.com/v1',
    chutes: 'https://llm.chutes.ai/v1',
    electronhub: 'https://api.electronhub.ai/v1',
    nanogpt: 'https://nano-gpt.com/api/v1',
    cometapi: 'https://api.cometapi.com/v1',
});

const LEGACY_SOURCE_LABEL = Object.freeze({
    openai: 'OpenAI', deepseek: 'DeepSeek', openrouter: 'OpenRouter',
    moonshot: 'Moonshot', groq: 'Groq', mistralai: 'Mistral', xai: 'xAI',
    siliconflow: 'SiliconFlow', aimlapi: 'AIMLAPI', chutes: 'Chutes',
    electronhub: 'ElectronHub', nanogpt: 'NanoGPT',
    claude: 'Anthropic', custom: 'Custom',
});

/**
 * 可干净映射到 profile 两格式面的 legacy 源:
 *   openai 格式(custom 派发面)= 纯 OpenAI-chat-completions 线形 +
 *   官方端点可物化的生态源;
 *   anthropic 格式(claude 派发面)= claude。
 * 特殊派发源(上游派发器自备端点/异构线形/禁用中上游)不在列:
 *   fireworks/makersuite/vertexai/azure_openai/workers_ai/pollinations/
 *   cohere/openai_responses/cometapi —— 合成档会直接断链或改线形,
 *   这些源恒走 legacy 路,不合成不激活。
 */
const LEGACY_MAPPABLE_SOURCES = new Set([
    'openai', 'deepseek', 'mistralai', 'openrouter', 'moonshot', 'groq',
    'xai', 'aimlapi', 'siliconflow', 'chutes', 'electronhub', 'nanogpt',
    'custom', 'claude',
]);

/**
 * 从旧单槽 oai_settings 合成 id='default' 的 profile;不可干净迁移 → null。
 * 不迁移判据(任一命中 → 留 legacy,不合成不激活):
 *   - src 不在 LEGACY_MAPPABLE_SOURCES(特殊派发源/禁用中上游);
 *   - proxy_password 非空 —— 凭据在字段层不在 secrets 池,profile 模型无对应槽;
 *   - 凭证解析落在 shared 层 —— 共享档是公共资源,绝不拷进个人档。
 * secret:个人池 api_key_<src> 的解析值 —— 目标池同池(claude/custom)直接引
 * active 条目 id;跨池(openai/deepseek/…→api_key_custom)复制明文一条
 * **非 active** 新条目(readSecret 按 id 读不查 active;不抢目标池 active 槽,
 * 旧路径与其它档的 fallback 凭证不变)。旧键一律不删,作 fallback。
 * @param {object} oai oai_settings(可为空)
 * @param {{ directories?: object, request?: object }} [ctx]
 *          request 供 resolveProviderSecretDetailed 分层判据(shared → 不迁移);
 *          缺省只查个人池,shared 判据降级跳过(保守 = 仍迁移但 secretId 空)。
 */
export function synthesizeLegacyProfile(oai, { directories = null, request = null } = {}) {
    const src = str(oai?.chat_completion_source);
    const isClaude = src === 'claude';
    const format = isClaude ? 'anthropic' : 'openai';
    const targetPool = FORMAT_TO_SECRET_KEY[format];
    const srcSecretKey = src ? `api_key_${src}` : '';

    /* 特殊派发源(fireworks/vertexai/azure/…)无干净线形映射 —— 留 legacy。 */
    if (src && !LEGACY_MAPPABLE_SOURCES.has(src)) return null;
    /* 字段层凭据(profile 无 proxy_password 槽)→ 不迁移。 */
    if (str(oai?.proxy_password)) return null;

    let baseUrl = '';
    if (isClaude) {
        baseUrl = str(oai?.reverse_proxy) || str(oai?.base_url); // 空 = 官方默认端点
    } else if (src === 'custom') {
        baseUrl = str(oai?.custom_url);
    } else {
        baseUrl = str(oai?.reverse_proxy) || str(oai?.base_url) || LEGACY_SOURCE_DEFAULT_URL[src] || '';
    }

    const legacyModel = str(oai?.[`${src || 'openai'}_model`]);
    let secretId = null;
    if (srcSecretKey && Object.values(SECRET_KEYS).includes(srcSecretKey)) {
        try {
            if (request) {
                /* 分层判据:shared 层生效 → 共享凭证不拷进个人档,不迁移。 */
                const det = resolveProviderSecretDetailed(request, srcSecretKey);
                if (det.source === 'shared') return null;
                if (det.source === 'user' && det.value && directories) {
                    const mgr = new SecretManager(directories);
                    const entries = mgr.getAllSecrets()[srcSecretKey] ?? [];
                    const active = entries.find((e) => e.active) ?? entries[0];
                    secretId = (srcSecretKey === targetPool && active?.value === det.value)
                        ? active.id
                        : mgr.writeSecret(targetPool, det.value, `migrated:${src}`, { activate: false });
                }
            } else if (directories) {
                const mgr = new SecretManager(directories);
                const entries = mgr.getAllSecrets()[srcSecretKey] ?? [];
                const active = entries.find((e) => e.active) ?? entries[0];
                if (active?.value) {
                    secretId = (srcSecretKey === targetPool)
                        ? active.id
                        : mgr.writeSecret(targetPool, active.value, `migrated:${src}`, { activate: false });
                }
            }
        } catch { /* secrets 面不可达 → secretId=null,档占位照常出 */ }
    }

    return {
        id: 'default',
        name: LEGACY_SOURCE_LABEL[src] ?? (src || 'Default'),
        format,
        baseUrl,
        secretId,
        models: { checked: legacyModel ? [legacyModel] : [], manual: [] },
    };
}

/**
 * GET profiles 的惰性迁移入口:connection_profiles 键缺失 → 合成 default
 * 并整档落盘(旧键不动);同时补 connection.activeModel 指针(仅当为空且
 * 能解析出模型)。**键在值为 [] 是显式空态**(用户删光了档),不重合成 —
 * 与「不可迁移源合成 null 不落盘」区分:后者键保持缺失,每次 GET 重估
 * (换到可映射源后即迁)。
 * 返 { profiles, activeModel, migrated }。
 */
export async function ensureConnectionProfiles(request, settingsRepo) {
    const handle = request.user.profile.handle;
    const doc = await settingsRepo.get(handle) ?? {};
    const oai = (doc.oai_settings && typeof doc.oai_settings === 'object' && !Array.isArray(doc.oai_settings))
        ? doc.oai_settings : {};
    // 显式空数组/已有档 → 如实回;只有键缺失才走迁移。
    if (Array.isArray(oai.connection_profiles)) {
        return { profiles: readConnectionProfiles(oai), activeModel: readActiveModel(oai), migrated: false };
    }

    const synth = synthesizeLegacyProfile(oai, { directories: request.user?.directories, request });
    if (!synth) {
        // 不可干净迁移(特殊源/字段层凭据/shared 层凭证)—— 键不落,下次重估。
        return { profiles: [], activeModel: readActiveModel(oai), migrated: false };
    }
    const next = await settingsRepo.update(handle, (base) => {
        const d = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
        const o = (d.oai_settings && typeof d.oai_settings === 'object' && !Array.isArray(d.oai_settings))
            ? { ...d.oai_settings } : {};
        // 并发竞态:期间被删成显式 [] → 不写回(尊重删光语义)。
        if (!Array.isArray(o.connection_profiles)) {
            o.connection_profiles = [synth];
            // activeModel 只在空槽时补针 —— 不覆盖用户显式选择。
            const conn = (o.connection && typeof o.connection === 'object' && !Array.isArray(o.connection)) ? { ...o.connection } : {};
            if (!readActiveModel(o)) {
                const modelId = synth.models.checked[0] ?? synth.models.manual[0];
                if (modelId) conn.activeModel = { profileId: 'default', modelId };
            }
            o.connection = conn;
        }
        d.oai_settings = o;
        return d;
    });
    const nextOai = (next.oai_settings && typeof next.oai_settings === 'object' && !Array.isArray(next.oai_settings))
        ? next.oai_settings : {};
    const profiles = readConnectionProfiles(nextOai);
    return { profiles, activeModel: readActiveModel(nextOai), migrated: true };
}

/**
 * PUT body → 归一化 profile(upsert 写面)。不接受的字段丢;
 * format 非枚举 → 'openai';name 空 → 沿用旧名/兜 'Profile'。
 */
export function sanitizeProfileInput(input, { existing = null, id } = {}) {
    const b = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const format = PROFILE_FORMATS.includes(b.format) ? b.format : (existing?.format ?? 'openai');
    const models = (b.models && typeof b.models === 'object' && !Array.isArray(b.models)) ? b.models : {};
    const existingModels = existing?.models ?? { checked: [], manual: [] };
    return {
        id,
        name: str(b.name) || existing?.name || 'Profile',
        format,
        baseUrl: b.baseUrl !== undefined ? str(b.baseUrl) : (existing?.baseUrl ?? ''),
        secretId: b.secretId !== undefined ? (str(b.secretId) || null) : (existing?.secretId ?? null),
        models: {
            checked: b.models !== undefined ? strArr(models.checked) : existingModels.checked,
            manual: b.models !== undefined ? strArr(models.manual) : existingModels.manual,
            ...(existingModels.lastProbe ? { lastProbe: existingModels.lastProbe } : {}),
        },
        ...(b.disabled !== undefined ? { disabled: !!b.disabled } : (existing?.disabled ? { disabled: true } : {})),
    };
}
