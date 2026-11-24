// 第一方登录面 —— enableUserAccounts 下会话失效(auth-expired 广播)时
// 以全屏蒙层接管:handle + password → POST /api/users/login(cookie-session,
// 同源凭证,apiFetch 自带 CSRF)。成功后整页重载,服务端会话 cookie 让
// SPA 以新身份重新引导 —— 比重挂在途 React 状态树更诚实。
//
// The front door lands here too: in SPA mode /login serves this shell, every
// API call answers 401, the same auth-expired broadcast fires and this gate
// renders. OAuth sign-in and password recovery must close the loop inside
// this component — there is no legacy page left to escape to.

import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { ApiError } from '../../api/client';
import { getOAuthProviders, loginAccount, requestRecoveryCode, resetPasswordWithCode } from '../../api/account';
import { oauthProviderLinks, type OAuthProviderLink } from '../../api/oauth';
import { Icon } from '../Icon';

export function LoginGate() {
    const { t } = useI18n();
    const [view, setView] = useState<'signin' | 'recover'>('signin');
    const [handle, setHandle] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [codeSent, setCodeSent] = useState(false);
    const [err, setErr] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [oauth, setOauth] = useState<OAuthProviderLink[]>([]);
    // Once the server reports code:'passwordless' for a handle, further
    // password submits against it are pointless — they can only burn the
    // 5/min login rate limit. Pin the handle until the field is edited.
    const [passwordlessFor, setPasswordlessFor] = useState('');

    // OAuth-bound accounts have no local password and the server refuses the
    // password path for them (users-public.js:684-687). The provider buttons
    // are their only way in, so they must be discovered and rendered here.
    useEffect(() => {
        let dead = false;
        void getOAuthProviders().then(providers => {
            if (!dead) setOauth(oauthProviderLinks({ providers: providers ?? undefined }));
        });
        return () => { dead = true; };
    }, []);

    function fail(e: unknown) {
        setErr(e instanceof ApiError ? e.message : String(e));
        setBusy(false);
    }

    async function submit(ev: FormEvent) {
        ev.preventDefault();
        const h = handle.trim();
        if (busy || !h) return;
        // One-shot marker: an explicit re-submit after the notice IS a new
        // attempt — an admin or recovery flow may have set a password
        // meanwhile, so a stale pin must not lock the form. Consume it;
        // a still-passwordless 403 simply re-pins below.
        if (h === passwordlessFor) setPasswordlessFor('');
        setBusy(true);
        setErr('');
        try {
            await loginAccount(h, password);
            // 重载:cookie-session 已落,服务端会再发 SPA 引导页。
            window.location.assign('/');
        } catch (e) {
            if (e instanceof ApiError && e.code === 'passwordless') {
                setPasswordlessFor(h);
                setBusy(false);
                return;
            }
            fail(e);
        }
    }

    async function submitRecover(ev: FormEvent) {
        ev.preventDefault();
        const h = handle.trim();
        if (busy || !h || (codeSent && !code.trim())) return;
        setBusy(true);
        setErr('');
        setNotice('');
        try {
            if (!codeSent) {
                // The code is printed to the server console — only the host can see it.
                await requestRecoveryCode(h);
                setCodeSent(true);
                setNotice(t('login.recover.sent'));
                setBusy(false);
                return;
            }
            await resetPasswordWithCode(h, code.trim(), newPassword);
            await loginAccount(h, newPassword);
            window.location.assign('/');
        } catch (e) {
            fail(e);
        }
    }

    function toggleView() {
        setView(view === 'signin' ? 'recover' : 'signin');
        setErr('');
        setNotice('');
        setCodeSent(false);
        setCode('');
        setPasswordlessFor('');
    }

    const recovering = view === 'recover';
    const isPasswordless = !recovering && passwordlessFor !== '' && handle.trim() === passwordlessFor;
    return (
        <div className="login-gate" role="dialog" aria-modal="true" aria-label={t('login.title')}>
            <form className="login-card" onSubmit={recovering ? submitRecover : submit}>
                <div className="login-card-head">
                    <Icon name="persona" size={22} />
                    <span>{recovering ? t('login.recover.title') : t('login.title')}</span>
                </div>
                <label className="login-field">
                    <span>{t('login.handle')}</span>
                    <input
                        autoFocus
                        autoComplete="username"
                        value={handle}
                        onChange={(e) => { setHandle(e.target.value); setPasswordlessFor(''); }}
                        disabled={busy || codeSent}
                    />
                </label>
                {!recovering && (
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
                )}
                {recovering && codeSent && (
                    <>
                        <label className="login-field">
                            <span>{t('login.recover.code')}</span>
                            <input
                                autoFocus
                                autoComplete="one-time-code"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                disabled={busy}
                            />
                        </label>
                        <label className="login-field">
                            <span>{t('login.recover.newPassword')}</span>
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                disabled={busy}
                            />
                        </label>
                    </>
                )}
                {isPasswordless && (
                    <div className="login-note" role="status">
                        <strong>{t('login.passwordless')}</strong>
                        <br />
                        {t('login.passwordless.hint')}
                    </div>
                )}
                {err && <div className="login-error" role="alert">{err}</div>}
                {notice && <div className="login-note" role="status">{notice}</div>}
                <button type="submit" disabled={busy || !handle.trim() || (recovering && codeSent && !code.trim())}>
                    {busy ? t('login.working')
                        : recovering ? (codeSent ? t('login.recover.submit') : t('login.recover.send'))
                            : t('login.submit')}
                </button>
                {!recovering && oauth.length > 0 && (
                    <div className="login-oauth">
                        <span>{t('login.oauth')}</span>
                        <div className="login-oauth-btns">
                            {oauth.map(p => (
                                <a key={p.id} className="login-oauth-btn" href={p.href}>{t(`login.oauth.${p.id}`)}</a>
                            ))}
                        </div>
                    </div>
                )}
                <button type="button" className="login-alt" onClick={toggleView} disabled={busy}>
                    {recovering ? t('login.back') : t('login.forgot')}
                </button>
            </form>
        </div>
    );
}
