/**
 * `convertCharacterBook` port — chara_card_v2 `data.character_book` (entries
 * as array, `keys`/`secondary_keys`/`id`/`enabled`/`position` string) →
 * world-file shape (`entries` keyed by uid, `key`/`keysecondary`/`uid`/
 * `disable`/numeric `position`). Server-side equivalent of upstream
 * `importEmbeddedWorldInfo`'s conversion step: a card's embedded book must be
 * materialized into world-file format before the WI engine can scan it —
 * otherwise every entry shares uid=undefined (dedup key `world.undefined`)
 * and the whole book collapses into a single entry.
 *
 * Upstream: public/scripts/world-info.js:5617.
 */
import {
    DEFAULT_DEPTH,
    DEFAULT_WEIGHT,
    newWorldInfoEntryTemplate,
    world_info_logic,
    world_info_position,
} from './types.js';
import type { WIEntry } from './types.js';
import type { WIWorldData } from './sources.js';

interface CharacterBookEntry {
    id?: number;
    keys?: string[];
    secondary_keys?: string[];
    comment?: string;
    content?: string;
    constant?: boolean;
    selective?: boolean;
    insertion_order?: number;
    position?: string;
    enabled?: boolean;
    extensions?: Record<string, unknown>;
}

export interface CharacterBook {
    name?: string;
    entries?: CharacterBookEntry[];
    [key: string]: unknown;
}

export function convertCharacterBook(characterBook: CharacterBook): WIWorldData {
    const result: WIWorldData = { entries: {}, originalData: characterBook } as WIWorldData;

    (characterBook.entries ?? []).forEach((entry, index) => {
        // Not in the spec, but this is needed to find the entry in the original data
        const id = entry.id ?? index;
        const ext = entry.extensions ?? {};

        result.entries![id] = {
            ...newWorldInfoEntryTemplate,
            uid: id,
            key: entry.keys ?? [],
            keysecondary: entry.secondary_keys ?? [],
            comment: entry.comment ?? '',
            content: entry.content ?? '',
            constant: entry.constant ?? false,
            selective: entry.selective ?? false,
            order: entry.insertion_order,
            position: (ext.position as number | undefined) ?? (entry.position === 'before_char' ? world_info_position.before : world_info_position.after),
            excludeRecursion: (ext.exclude_recursion as boolean | undefined) ?? false,
            preventRecursion: (ext.prevent_recursion as boolean | undefined) ?? false,
            delayUntilRecursion: (ext.delay_until_recursion as boolean | undefined) ?? false,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            displayIndex: (ext.display_index as number | undefined) ?? index,
            probability: (ext.probability as number | undefined) ?? 100,
            useProbability: (ext.useProbability as boolean | undefined) ?? true,
            depth: (ext.depth as number | undefined) ?? DEFAULT_DEPTH,
            selectiveLogic: (ext.selectiveLogic as number | undefined) ?? world_info_logic.AND_ANY,
            outletName: (ext.outlet_name as string | undefined) ?? '',
            group: (ext.group as string | undefined) ?? '',
            groupOverride: (ext.group_override as boolean | undefined) ?? false,
            groupWeight: (ext.group_weight as number | undefined) ?? DEFAULT_WEIGHT,
            scanDepth: (ext.scan_depth as number | undefined) ?? null,
            caseSensitive: (ext.case_sensitive as boolean | undefined) ?? null,
            matchWholeWords: (ext.match_whole_words as boolean | undefined) ?? null,
            useGroupScoring: (ext.use_group_scoring as boolean | undefined) ?? null,
            automationId: (ext.automation_id as string | undefined) ?? '',
            role: (ext.role as number | undefined) ?? 0,
            vectorized: (ext.vectorized as boolean | undefined) ?? false,
            sticky: (ext.sticky as number | undefined) ?? null,
            cooldown: (ext.cooldown as number | undefined) ?? null,
            delay: (ext.delay as number | undefined) ?? null,
            matchPersonaDescription: (ext.match_persona_description as boolean | undefined) ?? false,
            matchCharacterDescription: (ext.match_character_description as boolean | undefined) ?? false,
            matchCharacterPersonality: (ext.match_character_personality as boolean | undefined) ?? false,
            matchCharacterDepthPrompt: (ext.match_character_depth_prompt as boolean | undefined) ?? false,
            matchScenario: (ext.match_scenario as boolean | undefined) ?? false,
            matchCreatorNotes: (ext.match_creator_notes as boolean | undefined) ?? false,
            extensions: ext,
            triggers: (ext.triggers as string[] | undefined) ?? [],
            ignoreBudget: (ext.ignore_budget as boolean | undefined) ?? false,
        } as WIEntry;
    });

    return result;
}
