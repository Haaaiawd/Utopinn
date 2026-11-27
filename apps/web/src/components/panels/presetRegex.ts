// Preset-doc regex scripts —— 脚本本体是预设档数据(extensions.regex_scripts),
// 与调参同一条 doc 写路(宿主 onMutate → 防抖整档 PUT /presets/:name),
// 不走 /api/utopinn/regex 的 scripts 写面 —— 单通道无竞写。
// 放行闸 preset_allowed_regex 在 settings 不在档,组件侧 scoped GET/PUT 单独管。
// 本模块纯件:不碰网络、不碰 React,node --test 直接可测。
import type { PresetDocument } from '../../api/presets';
import type { RegexScriptData } from '../../api/regex';

/** doc.extensions 袋窄化 —— 非对象/数组 → 空袋(spread 安全)。 */
export const presetExtBag = (d: PresetDocument): Record<string, unknown> =>
    (d.extensions && typeof d.extensions === 'object' && !Array.isArray(d.extensions))
        ? (d.extensions as Record<string, unknown>) : {};

/** 档内 regex_scripts 读面 —— 非数组 → [];畸形非对象条目不渲(写时同过滤口径,
 *  JSON 视图兜底可见原始数组)。 */
export const presetRegexScripts = (doc: PresetDocument): RegexScriptData[] => {
    const arr = presetExtBag(doc).regex_scripts;
    return Array.isArray(arr)
        ? arr.filter((x): x is RegexScriptData => !!x && typeof x === 'object' && !Array.isArray(x))
        : [];
};

/** 脚本数组变换 → next doc:extensions 其余键原样透传(生态字段不丢)。 */
export const withPresetRegexScripts = (
    doc: PresetDocument,
    fn: (arr: RegexScriptData[]) => RegexScriptData[],
): PresetDocument => ({
    ...doc,
    extensions: { ...presetExtBag(doc), regex_scripts: fn(presetRegexScripts(doc)) },
});

/** 启停 —— disabled===true → 删键态 false;其余(缺省/false)→ true。 */
export const togglePresetRegex = (doc: PresetDocument, i: number): PresetDocument =>
    withPresetRegexScripts(doc, (arr) =>
        arr.map((sc, j) => (j === i ? { ...sc, disabled: sc.disabled === true ? false : true } : sc)));

export const removePresetRegex = (doc: PresetDocument, i: number): PresetDocument =>
    withPresetRegexScripts(doc, (arr) => arr.filter((_, j) => j !== i));

/** 单条字段补丁 —— spread 保活未列字段(placement/depth/pluginLanes 等)。 */
export const patchPresetRegex = (
    doc: PresetDocument, i: number, set: Partial<RegexScriptData>,
): PresetDocument =>
    withPresetRegexScripts(doc, (arr) => arr.map((sc, j) => (j === i ? { ...sc, ...set } : sc)));

/** 新脚本默认值 —— 与 studio RegexPage 全局新增同基线
 *  (placement:[2] = AI 输出车道;markdownOnly/runOnEdit 开,promptOnly 关)。 */
export const newPresetRegexScript = (id: string): RegexScriptData => ({
    id,
    scriptName: '',
    findRegex: '',
    replaceString: '',
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
});

export const addPresetRegex = (doc: PresetDocument, script: RegexScriptData): PresetDocument =>
    withPresetRegexScripts(doc, (arr) => [...arr, script]);

/* ---------- Stable (non-index) addressing ----------
 * Index-addressed ops assume the doc the editor rendered is the doc the
 * write applies to — false whenever another surface wrote in between.
 * Callers capture a key at render time: the script's id when it has one,
 * else the rendered script object itself for a deep-equal fallback
 * (legacy scripts without ids). The key resolves against the CURRENT
 * array at apply time, so a stale index can never hit the wrong entry. */
/** Resolution order: id → deep-equal ref → `at` (render-time index, LAST
    resort). `at` exists for one edge: rapid typing on an id-less script —
    keystroke N+1 can fire with the pre-patch closure, so `ref` no longer
    deep-equals; the entry still sits at its slot. Patch passes `at`;
    delete/toggle stay strict — a wrong target for those is worse than a
    lost toggle click. */
export type PresetRegexKey = { id?: string; ref?: RegexScriptData; at?: number };

export const presetRegexKeyOf = (sc: RegexScriptData): PresetRegexKey =>
    typeof sc.id === 'string' && sc.id ? { id: sc.id } : { ref: sc };

/** React row identity — bound to the (preset, script) PAIR, never the
    script id alone: copyPreset deep-copies ids, so two loaded presets
    routinely share them and a bare-id key lets React reuse a row — and
    its input/form state — across a preset switch (review 🔴6). */
export const presetRegexRowKey = (presetName: string | null | undefined, sc: RegexScriptData, i: number): string =>
    `${presetName ?? ''}::${(typeof sc.id === 'string' && sc.id) ? sc.id : `i${i}`}`;

/* ---------- Deterministic id minting (id-less legacy scripts) ----------
 * A queued mutation is REPLAYED onto several bases: the optimistic doc,
 * the fresh base inside a flush, and every reload/rebase. A random mint
 * produced a different id per pass, so the doc the editor saw and the
 * doc the server got disagreed — and every later write keyed on the
 * first (already-lost) id silently hit nothing (review 🔴3).
 * The mint is therefore a pure function of the script's content: same
 * script ⇒ same id, on every base, in every replay order. */
const canonForHash = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonForHash);
    if (v && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(v).sort()) o[k] = canonForHash((v as Record<string, unknown>)[k]);
        return o;
    }
    return v;
};

/** FNV-1a over the sorted-key JSON — small stable content hash. */
const contentHash = (sc: RegexScriptData): string => {
    const s = JSON.stringify(canonForHash(sc));
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
};

/** The id a content-identical script would have been minted — used to
    RECOVER an entry whose first queued patch already stamped it. */
export const presetRegexMintedId = (sc: RegexScriptData): string =>
    `rx-c${contentHash(sc)}`;

/** Deterministic id for `arr[i]` — content hash, with a positional
    suffix only when a DIFFERENT script already owns the base id. */
export const mintPresetRegexId = (arr: RegexScriptData[], i: number): string => {
    const base = presetRegexMintedId(arr[i]!);
    if (!arr.some((sc, j) => j !== i && sc.id === base)) return base;
    let n = 2;
    while (arr.some((sc, j) => j !== i && sc.id === `${base}-${n}`)) n += 1;
    return `${base}-${n}`;
};

/* Structural equality for the `ref` fallback — local twin of
   api/regex.ts's regexDeepEqual (this module stays import-free so
   node --test can load it; same split as quickreplies.ts/-model.ts). */
const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** Resolve a key against the current scripts array — id match first,
    then deep-equal ref, then minted-id recovery (an earlier queued
    patch on this same ref already stamped the deterministic id — it
    survives reordering where `at` would hit a neighbour), then
    render-time `at` as LAST resort. -1 = no resolvable target. */
export const findPresetRegexIndex = (doc: PresetDocument, key: PresetRegexKey): number => {
    const arr = presetRegexScripts(doc);
    if (key.id) {
        return arr.findIndex((sc) => sc.id === key.id);
    }
    if (key.ref) {
        const i = arr.findIndex((sc) => deepEqual(sc, key.ref));
        if (i >= 0) return i;
        const stamped = presetRegexMintedId(key.ref);
        const j = arr.findIndex((sc) => sc.id === stamped);
        if (j >= 0) return j;
    }
    return key.at != null && key.at >= 0 && key.at < arr.length ? key.at : -1;
};

export const togglePresetRegexByKey = (doc: PresetDocument, key: PresetRegexKey): PresetDocument => {
    const i = findPresetRegexIndex(doc, key);
    return i < 0 ? doc : togglePresetRegex(doc, i);
};

export const removePresetRegexByKey = (doc: PresetDocument, key: PresetRegexKey): PresetDocument => {
    const i = findPresetRegexIndex(doc, key);
    return i < 0 ? doc : removePresetRegex(doc, i);
};

/** Patch by stable key. When the matched script has no id, the patch
    also stamps its DETERMINISTIC content id — every replay mints the
    same id, so the optimistic doc and the flushed doc converge and
    later key-addressed edits keep resolving. */
export const patchPresetRegexByKey = (
    doc: PresetDocument,
    key: PresetRegexKey,
    set: Partial<RegexScriptData>,
): PresetDocument => {
    const arr = presetRegexScripts(doc);
    const i = findPresetRegexIndex(doc, key);
    if (i < 0) return doc;
    const sc = arr[i]!;
    const next = typeof sc.id === 'string' && sc.id ? set : { id: mintPresetRegexId(arr, i), ...set };
    return patchPresetRegex(doc, i, next);
};
