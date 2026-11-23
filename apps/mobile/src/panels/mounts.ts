// mounts — card-runtime mount lifecycle API (TASK-009).
//   POST   /api/card-runtime/mounts          {charId,chatName?,kind?,html?}
//                                          → mount bundle
//   DELETE /api/card-runtime/mounts/:mountId → owner-scoped revoke
// The minted mountId is the capability that authorizes the session-free
// public surface (/card-runtime/m/<id>/…) the WebView loads; the admin
// endpoints themselves ride the normal session+CSRF api-client.
//
//   charId   卡身份(avatar basename)
//   chatName 会话身份 —— 喂 PanelBootstrap.chatName + TH 桥 target.chatName
//            (chat 变量域/信箱域);缺席时 mount 仍能建(全局域)。
//   kind:'message' + html → TH「前端界面」楼层 doc-mount(createDocMount):
//            服务端把块 HTML 包成完整文档壳(TH boilerplate 等价物)。
import { ApiError } from '@utopinn/api-client';
import { client } from '../api/client';

/** Mount bundle from POST /api/card-runtime/mounts (mounts.js publicMount). */
export interface MountBundle {
    mountId?: string;
    charId?: string;
    entryUrl: string;
    assetBaseUrl?: string;
    cdnUrl?: string;
    shimUrl?: string;
    bridgeNonce?: string;
    manifest?: {
        enabled?: boolean;
        entry?: string;
        entryKind?: 'document' | 'module';
        permissions?: {
            api?: string[];
            sameOrigin?: boolean;
            stateNamespaces?: string[];
        };
    };
    warnings?: string[];
}

/** Mint a mount for a card's card_app. */
export async function mountCardApp(charId: string, chatName?: string): Promise<MountBundle> {
    return client().request<MountBundle>('/api/card-runtime/mounts', {
        method: 'POST',
        body: { charId, chatName },
    });
}

/**
 * Mint a TH「前端界面」楼层 doc-mount —— 块 HTML 交给服务端 doc 壳
 * (buildMessageDoc),WebView 加载 entryUrl?shim=t0 即得全 TH 面。
 * 不 revoke:楼层帧随滚动高频生灭,生命周期交给服务端 TTL(与 web
 * MessageIframe 同策略)。
 */
export async function mountMessageFrame(opts: {
    charId: string;
    chatName?: string;
    html: string;
}): Promise<MountBundle> {
    return client().request<MountBundle>('/api/card-runtime/mounts', {
        method: 'POST',
        body: { kind: 'message', charId: opts.charId, chatName: opts.chatName, html: opts.html },
    });
}

/** Revoke a mount (best-effort — callers catch; expiry is server-side too). */
export async function revokeMount(mountId: string): Promise<void> {
    await client().request(`/api/card-runtime/mounts/${encodeURIComponent(mountId)}`, {
        method: 'DELETE',
    });
}

/** Stable server error code ('no_card_app', 'card_app_disabled', …) or null. */
export function mountErrorCode(e: unknown): string | null {
    if (e instanceof ApiError && e.body && typeof e.body === 'object') {
        const code = (e.body as { error?: unknown }).error;
        return typeof code === 'string' ? code : null;
    }
    return null;
}
