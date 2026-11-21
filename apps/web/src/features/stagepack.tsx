// feature:stagepack — 舞台形态注册(novel/messenger/theater 三种形态)。
// 形态体与聊天形态共享 StageFrame(stage-header/弹层/QR/composer/生成引擎),
// 本文件只管形态内容;数据双轨:
//   · 楼层轨 —— useStageEngine().msgs,真实数据(加载逻辑见 StageFrame);
//   · 预演轨 —— stageData 种子,st-* 会话服务端不存(404 → 楼层空)时兜底,
//     侧栏/场景签如实标注「预演」,不装作真数据。
// theater 方向已重定义为「剧场小说」(非 galgame/VN):聊天楼层演成舞台剧
// —— 台上幕(cast 气泡/居中旁白条)+ 底条(choices/hotbar/对话条),
// 另有「沉浸接管」壳层:激活即 portal 全幅覆盖(chrome 让位不卸载,
// 退出即回)+ 真 Fullscreen/移动横屏锁(失败静默回落),详见 TheaterBody。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../kernel/context';
import { useI18n } from '../i18n';
import { charImageUrl, type CardItem } from '../api/characters';
import type { FloorMsg } from '../api/chats';
import { Icon } from '../components/Icon';
import { StageFrame, charImgFallback, useStageEngine } from '../components/stage/StageFrame';
import type { Feature } from '../kernel/kernel';

/** 卡头像环(形态内复用:会话卡图,无卡/离线 404 → default-char 占位)。 */
function StageRing({ size }: { size: number }) {
    const s = useShell();
    const card = s.chat ? s.cards.get(s.chat.charDir) : undefined;
    const src = card?.avatar ? charImageUrl(card.avatar) : '/assets/avatars/default-char.png';
    return (
        <span className="char-avatar-ring shrink-0" style={{ width: size, height: size }}>
            <img src={src} alt="" className="h-full w-full object-cover" onError={charImgFallback} />
        </span>
    );
}

/* =========================================================================
   novel —— 楼→章推导 + 章目录侧栏
   ========================================================================= */

/** 无分章信号时的自动分段粒度(N 楼/章)。 */
const SEGMENT_FLOORS = 4;

const ZH_D = '零一二三四五六七八九';
/** 1–99 中文数词(章序号);≥100 回落阿拉伯数字。 */
const zhNum = (n: number): string =>
    n < 10 ? ZH_D[n]!
        : n === 10 ? '十'
            : n < 20 ? `十${ZH_D[n % 10]}`
                : n < 100 ? `${ZH_D[Math.floor(n / 10)]}十${n % 10 ? ZH_D[n % 10] : ''}`
                    : String(n);

interface TocPara {
    id: string;
    text: string;
    /** user 楼不进书页正文 —— 渲为段间「指挥」注记,不藏数据。 */
    role: FloorMsg['role'];
    streaming?: boolean;
}

interface TocChapter {
    id: string;
    num: string;
    title: string;
    paras: TocPara[];
    /** 覆盖楼层区间(服务端楼号 = body 下标);含瞬态楼(负 id)时不下标。 */
    floors?: [number, number];
}

/** 推导路径 —— 侧栏如实标注,不假装是服务端章节目录。 */
type TocStrategy = 'markers' | 'segmented' | 'single' | 'empty' | 'seed';
interface NovelToc {
    chapters: TocChapter[];
    strategy: TocStrategy;
}

/** 错误楼(发送/生成失败)与空 system 楼(会话头种)不参与成书。 */
const bookable = (m: FloorMsg) => !m.error && (m.role !== 'system' || m.content.trim());

/** 章题标记首行自带的序号称谓(「第三章 风波」→ num 第三章 / title 风波)。 */
const CHAPTER_HEAD = /^(第[零〇一二两三四五六七八九十百千万\d]+[章节卷回部篇]|序[章言]|楔子|尾声|Prologue\b|Chapter\s+\d+)\s*[:：·\-—、 ]*\s*(.*)$/i;

const snippet = (s: string, n: number) => {
    const v = s.trim().replace(/\s+/g, ' ');
    return v.length > n ? `${v.slice(0, n)}…` : v;
};

/** 楼→章推导(三级,任务书口径):
 *  1. system 楼带正文 = 分章标记:首行作章题,标记楼本身不渲成段;
 *     首个标记前的楼层归入「序章」。
 *  2. 无标记且楼数 > SEGMENT_FLOORS → 每 N 楼一节(节题取首段起句)。
 *  3. 再少 → 单章兜底。
 *  user 楼保留为段间注记(role 标记,渲染为「指挥」行)。 */
function deriveChapters(msgs: FloorMsg[], t: (k: string) => string, chatTitle: string): NovelToc {
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

/** 形态错误楼(非 chat 形态没有楼层列,失败得有自己的露面位)。 */
function StageErrorFloors() {
    const { t } = useI18n();
    const eng = useStageEngine();
    const errs = eng.msgs.filter((m) => m.error);
    if (!errs.length) return null;
    return (
        <div className="space-y-2">
            {errs.map((m) => {
                const ops = eng.opsOf(m, eng.msgs.indexOf(m));
                return (
                    <div key={m.id} className="flex items-center justify-between gap-2 rounded-[12px] p-3" style={{ background: 'rgba(248, 113, 113, 0.08)', border: '1px solid rgba(248, 113, 113, 0.35)' }}>
                        <div className="min-w-0">
                            <span className="font-mono-ui text-[11.5px] font-medium" style={{ color: 'var(--status-danger)' }}>{m.error!.code}</span>
                            <span className="ml-2 text-[11px] text-[color:var(--fg-muted)]">{t('stage.err.failed')}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            {m.error!.retry && (
                                <button className="h-7 rounded-lg px-2.5 py-1 text-[11px] font-medium" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }} onClick={() => ops.onRetry(m)}>
                                    {t('stage.err.retry')}
                                </button>
                            )}
                            <button className="h-7 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-[11px] text-[color:var(--fg-secondary)]" onClick={() => ops.onTrace(m)}>
                                {t('stage.err.trace')}
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/** novel 形态(规范稿:px-5 sm:px-10 py-6 + scroll-fade-mask / 640px 栏 /
 *  章头左对齐 mono num + serif 题 / novel-p 点选出「润色此段」行)。
 *  TASK-044 补:左侧章目录(≥sm 常驻 / 移动抽屉)+ 楼→章推导 + 点章滚动定位。 */
function NovelBody() {
    const { t } = useI18n();
    const s = useShell();
    const eng = useStageEngine();
    const [tocOpen, setTocOpen] = useState(false);
    const [activeCh, setActiveCh] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const sectionRefs = useRef(new Map<string, HTMLElement>());

    /* 楼层轨优先;零楼层回落 stageData 预演种子(仅 st-* 预演会话 ——
       真会话(id=dir/name)零楼层走空态,不拿种子冒充正文)。 */
    const isSeedSession = !!s.chat && s.chat.id !== `${s.chat.charDir}/${s.chat.chatName}`;
    const toc = useMemo<NovelToc>(() => {
        if (eng.msgs.length) return deriveChapters(eng.msgs, t, s.chat?.title ?? '');
        if (!isSeedSession || !s.stageData.chapters.length) return { chapters: [], strategy: 'empty' };
        return {
            chapters: s.stageData.chapters.map((c) => ({
                id: c.id, num: c.num, title: c.title,
                paras: c.paras.map((p) => ({ id: p.id, text: p.text, role: 'assistant' as const })),
            })),
            strategy: 'seed',
        };
    }, [eng.msgs, isSeedSession, s.stageData.chapters, s.chat?.title, t]);

    const jump = (id: string) => {
        sectionRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveCh(id);
        setTocOpen(false);
    };

    /* 滚动跟随:目录高亮 = 视口顶缘 120px 线以上最后一章。 */
    const onScroll = () => {
        const el = scrollRef.current;
        if (!el || !toc.chapters.length) return;
        const top = el.getBoundingClientRect().top;
        let cur: string | null = toc.chapters[0]!.id;
        for (const c of toc.chapters) {
            const sec = sectionRefs.current.get(c.id);
            if (sec && sec.getBoundingClientRect().top - top <= 120) cur = c.id;
        }
        setActiveCh(cur);
    };

    const strategyText = {
        markers: `${t('novel.strategy.markers')} · ${toc.chapters.length} ${t('novel.strategy.chapters')}`,
        segmented: `${t('novel.strategy.segmented')} · ${SEGMENT_FLOORS} ${t('novel.strategy.perChapter')}`,
        single: t('novel.strategy.single'),
        seed: t('novel.strategy.seed'),
        empty: t('novel.strategy.empty'),
    }[toc.strategy];

    const tocList = (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center justify-between px-3.5">
                <span className="text-[11px] font-medium tracking-widest text-[color:var(--fg-muted)]">{t('novel.toc')}</span>
                <button className="ghost-btn h-6 w-6 sm:hidden" onClick={() => setTocOpen(false)} title={t('stage.edit.cancel')}>
                    <Icon name="x" size={13} />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {toc.chapters.map((c) => (
                    <button
                        key={c.id}
                        className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-surface)]"
                        style={activeCh === c.id ? { background: 'var(--bg-active)' } : undefined}
                        onClick={() => jump(c.id)}
                    >
                        <span className="block font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">{c.num}</span>
                        <span className="mt-0.5 block truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{c.title}</span>
                        <span className="mt-0.5 block font-mono-ui text-[10px] text-[color:var(--fg-faint)]">
                            {c.floors ? `#${c.floors[0] + 1}–${c.floors[1] + 1}${t('novel.floorsUnit')} · ` : ''}{c.paras.length}{t('panel.chapters.paras')}
                        </span>
                    </button>
                ))}
                {!toc.chapters.length && (
                    <div className="px-2.5 py-3 text-[11.5px] leading-relaxed text-[color:var(--fg-muted)]">{t('novel.toc.empty')}</div>
                )}
            </div>
            {/* 推导策略如实标注 —— 不假装是服务端章节目录 */}
            <div className="shrink-0 border-t border-[color:var(--border-hairline)] px-3.5 py-2 font-mono-ui text-[10px] leading-relaxed text-[color:var(--fg-faint)]">
                {strategyText}
            </div>
        </div>
    );

    return (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {/* ≥sm 常驻章目录栏 */}
            <aside className="hidden w-44 shrink-0 border-r border-[color:var(--border-hairline)] sm:block" style={{ background: 'var(--bg-chrome)' }}>
                {tocList}
            </aside>
            {/* 移动态:叠层抽屉章目录 */}
            {s.isMobile && tocOpen && (
                <div className="absolute inset-0 z-30 sm:hidden">
                    <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.34)' }} onClick={() => setTocOpen(false)} />
                    <aside className="pop-in absolute inset-y-0 left-0 w-56 max-w-[80%] border-r border-[color:var(--border-hairline)]" style={{ background: 'var(--bg-elevated)' }}>
                        {tocList}
                    </aside>
                </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
                {/* 移动端目录入口条 */}
                {s.isMobile && (
                    <button
                        className="flex h-9 shrink-0 items-center gap-2 border-b border-[color:var(--border-hairline)] px-4 text-[12px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-surface)]"
                        onClick={() => setTocOpen(true)}
                    >
                        <Icon name="listNumbers" size={15} />
                        <span className="truncate">{toc.chapters.find((c) => c.id === activeCh)?.title ?? t('novel.toc')}</span>
                    </button>
                )}
                <div ref={scrollRef} onScroll={onScroll} className="scroll-fade-mask min-h-0 flex-1 select-text overflow-y-auto px-5 py-6 sm:px-10">
                    <div className="mx-auto max-w-[640px] space-y-8 pb-8">
                        {eng.loadErr && (
                            <div className="rounded-[12px] p-3.5 text-[12px] text-[color:var(--fg-secondary)]" style={{ background: 'rgba(248, 113, 113, 0.08)', border: '1px solid rgba(248, 113, 113, 0.35)' }}>
                                <span className="font-medium" style={{ color: 'var(--status-danger)' }}>{t('stage.err.load')}</span>
                                <button className="ml-2 underline" onClick={() => void eng.reload()}>{t('panel.retry')}</button>
                            </div>
                        )}
                        {toc.chapters.map((c) => (
                            <section
                                key={c.id}
                                data-chapter={c.id}
                                ref={(el) => { if (el) sectionRefs.current.set(c.id, el); else sectionRefs.current.delete(c.id); }}
                                className="scroll-mt-4 space-y-3"
                            >
                                <div className="pt-2">
                                    <div className="font-mono-ui text-[11px] tracking-widest text-[color:var(--fg-muted)]">{c.num}</div>
                                    <h2 className="font-serif-ui heading-tight mt-1 text-title-lg font-semibold text-[color:var(--fg-primary)]">{c.title}</h2>
                                </div>
                                <div className="space-y-1.5">
                                    {!c.paras.length && (
                                        <div className="py-2 text-[12px] italic text-[color:var(--fg-faint)]">{t('novel.chapter.empty')}</div>
                                    )}
                                    {c.paras.map((p) => {
                                        if (p.role === 'user') {
                                            /* user 楼 = 指挥注记:居中弱显,不混进正文 */
                                            return (
                                                <div key={p.id} className="flex justify-center py-1">
                                                    <span className="max-w-[85%] truncate rounded-full px-3 py-1 text-[11px] italic text-[color:var(--fg-muted)]" style={{ background: 'var(--bg-surface)' }}>
                                                        {snippet(p.text, 48)}
                                                    </span>
                                                </div>
                                            );
                                        }
                                        const sel = s.stageData.selParaId === p.id;
                                        return (
                                            <div
                                                key={p.id}
                                                className="novel-p whitespace-pre-line"
                                                data-sel={sel || undefined}
                                                onClick={() => s.patchStageData({ selParaId: sel ? null : p.id })}
                                            >
                                                {p.text}
                                                {p.streaming && <span className="cursor-bar" />}
                                                {sel && (
                                                    <div className="mt-2.5 flex items-center gap-2 border-t pt-2 font-sans text-xs" style={{ textIndent: 0, borderColor: 'var(--border-subtle)' }}>
                                                        <button
                                                            className="rounded-lg px-2 py-1 text-[color:var(--fg-muted)]"
                                                            onClick={(e) => { e.stopPropagation(); s.patchStageData({ selParaId: null }); }}
                                                        >
                                                            {t('stage.edit.cancel')}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}
                        {toc.strategy === 'empty' && !eng.loadErr && (
                            <div className="flex flex-col items-center gap-2.5 py-14 text-center">
                                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] text-[color:var(--fg-muted)]">
                                    <Icon name="feather" size={20} />
                                </span>
                                <div className="text-[13px] font-medium text-[color:var(--fg-primary)]">{t('novel.empty')}</div>
                                <div className="max-w-[300px] text-[11.5px] leading-relaxed text-[color:var(--fg-muted)]">{t('novel.empty.desc')}</div>
                            </div>
                        )}
                        <StageErrorFloors />
                    </div>
                </div>
            </div>
        </div>
    );
}

/** messenger 形态(规范稿:频道 pill 条 + 620px 泡列 / 非己方带 w-8 头像环)。 */
function MessengerBody() {
    const s = useShell();
    const ch = s.stageData.channels.find((c) => c.id === s.stageData.activeChannel) ?? s.stageData.channels[0]!;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[color:var(--border-hairline)] px-4 py-2">
                {s.stageData.channels.map((c) => {
                    const act = c.id === ch.id;
                    return (
                        <button
                            key={c.id}
                            className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors"
                            style={act ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                            onClick={() => s.patchStageData({ activeChannel: c.id })}
                        >
                            <span>{c.name}</span>
                            {c.unread > 0 && (
                                <span className="flex h-4 w-4 items-center justify-center rounded-full font-mono-ui text-[10px]" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}>{c.unread}</span>
                            )}
                        </button>
                    );
                })}
            </div>
            <div className="scroll-fade-mask min-h-0 flex-1 select-text overflow-y-auto px-4 py-5 sm:px-7">
                <div className="mx-auto max-w-[620px] space-y-4 pb-6">
                    <div className="text-center text-[11px] text-[color:var(--fg-muted)]">{ch.notice}</div>
                    {ch.msgs.map((m, i) => (
                        <div key={i} className={`flex items-start gap-2.5 ${m.self ? 'justify-end' : 'justify-start'}`}>
                            {!m.self && <StageRing size={32} />}
                            <div className="max-w-[78%] space-y-1">
                                <div className={`flex items-center gap-2 text-[11px] text-[color:var(--fg-muted)] ${m.self ? 'justify-end' : ''}`}>
                                    <span>{m.sender}</span><span>{m.time}</span>
                                </div>
                                <div
                                    className="rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed"
                                    style={{ background: m.self ? 'var(--bg-user-bubble)' : 'var(--bg-surface)', color: 'var(--fg-primary)' }}
                                >
                                    {m.text}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}


/* =========================================================================
   theater —— 剧场小说:聊天楼层演成舞台剧(方向重定义,不是 galgame/VN)
   台上幕 = 末楼之前最近 N 楼:cast 头像框+气泡(user/persona 归右位,群聊
           逐 speaker 各自登台)/ 旁白楼层居中叙述条;旧幕滚出台口淡出。
   底条 fixture = choices(额外支) → hotbar(9 槽物品栏) → 对话条(advance)。
   ========================================================================= */

interface VnOption {
    key: string;
    /** 分支类(swipe)选项带版号徽标;结构化选项纯文本。 */
    badge?: string;
    text: string;
    onPick: () => void;
}

/** 未来协议钩位:generate 响应 choices 字段落进楼层 extra 后此处自动生效
 *  (服务端面 = TASK-044/050 theater choices;形状 {text}[] 宽松解析)。 */
function extraChoices(m: FloorMsg | null, send: (text: string) => void): VnOption[] {
    const raw = m?.extra?.choices;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((c, i) => {
            const text = typeof c === 'string' ? c : (c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : '');
            return text ? { key: `x${i}`, text, onPick: () => send(text) } : null;
        })
        .filter((o): o is VnOption => o !== null);
}

/* ——— 台上幕:楼层 → cast 气泡 / 旁白叙述条 ——— */

/** 台上幕容量:末楼进底部对话条,其前最近 N 楼在台;更早的滚出台口。 */
const STAGE_BEATS = 4;

/** 旁白判定:extra.narrator 显式标 | system 楼 | 非 user 无名楼 —— 居中叙述条。 */
const isNarratorFloor = (m: FloorMsg) =>
    !!m.extra?.narrator || m.role === 'system' || (m.role !== 'user' && !m.name.trim());

/** 演员头像:有图用图;挂图/无图 → 首字符圆块(诚实空态,不伪造立绘)。 */
function BeatAvatar({ url, name, size = 34 }: { url: string | null; name: string; size?: number }) {
    const [bad, setBad] = useState(false);
    useEffect(() => setBad(false), [url]);
    return (
        <span
            className="flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-serif-ui text-white/85"
            style={{ width: size, height: size, background: 'rgba(22,22,28,0.78)', border: '1px solid rgba(255,255,255,0.16)', fontSize: Math.round(size * 0.42) }}
        >
            {url && !bad
                ? <img src={url} alt={name} className="h-full w-full rounded-full object-cover" onError={() => setBad(true)} />
                : (name.trim()[0] ?? '·')}
        </span>
    );
}

/* ——— hotbar:楼层 variables 快照 → 9 槽物品栏 ——— */

const HOTBAR_SLOTS = 9;

interface HotItem { name: string; icon?: string; count?: number }

/** 物品数组键候选 —— MVU stat_data 各家卡字段名不一,按序探测;
 *  读不到 = 空槽(诚实空态,不伪造物品)。 */
const INV_KEYS = ['inventory', 'items', 'hotbar', 'bag', '物品栏', '背包', '物品', '行囊', '道具', '装备'];

/** 槽元素归一:字符串 → {name};对象 → name/icon/count 多键取。 */
const normItem = (x: unknown): HotItem | null => {
    if (typeof x === 'string') return x.trim() ? { name: x.trim() } : null;
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const o = x as Record<string, unknown>;
    const pickStr = (keys: string[]) =>
        keys.map((k) => o[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
    const name = pickStr(['name', 'label', 'title', '名称', '名字', 'id']);
    if (!name) return null;
    const icon = pickStr(['icon', 'image', 'img', 'pic', '图标']);
    const count = ['count', 'qty', 'num', 'n', '数量'].map((k) => o[k])
        .find((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return { name: name.trim(), icon: icon?.trim() || undefined, count };
};

/** 袋层探测:先按 INV_KEYS 直查数组,再向 stat_data 系容器下钻(≤3 层防深袋)。 */
function probeBag(bag: unknown, depth: number): HotItem[] | null {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag) || depth > 3) return null;
    const o = bag as Record<string, unknown>;
    for (const k of INV_KEYS) {
        const v = o[k];
        if (!Array.isArray(v)) continue;
        const items = v.map(normItem).filter((i): i is HotItem => i !== null);
        if (items.length) return items;
    }
    for (const nest of ['stat_data', 'statData', 'state', 'data', 'vars']) {
        const hit = probeBag(o[nest], depth + 1);
        if (hit) return hit;
    }
    return null;
}

/** 楼层 variables = {[swipeId]: stat_data 投影}:袋本体 → activeSwipe 位 → 最大数字键。 */
function floorItems(m: FloorMsg): HotItem[] {
    const bag = m.variables;
    if (!bag || typeof bag !== 'object') return [];
    const direct = probeBag(bag, 0);
    if (direct) return direct;
    const swipeKeys = Object.keys(bag).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => b - a);
    const ordered = [...new Set([...(m.activeSwipe != null ? [m.activeSwipe] : []), ...swipeKeys])];
    for (const k of ordered) {
        const hit = probeBag(bag[String(k)], 0);
        if (hit) return hit;
    }
    return [];
}

/** icon 字段判定:URL/文件路径 → <img>;短串(emoji/单字)→ 文本字形。 */
const isIconUrl = (s: string) => /^(\/|https?:\/\/|data:)/.test(s) || /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(s);

/** theater 形态 —— 剧场小说:壳层沉浸接管 + 台上幕 + 底条 fixture。
 *
 *  壳层(同 TASK-044):激活 theater 即 portal「fixed inset-0 z-78」全幅覆盖 ——
 *  rail/工作台/浮窗被压在下面(让位但不卸载,状态保留,退出即回);
 *  toast/弹窗/cmdk(z≥80)仍在上层,保留系统级逃生口。Chrome/shell 零改动。
 *  · 顶排:场景签 | 赏景(hideHud)+ 真全屏 ⛶ + 退出沉浸 ✕。
 *  · 真 Fullscreen = documentElement.requestFullscreen;fullscreenchange
 *    同步钮态,退出时顺手解横屏锁;无手势/旧内核拒绝 → 静默回落
 *    (覆盖层本身已是全幅接管,视觉无差)。
 *  · 移动横屏:fullscreen 成功后尝试 orientation.lock('landscape');
 *    失败/未锁 → 竖屏下露「旋转设备」提示层(可关)。
 *
 *  舞台(剧场小说重定义,楼层轨优先 —— 零楼层回落 vn 预演种子,场景签带「预演」徽标):
 *    台上幕 = 末楼之前最近 STAGE_BEATS 楼:cast 楼 → 头像框+名签+气泡
 *             (user/persona 归右,其余 speaker 归左;群聊逐名查卡登台,
 *             查不到卡 → 首字符圆块,不伪造头像);旁白楼 → 居中叙述条;
 *    底条   = extra.choices/swipe 分支选项 → hotbar(最近快照 variables
 *             探测物品数组,9 槽;点槽 → 退沉浸 + openPanel('cardapp'))
 *             → 对话条(末楼 speaker/正文 + 流式光标 + ▸ 推进);
 *    背景   = 末楼 extra.scene.bg 钩位 → 规范稿 stage-hall 资产 → 挂图落深空渐变。 */
function TheaterBody() {
    const { t } = useI18n();
    const s = useShell();
    const eng = useStageEngine();
    const vn = s.stageData.vn;
    const floors = eng.msgs.filter(bookable);
    const last = [...floors].reverse().find((m) => m.content.trim() || m.streaming) ?? null;
    const lastPos = last ? floors.lastIndexOf(last) : -1;
    const fromFloors = floors.length > 0;
    const card = s.chat ? s.cards.get(s.chat.charDir) : undefined;
    const ops = last ? eng.opsOf(last, eng.msgs.indexOf(last)) : null;

    /* 楼层名 → 卡查表(name/charDir 双键小写);群聊逐 speaker 各自登台。 */
    const castTable = useMemo(() => {
        const m = new Map<string, CardItem>();
        for (const c of s.cards.values()) {
            m.set(c.name.trim().toLowerCase(), c);
            m.set(c.charDir.trim().toLowerCase(), c);
        }
        return m;
    }, [s.cards]);

    const castOf = useCallback((name: string): CardItem | undefined => {
        const key = name.trim().toLowerCase();
        if (!key) return undefined;
        const exact = castTable.get(key);
        if (exact) return exact;
        /* 楼层名常带称谓/前缀缀尾(「林砚(大师兄)」「云栖宗 · 陈修线」)——
           剥括号段与间隔号后缀再试;仍不中 → undefined → 首字符块。 */
        const stripped = key.replace(/\s*[([{（【].*$/u, '').replace(/\s*[·・—–\-:：].*$/u, '').trim();
        return stripped && stripped !== key ? castTable.get(stripped) : undefined;
    }, [castTable]);

    const personaUrl = s.persona?.avatar ? `/User%20Avatars/${encodeURIComponent(s.persona.avatar)}` : null;
    /** 楼层 → 台上身份:{url 头像源(空 → 首字符块), name 名签}。 */
    const roleOf = useCallback((m: FloorMsg): { url: string | null; name: string } => {
        if (m.role === 'user') return { url: personaUrl, name: m.name || s.persona?.name || '你' };
        const c = castOf(m.name);
        return { url: c?.avatar ? charImageUrl(c.avatar) : null, name: m.name || c?.name || '?' };
    }, [personaUrl, castOf, s.persona?.name]);

    /* 台上幕 = 末楼之前的最近 N 楼(末楼独白归底部对话条);
       narrator 判定与头像在渲染处逐拍解析。 */
    const beatFloors = lastPos > 0 ? floors.slice(Math.max(0, lastPos - STAGE_BEATS), lastPos) : [];

    /* 对话条:末楼 speaker 名签 + 正文;user 楼按线名照显(它是玩家台词)。 */
    const speaker = fromFloors ? (last?.name || card?.name || '—') : vn.speaker;
    const line = fromFloors ? (last ? (last.displayContent ?? last.content) : '') : vn.line;
    const streaming = !!last?.streaming;
    const lastNarrator = !!last && isNarratorFloor(last);
    const lastRole = last ? roleOf(last) : null;

    /* 场景底图源:楼层 extra.scene.bg 钩位(未来场景 sidecar 落点)→ 规范稿
       stage-hall(云栖宗正殿内景,已抽为静态资产);挂图/无图 → 深空渐变兜底。 */
    const sceneBg = (() => {
        const sc = last?.extra?.scene;
        const bg = sc && typeof sc === 'object' ? (sc as Record<string, unknown>).bg : null;
        return typeof bg === 'string' && bg ? bg : '/assets/backgrounds/stage-hall.jpg';
    })();
    const [bgBad, setBgBad] = useState(false);

    /* ——— 沉浸壳状态 ——— */
    const [immersive, setImmersive] = useState(true);
    const [fsOn, setFsOn] = useState(false);
    const [portrait, setPortrait] = useState(false);
    const [rotateHint, setRotateHint] = useState(true);

    /* 台上幕滚动袋(frame/immersive 两处实例 → Set 收双份,新拍到底各自贴底;
       ref 卸载时拿不到元素 → 贴底前顺手清掉已断开的旧节点)。 */
    const beatScrolls = useRef(new Set<HTMLDivElement>());
    useEffect(() => {
        beatScrolls.current.forEach((el) => {
            if (!el.isConnected) beatScrolls.current.delete(el);
            else el.scrollTop = el.scrollHeight;
        });
    }, [floors.length, lastPos]);

    /* 选项区:extra.choices 钩位 → swipe 分支 → 空态;
       分支 +1 位 = 「再生成一支」(swipe 生成,仅末楼有意义)。 */
    let choices: VnOption[];
    if (!fromFloors) {
        choices = vn.choices.map((c) => ({ key: c.op, text: c.text, onPick: () => s.bridgeOp(c.op) }));
    } else {
        const extra = extraChoices(last, eng.send);
        const swipes = last?.role === 'assistant' ? last.swipes ?? [] : [];
        choices = extra.length ? extra : (swipes.length > 1
            ? swipes.map((sw) => ({
                key: `sw${sw.index}`, badge: `${sw.index + 1}`,
                text: snippet(sw.content, 44) || t('gal.choice.blank'),
                onPick: () => ops?.onSwipeTo(last!, sw.index),
            }))
            : []);
        if (!extra.length && last?.role === 'assistant' && ops?.isLast && !last.streaming && !last.error) {
            choices.push({
                key: 'sw-next', badge: '+', text: t('gal.choice.regen'),
                /* 「末位之后」= 再生成一版;无 swipe 链的楼取 1(count=0 时
                   index 0 会被 onSwipeTo 判同版早退)。 */
                onPick: () => ops.onSwipeTo(last, Math.max(1, last.swipes?.length ?? 0)),
            });
        }
    }

    /* hotbar:最近一层带 variables 快照的楼(MVU 投影 = 该楼结算后状态);
       探测多键,读不到 → 9 空槽(诚实空态)。floors 每渲即新数组,memo 无意义。 */
    const invFloor = [...floors].reverse().find((m) => m.variables && Object.keys(m.variables).length > 0);
    const items = invFloor ? floorItems(invFloor) : [];
    const slots: (HotItem | null)[] = Array.from({ length: HOTBAR_SLOTS }, (_, i) => items[i] ?? null);

    /* 推进钩位:末楼可锚才露面 —— eng.advance = normal 生成下一拍。 */
    const canAdvance = fromFloors && !!ops?.isLast && !last?.streaming && !last?.error;

    /* 真全屏态同步;退出全屏顺手解横屏锁。 */
    useEffect(() => {
        const onFs = () => {
            const on = !!document.fullscreenElement;
            setFsOn(on);
            if (!on) { try { screen.orientation?.unlock(); } catch { /* 不支持 */ } }
        };
        document.addEventListener('fullscreenchange', onFs);
        onFs();
        return () => document.removeEventListener('fullscreenchange', onFs);
    }, []);

    /* 移动竖屏侦测 —— 「旋转设备」提示层的开关量(仅沉浸态在意)。 */
    useEffect(() => {
        if (!immersive || !s.isMobile) { setPortrait(false); return; }
        const mq = window.matchMedia('(orientation: portrait)');
        const update = () => setPortrait(mq.matches);
        update();
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
    }, [immersive, s.isMobile]);

    /* ESC 退沉浸;真全屏态第一下让浏览器退全屏,第二下才退沉浸。 */
    useEffect(() => {
        if (!immersive) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !document.fullscreenElement) setImmersive(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [immersive]);

    /* 离场(换会话/换形态)→ 收全屏与横屏锁,不留给下一个场景。 */
    useEffect(() => () => {
        try { if (document.fullscreenElement) void document.exitFullscreen(); } catch { /* noop */ }
        try { screen.orientation?.unlock(); } catch { /* noop */ }
    }, []);

    /* 场景底图源随楼层变化 → 挂图标记复位重试。 */
    useEffect(() => { setBgBad(false); }, [sceneBg]);

    const enterFs = () => {
        const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
        const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
        if (!req) return;
        void req().then(async () => {
            if (!s.isMobile) return;
            /* lock 是近年才进规范/TS lib 的面,旧内核可能没有 → 防御性取值。 */
            const lock = (screen.orientation as { lock?: (o: string) => Promise<void> } | undefined)?.lock;
            try { if (lock) await lock.call(screen.orientation, 'landscape'); }
            catch { setRotateHint(true); } /* 锁不到 → 竖屏提示层 */
        }).catch(() => { /* 拒绝(无手势/旧内核)→ 静默回落沉浸覆盖层 */ });
    };
    const exitFs = () => {
        try { if (document.fullscreenElement) void document.exitFullscreen(); } catch { /* noop */ }
        try { screen.orientation?.unlock(); } catch { /* noop */ }
    };
    const leaveImmersive = () => { exitFs(); setImmersive(false); };

    /* hotbar → 卡自带面板:沉浸壳(z-78)压在工作台上,先退沉浸再切面板,
       真联动不假装;面板类型按卡 manifest —— 'cardapp' 宿主(CardAppFrame)
       自行解析卡的 entry/manifest 面;params 透传点击位,面板愿消费自取。 */
    const openBag = (item?: HotItem) => {
        if (immersive) leaveImmersive();
        s.openPanel('cardapp', { from: 'theater.hotbar', item: item?.name });
    };

    /* 进入即尝试全屏+横屏锁(任务书口径);无用户手势浏览器拒绝 → 静默,
       移动竖屏由提示层接管。 */
    useEffect(() => { if (s.isMobile) enterFs(); /* mount-only */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const pillStyle = { background: 'rgba(18,18,20,0.58)', border: '1px solid rgba(255,255,255,0.12)' } as const;

    const scene = (mode: 'frame' | 'immersive') => (
        <div
            className={mode === 'immersive'
                ? 'fixed inset-0 z-[78] flex flex-col overflow-hidden bg-black'
                : 'relative flex min-h-0 flex-1 flex-col overflow-hidden'}
        >
            {/* 背景层:深空渐变托底;场景图 cover 铺满,挂图/无图 → 只剩渐变 */}
            <div className="absolute inset-0" style={{ background: 'radial-gradient(130% 95% at 50% 16%, #21263f 0%, #12141f 55%, #07080d 100%)' }} />
            {!bgBad && <img src={sceneBg} alt="Scene" className="absolute inset-0 h-full w-full object-cover" onError={() => setBgBad(true)} />}
            {/* 三段渐变压暗(台口压重些,托住幕列与底条) */}
            <div className="absolute inset-0 z-[6]" style={{ background: 'linear-gradient(180deg, rgba(14,14,16,0.52) 0%, rgba(14,14,16,0.14) 42%, rgba(14,14,16,0.94) 100%)' }} />
            {/* 顶排:场景签 | 赏景/真全屏/退出 */}
            <div className="relative z-10 flex items-center justify-between gap-2 p-3.5">
                <span className="rounded-full px-3 py-1 text-[11.5px] text-white/90 backdrop-blur-md" style={pillStyle}>
                    {fromFloors ? (s.chat?.title ?? '') : vn.scene}
                    {!fromFloors && <span className="ml-1.5 rounded px-1 text-[9.5px] text-white/55" style={{ border: '1px solid rgba(255,255,255,0.18)' }}>{t('gal.seed')}</span>}
                </span>
                <div className="flex items-center gap-1.5">
                    <button
                        className="rounded-full px-3 py-1 text-[11.5px] text-white/85 backdrop-blur-md transition-colors hover:text-white"
                        style={pillStyle}
                        onClick={() => s.patchStageData({ vn: { ...vn, hideHud: !vn.hideHud } })}
                    >
                        {vn.hideHud ? t('vn.showDialog') : t('vn.hideHud')}
                    </button>
                    {mode === 'immersive' ? (
                        <>
                            <button
                                className="flex h-7 w-7 items-center justify-center rounded-full text-white/85 backdrop-blur-md transition-colors hover:text-white"
                                style={pillStyle}
                                title={fsOn ? t('gal.fs.exit') : t('gal.fs.enter')}
                                onClick={fsOn ? exitFs : enterFs}
                            >
                                <Icon name={fsOn ? 'dockBack' : 'focus'} size={13} />
                            </button>
                            <button
                                className="flex h-7 w-7 items-center justify-center rounded-full text-white/85 backdrop-blur-md transition-colors hover:text-white"
                                style={pillStyle}
                                title={t('gal.immersive.exit')}
                                onClick={leaveImmersive}
                            >
                                <Icon name="x" size={13} />
                            </button>
                        </>
                    ) : (
                        <button
                            className="flex h-7 w-7 items-center justify-center rounded-full text-white/85 backdrop-blur-md transition-colors hover:text-white"
                            style={pillStyle}
                            title={t('gal.immersive.enter')}
                            onClick={() => setImmersive(true)}
                        >
                            <Icon name="focus" size={13} />
                        </button>
                    )}
                </div>
            </div>
            {/* 「旋转设备」提示层:移动·竖屏·沉浸时露面;锁屏失败也拉回这层 */}
            {mode === 'immersive' && rotateHint && portrait && (
                <div className="absolute inset-x-0 top-14 z-10 flex justify-center">
                    <div className="flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] text-white/80 backdrop-blur-md" style={pillStyle}>
                        <Icon name="smartphone" size={13} />
                        {t('gal.rotate.hint')}
                        <button className="ml-0.5 text-white/45 transition-colors hover:text-white/85" onClick={() => setRotateHint(false)}>
                            <Icon name="x" size={11} />
                        </button>
                    </div>
                </div>
            )}
            {vn.hideHud ? <div className="flex-1" /> : (
                <>
                    {/* 台上幕:底锚幕列,台口向上淡出;每楼一拍,新拍浮现 */}
                    <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-end">
                        <div
                            ref={(el) => { if (el) beatScrolls.current.add(el); }}
                            className="stage-scroll no-scrollbar max-h-full overflow-y-auto px-4 sm:px-8"
                        >
                            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2.5 pb-2.5 pt-14">
                                {beatFloors.map((m) => {
                                    const text = (m.displayContent ?? m.content).trim();
                                    if (!text) return null;
                                    if (isNarratorFloor(m)) {
                                        /* 旁白:居中叙述条(舞台指示位,无头像) */
                                        return (
                                            <div key={m.id} className="stage-beat flex justify-center">
                                                <div
                                                    className="max-w-[86%] select-text rounded-xl px-4 py-2 text-center text-[12.5px] italic leading-relaxed text-white/75 backdrop-blur-sm"
                                                    style={{ background: 'rgba(14,14,18,0.5)', border: '1px solid rgba(255,255,255,0.08)' }}
                                                >
                                                    {text}
                                                </div>
                                            </div>
                                        );
                                    }
                                    const r = roleOf(m);
                                    const right = m.role === 'user';
                                    return (
                                        <div key={m.id} className={`stage-beat flex items-end gap-2.5 ${right ? 'flex-row-reverse' : ''}`}>
                                            <BeatAvatar url={r.url} name={r.name} />
                                            <div className={`min-w-0 max-w-[78%] space-y-0.5 ${right ? 'text-right' : ''}`}>
                                                <div className="truncate px-1.5 text-[10.5px] font-medium text-white/45">{r.name}</div>
                                                <div
                                                    className={`select-text whitespace-pre-line px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white/92 backdrop-blur-md ${right ? 'rounded-2xl rounded-br-md' : 'rounded-2xl rounded-bl-md'}`}
                                                    style={{
                                                        background: right ? 'rgba(34,37,48,0.74)' : 'rgba(16,16,20,0.68)',
                                                        border: '1px solid rgba(255,255,255,0.1)',
                                                    }}
                                                >
                                                    {text}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                    {/* 底条 fixture:choices → hotbar → 对话条 */}
                    <div className={mode === 'immersive' ? 'relative z-10 space-y-2.5 px-4 pb-4 sm:px-8 sm:pb-6' : 'relative z-10 mx-auto w-full max-w-[720px] space-y-2.5 p-4 sm:p-6'}>
                        <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-1.5">
                            {choices.map((c) => (
                                <button
                                    key={c.key}
                                    className="w-full rounded-xl px-4 py-2.5 text-left text-[13px] text-white/95 backdrop-blur-md transition-colors hover:bg-white/15 sm:w-[84%]"
                                    style={{ background: 'rgba(20,20,24,0.72)', border: '1px solid rgba(255,255,255,0.14)' }}
                                    onClick={c.onPick}
                                >
                                    {c.badge && <span className="mr-2 font-mono-ui text-[10px] text-white/45">{c.badge}</span>}
                                    {c.text}
                                </button>
                            ))}
                            {fromFloors && !choices.length && (
                                <div className="rounded-full px-3 py-1 text-[10.5px] text-white/40">{t('gal.choices.empty')}</div>
                            )}
                        </div>
                        {/* hotbar:Minecraft 式 9 槽物品栏 —— 入口不是全功能背包,
                            点槽/背包钮 → 退沉浸 + 右侧工作台卡自带面板(cardapp)。 */}
                        <div className="mx-auto flex items-center justify-center gap-1.5">
                            {slots.map((it, i) => (
                                <button
                                    key={i}
                                    className="hotbar-slot"
                                    title={it ? it.name : t('gal.bag.open')}
                                    onClick={() => openBag(it ?? undefined)}
                                >
                                    {it && (
                                        it.icon && isIconUrl(it.icon)
                                            ? <img src={it.icon} alt={it.name} className="h-5 w-5 rounded-[3px] object-cover" />
                                            : <span className="max-w-full truncate px-0.5 font-serif-ui text-[12px] leading-none text-white/88">
                                                {it.icon && it.icon.length <= 4 ? it.icon : it.name.trim()[0]}
                                            </span>
                                    )}
                                    {it?.count != null && it.count > 1 && <span className="hotbar-count">{it.count}</span>}
                                </button>
                            ))}
                            <button className="hotbar-slot hotbar-bag" title={t('gal.bag.open')} onClick={() => openBag()}>
                                <Icon name="layers" size={14} />
                            </button>
                        </div>
                        {/* 对话条:底锚通栏;当前拍 speaker+正文+推进(点条 = ▸);
                            旁白末楼居中叙述,不占演员位 */}
                        <div
                            className={`flex select-text items-start gap-3.5 rounded-2xl p-4 text-white backdrop-blur-xl sm:p-5 ${canAdvance ? 'cursor-pointer' : ''}`}
                            style={{ background: 'rgba(16,16,19,0.84)', border: '1px solid rgba(255,255,255,0.12)' }}
                            onClick={() => { if (canAdvance) eng.advance(); }}
                        >
                            {lastNarrator ? (
                                <div className="min-w-0 flex-1 space-y-1 text-center">
                                    <div className="text-[10px] italic tracking-[0.3em] text-white/40">{t('gal.narrator')}</div>
                                    <div className="whitespace-pre-line text-[13.5px] italic leading-relaxed text-white/85">
                                        {line}
                                        {streaming && <span className="cursor-bar" />}
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <span className="mt-0.5"><BeatAvatar url={lastRole?.url ?? null} name={lastRole?.name ?? speaker} size={42} /></span>
                                    <div className="min-w-0 flex-1 space-y-1">
                                        {/* 末楼 speaker 名签提亮;user 楼带「你」侧标 */}
                                        <div className="text-[12px] font-semibold text-white/90">
                                            {speaker}
                                            {last?.role === 'user' && <span className="ml-1.5 font-normal text-white/40">· {t('gal.you')}</span>}
                                        </div>
                                        <div className="whitespace-pre-line text-[15px] leading-relaxed text-white/95">
                                            {line || <span className="italic text-white/40">{t('gal.line.empty')}</span>}
                                            {streaming && <span className="cursor-bar" />}
                                        </div>
                                    </div>
                                </>
                            )}
                            {canAdvance && (
                                <button
                                    className="mt-1 shrink-0 self-center rounded-full p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/90"
                                    title={t('gal.advance')}
                                    onClick={(e) => { e.stopPropagation(); eng.advance(); }}
                                >
                                    <Icon name="fastForward" size={15} />
                                </button>
                            )}
                        </div>
                        <StageErrorFloors />
                    </div>
                </>
            )}
        </div>
    );

    return (
        <>
            {scene('frame')}
            {immersive ? createPortal(scene('immersive'), document.body) : null}
        </>
    );
}

/* ——— 形态注册:全部套 StageFrame(规范稿四形态共享帧头+composer)——— */
const NovelStage = () => <StageFrame><NovelBody /></StageFrame>;
const MessengerStage = () => <StageFrame><MessengerBody /></StageFrame>;
const TheaterStage = () => <StageFrame><TheaterBody /></StageFrame>;

/* 域内词条 —— stagepack 专属键(壳词条归 shell feature;en 按约定回键名)。 */
const zh: Record<string, string> = {
    'novel.toc': '章节目录', 'novel.toc.empty': '无章节 —— 楼层成书后此处出现目录',
    'novel.floorsUnit': ' 楼', 'novel.prologue': '序章', 'novel.body': '正文',
    'novel.chapter.empty': '(本章暂无正文)', 'novel.empty': '还没有成书的楼层',
    'novel.empty.desc': '发送一条导演指令(如「续写下一章」)即开始;楼层按分章标记或等长分段归入左侧目录',
    'novel.strategy.markers': '分章标记', 'novel.strategy.chapters': '章',
    'novel.strategy.segmented': '自动分段', 'novel.strategy.perChapter': '楼/章',
    'novel.strategy.single': '单章兜底 · 无分章标记', 'novel.strategy.seed': '预演种子 · 非本会话楼层',
    'novel.strategy.empty': '暂无章节',
    'gal.seed': '预演', 'gal.you': '你', 'gal.line.empty': '……尚无台词',
    'gal.choices.empty': '暂无分支选项 —— 用下方台词推进',
    'gal.choice.blank': '(空分支)', 'gal.choice.regen': '再生成一支',
    'gal.immersive.enter': '沉浸接管', 'gal.immersive.exit': '退出沉浸',
    'gal.narrator': '旁 白', 'gal.bag.open': '打开背包面板',
    'gal.fs.enter': '真全屏', 'gal.fs.exit': '退出全屏',
    'gal.rotate.hint': '旋转设备体验更佳', 'gal.advance': '推进',
};
const en: Record<string, string> = {
    ...Object.fromEntries(Object.keys(zh).map((k) => [k, k])),
    'novel.toc': 'Chapter index', 'novel.toc.empty': 'No chapters — the index appears once floors form the book',
    'novel.floorsUnit': ' floors', 'novel.prologue': 'Prologue', 'novel.body': 'Main text',
    'novel.chapter.empty': '(no text in this chapter yet)', 'novel.empty': 'No book-bound floors yet',
    'novel.empty.desc': 'Send a director instruction (e.g. "write the next chapter") to begin; floors are filed into the left index by chapter markers or even-length segments',
    'novel.strategy.markers': 'Chapter markers', 'novel.strategy.chapters': 'chapters',
    'novel.strategy.segmented': 'Auto-segmented', 'novel.strategy.perChapter': 'fl/ch',
    'novel.strategy.single': 'Single chapter · no markers', 'novel.strategy.seed': 'Preview seed · not session floors',
    'novel.strategy.empty': 'No chapters yet',
    'gal.seed': 'Preview', 'gal.you': 'you', 'gal.line.empty': '…no lines yet',
    'gal.choices.empty': 'No branch choices — advance with the line box below',
    'gal.choice.blank': '(empty branch)', 'gal.choice.regen': 'Generate another',
    'gal.immersive.enter': 'Go immersive', 'gal.immersive.exit': 'Exit immersive',
    'gal.narrator': 'NARRATOR', 'gal.bag.open': 'Open bag panel',
    'gal.fs.enter': 'Fullscreen', 'gal.fs.exit': 'Exit fullscreen',
    'gal.rotate.hint': 'Rotate device for a better experience', 'gal.advance': 'Advance',
};

export const stagepackFeature: Feature = {
    name: 'stagepack',
    apply(ctx) {
        ctx.locale('stagepack', { 'zh-CN': zh, en });
        ctx.add('stage.form', { kind: 'novel', order: 10, Component: NovelStage });
        ctx.add('stage.form', { kind: 'messenger', order: 10, Component: MessengerStage });
        ctx.add('stage.form', { kind: 'theater', order: 10, Component: TheaterStage });
    },
};
