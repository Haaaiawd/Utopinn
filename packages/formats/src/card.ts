// card.ts — CCv1/v2/v3 卡面统一视图 + 常用访问器。
// v1:平铺字段(name/description/...);v2/v3:{spec,spec_version,data:{...}}。

export type CardSpec = 'chara_card_v1' | 'chara_card_v2' | 'chara_card_v3' | 'unknown';

export function detectSpec(card: Record<string, unknown>): CardSpec {
    if (card?.spec === 'chara_card_v3') return 'chara_card_v3';
    if (card?.spec === 'chara_card_v2') return 'chara_card_v2';
    if (card && typeof card === 'object' && 'name' in card && !('data' in card)) return 'chara_card_v1';
    return 'unknown';
}

/** 统一拿到 data 层(v1 平铺 → 伪 data;v2/v3 → card.data)。 */
export function cardData(card: Record<string, any>): Record<string, any> {
    return card?.data && typeof card.data === 'object' ? card.data : card;
}

export function getEmbeddedBook(card: Record<string, any>): Record<string, any> | null {
    const book = cardData(card)?.character_book;
    return book && typeof book === 'object' ? book : null;
}

export function getBoundWorldName(card: Record<string, any>): string | null {
    const w = cardData(card)?.extensions?.world;
    return typeof w === 'string' && w.trim() ? w : null;
}

export function getCardName(card: Record<string, any>): string {
    return cardData(card)?.name ?? '';
}

/** JSON 卡导入:v1 平铺 → v2 包装的最小转换(对齐 ST 读入时的升格行为)。 */
export function toV2(card: Record<string, any>): Record<string, any> {
    const spec = detectSpec(card);
    if (spec === 'chara_card_v2' || spec === 'chara_card_v3') return card;
    const d = { ...card };
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: d.name ?? '',
            description: d.description ?? '',
            personality: d.personality ?? '',
            scenario: d.scenario ?? '',
            first_mes: d.first_mes ?? '',
            mes_example: d.mes_example ?? '',
            creator_notes: d.creator_notes ?? '',
            system_prompt: d.system_prompt ?? '',
            post_history_instructions: d.post_history_instructions ?? '',
            tags: Array.isArray(d.tags) ? d.tags : [],
            creator: d.creator ?? '',
            character_version: d.character_version ?? '',
            alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
            extensions: typeof d.extensions === 'object' && d.extensions ? d.extensions : {},
            ...(d.character_book ? { character_book: d.character_book } : {}),
        },
    };
}

/**
 * WI 条目模板 — `newWorldInfoEntryTemplate` 的字段序副本。
 * 字段顺序有兼容性含义:getSortedEntries 对条目做
 * `getStringHash(JSON.stringify(entry))` 算 hash,hash 会持久化进
 * chat_metadata.timedWorldInfo(sticky/cooldown 迁移兼容全靠它)。
 */
export const WI_ENTRY_TEMPLATE_ORDERED: Record<string, unknown> = {
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
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
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
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

/**
 * `world-info.js convertCharacterBook` 移植:CCv2 `character_book` →
 * 酒馆 WI 文件 `{entries:{uid:entry}}` 格式。先铺开模板再覆盖,
 * 字段序与原版逐项一致(见 WI_ENTRY_TEMPLATE_ORDERED 注释)。
 */
export function convertCharacterBook(characterBook: Record<string, any>): { entries: Record<string, Record<string, any>>; originalData: Record<string, any> } {
    const result: { entries: Record<string, Record<string, any>>; originalData: Record<string, any> } = {
        entries: {},
        originalData: characterBook,
    };

    (characterBook.entries ?? []).forEach((entry: Record<string, any>, index: number) => {
        if (entry.id === undefined) {
            entry.id = index;
        }
        if (entry.uid === undefined) {
            entry.uid = entry.id;
        }
        const x = entry.extensions ?? {};
        result.entries[entry.id] = {
            ...WI_ENTRY_TEMPLATE_ORDERED,
            uid: entry.id,
            key: entry.keys,
            keysecondary: entry.secondary_keys || [],
            comment: entry.comment || '',
            content: entry.content,
            constant: entry.constant || false,
            selective: entry.selective || false,
            order: entry.insertion_order,
            position: x.position ?? (entry.position === 'before_char' ? 0 : 1),
            excludeRecursion: x.exclude_recursion ?? false,
            preventRecursion: x.prevent_recursion ?? false,
            delayUntilRecursion: x.delay_until_recursion ?? false,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            displayIndex: x.display_index ?? index,
            probability: x.probability ?? 100,
            useProbability: x.useProbability ?? true,
            depth: x.depth ?? 4,
            selectiveLogic: x.selectiveLogic ?? 0,
            outletName: x.outlet_name ?? '',
            group: x.group ?? '',
            groupOverride: x.group_override ?? false,
            groupWeight: x.group_weight ?? 100,
            scanDepth: x.scan_depth ?? null,
            caseSensitive: x.case_sensitive ?? null,
            matchWholeWords: x.match_whole_words ?? null,
            useGroupScoring: x.use_group_scoring ?? null,
            automationId: x.automation_id ?? '',
            role: x.role ?? 0,
            vectorized: x.vectorized ?? false,
            sticky: x.sticky ?? null,
            cooldown: x.cooldown ?? null,
            delay: x.delay ?? null,
            matchPersonaDescription: x.match_persona_description ?? false,
            matchCharacterDescription: x.match_character_description ?? false,
            matchCharacterPersonality: x.match_character_personality ?? false,
            matchCharacterDepthPrompt: x.match_character_depth_prompt ?? false,
            matchScenario: x.match_scenario ?? false,
            matchCreatorNotes: x.match_creator_notes ?? false,
            extensions: entry.extensions ?? {},
            triggers: x.triggers || [],
            ignoreBudget: x.ignore_budget ?? false,
        };
    });

    return result;
}
