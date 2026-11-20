// 统计与命中板块(规范稿 stats:范围/分组选择器 + 汇总卡 + WI 条目命中表)。
// 数据全真面 /api/utopinn/stats/*:
//   summary(range × by) → 四汇总卡 + 分组行;
//   inject(chat)        → 注入源聚合 + worldinfo 条目级 hits(制卡调试杀手面 —
//                         哪条世界书从来没被触发过一眼见)。
// ctx 语义:chat=<charDir>/<chatName> 过滤到当前会话;未选会话 → 全域聚合
// (服务端 chat 参数缺省即全域,是真数据不是降级态,表头如实标注)。
import { useState } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import {
    statsInject, statsSummary, type InjectSourceStat, type StatsBy, type StatsRange, type WiHitEntry,
} from '../../api/stats';
import { PanelEmpty, PanelError, chatKey, useRemote } from './panelShared';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const RANGES: StatsRange[] = ['1h', '24h', '7d', 'all'];
const BYS: StatsBy[] = ['char', 'model', 'day'];

const fmtInt = (v: number | null | undefined): string => (num(v) != null ? Number(v).toLocaleString() : '—');
const fmtTok = (v: number | null | undefined): string => {
    const n = num(v);
    if (n == null) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    return n.toLocaleString();
};
const fmtMs = (v: number | null | undefined): string => {
    const n = num(v);
    if (n == null) return '—';
    return n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
};
const fmtPct = (v: number | null | undefined): string => (num(v) != null ? `${(Number(v) * 100).toFixed(1)}%` : '—');

/** WI 条目标题:key 数组首词/字符串优先,兜底 entry 复合键。 */
function entryTitle(e: WiHitEntry): string {
    const k = e.key;
    if (Array.isArray(k)) return String(k[0] ?? e.entry);
    if (typeof k === 'string' && k.trim()) return k;
    return e.entry;
}

/** 汇总卡(规范稿 2×2 格)。 */
function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
    return (
        <div
            className="rounded-[10px] p-3"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-card)' }}
        >
            <div className="text-[11px] text-[color:var(--fg-muted)]">{label}</div>
            <div className="heading-tight mt-1 font-mono-ui text-[19px] font-medium text-[color:var(--fg-primary)]">{value}</div>
            <div className="mt-0.5 font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">{sub}</div>
        </div>
    );
}

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
    return (
        <button
            className="shrink-0 rounded-md border px-2 py-0.5 font-mono-ui text-[10.5px]"
            style={{
                background: active ? 'var(--bg-active)' : 'transparent',
                color: active ? 'var(--fg-primary)' : 'var(--fg-muted)',
                borderColor: 'var(--border-hairline)',
            }}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

/** 注入源聚合行:source · 轮次 · 注入 · 命中率 · 均摊 token/ms。 */
function SourceRows({ sources }: { sources: InjectSourceStat[] }) {
    const { t } = useI18n();
    const rows = sources.filter((x) => x.events > 0);
    if (!rows.length) return null;
    return (
        <>
            <div className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">
                {t('stats.sources')}
            </div>
            <div className="inset-group">
                {rows.map((x) => (
                    <div key={x.source} className="inset-row text-[12px]">
                        <span className="min-w-0">
                            <span className="block truncate font-mono-ui text-[11.5px] text-[color:var(--fg-primary)]">{x.source}</span>
                            <span className="mt-0.5 block font-mono-ui text-[10px] text-[color:var(--fg-faint)]">
                                {x.events} {t('stats.src.events')} · {t('stats.src.hit')} {fmtPct(x.hitRate)}
                            </span>
                        </span>
                        <span className="shrink-0 text-right font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">
                            {fmtInt(x.injectedTotal)} inj · {x.tokensAvg != null ? `~${fmtInt(x.tokensAvg)}t` : '—'} · {x.msAvg != null ? `${fmtInt(x.msAvg)}ms` : '—'}
                        </span>
                    </div>
                ))}
            </div>
        </>
    );
}

/** WI 条目命中表(规范稿:0 命中条目 brand 高亮 —— 死条目一眼见)。 */
function WiHitTable({ entries }: { entries: WiHitEntry[] }) {
    const { t } = useI18n();
    const zero = entries.filter((e) => e.hits === 0).length;
    const max = Math.max(1, ...entries.map((e) => e.hits));
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-[color:var(--fg-secondary)]">{t('stats.wi.title')}</span>
                {zero > 0 ? (
                    <span className="font-mono-ui text-[10.5px] text-[color:var(--brand)]">
                        {zero} {t('stats.wi.zeroCount')}
                    </span>
                ) : null}
            </div>
            <div className="inset-group">
                {entries.map((e) => {
                    const dead = e.hits === 0;
                    return (
                        <div
                            key={e.entry}
                            className="space-y-1.5 border-t px-3.5 py-2.5 first:border-t-0"
                            style={{ borderColor: 'var(--border-hairline)' }}
                        >
                            <div className="flex items-center justify-between gap-2 text-[12px]">
                                <span
                                    className="truncate"
                                    style={{ color: dead ? 'var(--brand)' : 'var(--fg-primary)' }}
                                    title={e.entry}
                                >
                                    {entryTitle(e)}
                                </span>
                                <span
                                    className="shrink-0 font-mono-ui text-[11px]"
                                    style={{ color: dead ? 'var(--brand)' : 'var(--fg-muted)' }}
                                >
                                    {dead ? t('stats.wi.zero') : `${e.hits} ${t('stats.wi.hits')}`}
                                </span>
                            </div>
                            <div className="h-1 overflow-hidden rounded-full" style={{ background: 'var(--bg-active)' }}>
                                <div
                                    className="h-full rounded-full"
                                    style={{
                                        width: `${dead ? 0 : Math.max((e.hits / max) * 100, 6)}%`,
                                        background: dead ? 'var(--brand)' : 'var(--fg-secondary)',
                                    }}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export function StatsPanel() {
    const { t } = useI18n();
    const s = useShell();
    const [range, setRange] = useState<StatsRange>('7d');
    const [by, setBy] = useState<StatsBy>('char');

    const summary = useRemote(`stats:summary:${range}:${by}`, () => statsSummary({ range, by }));
    // ctx=会话时过滤到本会话;无 ctx → 全域聚合(chat 参数缺省)。
    const chatParam = chatKey(s.chat);
    const inject = useRemote(`stats:inject:${chatParam ?? '*'}`, () => statsInject(chatParam ?? undefined));

    if (summary.error && !summary.data) return <PanelError error={summary.error} onRetry={summary.reload} />;
    const tot = summary.data?.totals;
    const groups = summary.data?.groups ?? [];
    const wiEntries: WiHitEntry[] = inject.data?.sources.find((x) => x.source === 'worldinfo')?.entries ?? [];

    return (
        <div className="space-y-5 p-4">
            <div className="flex items-baseline justify-between gap-2">
                <div className="heading-tight text-[15px] font-medium text-[color:var(--fg-primary)]">{t('stats.title')}</div>
                <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                    {RANGES.map((r) => (
                        <Chip key={r} active={range === r} label={t(`stats.range.${r}`)} onClick={() => setRange(r)} />
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
                <StatCard
                    label={t('stats.card.gen')}
                    value={fmtInt(tot?.generations)}
                    sub={`${fmtInt(tot?.completed)} ${t('stats.card.done')}`}
                />
                <StatCard
                    label={t('stats.card.fail')}
                    value={tot ? fmtPct(tot.failRate) : '—'}
                    sub={`${fmtInt(tot?.failed)} ${t('stats.card.failedN')}`}
                />
                <StatCard
                    label={t('stats.card.tokens')}
                    value={tot ? fmtTok((tot.tokensIn ?? 0) + (tot.tokensOut ?? 0)) : '—'}
                    sub={`${t('stats.card.in')} ${fmtTok(tot?.tokensIn)} / ${t('stats.card.out')} ${fmtTok(tot?.tokensOut)}`}
                />
                <StatCard
                    label="P50 / P95"
                    value={tot ? fmtMs(tot.p50ms) : '—'}
                    sub={`P95 ${fmtMs(tot?.p95ms)}`}
                />
            </div>

            <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                    <span className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">
                        {t('stats.groups')}
                    </span>
                    <span className="flex items-center gap-1">
                        {BYS.map((b) => (
                            <Chip key={b} active={by === b} label={t(`stats.by.${b}`)} onClick={() => setBy(b)} />
                        ))}
                    </span>
                </div>
                {groups.length > 0 && (
                    <div className="inset-group">
                        {groups.slice(0, 12).map((g) => (
                            <div key={g.key} className="inset-row text-[12px]">
                                <span className="min-w-0">
                                    <span className="block truncate font-mono-ui text-[11.5px] text-[color:var(--fg-primary)]">{g.key}</span>
                                    <span className="mt-0.5 block font-mono-ui text-[10px] text-[color:var(--fg-faint)]">
                                        {g.generations} {t('stats.src.events')} · {fmtPct(g.failRate)} {t('stats.grp.fail')}
                                    </span>
                                </span>
                                <span className="shrink-0 text-right font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">
                                    {fmtTok((g.tokensIn ?? 0) + (g.tokensOut ?? 0))} · {fmtMs(g.p50ms)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {inject.error && !inject.data ? (
                <PanelError error={inject.error} onRetry={inject.reload} />
            ) : inject.data && inject.data.empty ? (
                <PanelEmpty icon="compass">
                    {chatParam ? t('stats.inject.emptyChat') : t('stats.inject.empty')}
                </PanelEmpty>
            ) : inject.data ? (
                <div className="space-y-3">
                    <SourceRows sources={inject.data.sources} />
                    {wiEntries.length > 0 ? (
                        <WiHitTable entries={wiEntries} />
                    ) : (
                        <div className="px-0.5 font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">
                            {t('stats.wi.none')} {chatParam ? `· ${chatParam}` : `· ${t('stats.scope.all')}`}
                        </div>
                    )}
                </div>
            ) : (
                <PanelEmpty icon="compass">…</PanelEmpty>
            )}
        </div>
    );
}
