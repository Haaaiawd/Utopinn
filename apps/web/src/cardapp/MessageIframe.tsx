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
//   → 'utopinn-panel' 桥 = 楼层帧只读子集(PANEL_METHODS_TH_MSGFRAME;
//     块是模型产出,不给写面 —— 见 protocol panels.ts 注释,与移动端同闸)。
//
// 事件:挂自己的 CardAppHost 轮询泵 —— 楼层 diff 事件 + 信箱事件照常推给
// 卡内 eventOn 订阅(TH 一致);refresh_message(mid=本楼) → 自助重新 mint。
import { useEffect, useRef, useState } from 'react';
import { apiPost } from '../api/client';
import { dispatchPanelCall, type PanelContext } from './ctxApi';
import { PanelBridge, UtopinnClient } from '@utopinn/api-client';
import { CardAppHost } from './ctxHost';
import { PANEL_METHODS_TH_MSGFRAME } from '@utopinn/protocol';
import { useShell } from '../kernel/context';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { dockFrame, undockFrame, useDockedFrames } from './msgframeDock';

interface DocMountBundle {
    mountId?: string;
    entryUrl: string;
    bridgeNonce?: string;
    manifest?: { entryKind?: string; permissions?: { api?: string[]; sameOrigin?: boolean } };
}

const POLL_MS = 8_000;
const clampHeight = (h: number) => Math.min(Math.max(Math.round(h), 32), 4000);

/** 帧可记档 ⇔ 有稳定楼层坐标(dock 注册表只记 {messageId,blockIndex})。 */
const hasCoord = (messageId: number | undefined): messageId is number =>
    typeof messageId === 'number' && Number.isFinite(messageId);

/**
 * 楼层内嵌 TH iframe。props.html 一变 → 整枚重铸(TH 也是整帧重渲)。
 * chrome='floor':右上角 dock 钮 —— 坐标记进 msgframeDock 注册表并开
 * 右工作台 'messageframe' 板块(多块同收,面板按坐标反解当刻块源),
 * 楼层位留细条可再展开。chrome='panel':板块承载变体 —— 无 dock 钮。
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

    /* 停靠判定 = 坐标在注册表里(响应式:别处放回/移除 → 本帧即时反映)。 */
    const docked = useDockedFrames(charDir, chatName)
        .some((f) => f.messageId === messageId && f.blockIndex === blockIndex);

    const dock = () => {
        if (!hasCoord(messageId)) return; // 无楼层坐标 → 注册表记不了,不做假动作
        dockFrame(charDir, chatName, messageId, blockIndex);
        /* params 只带会话坐标钉面板读哪份注册表 —— html 不随行,
           面板按坐标反解当刻块源(多块同收)。 */
        s.openPanel('messageframe', { charDir, chatName });
    };
    const undock = () => {
        if (!hasCoord(messageId)) return;
        undockFrame(charDir, chatName, messageId, blockIndex);
    };

    useEffect(() => {
        /* 收起的 floor 帧不 mint mount(细条期不白费服务端铸造);
           panel 变体是 dock 的落点本身 —— 同坐标不挡它。 */
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
        /* 楼层 iframe 授权子集 = 只读 + 订阅 + UI 动词(protocol
           PANEL_METHODS_TH_MSGFRAME)。块 HTML 是模型产出 —— 把全 TH 面
           给它等于让生成内容不经确认调 deleteChatMessages/变量写/
           generate/triggerSlash;TH 合法的「状态栏按钮写变量」走显式
           确认门,未实现前一律拒(桥 allowlist 闸,过不了 dispatch)。 */
        const bridge = new PanelBridge({
            nonce: mount.bridgeNonce ?? '',
            allowed: new Set<string>(PANEL_METHODS_TH_MSGFRAME),
            verifySource: (ev) => (ev as MessageEvent).source === frameRef.current?.contentWindow,
            normalize: (ev) => (ev as MessageEvent).data,
            send: (msg) => frameRef.current?.contentWindow?.postMessage(msg, '*'),
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
            // 本帧楼层下标进 panel-t0:getCurrentMessageId / message 域变量
            // 读对的是所在楼层,不是恒 0(共享化前此洞两端同在)。
            mountMessageId: messageId,
        }, new UtopinnClient({ baseUrl: window.location.origin }));
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

    /* 已收至右栏:楼层位留可再展开的细条(坐标在册即收起);panel 变体不参与。 */
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
            {/* 「收至右栏」dock 钮 —— 坐标记进 msgframeDock 注册表 + 开
                messageframe 板块(面板按坐标反解当刻块源),楼层位留细条;
                无楼层坐标的帧不可记档,钮不出。 */}
            {hasCoord(messageId) && (
                <button
                    className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md text-white/75 backdrop-blur-sm transition-colors hover:text-white"
                    style={{ background: 'rgba(18,18,20,0.55)', border: '1px solid rgba(255,255,255,0.14)' }}
                    title={t('msgframe.dock')}
                    onClick={dock}
                >
                    <Icon name="panelRight" size={13} />
                </button>
            )}
        </div>
    );
}
