/**
 * utopinn-library —— 首个 kernel 路由插件(B 步小面先行)。
 *
 * 原来 utopinn-library.js 的 10 个只读 GET 全部经 webServer.register()
 * 贡献;写路径(DELETE chat / PATCH settings)仍由 legacy Express router
 * 挂在同前缀下 —— dispatcher 未命中时 next() 落回,按面切不翻桌。
 *
 * 迁移准则:handler 原样搬(Express req/res 对象照拿),只把
 * router.get(path) 换成 ctx.webServer.register({method, path, handler})
 * pattern 形。插件 inject webServer:服务未提供时整个插件等待,
 * 不会出现半挂状态。
 */
import fs from 'node:fs';
import path from 'node:path';

import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { read as readCharacterCard } from '../character-card-parser.js';
import { getChatRepo, getPresetRepo, getSettingsRepo, getStorageEngine, getWorldInfoRepo } from '../storage/index.js';
import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';
import { applyJsonPatch } from '../storage/repositories/json-patch.js';
import {
    ConflictError,
    InvalidArgumentError,
    NotFoundError,
    PatchMissingParentError,
    PatchTestFailedError,
    StorageReadOnlyError,
    UnsupportedPatchOpError,
} from '../storage/errors.js';
import { assertSafeRepoName, stripJsonlExt } from '../storage/name-validation.js';
import { sendJsonResource, sendResourceReadError } from '../http-resource-cache.js';
import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import { SecretManager, SECRET_KEYS } from '../endpoints/secrets.js';
// TASK-032 写盘面统一:ack/integrity/gen-id/settle 机制与 legacy /api/chats 同源。
import sanitize from 'sanitize-filename';
import {
    acknowledgeGenerationFromValueOrPersistTarget,
    readLastChatGenerationId,
    writeLastChatGenerationId,
    refreshRecentChatIndexEntry,
    resettleMvuAfterWrite,
    settleMvuAfterAppend,
    sanitizeOperationsAgainstLukerGenerationId,
    getBackupFunction,
    writeChatSyncState,
    applyIntegrityToMetadata,
    sendRepoIntegrityConflict,
    createChatHeader,
    checkIntegrity,
    stripLukerGenerationIdFromMessage,
    isChatMessageLike,
    createIntegrityMismatchError,
    // state sidecar 三族:chat_state 判定链与 legacy /api/chats/state/* 同源。
    chatStateTargetFromQuery,
    resolveChatStateRepoKey,
    normalizeChatStateNamespace,
    applyChatStatePatch,
    isChatStatePatchConflictError,
    isJsonPatchValidationError,
    deleteRecentChatIndexEntry,
    deleteAllChatStateSidecars,
    // recent-chats 读面:/chats/recent 与 legacy /api/chats/recent 同一索引与排序源。
    ensureRecentChatIndex,
    getRecentChatSortTime,
} from '../endpoints/chats.js';
import {
    getQueryCharacterAvatar,
    normalizeCharacterStateNamespace,
    getCharacterStateSidecarPath,
    readCharacterStateSidecar,
    mapCharacterStatePatchError,
} from '../endpoints/characters.js';
import {
    isValidApiId,
    normalizePresetStateNamespace,
    mapStatePatchError,
} from '../endpoints/presets.js';

export const inject = ['webServer'];

/** charDir/chatName 里禁止的字符:路径分隔符与 NUL(防目录穿越)。 */
const UNSAFE_NAME_RE = /[/\\\x00]/;
const MAX_NAME_LEN = 128;

/**
 * 校验路由参数里的资源名(charDir/chatName/preset/world 名)。
 * @param {string} raw
 * @param {string} field 错误消息用的字段名
 * @returns {string} trim 后的安全名;非法时抛 InvalidArgumentError → 400
 */
export function safeName(raw, field) {
    const name = String(raw ?? '').trim();
    if (!name) throw new InvalidArgumentError(`${field} is required`);
    if (UNSAFE_NAME_RE.test(name) || name === '.' || name === '..') {
        throw new InvalidArgumentError(`${field} contains unsafe characters`);
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_LEN * 4) {
        // 参数侧给宽一点的上限(兼容旧数据的长文件名),写路径仍由 Repo 层收 128
        throw new InvalidArgumentError(`${field} is too long`);
    }
    return name;
}

/** 统一错误出口:InvalidArgumentError→400,NotFoundError→404,ConflictError→409,patch 语义错→对应映射,其余→500。 */
export function sendError(response, error, logPrefix) {
    if (error instanceof InvalidArgumentError) {
        return response.status(400).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
        return response.status(404).send({ error: error.message });
    }
    if (error instanceof ConflictError || error instanceof PatchTestFailedError || error instanceof PatchMissingParentError) {
        return response.status(409).send({ error: error.message });
    }
    if (error instanceof UnsupportedPatchOpError) {
        return response.status(400).send({ error: error.message });
    }
    if (error instanceof StorageReadOnlyError) {
        return response.status(503).send({ error: 'storage_read_only' });
    }
    console.error(`${logPrefix} failed:`, error);
    return response.status(500).send({ error: String(error?.message ?? error) });
}

// ---------------------------------------------------------------------------
// 角色卡(无 Repo 层,直接读 characters/ 下的 PNG/JSON)
// ---------------------------------------------------------------------------

const CHARACTER_IMAGE_EXTS = new Set(['.png', '.webp']);

/**
 * 读取一张角色卡:<charDir>.png(或 .webp)优先,退回 <charDir>.json。
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} charDir 不含扩展名的角色目录名
 * @returns {Promise<object|null>} 解析后的卡对象(CCv2 形状,data.* 持有字段);找不到返回 null
 */
async function loadCharacterDoc(directories, charDir) {
    const dir = directories.characters;
    for (const ext of ['.png', '.webp']) {
        const imagePath = path.join(dir, `${charDir}${ext}`);
        try {
            const raw = await fs.promises.readFile(imagePath);
            return JSON.parse(readCharacterCard(raw));
        } catch {
            // 该扩展名不存在或不含卡数据 → 继续尝试下一个
        }
    }
    try {
        const raw = await fs.promises.readFile(path.join(dir, `${charDir}.json`), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * persist-target hint 用的真实头像文件名:<charDir>.png/.webp 顺序探测,
 * 都不存在回退 .png。硬编码 .png 会让 webp 卡的 ack/settle chatKey 漂移(M8)。
 */
async function resolveAvatarFileName(directories, charDir) {
    for (const ext of ['.png', '.webp']) {
        try {
            await fs.promises.access(path.join(directories.characters, `${charDir}${ext}`));
            return `${charDir}${ext}`;
        } catch { /* 下一个扩展名 */ }
    }
    return `${charDir}.png`;
}

/** 从卡对象提取展示名与标签(兼容 v1 平铺与 v2 data.*)。 */
function cardFields(card) {
    const data = (card?.data && typeof card.data === 'object' && !Array.isArray(card.data)) ? card.data : card ?? {};
    const name = typeof data.name === 'string' && data.name ? data.name
        : (typeof card?.name === 'string' && card.name ? card.name : '');
    const tags = Array.isArray(data.tags) ? data.tags
        : (Array.isArray(card?.tags) ? card.tags : []);
    return { name, tags };
}

// ---------------------------------------------------------------------------
// 预设(预设 apiId 校验)
// ---------------------------------------------------------------------------

/** apiId 校验:不在映射表里 → InvalidArgumentError → 400。 */
function presetApiId(raw) {
    const apiId = String(raw ?? 'openai').trim() || 'openai';
    if (!Object.prototype.hasOwnProperty.call(PRESET_FOLDER_BY_API_ID, apiId)) {
        throw new InvalidArgumentError(
            `apiId must be one of: ${Object.keys(PRESET_FOLDER_BY_API_ID).join(', ')}`,
        );
    }
    return apiId;
}

// ---------------------------------------------------------------------------
// Settings 脱敏(GET 读视图用;PATCH 白名单仍由 legacy router 持有)
// ---------------------------------------------------------------------------

// 不做泛化的 `_key$` 后缀规则:`new_key`/`sort_key` 一类正常字段会被误伤
// (剥掉只影响响应视图,但薄客户端看不到该字段同样是个 bug)。`<provider>_key`
// 这种不带 api 前缀的稀有命名漏网可接受 —— ST 自己的密钥全是 api_key_* 形。
const SECRET_FIELD_RE = /(^|_)(api_?keys?|secrets?|passwords?|passwds?|credentials?|access_?keys?|private_?keys?|service_?accounts?|auth_?tokens?|session_?tokens?|bearer|headers?)($|_)/i;

/**
 * 深拷贝一份 settings doc,递归删除命中 SECRET_FIELD_RE 的叶键。
 * @param {*} value
 * @returns {*}
 */
export function sanitizeSettingsDoc(value) {
    if (Array.isArray(value)) {
        return value.map(sanitizeSettingsDoc);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) {
            if (SECRET_FIELD_RE.test(key)) continue;
            out[key] = sanitizeSettingsDoc(child);
        }
        return out;
    }
    return value;
}

/**
 * PATCH /settings 允许的顶层段。
 * `oai_settings` 承载连接配置(source/baseUrl/model 选择,连接设置 tab 依赖);
 * 合入前过 sanitizeSettingsDoc——api_key_* 形字段一律拒绝落盘,密钥走 /secrets。
 */
const PATCHABLE_SETTINGS_SECTIONS = new Set(['power_user', 'extension_settings', 'oai_settings']);

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

const P = '/api/utopinn';

export function apply(ctx) {
    const ws = ctx.webServer;
    const reg = (path, handler) => ctx.effect(() => ws.register({ kind: 'pattern', method: 'GET', path, handler }));
    const regPost = (path, method, handler) => ctx.effect(() => ws.register({ kind: 'pattern', method, path, handler }));

    /**
     * GET /characters —— 角色库列表。
     * {items:[{charDir,name,avatar,fileName,fileSize,tags}],total}
     */
    reg(`${P}/characters`, async function (request, response) {
        try {
            const dir = request.user.directories.characters;
            let entries;
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                entries = [];
            }

            // 收集候选 charDir:图片卡按文件名;json 卡只在无同名图片时列出
            const stems = new Map(); // charDir -> {fileName, fileSize, isImage}
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                const ext = path.extname(entry.name).toLowerCase();
                const stem = entry.name.slice(0, -ext.length);
                if (!stem) continue;
                if (CHARACTER_IMAGE_EXTS.has(ext)) {
                    const stat = await fs.promises.stat(path.join(dir, entry.name)).catch(() => null);
                    stems.set(stem, {
                        fileName: entry.name,
                        fileSize: stat?.size ?? 0,
                        ctimeMs: stat?.ctimeMs ?? 0,
                        isImage: true,
                    });
                }
            }
            for (const entry of entries) {
                if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
                const stem = entry.name.slice(0, -'.json'.length);
                if (!stem || stems.has(stem)) continue;
                const stat = await fs.promises.stat(path.join(dir, entry.name)).catch(() => null);
                stems.set(stem, {
                    fileName: entry.name,
                    fileSize: stat?.size ?? 0,
                    ctimeMs: stat?.ctimeMs ?? 0,
                    isImage: false,
                });
            }

            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const items = [];
            for (const [charDir, info] of stems) {
                const card = await loadCharacterDoc(request.user.directories, charDir);
                const fields = card ? cardFields(card) : { name: '', tags: [] };
                // legacy /api/characters/all 语义:date_last_chat = 该角色全部会话 updatedAt 最大值
                let dateLastChat = 0;
                try {
                    const chatEntries = await repo.listForCharacter(handle, charDir, { orderBy: 'name' });
                    for (const entry of chatEntries) {
                        const updatedAt = Number(entry?.updatedAt ?? 0);
                        if (updatedAt > dateLastChat) dateLastChat = updatedAt;
                    }
                } catch { /* 列表 enrich 失败不阻塞角色列出 */ }
                items.push({
                    charDir,
                    name: fields.name || charDir,
                    avatar: info.isImage ? info.fileName : null,
                    fileName: info.fileName,
                    fileSize: info.fileSize,
                    tags: fields.tags,
                    // 卡文件存在但解析失败时仍列出,名字退化回 charDir
                    readable: card != null,
                    // legacy:date_added = 卡文件 ctime;date_last_chat = 最近会话活跃
                    dateAdded: info.ctimeMs ?? 0,
                    dateLastChat,
                });
            }
            items.sort((a, b) => a.name.localeCompare(b.name));
            return response.send({ items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/characters list');
        }
    });

    /** GET /characters/:charDir —— 完整角色卡 JSON。 */
    reg(`${P}/characters/:charDir`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const card = await loadCharacterDoc(request.user.directories, charDir);
            if (!card) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            return response.send(card);
        } catch (error) {
            return sendError(response, error, 'utopinn/characters get');
        }
    });

    /**
     * GET /characters/:charDir/chats —— 某角色下全部会话。
     * {items:[{name,fileName,messageCount,byteSize,lastMessage,chatMetadata,
     *          updatedAt,createdAt,integrity}],total}
     */
    reg(`${P}/characters/:charDir/chats`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const entries = await repo.listForCharacter(handle, charDir, { orderBy: 'name' });

            const items = [];
            for (const entry of entries) {
                const info = await repo.getInfo(handle, charDir, entry.key.name);
                if (!info) continue;
                items.push({
                    name: info.name,
                    fileName: `${info.name}.jsonl`,
                    messageCount: info.messageCount,
                    byteSize: info.byteSize,
                    lastMessage: info.lastMessage,
                    chatMetadata: info.chatMetadata,
                    updatedAt: info.updatedAt,
                    createdAt: info.createdAt,
                    integrity: info.integrity,
                });
            }
            return response.send({ items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats list');
        }
    });

    /** GET /characters/:charDir/chats/:chatName —— 单会话(header + messages)。 */
    reg(`${P}/characters/:charDir/chats/:chatName`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const chat = await getChatRepo().get(handle, charDir, chatName);
            if (!chat) {
                // legacy /api/chats/get 语义:文件在盘上但 repo 读不出(unreadable/refused)
                // → corrupted:true;浏览器据此走损坏提示分支而非 new_chat 覆盖。
                const chatFilePath = path.join(request.user.directories.chats, charDir, `${chatName}.jsonl`);
                if (fs.existsSync(chatFilePath)) {
                    console.warn(`Chat file exists but is unreadable (corrupted): ${chatFilePath}`);
                    return response.send({ corrupted: true });
                }
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            return response.send({
                name: chatName,
                fileName: `${chatName}.jsonl`,
                header: chat.header ?? {},
                messages: Array.isArray(chat.body) ? chat.body : [],
                integrity: chat.integrity,
                updatedAt: chat.updatedAt,
                createdAt: chat.createdAt,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats get');
        }
    });

    /**
     * GET /presets?apiId=openai —— 该 API 家族下全部预设名。
     * {items:[{name}],total}
     */
    reg(`${P}/presets`, async function (request, response) {
        try {
            const apiId = presetApiId(request.query.apiId);
            const entries = await getPresetRepo().list(request.user.profile.handle, apiId);
            const items = entries
                .map((entry) => ({ name: entry?.key?.name }))
                .filter((item) => typeof item.name === 'string' && item.name.length > 0);
            items.sort((a, b) => a.name.localeCompare(b.name));
            return response.send({ items, total: items.length, apiId });
        } catch (error) {
            return sendError(response, error, 'utopinn/presets list');
        }
    });

    /** GET /presets/:name?apiId=openai —— 预设全文文档。 */
    reg(`${P}/presets/:name`, async function (request, response) {
        try {
            const apiId = presetApiId(request.query.apiId);
            const name = safeName(request.params.name, 'name');
            const doc = await getPresetRepo().get(request.user.profile.handle, apiId, name);
            if (doc == null) {
                return response.status(404).send({ error: `Preset not found: ${apiId}/${name}` });
            }
            return response.send({ name, apiId, doc });
        } catch (error) {
            return sendError(response, error, 'utopinn/presets get');
        }
    });

    /**
     * GET /worlds —— 全部世界书。
     * {items:[{name,displayName,extensions}],total}
     */
    reg(`${P}/worlds`, async function (request, response) {
        try {
            const entries = await getWorldInfoRepo().list(request.user.profile.handle);
            const items = entries.map((entry) => ({
                name: entry?.key?.name,
                displayName: entry?.name ?? entry?.key?.name,
                extensions: (entry?.extensions && typeof entry.extensions === 'object' && !Array.isArray(entry.extensions))
                    ? entry.extensions
                    : {},
            })).filter((item) => typeof item.name === 'string' && item.name.length > 0);
            items.sort((a, b) => a.name.localeCompare(b.name));
            return response.send({ items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/worlds list');
        }
    });

    /** GET /worlds/:name —— 单本世界书文档({entries:{}} 原样返回)。 */
    reg(`${P}/worlds/:name`, async function (request, response) {
        try {
            const requested = safeName(request.params.name, 'name');
            const repo = getWorldInfoRepo();
            const handle = request.user.profile.handle;
            const doc = await repo.get(handle, requested);
            if (doc == null) {
                return response.status(404).send({ error: `World book not found: ${requested}` });
            }
            const canonical = await repo.resolveName(handle, requested);
            return response.send({ name: canonical ?? requested, doc });
        } catch (error) {
            return sendError(response, error, 'utopinn/worlds get');
        }
    });

    /**
     * GET /personas —— 人设列表。
     * personas = {avatarFile: name};persona_descriptions = {avatarFile: {description,position,title,...}}。
     * {items:[{avatar,name,description,position,title,hasImage,isDefault}],total,defaultPersona}
     */
    reg(`${P}/personas`, async function (request, response) {
        try {
            const settings = await getSettingsRepo().get(request.user.profile.handle) ?? {};
            const powerUser = (settings.power_user && typeof settings.power_user === 'object' && !Array.isArray(settings.power_user))
                ? settings.power_user
                : {};
            const nameMap = (powerUser.personas && typeof powerUser.personas === 'object' && !Array.isArray(powerUser.personas))
                ? powerUser.personas
                : {};
            const descMap = (powerUser.persona_descriptions && typeof powerUser.persona_descriptions === 'object' && !Array.isArray(powerUser.persona_descriptions))
                ? powerUser.persona_descriptions
                : {};
            const defaultPersona = typeof powerUser.default_persona === 'string' ? powerUser.default_persona : '';

            const avatarIds = new Set([...Object.keys(nameMap), ...Object.keys(descMap)]);
            const items = [...avatarIds].map((avatar) => {
                const descriptor = (descMap[avatar] && typeof descMap[avatar] === 'object' && !Array.isArray(descMap[avatar]))
                    ? descMap[avatar]
                    : {};
                // avatar 文件名来自存储的 settings doc;含分隔符/.. 的键不做磁盘探测
                const safeAvatarName = !UNSAFE_NAME_RE.test(avatar) && avatar !== '.' && avatar !== '..';
                return {
                    avatar,
                    name: typeof nameMap[avatar] === 'string' ? nameMap[avatar] : '',
                    description: typeof descriptor.description === 'string' ? descriptor.description : '',
                    position: descriptor.position ?? 0,
                    title: typeof descriptor.title === 'string' ? descriptor.title : '',
                    hasImage: safeAvatarName
                        ? fs.existsSync(path.join(request.user.directories.avatars, avatar))
                        : false,
                    isDefault: avatar === defaultPersona,
                };
            });
            items.sort((a, b) => a.name.localeCompare(b.name));
            return response.send({ items, total: items.length, defaultPersona: defaultPersona || null });
        } catch (error) {
            return sendError(response, error, 'utopinn/personas list');
        }
    });

    /** GET /settings —— 脱敏后的完整 settings 文档;?raw=1 返回未脱敏(旧前端是完整文档消费者,薄客户端别用)。 */
    reg(`${P}/settings`, async function (request, response) {
        try {
            const doc = await getSettingsRepo().get(request.user.profile.handle) ?? {};
            if (typeof doc !== 'object' || Array.isArray(doc) || doc === null) {
                return response.status(422).send({ error: 'Settings document is not a JSON object' });
            }
            const raw = request.query?.raw === '1' || request.query?.raw === 'true';
            return response.send({ settings: raw ? doc : sanitizeSettingsDoc(doc) });
        } catch (error) {
            if (error instanceof SyntaxError) {
                return response.status(422).send({ error: 'Settings document is not valid JSON' });
            }
            return sendError(response, error, 'utopinn/settings get');
        }
    });

    /**
     * DELETE /characters/:charDir/chats/:chatName —— 删除会话(204;不存在→404)。
     */
    regPost(`${P}/characters/:charDir/chats/:chatName`, 'DELETE', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            if (!await repo.exists(handle, charDir, chatName)) {
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            await repo.delete(handle, charDir, chatName);
            const chatFilePath = path.join(request.user.directories.chats, charDir, `${chatName}.jsonl`);
            deleteAllChatStateSidecars(chatFilePath);
            await deleteRecentChatIndexEntry(request, chatFilePath);
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'utopinn/chats delete');
        }
    });

    /**
     * PATCH /settings —— 受限浅合并:{power_user:{...}, extension_settings:{...}}。
     * 顶层键必须全部落在白名单里,每段值必须是对象(逐键浅合并进现有段);
     * 其余顶层字段(oai_settings/world_info/预设选择等)不可经此端点写。
     */
    regPost(`${P}/settings`, 'PATCH', async function (request, response) {
        try {
            const patch = request.body;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                return response.status(400).send({ error: 'Request body must be a JSON object' });
            }
            const keys = Object.keys(patch);
            if (keys.length === 0) {
                return response.status(400).send({ error: 'No settings sections provided' });
            }
            const rejected = keys.filter((key) => !PATCHABLE_SETTINGS_SECTIONS.has(key));
            if (rejected.length > 0) {
                return response.status(400).send({
                    error: `Settings sections not patchable via this endpoint: ${rejected.join(', ')}. Allowed: ${[...PATCHABLE_SETTINGS_SECTIONS].join(', ')}`,
                });
            }
            for (const key of keys) {
                if (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])) {
                    return response.status(422).send({ error: `Section "${key}" must be a JSON object` });
                }
            }

            const repo = getSettingsRepo();
            const handle = request.user.profile.handle;
            const existing = await repo.get(handle);
            const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
            const next = { ...base };
            for (const key of keys) {
                const section = (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) ? base[key] : {};
                next[key] = { ...section, ...sanitizeSettingsDoc(patch[key]) };
            }
            await repo.save(handle, next);
            return response.send({ settings: sanitizeSettingsDoc(next) });
        } catch (error) {
            return sendError(response, error, 'utopinn/settings patch');
        }
    });

    // -----------------------------------------------------------------------
    // 写面第二波:preset/world 保存+删除、persona 写、masked-secret
    // -----------------------------------------------------------------------

    /**
     * PUT /presets/:name?apiId= —— 整档保存(body=预设 doc 对象)。
     */
    regPost(`${P}/presets/:name`, 'PUT', async function (request, response) {
        try {
            const apiId = presetApiId(request.query.apiId);
            const name = safeName(request.params.name, 'name');
            const doc = request.body;
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
                return response.status(422).send({ error: 'Preset doc must be a JSON object' });
            }
            await getPresetRepo().save(request.user.profile.handle, apiId, name, doc);
            return response.send({ ok: true, name, apiId });
        } catch (error) {
            return sendError(response, error, 'utopinn/presets put');
        }
    });

    /** DELETE /presets/:name?apiId= —— 删预设(连带 state namespace 清理,Repo 内做)。 */
    regPost(`${P}/presets/:name`, 'DELETE', async function (request, response) {
        try {
            const apiId = presetApiId(request.query.apiId);
            const name = safeName(request.params.name, 'name');
            const deleted = await getPresetRepo().delete(request.user.profile.handle, apiId, name);
            if (!deleted) {
                return response.status(404).send({ error: `Preset not found: ${apiId}/${name}` });
            }
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'utopinn/presets delete');
        }
    });

    /**
     * PUT /worlds/:name —— 整档保存(body={entries:{}};Repo 校验 entries 形态)。
     * 书名经 resolveName 归一 —— 请求名与盘档名归一后返回 canonical。
     */
    regPost(`${P}/worlds/:name`, 'PUT', async function (request, response) {
        try {
            const name = safeName(request.params.name, 'name');
            const doc = request.body;
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)
                || !doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
                return response.status(422).send({ error: 'World doc must be an object with an entries object' });
            }
            const repo = getWorldInfoRepo();
            const handle = request.user.profile.handle;
            await repo.save(handle, name, doc);
            const canonical = await repo.resolveName(handle, name);
            return response.send({ ok: true, name: canonical ?? name });
        } catch (error) {
            return sendError(response, error, 'utopinn/worlds put');
        }
    });

    /** DELETE /worlds/:name —— 删世界书。 */
    regPost(`${P}/worlds/:name`, 'DELETE', async function (request, response) {
        try {
            const name = safeName(request.params.name, 'name');
            const deleted = await getWorldInfoRepo().delete(request.user.profile.handle, name);
            if (!deleted) {
                return response.status(404).send({ error: `World book not found: ${name}` });
            }
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'utopinn/worlds delete');
        }
    });

    /**
     * PUT /personas/:avatar —— 人设写(嵌套合并进 power_user.personas +
     * persona_descriptions,不能走 PATCH 顶层浅合并 —— 会洗掉兄弟键)。
     * body:{name?,description?,position?,title?};avatar 文件名走 safeName。
     */
    regPost(`${P}/personas/:avatar`, 'PUT', async function (request, response) {
        try {
            const avatar = safeName(request.params.avatar, 'avatar');
            const body = request.body ?? {};
            if (typeof body !== 'object' || Array.isArray(body)) {
                return response.status(400).send({ error: 'Request body must be a JSON object' });
            }
            const repo = getSettingsRepo();
            const handle = request.user.profile.handle;
            const existing = await repo.get(handle);
            const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
            const powerUser = (base.power_user && typeof base.power_user === 'object' && !Array.isArray(base.power_user))
                ? { ...base.power_user }
                : {};
            const personas = (powerUser.personas && typeof powerUser.personas === 'object' && !Array.isArray(powerUser.personas))
                ? { ...powerUser.personas }
                : {};
            const descMap = (powerUser.persona_descriptions && typeof powerUser.persona_descriptions === 'object' && !Array.isArray(powerUser.persona_descriptions))
                ? { ...powerUser.persona_descriptions }
                : {};

            if (typeof body.name === 'string') {
                personas[avatar] = body.name;
            }
            const descFields = {};
            for (const k of ['description', 'position', 'title']) {
                if (body[k] !== undefined) descFields[k] = body[k];
            }
            if (Object.keys(descFields).length > 0) {
                const prior = (descMap[avatar] && typeof descMap[avatar] === 'object' && !Array.isArray(descMap[avatar]))
                    ? descMap[avatar]
                    : {};
                descMap[avatar] = { ...prior, ...descFields };
            }
            if (body.is_default === true) {
                powerUser.default_persona = avatar;
            }
            powerUser.personas = personas;
            powerUser.persona_descriptions = descMap;

            await repo.save(handle, { ...base, power_user: powerUser });
            return response.send({
                ok: true,
                avatar,
                name: typeof personas[avatar] === 'string' ? personas[avatar] : '',
                description: typeof descMap[avatar]?.description === 'string' ? descMap[avatar].description : '',
                position: descMap[avatar]?.position ?? 0,
                title: typeof descMap[avatar]?.title === 'string' ? descMap[avatar].title : '',
                isDefault: powerUser.default_persona === avatar,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/personas put');
        }
    });

    /**
     * DELETE /personas/:avatar —— 从 personas + persona_descriptions 双表摘除;
     * 若恰是 default_persona 一并清默认位。
     */
    regPost(`${P}/personas/:avatar`, 'DELETE', async function (request, response) {
        try {
            const avatar = safeName(request.params.avatar, 'avatar');
            const repo = getSettingsRepo();
            const handle = request.user.profile.handle;
            const existing = await repo.get(handle);
            const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
            const powerUser = (base.power_user && typeof base.power_user === 'object' && !Array.isArray(base.power_user))
                ? { ...base.power_user }
                : {};
            const personas = (powerUser.personas && typeof powerUser.personas === 'object' && !Array.isArray(powerUser.personas))
                ? { ...powerUser.personas }
                : {};
            const descMap = (powerUser.persona_descriptions && typeof powerUser.persona_descriptions === 'object' && !Array.isArray(powerUser.persona_descriptions))
                ? { ...powerUser.persona_descriptions }
                : {};

            const had = Object.hasOwn(personas, avatar) || Object.hasOwn(descMap, avatar);
            if (!had) {
                return response.status(404).send({ error: `Persona not found: ${avatar}` });
            }
            delete personas[avatar];
            delete descMap[avatar];
            if (powerUser.default_persona === avatar) {
                powerUser.default_persona = '';
            }
            powerUser.personas = personas;
            powerUser.persona_descriptions = descMap;
            await repo.save(handle, { ...base, power_user: powerUser });
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'utopinn/personas delete');
        }
    });

    // -----------------------------------------------------------------------
    // masked-secret:脱敏读(SecretManager.getSecretState 原生脱敏)+ 受限写
    // -----------------------------------------------------------------------

    const VALID_SECRET_KEYS = new Set(Object.values(SECRET_KEYS).filter((k) => k !== SECRET_KEYS._MIGRATED));

    /** GET /secrets —— 全键脱敏态 {key: [{id,value:masked,label,active}]|null}。 */
    reg(`${P}/secrets`, async function (request, response) {
        try {
            const state = new SecretManager(request.user.directories).getSecretState();
            return response.send({ secrets: state });
        } catch (error) {
            return sendError(response, error, 'utopinn/secrets get');
        }
    });

    /**
     * PUT /secrets/:key —— 写入一条新 secret(自动置 active,同 key 旧值退役)。
     * body:{value:string,label?} → 返回该 key 的脱敏条目组(不 echo 明文)。
     */
    regPost(`${P}/secrets/:key`, 'PUT', async function (request, response) {
        try {
            const key = safeName(request.params.key, 'key');
            if (!VALID_SECRET_KEYS.has(key)) {
                return response.status(400).send({ error: `Unknown secret key: ${key}` });
            }
            const value = request.body?.value;
            if (typeof value !== 'string' || value.length === 0) {
                return response.status(400).send({ error: 'Expected body.value non-empty string' });
            }
            const label = typeof request.body?.label === 'string' ? request.body.label : 'Unlabeled';
            const manager = new SecretManager(request.user.directories);
            const id = manager.writeSecret(key, value, label);
            const state = manager.getSecretState();
            return response.send({ ok: true, id, key, entries: state[key] ?? null });
        } catch (error) {
            return sendError(response, error, 'utopinn/secrets put');
        }
    });

    /** DELETE /secrets/:key/:id —— 按 id 删一条。 */
    regPost(`${P}/secrets/:key/:id`, 'DELETE', async function (request, response) {
        try {
            const key = safeName(request.params.key, 'key');
            if (!VALID_SECRET_KEYS.has(key)) {
                return response.status(400).send({ error: `Unknown secret key: ${key}` });
            }
            const id = safeName(request.params.id, 'id');
            new SecretManager(request.user.directories).deleteSecret(key, id);
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'utopinn/secrets delete');
        }
    });

    // -----------------------------------------------------------------------
    // 聊天生命周期(TASK-023):建 / 重命名 / 追加(swipe 随消息持久化)/ JSON-Patch
    // -----------------------------------------------------------------------

    /**
     * PUT /characters/:charDir/chats/:chatName —— 新建空会话。
     * body:{header?} → 缺省 {chat_metadata:{}};已存在 → 409。
     */
    regPost(`${P}/characters/:charDir/chats/:chatName`, 'PUT', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            if (await repo.exists(handle, charDir, chatName)) {
                return response.status(409).send({ error: `Chat already exists: ${charDir}/${chatName}` });
            }
            const header = request.body?.header;
            if (header !== undefined && (typeof header !== 'object' || header === null || Array.isArray(header))) {
                return response.status(400).send({ error: 'body.header must be an object when provided' });
            }
            const { integrity } = await repo.save(handle, charDir, chatName, header ?? { chat_metadata: {} }, []);
            return response.status(201).send({ ok: true, name: chatName, fileName: `${chatName}.jsonl`, integrity });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats create');
        }
    });

    /**
     * POST /characters/:charDir/chats/:chatName/rename —— 重命名。
     * body:{newName};目标占用 → 409,源不存在 → 404。
     */
    regPost(`${P}/characters/:charDir/chats/:chatName/rename`, 'POST', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const newName = safeName(stripJsonlExt(request.body?.newName), 'newName');
            const handle = request.user.profile.handle;
            await getChatRepo().rename(handle, charDir, chatName, newName);
            const oldFilePath = path.join(request.user.directories.chats, charDir, `${chatName}.jsonl`);
            const newFilePath = path.join(request.user.directories.chats, charDir, `${newName}.jsonl`);
            await deleteRecentChatIndexEntry(request, oldFilePath);
            await refreshRecentChatIndexEntry(request, newFilePath, {
                avatar: String(request.body?.avatar_url || ''),
            });
            return response.send({ ok: true, name: newName, fileName: `${newName}.jsonl` });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats rename');
        }
    });

    /**
     * POST /characters/:charDir/chats/:chatName/messages —— 追加消息(legacy /append 逐义)。
     * body:{messages[]|message, integrity?, force?, chat_metadata?, luker_generation_id?}
     *   缺失即建(create + autoInit settle);双去重:队首内容等值 + body 级
     *   gen-id 命中侧车;内嵌 extra.luker_generation_id 入库前剥离。
     *   integrity 乐观锁不匹配 → {error:'integrity', current_integrity} 409。
     * 响应:{ok, appended, created, skipped, matched_existing_generation_id, integrity}
     */
    regPost(`${P}/characters/:charDir/chats/:chatName/messages`, 'POST', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const body = request.body ?? {};
            const slugRaw = typeof body.integrity === 'string' ? body.integrity.trim() : '';
            const incomingId = typeof body.luker_generation_id === 'string' ? body.luker_generation_id.trim() : '';
            const force = Boolean(body.force);
            const messages = Array.isArray(body.messages) ? body.messages
                : (body.message && typeof body.message === 'object' ? [body.message] : []);
            if (messages.length === 0) {
                return response.status(400).send({ error: 'No message payload found. Expected body.messages or body.message.' });
            }
            const chatFilePath = path.join(request.user.directories.chats, charDir, sanitize(`${chatName}.jsonl`));
            const hint = { kind: 'character', avatar_url: await resolveAvatarFileName(request.user.directories, charDir), file_name: `${chatName}.jsonl` };
            // settle/ack 机制读 body.avatar_url|file_name —— 合成写盘上下文
            const writeReq = { ...request, body: { ...body, avatar_url: hint.avatar_url, file_name: hint.file_name } };
            const repo = getChatRepo();
            const existing = await repo.get(handle, charDir, chatName);
            const hasAiFloor = messages.some(m => m && m.is_user === false);
            const backup = (header, floors, integrity) => {
                try {
                    const headerWithIntegrity = { ...header, chat_metadata: applyIntegrityToMetadata(header?.chat_metadata, integrity) };
                    getBackupFunction(handle, charDir)(request.user.directories.backups, charDir,
                        [headerWithIntegrity, ...floors].map(m => JSON.stringify(m)).join('\n'));
                } catch (e) { console.error('Chat backup after utopinn append failed', e); }
            };

            if (slugRaw && !force && existing && existing.integrity !== slugRaw) {
                return sendRepoIntegrityConflict(response, createIntegrityMismatchError(chatFilePath, slugRaw));
            }
            const cleanedMessages = messages.map(m => stripLukerGenerationIdFromMessage(_.cloneDeep(m)));

            // legacy「缺失即建」:首写/吞楼层依赖——create + autoInit settle
            if (!existing) {
                const header = createChatHeader(body.chat_metadata && typeof body.chat_metadata === 'object' ? body.chat_metadata : {});
                const { integrity: newIntegrity } = await repo.save(handle, charDir, chatName, header, cleanedMessages, null);
                writeChatSyncState(chatFilePath, { integrity: newIntegrity, updated_at: Date.now() });
                if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
                backup(header, cleanedMessages, newIntegrity);
                await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
                acknowledgeGenerationFromValueOrPersistTarget(writeReq, messages, hasAiFloor ? hint : null);
                await settleMvuAfterAppend(writeReq, { autoInit: true });
                return response.send({ ok: true, appended: cleanedMessages.length, created: true, integrity: newIntegrity });
            }

            // legacy 双去重:队首内容等值剥离 → body 级 gen-id 命中侧车剥离
            const deduped = cleanedMessages.slice();
            const lastStored = existing.body.length ? existing.body[existing.body.length - 1] : null;
            const sidecarLast = readLastChatGenerationId(chatFilePath);
            let matchedGenId = false;
            while (deduped.length) {
                const lastStripped = isChatMessageLike(lastStored)
                    ? stripLukerGenerationIdFromMessage(_.cloneDeep(lastStored)) : null;
                if (lastStripped && isChatMessageLike(deduped[0]) && _.isEqual(lastStripped, deduped[0])) {
                    deduped.shift(); continue;
                }
                if (!sidecarLast || !incomingId || incomingId !== sidecarLast) break;
                matchedGenId = true; deduped.shift();
            }
            if (!deduped.length) {
                await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
                acknowledgeGenerationFromValueOrPersistTarget(writeReq, messages, hasAiFloor ? hint : null);
                return response.send({ ok: true, appended: 0, created: false, skipped: cleanedMessages.length, matched_existing_generation_id: matchedGenId, integrity: existing.integrity });
            }

            const mergedBody = existing.body.concat(deduped);
            const expectedForSave = (slugRaw && !force) ? slugRaw : null;
            let newIntegrity;
            try {
                ({ integrity: newIntegrity } = await repo.save(handle, charDir, chatName, existing.header, mergedBody, expectedForSave));
            } catch (err) {
                if (err instanceof ConflictError) return sendRepoIntegrityConflict(response, err);
                throw err;
            }
            writeChatSyncState(chatFilePath, { integrity: newIntegrity, updated_at: Date.now() });
            if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
            backup(existing.header, mergedBody, newIntegrity);
            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
            acknowledgeGenerationFromValueOrPersistTarget(writeReq, messages, hasAiFloor ? hint : null);
            await settleMvuAfterAppend(writeReq);
            return response.send({ ok: true, appended: deduped.length, created: false, skipped: cleanedMessages.length - deduped.length, matched_existing_generation_id: matchedGenId, integrity: newIntegrity });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats append');
        }
    });

    /**
     * PATCH /characters/:charDir/chats/:chatName —— JSON-Patch 局部改(legacy /patch 语义)。
     * body:{ops:[{op,path,value?}], integrity?, chat_metadata?, luker_generation_id?}
     *   doc 形状 {header, body:messages[]};swipe 切换 =
     *   {op:'replace', path:'/body/<i>/swipe_id', value:<n>};顶层 /N 路径拒绝(命名空间外)。
     *   chat_metadata 顶键展成 /header/chat_metadata/<k> 合并。
     *   integrity 冲突 → {error:'integrity', current_integrity} 409;op 非法 → 400。
     * 响应:{ok, applied, total_messages, integrity}
     */
    regPost(`${P}/characters/:charDir/chats/:chatName`, 'PATCH', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const ops = request.body?.ops;
            if (!Array.isArray(ops) || ops.length === 0) {
                return response.status(400).send({ error: 'Expected body.ops non-empty array' });
            }
            const handle = request.user.profile.handle;
            const body = request.body ?? {};
            const slugRaw = typeof body.integrity === 'string' ? body.integrity.trim() : '';
            const incomingId = typeof body.luker_generation_id === 'string' ? body.luker_generation_id.trim() : '';
            const chatFilePath = path.join(request.user.directories.chats, charDir, sanitize(`${chatName}.jsonl`));
            const hint = { kind: 'character', avatar_url: await resolveAvatarFileName(request.user.directories, charDir), file_name: `${chatName}.jsonl` };
            const writeReq = { ...request, body: { ...body, avatar_url: hint.avatar_url, file_name: hint.file_name } };
            const repo = getChatRepo();

            // op 形状先拦:对象 + path 为 '/' 前缀字符串 + 顶层数字段(裸 /5 命名空间外)拒绝
            for (const op of ops) {
                if (!op || typeof op !== 'object' || typeof op.path !== 'string' || !op.path.startsWith('/')) {
                    return response.status(400).send({ error: 'Invalid patch op: expected {op,path:"/..."}' });
                }
                if (/^\/\d+(\/|$)/.test(op.path)) {
                    return response.status(400).send({ error: `Patch path must address /body/<i>/… or /header/…, got "${op.path}"` });
                }
            }
            const sanitizedOps = sanitizeOperationsAgainstLukerGenerationId(ops);
            let existing = null;
            try { existing = await repo.get(handle, charDir, chatName); }
            catch (e) { if (!(e instanceof NotFoundError)) throw e; }
            const lastIdx = Math.max(0, (existing?.body?.length ?? 0) - 1);
            // hint-ack 末楼门:doc 命名空间下只有 /body/<lastIdx> 算末楼(整层与子路径都算)
            const hitsLast = ops.some(op => typeof op?.path === 'string'
                && (op.path === `/body/${lastIdx}` || op.path.startsWith(`/body/${lastIdx}/`)));

            // 纯 gen-id 记账 patch(全被 sanitize 剥):早退——只写侧车+ack,不轮 integrity
            if (sanitizedOps.length === 0) {
                if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
                acknowledgeGenerationFromValueOrPersistTarget(writeReq, ops, hitsLast ? hint : null);
                return response.send({ ok: true, applied: 0, total_messages: existing?.body?.length ?? 0, integrity: existing?.integrity ?? null });
            }

            // chat_metadata 顶键合并(legacy /patch 语义):展成 /header/chat_metadata/<k> 的 add/replace
            if (body.chat_metadata && typeof body.chat_metadata === 'object' && !Array.isArray(body.chat_metadata)) {
                for (const [k, v] of Object.entries(body.chat_metadata)) {
                    sanitizedOps.push({ op: 'add', path: `/header/chat_metadata/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, value: v });
                }
            }

            let result;
            try {
                result = await repo.patch(handle, charDir, chatName, sanitizedOps, slugRaw || undefined);
            } catch (err) {
                if (err instanceof ConflictError) return sendRepoIntegrityConflict(response, err);
                if (err instanceof PatchTestFailedError || err instanceof PatchMissingParentError) {
                    // test/add 守卫失败=内容漂移:给 current_integrity 让浏览器走
                    // 标准 409 rebase+retry,而不是空 current 的 force-overwrite 歧义分支。
                    const current = await repo.get(handle, charDir, chatName).catch(() => null);
                    console.warn(err.message);
                    return response.status(409).send({ error: 'integrity', current_integrity: current?.integrity ?? '' });
                }
                throw err;
            }
            if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
            writeChatSyncState(chatFilePath, { integrity: result.integrity, updated_at: Date.now() });
            const post = await repo.get(handle, charDir, chatName).catch(() => null);
            try {
                const headerWithIntegrity = { ...(post?.header ?? {}), chat_metadata: applyIntegrityToMetadata(post?.header?.chat_metadata, result.integrity) };
                getBackupFunction(handle, charDir)(request.user.directories.backups, charDir,
                    [headerWithIntegrity, ...(post?.body ?? [])].map(m => JSON.stringify(m)).join('\n'));
            } catch (e) { console.error('Chat backup after utopinn patch failed', e); }
            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
            acknowledgeGenerationFromValueOrPersistTarget(writeReq, ops, hitsLast ? hint : null);
            await resettleMvuAfterWrite(writeReq);
            return response.send({ ok: true, applied: sanitizedOps.length, total_messages: post?.body?.length ?? null, integrity: result.integrity });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats patch');
        }
    });

    /**
     * PUT /characters/:charDir/chats/:chatName/document —— 整文档替换(legacy /save 等价)。
     * body:{header?, messages[], integrity?, force?, luker_generation_id?}
     *   兼容 legacy 形状:{chat:[header, ...floors], force?}。
     *   CAS:body.integrity ?? header.chat_metadata.integrity;force 跳过。
     *   缺文件 + 带 expected → 按 legacy 语义降级 null 重试(无旧完整性可撞)。
     *   upsert:文件不存在即创建(与 PUT .../chats/:chatName create-only 互补)。
     * 响应:{ok:true, integrity}
     */
    regPost(`${P}/characters/:charDir/chats/:chatName/document`, 'PUT', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const reqBody = request.body ?? {};
            // 双形状:{header,messages} 或 legacy {chat:[header,...floors]}。
            // chat[] 形状用 looksLikeHeader 判定(同 /group/save):普通楼层不当 header 吞掉 floor-0。
            const looksLikeHeader = (v) => v && typeof v === 'object' && !Array.isArray(v)
                && ('chat_metadata' in v || 'user_name' in v || 'character_name' in v);
            const doc = Array.isArray(reqBody.chat)
                ? (looksLikeHeader(reqBody.chat[0])
                    ? { header: reqBody.chat[0], messages: reqBody.chat.slice(1) }
                    : { header: null, messages: reqBody.chat })
                : { header: reqBody.header, messages: reqBody.messages };
            if (!Array.isArray(doc.messages)) {
                return response.status(400).send({ error: 'Expected body.messages array (or legacy body.chat array)' });
            }
            if (!doc.messages.every(m => m && typeof m === 'object' && !Array.isArray(m))) {
                return response.status(422).send({ error: 'Every floor in messages must be an object' });
            }
            const handle = request.user.profile.handle;
            const chatFilePath = path.join(request.user.directories.chats, charDir, sanitize(`${chatName}.jsonl`));
            const hint = { kind: 'character', avatar_url: await resolveAvatarFileName(request.user.directories, charDir), file_name: `${chatName}.jsonl` };
            const writeReq = { ...request, body: { ...reqBody, avatar_url: hint.avatar_url, file_name: hint.file_name } };
            const incomingId = typeof reqBody.luker_generation_id === 'string' ? reqBody.luker_generation_id.trim() : '';

            const headerInput = (doc.header && typeof doc.header === 'object' && !Array.isArray(doc.header)) ? doc.header : createChatHeader({});
            const force = Boolean(reqBody.force);
            const doIntegrityCheck = checkIntegrity && !force;
            const expectedIntegrity = !doIntegrityCheck ? null
                : (typeof reqBody.integrity === 'string' && reqBody.integrity.trim()
                    ? reqBody.integrity.trim()
                    : String(headerInput?.chat_metadata?.integrity ?? '').trim() || null);

            let integrity;
            try {
                ({ integrity } = await getChatRepo().save(handle, charDir, chatName, headerInput, doc.messages, expectedIntegrity));
            } catch (err) {
                if (err instanceof NotFoundError && expectedIntegrity !== null) {
                    ({ integrity } = await getChatRepo().save(handle, charDir, chatName, headerInput, doc.messages, null));
                } else if (err instanceof ConflictError) {
                    return sendRepoIntegrityConflict(response, err);
                } else {
                    throw err;
                }
            }

            writeChatSyncState(chatFilePath, { integrity, updated_at: Date.now() });
            if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
            try {
                const headerWithIntegrity = {
                    ...headerInput,
                    chat_metadata: applyIntegrityToMetadata(headerInput.chat_metadata, integrity),
                };
                const jsonlData = [headerWithIntegrity, ...doc.messages].map(m => JSON.stringify(m)).join('\n');
                getBackupFunction(handle, charDir)(request.user.directories.backups, charDir, jsonlData);
            } catch (backupErr) {
                console.error('Chat backup after utopinn doc-save failed', backupErr);
            }

            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
            // ack:整写里末楼非 AI 层 = 本次写并非生成落盘(同 legacy /save 门);
            // body 级 gen-id 不在楼层里,并入收集值让显式 ack 通道吃得到(M7)。
            const chatData = [headerInput, ...doc.messages];
            if (incomingId) chatData.push({ extra: { luker_generation_id: incomingId } });
            const lastFloor = doc.messages.length ? doc.messages[doc.messages.length - 1] : null;
            acknowledgeGenerationFromValueOrPersistTarget(writeReq, chatData, lastFloor && lastFloor.is_user === false ? hint : null);
            await resettleMvuAfterWrite(writeReq);
            return response.send({ ok: true, integrity });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats document');
        }
    });

    /**
     * POST /chats/recent —— 最近会话列表(legacy POST /api/chats/recent 逐义搬运)。
     * body:{pinned?:[{file_name,avatar?,group?}], max?}
     *   pinned 判定同字段(file_name + avatar|group)置顶 → sort_time desc →
     *   slice(0, requested + pinned.length) → 滤 file_name;异常 500 兜底照 legacy。
     *   索引与排序直接复用 chats.js 导出的 ensureRecentChatIndex /
     *   getRecentChatSortTime —— 行为面只有一个事实源,不重抄。
     */
    regPost(`${P}/chats/recent`, 'POST', async function (request, response) {
        try {
            /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
            const pinnedChats = Array.isArray(request.body?.pinned) ? request.body.pinned : [];
            const requestedMax = Number.parseInt(String(request.body?.max ?? ''), 10);
            const requested = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : Number.MAX_SAFE_INTEGER;
            const max = requested + pinnedChats.length;
            const entries = await ensureRecentChatIndex(request);
            const recentChats = Array.from(entries.values());
            const isPinned = (chatFile) => pinnedChats.some(p => p.file_name === chatFile.file_name && (p.avatar === chatFile.avatar || p.group === chatFile.group));
            const sortedChats = recentChats.sort((a, b) => {
                const isAPinned = isPinned(a);
                const isBPinned = isPinned(b);

                if (isAPinned && !isBPinned) return -1;
                if (!isAPinned && isBPinned) return 1;

                return getRecentChatSortTime(b) - getRecentChatSortTime(a);
            }).slice(0, max);
            const validFiles = sortedChats.filter(chatFile => chatFile.file_name);

            return response.send(validFiles);
        } catch (error) {
            console.error(error);
            return response.sendStatus(500);
        }
    });

    // -----------------------------------------------------------------------
    // state sidecar 三族(TASK-032 收尾增量):/api/utopinn/state/{chat|char|preset}
    // 对应 legacy /api/{chats,characters,presets}/state/* —— target 字段、
    // namespace 归一、patch 语义、错误面逐义对齐,helper 全部从 legacy 端点
    // export 复用,sidecar 文件同一批,不存在第二套写盘逻辑。
    //
    // 三族公共动作集:get(GET+POST)/ get-batch / patch / delete。
    // 不对称处照 legacy 实际面:
    //   - char 独有 set(整态覆写,写 .state.<ns>.json);chat/preset 无对应物。
    //   - preset 独有 delete-all / rename(随预设批量清档/改名迁移 ns);
    //     chat/char 的等价物挂在父资源 delete/rename 里,不出 state 子面。
    //   - GET get 走 sendJsonResource(ETag 私有化读,需 ?account=<handle>);
    //     POST 写面仍是普通 JSON 应答。
    // -----------------------------------------------------------------------

    /**
     * GET /state/chat/get —— chat_state 读(ETag 资源读)。
     * query: is_group('true'|'false') + (id | avatar_url+file_name[+char_name]),
     *        namespace, account。
     */
    reg(`${P}/state/chat/get`, async function (request, response) {
        const target = chatStateTargetFromQuery(request.query);
        const repoKey = target ? resolveChatStateRepoKey(request, target) : null;
        const namespace = normalizeChatStateNamespace(request.query?.namespace);
        const resource = `chat-state:${target?.is_group ? 'group' : 'chat'}:${target?.is_group ? target?.id : `${target?.avatar_url}:${target?.file_name}`}:${namespace}`;
        if (!repoKey) {
            return sendResourceReadError(response, {
                code: 'invalid_args',
                resource,
                detail: 'Expected a valid chat state target.',
                status: 400,
            });
        }
        if (!namespace) {
            return sendResourceReadError(response, {
                code: 'invalid_args',
                resource,
                detail: 'Expected a state namespace.',
                status: 400,
            });
        }
        try {
            const data = await getChatRepo().getState(
                repoKey.handle,
                repoKey.charDir,
                repoKey.name,
                namespace,
                { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
            );
            return sendJsonResource(request, response, {
                resource,
                value: { ok: true, data },
            });
        } catch (error) {
            console.error('Error reading chat state sidecar:', error);
            return sendResourceReadError(response, {
                code: 'read_failed',
                resource,
                detail: 'Failed to read chat state.',
                status: 500,
            });
        }
    });

    /** POST /state/chat/get —— body 版 chat_state 读。 */
    regPost(`${P}/state/chat/get`, 'POST', async function (request, response) {
        try {
            const target = request.body || {};
            const repoKey = resolveChatStateRepoKey(request, target);
            const namespace = normalizeChatStateNamespace(target?.namespace);
            if (!repoKey) {
                return response.status(400).send({ error: 'Invalid state target payload.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }
            const data = await getChatRepo().getState(
                repoKey.handle,
                repoKey.charDir,
                repoKey.name,
                namespace,
                { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
            );
            return response.send({ ok: true, data });
        } catch (error) {
            console.error('Error reading chat state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    });

    /** POST /state/chat/get-batch —— 单 target 多 namespace 一次取。 */
    regPost(`${P}/state/chat/get-batch`, 'POST', async function (request, response) {
        try {
            const target = request.body || {};
            const repoKey = resolveChatStateRepoKey(request, target);
            const namespaces = [...new Set((Array.isArray(target?.namespaces) ? target.namespaces : [])
                .map((namespace) => normalizeChatStateNamespace(namespace))
                .filter(Boolean))];
            if (!repoKey) {
                return response.status(400).send({ error: 'Invalid state target payload.' });
            }
            if (!namespaces.length) {
                return response.status(400).send({ error: 'Expected body.namespaces array.' });
            }

            const data = await getChatRepo().getStateBatch(
                repoKey.handle,
                repoKey.charDir,
                repoKey.name,
                namespaces,
                { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
            );

            return response.send({ ok: true, data });
        } catch (error) {
            console.error('Error reading chat state sidecars:', error);
            return response.status(500).send({ error: true });
        }
    });

    /**
     * POST /state/chat/patch —— JSON-Patch 合并写 chat_state sidecar。
     * body:{target…, namespace, operations[]|operation}。
     * 与 legacy 同:绕过 Repo.setState 的父档存在性门(engine tx 直写,
     * 允许父聊天缺席的宽容 sidecar 写);写完触发一次聊天备份(父档缺席静默跳过)。
     */
    regPost(`${P}/state/chat/patch`, 'POST', async function (request, response) {
        try {
            const target = request.body || {};
            const repoKey = resolveChatStateRepoKey(request, target);
            const namespace = normalizeChatStateNamespace(target?.namespace);
            if (!repoKey) {
                return response.status(400).send({ error: 'Invalid state target payload.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }
            const operations = Array.isArray(target?.operations)
                ? target.operations
                : (_.isObjectLike(target?.operations)
                    ? [target.operations]
                    : (_.isObjectLike(target?.operation) ? [target.operation] : []));
            if (operations.length === 0) {
                return response.status(400).send({ error: 'No state patch operations found. Expected body.operations or body.operation.' });
            }

            // Use the storage engine transaction directly: legacy behavior is permissive and
            // allows writing a sidecar even when the parent chat does not exist, which the
            // ChatRepo.setState wrapper guards against with a NotFoundError.
            const engine = getStorageEngine();
            const repoKeyForEngine = {
                kind: 'chat',
                handle: repoKey.handle,
                charDir: repoKey.charDir,
                name: repoKey.name,
                isGroup: repoKey.isGroup,
                groupId: repoKey.groupId,
            };
            const { applied, created } = await engine.withTransaction(repoKey.handle, async (tx) => {
                const existing = await tx.getChatState(repoKeyForEngine, namespace);
                const existed = existing !== null && existing !== undefined;
                const state = (_.isObjectLike(existing) && !Array.isArray(existing)) ? existing : {};
                const result = applyChatStatePatch(state, operations);
                await tx.putChatState(repoKeyForEngine, namespace, result.state);
                return { applied: result.applied, created: !existed };
            });

            // State-only mutations don't change the chat document itself, but we
            // still trigger a backup so any state change has a recoverable point
            // (the backup payload is the current chat doc at the moment of the
            // state patch). Re-read the chat to serialize. If the parent chat
            // doesn't exist (legacy permissive sidecar write), skip silently.
            try {
                const chatDoc = await getChatRepo().get(
                    repoKey.handle, repoKey.charDir ?? '', repoKey.name,
                    { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
                );
                if (chatDoc) {
                    const headerWithIntegrity = {
                        ...(chatDoc.header ?? {}),
                        chat_metadata: applyIntegrityToMetadata(chatDoc.header?.chat_metadata, chatDoc.integrity),
                    };
                    const backupName = repoKey.isGroup ? repoKey.groupId : (repoKey.charDir ?? '');
                    if (backupName) {
                        const jsonlData = [headerWithIntegrity, ...(chatDoc.body ?? [])].map(m => JSON.stringify(m)).join('\n');
                        getBackupFunction(repoKey.handle, backupName)(request.user.directories.backups, backupName, jsonlData);
                    }
                }
            } catch (backupErr) {
                console.error('Chat backup after state/patch failed', backupErr);
            }

            return response.send({ ok: true, applied, created });
        } catch (error) {
            if (isChatStatePatchConflictError(error)) {
                return response.status(409).send({ error: 'Chat state patch conflict.' });
            }
            if (isJsonPatchValidationError(error)) {
                return response.status(400).send({ error: 'Invalid chat state patch payload.' });
            }
            console.error('Error patching chat state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    });

    /** POST /state/chat/delete —— 删一个 chat_state sidecar(缺失也算成功,deleted:true)。 */
    regPost(`${P}/state/chat/delete`, 'POST', async function (request, response) {
        try {
            const target = request.body || {};
            const repoKey = resolveChatStateRepoKey(request, target);
            const namespace = normalizeChatStateNamespace(target?.namespace);
            if (!repoKey) {
                return response.status(400).send({ error: 'Invalid state target payload.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }
            // deleteState returns void; report `deleted: true` on success to preserve the
            // legacy contract — the frontend reads `response.ok` only.
            await getChatRepo().deleteState(
                repoKey.handle,
                repoKey.charDir,
                repoKey.name,
                namespace,
                { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
            );
            return response.send({ ok: true, deleted: true });
        } catch (error) {
            console.error('Error deleting chat state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    });

    // -----------------------------------------------------------------------
    // char_state:<charName>.state.<ns>.json 与卡同目录(characters.js 同步 fs 面)。
    // POST 体里 avatar_url 经 validateAvatarUrlMiddleware —— 与 legacy 链同款,
    // 命中禁止字符(含 /\x00,Windows 再加 \\)直接 400,不进 handler。
    // -----------------------------------------------------------------------

    const withAvatarUrlValidation = (handler) => function (request, response) {
        return validateAvatarUrlMiddleware(request, response, () => handler(request, response));
    };

    /**
     * GET /state/char/get —— char_state 读(ETag 资源读)。
     * query: avatar|avatar_url + namespace + account(账号隔离由 getQueryCharacterAvatar 判)。
     */
    reg(`${P}/state/char/get`, function (request, response) {
        const target = getQueryCharacterAvatar(request, response);
        if (!target) {
            return;
        }
        const namespace = normalizeCharacterStateNamespace(request.query?.namespace);
        if (!namespace) {
            return sendResourceReadError(response, {
                code: 'invalid_args',
                resource: `character-state:${target.avatar}:`,
                detail: 'Expected a state namespace.',
                status: 400,
            });
        }
        const resource = `character-state:${target.avatar}:${namespace}`;
        try {
            const data = readCharacterStateSidecar(target.imagePath, namespace);
            return sendJsonResource(request, response, { resource, value: { ok: true, data } });
        } catch (error) {
            console.error('Error reading character state sidecar:', error);
            return sendResourceReadError(response, {
                code: 'read_failed',
                resource,
                detail: 'Failed to read character state.',
                status: 500,
            });
        }
    });

    /** POST /state/char/get —— body:{avatar_url, namespace} → {ok,data|null}。 */
    regPost(`${P}/state/char/get`, 'POST', withAvatarUrlValidation(function (request, response) {
        try {
            const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
            const namespace = normalizeCharacterStateNamespace(request.body?.namespace);
            if (!avatarUrl) {
                return response.status(400).send({ error: 'Expected body.avatar_url string.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }

            const characterPath = path.join(request.user.directories.characters, avatarUrl);
            return response.send({ ok: true, data: readCharacterStateSidecar(characterPath, namespace) });
        } catch (error) {
            console.error('Error reading character state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    }));

    /** POST /state/char/get-batch —— body:{avatar_url, namespaces[]} → {ok,data:{ns:doc|null}}。 */
    regPost(`${P}/state/char/get-batch`, 'POST', withAvatarUrlValidation(function (request, response) {
        try {
            const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
            if (!avatarUrl) {
                return response.status(400).send({ error: 'Expected body.avatar_url string.' });
            }
            const rawNamespaces = Array.isArray(request.body?.namespaces) ? request.body.namespaces : [];
            const seen = new Set();
            const normalized = [];
            for (const ns of rawNamespaces) {
                const n = normalizeCharacterStateNamespace(ns);
                if (!n || seen.has(n)) continue;
                seen.add(n);
                normalized.push(n);
            }
            if (normalized.length === 0) {
                return response.status(400).send({ error: 'Expected body.namespaces to be a non-empty array of strings.' });
            }

            const characterPath = path.join(request.user.directories.characters, avatarUrl);
            const data = {};
            for (const ns of normalized) {
                data[ns] = readCharacterStateSidecar(characterPath, ns);
            }
            return response.send({ ok: true, data });
        } catch (error) {
            console.error('Error reading character state sidecars:', error);
            return response.status(500).send({ error: true });
        }
    }));

    /**
     * POST /state/char/set —— char 独有:整态覆写一个 namespace。
     * body:{avatar_url, namespace, data:object};卡不存在 → 404。
     */
    regPost(`${P}/state/char/set`, 'POST', withAvatarUrlValidation(function (request, response) {
        try {
            const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
            const namespace = normalizeCharacterStateNamespace(request.body?.namespace);
            const state = request.body?.data;
            if (!avatarUrl) {
                return response.status(400).send({ error: 'Expected body.avatar_url string.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }
            if (!_.isObjectLike(state) || Array.isArray(state)) {
                return response.status(400).send({ error: 'Expected body.data object.' });
            }

            const characterPath = path.join(request.user.directories.characters, avatarUrl);
            if (!fs.existsSync(characterPath)) {
                return response.status(404).send({ error: 'Character not found.' });
            }
            const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
            if (!stateFilePath) {
                return response.status(400).send({ error: 'Invalid namespace for state sidecar path.' });
            }

            fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
            writeFileAtomicSync(stateFilePath, JSON.stringify(state), 'utf8');
            return response.send({ ok: true });
        } catch (error) {
            console.error('Error writing character state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    }));

    /**
     * POST /state/char/patch —— JSON-Patch 合并写 char_state。
     * body:{avatar_url, namespace, operations[]|operation};卡不存在 → 404;
     * patch 结果非对象 → 400;test/missing-parent → 409;op 非法 → 400。
     */
    regPost(`${P}/state/char/patch`, 'POST', withAvatarUrlValidation(function (request, response) {
        try {
            const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
            const namespace = normalizeCharacterStateNamespace(request.body?.namespace);
            if (!avatarUrl) {
                return response.status(400).send({ error: 'Expected body.avatar_url string.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }

            const operations = Array.isArray(request.body?.operations)
                ? request.body.operations
                : (_.isObjectLike(request.body?.operation) ? [request.body.operation] : []);
            if (operations.length === 0) {
                return response.status(400).send({ error: 'No character state patch operations found. Expected body.operations or body.operation.' });
            }

            const characterPath = path.join(request.user.directories.characters, avatarUrl);
            if (!fs.existsSync(characterPath)) {
                return response.status(404).send({ error: 'Character not found.' });
            }
            const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
            if (!stateFilePath) {
                return response.status(400).send({ error: 'Invalid namespace for state sidecar path.' });
            }

            const existing = readCharacterStateSidecar(characterPath, namespace);
            const seed = existing ?? {};

            let next;
            try {
                next = applyJsonPatch(seed, operations);
            } catch (error) {
                const mapped = mapCharacterStatePatchError(error, response);
                if (mapped) {
                    return mapped;
                }
                throw error;
            }

            if (!_.isObjectLike(next) || Array.isArray(next)) {
                return response.status(400).send({ error: 'Character state patch result must be an object.' });
            }

            fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
            writeFileAtomicSync(stateFilePath, JSON.stringify(next), 'utf8');
            return response.send({
                ok: true,
                applied: operations.length,
                created: existing == null,
            });
        } catch (error) {
            console.error('Error patching character state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    }));

    /** POST /state/char/delete —— 删一个 char_state sidecar;缺失 → {ok,deleted:false}。 */
    regPost(`${P}/state/char/delete`, 'POST', withAvatarUrlValidation(function (request, response) {
        try {
            const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
            const namespace = normalizeCharacterStateNamespace(request.body?.namespace);
            if (!avatarUrl) {
                return response.status(400).send({ error: 'Expected body.avatar_url string.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }

            const characterPath = path.join(request.user.directories.characters, avatarUrl);
            const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
            if (!stateFilePath || !fs.existsSync(stateFilePath)) {
                return response.send({ ok: true, deleted: false });
            }

            fs.unlinkSync(stateFilePath);
            return response.send({ ok: true, deleted: true });
        } catch (error) {
            console.error('Error deleting character state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    }));

    // -----------------------------------------------------------------------
    // preset_state:per-(apiId,name) 的 state namespace(PresetRepo 引擎面)。
    // target={apiId,name};独有 delete-all(清全 ns)/ rename(随名迁移 ns)。
    // -----------------------------------------------------------------------

    /**
     * GET /state/preset/get —— preset_state 读(ETag 资源读)。
     * query: apiId + name + namespace + account。
     */
    reg(`${P}/state/preset/get`, async function (request, response) {
        const apiId = String(request.query?.apiId || '');
        const name = sanitize(String(request.query?.name || ''));
        const namespace = normalizePresetStateNamespace(request.query?.namespace);
        const resource = `preset-state:${apiId}:${name}:${namespace}`;
        if (!isValidApiId(apiId) || !name) {
            return sendResourceReadError(response, {
                code: 'invalid_args',
                resource,
                detail: 'Expected an API id and preset name.',
                status: 400,
            });
        }
        if (!namespace) {
            return sendResourceReadError(response, {
                code: 'invalid_args',
                resource,
                detail: 'Expected a state namespace.',
                status: 400,
            });
        }
        try {
            const data = await getPresetRepo().getState(request.user.profile.handle, apiId, name, namespace);
            return sendJsonResource(request, response, {
                resource,
                value: { ok: true, data },
            });
        } catch (error) {
            console.error('Error reading preset state sidecar:', error);
            return sendResourceReadError(response, {
                code: 'read_failed',
                resource,
                detail: 'Failed to read preset state.',
                status: 500,
            });
        }
    });

    /** POST /state/preset/get —— body 版 preset_state 读。 */
    regPost(`${P}/state/preset/get`, 'POST', async function (request, response) {
        try {
            const apiId = request.body?.apiId;
            const name = sanitize(String(request.body?.name || ''));
            const namespace = normalizePresetStateNamespace(request.body?.namespace);
            if (!isValidApiId(apiId) || !name) {
                return response.status(400).send({ error: 'Invalid preset target payload.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }

            const handle = request.user.profile.handle;
            const data = await getPresetRepo().getState(handle, apiId, name, namespace);
            return response.send({ ok: true, data });
        } catch (error) {
            console.error('Error reading preset state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    });

    /** POST /state/preset/get-batch —— body:{apiId,name,namespaces[]} → {ok,data:{ns:doc|null}}。 */
    regPost(`${P}/state/preset/get-batch`, 'POST', async function (request, response) {
        try {
            const apiId = request.body?.apiId;
            const name = sanitize(String(request.body?.name || ''));
            if (!isValidApiId(apiId) || !name) {
                return response.status(400).send({ error: 'Invalid preset target payload.' });
            }

            const namespaces = [...new Set((Array.isArray(request.body?.namespaces) ? request.body.namespaces : [])
                .map((ns) => normalizePresetStateNamespace(ns))
                .filter(Boolean))];
            if (!namespaces.length) {
                return response.status(400).send({ error: 'Expected body.namespaces array.' });
            }

            const handle = request.user.profile.handle;
            const repo = getPresetRepo();
            const data = {};
            for (const ns of namespaces) {
                data[ns] = await repo.getState(handle, apiId, name, ns);
            }

            return response.send({ ok: true, data });
        } catch (error) {
            console.error('Error reading preset state sidecars:', error);
            return response.status(500).send({ error: true });
        }
    });

    /**
     * POST /state/preset/patch —— JSON-Patch 合并写 preset_state。
     * body:{apiId,name,namespace,operations[]|operation};
     * test/missing-parent → 409;op 非法 → 400。
     */
    regPost(`${P}/state/preset/patch`, 'POST', async function (request, response) {
        try {
            const apiId = request.body?.apiId;
            const name = sanitize(String(request.body?.name || ''));
            const namespace = normalizePresetStateNamespace(request.body?.namespace);
            if (!isValidApiId(apiId) || !name) {
                return response.status(400).send({ error: 'Invalid preset target payload.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }

            const operations = Array.isArray(request.body?.operations)
                ? request.body.operations
                : (request.body?.operation && typeof request.body.operation === 'object' ? [request.body.operation] : []);
            if (operations.length === 0) {
                return response.status(400).send({ error: 'No preset state patch operations found. Expected body.operations or body.operation.' });
            }

            const handle = request.user.profile.handle;
            const repo = getPresetRepo();
            const existing = await repo.getState(handle, apiId, name, namespace);
            const seed = existing ?? {};

            let next;
            try {
                next = applyJsonPatch(seed, operations);
            } catch (error) {
                const mapped = mapStatePatchError(error, response);
                if (mapped) {
                    return mapped;
                }
                throw error;
            }

            await repo.setState(handle, apiId, name, namespace, next);
            return response.send({
                ok: true,
                applied: operations.length,
                created: existing == null,
            });
        } catch (error) {
            console.error('Error patching preset state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    });

    /** POST /state/preset/delete —— 删一个 preset_state namespace → {ok,deleted}。 */
    regPost(`${P}/state/preset/delete`, 'POST', async function (request, response) {
        try {
            const apiId = request.body?.apiId;
            const name = sanitize(String(request.body?.name || ''));
            const namespace = normalizePresetStateNamespace(request.body?.namespace);
            if (!isValidApiId(apiId) || !name) {
                return response.status(400).send({ error: 'Invalid preset target payload.' });
            }
            if (!namespace) {
                return response.status(400).send({ error: 'Expected body.namespace string.' });
            }

            const handle = request.user.profile.handle;
            const deleted = await getPresetRepo().deleteState(handle, apiId, name, namespace);
            return response.send({ ok: true, deleted });
        } catch (error) {
            console.error('Error deleting preset state sidecar:', error);
            return response.status(500).send({ error: true });
        }
    });

    /** POST /state/preset/delete-all —— preset 独有:清空该预设全 ns → {ok,deleted:<count>}。 */
    regPost(`${P}/state/preset/delete-all`, 'POST', async function (request, response) {
        try {
            const apiId = request.body?.apiId;
            const name = sanitize(String(request.body?.name || ''));
            if (!isValidApiId(apiId) || !name) {
                return response.status(400).send({ error: 'Invalid preset target payload.' });
            }

            const handle = request.user.profile.handle;
            const deleted = await getPresetRepo().deleteAllStates(handle, apiId, name);
            return response.send({ ok: true, deleted });
        } catch (error) {
            console.error('Error deleting preset state sidecars:', error);
            return response.status(500).send({ error: true });
        }
    });

    /**
     * POST /state/preset/rename —— preset 独有:ns 面随名迁移。
     * body:{apiId, oldName, newName};同名 → {ok,renamed:0};
     * 目标 ns 撞档 → 409 'Preset state rename collision.'。
     */
    regPost(`${P}/state/preset/rename`, 'POST', async function (request, response) {
        try {
            const apiId = request.body?.apiId;
            const oldName = sanitize(String(request.body?.oldName || ''));
            if (!isValidApiId(apiId) || !oldName) {
                return response.status(400).send({ error: 'Invalid preset state rename payload.' });
            }
            let newName;
            try {
                newName = assertSafeRepoName(request.body?.newName, { field: 'newName' });
            } catch (err) {
                if (err instanceof InvalidArgumentError) {
                    return response.status(400).send({ error: err.message });
                }
                throw err;
            }
            if (oldName === newName) {
                return response.send({ ok: true, renamed: 0 });
            }

            const handle = request.user.profile.handle;
            const renamed = await getPresetRepo().renameStates(handle, apiId, oldName, newName);
            return response.send({ ok: true, renamed });
        } catch (error) {
            if (error instanceof ConflictError && error.code === 'preset_state_rename_collision') {
                return response.status(409).send({ error: 'Preset state rename collision.' });
            }
            console.error('Error renaming preset state sidecars:', error);
            return response.status(500).send({ error: true });
        }
    });
}
