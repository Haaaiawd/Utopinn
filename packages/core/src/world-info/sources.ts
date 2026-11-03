import { clone, getStringHash } from '../utils.js';
import { parseDecorators } from './decorators.js';
import {
    newWorldInfoEntryTemplate,
    world_info_insertion_strategy,
    type WIEntry,
} from './types.js';

const sortFn = (a: WIEntry, b: WIEntry) => (b.order ?? 0) - (a.order ?? 0);

export interface WIWorldData {
    entries?: Record<string, WIEntry>;
    [key: string]: unknown;
}

/**
 * Inputs needed to resolve the five lore sources. Callers resolve
 * world names to book data (storage/Repo concern stays outside core).
 */
export interface WILoreSourcesInput {
    /** Globally selected world names (`selected_world_info`). */
    selectedWorlds: string[];
    /** Character's primary world (`character.data.extensions.world`). */
    characterPrimaryWorld?: string;
    /** Extra books bound to this character (`world_info.charLore[].extraBooks`). */
    characterExtraBooks?: string[];
    /** Chat-bound world names (already resolved). */
    chatWorlds: string[];
    /** Persona lorebook (`power_user.persona_description_lorebook`). */
    personaWorld?: string;
    /** Insertion strategy for char vs global ordering. */
    insertionStrategy: number;
    /** Looks up world data by name. Return undefined/empty for missing books. */
    getWorldData: (name: string) => WIWorldData | undefined;
}

/**
 * `addMissingWorldInfoFields` port — entries on disk may lack fields;
 * the original normalizes them on the load path before scanning.
 */
export function addMissingWorldInfoFields(entries: WIEntry[]): WIEntry[] {
    entries.forEach((entry) => {
        Object.entries(newWorldInfoEntryTemplate).forEach(([key, value]) => {
            if (!Object.hasOwn(entry, key)) {
                entry[key] = clone(value);
            }
        });
        if (!Array.isArray(entry.key)) {
            entry.key = [];
        }
        if (!Array.isArray(entry.keysecondary)) {
            entry.keysecondary = [];
        }
        if (!entry.characterFilter || typeof entry.characterFilter !== 'object' || Array.isArray(entry.characterFilter)) {
            entry.characterFilter = { isExclude: false, names: [], tags: [] };
        }
    });
    return entries;
}

function entriesOfWorld(data: WIWorldData | undefined, worldName: string): WIEntry[] {
    if (!data?.entries) {
        return [];
    }
    const entries = Object.keys(data.entries).map(x => data.entries![x]!).map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest }));
    return addMissingWorldInfoFields(entries);
}

/**
 * Merges the four lore sources into one sorted entry list,
 * replicating `getSortedEntries` + `get*Lore` source semantics:
 * chat lore → persona lore → (char | global by strategy).
 * Each source skips worlds already covered by a higher-priority source.
 * Also parses decorators into entry content and stamps the entry hash.
 */
export function mergeLoreSources(input: WILoreSourcesInput): WIEntry[] {
    const { selectedWorlds, chatWorlds, personaWorld, getWorldData } = input;
    const charExtraBooks = input.characterExtraBooks ?? [];

    // Global lore: all selected worlds
    const globalLore: WIEntry[] = [];
    for (const worldName of selectedWorlds) {
        globalLore.push(...entriesOfWorld(getWorldData(worldName), worldName));
    }

    // Chat lore: skip worlds already selected globally
    const chatLore: WIEntry[] = [];
    for (const worldName of chatWorlds) {
        if (selectedWorlds.includes(worldName)) {
            continue;
        }
        chatLore.push(...entriesOfWorld(getWorldData(worldName), worldName));
    }

    // Persona lore: skip if already covered by chat or global
    let personaLore: WIEntry[] = [];
    if (personaWorld && !chatWorlds.includes(personaWorld) && !selectedWorlds.includes(personaWorld)) {
        personaLore = entriesOfWorld(getWorldData(personaWorld), personaWorld);
    }

    // Character lore: primary world + extra books, skipping anything
    // already covered by global/chat/persona selections
    const characterLore: WIEntry[] = [];
    const worldsToSearch = new Set<string>();
    if (input.characterPrimaryWorld) {
        worldsToSearch.add(input.characterPrimaryWorld);
    }
    for (const extra of charExtraBooks) {
        worldsToSearch.add(extra);
    }
    for (const worldName of worldsToSearch) {
        if (selectedWorlds.includes(worldName) || chatWorlds.includes(worldName) || personaWorld === worldName) {
            continue;
        }
        characterLore.push(...entriesOfWorld(getWorldData(worldName), worldName));
    }

    let entries: WIEntry[];
    switch (Number(input.insertionStrategy)) {
        case world_info_insertion_strategy.evenly:
            entries = [...globalLore, ...characterLore].sort(sortFn);
            break;
        case world_info_insertion_strategy.character_first:
            entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)];
            break;
        case world_info_insertion_strategy.global_first:
            entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)];
            break;
        default:
            console.error('[WI] Unknown WI insertion strategy:', input.insertionStrategy, 'defaulting to evenly');
            entries = [...globalLore, ...characterLore].sort(sortFn);
            break;
    }

    // Chat lore always goes first, then persona lore, then the rest
    entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];

    // Parse decorators, then stamp hash (split maps to preserve old hashes)
    entries = entries.map((entry) => {
        const [decorators, content] = parseDecorators(entry.content || '');
        return { ...entry, decorators, content };
    }).map((entry) => {
        const hash = getStringHash(JSON.stringify(entry));
        return { ...entry, hash };
    });

    // Deep clone so callers can't mutate source book data through entries
    return clone(entries);
}
