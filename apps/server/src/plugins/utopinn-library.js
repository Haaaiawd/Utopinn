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
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { serializeChatJsonl } from '@utopinn/formats';
import { Jimp } from '../jimp.js';
import { tryParse } from '../util.js';
import { getChatRepo, getGroupRepo, getNamedDocRepo, getPresetRepo, getSettingsRepo, getStorageEngine, getWorldInfoRepo } from '../storage/index.js';
import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';
import { applyJsonPatch } from '../storage/repositories/json-patch.js';
import { assertWritable } from '../storage/read-only-mode.js';
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
import { createCardListCache } from '../services/card-list-cache.js';
import {
    getSharedCharactersDir,
    isSafeSharedStem,
    loadCharacterDocFromDir,
    loadCharacterDocMerged,
    materializeSharedCharacter,
    readCharacterStateMerged,
    resolveCharacterFileMerged,
} from '../services/shared-library.js';
import { emit as diagEmit } from '../services/diag-bus.js';
import { buildGreetingFloor, buildGroupGreetingFloors, isEmptySystemSeedFloor, resolveGreetingName1 } from '../services/greeting-seed.js';
import { avatarToCharDir } from '../services/group-orchestration.js';
import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import { SecretManager, VALID_SECRET_KEYS, getSharedSecretState } from '../endpoints/secrets.js';
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
    // issue #3 展示投影:楼层透出 regex 应用后展示文本(存储字段原样)。
    projectChatFloorsForDisplayResponse,
    // 群聊写盘(TASK-062):repo 化 append 帮手,双去重/integrity/ack 与
    // legacy /api/chats/group/append 同一实现。
    appendMessagesToChatFile,
    invalidateRecentChatIndex,
} from '../endpoints/chats.js';
import {
    getQueryCharacterAvatar,
    normalizeCharacterStateNamespace,
    getCharacterStateSidecarPath,
    mapCharacterStatePatchError,
    // 角色写面(C-3):原子 PNG 重写 + ccv3/chara 双 chunk + 缓存失效,与 legacy /edit 同管线。
    writeCharacterData,
    // 人设头像上传(TASK-067):与 legacy /api/avatars/upload 同一裁剪/落盘管线。
    applyAvatarCropResize,
} from '../endpoints/characters.js';
import { invalidateThumbnail } from '../endpoints/thumbnails.js';
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
    // charDir 专用闸:`_library` 保留名(大小写不敏感)—— 池目录不可被当卡寻址。
    if (field === 'charDir' && name.toLowerCase() === '_library') {
        throw new InvalidArgumentError('charDir is a reserved name');
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
// 角色卡(无 Repo 层,直接读 characters/ 下的 PNG/JSON;_library 池读面合并)
// ---------------------------------------------------------------------------

const CHARACTER_IMAGE_EXTS = new Set(['.png', '.webp']);

/**
 * 读取一张角色卡:<charDir>.png(或 .webp)优先,退回 <charDir>.json。
 * 合并读面:私有目录在场即私有(同名遮蔽),否则回落 <dataRoot>/_library/characters。
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} charDir 不含扩展名的角色目录名
 * @returns {Promise<object|null>} 解析后的卡对象(CCv2 形状,data.* 持有字段);找不到返回 null
 */
async function loadCharacterDoc(directories, charDir) {
    return (await loadCharacterDocMerged(directories, charDir)).card;
}

/**
 * 新会话问候播种(TASK-059):读卡 + settings,产出 [greetingFloor] 或 []。
 * 两个建会话入口(PUT create / POST messages「缺失即建」)共用同一语义 —
 * 播种只在建文件瞬间发生一次,落盘后继 append 不重播(楼层已存在,首楼
 * 非空 system 占位)。
 * 失败不阻塞建会话:问候楼是增益项,卡/settings 读不出时退化为空楼层
 * (诚实空,同「卡无 first_mes」语义)。
 * @param {object} request express request
 * @param {string} charDir 角色目录名
 * @param {string} chatName 会话名(→ substCtx.currentChatId)
 * @param {object} chatMetadata 将随 header 落盘的 chat_metadata(活引用,
 *   问候文本里 {{setvar}} 家族的写入随 header 一并入库)
 * @returns {Promise<{floors: object[], variableWrites: object[]}>}
 */
async function greetingFloorsForNewChat(request, charDir, chatName, chatMetadata) {
    try {
        const card = await loadCharacterDoc(request.user.directories, charDir);
        if (!card) return { floors: [], variableWrites: [] };
        const settingsDoc = await getSettingsRepo().get(request.user.profile.handle).catch(() => null);
        const variableWrites = [];
        const floor = buildGreetingFloor({
            card,
            name1: resolveGreetingName1(request, settingsDoc),
            chatMetadata,
            chatName,
            // 克隆隔离:setglobalvar 写进克隆后被丢弃(volatile),不污染
            // settingsRepo 持有的共享 settings 文档对象。
            globalVariables: structuredClone(settingsDoc?.extension_settings?.variables?.global ?? {}),
            variableWrites,
        });
        return floor ? { floors: [floor], variableWrites } : { floors: [], variableWrites };
    } catch (error) {
        console.warn(`greeting seed skipped for ${charDir}/${chatName}:`, error?.message ?? error);
        return { floors: [], variableWrites: [] };
    }
}

/** 问候宏写进非 chat 域(message/global/preset/char)的 volatile 记账 —— 落盘点只有 header.chat_metadata,其余域诚实降级打日志。 */
function warnVolatileGreetingWrites(variableWrites, charDir, chatName) {
    const stray = (variableWrites ?? []).filter((w) => w?.domain !== 'chat');
    if (stray.length) {
        const domains = [...new Set(stray.map((w) => w?.domain).filter(Boolean))];
        console.warn(`greeting seed ${charDir}/${chatName}: ${stray.length} variable write(s) to non-chat domain(s) [${domains.join(',')}] not persisted (volatile)`);
    }
}

/**
 * persist-target hint 用的真实头像文件名:<charDir>.png/.webp 顺序探测,
 * 都不存在回退 .png。硬编码 .png 会让 webp 卡的 ack/settle chatKey 漂移(M8)。
 * 共享卡在池目录继续同序探测 —— hint 文件名对得上 /thumbnail 合并回落。
 */
async function resolveAvatarFileName(directories, charDir) {
    for (const ext of ['.png', '.webp']) {
        try {
            await fs.promises.access(path.join(directories.characters, `${charDir}${ext}`));
            return `${charDir}${ext}`;
        } catch { /* 下一个扩展名 */ }
    }
    const libDir = getSharedCharactersDir(directories);
    if (libDir && isSafeSharedStem(charDir)) {
        for (const ext of ['.png', '.webp']) {
            try {
                await fs.promises.access(path.join(libDir, `${charDir}${ext}`));
                return `${charDir}${ext}`;
            } catch { /* 下一个扩展名 */ }
        }
    }
    return `${charDir}.png`;
}

/**
 * PATCH /characters/:charDir 可写字段 —— 浅合并进 card.data
 * (v1/无 data 卡回落根层,PNG 写回经 toStoredV2Character 提升到 data.*)。
 */
const PATCHABLE_CHAR_STRING_FIELDS = new Set([
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version',
]);
/**
 * data.* 数组字段(string[]):alternate_greetings/group_only_greetings
 * 是问候消费面(TASK-059/068;extensions.alternate_greetings 影子键仍在
 * 子键白名单兼容,但真实消费读位在 data.*)。
 */
const PATCHABLE_CHAR_ARRAY_FIELDS = new Set(['tags', 'alternate_greetings', 'group_only_greetings']);
const PATCHABLE_CHAR_FIELDS = new Set([...PATCHABLE_CHAR_STRING_FIELDS, ...PATCHABLE_CHAR_ARRAY_FIELDS, 'extensions']);
/**
 * extensions 子键白名单 —— TASK-068「放行集 = 消费集」对账:
 *   world            世界书绑定(消费:embedded-world/charLore)
 *   alternate_greetings 影子键(真实读位 data.alternate_greetings,见上)
 *   regex_scripts    卡内正则(消费:regex 管线)
 *   talkativeness    群编排 NATURAL 权重(消费:group-orchestration memberTalkativeness)
 *   depth_prompt     深度提示(消费:solo generate-context + collectGroupDepthPrompts)
 *   group_greetings  群专属问候 legacy 位(消费:greeting-seed groupOnlyGreetingPool)
 *   group_greetings_mode  群问候挑选模式 0=RANDOM/1=PICK(消费:同上)
 * 钉死不放行:fav(纯 UI 态透传不消费,legacy merge-attributes 有专用写面)、
 *   tavern_helper(引擎侧车管线写,直 PATCH 会和 sidecar overlay 打架)、
 *   card_app(CardApp 专用端点写)、models(那是 config.yaml 键,与卡无关)。
 */
const PATCHABLE_CHAR_EXTENSIONS_KEYS = new Set([
    'world', 'alternate_greetings', 'regex_scripts',
    'talkativeness', 'depth_prompt', 'group_greetings', 'group_greetings_mode',
]);

/**
 * `<avatarFile>.state.<ns>.json` 侧车随卡文件改名迁移(.webp→.png 转换面用)。
 * 与 characters.js renameAllCharacterStateSidecars 同规则的本地最小实现:
 * 碰撞不覆盖(目标已存在跳过),失败只告警不阻塞 —— 卡写已成功。
 */
function migrateCharacterStateSidecars(charactersDir, oldFileName, newFileName) {
    const prefix = `${oldFileName}.state.`;
    let entries;
    try {
        entries = fs.readdirSync(charactersDir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
        const suffix = entry.name.slice(oldFileName.length); // '.state.<ns>.json'
        const targetPath = path.join(charactersDir, `${newFileName}${suffix}`);
        if (fs.existsSync(targetPath)) continue;
        try {
            fs.renameSync(path.join(charactersDir, entry.name), targetPath);
        } catch (error) {
            console.warn(`Failed to migrate character state sidecar ${entry.name}:`, error);
        }
    }
}

/** 从卡对象提取展示名/标签/当前会话指针(兼容 v1 平铺与 v2 data.*;chat 规范写位是顶层)。 */
function cardFields(card) {
    const data = (card?.data && typeof card.data === 'object' && !Array.isArray(card.data)) ? card.data : card ?? {};
    const name = typeof data.name === 'string' && data.name ? data.name
        : (typeof card?.name === 'string' && card.name ? card.name : '');
    const tags = Array.isArray(data.tags) ? data.tags
        : (Array.isArray(card?.tags) ? card.tags : []);
    const chat = typeof card?.chat === 'string' && card.chat ? card.chat
        : (typeof data.chat === 'string' ? data.chat : '');
    return { name, tags, chat };
}

// ---------------------------------------------------------------------------
// novel 章目录 + theater 资产(TASK-044 余量)
//
// 章目录双源:chat_state sidecar 'chapters' ns(显式章清单 —— 读写走通用
// state/chat/* 面,不另起存储)优先;缺席时按 apps/web stagepack.tsx
// deriveChapters 同规则从楼层推导 —— system 楼=分章标记,无标记按
// NOVEL_SEGMENT_FLOORS 楼一段,再兜底单章。
// theater 场景运行态另有 'scene' ns 约定(见 .skeinn/design/plugin-surface-
// forms.md):scene.bg/scene.bgm 的当前值落 sidecar,楼层 extra.scene 仍是
// 单楼场景引用 —— 本文件不为它开新路由,通用 state 面即写读通路。
// 资产清单 = 剧场三件套枚举,全部沿用既有落盘约定:
//   sprites     characters/<名>/ 顶层图(label 与 /api/sprites/get 同正则)
//   backgrounds characters/<名>/backgrounds/(charx 落点)+ 全局 backgrounds/
//   bgm         characters/<名>/bgm/ + 全局 assets/bgm/(乐库位,本格新约定)
// ---------------------------------------------------------------------------

const NOVEL_SEGMENT_FLOORS = 4;
const NOVEL_CHAPTERS_NS = 'chapters';
/**
 * 楼层书签(TASK-065 ST 语义):存档点落 chat_state 'bookmarks' 侧车档,
 * doc = {items:[{id,messageId,name,ts,swipeId?}]}。
 * 选侧车不选 chat_metadata —— 书签写不轮会话 integrity(客户端 CAS slug
 * 不因打个存档点过期)、rename 随档迁移(captureChatMove)、删会话级联。
 */
const CHAT_BOOKMARKS_NS = 'bookmarks';
/** 书签名展示上限(字节);fork 复合名预算留 ·NN 后缀余量。 */
const BOOKMARK_NAME_MAX_BYTES = 80;
const FORK_NAME_MAX_BYTES = 120;
const CHAPTER_HEAD_RE = /^(第[零〇一二两三四五六七八九十百千万\d]+[章节卷回部篇]|序[章言]|楔子|尾声|Prologue\b|Chapter\s+\d+)\s*[:：·\-—、 ]*\s*(.*)$/i;
const ASSET_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.apng', '.avif', '.bmp', '.jfif']);
const ASSET_AUDIO_EXTS = new Set(['.ogg', '.mp3', '.wav', '.m4a', '.flac', '.opus', '.aac']);

/** 首句/snippet 工具:空白压平后截 n 字,超出加省略号。 */
function chapterSnippet(text, n) {
    const v = String(text ?? '').trim().replace(/\s+/g, ' ');
    return v.length > n ? `${v.slice(0, n)}…` : v;
}

/** 楼层正文首段(stagepack parasOf 同规则:空行切段取首段)。 */
const firstParaText = (mes) => String(mes ?? '').split(/\n{2,}/)[0]?.trim() ?? '';

/**
 * 书签 doc 规整:非 {items:[]} 形 → 空清单;条目逐字段收编
 * (messageId 非负 int / name 字符串 / ts 数 / swipeId 非负 int 可选),
 * 缺 id 的旧档当场补 —— 脏数据不炸列表面。
 */
function normalizeBookmarkDoc(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.items)) return [];
    const out = [];
    for (const e of doc.items) {
        const messageId = Number(e?.messageId);
        if (!Number.isInteger(messageId) || messageId < 0) continue;
        out.push({
            id: typeof e?.id === 'string' && e.id ? e.id : `bm_${randomUUID().slice(0, 8)}`,
            messageId,
            name: typeof e?.name === 'string' && e.name ? e.name : `第${messageId + 1}楼`,
            ts: Number.isFinite(Number(e?.ts)) ? Number(e.ts) : 0,
            ...(Number.isInteger(Number(e?.swipeId)) && Number(e.swipeId) >= 0 ? { swipeId: Number(e.swipeId) } : {}),
        });
    }
    return out;
}

/** UTF-8 安全字节截断:按 code point 走,不劈代理对;截完 trim 尾。 */
function clampUtf8(str, maxBytes) {
    let bytes = 0;
    let out = '';
    for (const ch of String(str ?? '')) {
        bytes += Buffer.byteLength(ch, 'utf8');
        if (bytes > maxBytes) break;
        out += ch;
    }
    return out.trimEnd();
}

/** 书签名收编:trim + 字节截断;空 → 楼层默认名。 */
function bookmarkName(raw, messageId) {
    const v = clampUtf8(String(raw ?? '').trim(), BOOKMARK_NAME_MAX_BYTES);
    return v || `第${messageId + 1}楼`;
}

/**
 * 楼 → 章推导,与 apps/web/src/features/stagepack.tsx deriveChapters 同构。
 * @param {object[]} floors 投影后楼层(数组下标 = body 楼号)
 * @param {string} chatName 单章兜底时作题
 * @returns {{strategy:'empty'|'markers'|'segmented'|'single', items:object[]}}
 *   章项:{index,kind,num,title,range,floors,snippet,markerFloor?}
 *   range = 内容楼区间(含端点,不含标记楼);kind ∈ prologue|chapter|section|body
 */
export function deriveNovelChapters(floors, chatName) {
    // 只收「成书」楼:空 system 楼(会话头种)不构成章节
    const list = [];
    floors.forEach((m, idx) => {
        const mes = String(m?.mes_display ?? m?.mes ?? '');
        const isSystem = m?.is_system === true;
        if (isSystem && !mes.trim()) return;
        const role = m?.is_user ? 'user' : (isSystem ? 'system' : 'assistant');
        list.push({ idx, role, mes });
    });
    if (!list.length) return { strategy: 'empty', items: [] };

    const mk = (kind, num, title, slice, markerFloor) => {
        const first = slice[0];
        const last = slice[slice.length - 1];
        return {
            index: 0, kind, num, title,
            range: slice.length ? [first.idx, last.idx] : null,
            floors: slice.length,
            snippet: chapterSnippet(firstParaText(first?.mes), 40),
            ...(markerFloor != null ? { markerFloor } : {}),
        };
    };

    const markerAt = list.map((f, i) => (f.role === 'system' ? i : -1)).filter((i) => i >= 0);
    if (markerAt.length) {
        const items = [];
        if (markerAt[0] > 0) {
            items.push(mk('prologue', '序章', '序章', list.slice(0, markerAt[0])));
        }
        markerAt.forEach((mi) => {
            const end = markerAt.find((x) => x > mi) ?? list.length;
            const marker = list[mi];
            const line = marker.mes.trim().split('\n')[0]?.trim() ?? '';
            const head = CHAPTER_HEAD_RE.exec(line);
            const num = head ? head[1] : null;
            const title = head ? (String(head[2] ?? '').trim() || head[1]) : chapterSnippet(line, 24);
            items.push(mk('chapter', num, title, list.slice(mi + 1, end), marker.idx));
        });
        items.forEach((c, i) => { c.index = i; });
        return { strategy: 'markers', items };
    }
    if (list.length > NOVEL_SEGMENT_FLOORS) {
        const items = [];
        for (let i = 0; i < list.length; i += NOVEL_SEGMENT_FLOORS) {
            const slice = list.slice(i, i + NOVEL_SEGMENT_FLOORS);
            items.push(mk('section', null, chapterSnippet(firstParaText(slice[0].mes), 24), slice));
        }
        items.forEach((c, i) => { c.index = i; });
        return { strategy: 'segmented', items };
    }
    return { strategy: 'single', items: [mk('body', null, chatName || '单章', list)] };
}

/**
 * sidecar 'chapters' ns 章清单 → 章项;doc 非 {items:[]} 形 → null(回推导路)。
 * 条目:{from:int[,to:int][,title][,num]} —— to 缺省取下一条 from-1/末楼,
 * 越界钳到末楼;from 非 int/越界/to<from 的条目计入 skipped 并跳过。
 * @param {*} doc sidecar 文档
 * @param {object[]} floors 投影后楼层
 * @returns {{items:object[], skipped:number}|null}
 */
export function chaptersFromSidecarDoc(doc, floors) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.items)) return null;
    const entries = doc.items
        .map((e, i) => ({ e, i, from: Number(e?.from) }))
        .filter((x) => Number.isInteger(x.from) && x.from >= 0)
        .sort((a, b) => a.from - b.from || a.i - b.i);
    const declared = doc.items.length - entries.length; // from 非 int 的先记废
    const items = [];
    let skipped = declared;
    for (let i = 0; i < entries.length; i++) {
        const { e, from } = entries[i];
        if (!floors.length || from >= floors.length) { skipped++; continue; }
        const nextFrom = entries.slice(i + 1).map((x) => x.from).find((v) => v > from);
        let to = Number.isInteger(Number(e?.to)) ? Number(e.to) : (nextFrom ?? floors.length) - 1;
        to = Math.min(to, floors.length - 1);
        if (to < from) { skipped++; continue; }
        const slice = floors.slice(from, to + 1);
        items.push({
            index: items.length,
            kind: 'sidecar',
            num: typeof e?.num === 'string' && e.num ? e.num : null,
            title: typeof e?.title === 'string' && e.title ? e.title : `第${items.length + 1}章`,
            range: [from, to],
            floors: slice.length,
            snippet: chapterSnippet(firstParaText(slice[0]?.mes_display ?? slice[0]?.mes), 40),
        });
    }
    return { items, skipped };
}

/**
 * 目录枚举:dir[/sub] 下命中扩展名的常规文件 → {name,file,bytes}(按文件名排序);
 * 目录缺席/不可读 → [](诚实语义:没有就空,不静默造数据)。
 */
async function listAssetFiles(dir, extSet, sub) {
    const target = sub ? path.join(dir, sub) : dir;
    let entries;
    try {
        entries = await fs.promises.readdir(target, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!extSet.has(ext)) continue;
        const st = await fs.promises.stat(path.join(target, entry.name)).catch(() => null);
        out.push({ name: entry.name.slice(0, entry.name.length - ext.length), file: entry.name, bytes: st?.size ?? 0 });
    }
    out.sort((a, b) => a.file.localeCompare(b.file));
    return out;
}

// ---------------------------------------------------------------------------
// 预设(预设 apiId 校验)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 具名文档桶(TASK-058 读面;TASK-063 补 PUT/DELETE 写面)
// ---------------------------------------------------------------------------

/**
 * URL 桶名 → NamedDocRepo 桶名。白名单三桶与 legacy named-doc-routes
 * 同源(themes/movingUI/quickReplies);读写同闸(GET + PUT/DELETE)。
 */
const NAMED_DOC_BUCKETS = Object.freeze({
    'quick-replies': 'quickReplies',
    'themes': 'themes',
    'moving-ui': 'movingUI',
});

/** :bucket 参数 → repo 桶名;非法/未知 → InvalidArgumentError → 400。 */
function namedDocBucket(raw) {
    const key = safeName(raw, 'bucket');
    const bucket = NAMED_DOC_BUCKETS[key];
    if (!bucket) {
        throw new InvalidArgumentError(
            `bucket must be one of: ${Object.keys(NAMED_DOC_BUCKETS).join(', ')}`,
        );
    }
    return bucket;
}

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
 * PATCH /settings 允许的顶层段(对象值,逐键浅合并)。
 * `oai_settings` 承载连接配置(source/baseUrl/model 选择,连接设置 tab 依赖);
 * `world_info_settings` 承载 WI 引擎开关与 world_info.globalSelect/charLore("全局栈")。
 * 合入前过 sanitizeSettingsDoc——api_key_* 形字段一律拒绝落盘,密钥走 /secrets。
 * `background` 是 ST 全局聊天背景槽 {name,url,fitting,...}(#bg1 同源键)。
 * `accountStorage` 是 ST 用户态袋(pinnedChats 等;welcome-screen/e2e 同槽)。
 */
const PATCHABLE_SETTINGS_SECTIONS = new Set(['power_user', 'extension_settings', 'oai_settings', 'world_info_settings', 'background', 'accountStorage']);
/**
 * 允许的顶层标量键(非对象段,直写不合并)。
 * `preset_settings_openai` 是"当前 openai 预设"选择指针:生成侧读顶层
 * (generate-context resolvedPresetName),canonical 槽位却在 oai_settings
 * .preset_settings_openai(frontend/settings 响应侧优先读它)。两个读者并存,
 * 任一侧写入都双向镜像 —— 否则"设为默认"写一半静默不生效。
 */
const PATCHABLE_SETTINGS_SCALAR_KEYS = new Set(['preset_settings_openai']);

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

const P = '/api/utopinn';

export function apply(ctx) {
    const ws = ctx.webServer;
    const reg = (path, handler) => ctx.effect(() => ws.register({ kind: 'pattern', method: 'GET', path, handler }));
    const regPost = (path, method, handler) => ctx.effect(() => ws.register({ kind: 'pattern', method, path, handler }));

    // 角色列表浅字段索引:apply() 闭包内,reload/dispose 随之清(插件契约)。
    const cardListCache = createCardListCache();

    /**
     * 收集一个卡目录的候选 charDir:每个 stem 把 png/webp/json 候选档全部记入
     * 指纹(loadCharacterDoc 坏档 fallthrough,只看承载档会漏失效);
     * 列表展示档 = 图档(.png 优先于 .webp,同解析探测序),无图退 .json。
     * 私有目录与 _library 池共用同一扫描。
     * @param {string} dir 卡目录绝对路径
     * @returns {Promise<Map<string, {listed:{fileName:string,fileSize:number,ctimeMs:number}|null, isImage:boolean, files:object[]}>>}
     */
    async function collectCardStems(dir) {
        const stems = new Map();
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return stems;
        }
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            const stem = entry.name.slice(0, -ext.length);
            if (!stem) continue;
            const isImage = CHARACTER_IMAGE_EXTS.has(ext);
            const isJson = ext === '.json';
            if (!isImage && !isJson) continue;
            const stat = await fs.promises.stat(path.join(dir, entry.name)).catch(() => null);
            const rec = stems.get(stem) ?? { listed: null, isImage: false, files: [] };
            rec.files.push({
                fileName: entry.name,
                size: stat?.size ?? 0,
                mtimeMs: stat?.mtimeMs ?? 0,
                ctimeMs: stat?.ctimeMs ?? 0,
            });
            if (isImage && (!rec.isImage || ext === '.png')) {
                rec.listed = { fileName: entry.name, fileSize: stat?.size ?? 0, ctimeMs: stat?.ctimeMs ?? 0 };
                rec.isImage = true;
            } else if (isJson && !rec.isImage && !rec.listed) {
                rec.listed = { fileName: entry.name, fileSize: stat?.size ?? 0, ctimeMs: stat?.ctimeMs ?? 0 };
            }
            stems.set(stem, rec);
        }
        return stems;
    }

    /**
     * GET /characters —— 角色库列表。
     * {items:[{charDir,name,avatar,fileName,fileSize,tags,shared?}],total}
     *
     * 双源合并:用户私有目录 ∪ <dataRoot>/_library/characters;
     *   同名 stem 私有优先(遮蔽),池独有的项带 shared:true 徽标。
     *
     * 浅字段走 cardListCache:每次列表 readdir+stat(便宜)出指纹,
     * {fileName,size,mtimeMs,ctimeMs} 一致就复用上次的 name/tags/readable,
     * 变了才 loadCharacterDoc 重解 —— PNG 卡不再每请求整档重解。
     * dateLastChat 不缓存(chat repo 现查,不在卡文件里)。
     */
    reg(`${P}/characters`, async function (request, response) {
        try {
            const dir = request.user.directories.characters;
            const stems = await collectCardStems(dir);

            // _library 池:私有 stem 遮蔽;`_library` 保留名不可作为卡寻址。
            const libDir = getSharedCharactersDir(request.user.directories);
            const libStems = libDir ? await collectCardStems(libDir) : new Map();
            const visibleLibStems = new Map(
                [...libStems].filter(([stem]) => !stems.has(stem) && isSafeSharedStem(stem)),
            );

            // 合并扫描集:每条目带自己的真实目录 —— 私有条目 dir 读私有,
            // 池条目 dir 读 _library(stem 唯一归属,不存在「池 loader 读私有」)。
            const scans = [
                ...[...stems].map(([charDir, info]) => ({ charDir, info, dir, shared: false })),
                ...[...visibleLibStems].map(([charDir, info]) => ({ charDir, info, dir: libDir, shared: true })),
            ];

            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const items = [];
            let cacheHits = 0;
            for (const { charDir, info, dir: cardDir, shared } of scans) {
                if (!info.listed) continue; // 构造上不可能,防御跳过防空响应 500
                const fields = await cardListCache.get(cardDir, charDir, info.files, async () => {
                    const { card } = await loadCharacterDocFromDir(cardDir, charDir);
                    const parsed = card ? cardFields(card) : { name: '', tags: [], chat: '' };
                    return { name: parsed.name, tags: parsed.tags, chat: parsed.chat, readable: card != null };
                });
                if (fields.cached) cacheHits++;
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
                    avatar: info.isImage ? info.listed.fileName : null,
                    fileName: info.listed.fileName,
                    fileSize: info.listed.fileSize,
                    tags: fields.tags,
                    // 卡文件存在但解析失败时仍列出,名字退化回 charDir
                    readable: fields.readable,
                    // legacy /api/characters/all:chat = 卡内「当前会话」指针(jsonl 文件名)
                    chat: fields.chat || null,
                    // legacy:date_added = 卡文件 ctime;date_last_chat = 最近会话活跃
                    dateAdded: info.listed.ctimeMs ?? 0,
                    dateLastChat,
                    // 实例共享池条目徽标 —— 私有项不带此键(缺省即私有)。
                    ...(shared ? { shared: true } : {}),
                });
            }
            cardListCache.prune(dir, stems);
            if (libDir) cardListCache.prune(libDir, visibleLibStems);
            diagEmit({
                lvl: 'debug', kind: 'plugin', code: 'card_list_scan',
                msg: `characters list: ${items.length} card(s) (${visibleLibStems.size} shared), ${cacheHits} cached, ${items.length - cacheHits} parsed`,
                ctx: { route: `${P}/characters`, handle },
                data: { total: items.length, shared: visibleLibStems.size, hits: cacheHits, misses: items.length - cacheHits },
            });
            items.sort((a, b) => a.name.localeCompare(b.name));
            return response.send({ items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/characters list');
        }
    });

    /**
     * GET /characters/:charDir —— 完整角色卡 JSON。
     * 共享池命中时响应顶层带 shared:true 徽标(线协议元字段,不是卡字段)。
     */
    reg(`${P}/characters/:charDir`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const { card, shared } = await loadCharacterDocMerged(request.user.directories, charDir);
            if (!card) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            return response.send(shared ? { ...card, shared: true } : card);
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
            const messages = await projectChatFloorsForDisplayResponse(request, charDir, chat, chatName);
            return response.send({
                name: chatName,
                fileName: `${chatName}.jsonl`,
                header: chat.header ?? {},
                messages,
                integrity: chat.integrity,
                updatedAt: chat.updatedAt,
                createdAt: chat.createdAt,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats get');
        }
    });

    /**
     * GET /characters/:charDir/chats/:chatName/chapters —— novel 章目录聚合视图(TASK-044)。
     * sidecar 'chapters' ns 有 {items:[]} 章清单 → source:'sidecar';
     * 否则按 stagepack 同规则推导 → source:'derived' + strategy 细分。
     * 章项 range 为 body 楼号区间(含端点),CLI regen --range 用同一口径。
     */
    reg(`${P}/characters/:charDir/chats/:chatName/chapters`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const chat = await repo.get(handle, charDir, chatName);
            if (!chat) {
                const chatFilePath = path.join(request.user.directories.chats, charDir, `${chatName}.jsonl`);
                if (fs.existsSync(chatFilePath)) {
                    console.warn(`Chat file exists but is unreadable (corrupted): ${chatFilePath}`);
                    return response.send({ corrupted: true });
                }
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            const floors = await projectChatFloorsForDisplayResponse(request, charDir, chat, chatName);
            const sidecar = await repo.getState(handle, charDir, chatName, NOVEL_CHAPTERS_NS).catch(() => null);
            const fromDoc = chaptersFromSidecarDoc(sidecar, floors);
            if (fromDoc) {
                return response.send({
                    chat: chatName, charDir, floors: floors.length,
                    source: 'sidecar', strategy: 'sidecar',
                    items: fromDoc.items, total: fromDoc.items.length,
                    ...(fromDoc.skipped ? { skipped: fromDoc.skipped } : {}),
                });
            }
            const { strategy, items } = deriveNovelChapters(floors, chatName);
            return response.send({
                chat: chatName, charDir, floors: floors.length,
                source: 'derived', strategy, items, total: items.length,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats chapters');
        }
    });

    /**
     * GET /characters/:charDir/assets —— 剧场三件套资产清单(TASK-044)。
     * 卡不存在 → 404(诚实语义);资产目录缺席 → 空数组 + empty 标记。
     * url 均为静态面可直接取的路径(/characters|/backgrounds|/assets)。
     */
    reg(`${P}/characters/:charDir/assets`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const card = await loadCharacterDoc(request.user.directories, charDir);
            if (!card) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            const name = cardFields(card).name || charDir;
            // 资产目录按「卡显示名」寻址(charx 落点 = sanitize(data.name));
            // 名≠目录名时 charDir 目录也一并收(手工建资产目录常按文件名)
            const folders = [...new Set([sanitize(name), charDir].filter(Boolean))];
            const enc = encodeURIComponent;
            const sprites = [];
            const backgrounds = [];
            const bgm = [];
            for (const folder of folders) {
                const base = path.join(request.user.directories.characters, folder);
                for (const f of await listAssetFiles(base, ASSET_IMAGE_EXTS)) {
                    sprites.push({
                        // label 抽取与 legacy /api/sprites/get 同正则(joy-1.png → joy)
                        label: f.name.toLowerCase().match(/^(.+?)(?:[-\\.].*?)?$/)?.[1] ?? f.name,
                        name: f.name, file: f.file, bytes: f.bytes,
                        url: `/characters/${enc(folder)}/${enc(f.file)}`, scope: 'char',
                    });
                }
                for (const f of await listAssetFiles(base, ASSET_IMAGE_EXTS, 'backgrounds')) {
                    backgrounds.push({ name: f.name, file: f.file, bytes: f.bytes, url: `/characters/${enc(folder)}/backgrounds/${enc(f.file)}`, scope: 'char' });
                }
                for (const f of await listAssetFiles(base, ASSET_AUDIO_EXTS, 'bgm')) {
                    bgm.push({ name: f.name, file: f.file, bytes: f.bytes, url: `/characters/${enc(folder)}/bgm/${enc(f.file)}`, scope: 'char' });
                }
            }
            for (const f of await listAssetFiles(request.user.directories.backgrounds, ASSET_IMAGE_EXTS)) {
                backgrounds.push({ name: f.name, file: f.file, bytes: f.bytes, url: `/backgrounds/${enc(f.file)}`, scope: 'global' });
            }
            for (const f of await listAssetFiles(path.join(request.user.directories.assets, 'bgm'), ASSET_AUDIO_EXTS)) {
                bgm.push({ name: f.name, file: f.file, bytes: f.bytes, url: `/assets/bgm/${enc(f.file)}`, scope: 'global' });
            }
            return response.send({
                charDir, name, sprites, backgrounds, bgm,
                empty: sprites.length + backgrounds.length + bgm.length === 0,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/characters assets');
        }
    });

    /**
     * GET /backgrounds —— 全局聊天背景清单(backgrounds/ 目录,ST #bg1 选图源)。
     * {items:[{filename,url,isAnimated}],total};url 静态面直取,isAnimated
     * 按扩展名推断(legacy /api/backgrounds/all 的元数据缺省同款回落)。
     * settings.background = {name,url,fitting} 经 PATCH /settings 写。
     */
    reg(`${P}/backgrounds`, async function (request, response) {
        try {
            const files = await listAssetFiles(request.user.directories.backgrounds, ASSET_IMAGE_EXTS);
            const enc = encodeURIComponent;
            const items = files.map((f) => ({
                filename: f.file,
                url: `/backgrounds/${enc(f.file)}`,
                isAnimated: /\.(?:gif|webp|apng)$/i.test(f.file),
            }));
            return response.send({ items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/backgrounds list');
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

    /**
     * GET /named-docs/:bucket —— 具名文档桶名单。
     * bucket ∈ quick-replies|themes|moving-ui(NAMED_DOC_BUCKETS 白名单映射
     * 到 repo camelCase 桶);写面在同名 PUT/DELETE(TASK-063)。
     *
     * 与 legacy /api/quick-replies|themes|moving-ui/list 同源同形:
     *   {names:[…]};走 sendJsonResource(ETag 私有缓存,需 ?account=<handle>)
     *   保持 StageFrame 等消费者的缓存语义不变。
     */
    reg(`${P}/named-docs/:bucket`, async function (request, response) {
        try {
            const bucket = namedDocBucket(request.params.bucket);
            const entries = await getNamedDocRepo().list(request.user.profile.handle, bucket);
            const names = entries
                .map((entry) => entry?.key?.name)
                .filter((name) => typeof name === 'string' && name.length > 0)
                .sort((a, b) => a.localeCompare(b));
            return sendJsonResource(request, response, { resource: `${bucket}:list`, value: { names } });
        } catch (error) {
            return sendError(response, error, 'utopinn/named-docs list');
        }
    });

    /**
     * GET /named-docs/:bucket/:name —— 具名文档单体(只读)。
     * 与 legacy /get 同序:先名单校验(不存在 → 404 not_found)再读档
     * (doc==null → 422 invalid_resource);错误面沿用 {code,resource,detail}。
     */
    reg(`${P}/named-docs/:bucket/:name`, async function (request, response) {
        const handle = request.user.profile.handle;
        let bucket;
        let name;
        try {
            bucket = namedDocBucket(request.params.bucket);
            name = safeName(request.params.name, 'name');
        } catch (error) {
            return sendError(response, error, 'utopinn/named-docs get');
        }
        try {
            const entries = await getNamedDocRepo().list(handle, bucket);
            if (!entries.some((entry) => entry?.key?.name === name)) {
                return sendResourceReadError(response, {
                    code: 'not_found',
                    resource: `${bucket}:${name}`,
                    detail: `Named document not found in bucket ${bucket}: ${name}`,
                    status: 404,
                });
            }
            const doc = await getNamedDocRepo().get(handle, bucket, name);
            if (doc == null) {
                return sendResourceReadError(response, {
                    code: 'invalid_resource',
                    resource: `${bucket}:${name}`,
                    detail: `Named document is not valid JSON: ${bucket}/${name}`,
                    status: 422,
                });
            }
            return sendJsonResource(request, response, { resource: `${bucket}:${name}`, value: doc });
        } catch (error) {
            return sendResourceReadError(response, {
                code: 'read_failed',
                resource: `${bucket}:${name}`,
                detail: `Could not read named document: ${bucket}/${name}`,
                status: 500,
            });
        }
    });

    /**
     * PUT /named-docs/:bucket/:name —— 具名文档整档写回(TASK-063 写面)。
     * body 即文档本体(自由 JSON 对象);name 键归一到路由名 —— legacy
     * /save 拿 body.name 当落点名,REST 面收敛成「URL 是唯一权威名」,
     * 写回 doc.name 对齐路由名(ST 三桶文档都自带 name 键,保持自名一致)。
     * 其余字段原样透传 —— QR 册的 qrList 扩展位/主题字段不在线协议里枚举。
     * 404 不存在场景不存在(PUT 语义=创建/覆写);读仓闸由 repo.assertWritable。
     */
    regPost(`${P}/named-docs/:bucket/:name`, 'PUT', async function (request, response) {
        try {
            const handle = request.user.profile.handle;
            const bucket = namedDocBucket(request.params.bucket);
            const name = safeName(request.params.name, 'name');
            const doc = request.body;
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
                return response.status(400).send({ error: 'Request body must be a JSON object' });
            }
            await getNamedDocRepo().save(handle, bucket, name, { ...doc, name });
            return response.send({ ok: true, name });
        } catch (error) {
            return sendError(response, error, 'utopinn/named-docs save');
        }
    });

    /**
     * DELETE /named-docs/:bucket/:name —— 具名文档删除;missing → 404
     * (strict 删除,themes legacy /delete 同口径;quick-replies legacy 的
     * 宽松 200 不沿用 —— REST 面 404 是诚实语义,无旧消费方要兼容)。
     */
    regPost(`${P}/named-docs/:bucket/:name`, 'DELETE', async function (request, response) {
        try {
            const handle = request.user.profile.handle;
            const bucket = namedDocBucket(request.params.bucket);
            const name = safeName(request.params.name, 'name');
            await getNamedDocRepo().delete(handle, bucket, name, { strict: true });
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'utopinn/named-docs delete');
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
     * PATCH /settings —— 受限浅合并:{power_user:{…}, extension_settings:{…},
     * oai_settings:{…}, world_info_settings:{…}} 逐键浅合并进现有段;
     * 另放标量键 preset_settings_openai(预设选择指针,直写并镜像进
     * oai_settings.preset_settings_openai——两个读取面保持一致)。
     * 顶层键必须全部落在白名单里;其余顶层字段不可经此端点写。
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
            const allowed = [...PATCHABLE_SETTINGS_SECTIONS, ...PATCHABLE_SETTINGS_SCALAR_KEYS];
            const rejected = keys.filter((key) => !PATCHABLE_SETTINGS_SECTIONS.has(key) && !PATCHABLE_SETTINGS_SCALAR_KEYS.has(key));
            if (rejected.length > 0) {
                return response.status(400).send({
                    error: `Settings sections not patchable via this endpoint: ${rejected.join(', ')}. Allowed: ${allowed.join(', ')}`,
                });
            }
            for (const key of keys) {
                if (PATCHABLE_SETTINGS_SCALAR_KEYS.has(key)) {
                    // 标量键:string 直写,null 删键(merge-patch 语义)
                    if (patch[key] !== null && typeof patch[key] !== 'string') {
                        return response.status(422).send({ error: `Setting "${key}" must be a string` });
                    }
                    continue;
                }
                if (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])) {
                    return response.status(422).send({ error: `Section "${key}" must be a JSON object` });
                }
            }

            const repo = getSettingsRepo();
            const handle = request.user.profile.handle;

            // preset 选择指针双向镜像的输入校验:全部 4xx 前置在 tx 外,
            // 进 update() 临界区后唯一失败源是存储故障(那种情况全滚才对)。
            const presetViaOai = Object.hasOwn(patch, 'oai_settings')
                && patch.oai_settings && typeof patch.oai_settings === 'object' && !Array.isArray(patch.oai_settings)
                && Object.hasOwn(patch.oai_settings, 'preset_settings_openai');
            const presetViaTop = Object.hasOwn(patch, 'preset_settings_openai');
            if (presetViaOai || presetViaTop) {
                // 标量守卫:oai_settings 内嵌 preset_settings_openai 同顶层口径
                // —— 非 string|null 拒写(否则对象类型会污染 generate-context
                // 的预设指针)。
                const mirrorVal = presetViaOai ? patch.oai_settings.preset_settings_openai : patch.preset_settings_openai;
                if (mirrorVal !== null && typeof mirrorVal !== 'string') {
                    return response.status(422).send({ error: 'preset_settings_openai must be a string or null.' });
                }
            }

            // 读→合并→写整体进 update() 的 per-handle 临界区:并发 PATCH 异键
            // 不再整文档互覆(各键自合),同键按 tx 到达序后写胜。合并输入是
            // 绝对值,正确语义即 per-key last-wins —— 不上 CAS/test 锚,无 409。
            const next = await repo.update(handle, (base) => {
                const next = { ...base };
                for (const key of keys) {
                    if (PATCHABLE_SETTINGS_SCALAR_KEYS.has(key)) continue; // 标量键在段合并后统一落,保证同 patch 内顶键优先
                    const section = (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) ? base[key] : {};
                    const sanitized = sanitizeSettingsDoc(patch[key]);
                    if (key === 'world_info_settings'
                        && section.world_info && typeof section.world_info === 'object' && !Array.isArray(section.world_info)
                        && sanitized.world_info && typeof sanitized.world_info === 'object' && !Array.isArray(sanitized.world_info)) {
                        sanitized.world_info = { ...section.world_info, ...sanitized.world_info };
                    }
                    next[key] = { ...section, ...sanitized };
                }

                // preset 选择指针双向镜像:写 oai_settings.preset_settings_openai
                // → 同步顶层(generate-context 读顶层);写顶层 → 同步 oai_settings
                // (settings 响应侧优先读 canonical 槽位)。两者同 patch 时顶层优先。
                // 镜像对在同一 tx 内同生共死 —— 单 tx 全或无,不写一半。
                if (presetViaOai || presetViaTop) {
                    const nextOai = (next.oai_settings && typeof next.oai_settings === 'object' && !Array.isArray(next.oai_settings))
                        ? { ...next.oai_settings }
                        : {};
                    if (presetViaOai) {
                        next.preset_settings_openai = nextOai.preset_settings_openai;
                    }
                    if (presetViaTop) {
                        if (patch.preset_settings_openai === null) {
                            delete next.preset_settings_openai;
                            delete nextOai.preset_settings_openai;
                        } else {
                            next.preset_settings_openai = patch.preset_settings_openai;
                            nextOai.preset_settings_openai = patch.preset_settings_openai;
                        }
                    }
                    next.oai_settings = nextOai;
                }
                return next;
            });
            return response.send({ settings: sanitizeSettingsDoc(next) });
        } catch (error) {
            return sendError(response, error, 'utopinn/settings patch');
        }
    });

    /**
     * PATCH /characters/:charDir —— 角色卡字段级写(C-3)。
     *
     * body(JSON Merge Patch 风格,只允许白名单键):
     *   name/description/personality/scenario/first_mes/mes_example/creator_notes/
     *   system_prompt/post_history_instructions/creator/character_version → string;
     *   tags → string[];extensions → 对象,逐键合并一层,仅放
     *   world(世界书绑定,空串解绑)/alternate_greetings(string[])/regex_scripts(object[])。
     *   card_app 与资产二进制字段不放行 —— 走专用管线。null = 删键(name 除外)。
     *
     * 合并落点:v2/v3 卡 → card.data.* / card.data.extensions.*;
     *   v1 卡(无 data) → 根层/根 extensions,PNG 写回时经
     *   toStoredV2Character 提升到 data.*(同 legacy 升格管线)。
     *
     * name 只改显示名:charDir 是存储键(文件名/会话目录/state 侧车全挂它),
     *   重命名是另一个面,这里绝不同步。
     *
     * 写回:PNG 卡走 writeCharacterData(原子 tmp+rename + ccv3/chara 双 chunk
     *   + memory/disk 缓存失效,legacy /edit 同管线);.json 卡原子直写;
     *   .webp 卡(实为 PNG 字节才能读到这)经 jimp 转 <charDir>.png 并迁移
     *   <file>.state.* 侧车、摘除旧 .webp,防双源漂移。
     *
     * 响应:写后完整角色对象(同 GET 形状);extensions.world 先经
     *   WorldInfoRepo.resolveName 归一到 canonical 书名(同 legacy /edit 自愈)。
     */
    regPost(`${P}/characters/:charDir`, 'PATCH', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const patch = request.body;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
                return response.status(400).send({ error: 'Request body must be a non-empty JSON object' });
            }
            const rejected = Object.keys(patch).filter((key) => !PATCHABLE_CHAR_FIELDS.has(key));
            if (rejected.length > 0) {
                return response.status(400).send({
                    error: `Character fields not patchable: ${rejected.join(', ')}. Allowed: ${[...PATCHABLE_CHAR_FIELDS].join(', ')}`,
                });
            }
            for (const [key, value] of Object.entries(patch)) {
                if (key === 'extensions') continue;
                if (value === null) {
                    // merge-patch 删键;name 必须有值
                    if (key === 'name') {
                        return response.status(400).send({ error: 'Character name must not be null or empty.' });
                    }
                    continue;
                }
                if (PATCHABLE_CHAR_ARRAY_FIELDS.has(key)) {
                    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
                        return response.status(422).send({ error: 'Field "' + key + '" must be an array of strings' });
                    }
                    continue;
                }
                if (typeof value !== 'string') {
                    return response.status(422).send({ error: `Field "${key}" must be a string` });
                }
                if (key === 'name' && (value.trim() === '' || value.trim() === '.')) {
                    return response.status(400).send({ error: 'Character name must not be empty.' });
                }
            }
            let extensionsPatch = null;
            if (patch.extensions !== undefined) {
                if (typeof patch.extensions !== 'object' || patch.extensions === null || Array.isArray(patch.extensions)) {
                    return response.status(422).send({ error: 'Field "extensions" must be a JSON object (per-key merge)' });
                }
                const extRejected = Object.keys(patch.extensions).filter((key) => !PATCHABLE_CHAR_EXTENSIONS_KEYS.has(key));
                if (extRejected.length > 0) {
                    return response.status(400).send({
                        error: `extensions keys not patchable: ${extRejected.join(', ')}. Allowed: ${[...PATCHABLE_CHAR_EXTENSIONS_KEYS].join(', ')}`,
                    });
                }
                for (const [key, value] of Object.entries(patch.extensions)) {
                    if (value === null) continue; // 删键
                    if (key === 'world' && typeof value !== 'string') {
                        return response.status(422).send({ error: 'extensions.world must be a string (world book name, empty to unbind)' });
                    }
                    if (key === 'alternate_greetings' && (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))) {
                        return response.status(422).send({ error: 'extensions.alternate_greetings must be an array of strings' });
                    }
                    if (key === 'regex_scripts' && (!Array.isArray(value) || !value.every((item) => item && typeof item === 'object' && !Array.isArray(item)))) {
                        return response.status(422).send({ error: 'extensions.regex_scripts must be an array of objects' });
                    }
                    if (key === 'talkativeness' && (typeof value !== 'number' || !Number.isFinite(value))) {
                        return response.status(422).send({ error: 'extensions.talkativeness must be a finite number' });
                    }
                    if (key === 'depth_prompt') {
                        if (typeof value !== 'object' || Array.isArray(value)) {
                            return response.status(422).send({ error: 'extensions.depth_prompt must be an object {prompt?,depth?,role?}' });
                        }
                        if ('prompt' in value && typeof value.prompt !== 'string') {
                            return response.status(422).send({ error: 'extensions.depth_prompt.prompt must be a string' });
                        }
                        if ('depth' in value && (typeof value.depth !== 'number' || !Number.isFinite(value.depth))) {
                            return response.status(422).send({ error: 'extensions.depth_prompt.depth must be a finite number' });
                        }
                        if ('role' in value && typeof value.role !== 'string') {
                            return response.status(422).send({ error: 'extensions.depth_prompt.role must be a string' });
                        }
                    }
                    if (key === 'group_greetings' && (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))) {
                        return response.status(422).send({ error: 'extensions.group_greetings must be an array of strings' });
                    }
                    if (key === 'group_greetings_mode' && value !== 0 && value !== 1) {
                        return response.status(422).send({ error: 'extensions.group_greetings_mode must be 0 (RANDOM) or 1 (PICK)' });
                    }
                }
                extensionsPatch = patch.extensions;
            }

            // 合并读寻址:私有在场即私有;仅共享池命中 → 先物化(copy-on-write),
            // 之后按私有卡走 —— 共享档绝不在原地被改。
            let { card, source, shared } = await loadCharacterDocMerged(request.user.directories, charDir);
            if (!card || typeof card !== 'object' || Array.isArray(card) || !source) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            let effectiveCharDir = charDir;
            let materialized = null;
            if (shared) {
                assertWritable();
                materialized = await materializeSharedCharacter(request.user.directories, charDir);
                effectiveCharDir = materialized.charDir;
                const reloaded = await loadCharacterDocFromDir(request.user.directories.characters, effectiveCharDir);
                if (!reloaded.card || !reloaded.source) {
                    return response.status(500).send({ error: `Shared character materialized but unreadable: ${materialized.fileName}` });
                }
                ({ card, source } = reloaded);
            }

            // 合并:v2/v3 → data.*;v1/无 data → 根层(PNG 写出时升格提升)。
            const next = _.cloneDeep(card);
            const hasData = next.data && typeof next.data === 'object' && !Array.isArray(next.data);
            const fieldTarget = hasData ? next.data : next;
            for (const [key, value] of Object.entries(patch)) {
                if (key === 'extensions') continue;
                if (value === null) {
                    delete fieldTarget[key];
                    // 显式 null = 整字段删除:根/data 双存形下连根副本一起摘,
                    // 否则 PNG 写盘时 toStoredV2Character 把旧根值提升复活、
                    // JSON 卡读面也经 ?? 回落根值(PR#25 黄 2)。字段缺席不进
                    // 本循环 → 根副本原样不动(merge-patch 缺席语义保留)。
                    if (fieldTarget !== next) {
                        delete next[key];
                    }
                } else {
                    fieldTarget[key] = value;
                }
            }
            if (extensionsPatch) {
                const extensionsTarget = hasData
                    ? (next.data.extensions = (next.data.extensions && typeof next.data.extensions === 'object' && !Array.isArray(next.data.extensions)) ? next.data.extensions : {})
                    : (next.extensions = (next.extensions && typeof next.extensions === 'object' && !Array.isArray(next.extensions)) ? next.extensions : {});
                for (const [key, value] of Object.entries(extensionsPatch)) {
                    if (value === null) {
                        delete extensionsTarget[key];
                        // 同款复活洞:toStoredV2Character 把根 extensions
                        // deepMerge 进 data.extensions —— 显式 null 连另一层
                        // 副本一起摘(缺席键同样不动)。
                        const otherExtensions = hasData ? next.extensions : next.data?.extensions;
                        if (otherExtensions && typeof otherExtensions === 'object' && !Array.isArray(otherExtensions)) {
                            delete otherExtensions[key];
                        }
                    } else {
                        extensionsTarget[key] = value;
                    }
                }
            }

            // extensions.world 归一到 canonical 书名(同 legacy /edit 的
            // healCharacterWorldBinding):容忍匹配命中的漂移名一次写正。
            const handle = request.user.profile.handle;
            const worldSlots = hasData ? ['data.extensions.world'] : ['extensions.world', 'world'];
            for (const slot of worldSlots) {
                const bound = String(_.get(next, slot, '') || '').trim();
                if (!bound) continue;
                try {
                    const canonical = await getWorldInfoRepo().resolveName(handle, bound);
                    if (canonical && canonical !== bound) {
                        console.info(`utopinn/characters patch: healing ${slot}: "${bound}" -> "${canonical}"`);
                        _.set(next, slot, canonical);
                    }
                } catch (healError) {
                    console.warn('utopinn/characters patch: world binding heal failed', healError);
                }
            }

            assertWritable();
            if (source.kind === 'json') {
                writeFileAtomicSync(source.filePath, JSON.stringify(next), 'utf8');
            } else {
                // spec 缺失(v1)→ 先盖章走 toStoredV2Character 升格;否则
                // normalizeCharacterCardForStorage 会走 convertToV2 表单路径,
                // 把 extensions.world/system_prompt 等非表单字段清零。
                if (next.spec === undefined) {
                    next.spec = 'chara_card_v2';
                    next.spec_version = '2.0';
                }
                const writeOk = await writeCharacterData(source.filePath, JSON.stringify(next), effectiveCharDir, request, undefined, {
                    allowMissingInputFallback: false,
                    // .webp → .png 转换面输出档本来不存在,不能要求它在
                    requireExistingOutput: source.ext === '.png',
                    normalize: true,
                });
                if (!writeOk) {
                    const cause = request.lastWriteCharacterDataError || 'unknown write error';
                    return response.status(500).send({ error: `Failed to persist character data: ${cause}` });
                }
                if (source.ext !== '.png') {
                    // 写产物恒为 <charDir>.png——摘除旧图档并迁移 char_state
                    // 侧车,否则列表/读面在双源间漂移。
                    try {
                        fs.unlinkSync(source.filePath);
                    } catch (unlinkError) {
                        console.warn(`Failed to remove superseded character file ${source.filePath}:`, unlinkError);
                    }
                    migrateCharacterStateSidecars(request.user.directories.characters, path.basename(source.filePath), `${effectiveCharDir}.png`);
                }
            }

            const written = await loadCharacterDoc(request.user.directories, effectiveCharDir);
            const body = written ?? next;
            if (materialized) {
                // 物化 PATCH:告诉调用方写到的实际干名 —— 共享卡仍挂原 stem,
                // 之后的编辑/会话都应改指私有新档。
                return response.send({ ...body, __materialized: true, charDir: effectiveCharDir });
            }
            return response.send(body);
        } catch (error) {
            return sendError(response, error, 'utopinn/characters patch');
        }
    });

    /**
     * POST /characters/:charDir/install —— 显式物化:把共享池卡整档拷进
     * 用户 characters 目录。私有同名卡在场 → 409(同 PATCH 会先走私有);
     * 非共享卡 → 404;装完返回 {charDir,fileName,card}。
     */
    regPost(`${P}/characters/:charDir/install`, 'POST', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            assertWritable();
            const resolved = resolveCharacterFileMerged(request.user.directories, charDir);
            if (resolved && !resolved.shared) {
                return response.status(409).send({ error: `Character already installed privately: ${charDir}` });
            }
            const materialized = await materializeSharedCharacter(request.user.directories, charDir);
            const { card } = await loadCharacterDocFromDir(request.user.directories.characters, materialized.charDir);
            return response.send({
                charDir: materialized.charDir,
                fileName: materialized.fileName,
                card: card ?? null,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/characters install');
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

    /**
     * POST /personas/avatar —— 自定义人设头像上传(TASK-067)。
     * 与 legacy /api/avatars/upload 同一条管线与同一落点(avatars 目录):
     *   全局 multer field 'avatar' → Jimp 读图 → applyAvatarCropResize
     *   (?crop= JSON 透传)→ 原子写到 directories.avatars → 缩略图失效。
     * body.overwrite_name 指定落盘文件名(sanitize);缺省 <ts>.png。
     * 响应 {path} —— 文件名即 persona 主键,PUT /personas/:avatar 直引。
     */
    regPost(`${P}/personas/avatar`, 'POST', async function (request, response) {
        try {
            if (!request.file?.path) {
                return response.status(400).send({ error: 'Multipart field "avatar" required' });
            }
            const uploadPath = request.file.path;
            try {
                const crop = tryParse(request.query.crop);
                const rawImg = await Jimp.read(uploadPath);
                const image = await applyAvatarCropResize(rawImg, crop);
                const requested = request.body?.overwrite_name ?? request.query?.overwrite_name;
                const filename = requested ? sanitize(String(requested)) : `${Date.now()}.png`;
                if (!filename) {
                    return response.status(400).send({ error: 'Invalid overwrite_name' });
                }
                invalidateThumbnail(request.user.directories, 'persona', filename);
                writeFileAtomicSync(path.join(request.user.directories.avatars, filename), image);
                return response.send({ path: filename });
            } finally {
                await fs.promises.unlink(uploadPath).catch(() => { /* best-effort */ });
            }
        } catch (error) {
            console.error('utopinn/personas avatar upload failed:', error);
            return response.status(400).send({ error: 'Is not a valid image' });
        }
    });

    // -----------------------------------------------------------------------
    // 导出中心(TASK-067 刀2):chat/card/world/preset 四类资源原始格式回出,
    // 与 import-pipeline 的探测面对称 —— 导出文件直接能回导不丢语义。
    //   chat   → ST JSONL(header chat_metadata + body,formats serializeChatJsonl)
    //   card   → 盘上原卡文件直出(PNG 的 tEXt/chara 即持久化面)
    //   world  → {entries:{}} JSON(import 'world' 嗅探形)
    //   preset → 预设整档 JSON(import 'preset' 嗅探形)
    // -----------------------------------------------------------------------

    /** RFC 5987 Content-Disposition:非 ASCII 名走 filename*;ASCII 兜底给老客户端。 */
    const exportDisposition = (fileName) => {
        const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    };

    /** GET /export/chat/:charDir/:chatName —— 会话 JSONL(ST 兼容形)。 */
    reg(`${P}/export/chat/:charDir/:chatName`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const chat = await getChatRepo().get(request.user.profile.handle, charDir, chatName);
            if (!chat) {
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            /* ST 首行是整 header 对象(user_name/character_name/create_date/chat_metadata),
               repo 落盘即 JSON.stringify(header) —— 逐字节回出才不丢语义。
               serializeChatJsonl 只承载 chat_metadata 键,故首行自序、消息行仍走 formats 编码面。 */
            const hasHeader = chat.header && typeof chat.header === 'object' && !Array.isArray(chat.header)
                && Object.keys(chat.header).length > 0;
            const body = Array.isArray(chat.body) ? chat.body : [];
            const jsonl = [
                hasHeader ? JSON.stringify(chat.header) : null,
                serializeChatJsonl(null, body),
            ].filter(Boolean).join('\n');
            response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
            response.setHeader('content-disposition', exportDisposition(`${chatName}.jsonl`));
            return response.send(jsonl);
        } catch (error) {
            return sendError(response, error, 'utopinn/export chat');
        }
    });

    /**
     * GET /export/card/:charDir —— 角色卡原始文件直出。
     * PNG/webp 卡的 tEXt 块即盘上持久化面(PATCH 写回同一文件),
     * 回出原字节 = 导出即回导,不重新编码不丢位。
     * .json 卡(少见,手工落盘)回 JSON 文档;webp 兜底 JSON 化。
     */
    reg(`${P}/export/card/:charDir`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            // 合并读:共享卡也可整档导出(只读流 _library 源文件,不写)。
            const { card, source } = await loadCharacterDocMerged(request.user.directories, charDir);
            if (!card || !source) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            const fileName = path.basename(source.filePath);
            const buffer = await fs.promises.readFile(source.filePath);
            const contentType = source.kind === 'json'
                ? 'application/json; charset=utf-8'
                : (source.ext === '.webp' ? 'image/webp' : 'image/png');
            response.setHeader('content-type', contentType);
            response.setHeader('content-disposition', exportDisposition(fileName));
            return response.send(buffer);
        } catch (error) {
            return sendError(response, error, 'utopinn/export card');
        }
    });

    /** GET /export/world/:name —— 世界书整档 {entries:{}} JSON。 */
    reg(`${P}/export/world/:name`, async function (request, response) {
        try {
            const requested = safeName(request.params.name, 'name');
            const repo = getWorldInfoRepo();
            const handle = request.user.profile.handle;
            const doc = await repo.get(handle, requested);
            if (doc == null) {
                return response.status(404).send({ error: `World book not found: ${requested}` });
            }
            const canonical = await repo.resolveName(handle, requested);
            response.setHeader('content-type', 'application/json; charset=utf-8');
            response.setHeader('content-disposition', exportDisposition(`${canonical ?? requested}.json`));
            return response.send(JSON.stringify(doc, null, 2));
        } catch (error) {
            return sendError(response, error, 'utopinn/export world');
        }
    });

    /** GET /export/preset/:name?apiId= —— 预设整档 JSON(缺省 openai 家族)。 */
    reg(`${P}/export/preset/:name`, async function (request, response) {
        try {
            const name = safeName(request.params.name, 'name');
            const apiId = isValidApiId(String(request.query?.apiId ?? 'openai')) ? String(request.query?.apiId ?? 'openai') : null;
            if (!apiId) {
                return response.status(400).send({ error: `Invalid apiId: ${request.query?.apiId}` });
            }
            const doc = await getPresetRepo().get(request.user.profile.handle, apiId, name);
            if (doc == null) {
                return response.status(404).send({ error: `Preset not found: ${apiId}/${name}` });
            }
            response.setHeader('content-type', 'application/json; charset=utf-8');
            response.setHeader('content-disposition', exportDisposition(`${name}.json`));
            return response.send(JSON.stringify(doc, null, 2));
        } catch (error) {
            return sendError(response, error, 'utopinn/export preset');
        }
    });

    // -----------------------------------------------------------------------
    // masked-secret:脱敏读(SecretManager.getSecretState 原生脱敏)+ 受限写
    //   + shared 面(TASK-072 §2.4):实例共享档对本 handle 的可用性视图 —
    //   只回 {label, active:true}|null,不回 id / 掩码 / handles 名单。
    //   VALID_SECRET_KEYS 与 admin 共享面共用 secrets.js 的白名单。
    // -----------------------------------------------------------------------

    /** GET /secrets —— 全键脱敏态 {key: [{id,value:masked,label,active}]|null} + shared 可用性。 */
    reg(`${P}/secrets`, async function (request, response) {
        try {
            const state = new SecretManager(request.user.directories).getSecretState();
            const shared = getSharedSecretState(request);
            return response.send({ secrets: state, shared });
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
            /* activate:false → 新条不抢 active 槽 —— profile 编辑器存 key 走此,
               池内既有 active 条目(别档/旧路 fallback 凭证)不动。 */
            const activate = request.body?.activate !== false;
            const manager = new SecretManager(request.user.directories);
            const id = manager.writeSecret(key, value, label, { activate });
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
     * PUT /characters/:charDir/chats/:chatName —— 新建会话。
     * body:{header?} → 缺省 {chat_metadata:{}};已存在 → 409。
     * TASK-059:卡有问候时 body[0] 落 first_mes 开场楼(与 POST messages
     * 「缺失即建」同一播种语义);无问候 → 真空文件(现行为)。
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
            const headerDoc = header ?? { chat_metadata: {} };
            if (typeof headerDoc.chat_metadata !== 'object' || headerDoc.chat_metadata === null || Array.isArray(headerDoc.chat_metadata)) {
                headerDoc.chat_metadata = {};
            }
            const seed = await greetingFloorsForNewChat(request, charDir, chatName, headerDoc.chat_metadata);
            warnVolatileGreetingWrites(seed.variableWrites, charDir, chatName);
            const { integrity } = await repo.save(handle, charDir, chatName, headerDoc, seed.floors);
            return response.status(201).send({
                ok: true, name: chatName, fileName: `${chatName}.jsonl`, integrity,
                ...(seed.floors.length ? { greeting_seeded: true } : {}),
            });
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
            let existing = await repo.get(handle, charDir, chatName);
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
                const header = createChatHeader(
                    body.chat_metadata && typeof body.chat_metadata === 'object' && !Array.isArray(body.chat_metadata)
                        ? body.chat_metadata : {});
                // TASK-059 开场问候播种:卡 first_mes 落 body[0](swipe 组 =
                // first+alternates);问候在场时客户端捎来的空 system「会话头种」
                // 占位楼不再入库 —— 播种即顶位,保持上游新会话楼层形状。
                const seed = await greetingFloorsForNewChat(request, charDir, chatName, header.chat_metadata);
                warnVolatileGreetingWrites(seed.variableWrites, charDir, chatName);
                const floors = seed.floors.length
                    ? seed.floors.concat(cleanedMessages.filter((m) => !isEmptySystemSeedFloor(m)))
                    : cleanedMessages;
                // createIfAbsent 原子查+写:并发首写不再互踩(PR#18 review:
                // 旧 save(null) 无条件覆盖,后到者整段换先到者的楼层)。
                // 撞车 → 重读后落 append 路径,楼层不丢。
                let newIntegrity;
                try {
                    ({ integrity: newIntegrity } = await repo.createIfAbsent(handle, charDir, chatName, header, floors));
                } catch (err) {
                    if (!(err instanceof ConflictError)) throw err;
                    existing = await repo.get(handle, charDir, chatName);
                }
                if (!newIntegrity) {
                    // 并发已建 → 落到下方 append 路径(existing 已重读)。
                    const appended = await appendMessagesToChatFile({
                        filePath: chatFilePath, messages,
                        chatMetadata: _.isObjectLike(body.chat_metadata) ? body.chat_metadata : {},
                        integritySlug: slugRaw || undefined, force,
                        incomingGenerationId: incomingId, handle, charDir, name: chatName,
                    });
                    await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
                    acknowledgeGenerationFromValueOrPersistTarget(writeReq, messages, hasAiFloor ? hint : null);
                    await settleMvuAfterAppend(writeReq, { autoInit: true });
                    return response.send({
                        ok: true, appended: appended?.appended ?? 0, created: false,
                        integrity: appended?.integrity ?? existing?.integrity ?? null,
                    });
                }
                writeChatSyncState(chatFilePath, { integrity: newIntegrity, updated_at: Date.now() });
                if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
                backup(header, floors, newIntegrity);
                await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: hint.avatar_url });
                acknowledgeGenerationFromValueOrPersistTarget(writeReq, messages, hasAiFloor ? hint : null);
                await settleMvuAfterAppend(writeReq, { autoInit: true });
                return response.send({
                    ok: true,
                    appended: floors.length - seed.floors.length,
                    created: true,
                    ...(seed.floors.length ? { greeting_seeded: true } : {}),
                    integrity: newIntegrity,
                });
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

    // -----------------------------------------------------------------------
    // 群聊(TASK-062):群文档 CRUD + 群会话读写。
    //
    //   语义锚点 = 上游 group-chats.js + legacy /api/groups:/api/chats/group/*;
    //   群编排本体仍在 utopinn-generate(groupId 入参 → 纯函数层选员/组卡),
    //   这里只管群文档与群会话文件,不复制任何编排逻辑。
    //
    //   群会话 repo 键:{isGroup:true, groupId:<chatId>} —— chatId 是群聊天
    //   文件名(id 串),与 legacy group/get 同键;群文档 id 与默认 chatId
    //   相同(legacy create 约定)。
    //   楼层写面 ack/settle 机制读 body.id 认群 → writeReq 合成 id=chatId。
    // -----------------------------------------------------------------------

    /**
     * 群文档加载:repo.get(handle, groupId);不存在 → null(调用方回 404)。
     * @param {object} request
     * @param {string} groupId
     * @returns {Promise<object|null>}
     */
    async function loadGroupDoc(request, groupId) {
        try {
            return await getGroupRepo().get(request.user.profile.handle, groupId);
        } catch {
            return null;
        }
    }

    /**
     * 成员表解析(只读读面):avatar → 卡(charDir=头像文件干名) →
     * {avatar,charDir,name,disabled,loadable}。卡缺失成员保留占位
     * (loadable:false) —— 编排层会跳过它,UI 诚实显示不可载。
     */
    async function resolveGroupRoster(request, group) {
        const members = Array.isArray(group?.members) ? group.members : [];
        const disabled = new Set(Array.isArray(group?.disabled_members) ? group.disabled_members : []);
        const roster = [];
        for (const avatar of members) {
            const avatarStr = String(avatar ?? '');
            const charDir = avatarToCharDir(avatarStr);
            const card = charDir ? await loadCharacterDoc(request.user.directories, charDir).catch(() => null) : null;
            roster.push({
                avatar: avatarStr,
                charDir,
                name: String(card?.data?.name ?? card?.name ?? charDir ?? '').trim() || charDir,
                disabled: disabled.has(avatarStr),
                loadable: Boolean(card),
            });
        }
        return roster;
    }

    /**
     * 群新会话问候播种(上游 getGroupChat 空聊分支同义):全部成员各掷一
     * 条问候(含 disabled —— 上游不过滤),带 original_avatar/force_avatar。
     * 失败不阻塞建会话,诚实空。
     */
    async function groupGreetingFloorsForNewChat(request, group, chatName, chatMetadata) {
        try {
            const members = Array.isArray(group?.members) ? group.members : [];
            const roster = [];
            for (const avatar of members) {
                const avatarStr = String(avatar ?? '');
                const charDir = avatarToCharDir(avatarStr);
                if (!charDir) continue;
                const card = await loadCharacterDoc(request.user.directories, charDir).catch(() => null);
                if (!card) continue;
                roster.push({
                    avatar: avatarStr,
                    name: String(card?.data?.name ?? card?.name ?? charDir).trim() || charDir,
                    card,
                });
            }
            const settingsDoc = await getSettingsRepo().get(request.user.profile.handle).catch(() => null);
            const variableWrites = [];
            const floors = buildGroupGreetingFloors({
                roster,
                name1: resolveGreetingName1(request, settingsDoc),
                chatMetadata,
                chatName,
                globalVariables: structuredClone(settingsDoc?.extension_settings?.variables?.global ?? {}),
                variableWrites,
            });
            warnVolatileGreetingWrites(variableWrites, `group:${group?.id ?? '?'}`, chatName);
            return floors;
        } catch (error) {
            console.warn(`group greeting seed skipped for ${group?.id ?? '?'}/${chatName}:`, error?.message ?? error);
            return [];
        }
    }

    const GROUP_CHAT_OPTS = (chatId) => ({ isGroup: true, groupId: chatId });

    /** GET /groups —— 群列表(listWithChatStats,含 chat_size/date_last_chat)。 */
    reg(`${P}/groups`, async function (request, response) {
        try {
            const items = await getGroupRepo().listWithChatStats(request.user.profile.handle);
            return response.send({ items: items ?? [], total: (items ?? []).length });
        } catch (error) {
            return sendError(response, error, 'utopinn/groups list');
        }
    });

    /**
     * POST /groups —— 建群。body 字段与 legacy /api/groups/create 同名同
     * 默认(名/members/activation_strategy/generation_mode/disabled_members
     * /allow_self_responses/join 前后缀/auto_mode_delay/avatar_url/fav);
     * id=chat_id=Date.now() 串,chats=[id]。落盘成功 → 201 回群文档。
     */
    regPost(`${P}/groups`, 'POST', async function (request, response) {
        try {
            const body = request.body ?? {};
            const id = String(Date.now());
            const groupDoc = {
                id,
                name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'New Group',
                members: Array.isArray(body.members) ? body.members.map(String) : [],
                avatar_url: body.avatar_url,
                allow_self_responses: Boolean(body.allow_self_responses),
                activation_strategy: body.activation_strategy ?? 0,
                generation_mode: body.generation_mode ?? 0,
                disabled_members: Array.isArray(body.disabled_members) ? body.disabled_members.map(String) : [],
                fav: body.fav,
                chat_id: body.chat_id ?? id,
                chats: Array.isArray(body.chats) ? body.chats.map(String) : [id],
                auto_mode_delay: body.auto_mode_delay ?? 5,
                generation_mode_join_prefix: body.generation_mode_join_prefix ?? '',
                generation_mode_join_suffix: body.generation_mode_join_suffix ?? '',
            };
            await getGroupRepo().save(request.user.profile.handle, id, groupDoc);
            /* ST 同义:建群即开好默认群会话(chat_id=id —— 群文档先落,
               问候播种要用完整 members 表),否则首开 404 把 SPA 兜底弹走。 */
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const defaultChatId = String(groupDoc.chat_id ?? id);
            if (!(await repo.exists(handle, '', defaultChatId, GROUP_CHAT_OPTS(defaultChatId)))) {
                const headerDoc = { chat_metadata: {} };
                const floors = await groupGreetingFloorsForNewChat(request, groupDoc, defaultChatId, headerDoc.chat_metadata);
                try {
                    await repo.createIfAbsent(handle, '', defaultChatId, headerDoc, floors, GROUP_CHAT_OPTS(defaultChatId));
                    await refreshRecentChatIndexEntry(request, path.join(request.user.directories.groupChats, `${defaultChatId}.jsonl`));
                } catch (err) {
                    if (!(err instanceof ConflictError)) throw err; // 并发已建 → 问候不补,不覆盖
                }
            }
            return response.status(201).send(groupDoc);
        } catch (error) {
            return sendError(response, error, 'utopinn/groups create');
        }
    });

    /** GET /groups/:gid —— 群文档 + roster 解析(启停/可载标记)+ chats 元信息。 */
    reg(`${P}/groups/:gid`, async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const group = await loadGroupDoc(request, groupId);
            if (!group) {
                return response.status(404).send({ error: `Group not found: ${groupId}` });
            }
            const roster = await resolveGroupRoster(request, group);
            const chats = [];
            for (const chatId of Array.isArray(group.chats) ? group.chats : []) {
                const cid = stripJsonlExt(String(chatId));
                const info = await getChatRepo().getInfo(request.user.profile.handle, '', cid, GROUP_CHAT_OPTS(cid)).catch(() => null);
                chats.push({
                    id: cid,
                    messageCount: info?.messageCount ?? 0,
                    lastMessage: info?.lastMessage ?? null,
                    updatedAt: info?.updatedAt ?? null,
                    current: String(group.chat_id ?? '') === cid,
                });
            }
            return response.send({ ...group, roster, chats });
        } catch (error) {
            return sendError(response, error, 'utopinn/groups get');
        }
    });

    /**
     * PATCH /groups/:gid —— 群设置编辑(白名单浅合并):name/members/
     * activation_strategy/generation_mode/disabled_members/allow_self_responses
     * /join 前后缀/auto_mode_delay/chat_id/chats/avatar_url/fav。
     * 编辑即时生效:下次 generate 服务端重新读文档跑编排。
     */
    const PATCHABLE_GROUP_FIELDS = new Set([
        'name', 'members', 'activation_strategy', 'generation_mode', 'disabled_members',
        'allow_self_responses', 'generation_mode_join_prefix', 'generation_mode_join_suffix',
        'auto_mode_delay', 'chat_id', 'chats', 'avatar_url', 'fav',
    ]);
    regPost(`${P}/groups/:gid`, 'PATCH', async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const group = await loadGroupDoc(request, groupId);
            if (!group) {
                return response.status(404).send({ error: `Group not found: ${groupId}` });
            }
            const patch = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
            const rejected = Object.keys(patch).filter((k) => !PATCHABLE_GROUP_FIELDS.has(k));
            if (rejected.length) {
                return response.status(400).send({ error: `Group fields not patchable: ${rejected.join(', ')}` });
            }
            for (const arrKey of ['members', 'disabled_members', 'chats']) {
                if (arrKey in patch && !Array.isArray(patch[arrKey])) {
                    return response.status(400).send({ error: `${arrKey} must be an array` });
                }
            }
            const merged = { ...group };
            for (const [k, v] of Object.entries(patch)) {
                merged[k] = Array.isArray(v) ? v.map(String) : v;
            }
            merged.id = groupId;
            await getGroupRepo().save(request.user.profile.handle, groupId, merged);
            const roster = await resolveGroupRoster(request, merged);
            return response.send({ ...merged, roster });
        } catch (error) {
            return sendError(response, error, 'utopinn/groups patch');
        }
    });

    /** DELETE /groups/:gid —— 删群(级联群聊天文件,repo.delete 语义)。 */
    regPost(`${P}/groups/:gid`, 'DELETE', async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const result = await getGroupRepo().delete(request.user.profile.handle, groupId);
            if (result.chatsDeleted > 0) {
                await invalidateRecentChatIndex(request);
            }
            return response.send({ ok: true });
        } catch (error) {
            return sendError(response, error, 'utopinn/groups delete');
        }
    });

    /**
     * GET /groups/:gid/chats/:chatId —— 群会话(header+messages,展示投影)。
     * 首开空聊 → 成员问候播种(上游 openGroupChat 同义)并回写落盘;
     * 文件在盘但 repo 读不出 → {corrupted:true}。
     */
    reg(`${P}/groups/:gid/chats/:chatId`, async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const chatId = safeName(stripJsonlExt(request.params.chatId), 'chatId');
            const group = await loadGroupDoc(request, groupId);
            if (!group) {
                return response.status(404).send({ error: `Group not found: ${groupId}` });
            }
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            let chat = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId));
            if (!chat) {
                const chatFilePath = path.join(request.user.directories.groupChats, `${chatId}.jsonl`);
                if (fs.existsSync(chatFilePath)) {
                    console.warn(`Group chat file exists but is unreadable (corrupted): ${chatFilePath}`);
                    return response.send({ corrupted: true });
                }
                return response.status(404).send({ error: `Chat not found: ${groupId}/${chatId}` });
            }
            // 首开空聊播种:问候只落一次(body 非空即不再重播)。
            let seeded = false;
            if (!Array.isArray(chat.body) || chat.body.length === 0) {
                const headerDoc = chat.header && typeof chat.header === 'object' ? chat.header : {};
                if (typeof headerDoc.chat_metadata !== 'object' || headerDoc.chat_metadata === null || Array.isArray(headerDoc.chat_metadata)) {
                    headerDoc.chat_metadata = {};
                }
                const floors = await groupGreetingFloorsForNewChat(request, group, chatId, headerDoc.chat_metadata);
                if (floors.length) {
                    // CAS 写:integrity 用空快照的 —— 种子窗口里若有真楼到,
                    // 冲突即弃种重读,不覆盖(PR#18 review)。
                    try {
                        await repo.save(handle, '', chatId, headerDoc, floors, chat?.integrity ?? null, GROUP_CHAT_OPTS(chatId));
                        chat = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId));
                        seeded = true;
                    } catch (err) {
                        if (!(err instanceof ConflictError)) throw err;
                        chat = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId));
                    }
                }
            }
            const messages = await projectChatFloorsForDisplayResponse(request, '', chat, chatId);
            return response.send({
                name: chatId,
                fileName: `${chatId}.jsonl`,
                header: chat?.header ?? {},
                messages,
                integrity: chat?.integrity ?? null,
                updatedAt: chat?.updatedAt ?? null,
                createdAt: chat?.createdAt ?? null,
                ...(seeded ? { greeting_seeded: true } : {}),
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/group-chats get');
        }
    });

    /**
     * POST /groups/:gid/chats/:chatId —— 建群会话(body:{name?} 缺省
     * Date.now 串;成员问候播种;chatId 注册进 group.chats 并把
     * group.chat_id 指到它 —— 上游 openGroupChat 新建即选)。
     */
    regPost(`${P}/groups/:gid/chats/:chatId`, 'POST', async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const chatId = safeName(stripJsonlExt(request.params.chatId), 'chatId');
            const group = await loadGroupDoc(request, groupId);
            if (!group) {
                return response.status(404).send({ error: `Group not found: ${groupId}` });
            }
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            if (await repo.exists(handle, '', chatId, GROUP_CHAT_OPTS(chatId))) {
                return response.status(409).send({ error: `Chat already exists: ${groupId}/${chatId}` });
            }
            const headerDoc = { chat_metadata: {} };
            const floors = await groupGreetingFloorsForNewChat(request, group, chatId, headerDoc.chat_metadata);
            // createIfAbsent:exists→save 的窗口里并发建会静默覆盖(PR#18);
            // 冲突由 sendError 统一映 409「Chat already exists」。
            const { integrity } = await repo.createIfAbsent(handle, '', chatId, headerDoc, floors, GROUP_CHAT_OPTS(chatId));
            const chatFilePath = path.join(request.user.directories.groupChats, `${chatId}.jsonl`);
            await refreshRecentChatIndexEntry(request, chatFilePath);
            // 注册群↔会话绑定(group doc 持有 chats[] + chat_id)。
            const chats = Array.isArray(group.chats) ? group.chats.slice() : [];
            if (!chats.map(String).includes(chatId)) chats.push(chatId);
            await getGroupRepo().save(handle, groupId, { ...group, chats, chat_id: chatId });
            return response.status(201).send({
                ok: true, name: chatId, fileName: `${chatId}.jsonl`, integrity,
                ...(floors.length ? { greeting_seeded: true } : {}),
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/group-chats create');
        }
    });

    /**
     * POST /groups/:gid/chats/:chatId/messages —— 群会话追加(legacy
     * /api/chats/group/append 逐义:appendMessagesToChatFile repo 面双去重
     * +「缺失即建」含成员问候播种 + ack + MVU settle {group:true})。
     * body:{messages[]|message, integrity?, force?, chat_metadata?, luker_generation_id?}
     */
    regPost(`${P}/groups/:gid/chats/:chatId/messages`, 'POST', async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const chatId = safeName(stripJsonlExt(request.params.chatId), 'chatId');
            const group = await loadGroupDoc(request, groupId);
            if (!group) {
                return response.status(404).send({ error: `Group not found: ${groupId}` });
            }
            const handle = request.user.profile.handle;
            const body = request.body ?? {};
            const integritySlug = typeof body.integrity === 'string' ? body.integrity : undefined;
            const force = Boolean(body.force);
            const messages = Array.isArray(body.messages) ? body.messages
                : (body.message && typeof body.message === 'object' ? [body.message] : []);
            if (messages.length === 0) {
                return response.status(400).send({ error: 'No message payload found. Expected body.messages or body.message.' });
            }
            const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${chatId}.jsonl`));
            const repo = getChatRepo();
            const existing = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId));
            let result;
            if (!existing) {
                // 「缺失即建」+ 问候播种(与单聊 append 同语义):先落 header
                // + 问候 + 客户端楼层,再走 appendMessagesToChatFile 的 repo 面
                // 会造成问候丢失,因此直接 repo.save。
                const header = createChatHeader(
                    body.chat_metadata && typeof body.chat_metadata === 'object' && !Array.isArray(body.chat_metadata)
                        ? body.chat_metadata : {});
                const seed = await groupGreetingFloorsForNewChat(request, group, chatId, header.chat_metadata);
                const cleaned = messages.map(m => stripLukerGenerationIdFromMessage(_.cloneDeep(m)))
                    .filter((m) => !(seed.length && isEmptySystemSeedFloor(m)));
                const floors = seed.concat(cleaned);
                // createIfAbsent 原子查+写:并发首写撞车 → 重读后落 append
                // 路径,不再无条件覆盖(PR#18 review)。
                let newIntegrity;
                try {
                    ({ integrity: newIntegrity } = await repo.createIfAbsent(handle, '', chatId, header, floors, GROUP_CHAT_OPTS(chatId)));
                } catch (err) {
                    if (!(err instanceof ConflictError)) throw err;
                    result = await appendMessagesToChatFile({
                        filePath: chatFilePath,
                        messages,
                        chatMetadata: _.isObjectLike(body.chat_metadata) ? body.chat_metadata : {},
                        integritySlug,
                        force,
                        incomingGenerationId: typeof body.luker_generation_id === 'string' ? body.luker_generation_id : '',
                        handle,
                        charDir: '',
                        name: chatId,
                        isGroup: true,
                        groupId: chatId,
                    });
                }
                if (newIntegrity) {
                    writeChatSyncState(chatFilePath, { integrity: newIntegrity, updated_at: Date.now() });
                    if (typeof body.luker_generation_id === 'string' && body.luker_generation_id.trim()) {
                        writeLastChatGenerationId(chatFilePath, body.luker_generation_id.trim());
                    }
                    try {
                        const headerWithIntegrity = { ...header, chat_metadata: applyIntegrityToMetadata(header.chat_metadata, newIntegrity) };
                        getBackupFunction(handle, chatId)(request.user.directories.backups, chatId,
                            [headerWithIntegrity, ...floors].map(m => JSON.stringify(m)).join('\n'));
                    } catch (backupErr) {
                        console.error('Chat backup after group-chat create-append failed', backupErr);
                    }
                    result = { appended: cleaned.length, created: true, integrity: newIntegrity, ...(seed.length ? { greeting_seeded: true } : {}) };
                }
            } else {
                result = await appendMessagesToChatFile({
                    filePath: chatFilePath,
                    messages,
                    chatMetadata: _.isObjectLike(body.chat_metadata) ? body.chat_metadata : {},
                    integritySlug,
                    force,
                    incomingGenerationId: typeof body.luker_generation_id === 'string' ? body.luker_generation_id : '',
                    handle,
                    charDir: '',
                    name: chatId,
                    isGroup: true,
                    groupId: chatId,
                });
                if (result?.appended > 0) {
                    try {
                        const chatDoc = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId));
                        if (chatDoc) {
                            const headerWithIntegrity = {
                                ...(chatDoc.header ?? {}),
                                chat_metadata: applyIntegrityToMetadata(chatDoc.header?.chat_metadata, chatDoc.integrity),
                            };
                            getBackupFunction(handle, chatId)(request.user.directories.backups, chatId,
                                [headerWithIntegrity, ...(chatDoc.body ?? [])].map(m => JSON.stringify(m)).join('\n'));
                        }
                    } catch (backupErr) {
                        console.error('Chat backup after group-chat append failed', backupErr);
                    }
                }
            }
            await refreshRecentChatIndexEntry(request, chatFilePath);
            // ack/settle 认 body.id 为群聊天 id(buildGroupPersistTargetHint 同口径)。
            const writeReq = { ...request, body: { ...body, id: chatId } };
            acknowledgeGenerationFromValueOrPersistTarget(writeReq, messages, { kind: 'group', id: chatId });
            await settleMvuAfterAppend(writeReq, { group: true });
            return response.send({ ok: true, ...result });
        } catch (error) {
            if (error && typeof error === 'object' && 'currentIntegrity' in error && 'expectedIntegrity' in error) {
                console.warn(error.message);
                return response.status(409).send({ error: 'integrity', current_integrity: error.currentIntegrity ?? '' });
            }
            return sendError(response, error, 'utopinn/group-chats append');
        }
    });

    /**
     * PATCH /groups/:gid/chats/:chatId —— JSON-Patch 局部改(与单聊 PATCH
     * 同契约:ops 地址 /body/<i>/…|/header/…,chat_metadata 顶键展开合并,
     * integrity 冲突 → 409 {current_integrity};swipe 切 = /body/<i>/swipe_id)。
     * 写后 ack + resettleMvuAfterWrite({group:true})。
     */
    regPost(`${P}/groups/:gid/chats/:chatId`, 'PATCH', async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const chatId = safeName(stripJsonlExt(request.params.chatId), 'chatId');
            const group = await loadGroupDoc(request, groupId);
            if (!group) {
                return response.status(404).send({ error: `Group not found: ${groupId}` });
            }
            const ops = request.body?.ops;
            if (!Array.isArray(ops) || ops.length === 0) {
                return response.status(400).send({ error: 'Expected body.ops non-empty array' });
            }
            const handle = request.user.profile.handle;
            const body = request.body ?? {};
            const slugRaw = typeof body.integrity === 'string' ? body.integrity.trim() : '';
            const incomingId = typeof body.luker_generation_id === 'string' ? body.luker_generation_id.trim() : '';
            const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${chatId}.jsonl`));
            const repo = getChatRepo();
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
            try { existing = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId)); }
            catch (e) { if (!(e instanceof NotFoundError)) throw e; }
            if (existing == null) {
                return response.status(404).send({ error: `Chat not found: ${groupId}/${chatId}` });
            }
            const lastIdx = Math.max(0, (existing?.body?.length ?? 0) - 1);
            const hitsLast = ops.some(op => typeof op?.path === 'string'
                && (op.path === `/body/${lastIdx}` || op.path.startsWith(`/body/${lastIdx}/`)));

            if (sanitizedOps.length === 0) {
                if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
                const writeReq = { ...request, body: { ...body, id: chatId } };
                acknowledgeGenerationFromValueOrPersistTarget(writeReq, ops, hitsLast ? { kind: 'group', id: chatId } : null);
                return response.send({ ok: true, applied: 0, total_messages: existing?.body?.length ?? 0, integrity: existing?.integrity ?? null });
            }

            if (body.chat_metadata && typeof body.chat_metadata === 'object' && !Array.isArray(body.chat_metadata)) {
                for (const [k, v] of Object.entries(body.chat_metadata)) {
                    sanitizedOps.push({ op: 'add', path: `/header/chat_metadata/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, value: v });
                }
            }

            let result;
            try {
                result = await repo.patch(handle, '', chatId, sanitizedOps, slugRaw || undefined, GROUP_CHAT_OPTS(chatId));
            } catch (err) {
                if (err instanceof ConflictError) return sendRepoIntegrityConflict(response, err);
                if (err instanceof PatchTestFailedError || err instanceof PatchMissingParentError) {
                    const current = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId)).catch(() => null);
                    console.warn(err.message);
                    return response.status(409).send({ error: 'integrity', current_integrity: current?.integrity ?? '' });
                }
                throw err;
            }
            if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
            writeChatSyncState(chatFilePath, { integrity: result.integrity, updated_at: Date.now() });
            const post = await repo.get(handle, '', chatId, GROUP_CHAT_OPTS(chatId)).catch(() => null);
            try {
                const headerWithIntegrity = { ...(post?.header ?? {}), chat_metadata: applyIntegrityToMetadata(post?.header?.chat_metadata, result.integrity) };
                getBackupFunction(handle, chatId)(request.user.directories.backups, chatId,
                    [headerWithIntegrity, ...(post?.body ?? [])].map(m => JSON.stringify(m)).join('\n'));
            } catch (e) { console.error('Chat backup after group-chat patch failed', e); }
            await refreshRecentChatIndexEntry(request, chatFilePath);
            const writeReq = { ...request, body: { ...body, id: chatId } };
            acknowledgeGenerationFromValueOrPersistTarget(writeReq, ops, hitsLast ? { kind: 'group', id: chatId } : null);
            await resettleMvuAfterWrite(writeReq, { group: true });
            return response.send({ ok: true, applied: sanitizedOps.length, total_messages: post?.body?.length ?? null, integrity: result.integrity });
        } catch (error) {
            return sendError(response, error, 'utopinn/group-chats patch');
        }
    });

    /**
     * DELETE /groups/:gid/chats/:chatId —— 删群会话(文件 + 群文档
     * chats[] 解绑;chat_id 指到被删项时回指首个残留会话)。
     */
    regPost(`${P}/groups/:gid/chats/:chatId`, 'DELETE', async function (request, response) {
        try {
            const groupId = safeName(request.params.gid, 'groupId');
            const chatId = safeName(stripJsonlExt(request.params.chatId), 'chatId');
            const group = await loadGroupDoc(request, groupId);
            if (!group) {
                return response.status(404).send({ error: `Group not found: ${groupId}` });
            }
            const handle = request.user.profile.handle;
            const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${chatId}.jsonl`));
            await getChatRepo().delete(handle, '', chatId, GROUP_CHAT_OPTS(chatId));
            await deleteRecentChatIndexEntry(request, chatFilePath);
            await deleteAllChatStateSidecars(chatFilePath);
            const chats = (Array.isArray(group.chats) ? group.chats : []).map(String).filter((c) => c !== chatId);
            const next = { ...group, chats };
            if (String(group.chat_id ?? '') === chatId) next.chat_id = chats[0] ?? '';
            await getGroupRepo().save(handle, groupId, next);
            return response.send({ ok: true });
        } catch (error) {
            return sendError(response, error, 'utopinn/group-chats delete');
        }
    });

    // -----------------------------------------------------------------------
    // 楼层书签与岔出(TASK-065 ST bookmark 语义):
    //   打书签 = 存档点(楼层坐标 + 当时 activeSwipe,不写 swipe 版本语义);
    //   岔出   = 0..messageId 楼层复制成新会话文件,原会话不动(ST branch);
    //   存储   = chat_state 'bookmarks' 侧车(不轮会话 integrity,rename 随迁,
    //            删会话级联;读写经 Repo.setState/getState,双引擎同语义)。
    // -----------------------------------------------------------------------

    /**
     * GET /characters/:charDir/chats/:chatName/bookmarks —— 书签列表。
     * {chat,charDir,floors,items:[{id,messageId,name,ts,swipeId?}],total}
     * floors 随行:客户端据此把越界书签标失效(楼层已被删/截断)。
     */
    reg(`${P}/characters/:charDir/chats/:chatName/bookmarks`, async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const chat = await repo.get(handle, charDir, chatName);
            if (!chat) {
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            const doc = await repo.getState(handle, charDir, chatName, CHAT_BOOKMARKS_NS).catch(() => null);
            const items = normalizeBookmarkDoc(doc);
            return response.send({ chat: chatName, charDir, floors: (chat.body ?? []).length, items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats bookmarks list');
        }
    });

    /**
     * POST /characters/:charDir/chats/:chatName/bookmarks —— 打书签。
     * body:{messageId:int, name?, swipeId?} → 201 {ok,item,items,total}。
     * messageId 是 body 楼号(0 基),越界 → 400;name 缺省 `第N楼`。
     */
    regPost(`${P}/characters/:charDir/chats/:chatName/bookmarks`, 'POST', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const chat = await repo.get(handle, charDir, chatName);
            if (!chat) {
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            const floors = (chat.body ?? []).length;
            // 严格 int —— 不做 Number() 兜底强转(null→0 会偷渡成首楼)
            const messageId = request.body?.messageId;
            if (!Number.isInteger(messageId) || messageId < 0 || messageId >= floors) {
                return response.status(400).send({ error: `messageId must be an integer in [0, ${Math.max(0, floors - 1)}]` });
            }
            const swipeId = request.body?.swipeId;
            const item = {
                id: `bm_${randomUUID().slice(0, 8)}`,
                messageId,
                name: bookmarkName(request.body?.name, messageId),
                ts: Date.now(),
                ...(Number.isInteger(swipeId) && swipeId >= 0 ? { swipeId } : {}),
            };
            const doc = await repo.getState(handle, charDir, chatName, CHAT_BOOKMARKS_NS).catch(() => null);
            const items = normalizeBookmarkDoc(doc);
            items.push(item);
            items.sort((a, b) => a.messageId - b.messageId || a.ts - b.ts);
            await repo.setState(handle, charDir, chatName, CHAT_BOOKMARKS_NS, { items });
            return response.status(201).send({ ok: true, item, items, total: items.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats bookmark create');
        }
    });

    /**
     * DELETE /characters/:charDir/chats/:chatName/bookmarks/:bookmarkId —— 删书签。
     * 204;书签或会话不在 → 404(读-改-写:漏 id 即 404,不整档回写)。
     */
    regPost(`${P}/characters/:charDir/chats/:chatName/bookmarks/:bookmarkId`, 'DELETE', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const bookmarkId = safeName(request.params.bookmarkId, 'bookmarkId');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            if (!await repo.exists(handle, charDir, chatName)) {
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            const doc = await repo.getState(handle, charDir, chatName, CHAT_BOOKMARKS_NS).catch(() => null);
            const items = normalizeBookmarkDoc(doc);
            const next = items.filter((b) => b.id !== bookmarkId);
            if (next.length === items.length) {
                return response.status(404).send({ error: `Bookmark not found: ${bookmarkId}` });
            }
            await repo.setState(handle, charDir, chatName, CHAT_BOOKMARKS_NS, { items: next });
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, error, 'utopinn/chats bookmark delete');
        }
    });

    /**
     * POST /characters/:charDir/chats/:chatName/fork —— 从存档点岔出新会话。
     * body:{messageId:int, name?} → 复制 header + body[0..messageId](含端点,
     * swipe 组/swipe_id/variables 快照原样随楼走 —— 书签记坐标,不与
     * swipe 分叉语义混)成新 chat 文件,命名 `原名·书签名`(sanitize +
     * 128B 预算内截断 + 撞名自动 ·N)。原会话不动。
     * header 深拷贝后剔 chat_metadata.integrity(旧 CAS slug,留着会让
     * 新会话 document-PUT 空手 CAS 撞墙)并记 forked_from 溯源;
     * 书签侧车档过滤 ≤messageId 随迁 —— 其余 state ns(chapters/scene/
     * MVU)是新会话自己的运行态,不随迁。
     * 响应 201:{ok,name,fileName,messageCount,integrity,fork:{from,messageId}}
     */
    regPost(`${P}/characters/:charDir/chats/:chatName/fork`, 'POST', async function (request, response) {
        try {
            const charDir = safeName(request.params.charDir, 'charDir');
            const chatName = safeName(stripJsonlExt(request.params.chatName), 'chatName');
            const handle = request.user.profile.handle;
            const repo = getChatRepo();
            const chat = await repo.get(handle, charDir, chatName);
            if (!chat) {
                return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
            }
            const bodyLen = (chat.body ?? []).length;
            // 严格 int —— 同上,null→0 的强转偷渡会把整段会话岔在首楼
            const messageId = request.body?.messageId;
            if (!Number.isInteger(messageId) || messageId < 0 || messageId >= bodyLen) {
                return response.status(400).send({ error: `messageId must be an integer in [0, ${Math.max(0, bodyLen - 1)}]` });
            }
            // 复合名:`原名·书签名`;书签名 sanitize 空 → 楼层默认名,
            // 整体再过 sanitize(原名也可能带 FS 不允字符)+ 字节截断。
            const tag = sanitize(String(request.body?.name ?? '').trim()).trim() || `第${messageId + 1}楼`;
            const base = clampUtf8(sanitize(`${chatName}·${tag}`).trim() || `${chatName}-fork`, FORK_NAME_MAX_BYTES);
            let newName = null;
            for (let i = 0; i < 100; i++) {
                const candidate = i === 0 ? base : `${base}·${i + 1}`;
                if (!await repo.exists(handle, charDir, candidate)) { newName = candidate; break; }
            }
            if (!newName) {
                return response.status(409).send({ error: `No free fork name under ${charDir} (base: ${base})` });
            }
            const header = _.cloneDeep(chat.header && typeof chat.header === 'object' ? chat.header : {});
            if (header.chat_metadata && typeof header.chat_metadata === 'object' && !Array.isArray(header.chat_metadata)) {
                delete header.chat_metadata.integrity;
                header.chat_metadata.forked_from = { chat: chatName, messageId };
            } else {
                header.chat_metadata = { forked_from: { chat: chatName, messageId } };
            }
            const floors = _.cloneDeep((chat.body ?? []).slice(0, messageId + 1));
            const { integrity } = await repo.save(handle, charDir, newName, header, floors, null);
            const newChatFilePath = path.join(request.user.directories.chats, charDir, `${newName}.jsonl`);
            writeChatSyncState(newChatFilePath, { integrity, updated_at: Date.now() });
            // 书签随迁:坐标 ≤ 岔点者仍是新会话里的有效存档点。
            const doc = await repo.getState(handle, charDir, chatName, CHAT_BOOKMARKS_NS).catch(() => null);
            const carried = normalizeBookmarkDoc(doc).filter((b) => b.messageId <= messageId);
            if (carried.length) {
                await repo.setState(handle, charDir, newName, CHAT_BOOKMARKS_NS, { items: carried })
                    .catch((e) => console.warn(`fork bookmark carry failed for ${charDir}/${newName}:`, e?.message ?? e));
            }
            const avatar = await resolveAvatarFileName(request.user.directories, charDir);
            await refreshRecentChatIndexEntry(request, newChatFilePath, { avatar });
            return response.status(201).send({
                ok: true, name: newName, fileName: `${newName}.jsonl`,
                messageCount: floors.length, integrity,
                fork: { from: chatName, messageId },
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/chats fork');
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
            // 合并读:用户侧车优先,仅共享卡在场回落发布侧车(只读,不写 _library)。
            const data = readCharacterStateMerged(request.user.directories, path.parse(target.avatar).name, namespace);
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

            const data = readCharacterStateMerged(request.user.directories, path.parse(avatarUrl).name, namespace);
            return response.send({ ok: true, data });
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

            const stem = path.parse(avatarUrl).name;
            const data = {};
            for (const ns of normalized) {
                data[ns] = readCharacterStateMerged(request.user.directories, stem, ns);
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

            // 合并存在性:仅共享卡在场也可写 —— 锚点(user dir 同名侧车
            // 路径)恒 per-user,写不落到 _library。
            const characterPath = path.join(request.user.directories.characters, avatarUrl);
            if (!resolveCharacterFileMerged(request.user.directories, path.parse(avatarUrl).name)) {
                return response.status(404).send({ error: 'Character not found.' });
            }
            const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
            if (!stateFilePath) {
                return response.status(400).send({ error: 'Invalid namespace for state sidecar path.' });
            }

            assertWritable();
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

            // 合并存在性 + 合并 seed:共享卡的发布态做 patch 基底,
            // 结果仍写用户目录侧车(per-user 覆盖,不动 _library)。
            const characterPath = path.join(request.user.directories.characters, avatarUrl);
            const stem = path.parse(avatarUrl).name;
            if (!resolveCharacterFileMerged(request.user.directories, stem)) {
                return response.status(404).send({ error: 'Character not found.' });
            }
            const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
            if (!stateFilePath) {
                return response.status(400).send({ error: 'Invalid namespace for state sidecar path.' });
            }

            const existing = readCharacterStateMerged(request.user.directories, stem, namespace);
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

            assertWritable();
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

            assertWritable();
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
