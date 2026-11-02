#!/usr/bin/env node
// diff-golden.mjs — golden 比对器(D-004 阈值):
//   致命 = LLM 消息序列不等(role+content)
//   重要 = WI 注入条目增删/位置不同
//   可忍 = 白名单字段(时间戳/gen_id/同优先级顺序/空白差异)
// 用法: node diff-golden.mjs <golden.json> <actual.json> [--verbose]
// golden 由 capture-golden.mjs 产;actual 由新 core/服务端管线产(同形 wireRequest)。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [gPath, aPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');

const load = (p) => JSON.parse(readFileSync(resolve(p), 'utf8'));
const golden = load(gPath);
const actual = load(aPath);

// ---------- 白名单归一化 ----------
const tsRe = /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b/g;
const idRe = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bgen[_-]?id[:=]?\s*\S+|"[a-zA-Z_]*[Ii]d"\s*:\s*"[^"]*"/g;
const wsRe = /[ \t]+|\r\n?/g;
function normalize(s) {
    if (typeof s !== 'string') s = JSON.stringify(s);
    return s.replace(tsRe, '<TS>').replace(idRe, '<ID>').replace(wsRe, ' ').trim();
}

// ---------- 消息序列比对(致命) ----------
const gMsgs = (golden.wireRequests?.[0]?.messages ?? actual.messages ? golden.messages : []) || [];
const aMsgs = actual.wireRequests?.[0]?.messages ?? actual.messages ?? [];

const fatal = [], important = [], tolerated = [];

const n = Math.max(gMsgs.length, aMsgs.length);
for (let i = 0; i < n; i++) {
    const g = gMsgs[i], a = aMsgs[i];
    if (g === undefined) { fatal.push(`[${i}] 实际多出消息 role=${a.role} len=${a.content?.length}`); continue; }
    if (a === undefined) { fatal.push(`[${i}] 缺失消息 role=${g.role} len=${g.content?.length}`); continue; }
    if (g.role !== a.role) { fatal.push(`[${i}] role 不同: ${g.role} vs ${a.role}`); continue; }
    const gc = typeof g.content === 'string' ? g.content : JSON.stringify(g.content);
    const ac = typeof a.content === 'string' ? a.content : JSON.stringify(a.content);
    if (gc === ac) continue;
    if (normalize(gc) === normalize(ac)) { tolerated.push(`[${i}] ${g.role} 内容仅白名单差异`); continue; }
    fatal.push(`[${i}] ${g.role} 内容不等\n    golden: ${JSON.stringify(gc.slice(0, 120))}\n    actual: ${JSON.stringify(ac.slice(0, 120))}`);
}

// ---------- WI 注入轨迹(重要) ----------
// golden 里 WI 注入的可识别形态:content 中嵌入的世界书条目文本块。
// v1 近似:对每条 system/user 消息,与卡内世界书 entry.content 做包含匹配,
// 重建注入列表再比序。后续用 inspector.trace 精确替代。
function wiTrace(msgs, book) {
    if (!book?.entries) return [];
    const entries = Object.values(book.entries);
    const out = [];
    msgs.forEach((m, i) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        for (const e of entries) {
            if (e.content && e.content.length > 20 && c.includes(e.content))
                out.push({ msg: i, comment: e.comment || (e.key || [])[0], position: e.position });
        }
    });
    return out;
}
const book = golden.cardBook ?? null; // 捕获器后续可补 cardBook 字段
const gT = wiTrace(gMsgs, book), aT = wiTrace(aMsgs, book);
if (JSON.stringify(gT) !== JSON.stringify(aT)) {
    const gs = new Set(gT.map(t => `${t.msg}:${t.comment}`));
    const as = new Set(aT.map(t => `${t.msg}:${t.comment}`));
    for (const t of gT) if (!as.has(`${t.msg}:${t.comment}`)) important.push(`WI 缺失: msg${t.msg} ${t.comment}`);
    for (const t of aT) if (!gs.has(`${t.msg}:${t.comment}`)) important.push(`WI 多出: msg${t.msg} ${t.comment}`);
    if (!important.length) important.push('WI 条目相同但顺序/位置不同');
}

// ---------- 判定 ----------
const verdict = fatal.length ? 'FATAL' : important.length ? 'IMPORTANT' : tolerated.length ? 'TOLERATED' : 'PASS';
console.log(JSON.stringify({
    verdict,
    fatal: fatal.length, important: important.length, tolerated: tolerated.length,
    msgs: { golden: gMsgs.length, actual: aMsgs.length },
    details: verbose ? { fatal, important, tolerated } : { fatal: fatal.slice(0, 5), important: important.slice(0, 5) },
}, null, 1));
process.exit(verdict === 'PASS' || verdict === 'TOLERATED' ? 0 : 1);
