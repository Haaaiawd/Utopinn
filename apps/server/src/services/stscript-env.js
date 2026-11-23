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
 *   triggerGeneration/generateSwipe → services/trigger-generation.js
 *     (TASK-069:Generate('normal'|'swipe') 实弹派发 + 服务端 persist
 *     + TH 生命周期事件信箱;member 参数单聊忽略,上游同语义)
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    createStscriptEnv,
    executeSlashCommandsWithOptions,
} from '@utopinn/core';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getChatRepo, getSettingsRepo, getWorldInfoRepo } from '../storage/index.js';
import { runQuietGeneration } from './quiet-generation.js';
import { renameAllCharacterStateSidecars, resolveCharacterFilePath } from './character-state.js';
import {
    SHARED_LIBRARY_DIRNAME,
    getSharedCharactersDir,
    loadCharacterDocMerged,
    materializeSharedCharacter,
    resolveCharacterFileMerged,
} from './shared-library.js';
import { runTriggerGeneration } from './trigger-generation.js';

/** 'Foo.png'/'Foo.webp'/'Foo.json' → 'Foo'(avatar key → charDir)。 */
export function avatarToCharDir(avatar) {
    return String(avatar ?? '').replace(/\.(png|webp|json)$/i, '');
}

/** avatar/charDir 穿越闸:含路径分隔/.. 或 _library 保留名的 id 直接判死 —
 *  STscript 入参可达此面,不洗就 join 出 characters 目录(PR#18 review)。
 *  `_library` 不许作为 charDir 寻址(大小写不敏感)—— 防把池目录本身当卡。 */
export function safeCharDirName(avatar) {
    const d = avatarToCharDir(avatar);
    if (!d || d.includes('..') || d.includes('/') || d.includes('\\')) return null;
    return d.toLowerCase() !== SHARED_LIBRARY_DIRNAME ? d : null;
}

/**
 * 合并读卡:私有在场即私有(同名遮蔽),否则回落 _library 共享池。
 * 返回的卡对象不带 source/共享位 —— STscript 只消费字段。
 */
export async function loadCard(directories, charDir) {
    return (await loadCharacterDocMerged(directories, charDir)).card;
}

/** 角色名解析(/sendas name=):扫私有 + 共享池对卡名,私有先中。 */
export async function resolveCharacterByName(directories, name) {
    const dirs = [directories.characters, getSharedCharactersDir(directories)].filter(Boolean);
    for (const dir of dirs) {
        const files = await fs.readdir(dir).catch(() => []);
        for (const f of files) {
            if (!f.endsWith('.png')) continue;
            try {
                const card = JSON.parse(readCharacterCard(await fs.readFile(path.join(dir, f))));
                const cardName = card?.data?.name ?? card?.name;
                if (cardName === name) return { name: cardName, avatar: f };
            } catch { /* 坏卡跳过 */ }
        }
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
 * @returns {Promise<{env, macro, settings, chat, chatMetadata, card, sinks:{notifications,popups,inputs}, refreshChatState:()=>Promise<void>}|{error,status}>}
 */
export async function buildStscriptEnv({ handle, directories, charDir, chatName, userName }) {
    const settings = (await getSettingsRepo().get(handle)) ?? {};
    // 活对象:/getpersonabook 写 persona_description_lorebook 经它落 settings 档
    const powerUser = settings.power_user ??= {};
    // WI 书目状态 —— 与 generate-context resolveWorldInfoSettings 同一口径:
    // settings.world_info_settings.world_info{globalSelect,charLore}。
    const worldInfoState = (settings.world_info_settings ??= {}).world_info ??= {};
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
    /** 最近已知已持久化的 chat_metadata 快照 —— CAS 撞档时的 3-way 合并基线
     *  (脚本改动 vs 外部改动 key 级并)。env 生命周期内由本文件全部
     *  metadata 写路维护,初始 = 装载时的盘上状态。 */
    let metadataBase = {};
    if (charDir && chatName) {
        const doc = await getChatRepo().get(handle, charDir, chatName);
        if (!doc) {
            return { error: `Chat not found: ${charDir}/${chatName}`, status: 404 };
        }
        chat = Array.isArray(doc.body) ? doc.body : [];
        chatMetadata = doc.header?.chat_metadata ?? {};
        chatIntegrity = doc.integrity;
        metadataBase = structuredClone(chatMetadata);
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

    /**
     * 生成 commit 后把 env 活态对齐到盘上最新 revision:
     * - chatIntegrity / metadataBase / chatMetadata(ephemeral 清理、
     *   生成期 setvar、WI timed effects 等外部写都已在盘上)
     * - chat 楼层数组(落库回复楼 + 外部追加;保数组引用原地替换)
     * 不调它,生成后写面(/inject /setvar /del)会拿生成前的 CAS 游标
     * 与陈旧视图 —— 撞档误报 + 读不到已删条目。drain metadataFlush
     * 先行,在飞写不丢;生成自身落库失败也不妨碍 resync。
     */
    const refreshChatState = async () => {
        if (!charDir || !chatName) return;
        await metadataFlush.catch(() => {});
        const doc = await getChatRepo().get(handle, charDir, chatName);
        if (!doc) return;
        chatIntegrity = doc.integrity;
        const live = doc.header?.chat_metadata ?? {};
        for (const k of Object.keys(chatMetadata)) {
            if (!(k in live)) delete chatMetadata[k];
        }
        Object.assign(chatMetadata, live);
        metadataBase = structuredClone(live);
        const body = Array.isArray(doc.body) ? doc.body : [];
        chat.splice(0, chat.length, ...body);
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
        // updateChatMetadata CAS 撞档 → 3-way 合并重试:base=最近已持久化
        // 快照,live=盘上现状,ours=env 活对象。脚本改过/新增/删除的键
        // 覆盖 live;脚本没动的键取 live(外部写不丢、脚本删不复活)。
        // 键级粒度:同键内并发子字段改动不并(inject 场景由生成终态的
        // refreshChatState 预同步兜底)。仍撞 → 抛给命令层,不谎报成功。
        persistMetadata: () => {
            if (!charDir || !chatName) return Promise.resolve();
            const write = metadataFlush.then(async () => {
                const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
                try {
                    const r = await getChatRepo().updateChatMetadata(handle, charDir, chatName, chatMetadata, chatIntegrity);
                    chatIntegrity = r?.integrity ?? chatIntegrity;
                    metadataBase = structuredClone(chatMetadata);
                } catch (e) {
                    if (e?.name !== 'ConflictError') throw e;
                    const doc = await getChatRepo().get(handle, charDir, chatName);
                    if (!doc) throw e;
                    const live = doc.header?.chat_metadata ?? {};
                    const merged = { ...live };
                    for (const k of Object.keys(chatMetadata)) {
                        if (!sameJson(chatMetadata[k], metadataBase?.[k])) {
                            merged[k] = chatMetadata[k];
                        }
                    }
                    for (const k of Object.keys(metadataBase ?? {})) {
                        if (!(k in chatMetadata)) delete merged[k];
                    }
                    const r2 = await getChatRepo().updateChatMetadata(handle, charDir, chatName, merged, doc.integrity);
                    chatIntegrity = r2?.integrity ?? chatIntegrity;
                    for (const k of Object.keys(chatMetadata)) {
                        if (!(k in merged)) delete chatMetadata[k];
                    }
                    Object.assign(chatMetadata, merged);
                    metadataBase = structuredClone(merged);
                }
            });
            // 链不断(一次失败不毒化后续 persist/patchChat),但把真错误经
            // 返回值交给调用命令 —— await persistMetadata?.() 的写面
            // (/inject 族)才能收到非零 receipt;fire-and-forget 调用
            // 依旧靠链上 catch 落 warn。
            metadataFlush = write.catch((e) => console.warn('stscript persistMetadata failed:', e?.message));
            return write;
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
        // /newchat → doNewChat 服务端面:`<name2> - <humanizedDateTime>` 命名
        // + buildGreetingFloor 开场播种(上游新会话自带卡 first_mes 楼,
        // 空 body 会让客户端开进无问候会话 —— 不合上游)。
        // deleteCurrent=true → 新会话落成后删当前(上游 deleteCurrentChat 同语义)。
        newChat: async ({ deleteCurrent }) => {
            if (!charDir) return null;
            const { humanizedDateTime } = await import('../util.js');
            const { buildGreetingFloor } = await import('./greeting-seed.js');
            const newName = `${name2} - ${humanizedDateTime()}`;
            const newMetadata = {};
            const greeting = buildGreetingFloor({
                card,
                name1,
                chatMetadata: newMetadata,
                chatName: newName,
                globalVariables: extVars.global,
            });
            const body = greeting ? [greeting] : [];
            // header 惯例对齐 Luker chats.js/本文件 appendMessage 写面:
            // user_name/character_name 是 ST 遗留 vestigial 字段,一律 'unused'。
            const header = { user_name: 'unused', character_name: 'unused', chat_metadata: newMetadata };
            try {
                await getChatRepo().createIfAbsent(handle, charDir, newName, header, body);
                if (deleteCurrent && chatName) {
                    await getChatRepo().delete(handle, charDir, chatName).catch((e) => {
                        console.warn('stscript newChat deleteCurrent failed:', e?.message);
                    });
                }
                return { name: newName, charDir, chatName: newName };
            } catch (error) {
                console.warn('stscript newChat failed:', error?.message ?? error);
                return null;
            }
        },
        // /delchat → 上游 UI 删除路径的服务端面:删当前绑定会话文件。
        deleteChat: async () => {
            if (!charDir || !chatName) return false;
            try {
                await getChatRepo().delete(handle, charDir, chatName);
                return true;
            } catch (error) {
                console.warn('stscript deleteChat failed:', error?.message ?? error);
                return false;
            }
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
        // requestInput 不绑 —— /input 是无回执通道的交互命令,静默回 null 会被
        // 当「空输入」继续执行(GH#9 禁止静默成功);引擎层对未绑 seam 显式报错。
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
            } finally {
                // quiet 组装期 setvar 宏也可写 metadata —— CAS 游标同步照做。
                await refreshChatState().catch(() => {});
            }
        },
        // /trigger → Generate('normal'):真派发 + 服务端落楼层 + TH 事件信箱。
        //   seam 不向外抛 —— 非 await 调用是浮动 promise,拒绝会成
        //   unhandledRejection;失败如实进 sinks + diag,返回 ''(与
        //   generateQuiet 的「错误 toast 化回空串」同语义)。
        //   member:上游 selected_group && value —— 单聊忽略(见
        //   trigger-generation.js trigger_member_ignored diag)。
        triggerGeneration: async (member) => {
            if (!charDir || !chatName) {
                sinks.notifications.push({ severity: 'warning', text: '/trigger: no character/chat bound — skipped' });
                return '';
            }
            try {
                const r = await runTriggerGeneration({
                    handle, directories, charDir, chatName, card,
                    member,
                    type: 'normal',
                    userName: name1,
                    chat,
                });
                return r.text;
            } catch (error) {
                sinks.notifications.push({ severity: 'error', text: `/trigger failed: ${error?.message ?? error}` });
                return '';
            } finally {
                await refreshChatState().catch(() => {});
            }
        },
        // /swipe 越界(OVERSWIPE_REGENERATE)→ Generate('swipe'):与
        // /trigger 同链,verb='swipe' 走 persistGeneratedSwipe 并末楼。
        generateSwipe: async (messageIndex) => {
            if (!charDir || !chatName) {
                sinks.notifications.push({ severity: 'warning', text: '/swipe regen: no character/chat bound — skipped' });
                return false;
            }
            try {
                const r = await runTriggerGeneration({
                    handle, directories, charDir, chatName, card,
                    type: 'swipe',
                    userName: name1,
                    chat,
                });
                return Boolean(r?.persisted);
            } catch (error) {
                sinks.notifications.push({ severity: 'error', text: `/swipe regen failed: ${error?.message ?? error}` });
                return false;
            } finally {
                await refreshChatState().catch(() => {});
            }
        },
        // ── WI 族 seams(TASK-064 批二)────────────────────────────────
        // settings 活对象:命令改字段后 persistSettings 落整档(与
        // resolveWorldInfoSettings/generate-context 同一 settings 文档)。
        worldInfoSettings: worldInfoState,
        powerUser,
        listWorldBooks: () => getWorldInfoRepo().listNames(handle),
        // loadWorldInfo:canonical 解析 + get —— repo.resolveName 兜住
        // 大小写/别名差异,与引擎 canonical 位一致。
        getWorldBook: async (name) => {
            const repo = getWorldInfoRepo();
            const canonical = await repo.resolveName(handle, String(name));
            return repo.get(handle, canonical ?? String(name));
        },
        saveWorldBook: async (name, doc) => {
            const repo = getWorldInfoRepo();
            const canonical = await repo.resolveName(handle, String(name));
            await repo.save(handle, canonical ?? String(name), doc);
        },
        // createNewWorldInfo:createIfAbsent 单事务落 {entries:{}},返回
        // canonical 名(repo 返回 .name 已是存储位)。
        createWorldBook: async (name) => {
            const r = await getWorldInfoRepo().createIfAbsent(handle, String(name), { entries: {} });
            return r?.name ?? null;
        },
        // /getcharbook primary/characterFilterNames 的卡读面:avatar key → charDir。
        loadCharacterCard: (avatar) => {
            const d = safeCharDirName(avatar);
            return d ? loadCard(directories, d) : null;
        },
        // writeExtensionField('world'):extensions.world 写回卡文件。
        // png/webp → writeCharacterData 同端点写面(重嵌 chunk);json → 直写。
        // 仅共享卡在场 → 先物化(copy-on-write),写永远不落到 _library。
        setCharacterWorld: async (avatar, worldName) => {
            const charDirName = safeCharDirName(avatar);
            if (!charDirName) return false;
            const merged = resolveCharacterFileMerged(directories, charDirName);
            if (!merged) return false;
            if (merged.shared) {
                try {
                    await materializeSharedCharacter(directories, charDirName);
                } catch (error) {
                    console.warn('stscript setCharacterWorld: materialize failed:', error?.message ?? error);
                    return false;
                }
            }
            const filePath = resolveCharacterFilePath(directories.characters, charDirName);
            if (!filePath) return false;
            const ext = path.extname(filePath).toLowerCase();
            const fakeReq = { user: { profile: { handle, name: name1 }, directories } };
            try {
                if (ext !== '.json') {
                    const { readCharacterData, writeCharacterData } = await import('../endpoints/characters.js');
                    const cardObj = JSON.parse(await readCharacterData(filePath));
                    cardObj.data ??= {};
                    cardObj.data.extensions ??= {};
                    cardObj.data.extensions.world = worldName;
                    const ok = await writeCharacterData(filePath, JSON.stringify(cardObj), charDirName, fakeReq, undefined, {
                        requireExistingOutput: ext === '.png',
                    });
                    if (!ok) return false;
                    if (ext !== '.png') {
                        // 写产物恒为 <stem>.png —— 摘旧图档+迁侧车,同 PATCH 转换面。
                        await fs.rm(filePath, { force: true }).catch(() => {});
                        renameAllCharacterStateSidecars(filePath, path.join(directories.characters, `${charDirName}.png`));
                    }
                    return true;
                }
                const raw = await fs.readFile(filePath, 'utf8');
                const cardObj = JSON.parse(raw);
                cardObj.data ??= {};
                cardObj.data.extensions ??= {};
                cardObj.data.extensions.world = worldName;
                await fs.writeFile(filePath, JSON.stringify(cardObj, null, 2), 'utf8');
                return true;
            } catch (error) {
                console.warn('stscript setCharacterWorld failed:', error?.message ?? error);
                return false;
            }
        },
        // settings.tags 活数组([{id,name}])— characterFilterTags 的
        // id↔name 对表;服务端无独立 tags 仓,settings 档即事实源。
        listTags: () => (Array.isArray(settings.tags) ? settings.tags : []),
        // ── 会话/角色 seams(TASK-064 批二)────────────────────────────
        // /renamechat → ChatRepo.rename(与 PATCH 路由同写面;CAS 内部处理)。
        renameChat: async (oldName, newName) => {
            if (!charDir) return false;
            try {
                await getChatRepo().rename(handle, charDir, String(oldName), String(newName));
                return true;
            } catch (error) {
                console.warn('stscript renameChat failed:', error?.message ?? error);
                return false;
            }
        },
        // /rename-char → /api/characters/rename 同语义服务化:卡名写回 +
        // 新文件名落盘 + charDir 聊天迁移 + state sidecar 随迁。
        // 重 import 走 lazy(stscript-env ↔ mvu-settle ↔ chats 静态环)。
        // opts.renameChats=true 追加历史楼层 name 重写(上游确认弹窗选是)。
        renameCharacter: async (newName, { renameChats } = {}) => {
            if (!charDir) return false;
            // 仅共享卡在场 → 先物化成私有 copy,改名只动私有档。
            const mergedForRename = resolveCharacterFileMerged(directories, charDir);
            if (!mergedForRename) return false;
            if (mergedForRename.shared) {
                try {
                    await materializeSharedCharacter(directories, charDir);
                } catch (error) {
                    console.warn('stscript renameCharacter: materialize failed:', error?.message ?? error);
                    return false;
                }
            }
            const oldInternalName = charDir;
            const oldAvatarPath = path.join(directories.characters, `${oldInternalName}.png`);
            if (!await fs.stat(oldAvatarPath).catch(() => null)) {
                console.warn(`stscript renameCharacter: ${oldAvatarPath} not found (json/webp cards unsupported)`);
                return false;
            }
            const { readCharacterData, writeCharacterData } = await import('../endpoints/characters.js');
            const { invalidateRecentChatIndex } = await import('../endpoints/chats.js');
            const fakeReq = { user: { profile: { handle, name: name1 }, directories } };
            // getPngName 等价:新内部名避让(自身除外)
            let newInternalName = newName;
            for (let i = 1; await fs.stat(path.join(directories.characters, `${newInternalName}.png`)).catch(() => null) || await fs.stat(path.join(directories.chats, newInternalName)).catch(() => null); i++) {
                newInternalName = `${newName}${i}`;
            }
            try {
                const oldData = JSON.parse(await readCharacterData(oldAvatarPath));
                oldData.data ??= {};
                const oldDisplayName = oldData.data.name ?? oldData.name;
                oldData.data.name = newName;
                const ok = await writeCharacterData(oldAvatarPath, JSON.stringify(oldData), newInternalName, fakeReq);
                if (!ok) return false;
                await getChatRepo().renameCharDir(handle, oldInternalName, newInternalName);
                const oldChatsPath = path.join(directories.chats, oldInternalName);
                const newChatsPath = path.join(directories.chats, newInternalName);
                if (await fs.stat(oldChatsPath).catch(() => null) && !await fs.stat(newChatsPath).catch(() => null)) {
                    await fs.cp(oldChatsPath, newChatsPath, { recursive: true });
                    await fs.rm(oldChatsPath, { recursive: true, force: true });
                }
                await invalidateRecentChatIndex(fakeReq);
                renameAllCharacterStateSidecars(oldAvatarPath, path.join(directories.characters, `${newInternalName}.png`));
                await fs.rm(oldAvatarPath, { force: true });
                // renameChats:重写历史楼层 name(上游 renamePastMessages)。
                // 逐会话 patch /body/<i>/name —— 与 PATCH 路由同写面。
                if (renameChats === true && oldDisplayName) {
                    const repo = getChatRepo();
                    const chats = await repo.listForCharacter(handle, newInternalName, { limit: 2000 });
                    for (const entry of chats ?? []) {
                        const chatKey = entry?.key?.name;
                        if (!chatKey) continue;
                        const doc = await repo.get(handle, newInternalName, chatKey);
                        const ops = (doc?.body ?? [])
                            .map((m, i) => (m?.name === oldDisplayName ? { op: 'replace', path: `/body/${i}/name`, value: newName } : null))
                            .filter(Boolean);
                        if (ops.length) await repo.patch(handle, newInternalName, chatKey, ops, doc.integrity);
                    }
                }
                return true;
            } catch (error) {
                console.warn('stscript renameCharacter failed:', error?.message ?? error);
                return false;
            }
        },
        // generateImpersonate 不绑 —— trigger-generation 目前只载
        // normal|swipe 动词;impersonate 的 user 侧落楼路径未通,与其
        // 挂错语义不如引擎显式报错(GH#9 同路)。
        // /persona-set(=上游 setUserName)→ settings.username 落档。
        // 注意 name1 派生序 personas[default_persona] > settings.username —
        // temp 改名只在未选 persona 时影响后续 run,与上游加载语义一致。
        setUserName: (name) => {
            settings.username = String(name ?? '');
            void getSettingsRepo().save(handle, settings)
                .catch((e) => console.warn('stscript setUserName failed:', e?.message));
        },
        // /persona-set lookup/all 命中 → power_user.default_persona 落档
        // (服务端 persona 选中口径与 users.js:816 / chats.js:2845 一致:
        // default_persona 优先,settings.user_avatar 兜底)。
        selectPersona: (avatarKey) => {
            powerUser.default_persona = String(avatarKey ?? '');
            void getSettingsRepo().save(handle, settings)
                .catch((e) => console.warn('stscript selectPersona failed:', e?.message));
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

    // refreshChatState 一并透出:生成 commit 后对齐 env 活态与盘上
    // 最新 revision 的原语 —— 生成链 finally 调,调用方在自定义
    // commit 路径(如测试/外部生成写面)后同样可显式 resync。
    return { env, macro, settings, chat, chatMetadata, card, sinks, refreshChatState };
}
