// prose 楼层渲染器 —— TASK-026 消息四惯例的默认实现,经 'renderer' 贡献点
// 注册(chatFeature)。贡献点契约:组件无 props,楼层经 FloorRenderCtx
// 下发;宿主(CenterStage)保有 ops 条/swipe/TH iframe 挂载等 chrome,
// 渲染器只画正文面 —— 换一个渲染器 = 同一 ctx 换一张脸。
//
// 惯例(RP 文本事实,对齐 ST 消息样式语义):
//   *动作*              → em.prose-act 斜体弱墨(asterisk 惯例)
//   「…」『…』“…”"…"    → span.prose-say 引号对话色(--quote token,中英文都收)
//   greeting(首条 assistant)→ 版式待遇:宿主 article 加 .prose-greeting,
//                         正文按 chatSettings.fontSize ×1.06 抬一档
//   streaming 空文       → .tdots 三点脉冲(打字机感);有文 → cursor-bar 照旧
import { createContext, useContext, Fragment, type ReactNode } from 'react';
import type { FloorMsg } from '../../api/chats';

/** 宿主 → 渲染器的楼层现场(ctx 即协议,渲染器不碰 chat 文件/写回)。 */
export interface FloorRenderState {
    m: FloorMsg;
    /** TH 前端块摘出后的展示文本(mes_display 投影优先,同 FloorBody 取法)。 */
    text: string;
    streaming?: boolean;
    /** 首楼 greeting 旗标 —— 宿主按「首条可见 assistant 楼」判定,渲染器不发明。 */
    greeting?: boolean;
    /** chatSettings.fontSize —— 渲染器在宿主字号档上做版式微调。 */
    fontSize: number;
}

const FloorRenderCtx = createContext<FloorRenderState | null>(null);
export const FloorRenderProvider = FloorRenderCtx.Provider;

export function useFloorRender(): FloorRenderState {
    const f = useContext(FloorRenderCtx);
    if (!f) throw new Error('floor renderer mounted without FloorRenderCtx');
    return f;
}

/**
 * 行内切分:动作段与四族引号互斥匹配,一次 split 出全部锚点。
 * *…* 不吃换行/嵌套星号;直角引号/弯引/直引各自成对,未闭合段
 * 天然落回普通文本(流式半符到达时诚实显示原文,不闪烁假格式)。
 */
const INLINE_RE = /(\*[^*\n]+\*|「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|"[^"\n]*")/g;

export function renderInline(text: string): ReactNode {
    const parts = text.split(INLINE_RE);
    if (parts.length === 1) return text;
    return parts.map((seg, i) => {
        if (!seg) return null;
        const head = seg[0]!;
        const tail = seg[seg.length - 1]!;
        if (seg.length > 1 && head === '*' && tail === '*') {
            return <em key={i} className="prose-act">{seg.slice(1, -1)}</em>;
        }
        if (seg.length > 1 && (
            (head === '「' && tail === '」')
            || (head === '『' && tail === '』')
            || (head === '“' && tail === '”')
            || (head === '"' && tail === '"')
        )) {
            return <span key={i} className="prose-say">{seg}</span>;
        }
        return <Fragment key={i}>{seg}</Fragment>;
    });
}

/** typing 三点脉冲 —— 流式空文楼层(生成已起、首个 delta 未到)的占位。 */
export function TypingDots() {
    return <span className="tdots" aria-hidden="true"><i /><i /><i /></span>;
}

/** prose 楼层体:四惯例的默认实现(renderer 贡献点 order 0)。 */
export function ProseFloor() {
    const f = useFloorRender();
    return (
        <div
            className="chat-body-text whitespace-pre-line"
            style={{ fontSize: f.greeting ? Math.round(f.fontSize * 1.06) : f.fontSize }}
        >
            {renderInline(f.text)}
            {f.streaming && (f.text ? <span className="cursor-bar" /> : <TypingDots />)}
        </div>
    );
}
