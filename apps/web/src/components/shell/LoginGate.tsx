// First-party sign-in form — handle + password → POST /api/users/login
// (cookie-session, same-origin credentials, apiFetch carries CSRF). On
// success the page reloads wholesale so the server-issued session cookie
// reboots the SPA fresh — more honest than re-mounting the in-flight React
// tree. `postLoginUrl` is the reload target; LoginLanding passes the deep
// link the guest arrived on.
//
// Container story: this is the form half of LoginLanding's split-screen —
// rendered as page content, never as an overlay over the shell (App.tsx's
// AuthGate is what decides shell-vs-landing; the shell is absent from the
// DOM for guests). The front door lands here too: in SPA mode /login serves
// the app, the me() probe answers 401/403, and the landing renders. OAuth
// sign-in and password recovery must close the loop inside this component —
// there is no legacy page left to escape to.

import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { ApiError } from '../../api/client';
import { accountErrorText, getOAuthProviders, getRegistrationInfo, loginAccount, registerAccount, requestRecoveryCode, resetPasswordWithCode, type RegistrationInfo } from '../../api/account';
import { oauthProviderLinks, type OAuthProviderLink } from '../../api/oauth';
import { LogoU } from '../LogoU';

// OAuth callback failures bounce back as /login?error=<reason>
// (users-public.js redirectToLoginWithError). The SPA owns /login — nothing
// else reads the param. Reasons with a user-actionable meaning get their own
// copy; the rest (state/token/callback plumbing) share the generic line.
const OAUTH_ERR_KEYS: Record<string, string> = {
    oauth_user_disabled: 'login.err.oauth.disabled',
    oauth_user_not_linked: 'login.err.oauth.notLinked',
    discord_guild_check_failed: 'login.err.oauth.guild',
    provider_not_configured: 'login.err.oauth.notConfigured',
    unsupported_provider: 'login.err.oauth.notConfigured',
};

export function LoginGate({ postLoginUrl = '/' }: { postLoginUrl?: string }) {
    const { t } = useI18n();
    const [view, setView] = useState<'signin' | 'recover' | 'register'>('signin');
    const [handle, setHandle] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [name, setName] = useState('');
    const [confirm, setConfirm] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [codeSent, setCodeSent] = useState(false);
    const [err, setErr] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [oauth, setOauth] = useState<OAuthProviderLink[]>([]);
    // null = probe unanswered/failed → no register entry (server never
    // advertises a form it would refuse).
    const [regInfo, setRegInfo] = useState<RegistrationInfo | null>(null);
    // Once the server reports code:'passwordless' for a handle, further
    // password submits against it are pointless — they can only burn the
    // 5/min login rate limit. Pin the handle until the field is edited.
    const [passwordlessFor, setPasswordlessFor] = useState('');

    // OAuth-bound accounts have no local password and the server refuses the
    // password path for them (users-public.js /login, ~line 690). The provider buttons
    // are their only way in, so they must be discovered and rendered here.
    useEffect(() => {
        let dead = false;
        void getOAuthProviders().then(providers => {
            if (!dead) setOauth(oauthProviderLinks({ providers: providers ?? undefined }));
        });
        void getRegistrationInfo().then(info => {
            if (!dead) setRegInfo(info);
        });
        return () => { dead = true; };
    }, []);

    // Surface the ?error=<reason> bounce once, then strip it so a reload or a
    // bookmarked URL doesn't replay a stale OAuth failure.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const reason = params.get('error');
        if (!reason) return;
        params.delete('error');
        const qs = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
        const key = OAUTH_ERR_KEYS[reason];
        setErr(key ? t(key) : t('login.err.oauth'));
    }, [t]);

    function fail(e: unknown) {
        setErr(accountErrorText(e, t));
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
            // postLoginUrl keeps the deep link the guest arrived on
            // (LoginLanding computes it; '/' when mounted bare).
            window.location.assign(postLoginUrl);
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
            window.location.assign(postLoginUrl);
        } catch (e) {
            fail(e);
        }
    }

    async function submitRegister(ev: FormEvent) {
        ev.preventDefault();
        const h = handle.trim();
        const n = name.trim();
        const invite = inviteCode.trim();
        if (busy || !h || !n || !password) return;
        // Fail fast on the fields the server would reject anyway — the same
        // pre-checks the legacy register form runs, so a doomed submit never
        // burns a registerLimiter slot.
        if (password !== confirm) {
            setErr(t('login.register.errConfirm'));
            return;
        }
        if (regInfo?.requireInviteCode && !invite) {
            setErr(t('login.err.invite_code_required'));
            return;
        }
        setBusy(true);
        setErr('');
        try {
            // The server signs the session in on success — same landing as login.
            await registerAccount({ handle: h, name: n, password, ...(invite ? { inviteCode: invite } : {}) });
            window.location.assign(postLoginUrl);
        } catch (e) {
            fail(e);
        }
    }

    function gotoView(next: 'signin' | 'recover' | 'register') {
        setView(next);
        setErr('');
        setNotice('');
        setCodeSent(false);
        setCode('');
        setPasswordlessFor('');
    }

    const recovering = view === 'recover';
    const registering = view === 'register';
    const isPasswordless = view === 'signin' && passwordlessFor !== '' && handle.trim() === passwordlessFor;
    // Container only — the split-screen landing owns the page layout
    // (spec.css .login-landing); .login-gate is now the in-flow flex
    // scroller inside the form panel, not a modal overlay, so the
    // dialog/aria-modal semantics went with it.
    return (
        <div className="login-gate">
            <form className="login-card" onSubmit={registering ? submitRegister : recovering ? submitRecover : submit}>
                <div className="login-card-head">
                    <LogoU size={24} />
                    <span>{registering ? t('login.register.title') : recovering ? t('login.recover.title') : t('login.title')}</span>
                </div>
                {registering && (
                    <label className="login-field">
                        <span>{t('login.register.name')}</span>
                        <input
                            autoFocus
                            autoComplete="name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            disabled={busy}
                        />
                    </label>
                )}
                <label className="login-field">
                    <span>{t('login.handle')}</span>
                    <input
                        autoFocus={!registering}
                        autoComplete="username"
                        value={handle}
                        onChange={(e) => { setHandle(e.target.value); setPasswordlessFor(''); }}
                        disabled={busy || codeSent}
                    />
                </label>
                {view === 'signin' && (
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
                {registering && (
                    <>
                        <label className="login-field">
                            <span>{t('login.password')}</span>
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={busy}
                            />
                        </label>
                        <label className="login-field">
                            <span>{t('login.register.confirm')}</span>
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                disabled={busy}
                            />
                        </label>
                        {regInfo?.requireInviteCode && (
                            <label className="login-field">
                                <span>{t('login.register.invite')}</span>
                                <input
                                    autoComplete="off"
                                    value={inviteCode}
                                    onChange={(e) => setInviteCode(e.target.value)}
                                    disabled={busy}
                                />
                            </label>
                        )}
                    </>
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
                <button
                    type="submit"
                    disabled={
                        busy || !handle.trim()
                        || (recovering && codeSent && !code.trim())
                        || (registering && (!name.trim() || !password || !confirm))
                    }
                >
                    {busy ? t('login.working')
                        : registering ? t('login.register.submit')
                            : recovering ? (codeSent ? t('login.recover.submit') : t('login.recover.send'))
                                : t('login.submit')}
                </button>
                {view === 'signin' && oauth.length > 0 && (
                    <div className="login-oauth">
                        <span>{t('login.oauth')}</span>
                        <div className="login-oauth-btns">
                            {oauth.map(p => (
                                <a key={p.id} className="login-oauth-btn" href={p.href}>{t(`login.oauth.${p.id}`)}</a>
                            ))}
                        </div>
                    </div>
                )}
                {view === 'signin' && regInfo?.enabled && (
                    <button type="button" className="login-alt" onClick={() => gotoView('register')} disabled={busy}>
                        {t('login.register.link')}
                    </button>
                )}
                <button type="button" className="login-alt" onClick={() => gotoView(view === 'signin' ? 'recover' : 'signin')} disabled={busy}>
                    {view === 'signin' ? t('login.forgot') : t('login.back')}
                </button>
            </form>
        </div>
    );
}
