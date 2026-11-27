// Standalone split-screen login landing — this IS the whole page when there
// is no session; the app shell never mounts underneath (App.tsx AuthGate).
//
// Wide (>=900px): brand aside + form panel ~55:45. The brand column is real
// content — LogoU (same geometry as favicon/PWA marks), wordmark and one
// product line — over the public bundle wallpaper with a token-gradient
// fallback painted underneath, so a missing image degrades to color, never
// to a broken frame. Narrow (<900px): the brand column collapses to a top
// banner and the form panel takes the rest; the form stays reachable under
// an open keyboard because the gate scrolls inside the panel.
//
// Not the ambience layer: AmbientBackdrop reads shell ctx (stBg/chatBgLock)
// which a guest cannot have — stBg is null pre-login by definition — so the
// landing paints its own background from tokens + this public asset instead
// of growing a third ambience tier (see PR #62's two-layer model).

import { useI18n } from '../../i18n';
import { postLoginTarget } from '../../lib/postLoginTarget';
import { LogoU } from '../LogoU';
import { LoginGate } from './LoginGate';

export function LoginLanding() {
    const { t } = useI18n();
    return (
        <div className="login-landing">
            <aside className="login-brand">
                <div className="login-brand-art" aria-hidden="true" />
                <div className="login-brand-scrim" aria-hidden="true" />
                <div className="login-brand-body">
                    <div className="login-brand-mark">
                        <LogoU size={36} />
                        <span>Utopinn</span>
                    </div>
                    <p className="login-brand-tag">{t('login.landing.tagline')}</p>
                    <p className="login-brand-sub">{t('login.landing.sub')}</p>
                </div>
            </aside>
            <main className="login-panel">
                <LoginGate postLoginUrl={postLoginTarget(window.location)} />
            </main>
        </div>
    );
}
