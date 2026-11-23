// eventPump — th 事件泵(P0-4 / TASK-049 补齐;镜像
// apps/web/src/cardapp/ctxHost.ts 的 pollChat/diffAndEmitChat + pollEventLog
// 双泵,投递面从 iframe 换成 RN WebView 的 bridge.push)。
//
// 两个投递源:
//   1) chat doc 快照 diff —— 楼层追加/删除/编辑/swipe 变化 → th.event。
//      阅读器内用户写动作(发话/编辑/选稿)不经过服务端信箱,只能靠 diff
//      感知;卡经 th.* 写面做的变更也会再被 diff 看到(与 web 同语义 —
//      信箱+diff 双发是既有行为,不在这层做去重)。
//   2) th.getEventLog 信箱 —— 服务端写的跨 mount 事件(th.generate 生命周期、
//      setChatMessages 等 TH 写面、/trigger 生成、其它 mount 的 eventEmit)。
//
// 订阅面:卡的 eventOn 家族调用经 dispatch 前过 trackOutbound 记账
// (event→lid 集合,簿记规则与 packages/api-client panel-t0.ts 一致)——
// push 过滤用。真 listener 在卡 realm(t0 shim dispatchLocal),服务端的
// 'th.events' 是影子注册表 + 信箱;移动端转发语义不变 —— 这里只多记一笔。
// eventEmit/AndWait 在此注入 origin=hostId —— 本 mount 的信箱条目回流时
// 跳过,否则卡侧 dispatchLocal 已经发了一遍、泵回声会双发。
//
// 纯逻辑模块:IO 全注入(fetchChat / thCall / push),不触 RN 与 expo ——
// node --test 可直接 import 本文件(可擦除语法,Node ≥22.18 原生 TS 剥离)。
import type { PanelPush, ThEventLogEntry } from '@utopinn/protocol';

/** chat doc 快照面(本泵只读 messages 数组;StChatMessage/服务端楼层形即可)。 */
export interface ChatDocLike {
    messages?: unknown[] | null;
}

/** th/call 原始响应面(保留 unsupported 位 —— 不过 dispatchPanelCall 的包装)。 */
interface LooseThResult {
    ok?: boolean;
    unsupported?: boolean;
    result?: unknown;
    error?: string;
}

export interface PanelEventPumpDeps {
    /** 会话定位 —— chatName 缺席 → diff 泵停摆(chat doc 无处可拉),
     *  信箱仍拉(服务端退化为会话态 Map,短命但语义完整)。 */
    charDir: string;
    chatName?: string;
    /** host → card push(宿主侧接 PanelBridge.push)。 */
    push: (event: PanelPush['event'], payload: Record<string, unknown>) => void;
    /** th/call 透传面 —— 本泵只调 getEventLog;返回原始 {ok,result,unsupported} 形。 */
    thCall: (method: string, args: Record<string, unknown>) => Promise<unknown>;
    /** chat doc 读面(mobile getChat → {messages};只在 chatName 在场时被调)。 */
    fetchChat: () => Promise<ChatDocLike | null>;
    /** 信箱事件宿主旁路(不过卡订阅面)——MessageFrame 用 refresh_message 自刷。 */
    onThEvent?: (name: string, args: unknown[]) => void;
    /** 诊断/日志行(默认静默 —— 泵失败不该吵到面板上)。 */
    log?: (msg: string) => void;
}

const jsonClone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);
const asMsg = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;

/** swipe 槽位文本:string | {mes} 两种线形归一成可比较值。 */
function swipeSlotText(s: unknown): string | undefined {
    if (typeof s === 'string') return s;
    if (s && typeof s === 'object') {
        const mes = (s as { mes?: unknown }).mes;
        return typeof mes === 'string' ? mes : undefined;
    }
    return undefined;
}

export class PanelEventPump {
    /** mailbox origin 标:本 mount 转发 eventEmit 时打上,自己的泵跳过防回流。 */
    readonly hostId: string = `m-${Math.random().toString(36).slice(2, 10)}`;
    private lastEventSeq = 0;
    /** getEventLog 被判 unsupported → 永久停拉(老服务端无信箱面)。 */
    private eventLogDead = false;
    private dead = false;
    /** 上一次 chat doc 的楼层数组(seed() 建立基线,diff 不回头补发)。 */
    private chatMessages: unknown[] | null = null;
    /** event → listener-ids(panel-t0 同款;'*' = 无 lid 的旧式订阅)。 */
    private readonly subscribed = new Map<string, Set<string>>();
    private readonly deps: PanelEventPumpDeps;

    constructor(deps: PanelEventPumpDeps) {
        this.deps = deps;
    }

    // ── 订阅簿记(dispatch 前置钩子)────────────────────────────────────────

    private subscribe(event: string, lid?: string): void {
        let set = this.subscribed.get(event);
        if (!set) { set = new Set(); this.subscribed.set(event, set); }
        set.add(lid ?? '*');
    }

    private unsubscribeLid(lid: string): number {
        let removed = 0;
        for (const [ev, set] of this.subscribed) {
            if (set.delete(lid)) removed++;
            if (!set.size) this.subscribed.delete(ev);
        }
        return removed;
    }

    /**
     * dispatch 前置钩子:event 家族调用先记账、必要时补参数,再照常透传服务端
     * (服务端的影子注册表仍是内省/CLI 直查面)。返回要真正发出的 args。
     *   - eventOn/eventOnce      → 记 event→lid
     *   - eventRemoveListener    → 按 lid 摘;无 lid 按 event 摘(panel-t0 同序)
     *   - eventClearEvent/All    → 捎上本 mount 已知 lids —— server 有 ids 时只
     *                              清本 mount 影子条目,不清别家(web shadow 同语义)
     *   - eventEmit/AndWait      → 注入 origin=hostId(卡传来的 origin 不采信,
     *                              与 web emitToPanels 一致)
     *   - makeLast/makeFirst     → 顺序不影响 push 过滤,原样透传
     * 本方法不消费调用 —— 一切方法照常到达服务端。
     */
    trackOutbound(method: string, args: Record<string, unknown>): Record<string, unknown> {
        const event = typeof args?.event === 'string' ? args.event.trim() : '';
        const lid = typeof args?.listener_id === 'string' ? args.listener_id : undefined;
        switch (method) {
            case 'th.eventOn':
            case 'th.eventOnce':
                if (event) this.subscribe(event, lid);
                return args;
            case 'th.eventRemoveListener':
                if (lid) this.unsubscribeLid(lid);
                else if (event) this.subscribed.delete(event);
                return args;
            case 'th.eventClearEvent': {
                const lids = event ? [...(this.subscribed.get(event) ?? [])] : [];
                if (event) this.subscribed.delete(event);
                return { ...args, listener_ids: lids };
            }
            case 'th.eventClearListener':
                // shim 恒发 listener_ids(它摘完本地注册才发);lid 逐个清。
                for (const id of Array.isArray(args?.listener_ids) ? args.listener_ids : []) {
                    if (typeof id === 'string') this.unsubscribeLid(id);
                }
                if (lid) this.unsubscribeLid(lid);
                return args;
            case 'th.eventClearAll': {
                const lids = [...this.subscribed.values()].flatMap((s) => [...s]);
                this.subscribed.clear();
                return { ...args, listener_ids: lids };
            }
            case 'th.eventEmit':
            case 'th.eventEmitAndWait':
                return { ...args, origin: this.hostId };
            default:
                return args;
        }
    }

    /** 本 mount 当前订阅的事件名(diag/测试用)。 */
    subscribedEvents(): string[] {
        return [...this.subscribed.keys()];
    }

    // ── 投递 ─────────────────────────────────────────────────────────────

    /** 订阅过滤后推卡:t0 shim 收到 th.event 再 dispatchLocal 到真 listener。 */
    private emitTh(name: string, args: unknown[]): void {
        if (!this.subscribed.has(name)) return;
        this.deps.push('th.event', { name, args: jsonClone(args) ?? [] });
    }

    // ── chat doc diff 泵(web diffAndEmitChat 同语义)────────────────────

    /**
     * 追加 → *_message_rendered + message_sent/message_received;
     * 缩短 → message_deleted;同长 → swipe_id 变 message_swiped、
     * mes/激活槽内容变 message_edited+message_updated;
     * 任何差 → chat_changed + 'chat.updated' push(t0 shim 不认后者,
     * 但属 PanelPush 契约,ctx shim 接入日即生效)。
     *
     * 对象形 swipe 槽({mes})经 swipeSlotText 取值比较 —— 每次拉取都是新
     * parse,引用比较会每轮误报 edited(web 同位置用 !==,对象槽有假阳性;
     * 这里修掉,行为差异=少报不误报)。
     */
    private diffAndEmitChat(prev: unknown[] | null, next: unknown[] | null): void {
        if (!next) return;
        const pa = prev ?? [];
        const na = next;
        let dirty = false;
        if (na.length > pa.length) {
            for (let i = pa.length; i < na.length; i++) {
                const m = asMsg(na[i]);
                const rendered = m?.is_user ? 'user_message_rendered' : 'char_message_rendered';
                this.emitTh(rendered, [i]);
                this.emitTh(m?.is_user ? 'message_sent' : 'message_received', [i]);
            }
            dirty = true;
        } else if (na.length < pa.length) {
            this.emitTh('message_deleted', []);
            dirty = true;
        } else {
            for (let i = 0; i < na.length; i++) {
                const pm = asMsg(pa[i]);
                const nm = asMsg(na[i]);
                if (!nm || !pm) continue;
                if (nm.swipe_id !== pm.swipe_id) {
                    this.emitTh('message_swiped', [i]);
                    dirty = true;
                }
                const sid = Number.isInteger(nm.swipe_id) ? (nm.swipe_id as number) : null;
                const nSwipes = Array.isArray(nm.swipes) ? nm.swipes : null;
                const pSwipes = Array.isArray(pm.swipes) ? pm.swipes : null;
                const swipeContentChanged = nSwipes !== null && sid !== null
                    && swipeSlotText(nSwipes[sid]) !== swipeSlotText(pSwipes?.[sid]);
                if (nm.mes !== pm.mes || swipeContentChanged) {
                    this.emitTh('message_edited', [i]);
                    this.emitTh('message_updated', [i]);
                    dirty = true;
                }
            }
        }
        if (dirty) {
            const chatId = this.deps.chatName ? `${this.deps.chatName}.jsonl` : null;
            this.emitTh('chat_changed', [chatId]);
            this.deps.push('chat.updated', {});
        }
    }

    // ── 信箱泵(th.getEventLog since 分页;origin 去重)─────────────────────

    private async pollEventLog(): Promise<void> {
        if (this.dead || this.eventLogDead) return;
        try {
            const res = ((await this.deps.thCall('getEventLog', { since: this.lastEventSeq })) ?? {}) as LooseThResult;
            if (res.unsupported) { this.eventLogDead = true; return; }
            const result = res.result as
                | { seq?: number; entries?: ThEventLogEntry[] }
                | undefined;
            if (!result) return;
            if (typeof result.seq === 'number') this.lastEventSeq = Math.max(this.lastEventSeq, result.seq);
            for (const e of result.entries ?? []) {
                if (e?.origin && e.origin === this.hostId) continue;
                if (typeof e?.event === 'string' && e.event) {
                    const args = Array.isArray(e.args) ? e.args : [];
                    this.deps.onThEvent?.(e.event, args);
                    this.emitTh(e.event, args);
                }
            }
        } catch { /* 信箱面缺席/抖动不致命 —— 下轮泵再试 */ }
    }

    // ── 生命周期 ──────────────────────────────────────────────────────────

    /** 初次快照 —— bridge 就位后调一次,建立 diff 基线(不回放历史)。 */
    async seed(): Promise<void> {
        if (this.dead || !this.deps.chatName) return;
        try {
            const doc = await this.deps.fetchChat();
            this.chatMessages = Array.isArray(doc?.messages) ? doc!.messages! : null;
        } catch (e) {
            this.deps.log?.(`seed failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    /** 一轮泵:chat diff → 楼层事件 + chat.updated;随后信箱拉新。 */
    async tick(): Promise<void> {
        if (this.dead) return;
        if (this.deps.chatName) {
            try {
                const doc = await this.deps.fetchChat();
                const next = Array.isArray(doc?.messages) ? doc!.messages! : null;
                this.diffAndEmitChat(this.chatMessages, next);
                this.chatMessages = next;
            } catch (e) {
                this.deps.log?.(`tick fetchChat failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        await this.pollEventLog();
    }

    dispose(): void {
        this.dead = true;
    }
}
