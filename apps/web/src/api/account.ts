// 当前 handle 自助面(/api/users private 族)——
// GET /me(当前用户画像 + admin 标志);POST /change-name & /change-password
// 同样被 admin 跨 handle 复用(服务端判据:self || request.user.profile.admin)。
// 全部走 apiFetch(CSRF token + 403 轮换已内建)。
import { ApiError, apiFetch, assertOk } from './client';

export interface CurrentUser {
    handle: string;
    name: string;
    avatar: string;
    admin: boolean;
    password: boolean;
    created?: number;
}

async function parseErrorText(res: Response): Promise<string> {
    const raw = await res.text().catch(() => '');
    if (!raw) return res.statusText || `HTTP ${res.status}`;
    try {
        const j = JSON.parse(raw) as { error?: unknown; message?: unknown };
        if (typeof j.error === 'string' && j.error) return j.error;
        if (typeof j.message === 'string' && j.message) return j.message;
    } catch {
        /* 非 JSON 文本原样返回 */
    }
    return raw;
}

/** GET /api/users/me —— accounts-off 时恒返 default-user(admin=true)。 */
export async function getMe(): Promise<CurrentUser> {
    const res = await apiFetch('/api/users/me');
    await assertOk(res);
    return (await res.json()) as CurrentUser;
}

/**
 * POST /api/users/login —— cookie-session 登录;成功后 session.handle 落在
 * 现有 cookie 上,无需换发。CSRF:登录也是 mutation,apiFetch 会先取
 * /csrf-token(匿名会话即有 token 槽),401/403 时壳层已判死广播。
 * 失败的 403 语义服务端统一为 'Incorrect credentials',不区分未知 handle。
 */
export async function loginAccount(handle: string, password: string): Promise<void> {
    const res = await apiFetch('/api/users/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, password }),
    });
    if (!res.ok) throw new ApiError(await parseErrorText(res), res.status);
}

/** POST /api/users/logout —— 清 session.handle/csrfToken/version。 */
export async function logoutAccount(): Promise<void> {
    const res = await apiFetch('/api/users/logout', { method: 'POST' });
    if (!res.ok) throw new ApiError(await parseErrorText(res), res.status);
}

/** POST /api/users/change-name —— 改显示名(204 No Content)。 */
export async function changeUserName(handle: string, name: string): Promise<void> {
    const res = await apiFetch('/api/users/change-name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, name }),
    });
    if (!res.ok) throw new ApiError(await parseErrorText(res), res.status);
}

/** POST /api/users/change-password —— 设/清密码(newPassword 空串 = 清除;admin 无需旧密)。 */
export async function changeUserPassword(handle: string, newPassword: string, oldPassword?: string): Promise<void> {
    const res = await apiFetch('/api/users/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, newPassword, ...(oldPassword !== undefined ? { oldPassword } : {}) }),
    });
    if (!res.ok) throw new ApiError(await parseErrorText(res), res.status);
}
