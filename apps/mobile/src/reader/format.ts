// prose 形态的正文映射(design §2「正文映射 方案A」):
//   楼层正文 → 连续散文段落(段首缩进 2 字,markdown 直接排版)
//   *动作* → 斜体弱墨;[*内心*] 更弱;"对话"/「对话」→ 引号高亮单色
//   user 段 → 左缘发丝线楼层块;system/hidden → 幕间灰字小注
//   章节 = 语义切片(>4h 时间间隔 / ~5k 字节点,章名=首段首句截12字)
// 全部是显示计算 —— 不碰消息语义,不持久化。
import type { MessageViewModel, RendererMessageRole } from '@utopinn/protocol';
import { floorFrontendSplit } from '../panels/frontendBlocks';

// ---------- inline marks ----------

export type InlineType = 'text' | 'bold' | 'action' | 'thought' | 'quote';
export interface InlineSeg {
    type: InlineType;
    text: string;
}

// 引号高亮:直角/弯引号/英文双引号包裹的一截台词(限长,防跨段误吞)
const QUOTE_RE = /"([^"\n]{1,80})"|“([^”\n]{1,120})”|「([^」\n]{1,120})」/g;

function splitMarks(text: string, out: InlineSeg[]): void {
    // 先 [*内心*] 后 **粗** 后 *动作*(长壳先匹配;** 不进 *动作* 分支)
    let i = 0;
    const re = /(\[\*[^\]\n]+\*\])|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m.index > i) splitQuotes(text.slice(i, m.index), out);
        const token = m[0];
        if (token.startsWith('[*')) {
            out.push({ type: 'thought', text: token.slice(2, -2) });
        } else if (token.startsWith('**')) {
            out.push({ type: 'bold', text: token.slice(2, -2) });
        } else {
            out.push({ type: 'action', text: token.slice(1, -1) });
        }
        i = m.index + token.length;
    }
    if (i < text.length) splitQuotes(text.slice(i), out);
}

function splitQuotes(text: string, out: InlineSeg[]): void {
    let i = 0;
    QUOTE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QUOTE_RE.exec(text))) {
        if (m.index > i) out.push({ type: 'text', text: text.slice(i, m.index) });
        out.push({ type: 'quote', text: m[0] });
        i = m.index + m[0].length;
    }
    if (i < text.length) out.push({ type: 'text', text: text.slice(i) });
}

/** 段内分片:text/action/thought/quote。空段返回 []。 */
export function inlineSegs(text: string): InlineSeg[] {
    const out: InlineSeg[] = [];
    splitMarks(text, out);
    return out;
}

// ---------- paragraphs ----------

export interface Para {
    key: string;
    /** 扁平段落流下标。 */
    index: number;
    floorId: number;
    role: RendererMessageRole;
    /** user/system/hidden 楼层压成单段;assistant 按换行拆段。 */
    text: string;
    floor: MessageViewModel;
    isFloorFirst: boolean;
    isFloorLast: boolean;
    /** 楼层末段携带的 TH 前端块 HTML(渲染位 → MessageFrame 栈;P1)。 */
    frontendBlocks?: string[];
}

/**
 * 楼层 → {展示段落, 前端块}:前端块(html 栅栏/整楼文档)从展示文本摘出,
 * 不参与正文排版 —— 渲染器把它们画成 MessageFrame。
 */
export function floorSplit(m: MessageViewModel): { paras: string[]; blocks: string[] } {
    const split = floorFrontendSplit(m);
    let paras: string[];
    if (m.role !== 'assistant') {
        paras = [split.text];
    } else {
        const parts = split.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        paras = parts.length ? parts : [''];
    }
    return { paras, blocks: split.blocks.map((b) => b.html) };
}

/** 楼层 → 展示段落(旧签名,前端块位丢弃 —— 需要块请用 floorSplit)。 */
export function floorParas(m: MessageViewModel): string[] {
    return floorSplit(m).paras;
}

/** 消息流 → 扁平段落流(渲染器不重排楼层 —— 只展开)。 */
export function buildParas(messages: MessageViewModel[]): Para[] {
    const out: Para[] = [];
    for (const m of messages) {
        const { paras: parts, blocks } = floorSplit(m);
        parts.forEach((text, i) => {
            out.push({
                key: `${m.id}:${i}`,
                index: out.length,
                floorId: m.id,
                role: m.role,
                text,
                floor: m,
                isFloorFirst: i === 0,
                isFloorLast: i === parts.length - 1,
                frontendBlocks: i === parts.length - 1 && blocks.length ? blocks : undefined,
            });
        });
    }
    return out;
}

// ---------- chapters(语义切片 —— 不按楼层分章) ----------

export interface Chapter {
    index: number;
    /** 首段首句截 12 字。 */
    title: string;
    paraStart: number;
    /** exclusive */
    paraEnd: number;
    floorStart: number;
    chars: number;
}

const CHAPTER_GAP_MS = 4 * 60 * 60 * 1000;
const CHAPTER_CHARS = 5000;

/** 截首句:标点收尾的头一句;没有标点就头 12 字。剥掉 * 号与引号壳。 */
export function firstSentence(text: string, max = 12): string {
    const clean = text.replace(/[*「」"“”\[\]]/g, '').trim();
    if (!clean) return '';
    const m = clean.match(/^[^。！？!?…\n]{1,30}?[。！？!?…]/);
    const s = (m ? m[0] : clean).trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 分章启发式:楼层边界处,(a) 与上一楼层时间间隔 >4h,或
 * (b) 本章累计字数已达 ~5k → 在此层前起新章。
 * 楼层内部不拆(楼层=天然缝,字数允许 4-6k 弹性)。
 */
export function buildChapters(paras: Para[]): Chapter[] {
    const chapters: Chapter[] = [];
    let cur: Chapter | null = null;
    let prev: Para | null = null;
    for (const p of paras) {
        const ts = typeof p.floor.timestamp === 'number' ? p.floor.timestamp : undefined;
        const prevTs = prev && typeof prev.floor.timestamp === 'number' ? prev.floor.timestamp : undefined;
        const newFloor = prev == null || p.floorId !== prev.floorId;
        const gap = newFloor && ts != null && prevTs != null && ts - prevTs > CHAPTER_GAP_MS;
        const full = newFloor && cur != null && cur.chars >= CHAPTER_CHARS;
        if (cur == null || ((gap || full) && newFloor)) {
            cur = {
                index: chapters.length,
                title: firstSentence(p.text) || `第 ${chapters.length + 1} 章`,
                paraStart: p.index,
                paraEnd: p.index + 1,
                floorStart: p.floorId,
                chars: 0,
            };
            chapters.push(cur);
        }
        cur.paraEnd = p.index + 1;
        cur.chars += p.text.length;
        prev = p;
    }
    return chapters;
}

/** 段落下标 → 所属章。 */
export function chapterAt(chapters: Chapter[], paraIndex: number): Chapter | null {
    for (const c of chapters) {
        if (paraIndex >= c.paraStart && paraIndex < c.paraEnd) return c;
    }
    return chapters.length ? chapters[chapters.length - 1]! : null;
}

// ---------- misc display helpers ----------

/** 书架副行/列表预览:首句截断。 */
export function previewLine(text: string | undefined, max = 42): string {
    // wire 不可信(lastMessage 历史上是整条楼层对象)——非字符串直接放弃预览。
    if (typeof text !== 'string' || !text) return '';
    const oneLine = text.replace(/\s+/g, ' ').trim();
    const s = firstSentence(oneLine, max);
    return s || (oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine);
}

export const PARA_INDENT = '　　'; // 段首缩进 2 字(全角空格近似 —— RN Text 无 text-indent)
