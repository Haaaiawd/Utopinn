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
