// frontendBlocks — TH「前端界面」楼层块检测(P1;第三份权威拷贝:
// packages/core/src/message-frame.ts 与 apps/web/src/cardapp/messageFrame.ts
// 是同规格 —— 改则三侧同步)。
//
// TH/JSR 语义:楼层展示文本里的 ```html 栅栏块内容含 'html>'|'<head>'|
// '<body' → 「前端界面」块 → 宿主换成 doc-mount 帧渲染(MessageFrame);
// 整楼以文档标记开头 → 整楼一个块。检测在展示文本层做(mes_display 投影)。
import type { MessageViewModel } from '@utopinn/protocol';

/** TH isFrontend 同套标记。 */
const FRONTEND_MARKERS = ['html>', '<head>', '<body'] as const;

/** TH isFrontend:块内容是否「前端界面」。 */
export function isFrontendContent(content: string): boolean {
    return FRONTEND_MARKERS.some((tag) => content.includes(tag));
}

export interface FrontendBlock {
    /** 抽出的块内 HTML(去首尾空白;doc-mount 载荷)。 */
    html: string;
    /** 块在展示文本里的字节区间([start,end),诊断位)。 */
    start: number;
    end: number;
}

export interface FrontendSplit {
    /** 摘掉前端块后剩余的正文(楼层正常文本位)。 */
    text: string;
    /** 检出的前端块(渲染位 → 每块一个 MessageFrame)。 */
    blocks: FrontendBlock[];
}

// ```lang\n … ``` 代码栅栏(TH 卡写 html 最常用)
const FENCE_RE = /```[^\n`]*\n([\s\S]*?)```/g;

// 整楼文档起始(卡把完整 HTML 文档直接写进楼层,不带栅栏)
const WHOLE_DOC_RE = /^\s*(?:<!doctype\s+html|<html[\s>]|html>|<head[\s>]|<body[\s>])/i;

/**
 * 展示文本 → {text, blocks}。规则(TH 对齐):
 *   1) 每个代码栅栏块内容含前端标记 → 摘出为 iframe 块;
 *   2) 无栅栏块时,若整文本以文档标记开头 → 整楼一个块;
 *   3) 栅栏块与整楼文档不叠加。
 */
export function extractFrontendBlocks(displayText: string): FrontendSplit {
    const text = String(displayText ?? '');
    const blocks: FrontendBlock[] = [];
    let kept = '';
    let last = 0;
    FENCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FENCE_RE.exec(text)) !== null) {
        const content = m[1] ?? '';
        if (!isFrontendContent(content)) continue;
        kept += text.slice(last, m.index);
        blocks.push({ html: content.trim(), start: m.index, end: m.index + m[0].length });
        last = m.index + m[0].length;
    }
    kept += text.slice(last);
    if (blocks.length === 0 && WHOLE_DOC_RE.test(kept)) {
        return { text: '', blocks: [{ html: kept.trim(), start: 0, end: text.length }] };
    }
    return { text: kept, blocks };
}

/** 楼层展示文本(displayContent ?? content)→ 前端块检测,一次算完两端用。 */
export function floorFrontendSplit(m: MessageViewModel): FrontendSplit {
    return extractFrontendBlocks((m.displayContent ?? m.content).replace(/\r\n?/g, '\n'));
}
