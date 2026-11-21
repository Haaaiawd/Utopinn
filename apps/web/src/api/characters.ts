// Character cards via /api/utopinn/characters(TASK-026 + C-3 写面)。
// 列表行只带展示元;完整 CCv2 卡(data.* 持字段)是单独 GET ——
// 角色页要 first_mes / extensions.world(绑定书)/ character_book(内嵌书)。
import { apiFetch, apiGet, assertOk } from './client';
import type { CharacterPatchRequest } from '@utopinn/protocol';

export type { CharacterPatchRequest } from '@utopinn/protocol';

/** /api/utopinn/characters 行 —— 卡格、侧栏组头、舞台头共用的展示面。 */
export interface CardItem {
    charDir: string;
    name: string;
    /** 图片卡文件名(.png/.webp);JSON 卡为 null。 */
    avatar: string | null;
    fileName: string;
    fileSize: number;
    tags: string[];
    /** 卡文件存在但解析失败时仍列出(false → 名字退化 charDir)。 */
    readable: boolean;
}

/**
 * 服务端原样返回的卡文档:CCv2({name, data:{…}})或 v1 平铺。
 * `cardData` 归一两种形状 —— v2 字段在 data.* 下。
 */
export interface CardDoc {
    name?: string;
    description?: string;
    first_mes?: string;
    tags?: string[];
    creator?: string;
    extensions?: Record<string, unknown>;
    character_book?: unknown;
    data?: {
        name?: string;
        description?: string;
        first_mes?: string;
        tags?: string[];
        creator?: string;
        character_version?: string;
        extensions?: Record<string, unknown>;
        character_book?: unknown;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

/** v2 优先、v1 回落 —— 与服务端 cardFields() 同一规则。 */
export function cardData(doc: CardDoc | null | undefined): NonNullable<CardDoc['data']> {
    const d = doc?.data;
    if (d && typeof d === 'object' && !Array.isArray(d)) return d;
    return (doc ?? {}) as NonNullable<CardDoc['data']>;
}

/** 卡图静态路由(与 LibraryView 既有拼法一致)。 */
export function charImageUrl(fileName: string): string {
    return `/characters/${encodeURIComponent(fileName)}`;
}

export async function listCharacters(): Promise<{ items: CardItem[]; total: number }> {
    return apiGet('/api/utopinn/characters');
}

/** 单卡完整文档;404/解析失败时 apiGet 抛 ApiError,调用方给空态。 */
export async function getCharacter(charDir: string): Promise<CardDoc> {
    return apiGet(`/api/utopinn/characters/${encodeURIComponent(charDir)}`);
}

/** PATCH /api/utopinn/characters/:charDir —— 字段级 Merge Patch(写回 PNG/JSON 原卡)。 */
export async function patchCharacter(charDir: string, patch: CharacterPatchRequest): Promise<CardDoc> {
    const res = await apiFetch(`/api/utopinn/characters/${encodeURIComponent(charDir)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    await assertOk(res);
    return (await res.json()) as CardDoc;
}
