/**
 * 错误模型 — CLI cmdCli fail-code 语义的客户端映射:
 *   401/403 → 'session'(自动重取 CSRF 一次后仍败才抛)
 *   404     → 'not_found'
 *   409     → 'integrity_conflict'(body/消息含 integrity/current_integrity)
 *             其余 409(撞名/已存在)→ 'exists'
 *   fetch 层断网/DNS → 'network'(status 0)
 *   其余 HTTP → 'server'
 *   客户端参数错(非 HTTP)→ 'usage'
 */

export type ApiErrorCode =
    | 'session'
    | 'not_found'
    | 'integrity_conflict'
    | 'exists'
    | 'server'
    | 'network'
    | 'usage';

export class ApiError extends Error {
    readonly status: number;
    /** 服务端响应体(已解析 JSON;非 JSON 为原始文本;空体为 undefined)。 */
    readonly body: unknown;
    readonly code: ApiErrorCode;
    readonly headers?: Headers;

    constructor(status: number, body?: unknown, message?: string, code?: ApiErrorCode, headers?: Headers) {
        super(message ?? `HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
        this.headers = headers;
        this.code = code ?? defaultCode(status, body);
    }
}

function bodyText(body: unknown): string {
    if (body === undefined || body === null) return '';
    return typeof body === 'string' ? body : JSON.stringify(body);
}

function defaultCode(status: number, body: unknown): ApiErrorCode {
    if (status === 401 || status === 403) return 'session';
    if (status === 404) return 'not_found';
    if (status === 409) {
        // CLI 同款判别:body+message 里出现 integrity 字样才算 CAS 冲突
        return /integrity/i.test(bodyText(body)) ? 'integrity_conflict' : 'exists';
    }
    return 'server';
}

// ─── 判别 helpers(CLI isIntegrityConflict / fail-code 的客户端版)────────

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** 401|403 会话失效。 */
export const isSessionError = (e: unknown): boolean =>
    isApiError(e) && (e.status === 401 || e.status === 403);

/** 404。 */
export const isNotFound = (e: unknown): boolean =>
    isApiError(e) && e.status === 404;

/** 任意 409(integrity CAS 或 撞名)。 */
export const isConflict = (e: unknown): boolean =>
    isApiError(e) && e.status === 409;

/**
 * 409 integrity CAS——body 带 current_integrity/actual,可重锚。
 * CLI 判别是 /integrity/i 扫 body+message;这里按构造期 code 判,
 * 再 fallback 同样的正则(兼容外部手动构造的 error 形)。
 */
export const isIntegrityConflict = (e: unknown): boolean => {
    if (!isApiError(e)) {
        const err = e as { status?: number; body?: unknown; data?: unknown; message?: string };
        return err?.status === 409
            && /integrity/i.test(JSON.stringify(err?.body ?? err?.data ?? '') + (err?.message ?? ''));
    }
    return e.status === 409 && e.code === 'integrity_conflict';
};

/** 409 撞名/已存在(非 integrity)。 */
export const isExistsConflict = (e: unknown): boolean =>
    isApiError(e) && e.status === 409 && e.code === 'exists';

/** ≥500 或 code='server'。 */
export const isServerError = (e: unknown): boolean =>
    isApiError(e) && (e.code === 'server' || e.status >= 500);

/** fetch 层失败(断网/DNS/CORS)——status 0,code='network'。 */
export const isNetworkError = (e: unknown): boolean =>
    isApiError(e) && e.code === 'network';

/**
 * 从 409 body 取新锚:current_integrity(chat-put/append)|actual(state patch)|
 * expected 是给调用方的旧值,不是新锚。
 */
export function currentIntegrityFrom(e: unknown): string | null {
    if (!isApiError(e) || e.status !== 409) return null;
    const b = e.body as { current_integrity?: unknown; actual?: unknown; integrity?: unknown } | null;
    if (b && typeof b === 'object') {
        for (const k of ['current_integrity', 'actual', 'integrity'] as const) {
            const v = b[k];
            if (typeof v === 'string' && v) return v;
        }
    }
    return null;
}

/**
 * CLI writeOp 的 "409 重锚一次" 编排——薄客户端 CAS 写的标准用法:
 *   const {result} = await retryOnIntegrityConflict(
 *     (integrity) => client.library.patchChat(dir, chat, ops, {integrity}),
 *     {initial: lastKnownIntegrity});
 * 成功回 {result, integrity}(从新响应提取,供下次写锚定)。
 */
export async function retryOnIntegrityConflict<T>(
    attempt: (integrity: string | null) => Promise<T>,
    opts: {
        initial?: string | null;
        retries?: number;
        /** 从成功响应提取新锚(默认查 .integrity/.state_integrity)。 */
        extract?: (result: T) => string | null | undefined;
    } = {},
): Promise<{ result: T; integrity: string | null }> {
    const retries = opts.retries ?? 1;
    const extract = opts.extract
        ?? ((r: T) => (r as { integrity?: string; state_integrity?: string })?.integrity
            ?? (r as { state_integrity?: string })?.state_integrity
            ?? null);
    let integrity = opts.initial ?? null;
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
        try {
            const result = await attempt(integrity);
            return { result, integrity: extract(result) ?? integrity };
        } catch (e) {
            if (!isIntegrityConflict(e)) throw e;
            const fresh = currentIntegrityFrom(e);
            if (!fresh) throw e;
            integrity = fresh;
            lastErr = e;
        }
    }
    throw lastErr;
}
