/**
 * 会话/角色命名族 — 移植自 ref/Luker public/scripts/slash-commands.js:
 * /renamechat /getchatname /forcesave /rename-char /impersonate。
 *
 * 落点(TASK-064 批二):
 * - /renamechat → host.renameChat(服务端 = ChatRepo.rename,同一写面);
 *   成功后 currentChatId 指向新名(env.macro 为活对象)
 * - /getchatname → env.macro.currentChatId(零 seam)
 * - /forcesave → persistChat + persistSettings(已绑 seam 复用)
 * - /rename-char → host.renameCharacter(重副作用:卡文件+charDir 迁移
 *   +可选历史聊天消息名重写);未绑显式报错,不静默
 * - /impersonate → host.generateImpersonate(=Generate('impersonate'));
 *   未绑显式报错,与 /trigger(GH#9)同一路线
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, booleanEnumProvider } from '../types.js';
import type { StscriptEnv } from '../env.js';
import { addCommandObject } from '../registry.js';
import { isTrueBoolean } from '../util.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

const unnamed = (value: UnnamedArguments): string =>
    String(Array.isArray(value) ? value.join(' ') : value ?? '');

/** doRenameChat — renameChat(currentChatName, newName) → host seam。 */
export async function renameChatCallback(args: NamedArguments, chatName: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const newName = unnamed(chatName).trim();
    if (!newName) {
        await env.host.notify?.('warning', undefined, 'Name must be provided as an argument to rename this chat.');
        return '';
    }
    const currentChatName = env.macro.currentChatId;
    if (!currentChatName) {
        await env.host.notify?.('warning', undefined, 'No chat selected that can be renamed.');
        return '';
    }
    if (typeof env.host.renameChat !== 'function') {
        throw new Error('/renamechat requires host.renameChat seam — not bound on this host');
    }
    const renamed = await env.host.renameChat(currentChatName, newName);
    if (!renamed) {
        await env.host.notify?.('error', undefined, `Failed to rename chat to: ${newName}`);
        return '';
    }
    env.macro.currentChatId = newName;
    await env.host.notify?.('success', undefined, `Successfully renamed chat to: ${newName}`);
    return '';
}

/** doGetChatName — 当前会话名入管道。 */
export async function getChatNameCallback(args: NamedArguments): Promise<string> {
    const env = envOf(args);
    return String(env.macro.currentChatId ?? '');
}

/** forcesave — saveSettings + saveChatConditional 的脚本等价。 */
export async function forceSaveCallback(args: NamedArguments): Promise<string> {
    const env = envOf(args);
    await env.host.persistChat?.();
    env.host.persistMetadata?.();
    env.host.persistSettings?.();
    await env.host.notify?.('success', undefined, 'Chat and settings saved.');
    return '';
}

/** /rename-char → script.js renameCharacter 的服务端面(seam 全包)。 */
export async function renameCharCallback(args: NamedArguments, name: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const silent = isTrueBoolean(args['silent'] ?? 'true');
    const renameChats = args['chats'] !== undefined && args['chats'] !== null ? isTrueBoolean(args['chats']) : null;
    const newName = unnamed(name).trim();

    if (!newName && silent) {
        await env.host.notify?.('warning', undefined, 'No character name provided.');
        return 'false';
    }
    if (!env.host.currentCharAvatar) {
        await env.host.notify?.('warning', undefined, 'No character selected.');
        return 'false';
    }
    if (typeof env.host.renameCharacter !== 'function') {
        throw new Error('/rename-char requires host.renameCharacter seam — not bound on this host');
    }
    const renamed = await env.host.renameCharacter(newName, { silent, renameChats });
    return String(renamed);
}

/**
 * /impersonate → Generate('impersonate', {quiet_prompt, quietToLoud})。
 * 上游等生成锁 + 防重入;服务端生成链未绑 → 显式报错(GH#9 同路)。
 */
export async function impersonateCallback(args: NamedArguments, prompt: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    if (typeof env.host.generateImpersonate !== 'function') {
        throw new Error('/impersonate requires host.generateImpersonate seam — not bound on this host (use /gen for quiet generation)');
    }
    const promptStr = unnamed(prompt).trim();
    const shouldAwait = isTrueBoolean(args['await']);
    const gen = env.host.generateImpersonate(promptStr ? promptStr : undefined);
    if (shouldAwait) await gen;
    return '';
}

/**
 * /persona-set(别名 /persona /name)→ personas.js setNameCallback。
 * mode=lookup:仅查 persona;temp:仅改名;all:先查后兜底改名。
 * lookup/all 命中 → host.selectPersona(=autoSelectPersona 服务端面)
 * + name1 同步;未绑 warn 退化 setUserName(同名,仅缺 avatar 切换)。
 * temp/兜底 → host.setUserName,未绑显式报错。
 */
export async function personaSetCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const mode = String(args['mode'] ?? 'all').trim();
    const name = unnamed(value).trim();

    if (!name) {
        await env.host.notify?.('warning', undefined, 'You must specify a name to change to');
        return '';
    }
    if (!['lookup', 'temp', 'all'].includes(mode)) {
        await env.host.notify?.('warning', undefined, 'Mode must be one of "lookup", "temp" or "all"');
        return '';
    }

    if (mode !== 'temp') {
        const persona = env.host.findPersona?.(name);
        if (persona?.avatar) {
            if (typeof env.host.selectPersona === 'function') {
                env.host.selectPersona(persona.avatar);
            } else {
                await env.host.notify?.('warning', undefined, 'host.selectPersona unbound — persona name applied without avatar switch');
            }
            env.macro.name1 = persona.name;
            env.host.setUserName?.(persona.name);
            return '';
        }
        if (mode === 'lookup') {
            await env.host.notify?.('warning', undefined, `Persona ${name} not found`);
            return '';
        }
    }

    if (typeof env.host.setUserName !== 'function') {
        throw new Error('/persona-set requires host.setUserName seam — not bound on this host');
    }
    env.host.setUserName(name);
    env.macro.name1 = name;
    return '';
}

export function registerSessionCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'persona-set',
        callback: (args, value) => personaSetCallback(args, value),
        aliases: ['persona', 'name'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'mode', 'The mode for persona selection', [ARGUMENT_TYPE.STRING], false, false, 'all',
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'persona name', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
            <div>
                Sets the persona name for the user. If a persona with a matching name exists, it will be selected.
            </div>
            <div>
                The <code>mode</code> argument controls whether to only search for a persona (lookup), only set the name (temp), or both (all).
            </div>
        `,
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'renamechat',
        callback: (args, value) => renameChatCallback(args, value),
        unnamedArgumentList: [
            new SlashCommandArgument(
                'new chat name', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Renames the current chat.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'getchatname',
        callback: (args) => getChatNameCallback(args),
        returns: 'chat file name',
        helpString: 'Returns the name of the current chat file into the pipe.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'forcesave',
        callback: (args) => forceSaveCallback(args),
        helpString: 'Forces a save of the current chat and settings',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'rename-char',
        callback: (args, value) => renameCharCallback(args, value),
        returns: 'true/false - Whether the rename was successful',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'silent', 'Hide any blocking popups. (if false, the name is optional. If not supplied, a popup asking for it will appear)', [ARGUMENT_TYPE.BOOLEAN], false, false, 'true',
            ),
            new SlashCommandNamedArgument(
                'chats', 'Rename char in all previous chats', [ARGUMENT_TYPE.BOOLEAN], false, false, '<null>',
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'new char name', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: 'Renames the current character.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'impersonate',
        callback: (args, value) => impersonateCallback(args, value),
        aliases: ['imp'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'await', 'Whether to await for the triggered generation before continuing', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false', booleanEnumProvider('trueFalse')(),
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Calls an impersonation response, with an optional additional prompt.
            </div>
            <div>
                If <code>await=true</code> named argument is passed, the command will wait for the impersonation to end before continuing.
            </div>
        `,
    }));
}
