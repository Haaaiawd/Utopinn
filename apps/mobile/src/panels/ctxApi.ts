// ctxApi — 'utopinn-panel' bridge method → server dispatch (TASK-009).
// Same thin delegation as apps/web/src/cardapp/ctxApi.ts: the panel shim
// calls th.* methods; the host forwards them verbatim to
// POST /api/utopinn/th/call, whose method table is the single source of
// truth for what the server actually implements. Methods outside the
// table come back {unsupported:true} — surfaced here as an explicit
// `unsupported_method` error, never a silent stub.
import { ApiError } from '@utopinn/api-client';
import { client } from '../api/client';

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
 * server TH-compat layer. Non-th methods are rejected locally. Non-2xx
 * responses carry {ok:false,error} — the server message is surfaced so
 * card-side debugging sees e.g. "scope 'chat' requires target.chatName".
 */
export async function dispatchPanelCall(method: string, args: PanelCallArgs, ctx: PanelContext): Promise<unknown> {
    if (!method.startsWith('th.')) {
        throw new Error(`unsupported_method: ${method}`);
    }
    const serverMethod = method.slice(3);
    let res: ThCallResult;
    try {
        res = await client().request<ThCallResult>('/api/utopinn/th/call', {
            method: 'POST',
            body: {
                method: serverMethod,
                args,
                target: { charDir: ctx.charDir, chatName: ctx.chatName },
            },
        });
    } catch (e) {
        if (e instanceof ApiError && e.body && typeof e.body === 'object') {
            const b = e.body as ThCallResult;
            throw new Error(b.error ?? `th_call_failed: ${serverMethod} (HTTP ${e.status})`);
        }
        throw e;
    }
    if (res.unsupported) {
        throw new Error(`unsupported_method: ${serverMethod}`);
    }
    if (res.ok === false) {
        throw new Error(res.error ?? `th_call_failed: ${serverMethod}`);
    }
    return res.result;
}
