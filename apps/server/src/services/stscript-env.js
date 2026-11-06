/**
 * stscript-env —— 服务端 StscriptEnv 共享构造(TASK-019/025 共用)。
 *
 * uberge-script(REST runner)与 uberge-th(TH 兼容 triggerSlash)填同一套
 * StscriptHost seams,语义必须单点:
 *   appendMessage/sendSystemMessage → chatRepo 持久化 + macro.chat 内存同步
 *   persistMetadata → chat_metadata.variables 落库
 *   persistSettings → extension_settings.variables.global 整档回写
 *   runQuickReply → QuickReplies/*.json qrList 按 label 递归
 *   UI seam(notify/popup/input)收敛进 sinks(调用方决定回执形态)
 *   generateQuiet/triggerGeneration 未绑定 —— 引擎按 seam 缺失降级
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    createStscriptEnv,
    executeSlashCommandsWithOptions,
} from '@uberge/core';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getChatRepo, getSettingsRepo } from '../storage/index.js';

export async function loadCard(directories, charDir) {
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
export async function resolveCharacterByName(directories, name) {
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

export async function findQuickReplyScript(directories, label) {
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

/**
 * 组装服务端 STscript env。
 * @returns {Promise<{env, macro, settings, chat, chatMetadata, card, sinks:{notifications,popups,inputs}}|{error,status}>}
 */
export async function buildStscriptEnv({ handle, directories, charDir, chatName, userName }) {
    const settings = (await getSettingsRepo().get(handle)) ?? {};
    const powerUser = settings?.power_user ?? {};
    const card = charDir ? await loadCard(directories, charDir) : null;
    if (charDir && !card) {
        return { error: `Character not found: ${charDir}`, status: 404 };
    }

    let chat = [];
    let chatMetadata = {};
    if (charDir && chatName) {
        const doc = await getChatRepo().get(handle, charDir, chatName);
        if (!doc) {
            return { error: `Chat not found: ${charDir}/${chatName}`, status: 404 };
        }
        chat = Array.isArray(doc.body) ? doc.body : [];
        chatMetadata = doc.header?.chat_metadata ?? {};
    }

    const personas = powerUser.personas ?? {};
    const userAvatar = powerUser.default_persona ?? Object.keys(personas)[0] ?? 'user-default.png';
    const name1 = personas[userAvatar] ?? userName ?? 'User';
    const name2 = card?.data?.name ?? card?.name ?? 'Assistant';

    const sinks = { notifications: [], popups: [], inputs: [] };

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
                sinks.notifications.push({ severity: 'warning', text: 'appendMessage: no chat target — message not persisted' });
                if (insertAt === null || insertAt === undefined) chat.push(message);
                else chat.splice(insertAt, 0, message);
                return;
            }
            if (insertAt === null || insertAt === undefined) chat.push(message);
            else chat.splice(insertAt, 0, message);
            if (insertAt === null || insertAt === undefined) {
                await getChatRepo().append(handle, charDir, chatName, [message]);
            } else {
                // 中间插入 = 上游 saveChat 全量写回;header 直替为上游
                // 三键形态(script.js:7425-7429),非深合并——上游也不合并。
                await getChatRepo().save(handle, charDir, chatName,
                    { user_name: 'unused', character_name: 'unused', chat_metadata: chatMetadata }, chat);
            }
        },
        // saveChatConditional 等价(core insertChatMessage 在 appendMessage 后
        // await 它):消息体已由 appendMessage 落盘,这里补 header.chat_metadata
        // 快照——/sys /sendas /comment 写下的 tainted、/sysname 的 narrator_name。
        // chatMetadata 与 macro.chatMetadata 是同一活对象,顶层合并结果与
        // 上游整替一致;不整档 save 可避免重复写 body。
        persistChat: async () => {
            if (!charDir || !chatName) return;
            await getChatRepo().updateChatMetadata(handle, charDir, chatName, chatMetadata);
        },
        persistMetadata: () => {
            if (!charDir || !chatName) return;
            void getChatRepo().updateChatMetadata(handle, charDir, chatName, chatMetadata)
                .catch((e) => console.warn('stscript persistMetadata failed:', e?.message));
        },
        persistSettings: () => {
            void getSettingsRepo().save(handle, settings)
                .catch((e) => console.warn('stscript persistSettings failed:', e?.message));
        },
        notify: (severity, title, text) => {
            sinks.notifications.push({ severity, title, text });
        },
        showPopup: (text, isHtml) => { sinks.popups.push({ text, isHtml }); },
        sendSystemMessage: async (text, isHtml) => {
            const msg = { name: '', is_system: true, is_user: false, send_date: Date.now(), mes: text, extra: { isHtml } };
            chat.push(msg);
            if (charDir && chatName) {
                await getChatRepo().append(handle, charDir, chatName, [msg]);
            }
        },
        requestInput: async () => null,
        setInput: (text) => { sinks.inputs.push(text); },
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

    return { env, macro, settings, chat, chatMetadata, card, sinks };
}
