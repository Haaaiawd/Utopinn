// ctxApi — 'uberge-panel' bridge method → server dispatch (TASK-022/025).
// The panel shim (packages/panel-shim) calls th.* methods; the host forwards
// them to POST /api/uberge/th/call, whose method table is the single source
// of truth for what the server actually implements. Methods outside the
// table come back {unsupported:true} — surfaced here as an explicit
// `unsupported_method` error, never a silent stub.
import { apiPost } from '../api/client';

export interface PanelCallArgs {
    type?: string;          // 'chat' | 'global' | 'message' (variables scope)
    message_id?: number;
    script_id?: string;
    [k: string]: unknown;
}

export interface PanelContext {
    charDir: string;
    chatName?: string;
}

interface ThCallResult {
    ok?: boolean;
    unsupported?: boolean;
    result?: unknown;
    error?: string;
    [k: string]: unknown;
}

/**
 * Host-side dispatch: every 'th.*' method is forwarded verbatim to the
 * server TH-compat layer. Non-th methods are rejected locally.
 */
export async function dispatchPanelCall(method: string, args: PanelCallArgs, ctx: PanelContext): Promise<unknown> {
    if (!method.startsWith('th.')) {
        throw new Error(`unsupported_method: ${method}`);
    }
    const serverMethod = method.slice(3);
    const res = await apiPost<ThCallResult>('/api/uberge/th/call', {
        method: serverMethod,
        args,
        target: { charDir: ctx.charDir, chatName: ctx.chatName },
    });
    if (res.unsupported) {
        throw new Error(`unsupported_method: ${serverMethod}`);
    }
    if (res.ok === false) {
        throw new Error(res.error ?? `th_call_failed: ${serverMethod}`);
    }
    return res.result;
}
