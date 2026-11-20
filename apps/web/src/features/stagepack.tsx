// feature:stagepack — 舞台形态注册(novel/messenger/galgame 三种形态)。
// 形态体与聊天形态共享 StageFrame(stage-header/弹层/QR/composer/生成引擎),
// 本文件只管形态内容;数据走 stageData(mock 种子)+ 帧内统一 send 流。
import { useShell } from '../kernel/context';
import { useI18n } from '../i18n';
import { charImageUrl } from '../api/characters';
import { StageFrame } from '../components/stage/StageFrame';
import type { Feature } from '../kernel/kernel';

/** 卡头像环(形态内复用:会话卡图,无卡 → default-char 占位)。 */
function StageRing({ size }: { size: number }) {
    const s = useShell();
    const card = s.chat ? s.cards.get(s.chat.charDir) : undefined;
    const src = card?.avatar ? charImageUrl(card.avatar) : '/assets/avatars/default-char.png';
    return (
        <span className="char-avatar-ring shrink-0" style={{ width: size, height: size }}>
            <img src={src} alt="" className="h-full w-full object-cover" />
        </span>
    );
}

/** novel 形态(规范稿:px-5 sm:px-10 py-6 + scroll-fade-mask / 640px 栏 /
 *  章头左对齐 mono num + serif 题 / novel-p 点选出「润色此段」行)。 */
function NovelBody() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="scroll-fade-mask min-h-0 flex-1 select-text overflow-y-auto px-5 py-6 sm:px-10">
            <div className="mx-auto max-w-[640px] space-y-8 pb-8">
                {s.stageData.chapters.map((c) => (
                    <section key={c.id} className="space-y-3">
                        <div className="pt-2">
                            <div className="font-mono-ui text-[11px] tracking-widest text-[color:var(--fg-muted)]">{c.num}</div>
                            <h2 className="font-serif-ui heading-tight mt-1 text-xl font-semibold text-[color:var(--fg-primary)]">{c.title}</h2>
                        </div>
                        <div className="space-y-1.5">
                            {c.paras.map((p) => {
                                const sel = s.stageData.selParaId === p.id;
                                return (
                                    <div
                                        key={p.id}
                                        className="novel-p"
                                        data-sel={sel || undefined}
                                        onClick={() => s.patchStageData({ selParaId: sel ? null : p.id })}
                                    >
                                        {p.text}
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

/** galgame 形态(规范稿:stage-galgame 全屏底图 + 三段渐变 + 场景/赏景 pill
 *  + 84% 选项列 + backdrop-blur 对话卡[w-11 头像环])。 */
function GalgameBody() {
    const { t } = useI18n();
    const s = useShell();
    const vn = s.stageData.vn;
    return (
        <div className="relative flex min-h-0 flex-1 flex-col justify-between overflow-hidden">
            {/* 规范稿 vnBg = hallBg(云栖宗正殿内景,spec 内嵌图已抽为静态资产) */}
            <img src="/assets/backgrounds/stage-hall.jpg" alt="Scene" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(14,14,16,0.48) 0%, rgba(14,14,16,0.08) 48%, rgba(14,14,16,0.92) 100%)' }} />
            <div className="relative z-10 flex items-center justify-between p-3.5">
                <span className="rounded-full px-3 py-1 text-[11.5px] text-white/90 backdrop-blur-md" style={{ background: 'rgba(18,18,20,0.58)', border: '1px solid rgba(255,255,255,0.12)' }}>
                    {vn.scene}
                </span>
                <button
                    className="rounded-full px-3 py-1 text-[11.5px] text-white/85 backdrop-blur-md transition-colors hover:text-white"
                    style={{ background: 'rgba(18,18,20,0.58)', border: '1px solid rgba(255,255,255,0.12)' }}
                    onClick={() => s.patchStageData({ vn: { ...vn, hideHud: !vn.hideHud } })}
                >
                    {vn.hideHud ? t('vn.showDialog') : t('vn.hideHud')}
                </button>
            </div>
            {vn.hideHud ? <div className="flex-1" /> : (
                <div className="relative z-10 mx-auto w-full max-w-[640px] space-y-3 p-4 sm:p-6">
                    <div className="flex flex-col items-center gap-1.5">
                        {vn.choices.map((c, i) => (
                            <button
                                key={i}
                                className="w-full rounded-xl px-4 py-2.5 text-left text-[13px] text-white/95 backdrop-blur-md transition-colors hover:bg-white/15 sm:w-[84%]"
                                style={{ background: 'rgba(20,20,24,0.72)', border: '1px solid rgba(255,255,255,0.14)' }}
                                onClick={() => s.bridgeOp(c.op)}
                            >
                                {c.text}
                            </button>
                        ))}
                    </div>
                    <div
                        className="flex select-text items-start gap-3.5 rounded-2xl p-4 text-white backdrop-blur-xl sm:p-5"
                        style={{ background: 'rgba(16,16,19,0.84)', border: '1px solid rgba(255,255,255,0.12)' }}
                    >
                        <span className="mt-0.5"><StageRing size={44} /></span>
                        <div className="min-w-0 flex-1 space-y-1">
                            <div className="text-[12px] font-medium text-white/65">{vn.speaker}</div>
                            <div className="text-[14.5px] leading-relaxed text-white/95">{vn.line}</div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/* ——— 形态注册:全部套 StageFrame(规范稿四形态共享帧头+composer)——— */
const NovelStage = () => <StageFrame><NovelBody /></StageFrame>;
const MessengerStage = () => <StageFrame><MessengerBody /></StageFrame>;
const GalgameStage = () => <StageFrame><GalgameBody /></StageFrame>;

export const stagepackFeature: Feature = {
    name: 'stagepack',
    apply(ctx) {
        ctx.add('stage.form', { kind: 'novel', order: 10, Component: NovelStage });
        ctx.add('stage.form', { kind: 'messenger', order: 10, Component: MessengerStage });
        ctx.add('stage.form', { kind: 'galgame', order: 10, Component: GalgameStage });
    },
};
