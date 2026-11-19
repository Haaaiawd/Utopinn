#!/usr/bin/env node
/**
 * uberge — Uberge 服务端大脑的命令行薄客户端(agent-first 设计)。
 * 规格:.loom/capabilities/cli-client/capability.md(唯一契约,先读它)。
 * 零依赖:Node ≥22 原生 fetch + WebSocket。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const VERSION = '0.2.0';
const DEFAULT_SERVER = 'http://127.0.0.1:8000';
const DEFAULT_WAIT_MS = 180_000;
const DEFAULT_REQ_TIMEOUT = 30_000;

// ═══ argv ═══
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-s' || a === '--server') flags.server = argv[++i];
    else if (a === '--state') flags.state = argv[++i];
    else if (a === '--json') flags.json = true;
    else if (a === '--stream') flags.stream = true;
    else if (a === '--quiet') flags.quietMode = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--stdin' || a === '-') flags.stdin = true;
    else if (a === '--no-stream') flags.noStream = true;
    else if (a === '--write') flags.write = true;
    else if (a === '--list') flags.list = true;
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--section') flags.section = argv[++i];
    else if (a === '--from') flags.fromSeq = Number(argv[++i]);
    else if (a === '--wait') flags.wait = Number(argv[++i]);
    else if (a === '--timeout') flags.reqTimeout = Number(argv[++i]);
    else if (a === '--floor') flags.floor = Number(argv[++i]);
    else if (a === '--user') flags.user = argv[++i];
    else if (a === '--preset') flags.preset = argv[++i];
    else if (a === '--off') flags.off = true;
    else if (a === '--desc') flags.desc = argv[++i];
    else if (a === '--type') flags.type = argv[++i];
    else if (a === '--empty') flags.empty = true;
    else if (a === '--char') flags.char = argv[++i];
    else if (a === '--set') {
        const kv = String(argv[++i]).split('=');
        const raw = kv.slice(1).join('=');
        let v = raw;
        if (raw === 'true') v = true;
        else if (raw === 'false') v = false;
        else if (raw !== '' && !Number.isNaN(Number(raw))) v = Number(raw);
        else if (raw.startsWith('{') || raw.startsWith('[')) { try { v = JSON.parse(raw); } catch { } }
        (flags.set ??= {})[kv[0]] = v;
    }
    else if (a === '-n') flags.n = Number(argv[++i]);
    else positional.push(a);
}
const CMD = positional[0];
if (process.env.UBERGE_JSON === '1') flags.json = true;

// ═══ state(唯一事实源,凭证零落盘)═══
const STATE_PATH = resolve(flags.state || process.env.UBERGE_STATE || `${homedir()}/.uberge-cli.json`);
function loadState() {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
const state = loadState();
function saveState(patch) {
    const next = { ...state, ...patch, version: 1 };
    try {
        writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
        Object.assign(state, next);
    } catch (e) {
        warn(`state write failed: ${e.message}`);
    }
}
function ring(cmd, rc, extra = {}) {
    const recent = [...(state.recent ?? []), { t: Date.now(), cmd, rc, ...extra }].slice(-10);
    try {
        const next = { ...loadState(), recent };
        writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
        state.recent = recent;
    } catch { /* 环不进状态不致命 */ }
}

const SERVER = (flags.server || process.env.UBERGE_SERVER || state.server || DEFAULT_SERVER).replace(/\/+$/, '');
saveState({ server: SERVER });
const isLoopback = /^https?:\/\/(127\.|localhost|\[?::1\]?)/.test(SERVER);
if (!isLoopback) warn('non-loopback server — 未测远端/无登录面,建议 SSH tunnel 或白名单');

// ═══ 输出层 ═══
const JSON_MODE = Boolean(flags.json);
const warn = (m) => { if (!JSON_MODE) process.stderr.write(`\x1b[2m[cli] ${m}\x1b[0m\n`); };
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…+${s.length - n}ch` : s; };
function ctxSummary() {
    return {
        server: SERVER,
        charDir: state.char?.dir ?? null, charName: state.char?.name ?? null,
        chatName: state.chat?.name ?? null,
        floors: state.floors ?? null, integrity: state.integrity ?? null,
        persona: state.persona ?? null, preset: state.preset ?? null,
        job: state.lastJob ? { id: state.lastJob.id, status: state.lastJob.status, type: state.lastJob.type } : null,
    };
}
let exitCode = 0;
let nextHints = [];
const next = (...items) => { nextHints.push(...items.map(x => typeof x === 'string' ? { cmd: x, why: '' } : x)); };
function footer(extra = '') {
    if (JSON_MODE) return;
    const c = ctxSummary();
    const seg = [
        c.charName ? `${c.charName} @ ${c.chatName ?? '?'}` : null,
        c.floors != null ? `floors ${c.floors}` : null,
        c.job ? `job ${String(c.job.id).slice(0, 8)}:${c.job.status}` : null,
        extra || null,
    ].filter(Boolean).join(' · ');
    if (seg) console.log(`\n\x1b[2m── ${seg}\x1b[0m`);
    if (nextHints.length) console.log(`\x1b[2m· next: ${nextHints.map(n => n.cmd).join(' · ')}\x1b[0m`);
}
function out(data, nexts = []) {
    nextHints = nexts;
    if (JSON_MODE) {
        console.log(JSON.stringify({ ok: true, cmd: CMD, data, ctx: ctxSummary(), next: nexts }));
    }
    return data;
}
function fail(code, message, { status, detail, hint, nexts = [], rc = 1 } = {}) {
    exitCode = rc;
    ring(CMD ?? '?', rc, { err: code });
    if (JSON_MODE) {
        console.log(JSON.stringify({ ok: false, cmd: CMD ?? null, error: { code, message, status, detail, hint }, ctx: ctxSummary(), next: nexts }));
    } else {
        console.error(`\x1b[31merror[${code}]\x1b[0m ${message}`);
        if (detail) console.error(`\x1b[2m  ${trunc(typeof detail === 'string' ? detail : JSON.stringify(detail), 300)}\x1b[0m`);
        if (hint) console.error(`\x1b[2m  hint: ${hint}\x1b[0m`);
        if (nexts.length) console.error(`\x1b[2m  · next: ${nexts.map(n => n.cmd).join(' · ')}\x1b[0m`);
    }
    return null;
}
const needCtx = () => {
    if (!state.char?.dir || !state.chat?.name) {
        fail('no_ctx', 'no active char/chat', { hint: 'uberge use <char> [chat]', nexts: [{ cmd: 'uberge chars', why: '挑一张卡' }], rc: 2 });
        return null;
    }
    return { charDir: state.char.dir, chatName: state.chat.name, charName: state.char.name };
};

// ═══ 会话(CSRF+cookie 内存态)═══
let csrf = '', cookie = '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function session() {
    if (csrf) return;
    const r = await fetch(`${SERVER}/csrf-token`, { signal: AbortSignal.timeout(flags.reqTimeout ?? DEFAULT_REQ_TIMEOUT) });
    if (!r.ok) throw Object.assign(new Error(`csrf-token ${r.status}`), { code: 'session', status: r.status });
    csrf = (await r.json()).token;
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    cookie = sc.map(c => c.split(';')[0]).join('; ');
}
async function req(method, path, body, { allowFail = false, timeout, _reauthed = false } = {}) {
    await session();
    const r = await fetch(`${SERVER}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout ?? flags.reqTimeout ?? DEFAULT_REQ_TIMEOUT),
    });
    // 会话过期(服务端重启/cookie 轮换)→ 重握手一次重试
    if ((r.status === 401 || r.status === 403) && !_reauthed) {
        csrf = ''; cookie = '';
        return req(method, path, body, { allowFail, timeout, _reauthed: true });
    }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok && !allowFail) {
        const e = new Error(`${method} ${path} → ${r.status}: ${trunc(text, 200)}`);
        e.status = r.status; e.data = data;
        if (r.status === 401 || r.status === 403) e.code = 'session';
        else if (r.status === 404) e.code = 'not_found';
        else if (r.status === 409) e.code = 'integrity_conflict';
        else if (r.status >= 500) e.code = 'server';
        else e.code = 'server';
        throw e;
    }
    return { data, status: r.status, headers: r.headers };
}

// ═══ 实体面 ═══
const stripExt = (s, ext) => String(s ?? '').replace(new RegExp(`\\.${ext}$`, 'i'), '');
async function listChars() {
    const { data } = await req('POST', '/api/characters/all');
    return Array.isArray(data) ? data : [];
}
async function listChats(charDir, { simple = false } = {}) {
    const { data } = await req('POST', '/api/characters/chats', { avatar_url: `${charDir}.png`, simple });
    return Array.isArray(data) ? data : [];
}
async function getChat(charDir, chatName) {
    const { data } = await req('POST', '/api/chats/get', { avatar_url: `${charDir}.png`, file_name: `${chatName}.jsonl` });
    return data; // [header, ...floors] | {new_chat:true} | {corrupted:true}
}
async function resolveChar(fuzzy) {
    const chars = await listChars();
    const name = stripExt(String(fuzzy ?? ''), 'png');
    const exact = chars.find(c => stripExt(c.avatar, 'png') === name || c.name === name);
    if (exact) return exact;
    const partial = chars.filter(c => stripExt(c.avatar, 'png').includes(name) || c.name?.includes(name));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
        fail('ambiguous', `"${name}" matches ${partial.length} chars`, { detail: partial.map(c => stripExt(c.avatar, 'png')).join(' | '), hint: '用更长的名或目录名' });
        return null;
    }
    fail('not_found', `character not found: "${name}"`, { detail: chars.map(c => stripExt(c.avatar, 'png')).slice(0, 12).join(' | '), hint: `共 ${chars.length} 张,uberge chars 看全表` });
    return null;
}
async function resolveChatForUse(charDir, fuzzy, charChat) {
    const chats = await listChats(charDir);
    const names = chats.map(c => stripExt(c.file_name ?? c.name ?? c, 'jsonl'));
    if (!fuzzy) {
        // char.chat 指针优先(与服务端「当前聊天」一致);其次 sort_time 最新
        // ——服务端按 name 排序返回,names.at(-1) 是字典序不是最新,别用
        if (charChat && names.includes(stripExt(charChat, 'jsonl'))) return stripExt(charChat, 'jsonl');
        if (chats.length) {
            const newest = chats.reduce((a, c) => (Number(c?.sort_time ?? 0) > Number(a?.sort_time ?? 0) ? c : a), chats[0]);
            return stripExt(newest?.file_name ?? newest?.name ?? names[0], 'jsonl');
        }
        fail('not_found', `no chats for ${charDir}`, { hint: 'uberge chat-new <name> 建一个' });
        return null;
    }
    const name = stripExt(fuzzy, 'jsonl');
    const exact = names.find(n => n === name);
    if (exact) return exact;
    const partial = names.filter(n => n.includes(name));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
        fail('ambiguous', `chat "${name}" ambiguous`, { detail: partial.join(' | ') });
        return null;
    }
    // 铁律12:不许隐式建聊天——typo 不该变新文件
    fail('not_found', `chat not found: "${name}"`, { detail: names.slice(0, 10).join(' | '), hint: '新聊天用 uberge chat-new <name>' });
    return null;
}

// ═══ 写盘(uberge REST:append=POST messages / patch=PATCH chat)═══
// TASK-032:写盘面已统一进 uberge fiber——ack/integrity/gen-id/settle 与 legacy 同机制。
// patch 的 op path 用 /body/<i> 命名空间(uberge doc = {header, body:[]})。
async function writeOp(op, body, { retried = false } = {}) {
    const { charDir, chatName } = needCtx();
    const base = `/api/uberge/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`;
    const isAppend = op === 'append';
    const path = isAppend ? `${base}/messages` : base;
    const payload = isAppend
        ? { messages: body.messages, ...(body.luker_generation_id ? { luker_generation_id: body.luker_generation_id } : {}) }
        : { ops: body.operations ?? body.ops, ...(body.luker_generation_id ? { luker_generation_id: body.luker_generation_id } : {}) };
    if (!flags.force && state.integrity) payload.integrity = state.integrity;
    try {
        const { data } = await req(isAppend ? 'POST' : 'PATCH', path, payload);
        if (data?.integrity) saveState({ integrity: data.integrity });
        return data;
    } catch (e) {
        // 409 分两种:integrity CAS(可重锚重试)vs patch op 冲突(重试无用)。
        // uberge ConflictError 回 {error:'integrity_mismatch', actual}——直接拿 actual 重锚。
        const isIntegrity409 = e.status === 409 && /integrity/i.test(JSON.stringify(e.data ?? '') + e.message);
        if (isIntegrity409 && !retried && !flags.force) {
            warn('integrity 409 — 重锚后重试一次');
            const fresh = String(e.data?.actual || '') || (await getChat(charDir, chatName))?.[0]?.chat_metadata?.integrity || '';
            if (fresh) saveState({ integrity: fresh });
            payload.integrity = fresh;
            const { data } = await req(isAppend ? 'POST' : 'PATCH', path, payload);
            if (data?.integrity) saveState({ integrity: data.integrity });
            return data;
        }
        throw e;
    }
}
const appendFloors = (messages, extra = {}) => writeOp('append', { messages, ...extra });
const patchFloors = (operations, extra = {}) => writeOp('patch', { operations, ...extra });

const isoNow = () => new Date().toISOString();
function assistantFloor({ charName, text, jobId, model, genStarted, genFinished }) {
    return {
        name: charName, is_user: false, is_system: false,
        send_date: isoNow(), mes: text,
        gen_started: genStarted ?? isoNow(), gen_finished: genFinished ?? isoNow(),
        extra: { api: 'cli', model: model ?? '', ...(jobId ? { luker_generation_id: jobId } : {}) },
    };
}
function userFloor({ persona, text }) {
    return { name: persona ?? 'User', is_user: true, is_system: false, send_date: isoNow(), mes: text };
}

// ═══ active-job 护栏(写盘/POST 前必查)═══
async function checkNoActiveJob(charDir, chatName) {
    const { data } = await req('POST', '/api/backends/chat-completions/jobs/active', {
        persist_target: { avatar_url: `${charDir}.png`, file_name: `${chatName}.jsonl` },
    }, { allowFail: true });
    const jobs = Array.isArray(data?.jobs) ? data.jobs : (Array.isArray(data) ? data : []);
    const active = jobs.find(j => ['running', 'queued', 'persisting', 'awaiting_ack'].includes(j.status));
    if (active) {
        fail('active_job', `chat has active job ${active.id}`, {
            detail: `status=${active.status}`,
            hint: '等它完,或恢复/中止',
            nexts: [{ cmd: `uberge attach ${active.id}` }, { cmd: `uberge abort ${active.id}` }],
            rc: 3,
        });
        return active.id;
    }
    return null;
}

// ═══ 生成引擎(POST → ticket → WS resume → 帧 → 写盘 → 状态轮询)═══
function parseSSEDelta(line) {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { done: true };
    try {
        const j = JSON.parse(payload);
        if (j.luker) return { luker: j.luker };
        const d = j.choices?.[0]?.delta ?? j.choices?.[0]?.message ?? {};
        const delta = d.content ?? j.choices?.[0]?.text ?? '';
        const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : '';
        return (delta || reasoning) ? { delta, reasoning } : null;
    } catch { return null; }
}

async function wsTicket() {
    const { data } = await req('POST', '/api/ws-ticket', {});
    return data.ticket;
}

async function streamJob(jobId, { onDelta, onReasoning, fromSeq = 1, waitMs = DEFAULT_WAIT_MS } = {}) {
    // 返回 { streamed, frames, error?, tailLuker }
    const result = { streamed: '', reasoned: '', frames: { head: 0, chunk: 0, end: 0, error: 0 }, error: null, tailLuker: null, lastSeq: 0 };
    let sseBuf = '';
    let ws;
    let doneResolve;
    const done = new Promise(r => { doneResolve = r; });

    const connect = async (seq) => {
        const ticket = await wsTicket();
        ws = new WebSocket(`${SERVER.replace(/^http/, 'ws')}/api/ws-delivery`, `luker-ws-ticket.${ticket}`);
        await new Promise((res, rej) => {
            const to = setTimeout(() => rej(new Error('ws open timeout')), 10_000);
            ws.onopen = () => {
                clearTimeout(to);
                ws.send(JSON.stringify({ type: 'resume', request_id: jobId, from_seq: seq }));
                res();
            };
            ws.onerror = () => { clearTimeout(to); rej(new Error('ws connect failed')); };
        });
        ws.onmessage = (evt) => {
            let f; try { f = JSON.parse(String(evt.data)); } catch { return; }
            if (f.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong', ts: f.ts })); } catch { /* dying */ } return; }
            if (f.request_id !== jobId) return;
            if (typeof f.seq === 'number') result.lastSeq = Math.max(result.lastSeq, f.seq);
            result.frames[f.type] = (result.frames[f.type] ?? 0) + 1;
            if (f.type === 'chunk') {
                sseBuf += Buffer.from(f.data, 'base64').toString('utf8');
                let i;
                while ((i = sseBuf.indexOf('\n')) >= 0) {
                    const line = sseBuf.slice(0, i).replace(/\r$/, '');
                    sseBuf = sseBuf.slice(i + 1);
                    const p = parseSSEDelta(line);
                    if (!p) continue;
                    if (p.delta) { result.streamed += p.delta; onDelta?.(p.delta); }
                    if (p.reasoning) { result.reasoned += p.reasoning; onReasoning?.(p.reasoning); }
                    if (p.luker) result.tailLuker = p.luker;
                }
            } else if (f.type === 'error') {
                result.error = f;
                doneResolve();
            } else if (f.type === 'end') {
                doneResolve();
            }
        };
        ws.onclose = (e) => { if (e.code !== 1000 && e.code !== 1005) doneResolve(); };
        ws.onerror = () => doneResolve();
    };

    try {
        await connect(fromSeq);
    } catch (e) {
        result.error = { type: 'error', code: 'ws', message: e.message };
        return result;
    }
    // 等待:done / 超时 / 断连重连一次
    const deadline = Date.now() + (flags.wait ?? waitMs);
    let reconnected = false;
    while (Date.now() < deadline) {
        const winner = await Promise.race([done, sleep(1500).then(() => 'tick')]);
        if (winner !== 'tick') break;
        if (result.frames.end || result.error) break;
        // WS 死了但 job 没完 → 重连一次
        if (ws.readyState === WebSocket.CLOSED && !reconnected) {
            reconnected = true;
            warn('ws dropped — resume once');
            try { await connect(result.lastSeq + 1); } catch { break; }
        } else if (ws.readyState === WebSocket.CLOSED) break;
    }
    try { ws.close(1000); } catch { /* already gone */ }
    // SSE 尾残留
    if (sseBuf.includes('data:')) {
        for (const line of sseBuf.split('\n')) {
            const p = parseSSEDelta(line.replace(/\r$/, ''));
            if (p?.delta) { result.streamed += p.delta; onDelta?.(p.delta); }
            if (p?.reasoning) { result.reasoned += p.reasoning; onReasoning?.(p.reasoning); }
            if (p?.luker) result.tailLuker = p.luker;
        }
    }
    return result;
}

async function pollStatus(jobId, { waitMs = 60_000, breakOn = [] } = {}) {
    // breakOn:额外视为可返回的状态(默认只等终态)。写盘前用 awaiting_ack,
    // 因为要抢在 15s ack grace 内落 patch;写后只等终态。
    const deadline = Date.now() + waitMs;
    const terminals = new Set(['completed', 'failed', 'cancelled', ...breakOn]);
    let status = null;
    while (Date.now() < deadline) {
        const { data } = await req('POST', '/api/backends/chat-completions/jobs/status', { id: jobId }, { allowFail: true });
        if (data?.status) {
            status = data;
            if (status.persisted || terminals.has(status.status)) break;
        }
        await sleep(700);
    }
    return status;
}

function ndjson(obj) { if (JSON_MODE) console.log(JSON.stringify(obj)); }

/**
 * 生成主流程(设计稿「写盘时序」逐 type 实现):
 * ①护栏 ②前置写盘(regen 删楼)③POST+WS 流 ④写盘+ack ⑤状态轮询
 */
async function runGeneration(verb, { promptText = null, writeMode = 'auto' } = {}) {
    const ctx = needCtx();
    if (!ctx) return null;
    const { charDir, chatName, charName } = ctx;

    // ① active-job 护栏(任何写/POST 前)
    if (await checkNoActiveJob(charDir, chatName)) return null;

    // ②前置写盘
    const typeMap = { send: 'normal', regen: 'regenerate', swipe: 'swipe', continue: 'continue', impersonate: 'impersonate', quiet: 'quiet' };
    const type = typeMap[verb] ?? 'normal';
    let floorsData = null;
    if (verb === 'send') {
        const cur = await getChat(charDir, chatName).catch(() => null);
        if (cur && !cur.new_chat && Array.isArray(cur)) {
            saveState({ integrity: cur[0]?.chat_metadata?.integrity ?? state.integrity, floors: cur.length - 1 });
        }
        if (!flags.empty) {
            const wr = await appendFloors([userFloor({ persona: flags.user ?? state.persona ?? 'User', text: promptText ?? '' })]);
            saveState({ floors: (state.floors ?? 0) + 1 });
            ndjson({ type: 'write', op: 'append-user', appended: wr?.accepted ?? 1, integrity: wr?.integrity });
            if (!JSON_MODE) console.log(`\x1b[36m${flags.user ?? state.persona ?? 'User'}\x1b[0m\n${promptText}\n\n\x1b[35m${charName}\x1b[0m`);
        }
    } else if (verb === 'say') {
        const wr = await appendFloors([userFloor({ persona: flags.user ?? state.persona ?? 'User', text: promptText })]);
        saveState({ floors: (state.floors ?? 0) + 1 });
        ndjson({ type: 'done', ok: true, data: { said: true, appended: wr?.accepted ?? 1 }, ctx: ctxSummary() });
        if (!JSON_MODE) { footer('said'); }
        return { said: true };
    } else if (verb === 'regen') {
        // 先删末 AI 楼(script.js:7901 同序)——不删则旧回复还在 prompt 里
        floorsData = await getChat(charDir, chatName);
        saveState({ integrity: floorsData[0]?.chat_metadata?.integrity ?? state.integrity, floors: floorsData.length - 1 });
        const lastIdx = floorsData.length - 1;
        const last = floorsData[lastIdx];
        if (!last || last.is_user || lastIdx < 1) {
            fail('no_ai_floor', 'regen 需要末楼是 AI 楼', { hint: '末楼是 user——用 send 续对话', nexts: [{ cmd: 'uberge send "…"' }] });
            return null;
        }
        await patchFloors([{ op: 'remove', path: `/body/${lastIdx - 1}` }]);
        saveState({ floors: (state.floors ?? 1) - 1 });
    } else if (verb === 'swipe') {
        floorsData = await getChat(charDir, chatName);
        saveState({ integrity: floorsData[0]?.chat_metadata?.integrity ?? state.integrity, floors: floorsData.length - 1 });
        const last = floorsData.at(-1);
        if (!last || last.is_user) {
            fail('no_swipe', '末楼不可 swipe(user 楼或空聊天)', { hint: 'swipe 作用在 AI 楼上' });
            return null;
        }
    } else if (verb === 'continue') {
        floorsData = await getChat(charDir, chatName);
        saveState({ integrity: floorsData[0]?.chat_metadata?.integrity ?? state.integrity, floors: floorsData.length - 1 });
        if (!Array.isArray(floorsData) || floorsData.length < 2) {
            fail('no_floor', '空聊天无可续楼层', {});
            return null;
        }
    } else if (verb === 'impersonate' && !flags.write) {
        // 默认不写盘;--write 时生成后 append user 楼
    }

    // ③生成:body → POST → ticket → WS resume
    const jobId = randomUUID();
    const persistNone = type !== 'normal' && type !== 'regenerate';
    const body = {
        charDir, chatName, type,
        stream: !flags.noStream,
        presetName: flags.preset ?? state.preset ?? undefined,
        user: { name: flags.user ?? state.persona ?? 'User' },
        generation_overrides: flags.set ?? {},
        luker_generation: {
            job_id: jobId,
            // kind:'none' 必须纯 {kind:'none'}——服务端 getPersistChatKey
            // 只要看到 avatar_url+file_name 就当真 persist 目标,会尝试替
            // swipe/continue 写整楼再标 failed。
            persist_target: persistNone
                ? { kind: 'none' }
                : { kind: 'character', avatar_url: `${charDir}.png`, file_name: `${chatName}.jsonl`, char_name: charName },
        },
    };
    if (verb === 'quiet' && promptText) body.overrides = { quietPrompt: promptText };
    ndjson({ type: 'meta', cmd: verb, job_id: jobId, ctx: ctxSummary() });

    const started = Date.now();
    // job id 立刻入 state——POST 之后任何中断都能 `attach <id>` 找回
    saveState({ lastJob: { id: jobId, type, status: 'running', at: Date.now() } });
    // generate 用整个 wait 窗口——慢盘组装+上游排队能远超 30s 默认请求超时
    const { headers } = await req('POST', '/api/uberge/generate', body, { timeout: flags.wait ?? DEFAULT_WAIT_MS });
    const echoed = headers.get('x-luker-generation-id');
    if (echoed && echoed !== jobId) warn(`job id echo mismatch: ${echoed}`);

    // WS 必须在 POST 之后(job 不存在时 resume 会被 not_found 拒——硬约束)
    let reasoningShown = false;
    const stream = await streamJob(jobId, {
        onDelta: (d) => {
            if (JSON_MODE) { if (flags.stream) ndjson({ type: 'delta', text: d }); }
            else if (!flags.quietMode) process.stdout.write(d);
        },
        onReasoning: (d) => {
            if (JSON_MODE) { if (flags.stream) ndjson({ type: 'reasoning', text: d }); }
            else if (!flags.quietMode) {
                if (!reasoningShown) { reasoningShown = true; process.stdout.write('\x1b[2m【思考】\x1b[0m'); }
                process.stdout.write(`\x1b[2m${d}\x1b[0m`);
            }
        },
    });
    if (!JSON_MODE) process.stdout.write(reasoningShown ? '\x1b[0m\n' : '\n');

    // ④短等 status.text(权威文本),但必须抢在 15s ack grace 内写盘——
    // kind:'none' 动词(swipe/continue/impersonate/quiet)服务端不落盘,
    // 超时由兜底标 failed;写盘必须紧跟流尾,不能先等终态。
    // 轮询上限 4s:通常 dispatch 收尾后 status.text 立即可得;
    // awaiting_ack 一到就返回立刻写盘(grace 只剩 ~11s)。
    const status = await pollStatus(jobId, { waitMs: 4_000, breakOn: ['awaiting_ack'] }) ?? {};
    const text = String(status?.text ?? '') || stream.streamed;
    const genFinished = isoNow();
    if (!status?.status && !stream.frames.end) {
        // 完全失联:既没 end 帧又没终态——写盘可能与服务端兜底撞出双层
        warn(`job ${jobId} 无终态——不写盘,用 attach 对账`);
        saveState({ lastJob: { id: jobId, type, status: 'unknown', at: Date.now() } });
        exitCode = 6;
        return null;
    }

    // ⑤立即写盘(成功 + 服务端未落盘才写;persisted=true 说明兜底已写,再写就双楼)
    let writeResult = null;
    const failedUpstream = status?.status === 'failed' || status?.status === 'cancelled' || (stream.error && !text);
    if (!failedUpstream && text && !status?.persisted) {
        if (verb === 'send' || verb === 'regen') {
            const floor = assistantFloor({ charName, text, jobId, model: status?.model ?? '', genStarted: new Date(started).toISOString(), genFinished });
            // 双通道:顶层 gen-id 写 sidecar(幂等)+ extra.luker_generation_id 参与 ack
            writeResult = await appendFloors([floor], { luker_generation_id: jobId });
            saveState({ floors: (state.floors ?? 0) + 1 });
            ndjson({ type: 'write', op: 'append-ai', appended: writeResult?.accepted ?? 1, skipped: writeResult?.skipped ?? 0, integrity: writeResult?.integrity });
        } else if (verb === 'swipe') {
            const lastIdx = floorsData.length - 1;
            const last = floorsData[lastIdx];
            const bodyIdx = lastIdx - 1;
            const oldSwipes = Array.isArray(last.swipes) ? last.swipes : [];
            const oldInfo = Array.isArray(last.swipe_info) ? last.swipe_info : [];
            // swipe_info 必须与 swipes 逐位对齐——缺的位次用楼层字段补,
            // 否则新 swipe 挂进错位的 info 数组。整组替换比分片 append 稳。
            const floorEntry = { send_date: last.send_date, gen_started: last.gen_started, gen_finished: last.gen_finished, extra: last.extra ?? {} };
            const baseSwipes = oldSwipes.length ? oldSwipes : [last.mes ?? ''];
            const baseInfo = baseSwipes.map((_, i) => oldInfo[i] ?? floorEntry);
            const ops = [
                { op: 'add', path: `/body/${bodyIdx}/swipes`, value: [...baseSwipes, text] },
                { op: 'add', path: `/body/${bodyIdx}/swipe_info`, value: [...baseInfo, { send_date: isoNow(), gen_started: new Date(started).toISOString(), gen_finished: genFinished, extra: { api: 'cli', model: status?.model ?? '', luker_generation_id: jobId } }] },
                { op: 'add', path: `/body/${bodyIdx}/swipe_id`, value: baseSwipes.length },
                { op: 'add', path: `/body/${bodyIdx}/mes`, value: text },
            ];
            writeResult = await patchFloors(ops, { luker_generation_id: jobId });
            ndjson({ type: 'write', op: 'patch-swipe', applied: writeResult?.applied ?? ops.length });
        } else if (verb === 'continue') {
            const lastIdx = floorsData.length - 1;
            const last = floorsData[lastIdx];
            const bodyIdx = lastIdx - 1;
            const merged = String(last.mes ?? '') + text;
            const ops = [{ op: 'add', path: `/body/${bodyIdx}/mes`, value: merged }];
            const swipes = Array.isArray(last.swipes) ? last.swipes : null;
            const swipeId = Number.isInteger(last.swipe_id) ? last.swipe_id : null;
            if (swipes && swipeId != null && swipeId < swipes.length) {
                ops.push({ op: 'add', path: `/body/${bodyIdx}/swipes/${swipeId}`, value: merged });
                // gen-id 埋进 op 值——patch 的显式 ack 只扫 operations,不扫 body
                const info = Array.isArray(last.swipe_info) ? last.swipe_info[swipeId] : null;
                ops.push({ op: 'add', path: `/body/${bodyIdx}/swipe_info/${swipeId}`, value: { ...(info && typeof info === 'object' ? info : {}), gen_finished: genFinished, extra: { ...(info?.extra ?? {}), luker_generation_id: jobId } } });
            } else if (!swipes) {
                // 服务端兜底 persist 的楼层没有 swipe 结构 —— 补全(上游 normalize 语义)
                ops.push({ op: 'add', path: `/body/${bodyIdx}/swipes`, value: [merged] });
                ops.push({ op: 'add', path: `/body/${bodyIdx}/swipe_id`, value: 0 });
                ops.push({ op: 'add', path: `/body/${bodyIdx}/swipe_info`, value: [{ send_date: last.send_date ?? isoNow(), gen_started: last.gen_started ?? isoNow(), gen_finished: genFinished, extra: { ...(last.extra ?? {}), luker_generation_id: jobId } }] });
            }
            // add 对缺键/已存在都成立;replace 遇缺键直接 409
            ops.push({ op: 'add', path: `/body/${bodyIdx}/gen_finished`, value: genFinished });
            writeResult = await patchFloors(ops, { luker_generation_id: jobId });
            ndjson({ type: 'write', op: 'patch-continue', applied: writeResult?.applied ?? ops.length });
        } else if (verb === 'impersonate' && flags.write) {
            writeResult = await appendFloors([userFloor({ persona: text ? (flags.user ?? state.persona ?? 'User') : 'User', text }),], { luker_generation_id: jobId });
            saveState({ floors: (state.floors ?? 0) + 1 });
        }
    }

    // ⑥收尾:写盘(gen-id)→ ack 应把 job 翻 completed;短轮一次观察翻面
    const finalStatus = writeResult ? (await pollStatus(jobId, { waitMs: 8_000 }) ?? status) : status;
    const elapsed = Date.now() - started;
    // cosmetic failed 只指 kind:'none' 无 ack 时的超时翻面;真上游失败不算
    const cosmetic = ['impersonate', 'quiet', 'continue', 'swipe'].includes(verb) && finalStatus?.status === 'failed' && !failedUpstream;
    saveState({
        lastJob: { id: jobId, type, status: finalStatus?.status ?? 'unknown', at: Date.now(), chars: text.length },
        lastReplyPreview: trunc(text, 80),
    });
    ring(CMD, failedUpstream ? 5 : 0, { job: jobId.slice(0, 8) });

    const data = { job_id: jobId, text, status: finalStatus?.status, persisted: Boolean(finalStatus?.persisted), elapsed_ms: elapsed, cosmetic_failed: cosmetic || undefined };
    if (JSON_MODE) {
        ndjson({ type: 'done', ok: !failedUpstream, data, ctx: ctxSummary(), next: genNextFor(verb, failedUpstream) });
    } else {
        if (failedUpstream) {
            warn(`upstream failed: ${stream.error?.message ?? finalStatus?.error ?? 'unknown'}`);
        }
        if (cosmetic) warn('job 15s 后会翻 cosmetic failed(kind:none 无 ack 兜底,预期非错)');
        if (verb === 'impersonate' && !flags.write) warn('草稿未落盘——`--write` 落用户楼,或 `say` 直接写');
        footer(`${elapsed}ms · ${text.length}ch`);
        nextHints = genNextFor(verb, failedUpstream);
        if (nextHints.length) console.log(`\x1b[2m· next: ${nextHints.map(n => n.cmd).join(' · ')}\x1b[0m`);
    }
    if (flags.out) {
        writeFileSync(resolve(flags.out), text);
        warn(`wrote ${flags.out} (${Buffer.byteLength(text)}B)`);
    }
    if (failedUpstream) {
        exitCode = 5;
        return null;
    }
    return data;
}

function genNextFor(verb, failed) {
    if (failed) return [{ cmd: 'uberge inspect', why: '看 job 错误与 WI 轨迹' }, { cmd: `uberge attach ${state.lastJob?.id ?? ''}`.trim(), why: '对账终态' }];
    switch (verb) {
        case 'send': return [{ cmd: 'uberge send "…"', why: '继续' }, { cmd: 'uberge swipe', why: '换一版' }, { cmd: 'uberge inspect', why: '看 WI/轨迹' }];
        case 'regen': case 'swipe': return [{ cmd: 'uberge swipe', why: '再换一版' }, { cmd: 'uberge send "…"', why: '接着聊' }];
        case 'continue': return [{ cmd: 'uberge continue', why: '再续' }, { cmd: 'uberge send "…"' }];
        default: return [{ cmd: 'uberge history -n 3' }, { cmd: 'uberge send "…"' }];
    }
}

// ═══ SIGINT:detach 不杀 job(设计铁律 7)═══
process.on('SIGINT', () => {
    const j = state.lastJob;
    process.stderr.write(`\n[cli] interrupted${j ? ` — job ${j.id} still running` : ''}\n`);
    if (j) process.stderr.write(`[cli] resume: uberge attach ${j.id}\n`);
    process.exit(6);
});

// ═══ stdin 文本源 ═══
async function readTextArg(rest) {
    if (flags.stdin) {
        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        return Buffer.concat(chunks).toString('utf8');
    }
    return rest.join(' ');
}

// ═══ 命令实现 ═══
async function cmdBare() {
    // 零网络:纯快照+建议(设计铁律 1)
    const c = ctxSummary();
    if (JSON_MODE) return out({ snapshot: c, recent: state.recent?.slice(-5) }, bareNext());
    console.log(`\x1b[1muberge\x1b[0m ${SERVER}${c.charName ? ` — ${c.charName} @ ${c.chatName}` : ''}`);
    if (c.charName) {
        console.log(`  floors ${c.floors ?? '?'} · integrity ${c.integrity ? c.integrity.slice(0, 8) + '…' : '—'} · last job ${c.job ? `${String(c.job.id).slice(0, 8)}:${c.job.status}` : '—'}`);
        if (state.lastReplyPreview) console.log(`  last: ${trunc(state.lastReplyPreview, 70)}`);
    } else {
        console.log('  no context — 先选一张卡');
    }
    const n = bareNext();
    if (n.length) console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}
function bareNext() {
    if (!state.char?.dir) return [{ cmd: 'uberge chars', why: '选卡' }, { cmd: 'uberge doctor', why: '体检链路' }];
    return [{ cmd: 'uberge send "…"', why: '发消息' }, { cmd: 'uberge status', why: '在线刷新' }, { cmd: 'uberge history -n 5', why: '看上文' }];
}

async function cmdStatus() {
    const c = needCtx();
    let floors = state.floors, integrity = state.integrity, lastSwipe = null;
    if (c) {
        const cur = await getChat(c.charDir, c.chatName).catch(() => null);
        if (Array.isArray(cur)) {
            floors = cur.length - 1;
            integrity = cur[0]?.chat_metadata?.integrity ?? integrity;
            const last = cur.at(-1);
            lastSwipe = Array.isArray(last?.swipes) ? { n: (last.swipe_id ?? 0) + 1, total: last.swipes.length } : null;
            saveState({ floors, integrity });
        }
        const { data: active } = await req('POST', '/api/backends/chat-completions/jobs/active', {
            persist_target: { avatar_url: `${c.charDir}.png`, file_name: `${c.chatName}.jsonl` },
        }, { allowFail: true });
        const jobs = Array.isArray(active?.jobs) ? active.jobs : [];
        const running = jobs.filter(j => ['running', 'queued', 'persisting', 'awaiting_ack'].includes(j.status));
        const snap = { ...ctxSummary(), floors, integrity, swipe: lastSwipe, activeJobs: running.map(j => ({ id: j.id, status: j.status })) };
        if (JSON_MODE) return out(snap, running.length ? [{ cmd: `uberge attach ${running[0].id}` }] : genNextFor('status', false));
        console.log(`${c.charName} @ ${c.chatName} · floors ${floors} · integrity ${(integrity ?? '—').slice(0, 10)}`);
        if (lastSwipe) console.log(`  last floor swipe ${lastSwipe.n}/${lastSwipe.total}`);
        console.log(running.length ? `  ⚠ active jobs: ${running.map(j => `${j.id.slice(0, 8)}:${j.status}`).join(', ')}` : '  no active jobs');
        footer();
        nextHints = running.length ? [{ cmd: `uberge attach ${running[0].id}` }] : bareNext();
        if (nextHints.length) console.log(`\x1b[2m· next: ${nextHints.map(n => n.cmd).join(' · ')}\x1b[0m`);
        return snap;
    }
    const c2 = ctxSummary();
    if (JSON_MODE) return out(c2, bareNext());
    console.log(`server ${SERVER} · no ctx`);
    console.log(`\x1b[2m· next: uberge chars · uberge doctor\x1b[0m`);
    return c2;
}

// doctor 覆盖差集用:具名命令已绑的 kernel 路由(kernel list() 的
// "METHOD|kind|path" 串格式)。未列的 = raw-only,doctor --full 会打印差集。
const NAMED_UBERGE_ROUTES = new Set([
    'GET|exact|/api/uberge/_kernel',
    'GET|pattern|/api/uberge/jobs',
    'GET|pattern|/api/uberge/jobs/:id',
    'POST|pattern|/api/uberge/generate',
    'POST|pattern|/api/uberge/preview',
    'GET|pattern|/api/uberge/worlds',
    'GET|pattern|/api/uberge/worlds/:name',
    'GET|pattern|/api/uberge/plugins',
    'POST|pattern|/api/uberge/plugins/:id/enable',
    'POST|pattern|/api/uberge/plugins/:id/disable',
    'POST|pattern|/api/uberge/plugins/:id/reload',
    'POST|pattern|/api/uberge/mvu/settle',
    'POST|pattern|/api/uberge/mvu/resettle',
    'GET|pattern|/api/uberge/mvu/state',
    'POST|pattern|/api/uberge/script/run',
    'POST|pattern|/api/uberge/th/call',
]);

async function cmdDoctor() {
    const steps = [];
    const step = async (name, fn) => {
        try { const v = await fn(); steps.push({ name, ok: true, detail: v }); return true; }
        catch (e) { steps.push({ name, ok: false, detail: e.message, hint: e.hint }); return false; }
    };
    await step('server reachable', async () => {
        const r = await fetch(`${SERVER}/csrf-token`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { hint: 'server 没起或端口错' });
        return 'ok';
    });
    await step('csrf + session', async () => {
        await session();
        const { data } = await req('POST', '/api/characters/all');
        return `session ok, ${Array.isArray(data) ? data.length : 0} chars`;
    });
    await step('ws delivery', async () => {
        const ticket = await wsTicket();
        await new Promise((res, rej) => {
            const to = setTimeout(() => rej(new Error('ws open timeout 5s')), 5000);
            const w = new WebSocket(`${SERVER.replace(/^http/, 'ws')}/api/ws-delivery`, `luker-ws-ticket.${ticket}`);
            w.onopen = () => { clearTimeout(to); w.close(); res(); };
            w.onerror = () => { clearTimeout(to); rej(new Error('ws connect failed')); };
        });
        return 'ticket+connect ok';
    });
    if (state.char?.dir && state.chat?.name) {
        await step('ctx valid', async () => {
            const cur = await getChat(state.char.dir, state.chat.name);
            if (cur?.new_chat) return 'chat 文件未建(首条 send 时创建)';
            return `chat ${state.chat.name}: ${(cur?.length ?? 1) - 1} floors`;
        });
    } else {
        steps.push({ name: 'ctx', ok: true, detail: '未选(ctx 空不阻塞)' });
    }
    // cordis 覆盖差集:kernel 路由表 vs CLI 具名命令。具名=输出已整理的动词;
    // 其余由 raw 逃生舱兜底(可达但不友好)。差集清单就是 CLI 待补面。
    await step('capability coverage', async () => {
        const { data } = await req('GET', '/api/uberge/_kernel');
        const routes = (data?.routes ?? []).map(r => String(r));
        const named = NAMED_UBERGE_ROUTES;
        const uncovered = routes.filter(r => !named.has(r) && !r.startsWith('upgrade|'));
        return `${routes.length} routes · named ${routes.length - uncovered.length} · raw-only ${uncovered.length}${flags.full && uncovered.length ? ` (${uncovered.join(', ')})` : ''}`;
    });
    const allOk = steps.every(s => s.ok);
    if (JSON_MODE) return out({ steps, ok: allOk }, allOk ? bareNext() : [{ cmd: 'uberge doctor', why: '修完重验' }]);
    for (const s of steps) {
        console.log(`${s.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${s.name} — ${s.detail}${s.hint ? `  \x1b[2m(${s.hint})\x1b[0m` : ''}`);
    }
    footer();
    return { ok: allOk, steps };
}

const SCHEMA = {
    version: VERSION,
    commands: [
        { cmd: 'uberge', desc: '状态快照+next(零网络)', out: 'snapshot' },
        { cmd: 'uberge status', desc: '在线 ctx/floors/integrity/active jobs', out: 'ctx+jobs' },
        { cmd: 'uberge doctor', desc: '链路体检(server/session/ws/ctx)', out: 'steps[]' },
        { cmd: 'uberge schema', desc: '本目录(self-describing)', out: 'schema' },
        { cmd: 'uberge chars [-n N]', desc: '角色列表', out: '[{dir,name,chat}]' },
        { cmd: 'uberge chats [--char d]', desc: '当前/指定角色聊天列表', out: '[{name,floors,last}]' },
        { cmd: 'uberge recent [-n N]', desc: '跨角色最近聊天', out: '[{char,chat,time}]' },
        { cmd: 'uberge use <char> [chat]', desc: '选卡+聊天(模糊匹配,chat 缺省=最新)', out: 'ctx' },
        { cmd: 'uberge chat-new <name>', desc: '新聊天坐标(首条 send 建文件)', out: 'chat' },
        { cmd: 'uberge chat-rename <new>', desc: '重命名当前聊天', out: 'renamed' },
        { cmd: 'uberge chat-delete <name>', desc: '删除指定聊天(显式名)', out: 'deleted' },
        { cmd: 'uberge send <text>|--stdin', desc: 'append user 楼+生成+append AI 楼', out: 'stream text + footer' },
        { cmd: 'uberge say <text>', desc: '只写 user 楼不生成', out: 'floor' },
        { cmd: 'uberge regen', desc: '删末 AI 楼重生成', out: 'stream text' },
        { cmd: 'uberge swipe [N]|--list', desc: '末楼换一版/导航/列表', out: 'stream|swipe state' },
        { cmd: 'uberge continue', desc: '末楼续写(合入同楼)', out: 'stream delta' },
        { cmd: 'uberge impersonate [--write]', desc: '生成 user 口吻草稿(默认不落盘)', out: 'draft text' },
        { cmd: 'uberge quiet <prompt>', desc: 'quiet 生成(不落盘)', out: 'final text' },
        { cmd: 'uberge history [-n N] [--floor i] [--full] [--out f]', desc: '楼层回放', out: '[floor]' },
        { cmd: 'uberge edit <floor> <text|--stdin>', desc: '改楼层(swipes 同步)', out: 'updated' },
        { cmd: 'uberge jobs [-n N]', desc: 'job 列表', out: '[job]' },
        { cmd: 'uberge inspect [jobId] [--section s]', desc: 'job trace/sources/WI', out: 'detail' },
        { cmd: 'uberge preview [--type t] [-n N]', desc: '干跑组装 messages', out: '[msg]' },
        { cmd: 'uberge attach [jobId]', desc: '断链恢复(WS resume/status 对账)', out: 'stream|text' },
        { cmd: 'uberge abort [jobId]', desc: '中止 job', out: 'aborted' },
        { cmd: 'uberge persona [name]', desc: '查看/设定 persona', out: 'persona' },
        { cmd: 'uberge presets', desc: 'openai 预设列表', out: '[name]' },
        { cmd: 'uberge preset <name>|--off', desc: '绑定预设进 generate.presetName', out: 'preset' },
        { cmd: 'uberge worlds', desc: '[library] 世界书列表', out: '[{name,displayName}]' },
        { cmd: 'uberge wi <book> [-n N] [--full] [--out f]', desc: '[library] 世界书条目(uid/keys/constant/off)', out: '[entry]' },
        { cmd: 'uberge kernel', desc: '[diag] cordis 路由+服务清单(能力面)', out: '{routes,services}' },
        { cmd: 'uberge plugins', desc: '[plugins] fiber 清单', out: '[{id,disabled}]' },
        { cmd: 'uberge plugin <id> <enable|disable|reload>', desc: '[plugins] 组件生命周期(admin)', out: '{ok}' },
        { cmd: 'uberge mvu [state]', desc: '[mvu] chat 变量+settle 回执(=悬浮窗数据源)', out: '{variables,receipts}' },
        { cmd: 'uberge mvu settle [--floor i]', desc: '[mvu] 手动重结算目标楼层', out: '{ok}' },
        { cmd: 'uberge mvu resettle', desc: '[mvu] 全量重放投影(编辑/删楼/swipe 后)', out: '{ok}' },
        { cmd: 'uberge script <stscript|--stdin>', desc: '[script] 服务端 STscript runner(/echo|/gen…)', out: '{pipe,ops,notifications}' },
        { cmd: 'uberge th <method> [json]', desc: '[th] TavernHelper 调用面(变量/消息/slash)', out: '{result}' },
        { cmd: 'uberge raw <M> </path> [json|--stdin]', desc: '逃生舱:任意 REST 端点直达(kernel 表全量可绑)', out: '{status,data}' },
    ],
    flags: ['--json(机器 envelope/生成动词 NDJSON)', '--stream(JSON 时开 delta 帧)', '--full', '--out f', '-n N', '--floor i', '--stdin|-', '--wait ms', '--timeout ms', '--force', '--write', '--quiet', '--no-stream', '--char d', '--user n', '--preset n|--off', '--set k=v', '--from seq', '--type t', '--section s', '--state f', '-s url|UBERGE_SERVER'],
    exitCodes: { 0: 'ok', 1: 'server/generic', 2: 'usage', 3: 'conflict(integrity/ambiguous/active_job)', 4: 'network/session', 5: 'upstream failed/cancelled', 6: 'timeout-interrupted(job still running)' },
    errorCodes: ['usage', 'no_ctx', 'not_found', 'ambiguous', 'exists', 'integrity_conflict', 'active_job', 'no_floor', 'no_ai_floor', 'no_swipe', 'new_chat', 'upstream', 'session', 'network', 'timeout', 'server'],
    stateFile: '~/.uberge-cli.json: {server, char{dir,name}, chat{name}, persona, preset, integrity, floors, lastJob{id,type,status,at,chars}, lastReplyPreview, recent[]}',
    flow: 'send: ctx → jobs/active 护栏 → append user 楼 → POST /api/uberge/generate → ticket → WS resume from_seq:1 → head/chunk/end 帧 → append AI 楼(顶层+extra gen-id ack) → jobs/status 终态',
};

async function cmdChars() {
    const chars = await listChars();
    const rows = chars.map(c => ({ dir: stripExt(c.avatar, 'png'), name: c.name ?? '', chat: stripExt(c.chat ?? '', 'jsonl') }));
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(rows, null, 2)); warn(`wrote ${flags.out}`); }
    const show = flags.n ? rows.slice(0, flags.n) : rows;
    if (JSON_MODE) return out(show, [{ cmd: 'uberge use <dir>', why: '选卡进 ctx' }]);
    for (const r of show) console.log(`${r.dir.padEnd(36)} ${r.name} ${r.chat ? `· ${r.chat}` : ''}`);
    console.log(`\n${rows.length} characters`);
    next('uberge use <dir>');
    footer();
    return rows;
}

async function cmdChats() {
    const charDir = flags.char ? stripExt(flags.char, 'png') : needCtx()?.charDir;
    if (!charDir) return;
    const chats = await listChats(charDir);
    const rows = chats.map(c => ({
        name: stripExt(c.file_name ?? c.name ?? c, 'jsonl'),
        floors: c.chat_items ?? c.message_count ?? null,
        last: trunc(c.mes ?? c.last_mes ?? '', 60),
        time: c.sort_time ? new Date(c.sort_time).toISOString().slice(0, 16) : null,
    }));
    if (JSON_MODE) return out(rows, [{ cmd: 'uberge use <char> <chat>', why: '切聊天' }, { cmd: 'uberge chat-new <name>' }]);
    for (const r of rows) console.log(`${r.name === state.chat?.name ? '*' : ' '} ${r.name}  ${r.floors ?? '?'}f  ${r.time ?? ''}  ${r.last}`);
    console.log(`\n${rows.length} chats for ${charDir}`);
    footer();
    return rows;
}

async function cmdRecent() {
    const { data } = await req('POST', '/api/chats/recent', {});
    const rows = (Array.isArray(data) ? data : []).slice(0, flags.n ?? 10).map(c => ({
        char: stripExt(c.avatar_url ?? c.avatar ?? '', 'png'),
        chat: stripExt(c.file_name ?? '', 'jsonl'),
        time: c.sort_time ? new Date(c.sort_time).toISOString().slice(0, 16) : null,
    }));
    if (JSON_MODE) return out(rows, [{ cmd: 'uberge use <char> <chat>' }]);
    for (const r of rows) console.log(`${r.char.padEnd(30)} ${r.chat}  ${r.time ?? ''}`);
    footer();
    return rows;
}

async function cmdUse() {
    const char = await resolveChar(positional[1]);
    if (!char) return;
    const charDir = stripExt(char.avatar, 'png');
    const chatName = await resolveChatForUse(charDir, positional[2], char.chat);
    if (!chatName) return;
    saveState({ char: { dir: charDir, name: char.name ?? charDir }, chat: { name: chatName }, floors: null, integrity: null });
    const n = [{ cmd: 'uberge history -n 3', why: '看上文' }, { cmd: 'uberge send "…"', why: '发消息' }];
    if (JSON_MODE) return out({ charDir, charName: char.name, chatName }, n);
    console.log(`→ ${char.name ?? charDir} @ ${chatName}`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdChatNew() {
    const c = needCtx() ?? { charDir: flags.char ? stripExt(flags.char, 'png') : null, charName: null };
    if (!c?.charDir) { fail('no_ctx', '先选卡', { hint: 'uberge use <char>' }); return; }
    const name = stripExt(positional[1] ?? '', 'jsonl');
    if (!name) return void fail('usage', 'uberge chat-new <name>', { rc: 2 });
    const chats = await listChats(c.charDir);
    const names = chats.map(x => stripExt(x.file_name ?? x.name ?? x, 'jsonl'));
    if (names.includes(name)) {
        return void fail('exists', `chat exists: ${name}`, { detail: names.filter(n => n.includes(name.slice(0, 8))).join(' | '), rc: 3 });
    }
    saveState({ chat: { name }, floors: 0, integrity: null });
    const n = [{ cmd: 'uberge send "…"', why: '首条消息自动建文件' }];
    if (JSON_MODE) return out({ chatName: name }, n);
    console.log(`chat = ${name}(空,首条 send 建文件)`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdChatRename() {
    const c = needCtx(); if (!c) return;
    const newName = stripExt(positional[1] ?? '', 'jsonl');
    if (!newName) return void fail('usage', 'uberge chat-rename <new>', { rc: 2 });
    const { data } = await req('POST', '/api/chats/rename', { avatar_url: `${c.charDir}.png`, original_file: `${c.chatName}.jsonl`, renamed_file: `${newName}.jsonl` });
    saveState({ chat: { name: newName } });
    if (JSON_MODE) return out({ renamed: newName, data }, genNextFor('send', false));
    console.log(`renamed → ${newName}`);
    footer();
}

async function cmdChatDelete() {
    const c = needCtx(); if (!c) return;
    const name = stripExt(positional[1] ?? '', 'jsonl');
    if (!name) return void fail('usage', 'uberge chat-delete <name>(显式名,不给模糊)', { rc: 2 });
    await req('POST', '/api/chats/delete', { avatar_url: `${c.charDir}.png`, chatfile: `${name}.jsonl` });
    if (state.chat?.name === name) saveState({ chat: { name: null }, floors: null, integrity: null });
    if (JSON_MODE) return out({ deleted: name }, [{ cmd: 'uberge chats' }]);
    console.log(`deleted ${name}`);
    footer();
}

async function cmdHistory() {
    const c = needCtx(); if (!c) return;
    const data = await getChat(c.charDir, c.chatName);
    if (data?.new_chat) { fail('new_chat', 'chat 还没楼层', { hint: 'uberge send "…" 开第一条' }); return; }
    if (!Array.isArray(data)) return void fail('server', 'unexpected chats/get shape', { detail: data });
    saveState({ integrity: data[0]?.chat_metadata?.integrity ?? state.integrity, floors: data.length - 1 });
    const body = data.slice(1);
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (flags.floor != null) {
        const m = body[flags.floor];
        if (!m) return void fail('bad_floor', `floor ${flags.floor} 不存在(共 ${body.length} 层)`, { rc: 2 });
        if (JSON_MODE) return out(m, genNextFor('history', false));
        console.log(`#${flags.floor} ${m.is_user ? 'USER' : 'AI'} ${m.name ?? ''}\n${m.mes ?? ''}`);
        footer();
        return m;
    }
    const n = flags.n ?? 5;
    const show = body.slice(-n);
    if (JSON_MODE) return out(show, [{ cmd: 'uberge send "…"' }, { cmd: `uberge history --floor ${body.length - 1}` }]);
    show.forEach((m, i) => {
        const idx = body.length - show.length + i;
        const sw = Array.isArray(m.swipes) && m.swipes.length > 1 ? ` swipe ${(m.swipe_id ?? 0) + 1}/${m.swipes.length}` : '';
        console.log(`\n\x1b[2m#${idx}\x1b[0m ${m.is_user ? '\x1b[36m' : '\x1b[35m'}${m.name ?? (m.is_user ? 'User' : 'AI')}\x1b[0m${sw}`);
        console.log(flags.full ? m.mes : trunc(m.mes, 300));
    });
    footer();
    nextHints = [{ cmd: 'uberge send "…"' }, { cmd: `uberge history -n ${Math.min(body.length, n * 3)}`, why: '看更早' }];
    console.log(`\x1b[2m· next: ${nextHints.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdEdit() {
    const c = needCtx(); if (!c) return;
    const idx = Number(positional[1]);
    if (!Number.isInteger(idx)) return void fail('usage', 'uberge edit <floor> <text|--stdin>', { rc: 2 });
    const text = await readTextArg(positional.slice(2));
    if (!text) return void fail('usage', 'edit 需要文本', { rc: 2 });
    const cur = await getChat(c.charDir, c.chatName);
    if (!Array.isArray(cur)) return void fail('not_found', 'chat unreadable');
    const m = cur[idx + 1];
    if (!m) return void fail('bad_floor', `floor ${idx} 不存在`, { rc: 2 });
    saveState({ integrity: cur[0]?.chat_metadata?.integrity ?? state.integrity });
    const ops = [{ op: 'replace', path: `/${idx}/mes`, value: text }];
    if (Array.isArray(m.swipes) && Number.isInteger(m.swipe_id) && m.swipes[m.swipe_id] !== undefined) {
        ops.push({ op: 'replace', path: `/${idx}/swipes/${m.swipe_id}`, value: text });
    }
    await patchFloors(ops);
    if (JSON_MODE) return out({ floor: idx, ops: ops.length }, [{ cmd: 'uberge history -n 3' }]);
    console.log(`floor #${idx} updated(${ops.length} ops)`);
    footer();
}

async function cmdJobs() {
    const { data } = await req('GET', '/api/uberge/jobs');
    // 服务端实际形状 {items:[{id,status,chatKey,textPreview,persisted,...}]}
    const jobs = (Array.isArray(data?.items) ? data.items : Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : []).slice(0, flags.n ?? 10);
    const rows = jobs.map(j => ({
        id: j.id, status: j.status, persisted: Boolean(j.persisted),
        chat: j.chatKey ?? (j.persist_target ? `${stripExt(j.persist_target.avatar_url ?? '', 'png')}/${stripExt(j.persist_target.file_name ?? '', 'jsonl')}` : null),
        text: trunc(j.textPreview ?? j.text ?? '', 60), at: j.created_at ?? j.at ?? null,
    }));
    if (JSON_MODE) return out(rows, [{ cmd: 'uberge inspect <id8>', why: '看明细' }]);
    for (const r of rows) console.log(`${String(r.id).slice(0, 8)}  ${r.status?.padEnd(12)} ${r.persisted ? 'persisted' : '         '}  ${r.chat ?? '-'}  ${r.text}`);
    footer();
    return rows;
}

async function cmdInspect() {
    const id = positional[1] || state.lastJob?.id;
    if (!id) return void fail('usage', 'uberge inspect <jobId>(或先生成一次)', { rc: 2 });
    const { data: d } = await req('GET', `/api/uberge/jobs/${id}`, undefined, { allowFail: true });
    if (!d || d.error) return void fail('not_found', `job not found: ${id}`, { hint: 'uberge jobs 看列表' });
    saveState({ lastJob: { id, type: d.type ?? state.lastJob?.type, status: d.status, at: Date.now(), chars: (d.text ?? '').length } });
    const src = d.sources ?? {};
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(d, null, 2)); warn(`wrote ${flags.out}`); }
    const section = flags.section;
    const entries = src.worldInfo?.activated ?? [];
    const summary = {
        id, status: d.status, persisted: Boolean(d.persisted), type: d.type,
        model: src.model, preset: src.presetName, chat: src.chatCount,
        wiActivated: src.worldInfoActivated ?? entries.length,
        worlds: Object.entries(entries.reduce((a, e) => { a[e.world ?? '?'] = (a[e.world ?? '?'] ?? 0) + 1; return a; }, {})).map(([world, n]) => ({ world, n })),
        elapsed: d.perf?.totalMs ?? null,
    };
    if (section === 'text') {
        if (JSON_MODE) return out({ text: d.text ?? '' });
        console.log(d.text ?? '(no text)'); return;
    }
    if (section === 'sources' || section === 'trace') {
        const payload = section === 'sources' ? src : (d.trace ?? d);
        if (JSON_MODE) return out(payload);
        console.log(JSON.stringify(payload, null, 2).slice(0, flags.full ? 1e9 : 6000));
        return;
    }
    if (JSON_MODE) return out({ ...summary, entries: flags.full ? entries : entries.slice(0, 15) }, [{ cmd: 'uberge inspect --section sources' }]);
    console.log(`job ${String(id).slice(0, 8)} · ${summary.status} · persisted=${summary.persisted} · ${summary.model ?? '?'} · preset ${summary.preset ?? '-'}`);
    console.log(`WI activated ${summary.wiActivated}${summary.elapsed ? ` · ${Math.round(summary.elapsed)}ms` : ''}`);
    for (const w of summary.worlds) console.log(`  ${w.world}: ${w.n}`);
    const show = flags.full ? entries : entries.slice(0, 15);
    for (const e of show) console.log(`  - [${e.world}] ${trunc(e.comment ?? e.key ?? '', 58)} pos=${e.position} depth=${e.depth ?? '-'}`);
    if (!flags.full && entries.length > 15) console.log(`  …+${entries.length - 15} entries(--full 展开)`);
    footer();
}

async function cmdPreview() {
    const c = needCtx(); if (!c) return;
    const type = flags.type ?? 'normal';
    const { data } = await req('POST', '/api/uberge/preview', { charDir: c.charDir, chatName: c.chatName, type, user: { name: flags.user ?? state.persona ?? 'User' } });
    const msgs = data.messages ?? [];
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out({ count: msgs.length, perf: data.perf, messages: flags.full ? msgs : msgs.slice(0, flags.n ?? 8) }, [{ cmd: 'uberge send "…"' }]);
    console.log(`messages: ${msgs.length}${data.perf?.totalMs ? ` · ${Math.round(data.perf.totalMs)}ms` : ''}`);
    for (const m of msgs.slice(0, flags.n ?? 8)) {
        console.log(`\x1b[2m[${m.role}${m.name ? ':' + m.name : ''}]\x1b[0m ${trunc(m.content, flags.full ? 1e9 : 150)}`);
    }
    if (!flags.full && msgs.length > (flags.n ?? 8)) console.log(`…+${msgs.length - (flags.n ?? 8)} messages(-n/--full/--out 展开)`);
    footer();
}

async function cmdAttach() {
    const id = positional[1] || state.lastJob?.id;
    if (!id) return void fail('usage', 'uberge attach <jobId>', { rc: 2 });
    const st = await pollStatus(id, { waitMs: 3000 });
    if (!st) return void fail('not_found', `job ${id}`, {});
    if (['completed', 'failed', 'cancelled'].includes(st.status)) {
        const text = st.text ?? '';
        if (JSON_MODE) { ndjson({ type: 'done', ok: st.status === 'completed', data: { job_id: id, text, status: st.status }, ctx: ctxSummary() }); }
        else { console.log(text || `(${st.status}, no text)`); footer(); }
        if (st.status !== 'completed') exitCode = 5;
        return;
    }
    if (!JSON_MODE) console.log('\x1b[2m[attach] 流式接回…\x1b[0m');
    const stream = await streamJob(id, { fromSeq: flags.fromSeq ?? 1, onDelta: (d) => { if (JSON_MODE) { if (flags.stream) ndjson({ type: 'delta', text: d }); } else process.stdout.write(d); } });
    if (!JSON_MODE) process.stdout.write('\n');
    const final = await pollStatus(id, { waitMs: 30_000 });
    // authoritative job text 优先——断流重接的残件不能盖过服务端成文
    const text = final?.text || stream.streamed || '';
    saveState({ lastJob: { id, type: final?.type ?? state.lastJob?.type, status: final?.status ?? 'unknown', at: Date.now(), chars: text.length } });
    if (JSON_MODE) { ndjson({ type: 'done', ok: final?.status !== 'failed', data: { job_id: id, text, status: final?.status }, ctx: ctxSummary() }); }
    else footer(`${text.length}ch`);
    if (final?.status === 'failed') exitCode = 5;
}

async function cmdAbort() {
    const id = positional[1] || state.lastJob?.id;
    if (!id) return void fail('usage', 'uberge abort <jobId>', { rc: 2 });
    await req('POST', `/api/generation/${encodeURIComponent(id)}/abort`, {});
    if (JSON_MODE) return out({ aborted: id });
    console.log(`aborted ${String(id).slice(0, 8)}`);
    footer();
}

async function cmdPersona() {
    const name = positional[1];
    if (!name) {
        const p = state.persona ?? 'User';
        if (JSON_MODE) return out({ persona: p });
        console.log(`persona = ${p}${flags.desc ? `\n${flags.desc}` : ''}`);
        return;
    }
    saveState({ persona: name });
    if (JSON_MODE) return out({ persona: name });
    console.log(`persona = ${name}`);
}

async function cmdPresets() {
    const { data } = await req('GET', '/api/presets/list?apiId=openai', undefined, { allowFail: true });
    const names = data?.names ?? (Array.isArray(data) ? data : []);
    if (JSON_MODE) return out(names, [{ cmd: 'uberge preset <name>' }]);
    for (const n of names) console.log(` ${n === state.preset ? '*' : ' '} ${n}`);
    footer();
    return names;
}

async function cmdPreset() {
    if (flags.off) {
        saveState({ preset: null });
        if (JSON_MODE) return out({ preset: null });
        console.log('preset = (服务端默认 settings.preset_settings_openai)');
        return;
    }
    const name = positional[1];
    if (!name) return void fail('usage', 'uberge preset <name>|--off', { rc: 2 });
    const names = await cmdPresetsQuiet();
    if (Array.isArray(names) && names.length && !names.includes(name)) {
        const close = names.filter(n => n.includes(name));
        return void fail(close.length ? 'ambiguous' : 'not_found', `preset "${name}"`, { detail: (close.length ? close : names).slice(0, 10).join(' | ') });
    }
    saveState({ preset: name });
    if (JSON_MODE) return out({ preset: name });
    console.log(`preset = ${name}`);
}
async function cmdPresetsQuiet() {
    const { data } = await req('GET', '/api/presets/list?apiId=openai', undefined, { allowFail: true });
    return data?.names ?? (Array.isArray(data) ? data : null);
}

async function cmdSwipe() {
    const c = needCtx(); if (!c) return;
    // 导航模式(不生成)
    if (positional[1] !== undefined || flags.list) {
        const cur = await getChat(c.charDir, c.chatName);
        if (!Array.isArray(cur)) return void fail('not_found', 'chat unreadable');
        saveState({ integrity: cur[0]?.chat_metadata?.integrity ?? state.integrity });
        const idx = cur.length - 1;
        const m = cur[idx];
        const swipes = Array.isArray(m?.swipes) ? m.swipes : [];
        if (!swipes.length) return void fail('no_swipe', '末楼无 swipes', { hint: '先 uberge swipe 生成一版' });
        if (flags.list) {
            if (JSON_MODE) return out({ swipe_id: m.swipe_id ?? 0, total: swipes.length, swipes: swipes.map(s => trunc(s, 120)) });
            swipes.forEach((s, i) => console.log(`${i === (m.swipe_id ?? 0) ? '*' : ' '} ${i}: ${trunc(s, 100)}`));
            return;
        }
        const n = Number(positional[1]);
        if (!Number.isInteger(n) || n < 0 || n >= swipes.length) {
            return void fail('usage', `swipe N ∈ [0,${swipes.length - 1}]`, { detail: swipes.map((s, i) => `${i}: ${trunc(s, 40)}`).join(' | '), rc: 2 });
        }
        const info = Array.isArray(m.swipe_info) ? m.swipe_info[n] : null;
        const ops = [
            { op: 'add', path: `/${idx - 1}/swipe_id`, value: n },
            { op: 'replace', path: `/${idx - 1}/mes`, value: swipes[n] },
        ];
        if (info) {
            for (const k of ['send_date', 'gen_started', 'gen_finished', 'extra']) {
                if (info[k] !== undefined) ops.push({ op: 'add', path: `/${idx - 1}/${k}`, value: info[k] });
            }
        }
        await patchFloors(ops);
        if (JSON_MODE) return out({ swipe_id: n, total: swipes.length, mes: swipes[n] });
        console.log(`swipe ${n + 1}/${swipes.length}\n${swipes[n]}`);
        footer();
        return;
    }
    // 生成模式
    await runGeneration('swipe');
}

// ═══ 组件面(cordis fiber ↔ CLI 动词一一对应)═══
// uberge-library  → worlds / wi
// uberge-mvu      → mvu(状态板=卡内悬浮窗的数据源)
// uberge-diag     → kernel(路由+服务清单)
// uberge-plugins  → plugins / plugin(生命周期:enable|disable|reload)
// uberge-script   → script(服务端 STscript runner)

async function cmdWorlds() {
    const { data } = await req('GET', '/api/uberge/worlds');
    const items = data?.items ?? [];
    if (JSON_MODE) return out(items, [{ cmd: 'uberge wi <name>', why: '看条目' }]);
    for (const w of items) console.log(` ${w.name}${w.displayName !== w.name ? `  (${w.displayName})` : ''}`);
    console.log(`\n${items.length} world books`);
    next('uberge wi <name>');
    footer();
}

async function cmdWi() {
    const name = positional[1];
    if (!name) return void fail('usage', 'uberge wi <book>', { hint: 'uberge worlds 看列表', rc: 2 });
    const { data, status } = await req('GET', `/api/uberge/worlds/${encodeURIComponent(name)}`, undefined, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('not_found', `world book: ${name}`, { hint: 'uberge worlds 看列表' });
    const entries = Object.entries(data?.doc?.entries ?? {});
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data.doc, null, 2)); warn(`wrote ${flags.out}`); }
    const rows = entries.map(([uid, e]) => ({
        uid,
        keys: (e.key ?? e.keys ?? []).join(','),
        comment: e.comment ?? e.keyprimary?.join(',') ?? '',
        pos: e.position, constant: !!e.constant, depth: e.depth ?? null,
        disabled: !!(e.disable ?? e.disabled),
    }));
    if (JSON_MODE) return out({ book: data.name, count: rows.length, entries: flags.full ? rows : rows.slice(0, flags.n ?? 25) });
    console.log(`${data.name} — ${rows.length} entries`);
    for (const r of rows.slice(0, flags.n ?? 25)) {
        const marks = [r.constant ? '❗' : ' ', r.disabled ? '·off' : ''].join('');
        console.log(` ${marks} ${String(r.uid).padEnd(4)} ${trunc(r.comment || r.keys, 50)}  ${r.keys ? `\x1b[2m${trunc(r.keys, 40)}\x1b[0m` : ''}`);
    }
    if (!flags.full && rows.length > (flags.n ?? 25)) console.log(`  …+${rows.length - (flags.n ?? 25)}(--full/--out 展开)`);
    footer();
}

async function cmdKernel() {
    const { data } = await req('GET', '/api/uberge/_kernel');
    const routes = data?.routes ?? [];
    const services = data?.services ?? [];
    if (JSON_MODE) return out(data);
    console.log(`routes: ${routes.length}`);
    for (const r of routes) console.log(`  ${typeof r === 'string' ? r : `${r.method ?? '?'} ${r.path ?? ''}`}`);
    console.log(`services: ${services.length}`);
    for (const s of services) console.log(`  ${typeof s === 'string' ? s : s.name ?? JSON.stringify(s)}`);
    footer();
}

async function cmdPlugins() {
    const { data, status } = await req('GET', '/api/uberge/plugins', undefined, { allowFail: true });
    if (status >= 400) return void fail('server', `plugins 列表失败:${data?.error ?? 'denied?'}`, { hint: '需要 admin profile' });
    const items = data?.items ?? [];
    if (JSON_MODE) return out(items, [{ cmd: 'uberge plugin <id> <enable|disable|reload>' }]);
    for (const p of items) console.log(` ${p.disabled ? '\x1b[2m○\x1b[0m' : '\x1b[32m●\x1b[0m'} ${p.id ?? p.name}${p.version ? ` v${p.version}` : ''}${p.disabled ? ' (disabled)' : ''}`);
    console.log(`\n${items.length} fibers`);
    next('uberge plugin <id> <enable|disable|reload>');
    footer();
}

async function cmdPlugin() {
    const id = positional[1], verb = positional[2];
    if (!id || !['enable', 'disable', 'reload'].includes(verb)) {
        return void fail('usage', 'uberge plugin <id> <enable|disable|reload>', { hint: 'uberge plugins 看清单', rc: 2 });
    }
    const { data, status } = await req('POST', `/api/uberge/plugins/${encodeURIComponent(id)}/${verb}`, {}, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `${verb} ${id} 失败:${data?.error ?? 'unknown'}`, { hint: id === 'uberge-plugins' ? '插件管理器自锁,改 profile.patch.yaml' : undefined });
    if (JSON_MODE) return out(data);
    console.log(`${verb} → ${id}: ${data?.ok ? 'ok' : JSON.stringify(data)}`);
    footer();
}

function mvuTarget() {
    const c = needCtx();
    if (!c) return null;
    return { avatar_url: `${c.charDir}.png`, file_name: `${c.chatName}.jsonl` };
}

async function cmdMvu() {
    const sub = positional[1] ?? 'state';
    const t = mvuTarget();
    if (!t) return;
    if (sub === 'state') {
        const q = `avatar_url=${encodeURIComponent(t.avatar_url)}&file_name=${encodeURIComponent(t.file_name)}`;
        const { data, status } = await req('GET', `/api/uberge/mvu/state?${q}`, undefined, { allowFail: true });
        if (status >= 400 || data?.error) return void fail('server', `mvu state 失败:${data?.error ?? ''}`, { hint: '卡可能无 MVU 变量——send 生成一轮后再看' });
        const vars = data?.chatVariables ?? data?.variables ?? {};
        const keys = Object.keys(vars);
        if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
        if (JSON_MODE) return out(data);
        console.log(`chat variables: ${keys.length}`);
        for (const k of keys.slice(0, flags.n ?? 30)) {
            const v = vars[k];
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            console.log(`  ${k} = ${trunc(s, 90)}`);
        }
        if (!flags.full && keys.length > (flags.n ?? 30)) console.log(`  …+${keys.length - (flags.n ?? 30)}(--out 全量)`);
        const receipts = data?.receipts ?? data?.log ?? [];
        if (receipts.length) console.log(`mvu receipts: ${receipts.length}(--out 看明细)`);
        footer();
        return;
    }
    if (sub === 'settle' || sub === 'resettle') {
        const body = { ...t };
        if (sub === 'settle' && flags.floor != null) body.message_index = flags.floor;
        const { data, status } = await req('POST', `/api/uberge/mvu/${sub}`, body, { allowFail: true });
        if (status >= 400 || data?.error) return void fail('server', `mvu ${sub} 失败:${JSON.stringify(data?.error ?? data)}`);
        if (JSON_MODE) return out(data);
        console.log(`mvu ${sub}: ${data?.ok ? 'ok' : 'done'} ${trunc(JSON.stringify(data).slice(0, 200), 200)}`);
        footer();
        return;
    }
    fail('usage', 'uberge mvu [state|settle [--floor i]|resettle]', { rc: 2 });
}

async function cmdScript() {
    const script = await readTextArg(positional.slice(1));
    if (!script) return void fail('usage', 'uberge script <stscript|--stdin>', { hint: '例:uberge script "/echo hi"', rc: 2 });
    const c = needCtx() ?? {};
    const { data, status } = await req('POST', '/api/uberge/script/run', {
        script,
        ...(c.charDir ? { charDir: c.charDir } : {}),
        ...(c.chatName ? { chatName: c.chatName } : {}),
    }, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `script run 失败:${data?.error ?? ''}`);
    if (JSON_MODE) return out(data);
    if (data.pipe != null && data.pipe !== '') console.log(typeof data.pipe === 'string' ? data.pipe : JSON.stringify(data.pipe, null, 2));
    const side = [data.ops?.length ? `ops:${data.ops.length}` : null, data.notifications?.length ? `notify:${data.notifications.length}` : null, data.popups?.length ? `popup:${data.popups.length}` : null, data.isAborted ? 'aborted' : null].filter(Boolean).join(' · ');
    if (side) console.log(`\x1b[2m${side}\x1b[0m`);
    footer();
}

async function cmdTh() {
    // uberge-th fiber:TavernHelper 兼容调用面。METHODS 见插件源码。
    const method = positional[1];
    if (!method) return void fail('usage', 'uberge th <method> [json-args|--stdin]', {
        detail: 'getVariables|replaceVariables|insertOrAssignVariables|deleteVariable|getChatMessages|triggerSlash|getCharacter|getCurrentCharacterName|getLastMessageId|getCurrentMessageId|getEmbeddedScripts',
        rc: 2,
    });
    let args = {};
    if (flags.stdin) { try { args = JSON.parse(await readTextArg([])) ?? {}; } catch { args = {}; } }
    else if (positional[2] !== undefined) { try { args = JSON.parse(positional.slice(2).join(' ')) ?? {}; } catch { return void fail('usage', 'args 必须是 JSON', { rc: 2 }); } }
    const c = needCtx() ?? {};
    const { data, status } = await req('POST', '/api/uberge/th/call', {
        method,
        target: { ...(c.charDir ? { charDir: c.charDir } : {}), ...(c.chatName ? { chatName: c.chatName } : {}) },
        args,
    }, { allowFail: true });
    if (data?.unsupported) return void fail('not_found', `th method unsupported: ${method}`, { hint: '方法名拼写——见 usage detail' });
    if (status >= 400 || data?.ok === false) return void fail('server', `th ${method} 失败:${data?.error ?? status}`, { detail: data });
    if (JSON_MODE) return out(data);
    console.log(JSON.stringify(data?.result ?? data, null, 2).slice(0, flags.full ? 1e9 : 8000));
    footer();
}

async function cmdRaw() {
    // 逃生舱:kernel 路由表上任何端点都能直达——写动词(PUT/PATCH/DELETE)
    // 不必为每条 REST 面单开命令。读面优先用具名命令(输出已整理)。
    const method = String(positional[1] ?? 'GET').toUpperCase();
    const path = positional[2];
    if (!path?.startsWith('/')) return void fail('usage', 'uberge raw <METHOD> </path> [json|--stdin]', { hint: 'uberge kernel 看路由表', rc: 2 });
    let body;
    if (flags.stdin) { const t = await readTextArg([]); try { body = JSON.parse(t); } catch { body = t; } }
    else if (positional[3] !== undefined) { try { body = JSON.parse(positional.slice(3).join(' ')); } catch { body = positional.slice(3).join(' '); } }
    const { data, status } = await req(method, path, body, { allowFail: true });
    if (JSON_MODE) return out({ status, data });
    if (status >= 400) return void fail('server', `${method} ${path} → ${status}`, { detail: typeof data === 'string' ? trunc(data, 200) : data });
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2).slice(0, flags.full ? 1e9 : 8000));
    footer(`${method} ${path} → ${status}`);
}

// ═══ dispatch ═══
try {
    switch (CMD) {
        case undefined: await cmdBare(); break;
        case 'status': await cmdStatus(); break;
        case 'doctor': await cmdDoctor(); break;
        case 'schema': console.log(JSON.stringify(SCHEMA, null, 2)); break;
        case 'chars': await cmdChars(); break;
        case 'chats': await cmdChats(); break;
        case 'recent': await cmdRecent(); break;
        case 'use': await cmdUse(); break;
        case 'chat-new': await cmdChatNew(); break;
        case 'chat-rename': await cmdChatRename(); break;
        case 'chat-delete': await cmdChatDelete(); break;
        case 'history': await cmdHistory(); break;
        case 'edit': await cmdEdit(); break;
        case 'jobs': await cmdJobs(); break;
        case 'inspect': await cmdInspect(); break;
        case 'preview': await cmdPreview(); break;
        case 'attach': await cmdAttach(); break;
        case 'abort': await cmdAbort(); break;
        case 'persona': await cmdPersona(); break;
        case 'presets': await cmdPresets(); break;
        case 'preset': await cmdPreset(); break;
        case 'send': case 'say': case 'regen': case 'continue': case 'impersonate': case 'quiet': {
            const text = CMD === 'send' || CMD === 'say' || CMD === 'quiet'
                ? await readTextArg(positional.slice(1))
                : null;
            if ((CMD === 'send' || CMD === 'say' || CMD === 'quiet') && !text && !flags.empty) {
                fail('usage', `${CMD} 需要文本(或 --stdin/--empty)`, { rc: 2 });
                break;
            }
            await runGeneration(CMD === 'quiet' ? 'quiet' : CMD, { promptText: text });
            break;
        }
        case 'swipe': await cmdSwipe(); break;
        case 'worlds': await cmdWorlds(); break;
        case 'wi': await cmdWi(); break;
        case 'kernel': case 'caps': await cmdKernel(); break;
        case 'plugins': await cmdPlugins(); break;
        case 'plugin': await cmdPlugin(); break;
        case 'mvu': await cmdMvu(); break;
        case 'script': case 'stscript': await cmdScript(); break;
        case 'th': await cmdTh(); break;
        case 'raw': await cmdRaw(); break;
        case 'help': case '--help': case '-h':
            console.log('uberge — agent-first CLI。裸跑看状态,`uberge schema` 看自描述目录,`uberge doctor` 体检。文档:.loom/capabilities/cli-client/capability.md');
            break;
        default:
            fail('usage', `unknown command: ${CMD}`, { hint: 'uberge schema 看命令面', rc: 2 });
    }
} catch (e) {
    const code = e.code ?? (e.status ? 'server' : 'network');
    fail(code, e.message, {
        status: e.status, detail: e.data,
        hint: code === 'session' ? '会话/CSRF 失败——确认 server 起在 loopback 白名单面' : code === 'network' ? 'server 不可达——uberge doctor 体检' : undefined,
        rc: code === 'session' || code === 'network' ? 4 : (e.status === 409 ? 3 : 1),
    });
}
ring(CMD ?? '?', exitCode);
process.exit(exitCode);
