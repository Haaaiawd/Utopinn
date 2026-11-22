import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev proxy target: apps/server (Luker-derived backend, `pnpm server`).
// TASK-001 evidence: listens on 127.0.0.1:8000. The SPA is a thin client —
// every semantic call goes to REST here; /csrf-token is proxied so the
// session cookie + CSRF handshake work same-origin in dev.
const SERVER_ORIGIN = 'http://127.0.0.1:8000';

/**
 * http-proxy 'error' fires when the upstream is unreachable (ECONNREFUSED).
 * Rewrite it to 502 + a marker header so the client can tell "server absent"
 * (→ labelled mock fallback) apart from a real 5xx (→ surfaced error).
 */
interface ProxyErrorSink {
    headersSent?: boolean;
    writeHead?: (status: number, headers?: Record<string, string>) => void;
    end?: (body?: string) => void;
}
const upstreamError = (_err: unknown, _req: unknown, res: unknown) => {
    const r = res as ProxyErrorSink;
    if (!r.headersSent && r.writeHead) {
        r.writeHead(502, { 'content-type': 'application/json', 'x-utopinn-proxy-error': '1' });
    }
    r.end?.(JSON.stringify({ error: 'upstream_unavailable' }));
};

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        // shadcn-style '@' alias (components.json → aliases).
        alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
        port: 5173,
        // WSL over /mnt/d: inotify never fires for Windows-side writes.
        watch: { usePolling: true, interval: 400 },
        proxy: {
            '/api': { target: SERVER_ORIGIN, changeOrigin: true, ws: true, configure: (proxy) => proxy.on('error', upstreamError) },
            '/csrf-token': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // '/login' —— server-side legacy 登录页(users.js 恒挂,
            // 不依赖 LUKER_SERVE_LEGACY)。dev 下不代理的话,auth-expired
            // 条的「重新登录」会被 SPA fallback 静默吞回 '/';enableUserAccounts
            // 部署下这条路必须真的到服务端。
            '/login': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // CardApp iframe surface (/card-runtime/m/<id>/… + shim) — the
            // mount-id capability carries it, no session needed upstream.
            '/card-runtime': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // --- User-directory static roots (TASK-047). Upstream mounts them
            // on the app root via app.use('/', userDataRouter) at
            // apps/server/src/server-startup.js:85; the handlers live at
            // apps/server/src/users.js:1604-1609. Without these the dev server
            // 404s card PNGs/persona avatars and every image fell back to the
            // ghost placeholder.
            // /characters/<file> → <userRoot>/characters — src/users.js:1605
            '/characters': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // /User%20Avatars/<file> → <userRoot>/User Avatars — src/users.js:1606
            // (proxy context matches the raw, still percent-encoded req.url).
            '/User%20Avatars': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // /backgrounds/<file> → <userRoot>/backgrounds — src/users.js:1604
            '/backgrounds': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // /user/images/* + /user/files/* — src/users.js:1608-1609. Kept as
            // two exact prefixes (not '/user') so nothing else under /user* is
            // captured by the proxy.
            '/user/images': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            '/user/files': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // /thumbnail?type=avatar|bg|persona&file=… → thumbnailRouter, mounted
            // at apps/server/src/server-startup.js:101. The upstream mount is
            // singular '/thumbnail' — there is no '/thumbnails' route.
            '/thumbnail': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            // NOT proxied: '/assets'. Upstream '/assets/*' (src/users.js:1607)
            // is the server-side user-assets root, but apps/web/public/assets is
            // real local bundle content referenced throughout the SPA as
            // /assets/avatars/* and /assets/backgrounds/* — proxying the prefix
            // would shadow all of it. Nothing in the frontend references
            // server-side user asset files directly, so /assets stays local.
        },
    },
});
