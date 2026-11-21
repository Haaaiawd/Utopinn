// Personas via /api/utopinn/personas (TASK-024).
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

/**
 * 当前会话生效的人设选择(舞台头快切)。服务端没有 per-chat persona
 * 端点 —— 选择态存本地,生成时以 user:{name,description} 携带进
 * /api/utopinn/generate(utopinn-generate.js body.user → substCtx.name1)。
 */
export interface ActivePersona {
    /** personas 主键(头像文件名);mock/手填兜底可为 null。 */
    avatar: string | null;
    name: string;
    description: string;
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

/** Utopinn 内置用户默认头像库(public/assets/avatars/)—— 取代 ST 空白字牌。 */
export const BUILTIN_PERSONA_AVATARS = [
    { id: 'user-redpanda.png', prefix: 'user-redpanda', src: '/assets/avatars/user-redpanda.png', labelKey: 'studio.persona.av.redpanda' },
    { id: 'user-fox.png', prefix: 'user-fox', src: '/assets/avatars/user-fox.png', labelKey: 'studio.persona.av.fox' },
    { id: 'user-owl.png', prefix: 'user-owl', src: '/assets/avatars/user-owl.png', labelKey: 'studio.persona.av.owl' },
] as const;

export type BuiltinPersonaAvatarId = (typeof BUILTIN_PERSONA_AVATARS)[number]['id'];

/** 从任意存储键推断其绑定的内置动物头像(无匹配时按文件名稳定散列落三选一)。 */
export function resolveBuiltinPersonaAvatar(avatar: string | null | undefined): (typeof BUILTIN_PERSONA_AVATARS)[number] {
    const raw = (avatar ?? '').trim().toLowerCase();
    for (const b of BUILTIN_PERSONA_AVATARS) {
        if (raw === b.id || raw.startsWith(`${b.prefix}-`) || raw.startsWith(`${b.prefix}_`)) return b;
    }
    if (!raw) return BUILTIN_PERSONA_AVATARS[0];
    let h = 0;
    for (let i = 0; i < raw.length; i++) h = ((h * 31) + raw.charCodeAt(i)) >>> 0;
    return BUILTIN_PERSONA_AVATARS[h % BUILTIN_PERSONA_AVATARS.length]!;
}

/** 人设头像 URL:服务端 User Avatars 真图优先,否则落 Utopinn 内置动物头像库。 */
export function personaAvatarSrc(avatar: string | null | undefined, hasImage?: boolean): string {
    if (hasImage && avatar) return `/User%20Avatars/${encodeURIComponent(avatar)}`;
    return resolveBuiltinPersonaAvatar(avatar).src;
}

/** 为新建或换内置头像的人设铸造不冲突的 avatar 主键(保留内置前缀以便前端还原头像)。 */
export function mintPersonaAvatarKey(baseId: BuiltinPersonaAvatarId, existingKeys: Iterable<string>): string {
    const taken = new Set(existingKeys);
    if (!taken.has(baseId)) return baseId;
    const stem = baseId.replace(/\.png$/i, '');
    return `${stem}-${Date.now()}.png`;
}

export async function listPersonas(): Promise<PersonaList> {
    return apiGet<PersonaList>('/api/utopinn/personas');
}

/** 创建与更新同一条路:PUT /personas/:avatar(avatar 前端生成即新建)。 */
export async function savePersona(avatar: string, patch: PersonaPatch): Promise<PersonaSaved> {
    const res = await apiFetch(`/api/utopinn/personas/${encodeURIComponent(avatar)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    await assertOk(res);
    return (await res.json()) as PersonaSaved;
}

/** 204;删的是默认人设时服务端一并清默认位(前端先提示再调)。 */
export async function deletePersona(avatar: string): Promise<void> {
    const res = await apiFetch(`/api/utopinn/personas/${encodeURIComponent(avatar)}`, { method: 'DELETE' });
    await assertOk(res);
}
