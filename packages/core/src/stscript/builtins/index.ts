/**
 * 首批 builtin 命令注册入口 — 对应 Luker 的 initDefaultSlashCommands +
 * registerVariableCommands 中本切片覆盖的命令(消息/变量/控制流)。
 * 幂等:重复调用只在缺命令时补注册(addCommandObjectUnsafe 仍会去重警告)。
 */
import { SlashCommandParser } from '../parser.js';
import { registerMessageCommands } from './messages.js';
import { registerVariableCommands } from './variables.js';
import { registerChatOpsCommands } from './chat-ops.js';
import { registerNoteCommands } from './notes.js';

let registered = false;

export function registerBuiltinCommands(): void {
    if (registered) return;
    registered = true;
    registerMessageCommands();
    registerVariableCommands();
    registerChatOpsCommands();
    registerNoteCommands();
}

/** 已注册的 builtin 名清单(测试/白名单审计用)。 */
export function builtinCommandNames(): string[] {
    return Object.keys(SlashCommandParser.commands);
}

export { registerMessageCommands } from './messages.js';
export { registerVariableCommands } from './variables.js';
export { doReturn, returnEnumList } from './common.js';
