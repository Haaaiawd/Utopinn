/**
 * import-pipeline.js —— TASK-016 刀 1(导入管线)的纯解析/分析层。
 *
 * 无 express、无 storage、无 fs、无 config:吃 {fileName, buffer},
 * 吐 {kind, name, targetName, summary, warnings, prepared};endpoint
 * 只负责 IO、冲突裁决与落库。
 *
 * kind ∈ 'char' | 'world' | 'preset' | 'persona'。
 * prepared 是 commit 所需的全部载荷(commit 不重新探测):
 *   char:    {format:'png'|'json'|'charx'|'byaf', card, imageBuffer,
 *             auxAssets, extractedBuffers, byaf}
 *   world:   {doc}
 *   preset:  {doc}
 *   persona: {doc}
 *
 * 探测失败一律抛 ImportParseError(status=422, hints 描述嗅探到的线索)。
 */
import path from 'node:path';

import sanitize from 'sanitize-filename';

import {
    readCardFromPng,
    isPng,
    unzipEntries,
    CharXParser,
    ByafParser,
    cardData,
    detectSpec,
    getBoundWorldName,
} from '@utopinn/formats';
import { InvalidArgumentError } from '../storage/errors.js';
import { assertSafeRepoName } from '../storage/name-validation.js';
import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';

export const IMPORT_KINDS = Object.freeze(['char', 'world', 'preset', 'persona']);

/** 探测失败:格式不可识别或解析坏了。endpoint 映射成 422。 */
export class ImportParseError extends Error {
    constructor(message, hints = undefined) {
        super(message);
        this.name = 'ImportParseError';
        this.status = 422;
        this.hints = hints;
    }
}

const ZIP_MAGIC_0 = 0x50; // 'P'
const ZIP_MAGIC_1 = 0x4b; // 'K'
const MAX_HINT_KEYS = 12;
const MAX_REGEX_NAMES = 10;

function asU8(buffer) {
    return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function extOf(fileName) {
    const name = String(fileName ?? '').toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
}

function stemOf(fileName) {
    const name = String(fileName ?? '').trim();
    const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}

// ---------------------------------------------------------------------------
// 卡面 summary / warnings
// ---------------------------------------------------------------------------

const CARD_FIELD_ORDER = [
    'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions',
];

/**
 * 结构化卡面清单:regex/CardApp/HTML 面只列不执行(执行是 card-runtime 的事)。
 * @param {object} card 已解析的卡对象(v1 平铺或 v2/v3 spec 包)
 * @param {{imageBuffer: Buffer|Uint8Array|null, format: string, auxAssets?: Array}} meta
 */
function buildCardPreview(card, meta) {
    const data = cardData(card) ?? {};
    const extensions = (data.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions))
        ? data.extensions : {};

    const fields = CARD_FIELD_ORDER.filter((field) => {
        const value = data[field];
        return typeof value === 'string' ? value.length > 0 : value != null;
    });
    if (Array.isArray(data.tags) && data.tags.length > 0) fields.push('tags');

    const book = (data.character_book && typeof data.character_book === 'object' && !Array.isArray(data.character_book))
        ? data.character_book : null;
    const bookEntries = Array.isArray(book?.entries) ? book.entries.length
        : (book?.entries && typeof book.entries === 'object' ? Object.keys(book.entries).length : 0);

    const regexScripts = Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : [];
    const regexScriptNames = regexScripts
        .map((script) => script?.scriptName || script?.id || null)
        .filter(Boolean)
        .slice(0, MAX_REGEX_NAMES);

    const depthPrompt = (extensions.depth_prompt && typeof extensions.depth_prompt === 'object' && !Array.isArray(extensions.depth_prompt))
        ? {
            promptLength: typeof extensions.depth_prompt.prompt === 'string' ? extensions.depth_prompt.prompt.length : 0,
            depth: extensions.depth_prompt.depth ?? null,
            role: extensions.depth_prompt.role ?? null,
        }
        : null;

    const cardAppFiles = (extensions.card_app?.files && typeof extensions.card_app.files === 'object' && !Array.isArray(extensions.card_app.files))
        ? Object.keys(extensions.card_app.files).length : 0;

    const summary = {
        name: typeof data.name === 'string' ? data.name : (typeof card?.name === 'string' ? card.name : ''),
        spec: detectSpec(card),
        fields,
        bookEntries,
        regexScripts: regexScripts.length,
        regexScriptNames,
        depthPrompt,
        firstGreetingLen: typeof data.first_mes === 'string' ? data.first_mes.length : 0,
        alternateGreetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.length : 0,
        cardAppFiles,
        boundWorld: getBoundWorldName(card),
        tags: Array.isArray(data.tags) ? data.tags : [],
        creator: typeof data.creator === 'string' ? data.creator : '',
        avatar: meta.imageBuffer ? 'bundled' : 'none',
        sourceFormat: meta.format,
    };

    const warnings = [];
    if (!summary.name) {
        warnings.push('Card has no name; a fallback name will be used on commit.');
    }
    if (summary.spec === 'chara_card_v1') {
        warnings.push('V1 card: will be upgraded to chara_card_v2 storage on commit.');
    }
    if (regexScripts.length > 0) {
        warnings.push(`${regexScripts.length} regex script(s) embedded — listed for review, never executed by import.`);
    }
    if (cardAppFiles > 0) {
        warnings.push(`${cardAppFiles} CardApp file(s) will be extracted to card-apps storage on commit.`);
    }
    if (!meta.imageBuffer) {
        warnings.push('No card image available; the default avatar will be used on commit.');
    }
    if (bookEntries > 0) {
        warnings.push(`Embedded character_book with ${bookEntries} entr${bookEntries === 1 ? 'y' : 'ies'} travels with the card.`);
    }
    if (Array.isArray(meta.auxAssets) && meta.auxAssets.length > 0) {
        const counts = { sprite: 0, background: 0, misc: 0 };
        for (const asset of meta.auxAssets) counts[asset?.storageCategory] = (counts[asset?.storageCategory] ?? 0) + 1;
        warnings.push(
            `Bundled CharX assets: ${counts.sprite} sprite(s), ${counts.background} background(s), ${counts.misc} misc — written alongside the card on commit.`,
        );
    }
    return { summary, warnings };
}

// ---------------------------------------------------------------------------
// 各格式探测
// ---------------------------------------------------------------------------

function detectPngCard(u8) {
    let raw;
    try {
        raw = readCardFromPng(u8);
    } catch (error) {
        throw new ImportParseError(`PNG image carries no readable card chunk: ${error.message}`, {
            container: 'png',
            hint: 'Expected a tEXt/zTXt/iTXt chunk with keyword "chara" or "ccv3".',
        });
    }
    let card;
    try {
        card = JSON.parse(raw);
    } catch (error) {
        throw new ImportParseError(`PNG card chunk is not valid JSON: ${error.message}`, { container: 'png' });
    }
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
        throw new ImportParseError('PNG card chunk is not a JSON object', { container: 'png' });
    }
    return { format: 'png', card, imageBuffer: u8 };
}

function detectZip(u8, ext) {
    let entries;
    try {
        entries = unzipEntries(u8);
    } catch (error) {
        throw new ImportParseError(`ZIP container is not readable: ${error.message}`, { container: 'zip' });
    }
    const hasCardJson = entries.has('card.json');
    const hasManifest = entries.has('manifest.json');
    const names = [...entries.keys()].slice(0, MAX_HINT_KEYS);

    const tryOrder = ext === '.byaf' ? ['byaf', 'charx'] : ['charx', 'byaf'];
    const attempts = {
        charx: hasCardJson,
        byaf: hasManifest,
    };
    for (const which of tryOrder) {
        if (!attempts[which]) continue;
        try {
            if (which === 'charx') {
                const parsed = new CharXParser(u8).parse();
                return {
                    format: 'charx',
                    card: parsed.card,
                    imageBuffer: parsed.avatar,
                    auxAssets: parsed.auxiliaryAssets,
                    extractedBuffers: parsed.extractedBuffers,
                };
            }
            const parsed = new ByafParser(u8).parse();
            return {
                format: 'byaf',
                card: parsed.card,
                imageBuffer: parsed.images?.[0]?.image ?? null,
                byaf: {
                    images: parsed.images?.length ?? 0,
                    scenarios: parsed.scenarios?.length ?? 0,
                    chatBackgrounds: parsed.chatBackgrounds?.length ?? 0,
                    displayName: typeof parsed.character?.displayName === 'string' ? parsed.character.displayName : '',
                },
            };
        } catch (error) {
            throw new ImportParseError(`${which === 'charx' ? 'CharX' : 'BYAF'} payload failed to parse: ${error.message}`, {
                container: 'zip', zipEntries: names,
            });
        }
    }
    throw new ImportParseError('ZIP archive is neither CharX (card.json) nor BYAF (manifest.json)', {
        container: 'zip',
        zipEntries: names,
        hint: 'CharX needs card.json at zip root; BYAF needs manifest.json at zip root.',
    });
}

function isPlainObject(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** v1/gradio 平铺卡特征:name + 任一卡面专属字段(刻意不含 description —— 留给 persona)。 */
function looksLikeCardV1(obj) {
    if (typeof obj.char_name === 'string' && obj.char_name) {
        return true; // Pygmalion notepad 形
    }
    if (typeof obj.name !== 'string' || !obj.name) {
        return false;
    }
    const cardOnlyFields = [
        'first_mes', 'mes_example', 'personality', 'scenario', 'creatorcomment',
        'talkativeness', 'system_prompt', 'post_history_instructions', 'avatar',
        'character_book', 'alternate_greetings',
    ];
    if (cardOnlyFields.some((field) => field in obj)) {
        return true;
    }
    // 缺 spec 的 v2/v3 残件:{data:{name|description|first_mes...}}
    return isPlainObject(obj.data)
        && ['name', 'description', 'first_mes', 'personality', 'scenario'].some((field) => field in obj.data);
}

function sniffJsonDocument(obj, fileName) {
    // 世界书:{entries:{uid:entry}} —— 先于卡判(卡不会有顶层 entries)
    if (isPlainObject(obj.entries)) {
        const entryCount = Object.keys(obj.entries).length;
        const name = typeof obj.name === 'string' && obj.name ? obj.name : stemOf(fileName);
        return {
            kind: 'world',
            name,
            targetName: name,
            summary: { name, entries: entryCount },
            warnings: entryCount === 0 ? ['World book contains 0 entries.'] : [],
            prepared: { doc: obj },
        };
    }
    // 预设:OpenAI 系 settings 文件带 prompts 数组
    if (Array.isArray(obj.prompts)) {
        const name = typeof obj.name === 'string' && obj.name ? obj.name : stemOf(fileName);
        return {
            kind: 'preset',
            name,
            targetName: name,
            summary: {
                name,
                apiId: 'openai',
                prompts: obj.prompts.length,
                keys: Object.keys(obj).length,
            },
            warnings: obj.prompts.length === 0 ? ['Preset contains an empty prompts array.'] : [],
            prepared: { doc: obj },
        };
    }
    // 卡:spec 字段 / v1 平铺 / gradio char_name
    if ((typeof obj.spec === 'string' && obj.spec.startsWith('chara_card')) || looksLikeCardV1(obj)) {
        const { summary, warnings } = buildCardPreview(obj, { imageBuffer: null, format: 'json' });
        const name = summary.name || stemOf(fileName);
        return {
            kind: 'char', name,
            targetName: name,
            summary, warnings,
            prepared: { format: 'json', card: obj, imageBuffer: null },
        };
    }
    // persona:{name?, description, position?, title?, avatar?}
    if (typeof obj.description === 'string'
        && (typeof obj.name === 'string' || 'position' in obj || 'title' in obj || 'avatar' in obj)) {
        const name = typeof obj.name === 'string' && obj.name ? obj.name : stemOf(fileName);
        const warnings = [];
        if (!obj.description) warnings.push('Persona description is empty.');
        return {
            kind: 'persona',
            name,
            targetName: name,
            summary: {
                name,
                descriptionLen: obj.description.length,
                position: obj.position ?? null,
                title: typeof obj.title === 'string' ? obj.title : '',
                avatar: typeof obj.avatar === 'string' ? obj.avatar : null,
            },
            warnings,
            prepared: { doc: obj },
        };
    }
    return null;
}

/**
 * 探测导入载荷 → {kind, name, targetName, summary, warnings, prepared}。
 * @param {{fileName?: string, buffer: Buffer|Uint8Array}} input
 */
export function detectImportPayload({ fileName, buffer } = {}) {
    const u8 = asU8(buffer ?? new Uint8Array(0));
    const ext = extOf(fileName);
    if (u8.length === 0) {
        throw new ImportParseError('Empty import payload', { fileName: fileName ?? null });
    }

    if (isPng(u8)) {
        const { format, card, imageBuffer } = detectPngCard(u8);
        const { summary, warnings } = buildCardPreview(card, { imageBuffer, format });
        const name = summary.name || stemOf(fileName);
        return {
            kind: 'char', name, targetName: name,
            summary, warnings,
            prepared: { format, card, imageBuffer },
        };
    }

    if (u8[0] === ZIP_MAGIC_0 && u8[1] === ZIP_MAGIC_1) {
        const found = detectZip(u8, ext);
        const { summary, warnings } = buildCardPreview(found.card, found);
        if (found.format === 'byaf' && found.byaf) {
            const { images, scenarios, chatBackgrounds } = found.byaf;
            if (images > 1) warnings.push(`${images - 1} extra BYAF image(s) not persisted in this slice (first image becomes the avatar).`);
            if (chatBackgrounds > 0) warnings.push(`${chatBackgrounds} BYAF chat background(s) not persisted in this slice.`);
            if (scenarios > 1) warnings.push(`${scenarios} BYAF scenarios folded into the card (first + alternate greetings).`);
        }
        const displayName = found.byaf?.displayName;
        const name = summary.name || displayName || stemOf(fileName);
        return {
            kind: 'char', name, targetName: name,
            summary, warnings,
            prepared: found,
        };
    }

    // 文本面:仅 JSON 一种(.yaml 卡暂不纳入本刀)
    let obj;
    try {
        obj = JSON.parse(new TextDecoder().decode(u8));
    } catch {
        throw new ImportParseError('Unrecognized import payload (not PNG, ZIP, or JSON)', {
            fileName: fileName ?? null,
            extension: ext || null,
            firstBytes: [...u8.slice(0, 8)],
            hint: 'Supported: PNG card (chara/ccv3 chunk), .charx, .byaf, JSON card/worldbook/preset/persona.',
        });
    }
    if (!isPlainObject(obj)) {
        throw new ImportParseError('JSON document is not an object', { topLevelType: Array.isArray(obj) ? 'array' : typeof obj });
    }
    const sniffed = sniffJsonDocument(obj, fileName);
    if (sniffed) {
        return sniffed;
    }
    throw new ImportParseError('JSON document does not look like a card, worldbook, preset, or persona', {
        topLevelKeys: Object.keys(obj).slice(0, MAX_HINT_KEYS),
        spec: typeof obj.spec === 'string' ? obj.spec : null,
        hint: 'Card needs spec="chara_card_*" or v1 fields; worldbook needs an "entries" object; preset needs a "prompts" array; persona needs a "description" string.',
    });
}

// ---------------------------------------------------------------------------
// 名称 → 存储目标的纯推导(存在性检查在 endpoint,因为要碰 fs/Repo)
// ---------------------------------------------------------------------------

/** 文件名尾缀剥离:客户端把上传文件名当 name 传时去掉已知容器扩展名。 */
export function stripImportExt(name) {
    return String(name ?? '').trim().replace(/\.(png|webp|json|jsonl|charx|byaf)$/i, '');
}

/**
 * 卡的目标文件干名:sanitize-filename 收口(对齐 importFromPng 的
 * `jsonData.name = sanitize(...)`);空回落 'Unnamed'。
 */
export function charTargetStem(requestedName, detectedName) {
    const raw = stripImportExt(requestedName) || stripImportExt(detectedName);
    return sanitize(raw) || 'Unnamed';
}

/** repo 型资源名:剥扩展名 + 形状/长度边界(world/preset 走 Repo 层)。 */
export function repoTargetName(requestedName, detectedName) {
    return assertSafeRepoName(stripImportExt(requestedName) || stripImportExt(detectedName), { field: 'name' });
}

/** persona 落点其实是 avatar 键(personas/persona_descriptions 以头像文件名为键)。 */
export function personaAvatarKey(doc, displayName) {
    const raw = typeof doc?.avatar === 'string' && doc.avatar
        ? path.basename(doc.avatar)
        : `${displayName}.png`;
    const parsed = path.parse(raw);
    const stem = sanitize(parsed.name) || 'persona';
    const ext = parsed.ext ? sanitize(parsed.ext) : '.png';
    return `${stem}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

export function presetApiId(raw) {
    const apiId = String(raw ?? 'openai').trim() || 'openai';
    if (!Object.prototype.hasOwnProperty.call(PRESET_FOLDER_BY_API_ID, apiId)) {
        throw new InvalidArgumentError(
            `apiId must be one of: ${Object.keys(PRESET_FOLDER_BY_API_ID).join(', ')}`,
        );
    }
    return apiId;
}

// ---------------------------------------------------------------------------
// commit 前的卡面纯数据整形(无 IO;写盘在 endpoint)
// ---------------------------------------------------------------------------

/**
 * 镜像 importFromPng/importFromJson 的卡面整形:
 * name 走 sanitize 语义的调用方已先处理,这里做内部字段清理——
 * 摘掉私有/运行时字段、盖 create_date、保证 data/extensions 存在。
 * normalizeCharacterCardForStorage(v1→v2、legacy root→data 归并)由
 * writeCharacterData 在写盘前统一做,这里不重复。
 * @param {object} card
 * @param {{preservedChat?: string|null}} options overwrite 同名片时从旧卡继承的 chat 指针
 */
export function prepareCardForStorage(card, { preservedChat = null } = {}) {
    if (!isPlainObject(card)) {
        throw new ImportParseError('Card payload is not an object');
    }
    delete card.fav;
    delete card.chat;
    const data = isPlainObject(card.data) ? card.data : (card.data = {});
    const extensions = isPlainObject(data.extensions) ? data.extensions : (data.extensions = {});
    extensions.fav = false;
    card.create_date = new Date().toISOString();
    if (typeof preservedChat === 'string' && preservedChat) {
        card.chat = preservedChat;
    }
    return card;
}
