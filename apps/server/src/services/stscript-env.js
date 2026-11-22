/**
 * stscript-env —— 服务端 StscriptEnv 共享构造(TASK-019/025 共用)。
 *
 * utopinn-script(REST runner)与 utopinn-th(TH 兼容 triggerSlash)填同一套
 * StscriptHost seams,语义必须单点:
 *   appendMessage/sendSystemMessage → chatRepo 持久化 + macro.chat 内存同步
 *   persistMetadata → chat_metadata.variables 落库
 *   persistSettings → extension_settings.variables.global 整档回写
 *   runQuickReply → QuickReplies/*.json qrList 按 label 递归
 *   UI seam(notify/popup/input)收敛进 sinks(调用方决定回执形态)
 *   generateQuiet → services/quiet-generation.js(真 job 链 + diag)
 *   triggerGeneration 仍未绑定 —— GH#9 起引擎显式报错(messages.ts
 *     triggerGenerationCallback 抛错,不再静默假装触发成功)
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    createStscriptEnv,
    executeSlashCommandsWithOptions,
} from '@utopinn/core';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getChatRepo, getSettingsRepo } from '../storage/index.js';
import { runQuietGeneration } from './quiet-generation.js';

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
    /** 本会话文档 CAS 游标:env 生命周期内全部 repo 写路(append/save/
     *  patch/updateChatMetadata)读它作 expectedIntegrity、写后回填新值。
     *  外部并发写撞档 → ConflictError 显式冒泡,不静默改错楼层。 */
    let chatIntegrity;
    /** persistMetadata(void seam)的在飞写串行链 —— patchChat 先 drain。 */
    let metadataFlush = Promise.resolve();
    if (charDir && chatName) {
        const doc = await getChatRepo().get(handle, charDir, chatName);
        if (!doc) {
            return { error: `Chat not found: ${charDir}/${chatName}`, status: 404 };
        }
        chat = Array.isArray(doc.body) ? doc.body : [];
        chatMetadata = doc.header?.chat_metadata ?? {};
        chatIntegrity = doc.integrity;
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
                const r = await getChatRepo().append(handle, charDir, chatName, [message], chatIntegrity);
                chatIntegrity = r?.integrity ?? chatIntegrity;
            } else {
                // 中间插入 = 上游 saveChat 全量写回;header 直替为上游
                // 三键形态(script.js:7425-7429),非深合并——上游也不合并。
                const r = await getChatRepo().save(handle, charDir, chatName,
                    { user_name: 'unused', character_name: 'unused', chat_metadata: chatMetadata }, chat, chatIntegrity);
                chatIntegrity = r?.integrity ?? chatIntegrity;
            }
        },
        // saveChatConditional 等价(core insertChatMessage 在 appendMessage 后
        // await 它):消息体已由 appendMessage 落盘,这里补 header.chat_metadata
        // 快照——/sys /sendas /comment 写下的 tainted、/sysname 的 narrator_name。
        // chatMetadata 与 macro.chatMetadata 是同一活对象,顶层合并结果与
        // 上游整替一致;不整档 save 可避免重复写 body。
        persistChat: async () => {
            if (!charDir || !chatName) return;
            const r = await getChatRepo().updateChatMetadata(handle, charDir, chatName, chatMetadata, chatIntegrity);
            chatIntegrity = r?.integrity ?? chatIntegrity;
        },
        persistMetadata: () => {
            if (!charDir || !chatName) return;
            // seam 类型是 fire-and-forget(void),但写必须串行:note/setvar 的
            // 落库在飞时 patchChat 的 CAS 游标会拿到旧 integrity,把自己
            // 误判成并发撞档。挂进 metadataFlush 链,patchChat 先 drain。
            metadataFlush = metadataFlush.then(async () => {
                const r = await getChatRepo().updateChatMetadata(handle, charDir, chatName, chatMetadata, chatIntegrity);
                chatIntegrity = r?.integrity ?? chatIntegrity;
            }).catch((e) => console.warn('stscript persistMetadata failed:', e?.message));
        },
        // TASK-064 楼层写面:/del /cut /swipe /delswipe /addswipe /hide
        // /unhide /swap /message-* 的 JSON-Patch 落点 —— 与 PATCH
        // /characters/:dir/chats/:name 同一个 repo.patch(ops 形状与
        // web opsOf/PATCH 同构,/body/<i> 命名空间)。CAS 游标随写随进;
        // 先 drain persistMetadata 的在飞写,再取最新 integrity ——
        // 只对外部并发写(撞档→ConflictError)冒泡,自家写不误报。
        patchChat: async (ops) => {
            if (!Array.isArray(ops) || !ops.length) return;
            if (!charDir || !chatName) {
                sinks.notifications.push({ severity: 'warning', text: 'patchChat: no chat target — floor ops not persisted' });
                return;
            }
            await metadataFlush;
            const r = await getChatRepo().patch(handle, charDir, chatName, ops, chatIntegrity);
            chatIntegrity = r?.integrity ?? chatIntegrity;
        },
        // /go 会话解析:name → 当前 char 下的同名会话 → 角色名(取其最近
        // 会话)→ 'last'(最近的其他会话)。返回 null = 未命中(命令 warn);
        // 绝不隐式建会话。群聊导航留后续批次(go op 只带 charDir/chatName)。
        resolveChatTarget: async (name) => {
            const needle = String(name ?? '').trim();
            if (!needle) return null;
            const repo = getChatRepo();
            if (needle.toLowerCase() === 'last') {
                const recent = await repo.listRecent(handle, { limit: 10 });
                for (const e of recent ?? []) {
                    const k = e?.key ?? {};
                    if (k.isGroup) continue;
                    if (charDir && chatName && k.charDir === charDir && k.name === chatName) continue;
                    return { charDir: k.charDir, chatName: k.name, name: k.name };
                }
                return null;
            }
            // 1) 当前角色下同 chatName 的会话直跳(「跳会话」直觉语义)
            if (charDir) {
                const own = await repo.listForCharacter(handle, charDir, { limit: 200 });
                const hit = (own ?? []).find((e) => e?.key?.name === needle || e?.key?.name === `${needle}.jsonl`);
                if (hit?.key) return { charDir, chatName: hit.key.name, name: hit.key.name };
            }
            // 2) 角色名 → 该角色最近会话(上游 /go <char> 语义)
            const character = await resolveCharacterByName(directories, needle);
            if (character?.avatar) {
                const targetCharDir = String(character.avatar).replace(/\.(png|json)$/i, '');
                const chats = await repo.listForCharacter(handle, targetCharDir, { limit: 1 });
                const chatKey = chats?.[0]?.key?.name;
                return { charDir: targetCharDir, chatName: chatKey, name: character.name };
            }
            return null;
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
        // /gen → 服务端 quiet job(组装+派发+终态+ack+diag 全链)。
        // 上游 generateQuietPrompt 失败回 ''(toast 化)——同语义:错误进
        // sinks.notifications + diag,不把脚本整棵打死。
        generateQuiet: async (prompt, params = {}) => {
            if (!charDir || !chatName) {
                sinks.notifications.push({ severity: 'warning', text: '/gen: no character/chat bound — skipped' });
                return '';
            }
            try {
                const r = await runQuietGeneration({
                    handle,
                    directories,
                    charDir,
                    chatName,
                    card,
                    prompt,
                    params,
                    userName: name1,
                });
                return r.text;
            } catch (error) {
                sinks.notifications.push({ severity: 'error', text: `/gen failed: ${error?.message ?? error}` });
                return '';
            }
        },
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
