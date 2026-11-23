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
