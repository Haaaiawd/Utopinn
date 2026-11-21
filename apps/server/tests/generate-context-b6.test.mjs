/**
 * TASK-051 B6 — 内置 Default 预设 openai_max_context 口径(node:test)。
 *
 * 背景:stock openai/Default.json 的 4095 是 gpt-3.5 时代上游库存值
 * (max_4k);浏览器端被滑杆/模型上限放行,API 直生成没有滑杆,大卡
 * must-fit 必炸 TokenBudgetExceededError。
 *
 * 修法两条,本文件钉住:
 *   1. seed 上调:default/content 下 Default 预设与 settings 模板都抬到
 *      128000(上游 max_128k 未知模型档兜底),新装不再卡。
 *   2. 存量抬升:buildGenerationContext 只对「openai/Default 名 + ≤4095
 *      遗物值」抬到 128000——换名复制的预设/用户动过的值视为意图不碰。
 *
 * 跑法:node --test tests/generate-context-b6.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    getChatRepo,
    getPresetRepo,
    getSettingsRepo,
    initStorage,
} from '../src/storage/index.js';
import { buildGenerationContext } from '../src/services/generate-context.js';
import { query as diagQuery } from '../src/services/diag-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLE = 'h1';
const CHAR = 'Alice';

const ORDER = ['main', 'worldInfoBefore', 'chatHistory', 'worldInfoAfter', 'jailbreak'];

const PRESET = {
    openai_model: 'gpt-test',
    openai_max_context: 4095,
    openai_max_tokens: 100,
    prompts: [
        { identifier: 'main', role: 'system', content: 'You are {{char}}. {{user}} speaks.' },
        { identifier: 'worldInfoBefore', role: 'system', marker: true, content: '' },
        { identifier: 'chatHistory', role: 'system', marker: true, content: '' },
        { identifier: 'worldInfoAfter', role: 'system', marker: true, content: '' },
        { identifier: 'jailbreak', role: 'system', content: '' },
    ],
    prompt_order: [{ character_id: 100001, order: ORDER.map((identifier) => ({ identifier, enabled: true })) }],
};

// ~6000 token 大卡:4095 预算必炸,128000 绰绰有余。
const BIG_CARD = {
    name: 'Alice',
    data: {
        name: 'Alice',
        description: 'lorem ipsum dolor sit amet '.repeat(1500),
        personality: 'stoic',
        scenario: 'A ruined kingdom.',
        mes_example: '',
        extensions: {},
    },
};

function makeDirs() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-b6-'));
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
    return { tmpDir, dirs };
}

async function seedBase(dirs, presetName) {
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
    await getSettingsRepo().save(HANDLE, {
        power_user: {},
        preset_settings_openai: presetName,
    });
    await getChatRepo().save(HANDLE, CHAR, 'c1',
        { user_name: 'User', chat_metadata: {} },
        [{ is_user: true, name: 'User', mes: 'hello' }],
        null);
}

test('B6 — Default 遗物值 4095 抬升:大卡组装成功,inject 面报 128000', async () => {
    const { tmpDir, dirs } = makeDirs();
    try {
        await seedBase(dirs, 'Default');
        // 存量 dataRoot 情形:stock Default 还躺着 gpt-3.5 时代的 4095。
        await getPresetRepo().save(HANDLE, 'openai', 'Default', { ...PRESET, openai_max_context: 4095 });
        const since = Date.now();
        const request = { user: { profile: { handle: HANDLE, name: 'User' } } };

        const { builtPrompt } = await buildGenerationContext({
            request, charDir: CHAR, chatName: 'c1', card: BIG_CARD, user: { name: 'User' },
        });
        assert.match(
            builtPrompt.messages.map((m) => String(m.content)).join('\n'),
            /lorem ipsum/,
            '大卡描述必须进入组装结果(抬升后预算装得下)');

        // inject:preset 事件的 contextTokens = 生效预算——抬到 128000 而非 4095。
        const presetEvts = diagQuery({ kind: 'inject', code: 'preset', since });
        assert.equal(presetEvts.length, 1);
        assert.equal(presetEvts[0].data.contextTokens, 128000);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('B6 — 抬升口径收窄:换名预设的 4095 视为意图,不抬', async () => {
    const { tmpDir, dirs } = makeDirs();
    try {
        await seedBase(dirs, 'TinyCopy');
        // 同一数值、不同名 = 用户自建预设,不是 stock Default 遗物 → 保留
        await getPresetRepo().save(HANDLE, 'openai', 'TinyCopy', { ...PRESET, openai_max_context: 4095 });
        const request = { user: { profile: { handle: HANDLE, name: 'User' } } };

        await assert.rejects(
            buildGenerationContext({
                request, charDir: CHAR, chatName: 'c1', card: BIG_CARD, user: { name: 'User' },
            }),
            /Token budget exceeded/,
            '非 Default 名的 4095 是用户意图——照炸,不被静默抬升');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('B6 — Default 上用户动过的值(50000)不抬:尊重显式意图', async () => {
    const { tmpDir, dirs } = makeDirs();
    try {
        await seedBase(dirs, 'Default');
        await getPresetRepo().save(HANDLE, 'openai', 'Default', { ...PRESET, openai_max_context: 50000 });
        const since = Date.now();
        const request = { user: { profile: { handle: HANDLE, name: 'User' } } };

        await buildGenerationContext({
            request, charDir: CHAR, chatName: 'c1', card: BIG_CARD, user: { name: 'User' },
        });
        const presetEvts = diagQuery({ kind: 'inject', code: 'preset', since });
        assert.equal(presetEvts.length, 1);
        assert.equal(presetEvts[0].data.contextTokens, 50000, '用户调过的 Default 值原样生效');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('B6 — seed 口径:default/content 两处的库存值已是 128000', () => {
    const preset = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../default/content/presets/openai/Default.json'), 'utf8'));
    assert.equal(preset.openai_max_context, 128000, 'seed Default.json 抬到现代兜底位');

    const settings = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../default/content/settings.json'), 'utf8'));
    assert.equal(settings.oai_settings.openai_max_context, 128000,
        'settings 模板同步口径(与 Default 预设镜像)');
});
