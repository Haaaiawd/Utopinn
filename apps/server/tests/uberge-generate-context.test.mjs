/**
 * buildGenerationContext 集成测试(node:test,无 jest 依赖)。
 * 真 FsEngine + 种子数据:chat/preset/settings/world 四 repo →
 * mergeLoreSources → checkWorldInfo → buildPromptMessages 全链。
 * 跑法:node --test tests/uberge-generate-context.test.mjs
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-genctx-'));
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

        await t.test('missing chat/preset fail loud', async () => {
            await assert.rejects(
                buildGenerationContext({ request, charDir: CHAR, chatName: 'ghost', card: CARD, user: { name: 'User' } }),
                /Chat not found/);
            await assert.rejects(
                buildGenerationContext({ request, charDir: CHAR, chatName: 'c1', card: CARD, presetName: 'NoSuch', user: { name: 'User' } }),
                /Preset not found/);
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-genctx2-'));
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
