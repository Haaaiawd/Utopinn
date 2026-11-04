/**
 * card_app manifest — parse/validate/normalize `data.extensions.card_app`.
 *
 * Shape (v1, validated at read time — mount fails loud on errors):
 *
 *   extensions.card_app = {
 *     enabled: boolean,                 // default true when entry/files present
 *     entry: string,                    // relative path; '.html/.htm' → document
 *                                       // entry (served as the panel page),
 *                                       // '.js/.mjs' → ES-module entry (server
 *                                       // synthesizes a shell document, Luker
 *                                       // convention). Default 'index.js'.
 *     files: { [path]: string },        // embedded assets (already extracted at
 *                                       // import; tolerated, not revalidated here)
 *     permissions: {
 *       network: { allowlist: string[] },   // remote URLs the CDN proxy may fetch:
 *                                         // exact 'https://…/x.js' or prefix
 *                                         // 'https://…/dir/*'
 *       stateNamespaces: string[],          // bridge-writable state namespaces
 *       api: string[],                      // declared bridge faces/surfaces
 *                                         // ('ctx' | 'th' | '<face>.<method>')
 *       inlineScript: boolean,              // default true (legacy card docs)
 *       media: boolean,                     // <audio>/<video> media-src
 *       sameOrigin: boolean,                // lifts the opaque-origin sandbox
 *                                         // (weakens isolation; default false)
 *     },
 *     resources: { allowlist: string[] },   // alias → permissions.network.allowlist
 *                                       // (research-doc wording; both merge)
 *   }
 *
 * Boundary rules (TASK-014): remote resources are handled generically — no
 * per-card special-casing in the runtime itself; card code is untrusted and
 * every remote asset crosses the CDN proxy, never direct egress.
 */

const ENTRY_DOC_EXTENSIONS = new Set(['.html', '.htm']);
const ENTRY_MODULE_EXTENSIONS = new Set(['.js', '.mjs']);
const ENTRY_EXTENSIONS = new Set([...ENTRY_DOC_EXTENSIONS, ...ENTRY_MODULE_EXTENSIONS]);

const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const API_FACE_RE = /^(ctx|th)(\.[A-Za-z][A-Za-z0-9_]*)?$/;

/** Paths a card may reference: relative, POSIX separators, no traversal. */
export function isSafeRelativePath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
    if (value.includes('\0') || value.includes('?') || value.includes('#')) return false;
    if (/^[A-Za-z]:/.test(value)) return false;               // drive letter
    const normalized = value.replace(/\\/g, '/');
    if (normalized.startsWith('/')) return false;
    return normalized.split('/').every(seg => seg !== '..' && seg !== '');
}

function extensionOf(filePath) {
    const base = filePath.replace(/\\/g, '/').split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Normalize one allowlist entry.
 * @param {string} raw 'https://host/path/file.js' (exact) or '…/dir/*' (prefix)
 * @returns {{ entry: {kind:'exact'|'prefix', value:string} | null, error: string | null }}
 */
export function normalizeAllowlistEntry(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { entry: null, error: 'allowlist entries must be non-empty strings' };
    }
    const trimmed = raw.trim();
    const star = trimmed.endsWith('*');
    const body = star ? trimmed.slice(0, -1) : trimmed;
    if (body.includes('*')) {
        return { entry: null, error: `wildcard is only allowed as a trailing suffix: ${raw}` };
    }
    let url;
    try {
        url = new URL(body);
    } catch {
        return { entry: null, error: `invalid URL: ${raw}` };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { entry: null, error: `only http/https URLs are allowed: ${raw}` };
    }
    if (url.username || url.password) {
        return { entry: null, error: `credentials in URLs are not allowed: ${raw}` };
    }
    if (!url.hostname) {
        return { entry: null, error: `invalid URL: ${raw}` };
    }
    const value = url.toString();
    return { entry: { kind: star ? 'prefix' : 'exact', value }, error: null };
}

/**
 * Does a normalized allowlist admit this URL?
 * @param {string} url
 * @param {{kind:'exact'|'prefix', value:string}[]} allowlist
 * @returns {boolean}
 */
export function isAdmittedByAllowlist(url, allowlist) {
    return (allowlist || []).some(rule =>
        rule.kind === 'exact' ? url === rule.value : url.startsWith(rule.value));
}

/**
 * Reads `card_app` from a character card (v1 flat, v2/v3 `data` envelope).
 * @param {object} card Parsed card JSON
 * @returns {object|null} The raw card_app object, or null
 */
export function getRawCardApp(card) {
    const data = card?.data && typeof card.data === 'object' ? card.data : card;
    const ext = data?.extensions;
    const cardApp = ext?.card_app;
    return cardApp && typeof cardApp === 'object' ? cardApp : null;
}

/**
 * Parse + validate a card's card_app manifest.
 * @param {object} card Parsed card JSON
 * @returns {{ ok: boolean, errors: string[], warnings: string[], manifest: object|null }}
 *   ok=false whenever errors is non-empty or no card_app exists; manifest is the
 *   normalized view (allowlist rules, permission defaults applied) when parseable.
 */
export function parseCardAppManifest(card) {
    const errors = [];
    const warnings = [];
    const raw = getRawCardApp(card);
    if (!raw) {
        return { ok: false, errors: ['card has no extensions.card_app declaration'], warnings, manifest: null };
    }

    if ('enabled' in raw && typeof raw.enabled !== 'boolean') {
        errors.push('card_app.enabled: must be a boolean');
    }
    const enabled = raw.enabled !== false;

    // ---- entry ----
    let entry = 'index.js';
    if ('entry' in raw) {
        if (typeof raw.entry !== 'string' || !raw.entry.trim()) {
            errors.push('card_app.entry: must be a non-empty string');
        } else {
            entry = raw.entry.trim().replace(/\\/g, '/');
        }
    }
    let entryKind = 'module';
    if (!isSafeRelativePath(entry)) {
        errors.push(`card_app.entry: unsafe path "${entry}" (must be relative, no traversal)`);
    } else {
        const ext = extensionOf(entry);
        if (!ENTRY_EXTENSIONS.has(ext)) {
            errors.push(`card_app.entry: "${entry}" must end in .html/.htm/.js/.mjs`);
        } else {
            entryKind = ENTRY_DOC_EXTENSIONS.has(ext) ? 'document' : 'module';
        }
    }

    // ---- files (tolerated; extraction-time concerns reported as warnings) ----
    if ('files' in raw) {
        if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) {
            errors.push('card_app.files: must be an object map of path → content');
        } else {
            for (const key of Object.keys(raw.files)) {
                if (!isSafeRelativePath(key)) {
                    warnings.push(`card_app.files: skipping unsafe path "${key}"`);
                } else if (typeof raw.files[key] !== 'string') {
                    warnings.push(`card_app.files["${key}"]: content must be a string, skipped`);
                }
            }
        }
    }

    // ---- permissions ----
    const allowlist = [];
    const pushAllowlist = (list, label) => {
        if (list === undefined) return;
        if (!Array.isArray(list)) {
            errors.push(`${label}: must be an array of URLs`);
            return;
        }
        for (const rawEntry of list) {
            const { entry: rule, error } = normalizeAllowlistEntry(rawEntry);
            if (rule) {
                if (!allowlist.some(r => r.kind === rule.kind && r.value === rule.value)) allowlist.push(rule);
            } else {
                errors.push(`${label}: ${error}`);
            }
        }
    };

    const perms = raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : null;
    if (raw.permissions !== undefined && perms === null) {
        errors.push('card_app.permissions: must be an object');
    }
    pushAllowlist(perms?.network?.allowlist, 'card_app.permissions.network.allowlist');
    if (perms?.network !== undefined && (typeof perms.network !== 'object' || perms.network === null)) {
        errors.push('card_app.permissions.network: must be an object');
    }
    // `resources.allowlist` — the research-doc naming — merges into the same list.
    pushAllowlist(raw.resources?.allowlist, 'card_app.resources.allowlist');

    let stateNamespaces = [];
    if (perms?.stateNamespaces !== undefined) {
        if (!Array.isArray(perms.stateNamespaces)) {
            errors.push('card_app.permissions.stateNamespaces: must be an array of namespace strings');
        } else {
            for (const ns of perms.stateNamespaces) {
                if (typeof ns !== 'string' || !NAMESPACE_RE.test(ns)) {
                    errors.push(`card_app.permissions.stateNamespaces: invalid namespace "${ns}"`);
                } else if (!stateNamespaces.includes(ns)) {
                    stateNamespaces.push(ns);
                }
            }
        }
    }

    // 缺省面:th(TH 兼容是生态契约,ctx 面 shim 未立前未声明的卡不该
    // 落进降级徽标)。要 ctx 面的卡显式声明 api:['ctx']。
    let api = ['th'];
    if (perms?.api !== undefined) {
        if (!Array.isArray(perms.api)) {
            errors.push('card_app.permissions.api: must be an array of face/method names');
        } else {
            api = [];
            for (const name of perms.api) {
                if (typeof name !== 'string' || !API_FACE_RE.test(name)) {
                    errors.push(`card_app.permissions.api: invalid surface "${name}" (want 'ctx', 'th', or '<face>.<method>')`);
                } else if (!api.includes(name)) {
                    api.push(name);
                }
            }
        }
    }

    const boolPerm = (key, defaultValue) => {
        const value = perms?.[key];
        if (value === undefined) return defaultValue;
        if (typeof value !== 'boolean') {
            errors.push(`card_app.permissions.${key}: must be a boolean`);
            return defaultValue;
        }
        return value;
    };
    const inlineScript = boolPerm('inlineScript', true);
    const media = boolPerm('media', false);
    const sameOrigin = boolPerm('sameOrigin', false);
    if (sameOrigin) {
        warnings.push('card_app.permissions.sameOrigin: lifts the opaque-origin sandbox — card JS may send credentialed same-origin requests; prefer the default');
    }

    if (perms) {
        const known = new Set(['network', 'stateNamespaces', 'api', 'inlineScript', 'media', 'sameOrigin']);
        for (const key of Object.keys(perms)) {
            if (!known.has(key)) warnings.push(`card_app.permissions.${key}: unknown permission, ignored`);
        }
    }

    const manifest = {
        enabled,
        entry,
        entryKind,
        permissions: {
            network: { allowlist },
            stateNamespaces,
            api,
            inlineScript,
            media,
            sameOrigin,
        },
    };

    return { ok: errors.length === 0, errors, warnings, manifest };
}
