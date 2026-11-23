// chatView — ST wire 楼层 → MessageViewModel 的纯映射(GH#3 展示投影道)。
// 从 client.ts 拆出:无网络/会话依赖,node --test 可直测(只引 protocol)。
// 展示优先级与 apps/web stToView 同口径:
//   mes_display / swipes_display[i] / reasoning_display / swipe_info[i].extra.*
//   优先、原文字段回落 —— content/swipes[i].content/reasoning 槽放展示文本;
//   写回路径(rawFloorText)必须走 wire 原文,见 conversation.ts。
import { MVU_STATUS_PLACEHOLDER } from '@utopinn/protocol';
import type { MessageViewModel, SwipeView } from '@utopinn/protocol';

/** ST wire floor (JSONL row) — 展示投影字段与 apps/web stToView 同口径。 */
export interface StChatMessage {
    name?: string;
    is_user?: boolean;
    is_system?: boolean;
    mes?: string;
    /** 展示投影(GH#3):regex AI_OUTPUT 后的楼层展示文本(存储字段不动)。 */
    mes_display?: string;
    /** 展示投影:与 swipes 平行同序(元素恒为投影后文本)。 */
    swipes_display?: string[];
    /** 展示投影:extra.reasoning 的展示文本(REASONING placement)。 */
    reasoning_display?: string;
    send_date?: number | string;
    swipe_id?: number;
    swipes?: (string | { mes?: string; send_date?: number | string })[];
    /** 与 swipes 平行的生成簿记;[i].extra.reasoning_display = 各版推理投影。 */
    swipe_info?: Record<string, unknown>[];
    extra?: Record<string, unknown>;
}

/** 剥离 MVU 状态占位符 —— 存储层保留(卡 shim 定位用),视图层不渲染。 */
const stripStatusPlaceholder = (s: string): string =>
    s.includes(MVU_STATUS_PLACEHOLDER) ? s.replaceAll(MVU_STATUS_PLACEHOLDER, '').trimEnd() : s;

/** send_date can be epoch ms OR an ISO string (server persist writes ISO). */
function toMs(v: number | string | undefined): number | undefined {
    if (v == null) return undefined;
    const n = typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isNaN(n) ? undefined : n;
}

/**
 * ST wire → 楼层视图模型(与 apps/web stToView 同口径,GH#3):
 *   mes_display / swipes_display / reasoning_display / swipe_info[i].extra.
 *   reasoning_display 优先、原文字段回落 —— content/swipes[i].content/
 *   reasoning 槽直接放展示文本(展示车道);编辑种子从 wire 取,见
 *   useConversation.rawFloorText —— 别拿 content 写回 mes/swipes。
 *
 * 选稿语义(reviewer 返修):有 swipes 链时 content 取**当前 swipe 车道**
 *   (swipes_display[active] ?? 原文)—— mes/mes_display 是「当前稿」的
 *   服务端镜像,PATCH 只改 swipe_id 时它滞后,优先吃它会显示上一稿;
 *   无 swipes 链才回落 mes_display ?? mes。
 */
export function stToView(m: StChatMessage, id: number): MessageViewModel {
    const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const siExtra = (i: number): Record<string, unknown> | undefined => {
        const si = Array.isArray(m.swipe_info) ? m.swipe_info[i] : undefined;
        const ex = si && typeof si === 'object' ? (si as { extra?: unknown }).extra : undefined;
        return ex && typeof ex === 'object' ? (ex as Record<string, unknown>) : undefined;
    };
    const active = Number(m.swipe_id ?? 0);
    /* swipes_display 与 swipes 同序对齐;extra.display_text 已折进服务端
       投影,客户端只挑「投影 ?? 原文」。 */
    const swipes: SwipeView[] | undefined = Array.isArray(m.swipes) && m.swipes.length > 1
        ? m.swipes.map((s, i) => {
            const si = siExtra(i);
            return {
                index: i,
                content: stripStatusPlaceholder(asStr(m.swipes_display?.[i]) ?? (typeof s === 'string' ? s : (s.mes ?? ''))),
                reasoning: asStr(si?.reasoning_display) ?? asStr(si?.reasoning),
                timestamp: typeof s === 'object' ? toMs(s.send_date) : undefined,
            };
        })
        : undefined;
    const base = swipes?.[Math.min(Math.max(active, 0), swipes.length - 1)];
    const si = siExtra(Math.min(Math.max(active, 0), Math.max(0, (m.swipe_info?.length ?? 1) - 1)));
    return {
        id,
        role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
        name: m.name ?? '',
        content: swipes && base
            ? base.content
            : stripStatusPlaceholder(asStr(m.mes_display) ?? m.mes ?? ''),
        reasoning: asStr(m.reasoning_display) ?? asStr(m.extra?.reasoning) ?? asStr(si?.reasoning_display) ?? asStr(si?.reasoning),
        timestamp: toMs(m.send_date),
        swipes,
        activeSwipe: swipes ? Math.min(active, swipes.length - 1) : undefined,
    };
}
