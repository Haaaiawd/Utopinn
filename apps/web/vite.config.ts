import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
        r.writeHead(502, { 'content-type': 'application/json', 'x-uberge-proxy-error': '1' });
    }
    r.end?.(JSON.stringify({ error: 'upstream_unavailable' }));
};

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
            '/csrf-token': { target: SERVER_ORIGIN, changeOrigin: true, configure: (proxy) => proxy.on('error', upstreamError) },
        },
    },
});
