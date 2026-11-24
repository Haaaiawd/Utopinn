// usePanelHost — PanelWebView / MessageFrame 共享的 mount→bridge→pump 接线
// (TASK-009 面板页 + P0-4 事件泵 + P1 楼层前端帧共用一个生命周期)。
//
//   bridge:'utopinn-panel' 信道(nonce 闸 + allowlist + 请求/响应/推送)
//   host  :CardAppHost(@utopinn/api-client,web 同一实现)—— ctx.* dispatch
//          表 + th.* T0 本地/th/call 透传 + 楼层 diff 泵 + 信箱拉新 →
//          bridge.push;事件订阅记账(ctx.on/th.eventOn)也在其内。
//   send  :injectJavaScript 直递 window.__utopinnPanelReceive(t0/ctx shim 入口)
//
// dispatch 统一形态:surface 面在宿主层应答(面板页=卡的可视表面;
// 楼层帧=内联可视表面),th.getCurrentMessageId 按挂载语义覆盖,
// 其余方法全交 CardAppHost.dispatch。surface 动词无接线时如实
// PANEL_SURFACE_UNAVAILABLE 降级 —— 不假装成了。
//
// onChatChanged:host 在 diff dirty 与信箱 mutation 事件两条路上回调 ——
// 面板写面(TH set/delete/create/rotate)改完楼层,reader 的消息坐标必须
// 立刻重对,否则编辑/选稿按旧下标写错楼(原 eventPump 职责,共享化并进)。
import { useEffect, useRef } from 'react';
import { client } from '../api/client';
import { notifyChatChanged } from '../state/chatSync';
import { useSession } from '../state/session';
import { CardAppHost, PanelBridge } from '@utopinn/api-client';
import { PANEL_SURFACE_UNAVAILABLE } from '@utopinn/protocol';
import type { AnyPanelMethod, PanelPush, PanelResponse } from '@utopinn/protocol';
import type { MountBundle } from './mounts';

/** WebView 句柄的最小结构 —— 我们只调 injectJavaScript。 */
export interface WebViewHandle {
    injectJavaScript: (js: string) => void;
}

/**
 * host→card wire delivery:inject `window.__utopinnPanelReceive(msg)` — the
 * entrypoint both shims install for exactly this host (they also listen
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
     * 卡「表面可见性」语义(ctx.openOverlay/closeOverlay → wire
     * ctx.surfaceOpen/surfaceClose):
     *   open  → 本挂载形态已是可视表面时回 {ok:true,delivered};无面可承
     *           传 undefined → 如实 PANEL_SURFACE_UNAVAILABLE 降级。
     *   close → 壳回调(屏幕侧 navigation.goBack 等);未接 → 同码降级。
     */
    surface?: {
        /** open 应答里的 delivered 语义标签(诊断面)。 */
        deliveredAs: string;
        onClose?: () => void;
    };
    /** th.getCurrentMessageId 覆盖 + panel-t0 mountMessageId —— 楼层帧给
     *  所在楼层下标(TH 挂载语义;message 域变量同读此坐标)。 */
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
    const conn = useSession();
    const { mount, allowed, charDir, chatName, surface, currentMessageId, onThEvent } = opts;

    // ── bridge + host 生命周期:随 mount 一并生灭 ──
    useEffect(() => {
        if (!mount) return;
        const bridge = new PanelBridge({
            // No nonce in the bundle → '' — which no card can match, so every
            // request is denied rather than silently authorized.
            nonce: mount.bridgeNonce ?? '',
            allowed,
            // RNW onMessage 给的是 JSON string;非 JSON/外来流量容错丢弃
            // (卡可能为自有目的用 ReactNativeWebView.postMessage)。
            normalize: (raw) => {
                if (typeof raw !== 'string') return raw;
                try { return JSON.parse(raw); } catch { return undefined; }
            },
            send: (msg: PanelResponse | PanelPush) => webRef.current?.injectJavaScript(receiveJs(msg)),
            dispatch: async (method: AnyPanelMethod, args: Record<string, unknown>) => {
                // 卡「表面可见性」(ctx.openOverlay/closeOverlay → wire
                // ctx.surfaceOpen/surfaceClose):按挂载形态如实应答 ——
                // 面板页本身即是 surface(delivered 语义),不进 host.surface
                // 那套 openPanel/collapsePanels web 壳接线。
                if (method === 'ctx.surfaceOpen') {
                    return surface
                        ? { ok: true, delivered: surface.deliveredAs }
                        : { ok: false, reason: PANEL_SURFACE_UNAVAILABLE, surface: 'open' };
                }
                if (method === 'ctx.surfaceClose') {
                    if (surface?.onClose) {
                        surface.onClose();
                        return { ok: true };
                    }
                    return { ok: false, reason: PANEL_SURFACE_UNAVAILABLE, surface: 'close' };
                }
                // 楼层帧语义:getCurrentMessageId = 所在楼层(web panelT0 本地
                // 应答 mountMessageId;服务端实现拿 lastMessageId,不同义)。
                // mountMessageId 已喂进 host —— 此处拦截保留的是「下标来源
                // 是挂载语义、不是服务端 lastMessageId」的显式契约。
                if (method === 'th.getCurrentMessageId' && typeof currentMessageId === 'number') {
                    return currentMessageId;
                }
                return host.dispatch(method, args);
            },
        });
        const host = new CardAppHost({
            charDir,
            chatName,
            push: (event, payload) => bridge.push(event, payload),
            onThEvent,
            // 帧/面板的 TH 写改了 chat doc → 广播给该会话的读者重对坐标。
            onChatChanged: () => notifyChatChanged(charDir, chatName),
            mountMessageId: currentMessageId,
            // manifest 声明的可写 state ns 白名单 —— 不给则卡可越界写
            // 任意 chat_state(SEC:mount 时 manifest 已在手)。
            writableNamespaces: mount.manifest?.permissions?.stateNamespaces,
        }, client());
        // client() 构造时锚定 session.baseUrl —— 会话切换要重建 host
        // (旧实现 per-dispatch 取 client() 天然跟随;deps 里留 baseUrl 还原文)。
        bridgeRef.current = bridge;
        // 种子快照先于卡 init 竞速(ctx.__ready 自己也在拉 getChat —— 双份
        // 同值无害;卡的 eventOn 后到也只会漏历史 diff,事件面不回放)。
        void host.seed();
        const poll = setInterval(() => { void host.pollChat(); }, PANEL_POLL_MS);
        return () => {
            clearInterval(poll);
            bridgeRef.current = null;
            bridge.dispose();
            host.dispose();
        };
    }, [mount, allowed, charDir, chatName, surface, currentMessageId, onThEvent, conn.baseUrl]);

    const onMessage = (data: unknown) => bridgeRef.current?.onMessage(data);
    return { webRef, onMessage };
}
