/**
 * account 域 —— /api/users/* 薄登录面(multi-user.md §3.3 G1)。
 *
 * 线形(Luker users-public/users-private 原样):
 *   POST /api/users/login  {handle,password} → 200 {handle} | 403 {error} | 429 限流
 *   GET  /api/users/me                       → 200 {handle,name,avatar,admin,password,created} | 403
 *   POST /api/users/logout                   → 204
 *
 * 会话模型:cookie-session —— session(含 handle/version/csrfToken)整个序列化
 * 在签名 cookie 里,login 响应的 Set-Cookie 才是升级后的凭证,perform() 的
 * absorbSetCookie 必须吃到它(index.ts)。CSRF token 也存 session,login 前
 * fetchCsrfToken 握手出的匿名 cookie + token 直接可用。
 *
 * accounts-off(enableUserAccounts=false)时 me() 恒返 default-user(admin),
 * login 是 no-op —— 调用方不用分环境。
 */

import type { UtopinnClient } from './index.js';

/** GET /api/users/me 视图(users-private.js 原样)。accounts-off → default-user。 */
export interface AccountMe {
    handle: string;
    name: string;
    avatar: string;
    admin: boolean;
    /** 是否设过密码(OAuth-only 账户恒 false)。 */
    password: boolean;
    created?: number;
}

/** POST /api/users/login 成功回执。 */
export interface AccountLoginResponse {
    handle: string;
}

export class AccountApi {
    constructor(private readonly client: UtopinnClient) {}

    /**
     * POST /api/users/login —— 先经 autoSession 握 CSRF+cookie,再 POST。
     * 成功后同一 cookie jar 即已登录态(session 升级经 Set-Cookie 收进 jar)。
     * skipReauth:凭据错返 403,不该触发「清会话重握手再试」——重试同样会败,
     * 还白烧一次登录限流点(5/min)。
     */
    login(handle: string, password: string): Promise<AccountLoginResponse> {
        return this.client.request('/api/users/login', {
            method: 'POST',
            body: { handle, password },
            skipReauth: true,
        });
    }

    /** POST /api/users/logout —— 服务端清 session(204),本地 jar 也清干净。 */
    async logout(): Promise<void> {
        await this.client.request('/api/users/logout', { method: 'POST' });
        this.client.clearSession();
    }

    /** GET /api/users/me —— 「登录了吗/是谁」探针;403 = 会话死/未登录。 */
    me(): Promise<AccountMe> {
        return this.client.request('/api/users/me');
    }
}
