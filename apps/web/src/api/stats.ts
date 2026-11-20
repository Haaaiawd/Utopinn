// Stats 观测面 /api/utopinn/stats/*(统计与命中板块数据源;制卡调试刚需)。
// 服务端:apps/server/src/plugins/utopinn-stats.js —— job store(trace/perf)
//   × inspector ledger(真实 usage)× diag-bus inject 事件三方聚合,纯内存读面:
//   重启即清,无数据恒零值 + empty:true,不 500。
//   GET /stats/summary?range=1h|24h|7d|all&by=char|model|day → totals + groups[]
//   GET /stats/by-char/:id    单卡游玩量 + WI 命中(id=charDir|卡名)
//   GET /stats/inject?chat=<charDir>/<chat>  注入源聚合 + WI 条目级命中表
import { apiGet } from './client';

export type StatsRange = '1h' | '24h' | '7d' | 'all';
export type StatsBy = 'char' | 'model' | 'day';

/** 单 job 聚合指标行(percentile 为最近秩;无样本 → null,不虚报)。 */
export interface StatsTotals {
    generations: number;
    completed: number;
    failed: number;
    /** 0..1 小数(0.021 = 2.1%)。 */
    failRate: number;
    tokensIn: number;
    tokensOut: number;
    /** tokens 覆盖计数:usage/trace 都没挂的 job 不参与分子(防「0 像真值」)。 */
    tokensInJobs: number;
    tokensOutJobs: number;
    p50ms: number | null;
    p95ms: number | null;
}

export interface StatsGroup extends StatsTotals {
    /** by=char → charDir|group:<id>|'?';by=model → model;by=day → YYYY-MM-DD。 */
    key: string;
}

export interface StatsSummaryReply {
    range: StatsRange;
    by: StatsBy;
    totals: StatsTotals;
    groups: StatsGroup[];
    empty: boolean;
}

/** GET /stats/summary —— 范围窗口 × 维度分组聚合。 */
export async function statsSummary(
    { range = '7d', by = 'char' }: { range?: StatsRange; by?: StatsBy } = {},
): Promise<StatsSummaryReply> {
    const p = new URLSearchParams({ range, by });
    return apiGet(`/api/utopinn/stats/summary?${p}`);
}

/** WI 条目级命中行(inject worldinfo 事件的 data.entries 聚合)。
 *  entry = `${world}.${uid}` 复合键;key = 命中关键词首词。 */
export interface WiHitEntry {
    entry: string;
    world: string | null;
    uid: number | string | null;
    key: unknown;
    hits: number;
}

/** 注入源聚合行:source 即 inject stage(preset/charbook/worldinfo/regex/
 *  instruct/macro + 动态);worldinfo 附 entries + job-trace token 富化列。 */
export interface InjectSourceStat {
    source: string;
    events: number;
    injectedTotal: number;
    /** 注入非零轮次占比 0..1。 */
    hitRate: number;
    tokensAvg: number | null;
    msAvg: number | null;
    /** worldinfo 专属:条目级命中表(制卡调试的杀手数据)。 */
    entries?: WiHitEntry[];
    /** worldinfo 专属:job.trace join 的 WI token 总量/占比(diagId 认亲)。 */
    tokensTotal?: number | null;
    tokenShare?: number | null;
    tokensBasis?: string | null;
}

export interface StatsInjectReply {
    /** 回显过滤串;未过滤 → null(全域聚合)。 */
    chat: string | null;
    events: number;
    sources: InjectSourceStat[];
    empty: boolean;
}

/**
 * GET /stats/inject —— inject 事件按源聚合。
 * @param chat 可选 '<charDir>/<chat>'(.jsonl 后缀可带可不带);不传 = 全域。
 *   服务端校验:带 chat 就必须带斜杠双段,缺段 400。
 */
export async function statsInject(chat?: string): Promise<StatsInjectReply> {
    const p = new URLSearchParams();
    if (chat) p.set('chat', chat);
    const s = p.toString();
    return apiGet(`/api/utopinn/stats/inject${s ? `?${s}` : ''}`);
}

/** GET /stats/by-char/:id —— 单卡游玩量/WI 命中;解不出卡 → 404。 */
export interface StatsByCharReply {
    charDir: string;
    name: string;
    chats: number;
    floors: number;
    generations: number;
    failed: number;
    tokens: { in: number; out: number };
    lastActive: number | null;
    wiHits: number;
    wiGenerations: number;
    wiTop: WiHitEntry[];
    empty: boolean;
}

export async function statsByChar(id: string): Promise<StatsByCharReply> {
    return apiGet(`/api/utopinn/stats/by-char/${encodeURIComponent(id)}`);
}
