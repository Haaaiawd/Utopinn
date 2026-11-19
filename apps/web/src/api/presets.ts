// Presets via /api/utopinn/presets(apps/server/src/plugins/utopinn-library.js
// L403-430 / L604-632)。apiId 是服务端预设家族键(PRESET_FOLDER_BY_API_ID
// 白名单:openai/textgenerationwebui/kobold/novel/context/instruct/sysprompt/
// reasoning/movingUI/quickReplies),缺省 openai;非法 → ApiError(400)。
// 文档整档读写:GET 回 {name,apiId,doc};PUT body 即整档 doc;DELETE 连带
// 清该预设的 state namespace(服务端 Repo 内做)。
import { apiFetch, apiGet, assertOk } from './client';
import type {
    PresetDocument,
    PresetGetResponse,
    PresetListResponse,
    PresetPutResponse,
} from '@utopinn/protocol';

export type {
    PresetDocument,
    PresetGetResponse,
    PresetListItem,
    PresetListResponse,
    PresetPutResponse,
} from '@utopinn/protocol';

function presetQuery(apiId?: string): string {
    return apiId ? `?apiId=${encodeURIComponent(apiId)}` : '';
}

/** GET /api/utopinn/presets?apiId= —— 该家族全部预设名(按 name 排序)。 */
export async function listPresets(apiId?: string): Promise<PresetListResponse> {
    return apiGet(`/api/utopinn/presets${presetQuery(apiId)}`);
}

/** GET /api/utopinn/presets/:name?apiId= —— 预设全文;不在 → ApiError(404)。 */
export async function getPreset(name: string, apiId?: string): Promise<PresetGetResponse> {
    return apiGet(`/api/utopinn/presets/${encodeURIComponent(name)}${presetQuery(apiId)}`);
}

/**
 * PUT /api/utopinn/presets/:name?apiId= —— 整档保存(body=doc 对象,
 * 创建与更新同一条路);doc 非对象 → ApiError(422)。
 */
export async function savePreset(name: string, doc: PresetDocument, apiId?: string): Promise<PresetPutResponse> {
    const res = await apiFetch(`/api/utopinn/presets/${encodeURIComponent(name)}${presetQuery(apiId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
    });
    await assertOk(res);
    return (await res.json()) as PresetPutResponse;
}

/** DELETE /api/utopinn/presets/:name?apiId= —— 204;不在 → ApiError(404)。 */
export async function deletePreset(name: string, apiId?: string): Promise<void> {
    const res = await apiFetch(`/api/utopinn/presets/${encodeURIComponent(name)}${presetQuery(apiId)}`, {
        method: 'DELETE',
    });
    await assertOk(res);
}
