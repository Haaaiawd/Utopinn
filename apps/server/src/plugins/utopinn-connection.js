/**
 * utopinn-connection —— kernel 插件:上游连接探测 + 模型清单面(§C 补件)。
 *
 *   POST /api/utopinn/connection/test   前端"连接测试"钮的后端面。
 *   GET  /api/utopinn/models            上游模型清单(30s 内存缓存防连点;?fresh=1 绕过)。
 *
 * 连接配置源 = settings.oai_settings(当前生效),键形与 legacy
 * POST /api/backends/chat-completions/status 的 request.body 同构——
 * source→base url/key/headers/query 的解析与 /status 逐支对齐:同一批
 * API_* 常量 + normalizeProviderBaseUrl + readProviderSecret/readSecret +
 * mergeObjectWithYaml(custom_include_headers 与真实派发同构,宏不预替换)。
 * 密钥只用于上行 Authorization/x-api-key/api-key,绝不回显,也不进 diag。
 * body/query 只放行 secret_id(选密钥槽);URL 覆盖不开——
 * 这面读"生效配置",不是任意 URL 探针。
 *
 * test 契约:{ok, source, latencyMs, modelCount?, upstreamStatus, error?, detail?}
 *   error ∈ not_configured | unreachable | timeout | auth_failed | http_error | unsupported
 *   upstreamStatus = 上游应答的 HTTP 状态;未触达(网络/超时/未配置)为 null。
 * models 契约:{items:[{id, owned_by?}], source, stale?, error?, upstreamStatus?}
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
import { readProviderSecret, readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
import { getVertexAIAuth } from '../endpoints/google.js';
import { fetchGoogleModels, GoogleModelsHttpError } from '../endpoints/backends/google-models.js';
import { buildVertexModelsUrl, fetchVertexModels, VertexModelsHttpError } from '../endpoints/backends/vertex-models.js';
import { getSettingsRepo } from '../storage/index.js';
import { emit as diagEmit } from '../services/diag-bus.js';
import { sendError } from './utopinn-library.js';

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
 * source→{apiUrl, apiKey, headers, queryParams, kind} 解析 ——
 * endpoints/backends/chat-completions.js /status 的逐支镜像。
 * kind: 'openai'(通用 GET {apiUrl}/models)| claude | fireworks | makersuite |
 *       vertexai | azure | workers_ai | disabled | unsupported。
 * missing[] 收集 not_configured 的缺件(api_key / custom_url / …)。
 */
function resolveConnection(request, body) {
    const source = String(body.chat_completion_source || CHAT_COMPLETION_SOURCES.OPENAI);
    const conn = {
        source, kind: 'openai', marker: '',
        apiUrl: '', apiKey: '', headers: {}, queryParams: {}, missing: [],
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
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.OPENAI) || '';
            break;
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            conn.apiUrl = 'https://openrouter.ai/api/v1';
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.OPENROUTER);
            conn.headers = { ...OPENROUTER_HEADERS };
            break;
        case CHAT_COMPLETION_SOURCES.MISTRALAI:
            conn.apiUrl = normalizeProviderBaseUrl('mistral', body.reverse_proxy || body.base_url || API_MISTRAL);
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.MISTRALAI) || '';
            break;
        case CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES:
            conn.apiUrl = normalizeProviderBaseUrl('openai_responses', body.responses_url || 'https://api.openai.com/v1');
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.OPENAI_RESPONSES) || '';
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.CUSTOM:
            conn.apiUrl = normalizeProviderBaseUrl('custom', body.custom_url);
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.CUSTOM);
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.COHERE:
            conn.apiUrl = API_COHERE_V1;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.COHERE);
            break;
        case CHAT_COMPLETION_SOURCES.CHUTES:
            conn.apiUrl = API_CHUTES;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.CHUTES);
            break;
        case CHAT_COMPLETION_SOURCES.ELECTRONHUB:
            conn.apiUrl = API_ELECTRONHUB;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.ELECTRONHUB);
            break;
        case CHAT_COMPLETION_SOURCES.NANOGPT:
            conn.apiUrl = API_NANOGPT;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.NANOGPT);
            conn.queryParams = { detailed: true };
            break;
        case CHAT_COMPLETION_SOURCES.DEEPSEEK:
            conn.apiUrl = normalizeProviderBaseUrl('deepseek', body.reverse_proxy || body.base_url || API_DEEPSEEK.replace('/beta', ''));
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.DEEPSEEK) || '';
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.XAI:
            conn.apiUrl = normalizeProviderBaseUrl('xai', body.reverse_proxy || body.base_url || API_XAI);
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.XAI) || '';
            break;
        case CHAT_COMPLETION_SOURCES.AIMLAPI:
            conn.apiUrl = API_AIMLAPI;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.AIMLAPI);
            conn.headers = { ...AIMLAPI_HEADERS };
            break;
        case CHAT_COMPLETION_SOURCES.POLLINATIONS: {
            const isAnonymous = body.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS;
            conn.apiUrl = 'https://gen.pollinations.ai/text';
            conn.apiKey = isAnonymous ? 'anonymous' : readSecret(request.user.directories, SECRET_KEYS.POLLINATIONS, body.secret_id);
            break;
        }
        case CHAT_COMPLETION_SOURCES.GROQ:
            conn.apiUrl = API_GROQ;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.GROQ);
            break;
        case CHAT_COMPLETION_SOURCES.COMETAPI:
            conn.apiUrl = API_COMETAPI;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.COMETAPI);
            conn.kind = 'disabled'; // /status: throw 'This provider is temporarily disabled.'
            return conn;
        case CHAT_COMPLETION_SOURCES.MOONSHOT:
            conn.apiUrl = normalizeProviderBaseUrl('moonshot', body.reverse_proxy || body.base_url || API_MOONSHOT);
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.MOONSHOT) || '';
            break;
        case CHAT_COMPLETION_SOURCES.SILICONFLOW:
            conn.apiUrl = body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN ? API_SILICONFLOW_CN : API_SILICONFLOW;
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.SILICONFLOW);
            conn.queryParams = { type: 'text', sub_type: 'chat' };
            break;
        case CHAT_COMPLETION_SOURCES.CLAUDE:
            conn.kind = 'claude';
            conn.apiUrl = normalizeProviderBaseUrl('claude', body.reverse_proxy || body.base_url || API_CLAUDE);
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.CLAUDE) || '';
            mergeObjectWithYaml(conn.headers, body.custom_include_headers);
            break;
        case CHAT_COMPLETION_SOURCES.FIREWORKS:
            conn.kind = 'fireworks';
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.FIREWORKS);
            conn.marker = 'fireworks';
            if (!conn.apiKey) conn.missing.push('api_key');
            return conn;
        case CHAT_COMPLETION_SOURCES.MAKERSUITE:
            conn.kind = 'makersuite';
            conn.apiKey = body.proxy_password || readProviderSecret(request, SECRET_KEYS.MAKERSUITE) || '';
            conn.apiUrl = normalizeProviderBaseUrl('makersuite', body.reverse_proxy || body.base_url || API_MAKERSUITE);
            if (!conn.apiKey && !body.base_url && !body.reverse_proxy) conn.missing.push('api_key');
            return conn;
        case CHAT_COMPLETION_SOURCES.VERTEXAI:
            conn.kind = 'vertexai';
            conn.marker = `vertexai|${body.vertexai_auth_mode || 'express'}|${body.vertexai_region || ''}|${body.reverse_proxy || body.base_url || ''}`;
            return conn; // 凭据在 exec 内 getVertexAIAuth 解析(express key / service account / proxy)
        case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: {
            conn.kind = 'azure';
            conn.apiKey = readProviderSecret(request, SECRET_KEYS.AZURE_OPENAI);
            conn.marker = `azure|${body.azure_base_url || ''}|${body.azure_api_version || ''}`;
            if (!conn.apiKey) conn.missing.push('api_key');
            if (!body.azure_base_url) conn.missing.push('azure_base_url');
            if (!body.azure_api_version) conn.missing.push('azure_api_version');
            return conn;
        }
        case CHAT_COMPLETION_SOURCES.WORKERS_AI: {
            conn.kind = 'workers_ai';
            conn.apiKey = readSecret(request.user.directories, SECRET_KEYS.WORKERS_AI, body.secret_id);
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

/**
 * 装载"当前生效连接":settings.oai_settings + 可选 secret_id(body>query>oai)。
 * 返回 {conn, probeReq, body} —— probeReq 是把 body 换成连接配置形的请求视图,
 * readProviderSecret/getVertexAIAuth 照旧吃它(同一条取密钥路径)。
 */
async function loadConnection(request) {
    const settings = await getSettingsRepo().get(request.user.profile.handle) ?? {};
    const oai = (settings.oai_settings && typeof settings.oai_settings === 'object' && !Array.isArray(settings.oai_settings))
        ? settings.oai_settings : {};
    const sid = request.body?.secret_id ?? request.body?.secretId
        ?? request.query?.secret_id ?? request.query?.secretId ?? '';
    const body = { ...oai, ...(sid ? { secret_id: String(sid).trim() } : {}) };
    const probeReq = { ...request, body };
    return { body, probeReq, conn: resolveConnection(probeReq, body) };
}

/** missing/disabled/unsupported → 契约 error;否则跑 probeModels 并计时。 */
async function runProbe(request) {
    const t0 = performance.now();
    const { conn, probeReq, body } = await loadConnection(request);
    const done = (r) => ({ source: conn.source, latencyMs: Math.max(0, Math.round(performance.now() - t0)), ...r });
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
    const P = '/api/utopinn';

    // —— 模型清单缓存:30s TTL 防连点;失败时若有既往成功结果回 stale。 ——
    // key 含 source+url+密钥散列+secret_id:换源/换钥自然换键,密钥本体不落缓存键。
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
     * GET /models —— 上游模型清单,归一化 {items:[{id, owned_by?}], source, stale?}。
     * ?fresh=1 跳过 TTL;上游不通且无缓存 → {items:[], error, upstreamStatus}。
     */
    regGet(`${P}/models`, async function (request, response) {
        try {
            const { conn, probeReq, body } = await loadConnection(request);
            const base = { source: conn.source };
            if (conn.kind === 'disabled' || conn.kind === 'unsupported') {
                return response.send({ ...base, items: [], error: 'unsupported', detail: conn.kind === 'disabled' ? `${conn.source} is temporarily disabled upstream` : `chat_completion_source "${conn.source}" has no models probe` });
            }
            if (conn.missing.length) {
                return response.send({ ...base, items: [], error: 'not_configured', detail: `missing: ${conn.missing.join(', ')}` });
            }

            const keyHash = createHash('sha256').update(String(conn.apiKey ?? '')).digest('hex').slice(0, 12);
            const cacheKey = [
                request.user.profile.handle, conn.source,
                conn.apiUrl || conn.marker, keyHash, body.secret_id ?? '',
            ].join('|');
            const fresh = request.query?.fresh === '1' || request.query?.fresh === 'true';
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
        } catch (error) {
            return sendError(response, error, 'utopinn/models');
        }
    });
}
