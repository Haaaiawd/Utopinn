// panel-bridge — 'utopinn-panel' 桥宿主侧核(耦合格调研 §5.3 收敛)。
//
// 原三份同构实现(web cardapp/bridge.ts、mobile panels/bridge.ts、cli
// cardapp-host.mjs)统一到此。桥逻辑是客户端面(校验 → 台账 → dispatch →
// 应答),故在 api-client;帧形状/方法表/授权展开在 @utopinn/protocol
// (panels.ts + panel-wire.ts),不重述。
//
// 六门判序(三端一致):
//   transport verifySource? → channel/direction → requestId → NONCE
//   → shape(isPanelRequestData)→ allowlist → dispatch → respond/deny
// nonce 闸先于 shape:缺席(''/undefined)永不相等,伪造/遗留流量在此即拒。
//
// 传输参数化(宿主各供一段):
//   web iframe : verifySource = (ev) => ev.source === iframe.contentWindow
//                normalize    = (ev) => ev.data
//                send         = (msg) => contentWindow.postMessage(msg, '*')
//   RN WebView : send         = (msg) => injectJavaScript(receiveJs(msg))
//                normalize    = JSON.parse 容错(onMessage 给的是 string)
//   CLI headless: normalize  = jsonClone(斩断跨 realm 引用 + 落实 wire 可序列化)
//                encodeResult = jsonClone(result) ?? null(同因)
//                send         = 进程内 __utopinnPanelReceive 直递
// 传输唯一性(RN/进程内无 ev.source 概念)由「消息只能来自本 WebView/本
// realm」兜底 —— mount-scoped nonce 仍是全部鉴别手段,与服务端设计同姿态。
import {
    isPanelRequestData,
    toWireError,
    type AnyPanelMethod,
    type PanelPush,
    type PanelRequest,
    type PanelResponse,
} from '@utopinn/protocol';

export interface PanelBridgeOpts {
    /** Mount-scoped bridge nonce — inbound requests must match it exactly. */
    nonce: string;
    /** Grant set expanded by protocol.expandApiGrants (or an explicit table). */
    allowed: ReadonlySet<string>;
    /**
     * Transport pre-gate, runs before payload is read(web iframe 的
     * `ev.source === contentWindow` 门)。缺席 → 传输本身已限定卡域
     * (RN WebView onMessage / 进程内钩子),nonce 承担全部鉴别。
     */
    verifySource?: (raw: unknown) => boolean;
    /**
     * Raw transport payload → wire candidate。web 剥 ev.data;RN 容错
     * JSON.parse;CLI 进程内 jsonClone。返回非对象 → 静默丢弃。
     */
    normalize?: (raw: unknown) => unknown;
    /** Host → card delivery(response/push 统一出口)。 */
    send: (msg: PanelResponse | PanelPush) => void;
    /** dispatch 结果出站前编码(CLI 跨 realm jsonClone;默认原样)。 */
    encodeResult?: (result: unknown) => unknown;
    /** Forward an authorized call (ctxApi → server TH layer). */
    dispatch: (method: AnyPanelMethod, args: Record<string, unknown>) => Promise<unknown>;
}

export class PanelBridge {
    /** requestIds currently being dispatched — the pending ledger. */
    private pending = new Set<string>();
    private dead = false;

    constructor(private readonly opts: PanelBridgeOpts) { }

    /**
     * Inbound entry — register as the transport's message handler:
     *   web: window.addEventListener('message', bridge.onMessage)
     *   RN : WebView onMessage → bridge.onMessage(e.nativeEvent.data)
     *   CLI: window.__utopinnPanelPost → bridge.onMessage(msg)
     */
    readonly onMessage = (raw: unknown): void => {
        if (this.dead) return;
        if (this.opts.verifySource && !this.opts.verifySource(raw)) return;
        const data = (this.opts.normalize ? this.opts.normalize(raw) : raw) as Partial<PanelRequest> | null;
        if (!data || data.channel !== 'utopinn-panel' || data.direction !== 'request') return;
        if (typeof data.requestId !== 'string') return; // can't correlate — drop
        if (data.nonce !== this.opts.nonce) {
            return this.deny(data.requestId, 'bad_nonce', 'bridge nonce mismatch');
        }
        if (!isPanelRequestData(data)) {
            return this.deny(data.requestId, 'bad_request', 'malformed panel request');
        }
        if (!this.opts.allowed.has(data.method)) {
            return this.deny(data.requestId, 'denied', `method not granted: ${data.method}`);
        }
        const requestId = data.requestId;
        const encode = this.opts.encodeResult;
        this.pending.add(requestId);
        Promise.resolve(this.opts.dispatch(data.method, data.args ?? {}))
            .then((result) => this.respond(requestId, { ok: true, result: encode ? encode(result) : result }))
            .catch((e) => this.respond(requestId, { ok: false, error: toWireError(e) }))
            .finally(() => this.pending.delete(requestId));
    };

    private respond(requestId: string, body: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): void {
        if (this.dead) return;
        const msg: PanelResponse = {
            channel: 'utopinn-panel', direction: 'response',
            nonce: this.opts.nonce, requestId, ...body,
        };
        this.opts.send(msg);
    }

    private deny(requestId: string, code: string, message: string): void {
        this.respond(requestId, { ok: false, error: { code, message } });
    }

    /** Host → card unsolicited push('th.event'/'host.event'/'chat.updated' 等)。 */
    push(event: PanelPush['event'], payload?: Record<string, unknown>): void {
        if (this.dead) return;
        const msg: PanelPush = {
            channel: 'utopinn-panel', direction: 'push',
            nonce: this.opts.nonce, event, payload,
        };
        this.opts.send(msg);
    }

    dispose(): void {
        this.dead = true;
        this.pending.clear();
    }
}
