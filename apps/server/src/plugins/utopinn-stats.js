/**
 * utopinn-stats —— kernel 插件:生成/注入聚合统计面(制卡调试刚需)。
 *
 *   GET /api/utopinn/stats/summary?range=1h|24h|7d|all&by=char|model|day
 *       → {range,by,totals,groups[],empty}  每维
 *       {generations,completed,failed,failRate,tokensIn,tokensOut,p50ms,p95ms}
 *   GET /api/utopinn/stats/by-char/:id
 *       → {charDir,name,chats,floors,generations,failed,tokens,lastActive,
 *          wiHits,wiGenerations,wiTop,empty}  id 按 charDir → 卡名精确 → 卡名
 *          部分唯一 解析;解不出 404(语义同 library /characters/:charDir)。
 *   GET /api/utopinn/stats/inject?chat=<charDir>/<chat>
 *       → {chat,events,sources[],empty}  每源(stage)
 *       {source,events,injectedTotal,hitRate,tokensAvg,msAvg};
 *       worldinfo 展开条目级 entries[{entry,world,uid,key,hits}],
 *       token 列由 diagId 认亲 job.trace.collections 的 worldInfo* 段聚合。
 *
 * 数据源:job store(luker-generation 的 trace/perf/chatKey)+ inspector
 * ledger(真实 usage 优先,trace 预算差兜底)+ diag-bus inject 事件。
 * 纯内存读面:jobs TTL 2h/128 条、diag 环 2000 条、inspector 有字节
 * 预算——重启即清,无数据恒零值+empty:true,不 500。
 */
import fs from 'node:fs';
import path from 'node:path';

import { query as diagQuery } from '../services/diag-bus.js';
import { listGenerationJobsForRequest, getGenerationJobForRequest } from '../endpoints/backends/luker-generation.js';
import { getBufferForHandle } from '../request-inspector.js';
import { getChatRepo } from '../storage/index.js';
import { InvalidArgumentError } from '../storage/errors.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { safeName, sendError } from './utopinn-library.js';

export const inject = ['webServer'];

const P = '/api/utopinn/stats';

/** range 枚举 → 毫秒窗口;'all' = 不限。 */
const RANGE_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, 'all': 0 };
const BY_DIMS = new Set(['char', 'model', 'day']);
/** 产出成功的 job 终态/准终态(kind:none 的客户端写盘 job 也算产出了)。 */
const DONE_STATUSES = new Set(['completed', 'awaiting_ack', 'persisting', 'done']);
/** 固定展示的注入源序(spec 六源);其余 stage 如实附后。 */
const INJECT_STAGE_ORDER = ['preset', 'charbook', 'worldinfo', 'regex', 'instruct', 'macro'];
/** trace.collections 里归属世界书的段(before/after + @depth 注入)。 */
const WI_COLLECTION_RE = /^worldInfo(?:Before|After)$|^WIDepth-/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const roundInt = (v) => (v == null ? null : Math.round(v));

// ---------------------------------------------------------------------------
// job 行归一化:summary/by-char 共用的单 job 指标投影
// ---------------------------------------------------------------------------

/**
 * chatKey('char:<avatar>:<chat>'|'group:<id>')→ 部件。
 * avatar 含 .png/.webp 后缀,剥成 charDir;chat 名里若带冒号按最后一个
 * 冒号切(组 id 不解析 chat 段)。
 */
function chatKeyParts(chatKey) {
    const k = String(chatKey ?? '');
    if (k.startsWith('group:')) return { kind: 'group', id: k.slice(6) };
    if (!k.startsWith('char:')) return null;
    const rest = k.slice(5);
    const i = rest.lastIndexOf(':');
    const avatar = (i < 0 ? rest : rest.slice(0, i)).replace(/\.(?:png|webp)$/i, '');
    return { kind: 'char', charDir: avatar, chat: i < 0 ? '' : rest.slice(i + 1) };
}

/** trace.collections 里世界书段 token 合计(before/after/WIDepth-*)。 */
function wiCollectionsTokens(collections) {
    if (!Array.isArray(collections)) return null;
    let sum = 0, seen = false;
    for (const c of collections) {
        if (c && WI_COLLECTION_RE.test(String(c.identifier ?? '')) && num(c.tokens) != null) {
            sum += c.tokens;
            seen = true;
        }
    }
    return seen ? sum : null;
}

/**
 * 单 job → 指标行。tokensIn 优先 inspector 真实 usage(prompt_tokens),
 * 兜底 trace 预算差(tokenBudget-remainingBudget,是组装侧计量);
 * tokensOut 只有 inspector completion_tokens 一个来源。durMs 优先
 * inspector durationMs(端到端),兜底 job 生命周期(createdAt→终态 ts)。
 */
function jobMetrics(job, inspByJobId) {
    const insp = inspByJobId?.get(job.id) ?? null;
    const budget = num(job.trace?.tokenBudget);
    const remaining = num(job.trace?.remainingBudget);
    const traceIn = budget != null && remaining != null ? budget - remaining : null;
    const tokensIn = num(insp?.usage?.prompt_tokens) ?? traceIn;
    const tokensOut = num(insp?.usage?.completion_tokens);
    const totalTok = num(job.trace?.tokenBudget) != null && num(job.trace?.remainingBudget) != null
        ? job.trace.tokenBudget - job.trace.remainingBudget : null;
    const status = String(job.status ?? '');
    const endTs = num(job.finishedAt) ?? (['completed', 'failed', 'cancelled'].includes(status) ? num(job.updatedAt) : null);
    const kp = chatKeyParts(job.chatKey);
    return {
        id: job.id,
        diagId: job.diagId ?? null,
        status,
        createdAt: num(job.createdAt) ?? 0,
        updatedAt: num(job.updatedAt) ?? 0,
        model: job.modelName || job.requestMeta?.model || '',
        verb: job.requestMeta?.verb ?? null,
        charDir: kp?.kind === 'char' ? kp.charDir : null,
        groupId: kp?.kind === 'group' ? kp.id : null,
        chat: kp?.chat ?? null,
        tokensIn,
        tokensOut,
        tokensTotal: totalTok,
        wiTokens: wiCollectionsTokens(job.trace?.collections),
        durMs: num(insp?.durationMs) ?? (endTs != null && job.createdAt ? endTs - job.createdAt : null),
        assembleMs: num(job.perf?.totalMs),
        done: DONE_STATUSES.has(status),
        failed: status === 'failed',
    };
}

/** 本 handle 的 job 指标行(rangeMs 窗口过滤)+ diagId→行索引。 */
function collectJobRows(request, rangeMs) {
    const cutoff = rangeMs ? Date.now() - rangeMs : 0;
    const handle = request.user.profile.handle;
    const inspByJobId = new Map();
    try {
        for (const e of getBufferForHandle(handle)) {
            if (e?.generationJobId) inspByJobId.set(String(e.generationJobId), e);
        }
    } catch { /* inspector 缺失不挡统计 */ }
    const rows = [];
    for (const summary of listGenerationJobsForRequest(request)) {
        if (cutoff && Number(summary?.created_at ?? 0) < cutoff) continue;
        const job = getGenerationJobForRequest(request, summary?.id);
        if (job) rows.push(jobMetrics(job, inspByJobId));
    }
    return rows;
}

/** 行集 → spec 聚合。percentile 用最近秩;p50/p95 无时长样本 → null。 */
function aggregateRows(rows) {
    const durations = rows.map((r) => r.durMs).filter((v) => v != null).sort((a, b) => a - b);
    const pct = (p) => (durations.length ? durations[Math.min(durations.length - 1, Math.ceil(p * durations.length) - 1)] : null);
    const failed = rows.filter((r) => r.failed).length;
    const tokInJobs = rows.filter((r) => r.tokensIn != null).length;
    const tokOutJobs = rows.filter((r) => r.tokensOut != null).length;
    return {
        generations: rows.length,
        completed: rows.filter((r) => r.done).length,
        failed,
        failRate: rows.length ? Math.round((failed / rows.length) * 1000) / 1000 : 0,
        tokensIn: rows.reduce((s, r) => s + (r.tokensIn ?? 0), 0),
        tokensOut: rows.reduce((s, r) => s + (r.tokensOut ?? 0), 0),
        // tokens 覆盖计数:usage/trace 都没挂的 job 不参与分子,防「0 像真值」
        tokensInJobs: tokInJobs,
        tokensOutJobs: tokOutJobs,
        p50ms: roundInt(pct(0.5)),
        p95ms: roundInt(pct(0.95)),
    };
}

/** 本地时区日键(YYYY-MM-DD)——「今天」语义照运维直觉,不用 UTC。 */
function dayKey(ts) {
    const d = new Date(Number(ts) || 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// charDir 解析:目录名 → 卡名精确 → 卡名部分唯一(library 面同款读法)
// ---------------------------------------------------------------------------

async function loadCardDoc(dir, stem) {
    for (const ext of ['.png', '.webp']) {
        try {
            const raw = await fs.promises.readFile(path.join(dir, `${stem}${ext}`));
            return JSON.parse(readCharacterCard(raw));
        } catch { /* 下一个扩展名 */ }
    }
    try {
        return JSON.parse(await fs.promises.readFile(path.join(dir, `${stem}.json`), 'utf8'));
    } catch {
        return null;
    }
}

const cardDisplayName = (card) =>
    String(card?.data?.name ?? card?.name ?? '').trim();

/**
 * id → {charDir, name}。charDir 命中(有对应卡文件)直接返;
 * 否则全目录读卡名:精确 → 部分唯一;都不中 → null(调用方 404)。
 */
async function resolveCharDir(directories, raw) {
    const id = safeName(raw, 'id');
    const dir = String(directories?.characters ?? '');
    if (!dir) return null;
    let entries = [];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    const stems = new Set();
    for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (ext === '.png' || ext === '.webp' || ext === '.json') {
            const stem = e.name.slice(0, -ext.length);
            if (stem) stems.add(stem);
        }
    }
    if (stems.has(id)) {
        const card = await loadCardDoc(dir, id);
        return { charDir: id, name: cardDisplayName(card) || id };
    }
    const partials = [];
    for (const stem of stems) {
        const card = await loadCardDoc(dir, stem);
        const name = cardDisplayName(card);
        if (!name) continue;
        if (name === id) return { charDir: stem, name };
        if (name.includes(id)) partials.push({ charDir: stem, name });
    }
    return partials.length === 1 ? partials[0] : null;
}

// ---------------------------------------------------------------------------
// inject 事件聚合(diag-bus 的 kind:'inject',code=stage)
// ---------------------------------------------------------------------------

/**
 * inject 事件过滤 → 按 stage 聚合。filter 例:charDir / charDir+chatId。
 * 返回 Map(stage → 累加器);worldinfo 附带条目级命中表。
 */
function aggregateInjectEvents(filter) {
    const byStage = new Map();
    for (const e of diagQuery({ kind: 'inject', limit: 2000 })) {
        if (filter && !filter(e)) continue;
        const stage = String(e.code ?? e.ctx?.stage ?? 'unknown');
        let s = byStage.get(stage);
        if (!s) {
            s = { source: stage, events: 0, injectedTotal: 0, hits: 0, tokSum: 0, tokN: 0, msSum: 0, msN: 0, entries: new Map(), diagIds: [] };
            byStage.set(stage, s);
        }
        s.events++;
        if (e.ctx?.diagId) s.diagIds.push(String(e.ctx.diagId));
        const d = e.data ?? {};
        const injected = num(d.injected) ?? 0;
        s.injectedTotal += injected;
        if (injected > 0) s.hits++;
        if (num(d.tokens) != null) { s.tokSum += d.tokens; s.tokN++; }
        if (num(d.ms) != null) { s.msSum += d.ms; s.msN++; }
        if (stage === 'worldinfo' && Array.isArray(d.entries)) {
            for (const en of d.entries) {
                const key = `${en?.world ?? '?'}.${en?.uid ?? '?'}`;
                const cur = s.entries.get(key) ?? {
                    entry: key,
                    world: en?.world ?? null,
                    uid: en?.uid ?? null,
                    key: Array.isArray(en?.key) ? en.key[0] : en?.key ?? null,
                    hits: 0,
                };
                cur.hits++;
                s.entries.set(key, cur);
            }
        }
    }
    return byStage;
}

/** 累加器 → 输出形。wiJobs 是给 worldinfo 注入 job.trace token 的列。 */
function stageOut(s, jobEnrich = null) {
    const out = {
        source: s.source,
        events: s.events,
        injectedTotal: s.injectedTotal,
        hitRate: s.events ? Math.round((s.hits / s.events) * 1000) / 1000 : 0,
        tokensAvg: s.tokN ? round1(s.tokSum / s.tokN) : null,
        msAvg: s.msN ? round1(s.msSum / s.msN) : null,
    };
    if (s.entries.size) {
        out.entries = [...s.entries.values()].sort((a, b) => b.hits - a.hits || String(a.entry).localeCompare(String(b.entry)));
    }
    if (jobEnrich) Object.assign(out, jobEnrich);
    return out;
}

/** spec 六源序 → 其余观察到的 stage 按事件数降序附后。 */
function orderedStages(byStage) {
    const out = [];
    for (const name of INJECT_STAGE_ORDER) {
        out.push(byStage.get(name) ?? { source: name, events: 0, injectedTotal: 0, hits: 0, tokSum: 0, tokN: 0, msSum: 0, msN: 0, entries: new Map(), diagIds: [] });
    }
    const rest = [...byStage.values()]
        .filter((s) => !INJECT_STAGE_ORDER.includes(s.source))
        .sort((a, b) => b.events - a.events || a.source.localeCompare(b.source));
    return [...out, ...rest];
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function apply(ctx) {
    const ws = ctx.webServer;
    const reg = (path, handler) => ctx.effect(() => ws.register({ kind: 'pattern', method: 'GET', path, handler }));

    /** GET /summary —— jobs 聚合:范围窗口 × 维度分组。 */
    reg(`${P}/summary`, function (request, response) {
        try {
            const range = String(request.query?.range ?? 'all');
            if (!Object.prototype.hasOwnProperty.call(RANGE_MS, range)) {
                throw new InvalidArgumentError(`range must be one of: ${Object.keys(RANGE_MS).join('|')}`);
            }
            const by = String(request.query?.by ?? 'char');
            if (!BY_DIMS.has(by)) {
                throw new InvalidArgumentError(`by must be one of: ${[...BY_DIMS].join('|')}`);
            }
            const rows = collectJobRows(request, RANGE_MS[range]);
            const buckets = new Map();
            for (const r of rows) {
                const key = by === 'char'
                    ? (r.charDir ?? (r.groupId ? `group:${r.groupId}` : '?'))
                    : by === 'model'
                        ? (r.model || 'unknown')
                        : dayKey(r.createdAt);
                let bucket = buckets.get(key);
                if (!bucket) buckets.set(key, (bucket = []));
                bucket.push(r);
            }
            const groups = [...buckets.entries()]
                .map(([key, rs]) => ({ key, ...aggregateRows(rs) }))
                .sort((a, b) => b.generations - a.generations || a.key.localeCompare(b.key));
            return response.send({
                range, by,
                totals: aggregateRows(rows),
                groups,
                empty: rows.length === 0,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/stats summary');
        }
    });

    /** GET /by-char/:id —— 单卡游玩量/WI 命中。id = charDir|卡名(精确|部分唯一)。 */
    reg(`${P}/by-char/:id`, async function (request, response) {
        try {
            const resolved = await resolveCharDir(request.user.directories, request.params.id);
            if (!resolved) {
                return response.status(404).send({ error: `Character not found: ${request.params.id}` });
            }
            const { charDir, name } = resolved;
            const handle = request.user.profile.handle;

            // 楼层/活跃:chat repo 的 messageCount/updatedAt(同 /chats 面取数)
            let floors = 0, chats = 0, chatLast = 0;
            try {
                const repo = getChatRepo();
                const entries = await repo.listForCharacter(handle, charDir, { orderBy: 'name' });
                chats = entries.length;
                for (const entry of entries) {
                    const info = await repo.getInfo(handle, charDir, entry?.key?.name);
                    if (!info) continue;
                    floors += Number(info.messageCount ?? 0);
                    chatLast = Math.max(chatLast, Number(info.updatedAt ?? 0));
                }
            } catch { /* repo 读失败降级为 job-only 视图,不挡统计面 */ }

            const rows = collectJobRows(request, 0).filter((r) => r.charDir === charDir);
            // WI 命中:worldinfo inject 事件按 ctx.charDir 归户
            const wiMap = aggregateInjectEvents((e) => e.ctx?.charDir === charDir && e.code === 'worldinfo');
            const wi = wiMap.get('worldinfo');
            const wiEntries = wi ? [...wi.entries.values()].sort((a, b) => b.hits - a.hits || String(a.entry).localeCompare(String(b.entry))) : [];
            const lastActive = Math.max(chatLast, ...rows.map((r) => r.updatedAt), 0) || null;
            return response.send({
                charDir, name,
                chats,
                floors,
                generations: rows.length,
                failed: rows.filter((r) => r.failed).length,
                tokens: {
                    in: rows.reduce((s, r) => s + (r.tokensIn ?? 0), 0),
                    out: rows.reduce((s, r) => s + (r.tokensOut ?? 0), 0),
                },
                lastActive,
                wiHits: wi?.injectedTotal ?? 0,
                wiGenerations: wi?.events ?? 0,
                wiTop: wiEntries.slice(0, 10),
                empty: rows.length === 0 && floors === 0,
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/stats by-char');
        }
    });

    /**
     * GET /inject —— diag inject 事件按源聚合。
     * ?chat=<charDir>/<chat> 过滤到单会话;chat 段不带斜杠时 charDir 必填。
     * worldinfo 源额外挂 job.trace join 的 WI token 列(diagId 认亲)——
     * 「预算被谁吃掉」的读数;无 trace 可认时退 null,不虚报。
     */
    reg(`${P}/inject`, function (request, response) {
        try {
            let filter = null;
            let chatLabel = null;
            const chatParam = request.query?.chat;
            if (chatParam !== undefined && chatParam !== null && String(chatParam).trim() !== '') {
                const raw = String(chatParam).trim();
                const sep = raw.indexOf('/');
                if (sep < 0) {
                    throw new InvalidArgumentError('chat must be <charDir>/<chat>');
                }
                const charDir = raw.slice(0, sep);
                const chat = raw.slice(sep + 1).replace(/\.jsonl$/i, '');
                if (!charDir || !chat) {
                    throw new InvalidArgumentError('chat must be <charDir>/<chat>');
                }
                chatLabel = `${charDir}/${chat}`;
                filter = (e) => e.ctx?.charDir === charDir && e.ctx?.chatId === chat;
            }

            const byStage = aggregateInjectEvents(filter);

            // worldinfo token 占比:diagId → job(本 handle)→ trace.collections
            // 的 worldInfo* 段。preview/dry-run 事件无 job,自然落空不进分子。
            let wiEnrich = null;
            const wi = byStage.get('worldinfo');
            if (wi && wi.diagIds.length) {
                const rowsByDiag = new Map();
                for (const r of collectJobRows(request, 0)) {
                    if (r.diagId) rowsByDiag.set(r.diagId, r);
                }
                let wiTokSum = 0, wiTokN = 0, totalTokSum = 0;
                for (const diagId of wi.diagIds) {
                    const r = rowsByDiag.get(diagId);
                    if (!r) continue;
                    if (r.wiTokens != null) { wiTokSum += r.wiTokens; wiTokN++; }
                    if (r.tokensTotal != null) totalTokSum += r.tokensTotal;
                }
                wiEnrich = {
                    // 每代 WI 均摊 token(job trace 口径,非事件 tokens 字段)
                    tokensAvg: wiTokN ? round1(wiTokSum / wiTokN) : null,
                    tokensTotal: wiTokN ? wiTokSum : null,
                    tokenShare: wiTokN && totalTokSum ? Math.round((wiTokSum / totalTokSum) * 1000) / 1000 : null,
                    tokensBasis: wiTokN ? 'job-trace' : null,
                };
            }

            const sources = orderedStages(byStage).map((s) => stageOut(s, s.source === 'worldinfo' ? wiEnrich : null));
            return response.send({
                chat: chatLabel,
                events: sources.reduce((sum, s) => sum + s.events, 0),
                sources,
                empty: sources.every((s) => s.events === 0),
            });
        } catch (error) {
            return sendError(response, error, 'utopinn/stats inject');
        }
    });
}
