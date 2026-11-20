// feature:stagepack — 舞台形态注册(novel/messenger/galgame 三种形态)。
// 形态体与聊天形态共享 StageFrame(stage-header/弹层/QR/composer/生成引擎),
// 本文件只管形态内容;数据双轨:
//   · 楼层轨 —— useStageEngine().msgs,真实数据(加载逻辑见 StageFrame);
//   · 预演轨 —— stageData 种子,st-* 会话服务端不存(404 → 楼层空)时兜底,
//     侧栏/场景签如实标注「预演」,不装作真数据。
// galgame 另有「沉浸接管」壳层:激活即 portal 全幅覆盖(chrome 让位不卸载,
// 退出即回)+ 真 Fullscreen/移动横屏锁(失败静默回落),详见 GalgameBody。
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../kernel/context';
import { useI18n } from '../i18n';
import { charImageUrl } from '../api/characters';
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
                                    <h2 className="font-serif-ui heading-tight mt-1 text-xl font-semibold text-[color:var(--fg-primary)]">{c.title}</h2>
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
                                                            className="rounded-lg px-2.5 py-1 font-medium"
                                                            style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                                            onClick={(e) => { e.stopPropagation(); s.hint(t('novel.polish.stub')); }}
                                                        >
                                                            {t('novel.polish')}
                                                        </button>
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
   galgame —— 三件套:对话框(末楼 speaker)/ 立绘位 / 选项区
   ========================================================================= */

interface VnOption {
    key: string;
    /** 分支类(swipe)选项带版号徽标;结构化选项纯文本。 */
    badge?: string;
    text: string;
    onPick: () => void;
}

/** 未来协议钩位:generate 响应 choices 字段落进楼层 extra 后此处自动生效
 *  (服务端面 = TASK-044 galgame choices;形状 {text}[] 宽松解析)。 */
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

/** galgame 形态 —— 壳层沉浸接管 + 内容层三件套。
 *
 *  壳层(本格新增):激活 galgame 即 portal「fixed inset-0 z-78」全幅覆盖 ——
 *  rail/工作台/浮窗被压在下面(让位但不卸载,状态保留,退出即回);
 *  toast/弹窗/cmdk(z≥80)仍在上层,保留系统级逃生口。Chrome/shell 零改动。
 *  · 顶排:场景签 | 赏景(hideHud)+ 真全屏 ⛶ + 退出沉浸 ✕。
 *  · 真 Fullscreen = documentElement.requestFullscreen;fullscreenchange
 *    同步钮态,退出时顺手解横屏锁;无手势/旧内核拒绝 → 静默回落
 *    (覆盖层本身已是全幅接管,视觉无差)。
 *  · 移动横屏:fullscreen 成功后尝试 orientation.lock('landscape');
 *    失败/未锁 → 竖屏下露「旋转设备」提示层(可关)。
 *  · 布局 landscape 优先一套:底锚通栏对话条 + 左右立绘位,竖屏同结构缩小。
 *
 *  内容层(三件套,楼层轨优先 —— 零楼层回落 vn 预演种子,场景签带「预演」徽标):
 *    对话框 = 末楼 speaker/正文(流式带光标,末楼 speaker 名签提亮)+ 推进钩位;
 *    立绘层 = 左位主卡立绘(玩家楼时压暗)｜右位当前人设头像(仅玩家台词楼登场);
 *             无图 → 空槽/空位,不伪造立绘;
 *    选项区 = 末楼 extra.choices 钩位 → swipe 分支(点击直跳版) → 空态;
 *    背景层 = 末楼 extra.scene.bg 钩位 → 规范稿 vnBg 资产 → 挂图/无图落深空渐变。 */
function GalgameBody() {
    const { t } = useI18n();
    const s = useShell();
    const eng = useStageEngine();
    const vn = s.stageData.vn;
    const floors = eng.msgs.filter(bookable);
    const last = [...floors].reverse().find((m) => m.content.trim() || m.streaming) ?? null;
    const fromFloors = floors.length > 0;
    const card = s.chat ? s.cards.get(s.chat.charDir) : undefined;
    const sprite = card?.avatar ? charImageUrl(card.avatar) : null;
    const ops = last ? eng.opsOf(last, eng.msgs.indexOf(last)) : null;

    /* 对话框:末楼 speaker 名签 + 正文;user 楼按线名照显(它是玩家台词)。 */
    const speaker = fromFloors ? (last?.name || card?.name || '—') : vn.speaker;
    const line = fromFloors ? (last ? (last.displayContent ?? last.content) : '') : vn.line;
    const streaming = !!last?.streaming;

    /* 场景底图源:楼层 extra.scene.bg 钩位(未来场景 sidecar 落点)→ 规范稿
       vnBg(云栖宗正殿内景,已抽为静态资产);挂图/无图 → 深空渐变兜底。 */
    const sceneBg = (() => {
        const sc = last?.extra?.scene;
        const bg = sc && typeof sc === 'object' ? (sc as Record<string, unknown>).bg : null;
        return typeof bg === 'string' && bg ? bg : '/assets/backgrounds/stage-hall.jpg';
    })();
    const [bgBad, setBgBad] = useState(false);
    /* 右位立绘 = 当前人设头像(ST User Avatars 实数据);仅玩家台词楼登场,
       无人设/挂图 → 空位。 */
    const userSprite = last?.role === 'user' && s.persona?.avatar
        ? `/User%20Avatars/${encodeURIComponent(s.persona.avatar)}` : null;
    const [userSpriteBad, setUserSpriteBad] = useState(false);

    /* ——— 沉浸壳状态 ——— */
    const [immersive, setImmersive] = useState(true);
    const [fsOn, setFsOn] = useState(false);
    const [portrait, setPortrait] = useState(false);
    const [rotateHint, setRotateHint] = useState(true);

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

    /* 场景/右位立绘源随楼层变化 → 挂图标记复位重试。 */
    useEffect(() => { setBgBad(false); }, [sceneBg]);
    useEffect(() => { setUserSpriteBad(false); }, [userSprite]);

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

    /* 进入即尝试全屏+横屏锁(任务书口径);无用户手势浏览器拒绝 → 静默,
       移动竖屏由提示层接管。 */
    useEffect(() => { if (s.isMobile) enterFs(); /* mount-only */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const pillStyle = { background: 'rgba(18,18,20,0.58)', border: '1px solid rgba(255,255,255,0.12)' } as const;

    const scene = (mode: 'frame' | 'immersive') => (
        <div
            className={mode === 'immersive'
                ? 'fixed inset-0 z-[78] flex flex-col justify-between overflow-hidden bg-black'
                : 'relative flex min-h-0 flex-1 flex-col justify-between overflow-hidden'}
        >
            {/* 背景层:深空渐变托底;场景图 cover 铺满,挂图/无图 → 只剩渐变 */}
            <div className="absolute inset-0" style={{ background: 'radial-gradient(130% 95% at 50% 16%, #21263f 0%, #12141f 55%, #07080d 100%)' }} />
            {!bgBad && <img src={sceneBg} alt="Scene" className="absolute inset-0 h-full w-full object-cover" onError={() => setBgBad(true)} />}
            {/* 立绘层左右位:左 = 主卡 cast(玩家楼压暗);右 = 玩家人设(仅其台词楼登场) */}
            <div
                className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] flex items-end justify-between px-[3%]"
                style={{ height: mode === 'immersive' ? '72%' : '62%' }}
            >
                <div className="flex h-full w-[46%] items-end justify-center transition-opacity duration-300" style={{ opacity: last?.role === 'user' ? 0.5 : 1 }}>
                    {sprite ? (
                        <img
                            src={sprite} alt={card?.name ?? ''} className="h-full object-contain"
                            style={{ maskImage: 'linear-gradient(to bottom, black 84%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 84%, transparent 100%)' }}
                            onError={charImgFallback}
                        />
                    ) : (
                        <div
                            className={`${mode === 'immersive' ? 'mb-32' : 'mb-24'} flex flex-col items-center gap-1.5 rounded-2xl border border-dashed px-5 py-3 text-white/45 backdrop-blur-sm`}
                            style={{ borderColor: 'rgba(255,255,255,0.22)' }}
                        >
                            <Icon name="image" size={18} />
                            <span className="text-[11px]">{t('gal.sprite.empty')}</span>
                        </div>
                    )}
                </div>
                <div className="flex h-full w-[46%] items-end justify-center">
                    {userSprite && !userSpriteBad && (
                        <img
                            src={userSprite} alt={s.persona?.name ?? ''} className="h-full object-contain"
                            style={{ maskImage: 'linear-gradient(to bottom, black 84%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 84%, transparent 100%)' }}
                            onError={() => setUserSpriteBad(true)}
                        />
                    )}
                </div>
            </div>
            {/* 三段渐变压暗 */}
            <div className="absolute inset-0 z-[6]" style={{ background: 'linear-gradient(180deg, rgba(14,14,16,0.48) 0%, rgba(14,14,16,0.08) 48%, rgba(14,14,16,0.92) 100%)' }} />
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
                <div className={mode === 'immersive' ? 'relative z-10 space-y-3 px-4 pb-4 sm:px-8 sm:pb-6' : 'relative z-10 mx-auto w-full max-w-[640px] space-y-3 p-4 sm:p-6'}>
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
                    {/* 对话条:底锚半透明通栏;speaker+正文+推进钩位(点条 = ▸) */}
                    <div
                        className={`flex select-text items-start gap-3.5 rounded-2xl p-4 text-white backdrop-blur-xl sm:p-5 ${canAdvance ? 'cursor-pointer' : ''}`}
                        style={{ background: 'rgba(16,16,19,0.84)', border: '1px solid rgba(255,255,255,0.12)' }}
                        onClick={() => { if (canAdvance) eng.advance(); }}
                    >
                        <span className="mt-0.5"><StageRing size={44} /></span>
                        <div className="min-w-0 flex-1 space-y-1">
                            {/* 末楼 speaker 名签提亮;user 楼带「你」侧标 */}
                            <div className="text-[12px] font-semibold text-white/90">
                                {speaker}
                                {last?.role === 'user' && <span className="ml-1.5 font-normal text-white/40">· {t('gal.you')}</span>}
                            </div>
                            <div className="whitespace-pre-line text-[14.5px] leading-relaxed text-white/95">
                                {line || <span className="italic text-white/40">{t('gal.line.empty')}</span>}
                                {streaming && <span className="cursor-bar" />}
                            </div>
                        </div>
                        {canAdvance && (
                            <button
                                className="mt-1 shrink-0 rounded-full p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/90"
                                title={t('gal.advance')}
                                onClick={(e) => { e.stopPropagation(); eng.advance(); }}
                            >
                                <Icon name="fastForward" size={15} />
                            </button>
                        )}
                    </div>
                    <StageErrorFloors />
                </div>
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
const GalgameStage = () => <StageFrame><GalgameBody /></StageFrame>;

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
    'gal.sprite.empty': '无立绘资产',
    'gal.choices.empty': '暂无分支选项 —— 用下方台词推进',
    'gal.choice.blank': '(空分支)', 'gal.choice.regen': '再生成一支',
    'gal.immersive.enter': '沉浸接管', 'gal.immersive.exit': '退出沉浸',
    'gal.fs.enter': '真全屏', 'gal.fs.exit': '退出全屏',
    'gal.rotate.hint': '旋转设备体验更佳', 'gal.advance': '推进',
};
const en: Record<string, string> = Object.fromEntries(Object.keys(zh).map((k) => [k, k]));

export const stagepackFeature: Feature = {
    name: 'stagepack',
    apply(ctx) {
        ctx.locale('stagepack', { 'zh-CN': zh, en });
        ctx.add('stage.form', { kind: 'novel', order: 10, Component: NovelStage });
        ctx.add('stage.form', { kind: 'messenger', order: 10, Component: MessengerStage });
        ctx.add('stage.form', { kind: 'galgame', order: 10, Component: GalgameStage });
    },
};
