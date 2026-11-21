/**
 * utopinn-data —— 数据进出域(原 utopinn-data + utopinn-import 合并,
 * plugin-domain-map §2.1:扫描→预览→落库是同一条管线的三个顺序阶段,
 * 不应被切在两个 fiber 里;备份/LAN 迁移同属「数据过实例边界」)。
 *
 *   POST /api/utopinn/backup          备份快照:createBackupArchive 复用
 *                                    users.js 全量归档机(selection 分类可选)
 *   POST /api/utopinn/import/scan-st  {dir} 扫 ST default-user 目录 →
 *                                    可导入清单(characters/worlds/presets/
 *                                    quickReplies/personas/themes)
 *   POST /api/utopinn/import/preview  {name, dataBase64} 或 multipart(field
 *                                    "avatar")→ 格式探测 + 结构摘要 + 警告 +
 *                                    同名冲突,不落库
 *   POST /api/utopinn/import/commit   {kind?, name?, dataBase64, conflict?,
 *                                    apiId?} → 按 kind 落库:char→characters/*.png、
 *                                    world→WorldInfoRepo、preset→PresetRepo、
 *                                    persona→settings.power_user
 *   POST /api/utopinn/lan/offer       {handle,selection} → {url,expiresAt}
 *                                    与 legacy /api/users/lan-migration/offer 同语义
 *   POST /api/utopinn/lan/import      {handle,url,selection,mode} →
 *                                    loopback 代理到 legacy 流式 import(不复制语义)
 *   UDP <httpPort>                   LAN 发现:对 'utopinn-discover' /
 *                                    {"probe":"utopinn"} 探头回 JSON pong;
 *                                    socket 挂 ctx.effect,插件 dispose 即收
 *
 * 备份面只代理——归档/恢复重活在 legacy users-private 面上,不重复造。
 * 导入边界:预览先行(commit 是显式第二次调用);卡内 regex/CardApp/HTML 面
 * 只列摘要不执行;同名冲突必须显式 conflict='rename|overwrite|skip',缺省→409;
 * 探测失败→422+hints;不做事务,批量由客户端逐条循环。
 */
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import os from 'node:os';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { convertCharacterBook } from '@utopinn/core';
import { isPng, readCardFromPng, toV2, writeCardToPng } from '@utopinn/formats';
import { createBackupArchive, normalizeUserBackupSelection } from '../users.js';
import { createLanMigrationOffer, LAN_MIGRATION_PATH_PREFIX } from '../lan-migration.js';
import { getRequestBaseUrl } from '../express-common.js';
import { getConfigValue } from '../util.js';
import { getPresetRepo, getSettingsRepo, getWorldInfoRepo } from '../storage/index.js';
import { InvalidArgumentError, NotFoundError, StorageReadOnlyError } from '../storage/errors.js';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
import { persistCharXAssets } from '../charx.js';
import { importRisuSprites } from '../endpoints/sprites.js';
import { extractCardAppFiles } from '../endpoints/card-app.js';
import {
    IMPORT_KINDS,
    ImportParseError,
    charTargetStem,
    detectImportPayload,
    personaAvatarKey,
    prepareCardForStorage,
    presetApiId,
    repoTargetName,
    stripImportExt,
} from '../services/import-pipeline.js';

export const inject = ['webServer'];

// ---------------------------------------------------------------------------
// ST 目录扫描(backup/LAN/scan 子域)
// ---------------------------------------------------------------------------

/** ST default-user 数据目录 → 可导入类别映射。 */
const ST_DIRS = [
    ['characters', ['.png'], 'character'],
    ['worlds', ['.json'], 'world'],
    ['Worlds', ['.json'], 'world'],
    ['QuickReplies', ['.json'], 'quickReply'],
    ['OpenAI Settings', ['.json'], 'preset'],
    ['TextGen Settings', ['.json'], 'preset'],
    ['NovelAI Settings', ['.json'], 'preset'],
    ['KoboldAI Settings', ['.json'], 'preset'],
    ['User Avatars', ['.png', '.jpg', '.jpeg', '.webp'], 'persona'],
    ['themes', ['.json'], 'theme'],
];

async function scanStDir(root) {
    const items = [];
    for (const [sub, exts, kind] of ST_DIRS) {
        const dir = path.join(root, sub);
        let files;
        try {
            files = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue; // 缺子目录是常态 —— ST 目录不一定长全
        }
        for (const f of files) {
            if (!f.isFile()) continue;
            if (!exts.includes(path.extname(f.name).toLowerCase())) continue;
            const fp = path.join(dir, f.name);
            const size = (await fs.promises.stat(fp).catch(() => null))?.size ?? 0;
            items.push({ kind, name: path.basename(f.name, path.extname(f.name)), file: fp, bytes: size });
        }
    }
    return items;
}

// ---------------------------------------------------------------------------
// 导入管线(原 utopinn-import.js —— 通用小件)
// ---------------------------------------------------------------------------

/** 统一错误出口:InvalidArgumentError→400,NotFoundError→404,探测失败→422,其余→500。 */
function sendError(response, error, logPrefix) {
    if (error instanceof InvalidArgumentError) {
        return response.status(400).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
        return response.status(404).send({ error: error.message });
    }
    if (error instanceof ImportParseError || Number.isInteger(error?.status)) {
        const body = { error: error.message };
        if (error?.hints) body.hints = error.hints;
        return response.status(error.status ?? 422).send(body);
    }
    if (error instanceof StorageReadOnlyError) {
        return response.status(503).send({ error: error.message });
    }
    console.error(`${logPrefix} failed:`, error);
    return response.status(500).send({ error: String(error?.message ?? error) });
}

/**
 * 取导入载荷:multipart(request.file,全局 multer 落在 _uploads/)优先,
 * 否则 JSON body.dataBase64。multipart 的临时文件读后即删。
 * @returns {Promise<{buffer: Buffer, fileName: string}>}
 */
async function readImportPayload(request) {
    const body = request.body ?? {};
    if (request.file?.path) {
        const uploadPath = request.file.path;
        try {
            const buffer = await fs.promises.readFile(uploadPath);
            return { buffer, fileName: String(body.name || request.file.originalname || '') };
        } finally {
            await fs.promises.unlink(uploadPath).catch(() => { /* best-effort */ });
        }
    }
    if (typeof body.dataBase64 === 'string' && body.dataBase64.trim()) {
        return { buffer: Buffer.from(body.dataBase64, 'base64'), fileName: String(body.name || '') };
    }
    throw new InvalidArgumentError('Import payload required: multipart file (field "avatar") or JSON {name, dataBase64}');
}

// ---------------------------------------------------------------------------
// 名称 → 存储目标 / 冲突(纯推导在 services/import-pipeline.js)
// ---------------------------------------------------------------------------

const CHARACTER_FILE_EXTS = ['.png', '.webp', '.json'];

function charStemExists(directories, stem) {
    // 与 getPngName 同语义:卡文件任一扩展命中,或已有同名 chats 目录
    for (const ext of CHARACTER_FILE_EXTS) {
        if (fs.existsSync(path.join(directories.characters, `${stem}${ext}`))) {
            return true;
        }
    }
    return fs.existsSync(path.join(directories.chats, stem));
}

async function personaExists(handle, avatarKey) {
    const settings = await getSettingsRepo().get(handle) ?? {};
    const powerUser = (settings.power_user && typeof settings.power_user === 'object' && !Array.isArray(settings.power_user))
        ? settings.power_user : {};
    const personas = (powerUser.personas && typeof powerUser.personas === 'object' && !Array.isArray(powerUser.personas))
        ? powerUser.personas : {};
    const descriptions = (powerUser.persona_descriptions && typeof powerUser.persona_descriptions === 'object' && !Array.isArray(powerUser.persona_descriptions))
        ? powerUser.persona_descriptions : {};
    return Object.prototype.hasOwnProperty.call(personas, avatarKey)
        || Object.prototype.hasOwnProperty.call(descriptions, avatarKey);
}

/**
 * 目标名是否已存在(kind 分派)。
 * @param {{kind:string, targetName:string, avatarKey?:string, apiId?:string}} target
 */
async function targetExists(request, target) {
    const handle = request.user.profile.handle;
    switch (target.kind) {
        case 'char':
            return charStemExists(request.user.directories, target.targetName);
        case 'world':
            return (await getWorldInfoRepo().resolveName(handle, target.targetName)) != null;
        case 'preset':
            return (await getPresetRepo().get(handle, target.apiId, target.targetName)) != null;
        case 'persona':
            return personaExists(handle, target.avatarKey);
        default:
            return false;
    }
}

/** 'rename' 冲突策略:base + 递增序号直到空位(同 getPngName 的 Name1/Name2 形)。 */
async function uniqueTarget(request, target) {
    if (!await targetExists(request, target)) {
        return target;
    }
    for (let i = 1; ; i++) {
        const candidate = { ...target };
        if (target.kind === 'persona') {
            const parsed = path.parse(target.avatarKey);
            candidate.avatarKey = `${parsed.name}${i}${parsed.ext}`;
        } else {
            candidate.targetName = `${target.targetName}${i}`;
        }
        if (!await targetExists(request, candidate)) {
            return candidate;
        }
        if (i > 1000) {
            throw new InvalidArgumentError(`Could not find a free name for "${target.targetName}"`);
        }
    }
}

// ---------------------------------------------------------------------------
// 卡面 commit(走 characters.js 的 writeCharacterData 既有写路径)
// ---------------------------------------------------------------------------

/**
 * characters.js 模块加载期会读 config(getConfigValue)——服务端启动时必然
 * 已就绪,但裸测试进程里需要先 setConfigFilePath。把它的引入推迟到第一次
 * commit 时,让本文件保持"轻依赖可独立挂载/测试"。
 */
async function writeCardViaCharacters(input, cardJson, stem, request) {
    const { writeCharacterData } = await import('../endpoints/characters.js');
    return writeCharacterData(input, cardJson, stem, request);
}

/**
 * overwrite 同名片时继承旧卡的 chat 指针(对应旧导入管线的 preserved_chat)。
 * PNG 读 tEXt;纯 JSON 卡兜底。
 * @returns {Promise<string|null>}
 */
async function readPreservedChat(directories, stem) {
    try {
        const raw = await fs.promises.readFile(path.join(directories.characters, `${stem}.png`));
        const card = JSON.parse(readCardFromPng(raw));
        if (typeof card?.chat === 'string' && card.chat) return card.chat;
    } catch { /* 无 png 或读不出卡 → 试 json */ }
    try {
        const card = JSON.parse(await fs.promises.readFile(path.join(directories.characters, `${stem}.json`), 'utf8'));
        return typeof card?.chat === 'string' && card.chat ? card.chat : null;
    } catch {
        return null;
    }
}

let defaultAvatarBytes = null;

/** DEFAULT_AVATAR_PATH 惰性读取(无图源 JSON 卡的底图)。 */
async function defaultAvatar() {
    if (!defaultAvatarBytes) {
        defaultAvatarBytes = await fs.promises.readFile(DEFAULT_AVATAR_PATH);
    }
    return defaultAvatarBytes;
}

/**
 * 覆盖写后失效头像缩略图(同 invalidateThumbnail(directories,'avatar',file):
 * 删 thumbnails/avatar/<stem>.png;不引 thumbnails.js —— 它加载期读 config 且
 * 拖整棵 jimp 依赖树。generateThumbnail 本身也按 mtime 自愈,这里只是对齐旧管线)。
 */
function invalidateAvatarThumbnail(directories, stem) {
    try {
        const thumbnailPath = path.join(directories.thumbnailsAvatar, `${stem}.png`);
        if (fs.existsSync(thumbnailPath)) {
            fs.unlinkSync(thumbnailPath);
        }
    } catch (error) {
        console.warn(`utopinn/data import: failed to invalidate avatar thumbnail for ${stem}:`, error);
    }
}

/**
 * 直写 PNG:formats 的 writeCardToPng 把 card JSON 嵌进底图原子落盘。
 * 相对 writeCharacterData 的优势:原图字节保留(jimp 重编码在本环境
 * wasm codec 拉不起来时会静默退化到默认头像,真实环境也有重编码损耗)、
 * 不依赖 config/jimp。代价:不做 normalizeCharacterCardForStorage 的
 * legacy-root 归并——v1→v2 用 formats toV2 升格,其余在 prepareCardForStorage。
 */
function directWriteCard(directories, stem, baseImage, cardJson) {
    const out = writeCardToPng(baseImage instanceof Uint8Array ? baseImage : new Uint8Array(baseImage), cardJson);
    writeFileAtomicSync(path.join(directories.characters, `${stem}.png`), Buffer.from(out));
}

/**
 * 写一张卡:字段清理/升格 → 辅助资产落盘(charx/risu sprites/card_app.files)→
 * PNG 落 characters/<stem>.png。
 *
 * 写路径选择:
 *   - 底图是 PNG(或无图走默认头像)→ writeCardToPng 直写(保真原图字节;
 *     memoryCache 按 path+mtime 寻址、resource-view 缓存按 raw 内容自校验、
 *     缩略图按 mtime 自愈,直写覆盖不残留旧缓存——overwrite 同样安全,
 *     另显式失效头像缩略图对齐旧管线)。
 *   - 底图非 PNG(charx/byaf 的 jpg/webp)→ writeCharacterData 经 jimp
 *     转码写盘(jimp 不可用时按其既有 fallback 用默认头像);直写失败也回落它。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
/**
 * Materialize an embedded character_book to worlds/<extensions.world>.json
 * — the server-side equivalent of the upstream importEmbeddedWorldInfo and
 * the same materialization path as the in-memory fallbacks in
 * generate-context / mvu-settle. All of them MUST go through
 * convertCharacterBook to turn the v2 card book into world-file shape
 * (uid/keys restored); stuffing the raw card book in would leave every
 * entry sharing the "world.undefined" dedupe key and collapse the whole
 * book into a single entry.
 * The exists-check + write is one atomic WorldInfoRepo.createIfAbsent, so
 * concurrent imports of cards bound to the same world cannot overwrite each
 * other; an existing same-named standalone book is never overwritten — the
 * single exception is `overwrite` (import/commit conflict=overwrite), which
 * follows the upstream re-import semantics: replacing the card refreshes
 * the linked world too (upstream importEmbeddedWorldInfo overwrites the
 * same-named book on re-import). An empty extensions.world does not get a
 * name invented for it; a failed write only warns, it does not sink the
 * import. Every outcome — materialized / skipped / overwrote — leaves a
 * warnings entry so the caller can see what happened to the book.
 * @param {{overwrite?: boolean}} options `overwrite` is the caller's declared
 *   conflict policy (conflict=overwrite), applied to the world-name collision
 *   too — it does NOT hinge on the card file itself being replaced.
 * @returns {Promise<string[]>} entries appended to the commit response warnings
 */
async function materializeEmbeddedWorld(request, card, { overwrite = false } = {}) {
    const bookEntries = card?.data?.character_book?.entries;
    const worldName = String(card?.data?.extensions?.world ?? card?.extensions?.world ?? '').trim();
    if (!Array.isArray(bookEntries) || bookEntries.length === 0 || !worldName) {
        return [];
    }
    const repo = getWorldInfoRepo();
    const handle = request.user.profile.handle;
    try {
        const doc = convertCharacterBook(card.data.character_book);
        if (overwrite) {
            // 卡面被覆盖 ⇒ 绑定的世界书跟着刷新。resolve→save 是两步,但
            // overwrite 语义本身就是"卡的版本赢",不存在需要防的丢失写;
            // save 内部 put 仍按 canonical 名解析落点(resolveName 仅用于
            // 准确报告 overwrote vs materialized)。
            const existing = await repo.resolveName(handle, worldName);
            await repo.save(handle, worldName, doc);
            const name = (await repo.resolveName(handle, worldName)) ?? worldName;
            return [existing != null
                ? `Embedded character_book overwrote world "${name}" (${bookEntries.length} entries).`
                : `Embedded character_book materialized to world "${name}" (${bookEntries.length} entries).`];
        }
        const { created, name } = await repo.createIfAbsent(handle, worldName, doc);
        if (!created) {
            return [`Embedded character_book skipped: world "${name}" already exists — re-import with conflict=overwrite to update it.`];
        }
        return [`Embedded character_book materialized to world "${name}" (${bookEntries.length} entries).`];
    } catch (error) {
        console.warn(`utopinn/data: failed to materialize embedded world "${worldName}":`, error);
        return [`Embedded character_book could not be materialized to world "${worldName}": ${error?.message ?? error}`];
    }
}

async function commitCharacter(request, prepared, stem, { preserveChat = false, overwrite = false, overwriteEmbeddedWorld = false } = {}) {
    const directories = request.user.directories;

    const preservedChat = preserveChat ? await readPreservedChat(directories, stem) : null;
    let card = prepared.card;

    // gradio/Pygmalion 别名 → v1 字段,再走 toV2 升格(对齐 importFromJson 各分支)
    if (card?.spec === undefined) {
        card = { ...card };
        card.name ??= card.char_name;
        card.description ??= card.char_persona;
        card.first_mes ??= card.char_greeting;
        card.mes_example ??= card.example_dialogue;
        card.scenario ??= card.world_scenario;
        card = toV2(card);
    }
    card = prepareCardForStorage(card, { preservedChat });

    // 展示名走 sanitize(对齐 importFromPng);文件干名调用方已定。
    const data = (card.data && typeof card.data === 'object' && !Array.isArray(card.data)) ? card.data : {};
    const displayName = sanitize(String(data.name || card.name || stem)) || 'Unnamed';
    if (card.data && typeof card.data === 'object' && !Array.isArray(card.data)) {
        card.data.name = displayName;
    }
    card.name = displayName;

    // spec 卡:Risu additionalAssets(base64 立绘)落精灵目录并从卡面摘出
    importRisuSprites(directories, card);
    // card_app.files → card-apps/<stem>/ 下,卡面只留 enabled 等元数据
    extractCardAppFiles(card, stem, directories.cardApps);
    // charx 辅助资产:精灵→characters/<显示名>/,背景/杂项→userImages/<显示名>/
    if (prepared.format === 'charx' && Array.isArray(prepared.auxAssets) && prepared.auxAssets.length > 0) {
        try {
            persistCharXAssets(prepared.auxAssets, prepared.extractedBuffers, directories, displayName);
        } catch (error) {
            console.warn(`utopinn/data import: failed to persist CharX assets for ${displayName}:`, error);
        }
    }

    const cardJson = JSON.stringify(card);
    const baseIsPng = prepared.imageBuffer != null && isPng(prepared.imageBuffer);

    if (prepared.imageBuffer == null || baseIsPng) {
        try {
            const baseImage = prepared.imageBuffer ?? await defaultAvatar();
            directWriteCard(directories, stem, baseImage, cardJson);
            if (overwrite) {
                invalidateAvatarThumbnail(directories, stem);
            }
            return { ok: true, warnings: await materializeEmbeddedWorld(request, card, { overwrite: overwriteEmbeddedWorld }) };
        } catch (error) {
            // 底图畸形 / 默认头像缺失等 → 退回 writeCharacterData 的兜底链
            console.warn('utopinn/data import: direct PNG write failed, falling back to writeCharacterData:', error);
        }
    }

    const imageInput = prepared.imageBuffer ? Buffer.from(prepared.imageBuffer) : DEFAULT_AVATAR_PATH;
    const ok = await writeCardViaCharacters(imageInput, cardJson, stem, request);
    if (!ok) {
        return { ok: false, error: request?.lastWriteCharacterDataError || 'character write failed' };
    }
    return { ok: true, warnings: await materializeEmbeddedWorld(request, card, { overwrite: overwriteEmbeddedWorld }) };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function apply(ctx) {
    const reg = (path_, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path: path_, handler }));

    /** 备份快照——复用 createBackupArchive(handle,response,selection)。 */
    reg('/api/utopinn/backup', async function (request, response) {
        try {
            const selection = request.body?.selection && typeof request.body.selection === 'object'
                ? request.body.selection : undefined;
            await createBackupArchive(request.user.profile.handle, response, selection);
        } catch (error) {
            console.error('[utopinn/backup] failed:', error);
            if (!response.headersSent) return response.status(500).send({ error: 'backup failed' });
        }
    });

    /** LAN 迁移 offer——与 legacy 同语义:selection 消毒 + token + offer URL。 */
    reg('/api/utopinn/lan/offer', async function (request, response) {
        const handle = String(request.body?.handle ?? request.user.profile.handle).trim();
        if (!handle) return response.status(400).send({ error: 'Missing required fields' });
        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).send({ error: 'Unauthorized' });
        }
        const isAdmin = Boolean(request.user?.profile?.admin);
        let sel = request.body?.selection;
        if (typeof sel === 'string') { try { sel = JSON.parse(sel); } catch { sel = {}; } }
        const selection = normalizeUserBackupSelection(sel);
        if (!isAdmin) selection.globalExtensions = false;
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).send({ error: 'At least one backup category must be selected.' });
        }
        const { token, expiresAt } = createLanMigrationOffer({ handle, selection, includeGlobalExtensions: isAdmin });
        const url = `${getRequestBaseUrl(request).replace(/\/+$/, '')}${LAN_MIGRATION_PATH_PREFIX}${token}`;
        return response.send({ url, expiresAt });
    });

    /** LAN 迁移 import——薄代理:转发会话凭据到 legacy 流式端点,语义不复制。 */
    reg('/api/utopinn/lan/import', async function (request, response) {
        const port = Number(getConfigValue('port', 8000));
        const headers = { 'content-type': 'application/json' };
        for (const h of ['cookie', 'x-csrf-token', 'accept']) {
            if (request.headers[h]) headers[h] = request.headers[h];
        }
        let upstream;
        try {
            upstream = await fetch(`http://127.0.0.1:${port}/api/users/lan-migration/import`, {
                method: 'POST', headers, body: JSON.stringify(request.body ?? {}),
            });
        } catch (error) {
            return response.status(502).send({ error: `lan import upstream failed: ${error.message}` });
        }
        response.status(upstream.status);
        for (const h of ['content-type', 'content-disposition']) {
            const v = upstream.headers.get(h);
            if (v) response.setHeader(h, v);
        }
        const text = await upstream.text();
        return response.send(text);
    });

    /** ST 目录扫描——清单化,不导入;导入走 /import/preview+commit。 */
    reg('/api/utopinn/import/scan-st', async function (request, response) {
        if (!request.user?.profile?.admin) {
            return response.status(403).send({ error: 'Unauthorized' });
        }
        const dir = String(request.body?.dir ?? '').trim();
        if (!dir) return response.status(400).send({ error: 'dir is required' });
        const root = path.resolve(dir);
        const st = await fs.promises.stat(root).catch(() => null);
        if (!st?.isDirectory()) return response.status(404).send({ error: `not a directory: ${root}` });
        const items = await scanStDir(root);
        const counts = {};
        for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
        return response.send({ root, total: items.length, counts, items });
    });

    /**
     * POST /import/preview —— 探测 + 摘要 + 警告 + 冲突,不落库。
     * 响应:{kind,name,targetName,summary,warnings,conflicts:{existingSameName}}
     */
    reg('/api/utopinn/import/preview', async function (request, response) {
        try {
            const { buffer, fileName } = await readImportPayload(request);
            const detected = detectImportPayload({ fileName, buffer });

            const handle = request.user.profile.handle;
            const apiId = detected.kind === 'preset' ? presetApiId(request.body?.apiId ?? detected.summary.apiId) : null;
            const target = previewTarget(request, detected, apiId);
            const existingSameName = await targetExists(request, target);

            const warnings = [...detected.warnings];
            if (detected.kind === 'char' && detected.summary.boundWorld) {
                const bound = await getWorldInfoRepo().resolveName(handle, detected.summary.boundWorld);
                if (bound == null) {
                    warnings.push(`Card is bound to world "${detected.summary.boundWorld}", which is not in this library.`);
                }
            }

            return response.send({
                kind: detected.kind,
                name: detected.name,
                targetName: target.targetName,
                avatarKey: target.avatarKey,
                summary: detected.summary,
                warnings,
                conflicts: { existingSameName },
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/import preview');
        }
    });

    /**
     * preview/commit 共用的初始目标名推导。body.targetName 是显式覆盖;
     * body.name 只作"原始文件名"提示(扩展名嗅探 + 无名载荷回退),不当目标名。
     */
    function previewTarget(request, detected, apiId) {
        const requested = request.body?.targetName;
        switch (detected.kind) {
            case 'char':
                return { kind: 'char', targetName: charTargetStem(requested, detected.name) };
            case 'world':
            case 'preset':
                return { kind: detected.kind, targetName: repoTargetName(requested, detected.name), apiId };
            case 'persona': {
                const displayName = stripImportExt(requested) || detected.name;
                return {
                    kind: 'persona',
                    targetName: displayName,
                    avatarKey: personaAvatarKey(detected.prepared.doc, displayName),
                };
            }
            default:
                throw new ImportParseError(`Unsupported import kind: ${detected.kind}`);
        }
    }

    const CONFLICT_POLICIES = new Set(['rename', 'overwrite', 'skip']);

    /**
     * POST /import/commit —— 显式落库。
     * {kind?, name?|targetName?, dataBase64 | multipart, conflict?, apiId?}
     * 响应:{ok,kind,name,targetName,renamed,skipped?,avatarKey?,warnings}
     */
    reg('/api/utopinn/import/commit', async function (request, response) {
        try {
            const body = request.body ?? {};
            if (body.kind != null && !IMPORT_KINDS.includes(body.kind)) {
                throw new InvalidArgumentError(`kind must be one of: ${IMPORT_KINDS.join(', ')}`);
            }
            const { buffer, fileName } = await readImportPayload(request);
            const detected = detectImportPayload({ fileName, buffer });
            if (body.kind != null && body.kind !== detected.kind) {
                return response.status(422).send({
                    error: `Declared kind "${body.kind}" does not match detected kind "${detected.kind}"`,
                });
            }

            const apiId = detected.kind === 'preset' ? presetApiId(body.apiId ?? detected.summary.apiId) : null;
            let target = previewTarget(request, detected, apiId);
            const initialTargetName = target.targetName;
            const initialAvatarKey = target.avatarKey;

            const existing = await targetExists(request, target);
            let overwritePolicy = false;
            if (existing) {
                const policy = String(body.conflict ?? '').trim();
                if (!CONFLICT_POLICIES.has(policy)) {
                    return response.status(409).send({
                        error: `Name conflict for "${target.targetName}"; pass conflict=rename|overwrite|skip`,
                        conflicts: { existingSameName: true },
                    });
                }
                if (policy === 'skip') {
                    return response.send({
                        ok: true, skipped: true, kind: detected.kind,
                        name: detected.name, targetName: target.targetName, renamed: false,
                    });
                }
                if (policy === 'rename') {
                    target = await uniqueTarget(request, target);
                }
                // 'overwrite' → 沿用 targetName 直接写;rename 落的是新 stem,
                // preserveChat/overwrite(char 文件面的替换语义)只属于真覆盖。
                overwritePolicy = policy === 'overwrite';
            }

            // 世界书物化面的冲突裁决跟着用户声明的策略走,不挂卡面冲突:
            // 卡被删但物化书残留时再导,overwrite 同样要把书刷新(issue #7
            // 同款陷阱)——conflict 语义是"本导入撞上同名数据就让载荷赢"。
            const wantsOverwrite = String(body.conflict ?? '').trim() === 'overwrite';
            const result = await commitDetected(request, detected, target, {
                preserveChat: detected.kind === 'char' && overwritePolicy,
                overwrite: detected.kind === 'char' && overwritePolicy,
                overwriteEmbeddedWorld: detected.kind === 'char' && wantsOverwrite,
            });
            if (!result.ok) {
                return response.status(500).send({ error: result.error || 'import commit failed' });
            }
            const renamed = target.targetName !== initialTargetName
                || (target.avatarKey != null && target.avatarKey !== initialAvatarKey);
            return response.send({
                ok: true,
                kind: detected.kind,
                name: detected.name,
                targetName: target.targetName,
                avatarKey: target.avatarKey,
                renamed,
                warnings: result.warnings ?? [],
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/import commit');
        }
    });

    async function commitDetected(request, detected, target, { preserveChat = false, overwrite = false, overwriteEmbeddedWorld = false } = {}) {
        const handle = request.user.profile.handle;
        switch (detected.kind) {
            case 'char':
                return commitCharacter(request, detected.prepared, target.targetName, { preserveChat, overwrite, overwriteEmbeddedWorld });
            case 'world':
                await getWorldInfoRepo().save(handle, target.targetName, detected.prepared.doc);
                return { ok: true };
            case 'preset':
                await getPresetRepo().save(handle, target.apiId, target.targetName, detected.prepared.doc);
                return { ok: true };
            case 'persona':
                return commitPersona(handle, detected.prepared.doc, target);
            default:
                throw new ImportParseError(`Unsupported import kind: ${detected.kind}`);
        }
    }

    /**
     * persona → settings.power_user.personas[avatarKey]=name +
     * persona_descriptions[avatarKey]={...}。整体读改写,与 PATCH /settings 同型。
     */
    async function commitPersona(handle, doc, target) {
        const repo = getSettingsRepo();
        const settings = await repo.get(handle) ?? {};
        const root = (settings && typeof settings === 'object' && !Array.isArray(settings)) ? settings : {};
        const powerUser = (root.power_user && typeof root.power_user === 'object' && !Array.isArray(root.power_user))
            ? root.power_user : {};
        const personas = (powerUser.personas && typeof powerUser.personas === 'object' && !Array.isArray(powerUser.personas))
            ? powerUser.personas : {};
        const descriptions = (powerUser.persona_descriptions && typeof powerUser.persona_descriptions === 'object' && !Array.isArray(powerUser.persona_descriptions))
            ? powerUser.persona_descriptions : {};

        const descriptor = { ...doc };
        delete descriptor.name;
        delete descriptor.avatar;

        const next = {
            ...root,
            power_user: {
                ...powerUser,
                personas: { ...personas, [target.avatarKey]: target.targetName },
                persona_descriptions: { ...descriptions, [target.avatarKey]: descriptor },
            },
        };
        await repo.save(handle, next);
        return { ok: true };
    }

    /** LAN 发现:UDP 绑在 HTTP 同端口(UDP/TCP 端口互不冲突)。 */
    ctx.effect(() => {
        const port = Number(getConfigValue('port', 8000));
        const socket = dgram.createSocket('udp4');
        socket.on('error', (e) => console.warn('[utopinn/discover] udp error:', e.message));
        socket.on('message', (msg, rinfo) => {
            const text = msg.toString('utf-8').trim();
            if (text !== 'utopinn-discover' && !text.includes('"utopinn"')) return;
            const payload = JSON.stringify({
                app: 'utopinn', name: os.hostname(),
                httpPort: port,
                version: process.env.npm_package_version ?? 'dev',
            });
            socket.send(payload, rinfo.port, rinfo.address, () => {});
        });
        socket.bind(port);
        console.log(`[utopinn/discover] udp responder on :${port}`);
        return () => { try { socket.close(); } catch { /* already closed */ } };
    });
}
