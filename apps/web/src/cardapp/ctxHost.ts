// ctxHost — web 宿主的 ctx 面 + 复合 dispatch(TASK-046,镜像
// apps/cli/cardapp-host.mjs 的 ctxDispatch/runCardGeneration 语义)。
//
// 结构:
//   dispatch(method,args)
//     th.*  → T0 表 → createPanelT0Handler(client) 本地求值
//             其余  → POST /api/utopinn/th/call 透传(服务端 T1+)
//     ctx.* → 本文件 ctxDispatch 表 —— chat/变量/状态/生成/斜杠/WI/prompts
//
// 事件泵:宿主没有 ST 事件总线可挂 —— pollChat() 对 chat doc 做快照 diff,
// 命中的楼层级事件经 push() 注回 iframe('host.event' {name,args}),只发
// 卡订阅过的(ctx.on / th.eventOn 记账)。生成请求首尾泵
// generation_started/ended——卡片「发一个请求拿到结果」的最小闭环。
import {
    createPanelT0Handler,
    UtopinnClient,
    type JsonPatchOp,
} from '@utopinn/api-client';
import { PANEL_METHODS_TH_T0, PANEL_SURFACE_UNAVAILABLE } from '@utopinn/protocol';

export interface CtxHostOpts {
    charDir: string;
    chatName?: string;
    /** 宿主 → iframe push 投递(CardAppFrame 接 PanelBridge.push)。 */
    push: (event: 'host.event' | 'th.event' | 'chat.updated', payload: Record<string, unknown>) => void;
    /** 信箱事件宿主旁路(不过卡订阅面)——MessageIframe 用 refresh_message 自刷。 */
    onThEvent?: (name: string, args: unknown[]) => void;
    /** 卡「表面可见性」语义(wire ctx.surfaceOpen/surfaceClose ← ctx.openOverlay/closeOverlay):
     *  open → 展开承载本帧的工作台板块(panelType 随挂载形态:'cardapp'/'messageframe'),
     *  close → 收叠面板组。接线方=挂载组件 { panelType, openPanel:s.openPanel,
     *  collapsePanels:s.collapsePanels }(collapsePanels 由 web 格 kernel context 实现,
     *  名字已锁定)。未接 → 如实 PANEL_SURFACE_UNAVAILABLE 降级,不假装成了。 */
    surface?: {
        panelType?: string;
        openPanel?: (type?: string, params?: unknown) => void;
        collapsePanels?: () => void;
    };
    /** 诊断/日志行(默认 console)。 */
    log?: (msg: string) => void;
    /** 轮询/生成等待预算(ms)。 */
    generationWaitMs?: number;
    /** 发消息用的用户名(默认 User)。 */
    userName?: string;
}

interface ChatDoc {
    header?: { chat_metadata?: Record<string, unknown> } & Record<string, unknown>;
    messages?: Record<string, unknown>[];
    integrity?: string;
    [k: string]: unknown;
}

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** th/call 响应是判别联合 —— dispatch 层只需要宽松访问。 */
interface LooseThResult {
    ok?: boolean;
    unsupported?: boolean;
    result?: unknown;
    error?: string;
    method?: string;
}
const loose = (r: unknown): LooseThResult => (r ?? {}) as LooseThResult;
const jsonClone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

export class CardAppHost {
    private readonly charDir: string;
    private readonly chatName?: string;
    private readonly avatarUrl: string;
    private readonly chatFileName?: string;
    private readonly pushEvent: CtxHostOpts['push'];
    private readonly onThEvent?: CtxHostOpts['onThEvent'];
    private readonly surface?: CtxHostOpts['surface'];
    private readonly log: (msg: string) => void;
    private readonly generationWaitMs: number;
    private readonly userName: string;
    /** mailbox origin 标:本 mount 写出的条目,自己的泵跳过防回流双发。 */
    private readonly hostId = `h-${Math.random().toString(36).slice(2, 10)}`;
    private lastEventSeq = 0;
    private eventLogUnsupported = false;

    /** seed() 完成前 poll 一律 no-op —— 信箱游标未钉头就跑 pollEventLog
     *  会回放滞留历史(refresh 重铸环);diff 基线此刻也没立。
     *  无论 seed 钉头成败都置位:「拉不到留 0 有界回放」的兜底语义不动。 */
    private seeded = false;
    private client: UtopinnClient;
    private chatDoc: ChatDoc | null = null;
    private varCache: Record<string, unknown> = {};
    private ctxSubscribed = new Set<string>();
    private panelT0: ReturnType<typeof createPanelT0Handler> & { subscribedEvents?: () => string[] };
    private dead = false;

    constructor(opts: CtxHostOpts, client?: UtopinnClient) {
        this.charDir = opts.charDir;
        this.chatName = opts.chatName;
        this.avatarUrl = `${opts.charDir}.png`;
        this.chatFileName = opts.chatName ? `${opts.chatName}.jsonl` : undefined;
        this.pushEvent = opts.push;
        this.onThEvent = opts.onThEvent;
        this.surface = opts.surface;
        this.log = opts.log ?? ((m) => console.warn('[cardapp-host]', m));
        this.generationWaitMs = opts.generationWaitMs ?? 120_000;
        this.userName = opts.userName ?? 'User';
        this.client = client ?? new UtopinnClient({ baseUrl: window.location.origin });
        this.panelT0 = createPanelT0Handler({
            client: this.client,
            avatarUrl: this.avatarUrl,
            chatFileName: this.chatFileName ?? '',
            mountMessageId: 0,
            // 卡 eventEmit → server 信箱(跨 mount 扇出;本卡 shim 已 dispatchLocal,
            // 回推自己 bridge 会双发 —— 旧实现的 bug,信箱化后顺带修了)。
            emitToPanels: async (ev: string, args: unknown[]) => { await this.recordThEvent(ev, args); },
            debug: (rec) => this.log(`shadow ${JSON.stringify(rec)}`),
            getCharacterCard: async () => {
                const res = loose(await this.client.th.call('getCharacter', { target: { charDir: this.charDir } }));
                return res?.result as Record<string, unknown>;
            },
        }) as CardAppHost['panelT0'];
    }

    // ── 快照面 ─────────────────────────────────────────────────────────────
    private messages(): Record<string, unknown>[] {
        return Array.isArray(this.chatDoc?.messages) ? this.chatDoc!.messages! : [];
    }

    private async syncChat(): Promise<{ prev: ChatDoc | null; next: ChatDoc | null } | null> {
        if (!this.chatName) return null;
        try {
            const doc = await this.client.library.chatGet(this.charDir, this.chatName);
            if (doc && 'corrupted' in doc && doc.corrupted) return null;
            const prev = this.chatDoc;
            this.chatDoc = doc as unknown as ChatDoc;
            this.varCache = (this.chatDoc?.header?.chat_metadata?.variables as Record<string, unknown>) ?? {};
            return { prev, next: doc as unknown as ChatDoc };
        } catch (e) {
            this.log(`syncChat failed: ${e instanceof Error ? e.message : e}`);
            return null;
        }
    }

    /**
     * 事件泵:楼层 diff → 命中的楼层事件推给卡(仅订阅项)。
     *   追加      → rendered + message_sent/message_received
     *   缩短      → message_deleted
     *   同长字段差 → mes/活动 swipe 变 → message_edited+message_updated;
     *               swipe_id 变 → message_swiped
     *   任何差    → chat_changed(tavern_events.CHAT_CHANGED,楼层 diff 的兜底信号)
     */
    private diffAndEmitChat(prev: ChatDoc | null, next: ChatDoc | null): void {
        if (!next) return;
        const pa = Array.isArray(prev?.messages) ? prev!.messages! : [];
        const na = Array.isArray(next?.messages) ? next!.messages! : [];
        let dirty = false;
        if (na.length > pa.length) {
            for (let i = pa.length; i < na.length; i++) {
                const m = na[i] as { is_user?: boolean };
                const rendered = m?.is_user ? 'user_message_rendered' : 'char_message_rendered';
                this.emitCtx(rendered, [i]);
                this.emitTh(rendered, [i]);
                this.emitTh(m?.is_user ? 'message_sent' : 'message_received', [i]);
            }
            dirty = true;
        } else if (na.length < pa.length) {
            this.emitCtx('message_deleted', []);
            this.emitTh('message_deleted', []);
            dirty = true;
        } else {
            for (let i = 0; i < na.length; i++) {
                const pm = pa[i] as { mes?: unknown; swipe_id?: number; swipes?: unknown[] } | undefined;
                const nm = na[i] as { mes?: unknown; swipe_id?: number; swipes?: unknown[] } | undefined;
                if (!pm || !nm) continue;
                if (nm.swipe_id !== pm.swipe_id) {
                    this.emitTh('message_swiped', [i]);
                    this.emitCtx('message_swiped', [i]);
                    dirty = true;
                }
                const swipeContentChanged = Array.isArray(nm.swipes) && Number.isInteger(nm.swipe_id)
                    && nm.swipes[nm.swipe_id as number] !== (Array.isArray(pm.swipes) ? (pm.swipes as unknown[])[nm.swipe_id as number] : undefined);
                if (nm.mes !== pm.mes || swipeContentChanged) {
                    this.emitTh('message_edited', [i]);
                    this.emitTh('message_updated', [i]);
                    this.emitCtx('message_edited', [i]);
                    dirty = true;
                }
            }
        }
        if (dirty) {
            const chatId = this.chatFileName ?? this.chatName ?? null;
            this.emitTh('chat_changed', [chatId]);
            this.emitCtx('chat_changed', [chatId]);
            this.pushEvent('chat.updated', {});
        }
    }

    private emitCtx(name: string, args: unknown[]): void {
        if (!this.ctxSubscribed.has(name)) return;
        this.pushEvent('host.event', { name, args: jsonClone(args) ?? [] });
    }

    private emitTh(name: string, args: unknown[]): void {
        const want = this.panelT0?.subscribedEvents?.() ?? [];
        if (!want.includes(name)) return;
        this.pushEvent('th.event', { name, args: jsonClone(args) ?? [] });
    }

    /** 信箱写:本 mount 发起、且 chat doc diff 不可推导的事件(生成生命周期、
     *  卡 eventEmit)——同聊其它 mount 的泵读到后推给它们的订阅卡。 */
    private recordThEvent(name: string, args: unknown[] = []): Promise<void> {
        return this.client.th.call('eventEmit', {
            target: { charDir: this.charDir, chatName: this.chatName },
            args: { event: name, args: jsonClone(args) ?? [], origin: this.hostId },
        }).then(() => undefined).catch(() => { });
    }

    /** 信箱泵:拉 seq>lastEventSeq 的新条目,跳过本 mount 产出的(origin 去重)。 */
    private async pollEventLog(): Promise<void> {
        if (this.dead || this.eventLogUnsupported) return;
        try {
            const res = loose(await this.client.th.call('getEventLog', {
                target: { charDir: this.charDir, chatName: this.chatName },
                args: { since: this.lastEventSeq },
            }));
            if (res?.unsupported) { this.eventLogUnsupported = true; return; }
            const result = res?.result as
                | { seq?: number; entries?: { seq?: number; event?: string; args?: unknown[]; origin?: string }[] }
                | undefined;
            if (!result) return;
            if (typeof result.seq === 'number') this.lastEventSeq = Math.max(this.lastEventSeq, result.seq);
            for (const e of result.entries ?? []) {
                if (e?.origin && e.origin === this.hostId) continue;
                if (typeof e?.event === 'string' && e.event) {
                    this.onThEvent?.(e.event, Array.isArray(e.args) ? e.args : []);
                    this.emitTh(e.event, Array.isArray(e.args) ? e.args : []);
                }
            }
        } catch { /* 信箱面缺席/抖动不致命 — 下轮泵再试 */ }
    }

    /** 轮询入口(CardAppFrame 按 interval 调):diff → 事件 + chat.updated + 信箱。
     *  seed 未竟的拍整轮跳过 —— 游标钉头是顺序前置,不是可选优化。 */
    async pollChat(): Promise<void> {
        if (this.dead || !this.seeded) return;
        const r = await this.syncChat();
        if (r) this.diffAndEmitChat(r.prev, r.next);
        await this.pollEventLog();
    }

    /**
     * 初次快照——bridge 就位后调一次,让 ctx.getChat/varCache 有真值,
     * diff 基线也在此建立(不回放历史楼层)。
     * 信箱游标同钉到当前头:帧重挂后新宿主若从 0 拉,滞留 refresh_message
     * 会被当新事件再走 onThEvent → 触发重铸 → 再 seed → 再回放,无限环
     * (mobile eventPump.seed 同修,见 apps/mobile/tests/eventPump.test.ts)。
     * since=MAX_SAFE_INTEGER 语义 = 只要头位不取条目(服务端 filter
     * seq>since → 空 entries + 回当前 seq);新事件 seq>头位,照常送达。
     * 头位拉取失败时游标留 0 —— 下轮 tick 至多回放一轮有界历史,可接受。
     */
    async seed(): Promise<void> {
        try {
            await this.syncChat();
            if (this.eventLogUnsupported) return;
            try {
                const res = loose(await this.client.th.call('getEventLog', {
                    target: { charDir: this.charDir, chatName: this.chatName },
                    args: { since: Number.MAX_SAFE_INTEGER },
                }));
                if (res?.unsupported) { this.eventLogUnsupported = true; return; }
                const seq = (res?.result as { seq?: number } | undefined)?.seq;
                if (typeof seq === 'number') this.lastEventSeq = seq;
            } catch { /* 头位拉不到 → 下轮回放有界历史,可接受 */ }
        } finally {
            // gate 挡「seed 未竟时 poll 抢跑回放滞留信箱」;钉头失败也放行,
            // 有界历史回放兜底交给 pollEventLog 自己消化。
            this.seeded = true;
        }
    }

    // ── 生成面(ctx.sendMessage 非 silent + ctx.generate + lukerContext.generate)
    private async runCardGeneration(params: { type?: string; quietPrompt?: string } = {}): Promise<{ jobId: string | null; status: Record<string, unknown> | null }> {
        const type = params.type ?? 'normal';
        this.emitCtx('generation_started', [type]);
        this.emitTh('generation_started', [type]);
        this.recordThEvent('generation_started', [type]);
        const jobId = globalThis.crypto?.randomUUID?.() ?? `job-${Date.now()}`;
        const body: Record<string, unknown> = {
            charDir: this.charDir,
            chatName: this.chatName,
            type,
            stream: false,
            user: { name: this.userName },
            luker_generation: {
                job_id: jobId,
                persist_target: (type === 'normal' || type === 'regenerate')
                    ? { kind: 'character', avatar_url: this.avatarUrl, file_name: this.chatFileName, char_name: this.charDir }
                    : { kind: 'none' },
            },
        };
        if (params.quietPrompt) body.overrides = { quietPrompt: params.quietPrompt };
        try {
            await this.client.generation.generate(body as never, { timeout: 60_000 });
        } catch (e) {
            this.emitCtx('generation_ended', []);
            this.emitTh('generation_ended', []);
            this.recordThEvent('generation_ended');
            throw e;
        }
        const deadline = Date.now() + this.generationWaitMs;
        let status: Record<string, unknown> | null = null;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 800));
            try {
                const j = await this.client.generation.jobGet(jobId) as unknown as Record<string, unknown> | null;
                if (j?.persisted || ['completed', 'failed', 'cancelled', 'awaiting_ack'].includes(String(j?.status))) { status = j; break; }
            } catch { /* poll errors retry until deadline */ }
        }
        await this.syncChat();
        const ok = status?.status === 'completed' || status?.status === 'awaiting_ack' || status?.persisted;
        this.emitCtx(ok ? 'generation_ended' : 'generation_stopped', []);
        this.emitTh(ok ? 'generation_ended' : 'generation_stopped', []);
        this.recordThEvent(ok ? 'generation_ended' : 'generation_stopped');
        return { jobId, status };
    }

    // ── ctxDispatch(与 cardapp-host.mjs 同语义)───────────────────────────
    private async setExtensionPrompt(key: string, value: string, position: unknown, depth: unknown, scan: unknown, role: unknown): Promise<void> {
        const escKey = esc(String(key));
        const settings = await this.client.settingsGet().catch(() => null) as Record<string, unknown> | null;
        const ops: JsonPatchOp[] = [];
        if (!settings || typeof settings !== 'object' || settings.extension_prompts === undefined) {
            ops.push({ op: 'add', path: '/extension_prompts', value: {} });
        }
        ops.push({
            op: 'add', path: `/extension_prompts/${escKey}`,
            value: { value: String(value ?? ''), position: position ?? -1, depth, scan: !!scan, role },
        });
        await this.client.settingsPatch(ops);
    }

    private async getWorldBooks(options: { withSource?: boolean } = {}): Promise<unknown> {
        const out: { name: string; source: string }[] = [];
        const seen = new Set<string>();
        const push = (name: unknown, source: string) => {
            const n = String(name ?? '').trim();
            if (n && !seen.has(n)) { seen.add(n); out.push({ name: n, source }); }
        };
        const chatMeta = (this.chatDoc?.header?.chat_metadata ?? {}) as Record<string, unknown>;
        const chatBound = Array.isArray(chatMeta.world_info) ? chatMeta.world_info : (chatMeta.world_info ? [chatMeta.world_info] : []);
        for (const n of chatBound) push(n, 'chat');
        try {
            const settings = await this.client.library.settings().catch(() => null) as Record<string, any> | null;
            const wis = settings?.world_info_settings?.world_info ?? settings?.settings?.world_info_settings?.world_info;
            for (const n of wis?.globalSelect ?? []) push(n, 'global');
            for (const lore of wis?.charLore ?? []) {
                if (lore?.name === this.charDir) for (const n of lore.extraBooks ?? []) push(n, 'character_aux');
            }
            const personaBook = settings?.power_user?.persona_description_lorebook ?? settings?.settings?.power_user?.persona_description_lorebook;
            if (personaBook) push(personaBook, 'persona');
        } catch { }
        try {
            const charDoc = await this.client.library.char(this.charDir).catch(() => null) as Record<string, any> | null;
            const world = (charDoc?.card ?? charDoc)?.data?.extensions?.world;
            if (world) push(world, 'character');
        } catch { }
        return options.withSource ? out : out.map((b) => b.name);
    }

    private async getWorldBookEntries(name: string): Promise<unknown> {
        try { return await this.client.library.worldGet(String(name)); }
        catch { return null; }
    }

    private async ctxDispatch(sub: string, args: Record<string, unknown>): Promise<unknown> {
        switch (sub) {
            case 'getChat':
                await this.syncChat();
                return { messages: this.messages(), header: this.chatDoc?.header ?? null };

            case 'sendMessage': {
                const text = String(args?.text ?? args?.mes ?? '');
                const options = (args?.options ?? {}) as { silent?: boolean };
                if (options.silent) {
                    const r = await this.runCardGeneration({ type: 'quiet', quietPrompt: text });
                    return { ok: true, text: (r?.status?.text ?? r?.status?.result ?? null) as string | null };
                }
                const prev = this.chatDoc;
                await this.client.library.appendMessages(this.charDir, this.chatName!, [{
                    name: this.userName, is_user: true, is_system: false,
                    send_date: new Date().toISOString(), mes: text,
                }]);
                this.emitTh('message_sent', []);
                this.emitCtx('message_sent', []);
                const r = await this.runCardGeneration({ type: 'normal' });
                const synced = await this.syncChat();
                this.diffAndEmitChat(prev, synced?.next ?? this.chatDoc);
                return { ok: true, jobId: r?.jobId ?? null, text: (r?.status?.text ?? null) as string | null };
            }

            case 'generate':
                return this.runCardGeneration({ type: String(args?.type ?? 'normal'), quietPrompt: args?.quietPrompt ? String(args.quietPrompt) : undefined });
            case 'regenerate':
                return this.runCardGeneration({ type: 'regenerate' });
            case 'swipe':
                return this.runCardGeneration({ type: 'swipe' });

            case 'editMessage': {
                const i = Number(args?.messageId);
                const msg = this.messages()[i] as { swipes?: unknown[]; swipe_id?: number } | undefined;
                if (!msg) return { ok: true, edited: false };
                const text = String(args?.text ?? '');
                const ops: JsonPatchOp[] = [{ op: 'replace', path: `/body/${i}/mes`, value: text }];
                const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
                const swipeId = Number.isInteger(msg.swipe_id) ? msg.swipe_id! : null;
                if (swipes && swipeId != null && swipeId < swipes.length) {
                    ops.push({ op: 'replace', path: `/body/${i}/swipes/${swipeId}`, value: text });
                }
                await this.client.library.patchChat(this.charDir, this.chatName!, ops);
                await this.syncChat();
                this.emitCtx('message_edited', [i]);
                this.emitTh('message_edited', [i]);
                return { ok: true, edited: true };
            }

            case 'setVariable': {
                const key = String(args?.key ?? '');
                const v = jsonClone(args?.value);
                this.varCache[key] = v;
                const ops: JsonPatchOp[] = [
                    { op: 'add', path: `/header/chat_metadata/variables/${esc(key)}`, value: v },
                ];
                try {
                    await this.client.library.patchChat(this.charDir, this.chatName!, ops);
                } catch (e) {
                    // variables 父键缺席 → 先立 {} 再写(409 missing-parent 判别)
                    await this.client.library.patchChat(this.charDir, this.chatName!, [
                        { op: 'add', path: '/header/chat_metadata/variables', value: {} },
                    ]).catch(() => { });
                    await this.client.library.patchChat(this.charDir, this.chatName!, ops);
                }
                return args?.value;
            }

            case 'getChatState': {
                try {
                    const res = await this.client.state.chat.get(
                        { avatar_url: this.avatarUrl, file_name: this.chatFileName! }, String(args?.namespace ?? ''));
                    return { ok: true, state: (res as { data?: unknown })?.data ?? res ?? null };
                } catch (e) {
                    return { ok: false, state: null, reason: 'transport', hint: String(e instanceof Error ? e.message : e) };
                }
            }
            case 'updateChatState': {
                const ns = String(args?.namespace ?? '');
                const target = { avatar_url: this.avatarUrl, file_name: this.chatFileName! };
                try {
                    if (Array.isArray(args?.operations)) {
                        await this.client.state.chat.patch(target, ns, args!.operations as JsonPatchOp[]);
                        return { ok: true };
                    }
                    const v = jsonClone(args?.state ?? args?.value) ?? {};
                    await this.client.state.chat.patch(target, ns, [{ op: 'replace', path: '', value: v }]);
                    return { ok: true, state: v, updated: true };
                } catch (e) {
                    return { ok: false, reason: 'transport', hint: String(e instanceof Error ? e.message : e) };
                }
            }
            case 'deleteChatState': {
                try {
                    await this.client.state.chat.delete(
                        { avatar_url: this.avatarUrl, file_name: this.chatFileName! }, String(args?.namespace ?? ''));
                    return { ok: true };
                } catch (e) {
                    return { ok: false, reason: 'transport', hint: String(e instanceof Error ? e.message : e) };
                }
            }
            case 'getCharacterState': {
                const st = await this.client.state.char.get({ avatar_url: this.avatarUrl }, String(args?.namespace ?? '')).catch(() => null);
                return { ok: true, state: (st as { data?: unknown } | null)?.data ?? st ?? null };
            }
            case 'updateCharacterState': {
                const ns = String(args?.namespace ?? '');
                const cur = ((await this.client.state.char.get({ avatar_url: this.avatarUrl }, ns).catch(() => null)) as { data?: Record<string, unknown> } | null)?.data ?? {};
                const next = { ...cur, ...(jsonClone(args?.state ?? args?.value) as Record<string, unknown> ?? {}) };
                await this.client.state.char.set({ avatar_url: this.avatarUrl }, ns, next as Record<string, unknown>);
                return { ok: true, state: next };
            }

            case 'getCharacter': {
                const res = loose(await this.client.th.call('getCharacter', { target: { charDir: this.charDir } }));
                return res?.result;
            }
            case 'getWorldBooks':
                return this.getWorldBooks({ withSource: !!(args as { withSource?: boolean })?.withSource });
            case 'getWorldBook': {
                const name = args?.name ?? ((await this.getWorldBooks({})) as string[])[0];
                return name ? this.getWorldBookEntries(String(name)) : null;
            }
            case 'updateWorldBookEntry': {
                const name = args?.name ?? ((await this.getWorldBooks({})) as string[])[0];
                if (!name) return { ok: false, reason: 'no_book' };
                const doc = await this.getWorldBookEntries(String(name)) as { entries?: Record<string, Record<string, unknown>> } | null;
                if (!doc?.entries) return { ok: false, reason: 'no_book' };
                const uid = args?.uid ?? args?.entryId;
                const fields = (args?.fields ?? args?.data ?? {}) as Record<string, unknown>;
                const key = String(uid ?? Object.keys(doc.entries).length);
                doc.entries[key] = { ...(doc.entries[key] ?? {}), ...(fields as Record<string, unknown>) };
                await this.client.library.worldEdit(String(name), doc as { entries: Record<string, unknown> });
                return { ok: true };
            }

            case 'executeSlashCommand': {
                const res = loose(await this.client.th.call('triggerSlash', {
                    target: { charDir: this.charDir, chatName: this.chatName },
                    args: { script: String(args?.script ?? '') },
                }));
                if (res?.ok === false) throw new Error(res?.error ?? 'triggerSlash failed');
                return res?.result;
            }
            case 'setExtensionPrompt': {
                await this.setExtensionPrompt(
                    String(args?.key ?? ''), String(args?.value ?? ''),
                    args?.position, args?.depth, args?.scan, args?.role);
                return { ok: true };
            }
            case 'eventEmit': {
                // 卡→宿主扇出(worldinfo_force_activate 等):当前面没有服务端
                // 消费者 —— 收下并留痕,不伪装成功语义。
                this.log(`ctx.eventEmit ${String(args?.name)} (no host consumer)`);
                return { ok: true, delivered: 'log' };
            }

            case 'on': { this.ctxSubscribed.add(String(args?.event)); return null; }
            case 'off': { this.ctxSubscribed.delete(String(args?.event)); return null; }
            case 'setTimer': return null;
            case 'dispose': return null; // 真 dispose 由 CardAppFrame unmount 触发

            // ── 卡「表面可见性」面(openOverlay→openPanel(panelType),
            //    closeOverlay→collapsePanels)——接线方为挂载组件经 opts.surface;
            //    未接壳 → 如实降级,不假装成了 ────────────────────────────────
            case 'surfaceOpen': {
                const s = this.surface;
                if (typeof s?.openPanel !== 'function') {
                    this.log('ctx.surfaceOpen: 宿主未接 openPanel(surface 面缺席)→ degraded');
                    return { ok: false, reason: PANEL_SURFACE_UNAVAILABLE, surface: 'open' };
                }
                const panelType = s.panelType ?? 'cardapp';
                s.openPanel(panelType);
                return { ok: true, panel: panelType };
            }
            case 'surfaceClose': {
                const s = this.surface;
                if (typeof s?.collapsePanels !== 'function') {
                    this.log('ctx.surfaceClose: 宿主未接 collapsePanels(surface 面缺席)→ degraded');
                    return { ok: false, reason: PANEL_SURFACE_UNAVAILABLE, surface: 'close' };
                }
                s.collapsePanels();
                return { ok: true };
            }
            default: throw new Error(`unsupported_method: ctx.${sub}`);
        }
    }

    /** bridge dispatch 入口:th.* 复合 + ctx.* 表,其它一律 unsupported。 */
    async dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
        if (method.startsWith('th.')) {
            if ((PANEL_METHODS_TH_T0 as readonly string[]).includes(method)) {
                return await this.panelT0(method as never, args);
            }
            const res = loose(await this.client.th.call(method.slice(3), {
                target: { charDir: this.charDir, chatName: this.chatName },
                args: args ?? {},
            }));
            if (res?.unsupported) throw new Error(`unsupported_method: ${method.slice(3)}`);
            if (res?.ok === false) throw new Error(res?.error ?? `th_call_failed: ${method.slice(3)}`);
            return res?.result;
        }
        if (method.startsWith('ctx.')) {
            return await this.ctxDispatch(method.slice(4), args);
        }
        throw new Error(`unsupported_method: ${method}`);
    }

    dispose(): void {
        this.dead = true;
        this.ctxSubscribed.clear();
    }
}
