// Post-login navigation target — the URL a guest landed on is the page they
// were aiming for, so the post-login full reload returns there instead of
// always booting '/'. '/login' itself maps to '/' (the gate is not a
// destination), and the OAuth ?error= bounce param is pre-login state —
// stripped so a stale failure does not replay on the authed boot.
// Pure + node-testable: LoginLanding passes window.location in, specs pass
// literals (apps/web/tests/login-landing.test.mjs).

export function postLoginTarget(loc: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
    if (loc.pathname === '/login' || loc.pathname === '/login/') return '/';
    const params = new URLSearchParams(loc.search);
    params.delete('error');
    const qs = params.toString();
    return `${loc.pathname}${qs ? `?${qs}` : ''}${loc.hash}`;
}
