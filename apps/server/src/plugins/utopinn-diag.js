/**
 * utopinn-diag —— kernel 自诊断面 + 统一观测面(原 utopinn-diag +
 * utopinn-stats 合并,plugin-domain-map §2.2:同源 job store/diag-bus/
 * inspector,同消费者观测面板与 CLI logs/stats 动词,读模型一体)。
 *
 * GET /api/utopinn/_kernel → {routes, services}
 *   routes:   webServer.list()     当前注册的全部 HTTP/upgrade 位
 *   services: catalog.list()       ServiceCatalog(谁提供了什么)
 *
 * 观测面(diag-bus.js 环形缓冲,凝练契约见该文件头):
 *   GET  /api/utopinn/diag/events    query 过滤:kind/lvl(最低)/since/
 *                                  seq_gt/code/job/limit → {items,count,seq,size}
 *   GET  /api/utopinn/diag/errors    = events lvl≥warn 的快捷面
 *   GET  /api/utopinn/diag/stats     缓冲水位 + 窗口总览(events 按 kind /
 *                                  errors 按 domain=kind / since=窗口起点)
 *   POST /api/utopinn/diag/client    前端/WebView/CLI 上报自己的错误进总线
 *                                  (lvl/kind 枚举收紧:传了就必须合法,
 *                                   非法 → 400,不静默吞回默认档)
 *   GET  /api/utopinn/diag/jobs/:id/trace
 *                                  聚合回放:job 详情 + trace/sources/perf
 *                                  + inject 时序 + 相关事件(jobId∪diagId
 *                                  双键认亲——组装事件比 job 先出生)。
 *                                  promptMessages 走瘦身契约:串 >2KB →
 *                                  {$trunc:len, sha256, head},全文面在
 *                                  GET /api/utopinn/jobs/:id。
 *
 * 生成/注入聚合统计(原 utopinn-stats):
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
 *
 * UI 贡献声明(ui.contrib,§C-12 协议样板):本插件供 panel.type 'diag' 板块
 * —— GET /api/utopinn/ui/contrib 会把它与 BUILTIN_CONTRIB 映射去重合并。
 * (stats 面板贡献在 BUILTIN_CONTRIB['utopinn-diag'] 与 diag 并列。)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { emit, query as diagQuery, stats as diagStats, DIAG_KINDS, DIAG_LVLS } from '../services/diag-bus.js';
import { listGenerationJobsForRequest, getGenerationJobForRequest } from '../endpoints/backends/luker-generation.js';
import { getBufferForHandle } from '../request-inspector.js';
import { getChatRepo } from '../storage/index.js';
import { InvalidArgumentError } from '../storage/errors.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { safeName, sendError } from './_shared/http-utils.js';

export const inject = ['webServer', 'catalog'];

/** §C-12 manifest:插件 UI 贡献点声明(面板 Body 是前端本地组件,这里只供归属)。 */
export const ui = {
    contrib: [
        { slot: 'panel.type', contribution: { type: 'diag', icon: 'code', wired: true, badge: 'diag', category: 'system', desc: 'panel.desc.diag' } },
    ],
};

const MAX_STATS_SCAN = 2000;   // diag-query 上限;环容量更大时窗口覆盖尾部 2000 条
const PM_MAX_FIELD = 2048;     // promptMessages 单串截断阈(与 diag-bus MAX_FIELD 同值)
const PM_MAX_DEPTH = 4;

const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

function eventsReply(query) {
    const items = diagQuery({
        kind: query?.kind,
        lvl: query?.lvl,
        since: query?.since,
        seq_gt: query?.seq_gt,
        code: query?.code,
        job: query?.job,
        limit: query?.limit,
    });
    const st = diagStats();
    return { items, count: items.length, seq: st.seq, size: st.size };
}

/**
 * promptMessages 瘦身 —— 与 diag-bus sanitize 同契约:串 >2KB 换成
 * {$trunc:len, sha256:hash12, head:80ch}。数组不截断:组装回放要保序,
 * 体量由 chat 窗口天然封顶;messages 全文走 GET /api/utopinn/jobs/:id。
 */
function slimPrompt(value, depth = 0) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'string') {
        return value.length > PM_MAX_FIELD
            ? { $trunc: value.length, sha256: sha12(value), head: value.slice(0, 80) }
            : value;
    }
    if (t !== 'object') return value;
    if (depth >= PM_MAX_DEPTH) return '…';
    if (Array.isArray(value)) return value.map((x) => slimPrompt(x, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        const s = slimPrompt(v, depth + 1);
        if (s !== undefined) out[k] = s;
    }
    return out;
}

/** job → 相关事件:jobId 与 diagId 双键合并(diagId === jobId 时单查),按 seq 归序。 */
function relatedEvents(job) {
    const bySeq = new Map();
    for (const e of diagQuery({ job: job.id, limit: 500 })) bySeq.set(e.seq, e);
    if (job.diagId && job.diagId !== job.id) {
        for (const e of diagQuery({ job: job.diagId, limit: 500 })) bySeq.set(e.seq, e);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// 生成/注入聚合统计(原 utopinn-stats.js —— job 行归一化与聚合机)
// ---------------------------------------------------------------------------

const P_STATS = '/api/utopinn/stats';

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

export function apply(ctx) {
    const ws = ctx.webServer;
    const reg = (method, path, handler) => ctx.effect(() => ws.register({ kind: 'pattern', method, path, handler }));
    const P = '/api/utopinn/diag';

    ctx.effect(() => ws.register({
        kind: 'exact',
        method: 'GET',
        path: '/api/utopinn/_kernel',
        handler: function (_request, response) {
            return response.send({
                routes: ctx.webServer.list(),
                services: ctx.catalog.list(),
            });
        },
    }));

    // 读面 admin 闸:事件 ctx 含 handle/charDir/route,多用户部署下不闸即
    // 跨用户元数据泄漏(与 /plugins|/ui/contrib 同构)。单机自用无感。
    const adminOnly = (request, response) => {
        if (!request.user?.profile?.admin) {
            response.status(403).send({ error: 'Unauthorized' });
            return false;
        }
        return true;
    };

    reg('GET', `${P}/events`, function (request, response) {
        if (!adminOnly(request, response)) return;
        return response.send(eventsReply(request.query ?? {}));
    });

    reg('GET', `${P}/errors`, function (request, response) {
        if (!adminOnly(request, response)) return;
        return response.send(eventsReply({ ...(request.query ?? {}), lvl: 'warn' }));
    });

    reg('GET', `${P}/stats`, function (request, response) {
        if (!adminOnly(request, response)) return;
        const st = diagStats();
        // 窗口总览:环内现存事件按 kind 计数(events)+ warn+ 按 domain 计数
        // (errors 面同口径 lvl≥warn;domain=kind —— 前端 ERR_DOMAINS 词表即
        // kind)。since = 窗口起点(环内最老一条 ts);两口径并存:顶层
        // byKind/byLvl 仍是生命周期累计(events 入环即计,不随挤出回收)。
        const byKind = Object.create(null);
        const byDomain = Object.create(null);
        let errTotal = 0;
        const live = diagQuery({ limit: MAX_STATS_SCAN });
        for (const e of live) {
            byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
            if (e.lvl === 'warn' || e.lvl === 'error') {
                byDomain[e.kind] = (byDomain[e.kind] ?? 0) + 1;
                errTotal++;
            }
        }
        return response.send({
            ...st,
            events: { total: live.length, byKind },
            errors: { total: errTotal, byDomain },
            since: st.oldest,
        });
    });

    // 客户端上报面:CardApp WebView / 浏览器 / CLI 自己的错误进总线。
    // lvl/kind 白名单校验(缺省 warn/client)——传了就必须合法,非法 400;
    // 调用方的 ctx 塞进 data.ctx —— ctx 白名单只放服务端指针,客户端自由
    // 键不污染检索面。
    reg('POST', `${P}/client`, function (request, response) {
        const body = request.body ?? {};
        if (body.kind !== undefined && body.kind !== null && !DIAG_KINDS.has(body.kind)) {
            return response.status(400).send({ error: `invalid kind: ${String(body.kind)}`, kinds: [...DIAG_KINDS] });
        }
        if (body.lvl !== undefined && body.lvl !== null && !DIAG_LVLS.has(body.lvl)) {
            return response.status(400).send({ error: `invalid lvl: ${String(body.lvl)}`, lvls: [...DIAG_LVLS] });
        }
        const lvl = body.lvl ?? 'warn';
        const kind = body.kind ?? 'client';
        const e = emit({
            lvl,
            kind,
            code: body.code,
            msg: String(body.msg ?? 'client report'),
            ctx: { source: 'client', route: '/api/utopinn/diag/client' },
            data: { ctx: body.ctx, data: body.data, ua: request.headers?.['user-agent'] },
        });
        return response.send({ ok: true, seq: e?.seq ?? null });
    });

    reg('GET', `${P}/jobs/:id/trace`, function (request, response) {
        const job = getGenerationJobForRequest(request, request.params.id);
        if (!job) {
            return response.status(404).send({ error: 'Job not found.' });
        }
        const events = relatedEvents(job);
        const injections = events
            .filter((e) => e.kind === 'inject')
            .map((e) => ({ ts: e.ts, seq: e.seq, stage: e.ctx?.stage ?? e.code ?? null, ...(e.data ?? {}) }));
        return response.send({
            id: job.id,
            status: job.status,
            verb: job.requestMeta?.verb ?? null,
            model: job.modelName || job.requestMeta?.model || '',
            chatKey: job.chatKey ?? null,
            diagId: job.diagId ?? null,
            text: job.text ?? '',
            error: job.error || null,
            persisted: Boolean(job.persisted),
            lastSeq: job.lastSeq ?? 0,
            eventCount: Array.isArray(job.events) ? job.events.length : 0,
            trace: job.trace ?? null,
            sources: job.sources ?? null,
            // totalMs = 组装全程耗时(含卡加载);perf 块在但缺键的老 job 给 null 占位,
            // 消费方不用判 hasOwnProperty。
            perf: job.perf ? { totalMs: null, ...job.perf } : null,
            promptMessages: job.promptMessages ? slimPrompt(job.promptMessages) : null,
            timedWorldInfo: job.timedWorldInfo ?? null,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
            injections,
            events,
        });
    });

    // ------------------------------------------------------------------
    // 聚合统计路由(原 utopinn-stats;读面按 handle 切数据,不设 admin 闸——
    // job store 本就以 request.user 为边界)
    // ------------------------------------------------------------------

    /** GET /stats/summary —— jobs 聚合:范围窗口 × 维度分组。 */
    reg('GET', `${P_STATS}/summary`, function (request, response) {
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

    /** GET /stats/by-char/:id —— 单卡游玩量/WI 命中。id = charDir|卡名(精确|部分唯一)。 */
    reg('GET', `${P_STATS}/by-char/:id`, async function (request, response) {
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
     * GET /stats/inject —— diag inject 事件按源聚合。
     * ?chat=<charDir>/<chat> 过滤到单会话;chat 段不带斜杠时 charDir 必填。
     * worldinfo 源额外挂 job.trace join 的 WI token 列(diagId 认亲)——
     * 「预算被谁吃掉」的读数;无 trace 可认时退 null,不虚报。
     */
    reg('GET', `${P_STATS}/inject`, function (request, response) {
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
