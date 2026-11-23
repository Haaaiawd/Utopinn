// slash.ts —— 斜杠菜单的本地偏好槽(utopinn.slash.*)+ 注册表分组模型。
//   enabled = 环境斜杠体验总闸:关 → 打 `/` 不弹菜单、`/text` 按普通文本发送
//             (「不使用」语义,不是拦截;菜单经 `/` 钮显式打开仍可用)。
//   open    = 组头展开态(默认全折叠,持久化 —— 常用组记住展开)。
//   hidden  = 整组隐藏(不玩某族命令就关掉;菜单底部行一键恢复)。
import type { ScriptCommandInfo } from '../../api/th';

export interface SlashPrefs {
    enabled: boolean;
    hidden: SlashGroupKey[];
    open: SlashGroupKey[];
}

const K_ENABLED = 'utopinn.slash.enabled';
const K_HIDDEN = 'utopinn.slash.hidden';
const K_OPEN = 'utopinn.slash.open';

export const SLASH_GROUP_ORDER = ['tavern', 'flow', 'world', 'dialog', 'script', 'misc'] as const;
export type SlashGroupKey = (typeof SLASH_GROUP_ORDER)[number];

/** 组归属:注册名白名单。服务端快照无 source/category 字段,按
 *  core builtins 文件边界(packages/core/src/stscript/builtins/*.ts)归桶;
 *  未识别名落 misc —— 服务端日后加命令不漏出菜单。 */
const GROUP_MEMBERS: Record<Exclude<SlashGroupKey, 'misc'>, ReadonlySet<string>> = {
    /* 酒馆命令集:楼层操作(chat-ops)+ 作者注(notes)+ 会话身份(session)+ sys 家族 */
    tavern: new Set([
        'addswipe', 'cut', 'del', 'delname', 'delswipe', 'go', 'hide', 'unhide',
        'message-name', 'message-role', 'messages', 'reroll-pick', 'swap', 'swipe',
        'note', 'note-depth', 'note-frequency', 'note-position', 'note-role',
        'forcesave', 'getchatname', 'impersonate', 'persona-set', 'rename-char', 'renamechat',
        'sys', 'sysname',
    ]),
    /* 变量 / 运算 / 控制流(variables.ts 全域) */
    flow: new Set([
        'abs', 'add', 'addvar', 'addglobalvar', 'cos', 'decvar', 'decglobalvar', 'div',
        'flushvar', 'flushglobalvar', 'getvar', 'getglobalvar', 'incvar', 'incglobalvar',
        'len', 'listvar', 'log', 'max', 'min', 'mod', 'mul', 'popvar', 'pow', 'pushvar',
        'rand', 'round', 'setvar', 'setglobalvar', 'sin', 'sort', 'sqrt', 'sub', 'times', 'var',
        'if', 'while', 'let', 'break', 'closure-deserialize', 'closure-serialize',
    ]),
    /* 世界书族(world-commands.ts) */
    world: new Set([
        'world', 'createentry', 'findentry', 'getentryfield', 'setentryfield',
        'getcharbook', 'getchatbook', 'getglobalbooks', 'getpersonabook',
        'wi-get-timed-effect', 'wi-set-timed-effect',
    ]),
    /* 交互弹层(dialogs.ts + messages.ts 的 /input) */
    dialog: new Set(['buttons', 'popup', 'input']),
    /* 脚本引擎与消息管线(messages.ts + parser 伪命令) */
    script: new Set([
        'abort', 'comment', 'delay', 'echo', 'gen', 'pass', 'run',
        'send', 'sendas', 'setinput', 'trigger',
        '/', '?', 'breakpoint', 'parser-flag',
    ]),
};

export function slashGroupOf(name: string): SlashGroupKey {
    const n = name.toLowerCase();
    for (const g of SLASH_GROUP_ORDER) {
        if (g !== 'misc' && GROUP_MEMBERS[g].has(n)) return g;
    }
    return 'misc';
}

/* ——— localStorage 槽 ——— */

const isGroupKey = (g: unknown): g is SlashGroupKey =>
    typeof g === 'string' && (SLASH_GROUP_ORDER as readonly string[]).includes(g);

function readList(key: string): SlashGroupKey[] {
    try {
        const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
        return Array.isArray(v) ? v.filter(isGroupKey) : [];
    } catch {
        return [];
    }
}

export function loadSlashPrefs(): SlashPrefs {
    let enabled = true;
    try {
        enabled = localStorage.getItem(K_ENABLED) !== '0';
    } catch { /* storage unavailable → 默认开 */ }
    return { enabled, hidden: readList(K_HIDDEN), open: readList(K_OPEN) };
}

export function saveSlashPrefs(p: SlashPrefs): void {
    try {
        localStorage.setItem(K_ENABLED, p.enabled ? '1' : '0');
        localStorage.setItem(K_HIDDEN, JSON.stringify(p.hidden));
        localStorage.setItem(K_OPEN, JSON.stringify(p.open));
    } catch { /* storage unavailable */ }
}

/* ——— 菜单行模型:组头与命令行拍平成同一导航序,键盘 ↑↓ 统一走它 ——— */

export type SlashNavRow =
    | { kind: 'head'; group: SlashGroupKey; count: number; open: boolean }
    | { kind: 'cmd'; cmd: ScriptCommandInfo; group: SlashGroupKey };

export interface SlashNav {
    rows: SlashNavRow[];
    /** 整组隐藏的组 + 组内命令数(菜单底列恢复行用);flat 模式不列。 */
    hiddenGroups: { group: SlashGroupKey; count: number }[];
}

/**
 * cmds → 导航行。flat = 补全语境(正在打 token/已到参数区)或搜索态:
 * 无组头、组顺序平铺 —— Discord 式过滤结果;组视图(flat=false)
 * 全部折成组头,open 组展开条目。hidden 组两种模式都不出命令。
 */
export function buildSlashNav(cmds: ScriptCommandInfo[], opts: { flat: boolean; prefs: SlashPrefs }): SlashNav {
    const buckets = new Map<SlashGroupKey, ScriptCommandInfo[]>();
    for (const c of cmds) {
        const g = slashGroupOf(c.name);
        const arr = buckets.get(g);
        if (arr) arr.push(c);
        else buckets.set(g, [c]);
    }
    const hidden = new Set(opts.prefs.hidden);
    const open = new Set(opts.prefs.open);
    const rows: SlashNavRow[] = [];
    const hiddenGroups: SlashNav['hiddenGroups'] = [];
    for (const g of SLASH_GROUP_ORDER) {
        const items = buckets.get(g);
        if (!items?.length) continue;
        if (hidden.has(g)) {
            if (!opts.flat) hiddenGroups.push({ group: g, count: items.length });
            continue;
        }
        if (opts.flat) {
            for (const c of items) rows.push({ kind: 'cmd', cmd: c, group: g });
            continue;
        }
        const isOpen = open.has(g);
        rows.push({ kind: 'head', group: g, count: items.length, open: isOpen });
        if (isOpen) for (const c of items) rows.push({ kind: 'cmd', cmd: c, group: g });
    }
    return { rows, hiddenGroups };
}
