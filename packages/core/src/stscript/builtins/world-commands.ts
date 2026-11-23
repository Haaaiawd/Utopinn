/**
 * 世界书(World Info)命令族 — 移植自 ref/Luker
 * public/scripts/world-info.js 的 11 条 slash 命令:
 * /world /getchatbook /getglobalbooks /getpersonabook /getcharbook
 * /findentry /getentryfield /createentry /setentryfield
 * /wi-set-timed-effect /wi-get-timed-effect。
 *
 * 落点(TASK-064 批二):
 * - selected_world_info → host.worldInfoSettings.globalSelect 活数组
 *   (settings.world_info.globalSelect),persistSettings 落盘
 * - chat_metadata[METADATA_KEY='world_info'] → env.macro.chatMetadata,
 *   persistMetadata 落盘
 * - power_user.persona_description_lorebook → host.powerUser 活对象
 * - charLore 辅助书 → worldInfoSettings.charLore({name:charDir,extraBooks})
 * - 书 doc 读写 → host.getWorldBook/saveWorldBook/createWorldBook/
 *   listWorldBooks seams(服务端 = WorldInfoRepo)
 * - timed effects → chatMetadata.timedWorldInfo(core WorldInfoTimedEffects
 *   已移植),persistMetadata 落盘
 *
 * 语义差异(最小化,全部有出处):toastr → host.notify;world_names/
 * DOM select → host seams;setPersonaDescription()/reloadEditor()/
 * WORLDINFO_SETTINGS_UPDATED 事件属 UI 刷新,服务端无对价物(记注释)。
 */
import Fuse from 'fuse.js';
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandEnumValue, enumTypes, enumIcons, booleanEnumProvider } from '../types.js';
import type { StscriptEnv, StscriptWorldBook } from '../env.js';
import { addCommandObject } from '../registry.js';
import { isFalseBoolean, isTrueBoolean, uuidv4 } from '../util.js';
import { clone, findCanonicalNameInList, getUniqueName, normalizeArray, onlyUnique, parseStringArray } from '../../utils.js';
import { substituteParams } from '../../macros/substitute.js';
import { WorldInfoTimedEffects } from '../../world-info/timed-effects.js';
import type { WIEntry } from '../../world-info/types.js';
import { newWorldInfoEntryTemplate } from '../../world-info/types.js';
import { createWorldInfoEntry, newWorldInfoEntryDefinition, originalWIDataKeyMap, setWIOriginalDataValue } from '../../world-info/entries.js';

/** world-info.js METADATA_KEY — chat_metadata 中聊天绑定书的键。 */
export const WI_METADATA_KEY = 'world_info';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

const unnamed = (value: UnnamedArguments): string =>
    String(Array.isArray(value) ? value.join(' ') : value ?? '');

/** world_names 等价物;未绑 seam 时按空集处理(读面降级,写面单独判)。 */
async function worldNames(env: StscriptEnv): Promise<string[]> {
    return await env.host.listWorldBooks?.() ?? [];
}

/**
 * getEntriesFromFile — canonical resolve + 读 doc + 非空校验。
 * 上游三级警告各自独立(无效名/坏格式/空书),warn 文案同形。
 */
async function getEntriesFromFile(env: StscriptEnv, file: unknown): Promise<WIEntry[] | null> {
    const names = await worldNames(env);
    const resolvedFile = findCanonicalNameInList(names, file) || String(file ?? '').trim();
    if (!resolvedFile || !findCanonicalNameInList(names, resolvedFile)) {
        await env.host.notify?.('warning', undefined, 'Valid World Info file name is required');
        return null;
    }
    const data = await env.host.getWorldBook?.(resolvedFile);
    if (!data || !('entries' in data)) {
        await env.host.notify?.('warning', undefined, 'World Info file has an invalid format');
        return null;
    }
    const entries = Object.values(data.entries) as WIEntry[];
    if (!entries.length) {
        await env.host.notify?.('warning', undefined, 'World Info file has no entries');
        return null;
    }
    return entries;
}

/** createWorldWithName — 命名冲突校验 + getUniqueName + createWorldBook seam。 */
async function createWorldWithName(env: StscriptEnv, possibleName: unknown, fallbackName?: string): Promise<string> {
    const names = await worldNames(env);
    let newName: string | null = (() => {
        if (typeof possibleName === 'string' && possibleName) {
            if (names.includes(possibleName)) {
                throw new Error('This World Info file name is already in use');
            }
            return possibleName;
        }
        return fallbackName ?? `Lorebook (${uuidv4()})`;
    })();
    newName = getUniqueName(newName, name => names.includes(name));
    if (newName === null) {
        throw new Error('Could not generate a unique World Info file name');
    }
    if (typeof env.host.createWorldBook !== 'function') {
        throw new Error('/getchatbook /getpersonabook /getcharbook create= requires host.createWorldBook seam — not bound on this host');
    }
    return await env.host.createWorldBook(newName) ?? newName;
}

/** 上游 fallback 书名清洗(.replace(/[^a-z0-9 -]/gi,'_') 双下划线折叠 64 截断)。 */
const sanitizeBookName = (s: string): string =>
    s.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64);

/** 'Foo.png' → 'Foo'(getCharaFilename 等价;其他扩展名剥最后一段)。 */
const avatarToCharDir = (avatar: string): string => avatar.replace(/\.[^./\\]+$/, '');

/**
 * findChar({name, allowAvatar:true}) 等价:先 resolveCharacter(卡名),
 * 再按 avatar key 直查('X.png' 形态)。返回 {name, avatar} 或 null。
 */
async function resolveChar(env: StscriptEnv, identifier: string): Promise<{ name: string; avatar: string } | null> {
    const byName = env.host.resolveCharacter?.(identifier);
    const resolved = byName instanceof Promise ? await byName : byName;
    if (resolved) return { name: resolved.name, avatar: resolved.avatar ?? identifier };
    if (env.host.loadCharacterCard) {
        const card = await env.host.loadCharacterCard(identifier);
        if (card) return { name: card.name ?? avatarToCharDir(identifier), avatar: identifier };
    }
    return null;
}

// ---------------------------------------------------------------------------
// /world — onWorldInfoChange 的 slash 分支(启停全局书)
// ---------------------------------------------------------------------------

export async function worldCallback(args: NamedArguments, text: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const wiSettings = env.host.worldInfoSettings;
    if (!wiSettings) {
        await env.host.notify?.('warning', undefined, '/world: no world_info settings bound on this host');
        return '';
    }
    if (!Array.isArray(wiSettings.globalSelect)) wiSettings.globalSelect = [];
    const selected = wiSettings.globalSelect;
    const silent = isTrueBoolean(args['silent']);
    const input = unnamed(text);

    if (input.trim() !== '') {
        const names = await worldNames(env);
        for (const worldName of input.trim().toLowerCase().split(',')) {
            // getWIElement:option 文本大小写不敏感精确匹配 → canonical 名
            const canonical = names.find(n => n.toLowerCase() === worldName);
            if (canonical) {
                const state = String(args['state'] ?? '');
                switch (state) {
                    case 'off': {
                        if (selected.includes(canonical)) {
                            selected.splice(selected.indexOf(canonical), 1);
                            if (!silent) await env.host.notify?.('success', undefined, `Deactivated world: ${canonical}`);
                        } else {
                            if (!silent) await env.host.notify?.('error', undefined, `World was not active: ${canonical}`);
                        }
                        break;
                    }
                    case 'toggle': {
                        if (selected.includes(canonical)) {
                            selected.splice(selected.indexOf(canonical), 1);
                            if (!silent) await env.host.notify?.('success', undefined, `Deactivated world: ${canonical}`);
                        } else {
                            selected.push(canonical);
                            if (!silent) await env.host.notify?.('success', undefined, `Activated world: ${canonical}`);
                        }
                        break;
                    }
                    case 'on':
                    default: {
                        selected.push(canonical);
                        if (!silent) await env.host.notify?.('success', undefined, `Activated world: ${canonical}`);
                    }
                }
            } else {
                if (!silent) await env.host.notify?.('error', undefined, `No world found named: ${worldName}`);
            }
        }
    } else {
        if (!silent) await env.host.notify?.('success', undefined, 'Deactivated all worlds');
        selected.length = 0;
    }

    // saveSettingsDebounced → persistSettings;WORLDINFO_SETTINGS_UPDATED 事件无服务端对价物
    env.host.persistSettings?.();
    return '';
}

// ---------------------------------------------------------------------------
// get*book 四读一建(getChatBook/getGlobalBooks/getPersonaBook/getCharBook)
// ---------------------------------------------------------------------------

export async function getChatBookCallback(args: NamedArguments): Promise<string> {
    const env = envOf(args);
    const chatId = env.macro.currentChatId;
    if (!chatId) {
        await env.host.notify?.('warning', undefined, 'Open a chat to get a name of the chat-bound lorebook');
        return '';
    }
    const bound = env.macro.chatMetadata[WI_METADATA_KEY];
    const names = await worldNames(env);
    if (bound && names.includes(String(bound))) {
        return String(bound);
    }
    if (isFalseBoolean(String(args['create']))) {
        return '';
    }
    const newName = await createWorldWithName(env, args['name'], sanitizeBookName(`Chat Book ${chatId}`));
    env.macro.chatMetadata[WI_METADATA_KEY] = newName;
    env.host.persistMetadata?.();
    return newName;
}

export async function getGlobalBooksCallback(args: NamedArguments): Promise<string> {
    const env = envOf(args);
    const selected = env.host.worldInfoSettings?.globalSelect;
    if (!Array.isArray(selected) || !selected.length) {
        return JSON.stringify([]);
    }
    return JSON.stringify(selected.slice());
}

export async function getPersonaBookCallback(args: NamedArguments): Promise<string> {
    const env = envOf(args);
    const bookName = String(env.host.powerUser?.['persona_description_lorebook'] ?? '');
    if (bookName) {
        return bookName;
    }
    if (isTrueBoolean(String(args['create']))) {
        if (!env.host.powerUser) {
            throw new Error('/getpersonabook create= requires host.powerUser seam — not bound on this host');
        }
        const newName = await createWorldWithName(env, args['name'], sanitizeBookName(`Persona Book ${env.macro.name1 ?? ''}`));
        env.host.powerUser['persona_description_lorebook'] = newName;
        env.host.persistSettings?.();
        return newName;
    }
    return '';
}

export async function getCharBookCallback(args: NamedArguments, characterIdentifierRaw: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    // 上游 group 分支:服务端无群聊上下文,跳过(群支持到位后按上游补)
    let type = String(args['type'] ?? '').trim().toLowerCase() || 'primary';
    let identifier = String(Array.isArray(characterIdentifierRaw) ? characterIdentifierRaw.join(' ') : characterIdentifierRaw ?? '') || env.host.currentCharAvatar || '';
    if (!identifier) {
        await env.host.notify?.('error', undefined, 'Character not found.');
        return '';
    }
    const character = await resolveChar(env, identifier);
    if (!character) {
        await env.host.notify?.('error', undefined, 'Character not found.');
        return '';
    }
    const books: string[] = [];
    const card = character.avatar && env.host.loadCharacterCard ? await env.host.loadCharacterCard(character.avatar) : null;
    const primaryWorld = String(card?.data?.extensions?.world ?? card?.data?.world ?? '');
    if (type === 'all' || (type === 'primary' && primaryWorld)) {
        if (primaryWorld) books.push(primaryWorld);
    }
    if (type === 'all' || type === 'additional') {
        const fileName = avatarToCharDir(character.avatar ?? '');
        const extraCharLore = env.host.worldInfoSettings?.charLore?.find(e => e.name === fileName);
        if (extraCharLore && Array.isArray(extraCharLore.extraBooks)) {
            books.push(...extraCharLore.extraBooks.filter(onlyUnique).filter(Boolean));
        }
    }

    if (isTrueBoolean(String(args['create'])) && books.length === 0) {
        const newName = await createWorldWithName(env, args['name'], sanitizeBookName(`Character Book ${character.name}`));
        if (type === 'additional') {
            // charUpdateAddAuxWorld:charLore[name=charDir].extraBooks 追加
            const fileName = avatarToCharDir(character.avatar ?? '');
            const wiSettings = env.host.worldInfoSettings;
            if (!wiSettings) {
                throw new Error('/getcharbook type=additional create= requires host.worldInfoSettings seam — not bound on this host');
            }
            const charLore = wiSettings.charLore ?? [];
            const idx = charLore.findIndex(e => e.name === fileName);
            const next = normalizeArray([...(idx !== -1 ? (charLore[idx]?.extraBooks ?? []) : []), newName]);
            if (idx === -1) charLore.push({ name: fileName, extraBooks: next });
            else charLore[idx] = { name: charLore[idx]!.name, extraBooks: next };
            wiSettings.charLore = charLore;
            env.host.persistSettings?.();
        } else {
            // charUpdatePrimaryWorld:writeExtensionField('world')
            if (typeof env.host.setCharacterWorld !== 'function') {
                throw new Error('/getcharbook create= requires host.setCharacterWorld seam — not bound on this host');
            }
            await env.host.setCharacterWorld(character.avatar ?? '', newName);
        }
        books.push(newName);
    }

    return type === 'primary' ? (books[0] ?? '') : JSON.stringify(books.filter(onlyUnique).filter(Boolean));
}

// ---------------------------------------------------------------------------
// 条目 CRUD:findentry / getentryfield / createentry / setentryfield
// ---------------------------------------------------------------------------

export async function findEntryCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const file = args['file'];
    const field = String(args['field'] ?? 'key') || 'key';
    const entries = await getEntriesFromFile(env, file);
    if (!entries) return '';

    let needle = unnamed(value);
    if (typeof newWorldInfoEntryTemplate[field] === 'boolean') {
        if (isTrueBoolean(needle)) needle = String(true);
        if (isFalseBoolean(needle)) needle = String(false);
    }

    const fuse = new Fuse(entries, {
        keys: [{ name: field, weight: 1 }],
        includeScore: true,
        threshold: 0.3,
    });
    const results = fuse.search(needle);
    if (!results?.length) return '';
    const result = results[0]?.item?.uid;
    if (result === undefined) return '';
    return String(result);
}

export async function getEntryFieldCallback(args: NamedArguments, uidArg: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const file = args['file'];
    const field = String(args['field'] ?? 'content') || 'content';
    const tags = await env.host.listTags?.() ?? [];
    const entries = await getEntriesFromFile(env, file);
    if (!entries) return '';

    const uid = unnamed(uidArg);
    const entry = entries.find(x => String(x.uid) === String(uid));
    if (!entry) {
        await env.host.notify?.('warning', undefined, 'Valid UID is required');
        return '';
    }
    if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
        await env.host.notify?.('warning', undefined, 'Valid field name is required');
        return '';
    }

    let fieldValue: unknown;
    switch (field) {
        case 'characterFilterNames':
            if (entry.characterFilter) {
                fieldValue = entry.characterFilter.names;
            }
            break;
        case 'characterFilterTags':
            if (entry.characterFilter) {
                if (!entry.characterFilter.tags) {
                    return '';
                }
                fieldValue = tags.filter(tag => (entry.characterFilter!.tags as string[]).includes(tag.id)).map(tag => tag.name);
            }
            break;
        case 'characterFilterExclude':
            if (entry.characterFilter) {
                fieldValue = entry.characterFilter.isExclude;
            }
            break;
        default:
            fieldValue = entry[field] ?? newWorldInfoEntryDefinition[field]?.default;
    }

    if (fieldValue === undefined) {
        return '';
    }
    if (Array.isArray(fieldValue)) {
        return JSON.stringify(fieldValue.map(x => substituteParams(String(x), env.macro)));
    }
    return substituteParams(String(fieldValue), env.macro);
}

export async function createEntryCallback(args: NamedArguments, content: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const file = args['file'];
    const key = args['key'];
    const data = await env.host.getWorldBook?.(String(file ?? ''));
    if (!data || !('entries' in data)) {
        await env.host.notify?.('warning', undefined, 'Valid World Info file name is required');
        return '';
    }
    const entry = createWorldInfoEntry(String(file ?? ''), data as StscriptWorldBook & { entries: Record<string | number, Record<string, unknown>> });
    if (!entry) return '';
    if (key) {
        (entry['key'] as string[]).push(String(key));
        entry['addMemo'] = true;
        entry['comment'] = String(key);
    }
    const contentStr = unnamed(content);
    if (contentStr) {
        entry['content'] = contentStr;
    }
    await env.host.saveWorldBook?.(String(file ?? ''), data);
    // reloadEditor(file) — UI 刷新,服务端无对价物
    return String(entry['uid']);
}

export async function setEntryFieldCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const file = args['file'];
    const uid = args['uid'];
    const field = String(args['field'] ?? 'content') || 'content';
    const tags = await env.host.listTags?.() ?? [];

    const createCharacterFilterFieldObjectIfNeeded = (currentEntry: WIEntry) => {
        if (!currentEntry.characterFilter) {
            Object.assign(currentEntry, {
                characterFilter: { isExclude: false, names: [], tags: [] },
            });
        }
    };

    let rawValue: unknown = Array.isArray(value) ? value.join(' ') : value;
    if (rawValue === undefined) {
        await env.host.notify?.('warning', undefined, 'Value is required');
        return '';
    }
    const valueStr = String(rawValue).replace(/\\([{}|])/g, '$1');

    const data = await env.host.getWorldBook?.(String(file ?? ''));
    if (!data || !('entries' in data)) {
        await env.host.notify?.('warning', undefined, 'Valid World Info file name is required');
        return '';
    }
    const entry = (data.entries as Record<string, WIEntry>)[String(uid)];
    if (!entry) {
        await env.host.notify?.('warning', undefined, 'Valid UID is required');
        return '';
    }
    if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
        await env.host.notify?.('warning', undefined, 'Valid field name is required');
        return '';
    }
    if (!Object.hasOwn(entry, field)) {
        entry[field] = clone(newWorldInfoEntryDefinition[field]!.default);
    }
    const arrayFilter = newWorldInfoEntryDefinition[field]?.arrayFilter || (() => true);

    switch (field) {
        case 'characterFilterNames': {
            createCharacterFilterFieldObjectIfNeeded(entry);
            const charNames = parseStringArray(valueStr);
            const resolved: string[] = [];
            for (const name of charNames) {
                const char = await resolveChar(env, name);
                const avatar = char?.avatar;
                if (avatar) resolved.push(avatarToCharDir(avatar));
            }
            entry.characterFilter!.names = resolved.filter(onlyUnique);
            setWIOriginalDataValue(data, String(uid), 'character_filter', entry.characterFilter);
            break;
        }
        case 'characterFilterTags': {
            createCharacterFilterFieldObjectIfNeeded(entry);
            const tagNames = parseStringArray(valueStr);
            entry.characterFilter!.tags = tags.filter(tag => tagNames.includes(tag.name)).map(tag => tag.id);
            setWIOriginalDataValue(data, String(uid), 'character_filter', entry.characterFilter);
            break;
        }
        case 'characterFilterExclude': {
            createCharacterFilterFieldObjectIfNeeded(entry);
            entry.characterFilter!.isExclude = isTrueBoolean(valueStr);
            setWIOriginalDataValue(data, String(uid), 'character_filter', entry.characterFilter);
            break;
        }
        default: {
            const cur = entry[field];
            if (Array.isArray(cur)) {
                entry[field] = parseStringArray(valueStr).filter(arrayFilter);
            } else if (typeof cur === 'boolean') {
                entry[field] = isTrueBoolean(valueStr);
            } else if (typeof cur === 'number') {
                entry[field] = Number(valueStr);
            } else {
                entry[field] = valueStr;
            }
            if (originalWIDataKeyMap[field]) {
                setWIOriginalDataValue(data, String(uid), originalWIDataKeyMap[field], entry[field]);
            }
        }
    }

    await env.host.saveWorldBook?.(String(file ?? ''), data);
    return '';
}

// ---------------------------------------------------------------------------
// wi-*-timed-effect — WorldInfoTimedEffects 直调(sticky/cooldown/delay)
// ---------------------------------------------------------------------------

/** getScanningChat 等价:效应只看 chat.length,传 mes 文本数组即可。 */
const scanningChat = (env: StscriptEnv): string[] =>
    (env.macro.chat as unknown as { mes?: string }[]).map(m => String(m?.mes ?? ''));

function timedEntry(env: StscriptEnv, entries: WIEntry[], uid: unknown, file: unknown): WIEntry | null {
    const entry = clone(entries.find(x => String(x.uid) === String(uid)) ?? null) as WIEntry | null;
    if (!entry) return null;
    entry.world = String(file ?? ''); // Required by the timed effects manager(键=world.uid)
    return entry;
}

export async function getTimedEffectCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    if (!env.macro.currentChatId) {
        throw new Error('This command can only be used in chat');
    }
    const file = args['file'];
    const uid = unnamed(value);
    const effect = String(args['effect'] ?? '');
    const entries = await getEntriesFromFile(env, file);
    if (!entries) return '';
    const entry = timedEntry(env, entries, uid, file);
    if (!entry) {
        await env.host.notify?.('warning', undefined, 'Valid UID is required');
        return '';
    }
    const timedEffects = new WorldInfoTimedEffects(scanningChat(env), [entry], env.macro.chatMetadata);
    if (!timedEffects.isValidEffectType(effect)) {
        await env.host.notify?.('warning', undefined, 'Valid effect type is required');
        return '';
    }
    const data = timedEffects.getEffectMetadata(effect, entry);
    if (String(args['format'] ?? '').trim().toLowerCase() === ARGUMENT_TYPE.NUMBER) {
        return String(data ? (data.end - scanningChat(env).length) : 0);
    }
    return String(!!data);
}

export async function setTimedEffectCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    if (!env.macro.currentChatId) {
        throw new Error('This command can only be used in chat');
    }
    const file = args['file'];
    const uid = args['uid'];
    const effect = String(args['effect'] ?? '');

    const valueStr = unnamed(value);
    if (valueStr === undefined || valueStr === '') {
        // 上游 value===undefined 判空;'' 经 enum 也不可能为合法新状态,同路径
        await env.host.notify?.('warning', undefined, 'New state is required');
        return '';
    }

    const entries = await getEntriesFromFile(env, file);
    if (!entries) return '';
    const entry = timedEntry(env, entries, uid, file);
    if (!entry) {
        await env.host.notify?.('warning', undefined, 'Valid UID is required');
        return '';
    }
    const timedEffects = new WorldInfoTimedEffects(scanningChat(env), [entry], env.macro.chatMetadata);
    if (!timedEffects.isValidEffectType(effect)) {
        await env.host.notify?.('warning', undefined, 'Valid effect type is required');
        return '';
    }
    if (!entry[effect as keyof WIEntry]) {
        await env.host.notify?.('warning', undefined, 'This entry does not have the selected effect. Configure it in the editor first.');
        return '';
    }

    const getNewEffectState = (): boolean => {
        const currentState = !!timedEffects.getEffectMetadata(effect as 'sticky' | 'cooldown' | 'delay', entry);
        if (['toggle', 't', ''].includes(valueStr.trim().toLowerCase())) {
            return !currentState;
        }
        if (isTrueBoolean(valueStr)) return true;
        if (isFalseBoolean(valueStr)) return false;
        return currentState;
    };

    const newEffectState = getNewEffectState();
    timedEffects.setTimedEffect(effect as 'sticky' | 'cooldown' | 'delay', entry, newEffectState);
    env.host.persistMetadata?.();
    await env.host.notify?.('success', undefined, `Timed effect "${effect}" for entry ${entry.uid} is now ${newEffectState ? 'active' : 'inactive'}`);
    return '';
}

// ---------------------------------------------------------------------------
// 注册 — T7 WI 族 11 命令(参数面/别名与上游同形)
// ---------------------------------------------------------------------------

const wiFieldEnums = (): SlashCommandEnumValue[] =>
    Object.entries(newWorldInfoEntryDefinition).map(([key, def]) =>
        new SlashCommandEnumValue(key, `[${def.type}] default: ${(typeof def.default === 'string' ? `'${def.default}'` : JSON.stringify(def.default))}`, enumTypes.enum, enumIcons.default));

export function registerWorldCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'world',
        callback: (args, text) => worldCallback(args, text),
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'state', 'set world state', [ARGUMENT_TYPE.STRING], false, false, null,
                booleanEnumProvider('onOffToggle')(),
            ),
            new SlashCommandNamedArgument(
                'silent', 'suppress toast messages', [ARGUMENT_TYPE.BOOLEAN], false,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'world name',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: `
            <div>
                Sets active World, or unsets if no args provided, use <code>state=off</code> and <code>state=toggle</code> to deactivate or toggle a World, use <code>silent=true</code> to suppress toast messages.
            </div>
        `,
        aliases: [],
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getchatbook',
        callback: (args) => getChatBookCallback(args),
        returns: 'lorebook name',
        helpString: 'Get a name of the chat-bound lorebook or create a new one if was unbound, and pass it down the pipe.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: booleanEnumProvider('trueFalse')(),
            }),
        ],
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getglobalbooks',
        callback: (args) => getGlobalBooksCallback(args),
        returns: 'JSON-serialized array of globally active lorebook names',
        helpString: 'Get the list of globally active World Info files (selected_world_info) as JSON.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getpersonabook',
        callback: (args) => getPersonaBookCallback(args),
        returns: 'lorebook name',
        helpString: 'Get a name of the persona-bound lorebook or create a new one if was unbound, and pass it down the pipe.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: booleanEnumProvider('trueFalse')(),
            }),
        ],
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getcharbook',
        callback: (args, value) => getCharBookCallback(args, value),
        returns: 'lorebook name or a list of lorebook names',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'type of the lorebook to get, returns a list for "all" and "additional"',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['primary', 'additional', 'all'].map(v => new SlashCommandEnumValue(v)),
                defaultValue: 'primary',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name - or unique character identifier (avatar key). If not provided, the current character is used.',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Get a name of the character-bound lorebook and pass it down the pipe. Returns empty string if character lorebook is not set. Does not work in group chats without providing a character avatar name.',
        aliases: ['getcharlore', 'getcharwi'],
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'findentry',
        aliases: ['findlore', 'findwi'],
        returns: 'UID',
        callback: (args, value) => findEntryCallback(args, value),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field value for fuzzy match (default: key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'key',
                enumList: wiFieldEnums(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'texts', ARGUMENT_TYPE.STRING, true, true,
            ),
        ],
        helpString: `
            <div>
                Find a UID of the record from the specified book using the fuzzy match of a field value (default: key) and pass it down the pipe.
            </div>
        `,
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getentryfield',
        aliases: ['getlorefield', 'getwifield'],
        callback: (args, uid) => getEntryFieldCallback(args, uid),
        returns: 'field value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field to retrieve (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: wiFieldEnums(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>
                Get a field value (default: content) of the record with the UID from the specified book and pass it down the pipe.
            </div>
        `,
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'createentry',
        callback: (args, content) => createEntryCallback(args, content),
        aliases: ['createlore', 'createwi'],
        returns: 'UID of the new record',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            new SlashCommandNamedArgument(
                'key', 'record key', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'content', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Create a new record in the specified book with the key and content (both are optional) and pass the UID down the pipe.
            </div>
        `,
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'setentryfield',
        callback: (args, value) => setEntryFieldCallback(args, value),
        aliases: ['setlorefield', 'setwifield'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field name (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: wiFieldEnums(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
            <div>
                Set a field value (default: content) of the record with the UID from the specified book. To set multiple values for key fields, use comma-delimited list as a value.
            </div>
        `,
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'wi-set-timed-effect',
        callback: (args, value) => setTimedEffectCallback(args, value),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumList: [
                    new SlashCommandEnumValue('sticky', 'Stays active for N messages', enumTypes.enum, '📌'),
                    new SlashCommandEnumValue('cooldown', 'Cooldown for N messages', enumTypes.enum, '⌛'),
                ],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'new state of the effect',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
                enumList: booleanEnumProvider('onOffToggle')(),
            }),
        ],
        helpString: `
            <div>
                Set a timed effect for the record with the UID from the specified book. The duration must be set in the entry itself.
                Will only be applied for the current chat. Enabling an effect that was already active refreshes the duration.
                If the last chat message is swiped or deleted, the effect will be removed.
            </div>
        `,
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'wi-get-timed-effect',
        callback: (args, value) => getTimedEffectCallback(args, value),
        helpString: `
            <div>
                Get the current state of the timed effect for the record with the UID from the specified book.
            </div>
        `,
        returns: 'state of the effect',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumList: [
                    new SlashCommandEnumValue('sticky', 'Stays active for N messages', enumTypes.enum, '📌'),
                    new SlashCommandEnumValue('cooldown', 'Cooldown for N messages', enumTypes.enum, '⌛'),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'format',
                description: 'format of the returned value (number = remaining duration)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('bool', null, enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('number', null, enumTypes.enum, enumIcons.default),
                ],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
    }));
}
