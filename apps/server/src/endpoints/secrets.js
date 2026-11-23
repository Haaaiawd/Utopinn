// compat 面:harness/legacy UI 专用,产品调用走 /api/utopinn/*(收敛方案 .skeinn/design/legacy-convergence.md,TASK-035)。
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { color, getConfigValue, uuidv4 } from '../util.js';

export const SECRETS_FILE = 'secrets.json';
export const SECRET_KEYS = {
    _MIGRATED: '_migrated',
    HORDE: 'api_key_horde',
    MANCER: 'api_key_mancer',
    VLLM: 'api_key_vllm',
    APHRODITE: 'api_key_aphrodite',
    TABBY: 'api_key_tabby',
    OPENAI: 'api_key_openai',
    NOVEL: 'api_key_novel',
    CLAUDE: 'api_key_claude',
    DEEPL: 'deepl',
    LIBRE: 'libre',
    LIBRE_URL: 'libre_url',
    LINGVA_URL: 'lingva_url',
    OPENROUTER: 'api_key_openrouter',
    AI21: 'api_key_ai21',
    ONERING_URL: 'oneringtranslator_url',
    DEEPLX_URL: 'deeplx_url',
    MAKERSUITE: 'api_key_makersuite',
    VERTEXAI: 'api_key_vertexai',
    SERPAPI: 'api_key_serpapi',
    TOGETHERAI: 'api_key_togetherai',
    MISTRALAI: 'api_key_mistralai',
    CUSTOM: 'api_key_custom',
    OPENAI_RESPONSES: 'api_key_openai_responses',
    OOBA: 'api_key_ooba',
    INFERMATICAI: 'api_key_infermaticai',
    DREAMGEN: 'api_key_dreamgen',
    NOMICAI: 'api_key_nomicai',
    KOBOLDCPP: 'api_key_koboldcpp',
    LLAMACPP: 'api_key_llamacpp',
    COHERE: 'api_key_cohere',
    JINA: 'api_key_jina',
    PERPLEXITY: 'api_key_perplexity',
    GROQ: 'api_key_groq',
    AZURE_TTS: 'api_key_azure_tts',
    FEATHERLESS: 'api_key_featherless',
    HUGGINGFACE: 'api_key_huggingface',
    STABILITY: 'api_key_stability',
    CUSTOM_OPENAI_TTS: 'api_key_custom_openai_tts',
    TAVILY: 'api_key_tavily',
    CHUTES: 'api_key_chutes',
    ELECTRONHUB: 'api_key_electronhub',
    NANOGPT: 'api_key_nanogpt',
    BFL: 'api_key_bfl',
    COMFY_RUNPOD: 'api_key_comfy_runpod',
    FALAI: 'api_key_falai',
    GENERIC: 'api_key_generic',
    DEEPSEEK: 'api_key_deepseek',
    SERPER: 'api_key_serper',
    BRAVE_SEARCH: 'api_key_brave_search',
    EXA: 'api_key_exa',
    AIMLAPI: 'api_key_aimlapi',
    XAI: 'api_key_xai',
    FIREWORKS: 'api_key_fireworks',
    VERTEXAI_SERVICE_ACCOUNT: 'vertexai_service_account_json',
    MINIMAX: 'api_key_minimax',
    MINIMAX_GROUP_ID: 'minimax_group_id',
    MOONSHOT: 'api_key_moonshot',
    COMETAPI: 'api_key_cometapi',
    AZURE_OPENAI: 'api_key_azure_openai',
    ZAI: 'api_key_zai',
    SILICONFLOW: 'api_key_siliconflow',
    ELEVENLABS: 'api_key_elevenlabs',
    POLLINATIONS: 'api_key_pollinations',
    VOLCENGINE_APP_ID: 'volcengine_app_id',
    VOLCENGINE_ACCESS_KEY: 'volcengine_access_key',
    WORKERS_AI: 'api_key_workers_ai',
};

/**
 * @typedef {object} SecretValue
 * @property {string} id The unique identifier for the secret
 * @property {string} value The secret value
 * @property {string} label The label for the secret
 * @property {boolean} active Whether the secret is currently active
 */

/**
 * @typedef {object} SecretState
 * @property {string} id The unique identifier for the secret
 * @property {string} value The secret value, masked for security
 * @property {string} label The label for the secret
 * @property {boolean} active Whether the secret is currently active
 */

/**
 * @typedef {Record<string, SecretState[]|null>} SecretStateMap
 */

/**
 * @typedef {{[key: string]: SecretValue[]}} SecretKeys
 * @typedef {{[key: string]: string}} FlatSecretKeys
 */

// These are the keys that are safe to expose, even if allowKeysExposure is false
const EXPORTABLE_KEYS = [
    SECRET_KEYS.LIBRE_URL,
    SECRET_KEYS.LINGVA_URL,
    SECRET_KEYS.ONERING_URL,
    SECRET_KEYS.DEEPLX_URL,
];

export const allowKeysExposure = !!getConfigValue('allowKeysExposure', false, 'boolean');

/**
 * SecretManager class to handle all secret operations
 */
export class SecretManager {
    /**
     * @param {import('../users.js').UserDirectoryList} directories
     */
    constructor(directories) {
        this.directories = directories;
        this.filePath = path.join(directories.root, SECRETS_FILE);
        this.defaultSecrets = {};
    }

    /**
     * Ensures the secrets file exists, creating an empty one if necessary
     * @private
     */
    _ensureSecretsFile() {
        if (!fs.existsSync(this.filePath)) {
            writeFileAtomicSync(this.filePath, JSON.stringify(this.defaultSecrets), 'utf-8');
        }
    }

    /**
     * Reads and parses the secrets file
     * @private
     * @returns {SecretKeys}
     */
    _readSecretsFile() {
        this._ensureSecretsFile();
        const fileContents = fs.readFileSync(this.filePath, 'utf-8');
        return /** @type {SecretKeys} */ (JSON.parse(fileContents));
    }

    /**
     * Writes secrets to the file atomically
     * @private
     * @param {SecretKeys} secrets
     */
    _writeSecretsFile(secrets) {
        writeFileAtomicSync(this.filePath, JSON.stringify(secrets, null, 4), 'utf-8');
    }

    /**
     * Deactivates all secrets for a given key
     * @private
     * @param {SecretValue[]} secretArray
     */
    _deactivateAllSecrets(secretArray) {
        secretArray.forEach(secret => {
            secret.active = false;
        });
    }

    /**
     * Validates that the secret key exists and has valid structure
     * @private
     * @param {SecretKeys} secrets
     * @param {string} key
     * @returns {boolean}
     */
    _validateSecretKey(secrets, key) {
        return Object.hasOwn(secrets, key) && Array.isArray(secrets[key]);
    }

    /**
     * Masks a secret value with asterisks in the middle
     * @param {string} value The secret value to mask
     * @param {string} key The secret key
     * @returns {string} A masked version of the value for peeking
     */
    getMaskedValue(value, key) {
        // No masking if exposure is allowed
        if (allowKeysExposure || EXPORTABLE_KEYS.includes(key)) {
            return value;
        }
        const threshold = 10;
        const exposedChars = 3;
        const placeholder = '*';
        if (value.length <= threshold) {
            return placeholder.repeat(threshold);
        }
        const visibleEnd = value.slice(-exposedChars);
        const maskedMiddle = placeholder.repeat(threshold - exposedChars);
        return `${maskedMiddle}${visibleEnd}`;
    }

    /**
     * Writes a secret to the secrets file
     * @param {string} key Secret key
     * @param {string} value Secret value
     * @param {string} label Label for the secret
     * @param {{ activate?: boolean }} [opts] activate=false 时新条不抢 active
     *   槽(profile 迁移跨池复制用 —— readSecret 按 id 读不查 active,
     *   旧路径的 active 兜底因此原样不动);缺省 true 与旧行为一致。
     * @returns {string} The ID of the newly created secret
     */
    writeSecret(key, value, label = 'Unlabeled', { activate = true } = {}) {
        const secrets = this._readSecretsFile();

        if (!Array.isArray(secrets[key])) {
            secrets[key] = [];
        }

        if (activate) {
            this._deactivateAllSecrets(secrets[key]);
        }

        const secret = {
            id: uuidv4(),
            value: value,
            label: label,
            active: activate,
        };
        secrets[key].push(secret);

        this._writeSecretsFile(secrets);
        return secret.id;
    }

    /**
     * Deletes a secret from the secrets file by its ID
     * @param {string} key Secret key
     * @param {string?} id Secret ID to delete
     */
    deleteSecret(key, id) {
        if (!fs.existsSync(this.filePath)) {
            return;
        }

        const secrets = this._readSecretsFile();

        if (!this._validateSecretKey(secrets, key)) {
            return;
        }

        const secretArray = secrets[key];
        const targetIndex = secretArray.findIndex(s => id ? s.id === id : s.active);

        // Delete the secret if found
        if (targetIndex !== -1) {
            secretArray.splice(targetIndex, 1);
        }

        // Reactivate the first secret if none are active
        if (secretArray.length && !secretArray.some(s => s.active)) {
            secretArray[0].active = true;
        }

        // Remove the key if no secrets left
        if (secretArray.length === 0) {
            delete secrets[key];
        }

        this._writeSecretsFile(secrets);
    }

    /**
     * Reads the active secret value for a given key
     * @param {string} key Secret key
     * @param {string?} id ID of the secret to read (optional)
     * @returns {string} Secret value or empty string if not found
     */
    readSecret(key, id) {
        if (!fs.existsSync(this.filePath)) {
            return '';
        }

        const secrets = this._readSecretsFile();
        const secretArray = secrets[key];

        if (Array.isArray(secretArray) && secretArray.length > 0) {
            const activeSecret = secretArray.find(s => id ? s.id === id : s.active);
            return activeSecret?.value || '';
        }

        return '';
    }

    /**
     * Activates a specific secret by ID for a given key
     * @param {string} key Secret key to rotate
     * @param {string} id ID of the secret to activate
     */
    rotateSecret(key, id) {
        if (!fs.existsSync(this.filePath)) {
            return;
        }

        const secrets = this._readSecretsFile();

        if (!this._validateSecretKey(secrets, key)) {
            return;
        }

        const secretArray = secrets[key];
        const targetIndex = secretArray.findIndex(s => s.id === id);

        if (targetIndex === -1) {
            console.warn(`Secret with ID ${id} not found for key ${key}`);
            return;
        }

        this._deactivateAllSecrets(secretArray);
        secretArray[targetIndex].active = true;

        this._writeSecretsFile(secrets);
    }

    /**
     * Sets (or clears) the `share` ACL on an existing entry and persists it.
     * Only the instance-level shared secrets file (`<dataRoot>/_shared`) carries
     * ACLs — per-user files never get `share` fields, so this method is only
     * invoked through the admin shared-secrets surface.
     * @param {string} key Secret key
     * @param {string} id ID of the secret to update
     * @param {{mode: string, handles?: string[]}|null} share Share ACL, or null to clear
     * @returns {boolean} Whether the entry was found
     */
    updateSecretShare(key, id, share) {
        if (!fs.existsSync(this.filePath)) {
            return false;
        }

        const secrets = this._readSecretsFile();

        if (!this._validateSecretKey(secrets, key)) {
            return false;
        }

        const secretArray = secrets[key];
        const entry = secretArray.find(s => s.id === id);

        if (!entry) {
            console.warn(`Secret with ID ${id} not found for key ${key}`);
            return false;
        }

        if (share && typeof share === 'object') {
            entry.share = share;
        } else {
            delete entry.share;
        }

        this._writeSecretsFile(secrets);
        return true;
    }

    /**
     * Renames a secret by its ID
     * @param {string} key Secret key to rename
     * @param {string} id ID of the secret to rename
     * @param {string} label New label for the secret
     */
    renameSecret(key, id, label) {
        const secrets = this._readSecretsFile();

        if (!this._validateSecretKey(secrets, key)) {
            return;
        }

        const secretArray = secrets[key];
        const targetIndex = secretArray.findIndex(s => s.id === id);

        if (targetIndex === -1) {
            console.warn(`Secret with ID ${id} not found for key ${key}`);
            return;
        }

        secretArray[targetIndex].label = label;
        this._writeSecretsFile(secrets);
    }

    /**
     * Gets the state of all secrets (whether they exist or not)
     * @returns {SecretStateMap} Secret state
     */
    getSecretState() {
        const secrets = this._readSecretsFile();
        /** @type {SecretStateMap} */
        const state = {};

        for (const key of Object.values(SECRET_KEYS)) {
            // Skip migration marker
            if (key === SECRET_KEYS._MIGRATED) {
                continue;
            }
            const value = secrets[key];
            if (value && Array.isArray(value) && value.length > 0) {
                state[key] = value.map(secret => ({
                    id: secret.id,
                    value: this.getMaskedValue(secret.value, key),
                    label: secret.label,
                    active: secret.active,
                }));
            } else {
                // No secrets for this key
                state[key] = null;
            }
        }

        return state;
    }

    /**
     * Gets all secrets (for admin viewing)
     * @returns {SecretKeys} All secrets
     */
    getAllSecrets() {
        return this._readSecretsFile();
    }

    /**
     * Migrates legacy flat secrets format to new format
     */
    migrateFlatSecrets() {
        if (!fs.existsSync(this.filePath)) {
            return;
        }

        const fileContents = fs.readFileSync(this.filePath, 'utf8');
        const secrets = /** @type {FlatSecretKeys} */ (JSON.parse(fileContents));
        const values = Object.values(secrets);

        // Check if already migrated
        if (secrets[SECRET_KEYS._MIGRATED] || values.length === 0 || values.some(v => Array.isArray(v))) {
            return;
        }

        /** @type {SecretKeys} */
        const migratedSecrets = {};

        for (const [key, value] of Object.entries(secrets)) {
            if (typeof value === 'string' && value.trim()) {
                migratedSecrets[key] = [{
                    id: uuidv4(),
                    value: value,
                    label: key,
                    active: true,
                }];
            }
        }

        // Mark as migrated
        migratedSecrets[SECRET_KEYS._MIGRATED] = [];

        // Save backup of the old secrets file
        const backupFilePath = path.join(this.directories.backups, `secrets_migration_${Date.now()}.json`);
        fs.cpSync(this.filePath, backupFilePath);

        this._writeSecretsFile(migratedSecrets);
        console.info(color.green('Secrets migrated successfully, old secrets backed up to:'), backupFilePath);
    }
}

//#region Backwards compatibility
/**
 * Writes a secret to the secrets file
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} key Secret key
 * @param {string} value Secret value
 */
export function writeSecret(directories, key, value) {
    return new SecretManager(directories).writeSecret(key, value);
}

/**
 * Deletes a secret from the secrets file
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} key Secret key
 */
export function deleteSecret(directories, key) {
    return new SecretManager(directories).deleteSecret(key, null);
}

/**
 * Reads a secret from the secrets file
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} key Secret key
 * @param {string?} [id] Secret ID
 * @returns {string} Secret value
 */
export function readSecret(directories, key, id = null) {
    return new SecretManager(directories).readSecret(key, id);
}

/**
 * Reads the secret state from the secrets file
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Record<string, boolean>} Secret state
 */
export function readSecretState(directories) {
    const state = new SecretManager(directories).getSecretState();
    const result = /** @type {Record<string, boolean>} */ ({});
    for (const key of Object.values(SECRET_KEYS)) {
        // Skip migration marker
        if (key === SECRET_KEYS._MIGRATED) {
            continue;
        }
        result[key] = Array.isArray(state[key]) && state[key].length > 0;
    }
    return result;
}

/**
 * Reads all secrets from the secrets file
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Record<string, string>} Secrets
 */
export function getAllSecrets(directories) {
    const secrets = new SecretManager(directories).getAllSecrets();
    const result = /** @type {Record<string, string>} */ ({});
    for (const [key, values] of Object.entries(secrets)) {
        // Skip migration marker
        if (key === SECRET_KEYS._MIGRATED) {
            continue;
        }
        if (Array.isArray(values) && values.length > 0) {
            const activeSecret = values.find(secret => secret.active);
            if (activeSecret) {
                result[key] = activeSecret.value;
            }
        }
    }
    return result;
}
//#endregion

/**
 * Resolves the secret id requested by the caller from an incoming HTTP request.
 * Accepts either snake_case `secret_id` or camelCase `secretId`.
 * @param {import('express').Request} request
 * @returns {string} Trimmed secret id, or empty string if absent.
 */
export function getRequestedSecretId(request) {
    const raw = request?.body?.secret_id ?? request?.body?.secretId ?? '';
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Reads a provider secret, honoring an optional `secret_id` from the request body.
 * Falls back to the active secret for the given key if the requested id is missing
 * or cannot be resolved.
 * @param {import('express').Request} request
 * @param {string} key SECRET_KEYS entry to look up
 * @returns {string} The resolved secret value, or empty string when none is stored.
 */
export function readProviderSecret(request, key) {
    const secretId = getRequestedSecretId(request);
    if (secretId) {
        const requested = readSecret(request.user.directories, key, secretId);
        if (requested) {
            return requested;
        }
    }
    return readSecret(request.user.directories, key);
}

//#region Shared secrets (instance-level fallback)
//
// 设计:.skeinn/design/shared-secrets.md §2(TASK-072)。
// `<dataRoot>/_shared/secrets.json` 是实例级共享兜底档,与 _storage/_uploads/
// _errors 同风格 —— 在任何 user root 之外,天然不进 user backup / settings doc /
// ctx / CardApp 面。条目在现有 {id,value,label,active} 上加 ACL:
//   "share": {"mode":"all|handles|none", "handles":["friend-a"]}
// 缺 share 字段 = none(不开放);ACL 只在 resolver 服务端判,读面不判。

/** 共享档目录名(实例级,非 per-user)。 */
export const SHARED_SECRETS_DIR = '_shared';

/** share ACL 三态。 */
export const SHARE_MODES = Object.freeze({
    ALL: 'all',
    HANDLES: 'handles',
    NONE: 'none',
});

/** /api/utopinn/secrets 与 admin 共享面共用的写面 key 白名单。 */
export const VALID_SECRET_KEYS = new Set(Object.values(SECRET_KEYS).filter(k => k !== SECRET_KEYS._MIGRATED));

/**
 * 共享档根目录 `<dataRoot>/_shared`。
 * DATA_ROOT 未就绪(纯单测)时由 request.user.directories.root(<dataRoot>/<handle>)
 * 反推 dataRoot;两者皆无 → null,共享层恒 miss。
 * @param {import('express').Request} [request]
 * @returns {string|null}
 */
export function getSharedSecretsRoot(request = null) {
    const dataRoot = globalThis.DATA_ROOT
        || (request?.user?.directories?.root ? path.dirname(request.user.directories.root) : '');
    return dataRoot ? path.join(dataRoot, SHARED_SECRETS_DIR) : null;
}

/**
 * 共享档 SecretManager({root:'<dataRoot>/_shared'})。
 * @param {import('express').Request} [request]
 * @returns {SecretManager|null} null when the data root cannot be located
 */
export function getSharedSecretManager(request = null) {
    const root = getSharedSecretsRoot(request);
    // SecretManager 只用 directories.root(与本类),{root} 即合法入参;
    // backups 仅 migrateFlatSecrets 用,共享档永远数组格式,不走它。
    return root ? new SecretManager(/** @type {any} */ ({ root })) : null;
}

/**
 * 共享条目 ACL 判定 —— 只在 resolver 侧执行(§2.5.2:不在读面判,
 * 防手填 chat_completion_source 蹭未开放的 key)。
 * @param {object} entry Shared-file entry (may carry `share`)
 * @param {string} handle Caller handle
 * @returns {boolean}
 */
export function sharedEntryAllowsHandle(entry, handle) {
    const share = entry?.share;
    if (!share || typeof share !== 'object') {
        return false; // 缺省 = none,不开放
    }
    if (share.mode === SHARE_MODES.ALL) {
        return true;
    }
    if (share.mode === SHARE_MODES.HANDLES) {
        return typeof handle === 'string' && Array.isArray(share.handles) && share.handles.includes(handle);
    }
    return false; // 'none' / 未知 mode → 拒
}

/**
 * 共享档 active 条目(ACL 放行且值非空才返回);文件不存在 → null。
 * @param {import('express').Request} request
 * @param {string} key
 * @returns {object|null}
 */
function readSharedActiveEntry(request, key) {
    const root = getSharedSecretsRoot(request);
    if (!root || !fs.existsSync(path.join(root, SECRETS_FILE))) {
        return null;
    }
    const manager = getSharedSecretManager(request);
    const secrets = manager?.getAllSecrets() ?? {};
    const arr = secrets[key];
    if (!Array.isArray(arr)) {
        return null;
    }
    const entry = arr.find(s => s?.active);
    if (!entry || typeof entry.value !== 'string' || !entry.value) {
        return null;
    }
    const handle = request?.user?.profile?.handle;
    return sharedEntryAllowsHandle(entry, handle) ? entry : null;
}

/**
 * Provider 密钥统一解析 —— resolver 四层(§2.2):
 *   1. secret_id 指定槽(本人档;命中即用,未命中继续)
 *   2. 本人档 active
 *   3. 共享档 active 且 share ACL 放行本 handle
 *   4. ''
 * proxy_password 不进本函数:各 provider 调用点保留 `body.proxy_password ||`
 * 最优先(显式 per-request BYOK 不被共享档遮蔽)。
 *
 * 内部读面(getCsrfSecret / migrateFlatSecrets / STORAGE_KEYS)永不经过此函数 ——
 * csrfSecret 等 per-user key 必须隔离,绝不能蹭共享档(§2.2 红线)。
 *
 * @param {import('express').Request} request
 * @param {string} key SECRET_KEYS entry
 * @param {string|null} [secretId] 显式槽位覆盖;缺省读 request.body.secret_id
 * @returns {{value: string, source: 'user'|'shared'|'none'}}
 */
export function resolveProviderSecretDetailed(request, key, secretId = null) {
    const directories = request?.user?.directories;
    const userRoot = typeof directories?.root === 'string' ? directories.root : '';
    const requestedId = (typeof secretId === 'string' && secretId.trim())
        ? secretId.trim()
        : getRequestedSecretId(request);

    if (userRoot) {
        if (requestedId) {
            const requested = readSecret(directories, key, requestedId);
            if (requested) {
                return { value: requested, source: 'user' };
            }
        }
        const active = readSecret(directories, key);
        if (active) {
            return { value: active, source: 'user' };
        }
    }

    const shared = readSharedActiveEntry(request, key);
    if (shared) {
        return { value: shared.value, source: 'shared' };
    }

    return { value: '', source: 'none' };
}

/**
 * resolveProviderSecretDetailed 的值投影 —— provider 调用点的主入口。
 * @param {import('express').Request} request
 * @param {string} key SECRET_KEYS entry
 * @param {string|null} [secretId] 显式槽位覆盖;缺省读 request.body.secret_id
 * @returns {string} resolved secret, or ''
 */
export function resolveProviderSecret(request, key, secretId = null) {
    return resolveProviderSecretDetailed(request, key, secretId).value;
}

/**
 * 普通用户可见的共享态:{key: {label, active:true} | null}。
 * 只回「本 handle 可用」的共享条目的 label/active —— 不回 id、不回掩码、
 * 不回 handles 名单(掩码也是信息,私有部署给布尔就够 —— §2.4)。
 * @param {import('express').Request} request
 * @returns {Record<string, {label: string, active: boolean}|null>}
 */
export function getSharedSecretState(request) {
    const root = getSharedSecretsRoot(request);
    const exists = root && fs.existsSync(path.join(root, SECRETS_FILE));
    const secrets = exists ? (getSharedSecretManager(request)?.getAllSecrets() ?? {}) : {};
    const handle = request?.user?.profile?.handle;
    /** @type {Record<string, {label: string, active: boolean}|null>} */
    const state = {};
    for (const key of Object.values(SECRET_KEYS)) {
        if (key === SECRET_KEYS._MIGRATED) {
            continue;
        }
        const arr = Array.isArray(secrets[key]) ? secrets[key] : null;
        const entry = arr?.find(s => s?.active) ?? null;
        const usable = Boolean(entry) && typeof entry.value === 'string' && entry.value.length > 0
            && sharedEntryAllowsHandle(entry, handle);
        state[key] = usable ? { label: String(entry.label ?? ''), active: true } : null;
    }
    return state;
}
//#endregion

/**
 * Migrates legacy flat secrets format to the new format for all user directories
 * @param {import('../users.js').UserDirectoryList[]} directoriesList User directories
 */
export function migrateFlatSecrets(directoriesList) {
    for (const directories of directoriesList) {
        try {
            const manager = new SecretManager(directories);
            manager.migrateFlatSecrets();
        } catch (error) {
            console.warn(color.red(`Failed to migrate secrets for ${directories.root}:`), error);
        }
    }
}

export const router = express.Router();

router.post('/write', (request, response) => {
    try {
        const { key, value, label } = request.body;

        if (!key || typeof value !== 'string') {
            return response.status(400).send('Invalid key or value');
        }

        const manager = new SecretManager(request.user.directories);
        const id = manager.writeSecret(key, value, label);

        return response.send({ id });
    } catch (error) {
        console.error('Error writing secret:', error);
        return response.sendStatus(500);
    }
});

router.post('/read', (request, response) => {
    try {
        const manager = new SecretManager(request.user.directories);
        const state = manager.getSecretState();
        return response.send(state);
    } catch (error) {
        console.error('Error reading secret state:', error);
        return response.send({});
    }
});

router.post('/view', (request, response) => {
    try {
        if (!allowKeysExposure) {
            console.error('secrets.json could not be viewed unless allowKeysExposure in config.yaml is set to true');
            return response.sendStatus(403);
        }

        const secrets = getAllSecrets(request.user.directories);

        if (!secrets) {
            return response.sendStatus(404);
        }

        return response.send(secrets);
    } catch (error) {
        console.error('Error viewing secrets:', error);
        return response.sendStatus(500);
    }
});

router.post('/find', (request, response) => {
    try {
        const { key, id } = request.body;

        if (!key) {
            return response.status(400).send('Key is required');
        }

        if (!allowKeysExposure && !EXPORTABLE_KEYS.includes(key)) {
            console.error('Cannot fetch secrets unless allowKeysExposure in config.yaml is set to true');
            return response.sendStatus(403);
        }

        const manager = new SecretManager(request.user.directories);
        const state = manager.getSecretState();

        if (!state[key]) {
            return response.sendStatus(404);
        }

        const secretValue = manager.readSecret(key, id);
        return response.send({ value: secretValue });
    } catch (error) {
        console.error('Error finding secret:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', (request, response) => {
    try {
        const { key, id } = request.body;

        if (!key) {
            return response.status(400).send('Key and ID are required');
        }

        const manager = new SecretManager(request.user.directories);
        manager.deleteSecret(key, id);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Error deleting secret:', error);
        return response.sendStatus(500);
    }
});

router.post('/rotate', (request, response) => {
    try {
        const { key, id } = request.body;

        if (!key || !id) {
            return response.status(400).send('Key and ID are required');
        }

        const manager = new SecretManager(request.user.directories);
        manager.rotateSecret(key, id);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Error rotating secret:', error);
        return response.sendStatus(500);
    }
});

router.post('/rename', (request, response) => {
    try {
        const { key, id, label } = request.body;

        if (!key || !id || !label) {
            return response.status(400).send('Key, ID, and label are required');
        }

        const manager = new SecretManager(request.user.directories);
        manager.renameSecret(key, id, label);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Error renaming secret:', error);
        return response.sendStatus(500);
    }
});

router.post('/settings', async (_request, response) => {
    return response.send({ allowKeysExposure });
});
