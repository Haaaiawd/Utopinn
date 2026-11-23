// 立绘/表情绑定(TASK-067)—— per-chat 选择态,localStorage 槽
// `utopinn.emote.<chatId>`,与 persona 的 per-chat 选择同一惯例:
// 服务端无 per-chat 表情端点,ST 的当前表情本就是易失 UI 态
// (lastExpression 模块级、CHAT_CHANGED 即清),这里不伪造写回面。
// 绑定语义:本会话角色立绘 = 选定 sprite,渲染面 = 楼层 assistant 头像
// + 舞台头 chip。自动表情分类器不在本刀(任务边界)。
import { useCallback, useSyncExternalStore } from 'react';

export interface BoundEmote {
    /** sprite 文件名(资产清单 name)。 */
    file: string;
    /** 表情标签(文件名干名,joy-1.png → joy)。 */
    label: string;
    /** 静态面直取 URL(/characters/<folder>/<file>)。 */
    url: string;
}

const keyOf = (chatId: string | null | undefined) => `utopinn.emote.${chatId ?? 'default'}`;

const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };

export function getBoundEmote(chatId: string | null | undefined): BoundEmote | null {
    try {
        const raw = localStorage.getItem(keyOf(chatId));
        if (!raw) return null;
        const o = JSON.parse(raw) as Partial<BoundEmote> | null;
        if (o && typeof o === 'object' && typeof o.file === 'string' && typeof o.url === 'string') {
            return { file: o.file, label: typeof o.label === 'string' && o.label ? o.label : o.file, url: o.url };
        }
    } catch { /* storage 不可用或坏档 → 未绑定 */ }
    return null;
}

export function setBoundEmote(chatId: string | null | undefined, emote: BoundEmote | null): void {
    try {
        if (emote) localStorage.setItem(keyOf(chatId), JSON.stringify(emote));
        else localStorage.removeItem(keyOf(chatId));
    } catch { /* storage 不可用 */ }
    emit();
}

/* useSyncExternalStore 的快照必须引用稳定 —— 同值返回同对象,
   否则每次 getSnapshot 都新对象触发无限重渲。 */
const snapshotCache = new Map<string, BoundEmote | null>();
function snapshot(chatId: string | null | undefined): BoundEmote | null {
    const next = getBoundEmote(chatId);
    const key = keyOf(chatId);
    const prev = snapshotCache.get(key) ?? null;
    if (prev === next) return prev;
    if (prev && next && prev.file === next.file && prev.url === next.url && prev.label === next.label) return prev;
    snapshotCache.set(key, next);
    return next;
}

/** 当前会话绑定的立绘;null = 未绑定(渲染面回落卡头像)。 */
export function useBoundEmote(chatId: string | null | undefined): BoundEmote | null {
    const subscribe = useCallback((cb: () => void) => {
        const onStorage = (e: StorageEvent) => { if (e.key === keyOf(chatId)) cb(); };
        listeners.add(cb);
        window.addEventListener('storage', onStorage);
        return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
    }, [chatId]);
    return useSyncExternalStore(subscribe, () => snapshot(chatId), () => null);
}
