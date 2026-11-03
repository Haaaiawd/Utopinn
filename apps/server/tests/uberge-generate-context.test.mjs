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
import { buildGenerationContext } from '../src/services/generate-context.js';

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
                selected_world_info: ['GlobalBook'],
                persona_description: 'I am me.',
            },
            world_info: { charLore: [{ name: CHAR, extraBooks: ['CharBook'] }] },
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
