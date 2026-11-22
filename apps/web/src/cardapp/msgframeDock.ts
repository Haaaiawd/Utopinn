// msgframeDock — TH「前端界面」楼层帧「收至右栏」的停靠注册表。
//
// 存档形态:每会话一份 localStorage 清单
//   utopinn.mf.docked.<charDir>/<chatName> → DockedFrame[]
//   [{messageId, blockIndex, ts}] —— 只存楼层坐标,不存 html:
//   重生/swipe 后块内容会变,坐标才是稳定身份;渲染侧由坐标反解
//   当刻块源(getChat + extractFrontendBlocks,与楼层侧同一提取函数)。
//
// 读侧:useDockedFrames(useSyncExternalStore)—— 楼层细条与右栏栈
// 共享同一份事实源;同 tab 写经 emit 广播,跨 tab 走 storage 事件。
// 旧 per-frame 布尔 key(utopinn.mf.dock.<scope>#<mid>:<bi>='1')
// 在模块加载时一次性并入注册表,mid='x' 等不可解析坐标弃掉。
import { useSyncExternalStore } from 'react';

export interface DockedFrame {
    messageId: number;
    blockIndex: number;
    /** 收进时间戳(排序/展示留位,当前按数组序即收取序)。 */
    ts: number;
}

const PREFIX = 'utopinn.mf.docked.';
const LEGACY_PREFIX = 'utopinn.mf.dock.';
const LEGACY_RE = /^utopinn\.mf\.dock\.(.+)#(\d+):(\d+)$/;
const EMPTY: DockedFrame[] = [];

/** 注册表作用域 —— charDir/chatName 原样拼接(与旧布尔 key 同段约定)。 */
export const dockScope = (charDir: string, chatName: string | undefined): string =>
    `${charDir}/${chatName ?? ''}`;

const listKey = (scope: string) => `${PREFIX}${scope}`;

/** key → 清单的规范引用(useSyncExternalStore 要求快照引用稳定)。 */
const cache = new Map<string, DockedFrame[]>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };

function isEntry(x: unknown): x is DockedFrame {
    return !!x && typeof x === 'object'
        && typeof (x as DockedFrame).messageId === 'number' && Number.isFinite((x as DockedFrame).messageId)
        && typeof (x as DockedFrame).blockIndex === 'number' && Number.isFinite((x as DockedFrame).blockIndex);
}

function readList(key: string): DockedFrame[] {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return EMPTY;
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr) ? arr.filter(isEntry) : EMPTY;
    } catch { return EMPTY; }
}

/** 同坐标集 → 沿用旧引用,快照不因重解析抖动(顺序也计)。 */
const sameCoords = (a: DockedFrame[], b: DockedFrame[]) =>
    a.length === b.length && a.every((x, i) => x.messageId === b[i]!.messageId && x.blockIndex === b[i]!.blockIndex && x.ts === b[i]!.ts);

/** 会话停靠清单(坐标序 = 收取序)。 */
export function listDocked(charDir: string, chatName?: string): DockedFrame[] {
    const key = listKey(dockScope(charDir, chatName));
    const cur = readList(key);
    const prev = cache.get(key);
    if (prev && sameCoords(prev, cur)) return prev;
    cache.set(key, cur);
    return cur;
}

export function isDocked(charDir: string, chatName: string | undefined, messageId: number | undefined, blockIndex: number): boolean {
    return listDocked(charDir, chatName).some((f) => f.messageId === messageId && f.blockIndex === blockIndex);
}

function writeList(key: string, frames: DockedFrame[]): void {
    cache.set(key, frames);
    try {
        if (frames.length) localStorage.setItem(key, JSON.stringify(frames));
        else localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
    emit();
}

/** 收一帧进右栏(幂等:同坐标已在 → 不动)。 */
export function dockFrame(charDir: string, chatName: string | undefined, messageId: number, blockIndex: number): void {
    const key = listKey(dockScope(charDir, chatName));
    const cur = listDocked(charDir, chatName);
    if (cur.some((f) => f.messageId === messageId && f.blockIndex === blockIndex)) return;
    writeList(key, [...cur, { messageId, blockIndex, ts: Date.now() }]);
}

/** 放回楼层 / 移除死坐标(幂等)。 */
export function undockFrame(charDir: string, chatName: string | undefined, messageId: number, blockIndex: number): void {
    const key = listKey(dockScope(charDir, chatName));
    const cur = listDocked(charDir, chatName);
    const next = cur.filter((f) => !(f.messageId === messageId && f.blockIndex === blockIndex));
    if (next.length !== cur.length) writeList(key, next);
}

/* 跨 tab 同步:storage 事件只在别的 tab 触发,作废缓存 → 下一快照重读。 */
const onStorage = (e: StorageEvent) => {
    if (!e.key || !e.key.startsWith(PREFIX)) return;
    cache.delete(e.key);
    emit();
};

function subscribeDock(fn: () => void): () => void {
    if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
}

/** 会话停靠清单的响应式读 —— 增删即时反映到楼层细条与右栏栈。 */
export function useDockedFrames(charDir: string | undefined, chatName: string | undefined): DockedFrame[] {
    return useSyncExternalStore(
        subscribeDock,
        () => (charDir ? listDocked(charDir, chatName) : EMPTY),
        () => EMPTY,
    );
}

/* 旧布尔 key 一次性迁移:扫描 → 收集 → 写注册表 → 删旧 key。
   (分趟是刻意的 —— 写新 key 会位移 localStorage.key(i) 枚举序。) */
try {
    const found: { scope: string; mid: number; bi: number }[] = [];
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LEGACY_PREFIX)) continue;
        doomed.push(k);
        if (localStorage.getItem(k) !== '1') continue;
        const m = LEGACY_RE.exec(k); // 贪婪 .+ 锚定最后一个 '#',scope 含 '#' 也安全
        if (m) found.push({ scope: m[1]!, mid: +m[2]!, bi: +m[3]! });
    }
    for (const f of found) {
        const key = listKey(f.scope);
        const cur = cache.get(key) ?? readList(key);
        if (!cur.some((x) => x.messageId === f.mid && x.blockIndex === f.bi)) {
            writeList(key, [...cur, { messageId: f.mid, blockIndex: f.bi, ts: Date.now() }]);
        }
    }
    for (const k of doomed) { try { localStorage.removeItem(k); } catch { /* noop */ } }
} catch { /* storage unavailable */ }
