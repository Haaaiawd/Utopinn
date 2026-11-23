/**
 * utopinn-connection —— kernel 插件:上游连接探测 + 模型清单面(§C 补件)。
 *
 *   POST /api/utopinn/connection/test   前端"连接测试"钮的后端面。
 *   GET  /api/utopinn/models            上游模型清单(30s 内存缓存防连点;?fresh=1 绕过)。
 *
 * 连接配置源 = settings.oai_settings(当前生效),键形与 legacy
 * POST /api/backends/chat-completions/status 的 request.body 同构——
 * source→base url/key/headers/query 的解析与 /status 逐支对齐:同一批
 * API_* 常量 + normalizeProviderBaseUrl + resolveProviderSecret(四层:
 * proxy_password > secret_id 槽 > 本人 active > 共享档 ACL;TASK-072)+
 * mergeObjectWithYaml(custom_include_headers 与真实派发同构,宏不预替换)。
 * 密钥只用于上行 Authorization/x-api-key/api-key,绝不回显,也不进 diag。
 * body/query 只放行 secret_id(选密钥槽);URL 覆盖不开——
 * 这面读"生效配置",不是任意 URL 探针。
 *
 * test 契约:{ok, source, credential, latencyMs, modelCount?, upstreamStatus, error?, detail?}
 *   credential ∈ user | shared | proxy | none —— 哪层凭据在生效(§2.4)。
 *   error ∈ not_configured | unreachable | timeout | auth_failed | http_error | unsupported
 *   upstreamStatus = 上游应答的 HTTP 状态;未触达(网络/超时/未配置)为 null。
 * models 契约:{items:[{id, owned_by?}], source, credential, stale?, error?, upstreamStatus?}
 *   探测失败且有既往成功结果 → 回 stale:true + 上次 items(比空表有用)。
 */
import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import {
    AIMLAPI_HEADERS,
    CHAT_COMPLETION_SOURCES,
    OPENROUTER_HEADERS,
    POLLINATIONS_ENDPOINT,
    SILICONFLOW_ENDPOINT,
} from '../constants.js';
import { getConfigValue, mergeObjectWithYaml, trimTrailingSlash } from '../util.js';
import { normalizeProviderBaseUrl } from '../util/base-url.js';
import { resolveProviderSecretDetailed, SECRET_KEYS } from '../endpoints/secrets.js';
import { getVertexAIAuth } from '../endpoints/google.js';
import { fetchGoogleModels } from '../endpoints/backends/google-models.js';
import { buildVertexModelsUrl, fetchVertexModels } from '../endpoints/backends/vertex-models.js';
import { getSettingsRepo } from '../storage/index.js';
import { emit as diagEmit } from '../services/diag-bus.js';
import { sendError } from './_shared/http-utils.js';
import {
    ensureConnectionProfiles,
    readConnectionProfiles,
    readActiveModel,
    sanitizeProfileInput,
    profileDispatchBag,
    PROFILE_FORMATS,
} from '../services/connection-dispatch.js';
import { uuidv4 } from '../util.js';

export const inject = ['webServer'];

// 与 endpoints/backends/chat-completions.js 同值的默认端点(那边是模块私常量,
// 只能照抄;source→secret/url 的映射必须与 /status 保持同步漂移)。
const API_OPENAI = 'https://api.openai.com/v1';
const API_CLAUDE = 'https://api.anthropic.com/v1';
const API_MISTRAL = 'https://api.mistral.ai/v1';
const API_COHERE_V1 = 'https://api.cohere.ai/v1';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';
const API_CHUTES = 'https://llm.chutes.ai/v1';
const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_DEEPSEEK = 'https://api.deepseek.com/beta';
const API_XAI = 'https://api.x.ai/v1';
const API_AIMLAPI = 'https://api.aimlapi.com/v1';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_COMETAPI = 'https://api.cometapi.com/v1';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';
const API_SILICONFLOW_CN = 'https://api.siliconflow.cn/v1';
const API_WORKERS_AI = 'https://api.cloudflare.com/client/v4/accounts';
const FIREWORKS_MODELS_URL = 'https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200';

const PROBE_TIMEOUT_MS = 8_000;
const MODELS_CACHE_MS = 30_000;

/** 探针分类错误:error 是契约分类码,status 是上游 HTTP 状态(可空)。 */
class ProbeError extends Error {
    constructor(error, { status = null, detail = '' } = {}) {
        super(detail || error);
        this.error = error;
        this.status = status;
    }
}

/** node-fetch + 8s 超时(与真实派发同库);makersuite/vertexai 的分页 helper 也走它。 */
const probeFetch = (url, options = {}) => fetch(url, {
    ...options,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
});

function httpStatusToProbeError(status, statusText = '') {
    const detail = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
    return new ProbeError(
        status === 401 || status === 403 ? 'auth_failed' : 'http_error',
        { status, detail },
    );
}

/** 任意异常 → 契约分类码。ProbeError 直通;带 status 的 helper 错误按 HTTP 归类。 */
function classifyProbeError(e) {
    if (e instanceof ProbeError) return e;
    const status = Number(e?.status ?? e?.statusCode ?? 0) || null;
    if (status) return httpStatusToProbeError(status, e?.statusText || e?.message || '');
    const name = String(e?.name ?? e?.type ?? '');
    const code = String(e?.code ?? e?.cause?.code ?? '');
    if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR'
        || code === 'ETIMEDOUT' || /timed?\s*out/i.test(String(e?.message ?? ''))) {
        return new ProbeError('timeout', { detail: String(e?.message ?? e) });
    }
    return new ProbeError('unreachable', { detail: String(e?.message ?? e) });
}

/**
 * source→{apiUrl, apiKey, headers, queryParams, kind, credential} 解析 ——
 * endpoints/backends/chat-completions.js /status 的逐支镜像。
 * kind: 'openai'(通用 GET {apiUrl}/models)| claude | fireworks | makersuite |
 *       vertexai | azure | workers_ai | disabled | unsupported。
 * credential ∈ 'proxy'|'user'|'shared'|'none'(TASK-072):哪层凭据在生效 —
 *   proxy_password 显式压resolver 时 'proxy';resolver 分到的层(user 槽/
 *   user active/shared ACL)如实标;没凭据 'none'。anonymous pollinations
 *   不算凭据,归 'none'。
 * missing[] 收集 not_configured 的缺件(api_key / custom_url / …)。
 */
function resolveConnection(request, body) {
    const source = String(body.chat_completion_source || CHAT_COMPLETION_SOURCES.OPENAI);
    const conn = {
        source, kind: 'openai', marker: '', credential: 'none',
        apiUrl: '', apiKey: '', headers: {}, queryParams: {}, missing: [],
    };
    // resolver 分层 + proxy_password 覆盖的一次性分类:
    //   hasProxy=true(该 source 的 /status 支吃 proxy_password)→ proxy 优先;
    //   否则直接取 resolver 的 {value,source}。source='none' 即值空。
    const pick = (key, { proxy = false } = {}) => {
        if (proxy && body.proxy_password) {
            conn.credential = 'proxy';
            return body.proxy_password;
        }
        const d = resolveProviderSecretDetailed(request, key);
        conn.credential = d.source;
        return d.value || '';
    };
    // 通用族缺钥判定(/status L920 同款):有 key 或自定义 base/proxy 即视为可探。
    const genericMissingCheck = () => {
        if (!conn.apiKey && !body.base_url && !body.reverse_proxy && source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            conn.missing.push('api_key');
        }
    };

    switch (source) {
        case CHAT_COMPLETION_SOURCES.OPENAI:
            conn.apiUrl = normalizeProviderBaseUrl('openai', body.reverse_proxy || body.base_url || API_OPENAI);
            conn.apiKey = pick(SECRET_KEYS.OPENAI, { proxy: true });
            break;
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            conn.apiUrl = 'https://openrouter.ai/api/v1';
            conn.apiKey = pick(SECRET_KEYS.OPENROUTER);
            conn.headers = { ...OPENROUTER_HEADERS };
            break;
        case CHAT_COMPLETION_SOURCES.MISTRALAI:
            conn.apiUrl = normalizeProviderBaseUrl('mistral', body.reverse_proxy || body.base_url || API_MISTRAL);
            conn.apiKey = pick(SECRET_KEYS.MISTRALAI, { proxy: true });
            break;
        case CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES:
            conn.apiUrl = normalizeProviderBaseUrl('openai_responses', body.responses_url || 'https://api.openai.com/v1');
            conn.apiKey = pick(SECRET_KEYS.OPENAI_RESPONSES, { proxy: true });
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.CUSTOM:
            conn.apiUrl = normalizeProviderBaseUrl('custom', body.custom_url);
            conn.apiKey = pick(SECRET_KEYS.CUSTOM);
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.COHERE:
            conn.apiUrl = API_COHERE_V1;
            conn.apiKey = pick(SECRET_KEYS.COHERE);
            break;
        case CHAT_COMPLETION_SOURCES.CHUTES:
            conn.apiUrl = API_CHUTES;
            conn.apiKey = pick(SECRET_KEYS.CHUTES);
            break;
        case CHAT_COMPLETION_SOURCES.ELECTRONHUB:
            conn.apiUrl = API_ELECTRONHUB;
            conn.apiKey = pick(SECRET_KEYS.ELECTRONHUB);
            break;
        case CHAT_COMPLETION_SOURCES.NANOGPT:
            conn.apiUrl = API_NANOGPT;
            conn.apiKey = pick(SECRET_KEYS.NANOGPT);
            conn.queryParams = { detailed: true };
            break;
        case CHAT_COMPLETION_SOURCES.DEEPSEEK:
            conn.apiUrl = normalizeProviderBaseUrl('deepseek', body.reverse_proxy || body.base_url || API_DEEPSEEK.replace('/beta', ''));
            conn.apiKey = pick(SECRET_KEYS.DEEPSEEK, { proxy: true });
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.XAI:
            conn.apiUrl = normalizeProviderBaseUrl('xai', body.reverse_proxy || body.base_url || API_XAI);
            conn.apiKey = pick(SECRET_KEYS.XAI, { proxy: true });
            break;
        case CHAT_COMPLETION_SOURCES.AIMLAPI:
            conn.apiUrl = API_AIMLAPI;
            conn.apiKey = pick(SECRET_KEYS.AIMLAPI);
            conn.headers = { ...AIMLAPI_HEADERS };
            break;
        case CHAT_COMPLETION_SOURCES.POLLINATIONS: {
            const isAnonymous = body.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS;
            conn.apiUrl = 'https://gen.pollinations.ai/text';
            conn.apiKey = isAnonymous ? 'anonymous' : pick(SECRET_KEYS.POLLINATIONS);
            if (!isAnonymous) conn.credential = conn.apiKey ? conn.credential : 'none';
            break;
        }
        case CHAT_COMPLETION_SOURCES.GROQ:
            conn.apiUrl = API_GROQ;
            conn.apiKey = pick(SECRET_KEYS.GROQ);
            break;
        case CHAT_COMPLETION_SOURCES.COMETAPI:
            conn.apiUrl = API_COMETAPI;
            conn.apiKey = pick(SECRET_KEYS.COMETAPI);
            conn.kind = 'disabled'; // /status: throw 'This provider is temporarily disabled.'
            return conn;
        case CHAT_COMPLETION_SOURCES.MOONSHOT:
            conn.apiUrl = normalizeProviderBaseUrl('moonshot', body.reverse_proxy || body.base_url || API_MOONSHOT);
            conn.apiKey = pick(SECRET_KEYS.MOONSHOT, { proxy: true });
            break;
        case CHAT_COMPLETION_SOURCES.SILICONFLOW:
            conn.apiUrl = body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN ? API_SILICONFLOW_CN : API_SILICONFLOW;
            conn.apiKey = pick(SECRET_KEYS.SILICONFLOW);
            conn.queryParams = { type: 'text', sub_type: 'chat' };
            break;
        case CHAT_COMPLETION_SOURCES.CLAUDE:
            conn.kind = 'claude';
            conn.apiUrl = normalizeProviderBaseUrl('claude', body.reverse_proxy || body.base_url || API_CLAUDE);
            conn.apiKey = pick(SECRET_KEYS.CLAUDE, { proxy: true });
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.FIREWORKS:
            conn.kind = 'fireworks';
            conn.apiKey = pick(SECRET_KEYS.FIREWORKS);
            conn.marker = 'fireworks';
            if (!conn.apiKey) conn.missing.push('api_key');
            return conn;
        case CHAT_COMPLETION_SOURCES.MAKERSUITE:
            conn.kind = 'makersuite';
            conn.apiKey = pick(SECRET_KEYS.MAKERSUITE, { proxy: true });
            conn.apiUrl = normalizeProviderBaseUrl('makersuite', body.reverse_proxy || body.base_url || API_MAKERSUITE);
            if (!conn.apiKey && !body.base_url && !body.reverse_proxy) conn.missing.push('api_key');
            return conn;
        case CHAT_COMPLETION_SOURCES.VERTEXAI: {
            conn.kind = 'vertexai';
            conn.marker = `vertexai|${body.vertexai_auth_mode || 'express'}|${body.vertexai_region || ''}|${body.reverse_proxy || body.base_url || ''}`;
            // credential 粗分:getVertexAIAuth 以 reverse_proxy 命中 proxy 支
            // (authType 'proxy' / Bearer proxy_password);否则 express/full 走
            // resolver 分层(google.js 已切 resolver,凭据同源)。
            const mode = String(body.vertexai_auth_mode || 'express');
            if (body.reverse_proxy) {
                conn.credential = 'proxy';
            } else {
                conn.credential = resolveProviderSecretDetailed(
                    request,
                    mode === 'full' ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS.VERTEXAI,
                ).source;
            }
            return conn; // 凭据在 exec 内 getVertexAIAuth 解析(express key / service account / proxy)
        }
        case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: {
            conn.kind = 'azure';
            conn.apiKey = pick(SECRET_KEYS.AZURE_OPENAI);
            conn.marker = `azure|${body.azure_base_url || ''}|${body.azure_api_version || ''}`;
            if (!conn.apiKey) conn.missing.push('api_key');
            if (!body.azure_base_url) conn.missing.push('azure_base_url');
            if (!body.azure_api_version) conn.missing.push('azure_api_version');
            return conn;
        }
        case CHAT_COMPLETION_SOURCES.WORKERS_AI: {
            conn.kind = 'workers_ai';
            conn.apiKey = pick(SECRET_KEYS.WORKERS_AI);
            conn.marker = `workers_ai|${body.workers_ai_account_id || ''}`;
            if (!conn.apiKey) conn.missing.push('api_key');
            if (!String(body.workers_ai_account_id || '').trim()) conn.missing.push('workers_ai_account_id');
            return conn;
        }
        default:
            conn.kind = 'unsupported'; // /status 同名单(ai21/perplexity/zai/minimax/…)无模型面
            return conn;
    }

    genericMissingCheck();
    if (!conn.apiUrl) conn.missing.push(source === CHAT_COMPLETION_SOURCES.CUSTOM ? 'custom_url' : 'base_url');
    return conn;
}

/** 上游原始 data → {id, owned_by?}[];各家异构响应在此归一(/status 响应塑形同款)。 */
function extractModels(source, data) {
    const pick = (arr, idOf) => arr
        .map(m => {
            const id = String(idOf(m) ?? '').trim();
            return id ? { id, ...(m?.owned_by ? { owned_by: m.owned_by } : {}) } : null;
        })
        .filter(Boolean);
    if (Array.isArray(data?.data)) return pick(data.data, m => m?.id);
    if (source === CHAT_COMPLETION_SOURCES.COHERE && Array.isArray(data?.models)) {
        return pick(data.models, m => m?.name);
    }
    if (source === CHAT_COMPLETION_SOURCES.POLLINATIONS && Array.isArray(data)) {
        return pick(data, m => m?.name ?? m?.id);
    }
    return [];
}

/** fireworks 的 fast router 复刻 —— /status 同款附加条目,可选模型即算数。 */
const FIREWORKS_FAST_ROUTERS = {
    'accounts/fireworks/models/glm-5p2': 'accounts/fireworks/routers/glm-5p2-fast',
    'accounts/fireworks/models/kimi-k2p6': 'accounts/fireworks/routers/kimi-k2p6-fast',
    'accounts/fireworks/models/kimi-k2p7-code': 'accounts/fireworks/routers/kimi-k2p7-code-fast',
    'accounts/fireworks/models/kimi-k3': 'accounts/fireworks/routers/kimi-k3-fast',
};

function assertHttpUrl(url, field) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
        throw new ProbeError('not_configured', { detail: `${field} is not a valid http(s) url` });
    }
}

/** 分类后的上游模型探针:返 {status, items};失败抛 ProbeError。 */
async function probeModels(request, conn, body) {
    switch (conn.kind) {
        case 'openai': {
            assertHttpUrl(conn.apiUrl, 'base_url');
            const modelsUrl = new URL(urlJoin(conn.apiUrl, '/models'));
            for (const [k, v] of Object.entries(conn.queryParams)) modelsUrl.searchParams.append(k, v);
            const res = await probeFetch(modelsUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${conn.apiKey}`, ...conn.headers },
            });
            if (!res.ok) throw httpStatusToProbeError(res.status, res.statusText);
            return { status: res.status, items: extractModels(conn.source, await res.json()) };
        }
        case 'claude': {
            assertHttpUrl(conn.apiUrl, 'base_url');
            const res = await probeFetch(`${trimTrailingSlash(conn.apiUrl)}/models`, {
                method: 'GET',
                headers: {
                    'anthropic-version': '2023-06-01',
                    ...(conn.apiKey ? { 'x-api-key': conn.apiKey } : {}),
                    ...conn.headers,
                },
            });
            if (!res.ok) throw httpStatusToProbeError(res.status, res.statusText);
            return { status: res.status, items: extractModels(conn.source, await res.json()) };
        }
        case 'fireworks': {
            const res = await probeFetch(FIREWORKS_MODELS_URL, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${conn.apiKey}` },
            });
            if (!res.ok) throw httpStatusToProbeError(res.status, res.statusText);
            const data = await res.json();
            const items = (Array.isArray(data?.models) ? data.models : [])
                .filter(m => m?.contextLength > 0 && m?.kind !== 'EMBEDDING_MODEL')
                .map(m => ({ id: String(m.name) }));
            for (const [standardId, fastId] of Object.entries(FIREWORKS_FAST_ROUTERS)) {
                if (items.some(m => m.id === standardId)) items.push({ id: fastId });
            }
            return { status: res.status, items };
        }
        case 'makersuite': {
            const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
            const modelsUrl = !conn.apiKey && (body.base_url || body.reverse_proxy)
                ? `${conn.apiUrl}/${apiVersion}/models`
                : `${conn.apiUrl}/${apiVersion}/models?key=${conn.apiKey}`;
            const models = await fetchGoogleModels(modelsUrl, probeFetch);
            return { status: 200, items: models.map(m => ({ id: m.id })) };
        }
        case 'vertexai': {
            let auth;
            try {
                auth = await getVertexAIAuth(request);
            } catch (e) {
                const msg = String(e?.message ?? e);
                // 'API key is required'/'Service Account JSON is required'/'Unsupported mode' → 配置缺件;
                // 'authentication failed' → 凭据本身坏,归 auth_failed。
                throw new ProbeError(/required|Unsupported/i.test(msg) ? 'not_configured' : 'auth_failed', { detail: msg });
            }
            const region = String(body.vertexai_region || 'us-central1');
            let modelsUrl;
            const modelHeaders = {};
            if (auth.authType === 'express') {
                modelsUrl = `${buildVertexModelsUrl({ region })}?key=${auth.authHeader.replace('Bearer ', '')}`;
            } else if (auth.authType === 'full') {
                modelsUrl = buildVertexModelsUrl({ region });
                modelHeaders['Authorization'] = auth.authHeader;
            } else { // proxy
                const origin = normalizeProviderBaseUrl('vertexai', body.reverse_proxy || body.base_url || '');
                modelsUrl = buildVertexModelsUrl({ region, origin });
                modelHeaders['Authorization'] = auth.authHeader;
            }
            const models = await fetchVertexModels(modelsUrl, { headers: modelHeaders, fetchImpl: probeFetch });
            return { status: 200, items: models.map(m => ({ id: m.id })) };
        }
        case 'azure': {
            let modelsUrl;
            try {
                modelsUrl = new URL('/openai/models', body.azure_base_url);
            } catch {
                throw new ProbeError('not_configured', { detail: 'azure_base_url is not a valid url' });
            }
            modelsUrl.searchParams.set('api-version', body.azure_api_version);
            const res = await probeFetch(modelsUrl, {
                method: 'GET',
                headers: { 'api-key': conn.apiKey, 'Accept': 'application/json' },
            });
            if (!res.ok) throw httpStatusToProbeError(res.status, res.statusText);
            const data = await res.json();
            // GET /openai/models 只证 endpoint+key+api-version;deployment 名是
            // 生成侧的事(/status 的 B 段还会 POST 一次 chat/completions 探活,
            // 烧 token 换模型名——探测面不抄)。
            return { status: res.status, items: extractModels(conn.source, data) };
        }
        case 'workers_ai': {
            const accountId = String(body.workers_ai_account_id || '').trim();
            const modelsUrl = new URL(`${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/models/search`);
            modelsUrl.searchParams.set('task', 'Text Generation');
            modelsUrl.searchParams.set('per_page', '1000');
            const res = await probeFetch(modelsUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${conn.apiKey}` },
            });
            if (!res.ok) throw httpStatusToProbeError(res.status, res.statusText);
            const data = await res.json();
            const items = (Array.isArray(data?.result) ? data.result : [])
                .map(m => ({ id: String(m?.name ?? '').trim() }))
                .filter(m => m.id);
            return { status: res.status, items };
        }
        default:
            throw new ProbeError('unsupported', { detail: `no models probe for source ${conn.source}` });
    }
}

const pstr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/**
 * 装载探测目标(profile 档案制三态):
 *   body.profile_id(>query.profile_id)→ 该 profile 的派发袋;
 *   body.format ∈ {openai,anthropic} → 编辑器草稿(未保存档也能测,
 *     字段 {format, baseUrl/base_url, secretId/secret_id, key});
 *   皆无 → 旧行为:oai_settings 生效配置 + secret_id(body>query>oai)。
 * profile/draft 袋压在 {...oai} 底上 —— 与真实派发 includeConnection
 * 全量透传同构(custom_include_headers 等连接外字段照吃,fidelity 对齐);
 * 袋内 anti-bleed 空串同时压掉 oai 里的旧连接键。
 * 草稿 key 是瞬时明文:探测后覆盖 conn.apiKey,不落盘、不进缓存键明文段。
 * 返回 {body, probeReq, conn, marker, profileId} —— marker 是模型缓存
 * 键的目标段(profile:<id> / draft:<hash> / ''),防跨档串缓存。
 * probeReq 照旧喂 resolveConnection(同一条取密钥路径)。
 */
async function loadConnection(request) {
    const settings = await getSettingsRepo().get(request.user.profile.handle) ?? {};
    const oai = (settings.oai_settings && typeof settings.oai_settings === 'object' && !Array.isArray(settings.oai_settings))
        ? settings.oai_settings : {};
    const rawBody = (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) ? request.body : {};
    const profileId = pstr(rawBody.profile_id ?? rawBody.profileId
        ?? request.query?.profile_id ?? request.query?.profileId);
    const draftFormat = PROFILE_FORMATS.includes(rawBody.format) ? rawBody.format : '';
    const transientKey = pstr(rawBody.key);

    let body;
    let marker = '';
    if (draftFormat) {
        const bag = profileDispatchBag({
            id: '', format: draftFormat,
            baseUrl: pstr(rawBody.baseUrl ?? rawBody.base_url),
            secretId: pstr(rawBody.secretId ?? rawBody.secret_id) || null,
        }, null);
        delete bag.profile_id;
        body = { ...oai, ...bag };
        // draft 指纹:格式+url+secretId 变 → 键变;瞬时 key 由 keyHash 段覆盖。
        marker = 'draft:' + createHash('sha256')
            .update([draftFormat, bag.custom_url || bag.reverse_proxy || '', bag.secret_id].join('|'))
            .digest('hex').slice(0, 12);
    } else if (profileId) {
        const prof = readConnectionProfiles(oai).find((p) => p.id === profileId);
        if (!prof) {
            return { body: {}, probeReq: request, conn: null, marker: '', profileId, profileMissing: true };
        }
        body = { ...oai, ...profileDispatchBag(prof, null) };
        marker = 'profile:' + profileId;
    } else {
        const sid = rawBody.secret_id ?? rawBody.secretId
            ?? request.query?.secret_id ?? request.query?.secretId ?? '';
        body = { ...oai, ...(sid ? { secret_id: String(sid).trim() } : {}) };
    }
    const probeReq = { ...request, body };
    const conn = resolveConnection(probeReq, body);
    if (transientKey && draftFormat) {
        /* 草稿瞬时 key 后注入:resolveConnection 已按空钥把 api_key 计入
           missing —— 剥掉它,否则 anthropic 草稿(空 url 走官方端点)
           恒被 not_configured 拦在门前。仅草稿路径;profile/legacy 的
           missing 如实保留。 */
        conn.apiKey = transientKey;
        conn.credential = 'user';
        conn.missing = conn.missing.filter((m) => m !== 'api_key');
    }
    return { body, probeReq, conn, marker, profileId };
}

/** missing/disabled/unsupported → 契约 error;否则跑 probeModels 并计时。 */
async function runProbe(request) {
    const t0 = performance.now();
    const { conn, probeReq, body, profileMissing } = await loadConnection(request);
    if (profileMissing || !conn) {
        return {
            ok: false, source: 'profile', credential: 'none',
            latencyMs: Math.max(0, Math.round(performance.now() - t0)),
            upstreamStatus: null, error: 'not_configured', detail: 'profile not found',
        };
    }
    const done = (r) => ({ source: conn.source, credential: conn.credential, latencyMs: Math.max(0, Math.round(performance.now() - t0)), ...r });
    if (conn.kind === 'disabled') {
        return done({ ok: false, upstreamStatus: null, error: 'unsupported', detail: `${conn.source} is temporarily disabled upstream` });
    }
    if (conn.kind === 'unsupported') {
        return done({ ok: false, upstreamStatus: null, error: 'unsupported', detail: `chat_completion_source "${conn.source}" has no models probe` });
    }
    if (conn.missing.length) {
        return done({ ok: false, upstreamStatus: null, error: 'not_configured', detail: `missing: ${conn.missing.join(', ')}` });
    }
    try {
        const { status, items } = await probeModels(probeReq, conn, body);
        return done({ ok: true, upstreamStatus: status, items });
    } catch (e) {
        const pe = classifyProbeError(e);
        return done({ ok: false, upstreamStatus: pe.status, error: pe.error, detail: pe.message });
    }
}

export function apply(ctx) {
    const reg = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));
    const regGet = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'GET', path, handler }));
    const regMethod = (method, path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method, path, handler }));
    const P = '/api/utopinn';

    // —— 模型清单缓存:30s TTL 防连点;失败时若有既往成功结果回 stale。 ——
    // key 含 目标段(profile:<id>/draft:<hash>/legacy)+source+url+密钥散列
    // +secret_id:换源/换钥/换档自然换键,密钥本体不落缓存键。
    const modelCache = new Map();   // key → {at, items}
    const inflight = new Map();     // key → Promise(并发请求合并一次上游拉取)

    /**
     * POST /connection/test —— "连接测试"钮。
     * {ok, source, latencyMs, modelCount?, upstreamStatus, error?, detail?}
     * 恒 200 应答(探测结果在载荷里);只有配置读取自身异常才走 sendError。
     */
    reg(`${P}/connection/test`, async function (request, response) {
        try {
            const r = await runProbe(request);
            if (!r.ok) {
                diagEmit({
                    lvl: 'warn', kind: 'http', code: 'connection_probe',
                    msg: `connection test ${r.source} → ${r.error}${r.upstreamStatus ? ` ${r.upstreamStatus}` : ''}`,
                    ctx: { route: `${P}/connection/test`, source: r.source, status: r.upstreamStatus },
                });
            }
            return response.send({
                ok: r.ok,
                source: r.source,
                credential: r.credential,
                latencyMs: r.latencyMs,
                ...(r.ok ? { modelCount: r.items.length } : {}),
                upstreamStatus: r.upstreamStatus,
                ...(r.error ? { error: r.error, detail: r.detail } : {}),
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/connection test');
        }
    });

    /**
     * 模型清单共用流(GET /models 与 POST /connection/models 同体):
     * 契约 {items:[{id, owned_by?}], source, credential, stale?, error?,
     * upstreamStatus?, detail?};恒 200。?fresh=1 / body.fresh 跳过 TTL。
     * profile 目标探测完写回 models.lastProbe({at,items,ok})——草稿不写。
     */
    async function serveModels(request, response) {
        const { conn, probeReq, body, marker, profileId, profileMissing } = await loadConnection(request);
        if (profileMissing || !conn) {
            return response.send({
                source: 'profile', credential: 'none', items: [],
                error: 'not_configured', upstreamStatus: null, detail: 'profile not found',
            });
        }
        const base = { source: conn.source, credential: conn.credential };
        if (conn.kind === 'disabled' || conn.kind === 'unsupported') {
            return response.send({ ...base, items: [], error: 'unsupported', detail: conn.kind === 'disabled' ? `${conn.source} is temporarily disabled upstream` : `chat_completion_source "${conn.source}" has no models probe` });
        }
        if (conn.missing.length) {
            return response.send({ ...base, items: [], error: 'not_configured', detail: `missing: ${conn.missing.join(', ')}` });
        }

        const keyHash = createHash('sha256').update(String(conn.apiKey ?? '')).digest('hex').slice(0, 12);
        const cacheKey = [
            request.user.profile.handle, marker, conn.source,
            conn.apiUrl || conn.marker, keyHash, body.secret_id ?? '',
        ].join('|');
        const fresh = request.query?.fresh === '1' || request.query?.fresh === 'true'
            || request.body?.fresh === true || request.body?.fresh === '1';
        const cached = modelCache.get(cacheKey);
        if (!fresh && cached && (Date.now() - cached.at) < MODELS_CACHE_MS) {
            return response.send({ ...base, items: cached.items });
        }

        let promise = inflight.get(cacheKey);
        if (!promise) {
            promise = probeModels(probeReq, conn, body)
                .then(r => ({ ok: true, ...r }))
                .catch(e => ({ ok: false, err: classifyProbeError(e) }));
            inflight.set(cacheKey, promise);
            promise.finally(() => inflight.delete(cacheKey)).catch(() => { /* finally 链不产生拒绝面 */ });
        }
        const r = await promise;

        // lastProbe 回写(仅 profile 目标;草稿/旧面不落)。
        if (profileId) {
            const probeItems = r.ok ? r.items : (cached?.items ?? []);
            try {
                await getSettingsRepo().update(request.user.profile.handle, (doc) => {
                    const d = { ...(doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}) };
                    const o = (d.oai_settings && typeof d.oai_settings === 'object' && !Array.isArray(d.oai_settings))
                        ? { ...d.oai_settings } : {};
                    const list = readConnectionProfiles(o);
                    o.connection_profiles = list.map((p) => p.id === profileId
                        ? {
                            ...p,
                            models: {
                                ...p.models,
                                lastProbe: {
                                    at: Date.now(), ok: !!r.ok,
                                    items: probeItems.slice(0, 200).map((m) => ({ id: String(m.id) })),
                                },
                            },
                        }
                        : p);
                    d.oai_settings = o;
                    return d;
                });
            } catch { /* 簿记失败不吞探测结果 */ }
        }

        if (r.ok) {
            modelCache.set(cacheKey, { at: Date.now(), items: r.items });
            return response.send({ ...base, items: r.items });
        }
        // 失败:有既往成功结果 → stale 回放(旧数据 > 空表);没有 → 空 + error。
        if (cached) {
            return response.send({
                ...base, items: cached.items, stale: true,
                error: r.err.error, upstreamStatus: r.err.status, detail: r.err.message,
            });
        }
        return response.send({
            ...base, items: [],
            error: r.err.error, upstreamStatus: r.err.status, detail: r.err.message,
        });
    }

    /**
     * GET /models —— 旧契约不动(CLI 在用):生效配置的上游模型清单。
     * profile/draft 探测走 POST /connection/models。
     */
    regGet(`${P}/models`, async function (request, response) {
        try {
            return await serveModels(request, response);
        } catch (error) {
            return sendError(response, error, 'utopinn/models');
        }
    });

    /**
     * POST /connection/models —— profile/草稿目标的上游模型清单。
     * body:{profile_id} | {format, baseUrl, secretId?, key?, fresh?}
     */
    reg(`${P}/connection/models`, async function (request, response) {
        try {
            return await serveModels(request, response);
        } catch (error) {
            return sendError(response, error, 'utopinn/connection models');
        }
    });

    /* ------------------------------------------------------------------ */
    /* 连接配置档案 CRUD —— oai_settings.connection_profiles 整档操作。      */
    /* ------------------------------------------------------------------ */

    /**
     * GET /connection/profiles —— {profiles, activeModel}。
     * 惰性迁移:数组缺失/空 → 从旧单槽合成 'default' 档并落盘(旧键不删)。
     */
    regGet(`${P}/connection/profiles`, async function (request, response) {
        try {
            const r = await ensureConnectionProfiles(request, getSettingsRepo());
            return response.send({ profiles: r.profiles, activeModel: r.activeModel });
        } catch (error) {
            return sendError(response, error, 'utopinn/profiles get');
        }
    });

    /**
     * PUT /connection/profiles/:id —— upsert(id='new' 服务端发 uuid)。
     * body:{name?, format?, baseUrl?, secretId?, models?{checked,manual}, disabled?}
     * → {profiles, profile, activeModel};profile 引用 secret 只存 id 不存值。
     */
    regMethod('PUT', `${P}/connection/profiles/:id`, async function (request, response) {
        try {
            const repo = getSettingsRepo();
            const handle = request.user.profile.handle;
            const wanted = String(request.params.id ?? '').trim() || 'new';
            const id = wanted === 'new' ? uuidv4() : wanted;
            const next = await repo.update(handle, (doc) => {
                const d = { ...(doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}) };
                const o = (d.oai_settings && typeof d.oai_settings === 'object' && !Array.isArray(d.oai_settings))
                    ? { ...d.oai_settings } : {};
                const list = readConnectionProfiles(o);
                const idx = list.findIndex((p) => p.id === id);
                const merged = sanitizeProfileInput(request.body, { existing: idx >= 0 ? list[idx] : null, id });
                if (idx >= 0) list[idx] = merged; else list.push(merged);
                o.connection_profiles = list;
                /* 勾选面写面:指针模型被移出 checked∪manual → 清 activeModel
                   (不清则已取选项在派发链里复活;删档清针同语义)。 */
                const conn = (o.connection && typeof o.connection === 'object' && !Array.isArray(o.connection))
                    ? { ...o.connection } : {};
                const am = readActiveModel(o);
                if (am?.profileId === id
                    && ![...merged.models.checked, ...merged.models.manual].includes(am.modelId)) {
                    conn.activeModel = null;
                    o.connection = conn;
                }
                d.oai_settings = o;
                return d;
            });
            const nextOai = (next.oai_settings && typeof next.oai_settings === 'object' && !Array.isArray(next.oai_settings))
                ? next.oai_settings : {};
            const profiles = readConnectionProfiles(nextOai);
            return response.send({
                profiles,
                profile: profiles.find((p) => p.id === id) ?? null,
                activeModel: readActiveModel(nextOai),
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/profiles put');
        }
    });

    /**
     * DELETE /connection/profiles/:id —— 删档;connection.activeModel 指向
     * 该档时清针(不猜别档,下一次选择自然落)。secret 槽不动(只失引用)。
     */
    regMethod('DELETE', `${P}/connection/profiles/:id`, async function (request, response) {
        try {
            const repo = getSettingsRepo();
            const handle = request.user.profile.handle;
            const id = String(request.params.id ?? '').trim();
            const next = await repo.update(handle, (doc) => {
                const d = { ...(doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}) };
                const o = (d.oai_settings && typeof d.oai_settings === 'object' && !Array.isArray(d.oai_settings))
                    ? { ...d.oai_settings } : {};
                o.connection_profiles = readConnectionProfiles(o).filter((p) => p.id !== id);
                const conn = (o.connection && typeof o.connection === 'object' && !Array.isArray(o.connection))
                    ? { ...o.connection } : {};
                if (conn.activeModel?.profileId === id) conn.activeModel = null;
                o.connection = conn;
                d.oai_settings = o;
                return d;
            });
            const nextOai = (next.oai_settings && typeof next.oai_settings === 'object' && !Array.isArray(next.oai_settings))
                ? next.oai_settings : {};
            return response.send({
                profiles: readConnectionProfiles(nextOai),
                activeModel: readActiveModel(nextOai),
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/profiles delete');
        }
    });
}
