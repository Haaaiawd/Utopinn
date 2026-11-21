// Connection probe + upstream model list via /api/utopinn/connection/test
// & /api/utopinn/models(apps/server/src/plugins/utopinn-connection.js)。
// 连接参数直接读服务端当前生效的 settings.oai_settings + secrets,密钥永不回显。
import { apiGet, apiPost } from './client';
import type {
    ConnectionProbeErrorCode,
    ConnectionTestResponse,
    ModelsResponse,
    UpstreamModelItem,
} from '@utopinn/protocol';

export type {
    ConnectionProbeErrorCode,
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

/** GET /api/utopinn/models —— 缺省 30s 缓存,fresh=true 强制重探上游。 */
export async function listModels(opts?: { fresh?: boolean; secretId?: string }): Promise<ModelsResponse> {
    const qs = new URLSearchParams();
    if (opts?.fresh) qs.set('fresh', '1');
    if (opts?.secretId) qs.set('secret_id', opts.secretId);
    const q = qs.toString();
    return apiGet<ModelsResponse>(`/api/utopinn/models${q ? `?${q}` : ''}`);
}
