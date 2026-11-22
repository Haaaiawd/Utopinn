// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 实例级共享 secrets 管理面(TASK-072;design: .skeinn/design/shared-secrets.md §2.3)。
// 六动词全 POST + requireAdminMiddleware,挂 /api/users/shared-secrets/*(server-startup.js)。
//
// 硬约束(§2.5):
//   · 共享明文永不离开进程 —— 不设 /view /find 等价物;list 也只回掩码。
//     掩码走本文件的 maskSharedSecret,不复用 SecretManager.getMaskedValue:
//     后者认 allowKeysExposure,而 §2.5.5 明确该开关不松共享面。
//   · 唯一"验证"通道是 /api/utopinn/connection/test 的连通性结果。
//   · 共享档 <dataRoot>/_shared/secrets.json 不进 user backup/export/ctx。
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { requireAdminMiddleware } from '../users.js';
import { ensureDirectory } from '../util.js';
import {
    SECRETS_FILE,
    SECRET_KEYS,
    VALID_SECRET_KEYS,
    SHARE_MODES,
    SecretManager,
    getSharedSecretsRoot,
    getSharedSecretManager,
} from './secrets.js';

export const router = express.Router();

const SHARE_MODE_SET = new Set(Object.values(SHARE_MODES));

/**
 * 无条件掩码(与 getMaskedValue 同形,但不认 allowKeysExposure —— §2.5.5)。
 * @param {unknown} value
 * @returns {string}
 */
function maskSharedSecret(value) {
    const s = typeof value === 'string' ? value : '';
    const threshold = 10;
    const exposed = 3;
    if (s.length <= threshold) {
        return '*'.repeat(threshold);
    }
    return `${'*'.repeat(threshold - exposed)}${s.slice(-exposed)}`;
}

/**
 * 归一化 share 负载。mode 缺省时落 defaultMode;handles 模式必须给字符串数组。
 * @param {object} body 请求体
 * @param {string} defaultMode 缺省 mode(write/promote 显式共享 → 'all')
 * @returns {{ok: true, share: {mode: string, handles?: string[]}}|{ok: false, error: string}}
 */
function normalizeSharePayload(body, defaultMode) {
    const mode = body?.mode ?? defaultMode;
    if (!SHARE_MODE_SET.has(mode)) {
        return { ok: false, error: `mode must be one of: ${[...SHARE_MODE_SET].join(' | ')}` };
    }
    if (mode === SHARE_MODES.HANDLES) {
        const raw = body?.handles;
        if (!Array.isArray(raw) || !raw.every(h => typeof h === 'string' && h.trim().length > 0)) {
            return { ok: false, error: 'mode "handles" requires body.handles: non-empty-string[]' };
        }
        return { ok: true, share: { mode, handles: raw.map(h => h.trim()) } };
    }
    return { ok: true, share: { mode } };
}

/**
 * 取共享档 manager 并确保目录存在(写动词用;读动词走 existsSync 判定不建目录)。
 * @returns {SecretManager|null}
 */
function requireSharedManager(request) {
    const root = getSharedSecretsRoot(request);
    if (!root || !ensureDirectory(root)) {
        return null;
    }
    return getSharedSecretManager(request);
}

/**
 * POST /shared-secrets/list
 * → {items:{key:[{id,label,active,masked,share}]|null}} —— admin 也只见掩码。
 */
router.post('/shared-secrets/list', requireAdminMiddleware, (request, response) => {
    try {
        const root = getSharedSecretsRoot(request);
        const exists = Boolean(root) && fs.existsSync(path.join(root, SECRETS_FILE));
        const raw = exists ? (getSharedSecretManager(request)?.getAllSecrets() ?? {}) : {};
        const items = {};
        for (const key of Object.values(SECRET_KEYS)) {
            if (key === SECRET_KEYS._MIGRATED) {
                continue;
            }
            const arr = Array.isArray(raw[key]) ? raw[key] : [];
            items[key] = arr.length
                ? arr.map(e => ({
                    id: e.id,
                    label: typeof e.label === 'string' ? e.label : '',
                    active: Boolean(e.active),
                    masked: maskSharedSecret(e.value),
                    share: e?.share && typeof e.share === 'object'
                        ? {
                            mode: SHARE_MODE_SET.has(e.share.mode) ? e.share.mode : SHARE_MODES.NONE,
                            ...(Array.isArray(e.share.handles) ? { handles: e.share.handles } : {}),
                        }
                        : { mode: SHARE_MODES.NONE },
                }))
                : null;
        }
        return response.send({ items });
    } catch (error) {
        console.error('shared-secrets list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * POST /shared-secrets/write —— {key,value,label?,mode?,handles?} → {id}。
 * 写入共享档的动词本身就是显式共享动作:mode 缺省 'all'(§2.1「共享档只放
 * 打算共享的 key」);要白名单先写再 /visibility,或直接带 mode/handles。
 */
router.post('/shared-secrets/write', requireAdminMiddleware, (request, response) => {
    try {
        const { key, value, label } = request.body ?? {};
        if (!VALID_SECRET_KEYS.has(key)) {
            return response.status(400).send({ error: `Unknown secret key: ${key}` });
        }
        if (typeof value !== 'string' || value.length === 0) {
            return response.status(400).send({ error: 'Expected body.value non-empty string' });
        }
        const parsed = normalizeSharePayload(request.body, SHARE_MODES.ALL);
        if (!parsed.ok) {
            return response.status(400).send({ error: parsed.error });
        }
        const manager = requireSharedManager(request);
        if (!manager) {
            return response.sendStatus(500);
        }
        const id = manager.writeSecret(key, value, typeof label === 'string' && label ? label : 'shared');
        manager.updateSecretShare(key, id, parsed.share);
        return response.send({ id });
    } catch (error) {
        console.error('shared-secrets write failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * POST /shared-secrets/delete —— {key,id} → 204(幂等;无此条也 204)。
 */
router.post('/shared-secrets/delete', requireAdminMiddleware, (request, response) => {
    try {
        const { key, id } = request.body ?? {};
        if (!key || !id) {
            return response.status(400).send({ error: 'Key and ID are required' });
        }
        const manager = getSharedSecretManager(request);
        if (manager) {
            manager.deleteSecret(key, id);
        }
        return response.sendStatus(204);
    } catch (error) {
        console.error('shared-secrets delete failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * POST /shared-secrets/rotate —— {key,id} → 204(切 active;语义同本人档 rotate)。
 */
router.post('/shared-secrets/rotate', requireAdminMiddleware, (request, response) => {
    try {
        const { key, id } = request.body ?? {};
        if (!key || !id) {
            return response.status(400).send({ error: 'Key and ID are required' });
        }
        const manager = getSharedSecretManager(request);
        if (manager) {
            manager.rotateSecret(key, id);
        }
        return response.sendStatus(204);
    } catch (error) {
        console.error('shared-secrets rotate failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * POST /shared-secrets/visibility —— {key,id,mode:'all'|'handles'|'none',handles?[]} → 204。
 * mode 必填(本动词就是干这个的);mode/handles 原子落档。
 */
router.post('/shared-secrets/visibility', requireAdminMiddleware, (request, response) => {
    try {
        const { key, id, mode } = request.body ?? {};
        if (!key || !id) {
            return response.status(400).send({ error: 'Key and ID are required' });
        }
        if (!SHARE_MODE_SET.has(mode)) {
            return response.status(400).send({ error: `mode must be one of: ${[...SHARE_MODE_SET].join(' | ')}` });
        }
        const parsed = normalizeSharePayload(request.body, SHARE_MODES.NONE);
        if (!parsed.ok) {
            return response.status(400).send({ error: parsed.error });
        }
        const manager = getSharedSecretManager(request);
        const updated = manager ? manager.updateSecretShare(key, id, parsed.share) : false;
        if (!updated) {
            return response.status(404).send({ error: 'Shared secret entry not found' });
        }
        return response.sendStatus(204);
    } catch (error) {
        console.error('shared-secrets visibility failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * POST /shared-secrets/promote —— {key,id,label?,mode?,handles?} → {id}。
 * 把「调用者自己」secrets.json 里 id 指定的一条复制进共享档(新 uuid,不删原条;
 * 原条仍在 → 调用者侧继续优先用自己的,行为无缝 —— §2.6)。
 */
router.post('/shared-secrets/promote', requireAdminMiddleware, (request, response) => {
    try {
        const { key, id, label } = request.body ?? {};
        if (!VALID_SECRET_KEYS.has(key)) {
            return response.status(400).send({ error: `Unknown secret key: ${key}` });
        }
        if (!id || typeof id !== 'string') {
            return response.status(400).send({ error: 'ID is required' });
        }
        const own = new SecretManager(request.user.directories).getAllSecrets()[key];
        const src = Array.isArray(own) ? own.find(s => s.id === id) : null;
        if (!src || typeof src.value !== 'string' || !src.value) {
            return response.status(404).send({ error: 'Secret entry not found in caller secrets' });
        }
        const parsed = normalizeSharePayload(request.body, SHARE_MODES.ALL);
        if (!parsed.ok) {
            return response.status(400).send({ error: parsed.error });
        }
        const manager = requireSharedManager(request);
        if (!manager) {
            return response.sendStatus(500);
        }
        const newId = manager.writeSecret(
            key,
            src.value,
            typeof label === 'string' && label ? label : (src.label || 'shared'),
        );
        manager.updateSecretShare(key, newId, parsed.share);
        return response.send({ id: newId });
    } catch (error) {
        console.error('shared-secrets promote failed:', error);
        return response.sendStatus(500);
    }
});
