import type { TimedEffectType, WIChatMetadata, WIEntry, WITimedEffect } from './types.js';

/**
 * Timed effects manager for World Info (sticky/cooldown/delay).
 * Ported from `world-info.js class WorldInfoTimedEffects`.
 * Reads and mutates `chatMetadata.timedWorldInfo` — persistence is the caller's job.
 */
export class WorldInfoTimedEffects {
    #chat: string[];
    #entries: WIEntry[];
    #isDryRun: boolean;
    #chatMetadata: WIChatMetadata;
    #buffer: Record<TimedEffectType, WIEntry[]> = {
        sticky: [],
        cooldown: [],
        delay: [],
    };
    #onEnded: Record<TimedEffectType, (entry: WIEntry) => void>;

    constructor(chat: string[], entries: WIEntry[], chatMetadata: WIChatMetadata, isDryRun = false) {
        this.#chat = chat;
        this.#entries = entries;
        this.#isDryRun = isDryRun;
        this.#chatMetadata = chatMetadata;
        this.#ensureChatMetadata();

        this.#onEnded = {
            sticky: (entry) => {
                if (!entry.cooldown) {
                    return;
                }
                const key = this.#getEntryKey(entry);
                const effect = this.#getEntryTimedEffect('cooldown', entry, true);
                this.#chatMetadata.timedWorldInfo!.cooldown![key] = effect;
                this.#buffer.cooldown.push(entry);
            },
            cooldown: () => { },
            delay: () => { },
        };
    }

    #ensureChatMetadata(): void {
        const meta = this.#chatMetadata;
        if (!meta.timedWorldInfo) {
            meta.timedWorldInfo = {};
        }
        (['sticky', 'cooldown'] as const).forEach(type => {
            const bucket = meta.timedWorldInfo![type];
            if (!bucket || typeof bucket !== 'object') {
                meta.timedWorldInfo![type] = {};
            }
            Object.entries(meta.timedWorldInfo![type]!).forEach(([key, value]) => {
                if (!value || typeof value !== 'object') {
                    delete meta.timedWorldInfo![type]![key];
                }
            });
        });
    }

    #getEntryHash(entry: WIEntry): number | undefined {
        return entry.hash;
    }

    #getEntryKey(entry: WIEntry): string {
        return `${entry.world}.${entry.uid}`;
    }

    #getEntryTimedEffect(type: 'sticky' | 'cooldown', entry: WIEntry, isProtected: boolean): WITimedEffect {
        return {
            hash: this.#getEntryHash(entry)!,
            start: this.#chat.length,
            end: this.#chat.length + Number(entry[type]),
            protected: !!isProtected,
        };
    }

    #checkTimedEffectOfType(type: 'sticky' | 'cooldown', buffer: WIEntry[], onEnded: (entry: WIEntry) => void): void {
        const effects = Object.entries(this.#chatMetadata.timedWorldInfo![type] ?? {});
        for (const [key, value] of effects) {
            const entry = this.#entries.find(x => String(this.#getEntryHash(x)) === String(value.hash));

            if (this.#chat.length <= Number(value.start) && !value.protected) {
                delete this.#chatMetadata.timedWorldInfo![type]![key];
                continue;
            }

            // Missing entries (could be from another character's lorebook)
            if (!entry) {
                if (this.#chat.length >= Number(value.end)) {
                    delete this.#chatMetadata.timedWorldInfo![type]![key];
                }
                continue;
            }

            if (!entry[type]) {
                delete this.#chatMetadata.timedWorldInfo![type]![key];
                continue;
            }

            if (this.#chat.length >= Number(value.end)) {
                delete this.#chatMetadata.timedWorldInfo![type]![key];
                if (typeof onEnded === 'function') {
                    onEnded(entry);
                }
                continue;
            }

            buffer.push(entry);
        }
    }

    #checkDelayEffect(buffer: WIEntry[]): void {
        for (const entry of this.#entries) {
            if (!entry.delay) {
                continue;
            }
            if (this.#chat.length < entry.delay) {
                buffer.push(entry);
            }
        }
    }

    /** Checks for timed effects on chat messages. */
    checkTimedEffects(): void {
        if (!this.#isDryRun) {
            this.#checkTimedEffectOfType('sticky', this.#buffer.sticky, this.#onEnded.sticky.bind(this));
            this.#checkTimedEffectOfType('cooldown', this.#buffer.cooldown, this.#onEnded.cooldown.bind(this));
        }
        this.#checkDelayEffect(this.#buffer.delay);
    }

    /** Raw timed effect metadatum for a WI entry. */
    getEffectMetadata(type: TimedEffectType, entry: WIEntry): WITimedEffect | null {
        if (!this.isValidEffectType(type)) {
            return null;
        }
        const key = this.#getEntryKey(entry);
        return this.#chatMetadata.timedWorldInfo?.[type as 'sticky' | 'cooldown']?.[key] ?? null;
    }

    #setTimedEffectOfType(type: 'sticky' | 'cooldown', entry: WIEntry): void {
        if (!entry[type]) {
            return;
        }
        const key = this.#getEntryKey(entry);
        const bucket = this.#chatMetadata.timedWorldInfo![type]!;
        if (!bucket[key]) {
            bucket[key] = this.#getEntryTimedEffect(type, entry, false);
        }
    }

    /** Sets timed effects on the entries that were activated. */
    setTimedEffects(activatedEntries: WIEntry[]): void {
        if (this.#isDryRun) return;
        for (const entry of activatedEntries) {
            this.#setTimedEffectOfType('sticky', entry);
            this.#setTimedEffectOfType('cooldown', entry);
        }
    }

    /** Force set a timed effect for a WI entry. */
    setTimedEffect(type: TimedEffectType, entry: WIEntry, newState: boolean): void {
        if (!this.isValidEffectType(type)) {
            return;
        }
        if (this.#isDryRun && type !== 'delay') {
            return;
        }

        const key = this.#getEntryKey(entry);
        if (type !== 'delay') {
            delete this.#chatMetadata.timedWorldInfo![type]![key];
        }

        if (newState && type !== 'delay') {
            this.#chatMetadata.timedWorldInfo![type]![key] = this.#getEntryTimedEffect(type, entry, false);
        }
    }

    isValidEffectType(type: string): type is TimedEffectType {
        return typeof type === 'string' && ['sticky', 'cooldown', 'delay'].includes(type.trim().toLowerCase());
    }

    /** Whether the given timed effect is currently active on the entry. */
    isEffectActive(type: TimedEffectType, entry: WIEntry): boolean {
        if (!this.isValidEffectType(type)) {
            return false;
        }
        return this.#buffer[type]?.some(x => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false;
    }

    cleanUp(): void {
        for (const buffer of Object.values(this.#buffer)) {
            buffer.splice(0, buffer.length);
        }
    }
}
