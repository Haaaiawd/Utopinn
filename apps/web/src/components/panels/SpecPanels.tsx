// 规范稿板块体:PANEL_CATALOG 七块 —— 预设/模型、MVU 变量、手记、总簿
// (CardApp 宿主,lodger/CardAppFrame 接线不动)、世界书、章节、频道。
// 每块无 props,数据一律 useShell();目录数据 SPEC-DATA 标注待接。
import { useState } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { CardAppFrame } from '../../cardapp/CardAppFrame';

const lbl = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]';
const group = 'inset-group mb-3';
const row = 'inset-row text-[12px]';

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button className="sh-switch" data-checked={on || undefined} onClick={onToggle}>
            <span className="sh-switch-thumb" />
        </button>
    );
}

/** 规范稿「预设 / 模型」板块 —— preset panel(下拉 + 四参数 + 提示词条目开关)。 */
export function PresetPanel() {
    const { t } = useI18n();
    const s = useShell();
    const p = s.presetParams;
    const preset = s.presets.find((x) => x.id === s.activePresetId);
    const model = s.models.find((m) => m.id === s.activeModel);
    return (
        <div className="p-3">
            <span className={lbl}>{t('panel.preset.preset')}</span>
            <div className="relative mb-3">
                <button className="sh-select-trigger" onClick={() => s.setOpenDropdown(s.openDropdown === 'preset' ? null : 'preset')}>
                    <span className="truncate font-mono-ui text-[11px]">{preset?.id ?? '—'}</span>
                    <Icon name="chevronDown" size={12} className="text-[color:var(--fg-faint)]" />
                </button>
                {s.openDropdown === 'preset' && (
                    <div className="sh-select-menu pop-in">
                        {s.presets.map((x) => (
                            <button key={x.id} className="inset-row-btn flex w-full items-center justify-between rounded-md px-2.5 py-[7px] text-[11.5px]" onClick={() => { s.pickPreset(x.id); s.setOpenDropdown(null); }}>
                                <span className="truncate font-mono-ui text-[11px]">{x.id}</span>
                                {x.id === s.activePresetId && <Icon name="check" size={12} className="text-[color:var(--brand)]" />}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <span className={lbl}>{t('panel.preset.model')}</span>
            <div className="relative mb-3">
                <button className="sh-select-trigger" onClick={() => s.setOpenDropdown(s.openDropdown === 'model' ? null : 'model')}>
                    <span className="min-w-0 truncate text-left">
                        <span className="font-mono-ui text-[11px]">{model?.short ?? '—'}</span>
                        <span className="ml-1.5 text-[10px] text-[color:var(--fg-faint)]">{model?.provider} · {model?.ctx}</span>
                    </span>
                    <Icon name="chevronDown" size={12} className="text-[color:var(--fg-faint)]" />
                </button>
                {s.openDropdown === 'model' && (
                    <div className="sh-select-menu pop-in">
                        {s.models.map((m) => (
                            <button key={m.id} className="inset-row-btn flex w-full items-center justify-between rounded-md px-2.5 py-[7px] text-[11.5px]" onClick={() => { s.setActiveModel(m.id); s.setOpenDropdown(null); }}>
                                <span className="min-w-0 truncate"><span className="font-mono-ui text-[11px]">{m.short}</span> <span className="text-[10px] text-[color:var(--fg-faint)]">{m.provider}</span></span>
                                {m.id === s.activeModel && <Icon name="check" size={12} className="text-[color:var(--brand)]" />}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className={group}>
                {([
                    ['temp', t('param.temp'), 0, 2, 0.01],
                    ['topP', t('param.topP'), 0, 1, 0.01],
                    ['ctxLen', t('param.ctxLen'), 4096, 200000, 1024],
                    ['maxReply', t('param.maxReply'), 256, 8192, 256],
                ] as const).map(([k, name, min, max, step]) => (
                    <div key={k} className={row}>
                        <span className="text-[color:var(--fg-secondary)]">{name}</span>
                        <span className="flex items-center gap-2">
                            <input
                                type="range" min={min} max={max} step={step} value={p[k]}
                                onChange={(e) => s.setPresetParam(k, Number(e.target.value))}
                                className="w-[92px]"
                            />
                            <span className="w-12 text-right font-mono-ui text-[10.5px] text-[color:var(--fg-primary)]">
                                {k === 'ctxLen' || k === 'maxReply' ? p[k] : p[k].toFixed(2)}
                            </span>
                        </span>
                    </div>
                ))}
            </div>
            <span className={lbl}>{t('panel.preset.blocks')}</span>
            <div className={group}>
                {p.blocks.map((b) => (
                    <div key={b.id} className={row}>
                        <span className="min-w-0 truncate text-[color:var(--fg-secondary)]">{b.name}</span>
                        <Switch on={b.enabled} onToggle={() => s.togglePresetBlock(b.id)} />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** 规范稿 MVU 变量面板 —— 数值行 ± 步进 + echo pulse + bridgeOp 三动作 + JSON 视图。 */
export function MvuPanel() {
    const { t } = useI18n();
    const s = useShell();
    const [jsonView, setJsonView] = useState(false);
    return (
        <div className="p-3">
            <div className="mb-2 flex items-center justify-between">
                <span className={lbl} style={{ marginBottom: 0 }}>{t('panel.mvu.vars')}</span>
                <button className="ghost-btn h-6 px-2 text-[10px]" onClick={() => setJsonView(!jsonView)}>
                    {jsonView ? t('panel.mvu.table') : 'JSON'}
                </button>
            </div>
            {jsonView ? (
                <pre className="inset-group mb-3 overflow-x-auto p-3 font-mono-ui text-[10.5px] leading-relaxed text-[color:var(--fg-secondary)]">
                    {JSON.stringify(s.mvu, null, 2)}
                </pre>
            ) : (
                <div className={`${group}${s.echoMvu ? ' echo-pulse' : ''}`}>
                    {Object.entries(s.mvu).map(([k, v]) => (
                        <div key={k} className={row}>
                            <span className="text-[color:var(--fg-secondary)]">{k}</span>
                            <span className="flex items-center gap-1.5">
                                {typeof v === 'number' && (
                                    <button className="ghost-btn h-5 w-5 text-[10px]" onClick={() => s.mvuStep(k, -1)}><Icon name="minus" size={9} /></button>
                                )}
                                <span className="min-w-10 text-right font-mono-ui text-[11px] text-[color:var(--fg-primary)]">{typeof v === 'number' && !Number.isInteger(v) ? `${v}%` : v}</span>
                                {typeof v === 'number' && (
                                    <button className="ghost-btn h-5 w-5 text-[10px]" onClick={() => s.mvuStep(k, 1)}><Icon name="plus" size={9} /></button>
                                )}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <span className={lbl}>{t('panel.mvu.bridge')}</span>
            <div className={group}>
                {([
                    ['repair', 'bridge.repair'],
                    ['stipend', 'bridge.stipend'],
                    ['levy', 'bridge.levy'],
                ] as const).map(([op, k]) => (
                    <button key={op} className={`${row} inset-row-btn`} onClick={() => s.bridgeOp(op)}>
                        <span className="text-[color:var(--fg-secondary)]">{t(k)}</span>
                        <Icon name="arrowRight" size={12} className="text-[color:var(--fg-faint)]" />
                    </button>
                ))}
            </div>
            <p className="px-1 text-[10px] leading-relaxed text-[color:var(--fg-faint)]">{t('panel.mvu.note')}</p>
        </div>
    );
}

/** 规范稿手记板块 —— 纯 textarea,字留本地态(SPEC-DATA: 无持久端点)。 */
export function NotesPanel() {
    const s = useShell();
    return (
        <div className="flex h-full flex-col p-3">
            <textarea
                value={s.notesText}
                onChange={(e) => s.setNotesText(e.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-[10px] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-3 font-mono-ui text-[11.5px] leading-relaxed text-[color:var(--fg-secondary)] outline-none focus:border-[color:var(--border-strong)]"
            />
        </div>
    );
}

/** 总簿板块 —— 规范稿「云栖宗总簿」账簿 UI(三块统计 + 修缮进度 +
 *  三笔操作)。数据即 MVU 快照;CardApp 真宿主在 'cardapp' 板块。 */
export function LedgerPanel() {
    const { t } = useI18n();
    const s = useShell();
    const durability = Number(s.mvu['大殿耐久'] ?? 0);
    return (
        <div className="p-3.5">
            <div className="mb-3 flex items-baseline justify-between">
                <span className="heading-tight text-[13px] text-[color:var(--fg-primary)]">{t('ledger.title')}</span>
                <span className="font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{s.mvu['时辰']}</span>
            </div>
            <div className={`mb-3 grid grid-cols-3 gap-2${s.echoMvu ? ' echo-pulse' : ''}`}>
                {(['灵石', '宗门声望', '大殿耐久'] as const).map((k) => (
                    <div key={k} className="inset-group px-2.5 py-2">
                        <div className="text-[9px] text-[color:var(--fg-faint)]">{t(`ledger.${k}`)}</div>
                        <div className="mt-0.5 font-mono-ui text-[16px] font-medium text-[color:var(--fg-primary)]">
                            {s.mvu[k]}{k === '大殿耐久' ? '%' : ''}
                        </div>
                    </div>
                ))}
            </div>
            <div className="inset-group mb-3 p-3">
                <div className="mb-1.5 flex items-baseline justify-between">
                    <span className="text-[10.5px] text-[color:var(--fg-secondary)]">{t('ledger.repair')}</span>
                    <span className="font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{durability}/100</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--bg-active)]">
                    <div className="h-full rounded-full" style={{ width: `${durability}%`, background: 'var(--brand)', transition: 'width 0.3s ease' }} />
                </div>
            </div>
            <div className="inset-group">
                {([
                    ['repair', 'ledger.op.repair', 'ledger.op.repair.cost'],
                    ['stipend', 'ledger.op.stipend', 'ledger.op.stipend.cost'],
                    ['levy', 'ledger.op.levy', 'ledger.op.levy.cost'],
                ] as const).map(([op, k, ck]) => (
                    <button key={op} className="inset-row inset-row-btn" onClick={() => s.bridgeOp(op)}>
                        <span className="text-[12px] text-[color:var(--fg-secondary)]">{t(k)}</span>
                        <span className="font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{t(ck)}</span>
                    </button>
                ))}
            </div>
            <p className="mt-3 px-1 text-[9.5px] leading-relaxed text-[color:var(--fg-faint)]">{t('panel.mvu.note')}</p>
        </div>
    );
}

/** CardApp 宿主板块 —— lorder/ctx 桥接原样;离线时 CardAppFrame 自己给诚实错误态。 */
export function CardAppPanel() {
    const s = useShell();
    return (
        <div className="h-full min-h-[320px]">
            <CardAppFrame charDir={s.chat?.charDir ?? 'default_Seraphina'} chatName={s.chat?.chatName ?? 'demo-chat'} />
        </div>
    );
}

/** 世界书板块 —— 作品世界书条目(开关 + 优先级 + tokens),联动 studio 双栏同一份 state。 */
export function LorePanel() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="p-3">
            <span className={lbl}>{t('panel.lore.entries')}</span>
            <div className={group}>
                {s.worldbook.map((w) => (
                    <button key={w.id} className={`${row} inset-row-btn`} onClick={() => s.setSelectedLoreId(w.id)}>
                        <span className="min-w-0">
                            <span className="block truncate text-[color:var(--fg-primary)]">{w.title}</span>
                            <span className="mt-0.5 block text-[10px] text-[color:var(--fg-faint)]">
                                {w.type} · P{w.priority} · {w.tokens} tok
                            </span>
                        </span>
                        <Switch on={w.enabled} onToggle={() => {}} />
                    </button>
                ))}
            </div>
            <span className={lbl}>{t('panel.lore.global')}</span>
            <div className={group}>
                {s.globalLore.map((g) => (
                    <div key={g.id} className={row}>
                        <span className="min-w-0">
                            <span className="block truncate text-[color:var(--fg-primary)]">{g.name}</span>
                            <span className="mt-0.5 block font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{g.file} · {g.tokens} tok</span>
                        </span>
                        <Switch on={g.enabled} onToggle={() => s.toggleGlobalLore(g.id)} />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** 章节板块 —— novel 形态目录,点选章节跳 selParaId 首段。 */
export function ChaptersPanel() {
    const { t } = useI18n();
    const s = useShell();
    const chs = s.stageData.chapters;
    return (
        <div className="p-3">
            <div className={group}>
                {chs.map((c, i) => {
                    const active = s.chat?.stage === 'novel';
                    return (
                        <button
                            key={c.id}
                            className={`${row} inset-row-btn`}
                            onClick={() => s.patchStageData({ selParaId: c.paras[0]?.id ?? null })}
                        >
                            <span className="min-w-0">
                                <span className="block truncate text-[color:var(--fg-primary)]">{c.num} · {c.title}</span>
                                <span className="mt-0.5 block text-[10px] text-[color:var(--fg-faint)]">{c.paras.length} {t('panel.chapters.paras')}</span>
                            </span>
                            {i === chs.length - 1 && active && (
                                <span className="rounded-full px-1.5 py-px text-[9px]" style={{ background: 'var(--bg-active)', color: 'var(--brand)' }}>{t('panel.chapters.current')}</span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** 频道板块 —— messenger 形态频道列表,与舞台共享 activeChannel。 */
export function ChannelsPanel() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="p-3">
            <div className={group}>
                {s.stageData.channels.map((c) => (
                    <button
                        key={c.id}
                        className={`${row} inset-row-btn`}
                        style={s.stageData.activeChannel === c.id ? { background: 'var(--bg-active)' } : undefined}
                        onClick={() => s.patchStageData({ activeChannel: c.id })}
                    >
                        <span className="min-w-0">
                            <span className="block truncate text-[color:var(--fg-primary)]">{c.name}</span>
                            {c.notice && <span className="mt-0.5 block truncate text-[10px] text-[color:var(--fg-faint)]">{c.notice}</span>}
                        </span>
                        {c.unread > 0 && (
                            <span className="rounded-full px-1.5 py-px text-[9.5px] font-medium" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}>{c.unread}</span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}
