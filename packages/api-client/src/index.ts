/**
 * @utopinn/api-client — Utopinn 服务端类型化客户端(浏览器/RN/Node 三端)。
 *
 * 传输:fetch(REST)+ 可注入 WebSocket(ticket 流式)。
 *   - 浏览器/RN/Node≥22:直接用全局 fetch + WebSocket。
 *   - 老 Node:传 `ws` 包构造器 `webSocket: (u,p) => new WebSocket(u,p)`。
 *   - Cookie 会话:浏览器 credentials:'include' 自动;Node/RN 手动 —
 *     首请求自动抓 /csrf-token 并记住 Set-Cookie(autoSession),
 *     或预传 `cookie` + `csrfToken`。
 *
 * 动词面(与 CLI apps/cli/utopinn-cli.mjs 一一对应,见各 domain):
 *   client.account.*      login/logout/me(cookie-session;login 后同 jar 即用)
 *   client.library.*      characters/chats/presets/worlds/personas/settings/secrets
 *   client.state.*        state sidecar 三族(chat/char/preset)
 *   client.generation.*   generate/preview/jobs/jobGet/abort/streamJob/attachJob/waitForJob
 *   client.mvu.*          mvu state/settle/resettle/panelRender
 *   client.plugins.*      list/enable/disable/reload
 *   client.data.*         import/backup/lan
 *   client.script.*       run
 *   client.th.*           call
 *   client.diag.*         kernel
 *
 * 老 legacy 方法(getChat/patchChatMetadata/…)保留在类尾部供 panel-t0 桥用,
 * 新代码一律走 domain 面。
 */

import type { JsonPatchOp } from '@utopinn/protocol';
import { AccountApi } from './account.js';
import { ApiError } from './errors.js';
import { GenerationApi } from './generate.js';
import { LibraryApi } from './library.js';
import { DataApi, DiagApi, MvuApi, PluginsApi, ScriptApi, ThApi } from './misc.js';
import { StateApi } from './state.js';
import type { WebSocketFactory, WebSocketLike } from './stream.js';

export interface ClientOptions {
    baseUrl: string;
    /** CSRF token header `X-CSRF-Token`(server issues via /csrf-token)。 */
    csrfToken?: string;
    /** 会话 cookie(RN/Node 手动带;浏览器靠 credentials:'include')。 */
    cookie?: string;
    /** Extra headers(auth、device id…)。 */
    headers?: Record<string, string>;
    /** Injectable fetch(default global fetch)。 */
    fetch?: typeof fetch;
    /**
     * Injectable WebSocket constructor(默认 globalThis.WebSocket)。
     * Node<22 传 `ws` 包:`webSocket: (url, p) => new WS(url, p)`。
     */
    webSocket?: WebSocketFactory;
    /** 首个请求前自动抓 /csrf-token(含 Set-Cookie 捕获)。默认 true。 */
    autoSession?: boolean;
    /** 401/403 后清会话重抓 token 再重试一次。默认 true。 */
    autoReauth?: boolean;
    /** 默认每请求超时 ms(AbortSignal.timeout;单请求 opts.timeout 可盖)。 */
    timeoutMs?: number;
}

export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    /** 覆盖 ClientOptions.timeoutMs。 */
    timeout?: number;
    /** 外部取消(与 timeout 二选一)。 */
    signal?: AbortSignal;
    /** 逐请求附加头。 */
    headers?: Record<string, string>;
    /**
     * 本请求禁用「401/403 → 清会话重握手再试一次」(login 用:
     * 凭据错的 403 重试同样会败,还白烧服务端登录限流点)。
     */
    skipReauth?: boolean;
}

/** requestRaw 的透传出参(不抛 HTTP 错;备份/头取数用)。 */
export interface RawResponse {
    status: number;
    data: unknown;
    headers: Headers;
}

export interface BinaryResponse {
    status: number;
    data: ArrayBuffer;
    headers: Headers;
}

export class UtopinnClient {
    readonly baseUrl: string;
    private csrfToken?: string;
    private cookie?: string;
    private csrfFetched = false;
    private sessionPromise?: Promise<void>;
    private readonly headers: Record<string, string>;
    private readonly fetchImpl: typeof fetch;
    private readonly wsCtor?: WebSocketFactory;
    private readonly autoSession: boolean;
    private readonly autoReauth: boolean;
    readonly timeoutMs?: number;

    readonly account: AccountApi;
    readonly library: LibraryApi;
    readonly state: StateApi;
    readonly generation: GenerationApi;
    readonly mvu: MvuApi;
    readonly plugins: PluginsApi;
    readonly data: DataApi;
    readonly script: ScriptApi;
    readonly th: ThApi;
    readonly diag: DiagApi;

    constructor(opts: ClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.csrfToken = opts.csrfToken;
        this.csrfFetched = opts.csrfToken !== undefined;
        this.cookie = opts.cookie;
        this.headers = opts.headers ?? {};
        this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
        this.wsCtor = opts.webSocket;
        this.autoSession = opts.autoSession ?? true;
        this.autoReauth = opts.autoReauth ?? true;
        this.timeoutMs = opts.timeoutMs;

        this.account = new AccountApi(this);
        this.library = new LibraryApi(this);
        this.state = new StateApi(this);
        this.generation = new GenerationApi(this);
        this.mvu = new MvuApi(this);
        this.plugins = new PluginsApi(this);
        this.data = new DataApi(this);
        this.script = new ScriptApi(this);
        this.th = new ThApi(this);
        this.diag = new DiagApi(this);
    }

    // ── transport ────────────────────────────────────────────────────────

    setCsrfToken(token: string): void {
        this.csrfToken = token;
        this.csrfFetched = true;
    }

    setCookie(cookie: string): void {
        this.cookie = cookie;
    }

    /**
     * GET /csrf-token —— 抓 token + Set-Cookie(Node/RN 会话续命)。
     * 必须带上当前 cookie:token 存在 session 里(cookie-session 整体序列化),
     * 不带 cookie 去握手 = 开匿名新 session,login 态当场蒸发 ——
     * 浏览器靠自动带 cookie 天然同源(token 落同一 session),Node/RN 手动模拟。
     */
    async fetchCsrfToken(): Promise<string> {
        const headers: Record<string, string> = { ...this.headers };
        if (this.cookie) headers['Cookie'] = this.cookie;
        const res = await this.fetchImpl(`${this.baseUrl}/csrf-token`, { headers });
        if (!res.ok) throw new ApiError(res.status, await res.text());
        const data = await res.json() as { token?: string };
        if (typeof data.token === 'string' && data.token) this.csrfToken = data.token;
        this.absorbSetCookie(res.headers);
        this.csrfFetched = true;
        return this.csrfToken ?? '';
    }

    /**
     * Set-Cookie 收罐(按 name 合并;空值=服务端清该 cookie → 出罐)。
     * cookie-session 模型下 session 整体序列化在签名 cookie 里,login/logout
     * 的会话升级全靠响应 Set-Cookie——只吃 /csrf-token 一次的话,
     * login 后 jar 里仍是匿名 session,后面全 403。
     * 浏览器 fetch 拿不到 Set-Cookie(禁头)→ 天然 no-op。
     */
    private absorbSetCookie(headers: Headers): void {
        const setCookie = typeof (headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
            ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
            : [];
        if (!setCookie.length) return;
        const jar = new Map<string, string>();
        for (const pair of (this.cookie ?? '').split(';')) {
            const i = pair.indexOf('=');
            if (i > 0) jar.set(pair.slice(0, i).trim(), pair.trim());
        }
        for (const c of setCookie) {
            const pair = c.split(';')[0]?.trim();
            if (!pair) continue;
            const i = pair.indexOf('=');
            if (i <= 0) continue;
            const name = pair.slice(0, i).trim();
            const value = pair.slice(i + 1).trim();
            if (value) jar.set(name, pair);
            else jar.delete(name);
        }
        this.cookie = [...jar.values()].join('; ');
    }

    private ensureSession(): Promise<void> {
        if (!this.autoSession || this.csrfFetched) return Promise.resolve();
        this.sessionPromise ??= this.fetchCsrfToken()
            .then(() => undefined)
            .catch((e) => { this.sessionPromise = undefined; throw e; });
        return this.sessionPromise;
    }

    private resetSession(): void {
        this.csrfToken = undefined;
        this.cookie = undefined;
        this.csrfFetched = false;
        this.sessionPromise = undefined;
    }

    /** 本地会话整桶清掉(logout 后/换账号前)。下一请求自动重新握手。 */
    clearSession(): void {
        this.resetSession();
    }

    /**
     * 原始 HTTP 步:session → headers → fetch → (401/403 重认证重试一次)。
     * 不解析 body —— request/requestRaw/requestBinary 各自消费。
     */
    private async perform(path: string, opts: RequestOptions, reauthed: boolean): Promise<Response> {
        await this.ensureSession();
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [k, v] of Object.entries(opts.query ?? {})) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }
        const headers: Record<string, string> = { ...this.headers, ...opts.headers };
        if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
        if (this.cookie) headers['Cookie'] = this.cookie;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        const timeout = opts.timeout ?? this.timeoutMs;
        const signal = opts.signal
            ?? (timeout && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined);
        let res: Response;
        try {
            res = await this.fetchImpl(url.toString(), {
                method: opts.method ?? 'GET',
                headers,
                body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
                credentials: 'include',
                signal,
            });
        } catch (e) {
            throw new ApiError(0, e instanceof Error ? e.message : String(e),
                `network error ${opts.method ?? 'GET'} ${path}`, 'network');
        }
        this.absorbSetCookie(res.headers);
        if ((res.status === 401 || res.status === 403) && !reauthed && this.autoReauth && !opts.skipReauth) {
            // 同会话内轮换 CSRF 再试一次 —— cookie 不丢:浏览器语义就是
            // /csrf-token 带当前 cookie,token 落同一 session。resetSession()
            // 换成匿名握手等于「任何 403(含权限不足)都把登录态客户端侧登出」。
            // 会话真死(签名失效/版本踢)时新 cookie 自来或照旧 403,殊途同归。
            await this.fetchCsrfToken().catch(() => undefined);
            return this.perform(path, opts, true);
        }
        return res;
    }

    /** 透传层:JSON 解析但不抛 HTTP 错(需要自己看 status 的调用方用)。 */
    async requestRaw(path: string, opts: RequestOptions = {}): Promise<RawResponse> {
        const res = await this.perform(path, opts, false);
        const text = await res.text();
        const data: unknown = text.length ? safeJson(text) : undefined;
        return { status: res.status, data, headers: res.headers };
    }

    /** 主调用层:≥400 → ApiError(含 status/body/code/headers)。 */
    async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
        const r = await this.requestRaw(path, opts);
        if (r.status >= 400) {
            throw new ApiError(r.status, r.data,
                `HTTP ${r.status} ${opts.method ?? 'GET'} ${path}`, undefined, r.headers);
        }
        return r.data as T;
    }

    /** 二进制层(backup zip 等附件响应)。 */
    async requestBinary(path: string, opts: RequestOptions = {}): Promise<BinaryResponse> {
        const res = await this.perform(path, opts, false);
        const data = await res.arrayBuffer();
        if (res.status >= 400) {
            throw new ApiError(res.status, safeJson(new TextDecoder().decode(data)),
                `HTTP ${res.status} ${opts.method ?? 'GET'} ${path}`, undefined, res.headers);
        }
        return { status: res.status, data, headers: res.headers };
    }

    /** http(s) base → ws(s) base(WS 工厂拼 /api/ws-delivery 用)。 */
    wsBaseUrl(): string {
        return this.baseUrl.replace(/^http/, 'ws');
    }

    /** WebSocket 工厂:注入优先,否则全局;都没有 → usage 错(老 Node 传 ws 包)。 */
    wsFactory(): WebSocketFactory {
        if (this.wsCtor) return this.wsCtor;
        const WS = (globalThis as { WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike }).WebSocket;
        if (WS) return (url, protocols) => new WS(url, protocols);
        throw new ApiError(0, null,
            'no WebSocket implementation — pass ClientOptions.webSocket (e.g. the `ws` package on Node<22)',
            'usage');
    }

    // ════════════════════════════════════════════════════════════════════
    // legacy 动词(panel-t0 桥在用;新代码走上面 domain 面)
    // ════════════════════════════════════════════════════════════════════

    /** @deprecated legacy /api/chats/get;新代码用 library.chatGet。 */
    getChat(avatarUrl: string, fileName: string): Promise<ChatGetResult> {
        return this.request('/api/chats/get', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName },
        });
    }

    /** @deprecated legacy /api/chats/meta/patch;新代码用 library.patchChat 的 /header/chat_metadata ops。 */
    patchChatMetadata(avatarUrl: string, fileName: string, operations: JsonPatchOp[], integrity?: string): Promise<unknown> {
        return this.request('/api/chats/meta/patch', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, operations, integrity },
        });
    }

    /** @deprecated legacy /api/chats/patch;新代码用 library.patchChat。 */
    patchChat(avatarUrl: string, fileName: string, operations: JsonPatchOp[], chatMetadata?: Record<string, unknown>): Promise<unknown> {
        return this.request('/api/chats/patch', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, operations, chat_metadata: chatMetadata },
        });
    }

    /** @deprecated legacy /api/chats/state/get;新代码用 state.chat.get。 */
    stateGet<T = unknown>(avatarUrl: string, fileName: string, namespace: string): Promise<T> {
        return this.request('/api/chats/state/get', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, namespace },
        });
    }

    /** @deprecated legacy /api/chats/state/patch;新代码用 state.chat.patch。 */
    statePatch(avatarUrl: string, fileName: string, namespace: string, operations: JsonPatchOp[]): Promise<unknown> {
        return this.request('/api/chats/state/patch', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, namespace, operations },
        });
    }

    /** @deprecated legacy /api/settings/get;新代码用 library.settings()。 */
    settingsGet<T = Record<string, unknown>>(): Promise<T> {
        return this.request('/api/settings/get', { method: 'POST', body: {} });
    }

    /** @deprecated legacy /api/settings/patch;新代码用 library.settingsPatch(受限浅合并语义不同,注意)。 */
    settingsPatch(operations: JsonPatchOp[]): Promise<unknown> {
        return this.request('/api/settings/patch', { method: 'POST', body: { operations } });
    }
}

function safeJson(text: string): unknown {
    try { return JSON.parse(text); } catch { return text; }
}

// ─── re-exports ──────────────────────────────────────────────────────────

/** JsonPatchOp 单一事实源在 @utopinn/protocol;此处 re-export 保持旧 import 路径可用。 */
export type { JsonPatchOp } from '@utopinn/protocol';

export { ApiError } from './errors.js';
export {
    isApiError,
    isConflict,
    isExistsConflict,
    isIntegrityConflict,
    isNetworkError,
    isNotFound,
    isServerError,
    isSessionError,
    currentIntegrityFrom,
    retryOnIntegrityConflict,
    type ApiErrorCode,
} from './errors.js';

export { decodeBase64Bytes, decodeBase64Utf8, encodeBase64Bytes, toBase64Payload } from './base64.js';
export {
    parseSseDeltaLine,
    SseDeltaDecoder,
    streamJobEvents,
    tryParseWsMessage,
    type SseDelta,
    type StreamJobDeps,
    type StreamJobOptions,
    type StreamJobResult,
    type WebSocketFactory,
    type WebSocketLike,
} from './stream.js';
export {
    isTerminalStatus,
    type AttachJobResult,
    type GenerateAccepted,
    type PreviewAccepted,
    type StreamCallbacks,
    type WaitForJobOptions,
} from './generate.js';
export { asPatchOps, StateTargets, type StateGetOptions } from './state.js';
export type { BackupResult, ImportInput } from './misc.js';
export { AccountApi, type AccountLoginResponse, type AccountMe } from './account.js';
export { LibraryApi } from './library.js';
export { GenerationApi } from './generate.js';
export { StateApi } from './state.js';
export { DataApi, DiagApi, MvuApi, PluginsApi, ScriptApi, ThApi } from './misc.js';

/** `/api/chats/get` response shape (Luker): `{ header, body }` or legacy array form. */
export interface ChatGetResult {
    header?: Record<string, unknown> & { chat_metadata?: Record<string, unknown> };
    body?: Record<string, unknown>[];
    /** legacy flat array fallback */
    [k: string]: unknown;
}

export { createPanelT0Handler, type PanelT0Deps } from './panel-t0.js';
