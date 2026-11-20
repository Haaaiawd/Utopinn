/**
 * utopinn-diag —— kernel 自诊断面(B 步自证插件)+ 统一观测面。
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
 * UI 贡献声明(ui.contrib,§C-12 协议样板):本插件供 panel.type 'diag' 板块
 * —— GET /api/utopinn/ui/contrib 会把它与 BUILTIN_CONTRIB 映射去重合并。
 */
import { createHash } from 'node:crypto';
import { emit, query as diagQuery, stats as diagStats, DIAG_KINDS, DIAG_LVLS } from '../services/diag-bus.js';
import { getGenerationJobForRequest } from '../endpoints/backends/luker-generation.js';

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

    reg('GET', `${P}/events`, function (request, response) {
        return response.send(eventsReply(request.query ?? {}));
    });

    reg('GET', `${P}/errors`, function (request, response) {
        return response.send(eventsReply({ ...(request.query ?? {}), lvl: 'warn' }));
    });

    reg('GET', `${P}/stats`, function (_request, response) {
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
}
