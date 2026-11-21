// PanelWebView — RN host for untrusted card HTML (TASK-009).
// Flow mirrors the web CardAppFrame (apps/web/src/cardapp/CardAppFrame.tsx):
//   POST /api/card-runtime/mounts {charId} → mount bundle (entryUrl +
//   bridgeNonce + manifest) → WebView at entryUrl?shim=t0 → 'utopinn-panel'
//   bridge → ctxApi → server TH layer.
//
// Security posture (same model as design/cardapp-web-host.md + protocol
// panels.ts, carried to the RN transport):
//   - the WebView only ever sees session-free /card-runtime/m/<id>/ URLs —
//     the mountId capability is the authority; no session cookie is sent
//     (RN's fetch jar is app-level, never shared with the WebView, and
//     sharedCookiesEnabled is off for iOS WKWebView);
//   - CSP + opaque-origin headers come from the server (csp.js); RN's
//     WebView does not enforce CSP sandbox tokens, so the mount surface +
//     navigation gate below is what keeps card JS off /api/* — every
//     server endpoint on this surface ignores sessions anyway;
//   - inbound bridge requests authenticate via the mount-scoped nonce
//     echoed by the shim (onMessage has no ev.source — nonce equality is
//     the whole check); ungranted methods are denied without dispatch;
//   - 'ctx'-only manifests degrade to a badge (t0 shim serves the th face).
import { useEffect, useMemo, useRef, useState, type FC, type ReactElement, type Ref } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { dispatchPanelCall, type PanelContext } from './ctxApi';
import { expandApiGrants, PanelBridge } from './bridge';
import { mountCardApp, mountErrorCode, revokeMount, type MountBundle } from './mounts';
import { useSession } from '../state/session';
import { colors } from '../ui/theme';

/**
 * Phase machine:
 *   mounting → ready | degraded(ctx-face) | none(card has no usable panel)
 *   failure  → error (retryable)
 */
type Phase =
    | { kind: 'mounting' }
    | { kind: 'ready' }
    | { kind: 'degraded'; reason: 'ctx-face' }
    | { kind: 'none'; reason: 'no_card_app' | 'card_app_disabled' }
    | { kind: 'error'; message: string };

/**
 * host→card wire delivery: inject `window.__utopinnPanelReceive(msg)` — the
 * entrypoint the t0 shim installs for exactly this host (it also listens
 * for 'message' events, but direct delivery skips the event hop).
 * U+2028/U+2029 are legal JSON yet illegal inside JS string literals —
 * escape them or card data containing them would break the injection.
 */
function receiveJs(msg: unknown): string {
    const wire = JSON.stringify(msg).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `(function(){var f=window.__utopinnPanelReceive;if(typeof f==='function'){f(${wire});}})();true;`;
}

// RNW 14 的 WebViewProps = IOS&Android&Windows 声明交集,在 strict 下塌成
// never(库 d.ts 自身的问题,不是用法错)——这里声明我们实际使用的公共面,
// 既绕开塌缩又保住对本文件 props 的类型检查。
/** WebView 句柄的最小结构 —— 我们只调 injectJavaScript。 */
export interface WebViewHandle {
    injectJavaScript: (js: string) => void;
}

interface PanelWebViewElementProps {
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
    onHttpError?: (e: { nativeEvent: { statusCode: number } }) => void;
    onError?: (e: { nativeEvent: { description?: string } }) => void;
    startInLoadingState?: boolean;
    renderLoading?: () => ReactElement | null;
    style?: StyleProp<ViewStyle>;
}
const WView = WebView as unknown as FC<PanelWebViewElementProps>;

export function PanelWebView({ charDir, chatName, onSurfaceClose }: PanelContext & {
    /** 卡「表面可见性」close 语义的壳回调(屏幕侧接 navigation.goBack 等;
     *  未接 → surfaceClose 如实 no_shell_nav 降级)。 */
    onSurfaceClose?: () => void;
}) {
    const conn = useSession();
    const [mount, setMount] = useState<MountBundle | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'mounting' });
    const [attempt, setAttempt] = useState(0);
    const webRef = useRef<WebViewHandle | null>(null);
    const bridgeRef = useRef<PanelBridge | null>(null);

    // ── mount lifecycle: mint → load; cleanup → revoke(会话切换/卸载即收) ──
    useEffect(() => {
        let dead = false;
        let mintedId: string | null = null;
        setMount(null);
        setPhase({ kind: 'mounting' });
        mountCardApp(charDir)
            .then((m) => {
                if (dead) {
                    // unmounted mid-mint — the fresh capability must not leak
                    if (m.mountId) void revokeMount(m.mountId).catch(() => { });
                    return;
                }
                mintedId = m.mountId ?? null;
                setMount(m);
                const grants = expandApiGrants(m.manifest?.permissions?.api);
                // ctx-only manifest: nothing the t0 shim can lawfully call —
                // still render the frame (static UI survives) under a badge.
                setPhase(grants.ctxFace && !grants.thFace
                    ? { kind: 'degraded', reason: 'ctx-face' }
                    : { kind: 'ready' });
            })
            .catch((e) => {
                if (dead) return;
                const code = mountErrorCode(e);
                if (code === 'no_card_app' || code === 'card_app_disabled') {
                    setPhase({ kind: 'none', reason: code });
                } else {
                    setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
                }
            });
        return () => {
            dead = true;
            if (mintedId) void revokeMount(mintedId).catch(() => { });
        };
    }, [charDir, conn.baseUrl, attempt]);

    const grants = useMemo(() => expandApiGrants(mount?.manifest?.permissions?.api), [mount]);

    // ── bridge lifecycle: nonce + allowlist + dispatch, tied to this mount ──
    useEffect(() => {
        if (!mount) return;
        const bridge = new PanelBridge({
            // No nonce in the bundle → '' — which no card can match, so every
            // request is denied rather than silently authorized.
            nonce: mount.bridgeNonce ?? '',
            allowed: grants.allowed,
            send: (msg) => webRef.current?.injectJavaScript(receiveJs(msg)),
            dispatch: async (method, args) => {
                // 卡「表面可见性」(ctx.openOverlay/closeOverlay → wire
                // ctx.surfaceOpen/surfaceClose):面板页本身就是卡的可视表面 ——
                // open 即达意(无需再导航);close → 壳回调回上一页,未接如实降级。
                if (method === 'ctx.surfaceOpen') {
                    return { ok: true, delivered: 'panel_page' };
                }
                if (method === 'ctx.surfaceClose') {
                    if (onSurfaceClose) {
                        onSurfaceClose();
                        return { ok: true };
                    }
                    return { ok: false, reason: 'no_shell_nav' };
                }
                return dispatchPanelCall(method, args, { charDir, chatName });
            },
        });
        bridgeRef.current = bridge;
        return () => {
            bridgeRef.current = null;
            bridge.dispose();
        };
    }, [mount, grants, charDir, chatName, onSurfaceClose]);

    const onMessage = (e: WebViewMessageEvent) => {
        bridgeRef.current?.onMessage(e.nativeEvent.data);
    };

    if (phase.kind === 'error') {
        return (
            <View style={styles.center}>
                <Text style={styles.errGlyph}>🧩</Text>
                <Text style={styles.errText}>面板挂载失败:{phase.message}</Text>
                <Pressable style={styles.retry} onPress={() => setAttempt((a) => a + 1)}>
                    <Text style={styles.retryText}>重试</Text>
                </Pressable>
            </View>
        );
    }
    if (phase.kind === 'none') {
        return (
            <View style={styles.center}>
                <Text style={styles.errGlyph}>🃏</Text>
                <Text style={styles.emptyText}>
                    {phase.reason === 'card_app_disabled' ? '这张卡的面板被禁用了' : '这张卡没有面板'}
                </Text>
                <Text style={styles.emptySub}>CardApp(背包 / 任务卡 / 状态栏)由卡作者内嵌,不是所有卡都有。</Text>
            </View>
        );
    }
    if (phase.kind === 'mounting' || !mount) {
        return (
            <View style={styles.center}>
                <ActivityIndicator color={colors.sub} />
                <Text style={styles.emptySub}>挂载面板…</Text>
            </View>
        );
    }

    const src = `${conn.url(mount.entryUrl)}${mount.entryUrl.includes('?') ? '&' : '?'}shim=t0`;
    const mountPrefix = `${conn.baseUrl}/card-runtime/`;
    return (
        <View style={styles.host}>
            {phase.kind === 'degraded' && (
                <View style={styles.degraded}>
                    <Text style={styles.degradedText}>此卡声明了 ctx 面,当前只支持 th 面 —— 部分交互不可用</Text>
                </View>
            )}
            <WView
                ref={webRef}
                source={{ uri: src }}
                onMessage={onMessage}
                // Navigation gate ≈ iframe staying inside the mount space:
                // main-frame loads may only hit the session-free
                // /card-runtime surface (or non-http schemes the card may
                // legitimately produce). Subresources are CSP-scoped by the
                // server; /api/* is unreachable either way.
                onShouldStartLoadWithRequest={(req) =>
                    req.url.startsWith(mountPrefix) ||
                    req.url === 'about:blank' ||
                    req.url.startsWith('data:') ||
                    req.url.startsWith('blob:')
                }
                // '*' looks wrong but is the strict posture: RNW hands any
                // URL that FAILS the whitelist to Linking.openURL — i.e. a
                // non-'*' list would let card JS escape to the system
                // browser or fire intent:// apps. Whitelisting everything
                // makes onShouldStartLoadWithRequest the sole arbiter, and
                // it silently denies anything outside the mount space
                // (parity with the web iframe's sandbox=allow-scripts,
                // which has no popups/navigation either).
                originWhitelist={['*']}
                setSupportMultipleWindows={false}
                // sandboxed card code must not ride the user's session —
                // mount capability only (RN fetch keeps its own jar anyway;
                // this guards the iOS WKWebView shared cookie store).
                sharedCookiesEnabled={false}
                // Card UI prefs commonly stash in localStorage; allowed —
                // truth still lives server-side (chat_metadata / chat_state).
                domStorageEnabled={true}
                javaScriptEnabled={true}
                // http dev servers are declared cleartext in app.json; keep
                // the WebView consistent for https bases serving http mounts.
                mixedContentMode="compatibility"
                onHttpError={(e) =>
                    setPhase({
                        kind: 'error',
                        message: `面板加载失败(HTTP ${e.nativeEvent.statusCode})——会话切换或挂载过期后重进可恢复`,
                    })
                }
                onError={(e) =>
                    setPhase({ kind: 'error', message: e.nativeEvent.description || '面板加载失败' })
                }
                startInLoadingState={true}
                renderLoading={() => (
                    <View style={styles.loading}>
                        <ActivityIndicator color={colors.sub} />
                    </View>
                )}
                style={styles.web}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    host: { flex: 1, backgroundColor: colors.bg },
    web: { flex: 1, backgroundColor: 'transparent' },
    loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.bg },
    errGlyph: { fontSize: 36, marginBottom: 10 },
    errText: { color: colors.sub, fontSize: 14, textAlign: 'center', lineHeight: 21 },
    emptyText: { color: colors.sub, fontSize: 15 },
    emptySub: { color: colors.dim, fontSize: 12, marginTop: 10, textAlign: 'center', lineHeight: 18 },
    retry: {
        marginTop: 16, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
        backgroundColor: colors.card, paddingHorizontal: 18, paddingVertical: 8,
    },
    retryText: { color: colors.accent, fontSize: 14 },
    degraded: {
        paddingHorizontal: 14, paddingVertical: 8,
        backgroundColor: '#2a2216', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.warn,
    },
    degradedText: { color: colors.warn, fontSize: 12 },
});
