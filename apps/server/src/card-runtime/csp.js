/**
 * Per-card CSP + security headers for the card-runtime surface.
 *
 * Isolation model (research: capabilities/sandboxed-card-apps, C3):
 *   - The card document gets NO egress of its own. `default-src 'none'` plus a
 *     small set of path-scoped sources under {selfOrigin}/card-runtime/ — card
 *     assets and the mount-scoped CDN proxy are the only reachable resources.
 *     Card JS can never address /api/* (session authority) because:
 *       a) CSP path scoping blocks the fetch outright;
 *       b) `sandbox allow-scripts` gives the document an opaque origin, so
 *          even a client that ignored CSP path-matching would send no cookies
 *          and hit CORS on every session-gated endpoint;
 *       c) no card-runtime route itself performs session-scoped actions —
 *          mounts are authorized by unguessable capability ids, not cookies.
 *   - Remote dependencies are never direct sources: they come through
 *     /card-runtime/m/<id>/cdn, so they are already inside the allowed path.
 *   - `frame-ancestors {selfOrigin}` lets the host SPA iframe the document
 *     (same-origin) and nobody else; RN WebView ignores it harmlessly.
 *
 * Manifest permissions that intentionally loosen the sandbox:
 *   - inlineScript (default true): keeps 'unsafe-inline' in script-src —
 *     real card HTML carries inline scripts; this is the compat default.
 *   - media: enables media-src (audio/video) for card assets + proxy.
 *   - sameOrigin: adds 'allow-same-origin' to the sandbox tokens — weakens
 *     isolation, flagged by the manifest validator, default off.
 */

const RUNTIME_BASE = '/card-runtime/';

/**
 * Build the Content-Security-Policy value for a mounted card document.
 * @param {object} opts
 * @param {string} opts.selfOrigin e.g. 'http://127.0.0.1:8000' — the origin the
 *   client addressed, so CSP sources match however the server is reached.
 * @param {object} [opts.permissions] Normalized manifest.permissions
 * @returns {string} CSP header value
 */
export function buildCardRuntimeCsp({ selfOrigin, permissions = {} }) {
    const runtime = `${selfOrigin}${RUNTIME_BASE}`;
    // 设计稿边界(cardapp-web-host.md):不给 modals/downloads——卡 UI 走
    // 桥协议弹层,不该弹原生 alert/下载。sameOrigin 是显式声明位才放。
    const sandbox = ['allow-scripts'];
    if (permissions.sameOrigin === true) sandbox.push('allow-same-origin');

    const scriptSrc = [runtime, `'wasm-unsafe-eval'`];
    if (permissions.inlineScript !== false) scriptSrc.push(`'unsafe-inline'`);

    const directives = [
        `default-src 'none'`,
        `sandbox ${sandbox.join(' ')}`,
        `script-src ${scriptSrc.join(' ')}`,
        `style-src ${runtime} 'unsafe-inline'`,
        // 兼容面:Luker 生态卡按旧 /api/card-app/<char>/ 取图(同源只读),
        // 路径收窄放行;数据仍走桥,connect-src 不扩。
        `img-src ${runtime} ${selfOrigin}/api/card-app/ data: blob:`,
        `font-src ${runtime} data:`,
        // Card JS talks to the host over postMessage, not fetch — connect-src
        // only needs the runtime path (assets + CDN proxy).
        `connect-src ${runtime} data: blob:`,
        `worker-src ${runtime} blob:`,
        `frame-src 'none'`,
        `object-src 'none'`,
        `base-uri 'none'`,
        `form-action 'none'`,
        `frame-ancestors ${selfOrigin}`,
    ];
    if (permissions.media === true) {
        directives.splice(7, 0, `media-src ${runtime} data: blob:`);
    }
    return directives.join('; ');
}

/**
 * Headers every card-runtime response carries (documents and subresources).
 *
 * - `Access-Control-Allow-Origin: *` is required, not optional: under the CSP
 *   sandbox the document is an opaque origin, so module scripts / fetch() to
 *   our own asset routes are CORS requests with `Origin: null`. Everything on
 *   this surface is public-by-capability anyway — nothing session-scoped can
 *   be read through it.
 * - `Cross-Origin-Resource-Policy: cross-origin` overrides helmet's global
 *   `same-origin` for the same reason (opaque-origin documents are
 *   cross-origin to their subresources).
 * - `Referrer-Policy: no-referrer` keeps mount ids out of upstream logs on
 *   the rare redirect the WebView itself follows.
 * @param {object} opts same shape as buildCardRuntimeCsp
 * @returns {Record<string,string>}
 */
export function cardRuntimeSecurityHeaders(opts) {
    return {
        'Content-Security-Policy': buildCardRuntimeCsp(opts),
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), usb=(), payment=()",
    };
}
