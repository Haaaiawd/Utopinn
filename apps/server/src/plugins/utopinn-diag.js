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
 *   GET  /api/utopinn/diag/stats     各 kind/lvl 计数 + 环形缓冲水位
 *   POST /api/utopinn/diag/client    前端/WebView/CLI 上报自己的错误进总线
 *   GET  /api/utopinn/diag/jobs/:id/trace
 *                                  聚合回放:job 详情 + trace/sources/perf
 *                                  + inject 时序 + 相关事件(jobId∪diagId
 *                                  双键认亲——组装事件比 job 先出生)。
 */
import { emit, query as diagQuery, stats as diagStats, DIAG_KINDS, DIAG_LVLS } from '../services/diag-bus.js';
import { getGenerationJobForRequest } from '../endpoints/backends/luker-generation.js';

export const inject = ['webServer', 'catalog'];

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
        return response.send(diagStats());
    });

    // 客户端上报面:CardApp WebView / 浏览器 / CLI 自己的错误进总线。
    // lvl/kind 白名单校验(默认 warn/client);调用方的 ctx 塞进 data.ctx
    // —— ctx 白名单只放服务端指针,客户端自由键不污染检索面。
    reg('POST', `${P}/client`, function (request, response) {
        const body = request.body ?? {};
        const lvl = DIAG_LVLS.has(body.lvl) ? body.lvl : 'warn';
        const kind = DIAG_KINDS.has(body.kind) ? body.kind : 'client';
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
            perf: job.perf ?? null,
            promptMessages: job.promptMessages ?? null,
            timedWorldInfo: job.timedWorldInfo ?? null,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
            injections,
            events,
        });
    });
}
