/**
 * 公共回调基底 — 移植自 ref/Luker:
 * - slash-commands/SlashCommandReturnHelper.js:doReturn / enumList
 * - slash-commands.js:sendMessageAs / sendNarratorMessage / sendCommentMessage /
 *   sendMessageAsUser 共用的 chat 插入、insertAt 折算、getNameAndAvatarForMessage
 *
 * DOMPurify + showdown(markdown→html 与 sanitize)在 core 没有依赖,html 通道
 * 交给 env.host.markdownToHtml seam;缺省时原样透传 stringValue(见 doReturn 注记)。
 */
import type { StscriptEnv, StscriptMessage } from '../env.js';
import { getRegexedString } from '../../regex/engine.js';
import { escapeHtml } from '../util.js';
import { enumIcons, enumTypes, SlashCommandEnumValue } from '../types.js';
import type { EnumType } from '../types.js';

export type SlashCommandReturnType = 'pipe' | 'object' | 'chat-html' | 'chat-text' | 'popup-html' | 'popup-text' | 'toast-html' | 'toast-text' | 'console' | 'none';

/** slashCommandReturnHelper.enumList — 返回类型枚举(自动补全元数据)。 */
export function returnEnumList({ allowPipe = true, allowObject = false, allowChat = false, allowPopup = false, allowTextVersion = true }: { allowPipe?: boolean; allowObject?: boolean; allowChat?: boolean; allowPopup?: boolean; allowTextVersion?: boolean } = {}): SlashCommandEnumValue[] {
    return [
        allowPipe && new SlashCommandEnumValue('pipe', 'Return to the pipe for the next command', enumTypes.name, '|'),
        allowObject && new SlashCommandEnumValue('object', 'Return as an object (or array) to the pipe for the next command', enumTypes.variable, enumIcons.dictionary),
        allowChat && new SlashCommandEnumValue('chat-html', 'Sending a chat message with the return value - Can display HTML', enumTypes.command, enumIcons.message),
        allowChat && allowTextVersion && new SlashCommandEnumValue('chat-text', 'Sending a chat message with the return value - Will only display as text', enumTypes.qr as EnumType, enumIcons.message),
        allowPopup && new SlashCommandEnumValue('popup-html', 'Showing as a popup with the return value - Can display HTML', enumTypes.command, enumIcons.popup),
        allowPopup && allowTextVersion && new SlashCommandEnumValue('popup-text', 'Showing as a popup with the return value - Will only display as text', enumTypes.qr as EnumType, enumIcons.popup),
        new SlashCommandEnumValue('toast-html', 'Show the return value as a toast notification - Can display HTML', enumTypes.command, 'ℹ️'),
        allowTextVersion && new SlashCommandEnumValue('toast-text', 'Show the return value as a toast notification - Will only display as text', enumTypes.qr as EnumType, 'ℹ️'),
        new SlashCommandEnumValue('console', 'Log the return value (object, if it can be one) to the console', enumTypes.enum, '>'),
        new SlashCommandEnumValue('none', 'No return value'),
    ].filter((x): x is SlashCommandEnumValue => !!x);
}

export interface DoReturnOptions {
    objectToStringFunc?: (o: unknown) => string;
    objectToHtmlFunc?: ((o: unknown) => string) | null;
}

/**
 * slashCommandReturnHelper.doReturn — 处理 return= 参数的出路。
 * 差异:markdown→html 渲染与 DOMPurify sanitize 不在 core;html 通道经
 * env.host.markdownToHtml(缺省直接透传原文)。popup/chat/toast 经 host seams。
 */
export async function doReturn(env: StscriptEnv | undefined, type: string, value: unknown, { objectToStringFunc = (o: unknown) => o?.toString() ?? '', objectToHtmlFunc = null }: DoReturnOptions = {}): Promise<unknown> {
    const shouldHtml = type.endsWith('html');
    const actualConverterFunc = shouldHtml && objectToHtmlFunc ? objectToHtmlFunc : objectToStringFunc;
    const stringValue = typeof value !== 'string' ? actualConverterFunc(value) : value;

    switch (type) {
        case 'popup-html':
        case 'popup-text':
        case 'chat-text':
        case 'chat-html':
        case 'toast-text':
        case 'toast-html': {
            const htmlOrNotHtml = shouldHtml
                ? (env?.host.markdownToHtml?.(stringValue) ?? stringValue)
                : escapeHtml(stringValue);

            if (type.startsWith('popup')) await env?.host.showPopup?.(htmlOrNotHtml, shouldHtml);
            if (type.startsWith('chat')) await env?.host.sendSystemMessage?.(htmlOrNotHtml, shouldHtml);
            if (type.startsWith('toast')) await env?.host.notify?.('info', undefined, htmlOrNotHtml, { escapeHtml: !shouldHtml });

            return '';
        }
        case 'pipe':
            return stringValue ?? '';
        case 'object':
            return JSON.stringify(value);
        case 'console':
            console.info(value);
            return '';
        case 'none':
            return '';
        default:
            throw new Error(`Unknown return type: ${type}`);
    }
}

// ---------------------------------------------------------------------------
// slash-commands.js 的消息构造/插入公共件
// ---------------------------------------------------------------------------

export const NARRATOR_NAME_KEY = 'narrator_name';
export const NARRATOR_NAME_DEFAULT = 'System';
export const COMMENT_NAME_DEFAULT = 'Note';
export const SYSTEM_MESSAGE_TYPES = {
    HELP: 'help',
    WELCOME: 'welcome',
    EMPTY: 'empty',
    GENERIC: 'generic',
    NARRATOR: 'narrator',
    COMMENT: 'comment',
    SLASH_COMMANDS: 'slash_commands',
    FORMATTING: 'formatting',
    HOTKEYS: 'hotkeys',
    MACROS: 'macros',
    WELCOME_PROMPT: 'welcome_prompt',
    ASSISTANT_NOTE: 'assistant_note',
    ASSISTANT_MESSAGE: 'assistant_message',
} as const;

/**
 * 消息插入 — 原版里直接 chat.splice/push + 事件 + saveChatConditional。
 * core:chat 数组本体直接改(env.macro.chat 即宿主同一引用),持久化与渲染
 * 事件交给 host.appendMessage/persistChat;insertAt 语义与原版一致。
 * 返回实际插入下标(push 时为末尾)。
 */
export async function insertChatMessage(env: StscriptEnv, message: StscriptMessage, insertAt: number): Promise<number> {
    const chat = env.macro.chat as unknown as StscriptMessage[];

    if (!isNaN(insertAt) && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        await env.host.appendMessage?.(message, insertAt);
        await env.host.persistChat?.();
        env.ops.push({ type: 'send', name: message.name, index: insertAt });
        return insertAt;
    }
    chat.push(message);
    await env.host.appendMessage?.(message, null);
    await env.host.persistChat?.();
    env.ops.push({ type: 'send', name: message.name, index: chat.length - 1 });
    return chat.length - 1;
}

/**
 * slash-commands.js getNameAndAvatarForMessage — 角色 avatar 折算。
 * 原版依赖 characters[this_chid]/name2/neutralCharacterName/getThumbnailUrl/
 * default_avatar,全部经 host seams 注入;findChar → host.resolveCharacter。
 */
export function getNameAndAvatarForMessage(
    env: StscriptEnv,
    character: { name: string; avatar?: string } | null,
    name: string | null = null,
): { name: string | undefined; force_avatar?: string; original_avatar?: string } {
    const name2 = env.macro.name2 ?? '';
    const neutralCharacterName = env.host.neutralCharacterName ?? 'Assistant';
    const currentCharAvatar = env.host.currentCharAvatar;
    const isNeutralCharacter = !character && name2 === neutralCharacterName && name === neutralCharacterName;
    const avatarUrl = env.host.avatarUrl ?? ((_kind, id) => id);
    const defaultAvatar = env.host.defaultAvatar ?? 'img/logo.png';

    let force_avatar: string | undefined, original_avatar: string | undefined;
    if (character?.avatar === currentCharAvatar || isNeutralCharacter) {
        // If the targeted character is the currently selected one in a solo chat, we don't need to force any avatars
    } else if (character && character.avatar !== 'none') {
        force_avatar = avatarUrl('avatar', character.avatar!);
        original_avatar = character.avatar;
    } else {
        force_avatar = defaultAvatar;
        original_avatar = defaultAvatar;
    }

    return {
        name: character?.name || name || undefined,
        force_avatar,
        original_avatar,
    };
}

/** slash-commands.js at= 参数折算:负数(含 -0)按 depth 折为 index。 */
export function resolveInsertAt(args: Record<string, unknown>, chatLength: number): number {
    let insertAt = Number(args['at']);
    if (!isNaN(insertAt) && (insertAt < 0 || Object.is(insertAt, -0))) {
        insertAt = chatLength + insertAt;
    }
    return insertAt;
}

/** 正则过滤辅助 — getRegexedString(raw, placement, env 组装的 params)。 */
export function regexFilter(env: StscriptEnv, raw: string, placement: number, extra: { characterOverride?: string; isMarkdown?: boolean; isPrompt?: boolean; depth?: number } = {}): string {
    return getRegexedString(raw, placement, {
        characterOverride: extra.characterOverride,
        isMarkdown: extra.isMarkdown,
        isPrompt: extra.isPrompt,
        depth: extra.depth,
        scripts: env.host.regexScripts ?? [],
        regexDisabled: env.host.regexDisabled,
        perfDetection: env.host.regexPerfDetection,
    }, env.macro);
}

export type { StscriptMessage };
