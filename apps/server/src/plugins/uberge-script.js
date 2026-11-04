/**
 * uberge-script —— STscript/QuickReply 服务端 runner(TASK-019)。
 *
 *   POST /api/uberge/script/run
 *   body:{charDir?, chatName?, script}
 *
 * core 的 executeSlashCommandsWithOptions + builtins 已在;本插件填
 * StscriptHost seams:
 *   appendMessage      → chatRepo.append(持久化)+ macro.chat 内存同步
 *   persistMetadata    → chatRepo.updateChatMetadata(局部变量落库)
 *   persistSettings    → settingsRepo.save(全局变量落库)
 *   runQuickReply      → data/<user>/QuickReplies/*.json 按 label 查,递归跑
 *   notify/showPopup/requestInput → 服务端无 UI,收敛进响应数组(调用方转达)
 *   generateQuiet/triggerGeneration → 未绑定(引擎按 seam 缺失降级)
 *
 * 变量语义:chatMetadata.variables ↔ chat 头;globalVariables 是 settings
 * 活引用,persistSettings 整档回写。ops 回执随响应返回(谁改了什么)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    createStscriptEnv,
    executeSlashCommandsWithOptions,
    registerBuiltinCommands,
} from '@uberge/core';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getChatRepo, getSettingsRepo } from '../storage/index.js';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { safeName, sendError } from './uberge-library.js';

export const inject = ['webServer'];

async function loadCard(directories, charDir) {
    const pngPath = path.join(directories.characters, `${charDir}.png`);
    const jsonPath = path.join(directories.characters, `${charDir}.json`);
    try {
        const raw = await fs.readFile(pngPath);
        return JSON.parse(readCharacterCard(raw));
    } catch {
        const raw = await fs.readFile(jsonPath, 'utf8').catch(() => null);
        return raw ? JSON.parse(raw) : null;
    }
}

/** 角色名解析(/sendas name=):扫 characters 目录对卡名。 */
async function resolveCharacterByName(directories, name) {
    const files = await fs.readdir(directories.characters).catch(() => []);
    for (const f of files) {
        if (!f.endsWith('.png')) continue;
        try {
            const card = JSON.parse(readCharacterCard(await fs.readFile(path.join(directories.characters, f))));
            const cardName = card?.data?.name ?? card?.name;
            if (cardName === name) return { name: cardName, avatar: f };
        } catch { /* 坏卡跳过 */ }
    }
    return null;
}

async function findQuickReplyScript(directories, label) {
    const dir = path.join(directories.root, 'QuickReplies');
    const files = await fs.readdir(dir).catch(() => []);
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
            const set = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
            for (const qr of set?.qrList ?? set?.quickReplies ?? []) {
                if (qr?.label === label) return qr.message ?? null;
            }
        } catch { /* 坏集跳过 */ }
    }
    return null;
}

export function apply(ctx) {
    registerBuiltinCommands();

    const reg = (path, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));

    reg('/api/uberge/script/run', async function (request, response) {
        try {
            const body = request.body ?? {};
            const script = String(body.script ?? '');
            if (!script.trim()) {
                return response.status(400).send({ error: 'body.script is required' });
            }
            const handle = request.user.profile.handle;
            const directories = request.user.directories;
            const settings = (await getSettingsRepo().get(handle)) ?? {};
            const powerUser = settings?.power_user ?? {};

            const charDir = body.charDir ? safeName(body.charDir, 'charDir') : null;
            const chatName = body.chatName ? safeName(stripJsonlExt(body.chatName), 'chatName') : null;
            const card = charDir ? await loadCard(directories, charDir) : null;
            if (charDir && !card) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }

            // chat 上下文(可选):消息 + chat_metadata 活引用
            let chat = [];
            let chatMetadata = {};
            if (charDir && chatName) {
                const doc = await getChatRepo().get(handle, charDir, chatName);
                if (!doc) {
                    return response.status(404).send({ error: `Chat not found: ${charDir}/${chatName}` });
                }
                chat = Array.isArray(doc.body) ? doc.body : [];
                chatMetadata = doc.header?.chat_metadata ?? {};
            }

            const personas = powerUser.personas ?? {};
            const userAvatar = powerUser.default_persona ?? Object.keys(personas)[0] ?? 'user-default.png';
            const name1 = personas[userAvatar] ?? request.user.profile.name ?? 'User';
            const name2 = card?.data?.name ?? card?.name ?? 'Assistant';

            const notifications = [];
            const popups = [];
            const inputs = [];

            // extension_settings.variables.global 保证是对象并回指 settings 活引用
            const extVars = (settings.extension_settings ??= {}).variables ??= {};
            if (typeof extVars.global !== 'object' || extVars.global === null) extVars.global = {};

            const macro = {
                name1, name2,
                chat, chatMetadata,
                globalVariables: extVars.global,
                currentChatId: chatName ?? undefined,
                instruct: powerUser.instruct,
                contextTemplate: powerUser.context,
                mainApi: settings?.main_api,
            };

            const env = createStscriptEnv(macro, {
                appendMessage: async (message, insertAt) => {
                    if (!charDir || !chatName) {
                        notifications.push({ severity: 'warning', text: 'appendMessage: no chat target — message not persisted' });
                        if (insertAt === null || insertAt === undefined) chat.push(message);
                        else chat.splice(insertAt, 0, message);
                        return;
                    }
                    if (insertAt === null || insertAt === undefined) chat.push(message);
                    else chat.splice(insertAt, 0, message);
                    if (insertAt === null || insertAt === undefined) {
                        await getChatRepo().append(handle, charDir, chatName, [message]);
                    } else {
                        // 中间插入走整存(append 只接尾部;insert 语义用 save 保证序)
                        await getChatRepo().save(handle, charDir, chatName,
                            { chat_metadata: chatMetadata }, chat);
                    }
                },
                persistMetadata: () => {
                    if (!charDir || !chatName) return;
                    void getChatRepo().updateChatMetadata(handle, charDir, chatName, chatMetadata)
                        .catch((e) => console.warn('uberge/script persistMetadata failed:', e?.message));
                },
                persistSettings: () => {
                    void getSettingsRepo().save(handle, settings)
                        .catch((e) => console.warn('uberge/script persistSettings failed:', e?.message));
                },
                notify: (severity, title, text) => {
                    notifications.push({ severity, title, text });
                },
                showPopup: (text, isHtml) => { popups.push({ text, isHtml }); },
                sendSystemMessage: async (text, isHtml) => {
                    const msg = { name: '', is_system: true, is_user: false, send_date: Date.now(), mes: text, extra: { isHtml } };
                    chat.push(msg);
                    if (charDir && chatName) {
                        await getChatRepo().append(handle, charDir, chatName, [msg]);
                    }
                },
                requestInput: async () => null, // 服务端无弹窗 —— 空输入(引擎按降级处理)
                setInput: (text) => { inputs.push(text); },
                resolveCharacter: (name) => resolveCharacterByName(directories, name),
                findPersona: (name) => {
                    for (const [avatar, pName] of Object.entries(personas)) {
                        if (pName === name) return { name: pName, avatar };
                    }
                    return null;
                },
                userAvatar,
                personaAvatarExists: (key) => Object.prototype.hasOwnProperty.call(personas, key),
                currentCharAvatar: charDir ? `${charDir}.png` : undefined,
                neutralCharacterName: name2 === 'Assistant' ? 'Assistant' : undefined,
                countTokens: (text) => Math.ceil(String(text).length / 4),
                avatarUrl: (kind, id) => (kind === 'avatar' ? `characters/${id}` : `personas/${id}`),
                defaultAvatar: 'user-default.png',
                runQuickReply: async (name) => {
                    const qrScript = await findQuickReplyScript(directories, String(name));
                    if (qrScript === null) return null;
                    const r = await executeSlashCommandsWithOptions(env, qrScript);
                    return r?.pipe ?? r;
                },
            });

            const result = await executeSlashCommandsWithOptions(env, script);
            return response.send({
                ok: true,
                pipe: result?.pipe ?? result ?? null,
                isAborted: result?.isAborted ?? false,
                ops: env.ops,
                notifications,
                popups,
                inputs,
            });
        } catch (error) {
            if (error instanceof InvalidArgumentError || error instanceof NotFoundError) {
                return sendError(response, error, 'uberge/script run');
            }
            console.error('uberge/script run failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });
}
