// OAuth provider discovery → sign-in links. Pure module: no imports, so
// node --test exercises it via type-stripping (see tests/login-oauth.test.mjs).
// Server contract (apps/server/src/endpoints/users-public.js):
//   POST /api/users/oauth/providers → {providers:{github,discord}} — anonymous;
//   GET  /api/users/oauth/start/<id> begins the flow (plain navigation, no fetch).
export interface OAuthProviderMap {
    github?: boolean;
    discord?: boolean;
}

export interface OAuthProviderLink {
    id: 'github' | 'discord';
    href: string;
}

const ORDER: ReadonlyArray<OAuthProviderLink['id']> = ['github', 'discord'];

/** Enabled providers → start-URLs, stable order; anything falsy → no buttons. */
export function oauthProviderLinks(payload: { providers?: OAuthProviderMap } | null | undefined): OAuthProviderLink[] {
    const providers = payload?.providers ?? {};
    return ORDER
        .filter(id => providers[id])
        .map(id => ({ id, href: `/api/users/oauth/start/${id}` }));
}
