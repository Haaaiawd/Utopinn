// chatSync — 会话文档变更广播(P0-4 返修:帧写面 → 读者坐标同步)。
//
// 一条链:面板帧/CardApp 的 TH 写面(setChatMessages/deleteChatMessages/…)
// 改的是服务端 chat doc;reader 的 useChatSession 持有内存快照 + wire 缓存,
// 不重拉就拿旧下标编辑 → 写错楼层。事件泵(usePanelHost → CardAppHost)
// 在两条路上感知变更(chat doc diff dirty / 信箱 mutation 事件),经此模块
// 广播给当前会话的订阅者;useChatSession 收到后重拉权威快照。
//
// 纯扇出、无业务语义:订阅方自行决定怎么重对(重拉、防抖、跳过流式)。
type ChatKey = string;

const subs = new Map<ChatKey, Set<() => void>>();

const keyOf = (charDir: string, chatName?: string): ChatKey => `${charDir}>${chatName ?? ''}`;

/** 泵/宿主侧:该会话的服务端 doc 已变(或疑似已变)。 */
export function notifyChatChanged(charDir: string, chatName?: string): void {
    for (const fn of subs.get(keyOf(charDir, chatName)) ?? []) {
        try {
            fn();
        } catch {
            /* 订阅者自治 —— 通知方不替它兜底 */
        }
    }
}

/** 会话侧订阅;返回退订。chatName 缺席 = 全局域(与 pump 同语义)。 */
export function subscribeChatChanged(charDir: string, chatName: string | undefined, fn: () => void): () => void {
    const key = keyOf(charDir, chatName);
    let set = subs.get(key);
    if (!set) {
        set = new Set();
        subs.set(key, set);
    }
    set.add(fn);
    return () => {
        set.delete(fn);
        if (!set.size) subs.delete(key);
    };
}
