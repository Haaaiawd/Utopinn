// 当前 handle 自助面(/api/users private 族)——
// GET /me(当前用户画像 + admin 标志);POST /change-name & /change-password
// 同样被 admin 跨 handle 复用(服务端判据:self || request.user.profile.admin)。
// 全部走 apiFetch(CSRF token + 403 轮换已内建)。
import { ApiError, apiFetch, assertOk } from './client';
import type { OAuthProviderMap } from './oauth';

export interface CurrentUser {
    handle: string;
    name: string;
    avatar: string;
    admin: boolean;
    password: boolean;
    created?: number;
}

/** 解服务端 {error, code} JSON 错误体;text 取人读串,code 取机器判别码(若有)。 */
async function parseErrorBody(res: Response): Promise<{ text: string; code?: string }> {
    const raw = await res.text().catch(() => '');
    if (!raw) return { text: res.statusText || `HTTP ${res.status}` };
    try {
        const j = JSON.parse(raw) as { error?: unknown; message?: unknown; code?: unknown };
        const text = typeof j.error === 'string' && j.error ? j.error
            : typeof j.message === 'string' && j.message ? j.message
                : raw;
        const code = typeof j.code === 'string' && j.code ? j.code : undefined;
        return { text, code };
    } catch {
        /* 非 JSON 文本原样返回 */
    }
    return { text: raw };
}

async function throwApiError(res: Response): Promise<never> {
    const { text, code } = await parseErrorBody(res);
    throw new ApiError(text, res.status, code);
}

/** GET /api/users/me —— accounts-off 时恒返 default-user(admin=true)。 */
export async function getMe(): Promise<CurrentUser> {
    const res = await apiFetch('/api/users/me');
    await assertOk(res);
    return (await res.json()) as CurrentUser;
}

export type AuthProbe = 'authed' | 'guest' | 'unreachable';

/**
 * Pre-shell auth probe — plain fetch, deliberately NOT apiFetch: the gate
 * runs before any app surface exists, so there is no CSRF dance to reuse and
 * no auth-expired broadcast to trigger twice. A 200 unlocks the shell;
 * 401/403 means accounts are on and there is no session → the standalone
 * landing renders; anything else (server down, proxy absent, 5xx) cannot
 * prove auth either way → fail closed, the landing renders too.
 */
export async function probeAuthState(): Promise<AuthProbe> {
    try {
        const res = await fetch('/api/users/me');
        if (res.ok) return 'authed';
        if (res.status === 401 || res.status === 403) return 'guest';
        return 'unreachable';
    } catch {
        return 'unreachable';
    }
}

/**
 * POST /api/users/login —— cookie-session 登录;成功后 session.handle 落在
 * 现有 cookie 上,无需换发。CSRF:登录也是 mutation,apiFetch 会先取
 * /csrf-token(匿名会话即有 token 槽),401/403 时壳层已判死广播。
 * 失败的 403 语义服务端统一为 'Incorrect credentials',不区分未知 handle。
 * retryOn403=false:403 在这里是凭证答案而非 CSRF 过期——重放会让
 * loginLimiter(校凭证前计 IP,5/min)把一次错登记成两次。
 */
export async function loginAccount(handle: string, password: string): Promise<void> {
    const res = await apiFetch('/api/users/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, password }),
    }, { retryOn403: false });
    if (!res.ok) {
        const { text, code } = await parseErrorBody(res);
        throw new ApiError(text, res.status, code);
    }
}

/** POST /api/users/logout —— 清 session.handle/csrfToken/version。 */
export async function logoutAccount(): Promise<void> {
    const res = await apiFetch('/api/users/logout', { method: 'POST' });
    if (!res.ok) await throwApiError(res);
}

/** POST /api/users/oauth/providers — anonymous-reachable; failure/unconfigured → null (LoginGate hides the OAuth row). */
export async function getOAuthProviders(): Promise<OAuthProviderMap | null> {
    try {
        const res = await apiFetch('/api/users/oauth/providers', { method: 'POST' });
        if (!res.ok) return null;
        const body = (await res.json()) as { providers?: OAuthProviderMap };
        return body.providers ?? null;
    } catch {
        return null;
    }
}

export interface RegistrationInfo {
    enabled: boolean;
    requireInviteCode: boolean;
}

/**
 * POST /api/users/registration/info — anonymous-reachable probe for the
 * self-service register surface. Failure/unavailable → null: the LoginGate
 * then hides the create-account entry entirely (same honesty rule as the
 * OAuth row — a dead endpoint must not advertise a dead form).
 */
export async function getRegistrationInfo(): Promise<RegistrationInfo | null> {
    try {
        const res = await apiFetch('/api/users/registration/info', { method: 'POST' });
        if (!res.ok) return null;
        const body = (await res.json()) as Partial<RegistrationInfo>;
        if (typeof body.enabled !== 'boolean') return null;
        return { enabled: body.enabled, requireInviteCode: Boolean(body.requireInviteCode) };
    } catch {
        return null;
    }
}

/**
 * POST /api/users/register — creates the account and drops a signed-in
 * session cookie (server sets request.session.handle), so the caller only
 * needs a full reload, no separate login call. retryOn403=false: a 403 here
 * is the invite/registration domain answer, not CSRF expiry — a replay would
 * double-count the attempt in registerLimiter.
 */
export async function registerAccount(input: {
    handle: string;
    name: string;
    password: string;
    inviteCode?: string;
}): Promise<void> {
    const res = await apiFetch('/api/users/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    }, { retryOn403: false });
    if (!res.ok) await throwApiError(res);
}

/**
 * POST /api/users/recover-step1 — the recovery code is printed to the server
 * console (204); only the host/admin can retrieve it. 403/404 are domain
 * answers, not CSRF expiry — retryOn403=false.
 */
export async function requestRecoveryCode(handle: string): Promise<void> {
    const res = await apiFetch('/api/users/recover-step1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
    }, { retryOn403: false });
    if (!res.ok) await throwApiError(res);
}

/** POST /api/users/recover-step2 — code + newPassword; empty newPassword clears the password (403 = wrong code). */
export async function resetPasswordWithCode(handle: string, code: string, newPassword: string): Promise<void> {
    const res = await apiFetch('/api/users/recover-step2', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, code, newPassword }),
    }, { retryOn403: false });
    if (!res.ok) await throwApiError(res);
}

/** POST /api/users/change-name —— 改显示名(204 No Content)。 */
export async function changeUserName(handle: string, name: string): Promise<void> {
    const res = await apiFetch('/api/users/change-name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, name }),
    });
    if (!res.ok) await throwApiError(res);
}

/** POST /api/users/change-password —— 设/清密码(newPassword 空串 = 清除;admin 无需旧密)。 */
export async function changeUserPassword(handle: string, newPassword: string, oldPassword?: string): Promise<void> {
    const res = await apiFetch('/api/users/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, newPassword, ...(oldPassword !== undefined ? { oldPassword } : {}) }),
    });
    if (!res.ok) await throwApiError(res);
}

/**
 * 账号域错误 → 本地化文案。users-*(public/admin/private)错误体带稳定
 * `code` 机器判别码;已知码映射 `login.err.<code>` 词条,未知码/无码
 * 回落原始 message(诚实露出,不编造语义)。
 */
const LOCALIZED_ERR_CODES = new Set([
    'missing_fields', 'invalid_handle', 'user_exists', 'registration_disabled',
    'incorrect_credentials', 'user_disabled', 'passwordless', 'rate_limited',
    'user_not_found', 'incorrect_code', 'unauthorized', 'incorrect_password',
    'cannot_self', 'protected_user',
    'invite_code_required', 'invalid_invite_code', 'invite_code_revoked',
    'invite_code_expired', 'invite_code_exhausted',
]);

export function accountErrorText(e: unknown, t: (key: string) => string): string {
    if (e instanceof ApiError && e.code && LOCALIZED_ERR_CODES.has(e.code)) {
        return t(`login.err.${e.code}`);
    }
    return e instanceof Error ? e.message : String(e);
}
