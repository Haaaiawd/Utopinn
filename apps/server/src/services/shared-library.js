/**
 * shared-library — instance-level shared character pool (form A:
 * read-only pool + copy-on-write).
 *
 * `<dataRoot>/_library/characters/` holds shared cards (PNG/webp/JSON,
 * single-file cards, flat layout — no recursion). Same placement style as
 * `_shared/secrets.json`: outside every user root, so it can never leak
 * into per-user backup / settings doc / sync surfaces.
 *
 * Semantics (decided in the research writeup):
 *   - Merged reads: card list/detail/generation/state-sidecar reads see
 *     "user-private dir ∪ _library"; on same-stem conflicts the private
 *     card wins — private cards naturally shadow shared ones.
 *   - Edit-to-materialize: any write against a shared card (PATCH /
 *     scoped regex write / explicit install) first copies the whole card
 *     into the user's characters dir, then proceeds as a private card;
 *     shared files are never modified in place.
 *   - Red lines: chats/variables/secrets/jobs/CardApp runtime state stay
 *     per-user forever; the write anchor (resolveCharacterWriteAnchor)
 *     returns a synthesized user-dir path for shared cards so no sidecar
 *     or state write can ever land inside _library.
 *
 * Guards: charDir traversal checks ('.', '..', separators, NUL), the
 * `_library` reserved stem (case-insensitive — a pool file named
 * `_library.*` is not addressable either), symlink confinement
 * (realpath must stay inside the pool root), and `.state.*.json`
 * sidecar-name exclusion (sidecars are never cards).
 */

import fs from 'node:fs';
import path from 'node:path';

import { read as readCharacterCard } from '../character-card-parser.js';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import {
    CHARACTER_FILE_EXTS,
    getCharacterStateSidecarPath,
    isCharacterStateSidecarFileName,
    readCharacterStateSidecar,
    resolveCharacterFilePath,
} from './character-state.js';
import { ensureEmbeddedWorld } from './embedded-world.js';

/** Shared pool root directory name (instance-level, not per-user). */
export const SHARED_LIBRARY_DIRNAME = '_library';
/** Shared card subdirectory (leaves room for worlds/presets pools later). */
export const SHARED_CHARACTERS_SUBDIR = 'characters';

/**
 * `<dataRoot>/_library/characters`.
 * When DATA_ROOT is unset (pure unit tests) it is derived from
 * `directories.root` (`<dataRoot>/<handle>`); if neither exists → null and
 * the shared layer always misses (same strategy as getSharedSecretsRoot).
 * @param {import('../users.js').UserDirectoryList} [directories]
 * @returns {string|null}
 */
export function getSharedCharactersDir(directories) {
    const dataRoot = globalThis.DATA_ROOT
        || (typeof directories?.root === 'string' && directories.root ? path.dirname(directories.root) : '');
    return dataRoot ? path.join(dataRoot, SHARED_LIBRARY_DIRNAME, SHARED_CHARACTERS_SUBDIR) : null;
}

/**
 * Valid pool stem: basic shape (non-empty, not '.', '..', no separators or
 * NUL) + reserved-name gate. `_library` can never be addressed as a
 * charDir — that would address the pool dir itself; case-insensitive to
 * catch case-variant bypasses on case-insensitive filesystems.
 */
export function isSafeSharedStem(charDir) {
    const stem = String(charDir ?? '').trim();
    if (!stem || stem === '.' || stem === '..' || /[/\\\x00]/.test(stem)) return false;
    return stem.toLowerCase() !== SHARED_LIBRARY_DIRNAME;
}

/**
 * Symlink confinement: resolve both paths through realpath and require the
 * target to stay inside the base dir. Returns the canonical target path or
 * null (missing file, escape attempt, or broken link). A symlink in the
 * pool pointing outside would otherwise let read surfaces (static route,
 * thumbnails, doc loaders) serve arbitrary filesystem content — CWE-59.
 * Windows junctions resolve through realpath the same way.
 * @param {string} dir base directory the target must stay under
 * @param {string} candidate already-existence-checked absolute path
 * @returns {string|null} canonical absolute path inside dir
 */
function confineRealPath(dir, candidate) {
    try {
        const realRoot = fs.realpathSync(dir);
        const realTarget = fs.realpathSync(candidate);
        if (realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)) {
            return realTarget;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Address a card file inside the shared pool: stem guard +
 * .png/.webp/.json probe order (same as the private face) evaluated
 * per-candidate — a rejected candidate (escaping symlink / sidecar name)
 * falls through to the next extension instead of voiding the stem, so a
 * bad `Atlas.png` cannot hide a valid `Atlas.json`. filePath is the
 * canonical realpath; fileName/ext stay lexical so the reported stem
 * matches what the user sees.
 * @returns {{filePath:string, fileName:string, ext:string, size:number, mtimeMs:number}|null}
 */
export function resolveSharedCharacterFile(directories, charDir) {
    const dir = getSharedCharactersDir(directories);
    if (!dir || !isSafeSharedStem(charDir)) return null;
    for (const ext of CHARACTER_FILE_EXTS) {
        const fileName = `${charDir}${ext}`;
        // `.state.*.json` is a sidecar, never a card.
        if (isCharacterStateSidecarFileName(fileName)) continue;
        const lexical = path.join(dir, fileName);
        if (!fs.existsSync(lexical)) continue;
        // Out-of-pool symlink → skip this candidate, keep probing.
        const filePath = confineRealPath(dir, lexical);
        if (!filePath) continue;
        let stat;
        try { stat = fs.statSync(filePath); } catch { stat = null; }
        return {
            filePath,
            fileName,
            ext,
            size: stat?.size ?? 0,
            mtimeMs: stat?.mtimeMs ?? 0,
        };
    }
    return null;
}

/**
 * Merged addressing: private characters first (same-stem shadow), then the
 * shared pool.
 * @returns {{filePath:string, fileName:string, ext:string, size:number, mtimeMs:number, shared:boolean}|null}
 */
export function resolveCharacterFileMerged(directories, charDir) {
    const privatePath = resolveCharacterFilePath(directories?.characters, charDir);
    if (privatePath) {
        let stat;
        try { stat = fs.statSync(privatePath); } catch { stat = null; }
        return {
            filePath: privatePath,
            fileName: path.basename(privatePath),
            ext: path.extname(privatePath).toLowerCase(),
            size: stat?.size ?? 0,
            mtimeMs: stat?.mtimeMs ?? 0,
            shared: false,
        };
    }
    const shared = resolveSharedCharacterFile(directories, charDir);
    return shared ? { ...shared, shared: true } : null;
}

/**
 * Safe path for an arbitrary file inside the shared pool (fallback for
 * thumbnails / the static characters route). Same traversal guards as
 * resolveCharacterFilePath plus realpath confinement, so pool symlinks can
 * never serve content outside the pool. `_library` stems are rejected the
 * same as isSafeSharedStem.
 * @param {string} fileName file name (may contain subdirs for future
 *   layouts; v1 pool is flat so callers pass single file names)
 * @returns {string|null} canonical absolute path if it exists in-pool
 */
export function resolveSharedLibraryFilePath(directories, fileName) {
    const dir = getSharedCharactersDir(directories);
    if (!dir) return null;
    const name = String(fileName ?? '').trim();
    if (!name || name === '.' || name === '..' || /[\x00]/.test(name)) return null;
    const resolved = path.resolve(path.join(dir, name));
    const resolvedRoot = path.resolve(dir);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
    const stem = path.parse(name).name;
    if (stem.toLowerCase() === SHARED_LIBRARY_DIRNAME) return null;
    if (!fs.existsSync(resolved)) return null;
    return confineRealPath(dir, resolved);
}

/**
 * Single-directory card parse: `<charDir>.png` (or .webp) first, then
 * `<charDir>.json`. Same probe order as utopinn-library's original
 * loadCharacterDocDetailed — this is that logic parameterized by dir.
 * @param {string} dir card directory absolute path
 * @param {string} charDir
 * @returns {Promise<{card: object|null, source: {kind:'image', filePath:string, ext:string}|{kind:'json', filePath:string}|null}>}
 */
export async function loadCharacterDocFromDir(dir, charDir) {
    if (typeof dir !== 'string' || !dir) return { card: null, source: null };
    for (const ext of ['.png', '.webp']) {
        const filePath = path.join(dir, `${charDir}${ext}`);
        try {
            const raw = await fs.promises.readFile(filePath);
            return { card: JSON.parse(readCharacterCard(raw)), source: { kind: 'image', filePath, ext } };
        } catch {
            // ext missing or file carries no card data → next candidate
        }
    }
    try {
        const filePath = path.join(dir, `${charDir}.json`);
        const raw = await fs.promises.readFile(filePath, 'utf8');
        return { card: JSON.parse(raw), source: { kind: 'json', filePath } };
    } catch {
        return { card: null, source: null };
    }
}

/**
 * Confined pool-dir card parse: same probe order as loadCharacterDocFromDir
 * but every candidate must realpath inside the pool root — a pool symlink
 * pointing outside must not be parsed and served as card content.
 * @returns {Promise<{card: object|null, source: object|null}>}
 */
export async function loadSharedCharacterDoc(directories, charDir) {
    const dir = getSharedCharactersDir(directories);
    if (!dir || !isSafeSharedStem(charDir)) return { card: null, source: null };
    for (const ext of ['.png', '.webp']) {
        const lexical = path.join(dir, `${charDir}${ext}`);
        const filePath = fs.existsSync(lexical) ? confineRealPath(dir, lexical) : null;
        if (!filePath) continue;
        try {
            const raw = await fs.promises.readFile(filePath);
            return { card: JSON.parse(readCharacterCard(raw)), source: { kind: 'image', filePath, ext } };
        } catch {
            // no card data → next candidate
        }
    }
    const lexicalJson = path.join(dir, `${charDir}.json`);
    const jsonPath = fs.existsSync(lexicalJson) ? confineRealPath(dir, lexicalJson) : null;
    if (!jsonPath) return { card: null, source: null };
    try {
        const raw = await fs.promises.readFile(jsonPath, 'utf8');
        return { card: JSON.parse(raw), source: { kind: 'json', filePath: jsonPath } };
    } catch {
        return { card: null, source: null };
    }
}

/**
 * Merged card read: any private card file present → private source (a
 * private file that fails to parse does NOT fall back to shared — same-stem
 * shadowing is file-level, not "borrow the shared copy when private is
 * broken").
 * 本函数是卡读的唯一漏斗(library/generate/chats/mounts/stscript 全过
 * 这里)—— 顺手跑 ensureEmbeddedWorld 首见自愈:带 character_book 但
 * extensions.world 缺绑的卡(种子 cpSync/LAN 迁移/sync 落盘/旧导入
 * 存量)物化 worlds/<派生名> 并把绑定写回卡面;共享池卡只读,物化
 * 照做、绑定只落在返回对象内存态。自愈内部全 try,不抛。
 * @returns {Promise<{card: object|null, source: object|null, shared: boolean}>}
 */
export async function loadCharacterDocMerged(directories, charDir) {
    if (resolveCharacterFilePath(directories?.characters, charDir)) {
        const doc = await loadCharacterDocFromDir(directories.characters, charDir);
        await ensureEmbeddedWorld(directories, charDir, { ...doc, shared: false });
        return { ...doc, shared: false };
    }
    if (!isSafeSharedStem(charDir)) return { card: null, source: null, shared: false };
    const libDir = getSharedCharactersDir(directories);
    if (!libDir || !resolveSharedCharacterFile(directories, charDir)) {
        return { card: null, source: null, shared: false };
    }
    const doc = await loadSharedCharacterDoc(directories, charDir);
    await ensureEmbeddedWorld(directories, charDir, { ...doc, shared: true });
    return { ...doc, shared: true };
}

/**
 * Does the parsed object look like a character card? Materialization uses
 * this as a publishable gate — a `.state.*.json` sidecar body, an empty
 * object, or a bare cover PNG must never be materialized into the user's
 * library as a "card".
 */
function isCharacterCardLike(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
    if (card.data && typeof card.data === 'object' && !Array.isArray(card.data)) return true;
    return typeof card.name === 'string'
        || typeof card.description === 'string'
        || typeof card.first_mes === 'string';
}

/**
 * Estimated byte footprint of materializing `charDir` — mirrors the
 * materialize copy plan exactly so quota enforcement never over- or
 * under-counts:
 *   - stem-sibling card files: every confined candidate that will be copied;
 *   - `.state.*.json` publish sidecars: only when the landing stem stays
 *     `charDir` (the migration gate) AND the user does not already have a
 *     same-named sidecar (COPYFILE_EXCL means it would be skipped anyway).
 * @returns {number} bytes (0 when nothing would be copied)
 */
export function estimateSharedMaterializeBytes(directories, charDir) {
    const libDir = getSharedCharactersDir(directories);
    if (!libDir || !isSafeSharedStem(charDir)) return 0;
    const userDir = directories?.characters;
    let total = 0;
    const addFile = (filePath) => {
        try { total += fs.statSync(filePath).size || 0; } catch { /* race/absent → 0 */ }
    };
    for (const ext of CHARACTER_FILE_EXTS) {
        const name = `${charDir}${ext}`;
        if (isCharacterStateSidecarFileName(name)) continue;
        const lexical = path.join(libDir, name);
        if (!fs.existsSync(lexical)) continue;
        const real = confineRealPath(libDir, lexical);
        if (!real) continue; // escaping symlink is never copied
        addFile(real);
    }
    // Same landing-stem deconfliction as materializeSharedCharacter.
    let stem = charDir;
    for (let i = 1; userDir && resolveCharacterFilePath(userDir, stem); i++) {
        stem = `${charDir}${i}`;
    }
    if (stem !== charDir || !userDir) return total;
    const prefix = `${charDir}.state.`;
    let entries = [];
    try { entries = fs.readdirSync(libDir); } catch { entries = []; }
    for (const name of entries) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        // COPYFILE_EXCL — an existing user sidecar is never overwritten,
        // so it must not inflate the estimate.
        if (fs.existsSync(path.join(userDir, name))) continue;
        const real = confineRealPath(libDir, path.join(libDir, name));
        if (!real) continue;
        addFile(real);
    }
    return total;
}

/**
 * Materialize: copy the whole shared card into the user's characters dir
 * (the copy-on-write landing point).
 *   - All stem-sibling card files are copied (`Foo.png` may be a pure cover
 *     image while `Foo.json` carries the card — copying only the resolved
 *     .png would shadow the readable .json and produce an unreadable card).
 *   - The target stem is only deconflicted at the *private card file*
 *     level (any of .png/.webp/.json present = collision); chats/<stem>
 *     does not block — those conversations already belong to this card
 *     and should stay attached to the same stem after materialization.
 *   - Every copied source must realpath inside the pool (symlink
 *     confinement); after copying, the materialized set must parse back as
 *     a card — otherwise the copies are rolled back and the call fails.
 *   - `<stem>.state.*.json` publish sidecars migrate alongside (never
 *     overwriting existing user sidecars): after materialization the card
 *     is private and merged reads no longer fall back to the pool, so the
 *     publisher's initial state would otherwise be lost.
 *   - Extension is preserved (.webp stays .webp — no transcode).
 * @returns {Promise<{charDir:string, fileName:string, filePath:string, source:object}>}
 * @throws {NotFoundError} shared card does not exist
 * @throws {InvalidArgumentError} materialized copy would not be a readable card
 */
export async function materializeSharedCharacter(directories, charDir) {
    const libDir = getSharedCharactersDir(directories);
    const shared = resolveSharedCharacterFile(directories, charDir);
    if (!shared || !libDir) {
        throw new NotFoundError(`Shared character not found: ${charDir}`);
    }
    await fs.promises.mkdir(directories.characters, { recursive: true });

    // Collect every pool file participating in this stem's card view —
    // cover-only images and the data-carrying file all migrate together so
    // the private mirror reads exactly like the shared source did.
    const sources = [];
    for (const ext of CHARACTER_FILE_EXTS) {
        const name = `${charDir}${ext}`;
        const lexical = path.join(libDir, name);
        if (!fs.existsSync(lexical)) continue;
        const real = confineRealPath(libDir, lexical);
        if (!real) continue; // out-of-pool symlink → never readable, never copied
        sources.push({ ext, fileName: name, filePath: real });
    }

    let stem = charDir;
    for (let i = 1; resolveCharacterFilePath(directories.characters, stem); i++) {
        stem = `${charDir}${i}`;
    }

    const copied = [];
    try {
        for (const src of sources) {
            const dest = path.join(directories.characters, `${stem}${src.ext}`);
            await fs.promises.copyFile(src.filePath, dest, fs.constants.COPYFILE_EXCL);
            copied.push(dest);
        }
        // Publishable gate: the private copy must parse back as a card.
        // A cover-only PNG or a non-card JSON must not ship a broken copy.
        const { card } = await loadCharacterDocFromDir(directories.characters, stem);
        if (!isCharacterCardLike(card)) {
            throw new InvalidArgumentError(`Shared character is not a readable card: ${charDir}`);
        }
    } catch (error) {
        for (const dest of copied) {
            await fs.promises.rm(dest, { force: true }).catch(() => {});
        }
        throw error;
    }

    // Publish sidecar migration: `<stem>.state.<ns>.json`; on name collision
    // (user already has a same-stem sidecar) the user file wins — no overwrite.
    if (stem === charDir) {
        const prefix = `${charDir}.state.`;
        let entries = [];
        try { entries = await fs.promises.readdir(libDir, { withFileTypes: true }); } catch { /* pool unreadable → skip */ }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
            const sourcePath = path.join(libDir, entry.name);
            const targetPath = path.join(directories.characters, entry.name);
            try {
                const real = confineRealPath(libDir, sourcePath);
                if (!real) continue;
                await fs.promises.copyFile(real, targetPath, fs.constants.COPYFILE_EXCL);
            } catch { /* exists/failed does not block materialization — the card file is the source of truth */ }
        }
    }
    return { charDir: stem, fileName: `${stem}${shared.ext}`, filePath: path.join(directories.characters, `${stem}${shared.ext}`), source: shared };
}

/**
 * Write anchor for surfaces like char_state sidecars that are named by
 * stem and must land per-user. The returned filePath only feeds
 * getCharacterStateSidecarPath's dir+stem extraction —
 *   private card present → real file;
 *   shared-only → synthesized user-dir path (file need not exist; the
 *   sidecar name only takes the stem);
 *   neither → null (callers treat as "card not found").
 * NEVER returns a _library path — shared files are not writable.
 */
export function resolveCharacterWriteAnchor(directories, charDir) {
    const privatePath = resolveCharacterFilePath(directories?.characters, charDir);
    if (privatePath) return privatePath;
    const shared = resolveSharedCharacterFile(directories, charDir);
    if (!shared) return null;
    return path.join(directories.characters, shared.fileName);
}

/**
 * Merged char_state sidecar read: the user-dir sidecar always wins (the
 * user's own state trumps everything). The shared/published sidecar is
 * only consulted when the resolved card itself is shared — a private card
 * that shadows the pool stem must never inherit pool state, even when no
 * user sidecar exists for the namespace.
 * @param {string} charDir card stem (callers with an avatar file name strip
 *   the extension first)
 * @param {string} namespace already-normalized ns
 * @returns {object|null}
 */
export function readCharacterStateMerged(directories, charDir, namespace) {
    const stem = String(charDir ?? '').trim();
    if (!stem) return null;
    // Stem anchor is enough — the sidecar name only takes the stem, so a
    // synthesized .png anchor is equivalent to the real file.
    const userAnchor = path.join(directories.characters, `${stem}.png`);
    const own = readCharacterStateSidecar(userAnchor, namespace);
    if (own != null) return own;
    const merged = resolveCharacterFileMerged(directories, stem);
    if (!merged?.shared) return null;
    // Published sidecar identity = the *request stem*, not the resolved
    // realpath — an in-pool alias (Alias.png → Original.png) must read
    // `Alias.state.<ns>.json`, the same stem materialization migrates.
    const libDir = getSharedCharactersDir(directories);
    if (!libDir) return null;
    const poolAnchor = path.join(libDir, `${stem}.png`);
    const sidecarPath = getCharacterStateSidecarPath(poolAnchor, namespace);
    // Sidecar file itself must stay inside the pool (symlink guard).
    if (!sidecarPath || !confineRealPath(libDir, sidecarPath)) return null;
    return readCharacterStateSidecar(poolAnchor, namespace);
}
