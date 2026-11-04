/**
 * mvu-settle 服务端测试(node:test,真 FsEngine + 种子数据)。
 * 覆盖 TASK-013 done_when:
 *   - resolveMvuInitLorebooks 书目口径(global selected + 主书 + 辅书,无 chat-bound)
 *   - initializeMvuChat floor-0 初始化:variables[i] + chat_metadata 镜像 + kind:'init' 日志;已初始化早退
 *   - settlePersistedMvuMessage autoInit:no_baseline → 先 init 再 settle
 *   - resettleChatMvu 无变化跳过(非 MVU 聊天不整写)
 * 跑法:node --test tests/mvu-settle.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMvuData, MVU_STATUS_PLACEHOLDER } from '@uberge/core';
import {
    getChatRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    initStorage,
} from '../src/storage/index.js';
import {
    MVU_STATE_NAMESPACE,
    initializeMvuChat,
    resolveMvuInitLorebooks,
    resettleChatMvu,
    settlePersistedMvuMessage,
} from '../src/services/mvu-settle.js';

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-mvu-books-'));
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
                selected_world_info: ['GlobalBook'],
                persona_description_lorebook: 'ChatOnlyBook', // persona 书不进口径
            },
            world_info: { charLore: [{ name: CHAR, extraBooks: ['ExtraBook'] }] },
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-mvu-init-'));
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-mvu-initres-'));
    try {
        const dirs = makeDirs(tmpDir);
        await initStorage({ mode: 'fs', directoriesByHandle: () => dirs });
        fs.mkdirSync(dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(dirs.characters, `${CHAR}.json`), JSON.stringify({
            name: CHAR,
            data: { name: CHAR, extensions: { world: 'CharBook' } },
        }));
        await getSettingsRepo().save(HANDLE, {
            power_user: { selected_world_info: ['GlobalBook'] },
            world_info: { charLore: [{ name: CHAR, extraBooks: ['ExtraBook'] }] },
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-mvu-autoinit-'));
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

        // 不开 autoInit:no_baseline 原样返回,不写回。
        const before = await repo.get(HANDLE, CHAR, 'c3');
        const plain = await settlePersistedMvuMessage({ handle: HANDLE, charDir: CHAR, name: 'c3' });
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-mvu-floor0-'));
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uberge-mvu-resettle-'));
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
