// CardApp / panel bridge protocol — postMessage contract between the host
// (RN WebView / web iframe) and sandboxed card code. Nonce + allowlist +
// request-id correlation per mount. See .loom/design/mobile-panels.md.

/** Methods a mounted CardApp may invoke through the bridge. */
export const PANEL_METHODS = [
    'ctx.sendMessage',
    'ctx.swipe',
    'ctx.regenerate',
    'ctx.getChatState',
    'ctx.updateChatState',
    'ctx.getCharacterState',
    'ctx.updateCharacterState',
    'ctx.getWorldBook',
    'ctx.updateWorldBookEntry',
    'ctx.getCharacter',
    'ctx.getChat',
    'ctx.on',
    'ctx.off',
    'ctx.setTimer',
    'ctx.dispose',
] as const;
export type PanelMethod = (typeof PANEL_METHODS)[number];

/** Card → host request. Nonce minted per mount; host drops mismatches. */
export interface PanelRequest {
    channel: 'uberge-panel';
    direction: 'request';
    nonce: string;
    requestId: string;
    method: PanelMethod;
    args?: Record<string, unknown>;
}

/** Host → card response correlated by requestId. */
export interface PanelResponse {
    channel: 'uberge-panel';
    direction: 'response';
    nonce: string;
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
}

/** Host → card unsolicited events (chat updated, swipe changed, state changed). */
export interface PanelPush {
    channel: 'uberge-panel';
    direction: 'push';
    nonce: string;
    event: 'chat.updated' | 'swipe.changed' | 'state.changed' | 'lifecycle.unmount';
    payload?: Record<string, unknown>;
}

export type PanelWireMessage = PanelRequest | PanelResponse | PanelPush;

/** Bootstrap payload the host injects before the app's init() runs. */
export interface PanelBootstrap {
    channel: 'uberge-panel';
    direction: 'bootstrap';
    nonce: string;
    /** Namespaces the app is permitted to read/write. */
    stateNamespaces: string[];
    /** Entry resource URLs (host-routed, CSP-allowed). */
    assets: Record<string, string>;
    theme?: 'dark' | 'light';
}

export function isPanelMethod(v: unknown): v is PanelMethod {
    return typeof v === 'string' && (PANEL_METHODS as readonly string[]).includes(v);
}

export function isPanelRequest(v: unknown): v is PanelRequest {
    const m = v as Partial<PanelRequest> | null;
    return !!m && m.channel === 'uberge-panel' && m.direction === 'request' &&
        typeof m.nonce === 'string' && typeof m.requestId === 'string' &&
        isPanelMethod(m.method);
}
