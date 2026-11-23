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
import { registerDialogCommands } from './dialogs.js';
import { registerWorldCommands } from './world-commands.js';
import { registerSessionCommands } from './session.js';
import { registerSystemCommands } from './system.js';
import { registerInjectCommands } from './injects.js';
import { registerTextOpsCommands } from './text-ops.js';
import { registerPowerUserCommands } from './power-user.js';

let registered = false;

export function registerBuiltinCommands(): void {
    if (registered) return;
    registered = true;
    registerMessageCommands();
    registerVariableCommands();
    registerChatOpsCommands();
    registerNoteCommands();
    registerDialogCommands();
    // TASK-064 批二:WI/会话/帮助
    registerWorldCommands();
    registerSessionCommands();
    registerSystemCommands();
    // TASK-064 批三:inject×3(CardApp 耦合读侧的写侧)、文本/匹配工具、
    // power_user 写面(/newchat /delchat /closechat 挂在 session.ts)
    registerInjectCommands();
    registerTextOpsCommands();
    registerPowerUserCommands();
}

/** 已注册的 builtin 名清单(测试/白名单审计用)。 */
export function builtinCommandNames(): string[] {
    return Object.keys(SlashCommandParser.commands);
}

export { registerMessageCommands } from './messages.js';
export { registerVariableCommands } from './variables.js';
export { registerInjectCommands, consumeEphemeralScriptInjects } from './injects.js';
export { trimToStartSentence, trimToEndSentence } from './text-ops.js';
export { doReturn, returnEnumList } from './common.js';
