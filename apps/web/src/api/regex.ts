// Regex scripts three-scope CRUD via /api/utopinn/regex(utopinn-regex.js)。
//   GET    /api/utopinn/regex               全量视图 {global,allowed,disabled,chars,presets}
//   PUT    /api/utopinn/regex               整组替换 scripts[] 或切换 allow 放行位
//   PATCH  /api/utopinn/regex/:id           单条字段补丁 {scope,…,set:{…}}(:id 支持脚本 id 或下标)
//   DELETE /api/utopinn/regex/:id           删除单条(:id 支持脚本 id 或下标)
import { apiFetch, apiGet, assertOk } from './client';
import type {
    RegexCharGroup,
    RegexFullViewResponse,
    RegexPresetGroup,
    RegexScriptData,
} from '@utopinn/protocol';

export type {
    RegexCharGroup,
    RegexFullViewResponse,
    RegexPresetGroup,
    RegexScriptData,
};

export type RegexScopeTarget =
    | { scope: 'global' }
    | { scope: 'char'; charDir: string }
    | { scope: 'preset'; apiId: string; preset: string };

function scopeBody(target: RegexScopeTarget): Record<string, string> {
    if (target.scope === 'global') return { scope: 'global' };
    if (target.scope === 'char') return { scope: 'char', char: target.charDir };
    return { scope: 'preset', apiId: target.apiId, preset: target.preset };
}

function scopeQuery(target: RegexScopeTarget): string {
    const qs = new URLSearchParams(scopeBody(target));
    return `?${qs.toString()}`;
}

/** GET /api/utopinn/regex —— 全量三域视图。 */
export async function getRegexFullView(): Promise<RegexFullViewResponse> {
    return apiGet<RegexFullViewResponse>('/api/utopinn/regex');
}

/** GET /api/utopinn/regex?scope=preset 的响应 = RegexPresetGroup + scope 回显。 */
export interface RegexPresetScopeView extends RegexPresetGroup {
    scope: 'preset';
}

/** GET /api/utopinn/regex?scope=preset —— 单预设域视图
 *  (allow 放行闸 / in_use 位 / 档内 regex_scripts;脚本本体在预设 doc,
 *   此处只为 settings 侧放行态取数)。 */
export async function getRegexPresetScope(apiId: string, name: string): Promise<RegexPresetScopeView> {
    return apiGet<RegexPresetScopeView>(`/api/utopinn/regex${scopeQuery({ scope: 'preset', apiId, preset: name })}`);
}

/** PUT /api/utopinn/regex —— 整组替换或更新 preset/char 放行开关。 */
export async function putRegexScope(
    target: RegexScopeTarget,
    payload: { scripts?: RegexScriptData[]; allow?: boolean },
): Promise<{ ok: true; scope: string; count?: number; allow?: boolean }> {
    const res = await apiFetch('/api/utopinn/regex', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...scopeBody(target), ...payload }),
    });
    await assertOk(res);
    return (await res.json()) as { ok: true; scope: string; count?: number; allow?: boolean };
}

/** PATCH /api/utopinn/regex/:id —— 单条脚本字段补丁(如 {disabled:true})。 */
export async function patchRegexScript(
    target: RegexScopeTarget,
    idOrIndex: string | number,
    set: Partial<RegexScriptData>,
): Promise<{ ok: true; id: string; scope: string; script: RegexScriptData }> {
    const res = await apiFetch(`/api/utopinn/regex/${encodeURIComponent(String(idOrIndex))}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...scopeBody(target), set }),
    });
    await assertOk(res);
    return (await res.json()) as { ok: true; id: string; scope: string; script: RegexScriptData };
}

/** DELETE /api/utopinn/regex/:id —— 删除单条脚本。 */
export async function deleteRegexScript(
    target: RegexScopeTarget,
    idOrIndex: string | number,
): Promise<{ ok: true; id: string; scope: string; remaining: number }> {
    const res = await apiFetch(
        `/api/utopinn/regex/${encodeURIComponent(String(idOrIndex))}${scopeQuery(target)}`,
        { method: 'DELETE' },
    );
    await assertOk(res);
    return (await res.json()) as { ok: true; id: string; scope: string; remaining: number };
}

/** GET /api/utopinn/regex?scope=… —— script list for a single scope
    (global/char/preset all answer {scripts} — preset scope included so a
    serialized read-modify-write has a typed fetcher; preset writes still
    belong to the shared preset-doc lane, not putRegexScope). */
export async function getRegexScope(target: RegexScopeTarget): Promise<RegexScriptData[]> {
    const res = await apiGet<{ scripts?: unknown }>(`/api/utopinn/regex${scopeQuery(target)}`);
    const arr = res?.scripts;
    return Array.isArray(arr)
        ? arr.filter((x): x is RegexScriptData => !!x && typeof x === 'object' && !Array.isArray(x))
        : [];
}

/* Whole-array writes (scripts:[…]) are blind replaces server-side, so a
   caller that built its array from a stale snapshot silently drops rows
   added elsewhere. mutateRegexScope serializes a GET → fn → PUT per
   scope key: the transform always runs on the freshest array and two
   callers can never interleave. PATCH/DELETE stay preferred for
   single-script ops — this is for ops the API only exposes whole-array
   (add). */
const scopeChains = new Map<string, Promise<unknown>>();

export function mutateRegexScope(
    target: RegexScopeTarget,
    fn: (scripts: RegexScriptData[]) => RegexScriptData[],
): Promise<{ ok: true; count?: number }> {
    const key = JSON.stringify(scopeBody(target));
    const prev = scopeChains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
        const cur = await getRegexScope(target);
        return putRegexScope(target, { scripts: fn(cur) });
    });
    scopeChains.set(key, next.catch(() => undefined));
    return next.then((r) => ({ ok: true as const, count: r.count }));
}

/* ---------- Content-addressed single-script ops (id-less scripts) ----------
 * The PATCH/DELETE routes resolve :id by exact id first, then by array
 * index. For scripts WITHOUT an id the only address left is the index —
 * computed from whichever snapshot the view rendered, so once the list
 * changed server-side the write lands on the wrong script (review 🔴4).
 * The transforms live in ./regex-model (pure, testable); these wrappers
 * run them inside mutateRegexScope's serial GET→fn→PUT chain so the
 * content lookup always happens on the freshest array. */
import {
    regexDeepEqual, RegexScriptMovedError,
    regexPatchByContent, regexRemoveByContent,
} from './regex-model';

export { regexDeepEqual, RegexScriptMovedError };

/** DELETE-equivalent for an id-less script: remove the FIRST content
    match from the freshest array (identical twins are interchangeable). */
export function deleteRegexScriptByContent(
    target: RegexScopeTarget,
    script: RegexScriptData,
): Promise<{ ok: true; count?: number }> {
    return mutateRegexScope(target, (arr) => regexRemoveByContent(arr, script));
}

/** PATCH-equivalent for an id-less script: merge `set` onto the content
    match inside the serialized scope chain. */
export function patchRegexScriptByContent(
    target: RegexScopeTarget,
    script: RegexScriptData,
    set: Partial<RegexScriptData>,
): Promise<{ ok: true; count?: number }> {
    return mutateRegexScope(target, (arr) => regexPatchByContent(arr, script, set));
}
