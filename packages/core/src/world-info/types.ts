/**
 * World Info engine types — ported from `public/scripts/world-info.js`.
 * Field names kept identical to wire/disk format for golden-diff fidelity.
 */

export const world_info_insertion_strategy = {
    evenly: 0,
    character_first: 1,
    global_first: 2,
} as const;

export const world_info_logic = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
} as const;

/** Possible states of the WI evaluation */
export const scan_state = {
    NONE: 0,
    INITIAL: 1,
    RECURSION: 2,
    MIN_ACTIVATIONS: 3,
} as const;
export type ScanState = (typeof scan_state)[keyof typeof scan_state];

export const world_info_position = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
} as const;

export const wi_anchor_position = {
    before: 0,
    after: 1,
} as const;

export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const MAX_SCAN_DEPTH = 1000;

export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

export const GENERATION_TYPE_TRIGGERS = [
    'normal',
    'continue',
    'impersonate',
    'swipe',
    'regenerate',
    'quiet',
];

/** Entry defaults — `newWorldInfoEntryTemplate` minus excludeFromTemplate fields. */
export const newWorldInfoEntryTemplate: Record<string, unknown> = {
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: world_info_logic.AND_ANY,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: DEFAULT_DEPTH,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: DEFAULT_WEIGHT,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
};

export interface WICharacterFilter {
    isExclude?: boolean;
    names?: string[];
    tags?: string[];
}

/** A single WI entry as it appears inside `{entries:{uid: entry}}` plus resolved `world`/`hash`/`decorators`. */
export interface WIEntry {
    uid: number;
    world?: string;
    hash?: number;
    decorators?: string[];
    key?: string[];
    keysecondary?: string[];
    comment?: string;
    content?: string;
    constant?: boolean;
    vectorized?: boolean;
    selective?: boolean;
    selectiveLogic?: number;
    addMemo?: boolean;
    order?: number;
    position?: number;
    disable?: boolean;
    ignoreBudget?: boolean;
    excludeRecursion?: boolean;
    preventRecursion?: boolean;
    matchPersonaDescription?: boolean;
    matchCharacterDescription?: boolean;
    matchCharacterPersonality?: boolean;
    matchCharacterDepthPrompt?: boolean;
    matchScenario?: boolean;
    matchCreatorNotes?: boolean;
    delayUntilRecursion?: number | boolean;
    probability?: number;
    useProbability?: boolean;
    depth?: number;
    outletName?: string;
    group?: string;
    groupOverride?: boolean;
    groupWeight?: number;
    scanDepth?: number | null;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | null;
    useGroupScoring?: boolean | null;
    automationId?: string;
    role?: number;
    sticky?: number | null;
    cooldown?: number | null;
    delay?: number | null;
    triggers?: string[];
    characterFilter?: WICharacterFilter;
    [key: string]: unknown;
}

export type TimedEffectType = 'sticky' | 'cooldown' | 'delay';

export interface WITimedEffect {
    hash: number;
    start: number;
    end: number;
    protected: boolean;
}

/** chat_metadata slice the engine reads and mutates (persisted by caller). */
export interface WIChatMetadata {
    timedWorldInfo?: {
        sticky?: Record<string, WITimedEffect>;
        cooldown?: Record<string, WITimedEffect>;
    };
    [key: string]: unknown;
}

/** Chat-independent data to be scanned (persona/character fields). */
export interface WIGlobalScanData {
    trigger?: string;
    personaDescription?: string;
    characterDescription?: string;
    characterPersonality?: string;
    characterDepthPrompt?: string;
    scenario?: string;
    creatorNotes?: string;
}

export interface WIEMEntry {
    position: number;
    content: string;
}

export interface WIDepthEntry {
    depth: number;
    entries: string[];
    role: number;
}

export interface WIActivated {
    worldInfoBeforeEntries: string[];
    worldInfoAfterEntries: string[];
    worldInfoBefore: string;
    worldInfoAfter: string;
    EMEntries: WIEMEntry[];
    WIDepthEntries: WIDepthEntry[];
    ANBeforeEntries: string[];
    ANAfterEntries: string[];
    outletEntries: Record<string, string[]>;
    allActivatedEntries: Set<WIEntry>;
}
