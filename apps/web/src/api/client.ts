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

/**
 * fetch() with CSRF header attached. Retries once on 403 by rotating the
 * token — the session cookie may have been refreshed server-side.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (csrfToken === null) {
        try { await fetchCsrfToken(); } catch { /* server may be down; let fetch fail */ }
    }
    const makeHeaders = () => {
        const h = new Headers(init.headers);
        if (csrfToken) h.set('x-csrf-token', csrfToken);
        return h;
    };
    let res = await fetch(path, { ...init, headers: makeHeaders() });
    if (res.status === 403) {
        csrfToken = null;
        try { await fetchCsrfToken(); } catch { /* ignore */ }
        res = await fetch(path, { ...init, headers: makeHeaders() });
    }
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
