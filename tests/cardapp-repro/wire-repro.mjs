/**
 * wire-repro — starter-card bug reproduction on the REAL wire contract.
 *
 * What runs for real (nothing re-implemented):
 *   - packages/panel-shim/src/ctx-shim.js   — evaluated inside JSDOM
 *   - apps/server/default/_seed/card-apps/我没想当掌门啊/index.js
 *     — esbuild-bundled like apps/cli/cardapp-host.mjs, init(ctx) invoked
 *   - packages/api-client CardAppHost       — the real ctx dispatch table,
 *     diffAndEmitChat ordering, nsWritable gate, eventEmit 'no host consumer'
 *   - packages/api-client PanelBridge       — real nonce/allowlist/wire gate
 *   - the card's real manifest              — parsed out of the shipped PNG
 *     (chara tEXt) by apps/server/src/card-runtime/manifest.js
 *
 * What is faked (the parts that are not the bug surface):
 *   - UtopinnClient → in-memory chat doc / state store / settings / WI book
 *   - the LLM       → generation.jobGet appends a scripted char reply when the
 *     job completes (same shape as the server's persisted job)
 *
 * Push fidelity: CardAppHost.push() delivers into the JSDOM window's
 * __utopinnPanelReceive — identical ordering to web iframe / RN WebView.
 *
 * Run:  node tests/cardapp-repro/wire-repro.mjs [--verbose]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(fileURLToPath(import.meta.url), '../../..');
const req = createRequire(path.join(REPO, 'apps/cli/package.json'));
const { JSDOM, VirtualConsole } = req('jsdom');
const esbuild = req('esbuild');
const { CardAppHost, PanelBridge } = await import(pathToFileURL(path.join(REPO, 'packages/api-client/dist/index.js')).href);
const { expandApiGrants } = await import(pathToFileURL(path.join(REPO, 'packages/protocol/dist/index.js')).href);
const { parseCardAppManifest } = await import(pathToFileURL(path.join(REPO, 'apps/server/src/card-runtime/manifest.js')).href);
const { readCardFromPng } = await import(pathToFileURL(path.join(REPO, 'packages/formats/dist/index.js')).href);

const CARD_DIR = path.join(REPO, 'apps/server/default/_seed/card-apps/我没想当掌门啊');
const CARD_PNG = path.join(REPO, 'apps/server/default/scaffold/characters/我没想当掌门啊.png');
const WORLD_JSON = path.join(REPO, 'apps/server/default/_seed/worlds/我没想当掌门啊｜世界书 v1.8.json');
const WORLD_NAME = '我没想当掌门啊｜世界书 v1.8';
const CHAR_DIR = '我没想当掌门啊';
const CHAT_NAME = 'repro-chat';
const VERBOSE = process.argv.includes('--verbose');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jsonClone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Real manifest out of the shipped PNG (the card_app tEXt block).
// ---------------------------------------------------------------------------
const cardJson = JSON.parse(readCardFromPng(new Uint8Array(fs.readFileSync(CARD_PNG))));
const { manifest } = parseCardAppManifest(cardJson);
console.log('[manifest] permissions =', JSON.stringify(manifest.permissions));

// ---------------------------------------------------------------------------
// Fake client — in-memory chat doc + sidecar state + settings + WI book.
// Only the transport/LLM is fake; every CardAppHost decision path runs real.
// ---------------------------------------------------------------------------
function makeClient({ messages, variables }) {
    const doc = {
        header: { chat_metadata: { variables: jsonClone(variables) ?? {} } },
        messages: jsonClone(messages) ?? [],
    };
    const chatState = {};
    const charState = {};
    const settings = { extension_prompts: {} };
    const worldDoc = JSON.parse(fs.readFileSync(WORLD_JSON, 'utf8'));
    const calls = { eventEmit: [], settingsPatch: [] };

    /** minimal JSON-pointer add/replace; '/body/N/…' maps onto doc.messages. */
    function applyOps(root, ops) {
        for (const op of ops) {
            const segs = String(op.path).split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
            if (segs[0] === 'body') segs[0] = 'messages';
            if (!segs.length) { if (op.op === 'add' || op.op === 'replace') Object.assign(root, jsonClone(op.value)); continue; }
            let cur = root;
            while (segs.length > 1) {
                const k = /^\d+$/.test(segs[0]) && Array.isArray(cur) ? Number(segs[0]) : segs[0];
                if (cur[k] === undefined || cur[k] === null) cur[k] = /^\d+$/.test(segs[1]) ? [] : {};
                cur = cur[k]; segs.shift();
            }
            const k = /^\d+$/.test(segs[0]) && Array.isArray(cur) ? Number(segs[0]) : segs[0];
            if (op.op === 'add' || op.op === 'replace') cur[k] = jsonClone(op.value);
            else if (op.op === 'remove') { if (Array.isArray(cur)) cur.splice(k, 1); else delete cur[k]; }
        }
    }

    let jobReplyText = null;
    let jobPending = true;   // harness controls when the scripted reply persists
    const client = {
        library: {
            chatGet: async () => jsonClone(doc),
            appendMessages: async (_c, _n, msgs) => { for (const m of msgs) doc.messages.push(jsonClone(m)); },
            patchChat: async (_c, _n, ops) => { applyOps(doc, ops); },
            settings: async () => ({}),
            char: async () => ({ data: { extensions: { world: WORLD_NAME } } }),
            worldGet: async () => ({ doc: jsonClone(worldDoc) }),
            worldEdit: async () => ({}),
        },
        settingsDoc: async () => jsonClone(settings),
        settingsPatch: async (ops) => { calls.settingsPatch.push(jsonClone(ops)); applyOps(settings, ops); return { ok: true }; },
        state: {
            chat: {
                get: async (_t, ns) => ({ data: jsonClone(chatState[ns]) ?? null }),
                patch: async (_t, ns, ops) => {
                    for (const op of ops) {
                        if (op.path === '' && (op.op === 'replace' || op.op === 'add')) chatState[ns] = jsonClone(op.value);
                        else { chatState[ns] = chatState[ns] ?? {}; applyOps(chatState[ns], [op]); }
                    }
                },
                delete: async (_t, ns) => { delete chatState[ns]; },
            },
            char: {
                get: async (_t, ns) => ({ data: jsonClone(charState[ns]) ?? null }),
                set: async (_t, ns, v) => { charState[ns] = jsonClone(v); },
            },
        },
        generation: {
            generate: async () => ({ accepted: true }),
            jobGet: async () => {
                if (jobPending) return { status: 'running' };
                if (jobReplyText != null && !doc.__replyAppended) {
                    doc.__replyAppended = true;
                    doc.messages.push({ name: CHAR_DIR, is_user: false, is_system: false, send_date: new Date().toISOString(), mes: jobReplyText });
                }
                return { status: 'completed', persisted: true, text: jobReplyText };
            },
        },
        th: {
            call: async (name, { args } = {}) => {
                if (name === 'eventEmit') { calls.eventEmit.push({ name: args?.event, args: args?.args }); return { ok: true, result: {} }; }
                if (name === 'getEventLog') return { ok: true, result: { seq: 0, entries: [] } };
                if (name === 'getCharacter') return { ok: true, result: { data: { extensions: { world: WORLD_NAME } } } };
                return { ok: true, result: {} };
            },
        },
        _doc: doc, _chatState: chatState, _calls: calls,
        _setReply(text) { jobReplyText = text; doc.__replyAppended = false; },
        _finishJob() { jobPending = false; },
        _vars() { return doc.header.chat_metadata.variables; },
    };
    return client;
}

// ---------------------------------------------------------------------------
// JSDOM boot — bootstrap + stubs + real ctx-shim + bundled card init.
// ---------------------------------------------------------------------------
function installDomStubs(window) {
    const noop = () => { };
    if (typeof window.matchMedia !== 'function') {
        window.matchMedia = (q) => ({ matches: false, media: String(q), onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false });
    }
    for (const name of ['ResizeObserver', 'IntersectionObserver']) {
        if (typeof window[name] !== 'function') window[name] = class { observe() { } unobserve() { } disconnect() { } };
    }
    if (typeof window.requestAnimationFrame !== 'function') window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 16);
    if (!window.visualViewport) window.visualViewport = { width: window.innerWidth, height: window.innerHeight, addEventListener: noop, removeEventListener: noop, onresize: null };
    try { window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || noop; } catch { }
    window.scrollTo = window.scrollTo || noop; window.scrollBy = window.scrollBy || noop;
    window.alert = window.alert || noop; window.confirm = window.confirm || (() => false);
    window.prompt = window.prompt || (() => null); window.open = window.open || (() => null);
    try { window.top = window; window.parent = window; } catch { }
}

async function mountCard({ client, writableNamespaces, pushProbe, dropPush }) {
    const nonce = 'nonce-repro';
    const bootstrap = {
        face: 'ctx', mountId: 'm-repro', charId: CHAR_DIR, chatName: CHAT_NAME,
        entry: manifest.entry, assetBase: '/card-runtime/m/m-repro/',
        stateNamespaces: writableNamespaces ?? [],
    };
    const consoleLog = [];
    const vc = new VirtualConsole();
    for (const lvl of ['log', 'info', 'warn', 'error']) vc.on(lvl, (...a) => consoleLog.push({ lvl, msg: a.join(' ') }));
    vc.on('jsdomError', (e) => consoleLog.push({ lvl: 'jsdomError', msg: e?.stack || String(e) }));

    const shimSource = fs.readFileSync(path.join(REPO, 'packages/panel-shim/src/ctx-shim.js'), 'utf8');
    let bridge = null;
    const pendingInbound = [];
    let window = null;
    const chatCacheInfo = () => window?.eval(`(function(){var c=(window.__CARDAPP_CTX__&&window.__CARDAPP_CTX__.lukerContext&&window.__CARDAPP_CTX__.lukerContext.chat)||[];var t=c[c.length-1];return {len:c.length,tailUser:!!(t&&t.is_user),tailMes:String(t&&t.mes||'').slice(0,40)};})()`);
    const pushes = [];
    const pushToCard = (event, payload) => {   // manual replay — always delivers
        pushes.push({ event, payload, manual: true });
        pushProbe?.(event, payload);
        bridge?.push(event, payload);
    };
    const hostPush = (event, payload) => {     // host-originated — droppable for isolation
        pushes.push({ event, payload });
        pushProbe?.(event, payload);
        if (dropPush?.(event, payload)) return;
        bridge?.push(event, payload);
    };

    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="card-app-container"></div></body></html>', {
        url: 'https://cardapp.repro/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        virtualConsole: vc,
        beforeParse(w) {
            w.__UTOPINN_PANEL_NONCE__ = nonce;
            w.__UTOPINN_PANEL_BOOTSTRAP__ = bootstrap;
            w.__utopinnPanelPost = (m) => { bridge ? bridge.onMessage(m) : pendingInbound.push(m); };
            installDomStubs(w);
            w.eval(shimSource);
        },
    });
    window = dom.window;

    const host = new CardAppHost({
        charDir: CHAR_DIR,
        chatName: CHAT_NAME,
        push: hostPush,
        writableNamespaces,
        log: (m) => consoleLog.push({ lvl: 'host', msg: String(m) }),
    }, client);

    const grants = expandApiGrants(manifest.permissions?.api);
    bridge = new PanelBridge({
        nonce,
        allowed: grants.allowed,
        normalize: jsonClone,
        encodeResult: (r) => jsonClone(r) ?? null,
        send: (msg) => { try { window.__utopinnPanelReceive?.(jsonClone(msg)); } catch (e) { consoleLog.push({ lvl: 'warn', msg: `panelReceive threw: ${e?.message ?? e}` }); } },
        dispatch: (method, args) => host.dispatch(method, args),
    });
    // flush requests the shim queued before the bridge existed (cardapp-host.mjs:1077 parity)
    for (const m of pendingInbound.splice(0)) bridge.onMessage(m);

    await host.seed();
    try { window.__CARDAPP_CTX__?.__ready?.catch(() => { }); } catch { }

    // bundle + eval card module (cardapp-host.mjs parity)
    const entrySrc = fs.readFileSync(path.join(CARD_DIR, manifest.entry), 'utf8');
    const built = await esbuild.build({
        stdin: { contents: entrySrc, resolveDir: CARD_DIR, loader: 'js' },
        bundle: true, format: 'cjs', write: false, logLevel: 'silent', target: 'es2020',
    });
    window.eval(`(function(){var module={exports:{}},exports=module.exports;\n${built.outputFiles[0].text}\n;window.__cardapp_exports=module.exports;})()`);
    const mod = window.__cardapp_exports;
    const cardCtx = window.__CARDAPP_CTX__;
    try { await cardCtx.__ready; } catch { }
    await Promise.resolve(mod.init(cardCtx));
    await sleep(30);

    return {
        window, dom, host, pushes, consoleLog, chatCacheInfo,
        pushToCard,
        evalInCard: (expr) => window.eval(`(${expr})`),
        flush: async (ms = 120) => { await sleep(ms); },
        dispose: () => { try { dom.window.close(); } catch { } },
    };
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
const SEED_VARS = {
    stat_data: {
        day: 5, '宗门名': '云栖宗', '掌门名': '沈孤鸿', '脾性': '笑面虎', '由头': '躲仇家上山',
        '开场': '毕',
        '资源': { '灵石': 100 },
        '名册': [{ '名': '林小满', '差事': '外门弟子', '状态': '扫台阶', '信任': 50, '入': 1 }],
        '日务': [], '行囊': [], '渠道队': [], '山门事': [], '待回话': [], '牵扯': [],
    },
};
const SEED_MSGS = [
    { name: 'User', is_user: true, is_system: false, send_date: '2026-01-01T00:00:00Z', mes: '落印立契——云栖宗这烂摊子，我接了。' },
    { name: CHAR_DIR, is_user: false, is_system: false, send_date: '2026-01-01T00:00:10Z', mes: '五幕演毕，山门洞开。\n_.set(\'stat_data.开场\',\'毕\');' },
];
const REPLY_WITH_SETS = `山门日常一页。
_.set('stat_data.资源.灵石', 4242);
_.set('stat_data.名册.0.状态','领了月例');`;
const REPLY_NO_DAY_SET = `山门日常一页，新账入簿。
_.set('stat_data.资源.灵石', 4242);`;

function verdict(name, bad, detail) {
    console.log(`\n### ${name}: ${bad ? 'REPRODUCED' : 'NOT REPRODUCED'} — ${detail}`);
}

async function scenarioA() {
    console.log('\n===== A: char_message_rendered vs stale snapshot (real sendMessage flow) =====');
    const client = makeClient({ messages: SEED_MSGS, variables: SEED_VARS });
    client._setReply(REPLY_WITH_SETS); client._finishJob();   // reply lands inside the job, like the server
    let mounted = null;
    let cacheAtCharMsg = null;
    mounted = await mountCard({
        client,
        writableNamespaces: manifest.permissions.stateNamespaces,   // real manifest → []
        pushProbe: (event, payload) => {
            if (event === 'host.event' && payload?.name === 'char_message_rendered') {
                cacheAtCharMsg = mounted?.chatCacheInfo();
            }
        },
    });
    const { evalInCard, pushes, consoleLog, flush } = mounted;
    console.log('[init] container gate =', evalInCard(`document.getElementById('card-app-container')?.dataset?.gate ?? '?'`));
    evalInCard(`document.querySelector('.zb-daybtn[data-act="advance"]').click()`);
    await sleep(20);
    console.log('[drive] review overlay open:', evalInCard(`!!document.querySelector('.rv-go')`));
    evalInCard(`document.querySelector('.rv-go').click()`);
    await sleep(1600);   // sendMessage round-trip + scheduleChatRefresh(0)
    await flush(120);

    console.log('[push order]', pushes.map(p => p.event === 'host.event' ? p.payload?.name : p.event).join(' → '));
    console.log('[at charMsg dispatch] shim chatCache:', JSON.stringify(cacheAtCharMsg));
    const sd = evalInCard(`window.__CARDAPP_CTX__.getVariable('stat_data')`);
    const ls = sd?.['资源']?.['灵石'];
    const day = sd?.day;
    const roster0 = sd?.['名册']?.[0]?.['状态'];
    console.log('[after] stat_data.day =', day, '| 资源.灵石 =', ls, '| 名册[0].状态 =', JSON.stringify(roster0));
    console.log('[server-side var] 资源 =', JSON.stringify(client._vars()?.stat_data?.['资源']));
    console.log('[floor 1 mes now]', JSON.stringify(client._doc.messages[1].mes), '← stale charMsg re-processed the WRONG floor (editMessage stripped it)');
    console.log('[floor 3 reply still contains _.set lines]', client._doc.messages.at(-1).mes.includes('_.set'));
    const missed = consoleLog.filter(l => /无 set 行|落账|漏账|set 行/.test(l.msg)).map(l => `[${l.lvl}] ${l.msg}`);
    console.log(missed.join('\n') || '(no ledger logs)');
    verdict('A', ls !== 4242, `reply's _.set lines never applied (灵石=${ls} ≠ 4242); charMsg read chatCache len=${cacheAtCharMsg?.len} tail.is_user=${cacheAtCharMsg?.tailUser} — the reply was not in the snapshot`);
    mounted.dispose();
    return ls !== 4242;
}

/**
 * C — flag-kill isolation. pendingAdvanceDay is armed at .rv-go click; the
 * end-day bump can only fire inside onCharMsg's sets branch (bumpPendingDay).
 * Two independent killers, both fed by the wire host's per-diff semantics:
 *   - onChatChanged clears the flag unconditionally; the wire host emits
 *     chat_changed on EVERY dirty floor diff (incl. a mid-gen user-append diff
 *     that lands before the reply) — ST's semantics only fire it on chat switch.
 *   - onUserMsg reads a stale chatCache → lastUser misses 度过今日 → clears.
 * All pushes during sendMessage are suppressed, then each variant replays ONE
 * controlled sequence before a fresh-snapshot charMsg probe (day bump ⇔ flag
 * survived).
 */
async function scenarioC() {
    console.log('\n===== C: end-day fallback (pendingAdvanceDay) kill-path isolation =====');
    const CHAT_FILE = `${CHAT_NAME}.jsonl`;   // wire host always passes the current chatFileName
    const variants = {
        'control (no events)':            { fresh: true,  seq: [] },
        'chat_changed same-chat only':    { fresh: true,  seq: [['chat_changed', CHAT_FILE]] },
        'chat_changed real-switch only':  { fresh: true,  seq: [['chat_changed', 'other-chat.jsonl']] },
        'user_rendered @ stale cache':    { fresh: false, seq: [['user_message_rendered', 2]] },
        'user_rendered @ fresh cache':    { fresh: true,  seq: [['user_message_rendered', 2]] },
        'char_rendered only @ stale':     { fresh: false, seq: [['char_message_rendered', 3]] },
        'real order @ fresh cache':       { fresh: true,  seq: [['user_message_rendered', 2], ['char_message_rendered', 3], ['chat_changed', CHAT_FILE]] },
        'real order @ stale cache':       { fresh: false, seq: [['user_message_rendered', 2], ['char_message_rendered', 3], ['chat_changed', CHAT_FILE]] },
    };
    const results = {};
    for (const [label, v] of Object.entries(variants)) {
        const client = makeClient({ messages: SEED_MSGS, variables: SEED_VARS });
        client._setReply(REPLY_NO_DAY_SET);      // model forgot the day set — fallback's whole job
        let phase = 'arm';
        const mounted = await mountCard({
            client,
            writableNamespaces: manifest.permissions.stateNamespaces,
            dropPush: () => phase === 'flight',   // suppress the whole send flow — replay below
        });
        const { evalInCard } = mounted;
        evalInCard(`document.querySelector('.zb-daybtn[data-act="advance"]').click()`);
        await sleep(20);
        phase = 'flight';
        evalInCard(`document.querySelector('.rv-go').click()`);   // arms flag, sendMessage in-flight
        await sleep(30);                       // user msg appended; job still running
        const seqStale = mounted.chatCacheInfo();
        if (!v.fresh) {
            // stale window: sendMessage in-flight, cache still the seed snapshot —
            // exactly what a mid-generation poll diff / same-diff event sees
            for (const [name, arg] of v.seq) {
                mounted.pushToCard('host.event', { name, args: [name === 'chat_changed' ? arg : Number(arg)] });
                await sleep(60);
            }
        }
        client._finishJob();
        await sleep(1400);                       // sendMessage round-trip completes; pushes all dropped
        phase = 'replay';
        if (!client._doc.__replyAppended) { client._doc.__replyAppended = true; client._doc.messages.push({ name: CHAR_DIR, is_user: false, mes: REPLY_NO_DAY_SET }); }
        const replyIdx = client._doc.messages.length - 1;
        if (v.fresh) { mounted.pushToCard('chat.updated', {}); await mounted.flush(160); }
        const cacheAtSeq = mounted.chatCacheInfo();
        if (v.fresh) for (const [name, arg] of v.seq) {
            mounted.pushToCard('host.event', { name, args: [name === 'chat_changed' ? arg : Number(arg)] });
            await sleep(60);                    // async handler bodies settle
        }
        // probe: fresh cache, then charMsg — flag survived ⇔ day bumps
        mounted.pushToCard('chat.updated', {});
        await mounted.flush(160);
        mounted.pushToCard('host.event', { name: 'char_message_rendered', args: [replyIdx] });
        await sleep(400);
        const sd = evalInCard(`window.__CARDAPP_CTX__.getVariable('stat_data')`);
        results[label] = { day: sd?.day, ls: sd?.['资源']?.['灵石'] };
        console.log(`[${label}] cache@seq(stale)=${JSON.stringify(seqStale)} cache@seq=${JSON.stringify(cacheAtSeq)} → day=${sd?.day} 灵石=${sd?.['资源']?.['灵石']}`);
        mounted.dispose();
    }
    const controlOk = results['control (no events)'].day === 6;
    const switchStillClears = results['chat_changed real-switch only'].day !== 6;
    const killers = ['chat_changed same-chat only', 'user_rendered @ stale cache', 'real order @ stale cache']
        .filter(l => results[l].day !== 6);
    const survivors = ['user_rendered @ fresh cache', 'real order @ fresh cache']
        .filter(l => results[l].day === 6);
    const dead = controlOk && switchStillClears && killers.length === 3 && survivors.length === 2;
    verdict('C', dead, `same-chat chat_changed + stale-cache userMsg kill the flag (day 5); fresh snapshot / real-switch semantics behave (control 6, real-switch still clears)`);
    return dead;
}

async function scenarioB() {
    console.log('\n===== B: zongmen_ui writes vs manifest stateNamespaces =====');
    async function run(writable) {
        const client = makeClient({ messages: SEED_MSGS, variables: SEED_VARS });
        client._setReply(REPLY_NO_DAY_SET); client._finishJob();
        const m = await mountCard({ client, writableNamespaces: writable });
        await sleep(60);
        // roster render → rosterDiff marks 林小满 'new' → saveUiPrefs → ctx.updateChatState
        m.evalInCard(`document.querySelector('[data-tab="1"]').click()`);
        await sleep(30);
        m.evalInCard(`document.querySelector('[data-ssub="roster"]')?.click()`);
        await sleep(60);
        const state = jsonClone(client._chatState['zongmen_ui']) ?? null;
        m.dispose();
        return state;
    }
    const denied = await run(manifest.permissions.stateNamespaces);   // []
    console.log('[manifest ns =', JSON.stringify(manifest.permissions.stateNamespaces), '] zongmen_ui sidecar =', JSON.stringify(denied));
    const granted = await run(['zongmen_ui']);
    console.log('[ns = ["zongmen_ui"]              ] zongmen_ui sidecar =', JSON.stringify(granted)?.slice(0, 200));
    const bad = denied == null && granted != null;
    verdict('B', bad, `updateChatState denied under the shipped manifest (sidecar ${JSON.stringify(denied)}); same code persists once ns is granted`);
    return bad;
}

async function scenarioD(day = 5, arcs = null) {
    console.log(`\n===== D: worldinfo_force_activate emission vs host consumer (day=${day}${arcs ? ' arc=' + JSON.stringify(arcs) : ''}) =====`);
    const vars = jsonClone(SEED_VARS); vars.stat_data.day = day;
    if (arcs) vars.stat_data['主线'] = arcs;
    const client = makeClient({ messages: SEED_MSGS, variables: vars });
    client._setReply(REPLY_NO_DAY_SET); client._finishJob();
    const m = await mountCard({ client, writableNamespaces: manifest.permissions.stateNamespaces });
    m.evalInCard(`window.__CARDAPP_CTX__.eventSource.emit('generation_started', 'normal')`);
    await sleep(120);
    const hostLogs = m.consoleLog.filter(l => l.lvl === 'host' && /eventEmit/.test(l.msg));
    const cardLogs = m.consoleLog.filter(l => /点名|落印|开场剧/.test(l.msg));
    const wiEmit = hostLogs.find(l => /worldinfo_force_activate/.test(l.msg));
    console.log('[card console]', cardLogs.map(l => `[${l.lvl}] ${l.msg}`).join('\n') || '(none)');
    console.log('[host log]', hostLogs.map(l => l.msg));
    m.dispose();
    return { emitted: !!wiEmit, hostLog: wiEmit ?? null };
}

const summary = {};
summary.A = await scenarioA();
summary.C = await scenarioC();
summary.B = await scenarioB();
const d1 = await scenarioD(1);
const d5 = await scenarioD(5, { '断灵夜': '进行中' });
summary['D'] = d1.emitted;   // host consumer absent ⇔ emit reached the log-only dead end
console.log('\n===== summary =====');
console.log(`A: ${summary.A ? 'REPRODUCED' : 'not reproduced'}`);
console.log(`C: ${summary.C ? 'REPRODUCED' : 'not reproduced'}`);
console.log(`B: ${summary.B ? 'REPRODUCED' : 'not reproduced'}`);
console.log(`D: emit fired=${d1.emitted} → ${d1.hostLog ?? '(no emit)'}; arc-seeded run emitted=${d5.emitted}`);
