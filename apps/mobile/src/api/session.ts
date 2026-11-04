// Connection session: baseUrl persistence (SecureStore) + mini cookie jar
// (RN fetch has NO cookie jar) + CSRF token lifecycle. Mirrors the web
// client (apps/web/src/api/client.ts) and the e2e req() pattern in
// tests/e2e/uberge-*.mjs:
//   GET /csrf-token → {token} + session cookie;
//   non-GET requests send `x-csrf-token` + `cookie` headers manually;
//   set-cookie is harvested off every response.
// `fetchBound` is injected into UbergeClient so the whole api layer shares
// one session; `apiFetch` is used directly where response headers matter
// (x-luker-generation-id on /api/uberge/generate).
import * as SecureStore from 'expo-secure-store';

const BASE_URL_KEY = 'uberge.server.baseUrl';
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
            this.jar.set(pair.split('=')[0], pair);
        }
    }
    clear(): void {
        this.jar.clear();
    }
}

class ServerSession {
    private _baseUrl = DEFAULT_BASE_URL;
    private _conn: ConnState = 'unknown';
    private _loaded = false;
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

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    };
    private emit(): void {
        for (const fn of this.listeners) fn();
    }

    /** Restore the persisted baseUrl once at startup. */
    async load(): Promise<void> {
        if (this._loaded) return;
        try {
            const v = await SecureStore.getItemAsync(BASE_URL_KEY);
            if (v) this._baseUrl = normalizeBase(v);
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
        // A different server means a different session: drop jar + token.
        this.jar.clear();
        this.csrfToken = null;
        this._conn = 'unknown';
        this._loaded = true;
        this.emit();
        try {
            await SecureStore.setItemAsync(BASE_URL_KEY, next);
        } catch {
            /* non-fatal */
        }
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
     * Session-bound fetch (injected into UbergeClient). Primes the CSRF token
     * before the call; on 403 rotates it once — the session cookie may have
     * been refreshed server-side (same policy as apps/web apiFetch).
     */
    fetchBound = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const target = typeof input === 'string' ? input : String(input);
        if (!this.csrfToken) await this.ensureCsrf();
        let res = await this.rawFetch(target, init);
        if (res.status === 403) {
            this.csrfToken = null;
            await this.ensureCsrf();
            res = await this.rawFetch(target, init);
        }
        return res;
    };

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

    /** Connectivity probe — /api/uberge/_kernel proves the plugin is mounted. */
    async check(): Promise<boolean> {
        this._conn = 'checking';
        this.emit();
        try {
            const res = await this.apiFetch('/api/uberge/_kernel');
            this._conn = res.ok ? 'online' : 'offline';
        } catch {
            this._conn = 'offline';
        }
        this.emit();
        return this._conn === 'online';
    }
}

export const session = new ServerSession();
