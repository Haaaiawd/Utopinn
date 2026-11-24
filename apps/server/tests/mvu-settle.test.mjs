/**
 * mvu-settle 服务端测试(node:test,真 FsEngine + 种子数据)。
 * 覆盖 TASK-013 done_when:
 *   - resolveMvuInitLorebooks 书目口径(global selected + 主书 + 辅书,无 chat-bound)
 *   - initializeMvuChat floor-0 初始化:variables[i] + chat_metadata 镜像 + kind:'init' 日志;已初始化早退
 *   - settlePersistedMvuMessage autoInit:no_baseline → 先 init 再 settle
 *   - resettleChatMvu 无变化跳过(非 MVU 聊天不整写)
 * 覆盖 TASK-045:
 *   - autoInit 默认开:预建/导入聊天(floor-0 有信号、无 variables)settle 自愈
 *   - 非 MVU 聊天探测 not_mvu 早退(无 variables、integrity 不动)
 *   - 已初始化聊天不重复 init;显式 autoInit:false = 纯结算
 *   - settleMvuAfterAppend(chats.js /append seam)默认开:角色+群聊预建聊天
 * 跑法:node --test tests/mvu-settle.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMvuData, MVU_STATUS_PLACEHOLDER } from '@utopinn/core';
import {
    getChatRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    initStorage,
} from '../src/storage/index.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
import {
    MVU_STATE_NAMESPACE,
    initializeMvuChat,
    mvuHardDisabled,
    resolveMvuInitLorebooks,
    resettleChatMvu,
    settlePersistedMvuMessage,
} from '../src/services/mvu-settle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HANDLE = 'h1';
const CHAR = 'Alice';

function makeDirs(tmpDir) {
    return {
        root: tmpDir,
        characters: path.join(tmpDir, 'characters'),
        chats: path.join(tmpDir, 'chats'),
        worlds: path.join(tmpDir, 'worlds'),
        groups: path.join(tmpDir, 'groups'),
        groupChats: path.join(tmpDir, 'group chats'),
        backups: path.join(tmpDir, 'backups'),
        openAI_Settings: path.join(tmpDir, 'OpenAI Settings'),
        context: path.join(tmpDir, 'context'),
        instruct: path.join(tmpDir, 'instruct'),
        sysprompt: path.join(tmpDir, 'sysprompt'),
        reasoning: path.join(tmpDir, 'reasoning'),
        koboldAI_Settings: path.join(tmpDir, 'KoboldAI Settings'),
        novelAI_Settings: path.join(tmpDir, 'NovelAI Settings'),
        textGen_Settings: path.join(tmpDir, 'TextGen Settings'),
    };
}

async function seedWorlds() {
    await getWorldInfoRepo().save(HANDLE, 'GlobalBook', {
        entries: { '0': { content: 'gold: 5', comment: '[initvar]全局', uid: 0 } },
    });
    await getWorldInfoRepo().save(HANDLE, 'CharBook', {
        entries: { '0': { content: 'hp: 100', comment: '[initvar]主角' }, '1': { content: 'ignored', comment: '普通' } },
    });
    await getWorldInfoRepo().save(HANDLE, 'ExtraBook', {
        entries: { '0': { content: 'mp: 30', comment: '[initvar]辅' } },
    });
    // 未被任何来源引用 —— 不得进入 init 书目。
    await getWorldInfoRepo().save(HANDLE, 'ChatOnlyBook', {
        entries: { '0': { content: 'nope: 1', comment: '[initvar]' } },
    });
}

test('resolveMvuInitLorebooks — selected_global + 主书 + 辅书,不含 chat-bound/persona', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-books-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        fs.mkdirSync(dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`), JSON.stringify({
            name: CHAR,
            data: { name: CHAR, extensions: { world: 'CharBook' } },
        }));
        await getSettingsRepo().save(HANDLE, {
            power_user: {
                persona_description_lorebook: 'ChatOnlyBook', // persona 书不进口径
            },
            // 真实路径(5b9b6d2 后 power_user.selected_world_info/顶层 world_info 已死)。
            world_info_settings: {
                world_info: {
                    globalSelect: ['GlobalBook'],
                    charLore: [{ name: CHAR, extraBooks: ['ExtraBook'] }],
                },
            },
        });
        await seedWorlds();

        const { lorebooks, primaryLorebookName } = await resolveMvuInitLorebooks({
            handle: HANDLE, charDir: CHAR, directories: dirs,
        });
        assert.equal(primaryLorebookName, 'CharBook');
        assert.deepEqual(lorebooks.map(b => b.name), ['GlobalBook', 'CharBook', 'ExtraBook']);
        assert.equal(lorebooks.find(b => b.name === 'CharBook')?.isPrimary, true);
        assert.equal(lorebooks.find(b => b.name === 'GlobalBook')?.isPrimary, false);
        // entries 只保留 {content, comment}
        const char = lorebooks.find(b => b.name === 'CharBook');
        assert.equal(char.entries.length, 2);
        assert.deepEqual(
            char.entries.map(e => ({ content: e.content, comment: e.comment })),
            [{ content: 'hp: 100', comment: '[initvar]主角' }, { content: 'ignored', comment: '普通' }],
        );
        assert.ok(!lorebooks.some(b => b.name === 'ChatOnlyBook'), 'chat/persona 书不进 init 书目');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initializeMvuChat — floor-0 写 variables[i]+镜像+kind:init 日志;已初始化早退', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-init-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'c1', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '欢迎光临。', swipe_id: 0, swipes: ['欢迎光临。', '幸会。'] },
            { is_user: true, name: 'User', mes: '你好。' },
        ], null);

        const lorebooks = [{
            name: 'CharBook',
            isPrimary: true,
            entries: [{ content: 'hp: 100', comment: '[initvar]主角' }],
        }];
        const r1 = await initializeMvuChat({
            handle: HANDLE, charDir: CHAR, name: 'c1',
            lorebooks, primaryLorebookName: 'CharBook',
        });
        assert.equal(r1.status, 'initialized');
        assert.equal(r1.swipes, 2);

        const doc = await repo.get(HANDLE, CHAR, 'c1');
        const floor0 = doc.body[0];
        // 每个 swipe 槽位各一份 MvuData 快照
        assert.ok(isMvuData(floor0.variables['0']), 'variables[0] 是 MvuData');
        assert.ok(isMvuData(floor0.variables['1']), 'variables[1] 是 MvuData');
        assert.equal(floor0.variables['0'].stat_data.hp, 100);
        assert.equal(floor0.variables['0'].initialized_lorebooks.CharBook !== undefined, true);
        // 1 层未被 init 触碰
        assert.equal(doc.body[1].variables, undefined);
        // chat_metadata.variables 镜像(当前 swipe 槽位的投影)
        const mirror = doc.header.chat_metadata.variables;
        assert.equal(mirror.stat_data.hp, 100);
        assert.deepEqual(mirror.initialized_lorebooks, { CharBook: [] });
        // 侧车 kind:'init' op 日志
        const state = await repo.getState(HANDLE, CHAR, 'c1', MVU_STATE_NAMESPACE);
        const initEntry = state.ops.at(-1);
        assert.equal(initEntry.kind, 'init');
        assert.equal(initEntry.messageIndex, 0);
        assert.equal(initEntry.swipes, 2);

        // 已初始化 → 早退,不再写回
        const r2 = await initializeMvuChat({
            handle: HANDLE, charDir: CHAR, name: 'c1',
            lorebooks, primaryLorebookName: 'CharBook',
        });
        assert.equal(r2.status, 'already_initialized');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initializeMvuChat — directories 自解书目(无预解 lorebooks 时走 resolve)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-initres-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        fs.mkdirSync(dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`), JSON.stringify({
            name: CHAR,
            data: { name: CHAR, extensions: { world: 'CharBook' } },
        }));
        await getSettingsRepo().save(HANDLE, {
            world_info_settings: {
                world_info: {
                    globalSelect: ['GlobalBook'],
                    charLore: [{ name: CHAR, extraBooks: ['ExtraBook'] }],
                },
            },
        });
        await seedWorlds();
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'c2', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开场。', swipe_id: 0 },
        ], null);

        const r = await initializeMvuChat({
            handle: HANDLE, charDir: CHAR, name: 'c2', directories: dirs,
        });
        assert.equal(r.status, 'initialized');
        const doc = await repo.get(HANDLE, CHAR, 'c2');
        const vars = doc.body[0].variables['0'];
        assert.equal(vars.stat_data.gold, 5);   // GlobalBook
        assert.equal(vars.stat_data.hp, 100);   // CharBook(主书)
        assert.equal(vars.stat_data.mp, 30);    // ExtraBook(辅书)
        assert.equal(vars.stat_data.nope, undefined); // ChatOnlyBook 不进
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('settlePersistedMvuMessage autoInit — no_baseline 先 init 再 settle', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-autoinit-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'c3', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开场白,很长足够过五字。', swipe_id: 0 },
            { is_user: false, name: CHAR, mes: "她收剑还鞘。\n_.set('hp', 88);", swipe_id: 0 },
        ], null);
        const lorebooks = [{
            name: 'CharBook',
            isPrimary: true,
            entries: [{ content: 'hp: 100', comment: '[initvar]' }],
        }];

        // 显式 autoInit:false(TASK-045 后的纯结算退化开关):
        // 不探测,no_baseline 原样返回,不写回。
        const before = await repo.get(HANDLE, CHAR, 'c3');
        const plain = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'c3', autoInit: false });
        assert.equal(plain.status, 'no_baseline');
        const afterPlain = await repo.get(HANDLE, CHAR, 'c3');
        assert.equal(afterPlain.integrity, before.integrity, 'no_baseline 不动文档');

        // autoInit:floor-0 初始化 → 下一轮 attempt settle 成功。
        const auto = await settlePersistedMvuMessage({
            handle: HANDLE, charDir: CHAR, name: 'c3',
            autoInit: true, lorebooks, primaryLorebookName: 'CharBook',
        });
        assert.equal(auto.status, 'settled');
        const doc = await repo.get(HANDLE, CHAR, 'c3');
        // floor-0 已初始化(initvar hp=100)
        assert.ok(isMvuData(doc.body[0].variables['0']));
        assert.equal(doc.body[0].variables['0'].stat_data.hp, 100);
        // 末楼以 floor-0 为基底 fold _.set → hp 88,附占位符
        const last = doc.body[1];
        assert.ok(isMvuData(last.variables['0']));
        assert.equal(last.variables['0'].stat_data.hp, 88);
        assert.ok(last.mes.endsWith(MVU_STATUS_PLACEHOLDER), 'assistant 楼层附状态占位符');
        // 镜像同步到 chat_metadata.variables
        assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 88);
        // 侧车:先 init 后 settle 两条日志
        const state = await repo.getState(HANDLE, CHAR, 'c3', MVU_STATE_NAMESPACE);
        const kinds = state.ops.map(e => e.kind ?? 'settle');
        assert.ok(kinds.includes('init'), 'init 日志在册');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('settlePersistedMvuMessage autoInit + messageIndex 0 — greeting 命令不二次 fold', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-floor0-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();
        // 新建聊天只有 floor-0:greeting 带 _.add → init 已 fold;
        // 目标楼层即 0 时再 settle 会把同一命令二次应用,必须短路。
        await repo.save(HANDLE, CHAR, 'c4', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: "开局战斗。\n_.add('hp', -3);", swipe_id: 0 },
        ], null);
        const r = await settlePersistedMvuMessage({
            handle: HANDLE, charDir: CHAR, name: 'c4',
            autoInit: true,
            lorebooks: [{ name: 'b', entries: [{ content: 'hp: 10', comment: '[initvar]' }] }],
        });
        assert.equal(r.status, 'initialized');
        const doc = await repo.get(HANDLE, CHAR, 'c4');
        assert.equal(doc.body[0].variables['0'].stat_data.hp, 7, 'init fold 一次,不二次应用');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resettleChatMvu — 非 MVU 聊天无变化跳过整写;MVU 聊天改文后重放', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-resettle-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();

        // 非 MVU 聊天:全部楼层 no_baseline → body 不变 → 不整写。
        await repo.save(HANDLE, CHAR, 'plain', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '普通开场白。' },
            { is_user: true, name: 'User', mes: '普通回复。' },
        ], null);
        const plainDoc = await repo.get(HANDLE, CHAR, 'plain');
        const rr = await resettleChatMvu({ handle: HANDLE, charDir: CHAR, name: 'plain' });
        assert.equal(rr.status, 'not_mvu', '非 MVU 聊天门控跳过');
        assert.equal(rr.modified, false);
        const plainAfter = await repo.get(HANDLE, CHAR, 'plain');
        assert.equal(plainAfter.integrity, plainDoc.integrity, '无变化不推高 integrity');

        // MVU 聊天:init 后改写楼层文本 → 重放刷新 stat_data。
        await repo.save(HANDLE, CHAR, 'mvu', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开场白,很长足够过五字。', swipe_id: 0 },
            { is_user: false, name: CHAR, mes: "第一刀。\n_.set('hp', 90);", swipe_id: 0 },
        ], null);
        await initializeMvuChat({
            handle: HANDLE, charDir: CHAR, name: 'mvu',
            lorebooks: [{ name: 'b', entries: [{ content: 'hp: 100', comment: '[initvar]' }] }],
        });
        const s1 = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'mvu' });
        assert.equal(s1.status, 'settled');
        let doc = await repo.get(HANDLE, CHAR, 'mvu');
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 90);

        // 模拟 /patch 改写楼层命令:hp 90 → 60
        const edited = doc.body.slice();
        edited[1] = { ...edited[1], mes: "第一刀。\n_.set('hp', 60);", variables: undefined };
        await repo.save(HANDLE, CHAR, 'mvu', doc.header, edited, doc.integrity);
        const rr2 = await resettleChatMvu({ handle: HANDLE, charDir: CHAR, name: 'mvu' });
        assert.equal(rr2.status, 'settled');
        doc = await repo.get(HANDLE, CHAR, 'mvu');
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 60, '重放按新命令重折');
        assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 60);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------- TASK-045:autoInit 判据 = floor-0 初始化态,不再依赖「聊天刚建」 ----------

test('TASK-045 — 预建聊天 settle 默认探测:no_baseline 触发补 init(不传 autoInit)', async () => {
    // 掌门卡式预建/导入聊天:JSONL 已存在,floor-0 greeting 带 <initvar>
    // 信号但无 variables;首次 append 后 settle 必须自愈。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-prebuilt-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'prebuilt', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开局。\n<initvar>\n{"hp": 77, "gold": 12}\n</initvar>', swipe_id: 0 },
        ], null);
        // 存量 /append:追加一楼(assistant 回复带 _.set),再跑 seam settle ——
        // 不传 autoInit,TASK-045 后默认探测。
        const before = await repo.get(HANDLE, CHAR, 'prebuilt');
        await repo.save(HANDLE, CHAR, 'prebuilt', before.header, [
            ...before.body,
            { is_user: false, name: CHAR, mes: "她收剑还鞘。\n_.set('hp', 55);", swipe_id: 0 },
        ], before.integrity);

        const r = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'prebuilt' });
        assert.equal(r.status, 'settled');

        const doc = await repo.get(HANDLE, CHAR, 'prebuilt');
        // floor-0 探测补 init(<initvar> 覆盖 → hp 77/gold 12)
        assert.ok(isMvuData(doc.body[0].variables['0']), 'floor-0 被探测补 init');
        assert.equal(doc.body[0].variables['0'].stat_data.hp, 77);
        assert.equal(doc.body[0].variables['0'].stat_data.gold, 12);
        // 末楼以 floor-0 为基底 fold _.set → hp 55,mvu state 非空
        assert.ok(isMvuData(doc.body[1].variables['0']));
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 55);
        assert.ok(doc.body[1].mes.endsWith(MVU_STATUS_PLACEHOLDER));
        assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 55);
        const state = await repo.getState(HANDLE, CHAR, 'prebuilt', MVU_STATE_NAMESPACE);
        assert.equal(state.ops.filter(e => e.kind === 'init').length, 1, 'init 只跑一次');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('TASK-045 — 非 MVU 聊天:探测 not_mvu 早退,无 variables、integrity 不动', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-notmvu-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'plain2', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '普通开场白,没有信号。', swipe_id: 0 },
            { is_user: true, name: 'User', mes: '普通回复。' },
        ], null);
        const before = await repo.get(HANDLE, CHAR, 'plain2');
        // 默认 autoInit 探测仍跑,但 mvuSignalPresent 全灭 → not_mvu 早退。
        const r = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'plain2' });
        assert.equal(r.status, 'no_baseline');
        const doc = await repo.get(HANDLE, CHAR, 'plain2');
        assert.equal(doc.body[0].variables, undefined, 'floor-0 不长出快照');
        assert.equal(doc.body[1].variables, undefined, '末楼无快照');
        assert.equal(doc.header.chat_metadata?.variables, undefined, 'metadata 无镜像');
        assert.equal(doc.integrity, before.integrity, '探测早退不推高 integrity');
        const state = await repo.getState(HANDLE, CHAR, 'plain2', MVU_STATE_NAMESPACE).catch(() => null);
        assert.equal(state, null, '非 MVU 聊天不产生 mvu 侧车');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('TASK-045 — 已初始化聊天 append+settle 不重复 init', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-noreinit-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'inited', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开场白,很长足够过五字。', swipe_id: 0 },
        ], null);
        const lorebooks = [{
            name: 'CharBook',
            isPrimary: true,
            entries: [{ content: 'hp: 100', comment: '[initvar]' }],
        }];
        const r1 = await initializeMvuChat({
            handle: HANDLE, charDir: CHAR, name: 'inited',
            lorebooks, primaryLorebookName: 'CharBook',
        });
        assert.equal(r1.status, 'initialized');
        // 追加一楼后走默认 settle:floor-0 已初始化 → baseline 命中,
        // no_baseline 不成立 → init 探测根本不触发。
        const before = await repo.get(HANDLE, CHAR, 'inited');
        await repo.save(HANDLE, CHAR, 'inited', before.header, [
            ...before.body,
            { is_user: false, name: CHAR, mes: "第一刀。\n_.set('hp', 90);", swipe_id: 0 },
        ], before.integrity);
        const r = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'inited' });
        assert.equal(r.status, 'settled');
        const doc = await repo.get(HANDLE, CHAR, 'inited');
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 90);
        const state = await repo.getState(HANDLE, CHAR, 'inited', MVU_STATE_NAMESPACE);
        assert.equal(state.ops.filter(e => e.kind === 'init').length, 1, 'init 日志仍一条,未重复初始化');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('TASK-045 — /api/chats/append + /group/append 真实路由:预建聊天自愈', async () => {
    // chats.js 模块级 getConfigValue(backups.*/generationAckGraceMs)需 config
    // 就绪 —— 先指到 default/config.yaml 再动态 import(utopinn-library 同款)。
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
    process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';
    const { router: chatsRouter } = await import('../src/endpoints/chats.js');
    const { default: express } = await import('express');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-seam-'));
    let server;
    try {
        const dirs = makeDirs(tmpDir);
        fs.mkdirSync(dirs.backups, { recursive: true });
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        const repo = getChatRepo();

        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: HANDLE, name: 'User' }, directories: dirs };
            next();
        });
        app.use('/api/chats', chatsRouter);
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        const BASE = `http://127.0.0.1:${server.address().port}`;
        const post = (pathname, body) => fetch(`${BASE}${pathname}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

        // 掌门卡式预建角色聊天:floor-0 <initvar> 信号、无 variables。
        await repo.save(HANDLE, CHAR, 'seam1', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '开场。\n<initvar>\n{"hp": 66}\n</initvar>', swipe_id: 0 },
        ], null);
        // /append 存量分支(真实 HTTP)——TASK-045 前这里 settle 不带 autoInit。
        const r1 = await post('/api/chats/append', {
            avatar_url: 'Alice.png',
            file_name: 'seam1.jsonl',
            message: { is_user: false, name: CHAR, mes: "出手。\n_.set('hp', 33);", swipe_id: 0 },
        });
        assert.equal(r1.status, 200);
        assert.equal(r1.body?.ok, true);
        assert.equal(r1.body?.appended, 1);
        let doc = await repo.get(HANDLE, CHAR, 'seam1');
        assert.ok(isMvuData(doc.body[0].variables['0']), '角色预建聊天 floor-0 自愈');
        assert.ok(isMvuData(doc.body[1].variables['0']));
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 33);
        assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 33);

        // 预建群聊:同病同治(POST /group/append 真实路径)。
        await repo.save(HANDLE, '', 'g1', { user_name: 'User', chat_metadata: {} }, [
            { is_user: false, name: CHAR, mes: '群开局。\n<initvar>\n{"morale": 10}\n</initvar>', swipe_id: 0 },
        ], null, { isGroup: true, groupId: 'g1' });
        const r2 = await post('/api/chats/group/append', {
            id: 'g1',
            message: { is_user: false, name: CHAR, mes: "众人响应。\n_.add('morale', 5);", swipe_id: 0 },
        });
        assert.equal(r2.status, 200);
        assert.equal(r2.body?.ok, true);
        doc = await repo.get(HANDLE, '', 'g1', { isGroup: true, groupId: 'g1' });
        assert.ok(isMvuData(doc.body[0].variables['0']), '群聊 floor-0 自愈');
        assert.ok(isMvuData(doc.body[1].variables['0']));
        assert.equal(doc.body[1].variables['0'].stat_data.morale, 15);
    } finally {
        server?.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------- mvuHardDisabled:卡自持账本 / 每聊天显式关闭(掌门卡腐蚀修复) ----------
// 场景:CardApp 自管 stat_data —— 卡侧解析 AI 回复里的 _.set 行经
// ctx.setVariable 写账,editMessage 再把命令行从 mes 剥掉,并自管
// stat_data_prev/_for 回滚。服务端在 /save + /patch 后 resettleChatMvu
// 从已剥文本重折叠 → 楼层快照打回 baseline → stat_data 永久丢账。
// 钉:veto 命中时 init/settle/resettle 全静默(disabled/not_mvu),
// 楼层快照/mes/镜像/integrity 一字不动,StatusPlaceHolderImpl 不注入。

/** 卡账快照 fixture:isMvuData 需 stat_data + schema 双键在场。 */
function mvuSnap(statData) {
    return { stat_data: statData, schema: { type: 'object', properties: {} }, initialized_lorebooks: {} };
}

test('mvuHardDisabled — 纯函数:旗标矩阵', () => {
    assert.equal(mvuHardDisabled({}), false);
    assert.equal(mvuHardDisabled({ chatMetadata: { mvu: { enabled: false } } }), true);
    assert.equal(mvuHardDisabled({ card: { data: { extensions: { mvu: false } } } }), true);
    assert.equal(mvuHardDisabled({ card: { extensions: { mvu: false } } }), true);
    // 显式 false 压显式 true(否决是防御位)
    assert.equal(mvuHardDisabled({
        card: { data: { extensions: { mvu: false } } },
        chatMetadata: { mvu: { enabled: true } },
    }), true);
    // 真值旗标不算否决
    assert.equal(mvuHardDisabled({ card: { data: { extensions: { mvu: true } } } }), false);
});

test('mvuHardDisabled — 卡旗标 extensions.mvu:false:settle/resettle/init 全静默,卡账不回滚', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-veto-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        fs.mkdirSync(dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(dirs.characters, CHAR + '.json'), JSON.stringify({
            name: CHAR,
            data: { name: CHAR, extensions: { world: 'CharBook', mvu: false } },
        }));
        const repo = getChatRepo();
        // 会话态 = CardApp 写后形:floor-0 快照 hp:100;floor-1 快照 hp:42
        // 是卡自己的账(ctx.setVariable),mes 里的 _.set 行已被 editMessage
        // 剥掉;chat_metadata.variables.stat_data.hp=42 是卡最新账。
        await repo.save(HANDLE, CHAR, 'veto', {
            user_name: 'User',
            chat_metadata: { variables: { stat_data: { hp: 42 }, schema: { type: 'object' } } },
        }, [
            { is_user: false, name: CHAR, mes: '开场。', swipe_id: 0, variables: { '0': mvuSnap({ hp: 100 }) } },
            { is_user: false, name: CHAR, mes: '她收剑还鞘。', swipe_id: 0, variables: { '0': mvuSnap({ hp: 42 }) } },
        ], null);
        const before = await repo.get(HANDLE, CHAR, 'veto');

        // resettle:armed(镜像键+楼层快照满格)但卡否决 → 'disabled',整图不动。
        const rr = await resettleChatMvu({ handle: HANDLE, charDir: CHAR, name: 'veto', directories: dirs });
        assert.equal(rr.status, 'disabled', '卡旗标否决 resettle');
        let doc = await repo.get(HANDLE, CHAR, 'veto');
        assert.equal(doc.integrity, before.integrity, '否决不推高 integrity');
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 42, '卡账快照不回滚 baseline');
        assert.equal(doc.body[1].mes, '她收剑还鞘。', 'mes 不被注入占位符');
        assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 42, '镜像不被覆盖');

        // settle:同 veto —— 不 fold、不注占位符。
        const ss = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'veto', directories: dirs });
        assert.equal(ss.status, 'disabled', '卡旗标否决 settle');
        doc = await repo.get(HANDLE, CHAR, 'veto');
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 42);
        assert.ok(!doc.body[1].mes.includes('StatusPlaceHolder'), '无占位符注入');

        // init:正信号满格([initvar] 注释 + floorText _.set)也被卡否决 → 'disabled'。
        const init = await initializeMvuChat({
            handle: HANDLE, charDir: CHAR, name: 'veto',
            lorebooks: [{ name: 'b', isPrimary: true, entries: [{ content: 'hp: 1', comment: '[initvar]' }] }],
            directories: dirs,
        });
        assert.equal(init.status, 'disabled', '卡旗标否决 init');
        assert.equal(init.initialized, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('mvuHardDisabled — chat_metadata.mvu.enabled === false:免读卡单闸全静默', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-vetometa-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        // 故意不写卡文件 —— metadata 单闸即须成立(无卡可读不兜底)。
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'offchat', {
            user_name: 'User',
            chat_metadata: { mvu: { enabled: false }, variables: { stat_data: { hp: 7 } } },
        }, [
            { is_user: false, name: CHAR, mes: "开局。\n_.set('hp', 7);", swipe_id: 0, variables: { '0': mvuSnap({ hp: 7 }) } },
            { is_user: false, name: CHAR, mes: "推进。\n_.set('hp', 9);", swipe_id: 0, variables: { '0': mvuSnap({ hp: 9 }) } },
        ], null);
        const before = await repo.get(HANDLE, CHAR, 'offchat');

        const rr = await resettleChatMvu({ handle: HANDLE, charDir: CHAR, name: 'offchat', directories: dirs });
        assert.equal(rr.status, 'disabled');
        const ss = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'offchat', directories: dirs });
        assert.equal(ss.status, 'disabled');
        const init = await initializeMvuChat({ handle: HANDLE, charDir: CHAR, name: 'offchat', directories: dirs });
        assert.equal(init.status, 'disabled');

        const doc = await repo.get(HANDLE, CHAR, 'offchat');
        assert.equal(doc.integrity, before.integrity, '三连 veto 不推高 integrity');
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 9, '卡账快照不回滚');
        assert.ok(!doc.body[1].mes.includes('StatusPlaceHolder'), '占位符不注入');
        assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 7, '镜像不被覆盖');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('mvuHardDisabled — /save 写后 resettleMvuAfterWrite seam:卡旗标经 directories 生效', async () => {
    // 真实伤害链:CardApp editMessage 剥命令 → PUT /save → seam resettle →
    // 楼层快照回 baseline。本钉证明 seam 到 resettleChatMvu 的 directories
    // 管道通了(无 directories 时卡否决读不到卡 = 不生效)。
    if (!getConfigFilePath()) {
        setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
    }
    reloadConfigCache();
    const { resettleMvuAfterWrite } = await import('../src/endpoints/chats.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utopinn-mvu-vetoseam-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        fs.mkdirSync(dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(dirs.characters, CHAR + '.json'), JSON.stringify({
            name: CHAR,
            data: { name: CHAR, extensions: { mvu: false } },
        }));
        const repo = getChatRepo();
        await repo.save(HANDLE, CHAR, 'seamveto', {
            user_name: 'User',
            chat_metadata: { variables: { stat_data: { hp: 42 } } },
        }, [
            { is_user: false, name: CHAR, mes: '开场。', swipe_id: 0, variables: { '0': mvuSnap({ hp: 100 }) } },
            { is_user: false, name: CHAR, mes: '已剥命令的楼层。', swipe_id: 0, variables: { '0': mvuSnap({ hp: 42 }) } },
        ], null);
        const before = await repo.get(HANDLE, CHAR, 'seamveto');

        await resettleMvuAfterWrite({
            body: { avatar_url: 'Alice.png', file_name: 'seamveto.jsonl' },
            user: { profile: { handle: HANDLE }, directories: dirs },
        });
        const doc = await repo.get(HANDLE, CHAR, 'seamveto');
        assert.equal(doc.integrity, before.integrity, 'seam 全静默不推高 integrity');
        assert.equal(doc.body[1].variables['0'].stat_data.hp, 42, '卡账不回滚');
        assert.equal(doc.body[1].mes, '已剥命令的楼层。', 'mes 不被改写');
        assert.equal(doc.header.chat_metadata.variables.stat_data.hp, 42, '镜像不被覆盖');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
