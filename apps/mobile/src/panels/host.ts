// usePanelHost — PanelWebView / MessageFrame 共享的 mount→bridge→pump 接线
// (TASK-009 面板页 + P0-4 事件泵 + P1 楼层前端帧共用一个生命周期)。
//
//   bridge:'utopinn-panel' 信道(nonce 闸 + allowlist + 请求/响应/推送)
//   pump  :PanelEventPump —— eventOn 记账 + chat diff + 信箱拉新 → bridge.push
//   send  :injectJavaScript 直递 window.__utopinnPanelReceive(t0 shim 入口)
//
// dispatch 统一形态:surface 面在宿主层应答(面板页=卡的可视表面;
// 楼层帧=内联可视表面),th.getCurrentMessageId 按挂载语义覆盖,
// 其余方法经 pump.trackOutbound(订阅簿记+eventEmit origin)后 th/call 透传。
// surfaceOpen 无接线时如实 no_shell_surface 降级 —— 不假装成了。
import { useEffect, useRef } from 'react';
import { client, getChat } from '../api/client';
import { PanelBridge } from './bridge';
import { PanelEventPump } from './eventPump';
import { dispatchPanelCall } from './ctxApi';
import type { AnyPanelMethod, PanelPush, PanelResponse } from '@utopinn/protocol';
import type { MountBundle } from './mounts';

/** WebView 句柄的最小结构 —— 我们只调 injectJavaScript。 */
export interface WebViewHandle {
    injectJavaScript: (js: string) => void;
}

/**
 * host→card wire delivery:inject `window.__utopinnPanelReceive(msg)` — the
 * entrypoint the t0 shim installs for exactly this host (it also listens
 * for 'message' events, but direct delivery skips the event hop).
 * U+2028/U+2029 are legal JSON yet illegal inside JS string literals —
 * escape them or card data containing them would break the injection.
 */
export function receiveJs(msg: unknown): string {
    const wire = JSON.stringify(msg).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `(function(){var f=window.__utopinnPanelReceive;if(typeof f==='function'){f(${wire});}})();true;`;
}

/** 事件泵轮询间隔 —— 与 web 宿主同节拍(POLL_MS=8s)。 */
export const PANEL_POLL_MS = 8_000;

export interface PanelHostOpts {
    /** 已 mint 的 mount bundle(null → 不接线;变体重挂)。 */
    mount: MountBundle | null;
    /** 桥方法闸(PanelWebView=manifest 展开;MessageFrame=全 TH 面)。 */
    allowed: ReadonlySet<string>;
    charDir: string;
    chatName?: string;
    /**
     * 卡「表面可见性」语义(ctx.surfaceOpen/surfaceClose):
     *   open  → 本挂载形态已是可视表面时回 {ok:true,delivered};无面可承
     *           传 undefined → 如实 no_shell_surface 降级。
     *   close → 壳回调(屏幕侧 navigation.goBack 等);未接 → no_shell_nav。
     */
    surface?: {
        /** open 应答里的 delivered 语义标签(诊断面)。 */
        deliveredAs: string;
        onClose?: () => void;
    };
    /** th.getCurrentMessageId 覆盖 —— 楼层帧给所在楼层下标(TH 挂载语义)。 */
    currentMessageId?: number;
    /** 信箱事件宿主旁路(MessageFrame:refresh_message → 重铸本帧)。 */
    onThEvent?: (name: string, args: unknown[]) => void;
}

export function usePanelHost(opts: PanelHostOpts): {
    webRef: React.RefObject<WebViewHandle | null>;
    onMessage: (data: unknown) => void;
} {
    const webRef = useRef<WebViewHandle | null>(null);
    const bridgeRef = useRef<PanelBridge | null>(null);
    const { mount, allowed, charDir, chatName, surface, currentMessageId, onThEvent } = opts;

    // ── bridge + pump 生命周期:随 mount 一并生灭 ──
    useEffect(() => {
        if (!mount) return;
        // pump 先于 bridge 建 —— dispatch 闭包要在转发前过 trackOutbound。
        const pump = new PanelEventPump({
            charDir,
            chatName,
            push: (event, payload) => bridge.push(event, payload),
            thCall: (method, args) =>
                client().th.call(method, { target: { charDir, chatName }, args }),
            fetchChat: () => getChat(charDir, chatName!),
            onThEvent,
        });
        const bridge = new PanelBridge({
            // No nonce in the bundle → '' — which no card can match, so every
            // request is denied rather than silently authorized.
            nonce: mount.bridgeNonce ?? '',
            allowed,
            send: (msg: PanelResponse | PanelPush) => webRef.current?.injectJavaScript(receiveJs(msg)),
            dispatch: async (method: AnyPanelMethod, args: Record<string, unknown>) => {
                // 卡「表面可见性」(ctx.openOverlay/closeOverlay → wire
                // ctx.surfaceOpen/surfaceClose):按挂载形态如实应答。
                if (method === 'ctx.surfaceOpen') {
                    return surface
                        ? { ok: true, delivered: surface.deliveredAs }
                        : { ok: false, reason: 'no_shell_surface' };
                }
                if (method === 'ctx.surfaceClose') {
                    if (surface?.onClose) {
                        surface.onClose();
                        return { ok: true };
                    }
                    return { ok: false, reason: 'no_shell_nav' };
                }
                // 楼层帧语义:getCurrentMessageId = 所在楼层(web panelT0 本地
                // 应答 mountMessageId;服务端实现拿 lastMessageId,不同义)。
                if (method === 'th.getCurrentMessageId' && typeof currentMessageId === 'number') {
                    return currentMessageId;
                }
                return dispatchPanelCall(method, pump.trackOutbound(method, args), { charDir, chatName });
            },
        });
        bridgeRef.current = bridge;
        // 种子快照先于卡 init 竞速(卡的 eventOn 后到也只会漏历史 diff,
        // 事件面不回放 —— 与 web host.seed() 同语义)。
        void pump.seed();
        const poll = setInterval(() => { void pump.tick(); }, PANEL_POLL_MS);
        return () => {
            clearInterval(poll);
            bridgeRef.current = null;
            bridge.dispose();
            pump.dispose();
        };
    }, [mount, allowed, charDir, chatName, surface, currentMessageId, onThEvent]);

    const onMessage = (data: unknown) => bridgeRef.current?.onMessage(data);
    return { webRef, onMessage };
}
