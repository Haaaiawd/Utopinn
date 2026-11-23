// PanelEventPump 单元回归 —— 纯逻辑模块,IO 全注入(node --test 直跑,
// Node ≥22.18 原生 TS 剥离;@utopinn/protocol 只进 type 位,运行期零解析)。
// 钉住的行为:
//   - eventOn/Once → 订阅簿记;信箱条目按订阅过滤后才进 push
//   - origin=hostId 的信箱条目被跳过(自己的 eventEmit 不回声)
//   - trackOutbound 给 eventEmit 注入 origin;ClearEvent/ClearAll 捎 lids
//   - chat diff:追加楼层 → rendered+received/sent;swipe_id 变 → swiped;
//     mes 变 → edited+updated;任何差 → chat_changed + 'chat.updated'
//   - getEventLog unsupported → 停拉;seq 单调不回退
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelEventPump, type PanelEventPumpDeps } from '../src/panels/eventPump.ts';

interface PushRec { event: string; payload?: Record<string, unknown> }

function makeDeps(over: Partial<PanelEventPumpDeps> = {}) {
    const pushes: PushRec[] = [];
    const thCalls: { method: string; args: Record<string, unknown> }[] = [];
    const inner = over.thCall;
    const deps: PanelEventPumpDeps = {
        charDir: 'card.png',
        chatName: 'chat-1',
        push: (event, payload) => pushes.push({ event, payload }),
        thCall: async () => ({ ok: true }),
        fetchChat: async () => ({ messages: [] }),
        ...over,
    };
    // 覆盖也走记录面 —— thCalls 是所有调用(含自定义实现)的账本。
    deps.thCall = async (method, args) => {
        thCalls.push({ method, args });
        return inner ? inner(method, args) : { ok: true, result: { seq: 0, entries: [] } };
    };
    return { deps, pushes, thCalls };
}

test('seed 建立 diff 基线,不回放历史楼层', async () => {
    const { deps, pushes } = makeDeps({
        fetchChat: async () => ({ messages: [{ mes: 'old', is_user: false }] }),
    });
    const pump = new PanelEventPump(deps);
    await pump.seed();
    await pump.tick(); // 同一份 doc —— 不该有事件
    assert.deepEqual(pushes, []);
});

test('追加楼层 → rendered + received + chat_changed + chat.updated(订阅后)', async () => {
    const { deps, pushes } = makeDeps({
        fetchChat: async () => ({ messages: [] }),
    });
    const pump = new PanelEventPump(deps);
    pump.trackOutbound('th.eventOn', { event: 'message_received' });
    pump.trackOutbound('th.eventOn', { event: 'char_message_rendered' });
    pump.trackOutbound('th.eventOn', { event: 'chat_changed' });
    await pump.seed();
    deps.fetchChat = async () => ({ messages: [{ mes: 'hi', is_user: false }] });
    await pump.tick();
    const thEvents = pushes.filter((p) => p.event === 'th.event').map((p) => p.payload?.name);
    assert.deepEqual(thEvents, ['char_message_rendered', 'message_received', 'chat_changed']);
    assert.ok(pushes.some((p) => p.event === 'chat.updated'));
});

test('未订阅的事件不进 push(订阅过滤)', async () => {
    const { deps, pushes } = makeDeps({ fetchChat: async () => ({ messages: [] }) });
    const pump = new PanelEventPump(deps);
    // 只订 message_sent,追加的是 assistant 楼 → 不推任何 th.event
    pump.trackOutbound('th.eventOn', { event: 'message_sent' });
    await pump.seed();
    deps.fetchChat = async () => ({ messages: [{ mes: 'hi' }] });
    await pump.tick();
    assert.deepEqual(pushes.filter((p) => p.event === 'th.event'), []);
    // chat.updated 是裸 push(不走订阅面)—— 仍然要发
    assert.ok(pushes.some((p) => p.event === 'chat.updated'));
});

test('swipe_id 变 → message_swiped;mes 变 → edited+updated', async () => {
    let doc: unknown[] = [{ mes: 'a', swipes: ['a', 'b'], swipe_id: 0 }];
    const { deps, pushes } = makeDeps({ fetchChat: async () => ({ messages: doc }) });
    const pump = new PanelEventPump(deps);
    for (const ev of ['message_swiped', 'message_edited', 'message_updated']) {
        pump.trackOutbound('th.eventOn', { event: ev });
    }
    await pump.seed();
    doc = [{ mes: 'a', swipes: ['a', 'b'], swipe_id: 1 }];
    await pump.tick();
    const names = pushes.filter((p) => p.event === 'th.event').map((p) => p.payload?.name);
    assert.ok(names.includes('message_swiped'));
    doc = [{ mes: 'a2', swipes: ['a', 'b'], swipe_id: 1 }];
    pushes.length = 0;
    await pump.tick();
    const names2 = pushes.filter((p) => p.event === 'th.event').map((p) => p.payload?.name);
    assert.ok(names2.includes('message_edited'));
    assert.ok(names2.includes('message_updated'));
});

test('信箱:订阅事件推卡;origin=hostId 的条目被跳过', async () => {
    const { deps, pushes } = makeDeps({
        thCall: async () => ({
            ok: true,
            result: {
                seq: 3,
                entries: [
                    { seq: 1, at: 0, event: 'generation_ended', args: [9] },
                    { seq: 2, at: 0, event: 'echo', args: [], origin: 'WILL-SKIP' },
                    { seq: 3, at: 0, event: 'unsubscribed_thing', args: [] },
                ],
            },
        }),
    });
    const pump = new PanelEventPump(deps);
    const selfOrigin = pump.hostId;
    // 把第 2 条的 origin 伪造成本 mount —— 模拟自己 eventEmit 的回声
    deps.thCall = async () => ({
        ok: true,
        result: {
            seq: 3,
            entries: [
                { seq: 1, at: 0, event: 'generation_ended', args: [9] },
                { seq: 2, at: 0, event: 'echo', args: [], origin: selfOrigin },
                { seq: 3, at: 0, event: 'unsubscribed_thing', args: [] },
            ],
        },
    });
    pump.trackOutbound('th.eventOn', { event: 'generation_ended' });
    pump.trackOutbound('th.eventOn', { event: 'echo' });
    pump.trackOutbound('th.eventOn', { event: 'unsubscribed_thing' });
    await pump.seed();
    await pump.tick();
    const names = pushes.filter((p) => p.event === 'th.event').map((p) => p.payload?.name);
    assert.deepEqual(names, ['generation_ended', 'unsubscribed_thing']);
    assert.ok(!names.includes('echo'));
});

test('信箱旁路 onThEvent 不经订阅面也收到事件', async () => {
    const host: { name: string; args: unknown[] }[] = [];
    const { deps } = makeDeps({
        onThEvent: (name, args) => host.push({ name, args }),
        thCall: async () => ({
            ok: true,
            result: { seq: 1, entries: [{ seq: 1, at: 0, event: 'refresh_message', args: [4] }] },
        }),
    });
    const pump = new PanelEventPump(deps);
    // 故意不订阅 refresh_message —— 旁路仍该收到
    await pump.seed();
    await pump.tick();
    assert.deepEqual(host, [{ name: 'refresh_message', args: [4] }]);
});

test('getEventLog unsupported → 永久停拉(不再发 thCall)', async () => {
    const { deps, thCalls } = makeDeps({
        thCall: async () => ({ ok: false, unsupported: true }),
    });
    const pump = new PanelEventPump(deps);
    await pump.seed();
    await pump.tick();
    await pump.tick();
    assert.equal(thCalls.filter((c) => c.method === 'getEventLog').length, 1);
});

test('seq 单调推进:since 用上次最大 seq', async () => {
    const { deps, thCalls } = makeDeps({
        thCall: async (_m, args) => ({ ok: true, result: { seq: Number(args.since) + 5, entries: [] } }),
    });
    const pump = new PanelEventPump(deps);
    await pump.tick();
    await pump.tick();
    assert.equal(thCalls[0]!.args.since, 0);
    assert.equal(thCalls[1]!.args.since, 5);
});

test('trackOutbound:eventEmit 注入 origin;ClearEvent 捎上已知 lids', () => {
    const { deps } = makeDeps();
    const pump = new PanelEventPump(deps);
    pump.trackOutbound('th.eventOn', { event: 'tick', listener_id: 'l1' });
    pump.trackOutbound('th.eventOnce', { event: 'tick', listener_id: 'l2' });
    assert.deepEqual(pump.subscribedEvents(), ['tick']);
    const emitted = pump.trackOutbound('th.eventEmit', { event: 'tick', args: [1], origin: 'spoofed' });
    assert.equal(emitted.origin, pump.hostId);
    const cleared = pump.trackOutbound('th.eventClearEvent', { event: 'tick' });
    assert.deepEqual((cleared.listener_ids as string[]).sort(), ['l1', 'l2']);
    assert.deepEqual(pump.subscribedEvents(), []);
});

test('eventRemoveListener 按 lid 摘;无 lid 按 event 摘', () => {
    const { deps } = makeDeps();
    const pump = new PanelEventPump(deps);
    pump.trackOutbound('th.eventOn', { event: 'a', listener_id: 'l1' });
    pump.trackOutbound('th.eventOn', { event: 'b', listener_id: 'l2' });
    pump.trackOutbound('th.eventRemoveListener', { listener_id: 'l1' });
    assert.deepEqual(pump.subscribedEvents(), ['b']);
    pump.trackOutbound('th.eventRemoveListener', { event: 'b' });
    assert.deepEqual(pump.subscribedEvents(), []);
});

test('chatName 缺席 → diff 泵停摆,信箱仍拉', async () => {
    const { deps, pushes, thCalls } = makeDeps({ chatName: undefined });
    let fetched = 0;
    deps.fetchChat = async () => { fetched++; return { messages: [] }; };
    const pump = new PanelEventPump(deps);
    await pump.seed();
    await pump.tick();
    assert.equal(fetched, 0);
    assert.equal(thCalls.filter((c) => c.method === 'getEventLog').length, 1);
    assert.deepEqual(pushes, []);
});

test('dispose 后 tick 不再发请求', async () => {
    const { deps, thCalls } = makeDeps();
    const pump = new PanelEventPump(deps);
    pump.dispose();
    await pump.tick();
    assert.equal(thCalls.length, 0);
});
