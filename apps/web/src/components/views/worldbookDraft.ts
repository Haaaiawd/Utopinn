/**
 * 世界书条目编辑草稿 —— 表单态 ↔ 条目字段的双向映射,纯逻辑层。
 * 无 React/DOM/浏览器依赖,apps/web/tests/worldbook-draft.test.mjs 用
 * node --test 直测。字段名与取值域对齐 ST 上游与 core WIEntry
 * (packages/core/src/world-info/types.ts):
 *   - selectiveLogic = world_info_logic  0 AND_ANY / 1 NOT_ALL / 2 NOT_ANY / 3 AND_ALL
 *   - position       = world_info_position 0 before / 1 after / 2 ANTop / 3 ANBottom
 *                      4 atDepth / 5 EMTop / 6 EMBottom / 7 outlet
 *   - role           = extension_prompt_roles 0 system / 1 user / 2 assistant(仅 atDepth)
 *   - sticky/cooldown/delay = number|null(引擎定时效果,'' 落 null = 关)
 * applyDraft 一律 {...entry, ...表单键}:表单不认识的扩展键原样透传
 * (生态卡带进来的 display_index、extensions.* 等不被吃掉)。
 */

/** 条目最小形状 —— 原档透传型,只声明编辑面会动的键。 */
export interface EntryLike {
    uid?: number;
    key?: string[];
    keysecondary?: string[];
    comment?: string;
    content?: string;
    constant?: boolean;
    selective?: boolean;
    selectiveLogic?: number;
    disable?: boolean;
    position?: number;
    depth?: number;
    role?: number;
    outletName?: string;
    order?: number;
    probability?: number;
    useProbability?: boolean;
    group?: string;
    groupWeight?: number;
    sticky?: number | null;
    cooldown?: number | null;
    delay?: number | null;
    [key: string]: unknown;
}

/** 表单态:数字/数组一律以字符串呈现(输入受控),apply 时归位类型。 */
export interface EntryDraft {
    comment: string;
    content: string;
    /** 逗号分隔串 ↔ key:string[] */
    key: string;
    /** 次级匹配总开关(引擎:entry.selective && keysecondary.length 才走次关键字)。 */
    selective: boolean;
    /** 逗号分隔串 ↔ keysecondary:string[] */
    keysecondary: string;
    /** world_info_logic '0'..'3' */
    selectiveLogic: string;
    /** 常驻:无需关键词命中即注入(ST constant)。 */
    constant: boolean;
    disable: boolean;
    /** world_info_position '0'..'7' */
    position: string;
    /** atDepth 注入深度(仅 position=4 生效;表单恒显值)。 */
    depth: string;
    /** atDepth 注入角色 '0' system / '1' user / '2' assistant。 */
    role: string;
    /** outlet 名(仅 position=7 生效)。 */
    outletName: string;
    order: string;
    probability: string;
    useProbability: boolean;
    group: string;
    groupWeight: string;
    /** 定时效果三键,'' → null(关)。 */
    sticky: string;
    cooldown: string;
    delay: string;
}

export const POSITION_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const LOGIC_OPTIONS = [0, 1, 2, 3] as const;
export const ROLE_OPTIONS = [0, 1, 2] as const;

const str = (v: unknown, fb = ''): string =>
    typeof v === 'string' ? v : v == null ? fb : String(v);

const joinKeys = (v: unknown): string =>
    Array.isArray(v) ? v.map((k) => String(k)).join(', ') : '';

/** 逗号分隔 → string[]:trim 每段、弃空段(与 ST 编辑器同约定)。 */
export function splitKeys(v: string): string[] {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 字符串 → int:空/NaN 落兜底(保证写回是 number,不吃类型)。 */
const intOf = (v: string, fb: number): number => {
    const t = v.trim();
    if (!t) return fb;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : fb;
};

/** 字符串 → number|null:空 → null;NaN 保原值(防一次手滑清掉合法数)。 */
const numOrNull = (v: string, fb: number | null | undefined): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : typeof fb === 'number' ? fb : null;
};

/** 条目 → 表单态(每次选条/保存成功后重建,作 dirty 基线)。 */
export function draftOf(e: EntryLike): EntryDraft {
    return {
        comment: str(e.comment),
        content: str(e.content),
        key: joinKeys(e.key),
        selective: e.selective === true,
        keysecondary: joinKeys(e.keysecondary),
        selectiveLogic: str(e.selectiveLogic ?? 0),
        constant: e.constant === true,
        disable: e.disable === true,
        position: str(e.position ?? 0),
        depth: str(e.depth ?? 4),
        role: str(e.role ?? 0),
        outletName: str(e.outletName),
        order: str(e.order ?? 100),
        probability: str(e.probability ?? 100),
        useProbability: e.useProbability !== false,
        group: str(e.group),
        groupWeight: str(e.groupWeight ?? 100),
        sticky: e.sticky == null ? '' : str(e.sticky),
        cooldown: e.cooldown == null ? '' : str(e.cooldown),
        delay: e.delay == null ? '' : str(e.delay),
    };
}

/** 表单态 + 原条目 → 写回条目(未覆盖键经展开原样保留)。 */
export function applyDraft(entry: EntryLike, d: EntryDraft): EntryLike {
    return {
        ...entry,
        comment: d.comment,
        content: d.content,
        key: splitKeys(d.key),
        keysecondary: splitKeys(d.keysecondary),
        selective: d.selective,
        selectiveLogic: intOf(d.selectiveLogic, entry.selectiveLogic ?? 0),
        constant: d.constant,
        disable: d.disable,
        position: intOf(d.position, entry.position ?? 0),
        depth: intOf(d.depth, entry.depth ?? 4),
        role: intOf(d.role, entry.role ?? 0),
        outletName: d.outletName,
        order: intOf(d.order, entry.order ?? 100),
        probability: intOf(d.probability, entry.probability ?? 100),
        useProbability: d.useProbability,
        group: d.group,
        groupWeight: intOf(d.groupWeight, entry.groupWeight ?? 100),
        sticky: numOrNull(d.sticky, entry.sticky),
        cooldown: numOrNull(d.cooldown, entry.cooldown),
        delay: numOrNull(d.delay, entry.delay),
    };
}

/** 表单态 vs 当前条目基线 —— 脏即「保存」点亮、离条提示。 */
export function draftDirty(entry: EntryLike, d: EntryDraft): boolean {
    return JSON.stringify(d) !== JSON.stringify(draftOf(entry));
}

/** ST 惯例:uid = 现有最大 uid + 1(键与 entry.uid 两源都扫,兼容散卡)。 */
export function nextUid(entries: Record<string, EntryLike>): number {
    let max = -1;
    for (const [k, e] of Object.entries(entries)) {
        const nk = Number(k);
        if (Number.isInteger(nk) && nk > max) max = nk;
        const nu = Number(e?.uid);
        if (Number.isInteger(nu) && nu > max) max = nu;
    }
    return max + 1;
}

/**
 * 新条目缺省 —— 镜像 core newWorldInfoEntryTemplate(types.ts L60-100),
 * 唯一偏离:disable: true(新建停用起步,写完手动点亮,半成品不注入)。
 */
export function newEntry(uid: number): EntryLike {
    return {
        uid,
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
        disable: true,
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
}
