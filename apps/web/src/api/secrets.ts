// Secrets via /api/utopinn/secrets(apps/server/src/plugins/utopinn-library.js
// L776-822;SecretManager 原生打码,应答里永远没有明文)。
//   GET  /secrets            {secrets:{key:SecretEntry[]|null}} —— null=未设
//   PUT  /secrets/:key       body:{value,label?} → {ok,id,key,entries};
//                            写一条自动置 active,同 key 旧值退役;
//                            key 限 VALID_SECRET_KEYS 白名单 → 否则 400
//   DELETE /secrets/:key/:id 按 id 删一条 → 204
import { apiFetch, apiGet, assertOk } from './client';
import type {
    SecretEntry,
    SecretsResponse,
    SecretSetResponse,
} from '@utopinn/protocol';

export type { SecretEntry, SecretsResponse, SecretSetResponse } from '@utopinn/protocol';

/** GET /api/utopinn/secrets —— 全键脱敏态(value 是掩码串,不是明文)。 */
export async function listSecrets(): Promise<SecretsResponse> {
    return apiGet('/api/utopinn/secrets');
}

/**
 * PUT /api/utopinn/secrets/:key —— 写一条(value 是明文入参,应答不 echo)。
 * 回包 entries = 该 key 最新脱敏条目组(写后刷新直接用)。
 */
export async function putSecret(key: string, value: string, label?: string): Promise<SecretSetResponse> {
    const res = await apiFetch(`/api/utopinn/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value, ...(label !== undefined ? { label } : {}) }),
    });
    await assertOk(res);
    return (await res.json()) as SecretSetResponse;
}

/** DELETE /api/utopinn/secrets/:key/:id —— 204;未知 key → ApiError(400)。 */
export async function deleteSecret(key: string, id: string): Promise<void> {
    const res = await apiFetch(`/api/utopinn/secrets/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    });
    await assertOk(res);
}
