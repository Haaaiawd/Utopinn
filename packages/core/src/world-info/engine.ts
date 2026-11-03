import { WorldInfoBuffer, type WIMatchSourceHint } from './buffer.js';
import { filterByInclusionGroups } from './groups.js';
import { WorldInfoTimedEffects } from './timed-effects.js';
import {
    DEFAULT_DEPTH,
    scan_state,
    wi_anchor_position,
    world_info_logic,
    world_info_position,
    type ScanState,
    type WIActivated,
    type WIChatMetadata,
    type WIEntry,
    type WIGlobalScanData,
} from './types.js';

/**
 * Global WI settings the engine reads. Mirrors `world_info_*` globals.
 */
export interface WIEngineSettings {
    worldInfoDepth: number;
    worldInfoBudget: number;
    worldInfoBudgetCap: number;
    worldInfoCaseSensitive: boolean;
    worldInfoMatchWholeWords: boolean;
    worldInfoUseGroupScoring: boolean;
    worldInfoRecursive: boolean;
    worldInfoOverflowAlert: boolean;
    worldInfoMinActivations: number;
    worldInfoMinActivationsDepthMax: number;
    worldInfoMaxRecursionSteps: number;
}

export const DEFAULT_WI_SETTINGS: WIEngineSettings = {
    worldInfoDepth: 2,
    worldInfoBudget: 25,
    worldInfoBudgetCap: 0,
    worldInfoCaseSensitive: false,
    worldInfoMatchWholeWords: false,
    worldInfoUseGroupScoring: false,
    worldInfoRecursive: false,
    worldInfoOverflowAlert: false,
    worldInfoMinActivations: 0,
    worldInfoMinActivationsDepthMax: 0,
    worldInfoMaxRecursionSteps: 0,
};

/**
 * Ports the environment the engine needs. Everything that was a global
 * or a platform call in the original becomes an injected dependency.
 */
export interface WIEngineContext {
    /** Pre-merged, decorator-parsed, hashed entries (see mergeLoreSources). */
    sortedEntries: WIEntry[];
    /** Mutable chat metadata (timed effects persist here). */
    chatMetadata: WIChatMetadata;
    /** Global WI settings. */
    settings?: Partial<WIEngineSettings>;
    /** Macro substitution for keys + content. Default: identity. */
    substituteParams?: (content: string) => string;
    /** Token counter. Default: chars/4 estimate. */
    countTokens?: (text: string) => number | Promise<number>;
    /**
     * Regex pipeline hook for `regex_placement.WORLD_INFO`
     * (content => processed). Default: identity. The real regex engine
     * wires in here during prompt assembly (TASK-006).
     */
    applyWorldInfoRegex?: (content: string, opts: { depth: number | null; role?: number }) => string;
    /**
     * Scan-flagged extension prompts injected into the scan buffer
     * (`context.extensionPrompts[key].scan`).
     */
    scannableExtensionPrompts?: string[];
    /** Character filename for `characterFilter.names`. */
    getCharacterFilename?: () => string;
    /** Tags of the current character for `characterFilter.tags`. */
    getCharacterTags?: () => string[];
    /** RNG for probability + group rolls. Default Math.random. */
    rng?: () => number;
    /**
     * WORLDINFO_SCAN_DONE hook — may mutate `args` like the original event:
     * `state.next`, `activated.text`, `recursionDelay.currentLevel`, `budget`.
     */
    onScanDone?: (args: WIScanDoneArgs) => void | Promise<void>;
    /** Overflow alert callback (was toastr.warning). */
    onBudgetOverflow?: (budget: number, activatedCount: number) => void;
}

export interface WIScanDoneArgs {
    state: { current: ScanState; next: ScanState; loopCount: number };
    new: { all: WIEntry[]; successful: WIEntry[] };
    activated: { entries: Map<string, WIEntry>; text: string };
    sortedEntries: WIEntry[];
    recursionDelay: { availableLevels: number[]; currentLevel: number };
    budget: { current: number; overflowed: boolean };
    timedEffects: WorldInfoTimedEffects;
}

interface WITraceRecord {
    world: string;
    uid: number;
    attempts: unknown[];
    activated: boolean;
    lastActivation: unknown | null;
}

const sortFn = (a: WIEntry, b: WIEntry) => (b.order ?? 0) - (a.order ?? 0);
const identity = (x: string) => x;

function getScanStateName(state: ScanState): string {
    return Object.entries(scan_state).find(x => x[1] === state)?.[0] ?? String(state);
}

/**
 * Performs a scan on the chat and returns the world info activated.
 * Ported from `world-info.js checkWorldInfo`.
 *
 * @param chat The chat messages to scan, in reverse order (index 0 = newest).
 * @param maxContext Maximum context size (for WI budget %).
 * @param isDryRun Dry run: no timed-effect writes, no recursion state changes persisted.
 */
export async function checkWorldInfo(
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData: WIGlobalScanData = {},
    ctx: WIEngineContext,
): Promise<WIActivated> {
    const settings: WIEngineSettings = { ...DEFAULT_WI_SETTINGS, ...ctx.settings };
    const substitute = ctx.substituteParams ?? identity;
    const countTokens = ctx.countTokens ?? ((t: string) => Math.ceil(t.length / 4));
    const applyRegex = ctx.applyWorldInfoRegex ?? ((c: string) => c);
    const rng = ctx.rng ?? Math.random;
    const chatMetadata = ctx.chatMetadata;
    const sortedEntries = ctx.sortedEntries;

    const buffer = new WorldInfoBuffer(chat, globalScanData, {
        worldInfoDepth: settings.worldInfoDepth,
        worldInfoCaseSensitive: settings.worldInfoCaseSensitive,
        worldInfoMatchWholeWords: settings.worldInfoMatchWholeWords,
    });

    const scanTraceByEntry = new Map<string, WITraceRecord>();

    // Extension prompts with scan flag are part of the scan buffer
    for (const prompt of ctx.scannableExtensionPrompts ?? []) {
        if (prompt) {
            buffer.addInject(prompt);
        }
    }

    let scanState: ScanState = scan_state.INITIAL;
    let tokenBudgetOverflowed = false;
    let count = 0;
    const allActivatedEntries = new Map<string, WIEntry>();
    const failedProbabilityChecks = new Set<WIEntry>();
    let allActivatedText = '';
    let recursionSourceEntryKeys: string[] = [];

    let budget = Math.round(settings.worldInfoBudget * maxContext / 100) || 1;
    if (settings.worldInfoBudgetCap > 0 && budget > settings.worldInfoBudgetCap) {
        budget = settings.worldInfoBudgetCap;
    }

    const timedEffects = new WorldInfoTimedEffects(chat, sortedEntries, chatMetadata, isDryRun);
    timedEffects.checkTimedEffects();

    if (sortedEntries.length === 0) {
        return {
            worldInfoBeforeEntries: [],
            worldInfoAfterEntries: [],
            worldInfoBefore: '',
            worldInfoAfter: '',
            WIDepthEntries: [],
            EMEntries: [],
            ANBeforeEntries: [],
            ANAfterEntries: [],
            outletEntries: {},
            allActivatedEntries: new Set(),
        };
    }

    /** Delay levels for entries delayed until recursion. */
    const availableRecursionDelayLevels = [...new Set(sortedEntries
        .filter(entry => entry.delayUntilRecursion)
        .map(entry => entry.delayUntilRecursion === true ? 1 : Number(entry.delayUntilRecursion)),
    )].sort((a, b) => a - b);
    let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;

    const makeTraceKey = (entry: WIEntry) => `${entry.world}.${entry.uid}`;

    const getRecursionTraceSources = (state: ScanState = scanState): string[] => {
        if (state !== scan_state.RECURSION || !recursionSourceEntryKeys.length) {
            return [];
        }
        return [...new Set(recursionSourceEntryKeys)];
    };

    const withRecursionTraceSources = (details: Record<string, unknown> = {}, state: ScanState = scanState) => {
        const sources = getRecursionTraceSources(state);
        if (!sources.length) {
            return details;
        }
        return { ...details, recursionSourceEntries: sources };
    };

    const recordActivationAttempt = (entry: WIEntry, reason: string, details: Record<string, unknown> = {}, loopCount = count, state = scanState) => {
        if (!entry || entry.uid === undefined || !entry.world) {
            return;
        }
        const key = makeTraceKey(entry);
        const existing = scanTraceByEntry.get(key) || {
            world: String(entry.world || ''),
            uid: Number(entry.uid),
            attempts: [],
            activated: false,
            lastActivation: null,
        };
        existing.attempts.push({
            loop: Number(loopCount || 0),
            scanState: getScanStateName(state),
            trigger: String(globalScanData.trigger || 'normal'),
            scanDepth: Number(entry.scanDepth ?? buffer.getDepth()),
            reason: String(reason || ''),
            details,
        });
        scanTraceByEntry.set(key, existing);
    };

    const recordActivationSuccess = (entry: WIEntry, details: Record<string, unknown> = {}, loopCount = count, state = scanState) => {
        if (!entry || entry.uid === undefined || !entry.world) {
            return;
        }
        const key = makeTraceKey(entry);
        const existing = scanTraceByEntry.get(key) || {
            world: String(entry.world || ''),
            uid: Number(entry.uid),
            attempts: [],
            activated: false,
            lastActivation: null,
        };
        existing.activated = true;
        existing.lastActivation = {
            loop: Number(loopCount || 0),
            scanState: getScanStateName(state),
            trigger: String(globalScanData.trigger || 'normal'),
            scanDepth: Number(entry.scanDepth ?? buffer.getDepth()),
            details,
        };
        scanTraceByEntry.set(key, existing);
    };

    while (scanState) {
        // If world_info_max_recursion_steps is non-zero min activations are disabled, and vice versa
        if (settings.worldInfoMaxRecursionSteps && settings.worldInfoMaxRecursionSteps <= count) {
            break;
        }

        count++;
        let nextScanState: ScanState = scan_state.NONE;
        const activatedNow = new Set<WIEntry>();

        for (const entry of sortedEntries) {
            // Already processed/skipped entries stay skipped
            if (failedProbabilityChecks.has(entry) || allActivatedEntries.has(`${entry.world}.${entry.uid}`)) {
                continue;
            }

            if (entry.disable == true) {
                continue;
            }

            // Generation type trigger filter
            if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
                const isTriggered = entry.triggers.includes(globalScanData.trigger ?? 'normal');
                if (!isTriggered) {
                    continue;
                }
            }

            // Character filter (names)
            if (entry.characterFilter && entry.characterFilter.names && entry.characterFilter.names.length > 0) {
                const filename = ctx.getCharacterFilename?.() ?? '';
                const nameIncluded = entry.characterFilter.names.includes(filename);
                const filtered = entry.characterFilter.isExclude ? nameIncluded : !nameIncluded;
                if (filtered) {
                    continue;
                }
            }

            // Character filter (tags)
            if (entry.characterFilter && entry.characterFilter.tags && entry.characterFilter.tags.length > 0) {
                const tags = ctx.getCharacterTags?.() ?? [];
                if (tags.length) {
                    const includesTag = tags.some(tag => entry.characterFilter!.tags!.includes(tag));
                    const filtered = entry.characterFilter.isExclude ? includesTag : !includesTag;
                    if (filtered) {
                        continue;
                    }
                }
            }

            const isSticky = timedEffects.isEffectActive('sticky', entry);
            const isCooldown = timedEffects.isEffectActive('cooldown', entry);
            const isDelay = timedEffects.isEffectActive('delay', entry);

            if (isDelay) {
                continue;
            }

            if (isCooldown && !isSticky) {
                continue;
            }

            // Recursion flags only apply on recursion steps
            if (scanState !== scan_state.RECURSION && entry.delayUntilRecursion && !isSticky) {
                continue;
            }

            if (scanState === scan_state.RECURSION && entry.delayUntilRecursion && Number(entry.delayUntilRecursion) > currentRecursionDelayLevel && !isSticky) {
                continue;
            }

            if (scanState === scan_state.RECURSION && settings.worldInfoRecursive && entry.excludeRecursion && !isSticky) {
                continue;
            }

            if (entry.decorators?.includes('@@activate')) {
                recordActivationAttempt(entry, 'decorator_activate', withRecursionTraceSources({ decorator: '@@activate' }));
                activatedNow.add(entry);
                continue;
            }

            if (entry.decorators?.includes('@@dont_activate')) {
                continue;
            }

            const externallyActivated = buffer.getExternallyActivated(entry);
            if (externallyActivated) {
                recordActivationAttempt(externallyActivated, 'external_activation', withRecursionTraceSources({ sourceEntry: makeTraceKey(entry) }));
                activatedNow.add(externallyActivated);
                continue;
            }

            // Immediate activations
            if (entry.constant) {
                recordActivationAttempt(entry, 'constant', withRecursionTraceSources({ constant: true }));
                activatedNow.add(entry);
                continue;
            }

            if (isSticky) {
                recordActivationAttempt(entry, 'sticky', withRecursionTraceSources({ sticky: true }));
                activatedNow.add(entry);
                continue;
            }

            if (!Array.isArray(entry.key) || !entry.key.length) {
                continue;
            }

            const textToScan = buffer.get(entry, scanState);

            // PRIMARY KEYWORDS
            const primaryKeyMatch = entry.key.find(key => {
                const substituted = substitute(key);
                return substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
            });

            if (!primaryKeyMatch) {
                continue;
            }

            const substitutedPrimary = String(substitute(primaryKeyMatch) || primaryKeyMatch || '').trim();
            const matchSourceHints: WIMatchSourceHint[] = substitutedPrimary
                ? buffer.getMatchSourceHints(entry, substitutedPrimary, scanState)
                : [];

            const hasSecondaryKeywords = (
                entry.selective &&
                Array.isArray(entry.keysecondary) &&
                entry.keysecondary.length
            );

            if (!hasSecondaryKeywords) {
                recordActivationAttempt(entry, 'key_match', withRecursionTraceSources({
                    primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                    sourceHints: matchSourceHints,
                    selectiveLogic: 'none',
                }));
                activatedNow.add(entry);
                continue;
            }

            // SECONDARY KEYWORDS
            const selectiveLogic = entry.selectiveLogic ?? 0;
            const matchSecondaryKeys = (): boolean => {
                let hasAnyMatch = false;
                let hasAllMatch = true;
                const matchedSecondaryKeys: string[] = [];
                for (const keysecondary of entry.keysecondary!) {
                    const secondarySubstituted = substitute(keysecondary);
                    const hasSecondaryMatch = secondarySubstituted && buffer.matchKeys(textToScan, secondarySubstituted.trim(), entry);

                    if (hasSecondaryMatch) hasAnyMatch = true;
                    if (!hasSecondaryMatch) hasAllMatch = false;
                    if (hasSecondaryMatch) {
                        matchedSecondaryKeys.push(secondarySubstituted.trim());
                    }

                    if (selectiveLogic === world_info_logic.AND_ANY && hasSecondaryMatch) {
                        recordActivationAttempt(entry, 'key_match', withRecursionTraceSources({
                            primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                            sourceHints: matchSourceHints,
                            selectiveLogic: 'AND_ANY',
                            matchedSecondaryKeys,
                        }));
                        return true;
                    }
                    if (selectiveLogic === world_info_logic.NOT_ALL && !hasSecondaryMatch) {
                        recordActivationAttempt(entry, 'key_match', withRecursionTraceSources({
                            primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                            sourceHints: matchSourceHints,
                            selectiveLogic: 'NOT_ALL',
                            matchedSecondaryKeys,
                        }));
                        return true;
                    }
                }

                if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) {
                    recordActivationAttempt(entry, 'key_match', withRecursionTraceSources({
                        primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                        sourceHints: matchSourceHints,
                        selectiveLogic: 'NOT_ANY',
                        matchedSecondaryKeys: [],
                    }));
                    return true;
                }

                if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) {
                    recordActivationAttempt(entry, 'key_match', withRecursionTraceSources({
                        primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                        sourceHints: matchSourceHints,
                        selectiveLogic: 'AND_ALL',
                        matchedSecondaryKeys: entry.keysecondary!.map(x => String(substitute(x) || x || '').trim()).filter(Boolean),
                    }));
                    return true;
                }

                return false;
            };

            const matched = matchSecondaryKeys();
            if (!matched) {
                recordActivationAttempt(entry, 'secondary_key_miss', withRecursionTraceSources({
                    primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                    sourceHints: matchSourceHints,
                    selectiveLogic: Object.entries(world_info_logic).find(x => x[1] === selectiveLogic)?.[0] || String(selectiveLogic),
                    secondaryKeys: entry.keysecondary!.map(x => String(substitute(x) || x || '').trim()).filter(Boolean),
                }));
                continue;
            }

            activatedNow.add(entry);
        }

        // Sort for the probability and budget limit checks
        let newEntries: WIEntry[];
        if (activatedNow.size > 1) {
            const sortedEntriesIndex = new Map(sortedEntries.map((entry, index) => [entry, index]));
            newEntries = [...activatedNow]
                .sort((a, b) => {
                    const isASticky = timedEffects.isEffectActive('sticky', a) ? 1 : 0;
                    const isBSticky = timedEffects.isEffectActive('sticky', b) ? 1 : 0;
                    return isBSticky - isASticky
                        || (sortedEntriesIndex.get(a) ?? -1) - (sortedEntriesIndex.get(b) ?? -1);
                });
        } else {
            newEntries = [...activatedNow];
        }

        let newContent = '';
        const textToScanTokens = await countTokens(allActivatedText);
        const entriesBeforeGroupFilter = [...newEntries];
        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects, settings, rng);
        for (const groupedOutEntry of entriesBeforeGroupFilter) {
            if (!newEntries.includes(groupedOutEntry)) {
                recordActivationAttempt(groupedOutEntry, 'inclusion_group_filtered', withRecursionTraceSources({
                    group: String(groupedOutEntry.group || ''),
                }));
            }
        }

        let ignoresBudget = newEntries.filter(e => e.ignoreBudget).length;

        for (const entry of newEntries) {
            ignoresBudget -= (entry.ignoreBudget ? 1 : 0);
            if (tokenBudgetOverflowed && !entry.ignoreBudget) {
                if (ignoresBudget > 0) {
                    continue;
                }
                break;
            }

            const verifyProbability = (): boolean => {
                if (!entry.useProbability || entry.probability === 100) {
                    return true;
                }
                const isSticky = timedEffects.isEffectActive('sticky', entry);
                if (isSticky) {
                    return true;
                }
                const rollValue = rng() * 100;
                if (rollValue <= (entry.probability ?? 100)) {
                    return true;
                }
                failedProbabilityChecks.add(entry);
                return false;
            };

            const success = verifyProbability();
            if (!success) {
                recordActivationAttempt(entry, 'probability_failed', withRecursionTraceSources({
                    useProbability: Boolean(entry.useProbability),
                    probability: Number(entry.probability ?? 100),
                }));
                continue;
            }

            // Substitute macros inline (see original note re: \{{...}} escapes)
            entry.content = substitute(entry.content ?? '');
            newContent += `${entry.content}\n`;

            if (!entry.ignoreBudget && (textToScanTokens + (await countTokens(newContent))) >= budget) {
                if (!tokenBudgetOverflowed) {
                    if (ctx.onBudgetOverflow) {
                        ctx.onBudgetOverflow(budget, allActivatedEntries.size);
                    }
                    tokenBudgetOverflowed = true;
                }
                recordActivationAttempt(entry, 'budget_overflow', withRecursionTraceSources({
                    budget: Number(budget),
                    ignoreBudget: Boolean(entry.ignoreBudget),
                }));
                continue;
            }

            allActivatedEntries.set(`${entry.world}.${entry.uid}`, entry);
            recordActivationSuccess(entry, withRecursionTraceSources({
                reason: 'added_to_prompt',
                ignoreBudget: Boolean(entry.ignoreBudget),
                useProbability: Boolean(entry.useProbability),
                probability: Number(entry.probability ?? 100),
            }));
        }

        const successfulNewEntries = newEntries.filter(x => !failedProbabilityChecks.has(x));
        const successfulNewEntriesForRecursion = successfulNewEntries.filter(x => !x.preventRecursion);

        // Normal recursion
        if (settings.worldInfoRecursive && !tokenBudgetOverflowed && successfulNewEntriesForRecursion.length) {
            nextScanState = scan_state.RECURSION;
        }

        // Min-activations run followed by a recursive scan on the recurse buffer
        if (settings.worldInfoRecursive && !tokenBudgetOverflowed && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse()) {
            nextScanState = scan_state.RECURSION;
        }

        // Min activations not satisfied → advance depth and scan again
        const minActivationsNotSatisfied = settings.worldInfoMinActivations > 0 && (allActivatedEntries.size < settings.worldInfoMinActivations);
        if (!nextScanState && !tokenBudgetOverflowed && minActivationsNotSatisfied) {
            const overMax = (
                settings.worldInfoMinActivationsDepthMax > 0 &&
                buffer.getDepth() > settings.worldInfoMinActivationsDepthMax
            ) || (buffer.getDepth() > chat.length);

            if (!overMax) {
                nextScanState = scan_state.MIN_ACTIVATIONS;
                buffer.advanceScan();
            }
        }

        // Open "delay until recursion" levels continue with the next one
        if (nextScanState === scan_state.NONE && availableRecursionDelayLevels.length) {
            nextScanState = scan_state.RECURSION;
            currentRecursionDelayLevel = availableRecursionDelayLevels.shift()!;
        }

        const curScanState = scanState;
        scanState = nextScanState;
        if (scanState) {
            const text = successfulNewEntriesForRecursion
                .map(x => x.content).join('\n');
            if (text) {
                buffer.addRecurse(text);
                allActivatedText = (text + '\n' + allActivatedText);
            }
            if (scanState === scan_state.RECURSION) {
                recursionSourceEntryKeys = successfulNewEntriesForRecursion.map(entry => makeTraceKey(entry));
            } else {
                recursionSourceEntryKeys = [];
            }
        } else {
            recursionSourceEntryKeys = [];
        }

        // WORLDINFO_SCAN_DONE event — listeners may mutate args like the original
        const args: WIScanDoneArgs = {
            state: {
                current: curScanState,
                next: scanState,
                loopCount: count,
            },
            new: {
                all: newEntries,
                successful: successfulNewEntries,
            },
            activated: {
                entries: allActivatedEntries,
                text: allActivatedText,
            },
            sortedEntries,
            recursionDelay: {
                availableLevels: availableRecursionDelayLevels,
                currentLevel: currentRecursionDelayLevel,
            },
            budget: {
                current: budget,
                overflowed: tokenBudgetOverflowed,
            },
            timedEffects,
        };
        await ctx.onScanDone?.(args);

        if (args.state.next !== scanState) {
            scanState = args.state.next;
        }
        allActivatedText = args.activated.text;
        currentRecursionDelayLevel = args.recursionDelay.currentLevel;
        budget = args.budget.current;
        tokenBudgetOverflowed = args.budget.overflowed;
    }

    // --- BUILDING PROMPT ---
    const WIBeforeEntries: string[] = [];
    const WIAfterEntries: string[] = [];
    const EMEntries: { position: number; content: string }[] = [];
    const ANTopEntries: string[] = [];
    const ANBottomEntries: string[] = [];
    const WIDepthEntries: { depth: number; entries: string[]; role: number }[] = [];
    const WIOutletEntries: Record<string, string[]> = {};

    // Appends from insertion order 999 to 1. Use unshift for this purpose.
    [...allActivatedEntries.values()].sort(sortFn).forEach((entry) => {
        const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
        const content = applyRegex(entry.content ?? '', { depth: regexDepth, role: entry.role ?? 0 });

        if (!content) {
            return;
        }

        switch (entry.position) {
            case world_info_position.before:
                WIBeforeEntries.unshift(content);
                break;
            case world_info_position.after:
                WIAfterEntries.unshift(content);
                break;
            case world_info_position.EMTop:
                EMEntries.unshift({ position: wi_anchor_position.before, content });
                break;
            case world_info_position.EMBottom:
                EMEntries.unshift({ position: wi_anchor_position.after, content });
                break;
            case world_info_position.ANTop:
                ANTopEntries.unshift(content);
                break;
            case world_info_position.ANBottom:
                ANBottomEntries.unshift(content);
                break;
            case world_info_position.atDepth: {
                const role = entry.role ?? 0;
                const existingDepthIndex = WIDepthEntries.findIndex((e) => e.depth === (entry.depth ?? DEFAULT_DEPTH) && e.role === role);
                if (existingDepthIndex !== -1) {
                    WIDepthEntries[existingDepthIndex]!.entries.unshift(content);
                } else {
                    WIDepthEntries.push({
                        depth: entry.depth ?? DEFAULT_DEPTH,
                        entries: [content],
                        role,
                    });
                }
                break;
            }
            case world_info_position.outlet: {
                if (!entry.outletName) {
                    break;
                }
                if (Array.isArray(WIOutletEntries[entry.outletName])) {
                    WIOutletEntries[entry.outletName]!.push(content);
                } else {
                    WIOutletEntries[entry.outletName] = [content];
                }
                break;
            }
            default:
                break;
        }
    });

    // NOTE: the original merges ANTop/ANBottom into the Author's Note
    // extension prompt here via context.setExtensionPrompt. In core the
    // caller merges ANBeforeEntries/ANAfterEntries into its AN slot —
    // see prompt assembly (TASK-006).

    timedEffects.setTimedEffects(Array.from(allActivatedEntries.values()));
    buffer.resetExternalEffects();
    timedEffects.cleanUp();

    return {
        worldInfoBeforeEntries: [...WIBeforeEntries],
        worldInfoAfterEntries: [...WIAfterEntries],
        worldInfoBefore: WIBeforeEntries.length ? WIBeforeEntries.join('\n') : '',
        worldInfoAfter: WIAfterEntries.length ? WIAfterEntries.join('\n') : '',
        EMEntries,
        WIDepthEntries,
        ANBeforeEntries: ANTopEntries,
        ANAfterEntries: ANBottomEntries,
        outletEntries: WIOutletEntries,
        allActivatedEntries: new Set(allActivatedEntries.values()),
    };
}
