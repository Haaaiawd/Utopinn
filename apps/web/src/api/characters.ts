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
    /** true = 实例共享池条目(只读源;编辑/装卡即物化成私有 copy)。 */
    shared?: boolean;
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

/* 卡文档 promise 级缓存 —— 舞台头资产 chip / 角色页 / studio 绑定反查
   共享同一真值源,避免每次进会话/翻页都重拉同一卡。
   失效面:patchCharacter 写回后立刻作废该卡条目;失败 promise 自动逐出
   (重试语义天然);外部改卡(导入覆盖等)由 invalidateCharDocs 收口。 */
const cardDocCache = new Map<string, Promise<CardDoc>>();

export function loadCharDoc(charDir: string): Promise<CardDoc> {
    let p = cardDocCache.get(charDir);
    if (!p) {
        p = getCharacter(charDir);
        cardDocCache.set(charDir, p);
        p.catch(() => cardDocCache.delete(charDir));
    }
    return p;
}

/** 外部改卡(导入覆盖/ST 端写盘等不经 patchCharacter 的路径)后清缓存。 */
export function invalidateCharDocs(charDir?: string): void {
    if (charDir === undefined) cardDocCache.clear();
    else cardDocCache.delete(charDir);
}

/** PATCH /api/utopinn/characters/:charDir —— 字段级 Merge Patch(写回 PNG/JSON 原卡)。
 *  共享卡会先被服务端物化:响应带 __materialized/charDir(可能不同干名)。 */
export async function patchCharacter(charDir: string, patch: CharacterPatchRequest): Promise<CardDoc> {
    const res = await apiFetch(`/api/utopinn/characters/${encodeURIComponent(charDir)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    await assertOk(res);
    invalidateCharDocs(charDir);
    const doc = (await res.json()) as CardDoc;
    if (doc.__materialized && typeof doc.charDir === 'string') {
        invalidateCharDocs(doc.charDir);
    }
    return doc;
}

/** POST /api/utopinn/characters/:charDir/install —— 共享卡显式物化。
 *  返回 {charDir,fileName,card};私有同名在场 → 409,非共享卡 → 404。 */
export interface InstallCharacterResponse {
    charDir: string;
    fileName: string;
    card: CardDoc | null;
}
export async function installCharacter(charDir: string): Promise<InstallCharacterResponse> {
    const res = await apiFetch(`/api/utopinn/characters/${encodeURIComponent(charDir)}/install`, {
        method: 'POST',
    });
    await assertOk(res);
    invalidateCharDocs();
    return (await res.json()) as InstallCharacterResponse;
}

/** 卡文件级操作的统一响应面 —— charDir/fileName 均为新干名(rename/duplicate
 *  会改存储键;avatar 保持原干名)。 */
export interface CardFileResponse {
    charDir: string;
    fileName: string;
    card: CardDoc | null;
}

/** POST /characters/:charDir/rename —— 显示名+存储键一起搬(会话/侧车/CardApp
 *  /资产夹全级联);共享卡服务端先物化。返回新干名。 */
export async function renameCharacter(charDir: string, name: string): Promise<CardFileResponse> {
    const res = await apiFetch(`/api/utopinn/characters/${encodeURIComponent(charDir)}/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    await assertOk(res);
    invalidateCharDocs();
    return (await res.json()) as CardFileResponse;
}

/** POST /characters/:charDir/duplicate —— 复制卡(<stem>_N 命名,私副本落私有层)。 */
export async function duplicateCharacter(charDir: string): Promise<CardFileResponse> {
    const res = await apiFetch(`/api/utopinn/characters/${encodeURIComponent(charDir)}/duplicate`, {
        method: 'POST',
    });
    await assertOk(res);
    invalidateCharDocs();
    return (await res.json()) as CardFileResponse;
}

/** POST /characters/:charDir/avatar —— 换封面:multipart 'avatar',卡数据原样
 *  重打包;JSON 卡服务端 400。 */
export async function replaceCharacterAvatar(charDir: string, file: File): Promise<CardFileResponse> {
    const form = new FormData();
    form.append('avatar', file);
    const res = await apiFetch(`/api/utopinn/characters/${encodeURIComponent(charDir)}/avatar`, {
        method: 'POST',
        body: form,
    });
    await assertOk(res);
    invalidateCharDocs();
    return (await res.json()) as CardFileResponse;
}

/** DELETE /api/utopinn/characters/:charDir —— 删卡(204)。
 *  deleteChats=true 连带该角色全部会话;共享池卡服务端 403。 */
export async function deleteCharacter(charDir: string, opts?: { deleteChats?: boolean }): Promise<void> {
    const res = await apiFetch(`/api/utopinn/characters/${encodeURIComponent(charDir)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete_chats: opts?.deleteChats === true }),
    });
    await assertOk(res);
    invalidateCharDocs(charDir);
}
