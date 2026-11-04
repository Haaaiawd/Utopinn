/**
 * /api/uberge —— 薄客户端库/管理 REST API(TASK-018)。
 *
 * 10 个只读 GET 已迁往 kernel 插件 src/plugins/uberge-library.js
 * (webServer.register 贡献,inject 等位);本文件只剩写路径:
 * DELETE 会话、PATCH settings(受限浅合并)。
 * dispatcher 未命中时 next() 落回本 router —— 同一前缀按面切换。
 *
 * 响应约定:
 *   - 错误一律 {error: string}:400 输入非法 / 404 资源缺失 / 422 文档不合规。
 */
import express from 'express';

import { getChatRepo, getSettingsRepo } from '../storage/index.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import {
    safeName,
    sendError,
    sanitizeSettingsDoc,
} from '../plugins/uberge-library.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// 会话(ChatRepo;charDir = 角色目录名,chatName 可带可不带 .jsonl)
// ---------------------------------------------------------------------------

/**
 * DELETE /characters/:charDir/chats/:chatName —— 删除会话(204;不存在→404)。
 */
router.delete('/characters/:charDir/chats/:chatName', async function (request, response) {
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

// ---------------------------------------------------------------------------
// Settings(PATCH 只允许 power_user / extension_settings 两段)
// ---------------------------------------------------------------------------

/** PATCH /settings 允许的顶层段:只能往这两段里浅合并。 */
const PATCHABLE_SETTINGS_SECTIONS = new Set(['power_user', 'extension_settings']);

/**
 * PATCH /settings —— 受限浅合并:{power_user:{...}, extension_settings:{...}}。
 * 顶层键必须全部落在白名单里,每段值必须是对象(逐键浅合并进现有段);
 * 其余顶层字段(oai_settings/world_info/预设选择等)不可经此端点写。
 */
router.patch('/settings', async function (request, response) {
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
