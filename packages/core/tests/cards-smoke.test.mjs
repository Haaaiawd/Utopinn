/**
 * 新卡 smoke(无 golden):assets/ 里每张 PNG 走
 * formats 解析 → 卡字段 baseReplace → embedded book → mergeLoreSources
 * → checkWorldInfo → buildPromptMessages,断言不崩+结构合理。
 * 目的:把"能解析"验证延伸到"能组装",golden 判卷的前哨。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildPromptMessages,
    checkWorldInfo,
    mergeLoreSources,
    substituteParams,
    world_info_insertion_strategy,
} from '../dist/index.js';
import {
    readCardFromPng,
    convertCharacterBook,
    getEmbeddedBook,
    getBoundWorldName,
    cardData,
} from '@utopinn/formats';
import {
    CAPTURED_OAI_SETTINGS,
    CAPTURED_PROMPTS,
    CAPTURED_PROMPT_ORDER,
    CAPTURED_WI_SETTINGS,
    CAPTURED_MAX_CONTEXT,
    CAPTURED_MAX_TOKENS,
    countTokens,
} from './golden-env.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets');
const EXT_IN_CHAT = 1;

/** 与 golden-env buildFixture 同管线的卡→BuiltPrompt(无 golden 版) */
async function assembleCard(pngPath) {
    const card = JSON.parse(readCardFromPng(readFileSync(pngPath)));
    const d = cardData(card);
    const name1 = 'User';
    const name2 = d.name ?? 'char';
    const genChat = [
        { name: name2, is_user: false, mes: d.first_mes ?? '' },
        { name: name1, is_user: true, mes: 'hi' },
    ];
    const baseReplace = (v) => (typeof v !== 'string' || !v.length)
        ? ''
        : substituteParams(v, { name1, name2, chat: genChat, chatMetadata: {}, globalVariables: {} }, { replaceCharacterCard: false }).replace(/\r/g, '');
    const cardFields = Object.fromEntries(Object.entries({
        system: d.system_prompt ?? '', mesExamples: d.mes_example ?? '',
        description: d.description ?? '', personality: d.personality ?? '',
        persona: '', scenario: d.scenario ?? '',
        jailbreak: d.post_history_instructions ?? '',
        version: d.character_version ?? '',
        charDepthPrompt: d.extensions?.depth_prompt?.prompt ?? '',
        creatorNotes: d.creator_notes ?? '', firstMessage: d.first_mes ?? '',
    }).map(([k, v]) => [k, baseReplace(v)]));

    const substCtx = { name1, name2, chat: genChat, chatMetadata: {}, globalVariables: {}, cardFields, mainApi: 'openai' };
    const extensionPrompts = {};
    const dp = d.extensions?.depth_prompt;
    if (dp?.prompt) {
        extensionPrompts.DEPTH_PROMPT = { value: baseReplace(dp.prompt), position: EXT_IN_CHAT, depth: Number(dp.depth ?? 4), scan: true, role: Number(dp.role ?? 0) };
    }
    const book = getEmbeddedBook(card);
    const boundWorld = getBoundWorldName(card) ?? '_embedded';
    const worldData = book ? convertCharacterBook(book) : null;
    const sortedEntries = worldData
        ? mergeLoreSources({ selectedWorlds: [], characterPrimaryWorld: boundWorld, chatWorlds: [], insertionStrategy: world_info_insertion_strategy.character_first, getWorldData: (n) => (n === boundWorld ? worldData : undefined) })
        : [];
    const chatForWI = genChat.map((m) => `${m.name}: ${m.mes}`).reverse();
    const wiResult = sortedEntries.length
        ? await checkWorldInfo(chatForWI, CAPTURED_MAX_CONTEXT, false, {
            trigger: 'normal', personaDescription: cardFields.persona, characterDescription: cardFields.description,
            characterPersonality: cardFields.personality, characterDepthPrompt: cardFields.charDepthPrompt,
            scenario: cardFields.scenario, creatorNotes: cardFields.creatorNotes,
        }, {
            sortedEntries, chatMetadata: {}, settings: CAPTURED_WI_SETTINGS,
            substituteParams: (s) => substituteParams(s, substCtx), countTokens,
            scannableExtensionPrompts: Object.values(extensionPrompts).filter((p) => p.scan && p.value).map((p) => substituteParams(p.value, substCtx)),
        })
        : { worldInfoBeforeEntries: [], worldInfoAfterEntries: [], WIDepthEntries: [] };
    for (const g of wiResult.WIDepthEntries ?? []) {
        extensionPrompts[`customDepthWI_${g.depth}_${g.role}`] = { value: (g.entries ?? []).join('\n'), position: EXT_IN_CHAT, depth: g.depth, scan: false, role: g.role };
    }

    // WI EM 条目并入 mesExample(<START> 切块语义)
    let mesExample = cardFields.mesExamples;
    const emBlock = (s) => `<START>\n${String(s).replace(/\r/gm, '').trim()}\n`;
    const emBefore = (wiResult.EMEntries ?? []).filter((e) => Number(e.position) === 0).map((e) => e.content).filter(Boolean);
    const emAfter = (wiResult.EMEntries ?? []).filter((e) => Number(e.position) !== 0).map((e) => e.content).filter(Boolean);
    if (emBefore.length || emAfter.length) {
        mesExample = [...emBefore.map(emBlock), mesExample, ...emAfter.map(emBlock)].filter(Boolean).join('');
    }

    const ROLE_NAME = ['system', 'user', 'assistant'];
    const depthInjection = async (depth, role) => {
        const roleNum = ROLE_NAME.indexOf(role);
        return Object.keys(extensionPrompts).sort()
            .map((k) => extensionPrompts[k])
            .filter((p) => p.position === EXT_IN_CHAT && p.value)
            .filter((p) => p.depth === undefined || p.depth === depth)
            .filter((p) => p.role === undefined || p.role === roleNum)
            .map((p) => String(p.value).trim()).join('\n');
    };
    const reqExtensionPrompts = {};
    for (const [k, p] of Object.entries(extensionPrompts)) {
        if (p.value && p.position !== EXT_IN_CHAT) reqExtensionPrompts[k] = p;
    }

    const req = {
        card: { name: name2, description: cardFields.description, personality: cardFields.personality, scenario: cardFields.scenario, mesExample, systemPromptOverride: '', jailbreakOverride: cardFields.jailbreak },
        user: { name: name1, description: '' },
        chat: genChat,
        prompts: CAPTURED_PROMPTS.map((p) => ({ ...p })),
        promptOrder: CAPTURED_PROMPT_ORDER.map((o) => ({ ...o })),
        settings: { ...CAPTURED_OAI_SETTINGS },
        contextTokens: CAPTURED_MAX_CONTEXT, responseTokens: CAPTURED_MAX_TOKENS,
        worldInfo: { beforeEntries: wiResult.worldInfoBeforeEntries ?? [], afterEntries: wiResult.worldInfoAfterEntries ?? [] },
        extensionPrompts: reqExtensionPrompts,
        type: 'normal', api: 'custom', model: 'smoke-mock',
    };
    const built = await buildPromptMessages(req, { substCtx, countTokens, depthInjection, maxDepth: 10000, warn: () => {} });
    return { built, card: d, wiEntries: sortedEntries.length, activated: (wiResult.worldInfoBeforeEntries?.length ?? 0) + (wiResult.worldInfoAfterEntries?.length ?? 0), depthInjects: (wiResult.WIDepthEntries ?? []).length };
}

test('assets/ 新卡 smoke:解析→WI→组装 不崩', async (t) => {
    assert.ok(existsSync(ASSETS), 'assets/ exists');
    const pngs = readdirSync(ASSETS).filter((f) => f.endsWith('.png')).sort();
    assert.ok(pngs.length >= 5, `expected ≥5 pngs, got ${pngs.length}`);
    for (const f of pngs) {
        await t.test(f, async () => {
            const r = await assembleCard(join(ASSETS, f));
            assert.ok(r.built.messages.length >= 2, `${r.card.name}: got ${r.built.messages.length} messages`);
            assert.ok(r.built.messages.every((m) => typeof m.role === 'string'), 'roles valid');
            const joined = r.built.messages.map((m) => String(m.content)).join('\n');
            assert.ok(!joined.includes('{{char}}'), 'no raw {{char}} leaks');
            assert.ok(!joined.includes('{{user}}'), 'no raw {{user}} leaks');
            console.log(`# ${r.card.name}: msgs=${r.built.messages.length} wiBook=${r.wiEntries} wiHit=${r.activated} depthInj=${r.depthInjects}`);
        });
    }
});
