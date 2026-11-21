// CardApp / panel bridge protocol — postMessage contract between the host
// (RN WebView / web iframe) and sandboxed card code. Nonce + allowlist +
// request-id correlation per mount. See .loom/design/mobile-panels.md.

/** Methods a mounted CardApp may invoke through the bridge (Luker CardApp ctx face).
 * The second block (TASK-046) is the surface the web/RN ctx shim actually
 * crosses the wire for — everything else on the shim's ctx object
 * (container/eventSource/lukerContext/timers/…) is realm-local and never
 * touches the bridge. Semantics mirror apps/cli/cardapp-host.mjs ctxDispatch:
 *   ctx.setVariable      {key, value}            → chat_metadata.variables[key] = value (whole-key replace)
 *   ctx.editMessage      {messageId, text}       → /body/<i>/mes (+active swipe slot)
 *   ctx.executeSlashCommand {script}             → stscript triggerSlash semantics
 *   ctx.setExtensionPrompt {key,value,position,depth,scan,role} → settings.extension_prompts[key]
 *   ctx.generate         {type?, quietPrompt?}   → POST /api/utopinn/generate (aux/quiet path included)
 *   ctx.getWorldBooks    {withSource?}           → composite book list (chat/character/aux/global/persona)
 *   ctx.eventEmit        {name, args?}           → card → host event fan-out (worldinfo_force_activate 等)
 */
export const PANEL_METHODS = [
    'ctx.sendMessage',
    'ctx.swipe',
    'ctx.regenerate',
    'ctx.getChatState',
    'ctx.updateChatState',
    'ctx.getCharacterState',
    'ctx.updateCharacterState',
    'ctx.getWorldBook',
    'ctx.updateWorldBookEntry',
    'ctx.getCharacter',
    'ctx.getChat',
    'ctx.on',
    'ctx.off',
    'ctx.setTimer',
    'ctx.dispose',
    // ── TASK-046 ctx-face web 宿主补齐面 ──────────────────────────────────
    'ctx.setVariable',
    'ctx.editMessage',
    'ctx.executeSlashCommand',
    'ctx.setExtensionPrompt',
    'ctx.generate',
    'ctx.getWorldBooks',
    'ctx.eventEmit',
    'ctx.deleteChatState',
] as const;
export type PanelMethod = (typeof PANEL_METHODS)[number];

/**
 * TavernHelper-compatible face (JS-Slash-Runner API surface, re-implemented —
 * its PolyForm NC license forbids vendoring code). Cards without a `card_app`
 * declaration get these globals; they route over the same nonce bridge.
 * See .loom/capabilities/sandboxed-card-apps/research/tavern-helper-api-surface.md
 * and card-runtime-ecosystem.md §3 for the T0/T1/T2 tiering.
 */
export const PANEL_METHODS_TH = [
    // ── T0 ──────────────────────────────────────────────────────────────
    'th.getVariables',
    'th.replaceVariables',
    'th.insertOrAssignVariables',
    'th.insertVariables',
    'th.updateVariablesWith',
    'th.deleteVariable',
    'th.eventOn',
    'th.eventEmit',
    'th.eventEmitAndWait',
    'th.eventOnce',
    'th.eventRemoveListener',
    'th.eventMakeLast',
    'th.eventMakeFirst',
    'th.eventClearEvent',
    'th.eventClearListener',
    'th.eventClearAll',
    'th.getChatMessages',
    'th.getLastMessageId',
    'th.getCurrentMessageId',
    'th.injectPrompts',
    'th.uninjectPrompts',
    'th.waitGlobalInitialized',
    'th.initializeGlobal',
    'th.getCharacter',
    'th.getCurrentCharacterName',
    // ── T1 ──────────────────────────────────────────────────────────────
    'th.setChatMessages',
    'th.setChatMessage',
    'th.createChatMessages',
    'th.deleteChatMessages',
    'th.rotateChatMessages',
    'th.refreshOneMessage',
    'th.getLorebook',
    'th.getLorebooks',
    'th.getLorebookEntries',
    'th.setLorebookEntries',
    'th.replaceLorebookEntries',
    'th.updateLorebookEntriesWith',
    'th.createLorebookEntries',
    'th.deleteLorebookEntries',
    'th.createLorebook',
    'th.deleteLorebook',
    'th.getChatLorebook',
    'th.setChatLorebook',
    'th.getOrCreateChatLorebook',
    'th.getCharLorebooks',
    'th.getTavernRegexes',
    'th.replaceTavernRegexes',
    'th.updateTavernRegexesWith',
    'th.isCharacterTavernRegexesEnabled',
    'th.formatAsTavernRegexedString',
    'th.triggerSlash',
    'th.generate',
    'th.generateRaw',
    'th.stopGeneration',
    'th.formatAsDisplayedMessage',
    'th.retrieveDisplayedMessage',
    'th.substituteMacros',
    'th.getMvuData',
    'th.replaceMvuData',
    // host pump protocol (not a TH API — the server-side event mailbox read)
    'th.getEventLog',
] as const;
export type PanelMethodTH = (typeof PANEL_METHODS_TH)[number];

/** T0 subset — the minimum a panel mount must serve (see ecosystem doc §3). */
export const PANEL_METHODS_TH_T0 = [
    'th.getVariables',
    'th.replaceVariables',
    'th.insertOrAssignVariables',
    'th.insertVariables',
    'th.updateVariablesWith',
    'th.deleteVariable',
    'th.eventOn',
    'th.eventEmit',
    'th.eventEmitAndWait',
    'th.eventOnce',
    'th.eventRemoveListener',
    'th.eventMakeLast',
    'th.eventMakeFirst',
    'th.eventClearEvent',
    'th.eventClearListener',
    'th.eventClearAll',
    'th.getChatMessages',
    'th.getLastMessageId',
    'th.getCurrentMessageId',
    'th.injectPrompts',
    'th.uninjectPrompts',
    'th.waitGlobalInitialized',
    'th.initializeGlobal',
    'th.getCharacter',
    'th.getCurrentCharacterName',
] as const satisfies readonly PanelMethodTH[];
export type PanelMethodTHT0 = (typeof PANEL_METHODS_TH_T0)[number];

// ─── TH face argument/result shapes ─────────────────────────────────────

/** Variable scopes understood by the TH face. */
export type ThVariableScope = 'chat' | 'global' | 'message' | 'script';

export interface ThGetVariablesArgs {
    type?: ThVariableScope;      // default 'chat'
    message_id?: number;         // required for 'message' scope; negative = from last
    script_id?: string;          // required for 'script' scope
}

export interface ThVariableWriteArgs extends ThGetVariablesArgs {
    variables: Record<string, unknown>;
    /** updateVariablesWith: JSON-serialized updater description is NOT wire-safe —
     * the shim evaluates the updater locally and sends the merged result here. */
    result?: Record<string, unknown>;
}

export interface ThDeleteVariableArgs extends ThGetVariablesArgs {
    path: string; // dot-path
}

export interface ThGetChatMessagesArgs {
    /** TH range forms: `first`, `first-last`, `last`, `-count` (last N), `all`/`{{lastMessageId}}` */
    range: string;
    role?: 'user' | 'assistant' | 'system' | 'all';
    hide_state?: 'all' | 'hidden' | 'unhidden';
    include_swipes?: boolean;
}

/** TH message view — subset of the chat message record exposed to card code. */
export interface ThChatMessageView {
    message_id: number;
    name: string;
    role: 'user' | 'assistant' | 'system';
    is_hidden: boolean;
    message: string;
    data: Record<string, unknown>;
    extra?: Record<string, unknown>;
    swipes?: string[];
    swipe_id?: number;
}

export interface ThInjectedPrompt {
    id: string;
    position: 'in_chat' | 'none';
    depth?: number;
    role?: 'system' | 'user' | 'assistant';
    content: string;
    should_scan?: boolean;
    /** optional matcher over candidate messages (shim-side pre-filter) */
    filter?: unknown;
}

export interface ThInjectPromptsArgs {
    prompts: ThInjectedPrompt[];
}

export interface ThUninjectPromptsArgs {
    ids: string[];
}

export interface ThEventOnArgs {
    event: string;
    /** 'first' | 'last' — priority order when multiple listeners registered */
    priority?: 'normal' | 'first' | 'last';
    listener_id?: string; // shim-generated; used for removal
}

export interface ThEventEmitArgs {
    event: string;
    args?: unknown[];
    /** mailbox dedup: host/mount id that originated the emit — pumps skip own entries. */
    origin?: string;
}

/** eventClearListener args — one or more shim-issued listener ids. */
export interface ThEventClearListenerArgs {
    listener_id?: string;
    listener_ids?: string[];
}

/** getEventLog args — `since` is a mailbox seq; response carries newer entries. */
export interface ThGetEventLogArgs {
    since?: number;
}

/** Server-side event mailbox entry (chat_state `th.events.log` — see utopinn-th.js). */
export interface ThEventLogEntry {
    seq: number;
    at: number;           // Date.now() when the server accepted the emit
    event: string;
    args: unknown[];
    origin?: string;      // host/mount id, or 'card'/'server' — pumps skip their own
}

export interface ThGlobalReadyArgs {
    name: string; // e.g. 'Mvu'
}

/**
 * Event names the host may push through `PanelPush.event = 'th.event'`.
 * T0 subset of TH tavern_events + iframe_events; extend as needed.
 */
export const TH_TAVERN_EVENTS_T0 = [
    'message_sent',          // MESSAGE_SENT
    'message_received',      // MESSAGE_RECEIVED
    'message_swiped',        // MESSAGE_SWIPED
    'message_edited',        // MESSAGE_EDITED
    'message_deleted',       // MESSAGE_DELETED
    'message_updated',       // MESSAGE_UPDATED / MESSAGE_UPDATED_D
    'chat_changed',          // CHAT_CHANGED
    'generation_started',    // GENERATION_STARTED
    'generation_stopped',    // GENERATION_STOPPED
    'generation_ended',      // GENERATION_ENDED / STREAM_TOKEN_RECEIVED-ish
    'char_message_rendered', // CHARACTER_MESSAGE_RENDERED
    'user_message_rendered', // USER_MESSAGE_RENDERED
    'more_messages_loaded',  // MORE_MESSAGES_LOADED
] as const;
export type ThTavernEventT0 = (typeof TH_TAVERN_EVENTS_T0)[number];

/** iframe lifecycle events emitted by the host shell itself (not the server). */
export const TH_IFRAME_EVENTS = [
    'GENERATION_AFTER_COMMANDS',
    'GENERATION_STARTED',
    'GENERATION_ENDED',
    'BEFORE_MESSAGE_DELETED',
    'MESSAGE_EDITED',
    'MESSAGE_RECEIVED',
] as const;

/** Union of both faces — the bridge allowlist is face-aware per mount. */
export const ALL_PANEL_METHODS = [...PANEL_METHODS, ...PANEL_METHODS_TH] as const;
export type AnyPanelMethod = PanelMethod | PanelMethodTH;

/** Card → host request. Nonce minted per mount; host drops mismatches. */
export interface PanelRequest {
    channel: 'utopinn-panel';
    direction: 'request';
    nonce: string;
    requestId: string;
    method: AnyPanelMethod;
    args?: Record<string, unknown>;
}

/** Host → card response correlated by requestId. */
export interface PanelResponse {
    channel: 'utopinn-panel';
    direction: 'response';
    nonce: string;
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
}

/** Host → card unsolicited events (chat updated, swipe changed, state changed). */
export interface PanelPush {
    channel: 'utopinn-panel';
    direction: 'push';
    nonce: string;
    event: 'chat.updated' | 'swipe.changed' | 'state.changed' | 'lifecycle.unmount' | 'th.event' | 'host.event';
    /** th.event/host.event → {name: ThTavernEventT0|string, args: unknown[]}; others free-form.
     * 'host.event' is the ctx-face counterpart (cardapp-web-host.md): the shim
     * re-emits payload.name on ctx.eventSource with payload.args. */
    payload?: Record<string, unknown>;
}

export type PanelWireMessage = PanelRequest | PanelResponse | PanelPush;

/** Bootstrap payload the host injects before the app's init() runs. */
export interface PanelBootstrap {
    channel: 'utopinn-panel';
    direction: 'bootstrap';
    nonce: string;
    /** Which API face the shim injected: 'ctx' (CardApp) or 'th' (TavernHelper compat). */
    face: 'ctx' | 'th';
    /** Namespaces the app is permitted to read/write. */
    stateNamespaces: string[];
    /** Entry resource URLs (host-routed, CSP-allowed). */
    assets: Record<string, string>;
    theme?: 'dark' | 'light';
    /** th face only: floor identity this mount presents (same-floor shell = 0). */
    messageId?: number;
    /** th face only: names resolve for waitGlobalInitialized('X') without host round-trip. */
    initializedGlobals?: string[];
    /** ctx face: chat this mount is bound to (no .jsonl) — seeds ctx.getChatId/lukerContext.chatId. */
    chatName?: string;
    /** ctx face: mount-scoped asset base ('/card-runtime/m/<id>/') — seeds ctx.assetBase. */
    assetBase?: string;
    /** ctx face: mount manifest entry path — the init-caller imports it. */
    entry?: string;
}

export function isPanelMethod(v: unknown): v is AnyPanelMethod {
    return typeof v === 'string' && (ALL_PANEL_METHODS as readonly string[]).includes(v);
}

export function isPanelRequest(v: unknown): v is PanelRequest {
    const m = v as Partial<PanelRequest> | null;
    return !!m && m.channel === 'utopinn-panel' && m.direction === 'request' &&
        typeof m.nonce === 'string' && typeof m.requestId === 'string' &&
        isPanelMethod(m.method);
}
