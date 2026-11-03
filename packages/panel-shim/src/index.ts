import type { PanelBootstrap } from '@uberge/protocol';

/**
 * Path to the injectable runtime, relative to this package root.
 * The server serves it verbatim at `/api/panel-shim/t0.js`;
 * hosts inject it into the WebView before any card code runs.
 */
export const RUNTIME_RELATIVE_PATH = 'src/runtime.js';

/**
 * Inline snippet the host evaluates BEFORE loading runtime.js / card code.
 * Sets the per-mount nonce + bootstrap payload the runtime reads.
 */
export function renderBootstrapSnippet(bootstrap: PanelBootstrap): string {
    const nonceJson = JSON.stringify(bootstrap.nonce);
    const bootJson = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
    return `window.__UBERGE_PANEL_NONCE__=${nonceJson};\n` +
        `window.__UBERGE_PANEL_BOOTSTRAP__=${bootJson};\n`;
}

/**
 * Full injection source: bootstrap snippet + runtime file contents.
 * `runtimeSource` is provided by the caller (server read it from disk
 * or api-client fetched `/api/panel-shim/t0.js`) so this package stays fs-free.
 */
export function renderInitScript(bootstrap: PanelBootstrap, runtimeSource: string): string {
    return renderBootstrapSnippet(bootstrap) + runtimeSource;
}
