// Settings via /api/utopinn/settings(apps/server/src/plugins/utopinn-library.js;
// 白名单常量 PATCHABLE_SETTINGS_SECTIONS / PATCHABLE_SETTINGS_SCALAR_KEYS)。
//   GET  ?raw=  完整 settings 文档;缺省脱敏(api_key*/secret/password 类叶键
//               服务端 SECRET_FIELD_RE 递归剥除),?raw=1 未脱敏 —— 旧前端是
//               完整文档消费者,薄客户端别拿 raw 当常态。
//   PATCH       受限浅合并:对象段白名单 power_user / extension_settings /
//               oai_settings / world_info_settings(逐键浅合并,段值必须对象);
//               另放标量键 preset_settings_openai(string 直写 / null 删键,
//               服务端双向镜像 oai_settings.preset_settings_openai)。
//               其余顶层段不经此端点写 → ApiError(400);段值非对象 → 422。
import { apiFetch, apiGet, assertOk } from './client';
import type { SettingsResponse } from '@utopinn/protocol';

export type { SettingsResponse } from '@utopinn/protocol';

/** PATCH 白名单 —— 与服务端 PATCHABLE_SETTINGS_SECTIONS(对象段)
 *  + PATCHABLE_SETTINGS_SCALAR_KEYS(标量键)同口径(utopinn-library.js)。 */
export interface SettingsPatch {
    power_user?: Record<string, unknown>;
    extension_settings?: Record<string, unknown>;
    /** 连接配置(source/baseUrl/model 选择,连接设置 tab 依赖)。 */
    oai_settings?: Record<string, unknown>;
    /** WI 引擎开关与 world_info.globalSelect/charLore(「全局栈」写面)。 */
    world_info_settings?: Record<string, unknown>;
    /** 标量:当前 openai 预设选择指针;string 直写、null 删键(merge-patch),
     *  服务端镜像进 oai_settings.preset_settings_openai 双读取面。 */
    preset_settings_openai?: string | null;
}

/**
 * GET /api/utopinn/settings —— {settings}。
 * raw=true 拿未脱敏档(管理面/迁移用;展示面用缺省脱敏态)。
 */
export async function getSettings(opts?: { raw?: boolean }): Promise<SettingsResponse> {
    return apiGet(`/api/utopinn/settings${opts?.raw ? '?raw=1' : ''}`);
}

/**
 * PATCH /api/utopinn/settings —— 浅合并对象段 + preset_settings_openai 标量。
 * 回包是脱敏后的整档 {settings}(写后刷新读这一份,别回读 raw)。
 * 非白名单顶层键 → ApiError(400);段值非对象/标量非 string|null → ApiError(422)。
 * 注:api_key_* 形字段服务端 sanitizeSettingsDoc 剥除,密钥一律走 /secrets。
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
