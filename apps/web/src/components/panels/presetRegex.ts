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
