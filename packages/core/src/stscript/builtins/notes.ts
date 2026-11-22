/**
 * 作者注(Author's Note)命令族 — 移植自 ref/Luker
 * public/scripts/authors-note.js 的 /note /note-depth /note-frequency
 * /note-position /note-role。
 *
 * 落点(TASK-064):全部写 env.macro.chatMetadata[note_*] + persistMetadata
 * —— 即会话 metadata,正是 generate-context resolveAuthorsNote 读取的
 * note_prompt/note_interval/note_depth/note_position/note_role 同五个键。
 * 数值语义照抄:depth/interval 存 Number(Math.abs(x));position 映射
 * after|scenario→0 chat→1 before_scenario|before→2;role 映射
 * system→0 user→1 assistant→2。
 *
 * 命名:/note 兼容上游(有参=set、无参=get);note-set/note-get 为 TASK-064
 * 工作令显式点名入口,挂为 /note 的别名 —— 同一命令,语义无分叉。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandEnumValue, enumTypes, enumIcons } from '../types.js';
import type { StscriptEnv } from '../env.js';
import { addCommandObject } from '../registry.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

/** authors-note.js metadata_keys — 与 resolveAuthorsNote 消费的键同名。 */
export const NOTE_METADATA_KEYS = {
    prompt: 'note_prompt',
    interval: 'note_interval',
    depth: 'note_depth',
    position: 'note_position',
    role: 'note_role',
} as const;

const VALID_POSITIONS: Record<string, number> = {
    'after': 0,
    'scenario': 0,
    'chat': 1,
    'before_scenario': 2,
    'before': 2,
};

const VALID_ROLES: Record<string, number> = {
    'system': 0,
    'user': 1,
    'assistant': 2,
};

/** 写 chat_metadata[note_*] + persist + note op 回执(单点)。 */
function noteSet(env: StscriptEnv, key: string, value: unknown): void {
    env.macro.chatMetadata[key] = value;
    env.host.persistMetadata?.();
    env.ops.push({ type: 'note', key, value });
}

const unnamed = (value: UnnamedArguments): string =>
    String(Array.isArray(value) ? value.join(' ') : value ?? '');

export async function setNoteTextCommand(args: NamedArguments, text: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    const value = unnamed(text);
    if (value) {
        noteSet(env, NOTE_METADATA_KEYS.prompt, value);
        await env.host.notify?.('success', undefined, "Author's Note text updated");
    }
    return env.macro.chatMetadata[NOTE_METADATA_KEYS.prompt];
}

export async function setNoteDepthCommand(args: NamedArguments, text: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    const value = unnamed(text);
    if (value) {
        const num = Number(value);
        if (Number.isNaN(num)) {
            await env.host.notify?.('error', undefined, 'Not a valid number');
            return '';
        }
        noteSet(env, NOTE_METADATA_KEYS.depth, Math.abs(num));
        await env.host.notify?.('success', undefined, "Author's Note depth updated");
    }
    return env.macro.chatMetadata[NOTE_METADATA_KEYS.depth];
}

export async function setNoteIntervalCommand(args: NamedArguments, text: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    const value = unnamed(text);
    if (value) {
        const num = Number(value);
        if (Number.isNaN(num)) {
            await env.host.notify?.('error', undefined, 'Not a valid number');
            return '';
        }
        noteSet(env, NOTE_METADATA_KEYS.interval, Math.abs(num));
        await env.host.notify?.('success', undefined, "Author's Note frequency updated");
    }
    return env.macro.chatMetadata[NOTE_METADATA_KEYS.interval];
}

export async function setNotePositionCommand(args: NamedArguments, text: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    const value = unnamed(text);
    if (value) {
        const position = VALID_POSITIONS[value.trim().toLowerCase()];
        if (typeof position === 'undefined') {
            await env.host.notify?.('error', undefined, 'Not a valid position');
            return '';
        }
        noteSet(env, NOTE_METADATA_KEYS.position, position);
        await env.host.notify?.('info', undefined, "Author's Note position updated");
    }
    const current = env.macro.chatMetadata[NOTE_METADATA_KEYS.position];
    return Object.keys(VALID_POSITIONS).find(key => VALID_POSITIONS[key] == current);
}

export async function setNoteRoleCommand(args: NamedArguments, text: UnnamedArguments): Promise<unknown> {
    const env = envOf(args);
    const value = unnamed(text);
    if (value) {
        const role = VALID_ROLES[value.trim().toLowerCase()];
        if (typeof role === 'undefined') {
            await env.host.notify?.('error', undefined, 'Not a valid role');
            return '';
        }
        noteSet(env, NOTE_METADATA_KEYS.role, role);
        await env.host.notify?.('info', undefined, "Author's Note role updated");
    }
    const current = env.macro.chatMetadata[NOTE_METADATA_KEYS.role];
    return Object.keys(VALID_ROLES).find(key => VALID_ROLES[key] == current);
}

export function registerNoteCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'note',
        callback: (args, value) => setNoteTextCommand(args, value),
        // TASK-064 工作令点名的 /note-set /note-get 即上游 /note 的 set/get 两态。
        aliases: ['note-set', 'note-get'],
        returns: "current author's note",
        unnamedArgumentList: [
            new SlashCommandArgument('text', [ARGUMENT_TYPE.STRING], false),
        ],
        helpString: "Sets an author's note for the currently selected chat if specified and returns the current note.",
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'note-depth',
        aliases: ['depth'],
        callback: (args, value) => setNoteDepthCommand(args, value),
        returns: "current author's note depth",
        unnamedArgumentList: [
            new SlashCommandArgument('number', [ARGUMENT_TYPE.NUMBER], false),
        ],
        helpString: "Sets an author's note depth for in-chat positioning if specified and returns the current depth.",
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'note-frequency',
        aliases: ['freq', 'note-freq'],
        callback: (args, value) => setNoteIntervalCommand(args, value),
        returns: "current author's note insertion frequency",
        unnamedArgumentList: [
            new SlashCommandArgument('number', [ARGUMENT_TYPE.NUMBER], false),
        ],
        helpString: "Sets an author's note insertion frequency if specified and returns the current frequency.",
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'note-position',
        aliases: ['pos', 'note-pos'],
        callback: (args, value) => setNotePositionCommand(args, value),
        returns: "current author's note insertion position",
        unnamedArgumentList: [
            new SlashCommandArgument('position', [ARGUMENT_TYPE.STRING], false, false, null,
                [
                    new SlashCommandEnumValue('after', null, enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('chat', null, enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('before', null, enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('scenario', null, enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('before_scenario', null, enumTypes.enum, enumIcons.default),
                ]),
        ],
        helpString: "Sets an author's note position if specified and returns the current position (after|scenario→0, chat→1, before_scenario|before→2).",
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'note-role',
        callback: (args, value) => setNoteRoleCommand(args, value),
        returns: "current author's note chat insertion role",
        unnamedArgumentList: [
            new SlashCommandArgument('role', [ARGUMENT_TYPE.STRING], false, false, null,
                [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('user', null, enumTypes.enum, enumIcons.user),
                    new SlashCommandEnumValue('assistant', null, enumTypes.enum, enumIcons.assistant),
                ]),
        ],
        helpString: "Sets an author's note chat insertion role if specified and returns the current role (system|user|assistant → 0|1|2).",
    }));
}
