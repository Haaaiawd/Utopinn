// PanelEventPump 单元回归 —— 纯逻辑模块,IO 全注入(node --test 直跑,
// Node ≥22.18 原生 TS 剥离;@utopinn/protocol 只进 type 位,运行期零解析)。
// 钉住的行为:
//   - eventOn/Once → 订阅簿记;信箱条目按订阅过滤后才进 push
//   - origin=hostId 的信箱条目被跳过(自己的 eventEmit 不回声)
//   - trackOutbound 给 eventEmit 注入 origin;ClearEvent/ClearAll 捎 lids
//   - chat diff:追加楼层 → rendered+received/sent;swipe_id 变 → swiped;
//     mes 变 → edited+updated;任何差 → chat_changed + 'chat.updated'
//   - getEventLog unsupported → 停拉;seq 单调不回退
//   - seed 把信箱游标钉到头(不回放历史 —— refresh_message 滞留不炸重铸)
//   - mutation 事件/diff dirty → onChatChanged(读者坐标同步,含自产 origin)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelEventPump, type PanelEventPumpDeps } from '../src/panels/eventPump.ts';

interface PushRec { event: string; payload?: Record<string, unknown> }
interface LogEntry { seq: number; at: number; event: string; args?: unknown[]; origin?: string }

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

/** 忠实信箱模型:getEventLog 按 since 过滤 + 回当前头 seq。 */
function fakeMailbox(entries: LogEntry[] = []) {
    const log: LogEntry[] = [...entries];
    return {
        log,
        thCall: async (_m: string, args: Record<string, unknown>) => ({
            ok: true,
            result: {
                seq: log.length ? log[log.length - 1]!.seq : 0,
                entries: log.filter((e) => e.seq > Number(args.since ?? 0)),
            },
        }),
    };
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

test('seed 把信箱游标钉到头:滞留 refresh_message 不再回放(reviewer 返修)', async () => {
    const host: { name: string; args: unknown[] }[] = [];
    // 挂载前信箱里已有一条 refresh_message —— 老实现 seq=0 回放 → 无限重铸环
    const box = fakeMailbox([
        { seq: 7, at: 0, event: 'refresh_message', args: [3] },
        { seq: 8, at: 0, event: 'generation_ended', args: [] },
    ]);
    const { deps, pushes } = makeDeps({
        onThEvent: (name, args) => host.push({ name, args }),
        thCall: box.thCall,
    });
    const pump = new PanelEventPump(deps);
    pump.trackOutbound('th.eventOn', { event: 'refresh_message' });
    pump.trackOutbound('th.eventOn', { event: 'generation_ended' });
    await pump.seed();
    await pump.tick();
    assert.deepEqual(host, []);                                    // 旁路不吃历史
    assert.deepEqual(pushes.filter((p) => p.event === 'th.event'), []); // 卡侧不吃历史
    // seed 之后新到的事件照常送达
    box.log.push({ seq: 9, at: 1, event: 'refresh_message', args: [3] });
    await pump.tick();
    assert.deepEqual(host, [{ name: 'refresh_message', args: [3] }]);
});

test('信箱:订阅事件推卡;origin=hostId 的条目被跳过', async () => {
    const box = fakeMailbox();
    const { deps, pushes } = makeDeps({ thCall: box.thCall });
    const pump = new PanelEventPump(deps);
    pump.trackOutbound('th.eventOn', { event: 'generation_ended' });
    pump.trackOutbound('th.eventOn', { event: 'echo' });
    pump.trackOutbound('th.eventOn', { event: 'unsubscribed_thing' });
    await pump.seed();
    box.log.push(
        { seq: 1, at: 0, event: 'generation_ended', args: [9] },
        { seq: 2, at: 0, event: 'echo', args: [], origin: pump.hostId },
        { seq: 3, at: 0, event: 'unsubscribed_thing', args: [] },
    );
    await pump.tick();
    const names = pushes.filter((p) => p.event === 'th.event').map((p) => p.payload?.name);
    assert.deepEqual(names, ['generation_ended', 'unsubscribed_thing']);
    assert.ok(!names.includes('echo'));
});

test('信箱旁路 onThEvent 不经订阅面也收到事件', async () => {
    const host: { name: string; args: unknown[] }[] = [];
    const box = fakeMailbox();
    const { deps } = makeDeps({
        onThEvent: (name, args) => host.push({ name, args }),
        thCall: box.thCall,
    });
    const pump = new PanelEventPump(deps);
    await pump.seed();
    box.log.push({ seq: 1, at: 0, event: 'refresh_message', args: [4] });
    await pump.tick();
    assert.deepEqual(host, [{ name: 'refresh_message', args: [4] }]);
});

test('mutation 信箱事件 → onChatChanged(含本 mount 自产 origin)', async () => {
    const box = fakeMailbox();
    let changed = 0;
    const { deps } = makeDeps({ thCall: box.thCall, onChatChanged: () => changed++ });
    const pump = new PanelEventPump(deps);
    await pump.seed();
    box.log.push(
        { seq: 1, at: 0, event: 'chat_changed', args: [] },
        // 自己的写也通知 —— 读者缓存同样过期,origin 去重只管卡侧回声
        { seq: 2, at: 0, event: 'message_deleted', args: [5], origin: pump.hostId },
        { seq: 3, at: 0, event: 'totally_unrelated', args: [] },
    );
    await pump.tick();
    assert.equal(changed, 2);
});

test('diff dirty → onChatChanged(帧写面/他端写 → 读者重对坐标)', async () => {
    const { deps } = makeDeps({ fetchChat: async () => ({ messages: [] }) });
    let changed = 0;
    deps.onChatChanged = () => changed++;
    const pump = new PanelEventPump(deps);
    await pump.seed();
    deps.fetchChat = async () => ({ messages: [{ mes: 'x' }] });
    await pump.tick();
    assert.equal(changed, 1);
    await pump.tick(); // doc 不再变 → 不重复通知
    assert.equal(changed, 1);
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

test('seq 单调推进:seed 钉头后,since 跟随最新头', async () => {
    let head = 40;
    const { deps, thCalls } = makeDeps({
        thCall: async () => ({ ok: true, result: { seq: head, entries: [] } }),
    });
    const pump = new PanelEventPump(deps);
    await pump.seed();            // 头位拉取:since=MAX → 游标 40
    head = 42;
    await pump.tick();            // since=40 → 游标 42
    head = 50;
    await pump.tick();            // since=42 → 游标 50
    assert.equal(thCalls[0]!.args.since, Number.MAX_SAFE_INTEGER);
    assert.equal(thCalls[1]!.args.since, 40);
    assert.equal(thCalls[2]!.args.since, 42);
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

test('chatName 缺席 → diff 泵停摆,信箱仍拉(seed 也钉游标)', async () => {
    const { deps, pushes, thCalls } = makeDeps({ chatName: undefined });
    let fetched = 0;
    deps.fetchChat = async () => { fetched++; return { messages: [] }; };
    const pump = new PanelEventPump(deps);
    await pump.seed();
    await pump.tick();
    assert.equal(fetched, 0);
    assert.equal(thCalls.filter((c) => c.method === 'getEventLog').length, 2); // seed 头位 + tick
    assert.deepEqual(pushes, []);
});

test('seed 未竟时 tick 整轮 no-op(信箱抢跑竞态闸,web 同修)', async () => {
    let releaseChat: (() => void) | undefined;
    let gateFirst = true;
    const box = fakeMailbox([{ seq: 7, at: 0, event: 'refresh_message', args: [0] }]);
    let fetched = 0;
    const { deps, thCalls } = makeDeps({
        fetchChat: async () => {
            fetched++;
            // 只闸第一趟(seed 内那次)—— 后续 tick 的 fetchChat 照常返回
            if (gateFirst) { gateFirst = false; await new Promise<void>((r) => { releaseChat = r; }); }
            return { messages: [] };
        },
        thCall: box.thCall,
    });
    const pump = new PanelEventPump(deps);
    const seedP = pump.seed();           // 卡在 fetchChat —— seed 未竟
    await pump.tick();                    // seeded=false → 整轮 no-op
    assert.equal(fetched, 1);             // 只有 seed 自己那次
    assert.equal(thCalls.filter((c) => c.method === 'getEventLog').length, 0);
    releaseChat!();
    await seedP;
    await pump.tick();                    // 现在正常泵(since=钉过的头位)
    assert.equal(fetched, 2);
    const gl = thCalls.filter((c) => c.method === 'getEventLog');
    assert.equal(gl.length, 2);
    assert.equal(gl[0]!.args.since, Number.MAX_SAFE_INTEGER);
    assert.equal(gl[1]!.args.since, 7);
});

test('自源 refresh_message:onThEvent 收(宿主重铸恰好一次)但 emitTh 不回声', async () => {
    const host: { name: string; args: unknown[] }[] = [];
    const box = fakeMailbox();
    const { deps, pushes } = makeDeps({
        onThEvent: (name, args) => host.push({ name, args }),
        thCall: box.thCall,
    });
    const pump = new PanelEventPump(deps);
    pump.trackOutbound('th.eventOn', { event: 'refresh_message' });
    await pump.seed();
    // 帧脚本 refreshOneMessage(mid) 的真实产物:trackOutbound 给
    // eventEmit 注 origin=hostId —— 信箱条目带本 mount 去重标
    const emitted = pump.trackOutbound('th.eventEmit', { event: 'refresh_message', args: [3] });
    box.log.push({ seq: 1, at: 0, event: 'refresh_message', args: [3], origin: emitted.origin as string });
    await pump.tick();
    // 宿主旁路收到自源条目 —— origin 去重不挡 host 重铸这半路
    assert.deepEqual(host, [{ name: 'refresh_message', args: [3] }]);
    // 卡侧无回声 —— 订阅了也不推(发起帧 dispatchLocal 已响过)
    assert.deepEqual(pushes.filter((p) => p.event === 'th.event'), []);
    await pump.tick();
    assert.equal(host.length, 1);   // 游标已走,重铸恰好一次
});

test('dispose 后 tick 不再发请求', async () => {
    const { deps, thCalls } = makeDeps();
    const pump = new PanelEventPump(deps);
    pump.dispose();
    await pump.tick();
    assert.equal(thCalls.length, 0);
});
