/**
 * `substituteParams` (legacy path) — ported from `script.js substituteParamsLegacy`.
 * Builds the macro env from a substituted context, then runs evaluateMacros.
 * The experimental macro engine is intentionally NOT ported (feature flag off
 * by default; goldens were captured on the legacy path).
 */
import { evaluateMacros, type MacroContext, type MacroEnv } from './evaluate.js';

export interface CharacterCardFields {
    system?: string;
    mesExamples?: string;
    description?: string;
    personality?: string;
    persona?: string;
    scenario?: string;
    jailbreak?: string;
    version?: string;
    charDepthPrompt?: string;
    creatorNotes?: string;
    firstMessage?: string;
    alternateGreetings?: string[];
}

export interface SubstituteContext extends MacroContext {
    /** {{user}} default value. */
    name1?: string;
    /** {{char}} default value. */
    name2?: string;
    /** Group chat state for {{group}}/{{notChar}}. */
    groups?: { id: string; members?: string[]; disabled_members?: string[] }[];
    selectedGroup?: string | null;
    /** character avatar → display name resolution for group member names. */
    characterNameForAvatar?: (avatar: string) => string;
    /** Character card fields (from getCharacterCardFields). */
    cardFields?: CharacterCardFields;
    /** {{model}} — current generating model name. */
    model?: string;
    /** main_api value — mesExamples block-heading rule depends on it. */
    mainApi?: string;
    /**
     * Instruct-mode example formatter (`formatInstructModeExamples` port —
     * injected until the instruct engine lands in TASK-006).
     */
    formatInstructExamples?: (examples: string[], name1: string, name2: string) => string[];
}

export interface SubstituteOptions {
    name1Override?: string;
    name2Override?: string;
    original?: string;
    groupOverride?: string;
    replaceCharacterCard?: boolean;
    dynamicMacros?: MacroEnv;
    postProcessFn?: (x: string) => string;
}

/** `parseMesExamples` port — split on <START>, prepend block heading. */
export function parseMesExamples(examplesStr: string, isInstruct: boolean, ctx: SubstituteContext): string[] {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') {
        return [];
    }
    if (!examplesStr.startsWith('<START>')) {
        examplesStr = '<START>\n' + examplesStr.trim();
    }
    const exampleSeparator = ctx.contextTemplate?.example_separator
        ? `${substituteParams(ctx.contextTemplate.example_separator, ctx)}\n`
        : '';
    const blockHeading = (ctx.mainApi === 'openai' || isInstruct) ? '<START>\n' : exampleSeparator;
    return examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);
}

/**
 * Legacy `substituteParams` — evaluates {{macros}} against the given context.
 */
export function substituteParams(
    content: string,
    ctx: SubstituteContext,
    options: SubstituteOptions = {},
): string {
    if (!content) {
        return '';
    }
    if (typeof content !== 'string') {
        // 上游 script.js:2985 — 非串入参 warn 后强转(audit L4)。
        console.warn('substituteParams: content will be coerced to string', content);
        content = String(content);
    }

    const environment: MacroEnv = {};
    const _name1 = options.name1Override ?? ctx.name1 ?? '';
    const _name2 = options.name2Override ?? ctx.name2 ?? '';
    const _original = options.original;
    const _group = options.groupOverride;
    const _replaceCharacterCard = options.replaceCharacterCard ?? true;

    if (typeof _original === 'string') {
        let originalSubstituted = false;
        environment.original = () => {
            if (originalSubstituted) {
                return '';
            }
            originalSubstituted = true;
            return _original;
        };
    }

    const getGroupValue = (includeMuted: boolean): string => {
        if (typeof _group === 'string') {
            return _group;
        }
        if (ctx.selectedGroup) {
            const members = ctx.groups?.find(x => x.id === ctx.selectedGroup)?.members;
            const disabledMembers = ctx.groups?.find(x => x.id === ctx.selectedGroup)?.disabled_members ?? [];
            const isMuted = (x: string) => includeMuted ? true : !disabledMembers.includes(x);
            const names = Array.isArray(members)
                ? members.filter(isMuted).map(m => ctx.characterNameForAvatar?.(m) ?? '').filter(Boolean).join(', ')
                : '';
            return names;
        } else {
            return _name2;
        }
    };

    const getNotCharValue = (): string => {
        const currentUser = _name1;
        const currentSpeaker = _name2;
        if (!ctx.selectedGroup) {
            return currentUser;
        }
        const members = ctx.groups?.find(x => x.id === ctx.selectedGroup)?.members;
        if (!Array.isArray(members)) {
            return currentUser;
        }
        const memberNames = members
            .map(m => ctx.characterNameForAvatar?.(m) ?? '')
            .filter(Boolean);
        const otherMembers = memberNames.filter(name => name !== currentSpeaker);
        otherMembers.push(currentUser);
        return otherMembers.join(', ');
    };

    if (_replaceCharacterCard && ctx.cardFields) {
        const fields = ctx.cardFields;
        environment.charPrompt = fields.system || '';
        environment.charInstruction = environment.charJailbreak = fields.jailbreak || '';
        environment.description = fields.description || '';
        environment.personality = fields.personality || '';
        environment.scenario = fields.scenario || '';
        environment.persona = fields.persona || '';
        environment.mesExamples = () => {
            const isInstruct = !!ctx.instruct?.enabled && ctx.mainApi !== 'openai';
            const mesExamplesArray = parseMesExamples(fields.mesExamples ?? '', isInstruct, ctx);
            if (isInstruct && ctx.formatInstructExamples) {
                const instructExamples = ctx.formatInstructExamples(mesExamplesArray, _name1, _name2);
                return instructExamples.join('');
            }
            return mesExamplesArray.join('');
        };
        environment.mesExamplesRaw = fields.mesExamples || '';
        environment.charVersion = fields.version || '';
        environment.char_version = fields.version || '';
        environment.charDepthPrompt = fields.charDepthPrompt || '';
        environment.creatorNotes = fields.creatorNotes || '';
    }

    // Must be substituted last so that they're replaced inside {{description}}
    environment.user = _name1;
    environment.char = _name2;
    environment.group = environment.charIfNotGroup = getGroupValue(true);
    environment.groupNotMuted = getGroupValue(false);
    environment.notChar = getNotCharValue();
    environment.model = ctx.model ?? '';

    if (options.dynamicMacros && typeof options.dynamicMacros === 'object') {
        Object.assign(environment, options.dynamicMacros);
    }

    return evaluateMacros(content, environment, options.postProcessFn ?? ((x) => x), ctx);
}
