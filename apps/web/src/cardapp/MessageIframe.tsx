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
import { useShell } from '../kernel/context';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';

interface DocMountBundle {
    mountId?: string;
    entryUrl: string;
    bridgeNonce?: string;
    manifest?: { entryKind?: string; permissions?: { api?: string[]; sameOrigin?: boolean } };
}

const POLL_MS = 8_000;
const clampHeight = (h: number) => Math.min(Math.max(Math.round(h), 32), 4000);

/** dock 持久位:帧实例 = 会话坐标 + 楼号 + 块序(mountId 是进程内
 *  短寿命 capability,跨重开不稳 —— 楼层位才是可记的实例身份)。 */
const dockKey = (charDir: string, chatName: string | undefined, messageId: number | undefined, blockIndex: number) =>
    `utopinn.mf.dock.${charDir}/${chatName ?? ''}#${messageId ?? 'x'}:${blockIndex}`;

const readDocked = (k: string): boolean => {
    try { return localStorage.getItem(k) === '1'; } catch { return false; }
};

/**
 * 楼层内嵌 TH iframe。props.html 一变 → 整枚重铸(TH 也是整帧重渲)。
 * chrome='floor':右上角 dock 钮 —— 收进右工作台 'messageframe' 板块
 * (同块源重铸),楼层位留细条可再展开;按帧实例 localStorage 记档。
 * chrome='panel':板块承载变体 —— 无 dock 钮,占满板块高。
 */
export function MessageIframe({ charDir, chatName, html, messageId, blockIndex = 0, chrome = 'floor' }: PanelContext & { html: string; messageId?: number; blockIndex?: number; chrome?: 'floor' | 'panel' }) {
    const s = useShell();
    const sRef = useRef(s);
    sRef.current = s;
    const { t } = useI18n();
    const [mount, setMount] = useState<DocMountBundle | null>(null);
    const [dead, setDead] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const frameRef = useRef<HTMLIFrameElement>(null);

    const storeKey = dockKey(charDir, chatName, messageId, blockIndex);
    const [docked, setDocked] = useState(() => readDocked(storeKey));
    /* 帧实例坐标变了 → 以新 key 的存档重新判定(同组件实例复用时)。 */
    useEffect(() => { setDocked(readDocked(storeKey)); }, [storeKey]);

    const dock = () => {
        try { localStorage.setItem(storeKey, '1'); } catch { /* noop */ }
        setDocked(true);
        s.openPanel('messageframe', { charDir, chatName, html, messageId, blockIndex });
    };
    const undock = () => {
        try { localStorage.removeItem(storeKey); } catch { /* noop */ }
        setDocked(false);
    };

    useEffect(() => {
        /* 收起的 floor 帧不 mint mount(细条期不白费服务端铸造);
           panel 变体是 dock 的落点本身 —— 同一 storeKey 不挡它。 */
        if (docked && chrome === 'floor') return;
        let gone = false;
        setMount(null);
        setDead(null);
        apiPost<DocMountBundle>('/api/card-runtime/mounts', { kind: 'message', charId: charDir, chatName, html })
            .then((m) => { if (!gone) setMount(m); })
            .catch((e) => { if (!gone) setDead(e instanceof Error ? e.message : String(e)); });
        return () => { gone = true; };
    }, [charDir, chatName, html, attempt, docked, chrome]);

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
            /* 表面面(TH 格契约):message 挂载形态 → panelType='messageframe'
               (无 params 开 → 引导空态,诚实不假装);经 sRef 转发防陈化。 */
            surface: {
                panelType: 'messageframe',
                openPanel: (type, params) => sRef.current.openPanel(type ?? 'messageframe', params),
                collapsePanels: () => sRef.current.collapsePanels(),
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

    /* 已收至右栏:楼层位留可再展开的细条(按帧实例记档);panel 变体不参与。 */
    if (docked && chrome === 'floor') {
        return (
            <button
                className="my-1 flex w-full items-center justify-between gap-2 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-1.5 text-left text-[11.5px] text-[color:var(--fg-muted)] transition-colors hover:bg-[color:var(--bg-active)]"
                onClick={undock}
            >
                <span className="flex min-w-0 items-center gap-2">
                    <Icon name="layout" size={13} />
                    <span className="truncate">{t('msgframe.docked')}</span>
                </span>
                <span className="shrink-0 font-medium text-[color:var(--fg-secondary)]">{t('msgframe.expand')}</span>
            </button>
        );
    }
    if (dead) {
        return (
            <div className="my-1 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-2 font-mono-ui text-[11px] text-[color:var(--status-danger)]">
                TH frame mount failed: {dead}
                <button className="ml-2 underline" onClick={() => setAttempt((a) => a + 1)}>retry</button>
            </div>
        );
    }
    if (!mount) {
        return chrome === 'panel'
            ? <div className="h-full min-h-[280px] animate-pulse rounded-lg bg-[color:var(--bg-surface)]" />
            : <div className="my-1 h-16 animate-pulse rounded-lg bg-[color:var(--bg-surface)]" />;
    }
    const frame = (
        <iframe
            ref={frameRef}
            title={`th-message:${charDir}#${messageId ?? '-'}`}
            src={`${mount.entryUrl}?shim=t0`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className={chrome === 'panel' ? 'block h-full min-h-[280px] w-full overflow-hidden rounded-lg border-0' : 'block w-full overflow-hidden rounded-lg border-0'}
            style={{ minHeight: 32 }}
        />
    );
    if (chrome === 'panel') return <div className="h-full">{frame}</div>;
    return (
        <div className="relative my-1">
            {frame}
            {/* 「收至右栏」dock 钮 —— 帧实例收敛进 messageframe 板块(同块源重铸),
                楼层位留细条;选择按帧实例 localStorage 记档。 */}
            <button
                className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md text-white/75 backdrop-blur-sm transition-colors hover:text-white"
                style={{ background: 'rgba(18,18,20,0.55)', border: '1px solid rgba(255,255,255,0.14)' }}
                title={t('msgframe.dock')}
                onClick={dock}
            >
                <Icon name="panelRight" size={13} />
            </button>
        </div>
    );
}
