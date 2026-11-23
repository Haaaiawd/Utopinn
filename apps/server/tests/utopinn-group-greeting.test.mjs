/**
 * 群聊首开问候播种 + group_only_greetings 消费 + PATCH 放行面(TASK-068)。
 * 真 FsEngine + 种子卡 + 真 express + 真 HTTP;语义锚点:
 *   - 上游 group-chats.js getGroupChat 空聊分支 + getFirstCharacterMessage
 *     ([first_mes, ...alternate_greetings].filter(x=>x) 先滤空再随机挑)
 *   - 官方 Extension-GroupGreetings:data.group_only_greetings(specV3)优先,
 *     data.extensions.group_greetings(legacy)兜底;池非空整体覆盖 base 挑选;
 *     group_greetings_mode 0=RANDOM/1=PICK(服务端 PICK 退化 random)。
 *   - PATCH 放行集 = 消费集:talkativeness/depth_prompt/group_greetings/
 *     group_greetings_mode + data.alternate_greetings/group_only_greetings;
 *     fav/tavern_helper 钉死不放行。
 *   - 幂等:已有楼层绝不补种;并发首开不双种(createIfAbsent/save CAS)。
 * 跑法:node --test tests/utopinn-group-greeting.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { readCardFromPng, writeCardToPng } from '@utopinn/formats';
import {
    getChatRepo,
    getSettingsRepo,
    initStorage,
} from '../src/storage/index.js';
import { buildGroupGreetingFloors } from '../src/services/greeting-seed.js';
import { buildRosterEntry, selectActivatedMembers } from '../src/services/group-orchestration.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
// 插件经 secrets.js 在模块级读 config —— 静态 import 会抢在 setConfigFilePath 前
// 炸掉,改在 test.before 里动态 import(config 就绪后)。

const HANDLE = 'u1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

// 与 tests/storage/harness/fs-harness.js USER_DIRS 同构(FsEngine 按 dirKey 寻址)
const USER_DIRS = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

let ROOT;
let dirs;
let server;
let BASE;

const card = (data) => JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    name: data.name,
    data: { name: data.name, ...data.fields, extensions: data.extensions ?? {} },
});

/** 种子卡表 —— 每张卡一个变量位,方便逐源断言。 */
const SEED_CARDS = {
    // spec v3 data.group_only_greetings:整体覆盖 first_mes/alternate
    GA: card({ name: 'GA', fields: {
        first_mes: 'GA solo greet',
        alternate_greetings: ['GA alt'],
        group_only_greetings: ['GA group greet for {{user}}'],
    } }),
    // 无群问候 → base 池 first_mes(无 alternate_greetings 键 → 直取)
    GB: card({ name: 'GB', fields: { first_mes: 'GB first says {{char}}' } }),
    // legacy extensions.group_greetings 位
    GC: card({ name: 'GC', fields: { first_mes: 'GC solo' },
        extensions: { group_greetings: ['GC legacy group'] } }),
    // specV3 空 + legacy 非空 → legacy 兜底
    GD: card({ name: 'GD', fields: { first_mes: 'GD solo', group_only_greetings: [] },
        extensions: { group_greetings: ['GD legacy wins'] } }),
    // 双源并存 → specV3 优先
    GE: card({ name: 'GE', fields: { first_mes: 'GE solo', group_only_greetings: ['GE spec greet'] },
        extensions: { group_greetings: ['GE legacy lose'] } }),
    // mode=PICK(1) → 服务端退化 random,仍从群池挑
    GF: card({ name: 'GF', fields: { first_mes: 'GF solo' },
        extensions: { group_greetings: ['GF pick greet'], group_greetings_mode: 1 } }),
    // mode=2(异常值)→ 上游两支不进,不覆盖,落回 first_mes
    GG: card({ name: 'GG', fields: { first_mes: 'GG base first' },
        extensions: { group_greetings: ['GG should not appear'], group_greetings_mode: 2 } }),
    // 完全无问候 → 不产楼
    SilentX: card({ name: 'SilentX', fields: { first_mes: '', extensions: {} } }),
    // first_mes 空 + 单 alternate → 上游滤空后必中 alternate(修版语义)
    AltOnly: card({ name: 'AltOnly', fields: { first_mes: '', alternate_greetings: ['AO alt speaks'] } }),
};

async function api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + pathname, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const groupChatUrl = (gid, chatId) =>
    '/api/utopinn/groups/' + encodeURIComponent(gid) + '/chats/' + encodeURIComponent(chatId);
const groupChatOpts = (chatId) => ({ isGroup: true, groupId: String(chatId) });
const readGroupChat = (chatId) => getChatRepo().get(HANDLE, '', String(chatId), groupChatOpts(chatId));

/** POST /groups 的 id=Date.now() 串 —— 同毫秒连建会撞 id,建前让出 2ms。 */
async function createGroup(members, extra = {}) {
    await sleep(2);
    const res = await api('/api/utopinn/groups', {
        method: 'POST',
        body: { name: 'g', members, ...extra },
    });
    assert.equal(res.status, 201, 'group create failed: ' + JSON.stringify(res.body));
    return res.body;
}

test.before(async () => {
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

    const { apply: applyUtopinnLibrary } = await import('../src/plugins/utopinn-library.js');
    const utopinnLibraryRouter = express.Router();
    const ws = {
        register: (spec) => {
            utopinnLibraryRouter[String(spec.method || 'GET').toLowerCase()](spec.path, spec.handler);
            return () => {};
        },
    };
    applyUtopinnLibrary({ webServer: ws, effect: (fn) => (typeof fn === 'function' ? fn() : undefined) });

    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-ggreet-'));
    dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(ROOT, rel);
    }
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    fs.mkdirSync(dirs.groupChats, { recursive: true });
    fs.mkdirSync(dirs.groups, { recursive: true });
    await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });

    for (const [stem, json] of Object.entries(SEED_CARDS)) {
        fs.writeFileSync(path.join(dirs.characters, stem + '.json'), json);
    }

    await getSettingsRepo().save(HANDLE, {
        power_user: {
            personas: { 'ava.png': 'Mia' },
            default_persona: 'ava.png',
        },
        extension_settings: { variables: { global: { seed: 'g' } } },
    });

    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
        next();
    });
    app.use(utopinnLibraryRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    BASE = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => {
    server?.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 纯函数层:挑选池 + 上游滤空语义
// ---------------------------------------------------------------------------

test('纯函数:roster 序 = 楼层序;specV3 优先 / legacy 兜底 / 无池落 base', async () => {
    const load = (stem) => JSON.parse(fs.readFileSync(path.join(dirs.characters, stem + '.json'), 'utf8'));
    const roster = ['GA', 'GB', 'GC', 'GD', 'GE', 'GF', 'GG']
        .map((stem) => buildRosterEntry(stem + '.png', load(stem)));
    const floors = buildGroupGreetingFloors({ roster, name1: 'Mia', chatMetadata: {}, chatName: 'unit' });
    assert.equal(floors.length, 7);
    assert.deepEqual(floors.map((f) => f.original_avatar),
        ['GA.png', 'GB.png', 'GC.png', 'GD.png', 'GE.png', 'GF.png', 'GG.png']);
    assert.equal(floors[0].mes, 'GA group greet for Mia');   // specV3 覆盖
    assert.equal(floors[1].mes, 'GB first says GB');          // base first_mes
    assert.equal(floors[2].mes, 'GC legacy group');           // legacy 位
    assert.equal(floors[3].mes, 'GD legacy wins');            // specV3 空 → legacy
    assert.equal(floors[4].mes, 'GE spec greet');             // specV3 优先
    assert.equal(floors[5].mes, 'GF pick greet');             // PICK 退化 random
    assert.equal(floors[6].mes, 'GG base first');             // mode=2 不覆盖
    for (const f of floors) {
        assert.equal(f.is_user, false);
        assert.equal(f.is_system, false);
        assert.equal(typeof f.send_date, 'string');
        assert.equal(f.force_avatar, '/thumbnail?type=avatar&file=' + encodeURIComponent(f.original_avatar));
        assert.equal(f.swipes, undefined); // 上游群问候不建 swipe 组
    }
});

test('纯函数:上游 .filter(x=>x) 先滤空 —— first_mes 空 + 单 alternate 必发言', async () => {
    const load = (stem) => JSON.parse(fs.readFileSync(path.join(dirs.characters, stem + '.json'), 'utf8'));
    const roster = [buildRosterEntry('AltOnly.png', load('AltOnly')), buildRosterEntry('SilentX.png', load('SilentX'))];
    // 旧实现不滤空,50% 挑中 '' → 沉默;修版 40 连跑恒产 AO 楼。
    for (let i = 0; i < 40; i++) {
        const floors = buildGroupGreetingFloors({ roster, name1: 'Mia', chatMetadata: {}, chatName: 'u' + i });
        assert.equal(floors.length, 1, 'run ' + i);
        assert.equal(floors[0].mes, 'AO alt speaks');
        assert.equal(floors[0].original_avatar, 'AltOnly.png');
    }
});

test('纯函数:成员卡群问候含宏 —— {{char}} 展开为该成员名', async () => {
    const macroCard = {
        spec: 'chara_card_v2', spec_version: '2.0', name: 'Macro',
        data: { name: 'Macro', first_mes: 'x', group_only_greetings: ['I am {{char}}, hi {{user}}.'], extensions: {} },
    };
    const floors = buildGroupGreetingFloors({
        roster: [buildRosterEntry('Macro.png', macroCard)], name1: 'Mia', chatMetadata: {}, chatName: 'm',
    });
    assert.equal(floors.length, 1);
    assert.equal(floors[0].mes, 'I am Macro, hi Mia.');
});

// ---------------------------------------------------------------------------
// talkativeness 进成员选择权重(编排断言 —— 验收 2 前半)
// ---------------------------------------------------------------------------

test('编排:talkativeness=1 成员在 NATURAL 序恒激活(权重消费钉死)', async () => {
    const cardOf = (talk) => ({ data: { name: 'c', extensions: talk === undefined ? {} : { talkativeness: talk } } });
    const roster = [
        buildRosterEntry('hot.png', cardOf(1)),
        buildRosterEntry('cold.png', cardOf(0)),
    ];
    const group = { members: ['hot.png', 'cold.png'], disabled_members: [], activation_strategy: 0 };
    for (let i = 0; i < 40; i++) {
        const { activated } = selectActivatedMembers({
            group, roster, chat: [], type: 'normal', isUserInput: false, activationText: '',
        });
        assert.ok(activated.includes('hot.png'), 'run ' + i + ' hot not activated: ' + JSON.stringify(activated));
    }
});

// ---------------------------------------------------------------------------
// 服务端链路:POST /groups → 默认群会话按 roster 播种
// ---------------------------------------------------------------------------

test('POST /groups:默认群会话按 roster 序播种各成员问候', async () => {
    const group = await createGroup(['GA.png', 'GB.png', 'GC.png', 'GD.png', 'GE.png', 'GF.png', 'GG.png', 'SilentX.png']);
    const chat = await readGroupChat(group.chat_id);
    assert.ok(chat, 'default group chat missing');
    // SilentX 无问候不产楼 → 7 楼,序 = members 序(滤除 SilentX 后)
    assert.equal(chat.body.length, 7);
    assert.deepEqual(chat.body.map((f) => f.original_avatar),
        ['GA.png', 'GB.png', 'GC.png', 'GD.png', 'GE.png', 'GF.png', 'GG.png']);
    assert.equal(chat.body[0].mes, 'GA group greet for Mia');
    assert.equal(chat.body[4].mes, 'GE spec greet');
    assert.equal(chat.body[6].mes, 'GG base first');
    for (const f of chat.body) {
        assert.equal(f.is_user, false);
        assert.equal(f.is_system, false);
        assert.ok(f.extra && typeof f.extra.gen_id === 'number');
    }
});

test('GET 群会话(已播种):不重复播种,messages 透出原楼层', async () => {
    const group = await createGroup(['GA.png', 'GB.png']);
    const first = await api(groupChatUrl(group.id, group.chat_id));
    assert.equal(first.status, 200);
    assert.equal(first.body.messages.length, 2);
    assert.equal(first.body.greeting_seeded, undefined); // 非首开 → 不报播种
    const second = await api(groupChatUrl(group.id, group.chat_id));
    assert.equal(second.status, 200);
    assert.equal(second.body.messages.length, 2);
    const chat = await readGroupChat(group.chat_id);
    assert.equal(chat.body.filter((f) => f.mes === 'GA group greet for Mia').length, 1);
});

// ---------------------------------------------------------------------------
// GET 首开空聊 → 播种(上游 openGroupChat 空聊分支)+ 并发不双种
// ---------------------------------------------------------------------------

test('GET 首开空聊:按当时 roster 播种,二次 GET 不补种', async () => {
    const group = await createGroup(['SilentX.png']); // 沉默成员 → 默认会话空
    let chat = await readGroupChat(group.chat_id);
    assert.equal(chat.body.length, 0);
    // 编辑 roster 换上有问候的成员
    const patched = await api('/api/utopinn/groups/' + group.id, {
        method: 'PATCH', body: { members: ['GA.png', 'GB.png'] },
    });
    assert.equal(patched.status, 200);
    const opened = await api(groupChatUrl(group.id, group.chat_id));
    assert.equal(opened.status, 200);
    assert.equal(opened.body.greeting_seeded, true);
    assert.equal(opened.body.messages.length, 2);
    assert.equal(opened.body.messages[0].mes, 'GA group greet for Mia');
    chat = await readGroupChat(group.chat_id);
    assert.equal(chat.body.length, 2);
    // 幂等:二开不补
    const again = await api(groupChatUrl(group.id, group.chat_id));
    assert.equal(again.body.greeting_seeded, undefined);
    assert.equal(again.body.messages.length, 2);
});

test('并发首开不双种:N 个并行 GET 空聊只落一次问候', async () => {
    const group = await createGroup(['SilentX.png']);
    await api('/api/utopinn/groups/' + group.id, { method: 'PATCH', body: { members: ['GA.png', 'GC.png'] } });
    const results = await Promise.all([
        api(groupChatUrl(group.id, group.chat_id)),
        api(groupChatUrl(group.id, group.chat_id)),
        api(groupChatUrl(group.id, group.chat_id)),
    ]);
    for (const r of results) assert.equal(r.status, 200);
    const chat = await readGroupChat(group.chat_id);
    // CAS 败者重读 → 无论谁赢,问候只落一次(2 成员 × 1 楼)
    assert.equal(chat.body.length, 2);
    assert.equal(chat.body.filter((f) => f.mes === 'GA group greet for Mia').length, 1);
    assert.equal(chat.body.filter((f) => f.mes === 'GC legacy group').length, 1);
});

// ---------------------------------------------------------------------------
// POST chats 建群会话 + messages 缺失即建 + 并发
// ---------------------------------------------------------------------------

test('POST chats 建群会话:播种 + 重名 409;并发双建只赢一次', async () => {
    const group = await createGroup(['GA.png', 'GB.png']);
    const cid = 'named-' + Date.now();
    const created = await api(groupChatUrl(group.id, cid), { method: 'POST', body: {} });
    assert.equal(created.status, 201);
    assert.equal(created.body.greeting_seeded, true);
    const dup = await api(groupChatUrl(group.id, cid), { method: 'POST', body: {} });
    assert.equal(dup.status, 409);
    const chat = await readGroupChat(cid);
    assert.equal(chat.body.length, 2);

    const cid2 = 'race-' + Date.now();
    const [a, b] = await Promise.all([
        api(groupChatUrl(group.id, cid2), { method: 'POST', body: {} }),
        api(groupChatUrl(group.id, cid2), { method: 'POST', body: {} }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const raced = await readGroupChat(cid2);
    assert.equal(raced.body.length, 2); // 一次播种,无双份
});

test('POST messages 缺失即建:问候楼在前、posted 楼在后;重发不补种', async () => {
    const group = await createGroup(['GA.png', 'GB.png']);
    const cid = 'append-' + Date.now();
    const userMsg = { name: 'Mia', is_user: true, is_system: false, mes: 'hi all', send_date: new Date().toISOString(), extra: {} };
    const res = await api(groupChatUrl(group.id, cid) + '/messages', { method: 'POST', body: { message: userMsg } });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, true);
    assert.equal(res.body.greeting_seeded, true);
    const chat = await readGroupChat(cid);
    assert.equal(chat.body.length, 3);
    assert.equal(chat.body[0].mes, 'GA group greet for Mia');
    assert.equal(chat.body[1].mes, 'GB first says GB');
    assert.equal(chat.body[2].mes, 'hi all');
    // 已有楼层 → 不再播种
    const again = await api(groupChatUrl(group.id, cid) + '/messages', {
        method: 'POST', body: { message: { ...userMsg, mes: 'second' } },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.greeting_seeded, undefined);
    const after = await readGroupChat(cid);
    assert.equal(after.body.filter((f) => f.mes === 'GA group greet for Mia').length, 1);
    assert.equal(after.body.length, 4);
});

test('并发首写不双种:两路 POST messages 同撞缺失会话', async () => {
    const group = await createGroup(['GA.png']);
    const cid = 'race-msg-' + Date.now();
    const m = (text) => ({ name: 'Mia', is_user: true, is_system: false, mes: text, send_date: new Date().toISOString(), extra: {} });
    const [a, b] = await Promise.all([
        api(groupChatUrl(group.id, cid) + '/messages', { method: 'POST', body: { message: m('first-racer') } }),
        api(groupChatUrl(group.id, cid) + '/messages', { method: 'POST', body: { message: m('second-racer') } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const chat = await readGroupChat(cid);
    // 一人赢 createIfAbsent(问候+posted),另一人走 append —— 问候 1 次、用户楼 2 条
    assert.equal(chat.body.filter((f) => f.mes === 'GA group greet for Mia').length, 1);
    assert.equal(chat.body.filter((f) => f.is_user).length, 2);
    assert.equal(chat.body.length, 3);
});

// ---------------------------------------------------------------------------
// PATCH 放行面 = 消费集(验收 2 后半)
// ---------------------------------------------------------------------------

test('PATCH 放行:talkativeness/depth_prompt/group_greetings/group_greetings_mode', async () => {
    const res = await api('/api/utopinn/characters/GB', {
        method: 'PATCH',
        body: { extensions: {
            talkativeness: 0.8,
            depth_prompt: { prompt: 'Stay feral.', depth: 2, role: 'system' },
            group_greetings: ['GB patched group greet'],
            group_greetings_mode: 1,
        } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ext = res.body.data.extensions;
    assert.equal(ext.talkativeness, 0.8);
    assert.deepEqual(ext.depth_prompt, { prompt: 'Stay feral.', depth: 2, role: 'system' });
    assert.deepEqual(ext.group_greetings, ['GB patched group greet']);
    assert.equal(ext.group_greetings_mode, 1);
});

test('PATCH 放行:data.alternate_greetings / data.group_only_greetings(真实消费位)', async () => {
    const res = await api('/api/utopinn/characters/GB', {
        method: 'PATCH',
        body: { alternate_greetings: ['GB alt new'], group_only_greetings: ['GB group new'] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.alternate_greetings, ['GB alt new']);
    assert.deepEqual(res.body.data.group_only_greetings, ['GB group new']);
});

test('PATCH 钉死:fav / tavern_helper / 未知键不放行;坏型回 422', async () => {
    for (const bad of [
        { extensions: { fav: true } },
        { extensions: { tavern_helper: { variables: {} } } },
        { extensions: { card_app: {} } },
        { extensions: { unknown_key: 1 } },
    ]) {
        const res = await api('/api/utopinn/characters/GB', { method: 'PATCH', body: bad });
        assert.equal(res.status, 400, JSON.stringify(bad) + ' → ' + res.status);
    }
    for (const bad of [
        { group_only_greetings: 'not-an-array' },
        { alternate_greetings: [1, 2] },
        { extensions: { talkativeness: 'loud' } },
        { extensions: { group_greetings: 'nope' } },
        { extensions: { group_greetings_mode: 2 } },
        { extensions: { depth_prompt: 'x' } },
        { extensions: { depth_prompt: { depth: 'deep' } } },
    ]) {
        const res = await api('/api/utopinn/characters/GB', { method: 'PATCH', body: bad });
        assert.equal(res.status, 422, JSON.stringify(bad) + ' → ' + res.status);
    }
});

test('PATCH 写后消费闭环:群问候改池 → 新群会话按新池播种', async () => {
    await api('/api/utopinn/characters/GA', {
        method: 'PATCH', body: { group_only_greetings: ['GA REWRITTEN greet'] },
    });
    const group = await createGroup(['GA.png']);
    const chat = await readGroupChat(group.chat_id);
    assert.equal(chat.body.length, 1);
    assert.equal(chat.body[0].mes, 'GA REWRITTEN greet');
});

// ---------------------------------------------------------------------------
// PR#25 黄 1:flat PNG 卡(无 data)PATCH group_only_greetings
//   → toStoredV2Character legacy→data 提升映射接住,存进 data.*
//   → 群起手读池命中(此前根层滞留,data.* 读位落空)
// ---------------------------------------------------------------------------

test('PR25-1:flat PNG 卡 PATCH group_only_greetings → 升格 data.* → 建群读池命中', async () => {
    // flat 卡:无 data/spec(v1 形) —— loadCharacterDoc 探测序 png→json
    const flat = { name: 'FlatPng', first_mes: 'flat solo first' };
    fs.writeFileSync(path.join(dirs.characters, 'FlatPng.png'),
        writeCardToPng(new Uint8Array(PNG_1PX), JSON.stringify(flat)));

    const patched = await api('/api/utopinn/characters/FlatPng', {
        method: 'PATCH', body: { group_only_greetings: ['flat png group greet'] },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    // 落盘 PNG 回读:字段必须在 data.*,根层不得滞留
    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'FlatPng.png'))));
    assert.deepEqual(stored.data.group_only_greetings, ['flat png group greet']);
    assert.equal(stored.group_only_greetings, undefined, 'root copy must be promoted away');

    // 读池命中:建群 → 问候楼来自新池
    const group = await createGroup(['FlatPng.png']);
    const chat = await readGroupChat(group.chat_id);
    assert.equal(chat.body.length, 1);
    assert.equal(chat.body[0].mes, 'flat png group greet');
    assert.equal(chat.body[0].original_avatar, 'FlatPng.png');
});

// ---------------------------------------------------------------------------
// PR#25 黄 2:PATCH 显式 null = 整字段删除
//   双存形(根+data 双副本)下连根副本一起删 —— 否则 PNG 写盘
//   toStoredV2Character 把旧根值提升复活,JSON 卡读面 ?? 回落根值。
//   「字段缺席」≠「显式 null」:缺席不得动根副本。
// ---------------------------------------------------------------------------

test('PR25-2a:双存形 PNG 卡 PATCH alternate_greetings:null → 根 data 皆无', async () => {
    // 双存形:ST 运行时镜像会在根层留 data 字段副本
    const dual = {
        spec: 'chara_card_v2', spec_version: '2.0',
        name: 'Dual',
        alternate_greetings: ['root stale alt'],
        data: {
            name: 'Dual',
            first_mes: 'dual first',
            alternate_greetings: ['data alt'],
            extensions: {},
        },
    };
    fs.writeFileSync(path.join(dirs.characters, 'Dual.png'),
        writeCardToPng(new Uint8Array(PNG_1PX), JSON.stringify(dual)));

    const patched = await api('/api/utopinn/characters/Dual', {
        method: 'PATCH', body: { alternate_greetings: null },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const stored = JSON.parse(readCardFromPng(fs.readFileSync(path.join(dirs.characters, 'Dual.png'))));
    assert.equal(stored.data.alternate_greetings, undefined, 'data copy must be deleted');
    assert.equal(stored.alternate_greetings, undefined, 'root copy must not resurrect');

    // 问候池无它:rawAlts 非数组 → base first_mes 直取
    const floors = buildGroupGreetingFloors({
        roster: [buildRosterEntry('Dual.png', stored)], name1: 'Mia', chatMetadata: {}, chatName: 'd',
    });
    assert.equal(floors.length, 1);
    assert.equal(floors[0].mes, 'dual first');
});

test('PR25-2b:双存形 JSON 卡 —— 字段缺席不动根副本;显式 null 根 data 皆删', async () => {
    const dualJson = {
        spec: 'chara_card_v2', spec_version: '2.0',
        name: 'DualJson',
        alternate_greetings: ['json root alt'],
        group_only_greetings: ['json root group'],
        data: {
            name: 'DualJson',
            first_mes: 'dj first',
            alternate_greetings: ['json data alt'],
            group_only_greetings: ['json data group'],
            extensions: { group_greetings: ['json ext group'] },
        },
        extensions: { group_greetings: ['json root ext group'] },
    };
    fs.writeFileSync(path.join(dirs.characters, 'DualJson.json'), JSON.stringify(dualJson));

    // 字段缺席:PATCH 别的键 → 根副本原样保留(merge-patch 缺席语义)
    const rename = await api('/api/utopinn/characters/DualJson', {
        method: 'PATCH', body: { creator: 'tester' },
    });
    assert.equal(rename.status, 200);
    let stored = JSON.parse(fs.readFileSync(path.join(dirs.characters, 'DualJson.json'), 'utf8'));
    assert.deepEqual(stored.alternate_greetings, ['json root alt'], 'absent key must not touch root copy');
    assert.deepEqual(stored.data.alternate_greetings, ['json data alt']);

    // 显式 null:根+data 皆删
    const cleared = await api('/api/utopinn/characters/DualJson', {
        method: 'PATCH', body: { alternate_greetings: null, group_only_greetings: null },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    stored = JSON.parse(fs.readFileSync(path.join(dirs.characters, 'DualJson.json'), 'utf8'));
    assert.equal(stored.data.alternate_greetings, undefined);
    assert.equal(stored.alternate_greetings, undefined, 'JSON 卡根副本也必须删,否则读面 ?? 回落');
    assert.equal(stored.data.group_only_greetings, undefined);
    assert.equal(stored.group_only_greetings, undefined);

    // extensions 子键同款复活洞:根 extensions merge 回 data.extensions
    const extCleared = await api('/api/utopinn/characters/DualJson', {
        method: 'PATCH', body: { extensions: { group_greetings: null } },
    });
    assert.equal(extCleared.status, 200, JSON.stringify(extCleared.body));
    stored = JSON.parse(fs.readFileSync(path.join(dirs.characters, 'DualJson.json'), 'utf8'));
    assert.equal(stored.data.extensions.group_greetings, undefined);
    assert.equal(stored.extensions?.group_greetings, undefined, 'root extensions 副本也必须删');

    // 读面确认:两池皆空 → 该成员问候只剩 base first_mes
    const floors = buildGroupGreetingFloors({
        roster: [buildRosterEntry('DualJson.png', stored)], name1: 'Mia', chatMetadata: {}, chatName: 'dj',
    });
    assert.equal(floors.length, 1);
    assert.equal(floors[0].mes, 'dj first');
});
