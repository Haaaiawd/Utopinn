// compat 面:harness/legacy UI 专用,产品调用走 /api/utopinn/*(收敛方案 .skeinn/design/legacy-convergence.md,TASK-035)。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

import express from 'express';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue, getConfigEnvKeys, tryParse, color, setPermissionsSync, isValidUrl, isPathUnderParent, resolvePathWithinParent, confineRealPath } from '../util.js';
import { write } from '../character-card-parser.js';
import { serverDirectory } from '../server-directory.js';
import { Jimp, JimpMime } from '../jimp.js';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
import { getWorldInfoRepo, getPresetRepo, getNamedDocRepo, getSettingsRepo } from '../storage/index.js';

const WHITELIST_GENERIC_URL_DOWNLOAD_SOURCES = getConfigValue('whitelistImportDomains', []);
const USER_AGENT = 'Utopinn';

const DEFAULT_CONTENT_INDEX = 'index.json';

/**
 * Built-in content sources in declaration order (lowest precedence first):
 * `default/content` is the upstream asset list, `default/scaffold` is the
 * operator-owned release namespace. Operators append additional sources via
 * the `contentSources` key in config.yaml — each entry is `{ path, index? }`
 * (a bare string is accepted as shorthand for `{ path }`):
 *
 *   contentSources:
 *     - path: ./default/content-pack     # resolved against the server dir
 *       index: index.json                # optional; defaults to index.json
 *
 * `path` may be absolute, but the resolved directory must stay inside the
 * server directory or the data root — entries escaping both are skipped
 * with a warning. `index` is a plain file name inside the source directory.
 *
 * Precedence: later-declared sources override earlier ones. Seeding copies
 * the first matching index entry and skips same-filename duplicates, so the
 * merged index lists the highest-precedence source first — configured
 * sources win over `default/scaffold`, which wins over `default/content`.
 */
const BUILTIN_CONTENT_SOURCES = [
    { path: 'default/content' },
    { path: 'default/scaffold' },
];

/**
 * Source keys that already produced a warning in this process. Content
 * source problems are logged once per source, not once per call.
 * @type {Set<string>}
 */
const reportedContentSources = new Set();

function warnContentSource(key, ...args) {
    if (reportedContentSources.has(key)) {
        return;
    }
    reportedContentSources.add(key);
    console.warn(...args);
}

/**
 * Resolves one `contentSources` config entry to a source descriptor.
 * @param {any} entry Config entry: `{ path, index? }` or a bare path string
 * @returns {{dir: string, indexPath: string} | null} Source descriptor, or null when the entry is invalid
 */
function resolveContentSourceEntry(entry) {
    const record = typeof entry === 'string' ? { path: entry } : entry;
    const key = `entry:${JSON.stringify(record)}`;

    const relPath = typeof record?.path === 'string' ? record.path.trim() : '';
    if (!relPath) {
        warnContentSource(key, `contentSources entry ${JSON.stringify(record)} has no 'path'; skipping`);
        return null;
    }

    const dir = path.resolve(serverDirectory, relPath);
    const dataRoot = typeof globalThis.DATA_ROOT === 'string' ? path.resolve(globalThis.DATA_ROOT) : null;
    const contained = isPathUnderParent(serverDirectory, dir) || (dataRoot !== null && isPathUnderParent(dataRoot, dir));
    if (!contained) {
        warnContentSource(key, `contentSources path '${relPath}' resolves outside the server directory and data root; skipping`);
        return null;
    }

    const index = typeof record.index === 'string' && record.index.trim() ? record.index.trim() : DEFAULT_CONTENT_INDEX;
    if (index === '..' || path.basename(index) !== index) {
        warnContentSource(key, `contentSources entry for '${relPath}' has an invalid index name '${index}'; skipping`);
        return null;
    }

    return { dir, indexPath: path.join(dir, index) };
}

/**
 * A resolved content source — the only shape downstream code may see.
 * `origin` records who declared the pack; `rank` is the explicit precedence:
 * a higher-ranked source shadows same-named index entries from every
 * lower-ranked one. Rank is assigned once, here at resolution time, so
 * precedence is a value on the descriptor — not an emergent property of
 * which direction a consumer happens to iterate the array.
 * @typedef {Object} ContentSource
 * @property {string} dir Absolute pack root — every pack-derived path stays under it
 * @property {string} indexPath Absolute path of the pack's index file
 * @property {'builtin'|'config'} origin Who declared the pack
 * @property {number} rank Explicit precedence — higher shadows lower
 */

/**
 * Lists the active content sources in declaration order (lowest precedence
 * first): the built-ins, then the configured `contentSources` entries.
 * Invalid configured entries are skipped with a warning.
 * @returns {ContentSource[]} Resolved content sources, rank ascending
 */
export function resolveContentSources() {
    const sources = BUILTIN_CONTENT_SOURCES.map((source, rank) => ({
        dir: path.resolve(serverDirectory, source.path),
        indexPath: path.resolve(serverDirectory, source.path, DEFAULT_CONTENT_INDEX),
        origin: 'builtin',
        rank,
    }));

    // An object-typed env override is JSON.parse'd inside getConfigValue,
    // which silently falls back to the default when the value is malformed —
    // that would hide why the configured packs went missing, so the first
    // env key actually consulted gets checked here and named in the warning.
    for (const envKey of getConfigEnvKeys('contentSources')) {
        if (!(envKey in process.env)) {
            continue;
        }
        if (tryParse(process.env[envKey]) == null) {
            warnContentSource(`env:${envKey}`, `${envKey} is set but its value is not valid JSON; ignoring it`);
        }
        break;
    }

    const configured = getConfigValue('contentSources', []);
    if (configured == null) {
        return sources;
    }
    if (!Array.isArray(configured)) {
        warnContentSource('config-shape', 'contentSources must be a list of { path, index? } entries; ignoring it');
        return sources;
    }
    for (const entry of configured) {
        const source = resolveContentSourceEntry(entry);
        if (source) {
            source.origin = 'config';
            source.rank = sources.length;
            sources.push(source);
        }
    }
    return sources;
}

/**
 * @typedef {Object} ContentItem
 * @property {string} filename
 * @property {string} type
 * @property {string} [name]
 * @property {string|null} [folder]
 */

/**
 * @typedef {string} ContentType
 * @enum {string}
 */
export const CONTENT_TYPES = {
    SETTINGS: 'settings',
    CHARACTER: 'character',
    SPRITES: 'sprites',
    BACKGROUND: 'background',
    WORLD: 'world',
    AVATAR: 'avatar',
    THEME: 'theme',
    WORKFLOW: 'workflow',
    KOBOLD_PRESET: 'kobold_preset',
    OPENAI_PRESET: 'openai_preset',
    NOVEL_PRESET: 'novel_preset',
    TEXTGEN_PRESET: 'textgen_preset',
    INSTRUCT: 'instruct',
    CONTEXT: 'context',
    MOVING_UI: 'moving_ui',
    QUICK_REPLIES: 'quick_replies',
    SYSPROMPT: 'sysprompt',
    REASONING: 'reasoning',
    ERROR_PAGE: 'error_page',
    STYLESHEET: 'stylesheet',
};

/**
 * @enum {string}
 */
export const CONTENT_SCOPE = {
    USER: 'user',
    GLOBAL: 'global',
};

/**
 * Repo adapter — the exists/save pair a repo-backed type hands to the
 * seeder. The probe keeps a force-reseed from clobbering a user-edited doc
 * with the default. `handle` is the user handle, `name` the file basename.
 * @typedef {Object} ContentRepoAdapter
 * @property {string} label Repo descriptor used in log messages
 * @property {(handle: string, name: string) => Promise<boolean>} exists
 * @property {(handle: string, name: string, json: object) => Promise<void>} save
 */

const presetRepoAdapter = (apiId) => ({
    label: `PresetRepo[${apiId}]`,
    exists: (handle, name) => getPresetRepo().exists(handle, apiId, name),
    save: (handle, name, json) => getPresetRepo().save(handle, apiId, name, json),
});

const namedDocRepoAdapter = (family) => ({
    label: `NamedDocRepo[${family}]`,
    exists: async (handle, name) => (await getNamedDocRepo().get(handle, family, name)) != null,
    save: (handle, name, json) => getNamedDocRepo().save(handle, family, name, json),
});

/**
 * Content type registry — the single place a type's routing is declared.
 * Adding a type is one CONTENT_TYPES entry plus one row here; scope, user
 * target, global target, and the seed sink all follow from the row instead
 * of being edited into four separate switches.
 *
 *   dir       UserDirectoryList key the per-user fs target resolves through
 *   globalDir directory name under DATA_ROOT (global-scope types)
 *   scope     CONTENT_SCOPE — defaults to USER when omitted
 *   repo      ContentRepoAdapter — its presence picks the repo sink over fs
 *   preset    marks a resettable preset type for /api/presets/restore
 */
const CONTENT_TYPE_TABLE = {
    [CONTENT_TYPES.SETTINGS]: {
        dir: 'root',
        repo: {
            label: 'SettingsRepo',
            // The settings handler returns null on missing file/row in
            // every engine (see fs-engine-transaction.js:288-307,
            // sqlite-engine-transaction.js:210-228, and the equivalent
            // mysql/postgres handlers), so probing get() is enough; the
            // engines don't bootstrap an empty settings doc on first read.
            exists: async (handle) => (await getSettingsRepo().get(handle)) != null,
            save: (handle, _name, json) => getSettingsRepo().save(handle, json),
        },
    },
    [CONTENT_TYPES.CHARACTER]: { dir: 'characters' },
    [CONTENT_TYPES.SPRITES]: { dir: 'characters' },
    [CONTENT_TYPES.BACKGROUND]: { dir: 'backgrounds' },
    [CONTENT_TYPES.WORLD]: {
        dir: 'worlds',
        repo: {
            label: 'WorldInfoRepo',
            exists: async (handle, name) => (await getWorldInfoRepo().get(handle, name)) != null,
            save: (handle, name, json) => getWorldInfoRepo().save(handle, name, json),
        },
    },
    [CONTENT_TYPES.AVATAR]: { dir: 'avatars' },
    [CONTENT_TYPES.THEME]: { dir: 'themes', repo: namedDocRepoAdapter('themes') },
    [CONTENT_TYPES.WORKFLOW]: { dir: 'comfyWorkflows' },
    [CONTENT_TYPES.KOBOLD_PRESET]: { dir: 'koboldAI_Settings', repo: presetRepoAdapter('kobold'), preset: true },
    [CONTENT_TYPES.OPENAI_PRESET]: { dir: 'openAI_Settings', repo: presetRepoAdapter('openai'), preset: true },
    [CONTENT_TYPES.NOVEL_PRESET]: { dir: 'novelAI_Settings', repo: presetRepoAdapter('novel'), preset: true },
    [CONTENT_TYPES.TEXTGEN_PRESET]: { dir: 'textGen_Settings', repo: presetRepoAdapter('textgenerationwebui'), preset: true },
    [CONTENT_TYPES.INSTRUCT]: { dir: 'instruct', repo: presetRepoAdapter('instruct'), preset: true },
    [CONTENT_TYPES.CONTEXT]: { dir: 'context', repo: presetRepoAdapter('context'), preset: true },
    [CONTENT_TYPES.MOVING_UI]: { dir: 'movingUI', repo: namedDocRepoAdapter('movingUI') },
    [CONTENT_TYPES.QUICK_REPLIES]: { dir: 'quickreplies', repo: namedDocRepoAdapter('quickReplies') },
    [CONTENT_TYPES.SYSPROMPT]: { dir: 'sysprompt', repo: presetRepoAdapter('sysprompt'), preset: true },
    [CONTENT_TYPES.REASONING]: { dir: 'reasoning', repo: presetRepoAdapter('reasoning'), preset: true },
    [CONTENT_TYPES.ERROR_PAGE]: { scope: CONTENT_SCOPE.GLOBAL, globalDir: '_errors' },
    [CONTENT_TYPES.STYLESHEET]: { scope: CONTENT_SCOPE.GLOBAL, globalDir: '_css' },
};

// Registry invariant: every declared type needs a routing row, so an enum
// entry added without its row fails at module load, not silently at seed.
for (const type of Object.values(CONTENT_TYPES)) {
    if (!CONTENT_TYPE_TABLE[type]) {
        throw new Error(`content type '${type}' has no CONTENT_TYPE_TABLE row`);
    }
}

/**
 * Gets the scope of a content type.
 * @param {CONTENT_TYPES} type Content type
 * @returns {CONTENT_SCOPE} Resolved content scope
 */
function getScopeByType(type) {
    // A type name the registry doesn't know still merges as USER-scope —
    // the seed sink later reports it as unknown instead of misrouting it.
    return CONTENT_TYPE_TABLE[type]?.scope ?? CONTENT_SCOPE.USER;
}

/**
 * Whether a content type is one of the resettable preset types — the same
 * set `getDefaultPresets` collects for the /api/presets/restore flow. The
 * `*_preset` suffix covers preset types a pack declares ahead of the
 * registry; the row flag covers the non-suffixed preset families.
 * @param {string} type Content type
 * @returns {boolean}
 */
function isDefaultPresetType(type) {
    return type.endsWith('_preset') || CONTENT_TYPE_TABLE[type]?.preset === true;
}

/**
 * Gets the default presets from the content directory.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object[]} Array of default presets
 */
export function getDefaultPresets(directories) {
    try {
        const contentIndex = getContentIndex(CONTENT_SCOPE.USER);
        const presets = [];

        for (const contentItem of contentIndex) {
            if (isDefaultPresetType(contentItem.type)) {
                contentItem.name = path.parse(contentItem.filename).name;
                contentItem.folder = getUserTargetByType(contentItem.type, directories);
                presets.push(contentItem);
            }
        }

        return presets;
    } catch (err) {
        console.warn('Failed to get default presets', err);
        return [];
    }
}

/**
 * Gets a default JSON file from the content sources.
 * Only files the merged index declares under a preset type are served — a
 * same-named file sitting in a source directory without an index entry can
 * never win the reset. Declared copies are tried highest-precedence first;
 * a missing, escaping, or malformed copy falls through to the next
 * lower-precedence declared copy instead of aborting the restore.
 * @param {string} filename Name of the file to get
 * @returns {object | null} JSON object or null if no declared readable copy exists
 */
export function getDefaultPresetFile(filename) {
    const contentIndex = getContentIndex(CONTENT_SCOPE.USER);
    for (const item of contentIndex) {
        if (item.filename !== filename || !isDefaultPresetType(item.type)) {
            continue;
        }
        try {
            const contentPath = path.join(item.folder, item.filename);
            const realPath = confineRealPath(item.folder, contentPath);
            if (!realPath) {
                continue;
            }
            return JSON.parse(fs.readFileSync(realPath, 'utf8'));
        } catch (err) {
            console.warn(`Failed to get default file ${filename}`, err);
        }
    }
    return null;
}

/**
 * @typedef {Object} FsSink Filesystem sink: copy file into `target`.
 * @property {'fs'} kind
 * @property {string} target Target directory.
 *
 * @typedef {Object} RepoSink Repo sink: parse the file as JSON and hand off to `save`.
 * @property {'repo'} kind
 * @property {string} label Repo descriptor used in log messages (e.g. "WorldInfoRepo").
 * @property {() => Promise<boolean>} exists True when a doc with the same basename already lives in the Repo.
 * @property {(json: object, basename: string) => Promise<void>} save Persists the parsed JSON under `basename`.
 *
 * @typedef {Object} UnknownSink Sentinel: type has no defined target.
 * @property {'none'} kind
 *
 * @typedef {FsSink | RepoSink | UnknownSink} ContentSink
 */

/**
 * Resolves a content item to its persistence sink for a single user.
 * Repo-backed types route through their Repo so db-mode users actually see
 * the seeded data. Binary / multi-file types (CHARACTER, SPRITES, AVATAR,
 * BACKGROUND, WORKFLOW) keep the filesystem path because they are not
 * modeled in the storage engines.
 *
 * Repo sinks carry an `exists(basename)` probe so the force-reseed path
 * (forceCategories) doesn't clobber a user-edited theme/preset/world with
 * the default version on every server restart.
 * @param {string} type Content type from CONTENT_TYPES
 * @param {string} basename Basename of the content file (no extension)
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} handle User handle (last path segment of directories.root)
 * @returns {ContentSink}
 */
function resolveContentSink(type, basename, directories, handle) {
    // Lookup order: repo adapter first, then the fs target — a type with no
    // registry row at all is 'none', the unknown-type sentinel.
    const repo = CONTENT_TYPE_TABLE[type]?.repo;
    if (repo) {
        return {
            kind: 'repo',
            label: repo.label,
            exists: () => repo.exists(handle, basename),
            save: (json, name) => repo.save(handle, name, json),
        };
    }
    const target = getUserTargetByType(type, directories);
    if (!target) return { kind: 'none' };
    return { kind: 'fs', target };
}

/**
 * Seeds content from a content index into a per-content-item sink.
 * @param {ContentItem[]} contentIndex Content index
 * @param {string} contentLogPath Path to the content log file
 * @param {(contentItem: ContentItem) => ContentSink} resolveSink Sink resolver
 * @param {string[]} [forceCategories] List of categories to force check (even if content check is skipped)
 * @returns {Promise<boolean>} Whether any content was added
 */
async function seedContent(contentIndex, contentLogPath, resolveSink, forceCategories) {
    let anyContentAdded = false;
    const contentLog = getContentLog(contentLogPath);

    for (const contentItem of contentIndex) {
        if (contentLog.includes(contentItem.filename) && !forceCategories?.includes(contentItem.type)) {
            continue;
        }

        if (!contentItem.folder) {
            console.warn(`Content file ${contentItem.filename} has no parent folder`);
            continue;
        }

        const contentPath = path.join(contentItem.folder, contentItem.filename);

        if (!fs.existsSync(contentPath)) {
            console.warn(`Content file ${contentItem.filename} is missing`);
            continue;
        }

        // Index validation already rejects lexically escaping filenames;
        // this confines the canonical path too so an in-pack symlink cannot
        // seed out-of-pack content into a user directory.
        const realPath = confineRealPath(contentItem.folder, contentPath);
        if (!realPath) {
            console.warn(`Content file ${contentItem.filename} resolves outside its content source; skipping`);
            continue;
        }

        const sink = resolveSink(contentItem);

        if (sink.kind === 'none') {
            console.warn(`Content file ${contentItem.filename} has unknown type ${contentItem.type}`);
            continue;
        }

        if (sink.kind === 'repo') {
            // Guard the force-reseed path so a user-edited theme/preset/world
            // stored in the Repo is not silently overwritten with the default.
            // The contentLog gate above already protects the common case, but
            // when forceCategories.includes(contentItem.type) is true (e.g.
            // /api/users/reset-step2) the contentLog gate is bypassed.
            if (typeof sink.exists === 'function' && await sink.exists()) {
                console.info(`Content file ${contentItem.filename} already present in ${sink.label}; skipping`);
                if (!contentLog.includes(contentItem.filename)) {
                    contentLog.push(contentItem.filename);
                }
                continue;
            }
            let json;
            try {
                const raw = fs.readFileSync(realPath, 'utf8');
                json = JSON.parse(raw);
            } catch (parseErr) {
                console.warn(`Content file ${contentItem.filename} is not valid JSON; skipping`, parseErr);
                continue;
            }
            const basename = path.parse(contentItem.filename).name;
            try {
                await sink.save(json, basename);
            } catch (saveErr) {
                // Some Repos validate doc shape (e.g. WorldInfoRepo requires
                // an entries object). Surface per-file failures and continue
                // so one bad seed doesn't abort the rest; leave it off the
                // contentLog so a future run retries it.
                console.warn(`Failed to seed ${contentItem.filename} via ${sink.label}`, saveErr);
                continue;
            }
            contentLog.push(contentItem.filename);
            console.info(`Content file ${contentItem.filename} seeded via ${sink.label}`);
            anyContentAdded = true;
            continue;
        }

        // sink.kind === 'fs'
        const contentTarget = sink.target;
        const basePath = path.parse(contentItem.filename).base;
        const targetPath = path.join(contentTarget, basePath);
        contentLog.push(contentItem.filename);

        if (fs.existsSync(targetPath)) {
            console.warn(`Content file ${contentItem.filename} already exists in ${contentTarget}`);
            continue;
        }

        fs.mkdirSync(contentTarget, { recursive: true });
        fs.cpSync(realPath, targetPath, { recursive: true, force: false });
        setPermissionsSync(targetPath);
        console.info(`Content file ${contentItem.filename} copied to ${contentTarget}`);
        anyContentAdded = true;
    }

    writeFileAtomicSync(contentLogPath, contentLog.join('\n'));
    return anyContentAdded;
}

/**
 * Seeds content for a user. Repo-backed types route through their Repo so
 * db-mode users actually see seeded presets / worlds / themes / etc.;
 * binary types (CHARACTER, SPRITES, AVATAR, BACKGROUND, WORKFLOW) keep
 * the disk path.
 * @param {ContentItem[]} contentIndex Content index
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]} forceCategories List of categories to force check (even if content check is skipped)
 * @returns {Promise<boolean>} Whether any content was added
 */
export async function seedContentForUser(contentIndex, directories, forceCategories) {
    if (!fs.existsSync(directories.root)) {
        fs.mkdirSync(directories.root, { recursive: true });
    }

    const contentLogPath = path.join(directories.root, 'content.log');
    // Derive the user handle from directories.root. getUserDirectories builds
    // each directory as path.join(DATA_ROOT, handle, USER_DIRECTORY_TEMPLATE[key])
    // so the last segment of `root` is the handle.
    const handle = path.basename(directories.root);
    return seedContent(
        contentIndex,
        contentLogPath,
        (item) => resolveContentSink(item.type, path.parse(item.filename).name, directories, handle),
        forceCategories,
    );
}

/**
 * Seeds global content that is not user-specific, such as error pages.
 * @param {ContentItem[]} contentIndex Content index
 * @returns {Promise<boolean>} Whether any content was added
 */
async function seedGlobalContent(contentIndex) {
    const contentLogPath = path.join(globalThis.DATA_ROOT, 'content.log');
    return seedContent(
        contentIndex,
        contentLogPath,
        (item) => {
            const target = getGlobalTargetByType(item.type);
            if (!target) return { kind: 'none' };
            return { kind: 'fs', target };
        },
    );
}

/**
 * Checks for new content and seeds it for all users.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
 * @param {string[]} forceCategories List of categories to force check (even if content check is skipped)
 * @returns {Promise<void>}
 */
export async function checkForNewContent(directoriesList, forceCategories = []) {
    try {
        const contentCheckSkip = getConfigValue('skipContentCheck', false, 'boolean');
        if (contentCheckSkip && forceCategories?.length === 0) {
            return;
        }

        const userContentIndex = getContentIndex(CONTENT_SCOPE.USER);
        const globalContentIndex = getContentIndex(CONTENT_SCOPE.GLOBAL);
        let anyContentAdded = false;

        const globalSeedResult = await seedGlobalContent(globalContentIndex);
        if (globalSeedResult) {
            anyContentAdded = true;
        }

        for (const directories of directoriesList) {
            const userSeedResult = await seedContentForUser(userContentIndex, directories, forceCategories);

            if (userSeedResult) {
                anyContentAdded = true;
            }
        }

        if (anyContentAdded && !contentCheckSkip && forceCategories?.length === 0) {
            console.info();
            console.info(`${color.blue('If you don\'t want to receive content updates in the future, set')} ${color.yellow('skipContentCheck')} ${color.blue('to true in the config.yaml file.')}`);
            console.info();
        }
    } catch (err) {
        console.error('Content check failed', err);
    }
}

/**
 * Gets the merged content index across all content sources. Sources are
 * declared lowest-precedence first (`default/content`, `default/scaffold`,
 * then configured `contentSources` entries) and the merged index lists
 * highest precedence first: seeding copies the first matching entry and
 * skips same-filename duplicates, so a later-declared source overrides
 * earlier ones. A missing or malformed source index is skipped with a
 * warning and never aborts the merge.
 * @param {CONTENT_SCOPE} scope Scope of content to get
 * @returns {ContentItem[]} Array of content index
 */
function getContentIndex(scope = CONTENT_SCOPE.USER) {
    const result = [];
    // Rank-descending: the highest-precedence source merges first, so its
    // entries land ahead of same-named entries from every lower rank.
    const sources = resolveContentSources().sort((a, b) => b.rank - a.rank);

    for (const { dir, indexPath } of sources) {

        let index;
        try {
            if (!fs.existsSync(indexPath)) {
                warnContentSource(`missing:${indexPath}`, `Content source index ${indexPath} does not exist; skipping`);
                continue;
            }
            index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        } catch (err) {
            warnContentSource(`parse:${indexPath}`, `Content source index ${indexPath} is not valid JSON; skipping`, err);
            continue;
        }
        if (!Array.isArray(index)) {
            warnContentSource(`shape:${indexPath}`, `Content source index ${indexPath} is not an array; skipping`);
            continue;
        }

        let skipped = 0;
        let escaped = 0;
        for (const item of index) {
            if (item === null || typeof item !== 'object' || typeof item.filename !== 'string' || typeof item.type !== 'string') {
                skipped++;
                continue;
            }
            // An index entry must stay inside its own source directory —
            // path.join does not neutralise '..', so without this check an
            // entry like "../../secret.json" would read outside the pack.
            if (resolvePathWithinParent(dir, item.filename) === null) {
                escaped++;
                continue;
            }
            item.folder = dir;
            item.scope = getScopeByType(item.type);
            result.push(item);
        }
        if (skipped > 0) {
            warnContentSource(`items:${indexPath}`, `Content source index ${indexPath}: skipped ${skipped} malformed entr${skipped === 1 ? 'y' : 'ies'} (entries need filename and type strings)`);
        }
        if (escaped > 0) {
            warnContentSource(`escape:${indexPath}`, `Content source index ${indexPath}: skipped ${escaped} entr${escaped === 1 ? 'y' : 'ies'} whose filename resolves outside the source directory`);
        }
    }

    return result.filter((item) => item.scope === scope);
}

/**
 * Gets content by type and format.
 * @param {string} type Type of content
 * @param {'json'|'string'|'raw'} format Format of content
 * @param {CONTENT_SCOPE} scope Scope of content to get
 * @returns {string[]|Buffer[]} Array of content
 */
export function getContentOfType(type, format, scope = CONTENT_SCOPE.USER) {
    const contentIndex = getContentIndex(scope);
    const indexItems = contentIndex.filter((item) => item.type === type && item.folder);
    const files = [];
    // The merged index is ordered highest-precedence first; same-named items
    // from lower-precedence sources are shadowed by the first readable copy.
    // The logical name is the file basename — the identity the fs sink
    // flattens to and the repo stem keys on downstream. A winner that is
    // missing or unreadable does not shadow: the next declared copy is
    // tried, so a broken pack cannot erase the content it replaced.
    const seen = new Set();
    for (const item of indexItems) {
        const logicalName = path.basename(item.filename);
        if (seen.has(logicalName)) {
            continue;
        }
        try {
            const realPath = confineRealPath(item.folder, path.join(item.folder, item.filename));
            if (!realPath) {
                continue;
            }
            const fileContent = fs.readFileSync(realPath);
            switch (format) {
                case 'json':
                    files.push(JSON.parse(fileContent.toString()));
                    break;
                case 'string':
                    files.push(fileContent.toString());
                    break;
                case 'raw':
                    files.push(fileContent);
                    break;
            }
            seen.add(logicalName);
        } catch {
            // Ignore errors
        }
    }
    return files;
}

/**
 * Gets the target directory for the specified asset type.
 * @param {ContentType} type Asset type
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string | null} Target directory
 */
export function getUserTargetByType(type, directories) {
    const dirKey = CONTENT_TYPE_TABLE[type]?.dir;
    return dirKey ? directories[dirKey] : null;
}

/**
 * Gets the target directory for global content types.
 * @param {CONTENT_TYPES} type Content type
 * @returns {string | null} Target directory
 */
export function getGlobalTargetByType(type) {
    const globalDir = CONTENT_TYPE_TABLE[type]?.globalDir;
    return globalDir ? path.join(globalThis.DATA_ROOT, globalDir) : null;
}

/**
 * Gets the content log from the content log file.
 * @param {string} contentLogPath Path to the content log file
 * @returns {string[]} Array of content log lines
 */
function getContentLog(contentLogPath) {
    if (!fs.existsSync(contentLogPath)) {
        return [];
    }

    const contentLogText = fs.readFileSync(contentLogPath, 'utf8');
    return contentLogText.split('\n');
}

async function downloadChubLorebook(id) {
    const [lorebooks, creatorName, projectName] = id.split('/');
    const result = await fetch(`https://api.chub.ai/api/${lorebooks}/${creatorName}/${projectName}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Chub returned error', result.statusText, text);
        throw new Error('Failed to fetch lorebook metadata');
    }

    /** @type {any} */
    const metadata = await result.json();
    const projectId = metadata.node?.id;

    if (!projectId) {
        throw new Error('Project ID not found in lorebook metadata');
    }

    const downloadUrl = `https://api.chub.ai/api/v4/projects/${projectId}/repository/files/raw%252Fsillytavern_raw.json/raw`;
    const downloadResult = await fetch(downloadUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!downloadResult.ok) {
        const text = await downloadResult.text();
        console.error('Chub returned error', downloadResult.statusText, text);
        throw new Error('Failed to download lorebook');
    }

    const name = projectName;
    const buffer = Buffer.from(await downloadResult.arrayBuffer());
    const fileName = `${sanitize(name)}.json`;
    const fileType = downloadResult.headers.get('content-type');

    return { buffer, fileName, fileType };
}

async function downloadChubCharacter(id) {
    const [creatorName, projectName] = id.split('/');
    const result = await fetch(`https://api.chub.ai/api/characters/${creatorName}/${projectName}?full=true`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Chub returned error', result.statusText, text);
        throw new Error('Failed to fetch character metadata');
    }

    /** @type {any} */
    const metadata = await result.json();
    const { definition, topics } = metadata.node;

    /** @type {TavernCardV2} */
    const characterCard = {
        data: {
            name: definition.name,
            description: definition.personality,
            personality: definition.tavern_personality,
            scenario: definition.scenario,
            first_mes: definition.first_message,
            mes_example: definition.example_dialogs,
            creator_notes: definition.description,
            system_prompt: definition.system_prompt,
            post_history_instructions: definition.post_history_instructions,
            alternate_greetings: definition.alternate_greetings,
            tags: topics,
            creator: creatorName,
            character_version: '',
            character_book: definition.embedded_lorebook,
            extensions: definition.extensions,
        },
        spec: 'chara_card_v2',
        spec_version: '2.0',
    };

    const defaultAvatarBuffer = fs.readFileSync(DEFAULT_AVATAR_PATH);

    let imageBuffer = defaultAvatarBuffer;

    const imageUrl = metadata.node?.max_res_url;

    if (imageUrl) {
        const downloadResult = await fetch(imageUrl);
        if (downloadResult.ok) {
            imageBuffer = Buffer.from(await downloadResult.arrayBuffer());
        }
    }

    const buffer = write(imageBuffer, JSON.stringify(characterCard));
    const fileName = `${sanitize(characterCard.data.name)}.png`;
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

/**
 * Downloads a character card from the Pygsite.
 * @param {string} id UUID of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadPygmalionCharacter(id) {
    const result = await fetch(`https://server.pygmalion.chat/api/export/character/${id}/v2`);

    if (!result.ok) {
        const text = await result.text();
        console.error('Pygsite returned error', result.status, text);
        throw new Error('Failed to download character');
    }

    /** @type {any} */
    const jsonData = await result.json();
    const characterData = jsonData?.character;

    if (!characterData || typeof characterData !== 'object') {
        console.error('Pygsite returned invalid character data', jsonData);
        throw new Error('Failed to download character');
    }

    try {
        const avatarUrl = characterData?.data?.avatar;

        if (!avatarUrl) {
            console.error('Pygsite character does not have an avatar', characterData);
            throw new Error('Failed to download avatar');
        }

        const avatarResult = await fetch(avatarUrl);
        const avatarBuffer = Buffer.from(await avatarResult.arrayBuffer());

        const cardBuffer = write(avatarBuffer, JSON.stringify(characterData));

        return {
            buffer: cardBuffer,
            fileName: `${sanitize(id)}.png`,
            fileType: 'image/png',
        };
    } catch (e) {
        console.error('Failed to download avatar, using JSON instead', e);
        return {
            buffer: Buffer.from(JSON.stringify(jsonData)),
            fileName: `${sanitize(id)}.json`,
            fileType: 'application/json',
        };
    }
}

/**
 *
 * @param {String} str
 * @returns { { id: string, type: "character" | "lorebook" } | null }
 */
function parseChubUrl(str) {
    const splitStr = str.split('/');

    let domainIndex = -1;

    splitStr.forEach((part, index) => {
        if (part === 'www.chub.ai' || part === 'chub.ai' || part === 'www.characterhub.org' || part === 'characterhub.org') {
            domainIndex = index;
        }
    });

    const cleanUrl = domainIndex !== -1 ? splitStr.slice(domainIndex + 1) : splitStr;
    const length = cleanUrl.length;

    if (length < 2) {
        return null;
    }

    const firstPart = cleanUrl[0].toLowerCase();

    if (firstPart === 'characters' || firstPart === 'lorebooks') {
        const type = firstPart === 'characters' ? 'character' : 'lorebook';
        const id = type === 'character' ? cleanUrl.slice(1).join('/') : cleanUrl.join('/');
        return {
            id: id,
            type: type,
        };
    } else if (length === 2) {
        return {
            id: cleanUrl.join('/'),
            type: 'character',
        };
    }

    return null;
}

// Warning: Some characters might not exist in JannyAI.me
async function downloadJannyCharacter(uuid) {
    // This endpoint is being guarded behind Bot Fight Mode of Cloudflare
    // So hosted ST on Azure/AWS/GCP/Collab might get blocked by IP
    // Should work normally on self-host PC/Android
    const result = await fetch('https://api.jannyai.com/api/v1/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'characterId': uuid,
        }),
    });

    if (result.ok) {
        /** @type {any} */
        const downloadResult = await result.json();
        if (downloadResult.status === 'ok') {
            const imageResult = await fetch(downloadResult.downloadUrl);
            const buffer = Buffer.from(await imageResult.arrayBuffer());
            const fileName = `${sanitize(uuid)}.png`;
            const fileType = imageResult.headers.get('content-type');

            return { buffer, fileName, fileType };
        } else {
            console.error('Janny failed to download', downloadResult);
        }
    } else {
        console.error('Janny returned error', result.statusText, await result.text());
    }

    throw new Error('Failed to download character');
}

//Download Character Cards from AICharactersCards.com (AICC) API.
async function downloadAICCCharacter(id) {
    const apiURL = `https://aicharactercards.com/wp-json/pngapi/v1/image/${id}`;
    try {
        const response = await fetch(apiURL);
        if (!response.ok) {
            throw new Error(`Failed to download character: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || 'image/png'; // Default to 'image/png' if header is missing
        const buffer = Buffer.from(await response.arrayBuffer());
        const fileName = `${sanitize(id)}.png`; // Assuming PNG, but adjust based on actual content or headers

        return {
            buffer: buffer,
            fileName: fileName,
            fileType: contentType,
        };
    } catch (error) {
        console.error('Error downloading character:', error);
        throw error;
    }
}

/**
 * Parses an aicharactercards URL to extract the path.
 * @param {string} url URL to parse
 * @returns {string | null} AICC path
 */
function parseAICC(url) {
    try {
        if (isValidUrl(url)) {
            const urlObj = new URL(url);
            // Split the path and remove empty strings caused by trailing slashes
            const parts = urlObj.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
                // Always grab the last two segments (author/character)
                return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
            }
        } else {
            // Fallback for relative paths or raw "author/character" strings
            const parts = url.split('/').filter(Boolean);
            if (parts.length >= 2) {
                return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
            }
        }
    } catch (e) {
        console.error('Error parsing AICC URL:', e);
    }
    return null;
}

/**
 * Download character card from generic url.
 * @param {String} url
 */
async function downloadGenericPng(url) {
    try {
        const result = await fetch(url);

        if (result.ok) {
            const buffer = Buffer.from(await result.arrayBuffer());
            let fileName = sanitize(result.url.split('?')[0].split('/').reverse()[0]);
            const contentType = result.headers.get('content-type') || 'image/png'; //yoink it from AICC function lol

            // The `importCharacter()` function detects the MIME (content-type) of the file
            // using its file extension. The problem is that not all third-party APIs serve
            // their cards with a `.png` extension. To support more third-party sites,
            // dynamically append the `.png` extension to the filename if it doesn't
            // already have a file extension.
            if (contentType === 'image/png') {
                const ext = fileName.match(/\.(\w+)$/); // Same regex used by `importCharacter()`
                if (!ext) {
                    fileName += '.png';
                }
            }

            return {
                buffer: buffer,
                fileName: fileName,
                fileType: contentType,
            };
        }
    } catch (error) {
        console.error('Error downloading file: ', error);
        throw error;
    }
    return null;
}

/**
 * Parse Risu Realm URL to extract the UUID.
 * @param {string} url Risu Realm URL
 * @returns {string | null} UUID of the character
 */
function parseRisuUrl(url) {
    // Example: https://realm.risuai.net/character/7adb0ed8d81855c820b3506980fb40f054ceef010ff0c4bab73730c0ebe92279
    // or https://realm.risuai.net/character/7adb0ed8-d818-55c8-20b3-506980fb40f0
    const pattern = /^https?:\/\/realm\.risuai\.net\/character\/([a-f0-9-]+)\/?$/i;
    const match = url.match(pattern);
    return match ? match[1] : null;
}

/**
 * Download RisuAI character card
 * @param {string} uuid UUID of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadRisuCharacter(uuid) {
    const result = await fetch(`https://realm.risuai.net/api/v1/download/png-v3/${uuid}?non_commercial=true`);

    if (!result.ok) {
        const text = await result.text();
        console.error('RisuAI returned error', result.statusText, text);
        throw new Error('Failed to download character');
    }

    const buffer = Buffer.from(await result.arrayBuffer());
    const fileName = `${sanitize(uuid)}.png`;
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

/** * Check if the given string is a valid Perchance UUID.
 * @param {string} uuid UUID string to check
 * @returns {boolean} True if the UUID is valid, false otherwise
 */
function isPerchanceUUID(uuid) {
    if (!uuid) {
        return false;
    }

    //example: Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    //charactername~uuid.gz

    const uuidRegex = /^\w+~[a-f0-9]{32}\.gz$/;
    return uuidRegex.test(uuid);
}

/**
 * Parse Perchance URL to extract the character slug.
 * @param {string} url Perchance character URL
 * @returns {string} Slug of the character
 */
function parsePerchanceSlug(url) {
    // Example: https://perchance.org/ai-character-chat?data=Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    // or: Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    return url?.split('~')[1] || '';
}

/**
 * Download Perchance character card
 * @param {string} slug Slug of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string} | null>}
 */
async function downloadPerchanceCharacter(slug) {
    // example of slug
    // 6903e991c90fd1dba52c036d917e99c6.gz
    const perchanceBaseURL = 'https://user.uploads.dev/file';

    try {
        const charURL = `${perchanceBaseURL}/${slug}`;
        console.log('Downloading Perchance character from URL:', charURL);
        const result = await fetch(charURL, {
            headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        });

        //decompress gzipped content
        if (result.ok) {
            const perchanceChar = await extractPerchanceCharacterFromGz(result);

            const avatarUrl = perchanceChar.avatar?.url;

            //check if avatarURL is a base64 of any image type
            const isAvatarBase64 = avatarUrl && avatarUrl.startsWith('data:image/');

            const charData = {
                name: perchanceChar.name || 'Unnamed Perchance Character',
                first_mes: '',
                tags: [],
                description: perchanceChar.roleInstruction || '',
                creator: perchanceChar.metaTitle || '',
                creator_notes: perchanceChar.metaDescription || '',
                alternate_greetings: [],
                character_version: '',
                mes_example: '',
                post_history_instructions: '',
                system_prompt: '',
                scenario: '',
                personality: perchanceChar.reminderMessage || '',
                extensions: {
                    perchance_data: {
                        slug: slug,
                        char_url: charURL,
                        uuid: perchanceChar.uuid || null,
                        avatar_url: isAvatarBase64 ? null : (avatarUrl || null),
                        folder_path: perchanceChar.folderPath || null,
                        folder_name: perchanceChar.folderName || null,
                        custom_data: perchanceChar.customData || {},
                    },
                },
            };

            const avatarBuffer = await fetchPerchanceAvatar(avatarUrl, isAvatarBase64);

            // Character card
            const buffer = write(avatarBuffer, JSON.stringify({
                'spec': 'chara_card_v2',
                'spec_version': '2.0',
                'data': charData,
            }));

            const fileName = `${charData.name}.png`;
            const fileType = 'image/png';

            return { buffer, fileName, fileType };
        }
    } catch (error) {
        console.error('Error downloading character:', error);
        throw error;
    }
    return null;
}

/**
 * Extracts Perchance character data from a gzipped response.
 * @param {import('node-fetch').Response} result Fetch response containing gzipped character data
 * @returns {Promise<Object>} Parsed Perchance character data
 * @throws {Error} If the character data is invalid or missing required fields
 */
async function extractPerchanceCharacterFromGz(result) {
    const compressedBuffer = await result.arrayBuffer();
    const decompressedBuffer = zlib.gunzipSync(compressedBuffer);

    // inside the gz file, there is a file of the same name without extensions, but it is a json file

    if (!decompressedBuffer || decompressedBuffer.length === 0) {
        console.error('Perchance character data is empty or invalid');
        throw new Error('Failed to download character: Invalid Perchance character data');
    }

    // Parse the decompressed JSON
    const perchanceCharData = JSON.parse(decompressedBuffer.toString());

    if (!perchanceCharData?.addCharacter) {
        console.error('Perchance character data is missing addCharacter field', perchanceCharData);
        throw new Error('Failed to download character: Invalid Perchance character data');
    }

    return perchanceCharData.addCharacter;
}

/** * Fetches the avatar from Perchance URL or uses a default avatar if not available.
 * @param {string} avatarUrl URL of the avatar
 * @param {boolean} isAvatarBase64 Flag indicating if the avatar URL is a base64 string
 * @returns {Promise<Buffer>} Buffer containing the avatar image
 */
async function fetchPerchanceAvatar(avatarUrl, isAvatarBase64) {
    const defaultAvatarBuffer = fs.readFileSync(DEFAULT_AVATAR_PATH);

    if (!avatarUrl || (!isAvatarBase64 && !isValidUrl(avatarUrl))) {
        console.warn('Perchance character does not have an avatar, it is not base64, or it is an invalid url, using default avatar');
        return defaultAvatarBuffer;
    }

    if (isAvatarBase64) {
        // check if avatarUrl is a png
        const isPng = avatarUrl.startsWith('data:image/png;base64,');
        const base64 = avatarUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');

        if (isPng) {
            return buffer;
        } else {
            // use jimp to convert the base64 to PNG if it's not PNG
            console.debug('Perchance character avatar is not PNG, converting to PNG...');
            return await Jimp.read(buffer).then(image => image.getBuffer(JimpMime.png));
        }
    }

    // Fetch avatar from URL
    console.log('Fetching Perchance avatar from URL:', avatarUrl);
    const avatarResponse = await fetch(avatarUrl, { headers: { 'User-Agent': USER_AGENT } });

    if (avatarResponse.ok) {
        const avatarContentType = avatarResponse.headers.get('content-type');
        const avatarBuffer = Buffer.from(await avatarResponse.arrayBuffer());

        if (avatarContentType === 'image/png') {
            return avatarBuffer;
        } else {
            console.debug(`Perchance character avatar is not PNG: ${avatarContentType}. Converting to PNG...`);

            // use jimp to convert the image to PNG if it's not PNG
            return await Jimp.read(avatarBuffer)
                .then(image => image.getBuffer(JimpMime.png));
        }
    }

    console.error('Failed to fetch Perchance avatar:', avatarResponse.statusText);
    const isPerchanceOrgFileUploader = avatarUrl.includes('https://user-uploads.perchance.org');

    if (isPerchanceOrgFileUploader) {
        console.warn('Files from https://user-uploads.perchance.org are sometimes blocked by CloudFlare, try reuploading it in https://perchance.org/upload to get the new link from https://user-uploads.dev instead.');
    }

    console.warn('You can also download the avatar manually and assign it to the character:', avatarUrl);
    return defaultAvatarBuffer;
}

/**
* @param {String} url
* @returns {String | null } UUID of the character
*/
function getUuidFromUrl(url) {
    // Extract UUID from URL
    const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;
    const matches = url.match(uuidRegex);

    // Check if UUID is found
    const uuid = matches ? matches[0] : null;
    return uuid;
}

/**
 * Filter to get the domain host of a url instead of a blanket string search.
 * @param {String} url URL to strip
 * @returns {String} Domain name
 */
export function getHostFromUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname;
    } catch {
        return '';
    }
}

/**
 * Checks if host is part of generic download source whitelist.
 * @param {String} host Host to check
 * @returns {boolean} If the host is on the whitelist.
 */
export function isHostWhitelisted(host) {
    return WHITELIST_GENERIC_URL_DOWNLOAD_SOURCES.includes(host);
}

export const router = express.Router();

router.post('/importURL', async (request, response) => {
    if (!request.body.url) {
        return response.sendStatus(400);
    }

    try {
        const url = request.body.url;
        const host = getHostFromUrl(url);
        let result;
        let type;

        const isChub = host.includes('chub.ai') || host.includes('characterhub.org');
        const isJannnyContent = host.includes('janitorai');
        const isPygmalionContent = host.includes('pygmalion.chat');
        const isAICharacterCardsContent = host.includes('aicharactercards.com');
        const isRisu = host.includes('realm.risuai.net');
        const isPerchance = host.includes('perchance.org');
        const isGeneric = isHostWhitelisted(host);

        if (isPygmalionContent) {
            const uuid = getUuidFromUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadPygmalionCharacter(uuid);
        } else if (isJannnyContent) {
            const uuid = getUuidFromUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadJannyCharacter(uuid);
        } else if (isAICharacterCardsContent) {
            const AICCParsed = parseAICC(url);
            if (!AICCParsed) {
                return response.sendStatus(404);
            }
            type = 'character';
            result = await downloadAICCCharacter(AICCParsed);
        } else if (isChub) {
            const chubParsed = parseChubUrl(url);
            type = chubParsed?.type;

            if (chubParsed?.type === 'character') {
                console.info('Downloading chub character:', chubParsed.id);
                result = await downloadChubCharacter(chubParsed.id);
            } else if (chubParsed?.type === 'lorebook') {
                console.info('Downloading chub lorebook:', chubParsed.id);
                result = await downloadChubLorebook(chubParsed.id);
            } else {
                return response.sendStatus(404);
            }
        } else if (isRisu) {
            const uuid = parseRisuUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadRisuCharacter(uuid);
        } else if (isPerchance) {
            const perchanceSlug = parsePerchanceSlug(url);
            if (!perchanceSlug) {
                return response.sendStatus(404);
            }
            type = 'character';
            result = await downloadPerchanceCharacter(perchanceSlug);
        } else if (isGeneric) {
            console.info('Downloading from generic url:', url);
            type = 'character';
            result = await downloadGenericPng(url);
        } else {
            console.error(`Received an import for "${getHostFromUrl(url)}", but site is not whitelisted. This domain must be added to the config key "whitelistImportDomains" to allow import from this source.`);
            return response.sendStatus(404);
        }

        if (!result) {
            return response.sendStatus(404);
        }

        if (result.fileType) response.set('Content-Type', result.fileType);
        response.set('Content-Disposition', `attachment; filename="${encodeURI(result.fileName)}"`);
        response.set('X-Custom-Content-Type', type);
        return response.send(result.buffer);
    } catch (error) {
        console.error('Importing custom content failed', error);
        return response.sendStatus(500);
    }
});

router.post('/importUUID', async (request, response) => {
    if (!request.body.url) {
        return response.sendStatus(400);
    }

    try {
        const uuid = request.body.url;
        let result;

        const isJannny = uuid.includes('_character');
        const isPygmalion = (!isJannny && uuid.length == 36);
        const isAICC = uuid.startsWith('AICC/');
        const isPerchance = isPerchanceUUID(uuid);
        const uuidType = uuid.includes('lorebook') ? 'lorebook' : 'character';

        if (isPygmalion) {
            console.info('Downloading Pygmalion character:', uuid);
            result = await downloadPygmalionCharacter(uuid);
        } else if (isJannny) {
            console.info('Downloading Janitor character:', uuid.split('_')[0]);
            result = await downloadJannyCharacter(uuid.split('_')[0]);
        } else if (isAICC) {
            const [, author, card] = uuid.split('/');
            console.info('Downloading AICC character:', `${author}/${card}`);
            result = await downloadAICCCharacter(`${author}/${card}`);
        } else if (isPerchance) {
            console.info('Downloading Perchance character:', uuid);
            const parsedUuid = parsePerchanceSlug(uuid);
            result = await downloadPerchanceCharacter(parsedUuid);
        } else {
            if (uuidType === 'character') {
                console.info('Downloading chub character:', uuid);
                result = await downloadChubCharacter(uuid);
            } else if (uuidType === 'lorebook') {
                console.info('Downloading chub lorebook:', uuid);
                result = await downloadChubLorebook(uuid);
            } else {
                return response.sendStatus(404);
            }
        }

        if (!result) {
            throw new Error('Failed to download content');
        }

        if (result.fileType) response.set('Content-Type', result.fileType);
        response.set('Content-Disposition', `attachment; filename="${result.fileName}"`);
        response.set('X-Custom-Content-Type', uuidType);
        return response.send(result.buffer);
    } catch (error) {
        console.error('Importing custom content failed', error);
        return response.sendStatus(500);
    }
});
