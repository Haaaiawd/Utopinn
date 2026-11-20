// bridge — 'utopinn-panel' postMessage plumbing for the web host (TASK-022).
// CardAppFrame owns React/mount state; this module owns the wire:
// inbound validation (frame source → nonce → request shape → method grant),
// response encoding, and the in-flight request ledger. Contract shapes live
// in packages/protocol/src/panels.ts — do not re-invent them here.
import {
    isPanelRequest,
    PANEL_METHODS,
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
 * Expand `permissions.api` grants:
 *   'th'      → the whole T0 table (PANEL_METHODS_TH_T0)
 *   'th.xxx'  → that single method
 *   'ctx'     → the whole ctx face (PANEL_METHODS) — ctx shim serves it
 *   'ctx.xxx' → that single ctx method (shim still gets its local members)
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
        } else if (grant === 'ctx') {
            ctxFace = true;
            for (const m of PANEL_METHODS) allowed.add(m);
        } else if (grant.startsWith('ctx.')) {
            ctxFace = true;
            allowed.add(grant);
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
    /** Lazy so the same listener survives iframe ref mounts/unmounts. */
    getWindow: () => Window | null;
    /** Forward an authorized call (ctxApi → server TH layer). */
    dispatch: (method: AnyPanelMethod, args: Record<string, unknown>) => Promise<unknown>;
}

export class PanelBridge {
    /** requestIds currently being dispatched — the pending ledger. */
    private pending = new Set<string>();
    private dead = false;

    constructor(private readonly opts: PanelBridgeOpts) { }

    /** window 'message' handler — register/remove as one unit. */
    readonly onMessage = (ev: MessageEvent): void => {
        if (this.dead || ev.source !== this.opts.getWindow()) return;
        const data = ev.data as Partial<PanelRequest> | null;
        if (!data || data.channel !== 'utopinn-panel' || data.direction !== 'request') return;
        if (typeof data.requestId !== 'string') return; // can't correlate — drop
        // Nonce gate first: absent ('' or undefined) never equals a real
        // bridge nonce, so legacy/forged traffic dies here as unauthorized.
        if (data.nonce !== this.opts.nonce) {
            return this.deny(data.requestId, 'bad_nonce', 'bridge nonce mismatch');
        }
        if (!isPanelRequest(data)) {
            return this.deny(data.requestId, 'bad_request', 'malformed panel request');
        }
        if (!this.opts.allowed.has(data.method)) {
            return this.deny(data.requestId, 'denied', `method not granted: ${data.method}`);
        }
        const requestId = data.requestId;
        this.pending.add(requestId);
        this.opts.dispatch(data.method, data.args ?? {})
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
        // Opaque-origin iframe: target must be '*'; inbound source+nonce
        // checks are what authenticate the other side.
        this.opts.getWindow()?.postMessage(msg, '*');
    }

    private deny(requestId: string, code: string, message: string): void {
        this.respond(requestId, { ok: false, error: { code, message } });
    }

    /**
     * Host → card unsolicited push. TODO(host.event): forward the host event
     * bus / WS subscription as PanelPush 'th.event' ({name,args}) once that
     * slice lands — server-side subscriptions are already tracked via
     * th.eventOn; this is the delivery joint, intentionally not wired yet.
     */
    push(event: PanelPush['event'], payload?: Record<string, unknown>): void {
        if (this.dead) return;
        const msg: PanelPush = {
            channel: 'utopinn-panel', direction: 'push',
            nonce: this.opts.nonce, event, payload,
        };
        this.opts.getWindow()?.postMessage(msg, '*');
    }

    dispose(): void {
        this.dead = true;
        this.pending.clear();
    }
}
