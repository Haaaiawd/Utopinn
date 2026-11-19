// Settings via /api/utopinn/settings(apps/server/src/plugins/utopinn-library.js
// L516-595)。
//   GET  ?raw=  完整 settings 文档;缺省脱敏(api_key*/secret/password 类叶键
//               服务端 SECRET_FIELD_RE 递归剥除),?raw=1 未脱敏 —— 旧前端是
//               完整文档消费者,薄客户端别拿 raw 当常态。
//   PATCH       受限浅合并:顶层键白名单只有 power_user / extension_settings,
//               每段值必须是对象(逐键浅合并);其余顶层段(oai_settings、
//               world_info、预设选择等)不经此端点写 → ApiError(400)。
import { apiFetch, apiGet, assertOk } from './client';
import type { SettingsResponse } from '@utopinn/protocol';

export type { SettingsResponse } from '@utopinn/protocol';

/** PATCH 白名单段 —— 与服务端 PATCHABLE_SETTINGS_SECTIONS 同口径。 */
export interface SettingsPatch {
    power_user?: Record<string, unknown>;
    extension_settings?: Record<string, unknown>;
}

/**
 * GET /api/utopinn/settings —— {settings}。
 * raw=true 拿未脱敏档(管理面/迁移用;展示面用缺省脱敏态)。
 */
export async function getSettings(opts?: { raw?: boolean }): Promise<SettingsResponse> {
    return apiGet(`/api/utopinn/settings${opts?.raw ? '?raw=1' : ''}`);
}

/**
 * PATCH /api/utopinn/settings —— 浅合并 power_user / extension_settings。
 * 回包是脱敏后的整档 {settings}(写后刷新读这一份,别回读 raw)。
 * 非白名单顶层键 → ApiError(400);段值非对象 → ApiError(422)。
 */
export async function patchSettings(patch: SettingsPatch): Promise<SettingsResponse> {
    const res = await apiFetch('/api/utopinn/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    await assertOk(res);
    return (await res.json()) as SettingsResponse;
}
