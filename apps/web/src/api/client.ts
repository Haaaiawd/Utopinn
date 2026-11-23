// Thin fetch wrapper for the Luker-derived server.
// POST endpoints sit behind csrf-sync (apps/server/src/server-main.js):
// GET /csrf-token → {token} + session cookie; send x-csrf-token on mutations.
// With enableUserAccounts=false (server default) setUserDataMiddleware maps
// every request to DEFAULT_USER — no login needed on localhost.

export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

let csrfToken: string | null = null;

async function fetchCsrfToken(): Promise<string | null> {
    const res = await fetch('/csrf-token');
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    csrfToken = body.token ?? null;
    return csrfToken;
}

/** 会话死透判定去重:多并发 403 只打一次 /api/users/me 探针。 */
let sessionProbe: Promise<void> | null = null;
let authExpiredNotified = false;

/**
 * enableUserAccounts 下,持续 401/403 有两种成因:「登录会话死」
 * (过期/改密/禁用/secret 轮换)与「权限不足」(非 admin 碰 admin 面)。
 * me() 同挂才判死 —— 判死后广播 'utopinn:auth-expired',壳层引导去
 * /login(legacy 页恒可服务);accounts-off 时 me() 恒 200,永不触发。
 */
async function reportIfSessionDead(): Promise<void> {
    sessionProbe ??= (async () => {
        try {
            const res = await fetch('/api/users/me', {
                headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
            });
            if (res.status === 401 || res.status === 403) {
                if (!authExpiredNotified && typeof window !== 'undefined') {
                    authExpiredNotified = true;
                    window.dispatchEvent(new CustomEvent('utopinn:auth-expired'));
                }
            } else if (res.ok) {
                authExpiredNotified = false;
            }
        } catch { /* 网络层失败不判死 —— server down 走 offline 路径 */ } finally {
            sessionProbe = null;
        }
    })();
    return sessionProbe;
}

/**
 * fetch() with CSRF header attached. Retries once on 403 by rotating the
 * token — the session cookie may have been refreshed server-side.
 *
 * `opts.retryOn403 === false` skips that replay: callers whose 403 is a
 * *domain* answer (e.g. /api/users/login 'Incorrect credentials') must not
 * re-POST — the server rate limiter counts before checking credentials, so
 * a replayed wrong-password attempt burns two of the 5/min budget.
 */
export async function apiFetch(path: string, init: RequestInit = {}, opts: { retryOn403?: boolean } = {}): Promise<Response> {
    if (csrfToken === null) {
        try { await fetchCsrfToken(); } catch { /* server may be down; let fetch fail */ }
    }
    const makeHeaders = () => {
        const h = new Headers(init.headers);
        if (csrfToken) h.set('x-csrf-token', csrfToken);
        return h;
    };
    let res = await fetch(path, { ...init, headers: makeHeaders() });
    if (res.status === 403 && opts.retryOn403 !== false) {
        csrfToken = null;
        try { await fetchCsrfToken(); } catch { /* ignore */ }
        res = await fetch(path, { ...init, headers: makeHeaders() });
    }
    if (res.status === 401 || res.status === 403) void reportIfSessionDead();
    return res;
}

/**
 * Shared !ok → ApiError mapping. Vite dev proxy marks unreachable upstreams
 * with 502 + a header so the UI can fall back to labelled mock data
 * (see vite.config.ts).
 */
export async function assertOk(res: Response): Promise<void> {
    if (!res.ok) {
        const unreachable = res.status === 502 && res.headers.has('x-utopinn-proxy-error');
        const text = await res.text().catch(() => '');
        throw new ApiError(unreachable ? 'upstream_unavailable' : (text || res.statusText), res.status);
    }
}

export async function apiGet<T>(path: string): Promise<T> {
    const res = await apiFetch(path);
    await assertOk(res);
    return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    await assertOk(res);
    return (await res.json()) as T;
}
