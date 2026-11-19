// feature:stagepack — 舞台形态注册(novel/messenger/galgame 三种形态)。
// 形态体与聊天形态共享 stage header/composer 骨架;数据走 stageData(mock 种子)。
import { useShell } from '../kernel/context';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import type { Feature } from '../kernel/kernel';

/** novel 形态:纯书排版 + 段落点选(规范稿 novel-p + selPara)。 */
function NovelStage() {
    const s = useShell();
    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-[560px]">
                {s.stageData.chapters.map((c) => (
                    <div key={c.id} className="mb-7">
                        <div className="mb-3 text-center">
                            <div className="font-mono-ui text-[10px] tracking-[0.3em] text-[color:var(--fg-faint)]">{c.num}</div>
                            <div className="font-serif-ui mt-1 text-[16px] font-medium text-[color:var(--fg-primary)]">{c.title}</div>
                        </div>
                        {c.paras.map((p) => (
                            <p
                                key={p.id}
                                className="novel-p"
                                data-sel={s.stageData.selParaId === p.id || undefined}
                                onClick={() => s.patchStageData({ selParaId: s.stageData.selParaId === p.id ? null : p.id })}
                            >
                                {p.text}
                            </p>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

/** messenger 形态:频道顶条 + 成员侧条 + 消息流(规范稿 im 布局)。 */
function MessengerStage() {
    const s = useShell();
    const ch = s.stageData.channels.find((c) => c.id === s.stageData.activeChannel) ?? s.stageData.channels[0]!;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--border-hairline)] px-4">
                <span className="heading-tight text-[12.5px] text-[color:var(--fg-primary)]">{ch.name}</span>
                <span className="truncate text-[10px] text-[color:var(--fg-faint)]">{ch.notice}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mx-auto max-w-[520px]">
                    {ch.msgs.map((m, i) => (
                        <div key={i} className={`mb-3 flex ${m.self ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[78%] rounded-[12px] px-3 py-2 text-[12.5px] leading-relaxed ${m.self ? 'rounded-br-sm' : 'rounded-bl-sm'}`}
                                style={m.self ? { background: 'var(--brand)', color: 'var(--brand-fg)' } : { background: 'var(--bg-surface)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' }}>
                                {!m.self && <div className="mb-0.5 text-[10px] text-[color:var(--fg-muted)]">{m.sender} · {m.time}</div>}
                                {m.text}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** galgame 形态:全屏场景 + 底部对话框 + 选项浮层(规范稿 vn 布局)。 */
function GalgameStage() {
    const s = useShell();
    const vn = s.stageData.vn;
    return (
        <div className="relative min-h-0 flex-1 overflow-hidden">
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,#1a1c22 0%,#26201c 55%,#17140f 100%)' }} />
            <div className="absolute right-3 top-3 text-[10px] font-mono-ui text-[color:var(--fg-faint)]">{vn.scene}</div>
            {!vn.hideHud && (
                <div className="absolute inset-x-0 bottom-0 p-4" style={{ background: 'linear-gradient(180deg,transparent,rgba(0,0,0,0.72) 30%)' }}>
                    <div className="mx-auto max-w-[640px]">
                        {vn.choices.length > 0 && (
                            <div className="mb-3 flex flex-col items-center gap-1.5">
                                {vn.choices.map((c, i) => (
                                    <button key={i} className="pop-in rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-elevated)] px-4 py-1.5 text-[11.5px] text-[color:var(--fg-primary)]" onClick={() => s.bridgeOp(c.op)}>
                                        {c.text}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="inset-group p-3.5" style={{ background: 'color-mix(in srgb, var(--bg-elevated) 88%, transparent)' }}>
                            <div className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--brand)' }}>{vn.speaker}</div>
                            <div className="font-serif-ui text-[13px] leading-relaxed text-[color:var(--fg-primary)]">{vn.line}</div>
                        </div>
                        <button className="ghost-btn mx-auto mt-2 block h-6 px-2 text-[10px]" onClick={() => s.patchStageData({ vn: { ...vn, hideHud: true } })}>
                            <Icon name="eye" size={11} />
                        </button>
                    </div>
                </div>
            )}
            {vn.hideHud && (
                <button className="ghost-btn absolute bottom-3 right-3 h-7 w-7" onClick={() => s.patchStageData({ vn: { ...vn, hideHud: false } })}>
                    <Icon name="eyeClosed" size={13} />
                </button>
            )}
        </div>
    );
}

export const stagepackFeature: Feature = {
    name: 'stagepack',
    apply(ctx) {
        ctx.add('stage.form', { kind: 'novel', order: 10, Component: NovelStage });
        ctx.add('stage.form', { kind: 'messenger', order: 10, Component: MessengerStage });
        ctx.add('stage.form', { kind: 'galgame', order: 10, Component: GalgameStage });
    },
};
