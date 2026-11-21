/**
 * TASK-051 B1 — 服务端直持久化的 swipe 语义(node:test,真 FsEngine)。
 *
 * 契约(对齐上游 saveReply/ensureSwipes 落盘形):
 *   - 普通 AI 楼恒带 swipe_id/swipes[]/swipe_info[](同一楼多版本槽);
 *   - type:'swipe' job 的新文本并入「前一楼」swipes[]+swipe_id 指尾,
 *     楼层数不变;不可并楼(空聊/用户楼/小系统楼)退回新楼追加;
 *   - gen-id 侧车命中 = 已并楼,重入不叠第二份。
 *
 * 跑法:node --test tests/luker-generation-swipe.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';
import { initStorage, getChatRepo } from '../src/storage/index.js';
import { makeTempFsEngine } from './storage/harness/fs-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLE = 'u';
const CHAR = 'Alice';
const CHAT = 'c1';

// chats.js/mvu-settle.js 模块级 getConfigValue —— 指到 default/config.yaml
// 再动态 import(utopinn-library/mvu-settle 测试同款姿势)。
if (!getConfigFilePath()) {
    setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
}
reloadConfigCache();
process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

const {
    createGenerationJob,
    persistJobReplyText,
} = await import('../src/endpoints/backends/luker-generation.js');

let idCounter = 0;
function uniqueJobId(prefix) {
    idCounter += 1;
    return `${prefix}-${process.pid}-${idCounter}`;
}

function makeRequest(dirs, type) {
    return {
        user: { profile: { handle: HANDLE }, directories: dirs },
        body: { type, model: 'test-model', chat_completion_source: 'openai' },
    };
}

const characterPersistTarget = {
    kind: 'character',
    avatar_url: `${CHAR}.png`,
    file_name: `${CHAT}.jsonl`,
};

async function seedChat(repo, body) {
    await repo.save(HANDLE, CHAR, CHAT,
        { user_name: 'User', chat_metadata: {} },
        body,
        null);
}

async function readBody(repo) {
    const doc = await repo.get(HANDLE, CHAR, CHAT);
    return doc?.body ?? null;
}

function aiFloor(mes, extra = {}) {
    return { name: CHAR, is_user: false, is_system: false, send_date: '2026-11-20T00:00:00.000Z', mes, ...extra };
}

test('B1 normal persist — AI 楼带 swipe_id/swipes/swipe_info 三元组', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [{ name: 'User', is_user: true, mes: 'hi' }]);

        const req = makeRequest(fixture.dirs, 'normal');
        const job = createGenerationJob(req, { job_id: uniqueJobId('persist-normal'), persist_target: characterPersistTarget });
        const ok = await persistJobReplyText(job, 'First reply.', job.id, 'test-model');
        assert.equal(ok, true);

        const body = await readBody(repo);
        assert.equal(body.length, 2);
        const floor = body[1];
        assert.equal(floor.is_user, false);
        assert.equal(floor.mes, 'First reply.');
        assert.equal(floor.swipe_id, 0);
        assert.deepEqual(floor.swipes, ['First reply.']);
        assert.equal(floor.swipe_info.length, 1);
        assert.equal(floor.swipe_info[0].extra.api, 'openai');
        assert.equal(floor.swipe_info[0].extra.model, 'test-model');
        assert.equal(floor.swipe_info[0].extra.luker_server_persisted, true);
        // 协议层 ack 令牌不落盘(顶层 extra 被剥,快照同形不嵌)
        assert.equal(floor.swipe_info[0].extra.luker_generation_id, undefined);
        assert.equal(floor.extra.luker_server_persisted, true);
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — type:swipe 并入前楼 swipes[],楼层数不变', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [
            { name: 'User', is_user: true, mes: 'hi' },
            aiFloor('v1'),
        ]);

        const req = makeRequest(fixture.dirs, 'swipe');
        const job = createGenerationJob(req, { job_id: uniqueJobId('persist-swipe'), persist_target: characterPersistTarget });
        job.text = 'v2';
        const ok = await persistJobReplyText(job, job.text, job.id, 'test-model');
        assert.equal(ok, true);

        const body = await readBody(repo);
        assert.equal(body.length, 2, '楼层数不变——swipe 是同一楼的多版本');
        const floor = body[1];
        assert.deepEqual(floor.swipes, ['v1', 'v2']);
        assert.equal(floor.swipe_id, 1);
        assert.equal(floor.mes, 'v2');
        assert.equal(floor.swipe_info.length, 2);
        assert.equal(floor.swipe_info[1].extra.api, 'openai');
        assert.equal(floor.extra.api, 'openai');
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — 无 swipe 结构的旧 AI 楼回填后并楼', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        // 模拟本修前旧 persist 写出的裸楼层(无 swipes/swipe_id)
        await seedChat(repo, [
            { name: 'User', is_user: true, mes: 'hi' },
            { name: CHAR, is_user: false, is_system: false, send_date: '2026-11-20T00:00:00.000Z', mes: 'old reply', extra: { api: 'openai' } },
        ]);

        const req = makeRequest(fixture.dirs, 'swipe');
        const job = createGenerationJob(req, { job_id: uniqueJobId('persist-swipe-legacy'), persist_target: characterPersistTarget });
        const ok = await persistJobReplyText(job, 'new take', job.id, 'test-model');
        assert.equal(ok, true);

        const body = await readBody(repo);
        assert.equal(body.length, 2);
        const floor = body[1];
        // ensureSwipes 语义:旧 mes 回填槽 0,新版本进槽 1
        assert.deepEqual(floor.swipes, ['old reply', 'new take']);
        assert.equal(floor.swipe_id, 1);
        assert.equal(floor.mes, 'new take');
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — 连续 swipe 叠加:swipes 长度递增,swipe_id 恒指尾', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [
            { name: 'User', is_user: true, mes: 'hi' },
            aiFloor('v1'),
        ]);

        for (const text of ['v2', 'v3']) {
            const req = makeRequest(fixture.dirs, 'swipe');
            const job = createGenerationJob(req, { job_id: uniqueJobId(`persist-swipe-${text}`), persist_target: characterPersistTarget });
            assert.equal(await persistJobReplyText(job, text, job.id, 'test-model'), true);
        }

        const body = await readBody(repo);
        assert.equal(body.length, 2);
        assert.deepEqual(body[1].swipes, ['v1', 'v2', 'v3']);
        assert.equal(body[1].swipe_id, 2);
        assert.equal(body[1].mes, 'v3');
        assert.equal(body[1].swipe_info.length, 3);
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — 末楼是用户楼 → 退回新楼追加(上游 normal 回退)', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [
            aiFloor('last ai'),
            { name: 'User', is_user: true, mes: 'user said' },
        ]);

        const req = makeRequest(fixture.dirs, 'swipe');
        const job = createGenerationJob(req, { job_id: uniqueJobId('persist-swipe-user'), persist_target: characterPersistTarget });
        const ok = await persistJobReplyText(job, 'swipe on user floor', job.id, 'test-model');
        assert.equal(ok, true);

        const body = await readBody(repo);
        assert.equal(body.length, 3, '不可并楼 → 新楼追加');
        const floor = body[2];
        assert.equal(floor.is_user, false);
        assert.equal(floor.mes, 'swipe on user floor');
        assert.deepEqual(floor.swipes, ['swipe on user floor']);
        assert.equal(floor.swipe_id, 0);
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — 小系统楼(extra.isSmallSys)不可并楼 → 新楼追加', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [
            { name: 'User', is_user: true, mes: 'hi' },
            { name: '', is_user: false, is_system: true, mes: 'note', extra: { isSmallSys: true } },
        ]);

        const req = makeRequest(fixture.dirs, 'swipe');
        const job = createGenerationJob(req, { job_id: uniqueJobId('persist-swipe-sys'), persist_target: characterPersistTarget });
        const ok = await persistJobReplyText(job, 'swipe on sys floor', job.id, 'test-model');
        assert.equal(ok, true);

        const body = await readBody(repo);
        assert.equal(body.length, 3);
        assert.equal(body[2].mes, 'swipe on sys floor');
        assert.equal(body[1].mes, 'note', '小系统楼未被改写');
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — 空聊不可并楼 → 创建新楼', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, []);

        const req = makeRequest(fixture.dirs, 'swipe');
        const job = createGenerationJob(req, { job_id: uniqueJobId('persist-swipe-empty'), persist_target: characterPersistTarget });
        const ok = await persistJobReplyText(job, 'first floor', job.id, 'test-model');
        assert.equal(ok, true);

        const body = await readBody(repo);
        assert.equal(body.length, 1);
        assert.deepEqual(body[0].swipes, ['first floor']);
        assert.equal(body[0].swipe_id, 0);
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — gen-id 侧车命中 → 重入不叠第二份 swipe', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [
            { name: 'User', is_user: true, mes: 'hi' },
            aiFloor('v1'),
        ]);

        const jobId = uniqueJobId('persist-swipe-dedup');
        const req = makeRequest(fixture.dirs, 'swipe');
        const job = createGenerationJob(req, { job_id: jobId, persist_target: characterPersistTarget });
        assert.equal(await persistJobReplyText(job, 'v2', jobId, 'test-model'), true);
        // 同一 generationId 重入(兜底重试)——侧车命中,不再叠 swipe
        assert.equal(await persistJobReplyText(job, 'v2', jobId, 'test-model'), true);

        const body = await readBody(repo);
        assert.equal(body.length, 2);
        assert.deepEqual(body[1].swipes, ['v1', 'v2']);
        assert.equal(body[1].swipe_id, 1);
    } finally {
        fixture.cleanup();
    }
});

test('B1 swipe persist — 群聊寻址:kind:group 并楼同语义', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        const groupId = 'gchat-1';
        await repo.save(HANDLE, '', groupId,
            { user_name: 'User', chat_metadata: {} },
            [
                { name: 'User', is_user: true, mes: 'hi' },
                { name: 'Alice', is_user: false, is_system: false, send_date: '2026-11-20T00:00:00.000Z', mes: 'gv1', original_avatar: 'Alice.png', extra: { gen_id: 111 } },
            ],
            null,
            { isGroup: true, groupId });

        const req = makeRequest(fixture.dirs, 'swipe');
        const job = createGenerationJob(req, {
            job_id: uniqueJobId('persist-swipe-group'),
            persist_target: {
                kind: 'group',
                id: groupId,
                char_name: 'Alice',
                original_avatar: 'Alice.png',
                gen_id: 222,
            },
        });
        const ok = await persistJobReplyText(job, 'gv2', job.id, 'test-model');
        assert.equal(ok, true);

        const doc = await repo.get(HANDLE, '', groupId, { isGroup: true, groupId });
        assert.equal(doc.body.length, 2);
        const floor = doc.body[1];
        assert.deepEqual(floor.swipes, ['gv1', 'gv2']);
        assert.equal(floor.swipe_id, 1);
        assert.equal(floor.mes, 'gv2');
        // 新一批次 gen_id 覆盖(楼层当前版本来自本次生成),成员身份保留
        assert.equal(floor.extra.gen_id, 222);
        assert.equal(floor.original_avatar, 'Alice.png');
    } finally {
        fixture.cleanup();
    }
});
