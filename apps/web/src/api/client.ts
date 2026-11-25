// Thin fetch wrapper for the Luker-derived server.
// POST endpoints sit behind csrf-sync (apps/server/src/server-main.js):
// GET /csrf-token → {token} + session cookie; send x-csrf-token on mutations.
// With enableUserAccounts=false (server default) setUserDataMiddleware maps
// every request to DEFAULT_USER — no login needed on localhost.

export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
        // Machine-readable discriminator echoed from the response body
        // (e.g. 'passwordless' on /api/users/login 403) — lets the UI switch
        // on the failure class without string-matching localized text.
        public readonly code?: string,
        // Leftover fields of a structured error body (card-runtime extras like
        // errors[]/warnings[]) — kept so callers can render detail the flat
        // message would otherwise drop.
        public readonly details?: Record<string, unknown>,
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
    // 判死闸复位:probe 只在 401/403 时跑,不复位则同页二次判死永远
    // 静默(首判广播后锁存器恒 true)。任一请求成功即证明会话活着。
    if (res.ok) authExpiredNotified = false;
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
        let message = unreachable ? 'upstream_unavailable' : (text || res.statusText);
        let code: string | undefined;
        // {error, code} JSON bodies (users-* endpoints): surface the human
        // string, not the blob, and carry the machine code through so callers
        // can map it to localized copy without string-matching English.
        let details: Record<string, unknown> | undefined;
        if (!unreachable && text) {
            try {
                const j = JSON.parse(text) as Record<string, unknown>;
                const errStr = typeof j.error === 'string' && j.error ? j.error : undefined;
                const detailStr = typeof j.detail === 'string' && j.detail ? j.detail : undefined;
                const codeStr = typeof j.code === 'string' && j.code ? j.code : undefined;
                // Third shape: {error:{code, message}} (admin mounts/storage
                // inspect) — unwrap the nested pair.
                const nested = (j.error && typeof j.error === 'object' ? j.error : null) as { code?: unknown; message?: unknown } | null;
                const nestedCode = nested && typeof nested.code === 'string' && nested.code ? nested.code : undefined;
                const nestedMsg = nested && typeof nested.message === 'string' && nested.message ? nested.message : undefined;
                // Two body shapes in the wild: users-* send {error:<human msg>,
                // code:<discriminator>}; card-runtime sends {error:<snake_code>,
                // detail:<human msg>, ...extras}. `detail` always wins as the
                // message; when it exists a snake_case `error` is the code.
                if (detailStr) message = detailStr;
                else if (errStr) message = errStr;
                else if (nestedMsg) message = nestedMsg;
                else if (typeof j.message === 'string' && j.message) message = j.message;
                code = codeStr ?? nestedCode ?? (detailStr && errStr && /^[a-z][a-z0-9_]*$/.test(errStr) ? errStr : undefined);
                const { error: _e, code: _c, detail: _d, message: _m, ...rest } = j;
                if (Object.keys(rest).length) details = rest;
                // Manifest-style bodies carry {errors:[...]} lines with the
                // concrete filenames — fold a few into the message so toasts
                // show what actually failed instead of just the class.
                if (Array.isArray(rest.errors)) {
                    const lines = rest.errors.filter((x): x is string => typeof x === 'string' && !!x.trim());
                    if (lines.length) {
                        const shown = lines.slice(0, 3).join('; ');
                        message = `${message} — ${shown}${lines.length > 3 ? ` (+${lines.length - 3})` : ''}`;
                    }
                }
            } catch { /* non-JSON body — keep raw text */ }
        }
        throw new ApiError(message, res.status, code, details);
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
