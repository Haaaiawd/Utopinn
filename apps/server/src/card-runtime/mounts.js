/**
 * Mount registry — the capability token at the heart of the card-runtime
 * session posture.
 *
 * A mount is a short-lived, unguessable (128-bit random) id minted by the
 * authenticated `POST /api/card-runtime/mounts` and carried in every public
 * `/card-runtime/m/<id>/…` URL. This is what lets the sandboxed WebView load
 * card code WITHOUT a session cookie:
 *
 *   - host mints a mount with its session+CSRF (normal /api/* call);
 *   - the WebView only ever sees `/card-runtime/m/<id>/` URLs — the mount id
 *     IS the authority, nothing session-scoped is required or consulted;
 *   - even if the WebView somehow holds the session cookie, every
 *     card-runtime route ignores it, and the CSP `sandbox allow-scripts`
 *     keeps the document in an opaque origin so card JS cannot mint new
 *     session-scoped calls with it.
 *
 * Mounts are in-process only (Luker is single-process, same posture as the
 * ws-ticket store). Restart = re-mount, which the host does anyway.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { read as readCharacterCard } from '../character-card-parser.js';
import { resolvePathWithinParent } from '../util.js';
import { getRawCardApp, parseCardAppManifest, isSafeRelativePath } from './manifest.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;   // 6h sliding
const MAX_TTL_MS = 24 * 60 * 60 * 1000;      // 24h
const MIN_TTL_MS = 5 * 60 * 1000;            // 5min
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * @typedef {object} MountRecord
 * @property {string} id 32-hex capability id
 * @property {string} handle owning user handle
 * @property {object} directories user directory snapshot (from mint time)
 * @property {string} charId character id (avatar basename, sanitized)
 * @property {object} manifest normalized card_app manifest
 * @property {string[]} warnings manifest warnings surfaced at mint
 * @property {string} manifestHash sha256 of normalized manifest JSON
 * @property {number} createdAt
 * @property {number} expiresAt sliding expiry — touched on every public request
 * @property {number} ttlMs
 */

/** @type {Map<string, MountRecord>} */
const mounts = new Map();

export class CardRuntimeError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code stable machine-readable code
     * @param {string} message human detail
     * @param {object} [extra] extra JSON fields (e.g. manifest errors)
     */
    constructor(status, code, message, extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

/**
 * Loads a character card by id — mirrors utopinn-generate.loadCharacterCard:
 * PNG metadata first, `<charId>.json` sidecar fallback.
 * @param {object} directories user directories
 * @param {string} charId avatar basename (no .png)
 * @returns {Promise<object|null>} parsed card JSON or null
 */
export async function loadCardData(directories, charId) {
    const dir = directories.characters;
    const pngPath = path.join(dir, `${charId}.png`);
    const jsonPath = path.join(dir, `${charId}.json`);
    try {
        const raw = await fs.promises.readFile(pngPath);
        return JSON.parse(readCharacterCard(raw));
    } catch {
        try {
            const raw = await fs.promises.readFile(jsonPath, 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }
}

/**
 * Per-card asset directory — where card_app.files were extracted at import.
 * @param {object} directories
 * @param {string} charId sanitized
 */
export function cardAppAssetDir(directories, charId) {
    return path.join(directories.cardApps, sanitize(charId));
}

/**
 * Extract `card_app.files` into the asset dir when the dir is missing or empty.
 * Mirrors endpoints/card-app.js extractCardAppFiles semantics but leaves the
 * caller's card object untouched and only runs when there is nothing on disk —
 * files on disk are authoritative once Studio/user edits exist.
 * @param {object} card parsed card JSON
 * @param {object} directories
 * @param {string} charId
 * @returns {boolean} whether assets are present afterwards
 */
export function ensureCardAppAssets(card, directories, charId) {
    const assetDir = cardAppAssetDir(directories, charId);
    if (fs.existsSync(assetDir) && fs.readdirSync(assetDir).some(e => e !== '.git')) {
        return true;
    }
    const files = getRawCardApp(card)?.files;
    if (!files || typeof files !== 'object') {
        return false;
    }
    let wrote = 0;
    for (const [filePath, content] of Object.entries(files)) {
        if (typeof content !== 'string' || !isSafeRelativePath(filePath)) {
            console.warn(`[card-runtime] Skipping unsafe/empty card_app file: ${filePath}`);
            continue;
        }
        const normalized = filePath.replace(/\\/g, '/');
        const resolved = resolvePathWithinParent(assetDir, normalized);
        if (!resolved) continue;
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        const base64 = content.match(/^data:[^;]+;base64,(.+)$/s);
        fs.writeFileSync(resolved, base64 ? Buffer.from(base64[1], 'base64') : content, 'utf8');
        wrote++;
    }
    return wrote > 0 || (fs.existsSync(assetDir) && fs.readdirSync(assetDir).length > 0);
}

/**
 * Resolve a mount-scoped asset path inside the card's asset dir.
 * Rejects traversal and `.git` internals (Studio versioning leaves a repo in
 * the card dir; nothing inside it is meant for the sandbox).
 * @param {MountRecord} mount
 * @param {string} relPath
 * @returns {string|null} absolute path or null
 */
export function resolveAssetPath(mount, relPath) {
    const assetDir = cardAppAssetDir(mount.directories, mount.charId);
    const normalized = String(relPath || '').replace(/\\/g, '/');
    if (normalized.split('/').some(seg => seg === '.git')) return null;
    return resolvePathWithinParent(assetDir, normalized);
}

/**
 * Does the resolved entry file exist on disk?
 * @param {MountRecord} mount
 */
export function entryFileExists(mount) {
    const resolved = resolveAssetPath(mount, mount.manifest.entry);
    return !!resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile();
}

/**
 * Mint a mount for a card's card_app.
 * @param {object} opts
 * @param {string} opts.handle user handle (mount owner)
 * @param {object} opts.directories user directory snapshot
 * @param {string} opts.charId character id (avatar basename)
 * @param {number} [opts.ttlMs] sliding idle TTL, clamped to [5min, 24h]
 * @returns {Promise<MountRecord>}
 * @throws {CardRuntimeError}
 */
export async function createMount({ handle, directories, charId, ttlMs, chatName }) {
    const cleanId = sanitize(String(charId ?? '').trim());
    if (!cleanId) throw new CardRuntimeError(400, 'bad_char_id', 'charId is required');

    // Constrain to the characters dir (same confinement as characters.js).
    const avatarPath = path.join(directories.characters, `${cleanId}.png`);
    const jsonPath = path.join(directories.characters, `${cleanId}.json`);
    if (path.dirname(avatarPath) !== directories.characters) {
        throw new CardRuntimeError(400, 'bad_char_id', 'charId must be a character filename');
    }
    if (!fs.existsSync(avatarPath) && !fs.existsSync(jsonPath)) {
        throw new CardRuntimeError(404, 'character_not_found', `Character not found: ${cleanId}`);
    }

    const card = await loadCardData(directories, cleanId);
    if (!card) {
        throw new CardRuntimeError(404, 'character_not_found', `Character not found: ${cleanId}`);
    }
    if (!getRawCardApp(card)) {
        throw new CardRuntimeError(404, 'no_card_app', `Character ${cleanId} declares no card_app`);
    }
    const { ok, errors, warnings, manifest } = parseCardAppManifest(card);
    if (!ok) {
        throw new CardRuntimeError(422, 'invalid_card_app_manifest', 'card_app manifest failed validation', { errors, warnings });
    }
    if (!manifest.enabled) {
        throw new CardRuntimeError(409, 'card_app_disabled', `card_app is disabled for ${cleanId}`);
    }
    if (!ensureCardAppAssets(card, directories, cleanId)) {
        throw new CardRuntimeError(404, 'card_app_assets_missing', `No card_app assets on disk for ${cleanId} and the card embeds none`);
    }

    const record = {
        id: crypto.randomBytes(16).toString('hex'),
        handle: String(handle || ''),
        directories,
        charId: cleanId,
        // ctx face seeds: chat the host bound this mount to (no .jsonl) —
        // feeds PanelBootstrap.chatName → ctx.getChatId/lukerContext.chatId.
        chatName: typeof chatName === 'string' && chatName.trim() ? chatName.trim() : null,
        manifest,
        bridgeNonce: crypto.randomBytes(16).toString('hex'),
        warnings,
        manifestHash: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 32),
        createdAt: Date.now(),
        expiresAt: 0,
        ttlMs: Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS)),
    };
    if (!entryFileExists(record)) {
        throw new CardRuntimeError(404, 'entry_not_found', `card_app entry "${manifest.entry}" not found in extracted assets`);
    }
    record.expiresAt = record.createdAt + record.ttlMs;
    mounts.set(record.id, record);
    return record;
}

/**
 * Mint a mount for a TH「前端界面」楼层 iframe (displayed_message 面, TASK-049)。
 * 与 createMount 同能力模型(128-bit id = 授权本身),但载荷不是卡资产而是
 * 宿主随 mount 注册的整份 HTML 文档(TH 卡写进楼层正文的前端块)——
 * 楼层 iframe 的文档在 mount 里而非卡目录里。
 * @param {object} opts
 * @param {string} opts.handle user handle
 * @param {object} opts.directories user directory snapshot
 * @param {string} opts.charId character id (mount 属主,决定桥 target)
 * @param {string} [opts.chatName] bound chat (TH 桥 target.chatName)
 * @param {string} opts.doc fully assembled HTML document (shell-wrapped by caller)
 * @param {number} [opts.ttlMs]
 */
export function createDocMount({ handle, directories, charId, chatName, doc, ttlMs }) {
    const cleanId = sanitize(String(charId ?? '').trim());
    if (!cleanId) throw new CardRuntimeError(400, 'bad_char_id', 'charId is required');
    if (typeof doc !== 'string' || !doc.trim()) {
        throw new CardRuntimeError(400, 'bad_doc', 'doc (assembled HTML) is required');
    }
    if (doc.length > 1024 * 1024) {
        throw new CardRuntimeError(413, 'doc_too_large', 'doc exceeds 1MiB');
    }
    const avatarPath = path.join(directories.characters, `${cleanId}.png`);
    const jsonPath = path.join(directories.characters, `${cleanId}.json`);
    if (path.dirname(avatarPath) !== directories.characters) {
        throw new CardRuntimeError(400, 'bad_char_id', 'charId must be a character filename');
    }
    if (!fs.existsSync(avatarPath) && !fs.existsSync(jsonPath)) {
        throw new CardRuntimeError(404, 'character_not_found', `Character not found: ${cleanId}`);
    }

    const record = {
        id: crypto.randomBytes(16).toString('hex'),
        handle: String(handle || ''),
        directories,
        charId: cleanId,
        chatName: typeof chatName === 'string' && chatName.trim() ? chatName.trim() : null,
        kind: 'message',
        doc,
        // 合成 manifest:'__message__' 是楼层帧占位符(bootstrapTag 下发,
        // shim 据此判 IS_FLOOR_FRAME)。授权面注:manifest api:['th'] 仅为
        // 形态标 —— 楼层块是模型产出,宿主实际桥面是 MSGFRAME 只读子集
        // (web MessageIframe/mobile MessageFrame 各自闸,不读本字段);
        // sameOrigin 恒 false(楼层文档从不提权)。
        manifest: {
            entry: '__message__',
            entryKind: 'document',
            permissions: { api: ['th'], sameOrigin: false, stateNamespaces: [] },
        },
        bridgeNonce: crypto.randomBytes(16).toString('hex'),
        warnings: [],
        manifestHash: crypto.createHash('sha256').update(doc).digest('hex').slice(0, 32),
        createdAt: Date.now(),
        expiresAt: 0,
        ttlMs: Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS)),
    };
    record.expiresAt = record.createdAt + record.ttlMs;
    mounts.set(record.id, record);
    return record;
}

const MOUNT_ID_RE = /^[a-f0-9]{32}$/;

/**
 * Look up a mount and slide its expiry. Returns null on unknown/expired ids —
 * callers answer a uniform 404 (id validity is not disclosed).
 * @param {string} id
 * @returns {MountRecord|null}
 */
export function resolveMount(id) {
    if (!MOUNT_ID_RE.test(String(id || ''))) return null;
    const record = mounts.get(id);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
        mounts.delete(id);
        return null;
    }
    record.expiresAt = Date.now() + record.ttlMs;
    return record;
}

/**
 * Revoke a mount. Owner-scoped at the API layer.
 * @param {string} id
 * @returns {boolean}
 */
export function revokeMount(id) {
    return mounts.delete(id);
}

/**
 * List mounts, optionally filtered by owner handle.
 * @param {string} [handle]
 * @returns {object[]} public-facing mount summaries
 */
export function listMounts(handle) {
    const now = Date.now();
    const out = [];
    for (const record of mounts.values()) {
        if (record.expiresAt <= now) continue;
        if (handle !== undefined && record.handle !== handle) continue;
        out.push(publicMount(record));
    }
    return out;
}

/**
 * The mount summary handed to hosts (never the raw record — directories hold
 * absolute paths card JS doesn't need).
 * @param {MountRecord} record
 */
export function publicMount(record) {
    const base = `/card-runtime/m/${record.id}/`;
    // message mount 的文档由 entryHandler 直接出 mount.doc,entryUrl = 根路径。
    const entryUrl = record.kind === 'message'
        ? base
        : record.manifest.entryKind === 'document'
            ? `${base}${record.manifest.entry}`
            : base;
    return {
        mountId: record.id,
        charId: record.charId,
        chatName: record.chatName ?? null,
        entryKind: record.manifest.entryKind,
        entry: record.manifest.entry,
        entryUrl,
        assetBaseUrl: base,
        cdnUrl: `${base}cdn`,
        shimUrl: '/card-runtime/shim/t0.js',
        ctxShimUrl: '/card-runtime/shim/ctx.js',
        bridgeNonce: record.bridgeNonce,
        manifest: record.manifest,
        warnings: record.warnings,
        manifestHash: record.manifestHash,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [id, record] of mounts) {
        if (now > record.expiresAt) mounts.delete(id);
    }
}, CLEANUP_INTERVAL_MS).unref();

/** Test hooks — drive the registry without HTTP. */
export const __cardRuntimeTestUtils = {
    createMount,
    resolveMount,
    revokeMount,
    clear: () => mounts.clear(),
    size: () => mounts.size,
    forceExpire: (id) => {
        const record = mounts.get(id);
        if (record) record.expiresAt = 0;
    },
};
