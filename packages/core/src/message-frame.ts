/**
 * message-frame — TH displayed_message「前端界面」楼层检测(TASK-049)。
 *
 * TH/JSR 语义(ref/extensions/JS-Slash-Runner):
 *   - 楼层渲染出的文本里 `<pre><code>` 内容含 'html>' | '<head>' | '<body'
 *     即「前端界面」块 → 宿主把它换成 iframe 渲染(srcdoc = 块内容 +
 *     TH boilerplate),见 panel/render/iframe.ts createSrcContent。
 *   - 卡写面的惯用载体:楼层正文里的 markdown 代码块 ```html … ```,
 *     messageFormatting 渲成 pre>code 后被检中。整楼是完整 HTML 文档
 *     (<!doctype/<html 开头)的卡也走同面。
 *
 * 我们的渲染面是文本投影(mes_display,服务端 regex 展示车道)——检测在
 * 文本层做等价物:代码栅栏块 + 整楼文档起始标记。
 *
 * 本文件是 server(utopinn-th retrieveDisplayedMessage)与 web 楼层渲染
 * (cardapp/messageFrame.ts)共享的权威规格 —— 改则两侧同步。
 */

/** TH isFrontend 同套标记(见 util/is_frontend.ts)。 */
const FRONTEND_MARKERS = ['html>', '<head>', '<body'] as const;

/** TH isFrontend:块内容是否「前端界面」。 */
export function isFrontendContent(content: string): boolean {
    return FRONTEND_MARKERS.some((tag) => content.includes(tag));
}

export interface FrontendBlock {
    /** 抽出的块内 HTML(去首尾空白;iframe srcdoc 载荷)。 */
    html: string;
    /** 块在展示文本里的字节区间([start,end),诊断/调试位)。 */
    start: number;
    end: number;
}

export interface FrontendSplit {
    /** 摘掉前端块后剩余的正文(楼层正常文本位)。 */
    text: string;
    /** 检出的前端块(渲染位 → 每块一个 iframe)。 */
    blocks: FrontendBlock[];
}

// ```lang\n … ``` 代码栅栏(lang 任意非换行非反引号字符;TH 卡写 html 最常用)
const FENCE_RE = /```[^\n`]*\n([\s\S]*?)```/g;

// 整楼文档起始(TH 卡常把完整 HTML 文档直接写进楼层,不带栅栏)
const WHOLE_DOC_RE = /^\s*(?:<!doctype\s+html|<html[\s>]|html>|<head[\s>]|<body[\s>])/i;

/**
 * 展示文本 → {text, blocks}。规则(TH 对齐):
 *   1) 每个代码栅栏块内容含前端标记 → 摘出为 iframe 块;
 *   2) 无栅栏块时,若整文本以文档标记开头 → 整楼一个块;
 *   3) 栅栏块与整楼文档不叠加(整楼层 = 文档时里面不会再有"剩余文本")。
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
