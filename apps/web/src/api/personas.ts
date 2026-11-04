// Personas via /api/uberge/personas (TASK-024).
// avatar 文件名兼任主键(personas = {avatar: name} + persona_descriptions
// = {avatar: {description,position,title}} 双表,服务端做嵌套合并)。
// 写操作 PUT/DELETE 走 apiFetch —— CSRF 头在 client.ts 内置。
import { apiFetch, apiGet, assertOk } from './client';

export interface PersonaItem {
    /** 头像文件名,主键(如 'user-default.png')。 */
    avatar: string;
    name: string;
    description: string;
    /** 描述注入位(ST persona_description_positions:0 提示词内/2 AN 顶/3 AN 底/4 深度/9 关闭)。 */
    position: number;
    title: string;
    /** avatars 目录里存在同名图 —— 新建的人设通常没有,渲染落首字占位。 */
    hasImage: boolean;
    isDefault: boolean;
}

export interface PersonaList {
    items: PersonaItem[];
    total: number;
    defaultPersona: string | null;
}

/** PUT body —— 服务端嵌套合并,缺省字段保持原值;is_default 只认 true。 */
export interface PersonaPatch {
    name?: string;
    description?: string;
    position?: number;
    title?: string;
    is_default?: boolean;
}

/** PUT 回包(注意:无 hasImage —— 调用方别指望它刷新图片态)。 */
export interface PersonaSaved {
    ok: boolean;
    avatar: string;
    name: string;
    description: string;
    position: number;
    title: string;
    isDefault: boolean;
}

export async function listPersonas(): Promise<PersonaList> {
    return apiGet<PersonaList>('/api/uberge/personas');
}

/** 创建与更新同一条路:PUT /personas/:avatar(avatar 前端生成即新建)。 */
export async function savePersona(avatar: string, patch: PersonaPatch): Promise<PersonaSaved> {
    const res = await apiFetch(`/api/uberge/personas/${encodeURIComponent(avatar)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    await assertOk(res);
    return (await res.json()) as PersonaSaved;
}

/** 204;删的是默认人设时服务端一并清默认位(前端先提示再调)。 */
export async function deletePersona(avatar: string): Promise<void> {
    const res = await apiFetch(`/api/uberge/personas/${encodeURIComponent(avatar)}`, { method: 'DELETE' });
    await assertOk(res);
}
