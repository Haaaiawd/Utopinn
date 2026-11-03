/**
 * @uberge/api-client — typed client for the Uberge server.
 * Transport: fetch (HTTP) + injectable event subscription (WS ticket stream).
 * No Node/Browser-specific APIs beyond `fetch` — runs in RN/Expo, browsers, node≥18.
 */

export interface ClientOptions {
    baseUrl: string;
    /** CSRF token header `X-CSRF-Token` (server issues via /csrf-token). */
    csrfToken?: string;
    /** Extra headers (auth, device id…). */
    headers?: Record<string, string>;
    /** Injectable fetch (default global fetch). */
    fetch?: typeof fetch;
}

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: unknown,
        message?: string,
    ) {
        super(message ?? `HTTP ${status}`);
        this.name = 'ApiError';
    }
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
}

export class UbergeClient {
    readonly baseUrl: string;
    private csrfToken?: string;
    private headers: Record<string, string>;
    private fetchImpl: typeof fetch;

    constructor(opts: ClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.csrfToken = opts.csrfToken;
        this.headers = opts.headers ?? {};
        this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    }

    setCsrfToken(token: string): void {
        this.csrfToken = token;
    }

    async fetchCsrfToken(): Promise<string> {
        const res = await this.fetchImpl(`${this.baseUrl}/csrf-token`, { headers: { ...this.headers } });
        if (!res.ok) throw new ApiError(res.status, await res.text());
        const data = await res.json() as { token: string };
        this.csrfToken = data.token;
        return data.token;
    }

    async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [k, v] of Object.entries(opts.query ?? {})) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }
        const headers: Record<string, string> = { ...this.headers };
        if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await this.fetchImpl(url.toString(), {
            method: opts.method ?? 'GET',
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
            credentials: 'include',
        });
        const text = await res.text();
        const parsed: unknown = text.length ? safeJson(text) : undefined;
        if (!res.ok) throw new ApiError(res.status, parsed, `HTTP ${res.status} ${opts.method ?? 'GET'} ${path}`);
        return parsed as T;
    }

    // ── chats ────────────────────────────────────────────────────────────

    /** Full chat (header + body) as stored. */
    getChat(avatarUrl: string, fileName: string): Promise<ChatGetResult> {
        return this.request('/api/chats/get', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName },
        });
    }

    /** JSON-patch chat_metadata (chat variables live under `/variables`). */
    patchChatMetadata(avatarUrl: string, fileName: string, operations: JsonPatchOp[], integrity?: string): Promise<unknown> {
        return this.request('/api/chats/meta/patch', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, operations, integrity },
        });
    }

    /** JSON-patch the chat body (message writes — T1 territory, declared here for completeness). */
    patchChat(avatarUrl: string, fileName: string, operations: JsonPatchOp[], chatMetadata?: Record<string, unknown>): Promise<unknown> {
        return this.request('/api/chats/patch', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, operations, chat_metadata: chatMetadata },
        });
    }

    // ── chat_state sidecar (namespace state; panel/injected-prompt stores) ──

    stateGet<T = unknown>(avatarUrl: string, fileName: string, namespace: string): Promise<T> {
        return this.request('/api/chats/state/get', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, namespace },
        });
    }

    statePatch(avatarUrl: string, fileName: string, namespace: string, operations: JsonPatchOp[]): Promise<unknown> {
        return this.request('/api/chats/state/patch', {
            method: 'POST',
            body: { avatar_url: avatarUrl, file_name: fileName, namespace, operations },
        });
    }

    // ── settings (global-scope variables live under a dedicated key) ──────

    settingsGet<T = Record<string, unknown>>(): Promise<T> {
        return this.request('/api/settings/get', { method: 'POST', body: {} });
    }

    settingsPatch(operations: JsonPatchOp[]): Promise<unknown> {
        return this.request('/api/settings/patch', { method: 'POST', body: { operations } });
    }
}

function safeJson(text: string): unknown {
    try { return JSON.parse(text); } catch { return text; }
}

export interface JsonPatchOp {
    op: 'add' | 'remove' | 'replace' | 'test' | 'move' | 'copy';
    path: string;
    value?: unknown;
    from?: string;
}

/** `/api/chats/get` response shape (Luker): `{ header, body }` or legacy array form. */
export interface ChatGetResult {
    header?: Record<string, unknown> & { chat_metadata?: Record<string, unknown> };
    body?: Record<string, unknown>[];
    /** legacy flat array fallback */
    [k: string]: unknown;
}

export { createPanelT0Handler, type PanelT0Deps } from './panel-t0.js';
