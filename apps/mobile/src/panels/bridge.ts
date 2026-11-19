// bridge — 'utopinn-panel' postMessage plumbing for the RN WebView host
// (TASK-009). One-to-one port of apps/web/src/cardapp/bridge.ts semantics:
// inbound validation (channel → direction → requestId → NONCE → request
// shape → method grant), response encoding, in-flight request ledger,
// unsolicited host→card push. Contract shapes live in
// packages/protocol/src/panels.ts — do not re-invent them here.
//
// Transport difference vs the web iframe host: web checks
// `ev.source === iframe.contentWindow` to authenticate the sender; RN's
// onMessage has no source concept — messages can only arrive from inside
// this WebView, so the mount-scoped bridge nonce is the whole gate
// (same posture the server designed for: a nonce-less or mismatched
// request is denied, never dispatched). Outbound goes through the
// `send` callback (PanelWebView injects window.__utopinnPanelReceive).
import {
    isPanelRequest,
    PANEL_METHODS_TH_T0,
    type AnyPanelMethod,
    type PanelPush,
    type PanelRequest,
    type PanelResponse,
} from '@utopinn/protocol';

/** manifest.permissions.api expanded into a concrete grant set + face flags. */
export interface ApiGrants {
    /** Bridge methods this mount may invoke (server table stays the truth). */
    allowed: ReadonlySet<string>;
    /** Card declared the 'ctx' face ('ctx' or 'ctx.<method>'). */
    ctxFace: boolean;
    /** Card declared the 'th' face ('th' or 'th.<method>'). */
    thFace: boolean;
}

/**
 * Expand `permissions.api` grants (identical rules to the web host):
 *   'th'      → the whole T0 table (PANEL_METHODS_TH_T0)
 *   'th.xxx'  → that single method
 *   'ctx'/'ctx.xxx' → ctx face requested (host can't serve it yet — caller
 *                     degrades when no 'th' grant exists alongside)
 * api empty/undeclared → the ecosystem default = full T0 table.
 */
export function expandApiGrants(api: string[] | undefined): ApiGrants {
    if (!api || api.length === 0) {
        return { allowed: new Set<string>(PANEL_METHODS_TH_T0), ctxFace: false, thFace: true };
    }
    const allowed = new Set<string>();
    let ctxFace = false;
    let thFace = false;
    for (const grant of api) {
        if (grant === 'th') {
            thFace = true;
            for (const m of PANEL_METHODS_TH_T0) allowed.add(m);
        } else if (grant === 'ctx' || grant.startsWith('ctx.')) {
            ctxFace = true;
        } else if (grant.startsWith('th.')) {
            thFace = true;
            allowed.add(grant);
        }
    }
    return { allowed, ctxFace, thFace };
}

function toWireError(e: unknown): { code: string; message: string } {
    const message = e instanceof Error ? e.message : String(e);
    // ctxApi surfaces `unsupported_method: xxx` for methods outside the
    // server table — keep the code stable for card-side debugging.
    const code = message.startsWith('unsupported_method') ? 'unsupported_method' : 'call_failed';
    return { code, message };
}

export interface PanelBridgeOpts {
    /** Mount-scoped bridge nonce — inbound requests must match it exactly. */
    nonce: string;
    allowed: ReadonlySet<string>;
    /** Encode + deliver a host→card wire message into the WebView. */
    send: (msg: PanelResponse | PanelPush) => void;
    /** Forward an authorized call (ctxApi → server TH layer). */
    dispatch: (method: AnyPanelMethod, args: Record<string, unknown>) => Promise<unknown>;
}

export class PanelBridge {
    /** requestIds currently being dispatched — the pending ledger. */
    private pending = new Set<string>();
    private dead = false;

    constructor(private readonly opts: PanelBridgeOpts) { }

    /**
     * WebView onMessage payload — accepts the raw string RN hands us or an
     * already-parsed object; non-JSON / foreign traffic is dropped silently
     * (a card may use ReactNativeWebView.postMessage for its own reasons).
     */
    readonly onMessage = (raw: unknown): void => {
        if (this.dead) return;
        let data: unknown = raw;
        if (typeof raw === 'string') {
            try {
                data = JSON.parse(raw);
            } catch {
                return;
            }
        }
        const d = data as Partial<PanelRequest> | null;
        if (!d || d.channel !== 'utopinn-panel' || d.direction !== 'request') return;
        if (typeof d.requestId !== 'string') return; // can't correlate — drop
        // Nonce gate first: absent ('' or undefined) never equals a real
        // bridge nonce, so legacy/forged traffic dies here as unauthorized.
        if (d.nonce !== this.opts.nonce) {
            return this.deny(d.requestId, 'bad_nonce', 'bridge nonce mismatch');
        }
        if (!isPanelRequest(d)) {
            return this.deny(d.requestId, 'bad_request', 'malformed panel request');
        }
        if (!this.opts.allowed.has(d.method)) {
            return this.deny(d.requestId, 'denied', `method not granted: ${d.method}`);
        }
        const requestId = d.requestId;
        this.pending.add(requestId);
        this.opts.dispatch(d.method, d.args ?? {})
            .then((result) => this.respond(requestId, { ok: true, result }))
            .catch((e) => this.respond(requestId, { ok: false, error: toWireError(e) }))
            .finally(() => this.pending.delete(requestId));
    };

    private respond(requestId: string, body: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): void {
        if (this.dead) return;
        const msg: PanelResponse = {
            channel: 'utopinn-panel', direction: 'response',
            nonce: this.opts.nonce, requestId, ...body,
        };
        this.opts.send(msg);
    }

    private deny(requestId: string, code: string, message: string): void {
        this.respond(requestId, { ok: false, error: { code, message } });
    }

    /**
     * Host → card unsolicited push. TODO(host.event): forward the host event
     * bus / WS subscription as PanelPush 'th.event' ({name,args}) once that
     * slice lands — server-side subscriptions are already tracked via
     * th.eventOn; this is the delivery joint, intentionally not wired yet
     * (same state as the web host).
     */
    push(event: PanelPush['event'], payload?: Record<string, unknown>): void {
        if (this.dead) return;
        const msg: PanelPush = {
            channel: 'utopinn-panel', direction: 'push',
            nonce: this.opts.nonce, event, payload,
        };
        this.opts.send(msg);
    }

    dispose(): void {
        this.dead = true;
        this.pending.clear();
    }
}
