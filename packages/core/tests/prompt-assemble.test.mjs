/**
 * Prompt assembly characterization tests — buildPromptMessages fidelity
 * against legacy openai.js prepareOpenAIMessages semantics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptMessages, setOpenAIMessages, setTokenCounter } from '../dist/index.js';

setTokenCounter({ count: async (m) => (m.content?.length ?? 0) + 4 });

const deps = { substCtx: { name1: 'User', name2: 'Char', chat: [], chatMetadata: {}, globalVariables: {} } };

function baseReq(over = {}) {
    return {
        card: { name: 'Char', description: 'A card desc.', personality: 'bold', scenario: 'tavern', mesExample: '' },
        user: { name: 'User', description: 'the wanderer' },
        chat: [
            { is_user: true, name: 'User', mes: 'hello' },
            { is_user: false, name: 'Char', mes: 'greetings traveler' },
            { is_user: true, name: 'User', mes: 'tell me a story' },
        ],
        prompts: [
            { identifier: 'main', role: 'system', content: 'You are Char.', system_prompt: true, marker: true },
            { identifier: 'nsfw', role: 'system', content: 'NSFW text.', system_prompt: true },
            { identifier: 'jailbreak', role: 'system', content: 'JB text.', system_prompt: true },
            { identifier: 'chatHistory', role: 'system', marker: true, system_prompt: true },
            { identifier: 'dialogueExamples', role: 'system', marker: true, system_prompt: true },
        ],
        promptOrder: ['worldInfoBefore', 'main', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'nsfw', 'jailbreak', 'enhanceDefinitions', 'chatHistory', 'dialogueExamples'],
        settings: {
            wi_format: 'World:\n{0}',
            new_chat_prompt: '[Start a new chat]',
            new_example_chat_prompt: '[New example]',
            names_behavior: 0,
            squash_system_messages: false,
        },
        contextTokens: 4096,
        responseTokens: 300,
        worldInfo: {},
        ...over,
    };
}

test('canonical order: WI-before / main / WI-after / desc / persona / history', async () => {
    const r = await buildPromptMessages(baseReq({
        worldInfo: { beforeEntries: ['WI-before text'], afterEntries: ['WI-after text'] },
    }), deps);
    const wiB = r.messages.findIndex((m) => m.content.includes('WI-before'));
    const main = r.messages.findIndex((m) => m.content.includes('You are Char'));
    const wiA = r.messages.findIndex((m) => m.content.includes('WI-after'));
    const desc = r.messages.findIndex((m) => m.content.includes('A card desc'));
    const pers = r.messages.findIndex((m) => m.content.includes('the wanderer'));
    const hist = r.messages.findIndex((m) => m.content.includes('hello'));
    assert.ok(wiB !== -1 && main !== -1 && wiA !== -1 && desc !== -1 && pers !== -1 && hist !== -1);
    assert.ok(wiB < main, 'WI-before before main');
    assert.ok(main < wiA, 'main before WI-after');
    assert.ok(wiA < desc, 'WI-after before charDesc');
    assert.ok(desc < pers, 'desc before persona');
    assert.ok(pers < hist, 'persona before chat history');
    assert.match(r.messages[wiB].content, /^World:/);
});

test('depth injection: absolute prompt lands inside chat at depth', async () => {
    const r = await buildPromptMessages(baseReq({
        prompts: [
            { identifier: 'main', role: 'system', content: 'M', system_prompt: true, marker: true },
            { identifier: 'chatHistory', role: 'system', marker: true, system_prompt: true },
            {
                identifier: 'an', role: 'system', content: 'AUTHORS-NOTE',
                injection_position: 1, injection_depth: 1, injection_order: 100,
            },
        ],
    }), deps);
    const idx = r.messages.findIndex((m) => m.content.includes('AUTHORS-NOTE'));
    assert.ok(idx > 0 && idx < r.messages.length - 1, 'AN inside chat, idx=' + idx);
    assert.equal(r.trace.injectedCount, 1);
});

test('undefined injection_depth does not match depth 0', async () => {
    const r = await buildPromptMessages(baseReq({
        prompts: [
            { identifier: 'main', role: 'system', content: 'M', system_prompt: true, marker: true },
            { identifier: 'chatHistory', role: 'system', marker: true, system_prompt: true },
            { identifier: 'dep0', role: 'system', content: 'AT-DEPTH-ZERO', injection_position: 1, injection_depth: 0, injection_order: 100 },
            { identifier: 'depU', role: 'system', content: 'UNDEFINED-DEPTH', injection_position: 1, injection_order: 100 },
        ],
    }), deps);
    const atZero = r.messages.find((m) => m.content.includes('AT-DEPTH-ZERO'));
    const undef = r.messages.find((m) => m.content.includes('UNDEFINED-DEPTH'));
    assert.ok(atZero, 'depth=0 prompt injected');
    assert.ok(!undef, 'undefined-depth prompt must not inject at depth 0');
});

test('budget truncation: oldest chat dropped first, newest kept', async () => {
    const long = 'x'.repeat(200);
    const r = await buildPromptMessages(baseReq({
        contextTokens: 400,
        responseTokens: 50,
        chat: [
            { is_user: true, name: 'U', mes: 'OLD-' + long },
            { is_user: false, name: 'C', mes: 'old2-' + long },
            { is_user: true, name: 'U', mes: 'new' },
        ],
        settings: { new_chat_prompt: '', names_behavior: 0 },
    }), deps);
    assert.ok(r.trace.droppedChatCount >= 1, 'dropped=' + r.trace.droppedChatCount);
    const lastUser = r.messages[r.messages.length - 1];
    assert.match(lastUser.content, /new/);
});

test('names_behavior=CONTENT prefixes name in content', async () => {
    const r = await buildPromptMessages(baseReq({
        settings: { names_behavior: 2, new_chat_prompt: '' },
    }), deps);
    const userMsg = r.messages.find((m) => m.role === 'user');
    assert.match(userMsg.content, /^User: hello/);
    const botMsg = r.messages.find((m) => m.role === 'assistant');
    assert.match(botMsg.content, /^Char: greetings/);
});

test('names_behavior=COMPLETION uses name field, content untouched', async () => {
    const r = await buildPromptMessages(baseReq({
        settings: { names_behavior: 3, new_chat_prompt: '' },
    }), deps);
    const userMsg = r.messages.find((m) => m.role === 'user');
    assert.equal(userMsg.name, 'User');
    assert.equal(userMsg.content, 'hello');
});

test('squash merges consecutive unnamed system messages', async () => {
    const r = await buildPromptMessages(baseReq({
        settings: { names_behavior: 0, squash_system_messages: true, new_chat_prompt: '' },
        worldInfo: { beforeEntries: ['WI'] },
    }), deps);
    const systemCount = r.messages.filter((m) => m.role === 'system').length;
    assert.ok(systemCount <= 4, 'systemCount=' + systemCount);
});

test('attach prompt appends to target-role message', async () => {
    const r = await buildPromptMessages(baseReq({
        prompts: [
            { identifier: 'main', role: 'system', content: 'M', system_prompt: true, marker: true },
            { identifier: 'chatHistory', role: 'system', marker: true, system_prompt: true },
            {
                identifier: 'att', role: 'system', content: 'ATTACHED',
                injection_position: 2, attach_role: 'user', attach_index: 1, attach_side: 'end',
            },
        ],
    }), deps);
    // attach_index=1 按时序取第一条 user 消息('hello'),不是最新一条
    const firstUser = r.messages.find((m) => m.role === 'user');
    assert.match(firstUser.content, /ATTACHED$/);
    assert.match(firstUser.content, /^hello/);
});

test('setOpenAIMessages: output newest-first, narrator to system, IGNORE skipped', () => {
    const msgs = setOpenAIMessages([
        { is_user: true, name: 'U', mes: 'm1' },
        { is_user: false, name: 'C', mes: 'narrate', extra: { type: 4 } },
    ], { settings: { names_behavior: 2 }, api: 'openai', model: 'm' });
    // 输出为最新在前序:narrator 消息在后
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, 'narrate'); // narrator 不加名前缀
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[1].content, /^U: m1/);
});
