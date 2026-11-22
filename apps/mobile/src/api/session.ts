// Connection session: baseUrl persistence (SecureStore) + mini cookie jar
// (RN fetch has NO cookie jar) + CSRF token lifecycle + account verbs
// (login/logout/me;login 后 jar+handle 落 SecureStore 免重登)。Mirrors the web
// client (apps/web/src/api/client.ts) and the e2e req() pattern in
// tests/e2e/utopinn-*.mjs:
//   GET /csrf-token → {token} + session cookie;
//   non-GET requests send `x-csrf-token` + `cookie` headers manually;
//   set-cookie is harvested off every response.
// `fetchBound` is injected into UtopinnClient so the whole api layer shares
// one session; `apiFetch` is used directly where response headers matter
// (x-luker-generation-id on /api/utopinn/generate).
import * as SecureStore from 'expo-secure-store';

const BASE_URL_KEY = 'utopinn.server.baseUrl';
/** 登录会话(cookie-session 签名 cookie 整个就是凭证)落 SecureStore 免重登。
 *  键按 baseUrl 分桶:换服务器后旧 jar 天然不被复用(setBaseUrl 也显式清)。 */
const JAR_KEY = 'utopinn.server.jar';
const HANDLE_KEY = 'utopinn.server.handle';
/** Android emulator → host loopback. Physical device: use the LAN IP instead. */
export const DEFAULT_BASE_URL = 'http://10.0.2.2:8000';

export type ConnState = 'unknown' | 'checking' | 'online' | 'offline';

function normalizeBase(url: string): string {
    const t = url.trim().replace(/\/+$/, '');
    return t || DEFAULT_BASE_URL;
}

/**
 * set-cookie across RN fetch: prefer Headers.getSetCookie() (present in newer
 * stacks), fall back to the combined `set-cookie` header. The combined value
 * joins cookies with ", " but Expires dates also contain commas — only split
 * where the next token looks like `name=`.
 */
function readSetCookie(res: Response): string[] {
    const h = res.headers as unknown as {
        getSetCookie?: () => string[];
        get?: (name: string) => string | null;
        map?: Record<string, string | undefined>;
    };
    const arr = h.getSetCookie?.();
    if (arr?.length) return arr;
    const combined = h.get?.('set-cookie') ?? h.map?.['set-cookie'];
    if (!combined) return [];
    return combined.split(/,\s*(?=[^;,\s]+=)/);
}

class CookieJar {
    private jar = new Map<string, string>();
    header(): string | undefined {
        return this.jar.size ? [...this.jar.values()].join('; ') : undefined;
    }
    absorb(res: Response): void {
        for (const raw of readSetCookie(res)) {
            const pair = raw.split(';')[0]?.trim();
            if (!pair) continue;
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            // cookie-session 模型:空值 = 服务端清该 cookie(logout)→ 出罐,
            // 别把 "session-xxx=" 空串再塞回 Cookie 头。
            if (pair.slice(eq + 1).trim()) this.jar.set(pair.slice(0, eq), pair);
            else this.jar.delete(pair.slice(0, eq));
        }
    }
    clear(): void {
        this.jar.clear();
    }
    /** SecureStore 往返:JSON 对象 {cookieName: 'name=value'}。 */
    serialize(): string {
        return JSON.stringify(Object.fromEntries(this.jar));
    }
    restore(raw: string | null): void {
        if (!raw) return;
        try {
            const obj = JSON.parse(raw) as Record<string, unknown>;
            for (const [k, v] of Object.entries(obj)) {
                if (typeof v === 'string' && v.includes('=')) this.jar.set(k, v);
            }
        } catch { /* 坏档当没有 */ }
    }
    get empty(): boolean {
        return this.jar.size === 0;
    }
}

class ServerSession {
    private _baseUrl = DEFAULT_BASE_URL;
    private _conn: ConnState = 'unknown';
    private _loaded = false;
    private _handle: string | null = null;
    private jar = new CookieJar();
    private csrfToken: string | null = null;
    private csrfInflight: Promise<string | null> | null = null;
    private listeners = new Set<() => void>();

    get baseUrl(): string {
        return this._baseUrl;
    }
    get conn(): ConnState {
        return this._conn;
    }
    /** true once the persisted baseUrl has been read from SecureStore. */
    get loaded(): boolean {
        return this._loaded;
    }
    /** 已登录 handle(内存态;持久化恢复后也有值)。accounts-off → null 语义不明,别拿它判权限。 */
    get handle(): string | null {
        return this._handle;
    }

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    };
    private emit(): void {
        for (const fn of this.listeners) fn();
    }

    /** Restore the persisted baseUrl + session jar once at startup. */
    async load(): Promise<void> {
        if (this._loaded) return;
        try {
            const v = await SecureStore.getItemAsync(BASE_URL_KEY);
            if (v) this._baseUrl = normalizeBase(v);
            // 登录会话恢复:jar(签名 cookie)+ handle 上次 login 落的档。
            // 死会话(改密/服务端重启轮换 secret)交给首个 403 自然暴露,
            // 不在启动时多打一次探测请求。
            this.jar.restore(await SecureStore.getItemAsync(JAR_KEY));
            this._handle = await SecureStore.getItemAsync(HANDLE_KEY);
        } catch {
            /* SecureStore unavailable (web/dev) → default */
        }
        this._loaded = true;
        this.emit();
    }

    async setBaseUrl(url: string): Promise<void> {
        const next = normalizeBase(url);
        if (next === this._baseUrl && this._loaded) return;
        this._baseUrl = next;
        // A different server means a different session: drop jar + token + persisted creds.
        this.jar.clear();
        this.csrfToken = null;
        this._handle = null;
        this._conn = 'unknown';
        this._loaded = true;
        this.emit();
        try {
            await SecureStore.setItemAsync(BASE_URL_KEY, next);
            await SecureStore.deleteItemAsync(JAR_KEY);
            await SecureStore.deleteItemAsync(HANDLE_KEY);
        } catch {
            /* non-fatal */
        }
    }

    /** jar+handle 落 SecureStore(login 成功后;死会话清档走 clearPersisted)。 */
    private async persistSession(): Promise<void> {
        try {
            if (this.jar.empty) {
                await SecureStore.deleteItemAsync(JAR_KEY);
            } else {
                await SecureStore.setItemAsync(JAR_KEY, this.jar.serialize());
            }
            if (this._handle) await SecureStore.setItemAsync(HANDLE_KEY, this._handle);
            else await SecureStore.deleteItemAsync(HANDLE_KEY);
        } catch { /* SecureStore 不可用时会话只剩内存态 */ }
    }
    private async clearPersisted(): Promise<void> {
        try {
            await SecureStore.deleteItemAsync(JAR_KEY);
            await SecureStore.deleteItemAsync(HANDLE_KEY);
        } catch { /* non-fatal */ }
    }

    url(path: string): string {
        return `${this._baseUrl}${path}`;
    }
    /** ws(s):// URL for /api/ws-delivery. */
    wsUrl(path: string): string {
        return `${this._baseUrl.replace(/^http/i, 'ws')}${path}`;
    }

    /** Raw fetch: cookie + csrf headers in, set-cookie out. No retry. */
    private async rawFetch(input: string, init?: RequestInit): Promise<Response> {
        const headers = new Headers(init?.headers);
        const cookie = this.jar.header();
        if (cookie) headers.set('cookie', cookie);
        if (this.csrfToken) headers.set('x-csrf-token', this.csrfToken);
        const res = await fetch(input, { ...init, headers });
        this.jar.absorb(res);
        return res;
    }

    private ensureCsrf(): Promise<string | null> {
        if (this.csrfToken) return Promise.resolve(this.csrfToken);
        this.csrfInflight ??= this.rawFetch(this.url('/csrf-token'))
            .then(async (res) => {
                const body = (await res.json().catch(() => ({}))) as { token?: string };
                this.csrfToken = res.ok ? (body.token ?? null) : null;
                return this.csrfToken;
            })
            .catch(() => null)
            .finally(() => {
                this.csrfInflight = null;
            });
        return this.csrfInflight;
    }

    /**
     * Session-bound fetch (injected into UtopinnClient). Primes the CSRF token
     * before the call; on 403 rotates it once — the session cookie may have
     * been refreshed server-side (same policy as apps/web apiFetch).
     * 重轮换后仍 403:me() 探针分清「登录会话死」(清持久档,UI 引导重登)
     * 与「权限不足」(非 admin 调 admin 面,会话无罪,不动)。
     */
    fetchBound = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const target = typeof input === 'string' ? input : String(input);
        if (!this.csrfToken) await this.ensureCsrf();
        let res = await this.rawFetch(target, init);
        if (res.status === 403) {
            this.csrfToken = null;
            await this.ensureCsrf();
            res = await this.rawFetch(target, init);
            if (res.status === 403 || res.status === 401) void this.probeSessionDead();
        }
        return res;
    };

    /** me() 也 401/403 → 登录会话真死了(改密/禁用/secret 轮换)→ 清持久档。 */
    private async probeSessionDead(): Promise<void> {
        try {
            const me = await this.rawFetch(this.url('/api/users/me'));
            if (me.status === 401 || me.status === 403) {
                this._handle = null;
                await this.clearPersisted();
                this.emit();
            }
        } catch { /* 网络层失败不判死,按原错误路径走 */ }
    }

    /** Path shorthand over fetchBound for calls that need the raw Response. */
    apiFetch(path: string, init?: RequestInit): Promise<Response> {
        return this.fetchBound(this.url(path), init);
    }

    async apiPost<T>(path: string, body: unknown): Promise<T> {
        const res = await this.apiFetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 200)}`);
        return (text ? JSON.parse(text) : {}) as T;
    }

    // ─── account 面(login/logout/me;multi-user.md §3.3)─────────────────

    /**
     * POST /api/users/login —— CSRF 先行(ensureCsrf 备好匿名 session+token),
     * 走 rawFetch 不走 fetchBound:凭据错的 403 不该触发「轮换重试」
     * (重试同样败,白烧服务端 5/min 登录限流点)。成功后同 jar 即登录态
     * (Set-Cookie 已被 rawFetch 收进 jar),jar+handle 落 SecureStore。
     * TODO(UI): 登录屏(server URL 输入已有;补 handle+password 表单)
     * 按 mobile-app-stack 形态另起;现在只接 api 层。
     */
    async login(handle: string, password: string): Promise<{ handle: string }> {
        await this.ensureCsrf();
        const res = await this.rawFetch(this.url('/api/users/login'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ handle, password }),
        });
        const text = await res.text();
        if (!res.ok) {
            let msg = text.slice(0, 160);
            try { msg = (JSON.parse(text) as { error?: string }).error ?? msg; } catch { /* 非 JSON 原样 */ }
            throw new Error(`login failed (${res.status}): ${msg}`);
        }
        const data = (text ? JSON.parse(text) : {}) as { handle?: string };
        this._handle = data.handle ?? handle;
        await this.persistSession();
        this.emit();
        return { handle: this._handle };
    }

    /** GET /api/users/me —— 「登录了吗/是谁」探针。accounts-off 恒返 default-user。 */
    async me<T = {
        handle: string; name: string; avatar: string;
        admin: boolean; password: boolean; created?: number;
    }>(): Promise<T> {
        const res = await this.apiFetch('/api/users/me');
        const text = await res.text();
        if (!res.ok) throw new Error(`me → ${res.status}`);
        return (text ? JSON.parse(text) : {}) as T;
    }

    /** POST /api/users/logout —— 服务端清 session;本地 jar+持久档一起清。 */
    async logout(): Promise<void> {
        try {
            await this.apiFetch('/api/users/logout', { method: 'POST' });
        } catch { /* 服务端够不着/会话已死也照常清本地 */ }
        this.jar.clear();
        this.csrfToken = null;
        this._handle = null;
        await this.clearPersisted();
        this.emit();
    }

    /** Connectivity probe — /api/utopinn/_kernel proves the plugin is mounted. */
    async check(): Promise<boolean> {
        this._conn = 'checking';
        this.emit();
        try {
            const res = await this.apiFetch('/api/utopinn/_kernel');
            this._conn = res.ok ? 'online' : 'offline';
        } catch {
            this._conn = 'offline';
        }
        this.emit();
        return this._conn === 'online';
    }
}

export const session = new ServerSession();
