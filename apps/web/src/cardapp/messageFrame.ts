/**
 * messageFrame — TH「前端界面」楼层检测(web 渲染侧)。
 *
 * 权威实现:packages/core/src/message-frame.ts(TH isFrontend 语义)。
 * 本文件是同规格移植 —— web 不依赖 @utopinn/core,规格注释与实现
 * 必须逐行对齐;改动先改 core 再同步本文件。
 */

const FRONTEND_MARKERS = ['html>', '<head>', '<body'] as const;

export function isFrontendContent(content: string): boolean {
    return FRONTEND_MARKERS.some((tag) => content.includes(tag));
}

export interface FrontendBlock {
    html: string;
    start: number;
    end: number;
}

export interface FrontendSplit {
    text: string;
    blocks: FrontendBlock[];
}

const FENCE_RE = /```[^\n`]*\n([\s\S]*?)```/g;
const WHOLE_DOC_RE = /^\s*(?:<!doctype\s+html|<html[\s>]|html>|<head[\s>]|<body[\s>])/i;

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
