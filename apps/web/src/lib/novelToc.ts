// lib:novelToc —— 楼→章推导(任务书三级口径)+ 成书判定/截句工具。
// 同源消费方:NovelBody(stagepack 舞台侧栏/正文)与 ChaptersPanel
// (SpecPanels 右栏板块)—— 目录真值唯一,谁渲染都是同一套章。
// 推导策略随行(strategy),展示侧如实标注,不假装是服务端章节目录。
import type { FloorMsg } from '../api/chats';

/** 无分章信号时的自动分段粒度(N 楼/章)。 */
export const SEGMENT_FLOORS = 4;

const ZH_D = '零一二三四五六七八九';
/** 1–99 中文数词(章序号);≥100 回落阿拉伯数字。 */
const zhNum = (n: number): string =>
    n < 10 ? ZH_D[n]!
        : n === 10 ? '十'
            : n < 20 ? `十${ZH_D[n % 10]}`
                : n < 100 ? `${ZH_D[Math.floor(n / 10)]}十${n % 10 ? ZH_D[n % 10] : ''}`
                    : String(n);

export interface TocPara {
    id: string;
    text: string;
    /** user 楼不进书页正文 —— 渲为段间「指挥」注记,不藏数据。 */
    role: FloorMsg['role'];
    streaming?: boolean;
}

export interface TocChapter {
    id: string;
    num: string;
    title: string;
    paras: TocPara[];
    /** 覆盖楼层区间(服务端楼号 = body 下标);含瞬态楼(负 id)时不下标。 */
    floors?: [number, number];
}

/** 推导路径 —— 侧栏如实标注,不假装是服务端章节目录。 */
export type TocStrategy = 'markers' | 'segmented' | 'single' | 'empty' | 'seed';
export interface NovelToc {
    chapters: TocChapter[];
    strategy: TocStrategy;
}

/** 错误楼(发送/生成失败)与空 system 楼(会话头种)不参与成书。 */
export const bookable = (m: FloorMsg) => !m.error && (m.role !== 'system' || m.content.trim());

/** 章题标记首行自带的序号称谓(「第三章 风波」→ num 第三章 / title 风波)。 */
const CHAPTER_HEAD = /^(第[零〇一二两三四五六七八九十百千万\d]+[章节卷回部篇]|序[章言]|楔子|尾声|Prologue\b|Chapter\s+\d+)\s*[:：·\-—、 ]*\s*(.*)$/i;

export const snippet = (s: string, n: number) => {
    const v = s.trim().replace(/\s+/g, ' ');
    return v.length > n ? `${v.slice(0, n)}…` : v;
};

/** 楼→章推导(三级,任务书口径):
 *  1. system 楼带正文 = 分章标记:首行作章题,标记楼本身不渲成段;
 *     首个标记前的楼层归入「序章」。
 *  2. 无标记且楼数 > SEGMENT_FLOORS → 每 N 楼一节(节题取首段起句)。
 *  3. 再少 → 单章兜底。
 *  user 楼保留为段间注记(role 标记,渲染为「指挥」行)。 */
export function deriveChapters(msgs: FloorMsg[], t: (k: string) => string, chatTitle: string): NovelToc {
    const floors = msgs.filter(bookable);
    if (!floors.length) return { chapters: [], strategy: 'empty' };
    const parasOf = (list: FloorMsg[]): TocPara[] =>
        list.flatMap((m) => {
            const blocks = (m.displayContent ?? m.content).split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
            return blocks.map((text, i) => ({
                id: `f${m.id}p${i}`, text, role: m.role,
                streaming: (m.streaming && i === blocks.length - 1) || undefined,
            }));
        });
    const mk = (seq: number, num: string, title: string, list: FloorMsg[]): TocChapter => ({
        id: `ch-${seq}`, num, title, paras: parasOf(list),
        floors: list.length && list[0]!.id >= 0 && list[list.length - 1]!.id >= 0
            ? [list[0]!.id, list[list.length - 1]!.id] : undefined,
    });
    const markerAt = floors.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0);
    if (markerAt.length) {
        const chapters: TocChapter[] = [];
        if (markerAt[0]! > 0) {
            const pro = floors.slice(0, markerAt[0]!);
            chapters.push(mk(0, t('novel.prologue'), snippet(parasOf(pro)[0]?.text ?? '', 18), pro));
        }
        markerAt.forEach((mi) => {
            const end = markerAt.find((x) => x > mi) ?? floors.length;
            const line = (floors[mi]!.displayContent ?? floors[mi]!.content).trim().split('\n')[0]!.trim();
            const head = CHAPTER_HEAD.exec(line);
            const num = head ? head[1]! : `第${zhNum(chapters.length + 1)}章`;
            const title = head ? (head[2]?.trim() || head[1]!) : snippet(line, 24);
            chapters.push(mk(chapters.length, num, snippet(title, 24), floors.slice(mi + 1, end)));
        });
        return { chapters, strategy: 'markers' };
    }
    if (floors.length > SEGMENT_FLOORS) {
        const chapters: TocChapter[] = [];
        for (let i = 0; i < floors.length; i += SEGMENT_FLOORS) {
            const slice = floors.slice(i, i + SEGMENT_FLOORS);
            chapters.push(mk(chapters.length, `第${zhNum(chapters.length + 1)}节`, snippet(parasOf(slice)[0]?.text ?? '', 18), slice));
        }
        return { chapters, strategy: 'segmented' };
    }
    return { chapters: [mk(0, t('novel.body'), chatTitle || snippet(parasOf(floors)[0]?.text ?? '', 18), floors)], strategy: 'single' };
}
