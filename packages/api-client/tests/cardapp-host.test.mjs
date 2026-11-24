// CardAppHost(cardapp-host.ts)dispatch 路由 + 泵语义单测 —— 共享宿主落地
// @utopinn/api-client 后,web/RN 两端同一份实现,路由钉一次管两端:
//   - ctx.* → ctxDispatch 表(getChat/sendMessage/setVariable/editMessage/
//     chat_state/世界书/slash/prompt/surface/on-off/dispose)
//   - th.*  → T0 表 panelT0 本地求值;表外 → th/call 透传
//   - 表外任意方法 → unsupported_method(桥 allowlist 是前置闸,这里是兜底)
//   - 泵:楼层 diff → 订阅过滤的 th.event/host.event + chat.updated +
//     onChatChanged;信箱 mutation 事件含自源 → onChatChanged;自源条目
//     不回声给卡侧 listener;swipe 对象槽({mes})同内容 → 不误报 edited
// 跑法:node --test packages/api-client/tests/cardapp-host.test.mjs
// (client 全桩,零网络;dist 需先 build —— pnpm --filter @utopinn/api-client build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { CardAppHost } = await import(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js'));

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
 * CardAppHost 最小 client 桩:library.* / state.* / th.call / generation.* /
 * 以及 panel-t0 的 legacy 触点(getChat/settingsGet/settingsPatch)。
 * calls 账本按域分组,路由断言直接点名。
 */
function makeHost({ chatDoc, chatDocs, mailbox, chatName = 'chat-1', onThEvent, onChatChanged, surface } = {}) {
    const pushes = [];
    const calls = { th: [], lib: [], state: [], gen: [], legacy: [] };
    const docs = chatDocs ?? [chatDoc ?? { header: { chat_metadata: {} }, messages: [] }];
    let docIdx = 0;
    const client = {
        library: {
            // chatDocs 序列桩:每拍取下一帧到底钉住;深拷贝出参 —— 真 fetch
            // 每次新 parse,引用不复用(swipe 对象槽误报用例靠这个才测得到)。
            chatGet: async () => { calls.lib.push(['chatGet']); return JSON.parse(JSON.stringify(docs[Math.min(docIdx++, docs.length - 1)])); },
            appendMessages: async (d, c, msgs) => { calls.lib.push(['appendMessages', msgs]); return { ok: true }; },
            patchChat: async (d, c, ops) => { calls.lib.push(['patchChat', ops]); return { ok: true }; },
            settings: async () => { calls.lib.push(['settings']); return {}; },
            char: async () => { calls.lib.push(['char']); return { data: { extensions: {} } }; },
            worldGet: async (n) => { calls.lib.push(['worldGet', n]); return { entries: {} }; },
            worldEdit: async (n, d2) => { calls.lib.push(['worldEdit', n]); return { ok: true }; },
        },
        state: {
            chat: {
                get: async (t, ns) => { calls.state.push(['chat.get', t, ns]); return { data: { hp: 1 } }; },
                patch: async (t, ns, ops) => { calls.state.push(['chat.patch', t, ns, ops]); return { ok: true }; },
                delete: async (t, ns) => { calls.state.push(['chat.delete', t, ns]); return { ok: true }; },
            },
            char: {
                get: async (t, ns) => { calls.state.push(['char.get', t, ns]); return { data: {} }; },
                set: async (t, ns, v) => { calls.state.push(['char.set', t, ns, v]); return { ok: true }; },
            },
        },
        th: {
            call: async (method, opts = {}) => {
                const args = opts.args ?? {};
                calls.th.push([method, args]);
                if (method === 'getEventLog' && mailbox) {
                    return { ok: true, result: { seq: mailbox.head(), entries: mailbox.entries(args.since) } };
                }
                if (method === 'getCharacter') return { ok: true, result: { name: 'C' } };
                if (method === 'triggerSlash') return { ok: true, result: { echoed: true } };
                return { ok: true };
            },
        },
        generation: {
            generate: async (body) => { calls.gen.push(['generate', body]); return { jobId: body?.luker_generation?.job_id ?? 'j' }; },
            jobGet: async (id) => { calls.gen.push(['jobGet', id]); return { status: 'completed', text: 'done' }; },
        },
        // panel-t0 legacy 触点
        getChat: async () => { calls.legacy.push(['getChat']); return { header: { chat_metadata: { variables: { hp: 7 } } }, body: [] }; },
        settingsGet: async () => { calls.legacy.push(['settingsGet']); return {}; },
        settingsPatch: async (ops) => { calls.legacy.push(['settingsPatch', ops]); return {}; },
        patchChat: async () => { calls.legacy.push(['patchChat']); return {}; },
        patchChatMetadata: async () => { calls.legacy.push(['patchChatMetadata']); return {}; },
        stateGet: async () => ({}),
        statePatch: async () => ({}),
    };
    const host = new CardAppHost(
        {
            charDir: 'card.png',
            chatName,
            push: (event, payload) => pushes.push({ event, payload }),
            onThEvent,
            onChatChanged,
            surface,
            log: () => { },
            generationWaitMs: 2000,
        },
        /** @type {any} */(client),
    );
    return { host, pushes, calls };
}

// ─── ctx dispatch 路由 ───────────────────────────────────────────────────

test('ctx.getChat → library.chatGet,回 {messages,header}', async () => {
    const { host, calls } = makeHost({
        chatDoc: { header: { chat_metadata: { variables: { a: 1 } } }, messages: [{ mes: 'hi' }] },
    });
    const r = await host.dispatch('ctx.getChat', {});
    assert.equal(calls.lib[0][0], 'chatGet');
    assert.equal(r.messages.length, 1);
    assert.equal(r.header.chat_metadata.variables.a, 1);
});

test('ctx.setVariable → patchChat chat_metadata.variables.<key>', async () => {
    const { host, calls } = makeHost();
    await host.seed();
    await host.dispatch('ctx.setVariable', { key: 'hp', value: 42 });
    const patch = calls.lib.find(c => c[0] === 'patchChat');
    assert.ok(patch, 'patchChat not called');
    assert.equal(patch[1][0].path, '/header/chat_metadata/variables/hp');
    assert.equal(patch[1][0].value, 42);
});

test('ctx.sendMessage 非 silent → appendMessages + 生成 job 轮询', async () => {
    const { host, calls } = makeHost();
    await host.seed();
    const r = await host.dispatch('ctx.sendMessage', { text: 'hello' });
    assert.ok(calls.lib.some(c => c[0] === 'appendMessages'));
    assert.ok(calls.gen.some(c => c[0] === 'generate'));
    assert.equal(r.ok, true);
});

test('ctx.sendMessage silent → quiet 链不落楼层(不 append)', async () => {
    const { host, calls } = makeHost();
    await host.seed();
    const r = await host.dispatch('ctx.sendMessage', { text: 'q', options: { silent: true } });
    assert.equal(calls.lib.some(c => c[0] === 'appendMessages'), false);
    const gen = calls.gen.find(c => c[0] === 'generate');
    assert.equal(gen[1].type, 'quiet');
    assert.equal(gen[1].overrides.quietPrompt, 'q');
    assert.equal(r.ok, true);
});

test('ctx.editMessage → patchChat /body/<i>/mes(+活动 swipe 槽)', async () => {
    const { host, calls } = makeHost({
        chatDoc: {
            header: { chat_metadata: {} },
            messages: [{ mes: 'v0', swipes: ['a', 'b'], swipe_id: 1 }],
        },
    });
    await host.seed();
    const r = await host.dispatch('ctx.editMessage', { messageId: 0, text: 'v1' });
    const patch = calls.lib.find(c => c[0] === 'patchChat');
    const paths = patch[1].map(o => o.path);
    assert.ok(paths.includes('/body/0/mes'));
    assert.ok(paths.includes('/body/0/swipes/1'));
    assert.equal(r.edited, true);
});

test('ctx.getChatState/updateChatState → state.chat.* 正确转发', async () => {
    const { host, calls } = makeHost();
    const g = await host.dispatch('ctx.getChatState', { namespace: 'app' });
    assert.deepEqual(calls.state[0][1], { avatar_url: 'card.png.png', file_name: 'chat-1.jsonl' });
    assert.equal(g.state.hp, 1);
    const u = await host.dispatch('ctx.updateChatState', { namespace: 'app', operations: [{ op: 'replace', path: '/hp', value: 2 }] });
    assert.equal(u.ok, true);
    assert.equal(calls.state[1][0], 'chat.patch');
});

test('ctx.getCharacter → th.call getCharacter', async () => {
    const { host, calls } = makeHost();
    const r = await host.dispatch('ctx.getCharacter', {});
    assert.deepEqual(calls.th[0][0], 'getCharacter');
    assert.equal(r.name, 'C');
});

test('ctx.executeSlashCommand → th.call triggerSlash', async () => {
    const { host, calls } = makeHost();
    const r = await host.dispatch('ctx.executeSlashCommand', { script: '/echo hi' });
    const c = calls.th.find(x => x[0] === 'triggerSlash');
    assert.equal(c[1].script, '/echo hi');
    assert.deepEqual(r, { echoed: true });
});

test('ctx.setExtensionPrompt → settingsGet + settingsPatch(extension_prompts)', async () => {
    const { host, calls } = makeHost();
    await host.dispatch('ctx.setExtensionPrompt', { key: 'k', value: 'v', position: 1 });
    const sp = calls.legacy.find(c => c[0] === 'settingsPatch');
    assert.ok(sp, 'settingsPatch not called');
    const paths = sp[1].map(o => o.path);
    assert.ok(paths.some(p => p.startsWith('/extension_prompts')));
});

test('ctx.on → host.event 只推订阅过的事件', async () => {
    const { host, pushes, calls } = makeHost();
    await host.dispatch('ctx.on', { event: 'generation_started' });
    await host.dispatch('ctx.regenerate', {});
    const hostEvents = pushes.filter(p => p.event === 'host.event').map(p => p.payload.name);
    assert.ok(hostEvents.includes('generation_started'));
    // 未订阅的不推(generation_ended 泵发过,但订阅集里没有)
    assert.ok(!hostEvents.includes('generation_ended'));
    void calls;
});

test('ctx 表外方法 → unsupported_method', async () => {
    const { host } = makeHost();
    await assert.rejects(() => host.dispatch('ctx.teleport', {}), /unsupported_method: ctx\.teleport/);
    await assert.rejects(() => host.dispatch('magic.wand', {}), /unsupported_method/);
});

// ─── th dispatch 路由 ────────────────────────────────────────────────────

test('th T0(th.getVariables)→ panelT0 本地(legacy getChat),不走 th/call method 面', async () => {
    const { host, calls } = makeHost();
    const r = await host.dispatch('th.getVariables', { type: 'chat' });
    assert.equal(r.hp, 7);
    assert.ok(calls.legacy.some(c => c[0] === 'getChat'));
    assert.equal(calls.th.filter(c => c[0] === 'getVariables').length, 0);
});

test('th 表外(th.generate)→ th/call 透传', async () => {
    const { host, calls } = makeHost();
    await host.dispatch('th.generate', { user_input: 'x' });
    const c = calls.th.find(x => x[0] === 'generate');
    assert.ok(c, 'generate not forwarded');
    assert.equal(c[1].user_input, 'x');
});

// ─── 泵:diff → push + onChatChanged;信箱 mutation → onChatChanged ────────

test('楼层追加 diff → chat.updated push + onChatChanged + 订阅事件随行', async () => {
    const docs = [
        { header: { chat_metadata: {} }, messages: [{ mes: 'a', is_user: false }] },
        { header: { chat_metadata: {} }, messages: [{ mes: 'a', is_user: false }, { mes: 'b', is_user: false }] },
    ];
    let dirty = 0;
    const { host, pushes } = makeHost({ chatDocs: docs, onChatChanged: () => dirty++ });
    // 先订阅再 seed:eventOn 进 panelT0 注册表,追加命中才推 th.event。
    await host.dispatch('th.eventOn', { event: 'char_message_rendered', listener_id: 'L1' });
    await host.dispatch('ctx.on', { event: 'char_message_rendered' });
    await host.seed();          // 基线 = docs[0](第 1 帧)
    await host.pollChat();       // docs[1] —— 追加一层非 user 楼
    assert.ok(dirty >= 1);
    assert.ok(pushes.some(p => p.event === 'chat.updated'));
    assert.ok(pushes.some(p => p.event === 'th.event' && p.payload.name === 'char_message_rendered'));
    assert.ok(pushes.some(p => p.event === 'host.event' && p.payload.name === 'char_message_rendered'));
});

test('信箱 mutation 事件(含自源)→ onChatChanged;自源不回声 th.event', async () => {
    const seen = [];
    const mb = fakeMailbox();
    const { host, calls, pushes } = makeHost({ mailbox: mb, onChatChanged: () => seen.push('dirty') });
    await host.seed();
    // recordThEvent 一次,把 hostId 从信箱写的 origin 里钓出来。
    await host.dispatch('th.eventEmit', { event: 'warmup', args: [] });
    const hostId = calls.th.find(c => c[0] === 'eventEmit')?.[1]?.origin;
    assert.ok(hostId, 'eventEmit 应带 hostId origin');
    // 订阅两类事件,让回声过滤有据可查
    await host.dispatch('th.eventOn', { event: 'chat_changed', listener_id: 'L1' });
    await host.dispatch('th.eventOn', { event: 'message_edited', listener_id: 'L2' });
    mb.log.push({ seq: 1, at: 1, event: 'chat_changed', args: ['chat-1.jsonl'], origin: 'other' });
    mb.log.push({ seq: 2, at: 2, event: 'message_edited', args: [0], origin: hostId });
    await host.pollChat();
    assert.equal(seen.length, 2, '两条 mutation 都应通知宿主(含自源)');
    const echoed = pushes.filter(p => p.event === 'th.event').map(p => p.payload.name);
    assert.ok(echoed.includes('chat_changed'), '他源 chat_changed 应回声给订阅卡');
    assert.ok(!echoed.includes('message_edited'), '自源条目不得回声(防卡侧双发)');
});

test('swipe 对象槽({mes})同内容 → 不误报 message_edited', async () => {
    const seq = [
        { header: { chat_metadata: {} }, messages: [{ mes: 'm', swipes: [{ mes: 's0' }, { mes: 's1' }], swipe_id: 1 }] },
    ];
    const { host, pushes } = makeHost({ chatDoc: seq[0] });
    await host.dispatch('th.eventOn', { event: 'message_edited' });
    await host.seed();
    await host.pollChat(); // 同一 doc —— 对象槽引用虽新,内容同,不得报 edited
    const edited = pushes.filter(p => p.event === 'th.event' && p.payload.name === 'message_edited');
    assert.equal(edited.length, 0);
});

test('surface 未接 → surfaceOpen/Close 如实 PANEL_SURFACE_UNAVAILABLE', async () => {
    const { host } = makeHost();
    const o = await host.dispatch('ctx.surfaceOpen', {});
    assert.equal(o.ok, false);
    assert.equal(o.reason, 'panel_surface_unavailable');
    const c = await host.dispatch('ctx.surfaceClose', {});
    assert.equal(c.ok, false);
    assert.equal(c.reason, 'panel_surface_unavailable');
});
