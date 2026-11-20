// 诊断与观测板块(规范稿 diag 四子页:jobs / trace / errors / logs)。
// 数据全真面:
//   jobs   → listJobs()(摘要,新→旧;model/tokens/totalMs 为服务端摘要
//            新增字段,老服务端缺省 → '—' 诚实降级)
//   trace  → getJobTrace(id)(injections 注入时序 + perf + 相关事件回放)
//   errors → listErrors()(lvl≥warn;domain = 事件 kind;本地忽略 =
//            client-local Set + postClientEvent 留痕进总线)
//   logs   → listEvents()(lvl 精确档 + kind 十种全集双过滤)
// 子页/选中 job 存 ctx.panelParams['diag'] —— openPanel('diag',
// {sub:'trace', job:'…'}) 是楼层「查看 Trace」/token 胶囊/top-job-slot
// 的统一入口约定(壳透传不透解)。
import { useCallback, useEffect, useState } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { listJobs, type JobSummary } from '../../api/jobs';
import { reloadPlugin } from '../../api/plugins';
import {
    DIAG_KINDS, getJobTrace, listErrors, listEvents, postClientEvent,
    type DiagEvent,
} from '../../api/diag';
import { PanelEmpty, PanelError, useRemote } from './panelShared';

/** 观测面轮询节奏(与 top-job-slot 同拍);document.hidden 时跳过。 */
const POLL_MS = 8000;

type DiagSub = 'jobs' | 'trace' | 'errors' | 'logs';
/** openPanel('diag', params) 的载荷形(壳透传,面板自释)。 */
export interface DiagParams { sub?: DiagSub; job?: string }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const fmtClock = (ts: unknown): string => {
    const d = typeof ts === 'number' ? new Date(ts) : null;
    if (!d || Number.isNaN(d.getTime())) return '—';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const fmtMs = (v: unknown): string => (num(v) != null ? `${num(v)}ms` : '—');
const fmtTok = (v: unknown): string => (num(v) != null ? `${num(v)}t` : '—');

/** job 状态色:终态 ok / failed 红 / aborted|cancelled 琥珀 / 在跑 brand。 */
function statusColor(status: string): string {
    const s = String(status ?? '');
    if (s === 'failed') return 'var(--status-danger)';
    if (s === 'aborted' || s === 'cancelled') return 'var(--status-warn)';
    if (['completed', 'done', 'persisted', 'awaiting_ack', 'persisting'].includes(s)) return 'var(--status-ok)';
    return 'var(--brand)'; // running / queued / streaming / …
}

/** 终态判定(trace 页/top-job-slot 据此决定是否继续轮询)。 */
export const isJobTerminal = (status: string): boolean =>
    ['completed', 'done', 'persisted', 'awaiting_ack', 'persisting', 'failed', 'aborted', 'cancelled'].includes(String(status));

/** 观测面轻轮询:remote.reload 保数据不闪;页面隐藏即省流。 */
function usePoll(reload: () => void, on = true) {
    useEffect(() => {
        if (!on) return;
        const iv = setInterval(() => { if (!document.hidden) reload(); }, POLL_MS);
        return () => clearInterval(iv);
    }, [reload, on]);
}

/** lvl → 颜色(日志行首 [LVL] 标记)。 */
const lvlColor = (lvl: string) =>
    lvl === 'error' ? 'var(--status-danger)' : lvl === 'warn' ? 'var(--status-warn)' : 'var(--fg-muted)';

/** 过滤片(双段控件里的一格)。 */
function Chip({ active, label, onClick, bordered = true }: { active: boolean; label: string; onClick: () => void; bordered?: boolean }) {
    return (
        <button
            className="shrink-0 rounded-md px-2 py-0.5 font-mono-ui text-[10.5px]"
            style={{
                background: active ? 'var(--bg-active)' : 'transparent',
                color: active ? 'var(--fg-primary)' : 'var(--fg-muted)',
                border: bordered ? '1px solid var(--border-hairline)' : 'none',
            }}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

/* ----------------------------------------------------------------------- */
/* jobs 子页 —— 规范稿 jobs 列表(dot+id+type chip | model·tok | status·ms)   */
/* ----------------------------------------------------------------------- */

function JobsView({ remote, onTrace }: { remote: ReturnType<typeof useRemote<{ items: JobSummary[] }>>; onTrace: (job: string) => void }) {
    const { t } = useI18n();
    if (remote.error && !remote.data) return <PanelError error={remote.error} onRetry={remote.reload} />;
    const items = remote.data?.items ?? [];
    if (remote.data && items.length === 0) {
        return <PanelEmpty icon="code">{t('diag.jobs.empty')}</PanelEmpty>;
    }
    return (
        <div className="inset-group">
            {items.map((j) => {
                const clr = statusColor(j.status);
                const verb = j.verb ?? 'gen';
                return (
                    <button key={j.id} className="inset-row inset-row-btn" onClick={() => onTrace(j.id)}>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: clr }} />
                                <span className="truncate font-mono-ui text-[12.5px] font-medium text-[color:var(--fg-primary)]">{j.id}</span>
                                <span className="rounded bg-[color:var(--bg-active)] px-1.5 py-0.5 font-mono-ui text-[10.5px] text-[color:var(--fg-secondary)]">{verb}</span>
                            </div>
                            <div className="mt-1 truncate font-mono-ui text-[11px] text-[color:var(--fg-muted)]">
                                {j.model || '—'} · {fmtTok(j.tokens)}
                            </div>
                        </div>
                        <div className="shrink-0 text-right">
                            <div className="font-mono-ui text-[11.5px]" style={{ color: clr }}>{j.status}</div>
                            <div className="mt-0.5 font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">{fmtMs(j.totalMs)}</div>
                        </div>
                    </button>
                );
            })}
            {!remote.data && <div className="inset-row font-mono-ui text-[11px] text-[color:var(--fg-faint)]">…</div>}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* trace 子页 —— stage|inj|tokens|ms 时序表 + perf + 相关事件回放             */
/* ----------------------------------------------------------------------- */

function TraceView({ jobId }: { jobId: string }) {
    const { t } = useI18n();
    const remote = useRemote(`trace:${jobId}`, () => getJobTrace(jobId));
    const job = remote.data;
    // 在跑的 job 持续回放;终态停轮询。
    usePoll(remote.reload, !job || !isJobTerminal(job.status));

    if (remote.error && !remote.data) return <PanelError error={remote.error} onRetry={remote.reload} />;
    if (!job) return <PanelEmpty icon="code">…</PanelEmpty>;

    // tokens:优先 trace 预算差(tokenBudget-remainingBudget),兜底注入列求和。
    const budget = num(job.trace?.tokenBudget);
    const remaining = num(job.trace?.remainingBudget);
    const traceIn = budget != null && remaining != null ? budget - remaining : null;
    const injTok = job.injections.reduce((s, i) => s + (num(i.tokens) ?? 0), 0);
    const tok = traceIn ?? (job.injections.length ? injTok : null);
    const ms = num(job.perf?.totalMs) ?? (job.updated_at && job.created_at ? job.updated_at - job.created_at : null);

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between text-[12px]">
                <span className="min-w-0 truncate font-mono-ui font-medium text-[color:var(--fg-primary)]">
                    {job.id} · {job.verb ?? 'gen'}
                </span>
                <span className="shrink-0 font-mono-ui text-[11px] text-[color:var(--fg-muted)]">
                    {num(tok) != null ? `${tok} tok` : '—'} · {fmtMs(ms)}
                </span>
            </div>
            <div className="flex items-center gap-2 font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor(job.status) }} />
                <span style={{ color: statusColor(job.status) }}>{job.status}</span>
                {job.model ? <span className="truncate">· {job.model}</span> : null}
            </div>
            {job.error ? (
                <div
                    className="rounded-[10px] p-3 font-mono-ui text-[11.5px]"
                    style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--status-danger)' }}
                >
                    {job.error}
                </div>
            ) : null}
            {job.injections.length === 0 ? (
                <PanelEmpty icon="code">{t('diag.trace.none')}</PanelEmpty>
            ) : (
                <div className="inset-group">
                    <div
                        className="grid grid-cols-12 border-b px-3.5 py-2 font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]"
                        style={{ borderColor: 'var(--border-hairline)' }}
                    >
                        <span className="col-span-5">stage</span>
                        <span className="col-span-2 text-right">inj</span>
                        <span className="col-span-3 text-right">tokens</span>
                        <span className="col-span-2 text-right">ms</span>
                    </div>
                    {job.injections.map((tr) => (
                        <div
                            key={tr.seq}
                            className="grid grid-cols-12 items-center border-t px-3.5 py-2 font-mono-ui text-[11.5px]"
                            style={{ borderColor: 'var(--border-hairline)' }}
                        >
                            <span
                                className="col-span-5 truncate"
                                style={{ color: tr.stage === 'assemble' ? 'var(--brand)' : 'var(--fg-primary)' }}
                                title={String(tr.stage ?? '—')}
                            >
                                {tr.stage ?? '—'}
                            </span>
                            <span className="col-span-2 text-right text-[color:var(--fg-secondary)]">{num(tr.injected) ?? '—'}</span>
                            <span className="col-span-3 text-right text-[color:var(--fg-primary)]">{num(tr.tokens) ?? '—'}</span>
                            <span className="col-span-2 text-right text-[color:var(--fg-muted)]">{num(tr.ms) ?? '—'}</span>
                        </div>
                    ))}
                </div>
            )}
            {job.events.length > 0 && (
                <>
                    <div className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">
                        {t('diag.trace.events')} · {job.events.length}
                    </div>
                    <div className="inset-group">
                        {job.events.map((e) => (
                            <EventRow key={e.seq} e={e} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

/** 事件行(logs 子页与 trace 回放共用):[LVL] kind + 时刻 + msg,点开看 data。 */
function EventRow({ e }: { e: DiagEvent }) {
    const [open, setOpen] = useState(false);
    const hasMeta = e.data !== undefined || (e.ctx && Object.keys(e.ctx).length > 0);
    return (
        <div className="border-t first:border-t-0" style={{ borderColor: 'var(--border-hairline)' }}>
            <button className="inset-row-btn w-full space-y-1 px-3.5 py-2.5 text-left" onClick={() => setOpen((v) => !v)}>
                <div className="flex items-center justify-between gap-2 font-mono-ui text-[10.5px]">
                    <span style={{ color: lvlColor(e.lvl) }}>[{e.lvl.toUpperCase()}] {e.kind}</span>
                    <span className="shrink-0 text-[color:var(--fg-faint)]">{fmtClock(e.ts)}</span>
                </div>
                <div className="font-mono-ui text-[11.5px] leading-snug text-[color:var(--fg-primary)]">{e.msg}</div>
            </button>
            {open && hasMeta ? (
                <div className="px-3.5 pb-2.5">
                    <pre
                        className="select-text overflow-x-auto rounded-lg border p-2.5 font-mono-ui text-[10.5px] leading-relaxed text-[color:var(--fg-secondary)]"
                        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)' }}
                    >
                        {JSON.stringify({ ...(e.ctx ? { ctx: e.ctx } : {}), ...(e.data !== undefined ? { data: e.data } : {}) }, null, 2)}
                    </pre>
                </div>
            ) : null}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* errors 子页 —— domain 片 + 行展开(msg/stack)+ 重载插件/复制/本地忽略        */
/* ----------------------------------------------------------------------- */

/** 规范稿 error domain 四词(plugin/generate/state/th)+ 其他桶兜底。 */
const ERR_DOMAINS = ['plugin', 'generate', 'state', 'th'] as const;
type ErrFilter = 'all' | (typeof ERR_DOMAINS)[number] | 'other';

function errorTitle(e: DiagEvent): string {
    const first = String(e.msg ?? '').split('\n')[0] ?? '';
    return first.trim() || (e.code ?? e.kind);
}

function ErrorsView({
    remote, ignored, toggleIgnore, onTrace,
}: {
    remote: ReturnType<typeof useRemote<Awaited<ReturnType<typeof listErrors>>>>;
    ignored: ReadonlySet<number>;
    toggleIgnore: (seq: number) => void;
    onTrace: (job: string) => void;
}) {
    const { t } = useI18n();
    const s = useShell();
    const [domain, setDomain] = useState<ErrFilter>('all');
    const [openSeq, setOpenSeq] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);

    if (remote.error && !remote.data) return <PanelError error={remote.error} onRetry={remote.reload} />;
    const items = remote.data?.items ?? [];
    const filtered = items.filter((e) =>
        domain === 'all' ? true
            : domain === 'other' ? !(ERR_DOMAINS as readonly string[]).includes(e.kind)
                : e.kind === domain);

    const exportNdjson = () => {
        const nd = filtered.map((e) => JSON.stringify(e)).join('\n');
        const blob = new Blob([nd], { type: 'application/x-ndjson' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `utopinn-errors-${Date.now()}.jsonl`;
        a.click();
        URL.revokeObjectURL(a.href);
    };

    const copyStack = (e: DiagEvent) => {
        const text = `[${e.lvl}] ${e.kind} ${e.code ?? ''}\n${e.msg}\n${JSON.stringify(e.data ?? e.ctx ?? {}, null, 2)}`;
        navigator.clipboard?.writeText(text).then(() => s.hint(t('diag.copied'))).catch(() => s.hint(t('diag.copy.failed'), true));
    };

    const reload = (e: DiagEvent) => {
        const plugin = e.ctx?.plugin;
        if (!plugin) return;
        setBusy(true);
        void reloadPlugin(String(plugin))
            .then((r) => s.hint(r.ok ? t('diag.err.reloaded') : (r.error ?? 'reload failed'), !r.ok))
            .catch((err) => s.hint(err instanceof Error ? err.message : String(err), true))
            .finally(() => setBusy(false));
    };

    const ignore = (e: DiagEvent) => {
        const nowResolved = !ignored.has(e.seq);
        toggleIgnore(e.seq);
        // 忽略/重开动作也留痕进总线(本地 Set 是表现态,事件是证据)。
        void postClientEvent({
            lvl: 'info', kind: 'client', code: nowResolved ? 'err_ignore' : 'err_reopen',
            msg: `${nowResolved ? 'ignored' : 'reopened'} diag error seq=${e.seq} (${e.kind}/${e.code ?? 'no_code'})`,
            ctx: { route: 'diag-panel' },
        }).catch(() => { /* 上报失败不挡交互 */ });
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                    <Chip active={domain === 'all'} label={t('diag.err.all')} onClick={() => setDomain('all')} />
                    {ERR_DOMAINS.map((d) => (
                        <Chip key={d} active={domain === d} label={d} onClick={() => setDomain(d)} />
                    ))}
                    <Chip active={domain === 'other'} label={t('diag.err.other')} onClick={() => setDomain('other')} />
                </div>
                <button
                    className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[10.5px] text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-active)]"
                    style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}
                    onClick={exportNdjson}
                >
                    <Icon name="import" size={12} /><span>{t('diag.err.export')}</span>
                </button>
            </div>
            {remote.data && filtered.length === 0 ? (
                <PanelEmpty icon="shield">{t('diag.err.none')}</PanelEmpty>
            ) : (
                <div className="space-y-2">
                    {filtered.map((er) => {
                        const open = openSeq === er.seq;
                        const resolved = ignored.has(er.seq);
                        // trace 面按 job id 查;diagId 是组装期认亲键,不是 job ——
                        // 只有 jobId 的错误才给「查看 Trace」入口。
                        const jobId = er.ctx?.jobId;
                        return (
                            <div
                                key={er.seq}
                                className="overflow-hidden rounded-[10px]"
                                style={{
                                    background: 'var(--bg-surface)',
                                    border: `1px solid ${resolved ? 'var(--border-hairline)' : 'rgba(248, 113, 113, 0.32)'}`,
                                    opacity: resolved ? 0.62 : 1,
                                }}
                            >
                                <button
                                    className="w-full space-y-1.5 p-3 text-left transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                                    onClick={() => setOpenSeq(open ? null : er.seq)}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            <span
                                                className="shrink-0 rounded px-1.5 py-0.5 font-mono-ui text-[10px]"
                                                style={{
                                                    background: resolved ? 'var(--bg-active)' : 'rgba(248, 113, 113, 0.14)',
                                                    color: resolved ? 'var(--fg-muted)' : 'var(--status-danger)',
                                                }}
                                            >
                                                {er.kind}
                                            </span>
                                            <span className="truncate font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{er.code ?? '—'}</span>
                                        </div>
                                        <span className="shrink-0 font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{fmtClock(er.ts)}</span>
                                    </div>
                                    <div className="text-[12.5px] font-medium leading-snug text-[color:var(--fg-primary)]">{errorTitle(er)}</div>
                                    {er.ctx?.plugin ? (
                                        <div className="truncate font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{String(er.ctx.plugin)}</div>
                                    ) : null}
                                </button>
                                {open ? (
                                    <div className="space-y-2.5 border-t px-3 pb-3 pt-2.5" style={{ borderColor: 'var(--border-hairline)' }}>
                                        <div className="text-[11.5px] leading-relaxed text-[color:var(--fg-secondary)]">{er.msg}</div>
                                        <pre
                                            className="select-text overflow-x-auto rounded-lg border p-2.5 font-mono-ui text-[10.5px] leading-relaxed"
                                            style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--status-danger)' }}
                                        >
                                            {JSON.stringify(er.data ?? er.ctx ?? {}, null, 2)}
                                        </pre>
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            {jobId ? (
                                                <button
                                                    className="h-7 rounded-md bg-[color:var(--bg-active)] px-2.5 text-[11px] font-medium text-[color:var(--fg-primary)]"
                                                    onClick={() => onTrace(String(jobId))}
                                                >
                                                    {t('diag.err.trace')}
                                                </button>
                                            ) : null}
                                            {er.kind === 'plugin' && er.ctx?.plugin ? (
                                                <button
                                                    className="h-7 rounded-md px-2.5 text-[11px] font-medium"
                                                    style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                                    disabled={busy}
                                                    onClick={() => reload(er)}
                                                >
                                                    {t('diag.err.reload')}
                                                </button>
                                            ) : null}
                                            <button
                                                className="h-7 rounded-md border px-2.5 text-[11px] text-[color:var(--fg-secondary)]"
                                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)' }}
                                                onClick={() => copyStack(er)}
                                            >
                                                {t('diag.err.copy')}
                                            </button>
                                            <button className="h-7 rounded-md px-2.5 text-[11px] text-[color:var(--fg-muted)]" onClick={() => ignore(er)}>
                                                {resolved ? t('diag.err.reopen') : t('diag.err.ignore')}
                                            </button>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                    {!remote.data && <PanelEmpty icon="shield">…</PanelEmpty>}
                </div>
            )}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* logs 子页 —— lvl 精确片 + kind 全集片 + NDJSON 复制/导出/清空视图          */
/* ----------------------------------------------------------------------- */

type LogLvlFilter = 'ALL' | 'INFO' | 'WARN' | 'ERROR';
/** logs 过滤形(lvl=精确档 / kind=单选全集)。 */
export interface LogFilter { lvl: LogLvlFilter; kind: string }

function LogsView({ remote, filter, onFilterChange }: {
    remote: ReturnType<typeof useRemote<Awaited<ReturnType<typeof listEvents>>>>;
    filter: LogFilter;
    onFilterChange: (f: LogFilter) => void;
}) {
    const { t } = useI18n();
    const s = useShell();
    const { lvl, kind } = filter;
    const [clearedSeq, setClearedSeq] = useState(0);

    const applyLvl = (v: LogLvlFilter) => onFilterChange({ lvl: v, kind });
    const applyKind = (v: string) => onFilterChange({ lvl, kind: v });

    if (remote.error && !remote.data) return <PanelError error={remote.error} onRetry={remote.reload} />;
    // lvl 片是精确档(服务端 lvl 参数是最低等级,不是等值 —— 客户端再滤);
    // clearedSeq 是"清空视图"水位(服务端环不动,只藏 ≤水位 的行)。
    const items = (remote.data?.items ?? []).filter(
        (e) => e.seq > clearedSeq && (lvl === 'ALL' || e.lvl.toUpperCase() === lvl),
    );

    const ndjson = () => items.map((e) => JSON.stringify(e)).join('\n');
    const copy = () => {
        navigator.clipboard?.writeText(ndjson()).then(() => s.hint(t('diag.copied'))).catch(() => s.hint(t('diag.copy.failed'), true));
    };
    const exportFile = () => {
        const blob = new Blob([ndjson()], { type: 'application/x-ndjson' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `utopinn-logs-${Date.now()}.jsonl`;
        a.click();
        URL.revokeObjectURL(a.href);
    };
    const clear = () => {
        setClearedSeq(remote.data?.seq ?? Number.MAX_SAFE_INTEGER);
    };

    return (
        <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                    {(['ALL', 'INFO', 'WARN', 'ERROR'] as const).map((lv) => (
                        <Chip key={lv} active={lvl === lv} label={lv} onClick={() => applyLvl(lv)} />
                    ))}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[10.5px] text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-active)]"
                        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}
                        title={t('diag.logs.copyTitle')}
                        onClick={copy}
                    >
                        <Icon name="copy" size={12} /><span>{t('diag.logs.copy')}</span>
                    </button>
                    <button
                        className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[10.5px] text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-active)]"
                        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}
                        title={t('diag.logs.exportTitle')}
                        onClick={exportFile}
                    >
                        <Icon name="import" size={12} /><span>{t('diag.logs.export')}</span>
                    </button>
                    <button
                        className="h-6 rounded-md px-2 text-[10.5px] text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-active)]"
                        title={t('diag.logs.clearTitle')}
                        onClick={clear}
                    >
                        {t('diag.logs.clear')}
                    </button>
                </div>
            </div>
            <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                <Chip active={kind === 'all'} label={t('diag.err.all')} onClick={() => applyKind('all')} bordered={false} />
                {DIAG_KINDS.map((k) => (
                    <Chip key={k} active={kind === k} label={k} onClick={() => applyKind(k)} bordered={false} />
                ))}
            </div>
            {remote.data && items.length === 0 ? (
                <PanelEmpty icon="code">{t('diag.logs.none')}</PanelEmpty>
            ) : (
                <div className="inset-group">
                    {items.map((e) => <EventRow key={e.seq} e={e} />)}
                    {!remote.data && <div className="inset-row font-mono-ui text-[11px] text-[color:var(--fg-faint)]">…</div>}
                </div>
            )}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* diag 板块体 —— 子页段控件 + 四子页                                          */
/* ----------------------------------------------------------------------- */

export function DiagPanel() {
    const { t } = useI18n();
    const s = useShell();
    const params = (s.panelParams['diag'] ?? {}) as DiagParams;
    const sub: DiagSub = params.sub ?? (params.job ? 'trace' : 'jobs');

    const setParams = useCallback(
        (p: DiagParams) => s.setPanelParams('diag', p),
        [s],
    );
    const openTrace = useCallback((job: string) => setParams({ sub: 'trace', job }), [setParams]);

    // jobs/errors 数据在父级取 —— errors 未决数要上 tab 徽标(故常轮询)。
    const jobs = useRemote('diag:jobs', () => listJobs());
    const errors = useRemote('diag:errors', () => listErrors({ limit: 300 }));
    usePoll(jobs.reload, sub === 'jobs');
    usePoll(errors.reload);

    // 本地忽略(client-local resolve;跨子页切换保持,面板卸载即清)。
    const [ignored, setIgnored] = useState<ReadonlySet<number>>(new Set());
    const toggleIgnore = useCallback((seq: number) => {
        setIgnored((prev) => {
            const next = new Set(prev);
            if (next.has(seq)) next.delete(seq);
            else next.add(seq);
            return next;
        });
    }, []);

    // logs 过滤(lvl 精确档 / kind 单选全集)—— 状态挂父级,跨子页切换保持;
    // kind 走服务端参数(环面过滤),lvl 精确档客户端再滤。
    const [logFilter, setLogFilter] = useState<LogFilter>({ lvl: 'ALL', kind: 'all' });
    const logs = useRemote(`diag:logs:${logFilter.kind}`, () =>
        listEvents({ kind: logFilter.kind === 'all' ? undefined : logFilter.kind, limit: 500 }));
    usePoll(logs.reload, sub === 'logs');

    const unresolved = (errors.data?.items ?? []).filter((e) => !ignored.has(e.seq)).length;
    const tabs: [DiagSub, string][] = [
        ['jobs', 'Jobs'],
        ['trace', 'Trace'],
        ['errors', `${t('diag.sub.errors')}${errors.data ? ` (${unresolved})` : ''}`],
        ['logs', 'Logs'],
    ];

    return (
        <div className="space-y-4 p-4">
            <div
                className="inline-flex rounded-lg p-0.5"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}
            >
                {tabs.map(([k, lbl]) => (
                    <button
                        key={k}
                        className="rounded-[6px] px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                        style={{
                            background: sub === k ? 'var(--bg-active)' : 'transparent',
                            color: sub === k ? 'var(--fg-primary)' : 'var(--fg-muted)',
                        }}
                        onClick={() => setParams({ ...params, sub: k })}
                    >
                        {lbl}
                    </button>
                ))}
            </div>
            {sub === 'jobs' ? (
                <JobsView remote={jobs} onTrace={openTrace} />
            ) : sub === 'trace' ? (
                params.job ? (
                    <TraceView jobId={params.job} />
                ) : (
                    <PanelEmpty icon="code">{t('diag.trace.pick')}</PanelEmpty>
                )
            ) : sub === 'errors' ? (
                <ErrorsView remote={errors} ignored={ignored} toggleIgnore={toggleIgnore} onTrace={openTrace} />
            ) : (
                <LogsView remote={logs} filter={logFilter} onFilterChange={setLogFilter} />
            )}
        </div>
    );
}

/** diag 面板的"选中 job"约定 —— 供 top-job-slot/楼层/token 胶囊复用:
 *  openPanel('diag', diagTraceParams(jobId)) 即直开 trace 子页。 */
export function diagTraceParams(job: string): DiagParams {
    return { sub: 'trace', job };
}
