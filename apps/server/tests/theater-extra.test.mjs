/**
 * TASK-044 剧场楼层 extra 契约 —— 生成侧(node:test,真 FsEngine)。
 *
 * 契约(与 HTTP 面回读测试 theater-extra-http.test.mjs 姊妹):
 *   - 楼层 extra 是宽松透传袋:scene{bg?,bgm?}/choices[{label|text,goto?}]/
 *     narrator(true)|type('narrator' 上游惯例)原样落盘,不剥不捏;
 *   - 生成侧兜底 persist(persistGeneratedReply/Swipe)两条来路:
 *       a. 客户端指定 —— persist_target.extra 浅袋并入(服务端簿记键
 *          api/model/luker_server_persisted/luker_generation_id/gen_id
 *          不可被袋覆盖);
 *       b. 模型结构化产出 —— luker_generation.theater|structured(或
 *          persistTarget 同键)置真时 job.text 按 JSON 对象解析:首个
 *          非空正文键(mes|text|line|content|dialogue|reply|response|
 *          narration)提为 mes,speaker|name 提为楼层 name,其余键原样
 *          抬进 extra;解析失败/非对象 → 原文落 mes;
 *   - job.theater = 解析快照({text,name,extra}),GET /jobs/:id 透出
 *     choices/theater;不显式置真 → 不解析(JSON 原文照常落 mes)。
 *
 * 跑法:node --test tests/theater-extra.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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
// 再动态 import(luker-generation-swipe 测试同款姿势)。
if (!getConfigFilePath()) {
    setConfigFilePath(path.resolve(__dirname, '../default/config.yaml'));
}
reloadConfigCache();
process.env.LUKER_PERFORMANCE_USEDISKCACHE = 'false';
process.env.LUKER_PERFORMANCE_USE_DISK_CACHE = 'false';

const {
    createGenerationJob,
    persistJobReplyText,
    completeGenerationJobFromText,
    acknowledgeGenerationJobsForRequest,
} = await import('../src/endpoints/backends/luker-generation.js');

let idCounter = 0;
function uniqueJobId(prefix) {
    idCounter += 1;
    return `${prefix}-${process.pid}-${idCounter}`;
}

function makeRequest(dirs, type, { lukerGeneration } = {}) {
    return {
        user: { profile: { handle: HANDLE }, directories: dirs },
        body: {
            type,
            model: 'test-model',
            chat_completion_source: 'openai',
            ...(lukerGeneration ? { luker_generation: lukerGeneration } : {}),
        },
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

test('theater 置真 + 结构化产出 → 新楼提 mes/extra/speaker,簿记健在', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [{ name: 'User', is_user: true, mes: 'hi' }]);

        const req = makeRequest(fixture.dirs, 'normal', { lukerGeneration: { theater: true } });
        const job = createGenerationJob(req, { job_id: uniqueJobId('theater-lift'), persist_target: characterPersistTarget });
        const output = JSON.stringify({
            speaker: '旁白',
            mes: '暮色四合,大殿里只剩烛火。',
            scene: { bg: '/assets/backgrounds/hall.jpg', bgm: 'rain.ogg' },
            choices: [{ label: '上前问安', goto: 'hall-2' }, { text: '悄悄退下' }],
            narrator: true,
        });
        const ok = await persistJobReplyText(job, output, job.id, 'test-model');
        assert.equal(ok, true);

        const body = await readBody(repo);
        assert.equal(body.length, 2);
        const floor = body[1];
        assert.equal(floor.mes, '暮色四合,大殿里只剩烛火。');
        assert.equal(floor.name, '旁白', 'speaker 归因提为楼层名签');
        assert.equal(floor.is_user, false);
        assert.deepEqual(floor.extra.scene, { bg: '/assets/backgrounds/hall.jpg', bgm: 'rain.ogg' });
        assert.deepEqual(floor.extra.choices, [{ label: '上前问安', goto: 'hall-2' }, { text: '悄悄退下' }]);
        assert.equal(floor.extra.narrator, true);
        // 服务端簿记健在
        assert.equal(floor.extra.api, 'openai');
        assert.equal(floor.extra.model, 'test-model');
        assert.equal(floor.extra.luker_server_persisted, true);
        // swipe 槽位同文(mes 是提后正文,不是原始 JSON)
        assert.deepEqual(floor.swipes, ['暮色四合,大殿里只剩烛火。']);
        assert.deepEqual(floor.swipe_info[0].extra.choices, floor.extra.choices);
        assert.equal(floor.extra.luker_generation_id, undefined, '协议层 ack 令牌不落盘');
    } finally {
        fixture.cleanup();
    }
});

test('未置真 + 产出是 JSON → 原文落 mes,不解析不捏 extra', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [{ name: 'User', is_user: true, mes: 'hi' }]);

        const req = makeRequest(fixture.dirs, 'normal'); // 无 theater flag
        const job = createGenerationJob(req, { job_id: uniqueJobId('plain-json'), persist_target: characterPersistTarget });
        const output = JSON.stringify({ mes: 'hi', choices: [{ text: 'a' }] });
        assert.equal(await persistJobReplyText(job, output, job.id, 'test-model'), true);

        const floor = (await readBody(repo))[1];
        assert.equal(floor.mes, output, '原文落 mes——不显式置真就不猜形状');
        assert.equal(floor.extra.choices, undefined);
        assert.equal(floor.extra.scene, undefined);
        assert.equal(floor.extra.api, 'openai');
        assert.equal(floor.extra.luker_server_persisted, true);
    } finally {
        fixture.cleanup();
    }
});

test('theater 置真 + 非 JSON 产出 → 原文落 mes,兜底不炸', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [{ name: 'User', is_user: true, mes: 'hi' }]);

        const req = makeRequest(fixture.dirs, 'normal', { lukerGeneration: { theater: true } });
        const job = createGenerationJob(req, { job_id: uniqueJobId('theater-plain'), persist_target: characterPersistTarget });
        assert.equal(await persistJobReplyText(job, '普通文本回复。', job.id, 'test-model'), true);

        const floor = (await readBody(repo))[1];
        assert.equal(floor.mes, '普通文本回复。');
        assert.equal(floor.extra.choices, undefined);
        assert.equal(floor.extra.luker_server_persisted, true);
    } finally {
        fixture.cleanup();
    }
});

test('persist_target.extra 客户端袋并入;簿记键不可被盖', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [{ name: 'User', is_user: true, mes: 'hi' }]);

        const req = makeRequest(fixture.dirs, 'normal');
        const job = createGenerationJob(req, {
            job_id: uniqueJobId('client-extra'),
            persist_target: {
                ...characterPersistTarget,
                extra: {
                    scene: { bg: '/assets/backgrounds/dojo.jpg' },
                    narrator: true,
                    api: 'spoofed', // 簿记键——必须被滤掉,服务端真相胜
                    luker_server_persisted: false,
                },
            },
        });
        assert.equal(await persistJobReplyText(job, '你好。', job.id, 'test-model'), true);

        const floor = (await readBody(repo))[1];
        assert.equal(floor.mes, '你好。');
        assert.deepEqual(floor.extra.scene, { bg: '/assets/backgrounds/dojo.jpg' }, '客户端指定 scene 原样并入');
        assert.equal(floor.extra.narrator, true, '客户端指定 narrator 原样并入');
        assert.equal(floor.extra.api, 'openai', '袋内 api 不盖服务端真相');
        assert.equal(floor.extra.luker_server_persisted, true, '袋内簿记键被滤');
    } finally {
        fixture.cleanup();
    }
});

test('swipe 并楼:旧袋保留 + 新结构化产出并入,新槽正文=提后正文', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [
            { name: 'User', is_user: true, mes: 'hi' },
            aiFloor('v1', { extra: { scene: { bg: '/old.jpg' } } }),
        ]);

        const req = makeRequest(fixture.dirs, 'swipe', { lukerGeneration: { theater: true } });
        const job = createGenerationJob(req, { job_id: uniqueJobId('theater-swipe'), persist_target: characterPersistTarget });
        const output = JSON.stringify({
            mes: 'v2 台词。',
            choices: [{ text: '走' }, { text: '留' }],
        });
        assert.equal(await persistJobReplyText(job, output, job.id, 'test-model'), true);

        const body = await readBody(repo);
        assert.equal(body.length, 2, '并楼不增楼');
        const floor = body[1];
        assert.deepEqual(floor.swipes, ['v1', 'v2 台词。']);
        assert.equal(floor.mes, 'v2 台词。');
        assert.deepEqual(floor.extra.scene, { bg: '/old.jpg' }, '旧楼层袋原样保留');
        assert.deepEqual(floor.extra.choices, [{ text: '走' }, { text: '留' }], '新产出 choices 并入');
        assert.equal(floor.extra.luker_server_persisted, true);
        assert.deepEqual(floor.swipe_info[1].extra.choices, floor.extra.choices, 'swipe_info 快照同步');
    } finally {
        fixture.cleanup();
    }
});

test('completeGenerationJobFromText:theater 置真 → job.theater 快照(choices 契约位)', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const req = makeRequest(fixture.dirs, 'normal', { lukerGeneration: { theater: true } });
        const job = createGenerationJob(req, { job_id: uniqueJobId('theater-job'), persist_target: characterPersistTarget });
        const output = JSON.stringify({
            mes: '落针可闻。',
            choices: [{ label: 'A' }, { label: 'B', goto: 'b' }],
            scene: { bg: '/bg.jpg' },
        });
        await completeGenerationJobFromText(req, job, output, 'test-model');
        assert.equal(job.status, 'awaiting_ack');
        assert.ok(job.theater, '结构化快照落 job.theater');
        assert.equal(job.theater.text, '落针可闻。');
        assert.deepEqual(job.theater.extra.choices, [{ label: 'A' }, { label: 'B', goto: 'b' }]);
        assert.deepEqual(job.theater.extra.scene, { bg: '/bg.jpg' });
        // GET /jobs/:id 的 choices 位 = job.theater.extra.choices(插件面直读)
        assert.deepEqual(job.theater?.extra?.choices, [{ label: 'A' }, { label: 'B', goto: 'b' }]);
        // ack 掉 → 清 15s 兜底定时器(测试进程不被吊住)
        acknowledgeGenerationJobsForRequest(req, [job.id]);
        assert.equal(job.status, 'completed');
    } finally {
        fixture.cleanup();
    }
});

test('老聊天无 extra 楼层 → 正常 persist 不炸,extra 只有簿记', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        await seedChat(repo, [
            { name: 'User', is_user: true, send_date: 1, mes: 'old hi' },
            { name: CHAR, is_user: false, send_date: 2, mes: 'old reply' },
        ]);

        const req = makeRequest(fixture.dirs, 'normal');
        const job = createGenerationJob(req, { job_id: uniqueJobId('legacy-floor'), persist_target: characterPersistTarget });
        assert.equal(await persistJobReplyText(job, 'new reply', job.id, 'test-model'), true);

        const body = await readBody(repo);
        assert.equal(body.length, 3);
        assert.equal(body[0].extra, undefined, '老楼层无 extra 照样读回');
        const floor = body[2];
        assert.equal(floor.mes, 'new reply');
        assert.equal(floor.extra.api, 'openai');
        assert.equal(floor.extra.choices, undefined);
    } finally {
        fixture.cleanup();
    }
});

test('旁白两形共存:extra.narrator 与上游惯例 extra.type=narrator 都原样', async () => {
    const fixture = await makeTempFsEngine();
    try {
        await initStorage({ mode: 'fs', directoriesByHandle: () => fixture.dirs });
        const repo = getChatRepo();
        // 写侧:两种旁白标记各自落盘(上游 type 形 + theater narrator 形)
        await seedChat(repo, [
            { name: '', is_user: false, is_system: true, send_date: 1, mes: '开场白', extra: { type: 'narrator' } },
            { name: '', is_user: false, is_system: false, send_date: 2, mes: '旁注一句', extra: { narrator: true } },
        ]);
        const body = await readBody(repo);
        assert.equal(body[0].extra.type, 'narrator', '上游惯例标记透传');
        assert.equal(body[1].extra.narrator, true, 'theater 标记透传');
    } finally {
        fixture.cleanup();
    }
});
