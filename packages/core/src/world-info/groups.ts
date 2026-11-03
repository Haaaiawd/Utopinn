import type { WorldInfoBuffer } from './buffer.js';
import type { WorldInfoTimedEffects } from './timed-effects.js';
import { DEFAULT_WEIGHT, type ScanState, type WIEntry } from './types.js';

const sortFn = (a: WIEntry, b: WIEntry) => (b.order ?? 0) - (a.order ?? 0);

/** Settings the group filters read. */
export interface WIGroupSettings {
    worldInfoUseGroupScoring: boolean;
}

/**
 * Only leaves entries with the highest key matching score in each group.
 * Ported from `world-info.js filterGroupsByScoring`.
 */
function filterGroupsByScoring(
    groups: Record<string, WIEntry[]>,
    buffer: WorldInfoBuffer,
    removeEntry: (entry: WIEntry) => void,
    scanState: ScanState,
    hasStickyMap: Map<string, boolean>,
    settings: WIGroupSettings,
): void {
    for (const [key, group] of Object.entries(groups)) {
        if (!settings.worldInfoUseGroupScoring && !group.some(x => x.useGroupScoring)) {
            continue;
        }

        const hasAnySticky = hasStickyMap.get(key);
        if (hasAnySticky) {
            continue;
        }

        const scores = group.map(entry => buffer.getScore(entry, scanState));
        const maxScore = Math.max(...scores);

        for (let i = 0; i < group.length; i++) {
            const entry = group[i]!;
            const isScored = entry.useGroupScoring ?? settings.worldInfoUseGroupScoring;
            if (!isScored) {
                continue;
            }
            if (scores[i]! < maxScore) {
                removeEntry(entry);
                group.splice(i, 1);
                scores.splice(i, 1);
                i--;
            }
        }
    }
}

/**
 * Removes entries on cooldown and forces sticky entries as winners.
 * Ported from `world-info.js filterGroupsByTimedEffects`.
 */
function filterGroupsByTimedEffects(
    groups: Record<string, WIEntry[]>,
    timedEffects: WorldInfoTimedEffects,
    removeEntry: (entry: WIEntry) => void,
): Map<string, boolean> {
    const hasStickyMap = new Map<string, boolean>();

    for (const [key, group] of Object.entries(groups)) {
        hasStickyMap.set(key, false);

        const stickyEntries = group.filter(x => timedEffects.isEffectActive('sticky', x));
        if (stickyEntries.length) {
            for (const entry of group) {
                if (stickyEntries.includes(entry)) {
                    continue;
                }
                removeEntry(entry);
            }
            hasStickyMap.set(key, true);
        }

        const cooldownEntries = group.filter(x => timedEffects.isEffectActive('cooldown', x));
        for (const entry of cooldownEntries) {
            removeEntry(entry);
        }

        const delayEntries = group.filter(x => timedEffects.isEffectActive('delay', x));
        for (const entry of delayEntries) {
            removeEntry(entry);
        }
    }

    return hasStickyMap;
}

/**
 * Filters entries by inclusion groups.
 * Ported from `world-info.js filterByInclusionGroups`. Mutates `newEntries` in place.
 */
export function filterByInclusionGroups(
    newEntries: WIEntry[],
    allActivatedEntries: Map<string, WIEntry>,
    buffer: WorldInfoBuffer,
    scanState: ScanState,
    timedEffects: WorldInfoTimedEffects,
    settings: WIGroupSettings,
    rng: () => number = Math.random,
): void {
    const grouped = newEntries.filter(x => x.group).reduce<Record<string, WIEntry[]>>((acc, item) => {
        String(item.group).split(/,\s*/).filter(x => x).forEach(group => {
            if (!acc[group]) {
                acc[group] = [];
            }
            acc[group]!.push(item);
        });
        return acc;
    }, {});

    if (Object.keys(grouped).length === 0) {
        return;
    }

    const removeEntry = (entry: WIEntry) => newEntries.splice(newEntries.indexOf(entry), 1);
    function removeAllBut(group: WIEntry[], chosen: WIEntry | null): void {
        for (const entry of group) {
            if (entry === chosen) {
                continue;
            }
            removeEntry(entry);
        }
    }

    const hasStickyMap = filterGroupsByTimedEffects(grouped, timedEffects, removeEntry);
    filterGroupsByScoring(grouped, buffer, removeEntry, scanState, hasStickyMap, settings);

    for (const [key, group] of Object.entries(grouped)) {
        const hasAnySticky = hasStickyMap.get(key);
        if (hasAnySticky) {
            continue;
        }

        if (Array.from(allActivatedEntries.values()).some(x => x.group === key)) {
            // Forcefully deactivate all other entries in the group
            removeAllBut(group, null);
            continue;
        }

        if (!Array.isArray(group) || group.length <= 1) {
            continue;
        }

        // Check for group prio
        const prios = group.filter(x => x.groupOverride).sort(sortFn);
        if (prios.length) {
            removeAllBut(group, prios[0]!);
            continue;
        }

        // Weighted random using entry's weight
        const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? DEFAULT_WEIGHT), 0);
        const rollValue = rng() * totalWeight;
        let currentWeight = 0;
        let winner: WIEntry | null = null;

        for (const entry of group) {
            currentWeight += (entry.groupWeight ?? DEFAULT_WEIGHT);
            if (rollValue <= currentWeight) {
                winner = entry;
                break;
            }
        }

        if (!winner) {
            continue;
        }

        removeAllBut(group, winner);
    }
}
