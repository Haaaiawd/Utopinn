// Secrets via /api/utopinn/secrets(apps/server/src/plugins/utopinn-library.js
// L776-822;SecretManager 原生打码,应答里永远没有明文)。
//   GET  /secrets            {secrets:{key:SecretEntry[]|null},
//                             shared:{key:{label,active:true}|null}} ——
//                            null=未设;shared 是本 handle 可用的共享档可用性视图
//                            (TASK-072 §2.4:只回 label/active,不回 id/掩码/名单)
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

export type {
    SecretEntry,
    SecretsResponse,
    SecretSetResponse,
    SharedSecretAvailability,
} from '@utopinn/protocol';

/** GET /api/utopinn/secrets —— 全键脱敏态(value 是掩码串,不是明文)。 */
export async function listSecrets(): Promise<SecretsResponse> {
    return apiGet('/api/utopinn/secrets');
}

/**
 * PUT /api/utopinn/secrets/:key —— 写一条(value 是明文入参,应答不 echo)。
 * 回包 entries = 该 key 最新脱敏条目组(写后刷新直接用)。
 * opts.activate:false → 不抢池 active 槽(profile 档存 key 专用 —
 * 档引用走 secretId 显式槽,active 是别档/旧路的 fallback,不能挤)。
 */
export async function putSecret(key: string, value: string, label?: string, opts?: { activate?: boolean }): Promise<SecretSetResponse> {
    const res = await apiFetch(`/api/utopinn/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            value,
            ...(label !== undefined ? { label } : {}),
            ...(opts?.activate === false ? { activate: false } : {}),
        }),
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
