/**
 * WI 条目编辑原语 — 移植自 ref/Luker public/scripts/world-info.js:
 * newWorldInfoEntryDefinition / originalWIDataKeyMap /
 * setWIOriginalDataValue / getFreeWorldEntryUid / createWorldInfoEntry。
 *
 * 这批是纯数据结构操作,被 stscript WI 族命令(/getentryfield
 * /setentryfield /createentry /findentry 的字段校验)消费。
 * 键名/默认值/类型与磁盘线格式同构,golden-diff 逐字段对拍。
 */
import { setValueByPath } from '../utils.js';
import { GENERATION_TYPE_TRIGGERS, newWorldInfoEntryTemplate, world_info_logic, DEFAULT_DEPTH, DEFAULT_WEIGHT } from './types.js';

export interface WIFieldDefinition {
    default: unknown;
    type: string;
    excludeFromTemplate?: boolean;
    arrayFilter?: (value: unknown) => boolean;
}

/**
 * `newWorldInfoEntryDefinition` — /setentryfield /getentryfield 的字段白名单
 * 与类型折算表。'array'/'boolean'/'number'/'number?'/'boolean?'/'enum'/'string'
 * 类型标签仅用于校验语义展示,实际折算按 default 值形态(上游同款:
 * Array.isArray → parseStringArray、boolean → isTrueBoolean、number → Number)。
 */
export const newWorldInfoEntryDefinition: Record<string, WIFieldDefinition> = {
    key: { default: [], type: 'array' },
    keysecondary: { default: [], type: 'array' },
    comment: { default: '', type: 'string' },
    content: { default: '', type: 'string' },
    constant: { default: false, type: 'boolean' },
    vectorized: { default: false, type: 'boolean' },
    selective: { default: true, type: 'boolean' },
    selectiveLogic: { default: world_info_logic.AND_ANY, type: 'enum' },
    addMemo: { default: false, type: 'boolean' },
    order: { default: 100, type: 'number' },
    position: { default: 0, type: 'number' },
    disable: { default: false, type: 'boolean' },
    ignoreBudget: { default: false, type: 'boolean' },
    excludeRecursion: { default: false, type: 'boolean' },
    preventRecursion: { default: false, type: 'boolean' },
    matchPersonaDescription: { default: false, type: 'boolean' },
    matchCharacterDescription: { default: false, type: 'boolean' },
    matchCharacterPersonality: { default: false, type: 'boolean' },
    matchCharacterDepthPrompt: { default: false, type: 'boolean' },
    matchScenario: { default: false, type: 'boolean' },
    matchCreatorNotes: { default: false, type: 'boolean' },
    delayUntilRecursion: { default: 0, type: 'number' },
    probability: { default: 100, type: 'number' },
    useProbability: { default: true, type: 'boolean' },
    depth: { default: DEFAULT_DEPTH, type: 'number' },
    outletName: { default: '', type: 'string' },
    group: { default: '', type: 'string' },
    groupOverride: { default: false, type: 'boolean' },
    groupWeight: { default: DEFAULT_WEIGHT, type: 'number' },
    scanDepth: { default: null, type: 'number?' },
    caseSensitive: { default: null, type: 'boolean?' },
    matchWholeWords: { default: null, type: 'boolean?' },
    useGroupScoring: { default: null, type: 'boolean?' },
    automationId: { default: '', type: 'string' },
    role: { default: 0, type: 'enum' },
    sticky: { default: null, type: 'number?' },
    cooldown: { default: null, type: 'number?' },
    delay: { default: null, type: 'number?' },
    characterFilterNames: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterTags: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterExclude: { default: false, type: 'boolean', excludeFromTemplate: true },
    triggers: { default: [], type: 'array', arrayFilter: (value) => (GENERATION_TYPE_TRIGGERS as readonly string[]).includes(String(value)) },
};

/**
 * `originalWIDataKeyMap` — entry 字段 → originalData.entries[] 内的
 * 原始(导入源)路径。/setentryfield 改完新形态字段后同步原始层,
 * 使导出的世界书保留原始形态。
 */
export const originalWIDataKeyMap: Record<string, string> = {
    'displayIndex': 'extensions.display_index',
    'excludeRecursion': 'extensions.exclude_recursion',
    'preventRecursion': 'extensions.prevent_recursion',
    'delayUntilRecursion': 'extensions.delay_until_recursion',
    'selectiveLogic': 'selectiveLogic',
    'comment': 'comment',
    'constant': 'constant',
    'order': 'insertion_order',
    'depth': 'extensions.depth',
    'probability': 'extensions.probability',
    'position': 'extensions.position',
    'role': 'extensions.role',
    'outletName': 'extensions.outlet_name',
    'content': 'content',
    'enabled': 'enabled',
    'key': 'keys',
    'keysecondary': 'secondary_keys',
    'selective': 'selective',
    'matchWholeWords': 'extensions.match_whole_words',
    'useGroupScoring': 'extensions.use_group_scoring',
    'caseSensitive': 'extensions.case_sensitive',
    'matchPersonaDescription': 'extensions.match_persona_description',
    'matchCharacterDescription': 'extensions.match_character_description',
    'matchCharacterPersonality': 'extensions.match_character_personality',
    'matchCharacterDepthPrompt': 'extensions.match_character_depth_prompt',
    'matchScenario': 'extensions.match_scenario',
    'matchCreatorNotes': 'extensions.match_creator_notes',
    'scanDepth': 'extensions.scan_depth',
    'automationId': 'extensions.automation_id',
    'vectorized': 'extensions.vectorized',
    'group': 'extensions.group',
    'groupOverride': 'extensions.group_override',
    'groupWeight': 'extensions.group_weight',
    'sticky': 'extensions.sticky',
    'cooldown': 'extensions.cooldown',
    'delay': 'extensions.delay',
    'triggers': 'extensions.triggers',
    'ignoreBudget': 'extensions.ignore_budget',
};

/** `setWIOriginalDataValue` — 同步 originalData.entries 原始层(uid 宽松相等)。 */
export function setWIOriginalDataValue(data: Record<string, unknown>, uid: number | string, key: string, value: unknown): void {
    const originalData = data['originalData'] as { entries?: { uid?: number | string }[] } | undefined;
    if (originalData && Array.isArray(originalData.entries)) {
        const originalEntry = originalData.entries.find(x => x.uid === uid);
        if (!originalEntry) {
            return;
        }
        setValueByPath(originalEntry as Record<string, unknown>, key, value);
    }
}

/** `getFreeWorldEntryUid` — 0..999999 首个空 uid;满 → null。 */
export function getFreeWorldEntryUid(data: { entries?: Record<string | number, unknown> } | null): number | null {
    if (!data || !('entries' in data) || !data.entries) {
        return null;
    }
    const MAX_UID = 1_000_000;
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (uid in data.entries) {
            continue;
        }
        return uid;
    }
    return null;
}

/**
 * `createWorldInfoEntry` — 从 template 建空条目落进 data.entries。
 * 返回新条目(含分配到的 uid);失败 → undefined(上游同形)。
 */
export function createWorldInfoEntry(_name: string, data: { entries: Record<string | number, Record<string, unknown>> }): Record<string, unknown> | undefined {
    const newUid = getFreeWorldEntryUid(data);
    if (!Number.isInteger(newUid)) {
        console.error('Couldn\'t assign UID to a new entry');
        return undefined;
    }
    const newEntry = { uid: newUid, ...structuredClone(newWorldInfoEntryTemplate) };
    data.entries[newUid!] = newEntry;
    return newEntry;
}
