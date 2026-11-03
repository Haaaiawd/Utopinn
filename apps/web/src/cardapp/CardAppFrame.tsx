// CardAppFrame — web host for untrusted card HTML (TASK-022).
// Flow: POST /api/card-runtime/mounts {charId} → {entryUrl, manifest} →
// <iframe sandbox="allow-scripts"> at entryUrl?shim=t0 → 'uberge-panel'
// postMessage bridge → ctxApi dispatch.
//
// Security posture (design/cardapp-web-host.md):
// - opaque-origin sandbox: card code cannot read DOM/cookies; no modals/dl
// - NO nonce injection (can't write into an opaque iframe window) — the web
//   host instead authenticates via `event.source === iframe.contentWindow`,
//   which only this frame can satisfy. Equivalent strength for one iframe.
// - requests outside the shim channel are dropped silently.
import { useEffect, useRef, useState } from 'react';
import { apiPost } from '../api/client';
import { dispatchPanelCall, type PanelContext } from './ctxApi';
import { Icon } from '../components/Icon';

interface MountBundle {
    entryUrl: string;
    manifest?: { name?: string; enabled?: boolean };
    warnings?: string[];
}

interface BridgeMsg {
    channel?: string;
    direction?: string;
    requestId?: string;
    method?: string;
    args?: Record<string, unknown>;
}

export function CardAppFrame({ charDir, chatName }: PanelContext) {
    const [mount, setMount] = useState<MountBundle | null>(null);
    const [error, setError] = useState<string | null>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        let dead = false;
        apiPost<MountBundle>('/api/card-runtime/mounts', { charId: charDir })
            .then((m) => { if (!dead) setMount(m); })
            .catch((e) => { if (!dead) setError(e instanceof Error ? e.message : String(e)); });
        return () => { dead = true; };
    }, [charDir]);

    useEffect(() => {
        const onMsg = (ev: MessageEvent) => {
            if (ev.source !== frameRef.current?.contentWindow) return;
            const msg = ev.data as BridgeMsg;
            if (msg?.channel !== 'uberge-panel' || msg.direction !== 'request' || !msg.requestId || !msg.method) return;
            const reply = (ok: boolean, payload: unknown) => {
                frameRef.current?.contentWindow?.postMessage(
                    ok
                        ? { channel: 'uberge-panel', direction: 'response', requestId: msg.requestId, ok: true, result: payload }
                        : { channel: 'uberge-panel', direction: 'response', requestId: msg.requestId, ok: false, error: { message: String(payload) } },
                    '*', // opaque origin — target must be '*'; source check above guards inbound
                );
            };
            dispatchPanelCall(msg.method, msg.args ?? {}, { charDir, chatName })
                .then((v) => reply(true, v))
                .catch((e) => reply(false, e instanceof Error ? e.message : e));
        };
        window.addEventListener('message', onMsg);
        return () => window.removeEventListener('message', onMsg);
    }, [charDir, chatName]);

    if (error) {
        return (
            <div className="empty-hint">
                <div className="glyph"><Icon name="stories" size={22} /></div>
                <p>CardApp: {error}</p>
            </div>
        );
    }
    if (!mount) return <div className="empty-hint"><p>…</p></div>;

    const src = `${mount.entryUrl}${mount.entryUrl.includes('?') ? '&' : '?'}shim=t0`;
    return (
        <iframe
            ref={frameRef}
            className="cardapp-frame"
            title={mount.manifest?.name ?? `cardapp:${charDir}`}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
        />
    );
}
