/**
 * 首批 builtin:消息/系统命令 — 移植自 ref/Luker/public/scripts/slash-commands.js。
 * 覆盖:/send /sendas /sys /sysname /comment /echo /input /setinput /trigger
 * /gen /abort /pass(/return) /delay /run —— QR 高频 + 设计文档第一批。
 *
 * 宿主依赖全部经 args._env.host seams;原版里 toastr/DOM 的效果缺失时
 * 降级为 ops 回执 + 正常返回(不阻断脚本)。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandEnumValue, enumTypes, enumIcons, booleanEnumProvider, SlashCommandNamedArgumentAssignment } from '../types.js';
import { SlashCommandClosure } from '../closure.js';
import { SlashCommandBreakController } from '../control.js';
import { substituteParams } from '../../macros/substitute.js';
import { regex_placement } from '../../regex/types.js';
import { delay, extractMessageBias, getMessageTimeStamp, isFalseBoolean, isTrueBoolean, removeMacros } from '../util.js';
import type { StscriptEnv, StscriptMessage, StscriptNotifyOptions } from '../env.js';
import { addCommandObject } from '../registry.js';
import {
    COMMENT_NAME_DEFAULT,
    NARRATOR_NAME_DEFAULT,
    NARRATOR_NAME_KEY,
    SYSTEM_MESSAGE_TYPES,
    doReturn,
    getNameAndAvatarForMessage,
    insertChatMessage,
    regexFilter,
    resolveInsertAt,
    returnEnumList,
} from './common.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

// ---------------------------------------------------------------------------
// /send → sendUserMessageCallback + script.js sendMessageAsUser
// ---------------------------------------------------------------------------

/** script.js sendMessageAsUser — 构造并插入用户消息。 */
export async function sendMessageAsUser(env: StscriptEnv, messageText: string, messageBias: string, insertAt: number | null = null, compact = false, name?: string, avatar?: string): Promise<StscriptMessage> {
    name = name ?? env.macro.name1 ?? '';
    avatar = avatar ?? env.host.userAvatar;
    messageText = regexFilter(env, messageText, regex_placement.USER_INPUT);

    const message: StscriptMessage = {
        name: name,
        is_user: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(messageText, env.macro),
        extra: {
            isSmallSys: compact,
        },
    };

    // power_user.message_token_count_enabled → getTokenCountAsync seam
    if (env.host.messageTokenCountEnabled && env.host.countTokens) {
        message.extra!.token_count = await env.host.countTokens(message.mes);
    }

    // Lock user avatar to a persona.
    if (avatar && env.host.personaAvatarExists?.(avatar)) {
        message.force_avatar = env.host.avatarUrl?.('persona', avatar) ?? avatar;
    }

    if (messageBias) {
        message.extra!.bias = messageBias;
        message.mes = removeMacros(message.mes);
    }

    // populateFileAttachment / statMesProcess → host seam(可选)
    await env.host.attachFiles?.(message);
    await env.host.trackMessageStats?.(message, 'user');

    env.macro.chatMetadata['tainted'] = true;

    await insertChatMessage(env, message, insertAt ?? NaN);

    return message;
}

export async function sendUserMessageCallback(args: NamedArguments, text: unknown): Promise<unknown> {
    const env = envOf(args);
    const textStr = String(text ?? '').trim();
    const compact = isTrueBoolean(args['compact']);
    const bias = extractMessageBias(textStr);
    const insertAt = resolveInsertAt(args, env.macro.chat.length);

    let message;
    if ('name' in args) {
        const name = String(args['name'] ?? '');
        const avatar = env.host.findPersona?.(name)?.avatar || env.host.userAvatar;
        message = await sendMessageAsUser(env, textStr, bias, insertAt, compact, name, avatar);
    } else {
        message = await sendMessageAsUser(env, textStr, bias, insertAt, compact);
    }

    return await doReturn(env, String(args['return'] ?? 'none'), message, { objectToStringFunc: (x) => (x as StscriptMessage).mes });
}

// ---------------------------------------------------------------------------
// /sendas → sendMessageAs
// ---------------------------------------------------------------------------

const sendasWarnedEnvs = new WeakSet<StscriptEnv>();

export async function sendMessageAs(args: NamedArguments, text: unknown): Promise<unknown> {
    const env = envOf(args);
    let name = String(args['name'] ?? '').trim();

    if (!name) {
        // 原版 accountStorage 去重;core 每次 env 只提示一次
        if (!sendasWarnedEnvs.has(env)) {
            await env.host.notify?.('warning', 'Name defaulted to {{char}}', 'To avoid confusion, please use /sendas name="Character Name"', { timeOut: 10000 });
            sendasWarnedEnvs.add(env);
        }
        name = env.macro.name2 ?? '';
    }

    let mesText = String(text ?? '').trim();

    // Requires a regex check after the slash command is pushed to output
    mesText = regexFilter(env, mesText, regex_placement.SLASH_COMMAND, { characterOverride: name });

    // Messages that do nothing but set bias will be hidden from the context
    const bias = extractMessageBias(mesText);
    const isSystem = bias && !removeMacros(mesText).length;
    const compact = isTrueBoolean(args['compact']);

    const character = env.host.resolveCharacter?.(name) ?? null;

    const avatarCharacter = args['avatar'] ? env.host.resolveCharacter?.(String(args['avatar'])) ?? null : character;
    if (args['avatar'] && !avatarCharacter) {
        await env.host.notify?.('warning', undefined, `Character for avatar ${args['avatar']} not found`);
        return '';
    }

    const { name: avatarCharName, force_avatar, original_avatar } = getNameAndAvatarForMessage(env, avatarCharacter, name);

    const message: StscriptMessage = {
        name: character?.name || name || avatarCharName || '',
        is_user: false,
        is_system: isSystem,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(mesText, env.macro),
        force_avatar: force_avatar,
        original_avatar: original_avatar,
        extra: {
            bias: bias.trim().length ? bias : null,
            gen_id: Date.now(),
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    };

    message.swipe_id = 0;
    message.swipes = [message.mes];
    message.swipe_info = [{
        send_date: message.send_date,
        gen_started: null,
        gen_finished: null,
        extra: {
            bias: (message.extra as Record<string, unknown>)['bias'],
            gen_id: (message.extra as Record<string, unknown>)['gen_id'],
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    }];

    const insertAt = resolveInsertAt(args, env.macro.chat.length);

    env.macro.chatMetadata['tainted'] = true;

    await insertChatMessage(env, message, insertAt);

    return await doReturn(env, String(args['return'] ?? 'none'), message, { objectToStringFunc: (x) => (x as StscriptMessage).mes });
}

// ---------------------------------------------------------------------------
// /sys → sendNarratorMessage;/comment → sendCommentMessage;/sysname
// ---------------------------------------------------------------------------

export async function sendNarratorMessage(args: NamedArguments, text: unknown): Promise<unknown> {
    const env = envOf(args);
    const textStr = String(text ?? '');
    const name = String(args['name'] ?? (env.macro.chatMetadata[NARRATOR_NAME_KEY] || NARRATOR_NAME_DEFAULT));
    // Messages that do nothing but set bias will be hidden from the context
    const bias = extractMessageBias(textStr);
    const isSystem = bias && !removeMacros(textStr).length;
    const compact = isTrueBoolean(args['compact']);

    const message: StscriptMessage = {
        name: name,
        is_user: false,
        is_system: isSystem,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(textStr.trim(), env.macro),
        force_avatar: env.host.systemAvatar ?? 'img/logo.png',
        extra: {
            type: SYSTEM_MESSAGE_TYPES.NARRATOR,
            bias: bias.trim().length ? bias : null,
            gen_id: Date.now(),
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    };

    const insertAt = resolveInsertAt(args, env.macro.chat.length);

    env.macro.chatMetadata['tainted'] = true;

    await insertChatMessage(env, message, insertAt);

    return await doReturn(env, String(args['return'] ?? 'none'), message, { objectToStringFunc: (x) => (x as StscriptMessage).mes });
}

export async function sendCommentMessage(args: NamedArguments, text: unknown): Promise<unknown> {
    const env = envOf(args);
    const compact = isTrueBoolean(args['compact']);
    const message: StscriptMessage = {
        name: COMMENT_NAME_DEFAULT,
        is_user: false,
        is_system: true,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(String(text ?? '').trim(), env.macro),
        force_avatar: env.host.commentAvatar ?? 'img/quill.png',
        extra: {
            type: SYSTEM_MESSAGE_TYPES.COMMENT,
            gen_id: Date.now(),
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    };

    const insertAt = resolveInsertAt(args, env.macro.chat.length);

    env.macro.chatMetadata['tainted'] = true;

    await insertChatMessage(env, message, insertAt);

    return await doReturn(env, String(args['return'] ?? 'none'), message, { objectToStringFunc: (x) => (x as StscriptMessage).mes });
}

export function setNarratorName(args: NamedArguments, text: unknown): string {
    const env = envOf(args);
    const name = String(text ?? '') || NARRATOR_NAME_DEFAULT;
    env.macro.chatMetadata[NARRATOR_NAME_KEY] = name;
    return '';
}

// ---------------------------------------------------------------------------
// /echo → echoCallback
// ---------------------------------------------------------------------------

export async function echoCallback(args: NamedArguments, value: unknown): Promise<unknown> {
    const env = envOf(args);
    if (value === '') {
        console.warn('WARN: No argument provided for /echo command');
        return '';
    }

    if (args['severity'] && !['error', 'warning', 'success', 'info'].includes(String(args['severity']))) {
        await env.host.notify?.('warning', undefined, `Invalid severity provided for /echo command: ${args['severity']}`);
        args['severity'] = null;
    }

    // Make sure that the value is a string
    let valueStr = String(value);

    let title: string | undefined = args['title'] ? String(args['title']) : undefined;
    const severity = (args['severity'] ? String(args['severity']) : 'info') as 'error' | 'warning' | 'success' | 'info';

    const options: StscriptNotifyOptions = {};
    if (args['timeout'] && !isNaN(parseInt(String(args['timeout'])))) options.timeOut = parseInt(String(args['timeout']));
    if (args['extendedTimeout'] && !isNaN(parseInt(String(args['extendedTimeout'])))) options.extendedTimeOut = parseInt(String(args['extendedTimeout']));
    if (isTrueBoolean(args['preventDuplicates'])) options.preventDuplicates = true;
    if (args['cssClass']) options.toastClass = [options.toastClass, String(args['cssClass'])].filter(Boolean).join(' ');
    options.escapeHtml = args['escapeHtml'] !== undefined ? isTrueBoolean(args['escapeHtml']) : true;
    if (args['color']) options.color = String(args['color']);

    // Prepare possible await handling
    const awaitDismissal = isTrueBoolean(args['awaitDismissal']);
    let resolveToastDismissal: ((v: string) => void) | undefined;

    if (awaitDismissal) {
        options.onHidden = () => resolveToastDismissal!(valueStr);
    }
    if (args['onClick']) {
        if (args['onClick'] instanceof SlashCommandClosure) {
            options.onClick = async () => {
                // Execute the slash command directly, with its internal scope and everything. Clear progress handler so it doesn't interfere with command execution progress.
                (args['onClick'] as SlashCommandClosure).onProgress = undefined;
                await (args['onClick'] as SlashCommandClosure).execute();
            };
        } else {
            await env.host.notify?.('warning', undefined, 'Invalid onClick provided for /echo command. This is not a closure');
        }
    }

    // 原版 escapeHtml=false 时 DOMPurify.sanitize;core 无 DOMPurify,
    // 直接透传(已知差异:不剥离 style/script 标签)
    if (!options.escapeHtml) {
        if (title) title = String(title);
        valueStr = String(valueStr);
    }

    await env.host.notify?.(severity, title, valueStr, options);
    env.ops.push({ type: 'echo', severity, title, text: valueStr });

    if (awaitDismissal) {
        return new Promise((resolve) => {
            resolveToastDismissal = resolve;
        });
    } else {
        return valueStr;
    }
}

// ---------------------------------------------------------------------------
// /input /setinput /trigger /gen /abort /pass /delay /run
// ---------------------------------------------------------------------------

export async function inputCallback(args: NamedArguments, prompt: unknown): Promise<string> {
    const env = envOf(args);
    const safeValue = String(prompt || ''); // 原版 DOMPurify.sanitize;core 透传(已知差异)
    const defaultInput = args?.['default'] !== undefined && typeof args?.['default'] === 'string' ? args['default'] as string : '';
    const popupOptions = {
        large: isTrueBoolean(args?.['large']),
        wide: isTrueBoolean(args?.['wide']),
        okButton: args?.['okButton'] !== undefined && typeof args?.['okButton'] === 'string' ? args['okButton'] as string : 'Ok',
        rows: args?.['rows'] !== undefined && typeof args?.['rows'] === 'string' ? isNaN(Number(args['rows'])) ? 4 : Number(args['rows']) : 4,
        placeholder: args?.['placeholder'] !== undefined && typeof args?.['placeholder'] === 'string' ? args['placeholder'] as string : null,
        tooltip: args?.['tooltip'] !== undefined && typeof args?.['tooltip'] === 'string' ? args['tooltip'] as string : null,
    };
    // Do not remove this delay, otherwise the prompt will not show up
    await delay(1);
    env.ops.push({ type: 'input', prompt: safeValue });
    const result = env.host.requestInput ? await env.host.requestInput(safeValue, defaultInput, popupOptions) : null;
    await delay(1);

    // Input will return null on nothing entered, and false on cancel clicked
    if (result === null || result === false) {
        // Veryify if a cancel handler exists and it is valid
        if (args?.['onCancel']) {
            if (!(args['onCancel'] instanceof SlashCommandClosure)) {
                throw new Error('argument \'onCancel\' must be a closure for command /input');
            }
            await (args['onCancel'] as SlashCommandClosure).execute();
        }
    } else {
        // Verify if an ok handler exists and it is valid
        if (args?.['onSuccess']) {
            if (!(args['onSuccess'] instanceof SlashCommandClosure)) {
                throw new Error('argument \'onSuccess\' must be a closure for command /input');
            }
            await (args['onSuccess'] as SlashCommandClosure).execute();
        }
    }

    return String(result || '');
}

export function setInputCallback(args: NamedArguments, value: unknown): unknown {
    const env = envOf(args);
    void env.host.setInput?.(String(value ?? ''));
    env.ops.push({ type: 'setinput', text: String(value ?? '') });
    return value;
}

export async function triggerGenerationCallback(args: NamedArguments, value: unknown): Promise<string> {
    const env = envOf(args);
    const shouldAwait = isTrueBoolean(args?.['await']);
    env.ops.push({ type: 'trigger' });
    // GH#9:seam 缺席时 `?? Promise.resolve('')` 让 /trigger 静默假装成功——
    // 脚本以为楼层被生成了,实际什么都没发生。显式报错,让调用方看到
    // 「本宿主没有正常生成触发面」的事实(quiet 链走 /gen,不是这里)。
    if (!env.host.triggerGeneration) {
        throw new Error('/trigger requires host.triggerGeneration seam — not bound on this host (use /gen for quiet generation)');
    }
    const outerPromise = env.host.triggerGeneration(value ? String(value) : undefined) ?? Promise.resolve('');

    if (shouldAwait) {
        await outerPromise;
    }

    return '';
}

export async function generateCallback(args: NamedArguments, value: unknown): Promise<unknown> {
    const env = envOf(args);
    const trim = isTrueBoolean(args?.['trim']?.toString());
    const as = String(args?.['as'] ?? 'system');
    const quietToLoud = as === 'char';
    const length = Number(args?.['length'] ?? 0) || 0;

    if (!env.host.generateQuiet) {
        console.warn('WARN: /gen requires host.generateQuiet seam; returning empty string.');
        return '';
    }

    try {
        const name = args?.['name'];
        const char = name ? env.host.resolveCharacter?.(String(name)) ?? null : null;
        const params = {
            quietToLoud: quietToLoud,
            quietName: char?.name ?? (name !== undefined ? String(name) : undefined),
            responseLength: length,
            trimToSentence: trim,
            forceChId: null,
            stop: args?.['stop'] as string | string[] | undefined,
        };
        env.ops.push({ type: 'gen' });
        const result = await env.host.generateQuiet(String(value ?? ''), params);
        return result;
    } catch (err) {
        console.error('Error on /gen generation', err);
        await env.host.notify?.('error', 'API Error', (err as Error).message, { preventDuplicates: true });
    }
    return '';
}

export function abortCallback(args: NamedArguments, reason: unknown): string {
    const env = envOf(args);
    const quiet = args['quiet'];
    if (quiet instanceof SlashCommandClosure) throw new Error('argument \'quiet\' cannot be a closure for command /abort');
    const reasonText = (reason ?? '').toString().length == 0 ? '/abort command executed' : String(reason);
    const isQuiet = !isFalseBoolean(quiet?.toString() ?? 'true');
    args._abortController!.abort(reasonText, isQuiet);
    env.ops.push({ type: 'abort', reason: reasonText });
    return '';
}

export async function delayCallback(_args: NamedArguments, amount: unknown): Promise<string> {
    if (!amount) {
        console.warn('WARN: No amount provided for /delay command');
        return '';
    }

    let ms = Number(amount);
    if (isNaN(ms)) {
        ms = 0;
    }

    await delay(ms);
    return '';
}

export async function runCallback(args: NamedArguments, name: unknown): Promise<unknown> {
    const env = envOf(args);
    if (!name) {
        throw new Error('No name provided for /run command');
    }

    if (name instanceof SlashCommandClosure) {
        name.breakController = new SlashCommandBreakController();
        return (await name.execute())?.pipe;
    }

    /**@type {SlashCommandScope} */
    const scope = args._scope;
    const nameStr = String(name);
    if (scope.existsVariable(nameStr)) {
        const closure = scope.getVariable(nameStr);
        if (!(closure instanceof SlashCommandClosure)) {
            throw new Error(`"${nameStr}" is not callable.`);
        }
        closure.scope.parent = scope;
        closure.breakController = new SlashCommandBreakController();
        if (args._debugController && !closure.debugController) {
            closure.debugController = args._debugController;
        }
        while (closure.providedArgumentList.pop());
        closure.argumentList.forEach(arg => {
            if (Object.keys(args).includes(arg.name)) {
                const providedArg = new SlashCommandNamedArgumentAssignment();
                providedArg.name = arg.name;
                providedArg.value = args[arg.name] as string;
                closure.providedArgumentList.push(providedArg);
            }
        });
        const result = await closure.execute();
        return result!.pipe;
    }

    if (typeof env.host.runQuickReply !== 'function') {
        throw new Error('Quick Reply extension is not loaded');
    }

    try {
        env.ops.push({ type: 'run', name: nameStr.trim() });
        /**@type {ExecuteSlashCommandsOptions} */
        const options = {
            abortController: args._abortController,
            debugController: args._debugController,
        };
        return await env.host.runQuickReply(nameStr.trim(), args, options);
    } catch (error) {
        throw new Error(`Error running Quick Reply "${nameStr}": ${(error as Error).message}`);
    }
}

/** /pass(别名 /return)— 原样透传值;closure 数组报错的语义照抄。 */
export function passCallback(_args: NamedArguments, arg: UnnamedArguments): unknown {
    // We do not support arrays of closures. Arrays of strings will be send as JSON
    if (Array.isArray(arg) && arg.some(x => x instanceof SlashCommandClosure)) throw new Error('Command /pass does not support multiple closures');
    if (Array.isArray(arg)) return JSON.stringify(arg);
    return arg;
}

// ---------------------------------------------------------------------------
// 注册 — initDefaultSlashCommands 对应片段
// ---------------------------------------------------------------------------

export function registerMessageCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'send',
        rawQuotes: true,
        callback: (args, value) => sendUserMessageCallback(args, value),
        returns: 'Optionally the text of the sent message, if specified in the "return" argument',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'compact',
                'whether to use a compact layout',
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how \'depth\' usually works. For example, -1 will insert the message right before the last message in chat.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'display name',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '{{user}}',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'The way how you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: returnEnumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: 'If true, does not alter quoted literal unnamed arguments',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: booleanEnumProvider('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Adds a user message to the chat log without triggering a generation.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'sendas',
        rawQuotes: true,
        callback: (args, value) => sendMessageAs(args, value),
        returns: 'Optionally the text of the sent message, if specified in the "return" argument',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name - or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'avatar',
                description: 'Character avatar override (Can be either avatar key or just the character name to pull the avatar from)',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'compact',
                description: 'Use compact layout',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how \'depth\' usually works. For example, -1 will insert the message right before the last message in chat.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'The way how you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: returnEnumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: 'If true, does not alter quoted literal unnamed arguments',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: booleanEnumProvider('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Sends a message as a specific character. Uses the character avatar if it exists in the characters list.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'sys',
        rawQuotes: true,
        callback: (args, value) => sendNarratorMessage(args, value),
        aliases: ['nar'],
        returns: 'Optionally the text of the sent message, if specified in the "return" argument',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'compact',
                'compact layout',
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how \'depth\' usually works. For example, -1 will insert the message right before the last message in chat.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Optional custom display name to use for this system narrator message.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'The way how you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: returnEnumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: 'If true, does not alter quoted literal unnamed arguments',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: booleanEnumProvider('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Sends a message as a system narrator.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'sysname',
        callback: (args, value) => setNarratorName(args, value),
        unnamedArgumentList: [
            new SlashCommandArgument(
                'name', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: 'Sets a name for future system narrator messages in this chat (display only). Default: System. Leave empty to reset.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'comment',
        rawQuotes: true,
        callback: (args, value) => sendCommentMessage(args, value),
        returns: 'Optionally the text of the sent message, if specified in the "return" argument',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'compact',
                'Whether to use a compact layout',
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how \'depth\' usually works. For example, -1 will insert the message right before the last message in chat.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'The way how you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: returnEnumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: 'If true, does not alter quoted literal unnamed arguments',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: booleanEnumProvider('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text',
                [ARGUMENT_TYPE.STRING],
                true,
            ),
        ],
        helpString: 'Adds a note/comment message not part of the chat.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'echo',
        rawQuotes: true,
        callback: (args, value) => echoCallback(args, value),
        returns: 'the text',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'title', 'title of the toast message', [ARGUMENT_TYPE.STRING], false,
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'severity',
                description: 'severity level of the toast message',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'info',
                enumProvider: () => [
                    new SlashCommandEnumValue('info', 'info', enumTypes.macro, 'ℹ️'),
                    new SlashCommandEnumValue('warning', 'warning', enumTypes.enum, '⚠️'),
                    new SlashCommandEnumValue('error', 'error', enumTypes.enum, '❗'),
                    new SlashCommandEnumValue('success', 'success', enumTypes.enum, '✅'),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'timeout',
                description: 'time in milliseconds to display the toast message. Set this and \'extendedTimeout\' to 0 to show indefinitely until dismissed.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'extendedTimeout',
                description: 'time in milliseconds to display the toast message. Set this and \'timeout\' to 0 to show indefinitely until dismissed.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'preventDuplicates',
                description: 'prevent duplicate toasts with the same message from being displayed.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'awaitDismissal',
                description: 'wait for the toast to be dismissed before continuing.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cssClass',
                description: 'additional CSS class to add to the toast message (e.g. for custom styling)',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'color',
                description: 'custom CSS color of the toast message. Accepts all valid CSS color values (e.g. \'red\', \'#FF0000\', \'rgb(255, 0, 0)\').',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'escapeHtml',
                description: 'whether to escape HTML in the toast message.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onClick',
                description: 'a closure to call when the toast is clicked. This executed closure receives scope as provided in the script. Careful about possible side effects when manipulating variables and more.',
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: 'If true, does not alter quoted literal unnamed arguments',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: booleanEnumProvider('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Echoes the provided text to a toast message. Can be used to display informational messages or for pipes debugging.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'gen',
        callback: (args, value) => generateCallback(args, value),
        returns: 'generated text',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'trim',
                description: 'Trim the output by the last sentence boundary',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                isRequired: false,
                enumProvider: booleanEnumProvider('trueFalse'),
            }),
            new SlashCommandNamedArgument(
                'lock', 'lock user input during generation', [ARGUMENT_TYPE.BOOLEAN], false, false, null, booleanEnumProvider('onOff')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'in-prompt character name for instruct mode (or unique character identifier (avatar key), which will be used as name)',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'as',
                description: 'role of the generated prompt',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'system',
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('char', null, enumTypes.enum, enumIcons.character),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'length',
                description: 'maximum response length (in tokens) for the generated text',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'stop',
                description: 'a JSON-serialized array of stopping strings',
                typeList: [ARGUMENT_TYPE.LIST],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'instruct-style prompt',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Generates text using the provided prompt.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'abort',
        callback: (args, value) => abortCallback(args, value),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Whether to suppress the toast message notifying about the /abort call.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'The reason for aborting command execution. Shown when quiet=false',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Aborts the slash command batch execution.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'pass',
        callback: (_args, arg) => passCallback(_args, arg),
        returns: 'the provided value',
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.CLOSURE], true,
            ),
        ],
        aliases: ['return'],
        helpString: '/pass (text) – passes the text to the next command through the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'delay',
        callback: (args, value) => delayCallback(args, value),
        aliases: ['wait', 'sleep'],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'milliseconds', [ARGUMENT_TYPE.NUMBER], true,
            ),
        ],
        helpString: 'Delays the next command in the pipe by the specified number of milliseconds.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'input',
        aliases: ['prompt'],
        callback: (args, value) => inputCallback(args, value),
        returns: 'user input',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'default',
                description: 'default value of the input field',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'large',
                description: 'popup window will be shown larger in height, with more space for content (input field needs to be sized via \'rows\' argument)',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'off',
                enumList: booleanEnumProvider('onOff')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wide',
                description: 'popup window will be shown wider, with a wider input field',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'off',
                enumList: booleanEnumProvider('onOff')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'okButton',
                description: 'text for the ok button',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'Ok',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'rows',
                description: 'number of rows for the input field (lines being displayed)',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'placeholder',
                description: 'placeholder text displayed in the input field when empty',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'tooltip',
                description: 'tooltip text shown when hovering over the input field',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onSuccess',
                description: 'closure to execute when the ok button is clicked or the input is closed as successful (via Enter, etc)',
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onCancel',
                description: 'closure to execute when the cancel button is clicked or the input is closed as cancelled (via Escape, etc)',
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'text to display',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Shows a popup with the provided text and an input field.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'run',
        aliases: ['call', 'exec'],
        callback: (args, value) => runCallback(args, value),
        returns: 'result of the executed closure of QR',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'args', 'named arguments', [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY], false, true,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'scoped variable or qr label',
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.CLOSURE],
                isRequired: true,
            }),
        ],
        helpString: 'Runs a closure from a scoped variable, or a Quick Reply with the specified name from a currently active preset or from another preset. Named arguments can be referenced in a QR with {{arg::key}}.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'setinput',
        callback: (args, value) => setInputCallback(args, value),
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Sets the user input to the specified text and passes it to the next command through the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'trigger',
        callback: (args, value) => triggerGenerationCallback(args, value),
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'await', 'Whether to await for the triggered generation before continuing',
                [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'group member index (starts with 0) or name',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Triggers a message generation. If in group, can trigger a message for the specified group member index or name.',
    }));
}
