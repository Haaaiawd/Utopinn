// World books via /api/utopinn/worlds (TASK-010 CRUD 验收面)。
// 整档 {entries:{}} 读写:PUT body 即整本文档,服务端校验 entries 形态;
// 书名经服务端 resolveName 归一(显示名与盘档名可能不同)。
// 条目对象透传 —— 只改 UI 认识的字段,其余原样保留(生态卡带进来的
// 扩展字段不能被管理面吃掉)。
import { apiFetch, apiGet, assertOk } from './client';

/** ST 世界书条目(v1 编辑面只认这些键,其余透传)。 */
export interface WorldEntry {
    uid: number;
    key: string[];
    keysecondary?: string[];
    comment: string;
    content: string;
    disable?: boolean;
    order?: number;
    position?: number;
    [extra: string]: unknown;
}

export interface WorldDoc {
    entries: Record<string, WorldEntry>;
    [extra: string]: unknown;
}

export interface WorldListItem {
    name: string;
    displayName: string;
    extensions: Record<string, unknown>;
}

export async function listWorlds(): Promise<{ items: WorldListItem[]; total: number }> {
    return apiGet('/api/utopinn/worlds');
}

/** 跨页深链(qrStudioFocus 同款):世界书编辑器挂载时消费一次,
 *  选中指定书;不进 studioNav(域词表不含书名)。 */
export const wbStudioFocus: { set: string | null } = { set: null };

export async function getWorld(name: string): Promise<{ name: string; doc: WorldDoc }> {
    return apiGet(`/api/utopinn/worlds/${encodeURIComponent(name)}`);
}

/** 创建与更新同一条路:PUT /worlds/:name(body=整档 {entries:{}})。 */
export async function saveWorld(name: string, doc: WorldDoc): Promise<{ ok: boolean; name: string }> {
    const res = await apiFetch(`/api/utopinn/worlds/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
    });
    await assertOk(res);
    return (await res.json()) as { ok: boolean; name: string };
}

/** 204;404 时 assertOk 抛 ApiError —— 调用方按失败提示。 */
export async function deleteWorld(name: string): Promise<void> {
    const res = await apiFetch(`/api/utopinn/worlds/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await assertOk(res);
}
