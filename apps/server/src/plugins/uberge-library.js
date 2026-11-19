/**
 * uberge-library —— 首个 kernel 路由插件(B 步小面先行)。
 *
 * 原来 uberge-library.js 的 10 个只读 GET 全部经 webServer.register()
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

import { read as readCharacterCard } from '../character-card-parser.js';
import { getChatRepo, getPresetRepo, getSettingsRepo, getWorldInfoRepo } from '../storage/index.js';
import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';
import {
    ConflictError,
    InvalidArgumentError,
    NotFoundError,
    PatchTestFailedError,
    UnsupportedPatchOpError,
} from '../storage/errors.js';
import { stripJsonlExt } from '../storage/name-validation.js';
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
} from '../endpoints/chats.js';

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
    if (error instanceof ConflictError || error instanceof PatchTestFailedError) {
        return response.status(409).send({ error: error.message });
    }
    if (error instanceof UnsupportedPatchOpError) {
        return response.status(400).send({ error: error.message });
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

/** PATCH /settings 允许的顶层段:只能往这两段里浅合并。 */
const PATCHABLE_SETTINGS_SECTIONS = new Set(['power_user', 'extension_settings']);

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

const P = '/api/uberge';

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
                    isImage: false,
                });
            }

            const items = [];
            for (const [charDir, info] of stems) {
                const card = await loadCharacterDoc(request.user.directories, charDir);
                const fields = card ? cardFields(card) : { name: '', tags: [] };
                items.push({
                    charDir,
                    name: fields.name || charDir,
                    avatar: info.isImage ? info.fileName : null,
                    fileName: info.fileName,
                    fileSize: info.fileSize,
                    tags: fields.tags,
                    // 卡文件存在但解析失败时仍列出,名字退化回 charDir
                    readable: card != null,
                });
            }
            items.sort((a, b) => a.name.localeCompare(b.name));
            return response.send({ items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'uberge/characters list');
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
            return sendError(response, error, 'uberge/characters get');
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
            return sendError(response, error, 'uberge/chats list');
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
            return sendError(response, error, 'uberge/chats get');
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
            return sendError(response, error, 'uberge/presets list');
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
            return sendError(response, error, 'uberge/presets get');
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
            return sendError(response, error, 'uberge/worlds list');
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
            return sendError(response, error, 'uberge/worlds get');
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
            return sendError(response, error, 'uberge/personas list');
        }
    });

    /** GET /settings —— 脱敏后的完整 settings 文档。 */
    reg(`${P}/settings`, async function (request, response) {
        try {
            const doc = await getSettingsRepo().get(request.user.profile.handle) ?? {};
            if (typeof doc !== 'object' || Array.isArray(doc) || doc === null) {
                return response.status(422).send({ error: 'Settings document is not a JSON object' });
            }
            return response.send({ settings: sanitizeSettingsDoc(doc) });
        } catch (error) {
            if (error instanceof SyntaxError) {
                return response.status(422).send({ error: 'Settings document is not valid JSON' });
            }
            return sendError(response, error, 'uberge/settings get');
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
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'uberge/chats delete');
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
                next[key] = { ...section, ...patch[key] };
            }
            await repo.save(handle, next);
            return response.send({ settings: sanitizeSettingsDoc(next) });
        } catch (error) {
            return sendError(response, error, 'uberge/settings patch');
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
            return sendError(response, error, 'uberge/presets put');
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
            return sendError(response, error, 'uberge/presets delete');
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
            return sendError(response, error, 'uberge/worlds put');
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
            return sendError(response, error, 'uberge/worlds delete');
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
            return sendError(response, error, 'uberge/personas put');
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
            return sendError(response, error, 'uberge/personas delete');
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
            return sendError(response, error, 'uberge/secrets get');
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
            return sendError(response, error, 'uberge/secrets put');
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
            return sendError(response, error, 'uberge/secrets delete');
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
            return sendError(response, error, 'uberge/chats create');
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
            return response.send({ ok: true, name: newName, fileName: `${newName}.jsonl` });
        } catch (error) {
            return sendError(response, error, 'uberge/chats rename');
        }
    });

    /**
     * POST /characters/:charDir/chats/:chatName/messages —— 追加消息。
     * body:{messages:[...], integrity?}
     *   消息原样入库(swipe_id/swipes 字段随之持久化 —— swipe 写在这层,
     *   切 swipe 的改动走 PATCH /body/:i/swipe_id)。
     *   gen_id 去重(重发安全),integrity 乐观锁不匹配 → 409。
     * 响应:{integrity, accepted, dedupedGenIds}
     */
    regPost(`${P}/characters/:charDir/chats/:chatName/messages`, 'POST', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const messages = request.body?.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                return response.status(400).send({ error: 'Expected body.messages non-empty array' });
            }
            const handle = request.user.profile.handle;
            const body = request.body ?? {};
            const incomingId = String(body.luker_generation_id || '').trim();
            const chatFilePath = path.join(request.user.directories.chats, charDir, sanitize(`${chatName}.jsonl`));
            const hint = { kind: 'character', avatar_url: `${charDir}.png`, file_name: `${chatName}.jsonl` };
            // settle/ack 机制读 body.avatar_url|file_name —— 合成写盘上下文
            const writeReq = { ...request, body: { ...body, avatar_url: hint.avatar_url, file_name: hint.file_name } };

            // gen-id 侧车去重(legacy 同语义):重试同一生成只剥队首匹配
            const sidecarLast = readLastChatGenerationId(chatFilePath);
            const toWrite = messages.slice();
            let skipped = 0;
            while (toWrite.length && sidecarLast && String(toWrite[0]?.extra?.luker_generation_id || '') === sidecarLast) {
                toWrite.shift(); skipped++;
            }
            let result;
            if (toWrite.length) {
                result = await getChatRepo().append(
                    handle, charDir, chatName, toWrite,
                    typeof body.integrity === 'string' ? body.integrity : undefined,
                );
                if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
            } else {
                const cur = await getChatRepo().get(handle, charDir, chatName).catch(() => null);
                result = { integrity: cur?.integrity ?? null, accepted: 0, dedupedGenIds: [] };
            }
            // ack(append 里没 AI 层不许吞孤儿 job)+ settle + recents —— 与 legacy 同步序
            acknowledgeGenerationFromValueOrPersistTarget(writeReq, messages, messages.some(m => m?.is_user === false) ? hint : null);
            await settleMvuAfterAppend(writeReq, { autoInit: true });
            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
            return response.send({ ...result, skipped });
        } catch (error) {
            return sendError(response, error, 'uberge/chats append');
        }
    });

    /**
     * PATCH /characters/:charDir/chats/:chatName —— JSON-Patch 局部改。
     * body:{ops:[{op,path,value?}], integrity?}
     *   doc 形状 {header, body:messages[]};swipe 切换 =
     *   {op:'replace', path:'/body/<i>/swipe_id', value:<n>}。
     *   integrity 不匹配 / test op 失败 → 409;op 非法/路径越权 → 400。
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
            const incomingId = String(body.luker_generation_id || '').trim();
            const chatFilePath = path.join(request.user.directories.chats, charDir, sanitize(`${chatName}.jsonl`));
            const hint = { kind: 'character', avatar_url: `${charDir}.png`, file_name: `${chatName}.jsonl` };
            const writeReq = { ...request, body: { ...body, avatar_url: hint.avatar_url, file_name: hint.file_name } };

            // 防 gen-id 伪造注入 + hint-ack 末楼门(与 legacy patch 同规则)
            const sanitizedOps = sanitizeOperationsAgainstLukerGenerationId(ops);
            const existing = await getChatRepo().get(handle, charDir, chatName).catch(() => null);
            const lastIdx = Math.max(0, (existing?.body?.length ?? 0) - 1);
            const hitsLast = ops.some(op => typeof op?.path === 'string'
                && (op.path.startsWith(`/body/${lastIdx}/`) || op.path.startsWith(`/${lastIdx}/`)));
            const result = await getChatRepo().patch(
                handle, charDir, chatName, sanitizedOps,
                typeof body.integrity === 'string' ? body.integrity : undefined,
            );
            if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
            acknowledgeGenerationFromValueOrPersistTarget(writeReq, ops, hitsLast ? hint : null);
            await resettleMvuAfterWrite(writeReq);
            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
            return response.send(result);
        } catch (error) {
            return sendError(response, error, 'uberge/chats patch');
        }
    });
}
