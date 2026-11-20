// CardAppFrame — web host for untrusted card HTML (TASK-022).
// Flow: POST /api/card-runtime/mounts {charId} → mount bundle (entryUrl +
// bridgeNonce + manifest) → <iframe sandbox> at entryUrl?shim=t0 →
// 'utopinn-panel' postMessage bridge → ctxApi → server TH layer.
//
// Security posture (design/cardapp-web-host.md + protocol/panels.ts):
// - opaque-origin sandbox by default; manifest.permissions.sameOrigin
//   lifts it for cards that explicitly ask (and accept the weaker posture);
// - inbound requests authenticate via `ev.source === iframe.contentWindow`
//   AND the mount-scoped bridge nonce the shim echoes back — a forged or
//   nonce-less request is denied, never dispatched;
// - the method allowlist is expanded from manifest.permissions.api
//   (absent/empty → ecosystem default = the full T0 table);
// - 'ctx'-only manifests degrade to a badge: the t0 shim serves the th
//   face, ctx calls are not wired yet.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiPost } from '../api/client';
import { dispatchPanelCall, type PanelContext } from './ctxApi';
import { expandApiGrants, PanelBridge } from './bridge';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';

/** Mount bundle from POST /api/card-runtime/mounts (mounts.js publicMount). */
interface MountBundle {
    mountId?: string;
    charId?: string;
    entryUrl: string;
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

/** mounting → ready | degraded(reason); failure → error (retryable). */
type Phase =
    | { kind: 'mounting' }
    | { kind: 'ready' }
    | { kind: 'degraded'; reason: 'ctx-face' }
    | { kind: 'error'; message: string };

export function CardAppFrame({ charDir, chatName }: PanelContext) {
    const { t } = useI18n();
    const [mount, setMount] = useState<MountBundle | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'mounting' });
    const [attempt, setAttempt] = useState(0);
    const frameRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        let dead = false;
        setMount(null);
        setPhase({ kind: 'mounting' });
        apiPost<MountBundle>('/api/card-runtime/mounts', { charId: charDir })
            .then((m) => {
                if (dead) return;
                setMount(m);
                const grants = expandApiGrants(m.manifest?.permissions?.api);
                // ctx-only manifest: nothing the t0 shim can lawfully call —
                // still render the frame (static UI survives) under a badge.
                setPhase(grants.ctxFace && !grants.thFace
                    ? { kind: 'degraded', reason: 'ctx-face' }
                    : { kind: 'ready' });
            })
            .catch((e) => {
                if (!dead) setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
            });
        return () => { dead = true; };
    }, [charDir, attempt]);

    const grants = useMemo(() => expandApiGrants(mount?.manifest?.permissions?.api), [mount]);

    useEffect(() => {
        if (!mount) return;
        const bridge = new PanelBridge({
            // No nonce in the bundle → '' — which no card can match, so every
            // request is denied rather than silently authorized.
            nonce: mount.bridgeNonce ?? '',
            allowed: grants.allowed,
            getWindow: () => frameRef.current?.contentWindow ?? null,
            dispatch: (method, args) => dispatchPanelCall(method, args, { charDir, chatName }),
        });
        window.addEventListener('message', bridge.onMessage);
        return () => {
            window.removeEventListener('message', bridge.onMessage);
            bridge.dispose();
        };
    }, [mount, grants, charDir, chatName]);

    if (phase.kind === 'error') {
        /* 规范稿错误域模型:图标盒 + 标题 + code/detail 分层,不裸渲 JSON。 */
        let code: string | null = null;
        let detail = phase.message;
        try {
            const j = JSON.parse(phase.message) as { error?: unknown; detail?: unknown };
            if (j && typeof j === 'object') {
                code = typeof j.error === 'string' ? j.error : null;
                detail = typeof j.detail === 'string' ? j.detail : phase.message;
            }
        } catch { /* 非 JSON 原样展示 */ }
        return (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 py-10 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-[12px]" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--status-danger)' }}>
                    <Icon name="warning" size={20} />
                </div>
                <div className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('panel.cardapp.mountFailed')}</div>
                {code && <div className="mt-1.5 font-mono-ui text-[10.5px]" style={{ color: 'var(--status-danger)' }}>{code}</div>}
                <div className="mt-1 max-w-[280px] break-all font-mono-ui text-[11px] leading-relaxed text-[color:var(--fg-muted)]">{detail}</div>
                <button
                    className="mt-4 h-8 rounded-lg px-3.5 text-[12px] font-medium transition-colors hover:bg-[color:var(--bg-active)]"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--fg-primary)' }}
                    onClick={() => setAttempt((a) => a + 1)}
                >
                    {t('panel.cardapp.retry')}
                </button>
            </div>
        );
    }
    if (phase.kind === 'mounting' || !mount) {
        return (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 py-10 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-[12px]" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-muted)' }}>
                    <Icon name="stories" size={20} />
                </div>
                <div className="text-[12px] text-[color:var(--fg-muted)]">…</div>
            </div>
        );
    }

    const src = `${mount.entryUrl}${mount.entryUrl.includes('?') ? '&' : '?'}shim=t0`;
    const sandbox = mount.manifest?.permissions?.sameOrigin === true
        ? 'allow-scripts allow-same-origin'
        : 'allow-scripts';
    return (
        <div className="cardapp-host">
            {phase.kind === 'degraded' && (
                <div className="cardapp-degraded">
                    <span className="rounded-md px-2 py-0.5 font-mono-ui text-[10.5px]" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--status-warn)' }}>{t('panel.cardapp.ctxDegraded')}</span>
                </div>
            )}
            <iframe
                ref={frameRef}
                className="cardapp-frame"
                title={mount.manifest?.entry ?? `cardapp:${charDir}`}
                src={src}
                sandbox={sandbox}
                referrerPolicy="no-referrer"
            />
        </div>
    );
}
