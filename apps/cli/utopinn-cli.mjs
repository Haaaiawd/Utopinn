#!/usr/bin/env node
/**
 * utopinn — Utopinn 服务端大脑的命令行薄客户端(agent-first 设计)。
 * 规格:.loom/capabilities/cli-client/capability.md(唯一契约,先读它)。
 * 零依赖:Node ≥22 原生 fetch + WebSocket。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const VERSION = '0.3.0';
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
    else if (a === '--fresh') flags.fresh = true;
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
    else if (a === '--json-file') flags.jsonFile = argv[++i];
    else if (a === '--file') flags.file = argv[++i];
    else if (a === '--name') flags.name = argv[++i];
    else if (a === '--id') flags.id = argv[++i];
    else if (a === '--value') flags.value = argv[++i];
    else if (a === '--label') flags.label = argv[++i];
    else if (a === '--code') flags.code = argv[++i];
    else if (a === '--dir') flags.dir = argv[++i];
    else if (a === '--html') flags.html = true;
    else if (a === '--api') flags.api = argv[++i];
    else if (a === '--kind') flags.kind = argv[++i];
    else if (a === '--lvl') flags.lvl = argv[++i];
    else if (a === '--since') flags.since = argv[++i];
    else if (a === '--tail') flags.n = Number(argv[++i]);
    else if (a === '--job') flags.job = argv[++i];
    else if (a === '--conflict') flags.conflict = argv[++i];
    else if (a === '--as') flags.as = argv[++i];
    else if (a === '--mode') flags.mode = argv[++i];
    else if (a === '--handle') flags.handle = argv[++i];
    else if (a === '--chat') flags.chat = argv[++i];
    else if (a === '--card') flags.card = argv[++i];
    else if (a === '--settle') flags.settle = Number(argv[++i]);
    else if (a === '--mount-id') flags.mountId = argv[++i];
    else if (a === '--with-parent-doc') flags.withParentDoc = true;
    else if (a === '--via') flags.via = argv[++i];
    else if (a === '--group') flags.group = argv[++i];
    else if (a === '--gchat') flags.gchat = argv[++i];
    else if (a === '--member') flags.member = argv[++i];
    else if (a === '--no-chain') flags.noChain = true;
    else if (a === '--global') flags.global = true;
    else if (a === '--enable') flags.enable = true;
    else if (a === '--disable') flags.disable = true;
    else if (a === '--allow') flags.allow = true;
    else if (a === '--disallow') flags.disallow = true;
    else if (a === '--put') flags.put = true;
    else if (a === '--delete') flags.deleteFlag = true;
    else if (a === '--by') flags.by = argv[++i];
    else if (a === '--range') flags.range = argv[++i];
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
if (process.env.UTOPINN_JSON === '1') flags.json = true;

// ═══ state(唯一事实源,凭证零落盘)═══
const STATE_PATH = (() => {
    if (flags.state) return resolve(flags.state);
    const envPath = process.env.UTOPINN_STATE || process.env.UBERGE_STATE;
    if (envPath) return resolve(envPath);
    const np = homedir() + '/.utopinn-cli.json', op = homedir() + '/.uberge-cli.json';
    return existsSync(np) || !existsSync(op) ? np : op; // 改名后旧 state 文件兜底读
})();
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

const SERVER = (flags.server || process.env.UTOPINN_SERVER || state.server || DEFAULT_SERVER).replace(/\/+$/, '');
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
        fail('no_ctx', 'no active char/chat', { hint: 'utopinn use <char> [chat]', nexts: [{ cmd: 'utopinn chars', why: '挑一张卡' }], rc: 2 });
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
    // kernel GET chats:{items:[{fileName,messageCount,lastMessage,updatedAt,…}]}
    // → legacy 别名原位映射(file_name/sort_time/mes/chat_items),调用方不动。
    const url = '/api/utopinn/characters/' + encodeURIComponent(charDir) + '/chats';
    const { data } = await req('GET', url, undefined, { allowFail: true });
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map(i => ({ ...i, file_name: i.fileName, sort_time: i.updatedAt, mes: i.lastMessage?.mes ?? '', chat_items: i.messageCount }));
}
async function getChat(charDir, chatName) {
    // kernel GET chat:{header,messages,…};missing→404,unreadable→{corrupted:true}
    // → legacy 线形 [header, …floors] | {new_chat:true} | {corrupted:true}(调用方契约不动)
    const url = '/api/utopinn/characters/' + encodeURIComponent(charDir) + '/chats/' + encodeURIComponent(chatName);
    const { data, status } = await req('GET', url, undefined, { allowFail: true });
    if (data?.corrupted) return { corrupted: true };
    if (status === 404) return { new_chat: true };
    if (status !== 200) { const e = new Error(`chat get → ${status}`); e.status = status; e.code = 'server'; throw e; }
    return [data.header ?? {}, ...(Array.isArray(data.messages) ? data.messages : [])];
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
    fail('not_found', `character not found: "${name}"`, { detail: chars.map(c => stripExt(c.avatar, 'png')).slice(0, 12).join(' | '), hint: `共 ${chars.length} 张,utopinn chars 看全表` });
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
        fail('not_found', `no chats for ${charDir}`, { hint: 'utopinn chat-new <name> 建一个' });
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
    fail('not_found', `chat not found: "${name}"`, { detail: names.slice(0, 10).join(' | '), hint: '新聊天用 utopinn chat-new <name>' });
    return null;
}

// ═══ 写盘(utopinn REST:append=POST messages / patch=PATCH chat)═══
// TASK-032:写盘面已统一进 utopinn fiber——ack/integrity/gen-id/settle 与 legacy 同机制。
// patch 的 op path 用 /body/<i> 命名空间(utopinn doc = {header, body:[]})。
async function writeOp(op, body, { retried = false } = {}) {
    const { charDir, chatName } = needCtx();
    const base = `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`;
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
        // utopinn ConflictError 回 {error:'integrity_mismatch', actual}——直接拿 actual 重锚。
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
            nexts: [{ cmd: `utopinn attach ${active.id}` }, { cmd: `utopinn abort ${active.id}` }],
            rc: 3,
        });
        return active.id;
    }
    return null;
}

// ═══ TASK-037 群聊:ctx 解析 + 群写盘(/api/chats/group/* 同 /group/get|append|patch 契约)═══
// persist key = {kind:'group', id:chatId}——chatId 是群聊文件名(=群 doc.chat_id,
// 群档多聊时可 ≠ groupId);--gchat 显式覆盖,缺省取 doc.chat_id ?? doc.id。
async function resolveGroup(fuzzy) {
    const { data } = await req('POST', '/api/groups/all');
    const groups = Array.isArray(data) ? data : [];
    const token = String(fuzzy ?? '');
    const exact = groups.find(g => String(g.id) === token || g.name === token);
    if (exact) return exact;
    const partial = groups.filter(g => String(g.id).includes(token) || g.name?.includes(token));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
        fail('ambiguous', `"${token}" matches ${partial.length} groups`, { detail: partial.map(g => `${g.id}:${g.name}`).join(' | '), hint: '用完整 id 或更长的名' });
        return null;
    }
    fail('not_found', `group not found: "${token}"`, { detail: groups.map(g => `${g.id}:${g.name}`).slice(0, 12).join(' | '), hint: 'utopinn groups 看全表' });
    return null;
}

/**
 * 群 ctx:--group 显式 | state.group 绑定。chatId 三级:--gchat > state.group.chatId >
 * doc.chat_id ?? doc.id。member 透传服务端 force 选择(--member > state.group.member)。
 * 返回 null 且已 fail 时调用方直接 return。
 */
async function needGroupCtx() {
    const token = flags.group ?? state.group?.id;
    if (!token) {
        fail('no_ctx', 'no active group', { hint: 'utopinn guse <group> 绑定,或 --group <id|name> 单次', rc: 2 });
        return null;
    }
    const doc = await resolveGroup(token);
    if (!doc) return null;
    const chatId = stripExt(flags.gchat ?? state.group?.chatId ?? doc.chat_id ?? doc.id, 'jsonl');
    return {
        groupId: String(doc.id),
        groupName: doc.name ?? String(doc.id),
        chatId: String(chatId),
        member: flags.member ?? state.group?.member ?? null,
        doc,
    };
}

async function getGroupChat(chatId) {
    const { data } = await req('POST', '/api/chats/group/get', { id: chatId });
    return data; // [header+meta, ...floors] | [] (缺档)
}

/** group/append|patch:与 writeOp 同款 integrity CAS 重锚重试;payload 命名域 = legacy 契约。 */
async function groupWriteOp(op, chatId, body, { retried = false } = {}) {
    const isAppend = op === 'append';
    const payload = isAppend
        ? { id: chatId, messages: body.messages, ...(body.luker_generation_id ? { luker_generation_id: body.luker_generation_id } : {}) }
        : { id: chatId, operations: body.operations ?? body.ops, ...(body.luker_generation_id ? { luker_generation_id: body.luker_generation_id } : {}) };
    if (!flags.force && state.integrity) payload.integrity = state.integrity;
    if (flags.force) payload.force = true;
    try {
        const { data } = await req('POST', `/api/chats/group/${op}`, payload);
        if (data?.integrity) saveState({ integrity: data.integrity });
        return data;
    } catch (e) {
        const isIntegrity409 = e.status === 409 && /integrity/i.test(JSON.stringify(e.data ?? '') + e.message);
        if (isIntegrity409 && !retried && !flags.force) {
            warn('integrity 409 — 重锚后重试一次');
            const fresh = String(e.data?.actual || '') || (await getGroupChat(chatId))?.[0]?.chat_metadata?.integrity || '';
            if (fresh) saveState({ integrity: fresh });
            payload.integrity = fresh;
            const { data } = await req('POST', `/api/chats/group/${op}`, payload);
            if (data?.integrity) saveState({ integrity: data.integrity });
            return data;
        }
        throw e;
    }
}
const groupAppendFloors = (chatId, messages, extra = {}) => groupWriteOp('append', chatId, { messages, ...extra });
const groupPatchFloors = (chatId, operations, extra = {}) => groupWriteOp('patch', chatId, { operations, ...extra });

async function checkNoActiveGroupJob(chatId) {
    const { data } = await req('POST', '/api/backends/chat-completions/jobs/active', {
        persist_target: { kind: 'group', id: chatId },
    }, { allowFail: true });
    const jobs = Array.isArray(data?.jobs) ? data.jobs : (Array.isArray(data) ? data : []);
    const active = jobs.find(j => ['running', 'queued', 'persisting', 'awaiting_ack'].includes(j.status));
    if (active) {
        fail('active_job', `group chat has active job ${active.id}`, {
            detail: `status=${active.status}`,
            hint: '等它完,或恢复/中止',
            nexts: [{ cmd: `utopinn attach ${active.id}` }, { cmd: `utopinn abort ${active.id}` }],
            rc: 3,
        });
        return active.id;
    }
    return null;
}

/** 群 AI 楼层形:getFirstCharacterMessage/saveReply 同位(name+original_avatar+force_avatar+extra.gen_id)。 */
function groupAssistantFloor({ member, text, jobId, model, genStarted, genFinished, genId }) {
    return {
        name: member?.name ?? 'Assistant',
        is_user: false, is_system: false,
        send_date: isoNow(), mes: text,
        ...(member?.avatar ? { original_avatar: member.avatar, force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(member.avatar)}` } : {}),
        gen_started: genStarted ?? isoNow(), gen_finished: genFinished ?? isoNow(),
        extra: { api: 'cli', model: model ?? '', ...(jobId ? { luker_generation_id: jobId } : {}), ...(genId != null ? { gen_id: genId } : {}) },
    };
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
        // kernel GET /jobs/:id 是 legacy jobs/status 的字段超集(status/persisted 同名)。
        const { data } = await req('GET', `/api/utopinn/jobs/${encodeURIComponent(jobId)}`, undefined, { allowFail: true });
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
    // 群路由:--group 或 guse 绑定 → 群生成面(成员选择在服务端,
    // 单卡 ctx 缺失不算错——群与单卡是两套 ctx)
    if (flags.group !== undefined || state.group?.id) {
        return runGroupGeneration(verb, { promptText });
    }
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
            fail('no_ai_floor', 'regen 需要末楼是 AI 楼', { hint: '末楼是 user——用 send 续对话', nexts: [{ cmd: 'utopinn send "…"' }] });
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
    const { headers } = await req('POST', '/api/utopinn/generate', body, { timeout: flags.wait ?? DEFAULT_WAIT_MS });
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
    const failedUpstream = status?.status === 'failed' || status?.status === 'cancelled' || (stream.error && !text);
    const writeResult = await writeClientOwnedFloor(verb, { jobId, text, status, floorsData, genStarted: new Date(started).toISOString(), genFinished, charName, failedUpstream });

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

/**
 * TASK-037 群生成主流程。与 runGeneration 同构,但:
 * - 成员选择完全在服务端(body.groupId);--member → force(legacy force_chid)
 * - send 的用户楼先经 /group/append 落盘(legacy 契约:用户楼是客户端写的)
 * - regen 在群里 = normal 追加生成(legacy generateType 映射),不删楼
 * - send/regen 省 persist_target → 服务端填成员楼层字段自动落盘;
 *   swipe/continue/impersonate/quiet → kind:'none',客户端写盘(成员字段
 *   取自 x-utopinn-group 头)
 * - x-utopinn-group.queue 是本轮激活队列:queue[1..] 逐个 member force
 *   接力(一成员一 job,TASK-037 契约),--no-chain 只发第一人
 */
async function runGroupGeneration(verb, { promptText = null } = {}) {
    const gctx = await needGroupCtx();
    if (!gctx) return null;
    const { groupId, chatId, member } = gctx;

    if (await checkNoActiveGroupJob(chatId)) return null;

    const typeMap = { send: 'normal', regen: 'regenerate', swipe: 'swipe', continue: 'continue', impersonate: 'impersonate', quiet: 'quiet' };
    const type = typeMap[verb] ?? 'normal';
    let floorsData = null;
    if (verb === 'send') {
        const cur = await getGroupChat(chatId).catch(() => null);
        if (Array.isArray(cur) && cur.length) {
            saveState({ integrity: cur[0]?.chat_metadata?.integrity ?? state.integrity, floors: cur.length - 1 });
        }
        if (!flags.empty) {
            const wr = await groupAppendFloors(chatId, [userFloor({ persona: flags.user ?? state.persona ?? 'User', text: promptText ?? '' })]);
            saveState({ floors: (state.floors ?? 0) + 1 });
            ndjson({ type: 'write', op: 'append-user', appended: wr?.appended ?? 1, integrity: wr?.integrity });
            if (!JSON_MODE) console.log(`\x1b[36m${flags.user ?? state.persona ?? 'User'}\x1b[0m\n${promptText}\n`);
        }
    } else if (verb === 'say') {
        const wr = await groupAppendFloors(chatId, [userFloor({ persona: flags.user ?? state.persona ?? 'User', text: promptText })]);
        saveState({ floors: (state.floors ?? 0) + 1 });
        ndjson({ type: 'done', ok: true, data: { said: true, appended: wr?.appended ?? 1 }, ctx: ctxSummary() });
        if (!JSON_MODE) footer('said');
        return { said: true };
    } else if (verb === 'swipe' || verb === 'continue') {
        floorsData = await getGroupChat(chatId);
        saveState({ integrity: floorsData[0]?.chat_metadata?.integrity ?? state.integrity, floors: floorsData.length - 1 });
        const last = floorsData.at(-1);
        if (verb === 'swipe' && (!last || last.is_user)) {
            fail('no_swipe', '末楼不可 swipe(user 楼或空聊天)', { hint: 'swipe 作用在成员楼上' });
            return null;
        }
        if (verb === 'continue' && (!Array.isArray(floorsData) || floorsData.length < 2)) {
            fail('no_floor', '空聊天无可续楼层', {});
            return null;
        }
    } else if (verb === 'regen') {
        // legacy:群 regen 映射 normal——不删楼、不 swipe,纯追加。预取只为锚 integrity。
        floorsData = await getGroupChat(chatId);
        saveState({ integrity: floorsData[0]?.chat_metadata?.integrity ?? state.integrity, floors: floorsData.length - 1 });
    }

    // 单次群派发:成员在服务端选(或 member force);返回 {text,status,groupReport,streamed}
    const runOne = async ({ memberToken = null, typeOverride = null, quietOverrides = null }) => {
        const jobId = randomUUID();
        const body = {
            groupId,
            chatId,
            type: typeOverride ?? type,
            stream: !flags.noStream,
            presetName: flags.preset ?? state.preset ?? undefined,
            user: { name: flags.user ?? state.persona ?? 'User' },
            generation_overrides: flags.set ?? {},
            luker_generation: { job_id: jobId },
        };
        if (memberToken) body.member = memberToken;
        if (quietOverrides) body.overrides = quietOverrides;
        // kind:'none' 动词客户端写盘;持久动词省 persist_target → 服务端
        // persistTargetDefault 已带 kind:group+成员楼层字段(original_avatar/
        // force_avatar/gen_id),自动落盘——比客户端手填更权威。
        const memberType = ['swipe', 'continue', 'impersonate', 'quiet'].includes(typeOverride ?? type);
        if (memberType) body.luker_generation.persist_target = { kind: 'none' };
        ndjson({ type: 'meta', cmd: verb, job_id: jobId, group: groupId, chat: chatId });
        const started = Date.now();
        saveState({ lastJob: { id: jobId, type: typeOverride ?? type, status: 'running', at: Date.now() } });
        const { data: postData, headers } = await req('POST', '/api/utopinn/generate', body, { timeout: flags.wait ?? DEFAULT_WAIT_MS });
        if (postData?.skipped === 'no_activated_member') {
            return { jobId, text: '', skipped: true, groupReport: postData?.group ?? null, streamed: '' };
        }
        const groupReport = (() => { try { return JSON.parse(headers.get('x-utopinn-group') ?? 'null'); } catch { return null; } })();
        const stream = await streamJob(jobId, {
            onDelta: (d) => {
                if (JSON_MODE) { if (flags.stream) ndjson({ type: 'delta', text: d }); }
                else if (!flags.quietMode) process.stdout.write(d);
            },
            onReasoning: (d) => {
                if (JSON_MODE) { if (flags.stream) ndjson({ type: 'reasoning', text: d }); }
                else if (!flags.quietMode) process.stdout.write(`\x1b[2m${d}\x1b[0m`);
            },
        });
        if (!JSON_MODE) process.stdout.write('\n');
        const status = await pollStatus(jobId, { waitMs: 4_000, breakOn: ['awaiting_ack'] }) ?? {};
        const text = String(status?.text ?? '') || stream.streamed;
        return { jobId, text, status, groupReport, streamed: stream.streamed, elapsed: Date.now() - started };
    };

    const first = await runOne({
        memberToken: member,
        quietOverrides: verb === 'quiet' && promptText ? { quietPrompt: promptText } : null,
    });
    if (first.skipped) {
        ndjson({ type: 'done', ok: true, data: { job_id: null, skipped: 'no_activated_member', group: first.groupReport } });
        if (!JSON_MODE) footer('queue empty — 只有用户楼落盘');
        return { skipped: true, group: first.groupReport };
    }
    const speakerName = first.groupReport?.member?.name;
    if (!JSON_MODE && speakerName) process.stdout.write(`\x1b[2m—— ${speakerName}\x1b[0m\n`);

    // kind:'none' 动词:客户端按群楼层形写盘(ack 由 luker_generation_id 走)
    const failedUpstream = first.status?.status === 'failed' || first.status?.status === 'cancelled';
    if (!failedUpstream && first.text && !first.status?.persisted) {
        if (verb === 'swipe' || verb === 'continue') {
            const lastIdx = floorsData.length - 1;
            const last = floorsData[lastIdx];
            const bodyIdx = lastIdx - 1;
            if (verb === 'swipe') {
                const oldSwipes = Array.isArray(last.swipes) ? last.swipes : [];
                const oldInfo = Array.isArray(last.swipe_info) ? last.swipe_info : [];
                const floorEntry = { send_date: last.send_date, gen_started: last.gen_started, gen_finished: last.gen_finished, extra: last.extra ?? {} };
                const baseSwipes = oldSwipes.length ? oldSwipes : [last.mes ?? ''];
                const baseInfo = baseSwipes.map((_, i) => oldInfo[i] ?? floorEntry);
                await groupPatchFloors(chatId, [
                    { op: 'add', path: `/body/${bodyIdx}/swipes`, value: [...baseSwipes, first.text] },
                    { op: 'add', path: `/body/${bodyIdx}/swipe_info`, value: [...baseInfo, { send_date: isoNow(), gen_started: new Date().toISOString(), gen_finished: isoNow(), extra: { api: 'cli', model: first.status?.model ?? '', luker_generation_id: first.jobId } }] },
                    { op: 'add', path: `/body/${bodyIdx}/swipe_id`, value: baseSwipes.length },
                    { op: 'add', path: `/body/${bodyIdx}/mes`, value: first.text },
                ], { luker_generation_id: first.jobId });
            } else {
                const merged = String(last.mes ?? '') + first.text;
                const ops = [{ op: 'add', path: `/body/${bodyIdx}/mes`, value: merged }];
                const swipes = Array.isArray(last.swipes) ? last.swipes : null;
                const swipeId = Number.isInteger(last.swipe_id) ? last.swipe_id : null;
                if (swipes && swipeId != null && swipeId < swipes.length) {
                    ops.push({ op: 'add', path: `/body/${bodyIdx}/swipes/${swipeId}`, value: merged });
                }
                ops.push({ op: 'add', path: `/body/${bodyIdx}/gen_finished`, value: isoNow() });
                await groupPatchFloors(chatId, ops, { luker_generation_id: first.jobId });
            }
            ndjson({ type: 'write', op: `patch-${verb}`, applied: true });
        } else if (verb === 'impersonate' && flags.write) {
            await groupAppendFloors(chatId, [userFloor({ persona: first.text ? (flags.user ?? state.persona ?? 'User') : 'User', text: first.text })], { luker_generation_id: first.jobId });
            saveState({ floors: (state.floors ?? 0) + 1 });
        }
    }

    // 队列接力:queue[1..] 每成员一个独立 job(force member + 服务端落盘)
    const queueTail = (!member && !flags.noChain && ['send', 'regen'].includes(verb))
        ? (first.groupReport?.queue ?? []).slice(1)
        : [];
    const chained = [];
    for (const avatar of queueTail) {
        const step = await runOne({ memberToken: avatar, typeOverride: 'normal' });
        chained.push({ avatar, name: step.groupReport?.member?.name ?? null, job_id: step.jobId, chars: step.text.length });
        if (!JSON_MODE) process.stdout.write(`\x1b[2m—— ${step.groupReport?.member?.name ?? avatar}\x1b[0m\n`);
    }

    const finalStatus = first.status;
    saveState({
        lastJob: { id: first.jobId, type, status: finalStatus?.status ?? 'unknown', at: Date.now(), chars: first.text.length },
        lastReplyPreview: trunc(first.text, 80),
        floors: (state.floors ?? 0) + (first.status?.persisted ? 1 : 0) + chained.filter(c => c.name).length,
    });
    ring(CMD, failedUpstream ? 5 : 0, { job: first.jobId.slice(0, 8) });
    const data = {
        job_id: first.jobId, text: first.text,
        member: first.groupReport?.member ?? null,
        group: { groupId, chatId, queue: first.groupReport?.queue ?? [] },
        chained: chained.length ? chained : undefined,
        status: finalStatus?.status, persisted: Boolean(finalStatus?.persisted), elapsed_ms: first.elapsed,
    };
    if (JSON_MODE) {
        ndjson({ type: 'done', ok: !failedUpstream, data, ctx: ctxSummary() });
    } else {
        if (failedUpstream) warn(`upstream failed: ${finalStatus?.error ?? 'unknown'}`);
        footer(`${first.elapsed}ms · ${first.text.length}ch${chained.length ? ` · +${chained.length} members` : ''}`);
    }
    if (failedUpstream) { exitCode = 5; return null; }
    return data;
}

function genNextFor(verb, failed) {
    const traceHint = { cmd: `utopinn trace ${state.lastJob?.id ?? ''}`.trim(), why: '注入时序' };
    if (failed) return [{ cmd: 'utopinn inspect', why: '看 job 错误与 WI 轨迹' }, traceHint, { cmd: `utopinn attach ${state.lastJob?.id ?? ''}`.trim(), why: '对账终态' }];
    switch (verb) {
        case 'send': return [{ cmd: 'utopinn send "…"', why: '继续' }, { cmd: 'utopinn swipe', why: '换一版' }, traceHint];
        case 'regen': case 'swipe': return [{ cmd: 'utopinn swipe', why: '再换一版' }, { cmd: 'utopinn send "…"', why: '接着聊' }];
        case 'continue': return [{ cmd: 'utopinn continue', why: '再续' }, { cmd: 'utopinn send "…"' }];
        default: return [{ cmd: 'utopinn history -n 3' }, { cmd: 'utopinn send "…"' }];
    }
}

// ═══ SIGINT:detach 不杀 job(设计铁律 7)═══
process.on('SIGINT', () => {
    const j = state.lastJob;
    process.stderr.write(`\n[cli] interrupted${j ? ` — job ${j.id} still running` : ''}\n`);
    if (j) process.stderr.write(`[cli] resume: utopinn attach ${j.id}\n`);
    process.exit(6);
});

// ═══ stdin 文本源 ═══
async function readStdinBuffer() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks);
}
async function readTextArg(rest) {
    if (flags.stdin) return (await readStdinBuffer()).toString('utf8');
    return rest.join(' ');
}
/**
 * 编辑类写动词的 JSON 文档源:--json-file f | --stdin | 位置参 inline JSON。
 * 成功回 parsed doc;任何失败已 fail() 并回 undefined(调用方直接 return)。
 */
async function readJsonBody(rest, usageStr) {
    let raw;
    if (flags.jsonFile) {
        try { raw = readFileSync(resolve(flags.jsonFile), 'utf8'); }
        catch (e) { fail('usage', `--json-file 读取失败: ${e.message}`, { rc: 2 }); return undefined; }
    } else {
        raw = await readTextArg(rest);
    }
    if (!String(raw ?? '').trim()) { fail('usage', usageStr, { rc: 2 }); return undefined; }
    try { return JSON.parse(raw); }
    catch (e) { fail('usage', `JSON parse 失败: ${e.message}`, { detail: trunc(String(raw), 140), rc: 2 }); return undefined; }
}

// ═══ 命令实现 ═══
async function cmdBare() {
    // 零网络:纯快照+建议(设计铁律 1)
    const c = ctxSummary();
    if (JSON_MODE) return out({ snapshot: c, recent: state.recent?.slice(-5) }, bareNext());
    console.log(`\x1b[1mutopinn\x1b[0m ${SERVER}${c.charName ? ` — ${c.charName} @ ${c.chatName}` : ''}`);
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
    if (!state.char?.dir) return [{ cmd: 'utopinn chars', why: '选卡' }, { cmd: 'utopinn doctor', why: '体检链路' }];
    return [{ cmd: 'utopinn send "…"', why: '发消息' }, { cmd: 'utopinn status', why: '在线刷新' }, { cmd: 'utopinn history -n 5', why: '看上文' }];
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
        // kernel GET /jobs 客户端过滤替代 legacy jobs/active:
        // chatKey=char:<avatar_url>:<chatName-noext>(与 getPersistChatKey 同构)。
        const chatKey = `char:${c.charDir}.png:${c.chatName}`;
        const { data: active } = await req('GET', '/api/utopinn/jobs', undefined, { allowFail: true });
        const jobs = (Array.isArray(active?.items) ? active.items : []).filter(j => j.chatKey === chatKey || j.chatKey == null);
        const running = jobs.filter(j => ['running', 'queued', 'persisting', 'awaiting_ack'].includes(j.status));
        const snap = { ...ctxSummary(), floors, integrity, swipe: lastSwipe, activeJobs: running.map(j => ({ id: j.id, status: j.status })) };
        if (JSON_MODE) return out(snap, running.length ? [{ cmd: `utopinn attach ${running[0].id}` }] : genNextFor('status', false));
        console.log(`${c.charName} @ ${c.chatName} · floors ${floors} · integrity ${(integrity ?? '—').slice(0, 10)}`);
        if (lastSwipe) console.log(`  last floor swipe ${lastSwipe.n}/${lastSwipe.total}`);
        console.log(running.length ? `  ⚠ active jobs: ${running.map(j => `${j.id.slice(0, 8)}:${j.status}`).join(', ')}` : '  no active jobs');
        footer();
        nextHints = running.length ? [{ cmd: `utopinn attach ${running[0].id}` }] : bareNext();
        if (nextHints.length) console.log(`\x1b[2m· next: ${nextHints.map(n => n.cmd).join(' · ')}\x1b[0m`);
        return snap;
    }
    const c2 = ctxSummary();
    if (JSON_MODE) return out(c2, bareNext());
    console.log(`server ${SERVER} · no ctx`);
    console.log(`\x1b[2m· next: utopinn chars · utopinn doctor\x1b[0m`);
    return c2;
}

// ═══ 具名路由表:字面钉样 + 词表派生对账 ═══
// doctor "capability coverage" 拿本表 diff kernel 路由全集,未具名=raw-only 待补面
// (kernel list() 的 "METHOD|kind|path" 串格式;--full 打印差集)。
//
// 本块同时是 test-cli-routes.cjs 的对账锚 —— 它只扫 'METHOD|kind|path' 单引号
// 字面量与 kernel 双向对账,故钉样必须保持字面形态(字面块存在的唯一理由)。
// 真源是下方词表常量:程序化构造族(route(tail)/plugins verb/mvu sub)的合法词表
// 与命令实现共用,加载期自检断言 派生 ≡ 钉样程序化段 —— 单向漂移当场拒跑(exit 2),
// 不再靠人肉对表。字面族(命令按路径直呼的真·单例)直接列,由 kernel 侧对账钉存在性。
const NAMED_UTOPINN_ROUTES = new Set([
    'GET|exact|/api/utopinn/_kernel',
    // —— diag 观测面(logs/errors/diag-client/trace;diag/stats 属 OBSERVED 观测命名)——
    'GET|pattern|/api/utopinn/diag/events',
    'GET|pattern|/api/utopinn/diag/errors',
    'GET|pattern|/api/utopinn/diag/stats',
    'POST|pattern|/api/utopinn/diag/client',
    'GET|pattern|/api/utopinn/diag/jobs/:id/trace',
    // —— stats 聚合面(stats/stats char/stats inject)——
    'GET|pattern|/api/utopinn/stats/summary',
    'GET|pattern|/api/utopinn/stats/by-char/:id',
    'GET|pattern|/api/utopinn/stats/inject',
    // —— job 面(jobs/inspect/abort)——
    'GET|pattern|/api/utopinn/jobs',
    'GET|pattern|/api/utopinn/jobs/:id',
    'POST|pattern|/api/utopinn/jobs/:id/abort',
    'POST|pattern|/api/utopinn/generate',
    'POST|pattern|/api/utopinn/preview',
    // —— 生成写盘(writeOp:send/say append;edit/swipe/continue patch)——
    'POST|pattern|/api/utopinn/characters/:charDir/chats/:chatName/messages',
    'PATCH|pattern|/api/utopinn/characters/:charDir/chats/:chatName',
    // —— library 读面(chars/chats 显示已切 kernel;legacy 仅留内部解析用)——
    'GET|pattern|/api/utopinn/characters',
    'GET|pattern|/api/utopinn/characters/:charDir',
    'PATCH|pattern|/api/utopinn/characters/:charDir',
    // —— regex 管理面(utopinn-regex:global/char/preset 三层)——
    'GET|pattern|/api/utopinn/regex',
    'PUT|pattern|/api/utopinn/regex',
    'PATCH|pattern|/api/utopinn/regex/:id',
    'DELETE|pattern|/api/utopinn/regex/:id',
    'GET|pattern|/api/utopinn/characters/:charDir/chats',
    'GET|pattern|/api/utopinn/characters/:charDir/chats/:chatName',
    // —— library 写面 + chat 生命周期(chat-new 是懒建坐标,chat-create 立即建文件)——
    'PUT|pattern|/api/utopinn/characters/:charDir/chats/:chatName',
    'PUT|pattern|/api/utopinn/characters/:charDir/chats/:chatName/document',
    'POST|pattern|/api/utopinn/characters/:charDir/chats/:chatName/rename',
    'DELETE|pattern|/api/utopinn/characters/:charDir/chats/:chatName',
    'POST|pattern|/api/utopinn/chats/recent',
    'GET|pattern|/api/utopinn/worlds',
    'GET|pattern|/api/utopinn/worlds/:name',
    'PUT|pattern|/api/utopinn/worlds/:name',
    'DELETE|pattern|/api/utopinn/worlds/:name',
    'GET|pattern|/api/utopinn/presets',
    'GET|pattern|/api/utopinn/presets/:name',
    'PUT|pattern|/api/utopinn/presets/:name',
    'DELETE|pattern|/api/utopinn/presets/:name',
    'GET|pattern|/api/utopinn/personas',
    'PUT|pattern|/api/utopinn/personas/:avatar',
    'DELETE|pattern|/api/utopinn/personas/:avatar',
    'GET|pattern|/api/utopinn/settings',
    'PATCH|pattern|/api/utopinn/settings',
    'GET|pattern|/api/utopinn/secrets',
    'PUT|pattern|/api/utopinn/secrets/:key',
    'DELETE|pattern|/api/utopinn/secrets/:key/:id',
    // —— 连接面(conn test / models)——
    'POST|pattern|/api/utopinn/connection/test',
    'GET|pattern|/api/utopinn/models',
    // —— 组件面(plugins 列表/contrib/script/th 是字面单例)——
    'GET|pattern|/api/utopinn/plugins',
    'GET|exact|/api/utopinn/ui/contrib',
    'POST|pattern|/api/utopinn/script/run',
    'POST|pattern|/api/utopinn/th/call',
    // —— 数据面(import/backup/lan)——
    'POST|pattern|/api/utopinn/import/scan-st',
    'POST|pattern|/api/utopinn/import/preview',
    'POST|pattern|/api/utopinn/import/commit',
    'POST|pattern|/api/utopinn/backup',
    'POST|pattern|/api/utopinn/lan/offer',
    'POST|pattern|/api/utopinn/lan/import',
    // ═══ 程序化构造族的钉样展开(词表派生的冻结输出;改词表必须同步此段,自检强制)═══
    // —— 源 PLUGIN_VERBS:plugin <id> <verb> ——
    'POST|pattern|/api/utopinn/plugins/:id/enable',
    'POST|pattern|/api/utopinn/plugins/:id/disable',
    'POST|pattern|/api/utopinn/plugins/:id/reload',
    // —— 源 MVU_SUB_ROUTES:mvu <sub>(state=GET 读面;panel 打 render 端点)——
    'GET|pattern|/api/utopinn/mvu/state',
    'POST|pattern|/api/utopinn/mvu/settle',
    'POST|pattern|/api/utopinn/mvu/resettle',
    'POST|pattern|/api/utopinn/mvu/panel/render',
    // —— 源 STATE_OPS:state <family> <op>(get 的 GET/POST 双形都占具名位)——
    'GET|pattern|/api/utopinn/state/chat/get',
    'POST|pattern|/api/utopinn/state/chat/get',
    'POST|pattern|/api/utopinn/state/chat/get-batch',
    'POST|pattern|/api/utopinn/state/chat/patch',
    'POST|pattern|/api/utopinn/state/chat/delete',
    'GET|pattern|/api/utopinn/state/char/get',
    'POST|pattern|/api/utopinn/state/char/get',
    'POST|pattern|/api/utopinn/state/char/get-batch',
    'POST|pattern|/api/utopinn/state/char/set',
    'POST|pattern|/api/utopinn/state/char/patch',
    'POST|pattern|/api/utopinn/state/char/delete',
    'GET|pattern|/api/utopinn/state/preset/get',
    'POST|pattern|/api/utopinn/state/preset/get',
    'POST|pattern|/api/utopinn/state/preset/get-batch',
    'POST|pattern|/api/utopinn/state/preset/patch',
    'POST|pattern|/api/utopinn/state/preset/delete',
    'POST|pattern|/api/utopinn/state/preset/delete-all',
    'POST|pattern|/api/utopinn/state/preset/rename',
]);

// ═══ 具名派生源:词表常量(命令实现与具名表共用,单事实源)═══
// state 三族命名域照抄 kernel 路由(utopinn-library.js state 段):
//   chat={get,get-batch,patch,delete};char +set(整态覆写);preset +delete-all/rename。
const STATE_OPS = {
    chat: ['get', 'get-batch', 'patch', 'delete'],
    char: ['get', 'get-batch', 'set', 'patch', 'delete'],
    preset: ['get', 'get-batch', 'patch', 'delete', 'delete-all', 'rename'],
};

// plugin <id> <verb> —— cmdPlugin 的门词表;路由形 POST /plugins/:id/<verb>。
const PLUGIN_VERBS = ['enable', 'disable', 'reload'];

// mvu <sub> —— cmdMvu 的门词表。sub→路由非均匀(state=GET 读面,panel 打
// panel/render 端点,仅 settle/resettle 是统一 POST mvu/<sub>),故记 sub→具名串。
const MVU_SUB_ROUTES = {
    state: 'GET|pattern|/api/utopinn/mvu/state',
    settle: 'POST|pattern|/api/utopinn/mvu/settle',
    resettle: 'POST|pattern|/api/utopinn/mvu/resettle',
    panel: 'POST|pattern|/api/utopinn/mvu/panel/render',
};
// 统一 POST mvu/<sub> 形的子集(cmdMvu 的 settle|resettle 分支用)——从表派生。
const MVU_POST_SUBS = Object.keys(MVU_SUB_ROUTES)
    .filter((s) => MVU_SUB_ROUTES[s] === `POST|pattern|/api/utopinn/mvu/${s}`);

// 观测面命名:在 kernel 路由表且被具名,但没有任何 CLI 动词拼它 —— 刻意留名
// (doctor 不报 raw-only),逐条注释理由;新条目必须带理由。
const OBSERVED_NAMED = [
    // diag-bus 聚合统计口:logs/errors/trace 已覆盖读面,此 GET 留观测命名(raw 可达)。
    'GET|pattern|/api/utopinn/diag/stats',
];

/** 词表 → 具名串展开(程序化构造族 + OBSERVED)。字面族单例不参与 —— 只在钉样里。 */
function expandNamedRoutes() {
    const out = [];
    for (const [family, ops] of Object.entries(STATE_OPS)) {
        for (const op of ops) {
            out.push(`POST|pattern|/api/utopinn/state/${family}/${op}`);
            // get 的 --via get 走 GET+query(ETag 私有化读,kernel 双注册)
            if (op === 'get') out.push(`GET|pattern|/api/utopinn/state/${family}/get`);
        }
    }
    for (const verb of PLUGIN_VERBS) out.push(`POST|pattern|/api/utopinn/plugins/:id/${verb}`);
    out.push(...Object.values(MVU_SUB_ROUTES), ...OBSERVED_NAMED);
    return new Set(out);
}

/** 程序化构造族的钉样条目判别(route(tail) 三族:state/plugins :id/mvu)。 */
const isProgrammaticNamed = (r) => r.includes('/api/utopinn/state/')
    || r.includes('/api/utopinn/plugins/:id/')
    || r.includes('/api/utopinn/mvu/');

// ── 加载期对账:词表派生 ≡ 钉样程序化段。失同步 = 仓库内 bug(改词表漏钉/钉样残留),
// 任何 utopinn 调用当场拒跑 —— 不靠人肉对表,也不等 e2e 才报。
const _DERIVED_NAMED = expandNamedRoutes();
const _unpinned = [..._DERIVED_NAMED].filter((r) => !NAMED_UTOPINN_ROUTES.has(r));
const _stale = [...NAMED_UTOPINN_ROUTES].filter(isProgrammaticNamed).filter((r) => !_DERIVED_NAMED.has(r));
if (_unpinned.length || _stale.length) {
    for (const r of _unpinned) console.error(`named-routes drift: 词表派生出未钉路由 — ${r}(往钉样补字面量)`);
    for (const r of _stale) console.error(`named-routes drift: 钉样残留词表已无的路由 — ${r}(删之,或确属观测面进 OBSERVED_NAMED)`);
    process.exit(2);
}

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
        const { data } = await req('GET', '/api/utopinn/_kernel');
        const routes = (data?.routes ?? []).map(r => String(r));
        const named = NAMED_UTOPINN_ROUTES;
        const uncovered = routes.filter(r => !named.has(r) && !r.startsWith('upgrade|'));
        return `${routes.length} routes · named ${routes.length - uncovered.length} · raw-only ${uncovered.length}${flags.full && uncovered.length ? ` (${uncovered.join(', ')})` : ''}`;
    });
    const allOk = steps.every(s => s.ok);
    if (JSON_MODE) return out({ steps, ok: allOk }, allOk ? bareNext() : [{ cmd: 'utopinn doctor', why: '修完重验' }]);
    for (const s of steps) {
        console.log(`${s.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${s.name} — ${s.detail}${s.hint ? `  \x1b[2m(${s.hint})\x1b[0m` : ''}`);
    }
    footer();
    return { ok: allOk, steps };
}

const SCHEMA = {
    version: VERSION,
    commands: [
        { cmd: 'utopinn', desc: '状态快照+next(零网络)', out: 'snapshot' },
        { cmd: 'utopinn status', desc: '在线 ctx/floors/integrity/active jobs', out: 'ctx+jobs' },
        { cmd: 'utopinn doctor', desc: '链路体检(server/session/ws/ctx)', out: 'steps[]' },
        { cmd: 'utopinn schema', desc: '本目录(self-describing)', out: 'schema' },
        { cmd: 'utopinn chars [-n N]', desc: '角色列表', out: '[{dir,name,chat}]' },
        { cmd: 'utopinn chats [--char d]', desc: '当前/指定角色聊天列表', out: '[{name,floors,last}]' },
        { cmd: 'utopinn recent [-n N]', desc: '跨角色最近聊天', out: '[{char,chat,time}]' },
        { cmd: 'utopinn use <char> [chat]', desc: '选卡+聊天(模糊匹配,chat 缺省=最新)', out: 'ctx' },
        { cmd: 'utopinn groups', desc: '群列表(id/name/members/chat_id/strategy)', out: '[{id,name,members,chat_id}]' },
        { cmd: 'utopinn guse <id|name> [chatId]', desc: '绑群 ctx(send/regen/swipe 等自动走群路由;--member 点名,--gchat 换聊,--no-chain 只发第一人)', out: 'ctx' },
        { cmd: 'utopinn chat-new <name>', desc: '新聊天坐标(首条 send 建文件)', out: 'chat' },
        { cmd: 'utopinn chat-create <name>', desc: '[library] 立即建空聊天文件(PUT;chat-new 是懒建)', out: '{ok,integrity}' },
        { cmd: 'utopinn chat-put [doc]', desc: '[library] 整文档替换(legacy /save 等价;--json-file/--stdin;CAS 自动+409 重锚)', out: '{ok,integrity,floors}' },
        { cmd: 'utopinn chat-get [chat]', desc: '[library] utopinn doc 全文{header,messages,integrity}', out: '{doc}' },
        { cmd: 'utopinn chat-rename <new>', desc: '重命名当前聊天', out: 'renamed' },
        { cmd: 'utopinn chat-delete <name>', desc: '删除指定聊天(显式名)', out: 'deleted' },
        { cmd: 'utopinn char <name>', desc: '[library] 角色卡全文(模糊名→目录名)', out: '{card}' },
        { cmd: 'utopinn char-edit <name> [json|--json-file|--stdin|--set k=v]', desc: '[library] 卡字段 merge-patch(11 个字符串字段+tags+extensions{world|alternate_greetings|regex_scripts};name 只改显示名不动 charDir)', out: '{card}' },
        { cmd: 'utopinn send <text>|--stdin', desc: 'append user 楼+生成+append AI 楼', out: 'stream text + footer' },
        { cmd: 'utopinn say <text>', desc: '只写 user 楼不生成', out: 'floor' },
        { cmd: 'utopinn regen', desc: '删末 AI 楼重生成', out: 'stream text' },
        { cmd: 'utopinn swipe [N]|--list', desc: '末楼换一版/导航/列表', out: 'stream|swipe state' },
        { cmd: 'utopinn continue', desc: '末楼续写(合入同楼)', out: 'stream delta' },
        { cmd: 'utopinn impersonate [--write]', desc: '生成 user 口吻草稿(默认不落盘)', out: 'draft text' },
        { cmd: 'utopinn quiet <prompt>', desc: 'quiet 生成(不落盘)', out: 'final text' },
        { cmd: 'utopinn history [-n N] [--floor i] [--full] [--out f]', desc: '楼层回放', out: '[floor]' },
        { cmd: 'utopinn edit <floor> <text|--stdin>', desc: '改楼层(swipes 同步)', out: 'updated' },
        { cmd: 'utopinn jobs [-n N]', desc: 'job 列表', out: '[job]' },
        { cmd: 'utopinn inspect [jobId] [--section s]', desc: 'job trace/sources/WI', out: 'detail' },
        { cmd: 'utopinn preview [--type t] [-n N]', desc: '干跑组装 messages', out: '[msg]' },
        { cmd: 'utopinn attach [jobId]', desc: '断链恢复(WS resume/status 对账)', out: 'stream|text' },
        { cmd: 'utopinn abort [jobId]', desc: '中止 job', out: 'aborted' },
        { cmd: 'utopinn persona [name]', desc: '查看/设定 persona', out: 'persona' },
        { cmd: 'utopinn personas', desc: '[library] 人设表(avatar/name/default)', out: '[{avatar,name,isDefault}]' },
        { cmd: 'utopinn persona-edit <avatar> [json|--json-file|--stdin|--set k=v]', desc: '[library] 写人设(name/description/position/title/is_default)', out: '{ok,avatar,name}' },
        { cmd: 'utopinn persona-delete <avatar>', desc: '[library] 删人设(personas+desc 双表摘除)', out: '204' },
        { cmd: 'utopinn presets', desc: 'openai 预设列表(kernel)', out: '[name]' },
        { cmd: 'utopinn preset <name>|--off', desc: '绑定预设进 generate.presetName', out: 'preset' },
        { cmd: 'utopinn preset-get <name>', desc: '[library] 预设全文 doc(--api 族,默认 openai)', out: '{name,apiId,doc}' },
        { cmd: 'utopinn preset-edit <name> [json|--json-file|--stdin]', desc: '[library] 预设整档写回(upsert)', out: '{ok,name,apiId}' },
        { cmd: 'utopinn preset-delete <name>', desc: '[library] 删预设(--api 族)', out: '204' },
        { cmd: 'utopinn settings', desc: '[library] 服务端 settings(脱敏视图)', out: '{settings}' },
        { cmd: 'utopinn settings-set <json|--json-file|--stdin>', desc: '[library] settings 受限合并(power_user|extension_settings|oai_settings|world_info_settings|preset_settings_openai)', out: '{settings}' },
        { cmd: 'utopinn secrets', desc: '[secrets] 全键脱敏态(value 恒打码)', out: '{key:[{id,masked,label,active}]}' },
        { cmd: 'utopinn secret-set <key> --value v|--stdin [--label l]', desc: '[secrets] 写新 secret(服务端铸 id,不回显明文)', out: '{ok,id,entries*masked}' },
        { cmd: 'utopinn secret-delete <key> <id>', desc: '[secrets] 按 id 删一条', out: '204' },
        { cmd: 'utopinn conn test', desc: '[connection] 上游连接探测(读 oai_settings+secrets,密钥不回显)', out: '{ok,latencyMs,modelCount?,upstreamStatus,error?}' },
        { cmd: 'utopinn models [--fresh] [-n N]', desc: '[connection] 上游模型清单(30s 缓存,--fresh 强制重拉)', out: '{items:[{id,owned_by?}],stale?}' },
        { cmd: 'utopinn worlds', desc: '[library] 世界书列表', out: '[{name,displayName}]' },
        { cmd: 'utopinn wi <book> [-n N] [--full] [--out f]', desc: '[library] 世界书条目(uid/keys/constant/off)', out: '[entry]' },
        { cmd: 'utopinn world-edit <name> [json|--json-file|--stdin]', desc: '[library] 世界书整档写回{entries:{}}(upsert)', out: '{ok,name}' },
        { cmd: 'utopinn world-delete <name>', desc: '[library] 删世界书(显式名)', out: '204' },
        { cmd: 'utopinn regex [--global|--char d|--preset n --api id] [--full]', desc: '[regex] 三层脚本全量视图/分面明细', out: '{global,allowed,chars,presets}' },
        { cmd: 'utopinn regex --put [arr|--json-file|--stdin] [scope]', desc: '[regex] 该域整组写回(坏正则 400 不落盘)', out: '{ok,count}' },
        { cmd: 'utopinn regex <id> --enable|--disable|--delete [scope]', desc: '[regex] 单条启停/删(id 或下标)', out: '{ok,script|remaining}' },
        { cmd: 'utopinn regex --allow|--disallow --char d|--preset n', desc: '[regex] scoped/preset 放行表开关(character_allowed_regex / preset_allowed_regex)', out: '{ok,allow}' },
        { cmd: 'utopinn kernel', desc: '[diag] cordis 路由+服务清单(能力面)', out: '{routes,services}' },
        { cmd: 'utopinn logs [--kind k] [--lvl l] [-n N|--tail n] [--since ts] [--code c] [--job id]', desc: '[diag] 事件总线日志(http/job/generate/inject/th/plugin/client)', out: '[{seq,ts,lvl,kind,code,msg,ctx,data}]' },
        { cmd: 'utopinn errors [-n N]', desc: '[diag] warn+ 事件快捷面(http_4xx/5xx/job_failed/th/…)', out: '[{…}]' },
        { cmd: 'utopinn trace <jobId>', desc: '[diag] job 聚合回放:状态+注入时序表(preset/charbook/worldinfo/regex/instruct/macro/assemble)+perf+事件', out: '{job,injections,events,perf}' },
        { cmd: 'utopinn diag-client <msg> [--kind k] [--code c] [json|--stdin]', desc: '[diag] 客户端错误上报进服务端总线', out: '{ok,seq}' },
        { cmd: 'utopinn stats [--by char|model|day] [--range 1h|24h|7d|all]', desc: '[stats] 生成量/失败率/token/时延分组表(jobs+inspector 聚合)', out: '{totals,groups[]}' },
        { cmd: 'utopinn stats char <id>', desc: '[stats] 单卡:floors/gens/token/WI 命中频次+top 条目(charDir|卡名)', out: '{floors,generations,wiHits}' },
        { cmd: 'utopinn stats inject [--chat <charDir>/]<chat>', desc: '[stats] 注入源命中率+token 占比;worldinfo 条目级命中表', out: '{sources[],entries[]}' },
        { cmd: 'utopinn plugins', desc: '[plugins] fiber 清单', out: '[{id,disabled}]' },
        { cmd: `utopinn plugin <id> <${PLUGIN_VERBS.join('|')}>`, desc: '[plugins] 组件生命周期(admin)', out: '{ok}' },
        { cmd: 'utopinn contrib', desc: '[plugins] UI 贡献点清单(ui.contrib manifest × 内核映射;admin)', out: '[{plugin,slot,contribution,core?}]' },
        { cmd: `utopinn mvu <${Object.keys(MVU_SUB_ROUTES).join('|')}>`, desc: '[mvu] chat 变量+settle 回执(=悬浮窗数据源;panel 渲染)', out: '{variables,receipts}' },
        { cmd: 'utopinn mvu settle [--floor i]', desc: '[mvu] 手动重结算目标楼层', out: '{ok}' },
        { cmd: 'utopinn mvu resettle', desc: '[mvu] 全量重放投影(编辑/删楼/swipe 后)', out: '{ok}' },
        { cmd: 'utopinn mvu panel <tpl|--file f|--stdin>', desc: '[mvu] 模板×chat变量→面板HTML(--out 落盘,--html 裸输出)', out: '{html}' },
        { cmd: 'utopinn script <stscript|--stdin>', desc: '[script] 服务端 STscript runner(/echo|/gen…)', out: '{pipe,ops,notifications}' },
        { cmd: 'utopinn th <method> [json]', desc: '[th] TavernHelper 调用面(变量/消息/slash)', out: '{result}' },
        { cmd: 'utopinn cardapp <mount|eval|call|op|status|unmount>', desc: '[cardapp] headless CardApp 宿主(jsdom 真跑卡 HTML/JS;一次性进程语义)', out: '{mount,result,console}' },
        { cmd: 'utopinn import-scan <dir>', desc: '[data] 扫 ST default-user 目录→可导入清单(admin)', out: '{counts,items}' },
        { cmd: 'utopinn import-preview <file|--file f|--stdin>', desc: '[data] 格式探测+摘要+冲突,不落库', out: '{kind,summary,warnings,conflicts}' },
        { cmd: 'utopinn import-commit <file|--file f> [--conflict r|o|s] [--as name] [--kind k]', desc: '[data] 显式落库(同名 409→--conflict rename|overwrite|skip)', out: '{ok,targetName,renamed}' },
        { cmd: 'utopinn backup [--out f|dir] [--set cat=bool]', desc: '[data] zip 快照下载落盘(默认 cwd 用服务端文件名)', out: '{file,bytes}' },
        { cmd: 'utopinn lan-offer [--set cat=bool|--json-file sel]', desc: '[data] LAN 迁移 offer→一次性 url', out: '{url,expiresAt}' },
        { cmd: 'utopinn lan-import <url|--code c> [--mode merge|overwrite]', desc: '[data] 拉对端 zip 恢复(慢,--wait)', out: '{mode,restored}' },
        { cmd: `utopinn state chat <${STATE_OPS.chat.join('|')}> <ns…> [ops|--json-file|--stdin]`, desc: '[state] chat_state sidecar(目标=ctx 或 --char/--chat;patch=JSON-Patch;get 默认 POST,--via get 走 ETag 资源读)', out: '{ok,data|applied|deleted}' },
        { cmd: `utopinn state char <${STATE_OPS.char.join('|')}> <ns…> [doc]`, desc: '[state] char_state sidecar(--char|ctx;set=整态覆写,data 必须 JSON 对象)', out: '{ok,data|deleted}' },
        { cmd: `utopinn state preset <${STATE_OPS.preset.join('|')}> <name> <ns…> [--api id]`, desc: '[state] preset_state sidecar(显式名;--api 族默认 openai)', out: '{ok,data|deleted}' },
        { cmd: 'utopinn state preset <delete-all|rename> <name>|<old> <new> [--api id]', desc: '[state] preset 独有:清全 ns →{deleted:n}/ 随名迁移(撞档 409)', out: '{deleted|renamed}' },
        { cmd: 'utopinn raw <M> </path> [json|--stdin]', desc: '逃生舱:任意 REST 端点直达(kernel 表全量可绑)', out: '{status,data}' },
    ],
    flags: ['--json(机器 envelope/生成动词 NDJSON)', '--stream(JSON 时开 delta 帧)', '--full', '--out f', '-n N', '--floor i', '--stdin|-', '--wait ms', '--timeout ms', '--force', '--write', '--quiet', '--no-stream', '--char d', '--user n', '--preset n|--off', '--set k=v', '--from seq', '--type t', '--section s', '--state f', '-s url|UTOPINN_SERVER', '--json-file f(JSON 文档源)', '--file f(二进制/模板载荷)', '--name n', '--id', '--value v', '--label l', '--code c', '--dir d', '--html(裸输出)', '--api apiId', '--kind k', '--conflict p', '--as name', '--mode m', '--handle h', '--chat n(state chat 目标覆盖)', '--via post|get(state get 线形)', '--group id|name(群路由)', '--gchat chatId(群聊文件覆盖)', '--member avatar|dir|name(点名发言)', '--no-chain(群队列只发第一人)', '--lvl l(diag 最低等级)', '--since ts(diag 时间过滤)', '--tail n(-n 别名)', '--job id(diag job 过滤/trace 目标)', '--by char|model|day(stats 分组维)', '--range 1h|24h|7d|all(stats 窗口)'],
    exitCodes: { 0: 'ok', 1: 'server/generic', 2: 'usage', 3: 'conflict(integrity/ambiguous/active_job)', 4: 'network/session', 5: 'upstream failed/cancelled', 6: 'timeout-interrupted(job still running)' },
    errorCodes: ['usage', 'no_ctx', 'not_found', 'ambiguous', 'exists', 'integrity_conflict', 'active_job', 'no_floor', 'no_ai_floor', 'no_swipe', 'new_chat', 'upstream', 'session', 'network', 'timeout', 'server'],
    stateFile: '~/.utopinn-cli.json: {server, char{dir,name}, chat{name}, persona, preset, integrity, floors, lastJob{id,type,status,at,chars}, lastReplyPreview, recent[]}',
    flow: 'send: ctx → jobs/active 护栏 → append user 楼 → POST /api/utopinn/generate → ticket → WS resume from_seq:1 → head/chunk/end 帧 → append AI 楼(顶层+extra gen-id ack) → jobs/status 终态',
};

async function cmdChars() {
    // kernel GET /characters 给 tags/readable;chat 指针只在 legacy all 里 → 双源合并
    const chars = await listChars();
    const { data: kdata, status: kst } = await req('GET', '/api/utopinn/characters', undefined, { allowFail: true });
    const kmap = new Map((kst < 400 && Array.isArray(kdata?.items) ? kdata.items : []).map(i => [i.charDir, i]));
    const rows = chars.map(c => {
        const dir = stripExt(c.avatar, 'png');
        const k = kmap.get(dir) ?? {};
        return { dir, name: c.name ?? k.name ?? '', chat: stripExt(c.chat ?? '', 'jsonl'), tags: k.tags, readable: k.readable };
    });
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(rows, null, 2)); warn(`wrote ${flags.out}`); }
    const show = flags.n ? rows.slice(0, flags.n) : rows;
    if (JSON_MODE) return out(show, [{ cmd: 'utopinn use <dir>', why: '选卡进 ctx' }, { cmd: 'utopinn char <dir>', why: '看卡全文' }]);
    for (const r of show) console.log(`${r.readable === false ? '\x1b[31m!\x1b[0m' : ' '}${r.dir.padEnd(36)} ${r.name} ${r.chat ? `· ${r.chat}` : ''}`);
    console.log(`\n${rows.length} characters`);
    next('utopinn use <dir>');
    footer();
    return rows;
}

async function cmdChats() {
    const charDir = flags.char ? stripExt(flags.char, 'png') : needCtx()?.charDir;
    if (!charDir) return;
    // kernel GET 面(messageCount/lastMessage/updatedAt)优先;缺 items 回退 legacy
    const { data: kdata, status: kst } = await req('GET', `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats`, undefined, { allowFail: true });
    let rows;
    if (kst < 400 && Array.isArray(kdata?.items)) {
        rows = kdata.items.map(i => ({
            name: stripExt(i.name ?? i.fileName ?? '', 'jsonl'),
            floors: i.messageCount ?? null,
            // kernel lastMessage 是整楼层对象,摘 mes;legacy 是字符串
            last: trunc(typeof i.lastMessage === 'object' && i.lastMessage !== null ? (i.lastMessage.mes ?? '') : (i.lastMessage ?? ''), 60),
            time: i.updatedAt ? new Date(i.updatedAt).toISOString().slice(0, 16) : null,
        }));
    } else {
        const chats = await listChats(charDir);
        rows = chats.map(c => ({
            name: stripExt(c.file_name ?? c.name ?? c, 'jsonl'),
            floors: c.chat_items ?? c.message_count ?? null,
            last: trunc(c.mes ?? c.last_mes ?? '', 60),
            time: c.sort_time ? new Date(c.sort_time).toISOString().slice(0, 16) : null,
        }));
    }
    if (JSON_MODE) return out(rows, [{ cmd: 'utopinn use <char> <chat>', why: '切聊天' }, { cmd: 'utopinn chat-new <name>' }]);
    for (const r of rows) console.log(`${r.name === state.chat?.name ? '*' : ' '} ${r.name}  ${r.floors ?? '?'}f  ${r.time ?? ''}  ${r.last}`);
    console.log(`\n${rows.length} chats for ${charDir}`);
    footer();
    return rows;
}

async function cmdRecent() {
    const { data } = await req('POST', '/api/utopinn/chats/recent', {});
    const rows = (Array.isArray(data) ? data : []).slice(0, flags.n ?? 10).map(c => ({
        char: stripExt(c.avatar_url ?? c.avatar ?? '', 'png'),
        chat: stripExt(c.file_name ?? '', 'jsonl'),
        time: c.sort_time ? new Date(c.sort_time).toISOString().slice(0, 16) : null,
    }));
    if (JSON_MODE) return out(rows, [{ cmd: 'utopinn use <char> <chat>' }]);
    for (const r of rows) console.log(`${r.char.padEnd(30)} ${r.chat}  ${r.time ?? ''}`);
    footer();
    return rows;
}

async function cmdUse() {
    const char = await resolveChar(positional[1]);
    if (!char) return;
    const charDir = stripExt(char.avatar, 'png');
    // 新卡无聊天可解析时只绑卡坐标(不隐式建文件——铁律12 防的是
    // typo 变新文件,绑名不建文件);chat-new/chat-create 再补聊天坐标。
    const chats = await listChats(charDir);
    let chatName = null;
    if (positional[2] || chats.length) {
        chatName = await resolveChatForUse(charDir, positional[2], char.chat);
        if (!chatName) return;
    }
    saveState({ char: { dir: charDir, name: char.name ?? charDir }, chat: chatName ? { name: chatName } : null, group: null, floors: null, integrity: null });
    const n = chatName
        ? [{ cmd: 'utopinn history -n 3', why: '看上文' }, { cmd: 'utopinn send "…"', why: '发消息' }]
        : [{ cmd: 'utopinn chat-new <name>', why: '此卡还没有聊天,建一个' }, { cmd: 'utopinn chats', why: '看聊天列表' }];
    if (JSON_MODE) return out({ charDir, charName: char.name, chatName }, n);
    console.log(chatName ? `→ ${char.name ?? charDir} @ ${chatName}` : `→ ${char.name ?? charDir}(无聊天)`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdGroups() {
    const { data } = await req('POST', '/api/groups/all');
    const groups = Array.isArray(data) ? data : [];
    if (JSON_MODE) return out(groups.map(g => ({ id: g.id, name: g.name, members: g.members?.length ?? 0, chat_id: g.chat_id })), [{ cmd: 'utopinn guse <id|name>', why: '绑群 ctx' }]);
    console.log(`\n${'id'.padEnd(14)}  ${'name'.padEnd(20)}  members  chat_id  strategy/mode`);
    for (const g of groups) {
        console.log(`${String(g.id).padEnd(14)}  ${String(g.name ?? '').padEnd(20)}  ${String(g.members?.length ?? 0).padEnd(7)}  ${String(g.chat_id ?? g.id)}  a${g.activation_strategy ?? 0}/g${g.generation_mode ?? 0}`);
    }
    footer(`${groups.length} groups`);
    next([{ cmd: 'utopinn guse <id|name>', why: '绑群 ctx' }]);
    console.log(`\x1b[2m· next: utopinn guse <id|name>\x1b[0m`);
}

/** guse <id|name> [chatId] —— 绑群 ctx 进 state;send 等动词自动走群路由 */
async function cmdGuse() {
    const doc = await resolveGroup(positional[1]);
    if (!doc) return;
    const chatId = stripExt(positional[2] ?? flags.gchat ?? doc.chat_id ?? doc.id, 'jsonl');
    saveState({
        group: { id: String(doc.id), name: doc.name ?? String(doc.id), chatId: String(chatId), member: flags.member ?? null },
        floors: null, integrity: null,
    });
    const n = [
        { cmd: 'utopinn send "…"', why: '用户楼+成员生成' },
        { cmd: 'utopinn send --member <avatar|name> "…"', why: '点名成员' },
        { cmd: 'utopinn use <char> [chat]', why: '回单卡 ctx' },
    ];
    if (JSON_MODE) return out({ groupId: String(doc.id), groupName: doc.name, chatId: String(chatId), members: doc.members ?? [] }, n);
    console.log(`→ group ${doc.name ?? doc.id} @ chat ${chatId}(${doc.members?.length ?? 0} members)`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdChatNew() {
    // 只需 char 坐标——新卡绑卡后 chat 尚不存在,needCtx 会误判 no_ctx。
    const c = { charDir: state.char?.dir ?? (flags.char ? stripExt(flags.char, 'png') : null), charName: state.char?.name ?? null };
    if (!c?.charDir) { fail('no_ctx', '先选卡', { hint: 'utopinn use <char>' }); return; }
    const name = stripExt(positional[1] ?? '', 'jsonl');
    if (!name) return void fail('usage', 'utopinn chat-new <name>', { rc: 2 });
    const chats = await listChats(c.charDir);
    const names = chats.map(x => stripExt(x.file_name ?? x.name ?? x, 'jsonl'));
    if (names.includes(name)) {
        return void fail('exists', `chat exists: ${name}`, { detail: names.filter(n => n.includes(name.slice(0, 8))).join(' | '), rc: 3 });
    }
    saveState({ chat: { name }, floors: 0, integrity: null });
    const n = [{ cmd: 'utopinn send "…"', why: '首条消息自动建文件' }];
    if (JSON_MODE) return out({ chatName: name }, n);
    console.log(`chat = ${name}(空,首条 send 建文件)`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdChatRename() {
    const c = needCtx(); if (!c) return;
    const newName = stripExt(positional[1] ?? '', 'jsonl');
    if (!newName) return void fail('usage', 'utopinn chat-rename <new>', { rc: 2 });
    const { data, status } = await req('POST', `/api/utopinn/characters/${encodeURIComponent(c.charDir)}/chats/${encodeURIComponent(c.chatName)}/rename`, { newName }, { allowFail: true });
    if (status === 404) return void fail('not_found', `chat ${c.chatName} 不存在`, { hint: 'utopinn chats 看列表' });
    if (status === 409) return void fail('exists', `chat exists: ${newName}`, { rc: 3 });
    if (status >= 400 || data?.error) return void fail('server', `rename 失败:${data?.error ?? status}`, { status });
    saveState({ chat: { name: newName } });
    if (JSON_MODE) return out({ renamed: newName, data }, genNextFor('send', false));
    console.log(`renamed → ${newName}`);
    footer();
}

async function cmdChatDelete() {
    const c = needCtx(); if (!c) return;
    const name = stripExt(positional[1] ?? '', 'jsonl');
    if (!name) return void fail('usage', 'utopinn chat-delete <name>(显式名,不给模糊)', { rc: 2 });
    const { data, status } = await req('DELETE', `/api/utopinn/characters/${encodeURIComponent(c.charDir)}/chats/${encodeURIComponent(name)}`, undefined, { allowFail: true });
    if (status === 404) return void fail('not_found', `chat not found: ${name}`, { hint: 'utopinn chats 看列表' });
    if (status >= 400 || data?.error) return void fail('server', `delete 失败:${data?.error ?? status}`, { status });
    if (state.chat?.name === name) saveState({ chat: { name: null }, floors: null, integrity: null });
    if (JSON_MODE) return out({ deleted: name }, [{ cmd: 'utopinn chats' }]);
    console.log(`deleted ${name}`);
    footer();
}

async function cmdHistory() {
    const c = needCtx(); if (!c) return;
    const data = await getChat(c.charDir, c.chatName);
    if (data?.new_chat) { fail('new_chat', 'chat 还没楼层', { hint: 'utopinn send "…" 开第一条' }); return; }
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
    if (JSON_MODE) return out(show, [{ cmd: 'utopinn send "…"' }, { cmd: `utopinn history --floor ${body.length - 1}` }]);
    show.forEach((m, i) => {
        const idx = body.length - show.length + i;
        const sw = Array.isArray(m.swipes) && m.swipes.length > 1 ? ` swipe ${(m.swipe_id ?? 0) + 1}/${m.swipes.length}` : '';
        console.log(`\n\x1b[2m#${idx}\x1b[0m ${m.is_user ? '\x1b[36m' : '\x1b[35m'}${m.name ?? (m.is_user ? 'User' : 'AI')}\x1b[0m${sw}`);
        console.log(flags.full ? m.mes : trunc(m.mes, 300));
    });
    footer();
    nextHints = [{ cmd: 'utopinn send "…"' }, { cmd: `utopinn history -n ${Math.min(body.length, n * 3)}`, why: '看更早' }];
    console.log(`\x1b[2m· next: ${nextHints.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdEdit() {
    const c = needCtx(); if (!c) return;
    const idx = Number(positional[1]);
    if (!Number.isInteger(idx)) return void fail('usage', 'utopinn edit <floor> <text|--stdin>', { rc: 2 });
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
    if (JSON_MODE) return out({ floor: idx, ops: ops.length }, [{ cmd: 'utopinn history -n 3' }]);
    console.log(`floor #${idx} updated(${ops.length} ops)`);
    footer();
}

async function cmdJobs() {
    const { data } = await req('GET', '/api/utopinn/jobs');
    // 服务端实际形状 {items:[{id,status,chatKey,textPreview,persisted,...}]}
    const jobs = (Array.isArray(data?.items) ? data.items : Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : []).slice(0, flags.n ?? 10);
    const rows = jobs.map(j => ({
        id: j.id, status: j.status, persisted: Boolean(j.persisted),
        chat: j.chatKey ?? (j.persist_target ? `${stripExt(j.persist_target.avatar_url ?? '', 'png')}/${stripExt(j.persist_target.file_name ?? '', 'jsonl')}` : null),
        text: trunc(j.textPreview ?? j.text ?? '', 60), at: j.created_at ?? j.at ?? null,
    }));
    if (JSON_MODE) return out(rows, [{ cmd: 'utopinn inspect <id8>', why: '看明细' }]);
    for (const r of rows) console.log(`${String(r.id).slice(0, 8)}  ${r.status?.padEnd(12)} ${r.persisted ? 'persisted' : '         '}  ${r.chat ?? '-'}  ${r.text}`);
    footer();
    return rows;
}

async function cmdInspect() {
    const id = positional[1] || state.lastJob?.id;
    if (!id) return void fail('usage', 'utopinn inspect <jobId>(或先生成一次)', { rc: 2 });
    const { data: d, status } = await req('GET', `/api/utopinn/jobs/${id}`, undefined, { allowFail: true });
    // failed job 自带 error 字段——别把 job 状态误判成 404;not_found 只认 HTTP 404。
    if (!d || status === 404) return void fail('not_found', `job not found: ${id}`, { hint: 'utopinn jobs 看列表' });
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
    if (JSON_MODE) return out({ ...summary, entries: flags.full ? entries : entries.slice(0, 15) }, [{ cmd: 'utopinn inspect --section sources' }]);
    console.log(`job ${String(id).slice(0, 8)} · ${summary.status} · persisted=${summary.persisted} · ${summary.model ?? '?'} · preset ${summary.preset ?? '-'}`);
    console.log(`WI activated ${summary.wiActivated}${summary.elapsed ? ` · ${Math.round(summary.elapsed)}ms` : ''}`);
    for (const w of summary.worlds) console.log(`  ${w.world}: ${w.n}`);
    const show = flags.full ? entries : entries.slice(0, 15);
    for (const e of show) console.log(`  - [${e.world}] ${trunc(e.comment ?? e.key ?? '', 58)} pos=${e.position} depth=${e.depth ?? '-'}`);
    if (!flags.full && entries.length > 15) console.log(`  …+${entries.length - 15} entries(--full 展开)`);
    footer();
}

// ═══ diag 观测面(diag-bus):logs/errors/trace ═══
const DIAG_CTX_SHOW = ['jobId', 'diagId', 'charDir', 'chatId', 'route', 'status', 'verb', 'stage'];
function fmtDiagTs(ts) {
    const t = new Date(ts ?? 0);
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
}
function fmtDiagEvent(e) {
    const color = e.lvl === 'error' ? '\x1b[31m' : e.lvl === 'warn' ? '\x1b[33m' : e.lvl === 'debug' ? '\x1b[2m' : '\x1b[0m';
    const ctxBits = e.ctx
        ? DIAG_CTX_SHOW.filter(k => e.ctx[k] !== undefined).map(k => `${k}=${String(e.ctx[k]).slice(0, 24)}`).join(' ')
        : '';
    let line = `\x1b[2m${fmtDiagTs(e.ts)}\x1b[0m ${color}${String(e.lvl ?? '?').padEnd(5)}\x1b[0m ${String(e.kind ?? '?').padEnd(8)} ${(e.code ?? '').padEnd(18)} ${e.msg ?? ''}`;
    if (ctxBits) line += `  \x1b[2m${ctxBits}\x1b[0m`;
    if (flags.full && e.data !== undefined) line += `\n    \x1b[2m${trunc(JSON.stringify(e.data), 400)}\x1b[0m`;
    return line;
}
function printDiagEvents(items, tag) {
    for (const e of items) console.log(fmtDiagEvent(e));
    footer(`${items.length} events${tag ? ` · ${tag}` : ''}`);
}

async function cmdLogs() {
    const params = new URLSearchParams();
    if (flags.kind) params.set('kind', flags.kind);
    if (flags.lvl) params.set('lvl', flags.lvl);
    if (flags.code) params.set('code', flags.code);
    if (flags.since) params.set('since', flags.since);
    if (flags.job) params.set('job', flags.job);
    params.set('limit', String(flags.n ?? 50));
    const { data, status } = await req('GET', `/api/utopinn/diag/events?${params}`, undefined, { allowFail: true });
    if (status >= 400) return void fail('server', `diag events → ${status}`, { status, detail: data });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(items, [{ cmd: 'utopinn errors' }, { cmd: 'utopinn trace <jobId>' }]);
    printDiagEvents(items, `seq→${data?.seq ?? '?'} size ${data?.size ?? '?'}`);
    return items;
}

async function cmdErrors() {
    const params = new URLSearchParams();
    if (flags.kind) params.set('kind', flags.kind);
    if (flags.since) params.set('since', flags.since);
    params.set('limit', String(flags.n ?? 50));
    const { data, status } = await req('GET', `/api/utopinn/diag/errors?${params}`, undefined, { allowFail: true });
    if (status >= 400) return void fail('server', `diag errors → ${status}`, { status, detail: data });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (JSON_MODE) return out(items, [{ cmd: 'utopinn logs --lvl warn' }]);
    if (!items.length) console.log('no warn+ events');
    printDiagEvents(items);
    return items;
}

async function cmdTrace() {
    const id = positional[1] || flags.job || state.lastJob?.id;
    if (!id) return void fail('usage', 'utopinn trace <jobId>(或先生成一次)', { rc: 2 });
    const { data: d, status } = await req('GET', `/api/utopinn/diag/jobs/${encodeURIComponent(id)}/trace`, undefined, { allowFail: true });
    if (!d || status === 404) return void fail('not_found', `job not found: ${id}`, { hint: 'utopinn jobs 看列表' });
    if (status >= 400) return void fail('server', `trace → ${status}`, { status, detail: d });
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(d, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(d);
    const inj = Array.isArray(d.injections) ? d.injections : [];
    console.log(`job ${String(d.id).slice(0, 8)} · ${d.status} · verb=${d.verb ?? '-'} · model=${d.model || '-'} · chat=${d.chatKey ?? '-'}`);
    if (d.error) console.log(`\x1b[31merror: ${d.error}\x1b[0m`);
    if (inj.length) {
        const SKIP = new Set(['ts', 'seq', 'stage', 'injected', 'tokens', 'ms', 'entries']);
        console.log(`\n\x1b[1m  ${'stage'.padEnd(10)} ${'injected'.padStart(8)} ${'tokens'.padStart(7)} ${'ms'.padStart(7)}\x1b[0m  detail`);
        for (const s of inj) {
            const entries = Array.isArray(s.entries) ? ` entries:${s.entries.length}` : '';
            const detail = Object.entries(s)
                .filter(([k, v]) => !SKIP.has(k) && v !== undefined && v !== null)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? trunc(JSON.stringify(v), 60) : v}`)
                .join(' ');
            console.log(`  ${String(s.stage ?? '?').padEnd(10)} ${String(s.injected ?? '').padStart(8)} ${String(s.tokens ?? '').padStart(7)} ${String(s.ms ?? '').padStart(7)}  ${trunc(detail + entries, 100)}`);
        }
    }
    if (d.perf) {
        const p = d.perf, r1 = (v) => (v == null ? '-' : Math.round(v * 10) / 10);
        console.log(`\nperf: card=${r1(p.cardMs)} load=${r1(p.loadMs)} preset=${r1(p.presetMs)} wi=${r1(p.wiMs)} assemble=${r1(p.assembleMs)} total=${r1(p.totalMs)}ms`);
    }
    const evts = (Array.isArray(d.events) ? d.events : []).filter(e => e.kind !== 'inject');
    if (evts.length) {
        console.log(`\nevents:`);
        for (const e of evts) console.log(`  ${fmtDiagEvent(e)}`);
    }
    footer();
}

// ═══ stats 聚合面(utopinn-stats 插件):summary/by-char/inject ═══
const fmtTok = (v) => (v == null ? '-' : String(Math.round(v)));
const fmtMs = (v) => (v == null ? '-' : `${Math.round(v)}ms`);
const fmtPct = (v) => (v == null ? '-' : `${Math.round(v * 1000) / 10}%`);
const fmtTs = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '-');

async function cmdStats() {
    const sub = positional[1];
    if (sub === 'char') return cmdStatsChar(positional[2]);
    if (sub === 'inject') return cmdStatsInject();
    // 未知子命令按 summary 兜底?不——显式报错,防 `stats chr foo` 静默当总表
    if (sub !== undefined) return void fail('usage', `unknown stats subcommand: ${sub}`, { hint: 'utopinn stats [--by d] [--range r] · utopinn stats char <id> · utopinn stats inject [--chat c]', rc: 2 });
    const params = new URLSearchParams();
    if (flags.by) params.set('by', flags.by);
    if (flags.range) params.set('range', flags.range);
    const qs = params.toString();
    const { data, status } = await req('GET', `/api/utopinn/stats/summary${qs ? `?${qs}` : ''}`, undefined, { allowFail: true });
    if (status >= 400) return void fail('server', `stats summary → ${status}`, { status, detail: data });
    const t = data?.totals ?? {};
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data, [{ cmd: 'utopinn stats inject', why: '看注入源命中/token 占比' }, { cmd: 'utopinn stats char <id>' }]);
    console.log(`\x1b[1mtotals\x1b[0m  gen ${t.generations ?? 0} · ok ${t.completed ?? 0} · fail ${t.failed ?? 0} (${fmtPct(t.failRate)}) · tok in ${fmtTok(t.tokensIn)} out ${fmtTok(t.tokensOut)} · p50 ${fmtMs(t.p50ms)} p95 ${fmtMs(t.p95ms)}${data?.empty ? ' · \x1b[2mempty\x1b[0m' : ''}`);
    if (groups.length) {
        console.log(`\n  ${'key'.padEnd(30)} ${'gen'.padStart(5)} ${'fail'.padStart(5)} ${'failRate'.padStart(9)} ${'tokIn'.padStart(8)} ${'tokOut'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)}`);
        for (const g of groups) {
            console.log(`  ${trunc(g.key, 30).padEnd(30)} ${String(g.generations).padStart(5)} ${String(g.failed).padStart(5)} ${fmtPct(g.failRate).padStart(9)} ${fmtTok(g.tokensIn).padStart(8)} ${fmtTok(g.tokensOut).padStart(8)} ${fmtMs(g.p50ms).padStart(8)} ${fmtMs(g.p95ms).padStart(8)}`);
        }
    }
    next('utopinn stats inject', 'utopinn stats char <id>');
    footer(`by=${data?.by ?? '?'} range=${data?.range ?? '?'}`);
    return data;
}

async function cmdStatsChar(id) {
    const target = id ?? state.char?.dir;
    if (!target) return void fail('usage', 'utopinn stats char <charDir|卡名>', { hint: 'utopinn chars 看目录名', rc: 2 });
    const { data, status } = await req('GET', `/api/utopinn/stats/by-char/${encodeURIComponent(target)}`, undefined, { allowFail: true });
    if (status === 404) return void fail('not_found', `character not found: ${target}`, { hint: 'utopinn chars 看全表' });
    if (status >= 400) return void fail('server', `stats by-char → ${status}`, { status, detail: data });
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data, [{ cmd: `utopinn stats inject --chat <chat>`, why: '该卡注入源明细' }]);
    console.log(`\x1b[1m${data.name || data.charDir}\x1b[0m  \x1b[2m(${data.charDir})\x1b[0m`);
    console.log(`floors ${data.floors ?? 0} · chats ${data.chats ?? 0} · gen ${data.generations ?? 0} (fail ${data.failed ?? 0}) · tok in ${fmtTok(data.tokens?.in)} out ${fmtTok(data.tokens?.out)}`);
    console.log(`WI hits ${data.wiHits ?? 0} across ${data.wiGenerations ?? 0} gen · lastActive ${fmtTs(data.lastActive)}${data.empty ? ' · \x1b[2mempty\x1b[0m' : ''}`);
    const top = Array.isArray(data.wiTop) ? data.wiTop : [];
    if (top.length) {
        console.log('\nWI top:');
        for (const e of top) console.log(`  ${String(e.hits).padStart(4)}× ${e.entry}  \x1b[2m${trunc(e.key ?? '', 48)}\x1b[0m`);
    }
    next(`utopinn stats inject --chat <chat>`);
    footer();
    return data;
}

async function cmdStatsInject() {
    // --chat 接受 <charDir>/<chat> 或裸聊天名(裸名用 ctx charDir 补前缀);
    // 不带 --chat = 全局聚合(全 char 的 inject 事件)。
    let chatParam = flags.chat;
    if (chatParam && !chatParam.includes('/')) {
        if (!state.char?.dir) return void fail('no_ctx', '--chat <chat> 需要 ctx charDir(或给 <charDir>/<chat>)', { hint: 'utopinn use <char> [chat]', rc: 2 });
        chatParam = `${state.char.dir}/${chatParam}`;
    }
    const params = new URLSearchParams();
    if (chatParam) params.set('chat', chatParam);
    const qs = params.toString();
    const { data, status } = await req('GET', `/api/utopinn/stats/inject${qs ? `?${qs}` : ''}`, undefined, { allowFail: true });
    if (status >= 400) return void fail('server', `stats inject → ${status}`, { status, detail: data });
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data, [{ cmd: 'utopinn stats', why: '生成总表' }, { cmd: 'utopinn trace <jobId>', why: '单 job 回放' }]);
    console.log(`inject ${data?.chat ? `@ ${data.chat} ` : ''}· ${data?.events ?? 0} events${data?.empty ? ' · \x1b[2mempty\x1b[0m' : ''}`);
    console.log(`\n  ${'source'.padEnd(11)} ${'events'.padStart(6)} ${'hitRate'.padStart(8)} ${'injected'.padStart(8)} ${'tokAvg'.padStart(8)} ${'msAvg'.padStart(7)}`);
    for (const s of sources) {
        const share = s.tokenShare != null ? ` share=${fmtPct(s.tokenShare)}` : '';
        console.log(`  ${String(s.source).padEnd(11)} ${String(s.events).padStart(6)} ${fmtPct(s.hitRate).padStart(8)} ${String(s.injectedTotal).padStart(8)} ${fmtTok(s.tokensAvg).padStart(8)} ${fmtMs(s.msAvg).padStart(7)}${share}`);
    }
    const wi = sources.find((s) => s.source === 'worldinfo');
    const entries = Array.isArray(wi?.entries) ? wi.entries : [];
    if (entries.length) {
        const show = flags.full ? entries : entries.slice(0, flags.n ?? 15);
        console.log(`\nworldinfo entries(${entries.length}):`);
        for (const e of show) console.log(`  ${String(e.hits).padStart(4)}× ${e.entry}  \x1b[2m${trunc(e.key ?? '', 52)}\x1b[0m`);
        if (!flags.full && entries.length > show.length) console.log(`  …+${entries.length - show.length}(--full/-n 展开)`);
    }
    next('utopinn stats', 'utopinn trace <jobId>');
    footer();
    return data;
}

async function cmdDiagClient() {
    // 把一条"客户端错误"打进服务端总线——验证 POST /diag/client 面,
    // 也是 CLI 自身/脚本报错挂观测面的通道。
    let extra = {};
    if (flags.stdin || positional[2] !== undefined) {
        const doc = await readJsonBody(positional.slice(2), 'diag-client <msg> [json-ctx|--stdin]');
        if (doc === undefined) return;
        extra = doc;
    }
    const msg = positional[1] ?? extra.msg;
    if (!msg) return void fail('usage', 'utopinn diag-client <msg> [--kind k] [--code c] [json|--stdin]', { rc: 2 });
    const { data, status } = await req('POST', '/api/utopinn/diag/client', {
        msg,
        lvl: flags.lvl ?? 'warn',
        kind: flags.kind ?? 'client',
        code: flags.code,
        ctx: { cli: CMD, charDir: state.char?.dir, chatName: state.chat?.name },
        data: extra,
    }, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `diag-client → ${status}`, { status, detail: data });
    if (JSON_MODE) return out(data);
    console.log(`reported seq=${data?.seq}`);
    footer();
}

async function cmdPreview() {
    const c = needCtx(); if (!c) return;
    const type = flags.type ?? 'normal';
    const { data } = await req('POST', '/api/utopinn/preview', { charDir: c.charDir, chatName: c.chatName, type, user: { name: flags.user ?? state.persona ?? 'User' } });
    const msgs = data.messages ?? [];
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out({ count: msgs.length, perf: data.perf, messages: flags.full ? msgs : msgs.slice(0, flags.n ?? 8) }, [{ cmd: 'utopinn send "…"' }]);
    console.log(`messages: ${msgs.length}${data.perf?.totalMs ? ` · ${Math.round(data.perf.totalMs)}ms` : ''}`);
    for (const m of msgs.slice(0, flags.n ?? 8)) {
        console.log(`\x1b[2m[${m.role}${m.name ? ':' + m.name : ''}]\x1b[0m ${trunc(m.content, flags.full ? 1e9 : 150)}`);
    }
    if (!flags.full && msgs.length > (flags.n ?? 8)) console.log(`…+${msgs.length - (flags.n ?? 8)} messages(-n/--full/--out 展开)`);
    footer();
}

async function writeClientOwnedFloor(verb, { jobId, text, status, floorsData, genStarted, genFinished, charName, failedUpstream }) {
    // send/regen 走 append;swipe/continue 走 PATCH /body/<last>;impersonate(--write)写 user 楼。
    // cmdGenerate 流尾与 cmdAttach 断流重接共用——kind:none 的 job 服务端不落盘,只有这条写盘路。
    let writeResult = null;
    if (!failedUpstream && text && !status?.persisted) {
        if (verb === 'send' || verb === 'regen') {
            const floor = assistantFloor({ charName, text, jobId, model: status?.model ?? '', genStarted: genStarted, genFinished });
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
                { op: 'add', path: `/body/${bodyIdx}/swipe_info`, value: [...baseInfo, { send_date: isoNow(), gen_started: genStarted, gen_finished: genFinished, extra: { api: 'cli', model: status?.model ?? '', luker_generation_id: jobId } }] },
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
    return writeResult;
}

async function maybeCompensateAttachWrite(id, final, text) {
    // kind:'none' job 的写盘只有客户端一条路:原进程流中断/超时死掉时,
    // attach 是唯一能补写的地方。覆盖两态:awaiting_ack 存活(写完翻 completed)
    // 与 grace 超期 failed(写完 job 仍 failed,但楼层救回)。
    if (!text || !final || final.persisted) return null;
    const graceExpired = final.status === 'failed' && /within grace/.test(final.error ?? '');
    const inFlight = !['completed', 'failed', 'cancelled'].includes(final.status);
    if (!inFlight && !graceExpired) return null;
    const v = final.verb || (state.lastJob?.id === id ? state.lastJob?.type : null) || flags.as;
    const c = v ? needCtx() : null;
    if (!v || !c || !['send', 'regen', 'swipe', 'continue', 'impersonate'].includes(v)) {
        if (v && !c) warn('attach: 无 ctx,跳过客户端写盘(utopinn use 锁定聊天后可补写)');
        return null;
    }
    const floorsData = await getChat(c.charDir, c.chatName);
    const wr = await writeClientOwnedFloor(v, { jobId: id, text, status: final, floorsData, genStarted: new Date(final.created_at ?? Date.now()).toISOString(), genFinished: isoNow(), charName: c.charName });
    if (wr && graceExpired) warn('attach: grace 已过期——楼层已补写,job 保持 failed(预期)');
    return wr;
}

async function cmdAttach() {
    const id = positional[1] || state.lastJob?.id;
    if (!id) return void fail('usage', 'utopinn attach <jobId>', { rc: 2 });
    const st = await pollStatus(id, { waitMs: 3000 });
    if (!st) return void fail('not_found', `job ${id}`, {});
    if (['completed', 'failed', 'cancelled'].includes(st.status)) {
        const text = st.text ?? '';
        await maybeCompensateAttachWrite(id, st, text);
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
    const graceExpired = final?.status === 'failed' && /within grace/.test(final?.error ?? '');
    const wr = await maybeCompensateAttachWrite(id, final, text);
    if (wr && !graceExpired) { const after = await pollStatus(id, { waitMs: 10_000 }); if (after) Object.assign(final, after); }
    saveState({ lastJob: { id, type: final?.type ?? state.lastJob?.type, status: final?.status ?? 'unknown', at: Date.now(), chars: text.length } });
    if (JSON_MODE) { ndjson({ type: 'done', ok: final?.status !== 'failed', data: { job_id: id, text, status: final?.status }, ctx: ctxSummary() }); }
    else footer(`${text.length}ch`);
    if (final?.status === 'failed') exitCode = 5;
}

async function cmdAbort() {
    const id = positional[1] || state.lastJob?.id;
    if (!id) return void fail('usage', 'utopinn abort <jobId>', { rc: 2 });
    await req('POST', `/api/utopinn/jobs/${encodeURIComponent(id)}/abort`, {});
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
    const names = await cmdPresetsQuiet() ?? [];
    if (JSON_MODE) return out(names, [{ cmd: 'utopinn preset <name>' }, { cmd: 'utopinn preset-get <name>' }]);
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
    if (!name) return void fail('usage', 'utopinn preset <name>|--off', { rc: 2 });
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
    // kernel GET /presets 优先(同 PresetRepo 数据);缺 items 回退 legacy list
    const { data, status } = await req('GET', `/api/utopinn/presets?apiId=${encodeURIComponent(flags.api ?? 'openai')}`, undefined, { allowFail: true });
    if (status < 400 && Array.isArray(data?.items)) {
        return data.items.map(i => i?.name).filter(n => typeof n === 'string' && n.length > 0);
    }
    const { data: legacy } = await req('GET', `/api/presets/list?apiId=${encodeURIComponent(flags.api ?? 'openai')}`, undefined, { allowFail: true });
    return legacy?.names ?? (Array.isArray(legacy) ? legacy : null);
}

async function cmdSwipe() {
    // 群路由:导航模式走 group/patch(message-relative path),生成模式进群主流程
    if (flags.group !== undefined || state.group?.id) {
        const gctx = await needGroupCtx();
        if (!gctx) return;
        if (positional[1] !== undefined || flags.list) {
            const cur = await getGroupChat(gctx.chatId);
            if (!Array.isArray(cur) || !cur.length) return void fail('not_found', 'group chat unreadable');
            saveState({ integrity: cur[0]?.chat_metadata?.integrity ?? state.integrity });
            const idx = cur.length - 1;
            const m = cur[idx];
            const swipes = Array.isArray(m?.swipes) ? m.swipes : [];
            if (!swipes.length) return void fail('no_swipe', '末楼无 swipes', { hint: '先 utopinn swipe 生成一版' });
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
            await groupPatchFloors(gctx.chatId, ops);
            if (JSON_MODE) return out({ swipe_id: n, total: swipes.length, mes: swipes[n] });
            console.log(`swipe ${n + 1}/${swipes.length}\n${swipes[n]}`);
            footer();
            return;
        }
        await runGroupGeneration('swipe');
        return;
    }
    const c = needCtx(); if (!c) return;
    // 导航模式(不生成)
    if (positional[1] !== undefined || flags.list) {
        const cur = await getChat(c.charDir, c.chatName);
        if (!Array.isArray(cur)) return void fail('not_found', 'chat unreadable');
        saveState({ integrity: cur[0]?.chat_metadata?.integrity ?? state.integrity });
        const idx = cur.length - 1;
        const m = cur[idx];
        const swipes = Array.isArray(m?.swipes) ? m.swipes : [];
        if (!swipes.length) return void fail('no_swipe', '末楼无 swipes', { hint: '先 utopinn swipe 生成一版' });
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
// utopinn-library  → worlds / wi
// utopinn-mvu      → mvu(状态板=卡内悬浮窗的数据源)
// utopinn-diag     → kernel(路由+服务清单)
// utopinn-plugins  → plugins / plugin(生命周期:enable|disable|reload)
// utopinn-script   → script(服务端 STscript runner)

async function cmdWorlds() {
    const { data } = await req('GET', '/api/utopinn/worlds');
    const items = data?.items ?? [];
    if (JSON_MODE) return out(items, [{ cmd: 'utopinn wi <name>', why: '看条目' }]);
    for (const w of items) console.log(` ${w.name}${w.displayName !== w.name ? `  (${w.displayName})` : ''}`);
    console.log(`\n${items.length} world books`);
    next('utopinn wi <name>');
    footer();
}

async function cmdWi() {
    const name = positional[1];
    if (!name) return void fail('usage', 'utopinn wi <book>', { hint: 'utopinn worlds 看列表', rc: 2 });
    const { data, status } = await req('GET', `/api/utopinn/worlds/${encodeURIComponent(name)}`, undefined, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('not_found', `world book: ${name}`, { hint: 'utopinn worlds 看列表' });
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
    const { data } = await req('GET', '/api/utopinn/_kernel');
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
    const { data, status } = await req('GET', '/api/utopinn/plugins', undefined, { allowFail: true });
    if (status >= 400) return void fail('server', `plugins 列表失败:${data?.error ?? 'denied?'}`, { hint: '需要 admin profile' });
    const items = data?.items ?? [];
    if (JSON_MODE) return out(items, [{ cmd: `utopinn plugin <id> <${PLUGIN_VERBS.join('|')}>` }]);
    for (const p of items) console.log(` ${p.disabled ? '\x1b[2m○\x1b[0m' : '\x1b[32m●\x1b[0m'} ${p.id ?? p.name}${p.version ? ` v${p.version}` : ''}${p.disabled ? ' (disabled)' : ''}`);
    console.log(`\n${items.length} fibers`);
    next(`utopinn plugin <id> <${PLUGIN_VERBS.join('|')}>`);
    footer();
}

async function cmdPlugin() {
    const id = positional[1], verb = positional[2];
    if (!id || !PLUGIN_VERBS.includes(verb)) {
        return void fail('usage', `utopinn plugin <id> <${PLUGIN_VERBS.join('|')}>`, { hint: 'utopinn plugins 看清单', rc: 2 });
    }
    const { data, status } = await req('POST', `/api/utopinn/plugins/${encodeURIComponent(id)}/${verb}`, {}, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `${verb} ${id} 失败:${data?.error ?? 'unknown'}`, { hint: id === 'utopinn-plugins' ? '插件管理器自锁,改 profile.patch.yaml' : undefined });
    if (JSON_MODE) return out(data);
    console.log(`${verb} → ${id}: ${data?.ok ? 'ok' : JSON.stringify(data)}`);
    footer();
}

// utopinn contrib —— §C-12 插件 UI 贡献点清单(GET /api/utopinn/ui/contrib)。
// items:[{plugin,slot,contribution,core?,disabled?}] + slots 词表参照。
async function cmdContrib() {
    const { data, status } = await req('GET', '/api/utopinn/ui/contrib', undefined, { allowFail: true });
    if (status >= 400) return void fail('server', `ui/contrib → ${status}:${data?.error ?? 'denied?'}`, { hint: '需要 admin profile' });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data, [{ cmd: 'utopinn plugins' }]);
    if (!items.length) console.log('no ui contributions declared');
    console.log(`  ${'plugin'.padEnd(20)} ${'slot'.padEnd(14)} contribution`);
    for (const it of items) {
        const mark = `${it.core ? '\x1b[36m●\x1b[0m' : ' '}${it.disabled ? '\x1b[2m○\x1b[0m' : ' '}`;
        console.log(` ${mark}${String(it.plugin ?? '?').padEnd(20)} ${String(it.slot ?? '?').padEnd(14)} ${trunc(JSON.stringify(it.contribution), 80)}`);
    }
    console.log(`\n${items.length} contributions · ●=core ○=disabled`);
    next('utopinn plugins');
    footer();
    return items;
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
        const { data, status } = await req('GET', `/api/utopinn/mvu/state?${q}`, undefined, { allowFail: true });
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
    if (MVU_POST_SUBS.includes(sub)) {
        const body = { ...t };
        if (sub === 'settle' && flags.floor != null) body.message_index = flags.floor;
        const { data, status } = await req('POST', `/api/utopinn/mvu/${sub}`, body, { allowFail: true });
        if (status >= 400 || data?.error) return void fail('server', `mvu ${sub} 失败:${JSON.stringify(data?.error ?? data)}`);
        if (JSON_MODE) return out(data);
        console.log(`mvu ${sub}: ${data?.ok ? 'ok' : 'done'} ${trunc(JSON.stringify(data).slice(0, 200), 200)}`);
        footer();
        return;
    }
    if (sub === 'panel') {
        // 模板 × ctx chat 变量 → 服务端渲染面板 HTML(scope 缺省=当前 chat 变量)
        let template;
        if (flags.file) {
            try { template = readFileSync(resolve(flags.file), 'utf8'); }
            catch (e) { return void fail('usage', `--file 读取失败: ${e.message}`, { rc: 2 }); }
        } else {
            template = await readTextArg(positional.slice(2));
        }
        if (!String(template ?? '').trim()) return void fail('usage', 'utopinn mvu panel <tpl|--file f|--stdin>', { hint: 'scope 缺省取当前 chat 变量', rc: 2 });
        const { data, status } = await req('POST', '/api/utopinn/mvu/panel/render', { template, ...t }, { allowFail: true });
        if (status >= 400 || data?.error) return void fail('server', `mvu panel 失败:${data?.error ?? status}`, { status });
        const html = String(data?.html ?? '');
        if (flags.out) { writeFileSync(resolve(flags.out), html); warn(`wrote ${flags.out} (${html.length}ch)`); }
        if (JSON_MODE && !flags.html) return out({ html, len: html.length });
        console.log(html);
        footer(`${html.length}ch`);
        return;
    }
    fail('usage', `utopinn mvu <${Object.keys(MVU_SUB_ROUTES).join('|')}>(settle --floor i · panel <tpl|--file|--stdin>)`, { rc: 2 });
}

async function cmdScript() {
    const script = await readTextArg(positional.slice(1));
    if (!script) return void fail('usage', 'utopinn script <stscript|--stdin>', { hint: '例:utopinn script "/echo hi"', rc: 2 });
    const c = needCtx() ?? {};
    const { data, status } = await req('POST', '/api/utopinn/script/run', {
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
    // utopinn-th fiber:TavernHelper 兼容调用面。METHODS 见插件源码。
    const method = positional[1];
    if (!method) return void fail('usage', 'utopinn th <method> [json-args|--stdin]', {
        detail: 'getVariables|replaceVariables|insertOrAssignVariables|deleteVariable|getChatMessages|triggerSlash|getCharacter|getCurrentCharacterName|getLastMessageId|getCurrentMessageId|getEmbeddedScripts',
        rc: 2,
    });
    let args = {};
    if (flags.stdin) { try { args = JSON.parse(await readTextArg([])) ?? {}; } catch { args = {}; } }
    else if (positional[2] !== undefined) { try { args = JSON.parse(positional.slice(2).join(' ')) ?? {}; } catch { return void fail('usage', 'args 必须是 JSON', { rc: 2 }); } }
    const c = needCtx() ?? {};
    const { data, status } = await req('POST', '/api/utopinn/th/call', {
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

// ═══ 数据面/写面具名动词(TASK-036:kernel 路由全覆盖)═══
// library 读:char / chat-get;library 写:world-edit|delete、preset-get|edit|delete、
// personas|persona-edit|delete、settings|settings-set、secrets|secret-set|delete、
// chat 生命周期:chat-create;数据面:import-scan|preview|commit、backup、lan-offer|import。

async function cmdChar() {
    const char = await resolveChar(positional[1]);
    if (!char) return;
    const charDir = stripExt(char.avatar, 'png');
    const { data, status } = await req('GET', `/api/utopinn/characters/${encodeURIComponent(charDir)}`, undefined, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('not_found', `char: ${charDir}`, { detail: data?.error, status });
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data, [{ cmd: `utopinn use ${charDir}` }]);
    const d = (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) ? data.data : data;
    console.log(`\x1b[1m${d?.name ?? charDir}\x1b[0m  \x1b[2m(${charDir})\x1b[0m`);
    if (Array.isArray(d?.tags) && d.tags.length) console.log(`tags: ${d.tags.join(', ')}`);
    for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes']) {
        const v = d?.[k];
        if (typeof v === 'string' && v) console.log(`\x1b[2m[${k}]\x1b[0m ${trunc(v, flags.full ? 1e9 : 160)}`);
    }
    const extensions = d?.extensions && typeof d.extensions === 'object' ? Object.keys(d.extensions) : [];
    if (extensions.length) console.log(`\x1b[2mextensions: ${extensions.join(', ')}\x1b[0m`);
    footer();
}

// —— 角色卡写面(C-3):字段级 merge-patch;extensions 仅 world/alternate_greetings/regex_scripts ——
async function cmdCharEdit() {
    const char = await resolveChar(positional[1]);
    if (!char) return;
    const charDir = stripExt(char.avatar, 'png');
    let body = {};
    if (flags.jsonFile || flags.stdin || positional[2] !== undefined) {
        const doc = await readJsonBody(positional.slice(2), 'char-edit 需要 JSON patch 或 --set k=v');
        if (doc === undefined) return;
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return void fail('usage', 'char patch 必须是对象', { rc: 2 });
        body = doc;
    }
    // --set k=v 逐键并入;extensions 子键用 {"extensions":{"world":"…"}} 形给
    body = { ...body, ...(flags.set ?? {}) };
    if (!Object.keys(body).length) return void fail('usage', 'char-edit 无字段可写——给 JSON patch 或 --set name=…', { hint: '字段:name/description/personality/scenario/first_mes/mes_example/creator_notes/system_prompt/post_history_instructions/tags/creator/character_version + extensions{world|alternate_greetings|regex_scripts}', rc: 2 });
    const { data, status } = await req('PATCH', `/api/utopinn/characters/${encodeURIComponent(charDir)}`, body, { allowFail: true });
    if (status === 404) return void fail('not_found', `char: ${charDir}`, { hint: 'utopinn chars 看全表' });
    if (status === 400 || status === 422) return void fail('usage', `char-edit 被拒:${data?.error ?? status}`, { status, rc: 2 });
    if (status >= 400 || data?.error) return void fail('server', `char-edit ${charDir} 失败:${data?.error ?? status}`, { status });
    const n = [{ cmd: `utopinn char ${charDir}`, why: '看写后卡' }];
    if (JSON_MODE) return out(data, n);
    const d = (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) ? data.data : data;
    console.log(`char ${charDir} patched — name="${d?.name ?? ''}"${d?.extensions?.world ? ` · world=${d.extensions.world}` : ''}`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdChatGet() {
    // charDir = --char | ctx.char;chatName = 位置参 | ctx.chat —— 两组独立来源
    const charDir = flags.char ? stripExt(flags.char, 'png') : state.char?.dir;
    const chatName = stripExt(positional[1] ?? state.chat?.name, 'jsonl');
    if (!charDir || !chatName) return void fail('no_ctx', 'chat-get 需要 char+chat', { hint: 'utopinn use <char> <chat> 或 chat-get <chat> --char <d>', rc: 2 });
    const { data, status } = await req('GET', `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(chatName)}`, undefined, { allowFail: true });
    if (status === 404 || data?.error) return void fail('not_found', `chat: ${charDir}/${chatName}`, { detail: data?.error, hint: 'utopinn chats 看列表' });
    if (status >= 400) return void fail('server', `chat-get → ${status}`, { status });
    const msgs = Array.isArray(data?.messages) ? data.messages : [];
    if (data?.integrity) saveState({ integrity: data.integrity, floors: chatName === state.chat?.name ? msgs.length : state.floors });
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(data, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data);
    console.log(`${charDir} @ ${chatName} — ${msgs.length} floors · integrity ${String(data?.integrity ?? '—').slice(0, 10)}`);
    const meta = data?.header?.chat_metadata ?? {};
    const metaKeys = Object.keys(meta).filter(k => meta[k] !== undefined && k !== 'integrity');
    if (metaKeys.length) console.log(`\x1b[2mmetadata: ${metaKeys.join(', ')}\x1b[0m`);
    for (const m of msgs.slice(-2)) {
        console.log(`\x1b[2m#${msgs.indexOf(m)}\x1b[0m ${m.is_user ? '\x1b[36m' : '\x1b[35m'}${m.name ?? ''}\x1b[0m ${trunc(m.mes, 120)}`);
    }
    footer();
}

async function cmdChatCreate() {
    // 只需要 charDir(ctx.char 或 --char);chatName 就是要建的,不依赖 ctx.chat
    const charDir = flags.char ? stripExt(flags.char, 'png') : state.char?.dir;
    if (!charDir) return void fail('no_ctx', '先选卡', { hint: 'utopinn use <char> 或 --char d', rc: 2 });
    const name = stripExt(positional[1] ?? '', 'jsonl');
    if (!name) return void fail('usage', 'utopinn chat-create <name>(立即建空文件;懒建用 chat-new)', { rc: 2 });
    const { data, status } = await req('PUT', `/api/utopinn/characters/${encodeURIComponent(charDir)}/chats/${encodeURIComponent(name)}`, { header: { chat_metadata: {} } }, { allowFail: true });
    if (status === 409) return void fail('exists', `chat exists: ${name}`, { hint: 'utopinn chats 看列表', rc: 3 });
    if (status >= 400 || data?.error) return void fail('server', `chat-create 失败:${data?.error ?? status}`, { status });
    // 只在 ctx.char 与目标同卡时才把 ctx.chat 切过去(--char 建到别的卡上不挪 ctx)
    if (charDir === state.char?.dir) saveState({ chat: { name }, floors: 0, integrity: data?.integrity ?? null });
    const n = [{ cmd: 'utopinn send "…"', why: '写第一楼' }];
    if (JSON_MODE) return out({ created: name, integrity: data?.integrity }, n);
    console.log(`chat = ${name}(空文件已建)`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

// —— 整文档替换(legacy /save 等价;edit/swipe 是增量,这个是全量)——
async function cmdChatPut() {
    const c = needCtx(); if (!c) return;
    const doc = await readJsonBody(positional.slice(1), 'chat-put 需要 {header,messages} 或 legacy [header,...floors](--json-file f|--stdin|inline)');
    if (doc === undefined) return;
    const payload = Array.isArray(doc) ? { chat: doc } : { ...doc };
    const floors = Array.isArray(doc) ? Math.max(0, doc.length - 1)
        : (Array.isArray(doc.messages) ? doc.messages.length : null);
    if (flags.force) payload.force = true;
    else if (state.integrity && payload.integrity === undefined) payload.integrity = state.integrity;
    const route = `/api/utopinn/characters/${encodeURIComponent(c.charDir)}/chats/${encodeURIComponent(c.chatName)}/document`;
    const attempt = async () => req('PUT', route, payload, { allowFail: true });
    let { data, status } = await attempt();
    // 409 重锚一次:document 路由回 {error:'integrity', current_integrity}
    if (status === 409 && !flags.force) {
        const fresh = String(data?.current_integrity || data?.actual || '');
        if (fresh) {
            warn('integrity 409 — 重锚后重试一次');
            saveState({ integrity: fresh });
            payload.integrity = fresh;
            ({ data, status } = await attempt());
        }
    }
    if (status >= 400 || data?.error) {
        return void fail('server', `chat-put 失败:${data?.error ?? status}`, { status, detail: data?.current_integrity ? `current=${data.current_integrity.slice(0, 12)}…` : undefined });
    }
    if (data?.integrity) saveState({ integrity: data.integrity, ...(floors !== null ? { floors } : {}) });
    const n = [{ cmd: 'utopinn history -n 3', why: '核对写回' }, { cmd: 'utopinn send "…"', why: '继续' }];
    if (JSON_MODE) return out({ ok: true, integrity: data?.integrity, floors }, n);
    console.log(`chat document saved — floors ${floors ?? '?'} · integrity ${String(data?.integrity ?? '').slice(0, 8)}…`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

// —— worlds 写面 ——
async function cmdWorldEdit() {
    const name = positional[1];
    if (!name) return void fail('usage', 'utopinn world-edit <name> [json|--json-file f|--stdin]', { hint: 'utopinn wi <book> --out d.json 取现文档改完写回', rc: 2 });
    const doc = await readJsonBody(positional.slice(2), 'world-edit 需要世界书文档 {entries:{}}');
    if (doc === undefined) return;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
        return void fail('usage', 'world doc 必须是含 entries 对象的对象', { rc: 2 });
    }
    const { data, status } = await req('PUT', `/api/utopinn/worlds/${encodeURIComponent(name)}`, doc, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `world-edit ${name} 失败:${data?.error ?? status}`, { status });
    const n = [{ cmd: `utopinn wi ${data?.name ?? name} -n 10`, why: '验证写回' }];
    if (JSON_MODE) return out(data, n);
    console.log(`world "${data?.name ?? name}" saved — ${Object.keys(doc.entries).length} entries`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdWorldDelete() {
    const name = positional[1];
    if (!name) return void fail('usage', 'utopinn world-delete <name>(显式名)', { rc: 2 });
    const { data, status } = await req('DELETE', `/api/utopinn/worlds/${encodeURIComponent(name)}`, undefined, { allowFail: true });
    if (status === 404) return void fail('not_found', `world book: ${name}`, { hint: 'utopinn worlds 看列表' });
    if (status >= 400 || data?.error) return void fail('server', `world-delete 失败:${data?.error ?? status}`, { status });
    if (JSON_MODE) return out({ deleted: name }, [{ cmd: 'utopinn worlds' }]);
    console.log(`deleted world "${name}"`);
    footer();
}

// —— regex 面(utopinn-regex:global/char/preset 三层存储 + 放行表)——
function regexScope() {
    if (flags.preset) {
        if ('char' in flags) return void fail('usage', '--char 与 --preset 二选一', { rc: 2 });
        return { scope: 'preset', apiId: flags.api ?? 'openai', preset: flags.preset };
    }
    if ('char' in flags) {
        const charDir = flags.char ?? state.char?.dir;
        if (!charDir) return void fail('usage', '--char 需要 <dir>,或先 utopinn use 绑卡', { rc: 2 });
        return { scope: 'char', char: charDir };
    }
    return { scope: 'global' }; // --global 显式/缺省同义
}
const regexScopeBody = (s) => s.scope === 'char' ? { scope: 'char', char: s.char }
    : s.scope === 'preset' ? { scope: 'preset', apiId: s.apiId, preset: s.preset }
    : { scope: 'global' };
const regexScopeQs = (s) => {
    const q = { scope: s.scope };
    if (s.scope === 'char') q.char = s.char;
    if (s.scope === 'preset') { q.apiId = s.apiId; q.preset = s.preset; }
    return '?' + new URLSearchParams(q).toString();
};
const regexScopeLabel = (s) => s.scope === 'char' ? `char ${s.char}` : s.scope === 'preset' ? `preset ${s.apiId}/${s.preset}` : 'global';
const regexRow = (s, i) => {
    const mark = s?.disabled ? '·off' : ' ✓  ';
    const id = (s?.id ? String(s.id) : `#${i}`).slice(0, 8);
    return ` ${mark} ${id.padEnd(10)} ${trunc(s?.scriptName || '(unnamed)', 26).padEnd(27)} ${trunc(String(s?.findRegex ?? ''), 40)}${s?.replaceString ? ` → ${trunc(String(s.replaceString), 24)}` : ''}`;
};

async function cmdRegex() {
    const id = positional[1];
    const scope = regexScope();
    if (!scope) return;

    // 整组写回:utopinn regex --put [arr|--json-file f|--stdin] [scope]
    if (flags.put) {
        const doc = await readJsonBody(positional.slice(1), 'regex --put 需要脚本数组 [{…}] 或 {scripts:[…]}');
        if (doc === undefined) return;
        const scripts = Array.isArray(doc) ? doc : doc?.scripts;
        if (!Array.isArray(scripts)) return void fail('usage', '--put 载荷须为脚本数组或 {scripts:[…]}', { rc: 2 });
        const { data, status } = await req('PUT', '/api/utopinn/regex', { ...regexScopeBody(scope), scripts }, { allowFail: true });
        if (status >= 400 || data?.error) return void fail(status === 400 ? 'usage' : 'server', `regex put 失败:${data?.error ?? status}`, { status, rc: status === 400 ? 2 : 1 });
        if (JSON_MODE) return out(data, [{ cmd: 'utopinn regex', why: '验证写回' }]);
        console.log(`${regexScopeLabel(scope)} — ${data?.count ?? scripts.length} scripts saved`);
        next('utopinn regex'); footer(); return;
    }

    // 放行开关:utopinn regex --allow|--disallow --char <dir>|--preset <n> [--api id]
    if (flags.allow || flags.disallow) {
        if (scope.scope === 'global') return void fail('usage', 'global 域无放行表(恒活,disabledExtensions 管全灭)', { rc: 2 });
        const { data, status } = await req('PUT', '/api/utopinn/regex', { ...regexScopeBody(scope), allow: !!flags.allow }, { allowFail: true });
        if (status >= 400 || data?.error) return void fail('server', `regex allow 失败:${data?.error ?? status}`, { status });
        if (JSON_MODE) return out(data);
        console.log(`${regexScopeLabel(scope)} — regex scripts ${flags.allow ? 'allowed' : 'disallowed'}`);
        footer(); return;
    }

    // 单条:utopinn regex <id> --enable|--disable|--delete [scope]
    if (flags.enable || flags.disable || flags.deleteFlag) {
        if (!id) return void fail('usage', 'utopinn regex <id> --enable|--disable|--delete(脚本 id 或下标)', { rc: 2 });
        if (flags.deleteFlag) {
            const { data, status } = await req('DELETE', `/api/utopinn/regex/${encodeURIComponent(id)}${regexScopeQs(scope)}`, undefined, { allowFail: true });
            if (status === 404) return void fail('not_found', `regex script: ${id} (${regexScopeLabel(scope)})`);
            if (status >= 400 || data?.error) return void fail('server', `regex delete 失败:${data?.error ?? status}`, { status });
            if (JSON_MODE) return out(data);
            console.log(`deleted ${id} from ${regexScopeLabel(scope)} (${data?.remaining ?? '?'} left)`);
            footer(); return;
        }
        const { data, status } = await req('PATCH', `/api/utopinn/regex/${encodeURIComponent(id)}`, { ...regexScopeBody(scope), set: { disabled: !flags.enable } }, { allowFail: true });
        if (status === 404) return void fail('not_found', `regex script: ${id} (${regexScopeLabel(scope)})`);
        if (status >= 400 || data?.error) return void fail('server', `regex patch 失败:${data?.error ?? status}`, { status });
        if (JSON_MODE) return out(data);
        console.log(`${regexScopeLabel(scope)} — "${data?.script?.scriptName ?? id}" ${flags.enable ? 'enabled' : 'disabled'}`);
        footer(); return;
    }
    if (id) return void fail('usage', `regex ${id} 需要动作:--enable|--disable|--delete`, { hint: '列表用 utopinn regex;整组写回 --put', rc: 2 });

    // 读面:无 scope flag → 全量视图;有 → 分面明细
    if (!flags.global && !('char' in flags) && !flags.preset) {
        const { data, status } = await req('GET', '/api/utopinn/regex', undefined, { allowFail: true });
        if (status >= 400 || data?.error) return void fail('server', `regex 读取失败:${data?.error ?? status}`, { status });
        if (JSON_MODE) return out(data, [{ cmd: 'utopinn regex --global', why: '看全局脚本' }]);
        const allowedChars = new Set(data?.allowed?.characters ?? []);
        console.log(`global — ${data?.global?.length ?? 0} scripts${data?.extensionDisabled ? '  \x1b[31m(disabledExtensions 全灭中)\x1b[0m' : ''}`);
        (data?.global ?? []).forEach((s, i) => console.log(regexRow(s, i)));
        for (const c of data?.chars ?? []) {
            console.log(`char ${c.charDir} (${c.name}) — ${allowedChars.has(c.avatar) ? 'allowed' : '·off'} · ${c.count} scripts`);
            if (flags.full) (c.scripts ?? []).forEach((s, i) => console.log(regexRow(s, i)));
        }
        for (const p of data?.presets ?? []) {
            console.log(`preset ${p.apiId}/${p.name} — ${p.allowed ? 'allowed' : '·off'} · ${p.count} scripts`);
            if (flags.full) (p.scripts ?? []).forEach((s, i) => console.log(regexRow(s, i)));
        }
        next('utopinn regex --global'); footer(); return;
    }

    const { data, status } = await req('GET', `/api/utopinn/regex${regexScopeQs(scope)}`, undefined, { allowFail: true });
    if (status === 404) return void fail('not_found', `${regexScopeLabel(scope)}`, { hint: 'utopinn regex 看全量' });
    if (status >= 400 || data?.error) return void fail('server', `regex 读取失败:${data?.error ?? status}`, { status });
    if (JSON_MODE) return out(data);
    const scripts = data?.scripts ?? [];
    const tag = data?.allowed === false ? '·off' : (data?.allowed ? 'allowed' : '');
    console.log(`${regexScopeLabel(scope)}${tag ? ` — ${tag}` : ''} · ${scripts.length} scripts`);
    for (let i = 0; i < scripts.length; i++) console.log(regexRow(scripts[i], i));
    footer();
}

// —— presets 写面(apiId 默认 openai,--api 换族)——
const presetPath = (name) => `/api/utopinn/presets/${encodeURIComponent(name)}?apiId=${encodeURIComponent(flags.api ?? 'openai')}`;

async function cmdPresetGet() {
    const name = positional[1] ?? state.preset;
    if (!name) return void fail('usage', 'utopinn preset-get <name>', { hint: 'utopinn presets 看列表', rc: 2 });
    const { data, status } = await req('GET', presetPath(name), undefined, { allowFail: true });
    if (status === 404 || data?.error) return void fail('not_found', `preset: ${name}`, { hint: 'utopinn presets 看列表' });
    if (status >= 400) return void fail('server', `preset-get → ${status}`, { status });
    const doc = data?.doc ?? {};
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(doc, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data, [{ cmd: `utopinn preset-edit ${name} --json-file <doc>`, why: '改完写回' }]);
    const prompts = Array.isArray(doc.prompts) ? doc.prompts.length : 0;
    const sampler = ['temperature', 'top_p', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'stream_openai']
        .filter(k => doc[k] !== undefined).map(k => `${k}=${trunc(JSON.stringify(doc[k]), 24)}`).join(' ');
    console.log(`${name} (${data?.apiId ?? flags.api ?? 'openai'}) — prompts:${prompts}${sampler ? ` · ${sampler}` : ''}`);
    console.log(`\x1b[2mkeys: ${Object.keys(doc).slice(0, flags.full ? 1e9 : 24).join(', ')}${!flags.full && Object.keys(doc).length > 24 ? ' …' : ''}\x1b[0m`);
    footer();
}

async function cmdPresetEdit() {
    const name = positional[1];
    if (!name) return void fail('usage', 'utopinn preset-edit <name> [json|--json-file f|--stdin]', { hint: 'utopinn preset-get <name> --out d.json 取现文档', rc: 2 });
    const doc = await readJsonBody(positional.slice(2), 'preset-edit 需要预设 doc 对象');
    if (doc === undefined) return;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return void fail('usage', 'preset doc 必须是 JSON 对象', { rc: 2 });
    }
    const { data, status } = await req('PUT', presetPath(name), doc, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `preset-edit ${name} 失败:${data?.error ?? status}`, { status });
    const n = [{ cmd: `utopinn preset-get ${name}`, why: '验证写回' }, { cmd: `utopinn preset ${name}`, why: '绑进 ctx' }];
    if (JSON_MODE) return out(data, n);
    console.log(`preset "${name}" saved (${data?.apiId ?? flags.api ?? 'openai'})`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdPresetDelete() {
    const name = positional[1];
    if (!name) return void fail('usage', 'utopinn preset-delete <name>(显式名,--api 族)', { rc: 2 });
    const { data, status } = await req('DELETE', presetPath(name), undefined, { allowFail: true });
    if (status === 404) return void fail('not_found', `preset: ${name}`, { hint: 'utopinn presets 看列表' });
    if (status >= 400 || data?.error) return void fail('server', `preset-delete 失败:${data?.error ?? status}`, { status });
    const wasBound = state.preset === name;
    if (wasBound) saveState({ preset: null });
    if (JSON_MODE) return out({ deleted: name, unbound: wasBound }, [{ cmd: 'utopinn presets' }]);
    console.log(`deleted preset "${name}"${wasBound ? '(已解绑 ctx.preset)' : ''}`);
    footer();
}

// —— personas 面 ——
async function cmdPersonas() {
    const { data, status } = await req('GET', '/api/utopinn/personas', undefined, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `personas 列表失败:${data?.error ?? status}`, { status });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (JSON_MODE) return out({ items, defaultPersona: data?.defaultPersona ?? null }, [{ cmd: 'utopinn persona-edit <avatar> --set name=…' }]);
    for (const p of items) {
        console.log(`${p.isDefault ? '*' : ' '} ${p.avatar.padEnd(28)} ${p.name}${p.title ? ` · ${p.title}` : ''}${p.hasImage ? '' : '  \x1b[2m(no img)\x1b[0m'}`);
    }
    console.log(`\n${items.length} personas`);
    next('utopinn persona-edit <avatar> --set name=…');
    footer();
}

async function cmdPersonaEdit() {
    const avatar = positional[1];
    if (!avatar) return void fail('usage', 'utopinn persona-edit <avatar> [json|--json-file f|--stdin|--set k=v]', { hint: '字段:name/description/position/title/is_default', rc: 2 });
    let body = {};
    if (flags.jsonFile || flags.stdin || positional[2] !== undefined) {
        const doc = await readJsonBody(positional.slice(2), 'persona-edit 需要 JSON doc 或 --set k=v');
        if (doc === undefined) return;
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return void fail('usage', 'persona doc 必须是对象', { rc: 2 });
        body = doc;
    }
    body = { ...body, ...(flags.set ?? {}) };
    if (!Object.keys(body).length) return void fail('usage', 'persona-edit 无字段可写——给 JSON doc 或 --set name=…', { rc: 2 });
    const { data, status } = await req('PUT', `/api/utopinn/personas/${encodeURIComponent(avatar)}`, body, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `persona-edit ${avatar} 失败:${data?.error ?? status}`, { status });
    const n = [{ cmd: 'utopinn personas', why: '看表' }];
    if (JSON_MODE) return out(data, n);
    console.log(`persona ${data?.avatar ?? avatar} → name="${data?.name ?? ''}"${data?.isDefault ? ' · default' : ''}${data?.title ? ` · ${data.title}` : ''}`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdPersonaDelete() {
    const avatar = positional[1];
    if (!avatar) return void fail('usage', 'utopinn persona-delete <avatar>(显式 avatar 文件名)', { rc: 2 });
    const { data, status } = await req('DELETE', `/api/utopinn/personas/${encodeURIComponent(avatar)}`, undefined, { allowFail: true });
    if (status === 404) return void fail('not_found', `persona: ${avatar}`, { hint: 'utopinn personas 看列表' });
    if (status >= 400 || data?.error) return void fail('server', `persona-delete 失败:${data?.error ?? status}`, { status });
    if (JSON_MODE) return out({ deleted: avatar }, [{ cmd: 'utopinn personas' }]);
    console.log(`deleted persona "${avatar}"`);
    footer();
}

// —— settings 面(服务端已脱敏;PATCH 白名单同 utopinn-library PATCHABLE_SETTINGS_*)——
const SETTINGS_PATCHABLE = new Set(['power_user', 'extension_settings', 'oai_settings', 'world_info_settings', 'preset_settings_openai']);
// 标量键(非对象段):preset_settings_openai 预设选择指针 —— 服务端直写并镜像 oai_settings。
const SETTINGS_SCALAR_KEYS = new Set(['preset_settings_openai']);

async function cmdSettings() {
    const { data, status } = await req('GET', '/api/utopinn/settings', undefined, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `settings 读取失败:${data?.error ?? status}`, { status });
    const settings = data?.settings ?? {};
    if (flags.out) { writeFileSync(resolve(flags.out), JSON.stringify(settings, null, 2)); warn(`wrote ${flags.out}`); }
    if (JSON_MODE) return out(data, [{ cmd: 'utopinn settings-set --json-file <patch>', why: '受限合并写回' }]);
    const keys = Object.keys(settings);
    console.log(`settings — ${keys.length} 顶层段`);
    for (const k of keys.slice(0, flags.n ?? 25)) {
        const v = settings[k];
        const desc = v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length} keys}`) : trunc(JSON.stringify(v), 60);
        console.log(`  ${k} ${desc}`);
    }
    if (!flags.full && keys.length > (flags.n ?? 25)) console.log(`  …+${keys.length - (flags.n ?? 25)}(--full/--out 展开)`);
    next('utopinn settings-set --json-file <patch>');
    footer();
}

async function cmdSettingsSet() {
    const patch = await readJsonBody(positional.slice(1), 'settings-set 需要 JSON patch {power_user:{…}}|{extension_settings:{…}}');
    if (patch === undefined) return;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
        return void fail('usage', 'settings patch 必须是非空对象', { rc: 2 });
    }
    const rejected = Object.keys(patch).filter(k => !SETTINGS_PATCHABLE.has(k));
    if (rejected.length) {
        return void fail('usage', `不可写顶层段: ${rejected.join(', ')}`, { hint: `此端点只放 ${[...SETTINGS_PATCHABLE].join(' | ')};其余段走服务端管理面`, rc: 2 });
    }
    for (const [k, v] of Object.entries(patch)) {
        if (SETTINGS_SCALAR_KEYS.has(k)) {
            if (v !== null && typeof v !== 'string') return void fail('usage', `"${k}" 必须是字符串(预设名)`, { rc: 2 });
            continue;
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            return void fail('usage', `section "${k}" 必须是 JSON 对象(逐键浅合并)`, { rc: 2 });
        }
    }
    const { data, status } = await req('PATCH', '/api/utopinn/settings', patch, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `settings-set 失败:${data?.error ?? status}`, { status });
    const n = [{ cmd: 'utopinn settings', why: '看合并后视图' }];
    if (JSON_MODE) return out(data, n);
    console.log(`settings merged: ${Object.keys(patch).map(k => SETTINGS_SCALAR_KEYS.has(k) ? `${k}=${JSON.stringify(patch[k])}` : `${k}(+${Object.keys(patch[k]).length})`).join(' · ')}`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

// —— secrets 面(值永不回显;服务端 allowKeysExposure 开了也照打码)——
const maskSecret = (v) => {
    const s = String(v ?? '');
    if (s.length <= 4) return '····';
    return `${s.slice(0, 2)}${'·'.repeat(Math.min(6, Math.max(2, s.length - 4)))}${s.slice(-2)}`;
};
const maskedSecretEntries = (entries) => (Array.isArray(entries) ? entries : []).map(e => ({
    id: e?.id, value: maskSecret(e?.value), label: e?.label ?? '', active: Boolean(e?.active),
}));

async function cmdSecrets() {
    const { data, status } = await req('GET', '/api/utopinn/secrets', undefined, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `secrets 读取失败:${data?.error ?? status}`, { status });
    const raw = data?.secrets ?? {};
    const set = {};
    let nullCount = 0;
    for (const [k, entries] of Object.entries(raw)) {
        if (Array.isArray(entries) && entries.length) set[k] = maskedSecretEntries(entries);
        else nullCount++;
    }
    if (JSON_MODE) return out({ secrets: set, unset: nullCount }, [{ cmd: 'utopinn secret-set <key> --value …|--stdin' }]);
    const rows = Object.entries(set);
    for (const [k, entries] of rows) {
        for (const e of entries) {
            console.log(`${e.active ? '\x1b[32m●\x1b[0m' : '\x1b[2m○\x1b[0m'} ${k.padEnd(28)} ${e.value.padEnd(14)} ${e.label} \x1b[2m${String(e.id).slice(0, 8)}\x1b[0m`);
        }
    }
    console.log(`\n${rows.length} keys set · ${nullCount} empty`);
    next('utopinn secret-set <key> --value …|--stdin');
    footer();
}

async function cmdSecretSet() {
    const key = positional[1];
    if (flags.id) return void fail('usage', 'PUT 总是新建条目(服务端铸 id)——没有 --id 语义;删旧条目用 secret-delete <key> <id>', { rc: 2 });
    let value = flags.value;
    if (value === undefined && flags.stdin) {
        // stdin 密钥不进出参/命令行历史;剥尾换行防 "…\n" 静默进 value
        value = (await readStdinBuffer()).toString('utf8').replace(/\r?\n$/, '');
    }
    if (value === undefined && positional[2] !== undefined) value = positional[2];
    if (!key) return void fail('usage', 'utopinn secret-set <key> --value v|--stdin [--label l]', { hint: 'utopinn secrets 看键名(api_key_* 一族)', rc: 2 });
    if (typeof value !== 'string' || !value) return void fail('usage', 'secret-set 需要 --value v 或 --stdin(值不进命令行历史)', { rc: 2 });
    const { data, status } = await req('PUT', `/api/utopinn/secrets/${encodeURIComponent(key)}`, { value, ...(flags.label ? { label: flags.label } : {}) }, { allowFail: true });
    if (status === 400) return void fail('usage', `secret-set 被拒:${data?.error ?? 'bad key/value'}`, { detail: data?.error, hint: 'utopinn secrets 看合法键名', rc: 2 });
    if (status >= 400 || data?.error) return void fail('server', `secret-set 失败:${data?.error ?? status}`, { status });
    const entries = maskedSecretEntries(data?.entries);
    if (JSON_MODE) return out({ ok: true, id: data?.id, key, entries });
    console.log(`secret-set ${key} → id ${String(data?.id ?? '').slice(0, 8)}… (active)`);
    for (const e of entries) console.log(`  ${e.active ? '●' : '○'} ${e.value}  ${e.label} \x1b[2m${String(e.id).slice(0, 8)}\x1b[0m`);
    footer();
}

async function cmdSecretDelete() {
    const key = positional[1], id = positional[2] ?? flags.id;
    if (!key || !id) return void fail('usage', 'utopinn secret-delete <key> <id>', { hint: 'utopinn secrets 看 id', rc: 2 });
    const { data, status } = await req('DELETE', `/api/utopinn/secrets/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, undefined, { allowFail: true });
    if (status === 400) return void fail('usage', `secret-delete 被拒:${data?.error ?? ''}`, { rc: 2 });
    if (status >= 400 || data?.error) return void fail('server', `secret-delete 失败:${data?.error ?? status}`, { status });
    if (JSON_MODE) return out({ deleted: { key, id } }, [{ cmd: 'utopinn secrets' }]);
    console.log(`deleted secret ${key}/${String(id).slice(0, 8)}`);
    footer();
}

// —— 连接面:conn test / models(读服务端生效配置,密钥不出服务端)——
async function cmdConn() {
    const sub = positional[1] ?? 'test';
    if (sub !== 'test') return void fail('usage', 'utopinn conn test', { hint: '目前只有 test 一个动词', rc: 2 });
    // 服务端探针 8s 上限;客户端给 15s 留网络余量
    const { data, status } = await req('POST', '/api/utopinn/connection/test', {}, { allowFail: true, timeout: 15_000 });
    if (status >= 400) return void fail('server', `conn test → ${status}: ${data?.error ?? ''}`, { status });
    if (JSON_MODE) return out(data, data?.ok ? [{ cmd: 'utopinn models' }] : [{ cmd: 'utopinn secrets', why: '查密钥槽' }, { cmd: 'utopinn settings', why: '查 oai_settings' }]);
    if (data?.ok) {
        console.log(`\x1b[32m✓\x1b[0m ${data.source} · ${data.latencyMs}ms · ${data.modelCount ?? '?'} models (HTTP ${data.upstreamStatus})`);
        next('utopinn models');
    } else {
        exitCode = 5; // upstream failed — SCHEMA.exitCodes[5]
        console.log(`\x1b[31m✗\x1b[0m ${data?.source ?? '?'} · ${data?.error ?? 'failed'}${data?.upstreamStatus ? ` (HTTP ${data.upstreamStatus})` : ''}${data?.latencyMs != null ? ` · ${data.latencyMs}ms` : ''}`);
        if (data?.detail) console.log(`  \x1b[2m${data.detail}\x1b[0m`);
        next(data?.error === 'not_configured' ? 'utopinn secrets' : 'utopinn conn test');
    }
    footer();
    return data;
}

async function cmdModels() {
    const q = flags.fresh ? '?fresh=1' : '';
    const { data, status } = await req('GET', `/api/utopinn/models${q}`, undefined, { allowFail: true, timeout: 15_000 });
    if (status >= 400) return void fail('server', `models → ${status}: ${data?.error ?? ''}`, { status });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (JSON_MODE) return out(data, data?.error ? [{ cmd: 'utopinn conn test', why: '探测链路' }] : []);
    if (data?.error) console.log(`\x1b[33m!\x1b[0m ${data.source ?? '?'} ${data.error}${data?.upstreamStatus ? ` (HTTP ${data.upstreamStatus})` : ''}${data?.detail ? ` — ${data.detail}` : ''}${data?.stale ? ' \x1b[2m[stale cache]\x1b[0m' : ''}`);
    const show = flags.n ? items.slice(0, flags.n) : items;
    for (const m of show) console.log(`  ${m.id}${m.owned_by ? `  \x1b[2m${m.owned_by}\x1b[0m` : ''}`);
    console.log(`\n${items.length} models${data?.stale ? ' (stale)' : ''}${flags.n && items.length > flags.n ? ` · showing ${flags.n}` : ''}`);
    next('utopinn conn test');
    footer();
    return items;
}

// —— 数据面:import / backup / lan ——
/** 导入载荷:--file f | 位置参 | --stdin(二进制)。回 {buffer,fileName} 或 null(已 fail)。 */
async function importPayload() {
    if (flags.stdin) {
        const buffer = await readStdinBuffer();
        if (!buffer.length) { fail('usage', 'stdin 空载荷', { rc: 2 }); return null; }
        return { buffer, fileName: String(flags.name ?? positional[1] ?? 'stdin.bin') };
    }
    const file = flags.file ?? positional[1];
    if (!file) { fail('usage', '需要文件(--file f | 位置参 | --stdin)', { rc: 2 }); return null; }
    let buffer;
    try { buffer = readFileSync(resolve(file)); }
    catch (e) { fail('usage', `读文件失败: ${e.message}`, { rc: 2 }); return null; }
    return { buffer, fileName: String(flags.name ?? basename(resolve(file))) };
}
const importBody = (p, extra = {}) => ({ name: p.fileName, dataBase64: p.buffer.toString('base64'), ...extra });

async function cmdImportScan() {
    const dir = positional[1] ?? flags.dir;
    if (!dir) return void fail('usage', 'utopinn import-scan <dir>(服务端路径,不是本地路径)', { rc: 2 });
    const { data, status } = await req('POST', '/api/utopinn/import/scan-st', { dir: String(dir) }, { allowFail: true });
    if (status === 403) return void fail('server', 'import-scan 需要 admin profile', { status });
    if (status === 404) return void fail('not_found', `not a directory: ${dir}`, { detail: data?.error });
    if (status >= 400 || data?.error) return void fail('server', `import-scan 失败:${data?.error ?? status}`, { status });
    const counts = data?.counts ?? {};
    const items = Array.isArray(data?.items) ? data.items : [];
    if (JSON_MODE) return out(data, [{ cmd: 'utopinn import-preview --file <path>' }]);
    console.log(`${data?.root ?? dir} — ${data?.total ?? items.length} importable`);
    for (const [k, n] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${n}`);
    for (const i of items.slice(0, flags.n ?? 20)) console.log(`  \x1b[2m${i.kind.padEnd(10)}\x1b[0m ${trunc(i.name, 40)}  \x1b[2m${(i.bytes / 1024).toFixed(0)}KB ${i.file}\x1b[0m`);
    if (!flags.full && items.length > (flags.n ?? 20)) console.log(`  …+${items.length - (flags.n ?? 20)}(--full 展开)`);
    next('utopinn import-preview --file <path>');
    footer();
}

async function cmdImportPreview() {
    const p = await importPayload();
    if (!p) return;
    const { data, status } = await req('POST', '/api/utopinn/import/preview', importBody(p, {
        ...(flags.api ? { apiId: flags.api } : {}),
        ...(flags.as ? { targetName: flags.as } : {}),
    }), { allowFail: true });
    if (status === 422 || status === 400) return void fail('usage', `探测失败:${data?.error ?? status}`, { detail: data?.hints ?? data?.error, hint: '换文件或用 --kind/--api 纠类型后 commit', rc: 2 });
    if (status >= 400 || data?.error) return void fail('server', `import-preview 失败:${data?.error ?? status}`, { status });
    const conflict = Boolean(data?.conflicts?.existingSameName);
    const n = [{ cmd: `utopinn import-commit ${flags.file ?? positional[1] ?? '<file>'}${conflict ? ' --conflict rename' : ''}`, why: conflict ? '有同名冲突,显式给策略' : '确认落库' }];
    if (JSON_MODE) return out(data, n);
    console.log(`${data?.kind ?? '?'}  "${data?.name ?? '?'}" → ${data?.targetName ?? '?'}${conflict ? '  \x1b[33m⚠ 同名已存在\x1b[0m' : ''}`);
    const sum = data?.summary ?? {};
    for (const [k, v] of Object.entries(sum).slice(0, flags.full ? 1e9 : 12)) {
        console.log(`  ${k}: ${trunc(typeof v === 'object' ? JSON.stringify(v) : String(v), 90)}`);
    }
    for (const w of (data?.warnings ?? [])) console.log(`  \x1b[33mwarning:\x1b[0m ${w}`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdImportCommit() {
    const p = await importPayload();
    if (!p) return;
    const { data, status } = await req('POST', '/api/utopinn/import/commit', importBody(p, {
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...(flags.as ? { targetName: flags.as } : {}),
        ...(flags.conflict ? { conflict: flags.conflict } : {}),
        ...(flags.api ? { apiId: flags.api } : {}),
    }), { allowFail: true });
    if (status === 409) {
        return void fail('exists', `同名冲突 "${data?.targetName ?? ''}"——显式给策略`, {
            detail: data?.error,
            hint: '--conflict rename|overwrite|skip',
            nexts: [{ cmd: `utopinn import-commit ${flags.file ?? positional[1] ?? '<file>'} --conflict rename` }],
            rc: 3,
        });
    }
    if (status === 422 || status === 400) return void fail('usage', `commit 被拒:${data?.error ?? status}`, { detail: data?.hints ?? data?.error, rc: 2 });
    if (status >= 400 || data?.error) return void fail('server', `import-commit 失败:${data?.error ?? status}`, { status });
    const n = data?.kind === 'char' ? [{ cmd: 'utopinn chars -n 5', why: '看新卡' }] : data?.kind === 'world' ? [{ cmd: `utopinn wi ${data.targetName} -n 10` }] : [{ cmd: 'utopinn doctor' }];
    if (JSON_MODE) return out(data, n);
    console.log(`imported ${data?.kind ?? '?'} "${data?.name ?? ''}" → ${data?.targetName ?? '?'}${data?.renamed ? ' (renamed)' : ''}${data?.skipped ? ' (skipped)' : ''}`);
    for (const w of (data?.warnings ?? [])) console.log(`  \x1b[33mwarning:\x1b[0m ${w}`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdBackup() {
    // zip attachment 二进制流——req() 的 JSON 路径走不通,自管 fetch(保留 401/403 重握手一次)
    const doFetch = () => fetch(`${SERVER}/api/utopinn/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: cookie },
        body: JSON.stringify(flags.set ? { selection: flags.set } : {}),
        signal: AbortSignal.timeout(flags.wait ?? 180_000),
    });
    await session();
    let r = await doFetch();
    if (r.status === 401 || r.status === 403) { csrf = ''; cookie = ''; await session(); r = await doFetch(); }
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        let d; try { d = JSON.parse(t); } catch { d = t; }
        return void fail('server', `backup → ${r.status}`, { status: r.status, detail: d });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const cd = r.headers.get('content-disposition') ?? '';
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
    const srvName = (m ? decodeURIComponent(String(m[1]).trim().replace(/^"|"$/g, '')) : '') || `utopinn-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    let outPath;
    if (flags.out) {
        const p = resolve(flags.out);
        outPath = /[\\/]$/.test(flags.out) || (existsSync(p) && statSync(p).isDirectory()) ? join(p, srvName) : p;
    } else {
        outPath = resolve(srvName);
    }
    writeFileSync(outPath, buf);
    if (JSON_MODE) return out({ file: outPath, bytes: buf.length, serverName: srvName });
    console.log(`backup → ${outPath} (${(buf.length / 1024).toFixed(1)}KB)`);
    footer();
}

/** lan offer/import 共用的 selection 源:--set cat=bool 或 --json-file。 */
function lanSelection() {
    if (flags.jsonFile) {
        try { return JSON.parse(readFileSync(resolve(flags.jsonFile), 'utf8')); }
        catch (e) { fail('usage', `--json-file 读取失败: ${e.message}`, { rc: 2 }); return null; }
    }
    if (flags.set) return { ...flags.set };
    return undefined;
}

async function cmdLanOffer() {
    const selection = lanSelection();
    if (selection === null) return;
    const { data, status } = await req('POST', '/api/utopinn/lan/offer', {
        ...(flags.handle ? { handle: flags.handle } : {}),
        ...(selection ? { selection } : {}),
    }, { allowFail: true });
    if (status >= 400 || data?.error) return void fail('server', `lan-offer 失败:${data?.error ?? status}`, { status, hint: status === 403 ? '跨 handle 需要 admin' : undefined });
    const n = [{ cmd: `utopinn lan-import --code ${data?.url ?? '<url>'}`, why: '对端机器执行拉入' }];
    if (JSON_MODE) return out(data, n);
    console.log(`offer → ${data?.url ?? '(no url)'}`);
    console.log(`expires ${data?.expiresAt ? new Date(data.expiresAt).toISOString() : '?'}(一次性,~10min)`);
    footer();
    nextHints = n;
    console.log(`\x1b[2m· next: ${n.map(x => x.cmd).join(' · ')}\x1b[0m`);
}

async function cmdLanImport() {
    const url = flags.code ?? positional[1];
    if (!url) return void fail('usage', 'utopinn lan-import <offer-url|--code c> [--mode merge|overwrite]', { hint: 'url 来自对端 lan-offer', rc: 2 });
    const selection = lanSelection();
    if (selection === null) return;
    const mode = String(flags.mode ?? 'merge').toLowerCase();
    if (!['merge', 'overwrite'].includes(mode)) return void fail('usage', '--mode 只认 merge|overwrite', { rc: 2 });
    const { data, status } = await req('POST', '/api/utopinn/lan/import', {
        url,
        ...(flags.handle ? { handle: flags.handle } : {}),
        ...(selection ? { selection } : {}),
        mode,
    }, { allowFail: true, timeout: flags.wait ?? 240_000 });
    if (status >= 400 || (data && typeof data === 'object' && data.error)) {
        return void fail('server', `lan-import 失败:${typeof data === 'object' ? data?.error ?? status : trunc(data, 200)}`, {
            status,
            hint: 'url 必须是对端 /api/users/transfer/backup/<token> 一次性链接;超时/被用掉会 4xx',
        });
    }
    let parsed = data;
    if (typeof data === 'string') { try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; } }
    if (JSON_MODE) return out(parsed);
    console.log(`lan-import ${mode} ← ${parsed?.source?.host ?? 'remote'}`);
    console.log(JSON.stringify(parsed, null, 2).slice(0, flags.full ? 1e9 : 3000));
    footer();
}

async function cmdRaw() {
    // 逃生舱:kernel 路由表上任何端点都能直达——写动词(PUT/PATCH/DELETE)
    // 不必为每条 REST 面单开命令。读面优先用具名命令(输出已整理)。
    const method = String(positional[1] ?? 'GET').toUpperCase();
    const path = positional[2];
    if (!path?.startsWith('/')) return void fail('usage', 'utopinn raw <METHOD> </path> [json|--stdin]', { hint: 'utopinn kernel 看路由表', rc: 2 });
    let body;
    if (flags.stdin) { const t = await readTextArg([]); try { body = JSON.parse(t); } catch { body = t; } }
    else if (positional[3] !== undefined) { try { body = JSON.parse(positional.slice(3).join(' ')); } catch { body = positional.slice(3).join(' '); } }
    const { data, status } = await req(method, path, body, { allowFail: true });
    if (JSON_MODE) return out({ status, data });
    if (status >= 400) return void fail('server', `${method} ${path} → ${status}`, { detail: typeof data === 'string' ? trunc(data, 200) : data });
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2).slice(0, flags.full ? 1e9 : 8000));
    footer(`${method} ${path} → ${status}`);
}

// ═══ state sidecar 三族(TASK-038):/api/utopinn/state/<family>/<op> ═══
// 词表 STATE_OPS 在具名路由区(NAMED_UTOPINN_ROUTES 旁,与具名钉样共用并自检)。
//   - get 默认 POST body 形;--via get 走 GET+query 的 ETag 私有化读
//     (?account 必须=认证 handle,默认 default-user,--handle 覆盖)。
//   - patch 收 JSON-Patch:ops 数组 | {operations:[…]} | {operation:{…}} | 裸单 op。
//   - char 独有 set(整态覆写;body.data 先验对象形);preset 独有 delete-all/rename。
//   - delete 类恒显式点名;chat 目标 = ctx 或 --char/--chat 显式覆盖
//     (群聊 is_group 目标待 --group flag 统一收,本格不加)。

const stateUsage = (detail) => fail('usage', `utopinn state <${Object.keys(STATE_OPS).join('|')}> <op> [args] [json|--json-file|--stdin]`, {
    detail: detail ?? `chat:${STATE_OPS.chat.join('|')} <ns…>(ctx|--char/--chat) · char:${STATE_OPS.char.join('|')} <ns> <doc> · preset:<op> <name> [ns…]|delete-all <name>|rename <old> <new>(--api 族,默认 openai)`,
    rc: 2,
});

/** patch 载荷归一 → operations 数组;不认得的形状回 null。 */
function asPatchOps(doc) {
    if (Array.isArray(doc)) return doc;
    if (doc && typeof doc === 'object') {
        if (Array.isArray(doc.operations)) return doc.operations;
        if (doc.operation && typeof doc.operation === 'object' && !Array.isArray(doc.operation)) return [doc.operation];
        if (typeof doc.op === 'string' && typeof doc.path === 'string') return [doc];
    }
    return null;
}

/** state 面统一错误映射:409→integrity_conflict/exists rc3,404→not_found,403→session,400→usage。 */
function stateFail(family, op, status, data) {
    const errTxt = data?.error ?? data?.detail ?? (typeof data === 'string' ? trunc(data, 160) : JSON.stringify(data));
    if (status === 409) return fail(op === 'rename' ? 'exists' : 'integrity_conflict', `state ${family} ${op} 冲突: ${errTxt}`, { status, rc: 3 }), true;
    if (status === 404) return fail('not_found', `state ${family} ${op}: ${errTxt}`, { status }), true;
    if (status === 403) return fail('session', `state ${family} ${op} forbidden: ${errTxt}`, { status, hint: '--via get 需要 ?account=认证 handle(默认 default-user,--handle 覆盖)', rc: 4 }), true;
    if (status === 400) return fail('usage', `state ${family} ${op} 被拒: ${errTxt}`, { status, rc: 2 }), true;
    if (status >= 400 || (data && typeof data === 'object' && data.error)) return fail('server', `state ${family} ${op} 失败(${status}): ${errTxt}`, { status }), true;
    return false;
}

function stateShow(data, tag) {
    if (JSON_MODE) return out(data);
    console.log(JSON.stringify(data, null, 2).slice(0, flags.full ? 1e9 : 8000));
    footer(tag);
    return data;
}

async function cmdState() {
    const family = positional[1], op = positional[2];
    if (!STATE_OPS[family]?.includes(op ?? '')) return void stateUsage();
    const via = String(flags.via ?? 'post').toLowerCase();
    if (!['post', 'get'].includes(via)) return void fail('usage', '--via 只认 post|get', { rc: 2 });
    if (via === 'get' && op !== 'get') return void fail('usage', '--via get 只对 state <family> get 有效', { rc: 2 });
    const rest = positional.slice(3);
    const account = flags.handle ?? 'default-user';

    // ── target 形状:chat={avatar_url,file_name},char={avatar_url},preset={apiId,name} ──
    let body = {}, query = null, argCursor = 0;
    if (family === 'chat') {
        const charDir = flags.char ? stripExt(flags.char, 'png') : state.char?.dir;
        const chatName = stripExt(flags.chat ?? state.chat?.name ?? '', 'jsonl');
        if (!charDir || !chatName) {
            return void fail('no_ctx', 'state chat 需要 char+chat 目标', { hint: 'utopinn use <char> <chat>,或 --char d --chat n 显式给', rc: 2 });
        }
        body = { avatar_url: `${charDir}.png`, file_name: `${chatName}.jsonl` };
        query = { is_group: 'false', avatar_url: body.avatar_url, file_name: body.file_name };
    } else if (family === 'char') {
        const charDir = flags.char ? stripExt(flags.char, 'png') : state.char?.dir;
        if (!charDir) {
            return void fail('no_ctx', 'state char 需要 char 目标', { hint: 'utopinn use <char> 或 --char d 显式给', rc: 2 });
        }
        body = { avatar_url: `${charDir}.png` };
        query = { avatar: body.avatar_url };
    } else { // preset:name 是首个位置参(显式点名,delete 族铁律同款)
        if (!rest[0]) return void stateUsage(`state preset ${op} 需要显式 <name>`);
        body = { apiId: flags.api ?? 'openai', name: rest[0] };
        query = { apiId: body.apiId, name: body.name };
        argCursor = 1;
    }
    const nsArgs = rest.slice(argCursor);
    const route = (tail) => `/api/utopinn/state/${family}/${tail}`;

    if (op === 'get') {
        const ns = nsArgs[0];
        if (!ns) return void stateUsage(`state ${family} get <ns>`);
        let data, status;
        if (via === 'get') {
            const q = new URLSearchParams({ ...query, namespace: ns, account });
            ({ data, status } = await req('GET', `${route('get')}?${q}`, undefined, { allowFail: true }));
        } else {
            ({ data, status } = await req('POST', route('get'), { ...body, namespace: ns }, { allowFail: true }));
        }
        if (stateFail(family, op, status, data)) return;
        return stateShow(data, `state ${family} get ${ns}${via === 'get' ? ' (GET)' : ''} → ${data?.data == null ? 'null' : 'doc'}`);
    }
    if (op === 'get-batch') {
        if (!nsArgs.length) return void stateUsage(`state ${family} get-batch <ns…>`);
        const { data, status } = await req('POST', route('get-batch'), { ...body, namespaces: nsArgs }, { allowFail: true });
        if (stateFail(family, op, status, data)) return;
        return stateShow(data, `state ${family} get-batch ×${nsArgs.length}`);
    }
    if (op === 'patch') {
        const ns = nsArgs[0];
        if (!ns) return void stateUsage(`state ${family} patch <ns> [ops|--json-file f|--stdin]`);
        const doc = await readJsonBody(nsArgs.slice(1), `state ${family} patch 需要 JSON-Patch ops(数组|单 op|{operations|operation})`);
        if (doc === undefined) return;
        const operations = asPatchOps(doc);
        if (!operations?.length) return void fail('usage', 'patch ops 空或形状不对(数组|单 op|{operations|operation})', { rc: 2 });
        const { data, status } = await req('POST', route('patch'), { ...body, namespace: ns, operations }, { allowFail: true });
        if (stateFail(family, op, status, data)) return;
        return stateShow(data, `state ${family} patch ${ns}: applied ${data?.applied ?? '?'}${data?.created ? ' · created' : ''}`);
    }
    if (op === 'delete') {
        const ns = nsArgs[0];
        if (!ns) return void stateUsage(`state ${family} delete <ns>(显式点名)`);
        const { data, status } = await req('POST', route('delete'), { ...body, namespace: ns }, { allowFail: true });
        if (stateFail(family, op, status, data)) return;
        return stateShow(data, `state ${family} delete ${ns}: ${data?.deleted ? 'deleted' : 'absent'}`);
    }
    if (op === 'set') { // char 独有(STATE_OPS 已门住其余 family)
        const ns = nsArgs[0];
        if (!ns) return void stateUsage('state char set <ns> [doc|--json-file f|--stdin]');
        const doc = await readJsonBody(nsArgs.slice(1), 'state char set 需要整态 doc(JSON 对象)');
        if (doc === undefined) return;
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
            return void fail('usage', 'state char set 的 doc 必须是 JSON 对象(整态覆写,不收数组/标量)', { rc: 2 });
        }
        const { data, status } = await req('POST', route('set'), { ...body, namespace: ns, data: doc }, { allowFail: true });
        if (stateFail(family, op, status, data)) return;
        return stateShow(data, `state char set ${ns} → ok`);
    }
    if (op === 'delete-all') { // preset 独有
        const { data, status } = await req('POST', route('delete-all'), { apiId: body.apiId, name: body.name }, { allowFail: true });
        if (stateFail(family, op, status, data)) return;
        return stateShow(data, `state preset delete-all ${body.name}: ${data?.deleted ?? 0} ns cleared`);
    }
    if (op === 'rename') { // preset 独有;body.name 此时是 oldName,newName 是下一个位置参
        const newName = nsArgs[0];
        if (!newName) return void stateUsage('state preset rename <old> <new>');
        const { data, status } = await req('POST', route('rename'), { apiId: body.apiId, oldName: body.name, newName }, { allowFail: true });
        if (stateFail(family, op, status, data)) return;
        return stateShow(data, `state preset rename ${body.name} → ${newName}: ${data?.renamed ?? 0} ns moved`);
    }
}

async function cmdCardApp() {
    // 懒加载:jsdom/esbuild 不进 utopinn-cli.mjs 启动路径(零依赖冷启保持)
    const { run } = await import('./cmd-cardapp.mjs');
    return run({
        positional, flags, SERVER, needCtx, out, fail, warn, footer,
        saveState, state, readTextArg, stripExt, JSON_MODE,
    });
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
        case 'groups': await cmdGroups(); break;
        case 'guse': await cmdGuse(); break;
        case 'chat-new': await cmdChatNew(); break;
        case 'chat-create': await cmdChatCreate(); break;
        case 'chat-put': await cmdChatPut(); break;
        case 'chat-get': await cmdChatGet(); break;
        case 'chat-rename': await cmdChatRename(); break;
        case 'chat-delete': await cmdChatDelete(); break;
        case 'char': await cmdChar(); break;
        case 'char-edit': await cmdCharEdit(); break;
        case 'history': await cmdHistory(); break;
        case 'edit': await cmdEdit(); break;
        case 'jobs': await cmdJobs(); break;
        case 'inspect': await cmdInspect(); break;
        case 'logs': await cmdLogs(); break;
        case 'errors': await cmdErrors(); break;
        case 'trace': await cmdTrace(); break;
        case 'stats': await cmdStats(); break;
        case 'diag-client': await cmdDiagClient(); break;
        case 'preview': await cmdPreview(); break;
        case 'attach': await cmdAttach(); break;
        case 'abort': await cmdAbort(); break;
        case 'persona': await cmdPersona(); break;
        case 'personas': await cmdPersonas(); break;
        case 'persona-edit': await cmdPersonaEdit(); break;
        case 'persona-delete': await cmdPersonaDelete(); break;
        case 'presets': await cmdPresets(); break;
        case 'preset': await cmdPreset(); break;
        case 'preset-get': await cmdPresetGet(); break;
        case 'preset-edit': await cmdPresetEdit(); break;
        case 'preset-delete': await cmdPresetDelete(); break;
        case 'settings': await cmdSettings(); break;
        case 'settings-set': await cmdSettingsSet(); break;
        case 'secrets': await cmdSecrets(); break;
        case 'secret-set': await cmdSecretSet(); break;
        case 'secret-delete': await cmdSecretDelete(); break;
        case 'conn': await cmdConn(); break;
        case 'models': await cmdModels(); break;
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
        case 'world-edit': await cmdWorldEdit(); break;
        case 'world-delete': await cmdWorldDelete(); break;
        case 'regex': await cmdRegex(); break;
        case 'kernel': case 'caps': await cmdKernel(); break;
        case 'plugins': await cmdPlugins(); break;
        case 'plugin': await cmdPlugin(); break;
        case 'contrib': await cmdContrib(); break;
        case 'mvu': await cmdMvu(); break;
        case 'script': case 'stscript': await cmdScript(); break;
        case 'th': await cmdTh(); break;
        case 'cardapp': await cmdCardApp(); break;
        case 'import-scan': await cmdImportScan(); break;
        case 'import-preview': await cmdImportPreview(); break;
        case 'import-commit': await cmdImportCommit(); break;
        case 'backup': await cmdBackup(); break;
        case 'lan-offer': await cmdLanOffer(); break;
        case 'lan-import': await cmdLanImport(); break;
        case 'state': await cmdState(); break;
        case 'raw': await cmdRaw(); break;
        case 'help': case '--help': case '-h':
            console.log('utopinn — agent-first CLI。裸跑看状态,`utopinn schema` 看自描述目录,`utopinn doctor` 体检。文档:.loom/capabilities/cli-client/capability.md');
            break;
        default:
            fail('usage', `unknown command: ${CMD}`, { hint: 'utopinn schema 看命令面', rc: 2 });
    }
} catch (e) {
    const code = e.code ?? (e.status ? 'server' : 'network');
    fail(code, e.message, {
        status: e.status, detail: e.data,
        hint: code === 'session' ? '会话/CSRF 失败——确认 server 起在 loopback 白名单面' : code === 'network' ? 'server 不可达——utopinn doctor 体检' : undefined,
        rc: code === 'session' || code === 'network' ? 4 : (e.status === 409 ? 3 : 1),
    });
}
ring(CMD ?? '?', exitCode);
// 大 envelope(~140KB)写管道时 console.log 只进缓冲——直接 exit 会截断 stdout。
// 等 writableLength 排空再走;3s 兜底防 drain 卡死。
const drainExit = () => {
    if (process.stdout.writableLength > 0 || process.stdout.writableNeedDrain) {
        return void setTimeout(drainExit, 10);
    }
    process.exit(exitCode);
};
setTimeout(() => process.exit(exitCode), 3000).unref();
drainExit();
