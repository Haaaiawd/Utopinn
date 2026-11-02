// Resource schemas: character card, world book, preset, chat, chat state.
// Shapes mirror SillyTavern's on-disk formats — wire format == storage format
// so import/export round-trips losslessly.

import type { PresetCategory } from './common.js';

// ---------- Character card (CCv2/v3 core; PNG metadata stays in formats pkg) ----------

export interface CharacterCardData {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    creatorcomment?: string;
    avatar?: string;
    tags?: string[];
    creator?: string;
    character_version?: string;
    /** CCv2+: alternate greetings, used by swipe picker. */
    alternate_greetings?: string[];
    /** Embedded world book (CCv2 `character_book`). */
    character_book?: WorldBook;
    /** Prompt-order character note / depth prompts (CCv2 extensions). */
    extensions?: {
        depth_prompt?: { prompt: string; depth: number; role?: 'system' | 'user' | 'assistant' };
        card_app?: { enabled: boolean; entry?: string };
        [key: string]: unknown;
    };
    /** Post-history instructions (CCv3). */
    post_history_instructions?: string;
    system_prompt?: string;
}

export interface CharacterSummary {
    name: string;
    avatar: string;
    /** File name on server (usually `${name}.png`). */
    fileName: string;
    fileSize?: number;
    tags?: string[];
    chatCount?: number;
    dateLastChat?: number;
    hasCardApp: boolean;
}

// ---------- World book / World Info ----------

export type WorldBookPosition =
    | 'before_char'
    | 'after_char'
    | 'em_top'
    | 'em_bottom'
    | 'an_top'
    | 'an_bottom'
    | 'at_depth';

export type WorldBookSelectiveLogic = 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL';

export interface WorldBookEntry {
    /** Stable entry key (numeric string in ST files; uid also carried). */
    uid: number;
    key: string[];
    keysecondary?: string[];
    comment?: string;
    content: string;
    constant?: boolean;
    selective?: boolean;
    selectiveLogic?: WorldBookSelectiveLogic | number;
    order: number;
    position: WorldBookPosition | number;
    /** at_depth position extras. */
    depth?: number;
    role?: 'system' | 'user' | 'assistant' | number;
    disable?: boolean;
    probability?: number;
    useProbability?: boolean;
    /** Sticky/cooldown/delay sweep fields. */
    sticky?: number;
    cooldown?: number;
    delay?: number;
    /** Scan/depth/vector controls. */
    scanDepth?: number;
    caseSensitive?: boolean;
    matchWholeWords?: boolean;
    useGroupScoring?: boolean;
    automation_id?: string;
    vectorized?: boolean;
    preventRecursion?: boolean;
    excludeRecursion?: boolean;
    displayIndex?: number;
}

/** On-disk world book shape: `{ entries: { [key]: entry } }`. */
export interface WorldBook {
    entries: Record<string, WorldBookEntry>;
}

/** Binding model: where a world book is sourced from for a chat. */
export type WorldBookSource =
    | { kind: 'primary'; name: string } // character's main book
    | { kind: 'auxiliary'; name: string } // character's extra book
    | { kind: 'chat'; name: string } // chat-bound lore
    | { kind: 'global'; name: string } // user-global selection
    | { kind: 'persona'; name: string };

// ---------- Preset ----------

export interface PresetSummary {
    category: PresetCategory;
    name: string;
}

/** Presets are opaque JSON documents — validated by core at assembly time. */
export type PresetDocument = Record<string, unknown>;

// ---------- Chat ----------

export interface ChatMessageHeader {
    name: string;
    is_user: boolean;
    is_system?: boolean;
    send_date: string | number;
    mes: string;
    /** Swipe alternatives; index = active swipe. */
    swipes?: string[];
    swipe_id?: number;
    extra?: Record<string, unknown>;
}

/** First JSONL line carries chat metadata. */
export interface ChatMetadata {
    user_name: string;
    character_name: string;
    create_date: string | number;
    chat_metadata: Record<string, unknown>;
}

export interface ChatSummary {
    file: string;
    character: string;
    messageCount: number;
    lastMessage?: string;
    lastDate?: string | number;
}

// ---------- Namespaced state (Luker .luker-state.<ns>.json sidecars) ----------

export type StateNamespace = string;

export interface ChatState {
    chat: string;
    namespace: StateNamespace;
    /** Opaque JSON document owned by the namespace (CardApp, MVU variables…). */
    data: Record<string, unknown>;
    version: number;
}

export interface CharacterState {
    character: string;
    namespace: StateNamespace;
    data: Record<string, unknown>;
    version: number;
}

/** Floor-aware state snapshot for swipe/delete/branch rewind. */
export interface FloorState {
    chat: string;
    namespace: StateNamespace;
    floor: number;
    data: Record<string, unknown>;
}
