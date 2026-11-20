/**
 * utopinn-regex —— 正则脚本三层存储的 REST 面(§C-7 补件)。
 *
 * 存储模型(调研:services/extension-prompts.js:9-11 + legacy
 * public/scripts/extensions/regex/engine.js getScriptsByType/saveScriptsByType):
 *
 *   scope   持久层                                          运行时放行
 *   ──────  ─────────────────────────────────────────────   ─────────────────────────────────────
 *   global  settings.json → extension_settings.regex        恒活(disabledExtensions 含 'regex' 时全灭)
 *   char    characters/<dir>.png tEXt / .json 卡            extension_settings.character_allowed_regex
 *           → card.data.extensions.regex_scripts            含 avatar 文件名(如 "X.png")
 *   preset  <apiId Settings>/<name>.json                    extension_settings.preset_allowed_regex
 *           → doc.extensions.regex_scripts                  [apiId] 含预设名
 *
 *   UI 集(extension_settings.regex_presets,导入导出桶)与
 *   regex_perf_detection/regex_section_collapsed 是前端编辑器态,本面不管。
 *
 *   GET    /api/utopinn/regex                     全量视图 {global,allowed,disabled,chars,presets}
 *   GET    /api/utopinn/regex?scope=global        {scope,scripts}
 *   GET    /api/utopinn/regex?scope=char&char=d   {scope,charDir,avatar,name,allowed,scripts}
 *   GET    /api/utopinn/regex?scope=preset&apiId=a&preset=n
 *   PUT    /api/utopinn/regex                     {scope,…,scripts? 整组替换,allow? 放行开关}
 *   PATCH  /api/utopinn/regex/:id                 {scope,…,set:{字段补丁}}——按 id 精确命中,
 *                                                  否则 :id 为非负整数时按数组下标兜底
 *   DELETE /api/utopinn/regex/:id                 scope 走 query 或 body,按 id/下标删一条
 *
 * 并发:settings/preset 走 Repo.patch(单 tx 读改写,per-handle 串行;
 * 单条改写用 test-op CAS,撞车 → 409)。卡写是 tx 外的文件操作——
 * 插件内 keyed tail 互斥(handle+文件路径),读改写不交错。
 * 字段契约:RegexScriptData(id/scriptName/findRegex/replaceString/trimStrings/
 * placement/disabled/markdownOnly/promptOnly/runOnEdit/substituteRegex/
 * minDepth/maxDepth/pluginLanes/allowSlow)——读写 spread 保活未知字段。
 */
import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { regexFromString } from '@utopinn/core';

import { read as readCharacterCard } from '../character-card-parser.js';
import { writeCharacterData } from '../endpoints/characters.js';
import { getPresetRepo, getSettingsRepo } from '../storage/index.js';
import { assertWritable } from '../storage/read-only-mode.js';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { safeName, sendError } from './_shared/http-utils.js';

export const inject = ['webServer'];

const P = '/api/utopinn/regex';

/** regex 放行生效的 preset 域 = LLM 预设族(engine.js getCurrentPresetAPI 语义)。 */
const REGEX_PRESET_API_IDS = Object.freeze(['openai', 'textgenerationwebui', 'novel', 'kobold', 'koboldhorde']);
/** PATCH set 补丁禁写字段(防 __proto__ 类键)。 */
const FORBIDDEN_PATCH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SCRIPTS = 500;
const MAX_FIND_REGEX_LEN = 64 * 1024;

// ---------------------------------------------------------------------------
// 校验:脚本必须是 plain object;findRegex 非空时须按 regexFromString 编译通过
// (与运行面同一编译路径,/pat/flags 或裸 pattern 都收),坏正则 400 不落盘。
// ---------------------------------------------------------------------------

/**
 * @param {unknown} script
 * @param {number|string} where 报错定位(数组下标)
 * @returns {string|null} 非法原因;合法返回 null
 */
function validateRegexScript(script, where) {
    if (!script || typeof script !== 'object' || Array.isArray(script)) {
        return `scripts[${where}] must be a plain object`;
    }
    if (script.scriptName !== undefined && typeof script.scriptName !== 'string') {
        return `scripts[${where}].scriptName must be a string`;
    }
    if (script.findRegex !== undefined) {
        if (typeof script.findRegex !== 'string') {
            return `scripts[${where}].findRegex must be a string`;
        }
        if (script.findRegex.length > MAX_FIND_REGEX_LEN) {
            return `scripts[${where}].findRegex exceeds ${MAX_FIND_REGEX_LEN} chars`;
        }
        if (script.findRegex && !regexFromString(script.findRegex)) {
            // regexFromString 不吐原因——new RegExp 探一次拿 SyntaxError 文本
            let reason = 'does not compile';
            try { new RegExp(script.findRegex); } catch (e) { reason = e?.message ?? reason; }
            const label = script.scriptName ? ` "${script.scriptName}"` : '';
            return `scripts[${where}]${label} findRegex ${reason}`;
        }
    }
    if (script.placement !== undefined
        && (!Array.isArray(script.placement) || script.placement.some((x) => !Number.isFinite(x)))) {
        return `scripts[${where}].placement must be an array of numbers`;
    }
    if (script.trimStrings !== undefined
        && (!Array.isArray(script.trimStrings) || script.trimStrings.some((x) => typeof x !== 'string'))) {
        return `scripts[${where}].trimStrings must be an array of strings`;
    }
    // minDepth/maxDepth 的 null 是 ST 合法值(=无界,engine.js:936-942 语义)。
    for (const f of ['minDepth', 'maxDepth']) {
        if (script[f] !== undefined && script[f] !== null && !Number.isFinite(script[f])) {
            return `scripts[${where}].${f} must be a number or null`;
        }
    }
    if (script.substituteRegex !== undefined && !Number.isFinite(script.substituteRegex)) {
        return `scripts[${where}].substituteRegex must be a number`;
    }
    for (const f of ['disabled', 'markdownOnly', 'promptOnly', 'runOnEdit']) {
        if (script[f] !== undefined && typeof script[f] !== 'boolean') {
            return `scripts[${where}].${f} must be a boolean`;
        }
    }
    return null;
}

/**
 * @param {unknown} scripts
 * @returns {string|null} 首个非法原因;全合法返回 null
 */
function validateScriptArray(scripts) {
    if (!Array.isArray(scripts)) return 'scripts must be an array';
    if (scripts.length > MAX_SCRIPTS) return `scripts exceeds ${MAX_SCRIPTS} entries`;
    for (let i = 0; i < scripts.length; i++) {
        const err = validateRegexScript(scripts[i], i);
        if (err) return err;
    }
    return null;
}

/** 从请求(query+body 合并)解 scope。charDir/preset 名过 safeName。 */
function resolveScope(request) {
    const src = { ...(request.query ?? {}), ...(request.body ?? {}) };
    const scope = String(src.scope ?? 'global').trim().toLowerCase();
    if (scope === 'global') return { scope: 'global' };
    if (scope === 'char' || scope === 'scoped') {
        return { scope: 'char', charDir: safeName(src.char ?? src.charDir, 'char') };
    }
    if (scope === 'preset') {
        const apiId = String(src.apiId ?? src.api ?? 'openai').trim();
        if (!REGEX_PRESET_API_IDS.includes(apiId)) {
            throw new InvalidArgumentError(`apiId must be one of ${REGEX_PRESET_API_IDS.join('|')}, got "${apiId}"`);
        }
        return { scope: 'preset', apiId, name: safeName(src.preset ?? src.name, 'preset') };
    }
    throw new InvalidArgumentError(`scope must be global|char|preset, got "${scope}"`);
}

/** 从卡对象取生效 regex 数组:V2 canonical 槽 data.extensions 优先,根 extensions 兜底。 */
function cardRegexScripts(card) {
    const scoped = card?.data?.extensions?.regex_scripts;
    if (Array.isArray(scoped)) return scoped;
    const legacy = card?.extensions?.regex_scripts;
    return Array.isArray(legacy) ? legacy : [];
}

/**
 * 把新脚本组写进卡 canonical 槽(data.extensions.regex_scripts),顺带摘掉
 * 根 extensions 旧槽位——toStoredV2Character 写盘时会把根 extensions merge 进
 * data.extensions,两边都留会互相覆盖。
 */
function setCardRegexScripts(card, scripts) {
    if (!card.data || typeof card.data !== 'object' || Array.isArray(card.data)) card.data = {};
    if (!card.data.extensions || typeof card.data.extensions !== 'object' || Array.isArray(card.data.extensions)) {
        card.data.extensions = {};
    }
    card.data.extensions.regex_scripts = scripts;
    if (card.extensions && typeof card.extensions === 'object' && 'regex_scripts' in card.extensions) {
        delete card.extensions.regex_scripts;
    }
}

/**
 * 按 :id 定位脚本:先精确匹配 script.id;未命中且 :id 是非负整数时下标兜底
 * (老卡可能存在无 id 的历史脚本,只能靠下标定位)。
 * @returns {{index:number, script:object}|null}
 */
function findScript(scripts, id) {
    const byId = scripts.findIndex((s) => s && s.id !== undefined && String(s.id) === id);
    if (byId >= 0) return { index: byId, script: scripts[byId] };
    if (/^\d+$/.test(id)) {
        const i = Number(id);
        if (i < scripts.length && scripts[i] && typeof scripts[i] === 'object') {
            return { index: i, script: scripts[i] };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// settings/preset 写:Repo.patch 单 tx(test-op CAS 防并发丢写,撞车 → 409)
// ---------------------------------------------------------------------------

/** PATCH/DELETE 通用:CAS 替换数组。old 必须与盘上 deep-equal,否则 PatchTestFailed → 409。 */
function casReplaceOps(path, oldValue, newValue) {
    return [
        { op: 'test', path, value: oldValue },
        { op: 'replace', path, value: newValue },
    ];
}

/** PUT 全局组:add 对已有 member = set(缺省/在场两用);extension_settings 缺失先补父。 */
function putGlobalOps(settingsDoc, scripts) {
    const ops = [];
    const ext = settingsDoc?.extension_settings;
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
        ops.push({ op: 'add', path: '/extension_settings', value: {} });
    }
    ops.push({ op: 'add', path: '/extension_settings/regex', value: scripts });
    return ops;
}

/** PUT preset 组:/extensions 缺失先补父。 */
function putPresetOps(presetDoc, scripts) {
    const ops = [];
    const ext = presetDoc?.extensions;
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
        ops.push({ op: 'add', path: '/extensions', value: {} });
    }
    ops.push({ op: 'add', path: '/extensions/regex_scripts', value: scripts });
    return ops;
}

/**
 * 放行表更新(char/preset)。字段缺省 → add;在场 → test+replace CAS。
 * @returns {Promise<void>}
 */
async function patchAllowlist(handle, scope, { avatar, apiId, presetName, allow }) {
    const repo = getSettingsRepo();
    const settings = (await repo.get(handle)) ?? {};
    const ext = (settings.extension_settings && typeof settings.extension_settings === 'object')
        ? settings.extension_settings : {};
    const ops = [];
    if (!settings.extension_settings || typeof settings.extension_settings !== 'object') {
        ops.push({ op: 'add', path: '/extension_settings', value: {} });
    }
    if (scope === 'char') {
        const cur = Array.isArray(ext.character_allowed_regex) ? ext.character_allowed_regex : undefined;
        const list = cur ?? [];
        const next = allow
            ? [...new Set([...list, avatar])]
            : list.filter((a) => a !== avatar);
        if (cur === undefined) {
            ops.push({ op: 'add', path: '/extension_settings/character_allowed_regex', value: next });
        } else {
            ops.push(...casReplaceOps('/extension_settings/character_allowed_regex', cur, next));
        }
    } else {
        const cur = (ext.preset_allowed_regex && typeof ext.preset_allowed_regex === 'object' && !Array.isArray(ext.preset_allowed_regex))
            ? ext.preset_allowed_regex : undefined;
        const table = structuredClone(cur ?? {});
        const list = Array.isArray(table[apiId]) ? table[apiId] : [];
        table[apiId] = allow
            ? [...new Set([...list, presetName])]
            : list.filter((n) => n !== presetName);
        if (cur === undefined) {
            ops.push({ op: 'add', path: '/extension_settings/preset_allowed_regex', value: table });
        } else {
            ops.push(...casReplaceOps('/extension_settings/preset_allowed_regex', cur, table));
        }
    }
    await repo.patch(handle, ops);
}

// ---------------------------------------------------------------------------
// char 卡写:keyed tail 互斥(tx 外的文件写,读改写串行化)
// ---------------------------------------------------------------------------

const _cardWriteTails = new Map(); // `${handle}:${absPath}` → Promise(写完自清)

function withCardWriteLock(key, fn) {
    const prev = _cardWriteTails.get(key) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {}); // 吞尾链 rejection,不毒化下一个
    tail.finally(() => {
        if (_cardWriteTails.get(key) === tail) _cardWriteTails.delete(key);
    });
    _cardWriteTails.set(key, tail);
    return run;
}

/** 探测 <charDir>.<png|webp|json> 在场文件,返回 {file,ext} 或 null。 */
function resolveCharFile(directories, charDir) {
    for (const ext of ['.png', '.webp', '.json']) {
        const file = path.join(directories.characters, `${charDir}${ext}`);
        if (fs.existsSync(file)) return { file, ext };
    }
    return null;
}

async function resolveAvatarFileName(directories, charDir) {
    for (const ext of ['.png', '.webp']) {
        try {
            await fs.promises.access(path.join(directories.characters, `${charDir}${ext}`));
            return `${charDir}${ext}`;
        } catch { /* 下一个扩展名 */ }
    }
    if (fs.existsSync(path.join(directories.characters, `${charDir}.json`))) return `${charDir}.json`;
    return `${charDir}.png`;
}

/** 读一张卡(png/webp 走卡解析,json 直读)。返回解析后对象或 null。 */
async function loadRegexCard(directories, charDir) {
    const dir = directories.characters;
    for (const ext of ['.png', '.webp']) {
        try {
            const raw = await fs.promises.readFile(path.join(dir, `${charDir}${ext}`));
            return { card: JSON.parse(readCharacterCard(raw)), ext, file: path.join(dir, `${charDir}${ext}`) };
        } catch { /* 无此文件或不含卡数据 → 下一个 */ }
    }
    try {
        const file = path.join(dir, `${charDir}.json`);
        const raw = await fs.promises.readFile(file, 'utf8');
        return { card: JSON.parse(raw), ext: '.json', file };
    } catch {
        return null;
    }
}

/**
 * char 域读改写:.png 走 writeCharacterData(jimp 重编码 + 原子写 + 缓存失效,
 * legacy merge-attributes 同路径);.json 原子写 JSON;.webp 不支持写(legacy
 * merge-attributes 同样拒非 png —— 400)。
 * @param {(oldScripts:object[])=>object[]} mutator 旧数组 → 新数组(抛错即不写)
 */
async function mutateCharScripts(request, charDir, mutator) {
    const directories = request.user.directories;
    const target = resolveCharFile(directories, charDir);
    if (!target) throw new NotFoundError('character card', { charDir });
    if (target.ext === '.webp') {
        throw new InvalidArgumentError(`scoped regex write supports .png/.json cards only: ${charDir}.webp`);
    }
    const lockKey = `${request.user.profile.handle}:${target.file}`;
    return withCardWriteLock(lockKey, async () => {
        const loaded = await loadRegexCard(directories, charDir);
        if (!loaded) throw new NotFoundError('character card', { charDir });
        const old = cardRegexScripts(loaded.card);
        const next = mutator(old);
        setCardRegexScripts(loaded.card, next);
        // v1 .png(spec 缺失):先盖章走 toStoredV2Character 升格;
        // 否则 normalizeCharacterCardForStorage 走 convertToV2 表单路径,
        // 把 extensions.world/system_prompt 等非表单字段清零(同 library PATCH)。
        if (loaded.card.spec === undefined) {
            loaded.card.spec = 'chara_card_v2';
            loaded.card.spec_version = '2.0';
        }
        assertWritable();
        if (loaded.ext === '.png') {
            const ok = await writeCharacterData(
                loaded.file, JSON.stringify(loaded.card), charDir, request, undefined,
                { allowMissingInputFallback: false, requireExistingOutput: true },
            );
            if (!ok) {
                throw new Error(request.lastWriteCharacterDataError ?? 'character card write failed');
            }
        } else {
            writeFileAtomicSync(loaded.file, JSON.stringify(loaded.card, null, 2), 'utf8');
        }
        return next;
    });
}

// ---------------------------------------------------------------------------
// 读面
// ---------------------------------------------------------------------------

async function readGlobalView(handle) {
    const settings = (await getSettingsRepo().get(handle)) ?? {};
    const ext = (settings.extension_settings && typeof settings.extension_settings === 'object')
        ? settings.extension_settings : {};
    return {
        scripts: Array.isArray(ext.regex) ? ext.regex : [],
        allowedChars: Array.isArray(ext.character_allowed_regex) ? ext.character_allowed_regex : [],
        allowedPresets: (ext.preset_allowed_regex && typeof ext.preset_allowed_regex === 'object' && !Array.isArray(ext.preset_allowed_regex))
            ? ext.preset_allowed_regex : {},
        disabled: Array.isArray(ext.disabledExtensions) ? ext.disabledExtensions : [],
    };
}

async function scopedCharView(request, charDir) {
    const loaded = await loadRegexCard(request.user.directories, charDir);
    if (!loaded) return null;
    const avatar = await resolveAvatarFileName(request.user.directories, charDir);
    const data = (loaded.card?.data && typeof loaded.card.data === 'object') ? loaded.card.data : loaded.card ?? {};
    return {
        file: loaded.file,
        avatar,
        name: typeof data.name === 'string' && data.name ? data.name : charDir,
        scripts: cardRegexScripts(loaded.card),
    };
}

/** 全量视图:global + 有脚本/被放行的卡 + 有脚本/被放行的 LLM 预设。 */
async function fullView(request) {
    const handle = request.user.profile.handle;
    const g = await readGlobalView(handle);

    // 卡枚举:按 charDir 归组(png > webp > json),只列有脚本或被放行的。
    const chars = [];
    const stems = new Set();
    let files = [];
    try { files = await fs.promises.readdir(request.user.directories.characters, { withFileTypes: true }); } catch { /* 空库 */ }
    for (const f of files) {
        if (!f.isFile()) continue;
        const ext = path.extname(f.name).toLowerCase();
        if (!['.png', '.webp', '.json'].includes(ext)) continue;
        stems.add(f.name.slice(0, -ext.length));
    }
    for (const charDir of [...stems].sort()) {
        const view = await scopedCharView(request, charDir).catch(() => null);
        if (!view) continue;
        const allowed = g.allowedChars.includes(view.avatar);
        if (!allowed && view.scripts.length === 0) continue;
        chars.push({ charDir, avatar: view.avatar, name: view.name, allowed, count: view.scripts.length, scripts: view.scripts });
    }

    // 预设枚举:LLM 族全扫(listWithDocs 60s 缓存),只列有脚本或被放行的。
    const presets = [];
    const presetRepo = getPresetRepo();
    for (const apiId of REGEX_PRESET_API_IDS) {
        const docs = await presetRepo.listWithDocs(handle, apiId).catch(() => []);
        for (const { name, doc } of docs) {
            const scripts = Array.isArray(doc?.extensions?.regex_scripts) ? doc.extensions.regex_scripts : [];
            const allowed = Array.isArray(g.allowedPresets?.[apiId]) && g.allowedPresets[apiId].includes(name);
            if (!allowed && scripts.length === 0) continue;
            presets.push({ apiId, name, allowed, count: scripts.length, scripts });
        }
    }

    return {
        global: g.scripts,
        allowed: { characters: g.allowedChars, presets: g.allowedPresets },
        extensionDisabled: g.disabled.includes('regex'),
        chars,
        presets,
    };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function apply(ctx) {
    const ws = ctx.webServer;
    const reg = (method, path_, handler) =>
        ctx.effect(() => ws.register({ kind: 'pattern', method, path: path_, handler }));

    /** GET /regex —— ?scope=… 分面;无 scope 出全量视图。 */
    reg('GET', P, async function (request, response) {
        try {
            const hasScope = request.query && Object.prototype.hasOwnProperty.call(request.query, 'scope');
            if (!hasScope) {
                return response.send(await fullView(request));
            }
            const handle = request.user.profile.handle;
            const scope = resolveScope(request);
            if (scope.scope === 'global') {
                const g = await readGlobalView(handle);
                return response.send({ scope: 'global', scripts: g.scripts, extensionDisabled: g.disabled.includes('regex') });
            }
            if (scope.scope === 'char') {
                const [g, view] = await Promise.all([readGlobalView(handle), scopedCharView(request, scope.charDir)]);
                if (!view) {
                    return response.status(404).send({ error: `Character not found: ${scope.charDir}` });
                }
                return response.send({
                    scope: 'char', charDir: scope.charDir, avatar: view.avatar, name: view.name,
                    allowed: g.allowedChars.includes(view.avatar), scripts: view.scripts,
                });
            }
            const [g, doc] = await Promise.all([
                readGlobalView(handle),
                getPresetRepo().get(handle, scope.apiId, scope.name),
            ]);
            if (!doc) {
                return response.status(404).send({ error: `Preset not found: ${scope.apiId}/${scope.name}` });
            }
            const scripts = Array.isArray(doc?.extensions?.regex_scripts) ? doc.extensions.regex_scripts : [];
            const allowed = Array.isArray(g.allowedPresets?.[scope.apiId]) && g.allowedPresets[scope.apiId].includes(scope.name);
            return response.send({ scope: 'preset', apiId: scope.apiId, name: scope.name, allowed, scripts });
        } catch (error) {
            return sendError(response, error, 'utopinn/regex get');
        }
    });

    /**
     * PUT /regex —— {scope,…,scripts? 整组替换,allow? 放行开关}。
     * scripts/allow 至少给一个;char 域先写卡再调放行表(放行失败留
     * 未放行脚本 = 惰性安全向)。
     */
    reg('PUT', P, async function (request, response) {
        try {
            const handle = request.user.profile.handle;
            const scope = resolveScope(request);
            const body = request.body ?? {};
            const hasScripts = Object.prototype.hasOwnProperty.call(body, 'scripts');
            const hasAllow = typeof body.allow === 'boolean';
            if (!hasScripts && !hasAllow) {
                return response.status(400).send({ error: 'Expected body.scripts (array) and/or body.allow (boolean).' });
            }
            if (hasScripts) {
                const bad = validateScriptArray(body.scripts);
                if (bad) return response.status(400).send({ error: `Invalid regex scripts: ${bad}` });
            }
            if (hasAllow && scope.scope === 'global') {
                return response.status(400).send({ error: 'global scope has no allowlist (always active).' });
            }

            let stored;
            if (hasScripts) {
                if (scope.scope === 'global') {
                    const settings = (await getSettingsRepo().get(handle)) ?? {};
                    await getSettingsRepo().patch(handle, putGlobalOps(settings, body.scripts));
                } else if (scope.scope === 'char') {
                    await mutateCharScripts(request, scope.charDir, () => body.scripts);
                } else {
                    const repo = getPresetRepo();
                    const doc = await repo.get(handle, scope.apiId, scope.name);
                    if (!doc) {
                        return response.status(404).send({ error: `Preset not found: ${scope.apiId}/${scope.name}` });
                    }
                    await repo.patch(handle, scope.apiId, scope.name, putPresetOps(doc, body.scripts));
                }
                stored = body.scripts;
            }

            if (hasAllow) {
                // 幽灵放行拦截:卡文件不存在时拒绝写放行表(否则留下指向
                // 不存在 avatar 的 character_allowed_regex 条目)。
                if (scope.scope === 'char' && !resolveCharFile(request.user.directories, scope.charDir)) {
                    throw new NotFoundError('character card', { charDir: scope.charDir });
                }
                const avatar = scope.scope === 'char'
                    ? await resolveAvatarFileName(request.user.directories, scope.charDir)
                    : undefined;
                await patchAllowlist(handle, scope.scope, {
                    avatar, apiId: scope.apiId, presetName: scope.name, allow: body.allow,
                });
            }

            return response.send({
                ok: true, scope: scope.scope,
                ...(scope.charDir ? { charDir: scope.charDir } : {}),
                ...(scope.apiId ? { apiId: scope.apiId, name: scope.name } : {}),
                ...(stored ? { count: stored.length } : {}),
                ...(hasAllow ? { allow: body.allow } : {}),
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/regex put');
        }
    });

    /**
     * PATCH /regex/:id —— {scope,…,set:{}} 字段级补丁合并进命中脚本
     * (spread 保活未知字段;set 禁 __proto__/constructor/prototype 键)。
     */
    reg('PATCH', `${P}/:id`, async function (request, response) {
        try {
            const handle = request.user.profile.handle;
            const scope = resolveScope(request);
            const id = String(request.params.id ?? '');
            const set = request.body?.set;
            if (!set || typeof set !== 'object' || Array.isArray(set)) {
                return response.status(400).send({ error: 'Expected body.set object (field patch).' });
            }
            for (const k of Object.keys(set)) {
                if (FORBIDDEN_PATCH_KEYS.has(k)) {
                    return response.status(400).send({ error: `set.${k} is not a patchable key` });
                }
            }
            let mergedScript = null;
            const mutate = (scripts) => {
                const hit = findScript(scripts, id);
                if (!hit) throw new NotFoundError('regex script', { id, scope });
                const merged = { ...hit.script, ...set };
                const bad = validateRegexScript(merged, hit.index);
                if (bad) throw new InvalidArgumentError(`refusing to persist: ${bad}`);
                mergedScript = merged;
                const next = scripts.slice();
                next[hit.index] = merged;
                return next;
            };
            await applyScopedMutation(request, scope, mutate);
            return response.send({ ok: true, id, scope: scope.scope, script: mergedScript });
        } catch (error) {
            return sendError(response, error, 'utopinn/regex patch');
        }
    });

    /** DELETE /regex/:id —— scope 走 query(或 body),按 id/下标删一条。 */
    reg('DELETE', `${P}/:id`, async function (request, response) {
        try {
            const scope = resolveScope(request);
            const id = String(request.params.id ?? '');
            const mutate = (scripts) => {
                const hit = findScript(scripts, id);
                if (!hit) throw new NotFoundError('regex script', { id, scope });
                const next = scripts.slice();
                next.splice(hit.index, 1);
                return next;
            };
            const result = await applyScopedMutation(request, scope, mutate);
            return response.send({ ok: true, id, scope: scope.scope, remaining: result.length });
        } catch (error) {
            return sendError(response, error, 'utopinn/regex delete');
        }
    });
}

/**
 * PATCH/DELETE 公共写机:按 scope 把 mutator(旧数组→新数组)落到对应存储。
 * settings/preset 用 test-op CAS 单 tx;char 走 keyed-tail 卡写。
 * @param {(old:object[])=>object[]} mutator
 * @returns {Promise<object[]>} 落盘后的新数组
 */
async function applyScopedMutation(request, scope, mutator) {
    const handle = request.user.profile.handle;
    if (scope.scope === 'global') {
        const settings = (await getSettingsRepo().get(handle)) ?? {};
        const ext = (settings.extension_settings && typeof settings.extension_settings === 'object')
            ? settings.extension_settings : {};
        const old = Array.isArray(ext.regex) ? ext.regex : [];
        const next = mutator(old);
        const ops = [];
        if (!settings.extension_settings || typeof settings.extension_settings !== 'object') {
            ops.push({ op: 'add', path: '/extension_settings', value: {} });
        }
        if (ext.regex === undefined) {
            // 字段缺省:CAS 无从锚定——直接 add(并发建字段 last-wins,可接受)
            ops.push({ op: 'add', path: '/extension_settings/regex', value: next });
        } else {
            ops.push(...casReplaceOps('/extension_settings/regex', old, next));
        }
        await getSettingsRepo().patch(handle, ops);
        return next;
    }
    if (scope.scope === 'char') {
        return mutateCharScripts(request, scope.charDir, mutator);
    }
    const repo = getPresetRepo();
    const doc = await repo.get(handle, scope.apiId, scope.name);
    if (!doc) throw new NotFoundError('preset', { apiId: scope.apiId, name: scope.name });
    const ext = doc.extensions && typeof doc.extensions === 'object' ? doc.extensions : {};
    const old = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
    const next = mutator(old);
    const ops = [];
    if (!doc.extensions || typeof doc.extensions !== 'object' || Array.isArray(doc.extensions)) {
        ops.push({ op: 'add', path: '/extensions', value: {} });
    }
    if (ext.regex_scripts === undefined) {
        ops.push({ op: 'add', path: '/extensions/regex_scripts', value: next });
    } else {
        ops.push(...casReplaceOps('/extensions/regex_scripts', old, next));
    }
    await repo.patch(handle, scope.apiId, scope.name, ops);
    return next;
}
