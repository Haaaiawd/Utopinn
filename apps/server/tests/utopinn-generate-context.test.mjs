/**
 * buildGenerationContext 集成测试(node:test,无 jest 依赖)。
 * 真 FsEngine + 种子数据:chat/preset/settings/world 四 repo →
 * mergeLoreSources → checkWorldInfo → buildPromptMessages 全链。
 * 跑法:node --test tests/utopinn-generate-context.test.mjs
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
import { buildGenerationContext, persistWorldInfoTimedEffects } from '../src/services/generate-context.js';
import { buildStscriptEnv } from '../src/services/stscript-env.js';
import { runStscript } from '@utopinn/core';

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

test('buildGenerationContext — storage → WI → prompt', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-genctx-'));
    try {
        // FsEngine 需要按 dirKey 寻址(preset→openAI_Settings,world→worlds…),
        // 与 tests/storage/harness/fs-harness.js USER_DIRS 同构。
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

        await getSettingsRepo().save(HANDLE, {
            power_user: {
                persona_description: 'I am me.',
            },
            // 上游真实结构(settings.world_info_settings;audit H1/H2 前
            // 实现误读 power_user.selected_world_info / settings.world_info)
            world_info_settings: {
                world_info_depth: 2,
                world_info_budget: 25,
                world_info_recursive: true,
                world_info_include_names: true,
                world_info_match_whole_words: true,
                world_info_character_strategy: 1,
                world_info: {
                    globalSelect: ['GlobalBook'],
                    charLore: [{ name: CHAR, extraBooks: ['CharBook'] }],
                },
            },
            preset_settings_openai: 'Default',
        });
        await getPresetRepo().save(HANDLE, 'openai', 'Default', PRESET);
        await getWorldInfoRepo().save(HANDLE, 'GlobalBook', {
            entries: { '0': wiEntry(0, 'dragon', 'Dragons once ruled this land.', 100) },
        });
        await getWorldInfoRepo().save(HANDLE, 'CharBook', {
            entries: { '0': wiEntry(0, 'sword', 'Her sword is named Oath.', 50) },
        });
        await getWorldInfoRepo().save(HANDLE, 'ChatBook', {
            entries: { '0': wiEntry(0, 'voice', 'Whispers carry far in ruins.', 10) },
        });
        await getChatRepo().save(HANDLE, CHAR, 'c1',
            { user_name: 'User', chat_metadata: { world_info: 'ChatBook' } },
            [
                { is_user: true, name: 'User', mes: 'I found a dragon scale.' },
                { is_user: false, name: 'Alice', mes: 'Keep your voice down.' },
            ],
            null);

        await t.test('macros + chat history land in messages', async () => {
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'c1', card: CARD, user: { name: 'User' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /You are Alice/);
            assert.match(text, /I found a dragon scale\./);
            assert.match(text, /Keep your voice down\./);
            assert.ok(builtPrompt.trace);
        });

        await t.test('perf 分段计时齐字段且非负', async () => {
            const { perf } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'c1', card: CARD, user: { name: 'User' },
            });
            for (const k of ['loadMs', 'presetMs', 'wiMs', 'assembleMs', 'collectionMs', 'populateMs', 'tokenMs', 'totalMs']) {
                assert.ok(Number.isFinite(perf[k]) && perf[k] >= 0, `perf.${k}`);
            }
            assert.ok(perf.totalMs >= perf.assembleMs, 'total covers assemble');
            assert.ok(perf.assembleMs >= perf.tokenMs, 'token inside assemble');
            // collect+populate 量的是 promptBuilder 内层窗口,≤ 外层 assembleMs
            assert.ok(perf.collectionMs + perf.populateMs <= perf.assembleMs, 'collect+populate within assemble');
            assert.ok(perf.tokenMs > 0, 'encoder actually ran');
        });

        await t.test('global world book activates on keyword hit', async () => {
            const { builtPrompt, sources } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'c1', card: CARD, user: { name: 'User' },
            });
            assert.match(allText(builtPrompt), /Dragons once ruled this land\./);
            assert.ok(sources.worldInfoActivated > 0);
        });

        await t.test('chat-bound + charLore books join the scan', async () => {
            await getChatRepo().save(HANDLE, CHAR, 'c2',
                { user_name: 'User', chat_metadata: { world_info: 'ChatBook' } },
                [{ is_user: true, name: 'User', mes: 'I lower my voice and draw my sword.' }],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'c2', card: CARD, user: { name: 'User' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /Whispers carry far in ruins\./);
            assert.match(text, /Her sword is named Oath\./);
        });

        // issue#8 回归:sources.worldInfoActivated 必须与 worldInfo.activated
        // 明细同源——非 before 位(after/AN/atDepth)的激活也要进计数;
        // 旧的 before(+after+depth 桶)加总会漏 AN/EM/outlet,且 atDepth 桶
        // 按 depth+role 合并,桶数≠条目数。
        await t.test('worldInfoActivated == worldInfo.activated.length(全位置口径)', async () => {
            await getWorldInfoRepo().save(HANDLE, 'PosBook', {
                entries: {
                    '0': { ...wiEntry(0, 'dragon', 'AFTER_POS content.', 20), position: 1, ignoreBudget: true },
                    '1': { ...wiEntry(1, 'dragon', 'AN_POS content.', 30), position: 2, ignoreBudget: true },
                    '2': { ...wiEntry(2, 'dragon', 'DEPTH_POS content.', 40), position: 4, depth: 1, ignoreBudget: true },
                },
            });
            await getChatRepo().save(HANDLE, CHAR, 'c3',
                { user_name: 'User', chat_metadata: { world_info: 'PosBook' } },
                [{ is_user: true, name: 'User', mes: 'dragon' }],
                null);
            const { sources } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'c3', card: CARD, user: { name: 'User' },
            });
            const activated = sources.worldInfo?.activated ?? [];
            // PosBook 3 条全位置 + GlobalBook 的 dragon(globalSelect 全域)
            assert.equal(activated.length, 4);
            assert.equal(sources.worldInfoActivated, activated.length,
                'worldInfoActivated 必须等于 activated 明细长度,不许漏非 before 位');
        });

        await t.test('missing chat/preset fail loud', async () => {
            await assert.rejects(
                buildGenerationContext({ request, charDir: CHAR, chatName: 'ghost', card: CARD, user: { name: 'User' } }),
                /Chat not found/);
            await assert.rejects(
                buildGenerationContext({ request, charDir: CHAR, chatName: 'c1', card: CARD, presetName: 'NoSuch', user: { name: 'User' } }),
                /Preset not found/);
        });

        // TASK-046 段3b:panel-t0 th.injectPrompts 写 chat_state ns
        // 'th.inject' {prompts: ThInjectedPrompt[]} —— 组装读侧消费进
        // extension_prompts(IN_CHAT/depth/role/scan),注入内容必须进
        // builtPrompt;'none' 位与无 state 聊天不受影响。
        await t.test('chat_state th.inject prompts land in builtPrompt', async () => {
            await getChatRepo().setState(HANDLE, CHAR, 'c1', 'th.inject', {
                prompts: [
                    { id: 'inj-1', position: 'in_chat', depth: 1, role: 'system', content: 'SECRET_INJECTED_BANNER', should_scan: false },
                    { id: 'inj-none', position: 'none', content: 'SHOULD_NOT_APPEAR' },
                ],
            });
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'c1', card: CARD, user: { name: 'User' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /SECRET_INJECTED_BANNER/, 'in_chat inject must reach the prompt');
            assert.ok(!/SHOULD_NOT_APPEAR/.test(text), 'position:none inject stays dormant');
            // 清掉后不再注入 —— 读写闭环(uninject 语义)。
            await getChatRepo().setState(HANDLE, CHAR, 'c1', 'th.inject', { prompts: [] });
            const { builtPrompt: after } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'c1', card: CARD, user: { name: 'User' },
            });
            assert.ok(!/SECRET_INJECTED_BANNER/.test(allText(after)), 'cleared inject must not linger');
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

/**
 * audit 回归钉:settings 路径族修复后的行为断言。
 * 覆盖 include_names / recursive / Author's Note / depth_prompt /
 * timed-effects 持久化 / dryRun 不写。
 */
test('audit regressions — settings + injection + persist', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-genctx2-'));
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

        const CARD2 = {
            name: 'Alice',
            data: {
                name: 'Alice',
                description: 'A wandering knight.',
                mes_example: '',
                extensions: {
                    depth_prompt: { prompt: 'Keep the ruins mood.', depth: 1, role: 'system' },
                },
            },
        };
        const baseSettings = (extra = {}) => ({
            power_user: {},
            world_info_settings: {
                world_info_depth: 2,
                world_info_budget: 25,
                world_info_recursive: false,
                world_info_include_names: true,
                world_info_match_whole_words: true,
                world_info: {},
                ...extra,
            },
            preset_settings_openai: 'Default',
        });
        await getPresetRepo().save(HANDLE, 'openai', 'Default', PRESET);

        await getWorldInfoRepo().save(HANDLE, 'NameBook', {
            entries: { '0': wiEntry(0, 'User', 'Name-keyed lore.', 100) },
        });
        await getWorldInfoRepo().save(HANDLE, 'RecurBook', {
            entries: {
                '0': wiEntry(0, 'dragon', 'Dragon lore mentions scales.', 100),
                '1': wiEntry(1, 'scales', 'Scale lore via recursion.', 50),
            },
        });
        await getWorldInfoRepo().save(HANDLE, 'StickyBook', {
            entries: { '0': { ...wiEntry(0, 'dragon', 'Sticky dragon lore.', 100), sticky: 2 } },
        });
        await getWorldInfoRepo().save(HANDLE, 'AnBook', {
            entries: { '0': { ...wiEntry(0, 'one', 'WI note topper.', 100), position: 2 } }, // ANTop;key 命中 an1 的 'one' 消息
        });

        await t.test('include_names=true: name-keyed entry fires', async () => {
            await getSettingsRepo().save(HANDLE, {
                ...baseSettings(),
                world_info_settings: { ...baseSettings().world_info_settings, world_info: { globalSelect: ['NameBook'] } },
            });
            await getChatRepo().save(HANDLE, CHAR, 'n1',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: true, name: 'User', mes: 'hello there' }],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'n1', card: CARD2, user: { name: 'User' },
            });
            assert.match(allText(builtPrompt), /Name-keyed lore\./);
        });

        await t.test('include_names=false: same entry does not fire', async () => {
            await getSettingsRepo().save(HANDLE, {
                ...baseSettings(),
                world_info_settings: { ...baseSettings().world_info_settings, world_info_include_names: false, world_info: { globalSelect: ['NameBook'] } },
            });
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'n1', card: CARD2, user: { name: 'User' },
            });
            assert.doesNotMatch(allText(builtPrompt), /Name-keyed lore\./);
        });

        await t.test('recursive=false: content-only key stays dormant; true: fires', async () => {
            await getSettingsRepo().save(HANDLE, {
                ...baseSettings(),
                world_info_settings: { ...baseSettings().world_info_settings, world_info_recursive: false, world_info: { globalSelect: ['RecurBook'] } },
            });
            await getChatRepo().save(HANDLE, CHAR, 'r1',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: true, name: 'User', mes: 'I saw a dragon.' }],
                null);
            const off = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'r1', card: CARD2, user: { name: 'User' },
            });
            assert.match(allText(off.builtPrompt), /Dragon lore mentions scales\./);
            assert.doesNotMatch(allText(off.builtPrompt), /Scale lore via recursion\./);

            await getSettingsRepo().save(HANDLE, {
                ...baseSettings(),
                world_info_settings: { ...baseSettings().world_info_settings, world_info_recursive: true, world_info: { globalSelect: ['RecurBook'] } },
            });
            const on = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'r1', card: CARD2, user: { name: 'User' },
            });
            assert.match(allText(on.builtPrompt), /Scale lore via recursion\./);
        });

        await t.test("Author's Note + card depth_prompt inject into messages", async () => {
            await getSettingsRepo().save(HANDLE, baseSettings());
            await getChatRepo().save(HANDLE, CHAR, 'an1',
                {
                    user_name: 'User',
                    chat_metadata: { note_prompt: 'Tone: mournful.', note_interval: 1, note_position: 1, note_depth: 2, note_role: 0 },
                },
                [
                    { is_user: true, name: 'User', mes: 'one' },
                    { is_user: false, name: 'Alice', mes: 'two' },
                ],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'an1', card: CARD2, user: { name: 'User' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /Tone: mournful\./);
            assert.match(text, /Keep the ruins mood\./);
        });

        await t.test('WI ANTop merges into Author\'s Note', async () => {
            await getSettingsRepo().save(HANDLE, {
                ...baseSettings(),
                world_info_settings: { ...baseSettings().world_info_settings, world_info: { globalSelect: ['AnBook'] } },
            });
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'an1', card: CARD2, user: { name: 'User' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /WI note topper\./);
            assert.match(text, /Tone: mournful\./);
        });

        await t.test('audit L1: prompt/continued messages carry no name on wire (upstream drops it)', async () => {
            // 上游 openai.js:3792 fromPromptAsync 不传 prompt.name;continueNudge
            // 路径(917-921)也不 setName——名字只在 names_behavior=COMPLETION 的
            // 聊天历史装填里经 setName 上线。
            await getPresetRepo().save(HANDLE, 'openai', 'Default', {
                ...PRESET,
                prompts: PRESET.prompts.map((p) =>
                    p.identifier === 'main' ? { ...p, name: 'PresetName' } : p),
                names_behavior: 3, // COMPLETION
            });
            await getSettingsRepo().save(HANDLE, baseSettings());
            await getChatRepo().save(HANDLE, CHAR, 'l1',
                { user_name: 'User', chat_metadata: {} },
                [
                    { is_user: true, name: 'User', mes: 'The dragon landed.' },
                    { is_user: false, name: 'Alice', mes: 'Then it roared.' },
                ],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'l1', card: CARD2, user: { name: 'User' },
                type: 'continue',
                overrides: { cyclePrompt: 'Then it roared.' },
            });
            const msgs = builtPrompt.messages;
            // prompt 级 name('PresetName')不上 wire
            const mainMsg = msgs.find((m) => /You are Alice/.test(String(m.content)));
            assert.ok(mainMsg, 'main prompt present');
            assert.equal(mainMsg.name, undefined, 'prompt-derived message must not carry name');
            // COMPLETION 下聊天历史仍带名
            const histMsg = msgs.find((m) => String(m.content) === 'The dragon landed.');
            assert.ok(histMsg, 'history message present');
            assert.equal(histMsg.name, 'User', 'COMPLETION keeps name on chat history');
            // 被 continue 的消息:上游不补名
            const contMsg = msgs.find((m) => String(m.content) === 'Then it roared.');
            assert.ok(contMsg, 'continued message present');
            assert.equal(contMsg.name, undefined, 'continued message must not carry name');
        });

        await t.test('audit L2: continue_nudge substitutes {{lastChatMessage}} literally', async () => {
            // 上游 openai.js:909 — substituteParamsExtended(continue_nudge_prompt,
            // { lastChatMessage: String(cyclePrompt).trim() }):宏替成续写目标文本。
            await getPresetRepo().save(HANDLE, 'openai', 'Default', {
                ...PRESET,
                continue_nudge_prompt: 'Continue. Last message: {{lastChatMessage}}',
            });
            await getSettingsRepo().save(HANDLE, baseSettings());
            await getChatRepo().save(HANDLE, CHAR, 'l2',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: false, name: 'Alice', mes: 'It roared again.' }],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'l2', card: CARD2, user: { name: 'User' },
                type: 'continue',
                overrides: { cyclePrompt: '  It roared again.  ' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /Last message: It roared again\./, 'cyclePrompt trimmed + substituted');
            assert.doesNotMatch(text, /\{\{lastChatMessage\}\}/, 'no literal macro residue');
        });

        await t.test('audit M13: /sys persists message + chat_metadata.tainted (saveChatConditional)', async () => {
            // 上游 sendNarratorMessage(slash-commands.js:6113-6152):
            // chat_metadata.tainted = true → push → saveChatConditional()
            // → header+body 一起落盘。persistChat seam 补 header 侧。
            await fs.promises.mkdir(dirs.characters, { recursive: true });
            await fs.promises.writeFile(
                path.join(dirs.characters, `${CHAR}.json`), JSON.stringify(CARD2));
            await getChatRepo().save(HANDLE, CHAR, 'm13',
                { user_name: 'User', character_name: 'Alice', chat_metadata: {} },
                [{ is_user: true, name: 'User', mes: 'hi' }],
                null);
            const built = await buildStscriptEnv({
                handle: HANDLE, directories: dirs, charDir: CHAR, chatName: 'm13', userName: 'User',
            });
            assert.ok(!built.error, `env build failed: ${built.error}`);
            const run = await runStscript(built.env, '/sys Narrator note');
            assert.equal(run.error, undefined, `script error: ${run.error?.message}`);
            const doc = await getChatRepo().get(HANDLE, CHAR, 'm13');
            assert.ok(doc.body.some((m) => m.mes === 'Narrator note'), 'system message appended');
            assert.equal(doc.header.chat_metadata.tainted, true, 'tainted persisted to header');
            assert.equal(doc.header.user_name, 'User', 'existing header fields preserved');
        });

        await t.test('timed effects persist via persistWorldInfoTimedEffects; dryRun stays clean', async () => {
            await getSettingsRepo().save(HANDLE, {
                ...baseSettings(),
                world_info_settings: { ...baseSettings().world_info_settings, world_info: { globalSelect: ['StickyBook'] } },
            });
            await getChatRepo().save(HANDLE, CHAR, 't1',
                { user_name: 'User', chat_metadata: {} },
                [{ is_user: true, name: 'User', mes: 'dragon!' }],
                null);

            const dry = await buildGenerationContext({
                request, charDir: CHAR, chatName: 't1', card: CARD2, user: { name: 'User' }, dryRun: true,
            });
            // dryRun 不写 entry;引擎构造期仍会初始化空桶(ensureChatMetadata),
            // 断言面=每个桶零 entry 而非键不存在。
            for (const bucket of Object.values(dry.chatMetadata.timedWorldInfo ?? {})) {
                assert.equal(Object.keys(bucket ?? {}).length, 0, 'dryRun must not record effects');
            }

            const live = await buildGenerationContext({
                request, charDir: CHAR, chatName: 't1', card: CARD2, user: { name: 'User' },
            });
            assert.ok(Object.keys(live.chatMetadata.timedWorldInfo?.sticky ?? {}).length > 0, 'sticky effect recorded');
            await persistWorldInfoTimedEffects({
                request, charDir: CHAR, chatName: 't1',
                chatMetadata: live.chatMetadata, expectedIntegrity: live.chatIntegrity,
            });
            const reread = await getChatRepo().get(HANDLE, CHAR, 't1');
            assert.ok(Object.keys(reread.header.chat_metadata.timedWorldInfo?.sticky ?? {}).length > 0,
                'timedWorldInfo persisted into chat header');
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

/**
 * issue#2 端到端钉:MagVarUpdate 变量宏家族在装配全链里可用——
 * MVU 世界书条目 `{{format_message_variable::stat_data}}` 必须把楼层
 * 快照里的 stat_data 以 YAML 层级回显进 prompt;set 家族写走
 * variableWrites → persistMacroVariableWrites 落盘闭环。
 */
test('issue#2 — MVU format/set_message_variable 进 prompt + 落盘', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-macro-'));
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

        await getSettingsRepo().save(HANDLE, {
            power_user: {},
            world_info_settings: {
                world_info_depth: 2,
                world_info_budget: 100,
                world_info_recursive: false,
                world_info_include_names: false,
                world_info_match_whole_words: false,
                world_info: { globalSelect: ['MvuBook'] },
            },
            preset_settings_openai: 'Default',
            extension_settings: { variables: { global: { world: 'eden' } } },
        });
        await getPresetRepo().save(HANDLE, 'openai', 'Default', PRESET);

        // MVU 卡典型形态:status_current_variables 块 + format_message_variable。
        await getWorldInfoRepo().save(HANDLE, 'MvuBook', {
            entries: {
                '0': wiEntry(0, 'dragon', [
                    '---',
                    '<status_current_variables>',
                    '{{format_message_variable::stat_data}}',
                    '</status_current_variables>',
                ].join('\n'), 100),
                '1': wiEntry(1, 'wound', '{{set_message_variable::stat_data.hp::42}}', 90),
                '2': wiEntry(2, 'realm', '{{set_global_variable::world::utopia}}', 80),
            },
        });

        // MVU settle 形态:最新 assistant 楼携 variables[swipe_id] 快照,
        // 顶层键镜像进 chat_metadata.variables。
        const mvuSnapshot = () => ({
            stat_data: {
                hp: 80,
                inv: { sword: 1 },
                $meta: { internal: true }, // 内部键必须被剔除
            },
            schema: { type: 'object' },
        });
        const mvuFloor = (mes = 'I draw my blade.') => ({
            is_user: false, name: 'Alice', mes,
            swipe_id: 0, swipes: [mes],
            variables: { 0: mvuSnapshot() },
        });

        await t.test('format_message_variable::stat_data YAML 回显进 assembled prompt', async () => {
            await getChatRepo().save(HANDLE, CHAR, 'mvu1',
                { user_name: 'User', chat_metadata: { variables: mvuSnapshot() } },
                [
                    { is_user: true, name: 'User', mes: 'dragon' },
                    mvuFloor(),
                ],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'mvu1', card: CARD, user: { name: 'User' },
            });
            const text = allText(builtPrompt);
            assert.match(text, /<status_current_variables>/, 'MVU wrapper landed');
            assert.match(text, /hp: 80/, 'stat_data.hp rendered as YAML');
            assert.match(text, /inv:\r?\n\s+sword: 1/, 'nested subtree rendered');
            assert.doesNotMatch(text, /\$meta/, '$ internal keys stripped');
            assert.doesNotMatch(text, /\{\{format_message_variable/, 'no literal macro residue');
        });

        await t.test('set_message_variable 落盘:楼层快照 + chat_metadata.variables 双写', async () => {
            await getChatRepo().save(HANDLE, CHAR, 'mvu2',
                { user_name: 'User', chat_metadata: { variables: mvuSnapshot() } },
                [
                    { is_user: true, name: 'User', mes: 'wound' },
                    mvuFloor(),
                ],
                null);
            await buildGenerationContext({
                request, charDir: CHAR, chatName: 'mvu2', card: CARD, user: { name: 'User' },
            });
            const doc = await getChatRepo().get(HANDLE, CHAR, 'mvu2');
            const floor = doc.body[1];
            assert.equal(floor.variables[0].stat_data.hp, 42, 'floor snapshot updated on disk');
            assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 42, 'chat_metadata mirror updated on disk');
        });

        await t.test('set_global_variable 落盘:settings.extension_settings.variables.global', async () => {
            await getChatRepo().save(HANDLE, CHAR, 'mvu3',
                { user_name: 'User', chat_metadata: { variables: mvuSnapshot() } },
                [
                    { is_user: true, name: 'User', mes: 'realm' },
                    mvuFloor(),
                ],
                null);
            await buildGenerationContext({
                request, charDir: CHAR, chatName: 'mvu3', card: CARD, user: { name: 'User' },
            });
            const settings = await getSettingsRepo().get(HANDLE);
            assert.equal(settings.extension_settings.variables.global.world, 'utopia',
                'global write persisted through settings channel');
        });

        await t.test('dryRun 不落盘:set 宏只活在本请求内', async () => {
            // 上个子测试已把 global.world 写成 'utopia' —— 复位再断言。
            const cur = await getSettingsRepo().get(HANDLE);
            cur.extension_settings.variables.global.world = 'eden';
            await getSettingsRepo().save(HANDLE, cur);
            await getChatRepo().save(HANDLE, CHAR, 'mvu4',
                { user_name: 'User', chat_metadata: { variables: mvuSnapshot() } },
                [
                    { is_user: true, name: 'User', mes: 'wound realm' },
                    mvuFloor(),
                ],
                null);
            await buildGenerationContext({
                request, charDir: CHAR, chatName: 'mvu4', card: CARD, user: { name: 'User' }, dryRun: true,
            });
            const doc = await getChatRepo().get(HANDLE, CHAR, 'mvu4');
            assert.equal(doc.body[1].variables[0].stat_data.hp, 80, 'dryRun must not persist floor writes');
            assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 80, 'dryRun must not persist mirror writes');
            const settings = await getSettingsRepo().get(HANDLE);
            assert.equal(settings.extension_settings.variables.global.world, 'eden', 'dryRun must not persist global writes');
        });

        await t.test('get_char_variable 读卡级 tavern_helper 变量', async () => {
            const charCard = {
                name: 'Alice',
                data: {
                    name: 'Alice',
                    description: 'A wandering knight.',
                    mes_example: '',
                    extensions: { tavern_helper: { variables: { affection: 7 } } },
                },
            };
            await getWorldInfoRepo().save(HANDLE, 'MvuCharBook', {
                entries: { '0': wiEntry(0, 'bond', 'Affection={{get_char_variable::affection}}', 100) },
            });
            await getSettingsRepo().save(HANDLE, {
                power_user: {},
                world_info_settings: {
                    world_info_depth: 2, world_info_budget: 100, world_info_recursive: false,
                    world_info_include_names: false, world_info_match_whole_words: false,
                    world_info: { globalSelect: ['MvuCharBook'] },
                },
                preset_settings_openai: 'Default',
                extension_settings: { variables: { global: {} } },
            });
            await getChatRepo().save(HANDLE, CHAR, 'mvu5',
                { user_name: 'User', chat_metadata: {} },
                [
                    { is_user: true, name: 'User', mes: 'bond' },
                    { is_user: false, name: 'Alice', mes: 'aye.' },
                ],
                null);
            const { builtPrompt } = await buildGenerationContext({
                request, charDir: CHAR, chatName: 'mvu5', card: charCard, user: { name: 'User' },
            });
            assert.match(allText(builtPrompt), /Affection=7/, 'char variable read from card extensions');
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
