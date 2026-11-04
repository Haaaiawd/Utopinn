// /api/uberge/import 导入管线(apps/server/src/plugins/uberge-import.js)。
// 两段式:preview(探测+摘要+警告+同名冲突,不落库)→ commit(显式落库)。
// SPA 统一走 {name, dataBase64} JSON 面;multipart(field "avatar")留给旧 UI。
// 降级惯例同 preview.ts:服务端不可达(TypeError / 代理 502)→ 本地嗅探的
// mock 预览(徽标诚实标注,commit 是真实写操作,mock 下前端禁按);
// 真实 HTTP 错(422 探测失败/409 冲突/500)照常抛给视图。
import { ApiError, apiFetch } from './client';

export type ImportKind = 'char' | 'world' | 'preset' | 'persona';
export type ImportConflictPolicy = 'rename' | 'overwrite' | 'skip';

/** summary 是 kind 合集:char 带卡面清单,world/preset/persona 各带自己的小面。 */
export interface ImportSummary {
    name?: string;
    spec?: string;
    fields?: string[];
    bookEntries?: number;
    regexScripts?: number;
    regexScriptNames?: string[];
    depthPrompt?: { promptLength: number; depth: number | null; role: string | null } | null;
    firstGreetingLen?: number;
    alternateGreetings?: number;
    cardAppFiles?: number;
    boundWorld?: string | null;
    tags?: string[];
    creator?: string;
    avatar?: 'bundled' | 'none' | string;
    sourceFormat?: string;
    /* world */
    entries?: number;
    /* preset */
    apiId?: string;
    prompts?: number;
    keys?: number;
    /* persona */
    descriptionLen?: number;
    position?: number | null;
    title?: string;
}

/** POST /import/preview 回包。 */
export interface ImportPreview {
    kind: ImportKind;
    name: string;
    targetName: string;
    /** persona 专有:落库键(头像文件名)。 */
    avatarKey?: string;
    summary: ImportSummary;
    warnings: string[];
    conflicts: { existingSameName: boolean };
}

/** 探测失败(422)/冲突(409)时服务端在 body 带 hints —— ApiError 丢掉,这里留住。 */
export class ImportApiError extends ApiError {
    constructor(
        message: string,
        status?: number,
        public readonly hints?: Record<string, unknown>,
    ) {
        super(message, status);
        this.name = 'ImportApiError';
    }
}

export interface ImportPreviewResult {
    data: ImportPreview | null;
    /** true = 服务端不可达,data 是本地嗅探的 mock。 */
    mock: boolean;
    error?: string;
    hints?: Record<string, unknown>;
}

export interface ImportCommitBody {
    /** 原始文件名(扩展名嗅探提示),不当目标名。 */
    name?: string;
    /** 显式覆盖落点名;缺省走探测名推导。 */
    targetName?: string;
    dataBase64: string;
    kind?: ImportKind;
    /** 同名已存在时必给:rename|overwrite|skip,缺省 → 409。 */
    conflict?: ImportConflictPolicy;
    apiId?: string;
}

export interface ImportCommitResult {
    ok: boolean;
    kind: ImportKind;
    name: string;
    targetName: string;
    avatarKey?: string;
    renamed: boolean;
    skipped?: boolean;
    warnings?: string[];
}

/** 待办队列单元:全局拖放/选文件/URL 都先落成 draft 再进导入中心。 */
export interface ImportDraft {
    id: string;
    /** 原始文件名(URL 导入 = 链接末段)。 */
    name: string;
    dataBase64: string;
}

/** dataBase64 约 ×1.33 膨胀;服务端 JSON limit 500mb,浏览器读文件先自限。 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

let draftSeq = 0;
export function nextDraftId(): string {
    return `imp-${Date.now()}-${++draftSeq}`;
}

export function bytesToBase64(u8: Uint8Array): string {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

export async function fileToDraft(file: File): Promise<ImportDraft> {
    const buf = new Uint8Array(await file.arrayBuffer());
    return { id: nextDraftId(), name: file.name || 'import', dataBase64: bytesToBase64(buf) };
}

async function postImport<T>(path: string, body: unknown): Promise<T> {
    const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const unreachable = res.status === 502 && res.headers.has('x-uberge-proxy-error');
        const parsed = await res.json().catch(() => null) as
            { error?: string; hints?: Record<string, unknown> } | null;
        throw new ImportApiError(
            unreachable ? 'upstream_unavailable' : (parsed?.error || res.statusText),
            res.status,
            parsed?.hints,
        );
    }
    return (await res.json()) as T;
}

export async function previewImport(name: string, dataBase64: string): Promise<ImportPreview> {
    return postImport<ImportPreview>('/api/uberge/import/preview', { name, dataBase64 });
}

export async function commitImport(body: ImportCommitBody): Promise<ImportCommitResult> {
    return postImport<ImportCommitResult>('/api/uberge/import/commit', body);
}

// ---------------------------------------------------------------------------
// 离线 mock 嗅探 —— 服务端不可达时让导入中心保持可演示。
// 只复刻探测的形状(kind+粗摘要),正则/CardApp 面等细节不在客户端重做;
// commit 仍要求在线(mock 预览下视图禁按)。
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function stemOf(fileName: string): string {
    const base = fileName.split('/').pop() ?? fileName;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

function mockCharSummary(card: Record<string, unknown>, format: string, bundled: boolean): ImportSummary {
    const data = isPlainObject(card.data) ? card.data : card;
    const ext = isPlainObject(data.extensions) ? data.extensions : {};
    const book = isPlainObject(data.character_book) ? data.character_book : null;
    const entries = book?.entries;
    const regex = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
    const cardApp = isPlainObject(ext.card_app) && isPlainObject(ext.card_app.files)
        ? Object.keys(ext.card_app.files).length : 0;
    return {
        name: typeof data.name === 'string' ? data.name : '',
        spec: typeof card.spec === 'string' ? card.spec : 'chara_card_v1',
        bookEntries: Array.isArray(entries) ? entries.length : (isPlainObject(entries) ? Object.keys(entries).length : 0),
        regexScripts: regex.length,
        cardAppFiles: cardApp,
        boundWorld: typeof ext.world === 'string' ? ext.world : null,
        tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
        avatar: bundled ? 'bundled' : 'none',
        sourceFormat: format,
    };
}

function sniffLocal(name: string, dataBase64: string): ImportPreview {
    const u8 = base64ToBytes(dataBase64);
    if (u8.length === 0) throw new Error('empty payload');
    const stem = stemOf(name) || 'import';

    if (PNG_MAGIC.every((b, i) => u8[i] === b)) {
        return {
            kind: 'char', name: stem, targetName: stem,
            summary: { name: stem, avatar: 'bundled', sourceFormat: 'png' },
            warnings: [], conflicts: { existingSameName: false },
        };
    }
    // ZIP(charx/byaf):内容识别在服务端,离线只给容器级摘要。
    if (u8[0] === 0x50 && u8[1] === 0x4b) {
        return {
            kind: 'char', name: stem, targetName: stem,
            summary: { name: stem, avatar: 'bundled', sourceFormat: 'zip' },
            warnings: [], conflicts: { existingSameName: false },
        };
    }

    let obj: unknown;
    try {
        obj = JSON.parse(new TextDecoder().decode(u8));
    } catch {
        throw new Error('unrecognized payload (not PNG, ZIP, or JSON)');
    }
    if (!isPlainObject(obj)) throw new Error('JSON document is not an object');

    if (isPlainObject(obj.entries)) {
        return {
            kind: 'world', name: typeof obj.name === 'string' && obj.name ? obj.name : stem, targetName: stem,
            summary: { name: stem, entries: Object.keys(obj.entries).length },
            warnings: [], conflicts: { existingSameName: false },
        };
    }
    if (Array.isArray(obj.prompts)) {
        return {
            kind: 'preset', name: typeof obj.name === 'string' && obj.name ? obj.name : stem, targetName: stem,
            summary: { name: stem, apiId: 'openai', prompts: obj.prompts.length, keys: Object.keys(obj).length },
            warnings: [], conflicts: { existingSameName: false },
        };
    }
    const looksCard = (typeof obj.spec === 'string' && obj.spec.startsWith('chara_card'))
        || 'first_mes' in obj || 'char_name' in obj || isPlainObject(obj.data);
    if (looksCard) {
        const summary = mockCharSummary(obj, 'json', false);
        return {
            kind: 'char', name: summary.name || stem, targetName: summary.name || stem,
            summary, warnings: [], conflicts: { existingSameName: false },
        };
    }
    if (typeof obj.description === 'string') {
        return {
            kind: 'persona', name: typeof obj.name === 'string' && obj.name ? obj.name : stem, targetName: stem,
            summary: { name: stem, descriptionLen: obj.description.length, title: typeof obj.title === 'string' ? obj.title : '' },
            warnings: [], conflicts: { existingSameName: false },
        };
    }
    throw new Error('JSON does not look like a card, worldbook, preset, or persona');
}

/**
 * Preview with honest fallback(同 postPreviewWithFallback 的契约):
 * 网络层不可达 → mock 嗅探;真实 4xx/5xx → error+hints 交回视图。
 */
export async function previewImportWithFallback(name: string, dataBase64: string): Promise<ImportPreviewResult> {
    try {
        return { data: await previewImport(name, dataBase64), mock: false };
    } catch (error) {
        const unreachable = error instanceof TypeError ||
            (error instanceof ApiError && error.status === 502);
        if (!unreachable) {
            return {
                data: null, mock: false,
                error: error instanceof Error ? error.message : String(error),
                hints: error instanceof ImportApiError ? error.hints : undefined,
            };
        }
        try {
            return { data: sniffLocal(name, dataBase64), mock: true };
        } catch (e) {
            return { data: null, mock: true, error: e instanceof Error ? e.message : String(e) };
        }
    }
}
