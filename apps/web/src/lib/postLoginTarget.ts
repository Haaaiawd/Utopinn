// Post-login navigation target — the URL a guest landed on is the page they
// were aiming for, so the post-login full reload returns there instead of
// always booting '/'. '/login' itself maps to '/' (the gate is not a
// destination), and the OAuth ?error= bounce param is pre-login state —
// stripped so a stale failure does not replay on the authed boot.
// Pure + node-testable: LoginLanding passes window.location in, specs pass
// literals (apps/web/tests/login-landing.test.mjs).

// Only a same-origin path may come back — the string is handed to
// window.location.assign after sign-in, so anything the browser would read
// as a URL reference must fail closed to '/':
//   '//host'      — protocol-relative URL, navigates off-site
//   '\...'        — Chromium/Firefox normalize backslashes to '/', so
//                   '/\evil.com' is the same off-site hop
//   '%2F' / '%5C' — encoded separators; the rules are re-checked on the
//                   single-decoded form so '/%2F%2Fevil.com' can't smuggle
//                   a '//host' past the raw check
// A bare '%' that fails to decode also fails closed.
function isSameOriginPath(p: string): boolean {
    const ok = (s: string) => s.startsWith('/') && !s.startsWith('//') && !s.includes('\\');
    if (!ok(p)) return false;
    let decoded: string;
    try {
        decoded = decodeURIComponent(p);
    } catch {
        return false;
    }
    return ok(decoded);
}

export function postLoginTarget(loc: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
    const params = new URLSearchParams(loc.search);
    params.delete('error');
    const qs = params.toString();
    const target = `${loc.pathname}${qs ? `?${qs}` : ''}${loc.hash}`;
    if (!isSameOriginPath(target)) return '/';
    if (loc.pathname === '/login' || loc.pathname === '/login/') return '/';
    return target;
}

// OAuth sign-in is a cross-origin round trip: /oauth/start sends the tab to
// the provider and the callback's server-side redirect always lands on '/'.
// The deep link therefore has to ride something the server cannot strip —
// sessionStorage (same-tab, dies with it). LoginGate stashes the target when
// an OAuth button is clicked; AuthGate consumes it on the authed boot and
// re-targets the reload. An unanswered/bounced attempt leaves the stash for
// the retry; it is only ever written from a validated postLoginTarget value.
const OAUTH_RETURN_KEY = 'utopinn.oauthReturnTo';

export function stashOAuthReturnTo(target: string, store?: Pick<Storage, 'setItem'>): void {
    if (!isSameOriginPath(target)) return;
    try {
        (store ?? window.sessionStorage).setItem(OAUTH_RETURN_KEY, target);
    } catch { /* storage unavailable — degrade to the callback's '/' */ }
}

export function consumeOAuthReturnTo(store?: Pick<Storage, 'getItem' | 'removeItem'>): string | null {
    let raw: string | null = null;
    try {
        const s = store ?? window.sessionStorage;
        raw = s.getItem(OAUTH_RETURN_KEY);
        s.removeItem(OAUTH_RETURN_KEY);
    } catch {
        return null;
    }
    return raw && isSameOriginPath(raw) ? raw : null;
}
