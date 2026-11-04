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
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { stripJsonlExt } from '../storage/name-validation.js';

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

/** 统一错误出口:InvalidArgumentError→400,NotFoundError→404,其余→500。 */
export function sendError(response, error, logPrefix) {
    if (error instanceof InvalidArgumentError) {
        return response.status(400).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
        return response.status(404).send({ error: error.message });
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
    const reg = (path, handler) => ws.register({ kind: 'pattern', method: 'GET', path, handler });
    const regPost = (path, method, handler) => ws.register({ kind: 'pattern', method, path, handler });

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
}
