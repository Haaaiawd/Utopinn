/**
 * Host-side T0 dispatcher: translates `th.*` bridge method calls into
 * api-client calls, implementing TavernHelper-compatible semantics.
 * Runs on the RN host / web iframe parent — never inside the sandbox.
 *
 * Scope mapping (see card-runtime-ecosystem.md §1C):
 *   chat   → chat_metadata.variables            (travels with the chat file)
 *   global → settings.th_global_variables       (user-level, all cards)
 *   message→ chat.body[i].data                  (per-floor, swipe-aware reads)
 *   script → chat_state ns `thvars.<script_id>` (per-script sidecar)
 */

import type { JsonPatchOp, UtopinnClient } from './index.js';
import type {
    PanelMethodTHT0,
    ThChatMessageView,
    ThGetChatMessagesArgs,
    ThGetVariablesArgs,
    ThInjectedPrompt,
    ThVariableScope,
} from '@utopinn/protocol';

export interface PanelT0Deps {
    client: UtopinnClient;
    /** chat identity: avatar filename + chat file (no .jsonl). */
    avatarUrl: string;
    chatFileName: string;
    /** floor id this mount presents as (same-floor shell = 0). */
    mountMessageId?: number;
    /** globals already resolvable for waitGlobalInitialized (from bootstrap). */
    initializedGlobals?: ReadonlySet<string>;
    /** host pushes go through this — the handler emits `{name,args}` for th.eventEmit. */
    emitToPanels?: (event: string, args: unknown[]) => void | Promise<void>;
    /** character card data for th.getCharacter (host supplies; lazy). */
    getCharacterCard?: () => Promise<Record<string, unknown>>;
    /** diagnostics sink: shadow-write results (fire-and-forget 也能看见错)。 */
    debug?: (rec: unknown) => void;
}

const NS_INJECT = 'th.inject';
const NS_SCRIPT_VARS = (scriptId: string) => `thvars.${scriptId}`;
const SETTINGS_GLOBAL_VARS = 'th_global_variables';

const esc = (seg: string) => seg.replace(/~/g, '~0').replace(/\//g, '~1');
const pathOf = (segments: string[]) => '/' + segments.map(esc).join('/');

const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
const BAD_KEY = (k: string) => k === '__proto__' || k === 'constructor' || k === 'prototype';
/** TH mergeWith:plain-object 深合;数组/标量/异型整体替换(数组非逐位合)。 */
function mergeDeep(dst: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
    for (const [k, v] of Object.entries(src)) {
        if (BAD_KEY(k)) continue;
        if (isObj(dst[k]) && isObj(v)) mergeDeep(dst[k]!, v);
        else dst[k] = v;
    }
    return dst;
}
/** TH insertVariables:defaultsDeep——只补缺失键,不动既有值。 */
function defaultsDeep(dst: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
    for (const [k, v] of Object.entries(src)) {
        if (BAD_KEY(k)) continue;
        if (dst[k] === undefined) dst[k] = v;
        else if (isObj(dst[k]) && isObj(v)) defaultsDeep(dst[k]!, v);
    }
    return dst;
}

export function createPanelT0Handler(deps: PanelT0Deps) {
    const { client } = deps;
    /** event → listener-ids the card registered (host push filter + clear ops).
     * '*' = legacy name-level subscription (shim didn't send a listener_id). */
    const subscribed = new Map<string, Set<string>>();
    let lidSeq = 0;

    const subscribe = (event: string, lid?: string) => {
        let set = subscribed.get(event);
        if (!set) { set = new Set(); subscribed.set(event, set); }
        set.add(lid ?? '*');
        return lid ?? `h-${++lidSeq}`;
    };
    const unsubscribeLid = (lid: string): number => {
        let removed = 0;
        for (const [ev, set] of subscribed) {
            if (set.delete(lid)) removed++;
            if (!set.size) subscribed.delete(ev);
        }
        return removed;
    };

    /** Fire-and-forget shadow write: the server keeps the th.events registry /
     * mailbox in chat_state — host filter is the delivery truth, the shadow is
     * for introspection + cross-mount semantics. Never gates the card call. */
    const shadow = (method: string, args: Record<string, unknown>): void => {
        const charDir = deps.avatarUrl.replace(/\.png$/i, '');
        const chatName = deps.chatFileName.replace(/\.jsonl$/i, '') || undefined;
        Promise.resolve(client.th.call(method, { target: { charDir, chatName }, args }))
            .then((res) => deps.debug?.({ shadow: method, ok: res?.ok !== false }))
            .catch((e) => deps.debug?.({ shadow: method, error: String(e?.message ?? e) }));
    };

    async function chatBody(): Promise<Record<string, unknown>[]> {
        const res = await client.getChat(deps.avatarUrl, deps.chatFileName);
        if (Array.isArray(res?.body)) return res.body;
        // legacy array form: [header, ...messages]
        const arr = res as unknown as Record<string, unknown>[];
        return Array.isArray(arr) ? arr.slice(1) : [];
    }

    async function chatVariables(): Promise<Record<string, unknown>> {
        const res = await client.getChat(deps.avatarUrl, deps.chatFileName);
        // res 两形:{header,body} | legacy 数组 [header, ...messages](同 chatBody 口径)
        const meta = res?.header?.chat_metadata
            ?? (Array.isArray(res) ? (res[0] as Record<string, unknown> | undefined)?.chat_metadata : undefined);
        return ((meta as Record<string, unknown> | undefined)?.variables as Record<string, unknown>) ?? {};
    }

    async function readScope(args: ThGetVariablesArgs): Promise<Record<string, unknown>> {
        const scope = args.type ?? 'chat';
        switch (scope) {
            case 'chat':
                return chatVariables();
            case 'global': {
                const s = await client.settingsGet();
                return (s[SETTINGS_GLOBAL_VARS] as Record<string, unknown>) ?? {};
            }
            case 'message': {
                const body = await chatBody();
                const idx = resolveMessageIndex(args.message_id, body.length);
                return (body[idx]?.data as Record<string, unknown>) ?? {};
            }
            case 'script': {
                if (!args.script_id) throw new Error('script scope requires script_id');
                const state = await client.stateGet<Record<string, unknown>>(
                    deps.avatarUrl, deps.chatFileName, NS_SCRIPT_VARS(args.script_id));
                return state ?? {};
            }
        }
    }

    async function writeScope(
        args: ThGetVariablesArgs & { variables: Record<string, unknown> },
        mode: 'replace' | 'merge' | 'insert-missing',
    ): Promise<void> {
        const scope = args.type ?? 'chat';
        const current = mode === 'replace' ? {} : await readScope(args);
        const next = mode === 'replace'
            ? args.variables
            : mode === 'merge'
                ? mergeDeep(current, args.variables)            // TH mergeWith 深合
                : defaultsDeep(current, args.variables);        // insert-missing: existing wins(深)
        const ops: JsonPatchOp[] = [{ op: 'replace', path: '', value: next }];

        switch (scope) {
            case 'chat':
                await client.patchChatMetadata(deps.avatarUrl, deps.chatFileName,
                    [{ op: 'replace', path: '/variables', value: next }]);
                return;
            case 'global':
                await client.settingsPatch(
                    [{ op: 'replace', path: `/${esc(SETTINGS_GLOBAL_VARS)}`, value: next }]);
                return;
            case 'message': {
                const body = await chatBody();
                const idx = resolveMessageIndex(args.message_id, body.length);
                await client.patchChat(deps.avatarUrl, deps.chatFileName,
                    [{ op: 'replace', path: `/body/${idx}/data`, value: next }]);
                return;
            }
            case 'script': {
                if (!args.script_id) throw new Error('script scope requires script_id');
                await client.statePatch(deps.avatarUrl, deps.chatFileName,
                    NS_SCRIPT_VARS(args.script_id), ops);
                return;
            }
        }
    }

    async function readInjected(): Promise<ThInjectedPrompt[]> {
        const state = await client.stateGet<{ prompts?: ThInjectedPrompt[] }>(
            deps.avatarUrl, deps.chatFileName, NS_INJECT).catch(() => null);
        return state?.prompts ?? [];
    }

    async function handle(method: PanelMethodTHT0, args: Record<string, unknown> = {}): Promise<unknown> {
        switch (method) {
            // ── variables ──────────────────────────────────────────────
            case 'th.getVariables':
                return readScope(args as ThGetVariablesArgs);
            case 'th.replaceVariables': {
                // GH#4 护栏:TH 语义是全量替换,但静默丢根是真事故——丢根且
                // 未 force:true → 拒绝(明细含丢根名单);server /th/call 同款。
                const a = args as ThGetVariablesArgs & { variables?: Record<string, unknown>; force?: boolean };
                if (!isObj(a.variables)) throw new Error('args.variables must be an object');
                const current = await readScope(a);
                const lostRoots = Object.keys(current).filter(k => !(k in a.variables!));
                let lostStat: string[] = [];
                const curSd = current.stat_data, nxtSd = a.variables.stat_data;
                if (isObj(curSd) && isObj(nxtSd)) lostStat = Object.keys(curSd).filter(k => !(k in nxtSd));
                if ((lostRoots.length || lostStat.length) && a.force !== true) {
                    throw new Error(
                        `replaceVariables root_loss: lost_roots=[${lostRoots.join(',')}]`
                        + ` lost_stat_data_roots=[${lostStat.join(',')}]`
                        + ' — 全量覆盖是预期行为则传 force:true;否则改用 insertOrAssignVariables/updateVariablesWith');
                }
                await writeScope(a as never, 'replace');
                return null;
            }
            case 'th.insertOrAssignVariables':
                await writeScope(args as unknown as ThGetVariablesArgs & { variables: Record<string, unknown> }, 'merge');
                return null;
            case 'th.insertVariables':
                await writeScope(args as unknown as ThGetVariablesArgs & { variables: Record<string, unknown> }, 'insert-missing');
                return null;
            case 'th.updateVariablesWith': {
                const a = args as ThGetVariablesArgs & { result?: Record<string, unknown> };
                if (!a.result) throw new Error('updateVariablesWith expects shim-evaluated `result`');
                await writeScope({ ...a, variables: a.result }, 'replace');
                return null;
            }
            case 'th.deleteVariable': {
                const a = args as unknown as ThGetVariablesArgs & { path: string };
                const scope = a.type ?? 'chat';
                const store = await readScope(a);
                deletePath(store, a.path);
                await writeScope({ ...a, variables: store }, 'replace');
                void scope;
                return null;
            }

            // ── messages ───────────────────────────────────────────────
            case 'th.getChatMessages': {
                const a = args as unknown as ThGetChatMessagesArgs;
                const body = await chatBody();
                const [lo, hi] = parseRange(a.range, body.length - 1);
                const out: ThChatMessageView[] = [];
                for (let i = lo; i <= hi && i < body.length; i++) {
                    const v = toThView(body[i]!, i, a);
                    if (v) out.push(v);
                }
                return out;
            }
            case 'th.getLastMessageId': {
                const body = await chatBody();
                return body.length - 1;
            }
            case 'th.getCurrentMessageId':
                return deps.mountMessageId ?? 0;

            // ── injected prompts (consumed by the generation pipeline; should_scan → WI scan buffer) ──
            case 'th.injectPrompts': {
                const a = args as { prompts?: ThInjectedPrompt[] };
                const list = await readInjected();
                const incoming = a.prompts ?? [];
                const byId = new Map(list.map(p => [p.id, p]));
                for (const p of incoming) byId.set(p.id, p);
                await client.statePatch(deps.avatarUrl, deps.chatFileName, NS_INJECT,
                    [{ op: 'replace', path: '', value: { prompts: [...byId.values()] } }]);
                return { injected: incoming.map(p => p.id) };
            }
            case 'th.uninjectPrompts': {
                const a = args as { ids?: string[] };
                const keep = (await readInjected()).filter(p => !(a.ids ?? []).includes(p.id));
                await client.statePatch(deps.avatarUrl, deps.chatFileName, NS_INJECT,
                    [{ op: 'replace', path: '', value: { prompts: keep } }]);
                return { remaining: keep.map(p => p.id) };
            }

            // ── events (registry lives in the shim; host tracks subscriptions for
            //    push filtering + forwards the shadow write to the server) ──
            case 'th.eventOn':
            case 'th.eventOnce': {
                const a = args as { event?: string; listener_id?: string };
                if (!a.event) return { subscribed: null };
                const lid = subscribe(a.event, a.listener_id);
                shadow(method.slice(3), { event: a.event, listener_id: lid });
                return { subscribed: a.event, listener_id: lid };
            }
            case 'th.eventMakeLast':
            case 'th.eventMakeFirst': {
                const a = args as { event?: string; listener_id?: string };
                // 顺序不影响 push 过滤(事件名级)——只转影子重排。
                if (a.event || a.listener_id) shadow(method.slice(3), { event: a.event, listener_id: a.listener_id });
                return { moved: null };
            }
            case 'th.eventRemoveListener': {
                const a = args as { event?: string; listener_id?: string };
                let removed = 0;
                if (a.listener_id) removed = unsubscribeLid(a.listener_id);
                else if (a.event && subscribed.delete(a.event)) removed = 1;
                shadow('eventRemoveListener', { event: a.event, listener_id: a.listener_id });
                return { removed };
            }
            case 'th.eventClearEvent': {
                const a = args as { event?: string };
                // 只清本 mount 的影子条目 —— 带上已知 lids,别动其它 mount 的注册。
                const lids = a.event ? [...(subscribed.get(a.event) ?? [])] : [];
                if (a.event) subscribed.delete(a.event);
                shadow('eventClearEvent', { event: a.event, listener_ids: lids });
                return { cleared: a.event ?? null };
            }
            case 'th.eventClearListener': {
                const a = args as { listener_id?: string; listener_ids?: string[] };
                const ids = Array.isArray(a.listener_ids) ? a.listener_ids : (a.listener_id ? [a.listener_id] : []);
                let removed = 0;
                for (const id of ids) removed += unsubscribeLid(String(id));
                shadow('eventClearListener', { listener_ids: ids });
                return { removed };
            }
            case 'th.eventClearAll': {
                const lids = [...subscribed.values()].flatMap((s) => [...s]);
                subscribed.clear();
                shadow('eventClearAll', { listener_ids: lids });
                return { removed: lids.length };
            }
            case 'th.eventEmit':
            case 'th.eventEmitAndWait': {
                const a = args as { event?: string; args?: unknown[] };
                if (a.event && deps.emitToPanels) await deps.emitToPanels(a.event, a.args ?? []);
                return null;
            }

            // ── globals / identity ─────────────────────────────────────
            case 'th.waitGlobalInitialized': {
                const a = args as { name?: string };
                return deps.initializedGlobals?.has(a.name ?? '') ?? false;
            }
            case 'th.initializeGlobal': {
                const a = args as { name?: string };
                return { initialized: false, name: a.name ?? null };
            }
            case 'th.getCharacter':
                return deps.getCharacterCard ? deps.getCharacterCard() : null;
            case 'th.getCurrentCharacterName':
                return deps.avatarUrl.replace(/\.png$/i, '');
        }
    }

    /** events this mount wants forwarded (host calls this to filter pushes). */
    handle.subscribedEvents = () => [...subscribed.keys()];
    return handle;
}

// ─── helpers ─────────────────────────────────────────────────────────────

function resolveMessageIndex(messageId: number | undefined, length: number): number {
    if (messageId === undefined) throw new Error('message scope requires message_id');
    const idx = messageId < 0 ? length + messageId : messageId;
    if (idx < 0 || idx >= length) throw new Error(`message_id ${messageId} out of range (len=${length})`);
    return idx;
}

/** TH range forms: 'first', 'first-last', 'last', '-count' (last N), 'all', '{{lastMessageId}}'. */
export function parseRange(range: string, lastId: number): [number, number] {
    const r = String(range ?? '').trim();
    if (lastId < 0) return [0, -1];
    if (r === 'all' || r === '{{lastMessageId}}' || r === '') return [0, lastId];
    if (r === 'last') return [lastId, lastId];
    const neg = /^-(\d+)$/.exec(r);
    if (neg) return [Math.max(0, lastId - Number(neg[1]) + 1), lastId];
    const span = /^(\d+)-(\d+)$/.exec(r);
    if (span) return [Number(span[1]), Math.min(Number(span[2]), lastId)];
    const single = /^(\d+)$/.exec(r);
    if (single) { const i = Math.min(Number(single[1]), lastId); return [i, i]; }
    return [0, lastId];
}

function toThView(m: Record<string, unknown>, id: number, a: ThGetChatMessagesArgs): ThChatMessageView | null {
    const role: ThChatMessageView['role'] = m.is_system ? 'system' : m.is_user ? 'user' : 'assistant';
    if (a.role && a.role !== 'all' && role !== a.role) return null;
    const hidden = Boolean(m.is_hidden);
    if (a.hide_state === 'hidden' && !hidden) return null;
    if (a.hide_state === 'unhidden' && hidden) return null;
    return {
        message_id: id,
        name: String(m.name ?? ''),
        role,
        is_hidden: hidden,
        message: String(m.mes ?? ''),
        data: (m.data as Record<string, unknown>) ?? {},
        extra: (m.extra as Record<string, unknown>) ?? undefined,
        swipes: a.include_swipes ? (m.swipes as string[] | undefined) : undefined,
        swipe_id: a.include_swipes ? (m.swipe_id as number | undefined) : undefined,
    };
}

function deletePath(store: Record<string, unknown>, dotPath: string): void {
    const segs = dotPath.split('.');
    let cur: Record<string, unknown> = store;
    for (let i = 0; i < segs.length - 1; i++) {
        const next = cur[segs[i]!];
        if (next === null || typeof next !== 'object') return;
        cur = next as Record<string, unknown>;
    }
    delete cur[segs[segs.length - 1]!];
}
