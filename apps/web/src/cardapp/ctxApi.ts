// ctxApi — 'uberge-panel' bridge method → REST 映射(TASK-022).
// The panel shim (packages/panel-shim) calls th.* methods; this file is the
// host-side dispatch table. Methods not yet backed by a server path return
// the explicit `unsupported_method` error — never a silent stub.
import { getChat } from '../api/chats';
import { apiFetch } from '../api/client';

export interface PanelCallArgs {
    type?: string;          // 'chat' | 'global' | 'character' (variables scope)
    message_id?: number;
    script_id?: string;
    [k: string]: unknown;
}

export interface PanelContext {
    charDir: string;
    chatName?: string;
}

async function apiGet<T>(path: string): Promise<T> {
    const res = await apiFetch(path);
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`);
    return (await res.json()) as T;
}

/** Unsupported-method error — panels can feature-detect via the message. */
const unsupported = (m: string) => Promise.reject(new Error(`unsupported_method: ${m}`));

/**
 * Dispatch table. First slice covers the read face panels actually need to
 * render (character info / chat messages / last ids / chat-scoped variables);
 * write ops and event verbs return unsupported_method until the settle path
 * (TASK-013 sidecar) is bridged in.
 */
export async function dispatchPanelCall(method: string, args: PanelCallArgs, ctx: PanelContext): Promise<unknown> {
    switch (method) {
        case 'th.getCharacter': {
            return apiGet(`/api/uberge/characters/${encodeURIComponent(ctx.charDir)}`);
        }
        case 'th.getCurrentCharacterName':
            return ctx.charDir;
        case 'th.getChatMessages': {
            if (!ctx.chatName) return unsupported(`${method} (no chat bound)`);
            const { messages } = await getChat(ctx.charDir, ctx.chatName);
            return messages.map((m) => ({ message_id: m.id, name: m.name, mes: m.content, is_user: m.role === 'user' }));
        }
        case 'th.getLastMessageId':
        case 'th.getCurrentMessageId': {
            if (!ctx.chatName) return -1;
            const { messages } = await getChat(ctx.charDir, ctx.chatName);
            return messages.length - 1;
        }
        case 'th.getVariables': {
            if (args.type === 'global') return unsupported(`${method} global scope — settings repo seam pending`);
            if (!ctx.chatName) return unsupported(`${method} (no chat bound)`);
            const { header } = await getChat(ctx.charDir, ctx.chatName);
            const meta = (header.chat_metadata ?? header) as Record<string, unknown>;
            return (meta.variables as Record<string, unknown>) ?? {};
        }
        default:
            return unsupported(method);
    }
}
