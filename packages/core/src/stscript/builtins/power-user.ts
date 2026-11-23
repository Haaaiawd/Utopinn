/**
 * power_user 写面族 — 移植自 ref/Luker public/scripts/power-user.js
 * 与 slash-commands.js 的 settings 直写命令:
 * - /stop-strings → power_user.custom_stopping_strings(JSON 数组串,
 *   textgen-body.js 读侧已消费;chat 补全读侧接线属生成链范围)
 * - /start-reply-with → power_user.user_prompt_bias(promptBias,
 *   上游 script.js:5818 生成注入位;服务端组装消费位同上前注)
 * - /single /bubble /flat → power_user.chat_display
 *   (chat_styles DOCUMENT=2 / BUBBLES=1 / DEFAULT=0)
 *
 * 落点:env.host.powerUser 活对象 + persistSettings —— 与 WI 族同写面
 * (settings.power_user 整档回写)。powerUser 未绑 → warn + 返回当前值
 * (空),不静默假写。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, booleanEnumProvider } from '../types.js';
import { isTrueBoolean } from '../util.js';
import type { StscriptEnv } from '../env.js';
import { addCommandObject } from '../registry.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

const unnamed = (value: UnnamedArguments): string =>
    String(Array.isArray(value) ? value.join(' ') : value ?? '');

/** powerUser 活对象;未绑 → null(命令层 warn 降级)。 */
function powerUserOf(env: StscriptEnv): Record<string, unknown> | null {
    return env.host.powerUser ?? null;
}

/** power_user.chat_styles(single=DOCUMENT 2、bubble=BUBBLES 1、flat=DEFAULT 0)。 */
const CHAT_STYLES = { DEFAULT: 0, BUBBLES: 1, DOCUMENT: 2 } as const;

export async function stopStringsCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const pu = powerUserOf(env);
    if (!pu) {
        await env.host.notify?.('warning', undefined, '/stop-strings requires host.powerUser seam — not bound on this host');
        return '';
    }
    const force = isTrueBoolean(String(args?.['force'] ?? 'false'));
    let text = unnamed(value).trim();
    if (!force && !text) {
        return String(pu['custom_stopping_strings'] ?? '');
    }
    if (force && !text) {
        text = JSON.stringify([]);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }
    if (!parsed || !Array.isArray(parsed)) {
        throw new Error('Invalid list format. The value must be a JSON-serialized array of strings.');
    }
    const list = parsed.map((item) => String(item));
    pu['custom_stopping_strings'] = JSON.stringify(list);
    env.host.persistSettings?.();
    return String(pu['custom_stopping_strings']);
}

export async function startReplyWithCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    const pu = powerUserOf(env);
    if (!pu) {
        await env.host.notify?.('warning', undefined, '/start-reply-with requires host.powerUser seam — not bound on this host');
        return '';
    }
    const force = isTrueBoolean(String(args?.['force'] ?? 'false'));
    const text = unnamed(value);
    if (!force && !text) {
        return String(pu['user_prompt_bias'] ?? '');
    }
    pu['user_prompt_bias'] = text;
    env.host.persistSettings?.();
    return String(pu['user_prompt_bias']);
}

export async function chatStyleCallback(args: NamedArguments, style: number): Promise<string> {
    const env = envOf(args);
    const pu = powerUserOf(env);
    if (!pu) {
        await env.host.notify?.('warning', undefined, '/single|/bubble|/flat requires host.powerUser seam — not bound on this host');
        return '';
    }
    pu['chat_display'] = style;
    env.host.persistSettings?.();
    return '';
}

export function registerPowerUserCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'stop-strings',
        aliases: ['stopping-strings', 'custom-stopping-strings', 'custom-stop-strings'],
        callback: (args, value) => stopStringsCallback(args, value),
        returns: ARGUMENT_TYPE.LIST,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'force',
                description: 'force set a value if empty',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'list of strings',
                typeList: [ARGUMENT_TYPE.LIST],
            }),
        ],
        helpString: 'Sets a list of custom stopping strings (JSON-serialized array). Gets the list if no value is provided. Use force=true to force set an empty value.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'start-reply-with',
        callback: (args, value) => startReplyWithCallback(args, value),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'force',
                description: 'force set a value if empty',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: booleanEnumProvider('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'value',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Sets a "Start Reply With". Gets the current value if no value is provided. Use force=true to force set an empty value.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'single',
        aliases: ['story'],
        callback: (args) => chatStyleCallback(args, CHAT_STYLES.DOCUMENT),
        helpString: 'Sets the message style to single document mode without names or avatars visible.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'bubble',
        aliases: ['bubbles'],
        callback: (args) => chatStyleCallback(args, CHAT_STYLES.BUBBLES),
        helpString: 'Sets the message style to bubble chat mode.',
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'flat',
        aliases: ['default'],
        callback: (args) => chatStyleCallback(args, CHAT_STYLES.DEFAULT),
        helpString: 'Sets the message style to flat chat mode.',
    }));
}
