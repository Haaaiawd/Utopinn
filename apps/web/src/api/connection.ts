// Connection probe + upstream model list via /api/utopinn/connection/test
// & /api/utopinn/models(apps/server/src/plugins/utopinn-connection.js)。
// 连接参数直接读服务端当前生效的 settings.oai_settings + secrets,密钥永不回显。
//
// 连接配置档案(profiles):oai_settings.connection_profiles ——
//   GET    /connection/profiles        {profiles, activeModel}(惰性迁移旧单槽)
//   PUT    /connection/profiles/:id    upsert(id='new' 服务端发 uuid)
//   DELETE /connection/profiles/:id    删档 + 清指向它的 activeModel
//   POST   /connection/test|models     探测目标 = {profile_id} 或内联草稿
//                                      {format, baseUrl, secretId, key}
import { apiFetch, apiGet, apiPost, assertOk } from './client';
import type {
    ActiveModelPointer,
    ConnectionProbeErrorCode,
    ConnectionProbeTarget,
    ConnectionProfile,
    ConnectionProfileFormat,
    ConnectionProfileInput,
    ConnectionProfilePutResponse,
    ConnectionProfilesResponse,
    ConnectionTestResponse,
    ModelsResponse,
    UpstreamModelItem,
} from '@utopinn/protocol';

export type {
    ActiveModelPointer,
    ConnectionProbeErrorCode,
    ConnectionProbeTarget,
    ConnectionProfile,
    ConnectionProfileFormat,
    ConnectionProfileInput,
    ConnectionProfilePutResponse,
    ConnectionProfilesResponse,
    ConnectionTestResponse,
    ModelsResponse,
    UpstreamModelItem,
};

/** POST /api/utopinn/connection/test —— 恒 200,连通性结果在 ok/error 字段内。 */
export async function testConnection(secretId?: string): Promise<ConnectionTestResponse> {
    return apiPost<ConnectionTestResponse>(
        '/api/utopinn/connection/test',
        secretId ? { secret_id: secretId } : {},
    );
}

/**
 * POST /api/utopinn/connection/test —— 按目标(profile/草稿)探测;
 * 不切源、不改任何设置,编辑器里未保存的草稿也能测。
 */
export async function testConnectionTarget(target: ConnectionProbeTarget): Promise<ConnectionTestResponse> {
    return apiPost<ConnectionTestResponse>('/api/utopinn/connection/test', target);
}

/** GET /api/utopinn/models —— 缺省 30s 缓存,fresh=true 强制重探上游。 */
export async function listModels(opts?: { fresh?: boolean; secretId?: string }): Promise<ModelsResponse> {
    const qs = new URLSearchParams();
    if (opts?.fresh) qs.set('fresh', '1');
    if (opts?.secretId) qs.set('secret_id', opts.secretId);
    const q = qs.toString();
    return apiGet<ModelsResponse>(`/api/utopinn/models${q ? `?${q}` : ''}`);
}

/** POST /api/utopinn/connection/models —— profile/草稿目标的上游清单。 */
export async function listModelsFor(target: ConnectionProbeTarget): Promise<ModelsResponse> {
    return apiPost<ModelsResponse>('/api/utopinn/connection/models', target);
}

/** GET /api/utopinn/connection/profiles —— 缺省触发旧单槽→default 惰性迁移。 */
export async function listProfiles(): Promise<ConnectionProfilesResponse> {
    return apiGet('/api/utopinn/connection/profiles');
}

/** PUT /api/utopinn/connection/profiles/:id —— upsert;'new' 服务端发 uuid。 */
export async function putProfile(id: string, input: ConnectionProfileInput): Promise<ConnectionProfilePutResponse> {
    const res = await apiFetch(`/api/utopinn/connection/profiles/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    });
    await assertOk(res);
    return (await res.json()) as ConnectionProfilePutResponse;
}

/** DELETE /api/utopinn/connection/profiles/:id → {profiles, activeModel}。 */
export async function deleteProfile(id: string): Promise<ConnectionProfilesResponse> {
    const res = await apiFetch(`/api/utopinn/connection/profiles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    });
    await assertOk(res);
    return (await res.json()) as ConnectionProfilesResponse;
}
