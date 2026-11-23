/**
 * CardAppHost(ctxHost.ts)楼层帧宿主单测 —— 移植 apps/mobile/tests/eventPump.test.ts
 * 的同源钉住项(web 侧 pump 是 CardAppHost.seed/pollChat 双泵而非独立类,
 * 行为契约一致):
 *   - seed 把信箱游标钉到头(滞留 refresh_message 不回放 —— 帧重挂不炸重铸环)
 *   - 头位拉取 since=MAX_SAFE_INTEGER;之后 tick 的 since 跟随最新头
 *   - getEventLog unsupported → 永久停拉(eventLogUnsupported)
 *   - 楼层帧授权子集 MSGFRAME:读+订阅+UI 动词在,写面不在(桥 denied 前置闸)
 * 跑法:node --test apps/web/tests/msgframe-host.test.mjs
 * (被测 .ts 走 Node>=22.6 type-stripping;client 全注入,零网络)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardAppHost } from '../src/cardapp/ctxHost.ts';
import { PANEL_METHODS_TH_MSGFRAME } from '@utopinn/protocol';

/** 忠实信箱模型:getEventLog 按 since 过滤 + 回当前头 seq(与服务端同语义)。 */
function fakeMailbox(entries = []) {
    const log = [...entries];
    return {
        log,
        head: () => (log.length ? log[log.length - 1].seq : 0),
        entries: (since) => log.filter((e) => e.seq > Number(since ?? 0)),
    };
}

/**
 * 最小 client 桩:CardAppHost 触点是 library.chatGet + th.call;
 * panelT0 影子写(eventOn → shadow)也落 th.call,一并记账。
 */
function makeHost({ chatDoc, mailbox, chatName = 'chat-1', onThEvent, log } = {}) {
    const pushes = [];
    const thCalls = [];
    const client = {
        library: {
            chatGet: async () =>
                chatDoc ?? { header: { chat_metadata: {} }, messages: [] },
        },
        th: {
            call: async (method, opts = {}) => {
                const args = opts.args ?? {};
                thCalls.push({ method, args });
                if (method === 'getEventLog' && mailbox) {
                    return {
                        ok: true,
                        result: { seq: mailbox.head(), entries: mailbox.entries(args.since) },
                    };
                }
                return { ok: true };
            },
        },
        // panelT0 legacy 触点 —— 本组用例不走到,防御性留桩。
        getChat: async () => ({ header: { chat_metadata: {} }, body: [] }),
        settingsGet: async () => ({}),
        stateGet: async () => ({}),
    };
    const host = new CardAppHost(
        {
            charDir: 'card.png',
            chatName,
            push: (event, payload) => pushes.push({ event, payload }),
            onThEvent,
            log: log ?? (() => { }),
        },
        /** @type {any} */(client),
    );
    return { host, pushes, thCalls };
}

test('seed 把信箱游标钉到头:滞留 refresh_message 不再回放(mobile 同修)', async () => {
    const host0 = [];
    // 挂载前信箱里已有一条 refresh_message —— 老实现 seq=0 回放 → 无限重铸环
    const box = fakeMailbox([
        { seq: 7, at: 0, event: 'refresh_message', args: [3] },
        { seq: 8, at: 0, event: 'generation_ended', args: [] },
    ]);
    const { host, pushes } = makeHost({ mailbox: box, onThEvent: (n, a) => host0.push({ n, a }) });
    await host.dispatch('th.eventOn', { event: 'refresh_message' });
    await host.dispatch('th.eventOn', { event: 'generation_ended' });
    await host.seed();
    await host.pollChat();
    assert.deepEqual(host0, []);                                       // 旁路不吃历史
    assert.deepEqual(pushes.filter((p) => p.event === 'th.event'), []); // 卡侧不吃历史
    // seed 之后新到的事件照常送达
    box.log.push({ seq: 9, at: 1, event: 'refresh_message', args: [3] });
    await host.pollChat();
    assert.deepEqual(host0, [{ n: 'refresh_message', a: [3] }]);
    assert.ok(pushes.some((p) => p.event === 'th.event' && p.payload?.name === 'refresh_message'));
});

test('seq 单调推进:seed 钉头后 since 跟随最新头', async () => {
    const box = fakeMailbox([{ seq: 40, at: 0, event: 'x', args: [] }]);
    const { host, thCalls } = makeHost({ mailbox: box });
    await host.seed();       // 头位拉取:since=MAX → 游标 40
    box.log.push({ seq: 42, at: 1, event: 'y', args: [] });
    await host.pollChat();   // since=40 → 游标 42
    box.log.push({ seq: 50, at: 2, event: 'z', args: [] });
    await host.pollChat();   // since=42 → 游标 50
    const gl = thCalls.filter((c) => c.method === 'getEventLog');
    assert.equal(gl[0].args.since, Number.MAX_SAFE_INTEGER);
    assert.equal(gl[1].args.since, 40);
    assert.equal(gl[2].args.since, 42);
});

test('getEventLog unsupported → 永久停拉(不再发 th.call)', async () => {
    const thCalls = [];
    const client = {
        library: { chatGet: async () => ({ header: {}, messages: [] }) },
        th: {
            call: async (method, opts = {}) => {
                thCalls.push({ method });
                return { ok: false, unsupported: true };
            },
        },
    };
    const host = new CardAppHost(
        { charDir: 'card.png', chatName: 'c', push: () => { }, log: () => { } },
        /** @type {any} */(client),
    );
    await host.seed();
    await host.pollChat();
    await host.pollChat();
    assert.equal(thCalls.filter((c) => c.method === 'getEventLog').length, 1);
});

test('seed 未竟时 pollChat 整轮 no-op(信箱抢跑竞态闸)', async () => {
    let releaseChat;
    let gateFirst = true;
    const chatGetCalls = [];
    const box = fakeMailbox([{ seq: 7, at: 0, event: 'refresh_message', args: [0] }]);
    const thCalls = [];
    const client = {
        library: {
            chatGet: async () => {
                chatGetCalls.push(1);
                // 只闸第一趟(seed 内那次)—— 后续 poll 的 chatGet 照常返回
                if (gateFirst) { gateFirst = false; await new Promise((r) => { releaseChat = r; }); }
                return { header: {}, messages: [] };
            },
        },
        th: {
            call: async (method, opts = {}) => {
                thCalls.push({ method, args: opts.args ?? {} });
                return { ok: true, result: { seq: box.head(), entries: box.entries(opts.args?.since) } };
            },
        },
    };
    const host = new CardAppHost(
        { charDir: 'card.png', chatName: 'c', push: () => { }, log: () => { } },
        /** @type {any} */(client),
    );
    const seedP = host.seed();          // 卡在 chatGet —— seed 未竟
    await host.pollChat();               // seeded=false → 整轮 no-op
    assert.equal(chatGetCalls.length, 1);                        // 只有 seed 自己那次
    assert.equal(thCalls.filter((c) => c.method === 'getEventLog').length, 0);
    releaseChat();
    await seedP;                          // seed 落地(seeded=true;内有一次钉头 getEventLog)
    await host.pollChat();               // 现在正常泵
    assert.equal(chatGetCalls.length, 2);
    const gl = thCalls.filter((c) => c.method === 'getEventLog');
    assert.equal(gl.length, 2);          // seed 钉头 + poll 拉新
    assert.equal(gl[0].args.since, Number.MAX_SAFE_INTEGER);
    // 钉过头:首轮 poll 的 since=7 而非 0 —— 滞留 refresh 没回放
    assert.equal(gl[1].args.since, 7);
});

test('chatName 缺席 → diff 泵停摆,seed 仍钉信箱游标', async () => {
    let fetched = 0;
    const box = fakeMailbox([{ seq: 5, at: 0, event: 'refresh_message', args: [0] }]);
    const client = {
        library: { chatGet: async () => { fetched++; return { messages: [] }; } },
        th: {
            call: async (method, opts = {}) => {
                if (method === 'getEventLog') {
                    return { ok: true, result: { seq: box.head(), entries: box.entries(opts.args?.since) } };
                }
                return { ok: true };
            },
        },
    };
    let host0 = 0;
    const host = new CardAppHost(
        { charDir: 'card.png', chatName: undefined, push: () => { }, onThEvent: () => { host0++; }, log: () => { } },
        /** @type {any} */(client),
    );
    await host.seed();
    assert.equal(fetched, 0);   // 无 chatName 不拉 chat doc
    // 滞留事件不回放(钉过头)—— pollChat 也不该再产出
    await host.pollChat();
    assert.equal(host0, 0);
});

test('MSGFRAME 授权子集:状态栏读面在,写面/生成/注入面不在', () => {
    const allow = new Set(PANEL_METHODS_TH_MSGFRAME);
    // TH 状态栏真实用到的读+订阅+UI 动词 —— 裁了它们楼层框就瞎
    for (const m of [
        'th.getVariables', 'th.getChatMessages', 'th.getLastMessageId',
        'th.getCurrentMessageId', 'th.getCharacter', 'th.getMvuData',
        'th.substituteMacros', 'th.formatAsDisplayedMessage', 'th.retrieveDisplayedMessage',
        'th.eventOn', 'th.eventOnce', 'th.eventRemoveListener',
        'th.eventEmit', 'th.eventEmitAndWait', 'th.waitGlobalInitialized',
    ]) {
        assert.ok(allow.has(m), `MSGFRAME 缺 ${m} —— 状态栏读面被误裁`);
    }
    // 写法不能白送模型产出 —— 全 TH 面的历史敞口正是这些
    for (const m of [
        'th.replaceVariables', 'th.insertOrAssignVariables', 'th.insertVariables',
        'th.updateVariablesWith', 'th.deleteVariable',
        'th.setChatMessages', 'th.setChatMessage', 'th.createChatMessages',
        'th.deleteChatMessages', 'th.rotateChatMessages',
        'th.triggerSlash', 'th.generate', 'th.generateRaw', 'th.stopGeneration',
        'th.injectPrompts', 'th.uninjectPrompts', 'th.initializeGlobal',
        'th.setLorebookEntries', 'th.createLorebook', 'th.deleteLorebook',
        'th.replaceTavernRegexes', 'th.replaceMvuData', 'th.getEventLog',
    ]) {
        assert.ok(!allow.has(m), `MSGFRAME 漏进写面 ${m}`);
    }
});
