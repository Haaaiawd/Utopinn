import { escapeRegex } from '../utils.js';
import { parseRegexFromString } from './regex.js';
import {
    MAX_SCAN_DEPTH,
    scan_state,
    world_info_logic,
    type ScanState,
    type WIEntry,
    type WIGlobalScanData,
} from './types.js';

/** WI global settings slice the buffer depends on. */
export interface WIBufferSettings {
    worldInfoDepth: number;
    worldInfoCaseSensitive: boolean;
    worldInfoMatchWholeWords: boolean;
}

export interface WIMatchSourceHint {
    source: string;
    depth?: number;
    index?: number;
}

/**
 * Scanning buffer for one evaluation of World Info.
 * Ported from `world-info.js class WorldInfoBuffer`.
 */
export class WorldInfoBuffer {
    /** Entries that need to be activated no matter what (`/world activate`-style). */
    static externalActivations = new Map<string, WIEntry>();

    #globalScanData: Required<WIGlobalScanData>;
    #depthBuffer: string[] = [];
    #recurseBuffer: string[] = [];
    #injectBuffer: string[] = [];
    #skew = 0;
    #startDepth = 0;
    #settings: WIBufferSettings;

    constructor(messages: string[], globalScanData: WIGlobalScanData, settings: WIBufferSettings) {
        this.#initDepthBuffer(messages);
        this.#globalScanData = {
            trigger: globalScanData.trigger ?? 'normal',
            personaDescription: globalScanData.personaDescription ?? '',
            characterDescription: globalScanData.characterDescription ?? '',
            characterPersonality: globalScanData.characterPersonality ?? '',
            characterDepthPrompt: globalScanData.characterDepthPrompt ?? '',
            scenario: globalScanData.scenario ?? '',
            creatorNotes: globalScanData.creatorNotes ?? '',
        };
        this.#settings = settings;
    }

    #initDepthBuffer(messages: string[]): void {
        for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
            const message = messages[depth];
            if (message) {
                this.#depthBuffer[depth] = message.trim();
            }
            if (depth === messages.length - 1) {
                break;
            }
        }
    }

    #transformString(str: string, entry: WIEntry): string {
        const caseSensitive = entry.caseSensitive ?? this.#settings.worldInfoCaseSensitive;
        return caseSensitive ? str : str.toLowerCase();
    }

    /**
     * Gets all messages up to the entry's scan depth + recursion buffer.
     */
    get(entry: WIEntry, scanState: ScanState): string {
        let depth = entry.scanDepth ?? this.getDepth();
        if (depth <= this.#startDepth) {
            return '';
        }

        if (depth < 0) {
            console.error(`[WI] Invalid WI scan depth ${depth}. Must be >= 0`);
            return '';
        }

        if (depth > MAX_SCAN_DEPTH) {
            console.warn(`[WI] Invalid WI scan depth ${depth}. Truncating to ${MAX_SCAN_DEPTH}`);
            depth = MAX_SCAN_DEPTH;
        }

        const MATCHER = '\x01';
        const JOINER = '\n' + MATCHER;
        let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);
        const g = this.#globalScanData;

        if (entry.matchPersonaDescription && g.personaDescription) {
            result += JOINER + g.personaDescription;
        }
        if (entry.matchCharacterDescription && g.characterDescription) {
            result += JOINER + g.characterDescription;
        }
        if (entry.matchCharacterPersonality && g.characterPersonality) {
            result += JOINER + g.characterPersonality;
        }
        if (entry.matchCharacterDepthPrompt && g.characterDepthPrompt) {
            result += JOINER + g.characterDepthPrompt;
        }
        if (entry.matchScenario && g.scenario) {
            result += JOINER + g.scenario;
        }
        if (entry.matchCreatorNotes && g.creatorNotes) {
            result += JOINER + g.creatorNotes;
        }

        if (this.#injectBuffer.length > 0) {
            result += JOINER + this.#injectBuffer.join(JOINER);
        }

        // Min activations should not include the recursion buffer
        if (this.#recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS) {
            result += JOINER + this.#recurseBuffer.join(JOINER);
        }

        return result;
    }

    /**
     * Matches a keyword/regex against the buffer text.
     */
    matchKeys(haystack: string, needle: string, entry: WIEntry): boolean {
        const keyRegex = parseRegexFromString(needle);
        if (keyRegex) {
            return keyRegex.test(haystack);
        }

        haystack = this.#transformString(haystack, entry);
        const transformedString = this.#transformString(needle, entry);
        const matchWholeWords = entry.matchWholeWords ?? this.#settings.worldInfoMatchWholeWords;

        if (matchWholeWords) {
            const keyWords = transformedString.split(/\s+/);
            if (keyWords.length > 1) {
                return haystack.includes(transformedString);
            } else {
                const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
                if (regex.test(haystack)) {
                    return true;
                }
            }
        } else {
            return haystack.includes(transformedString);
        }

        return false;
    }

    /**
     * Returns match source hints for a key (trace metadata).
     */
    getMatchSourceHints(entry: WIEntry, needle: string, scanState: ScanState): WIMatchSourceHint[] {
        const hints: WIMatchSourceHint[] = [];
        const key = String(needle || '').trim();
        if (!key) {
            return hints;
        }

        let depth = entry.scanDepth ?? this.getDepth();
        if (!Number.isFinite(depth)) {
            depth = this.getDepth();
        }
        depth = Math.max(0, Math.min(MAX_SCAN_DEPTH, Math.floor(depth)));

        for (let index = this.#startDepth; index < depth; index++) {
            const message = this.#depthBuffer[index];
            if (!message) {
                continue;
            }
            if (this.matchKeys(message, key, entry)) {
                hints.push({ source: 'chat_depth', depth: index + 1 });
            }
        }

        const g = this.#globalScanData;
        const globalMatchers: [string, boolean | undefined, string][] = [
            ['personaDescription', entry.matchPersonaDescription, g.personaDescription],
            ['characterDescription', entry.matchCharacterDescription, g.characterDescription],
            ['characterPersonality', entry.matchCharacterPersonality, g.characterPersonality],
            ['characterDepthPrompt', entry.matchCharacterDepthPrompt, g.characterDepthPrompt],
            ['scenario', entry.matchScenario, g.scenario],
            ['creatorNotes', entry.matchCreatorNotes, g.creatorNotes],
        ];
        for (const [name, enabled, text] of globalMatchers) {
            if (!enabled || !text) {
                continue;
            }
            if (this.matchKeys(text, key, entry)) {
                hints.push({ source: name });
            }
        }

        for (let index = 0; index < this.#injectBuffer.length; index++) {
            const text = this.#injectBuffer[index];
            if (!text) {
                continue;
            }
            if (this.matchKeys(text, key, entry)) {
                hints.push({ source: 'extension_inject', index: index + 1 });
            }
        }

        if (scanState !== scan_state.MIN_ACTIVATIONS) {
            for (let index = 0; index < this.#recurseBuffer.length; index++) {
                const text = this.#recurseBuffer[index];
                if (!text) {
                    continue;
                }
                if (this.matchKeys(text, key, entry)) {
                    hints.push({ source: 'wi_recursion', index: index + 1 });
                }
            }
        }

        if (hints.length === 0) {
            hints.push({ source: 'scan_buffer' });
        }
        return hints;
    }

    addRecurse(message: string): void {
        this.#recurseBuffer.push(message);
    }

    addInject(message: string): void {
        this.#injectBuffer.push(message);
    }

    hasRecurse(): boolean {
        return this.#recurseBuffer.length > 0;
    }

    /** Increments skew to advance the scan range (min-activations). */
    advanceScan(): void {
        this.#skew++;
    }

    /** Settings depth + current skew. */
    getDepth(): number {
        return this.#settings.worldInfoDepth + this.#skew;
    }

    /** Get the externally activated version of the entry, if there is one. */
    getExternallyActivated(entry: WIEntry): WIEntry | undefined {
        return WorldInfoBuffer.externalActivations.get(`${entry.world}.${entry.uid}`);
    }

    resetExternalEffects(): void {
        WorldInfoBuffer.externalActivations = new Map();
    }

    /**
     * Match score for group scoring: number of key activations.
     */
    getScore(entry: WIEntry, scanState: ScanState): number {
        const bufferState = this.get(entry, scanState);
        let numberOfPrimaryKeys = 0;
        let numberOfSecondaryKeys = 0;
        let primaryScore = 0;
        let secondaryScore = 0;

        if (Array.isArray(entry.key)) {
            numberOfPrimaryKeys = entry.key.length;
            for (const key of entry.key) {
                if (this.matchKeys(bufferState, key, entry)) {
                    primaryScore++;
                }
            }
        }

        if (Array.isArray(entry.keysecondary)) {
            numberOfSecondaryKeys = entry.keysecondary.length;
            for (const key of entry.keysecondary) {
                if (this.matchKeys(bufferState, key, entry)) {
                    secondaryScore++;
                }
            }
        }

        if (!numberOfPrimaryKeys) {
            return 0;
        }

        if (numberOfSecondaryKeys > 0) {
            switch (entry.selectiveLogic) {
                case world_info_logic.AND_ANY:
                    return primaryScore + secondaryScore;
                case world_info_logic.AND_ALL:
                    return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore;
            }
        }

        return primaryScore;
    }
}
