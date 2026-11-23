// MessageFrame — TH「前端界面」楼层块宿主(P1;web MessageIframe 的 RN 对应物)。
//
//   POST /api/card-runtime/mounts {kind:'message',charId,chatName,html}
//   → doc-mount(entryUrl + bridgeNonce)→ WebView 加载 ?shim=t0
//   → 'utopinn-panel' 桥 + 只读 TH 子集(PANEL_METHODS_TH_MSGFRAME —— 块是
//     模型产出,不给写面;见 protocol panels.ts 注释)。
//
// 与 web MessageIframe 的对齐/差异:
//   - 高度:web 靠 doc 壳的 autoheight 脚本 parent.postMessage 回报 —— RN
//     WebView 里 window.parent===window,那条路是死的。这里注入同款
//     ResizeObserver 脚本走 ReactNativeWebView.postMessage → onMessage
//     先于桥拦截 {type:'utopinn-msgframe-height'} 调帧高(上限同 web 4000)。
//   - 事件:挂自己的 PanelEventPump(usePanelHost)—— 楼层 diff + 信箱
//     事件照常推给卡内 eventOn;refresh_message(mid=本楼) → 重铸本帧。
//   - getCurrentMessageId → 所在楼层下标(TH 楼层帧身份语义;服务端实现
//     回 lastMessageId,不同义,宿主层覆盖)。
//   - 不 revoke:楼层帧随滚动/回收高频生灭,生命周期交给服务端 TTL
//     (web 同策略);html 变化 → 整枚重铸(TH 也是整帧重渲)。
import { useCallback, useEffect, useMemo, useState, type FC, type ReactElement, type Ref } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { PANEL_METHODS_TH_MSGFRAME } from '@utopinn/protocol';
import { mountMessageFrame, type MountBundle } from './mounts';
import { usePanelHost, type WebViewHandle } from './host';
import { useSession } from '../state/session';
import { colors } from '../ui/theme';

/** 高度闸 —— 与 web clampHeight 同(32..4000)。 */
const clampHeight = (h: number) => Math.min(Math.max(Math.round(h), 32), 4000);

/**
 * doc 壳自带 autoheight 走 parent.postMessage(RN 死路)——注入等价物:
 * 同一判定(scrollHeight 双源取大 + 去重)改走 ReactNativeWebView.postMessage;
 * utopinn-panel 桥报文是 {channel:'utopinn-panel'},不撞信道。
 */
const HEIGHT_REPORT_JS = `(function(){
  var last = -1;
  function post() {
    try {
      var h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0);
      if (h !== last) { last = h;
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'utopinn-msgframe-height', height: h }));
        }
      }
    } catch (e) { /* opaque 父页/布局未就绪不致命 */ }
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(post).observe(document.documentElement);
  }
  window.addEventListener('load', post);
  document.addEventListener('DOMContentLoaded', post);
  setTimeout(post, 50); setTimeout(post, 300); setTimeout(post, 1200);
})(); true;`;

interface FrameWebViewProps {
    ref?: Ref<WebViewHandle>;
    source: { uri: string };
    onMessage?: (e: WebViewMessageEvent) => void;
    onShouldStartLoadWithRequest?: (req: { url: string }) => boolean;
    originWhitelist?: string[];
    setSupportMultipleWindows?: boolean;
    sharedCookiesEnabled?: boolean;
    domStorageEnabled?: boolean;
    javaScriptEnabled?: boolean;
    mixedContentMode?: 'never' | 'always' | 'compatibility';
    injectedJavaScript?: string;
    onHttpError?: (e: { nativeEvent: { statusCode: number } }) => void;
    onError?: (e: { nativeEvent: { description?: string } }) => void;
    startInLoadingState?: boolean;
    renderLoading?: () => ReactElement | null;
    scrollEnabled?: boolean;
    style?: StyleProp<ViewStyle>;
}
const WView = WebView as unknown as FC<FrameWebViewProps>;

export function MessageFrame({ charDir, chatName, html, messageId }: {
    charDir: string;
    chatName?: string;
    /** 前端块 HTML(extractFrontendBlocks 产出;变则整枚重铸)。 */
    html: string;
    /** 所在楼层下标 —— getCurrentMessageId + refresh_message 过滤用。 */
    messageId?: number;
}) {
    const conn = useSession();
    const [mount, setMount] = useState<MountBundle | null>(null);
    const [dead, setDead] = useState<string | null>(null);
    const [height, setHeight] = useState(64);

    // ── doc-mount 生命周期:html 变 → 重铸;不 revoke(TTL 收场)。 ──
    useEffect(() => {
        let gone = false;
        setMount(null);
        setDead(null);
        mountMessageFrame({ charId: charDir, chatName, html })
            .then((m) => { if (!gone) setMount(m); })
            .catch((e) => { if (!gone) setDead(e instanceof Error ? e.message : String(e)); });
        return () => { gone = true; };
    }, [charDir, chatName, html]);

    // refresh_message(mid=本楼/无坐标) → 自助重铸(usePanelHost 信箱旁路)。
    const onThEvent = useCallback((name: string, args: unknown[]) => {
        if (name === 'refresh_message' && (messageId === undefined || Number(args?.[0]) === messageId)) {
            setMount((m) => {
                if (!m) return m;
                mountMessageFrame({ charId: charDir, chatName, html })
                    .then(setMount)
                    .catch((e) => setDead(e instanceof Error ? e.message : String(e)));
                return null;
            });
        }
    }, [charDir, chatName, html, messageId]);

    /* 授权子集 = 只读 + 订阅 + UI 动词(protocol PANEL_METHODS_TH_MSGFRAME)。
       楼层块是模型产出 —— deleteChatMessages/变量写/generate/triggerSlash
       这类写法不能随 HTML 白送;TH 合法的「按钮写变量」走显式确认门,
       未实现前一律拒。与 web MessageIframe 的全 TH 面是有意的分歧(web
       同隐患未修,移动端先收)。 */
    const allowed = useMemo(() => new Set<string>(PANEL_METHODS_TH_MSGFRAME), []);
    // 楼层帧本身即可视表面:open → delivered:'floor_frame';close → 无壳可收,
    // 如实 no_shell_nav(ctx.* 在 PANEL_METHODS_TH 闸下根本到不了 dispatch,
    // 这是防御性应答,与桥 allowlist 分层不冲突)。
    const surface = useMemo(() => ({ deliveredAs: 'floor_frame' }), []);
    const { webRef, onMessage } = usePanelHost({
        mount,
        allowed,
        charDir,
        chatName,
        surface,
        currentMessageId: messageId,
        onThEvent,
    });

    // 高度上报与桥报文同信道进来 —— 先拦 utopinn-msgframe-height,余者进桥。
    const onWvMessage = (e: WebViewMessageEvent) => {
        const raw = e.nativeEvent.data;
        if (typeof raw === 'string' && raw.includes('msgframe-height')) {
            try {
                const d = JSON.parse(raw) as { type?: string; height?: unknown };
                if (d?.type === 'utopinn-msgframe-height' && typeof d.height === 'number') {
                    setHeight(clampHeight(d.height));
                    return;
                }
            } catch { /* 非 JSON 落回桥 */ }
        }
        onMessage(raw);
    };

    if (dead) {
        return <View style={styles.dead} />;
    }
    if (!mount) {
        return <View style={styles.loading} />;
    }
    const src = `${conn.url(mount.entryUrl)}${mount.entryUrl.includes('?') ? '&' : '?'}shim=t0`;
    const mountPrefix = `${conn.baseUrl}/card-runtime/`;
    return (
        <View style={[styles.host, { height }]}>
            <WView
                ref={webRef}
                source={{ uri: src }}
                onMessage={onWvMessage}
                injectedJavaScript={HEIGHT_REPORT_JS}
                // 同 PanelWebView 的导航闸:主框只许留在 mount 面内。
                onShouldStartLoadWithRequest={(req) =>
                    req.url.startsWith(mountPrefix) ||
                    req.url === 'about:blank' ||
                    req.url.startsWith('data:') ||
                    req.url.startsWith('blob:')
                }
                originWhitelist={['*']}
                setSupportMultipleWindows={false}
                sharedCookiesEnabled={false}
                domStorageEnabled={true}
                javaScriptEnabled={true}
                mixedContentMode="compatibility"
                onHttpError={() => setDead('http_error')}
                onError={() => setDead('load_error')}
                // 帧高由上报驱动 —— 内滚动关掉,不然双滚动条手感割裂。
                scrollEnabled={false}
                startInLoadingState={true}
                renderLoading={() => <View style={styles.loading} />}
                style={styles.web}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    host: {
        marginVertical: 6,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: colors.card,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
    },
    web: { flex: 1, backgroundColor: 'transparent' },
    loading: { height: 64, borderRadius: 10, backgroundColor: colors.card, marginVertical: 6 },
    dead: {
        height: 36, borderRadius: 10, marginVertical: 6,
        backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
});
