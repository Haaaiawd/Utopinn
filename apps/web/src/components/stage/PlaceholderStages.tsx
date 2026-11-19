// 舞台形态占位:novel / messenger / galgame。
// SPEC-DATA: 待接 —— 形态会话内容没有服务端源;结构按规范稿 901–912 保留,
// 文案种子走 api/mock 的会话行,数据接通前一律落占位文本。
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon } from '../Icon';
import { MOCK_CHAPTERS, MOCK_CHANNELS } from '../../api/mock';

/** 舞台头通用壳:面包屑 + 形态标 + 未接提示。 */
function StageHead({ kind, title }: { kind: string; title: string }) {
    const { t } = useI18n();
    return (
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[color:var(--border-hairline)] px-4">
            <span className="flex items-center gap-1.5 text-[11px] text-[color:var(--fg-faint)]">
                <Icon name="book" size={12} />{t('tree.stages')}
            </span>
            <span className="text-[color:var(--fg-faint)]">/</span>
            <span className="heading-tight text-[13px] text-[color:var(--fg-primary)]">{title}</span>
            <span className="rounded-full bg-[color:var(--brand-soft)] px-1.5 py-0.5 text-[10px] text-[color:var(--brand)]">{t(`stage.kind.${kind}`)}</span>
            <span className="grow" />
            <span className="text-[10px] text-[color:var(--fg-faint)]">{t('stage.unwired')}</span>
        </div>
    );
}

export function NovelStage() {
    const { t } = useI18n();
    const { chat } = useShell();
    const ch = MOCK_CHAPTERS.find((c) => c.active) ?? MOCK_CHAPTERS[MOCK_CHAPTERS.length - 1]!;
    return (
        <>
            <StageHead kind="novel" title={chat?.title ?? '长夜卷一 · 烬城'} />
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-[var(--read-width)] px-8 py-10">
                    <p className="mb-1 text-center text-[11px] tracking-[0.3em] text-[color:var(--fg-faint)]">{t('novel.chapter').replace('{n}', String(ch.n))}</p>
                    <h2 className="heading-tight mb-8 text-center text-[20px]">{ch.title}</h2>
                    {/* SPEC-DATA: 待接 —— 章节正文无源,占位段落 */}
                    {['novel.p1', 'novel.p2', 'novel.p3'].map((k, i) => (
                        <p key={k} className="novel-p" data-sel={i === 1}>{t(k)}</p>
                    ))}
                    <p className="novel-p">{t('novel.caret')}<span className="cursor-bar" /></p>
                </div>
            </div>
        </>
    );
}

export function MessengerStage() {
    const { t } = useI18n();
    const { chat } = useShell();
    return (
        <>
            <StageHead kind="messenger" title={chat?.title ?? '灯塔值班群'} />
            <div className="flex min-h-0 flex-1">
                <div className="w-[172px] shrink-0 border-r border-[color:var(--border-hairline)] py-2">
                    {MOCK_CHANNELS.map((c) => (
                        <button key={c.id} type="button"
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${c.active ? 'bg-[color:var(--bg-active)] text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)]'}`}>
                            <span className="text-[color:var(--fg-faint)]">#</span>
                            <span className="flex-1 truncate">{c.name}</span>
                            {c.unread > 0 && <span className="rounded-full bg-[color:var(--brand)] px-1.5 text-[9px] text-white">{c.unread}</span>}
                        </button>
                    ))}
                </div>
                <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-[color:var(--fg-faint)]">
                    <Icon name="messages" size={26} />
                    <p className="text-[12px]">{t('stage.unwired')}</p>
                </div>
            </div>
        </>
    );
}

export function GalgameStage() {
    const { t } = useI18n();
    const { chat } = useShell();
    return (
        <>
            <StageHead kind="galgame" title={chat?.title ?? '风信子航线'} />
            <div className="relative flex min-h-0 flex-1 items-end justify-center overflow-hidden p-8">
                {/* SPEC-DATA: 待接 —— 立绘/背景无源,占位气氛渐变 */}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, var(--surface-1) 0%, var(--surface-3) 100%)' }} />
                <div className="relative w-full max-w-[640px] rounded-[14px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-canvas)]/85 p-5 backdrop-blur">
                    <div className="mb-1 text-[12px] font-medium text-[color:var(--brand)]">{t('gal.speaker')}</div>
                    <p className="text-[14px] leading-7 text-[color:var(--fg-primary)]">{t('gal.line')}</p>
                    <div className="mt-3 flex items-center justify-between text-[10px] text-[color:var(--fg-faint)]">
                        <span>{t('gal.save').replace('{n}', '2/8')}</span>
                        <span className="flex gap-3">{['gal.auto', 'gal.skip', 'gal.log'].map((k) => <span key={k} className="cursor-pointer hover:text-[color:var(--fg-secondary)]">{t(k)}</span>)}</span>
                    </div>
                </div>
            </div>
        </>
    );
}

