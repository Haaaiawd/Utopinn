// CardAppFrame — web host for untrusted card HTML (TASK-022 + TASK-046).
// Flow: POST /api/card-runtime/mounts {charId,chatName} → mount bundle
// (entryUrl + bridgeNonce + manifest) → <iframe sandbox> at
// entryUrl?shim=<ctx|t0> → 'utopinn-panel' postMessage bridge →
// CardAppHost composite dispatch (ctx.* table + th.* T0-local + th/call).
//
// Face selection (manifest.entryKind):
//   module   → ?shim=ctx — ctx-shim builds __CARDAPP_CTX__; the server shell
//              emits an init-caller that invokes module.init(ctx).
//   document → ?shim=t0  — TH-face T0 table (ecosystem default).
//   document + ctx-only manifest → degraded badge (no init(ctx) convention
//              exists for document entries; ctx needs a module entry).
//
// Security posture (design/cardapp-web-host.md + protocol/panels.ts):
// - opaque-origin sandbox by default; manifest.permissions.sameOrigin
//   lifts it for cards that explicitly ask (and accept the weaker posture);
// - inbound requests authenticate via `ev.source === iframe.contentWindow`
//   AND the mount-scoped bridge nonce the shim echoes back;
// - the method allowlist is expanded from manifest.permissions.api
//   (absent/empty → document: T0 table / module: ctx+th).
// - the event pump polls the chat doc and pushes subscribed host.event /
//   th.event frames — no host event bus exists yet; poll-based diff is the
//   minimal honest delivery joint.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiPost } from '../api/client';
import { dispatchPanelCall, type PanelContext } from './ctxApi';
import { expandApiGrants, PanelBridge } from './bridge';
import { CardAppHost } from './ctxHost';
import { useI18n } from '../i18n';
import { useShell } from '../kernel/context';
import { Icon } from '../components/Icon';

/** Mount bundle from POST /api/card-runtime/mounts (mounts.js publicMount). */
interface MountBundle {
    mountId?: string;
    charId?: string;
    chatName?: string | null;
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

/** 事件泵轮询间隔 —— 面板开着的 8s 一次 chat diff,够浮窗感知楼层变化。 */
const POLL_MS = 8_000;

export function CardAppFrame({ charDir, chatName }: PanelContext) {
    const { t } = useI18n();
    const s = useShell();
    const [mount, setMount] = useState<MountBundle | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'mounting' });
    const [attempt, setAttempt] = useState(0);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const bridgeRef = useRef<PanelBridge | null>(null);

    /* 全屏提升(§6.4):fs = ctx 旗标(wb tab 条「全屏」钮置位)。
       .cardapp-host 切 cardapp-host-fs class → fixed inset-0 z-78;
       同一 DOM 节点同枚 iframe,零 remount(真 portal 搬 DOM 会重载
       iframe —— 禁用,class 提升是 theater 形态的正确实现)。
       ESC / 右上退出钮还原;卡内 requestFullscreen 由 allowfullscreen 放行。 */
    const fs = s.cardappFs;
    useEffect(() => {
        if (!fs) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') s.setCardappFs(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [fs, s]);
    /* surface 面(TH 格契约)经 ref 转发 —— host/bridge 在 mount effect
       里构造且 deps 不含 s,闭包若直捕 s 会陈化(ctx memo 每渲重算)。 */
    const sRef = useRef(s);
    sRef.current = s;

    useEffect(() => {
        let dead = false;
        setMount(null);
        setPhase({ kind: 'mounting' });
        apiPost<MountBundle>('/api/card-runtime/mounts', { charId: charDir, chatName })
            .then((m) => {
                if (dead) return;
                setMount(m);
                const grants = expandApiGrants(m.manifest?.permissions?.api);
                // ctx-only manifest on a document entry — nothing lawful to
                // serve (no init(ctx) convention for documents): degrade.
                const isModule = m.manifest?.entryKind === 'module';
                setPhase(grants.ctxFace && !grants.thFace && !isModule
                    ? { kind: 'degraded', reason: 'ctx-face' }
                    : { kind: 'ready' });
            })
            .catch((e) => {
                if (!dead) setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
            });
        return () => { dead = true; };
    }, [charDir, chatName, attempt]);

    const grants = useMemo(() => expandApiGrants(mount?.manifest?.permissions?.api), [mount]);

    useEffect(() => {
        if (!mount) return;
        const bridge = new PanelBridge({
            // No nonce in the bundle → '' — which no card can match, so every
            // request is denied rather than silently authorized.
            nonce: mount.bridgeNonce ?? '',
            allowed: grants.allowed,
            getWindow: () => frameRef.current?.contentWindow ?? null,
            dispatch: (method, args) => dispatchPanelCall(method, args, { charDir, chatName }, host),
        });
        const host = new CardAppHost({
            charDir,
            chatName: chatName ?? mount.chatName ?? undefined,
            push: (event, payload) => bridge.push(event, payload),
            /* 表面面(TH 格契约):卡 surfaceOpen/surfaceClose → 壳
               openPanel/collapsePanels;panelType='cardapp'(板块挂载形态)。
               经 sRef 转发 —— 本 effect deps 不含 s,直捕会陈化。 */
            surface: {
                panelType: 'cardapp',
                openPanel: (type, params) => sRef.current.openPanel(type ?? 'cardapp', params),
                collapsePanels: () => sRef.current.collapsePanels(),
            },
        });
        bridgeRef.current = bridge;
        // 种子快照先于卡 init 竞速(ctx.__ready 也在自己拉 getChat,
        // 双份同值无害 —— host 侧缓存喂的是事件 diff)。
        void host.seed();
        const poll = window.setInterval(() => { void host.pollChat(); }, POLL_MS);
        window.addEventListener('message', bridge.onMessage);
        return () => {
            window.clearInterval(poll);
            window.removeEventListener('message', bridge.onMessage);
            bridge.dispose();
            host.dispose();
            bridgeRef.current = null;
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

    const isModule = mount.manifest?.entryKind === 'module';
    const shim = isModule ? 'ctx' : 't0';
    const src = `${mount.entryUrl}${mount.entryUrl.includes('?') ? '&' : '?'}shim=${shim}`;
    const sandbox = mount.manifest?.permissions?.sameOrigin === true
        ? 'allow-scripts allow-same-origin'
        : 'allow-scripts';
    return (
        <div className={`cardapp-host${fs ? ' cardapp-host-fs' : ''}`}>
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
                allowFullScreen
                allow="fullscreen"
            />
            {fs && (
                <button className="cardapp-fs-exit" title={t('wb.fsExit')} onClick={() => s.setCardappFs(false)}>
                    <Icon name="dockBack" size={13} />
                </button>
            )}
        </div>
    );
}
