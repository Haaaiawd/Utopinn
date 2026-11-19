/**
 * diag-bus —— 服务端统一诊断/观测面:进程内事件总线(环形缓冲)。
 *
 *   emit({lvl, kind, code?, msg, ctx?, data?})
 *     lvl:  debug|info|warn|error
 *     kind: http|job|generate|inject|th|state|storage|plugin|ws|client
 *     code: 机读小标(http_404 / job_failed / worldinfo / th_unsupported…)
 *     msg:  单行人类可读摘要(≤512ch,正文永远不进这里)
 *     ctx:  指针袋 —— 只放行白名单标量(route/method/path/status/
 *           jobId/diagId/chatId/chatKey/charDir/groupId/verb/stage/
 *           source/plugin/scope/handle/endpoint/model/preset)。
 *           不放 prompt 正文、不放变量全表、不放 messages。
 *     data: 小对象,递归瘦身 —— 深≤4 层、数组≤50、字符串>2KB
 *           截断为 {$trunc:len, sha256:hash12, head:80ch}。
 *           WI 激活明细放 key+depth+position 级粒度;要正文走
 *           /jobs/:id 的 trace/sources 或 inspect。
 *
 *   query({kind,lvl,since,seq_gt,code,job,limit})
 *     lvl = 最低等级(errors 面 = lvl:'warn');job 匹配 ctx.jobId
 *     或 ctx.diagId(组装期事件比 job 先出生,靠 diagId 认亲)。
 *     返回按 seq 升序(旧→新)的尾 limit 条。
 *
 *   stats() → {capacity,size,seq,dropped,byKind,byLvl,oldest,newest}
 *
 * 容量默认 2000,UTOPINN_DIAG_CAPACITY 覆盖。纯内存、无持久化义务
 * —— 进程重启即清,长期归档是外部的事(Loki/文件落盘都挂 emit 侧)。
 */
import { createHash } from 'node:crypto';

const CAPACITY = Math.max(64, Number(process.env.UTOPINN_DIAG_CAPACITY) || 2000);
const MAX_QUERY = 2000;
const MAX_MSG = 512;
const MAX_FIELD = 2048;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const MAX_KEYS = 60;

export const DIAG_KINDS = new Set([
    'http', 'job', 'generate', 'inject', 'th',
    'state', 'storage', 'plugin', 'ws', 'client',
]);
export const DIAG_LVLS = new Set(['debug', 'info', 'warn', 'error']);
const LVL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

/** ctx 白名单:只放指针/枚举级标量。其他键静默丢弃(防塞大对象)。 */
const CTX_KEYS = new Set([
    'route', 'method', 'path', 'status',
    'jobId', 'diagId', 'chatId', 'chatKey', 'charDir', 'groupId',
    'verb', 'stage', 'source', 'plugin', 'scope', 'handle',
    'endpoint', 'model', 'preset',
]);

const buf = new Array(CAPACITY);
let seq = 0;
let size = 0;
let head = 0;      // 下一个写入位
let dropped = 0;   // 被挤出环的条数
const byKind = Object.create(null);
const byLvl = Object.create(null);

const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** data 瘦身:超形替换,不 throw。 */
function sanitize(v, depth = 0) {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'string') {
        return v.length > MAX_FIELD
            ? { $trunc: v.length, sha256: sha12(v), head: v.slice(0, 80) }
            : v;
    }
    if (t === 'number' || t === 'boolean') return Number.isFinite(v) || t === 'boolean' ? v : String(v);
    if (t === 'bigint') return String(v);
    if (v instanceof Error) return { name: v.name, message: String(v.message ?? '').slice(0, 400) };
    if (t !== 'object') return String(v).slice(0, 200);
    if (depth >= MAX_DEPTH) return '…';
    if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < Math.min(v.length, MAX_ARRAY); i++) {
            const s = sanitize(v[i], depth + 1);
            if (s !== undefined) out.push(s);
        }
        if (v.length > MAX_ARRAY) out.push(`…+${v.length - MAX_ARRAY}`);
        return out;
    }
    const out = {};
    let n = 0;
    for (const [k, val] of Object.entries(v)) {
        if (++n > MAX_KEYS) { out.$more = Object.keys(v).length - MAX_KEYS; break; }
        const s = sanitize(val, depth + 1);
        if (s !== undefined) out[k] = s;
    }
    return out;
}

function sanitizeCtx(ctx) {
    if (!ctx || typeof ctx !== 'object') return undefined;
    const out = {};
    for (const k of CTX_KEYS) {
        const v = ctx[k];
        if (v === undefined || v === null) continue;
        out[k] = (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
            ? v
            : String(v).slice(0, 120);
    }
    return Object.keys(out).length ? out : undefined;
}

/** 事件入环。同步、不 throw(调用方无须 try/catch)。 */
export function emit({ lvl = 'info', kind = 'plugin', code, msg, ctx, data } = {}) {
    try {
        if (!DIAG_LVLS.has(lvl)) lvl = 'info';
        if (!DIAG_KINDS.has(kind)) kind = 'plugin';
        const e = {
            seq: ++seq,
            ts: Date.now(),
            lvl,
            kind,
        };
        if (code !== undefined && code !== null) e.code = String(code).slice(0, 80);
        e.msg = String(msg ?? '').slice(0, MAX_MSG);
        const c = sanitizeCtx(ctx);
        if (c) e.ctx = c;
        if (data !== undefined) {
            const s = sanitize(data);
            if (s !== undefined) e.data = s;
        }
        buf[head] = e;
        head = (head + 1) % CAPACITY;
        if (size < CAPACITY) size++; else dropped++;
        byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        byLvl[e.lvl] = (byLvl[e.lvl] ?? 0) + 1;
        return e;
    } catch {
        return null; // 诊断面绝不炸业务路径
    }
}

function* iterate() {
    for (let i = 0; i < size; i++) {
        yield buf[(head - size + i + CAPACITY) % CAPACITY];
    }
}

/**
 * 过滤查询(旧→新,尾部截 limit)。
 * @param {object} f
 * @param {string} [f.kind]   精确 kind
 * @param {string} [f.lvl]    最低等级(warn = warn+error)
 * @param {string|number} [f.since] ts ms 或可 Date.parse 的串
 * @param {number} [f.seq_gt] 增量拉取:只看 seq > N
 * @param {string} [f.code]   精确 code
 * @param {string} [f.job]    ctx.jobId === job 或 ctx.diagId === job
 * @param {number} [f.limit=200]
 */
export function query({ kind, lvl, since, seq_gt, code, job, limit = 200 } = {}) {
    const minRank = lvl ? (LVL_RANK[lvl] ?? 0) : -1;
    const sinceTs = since !== undefined && since !== null && since !== ''
        ? (Number(since) || Date.parse(String(since)) || 0)
        : 0;
    const seqGt = Number(seq_gt) || 0;
    const lim = Math.max(1, Math.min(Number(limit) || 200, MAX_QUERY));
    const jobStr = job !== undefined && job !== null ? String(job) : null;
    const out = [];
    for (const e of iterate()) {
        if (!e) continue;
        if (kind && e.kind !== kind) continue;
        if (minRank >= 0 && (LVL_RANK[e.lvl] ?? 0) < minRank) continue;
        if (sinceTs && e.ts < sinceTs) continue;
        if (seqGt && e.seq <= seqGt) continue;
        if (code && String(e.code ?? '') !== String(code)) continue;
        if (jobStr && !(e.ctx && (e.ctx.jobId === jobStr || e.ctx.diagId === jobStr))) continue;
        out.push(e);
    }
    return out.slice(-lim);
}

export function stats() {
    const oldest = size ? buf[(head - size + CAPACITY) % CAPACITY] : null;
    const newest = size ? buf[(head - 1 + CAPACITY) % CAPACITY] : null;
    return {
        capacity: CAPACITY,
        size,
        seq,
        dropped,
        byKind: { ...byKind },
        byLvl: { ...byLvl },
        oldest: oldest?.ts ?? null,
        newest: newest?.ts ?? null,
    };
}

export const diagBus = { emit, query, stats };
