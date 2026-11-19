#!/usr/bin/env node
// diag 观测面实弹演示:起 scratch 服 → 造事件 → 人类可读 logs/errors/trace。
// 不进验收矩阵;报告取证用。`node diag-demo.mjs` 跑完自拆。
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..', '..');
const CLI_PATH = resolve(SERVER_DIR, '..', 'cli', 'utopinn-cli.mjs');
process.env.E2E_READY_TIMEOUT_MS ||= '600000';
const { startServer, tearDownServer, cloneDataDir, SCRATCH_ROOT } = await import(new URL('../e2e/_lib/server.js', import.meta.url));
const { writeCharacter, writePreset, writeWorldBook, markOnboarded, BRYN_ENTRIES } = await import(new URL('../e2e/_lib/fixtures.js', import.meta.url));

const CHAR_DIR = 'acceptance-ash', CHAT = 'acc-main', PRESET = 'acc-preset', BOOK = 'acc-book';

function findPrebuiltBundlesDir() {
    const root = resolve(SERVER_DIR, 'data', '_webpack');
    if (!existsSync(root)) return null;
    for (const hash of readdirSync(root)) {
        const out = join(root, hash, 'output');
        if (['lib.core.bundle.js', 'lib.optional.bundle.js', 'codemirror.bundle.js'].every(f => existsSync(join(out, f)))) return out;
    }
    return null;
}

let server = null, hangServer = null;
try {
    hangServer = createHttpServer(() => {});
    await new Promise(r => hangServer.listen(0, '127.0.0.1', r));
    const hangPort = hangServer.address().port;
    const dataRoot = resolve(SCRATCH_ROOT, `utopinn-demo-data-${process.pid}`);
    cloneDataDir(dataRoot);
    writeCharacter({ dataRoot, avatarFile: `${CHAR_DIR}.png` });
    writePreset({ dataRoot, name: PRESET });
    writeWorldBook({ dataRoot, name: BOOK, entries: BRYN_ENTRIES });
    markOnboarded({ dataRoot });
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const sdoc = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    sdoc.oai_settings = { ...(sdoc.oai_settings ?? {}), chat_completion_source: 'openai', reverse_proxy: `http://127.0.0.1:${hangPort}/v1`, model: 'acc-probe', openai_model: 'acc-probe', api_key_openai: 'demo' };
    writeFileSync(settingsPath, JSON.stringify(sdoc, null, 4));

    const bundles = findPrebuiltBundlesDir();
    const t0 = Date.now();
    server = await startServer({
        batchKey: 'server', scenarioId: 'utopinn-demo', useExistingDataRoot: dataRoot,
        extraEnv: { NO_PROXY: 'localhost,127.0.0.1', ...(bundles ? { LUKER_PREBUILT_BUNDLES_DIR: bundles } : {}) },
    });
    console.log(`server up: ${server.baseURL} boot=${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

    const WORK = mkdtempSync(join(tmpdir(), 'utopinn-demo-'));
    const STATE = join(WORK, 'cli-state.json');
    const cli = (args, { quiet } = {}) => {
        const r = spawnSync(process.execPath, [CLI_PATH, '-s', server.baseURL, '--state', STATE, ...args],
            { encoding: 'utf8', timeout: 120_000, cwd: WORK, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' } });
        if (!quiet) process.stdout.write(String(r.stdout ?? ''));
        if (r.stderr && !quiet) process.stderr.write(String(r.stderr).slice(0, 500));
        return { rc: r.status, stdout: String(r.stdout ?? '') };
    };
    const banner = (s) => console.log(`\n\x1b[1m═══ $ ${s} ═══\x1b[0m`);

    // 备语境(与验收矩阵同路径)
    cli(['chat-create', CHAT, '--char', CHAR_DIR], { quiet: true });
    cli(['use', CHAR_DIR, CHAT, '--preset', PRESET], { quiet: true });
    // WI 书绑到聊天 header.chat_metadata.world_info,worldinfo 段才有料
    const wiOp = { ops: [{ op: 'add', path: '/header/chat_metadata/world_info', value: BOOK }] };
    const bindR = cli(['raw', 'PATCH', `/api/utopinn/characters/${CHAR_DIR}/chats/${CHAT}`, JSON.stringify(wiOp)], { quiet: true });
    console.log(`world bind → ${bindR.stdout.trim().split('\n').pop()?.slice(0, 160)}`);

    banner('preview(干跑组装)');
    cli(['preview', '-n', '3']);

    banner('generate 实弹(上游挂死 → job running)');
    cli(['raw', 'POST', '/api/utopinn/generate', JSON.stringify({ charDir: CHAR_DIR, chatName: CHAT, type: 'quiet', user: { name: 'User' } })]);
    // 等 job 落 store
    let jobId = null;
    {
        const dl = Date.now() + 15_000;
        while (Date.now() < dl && !jobId) {
            const r = cli(['jobs', '--json'], { quiet: true });
            try { const env = JSON.parse(r.stdout.trim().split('\n').pop()); jobId = env?.data?.[0]?.id ?? null; } catch { }
            if (!jobId) await new Promise(r2 => setTimeout(r2, 800));
        }
    }
    console.log(`jobId=${jobId}`);

    banner('logs --kind inject');
    cli(['logs', '--kind', 'inject', '-n', '20']);

    banner('先造一个 404,再 errors');
    cli(['chat-get', 'ghost-chat'], { quiet: true });
    cli(['errors', '-n', '10']);

    banner('logs 全量 tail 15');
    cli(['logs', '-n', '15']);

    if (jobId) { banner(`trace ${jobId.slice(0, 8)}…`); cli(['trace', jobId]); }
} finally {
    if (server) await tearDownServer(server).catch(() => {});
    if (hangServer) hangServer.close();
}
