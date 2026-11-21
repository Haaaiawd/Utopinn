// panel-shim runtime tests — run the IIFE in a vm sandbox with a fake
// window/postMessage env and verify transport marshaling + API semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const RUNTIME = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime.js'), 'utf8');

function makeEnv(bootstrap = {}) {
    const sent = [];
    const listeners = {};
    const win = {
        __UTOPINN_PANEL_NONCE__: 'nonce-1',
        __UTOPINN_PANEL_BOOTSTRAP__: { nonce: 'nonce-1', face: 'th', stateNamespaces: [], assets: {}, ...bootstrap },
        __utopinnPanelPost: (msg) => sent.push(msg),
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        console,
        setTimeout,
        Date,
        JSON,
        Promise,
        Object,
        Array,
        Error,
        Math,
        String,
        Number,
        Boolean,
    };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(RUNTIME, win);
    const lastRequest = () => sent[sent.length - 1];
    const respond = (requestId, result, ok = true) => {
        win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'response', nonce: 'nonce-1', requestId, ok, result });
    };
    return { win, sent, listeners, lastRequest, respond };
}

test('shim installs TavernHelper + bare globals + event constants', () => {
    const { win } = makeEnv();
    assert.equal(typeof win.TavernHelper, 'object');
    for (const name of ['getVariables', 'replaceVariables', 'insertOrAssignVariables', 'insertVariables',
        'updateVariablesWith', 'deleteVariable', 'eventOn', 'eventOnce', 'eventEmit', 'eventEmitAndWait',
        'eventRemoveListener', 'getChatMessages', 'getLastMessageId', 'getCurrentMessageId',
        'injectPrompts', 'uninjectPrompts', 'waitGlobalInitialized', 'initializeGlobal',
        'getCharacter', 'getCurrentCharacterName']) {
        assert.equal(typeof win[name], 'function', `missing bare global ${name}`);
    }
    assert.equal(win.tavern_events.MESSAGE_RECEIVED, 'message_received');
    assert.equal(win.iframe_events.GENERATION_ENDED, 'GENERATION_ENDED');
});

test('getVariables marshals scope args into a bridge request', async () => {
    const { win, lastRequest, respond } = makeEnv();
    const p = win.getVariables({ type: 'chat' });
    const req = lastRequest();
    assert.deepEqual(JSON.parse(JSON.stringify(req)),{channel:"utopinn-panel",direction:"request",nonce:"nonce-1",requestId:req.requestId,method:"th.getVariables",args:{type:"chat"}});
    respond(req.requestId, { hp: 10 });
    assert.deepEqual(JSON.parse(JSON.stringify(await p)),{hp:10});
});

test('updateVariablesWith evaluates updater locally then ships result', async () => {
    const { win, lastRequest, respond } = makeEnv();
    const p = win.updateVariablesWith((vars) => ({ ...vars, hp: vars.hp + 5 }), { type: 'chat' });
    respond(lastRequest().requestId, { hp: 10 }); // getVariables
    await new Promise(r => setTimeout(r, 0)); // flush chained request
    const req = lastRequest();
    assert.equal(req.method,"th.updateVariablesWith");
    assert.deepEqual(JSON.parse(JSON.stringify(req.args.result)),{hp:15});
    respond(req.requestId, null);
    await p;
});

test('eventOn registers locally + notifies host; pushed th.event dispatches', async () => {
    const { win, lastRequest, respond } = makeEnv();
    let got = null;
    win.eventOn('message_received', (a) => { got = a; });
    const req = lastRequest();
    assert.equal(req.method, 'th.eventOn');
    respond(req.requestId, { subscribed: 'message_received' });
    win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: 'message_received', args: [{ id: 3 }] } });
    assert.deepEqual(JSON.parse(JSON.stringify(got)),{id:3});
});

test('eventOnce fires once then unregisters', () => {
    const { win } = makeEnv();
    let count = 0;
    win.eventOnce('x', () => { count++; });
    const push = () => win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: 'x', args: [] } });
    push(); push();
    assert.equal(count, 1);
});

test('eventOn 上报 listener_id(realm 唯一形);makeFirst/makeLast 本地重排+上报', async () => {
    const { win, sent, respond } = makeEnv();
    const order = [];
    const f1 = () => order.push('f1');
    const f2 = () => order.push('f2');
    win.eventOn('e', f1);
    win.eventOn('e', f2);
    const reqs = sent.filter((m) => m.method === 'th.eventOn');
    assert.equal(reqs.length, 2);
    // realm 段 lid('l<seq>.<tag>')带上报,影子按 lid upsert 不撞
    assert.match(reqs[0].args.listener_id, /^l\d+\.[a-z0-9]+$/);
    assert.notEqual(reqs[0].args.listener_id, reqs[1].args.listener_id);
    respond(reqs[0].requestId, {}); respond(reqs[1].requestId, {});
    respond(sent[sent.length - 1].requestId, {});

    // makeFirst:f2 提到队首 → 下一个 push 先跑 f2
    win.eventMakeFirst('e', f2);
    const mf = sent[sent.length - 1];
    assert.equal(mf.method, 'th.eventMakeFirst');
    assert.equal(mf.args.listener_id, reqs[1].args.listener_id);
    respond(mf.requestId, {});
    win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: 'e', args: [] } });
    assert.deepEqual(order, ['f2', 'f1']);

    // makeLast:f2 回队尾
    win.eventMakeLast('e', f2);
    respond(sent[sent.length - 1].requestId, {});
    win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: 'e', args: [] } });
    assert.deepEqual(order, ['f2', 'f1', 'f1', 'f2']);
});

test('eventClearEvent / eventClearListener / eventClearAll 本地清+上报', async () => {
    const { win, sent, respond } = makeEnv();
    const hits = [];
    const fa = () => hits.push('a');
    const fb = () => hits.push('b');
    win.eventOn('e1', fa); win.eventOn('e2', fb); win.eventOn('e1', fb);
    sent.splice(0).forEach((m) => respond(m.requestId, {}));

    // clearEvent('e1') → e1 全清,e2 保留
    win.eventClearEvent('e1');
    let req = sent[sent.length - 1];
    assert.equal(req.method, 'th.eventClearEvent');
    assert.equal(req.args.event, 'e1');
    respond(req.requestId, {});
    for (const ev of ['e1', 'e2']) {
        win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: ev, args: [] } });
    }
    assert.deepEqual(hits, ['b']);

    // clearListener(fn) → 从所有事件摘 fn(跨事件 lid 集上报)
    hits.length = 0;
    win.eventOn('x1', fa); win.eventOn('x2', fa);
    sent.splice(0).forEach((m) => respond(m.requestId, {}));
    win.eventClearListener(fa);
    req = sent[sent.length - 1];
    assert.equal(req.method, 'th.eventClearListener');
    assert.equal(req.args.listener_ids.length, 2);
    respond(req.requestId, {});
    win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: 'x1', args: [] } });
    win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: 'e2', args: [] } });
    assert.deepEqual(hits, ['b'], 'fa 全摘,fb 的 e2 仍在');

    // clearAll → 全清
    hits.length = 0;
    win.eventClearAll();
    req = sent[sent.length - 1];
    assert.equal(req.method, 'th.eventClearAll');
    respond(req.requestId, {});
    win.__utopinnPanelReceive({ channel: 'utopinn-panel', direction: 'push', nonce: 'n', event: 'th.event', payload: { name: 'e2', args: [] } });
    assert.deepEqual(hits, []);
});

test('eventEmit dispatches locally AND notifies host', async () => {
    const { win, lastRequest, respond } = makeEnv();
    let local = null;
    win.eventOn('ping', (v) => { local = v; });
    respond(lastRequest().requestId, {});
    const p = win.eventEmit('ping', 42);
    const req = lastRequest();
    assert.equal(req.method, 'th.eventEmit');
    assert.deepEqual(JSON.parse(JSON.stringify(req.args)),{event:"ping",args:[42]});
    assert.equal(local, 42);
    respond(req.requestId, null);
    await p;
});

test('waitGlobalInitialized resolves when global appears in-window', async () => {
    const { win } = makeEnv();
    const p = win.waitGlobalInitialized('LateCardLib');
    win.LateCardLib = { marker: true };
    const g = await p;
    assert.equal(g.marker, true);
});

test('window.Mvu namespace ships getMvuData/replaceMvuData + event constant', async () => {
    const { win } = makeEnv();
    assert.equal(typeof win.Mvu?.getMvuData, 'function');
    assert.equal(typeof win.Mvu?.replaceMvuData, 'function');
    assert.equal(win.Mvu?.events?.VARIABLE_UPDATE_ENDED, 'mvu_variable_update_ended');
});

test('getCurrentMessageId uses bootstrap messageId without a round-trip', async () => {
    const { win, sent } = makeEnv({ messageId: 0 });
    assert.equal(await win.getCurrentMessageId(), 0);
    assert.equal(sent.length, 0);
});

test('responses reject on ok:false', async () => {
    const { win, lastRequest, respond } = makeEnv();
    const p = win.getVariables({});
    respond(lastRequest().requestId, undefined, false);
    await assert.rejects(p);
});
