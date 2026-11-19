// Server plugin manager via /api/utopinn/plugins(TASK-021 管理面)。
// list() = profile × patch × 运行时合并态;enable/disable 落 patch.yaml,
// reload = dispose + cache-bust 重导入。utopinn-plugins 自锁:它的
// disable/reload 被服务端 400 拒(关了自己就没路可开)。
import { apiFetch, apiGet, assertOk } from './client';

export interface PluginItem {
    id: string;
    module: string;
    disabled: boolean;
    /** active | disabled | failed | degraded | unknown(未装载时的 profile 行)。 */
    status: string;
    /** 该行进过 profile.patch.yaml —— 即用户手调过启停。 */
    patch: boolean;
}

export interface PluginActResult {
    ok: boolean;
    status?: string;
    error?: string;
}

export async function listPlugins(): Promise<{ items: PluginItem[] }> {
    return apiGet('/api/utopinn/plugins');
}

async function act(id: string, verb: 'enable' | 'disable' | 'reload'): Promise<PluginActResult> {
    const res = await apiFetch(`/api/utopinn/plugins/${encodeURIComponent(id)}/${verb}`, { method: 'POST' });
    await assertOk(res);
    return (await res.json()) as PluginActResult;
}

export const enablePlugin = (id: string) => act(id, 'enable');
export const disablePlugin = (id: string) => act(id, 'disable');
export const reloadPlugin = (id: string) => act(id, 'reload');
