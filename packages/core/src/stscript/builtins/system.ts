/**
 * 系统/帮助族 — 移植自 ref/Luker public/scripts/slash-commands.js:
 * /?(别名 help)→ helpCommandCallback。
 *
 * 上游 sendSystemMessage(system_message_types.X) 落系统楼;HELP/
 * FORMATTING/HOTKEYS/MACROS 正文是浏览器模板渲染
 * (renderTemplateAsync + SlashCommandBrowser 交互组件)。
 * 服务端无模板引擎 —— 退化为静态文本同义物:命令清单纯文本由
 * 注册表直出(与 /api/utopinn/script/commands 同事实源),其余主题
 * 静态文案。发送通道 host.sendSystemMessage;未绑 → 显式报错。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandEnumValue, enumTypes, enumIcons } from '../types.js';
import type { StscriptEnv } from '../env.js';
import { SlashCommandParser } from '../parser.js';
import { addCommandObject } from '../registry.js';
import { SYSTEM_MESSAGE_TYPES } from './common.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

/** SlashCommandBrowser 的文本退化:注册表内非别名命令逐行列出。 */
function slashCommandsHelpText(): string {
    const lines: string[] = [];
    for (const [key, cmd] of Object.entries(SlashCommandParser.commands)) {
        if (key !== cmd.name) continue;
        const help = String(cmd.helpString ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        lines.push(help ? `/${cmd.name} — ${help}` : `/${cmd.name}`);
    }
    lines.sort((a, b) => a.localeCompare(b));
    return `Slash commands (${lines.length}):\n${lines.join('\n')}`;
}

const HELP_TEXT = `SillyTavern-compatible server. Help topics:
- /? slash   — list registered slash commands (STscript)
- /? macros  — {{macro}} text replacement help
- /? format  — chat/text formatting notes
- /? hotkeys — keyboard shortcuts (browser client only)`;

const FORMATTING_TEXT = `Chat formatting:
- *italic*  **bold**  \`code\`  \`\`\`code block\`\`\`
- Quote a line with > ; strike with ~~text~~.
- {{macros}} expand inline; /commands run from the input or Quick Replies.`;

const HOTKEYS_TEXT = `Keyboard shortcuts are client-side (browser). See the client's shortcut reference.`;

const MACROS_TEXT = `Text replacement macros:
{{user}} {{char}} {{persona}} {{charPersona}} {{scenario}} {{chat}}
{{input}} {{lastMessage}} {{lastUserMessage}} {{lastCharMessage}}
{{random:a,b,c}} {{pick:a,b}} {{roll:d20}} {{time}} {{date}} {{datetime}}
{{getvar::key}} {{getglobalvar::key}} {{idle_duration}} {{model}}`;

/** helpCommandCallback — 主题分派(sendSystemMessage)。 */
export async function helpCommandCallback(args: NamedArguments, type: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    if (typeof env.host.sendSystemMessage !== 'function') {
        throw new Error('/help requires host.sendSystemMessage seam — not bound on this host');
    }
    const topic = String(Array.isArray(type) ? type.join(' ') : type ?? '').trim().toLowerCase();
    switch (topic) {
        case 'slash':
        case 'commands':
        case 'slashes':
        case 'slash commands':
        case '1':
            await env.host.sendSystemMessage(slashCommandsHelpText(), false);
            break;
        case 'format':
        case 'formatting':
        case 'formats':
        case 'chat formatting':
        case '2':
            await env.host.sendSystemMessage(FORMATTING_TEXT, false);
            break;
        case 'hotkeys':
        case 'hotkey':
        case '3':
            await env.host.sendSystemMessage(HOTKEYS_TEXT, false);
            break;
        case 'macros':
        case 'macro':
        case '4':
            await env.host.sendSystemMessage(MACROS_TEXT, false);
            break;
        default:
            await env.host.sendSystemMessage(HELP_TEXT, false);
    }
    return '';
}

export function registerSystemCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: '?',
        callback: (args, value) => helpCommandCallback(args, value),
        aliases: ['help'],
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'help topic',
            typeList: [ARGUMENT_TYPE.STRING],
            enumList: [
                new SlashCommandEnumValue('slash', 'slash commands (STscript)', enumTypes.command, '/'),
                new SlashCommandEnumValue('macros', '{{macros}} (text replacement)', enumTypes.macro, enumIcons.macro),
                new SlashCommandEnumValue('format', 'chat/text formatting', enumTypes.name, '★'),
                new SlashCommandEnumValue('hotkeys', 'keyboard shortcuts', enumTypes.enum, '⏎'),
            ],
        })],
        helpString: 'Get help on macros, chat formatting and commands.',
    }));
}

export { SYSTEM_MESSAGE_TYPES };
