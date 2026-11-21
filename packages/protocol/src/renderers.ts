// Conversation renderer seam — contract between the host and a pluggable
// conversation presentation. Renderers draw; they never interpret message
// semantics, never read chat files, never write state. The host supplies
// normalized message views, append-only stream deltas, receipts and action
// callbacks. See .skeinn/design/conversation-renderers.md (R1–R5 evidence).

// ---------- Renderer manifest ----------

/** Platform a renderer implementation can run on. */
export const RENDERER_TARGETS = ['web', 'mobile'] as const;
export type RendererTarget = (typeof RENDERER_TARGETS)[number];

/**
 * Surfaces a renderer draws itself. The host keeps fallback chrome for
 * anything not claimed (e.g. a renderer without 'swipes' gets the host's
 * swipe picker). Mirrors design §1 `capabilities`.
 */
export const RENDERER_CAPABILITIES = [
    'swipes',       // swipe picker / counter / version badge
    'receipts',     // variable-op / system receipts rendered inline
    'reasoning',    // collapsible reasoning blocks
    'avatars',
    'timestamps',
    'attachments',  // media / file wrappers
    'threaded',     // floor-to-floor quote relations (forum form)
    'sprites',      // per-speaker figures / cast art (galgame form)
] as const;
export type RendererCapability = (typeof RENDERER_CAPABILITIES)[number];

/**
 * Declarative settings field — dsh-mod `settingsSchema` shape
 * (ref/dsh-tavern …/mod-contract.cjs MOD_FIELD_TYPES, minus asset pickers).
 * The host's settings surface renders these; the renderer never builds forms.
 */
export const RENDERER_SETTING_TYPES = [
    'text',
    'toggle',
    'slider',
    'segmented',
    'colour',
    'select',
] as const;
export type RendererSettingType = (typeof RENDERER_SETTING_TYPES)[number];

export interface RendererSettingField {
    key: string;
    type: RendererSettingType;
    label: string;
    help?: string;
    default?: unknown;
    /** segmented / select options. */
    choices?: { value: string; label: string }[];
    /** slider bounds. */
    min?: number;
    max?: number;
    step?: number;
    /** Show only when another field equals a value (dsh-mod dependsOn). */
    dependsOn?: { key: string; equals: unknown };
}

export interface RendererManifest {
    /** Stable id, lowercase dotted (`utopinn.prose`). Registration rejects dupes. */
    id: string;
    name: string;
    version: string;
    /** Hosts that may run this renderer; a host refuses a manifest without it. */
    targets: RendererTarget[];
    description?: string;
    author?: string;
    capabilities?: RendererCapability[];
    /** Declarative settings rendered by the host's settings surface. */
    settingsSchema?: {
        fields: RendererSettingField[];
        sections?: { id: string; title: string; fields: string[] }[];
    };
    /** StageScheme token keys this renderer consumes ('ink', 'surface', 'fontReading'…). */
    schemeKeys?: string[];
    /**
     * Extra host services beyond the base contract a renderer negotiates
     * (galgame-class: direction projections, asset packs, audio — evidence:
     * dsh stageSessionInputs, ref/dsh-tavern …/stage-session-binding.js).
     * Absent services → host must not mount the renderer.
     */
    requires?: string[];
}

/** Registry entry for a plugin-provided renderer (design §4). */
export interface RendererRegistration {
    manifest: RendererManifest;
    /** Plugin that owns this renderer (host bookkeeping). */
    owner?: string;
    /** Code entry the host loads on demand; builtin renderers omit it. */
    componentUrl?: string;
}

// ---------- Message view model (host → renderer) ----------

export type RendererMessageRole = 'user' | 'assistant' | 'system';

/** Reference to a displayable avatar — the host resolves URLs. */
export interface AvatarRef {
    kind: 'character' | 'persona' | 'group' | 'asset';
    id: string;
    /** Pre-resolved URL when cheap (data: or server-relative). */
    url?: string;
}

/** One structured product the host attaches to a floor (变量回执/系统产物). */
export interface MessageReceipt {
    /** 'variables' (var-op list), 'mvu', 'candidate', 'media', host-defined… */
    kind: string;
    /** One-line summary for collapsed display. */
    summary?: string;
    /**
     * Structured ops/changes — renderers may ignore; host UI owns the detail
     * view. Shape mirrors Luker VarOp (`{op:'setvar'|…, key, path?, value}`).
     */
    ops?: { op: string; key: string; path?: string; value?: unknown; previous?: unknown }[];
    data?: Record<string, unknown>;
}

/**
 * One swipe alternative. Mirrors Luker `swipes[i]` + `swipe_info[i].extra`:
 * reasoning and variable receipts ride the swipe, not the floor
 * (ref/Luker/public/script.js:6813-6819; variable-op-log/floor-ops.js:14-36).
 */
export interface SwipeView {
    index: number;
    content: string;
    reasoning?: string;
    timestamp?: string | number;
    receipts?: MessageReceipt[];
    extra?: Record<string, unknown>;
}

/**
 * Normalized floor view. `content`/`reasoning`/`receipts`/`timestamp` describe
 * the ACTIVE swipe; `swipes` enumerates the sibling chain for pickers/previews
 * (absent or length<2 → no swipe chrome needed).
 */
export interface MessageViewModel {
    /** Host floor identity (JSONL message index / turn). */
    id: number;
    role: RendererMessageRole;
    name: string;
    /** Speaker avatar; per-floor override covers group members (Luker force_avatar). */
    avatar?: AvatarRef;
    /** Canonical text of the active swipe. */
    content: string;
    /** Display-only override (Luker extra.display_text); prefer over `content` when set. */
    displayContent?: string;
    /** Active swipe's reasoning; collapsed by convention. */
    reasoning?: string;
    /** Variable/system receipts bound to the active swipe + the floor. */
    receipts?: MessageReceipt[];
    timestamp?: string | number;
    /** Excluded from prompt assembly (ghost message). */
    hidden?: boolean;
    /** This floor is the in-flight generation — deltas arrive via onDelta. */
    streaming?: boolean;
    /** Generation stopped mid-flight; the partial text is final. */
    interrupted?: boolean;
    swipes?: SwipeView[];
    activeSwipe?: number;
    /** Host extension slot (media, files, itemized prompt…); renderers may ignore. */
    extra?: Record<string, unknown>;
}

// ---------- Conversation view ----------

/** User typography synced from server settings — applies to every renderer. */
export interface TypingSettings {
    /** px; renderer's own base size when unset. */
    fontSize?: number;
    lineHeight?: number;
    /** Reading column max width, px. */
    columnWidth?: number;
    fontFamily?: string;
    density?: 'comfortable' | 'compact';
}

/**
 * Card-declared stage scheme (design §3). Tokens are colors/fonts only and
 * never carry layout semantics; `renderer` is a recommendation — the user's
 * stored choice always outranks it (dsh TAVERN_VIEW_BUILTIN rule).
 */
export interface StageScheme {
    renderer?: string;
    tokens?: Record<string, string>;
}

/** The host-supplied visible conversation window. */
export interface ConversationView {
    /** Chat identity; mirrors GenerateRequest.chatRef shape. */
    chatRef?: { kind: 'chat'; character: string; file: string };
    /** Floors in display order — the renderer must not reorder them. */
    messages: MessageViewModel[];
    /** Floor currently receiving deltas, if any (drives "typing" affordances). */
    streamingMessageId?: number;
    typing: TypingSettings;
    /** Card-declared scheme already resolved against the user's choice. */
    scheme?: StageScheme;
    /** Monotonic bump on any structural change; 0/undefined = first snapshot. */
    revision?: number;
}

/** Per-floor context passed alongside renderMessage. */
export interface MessageRenderContext {
    /** Position within ConversationView.messages. */
    index: number;
    isFirst?: boolean;
    isLast?: boolean;
    /**
     * Same speaker as the previous visible floor — chrome (avatar/name) may
     * merge visually; floor identity and actions never merge (R4 rule).
     */
    sameSpeakerAsPrevious?: boolean;
    streaming?: boolean;
}

// ---------- Host services (renderer → host) ----------

/** Semantics the host owns; the renderer only invokes them (design §1 actions). */
export interface RendererActions {
    /** Switch a floor's active swipe. */
    swipe(messageId: number, index: number): void;
    /** Ask the host to open its edit interaction for this floor. */
    beginEdit(messageId: number): void;
    /** Commit edited text (renderer-drawn editors). */
    submitEdit(messageId: number, text: string): void;
    regenerate(messageId: number): void;
    /** Fork the chat at this floor (Luker create-branch / dsh fork turn). */
    branch(messageId: number): void;
    deleteSwipe?(messageId: number, index: number): void;
    /** Open the host's overflow menu for this floor (translate/hide/copy…). */
    more(messageId: number): void;
}

/** Host-originated nudges outside the message stream. */
export const RENDERER_HOST_EVENTS = [
    'typing.changed',    // TypingSettings changed
    'scheme.changed',    // StageScheme changed
    'receipts.changed',  // a floor's receipt list changed off-band
    'visibility',        // host chrome shown/hidden (fullscreen, side panels)
] as const;
export type RendererHostEvent = (typeof RENDERER_HOST_EVENTS)[number];

/**
 * Everything the host offers beyond the view itself. Per-floor variable-op /
 * MVU receipt DATA arrives via `MessageViewModel.receipts` (and 'receipts.changed'
 * events) — the services below are for what the view alone cannot carry.
 */
export interface RendererHostServices {
    actions: RendererActions;
    /** Token estimate for a floor; null while unknown (tokenizer may be remote). */
    tokenCount?(messageId: number): Promise<number | null>;
    /** Resolve an avatar/asset ref to a displayable URL. */
    resolveAsset?(ref: AvatarRef): string | Promise<string>;
    /** Subscribe to a host event; returns an unsubscribe function. */
    on(event: RendererHostEvent, listener: () => void): () => void;
    /** Report a renderer fault into the host error surface. */
    report(error: unknown): void;
}

// ---------- Renderer lifecycle ----------

/**
 * Append-only stream payload. Never reorders, never replaces settled text —
 * the renderer may buffer/pace/withhold a live tail but not rewrite it (R5).
 */
export interface RendererDelta {
    kind: 'text' | 'reasoning';
    text: string;
}

/** Why onUpdate fired — lets the renderer scope a redraw. */
export const MESSAGE_UPDATE_KINDS = [
    'content',   // settled text/reasoning changed (edit, post-processing)
    'swipe',     // activeSwipe changed — whole-floor content replace
    'receipts',
    'meta',      // name/avatar/hidden/timestamp changed
] as const;
export type MessageUpdateKind = (typeof MESSAGE_UPDATE_KINDS)[number];

/**
 * Opaque mount handle: a DOM Element on web, a native view ref on mobile.
 * The renderer treats it as append-only real estate owned by the host.
 */
export type RendererMount = unknown;

/**
 * Renderer lifecycle (evidence: dsh stage `createViews(services) → views{,dispose}`
 * + `registerTurnView render(input) → node|null` with error-boundary fallback):
 *
 *   init → mount(view) → renderMessage/onDelta/onUpdate/onViewChange → unmount → dispose
 *
 * The host pushes every call; the renderer is never pulled for data.
 * Builtins and plugins implement the same shape — the seam's self-proof.
 */
export interface ConversationRenderer {
    /** Identity + declared needs; must equal the registered manifest. */
    manifest: RendererManifest;
    /** One-time wiring with host services. */
    init?(services: RendererHostServices): void | Promise<void>;
    /** Attach into the host-supplied mount with the first visible-window snapshot. */
    mount(target: RendererMount, view: ConversationView): void;
    /** (Re)draw one floor; called per visible floor at mount time. */
    renderMessage?(message: MessageViewModel, context: MessageRenderContext): void;
    /** Append-only stream chunk for the streaming floor. */
    onDelta?(messageId: number, delta: RendererDelta): void;
    /** A settled floor changed (edit, swipe switch, receipts, meta). */
    onUpdate?(message: MessageViewModel, kind: MessageUpdateKind): void;
    /** Non-message view change (typing, scheme, visible window). */
    onViewChange?(view: ConversationView): void;
    /** A floor left the visible set (delete or window eviction). */
    onRemove?(messageId: number): void;
    /** Detach from the mount; release listeners/timers/owned nodes. */
    unmount?(): void;
    /** Final teardown; the renderer is discarded after this. */
    dispose?(): void;
}

// ---------- Type guards ----------

export function isRendererManifest(v: unknown): v is RendererManifest {
    if (typeof v !== 'object' || v === null) return false;
    const m = v as Partial<RendererManifest>;
    return typeof m.id === 'string' && typeof m.name === 'string' &&
        typeof m.version === 'string' &&
        Array.isArray(m.targets) &&
        m.targets.every(t => (RENDERER_TARGETS as readonly string[]).includes(t as string));
}
