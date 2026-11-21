// MessageIframe — TH「前端界面」楼层 iframe 宿主(TASK-049 displayed_message)。
//
// TH/JSR 语义(ref/extensions/JS-Slash-Runner):楼层渲染文本里的
// <pre><code> 含 <body/<head/html> 即前端界面块 → 换成 iframe(srcdoc =
// 块内容 + TH boilerplate + predefine TH 面)。
//
// 本实现走 card-runtime doc mount(同 CardApp 能力模型):
//   POST /api/card-runtime/mounts {kind:'message', html} → mountId + entryUrl
//   + bridgeNonce → <iframe sandbox> GET /card-runtime/m/<id>/?shim=t0
//   → 服务端出 mount.doc(壳+块内容+autoheight)+ splice t0 shim(nonce bootstrap)
//   → 'utopinn-panel' 桥 = 全 TH 面(PANEL_METHODS_TH;T0 本地+th/call 转发)。
//
// 事件:挂自己的 CardAppHost 轮询泵 —— 楼层 diff 事件 + 信箱事件照常推给
// 卡内 eventOn 订阅(TH 一致);refresh_message(mid=本楼) → 自助重新 mint。
import { useEffect, useRef, useState } from 'react';
import { apiPost } from '../api/client';
import { dispatchPanelCall, type PanelContext } from './ctxApi';
import { PanelBridge } from './bridge';
import { CardAppHost } from './ctxHost';
import { PANEL_METHODS_TH } from '@utopinn/protocol';

interface DocMountBundle {
    mountId?: string;
    entryUrl: string;
    bridgeNonce?: string;
    manifest?: { entryKind?: string; permissions?: { api?: string[]; sameOrigin?: boolean } };
}

const POLL_MS = 8_000;
const clampHeight = (h: number) => Math.min(Math.max(Math.round(h), 32), 4000);

/**
 * 楼层内嵌 TH iframe。props.html 一变 → 整枚重铸(TH 也是整帧重渲)。
 */
export function MessageIframe({ charDir, chatName, html, messageId }: PanelContext & { html: string; messageId?: number }) {
    const [mount, setMount] = useState<DocMountBundle | null>(null);
    const [dead, setDead] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const frameRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        let gone = false;
        setMount(null);
        setDead(null);
        apiPost<DocMountBundle>('/api/card-runtime/mounts', { kind: 'message', charId: charDir, chatName, html })
            .then((m) => { if (!gone) setMount(m); })
            .catch((e) => { if (!gone) setDead(e instanceof Error ? e.message : String(e)); });
        return () => { gone = true; };
    }, [charDir, chatName, html, attempt]);

    useEffect(() => {
        if (!mount) return;
        // TH 楼层 iframe = 全 TH 面(桥 T0 本地 + th/call 转发,与 CardApp 'th' 档同级)
        const bridge = new PanelBridge({
            nonce: mount.bridgeNonce ?? '',
            allowed: new Set<string>(PANEL_METHODS_TH),
            getWindow: () => frameRef.current?.contentWindow ?? null,
            dispatch: (method, args) => dispatchPanelCall(method, args, { charDir, chatName }, host),
        });
        const host = new CardAppHost({
            charDir,
            chatName: chatName ?? undefined,
            push: (event, payload) => bridge.push(event, payload),
            onThEvent: (name, args) => {
                if (name === 'refresh_message' && (messageId === undefined || Number(args?.[0]) === messageId)) {
                    setAttempt((a) => a + 1);
                }
            },
        });
        void host.seed();
        const poll = window.setInterval(() => { void host.pollChat(); }, POLL_MS);
        window.addEventListener('message', bridge.onMessage);
        return () => {
            window.clearInterval(poll);
            window.removeEventListener('message', bridge.onMessage);
            bridge.dispose();
            host.dispose();
        };
    }, [mount, charDir, chatName, messageId]);

    // 自动高度:iframe 内 autoheight 脚本 post height → 调 iframe 高
    useEffect(() => {
        const onHeight = (ev: MessageEvent) => {
            if (ev.source !== frameRef.current?.contentWindow) return;
            const d = ev.data as { type?: string; height?: unknown } | null;
            if (d?.type === 'utopinn-msgframe-height' && typeof d.height === 'number' && frameRef.current) {
                frameRef.current.style.height = `${clampHeight(d.height)}px`;
            }
        };
        window.addEventListener('message', onHeight);
        return () => window.removeEventListener('message', onHeight);
    }, []);

    if (dead) {
        return (
            <div className="my-1 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-2 font-mono-ui text-[11px] text-[color:var(--status-danger)]">
                TH frame mount failed: {dead}
                <button className="ml-2 underline" onClick={() => setAttempt((a) => a + 1)}>retry</button>
            </div>
        );
    }
    if (!mount) {
        return <div className="my-1 h-16 animate-pulse rounded-lg bg-[color:var(--bg-surface)]" />;
    }
    return (
        <iframe
            ref={frameRef}
            title={`th-message:${charDir}#${messageId ?? '-'}`}
            src={`${mount.entryUrl}?shim=t0`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="my-1 block w-full overflow-hidden rounded-lg border-0"
            style={{ minHeight: 32 }}
        />
    );
}
