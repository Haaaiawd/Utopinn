/**
 * extension prompts 三面集成测试(node:test,无 jest 依赖)。
 * 真 FsEngine + 种子数据:
 *   - scan 标记注入进 checkWorldInfo 扫描缓冲
 *   - IN_CHAT 深度注入聚合进 messages(深度/role 过滤)
 *   - WI 内容正则钩子(placement 含 WORLD_INFO + promptOnly)
 * 跑法:node --test tests/uberge-extension-prompts.test.mjs
 *
 * 注意:position 用 ST 编号(extension_prompt_types:
 * NONE=-1 / IN_PROMPT=0 / IN_CHAT=1 / BEFORE_PROMPT=2),normalize 透传同号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    getChatRepo,
    getPresetRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    initStorage,
} from '../src/storage/index.js';
import { buildGenerationContext } from '../src/services/generate-context.js';
import {
    createDepthInjectionProvider,
    createWorldInfoRegexHook,
    normalizeExtensionPrompts,
    scannableExtensionPrompts,
} from '../src/services/extension-prompts.js';

const HANDLE = 'h1';
const CHAR = 'Alice';

const CARD = {
    name: 'Alice',
    data: {
        name: 'Alice',
        description: 'A wandering knight.',
        personality: 'stoic',
        scenario: 'A ruined kingdom.',
        mes_example: '',
        extensions: {},
    },
};

const ORDER = ['main', 'worldInfoBefore', 'chatHistory', 'worldInfoAfter', 'jailbreak'];

const PRESET = {
    openai_model: 'gpt-test',
    openai_max_context: 8192,
    openai_max_tokens: 200,
    prompts: [
        { identifier: 'main', role: 'system', content: 'You are {{char}}. {{user}} speaks.' },
        { identifier: 'worldInfoBefore', role: 'system', marker: true, content: '' },
        { identifier: 'chatHistory', role: 'system', marker: true, content: '' },
        { identifier: 'worldInfoAfter', role: 'system', marker: true, content: '' },
        { identifier: 'jailbreak', role: 'system', content: '' },
    ],
    prompt_order: [{ character_id: 100001, order: ORDER.map((identifier) => ({ identifier, enabled: true })) }],
};

const wiEntry = (uid, key, content, order) => ({
    uid, key: [key], content, comment: '', disable: false, enabled: true,
    position: 0, selective: false, order, constant: false, selectiveLogic: 0,
});

function allText(builtPrompt) {
    return builtPrompt.messages.map((m) => String(m.content)).join('\n');
}

/** ST 存储编号速记(IN_PROMPT=0/IN_CHAT=1/BEFORE_PROMPT=2,role SYSTEM=0/USER=1/ASSISTANT=2) */
const ST = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };

test('extension prompts — scan/depth/regex 三面', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-extprompts-'));
    try {
        const dirs = {
            root: tmpDir,
            characters: path.join(tmpDir, 'characters'),
            chats: path.join(tmpDir, 'chats'),
            worlds: path.join(tmpDir, 'worlds'),
            groups: path.join(tmpDir, 'groups'),
            openAI_Settings: path.join(tmpDir, 'OpenAI Settings'),
            context: path.join(tmpDir, 'context'),
            instruct: path.join(tmpDir, 'instruct'),
            sysprompt: path.join(tmpDir, 'sysprompt'),
            reasoning: path.join(tmpDir, 'reasoning'),
            koboldAI_Settings: path.join(tmpDir, 'KoboldAI Settings'),
            novelAI_Settings: path.join(tmpDir, 'NovelAI Settings'),
            textGen_Settings: path.join(tmpDir, 'TextGen Settings'),
        };
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const request = { user: { profile: { handle: HANDLE, name: 'User' } } };

        const saveSettings = (extra) => getSettingsRepo().save(HANDLE, {
            power_user: { persona_description: 'I am me.' },
            // 真实路径:world_info_settings.world_info.globalSelect(5b9b6d2 后
            // power_user.selected_world_info 已死,seed 错 = 测试绿着错)。
            world_info_settings: { world_info: { globalSelect: ['ScanBook'] } },
            preset_settings_openai: 'Default',
            ...extra,
        });

        await getPresetRepo().save(HANDLE, 'openai', 'Default', PRESET);
        await getWorldInfoRepo().save(HANDLE, 'ScanBook', {
            entries: { '0': wiEntry(0, 'leviathan', 'The leviathan surfaces.', 100) },
        });

        await t.test('scan=true extension prompt enters WI scan buffer', async () => {
            await saveSettings({
                extension_prompts: {
                    note1: { value: 'sailors whisper of the leviathan', position: ST.IN_PROMPT, depth: 0, role: 0, scan: true },
                },
            });
            await getChatRepo().save(HANDLE, CHAR, 's1',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: true, name: 'User', mes: 'Calm seas today.' }],
                null);
            const { builtPrompt, sources } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 's1', card: CARD, user: { name: 'User' },
            });
            assert.match(allText(builtPrompt), /The leviathan surfaces\./);
            assert.ok(sources.worldInfoActivated > 0);
        });

        await t.test('scan=false stays out of WI scan buffer', async () => {
            await saveSettings({
                extension_prompts: {
                    note1: { value: 'sailors whisper of the leviathan', position: ST.IN_PROMPT, depth: 0, role: 0, scan: false },
                },
            });
            await getChatRepo().save(HANDLE, CHAR, 's2',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: true, name: 'User', mes: 'Calm seas today.' }],
                null);
            const { builtPrompt, sources } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 's2', card: CARD, user: { name: 'User' },
            });
            assert.doesNotMatch(allText(builtPrompt), /The leviathan surfaces\./);
            assert.equal(sources.worldInfoActivated, 0);
        });

        await t.test('IN_CHAT inject lands at exact depth with mapped role', async () => {
            await saveSettings({
                extension_prompts: {
                    depthNote: { value: 'DEPTH MARKER', position: ST.IN_CHAT, depth: 1, role: 1 },
                },
            });
            await getChatRepo().save(HANDLE, CHAR, 's3',
                { user_name: 'User', chat_metadata: {} },
                [
                    { is_user: true, name: 'User', mes: 'Ping.' },
                    { is_user: true, name: 'User', mes: 'Middle.' },
                    { is_user: false, name: 'Alice', mes: 'Reply.' },
                ],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 's3', card: CARD, user: { name: 'User' },
            });
            const messages = builtPrompt.messages;
            const idx = messages.findIndex((m) => String(m.content).includes('DEPTH MARKER'));
            assert.ok(idx > 0, 'DEPTH MARKER should be injected');
            assert.equal(messages[idx].role, 'user');
            // depth 1 = 最新一条之下:前面是 'Middle.',后面是 'Reply.'
            assert.equal(String(messages[idx - 1].content), 'Middle.');
            assert.equal(String(messages[idx + 1].content), 'Reply.');
        });

        await t.test('role filter keeps assistant/user injects apart', async () => {
            await saveSettings({
                extension_prompts: {
                    aNote: { value: 'ASSISTANT NOTE', position: ST.IN_CHAT, depth: 0, role: 2 },
                    uNote: { value: 'USER NOTE', position: ST.IN_CHAT, depth: 0, role: 1 },
                },
            });
            await getChatRepo().save(HANDLE, CHAR, 's4',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: false, name: 'Alice', mes: 'Tail.' }],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 's4', card: CARD, user: { name: 'User' },
            });
            const messages = builtPrompt.messages;
            const aIdx = messages.findIndex((m) => String(m.content).includes('ASSISTANT NOTE'));
            const uIdx = messages.findIndex((m) => String(m.content).includes('USER NOTE'));
            assert.ok(aIdx > 0 && uIdx > 0);
            assert.equal(messages[aIdx].role, 'assistant');
            assert.equal(messages[uIdx].role, 'user');
            // depth 0 同层序:system→user→assistant 入 newest 前,反转后 assistant 在 user 前
            assert.equal(aIdx, uIdx - 1);
            // 两条都落在最后一条聊天消息之后
            assert.ok(aIdx > messages.findIndex((m) => String(m.content) === 'Tail.'));
        });

        await t.test('WI regex hook rewrites activated entry content', async () => {
            await saveSettings({
                extension_prompts: {
                    note1: { value: 'sailors whisper of the leviathan', position: ST.IN_PROMPT, depth: 0, role: 0, scan: true },
                },
                extension_settings: {
                    regex: [
                        {
                            id: 'r1', scriptName: 'swap-kraken', findRegex: '/leviathan/',
                            replaceString: 'KRAKEN', placement: [5], promptOnly: true,
                        },
                        {
                            id: 'r2', scriptName: 'chat-only', findRegex: '/leviathan/',
                            replaceString: 'NOSHOW', placement: [5],
                        },
                    ],
                },
            });
            await getChatRepo().save(HANDLE, CHAR, 's5',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: true, name: 'User', mes: 'Calm seas today.' }],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 's5', card: CARD, user: { name: 'User' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /The KRAKEN surfaces\./);
            assert.doesNotMatch(text, /NOSHOW/);
            assert.doesNotMatch(text, /The leviathan surfaces\./);
        });

        await t.test('chat_metadata.script_injects rehydrate as script_inject_*', async () => {
            await saveSettings({});
            await getChatRepo().save(HANDLE, CHAR, 's6',
                { user_name: 'User', chat_metadata: { script_injects: { jab: { value: 'jab at leviathan', position: ST.IN_PROMPT, depth: 0, scan: true, role: 0 } } } },
                [{ is_user: true, name: 'User', mes: 'Calm seas today.' }],
                null);
            const { builtPrompt, request: req } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 's6', card: CARD, user: { name: 'User' },
            });
            assert.match(allText(builtPrompt), /The leviathan surfaces\./);
            assert.equal(req.extensionPrompts.script_inject_jab.scan, true);
        });

        await t.test('unit: normalize keeps ST positions, keeps undefined wildcards', async () => {
            const doc = {
                extension_prompts: {
                    a: { value: 'x', position: ST.IN_CHAT, depth: 2, role: 2, scan: true },
                    b: { value: 'y' }, // 全缺省
                    c: { value: 'z', position: ST.BEFORE_PROMPT, depth: 0, role: 0 },
                    d: { value: 'w', position: ST.IN_PROMPT, depth: 0, role: 0 },
                },
            };
            const norm = normalizeExtensionPrompts(doc);
            assert.equal(norm.a.position, 1); // ST IN_CHAT 透传
            assert.equal(norm.b.position, -1);
            assert.equal(norm.b.depth, undefined);
            assert.equal(norm.b.role, undefined);
            assert.equal(norm.b.scan, false);
            assert.equal(norm.c.position, 2); // ST BEFORE_PROMPT
            assert.equal(norm.d.position, 0); // ST IN_PROMPT

            // scan 面:subst 逐条生效
            assert.deepEqual(scannableExtensionPrompts(doc), ['x']);
            assert.deepEqual(scannableExtensionPrompts(doc, (s) => `[${s}]`), ['[x]']);

            // 深度注入:key 字典序 join + role 过滤(b 无 position → 不进 IN_CHAT 面)
            const provider = createDepthInjectionProvider(doc);
            assert.equal(await provider(2, 'assistant'), 'x');
            assert.equal(await provider(9, 'assistant'), ''); // depth 不匹配
            assert.equal(await provider(2, 'user'), '');    // role 不匹配
            // undefined depth/role 是通配:加一条裸 IN_CHAT 验证
            const doc2 = {
                extension_prompts: {
                    wild: { value: 'wild', position: ST.IN_CHAT },
                    scoped: { value: 'scoped', position: ST.IN_CHAT, depth: 0, role: 0 },
                },
            };
            const provider2 = createDepthInjectionProvider(doc2);
            assert.equal(await provider2(0, 'system'), 'scoped\nwild'); // key 序:scoped < wild
            assert.equal(await provider2(7, 'user'), 'wild');          // wild 无 depth/role → 通配
        });

        await t.test('unit: WI regex hook gates + depth bounds + disabledExtensions', async () => {
            const substCtx = { name1: 'User', name2: 'Alice', chatMetadata: {} };
            const doc = {
                extension_settings: {
                    regex: [
                        { scriptName: 'hit', findRegex: '/foo/', replaceString: 'bar', placement: [5], promptOnly: true },
                        { scriptName: 'no-promptonly', findRegex: '/foo/', replaceString: 'x', placement: [5] },
                        { scriptName: 'no-wi', findRegex: '/foo/', replaceString: 'y', placement: [2], promptOnly: true },
                        { scriptName: 'off', findRegex: '/foo/', replaceString: 'z', placement: [5], promptOnly: true, disabled: true },
                        { scriptName: 'deep-only', findRegex: '/r/', replaceString: '0', placement: [5], promptOnly: true, minDepth: 2 },
                    ],
                },
            };
            const hook = createWorldInfoRegexHook(doc, substCtx);
            assert.equal(hook('foo', { depth: null }), 'ba0'); // deep-only 无 depth 门控
            assert.equal(hook('foo', { depth: 0 }), 'bar');    // deep-only 被 minDepth 挡
            assert.equal(hook('foo', { depth: 3 }), 'ba0');    // deep-only 命中 /r/→0
            // disabledExtensions 灭整个 regex 扩展
            const docKill = { extension_settings: { disabledExtensions: ['regex'], regex: doc.extension_settings.regex } };
            assert.equal(createWorldInfoRegexHook(docKill, substCtx)('foo', { depth: null }), 'foo');
            // substituteRegex=RAW:findRegex 先过宏
            const docRaw = {
                extension_settings: {
                    regex: [{ scriptName: 'raw', findRegex: '/{{user}}/', replaceString: 'YOU', placement: [5], promptOnly: true, substituteRegex: 1 }],
                },
            };
            assert.equal(createWorldInfoRegexHook(docRaw, substCtx)('dear User', { depth: null }), 'dear YOU');
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
