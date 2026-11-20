// ctxApi — 'utopinn-panel' bridge method → dispatch (TASK-022/025 + TASK-046).
// Composite host dispatch mirrors apps/cli/cardapp-host.mjs:
//   ctx.* → CardAppHost.ctxDispatch (web host implementation, ctxHost.ts)
//   th.*  → T0 table → createPanelT0Handler (api-client, client-side)
//           else     → POST /api/utopinn/th/call 透传 (server T1+)
// The legacy host-less path forwards th.* verbatim — kept for callers that
// predate the composite host; CardAppFrame always passes a CardAppHost.
import { apiPost } from '../api/client';
import type { CardAppHost } from './ctxHost';

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
 * Host-side dispatch entry. With a CardAppHost → composite table
 * (ctx.* + th.* T0-local + th/call fallback). Without → legacy th-only
 * passthrough to the server TH layer; everything else rejected locally.
 */
export async function dispatchPanelCall(
    method: string,
    args: PanelCallArgs,
    ctx: PanelContext,
    host?: CardAppHost,
): Promise<unknown> {
    if (host) {
        return await host.dispatch(method, args as Record<string, unknown>);
    }
    if (!method.startsWith('th.')) {
        throw new Error(`unsupported_method: ${method}`);
    }
    const serverMethod = method.slice(3);
    const res = await apiPost<ThCallResult>('/api/utopinn/th/call', {
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
