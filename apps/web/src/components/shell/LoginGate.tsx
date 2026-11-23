// 第一方登录面 —— enableUserAccounts 下会话失效(auth-expired 广播)时
// 以全屏蒙层接管:handle + password → POST /api/users/login(cookie-session,
// 同源凭证,apiFetch 自带 CSRF)。成功后整页重载,服务端会话 cookie 让
// SPA 以新身份重新引导 —— 比重挂在途 React 状态树更诚实。
//
// 前门(GET / 未登录 → 302 /login)仍由服务端 legacy 登录页把守;本面只
// 覆盖「会话在 SPA 生命周期中途死掉」一段,避免突兀跳旧 UI。

import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { ApiError } from '../../api/client';
import { loginAccount } from '../../api/account';
import { Icon } from '../Icon';

export function LoginGate() {
    const { t } = useI18n();
    const [handle, setHandle] = useState('');
    const [password, setPassword] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);

    async function submit(ev: FormEvent) {
        ev.preventDefault();
        if (busy || !handle.trim()) return;
        setBusy(true);
        setErr('');
        try {
            await loginAccount(handle.trim(), password);
            // 重载:cookie-session 已落,服务端会再发 SPA 引导页。
            window.location.assign('/');
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : String(e));
            setBusy(false);
        }
    }

    return (
        <div className="login-gate" role="dialog" aria-modal="true" aria-label={t('login.title')}>
            <form className="login-card" onSubmit={submit}>
                <div className="login-card-head">
                    <Icon name="persona" size={22} />
                    <span>{t('login.title')}</span>
                </div>
                <label className="login-field">
                    <span>{t('login.handle')}</span>
                    <input
                        autoFocus
                        autoComplete="username"
                        value={handle}
                        onChange={(e) => setHandle(e.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="login-field">
                    <span>{t('login.password')}</span>
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={busy}
                    />
                </label>
                {err && <div className="login-error" role="alert">{err}</div>}
                <button type="submit" disabled={busy || !handle.trim()}>
                    {busy ? t('login.working') : t('login.submit')}
                </button>
            </form>
        </div>
    );
}
