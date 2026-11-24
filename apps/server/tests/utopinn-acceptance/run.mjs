#!/usr/bin/env node
/**
 * TASK-038 收尾件 —— utopinn CLI 验收矩阵(可重跑)。
 *
 * 起一台 scratch 服务端(e2e 同款 harness:克隆 seed data/ + OS 空端口 +
 * 就绪轮询),预置最小语料(卡/预设×2/世界书/settings 探针),然后按域
 * 逐个跑 `apps/cli/utopinn-cli.mjs` 动词,断言 rc + JSON envelope 内容。
 *
 * 覆盖:kernel/doctor(66 named)· library 读面(chars/chats/chat-get/
 * presets/worlds/wi/personas/settings 脱敏两态/secrets)· chat 写面
 * (chat-create/chat-put CAS+409 重锚/chat-rename/chat-delete)· generate
 * 干跑 preview · jobs(jobs/inspect)· mvu state · plugins 列表 · backup
 * 产物 · settings-set 回读 · state sidecar 三族全链
 * (get→patch→get→delete→空读)· 冲突路径(preset rename 撞档 rc3、
 * patch test-fail rc3、chat 重名 rc3)。
 *
 * 不覆盖(按任务边界):真 LLM 生成(外部密钥)、WS 流式面。generate 实弹
 * 派发仅用于在 job store 里造一条 job 供 jobs/inspect 断言——上游指向
 * runner 内挂的 127.0.0.1 hang-server(收连接永不回包),job 常驻
 * 'running' 态(failed job 带 error 字段,会踩 cmdInspect 的 not_found
 * 误报),随 runner 退出被 teardown 一并收掉,零外部依赖。
 *
 * 用法:
 *   node apps/server/tests/utopinn-acceptance/run.mjs [--keep] [--verbose]
 *   UTOPINN_E2E_SCRATCH_ROOT=/tmp/xyz node ...   # scratch 根目录覆盖
 *
 * 退出码:全过=0,有 FAIL=1,服务端起不来=2。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..', '..');
const CLI_PATH = resolve(SERVER_DIR, '..', 'cli', 'utopinn-cli.mjs');
const KEEP = process.argv.includes('--keep');
const VERBOSE = process.argv.includes('--verbose');

// scratch 根:e2e harness 读 E2E_SCRATCH_ROOT;任务约定 UTOPINN_E2E_SCRATCH_ROOT
// 也可作入口(语义同一个东西,后者优先由外层指定)。
process.env.E2E_SCRATCH_ROOT = process.env.UTOPINN_E2E_SCRATCH_ROOT
    || process.env.E2E_SCRATCH_ROOT
    || resolve(SERVER_DIR, 'tests/.e2e-scratch');
process.env.E2E_READY_TIMEOUT_MS ||= '600000'; // 本机 /mnt 盘冷起 ~10min

const { startServer, tearDownServer, cloneDataDir, SCRATCH_ROOT } = await import(new URL('../e2e/_lib/server.js', import.meta.url));
const { writeCharacter, writePreset, writeWorldBook, markOnboarded, BRYN_ENTRIES } = await import(new URL('../e2e/_lib/fixtures.js', import.meta.url));

// ─── 语料常量 ───
const CHAR_DIR = 'acceptance-ash';
const CHAT = 'acc-main';
const PRESET = 'acc-preset';
const PRESET2 = 'acc-preset-src';
const BOOK = 'acc-book';
const PLANTED_KEY = 'sk-acc-plant-123';       // settings.oai_settings.api_key_openai
const SECRET_VALUE = 'sk-live-acc-42';        // secrets 面写入值
const PU_PROBE = 'acc-7';                     // settings-set 回读探针

// ─── 报告 ───
const results = [];
const t0 = Date.now();
let currentGroup = '';
const group = (name) => { currentGroup = name; console.log(`\n\x1b[1m# ${name}\x1b[0m`); };
function rec(name, ok, detail = '', ms = 0) {
    results.push({ name, ok: Boolean(ok), detail, ms });
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`;
    if (!ok || VERBOSE) console.log(`  ${ok ? '\x1b[32m' : '\x1b[31m'}${line}\x1b[0m`);
}

// ─── CLI 调用器:每次全新进程,--state 指向 scratch 文件,--json envelope ───
let WORK, STATE_FILE, BASE;
function cli(args, { stdin } = {}) {
    const t = Date.now();
    const r = spawnSync(process.execPath,
        [CLI_PATH, '-s', BASE, '--state', STATE_FILE, '--json', ...args],
        {
            input: stdin ?? '', encoding: 'utf8', timeout: 120_000, cwd: WORK,
            // char 全文/大世界书 dump 会超 spawnSync 默认 1MB 上限(新种子卡
            // 内嵌卡应用让单卡 JSON 达数 MB),显式放大防 ENOBUFS 假阴性。
            maxBuffer: 64 * 1024 * 1024,
            env: {
                ...process.env,
                NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
            },
        });
    const stdout = String(r.stdout ?? '');
    let env = null;
    for (const line of stdout.trim().split('\n').reverse()) {
        try {
            const j = JSON.parse(line);
            if (j && typeof j === 'object' && 'ok' in j) { env = j; break; }
        } catch { /* non-envelope line */ }
    }
    if (!env) { try { env = JSON.parse(stdout); } catch { /* schema 裸输出兜底 */ } }
    return { rc: r.status ?? (r.error ? -1 : 1), env, stdout, stderr: String(r.stderr ?? ''), ms: Date.now() - t };
}
const d = (r) => r.env?.data;
const errOf = (r) => r.env?.error ?? {};
function expect(name, r, { rc = 0, err } = {}, then) {
    const okRc = Array.isArray(rc) ? rc.includes(r.rc) : r.rc === rc;
    let ok = okRc, detail = `rc=${r.rc}`;
    if (ok && err && errOf(r).code !== err) { ok = false; detail += ` err=${errOf(r).code}`; }
    if (ok && then) {
        const extra = then(d(r), r);
        if (extra !== true) { ok = false; detail += ` ${extra}`; }
    }
    if (!ok) detail += ` | stdout:${r.stdout.slice(0, 220)}`;
    rec(name, ok, detail, r.ms);
    return r;
}
// CLI 本地 state 手术:plant 陈旧 integrity,逼 chat-put 走 409→重锚路径。
function mutateCliState(mut) {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    mut(s);
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── 预置语料(pre-boot:先克隆种子再写盘,服务端冷启吃进内存后任何
//      legacy 重存都不会把探针键冲掉;post-boot 直写会被服务端自己的
//      settings 保存覆盖——实测被 /api/characters/* 链路的写盘清掉过)───
const { writeCardToPng } = await import('@utopinn/formats').catch(() => ({}));
/** 嵌真 PNG 探头卡:card_app 资产走 data.extensions.card_app.files。 */
function writeCardAppProbe({ dataRoot, avatarFile, name, cardApp }) {
    const charsDir = resolve(dataRoot, 'default-user', 'characters');
    mkdirSync(charsDir, { recursive: true });
    const seed = resolve(SERVER_DIR, 'default/content/default_我没想当掌门啊.png');
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name, description: 'cardapp acceptance probe', personality: '', scenario: '',
            first_mes: 'probe', mes_example: '', creator_notes: '', system_prompt: '',
            post_history_instructions: '', alternate_greetings: [], tags: ['acc'],
            creator: 'acc', character_version: '1.0',
            extensions: { card_app: cardApp },
        },
    };
    if (typeof writeCardToPng !== 'function') throw new Error('@utopinn/formats writeCardToPng 不可导入(cardapp 探头无法制卡)');
    const png = writeCardToPng(new Uint8Array(readFileSync(seed)), JSON.stringify(card));
    writeFileSync(resolve(charsDir, avatarFile), Buffer.from(png));
}

function seedCorpus(dataRoot, { upstreamUrl }) {
    writeCharacter({ dataRoot, avatarFile: `${CHAR_DIR}.png` });
    // cardapp headless 探头 ×2:document 面(TH 链+事件订阅)与 module 面(init(ctx))。
    // mounts 按「PNG 元数据优先」读卡——必须真嵌 PNG tEXt,sidecar 不顶用。
    writeCardAppProbe({ dataRoot, avatarFile: 'acc-cardapp.png', name: 'CardApp Probe', cardApp: {
        enabled: true, entry: 'index.html',
        files: {
            'index.html': '<!doctype html><html><body><div id="app">loading</div><script>'
                + '(function(){var app=document.getElementById("app");'
                + 'if(!window.TavernHelper){app.textContent="NO-SHIM";return}'
                + 'TavernHelper.eventOn("acc_probe_ev",function(){app.textContent+="EVHIT"});'
                + 'TavernHelper.getVariables({type:"chat"}).then(function(v){app.textContent="VARS:"+JSON.stringify(v)})'
                + '})();</script></body></html>',
            'style.css': '#app{color:#eee}',
        },
    } });
    writeCardAppProbe({ dataRoot, avatarFile: 'acc-cardapp-mod.png', name: 'CardApp Module Probe', cardApp: {
        enabled: true, entry: 'index.js',
        files: {
            'index.js': 'export async function init(ctx){document.getElementById("card-app-container").textContent="MODULE-INIT:"+ctx.charId}',
        },
    } });
    writePreset({ dataRoot, name: PRESET });
    writePreset({ dataRoot, name: PRESET2 });
    writeWorldBook({ dataRoot, name: BOOK, entries: BRYN_ENTRIES });
    markOnboarded({ dataRoot });
    // settings 探针:①api_key_openai 供脱敏两态断言 ②上游指向 runner
    // 内挂的 hang-server——generate 派发后 job 常驻 'running',inspect
    // 可断言真 job(failed job 的 error 字段会踩 CLI 的 not_found 误报)
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const sdoc = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    sdoc.oai_settings = {
        ...(sdoc.oai_settings ?? {}),
        chat_completion_source: 'openai',
        // 首跑一次会把 legacy oai 槽合成 connection_profiles(default 档指
        // 真 api.openai.com);profile 派发恒优先于 oai_settings.reverse_proxy,
        // 不清空 generate 会直连外网而不是 hang-server。置空回落旧单槽。
        connection_profiles: [],
        reverse_proxy: upstreamUrl,
        proxy_password: 'acc-probe-pw',
        model: 'acc-probe', openai_model: 'acc-probe',
        api_key_openai: PLANTED_KEY,
    };
    writeFileSync(settingsPath, JSON.stringify(sdoc, null, 4));
}

// 诊断:settings 断言失败时把磁盘实况并进 detail,区分「文件被
// 覆写」与「读到另一份 doc」。只读,不影响断言路径。
function settingsFileSnapshot() {
    try {
        const fp = resolve(server.dataRoot, 'default-user', 'settings.json');
        const j = JSON.parse(readFileSync(fp, 'utf8'));
        return `file keys=${Object.keys(j).length} oai=${Boolean(j.oai_settings)} pu=${Boolean(j.power_user)}`;
    } catch (e) { return `file unreadable:${e?.message}`; }
}

// ─── runner 直连取证(仅 settings raw=1 用)───
// CLI 的 --json envelope 在 ~140KB 载荷时被 CLI 自己的
// `process.exit()` 截断(stdout 未 drain 完进程已退,已知 CLI bug,
// 本任务禁改 CLI)。脱敏断言改用 `settings --out` 落盘(文件写是
// CLI 进程内同步完成);raw=1 的明文键断言走这里直连——同一
// /api/utopinn 面、同一 CSRF+session 握手,只绕开 CLI 的
// stdout 传输层。
let _csrf = '', _cookie = '';
async function directGet(pathname) {
    if (!_csrf) {
        const r = await fetch(`${BASE}/csrf-token`);
        _csrf = (await r.json()).token;
        _cookie = (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
    }
    const r = await fetch(`${BASE}${pathname}`, {
        headers: { 'x-csrf-token': _csrf, cookie: _cookie },
    });
    return { status: r.status, data: await r.json().catch(() => null) };
}

function findPrebuiltBundlesDir() {
    const root = resolve(SERVER_DIR, 'data', '_webpack');
    if (!existsSync(root)) return null;
    for (const hash of readdirSync(root)) {
        const out = join(root, hash, 'output');
        if (['lib.core.bundle.js', 'lib.optional.bundle.js', 'codemirror.bundle.js'].every(f => existsSync(join(out, f)))) return out;
    }
    return null;
}

// ═══ 主流程 ═══
let server = null, hangServer = null;
try {
    // 挂死上游:收连接永不回包——generate 派发后 job 停 'running' 态,
    // 供 jobs/inspect 断言;随 runner 退出关死,不产生任何外部调用。
    hangServer = createHttpServer(() => { /* hold forever */ });
    await new Promise(r => hangServer.listen(0, '127.0.0.1', r));
    const hangPort = hangServer.address().port;

    const bundles = findPrebuiltBundlesDir();
    // 自管 dataRoot:克隆种子 → 预置语料 → useExistingDataRoot 起服
    const dataRoot = resolve(SCRATCH_ROOT, `utopinn-acceptance-data-${process.pid}`);
    cloneDataDir(dataRoot);
    seedCorpus(dataRoot, { upstreamUrl: `http://127.0.0.1:${hangPort}/v1` });
    const bootT = Date.now();
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'utopinn-acceptance',
        useExistingDataRoot: dataRoot,
        extraEnv: {
            NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
            ...(bundles ? { LUKER_PREBUILT_BUNDLES_DIR: bundles } : {}),
        },
    });
    BASE = server.baseURL;
    console.log(`server up: ${BASE}  boot=${((Date.now() - bootT) / 1000).toFixed(1)}s  dataRoot=${server.dataRoot}${bundles ? '  [prebuilt bundles]' : ''}`);

    // kernel 就绪二次确认(harness 只等 /)
    {
        const dl = Date.now() + 30_000;
        let ok = false;
        while (Date.now() < dl) {
            try { const r = await fetch(`${BASE}/api/utopinn/_kernel`); if (r.ok) { ok = true; break; } } catch { /* boot */ }
            await new Promise(r => setTimeout(r, 300));
        }
        if (!ok) throw new Error('kernel /api/utopinn/_kernel 30s 内未就绪');
    }

    WORK = mkdtempSync(join(tmpdir(), 'utopinn-acc-'));
    STATE_FILE = join(WORK, 'cli-state.json');

    // ──────────────── A. diag:kernel + doctor ────────────────
    group('kernel/doctor(66 named)');
    let r = cli(['kernel']);
    expect('kernel 路由表', r, { rc: 0 }, (data) => {
        const routes = data?.routes ?? [];
        if (routes.length < 66) return `routes=${routes.length}<66`;
        if (!routes.includes('GET|exact|/api/utopinn/_kernel')) return 'kernel 自举路由缺失';
        return true;
    });
    r = cli(['doctor', '--full']);
    expect('doctor 全链路', r, { rc: 0 }, (data) => {
        if (data?.ok !== true) return `steps=${JSON.stringify(data?.steps?.filter(s => !s.ok)?.map(s => s.name))}`;
        const cov = data?.steps?.find(s => s.name === 'capability coverage')?.detail ?? '';
        if (!/raw-only 0/.test(cov)) return `coverage="${cov}"`;
        return true;
    });

    // ──────────────── B. ctx + library 读面 ────────────────
    group('library 读面 + ctx');
    r = cli(['chat-create', CHAT, '--char', CHAR_DIR]);
    expect('chat-create(空文件)', r, { rc: 0 }, (data) => data?.created === CHAT || `created=${data?.created}`);
    r = cli(['chat-create', CHAT, '--char', CHAR_DIR]);
    expect('chat-create 重名 rc3', r, { rc: 3, err: 'exists' });
    r = cli(['use', CHAR_DIR, CHAT]);
    expect('use 绑 ctx', r, { rc: 0 }, (data) => (data?.charDir === CHAR_DIR && data?.chatName === CHAT) || JSON.stringify(data));
    r = cli(['chars']);
    expect('chars 含种子卡', r, { rc: 0 }, (data) => Array.isArray(data) && data.some(c => c.dir === CHAR_DIR) || 'dir 未出现');
    r = cli(['char', CHAR_DIR]);
    expect('char 卡全文', r, { rc: 0 });
    r = cli(['chats']);
    expect('chats 含 acc-main', r, { rc: 0 }, (data) => Array.isArray(data) && data.some(c => c.name === CHAT) || 'chat 未出现');
    r = cli(['chat-get']);
    expect('chat-get 空档', r, { rc: 0 }, (data) => Array.isArray(data?.messages) || 'messages 非数组');
    r = cli(['presets']);
    expect('presets 含种子', r, { rc: 0 }, (data) => Array.isArray(data) && data.includes(PRESET) || JSON.stringify(data).slice(0, 120));
    r = cli(['worlds']);
    expect('worlds 含种子书', r, { rc: 0 }, (data) => Array.isArray(data) && data.some(w => w.name === BOOK) || 'book 未出现');
    r = cli(['wi', BOOK]);
    expect('wi 条目', r, { rc: 0 }, (data) => (data?.count ?? 0) >= 1 || `count=${data?.count}`);
    r = cli(['personas']);
    expect('personas 列表', r, { rc: 0 }, (data) => Array.isArray(data?.items) || 'items 非数组');
    r = cli(['recent']);
    expect('recent(kernel)', r, { rc: 0 });
    // settings 文档 ~140KB,CLI --json envelope 会被 CLI 自己的
    // process.exit() 提前截断(stdout 未 drain,已知 CLI bug,本任务
    // 不改 CLI)——内容断言走 `settings --out` 落盘(CLI 进程内同步
    // 写盘)+ raw envelope 前缀的 status:200 + runner 直连取证明文键。
    r = cli(['settings', '--out', join(WORK, 'settings-sanitized.json')]);
    expect('settings 脱敏态', r, { rc: 0 }, () => {
        let doc;
        try { doc = JSON.parse(readFileSync(join(WORK, 'settings-sanitized.json'), 'utf8')); }
        catch (e) { return `out 文件不可读:${e?.message}`; }
        const oai = doc?.oai_settings;
        if (!oai) return `oai_settings 缺失 (${settingsFileSnapshot()})`;
        if ('api_key_openai' in oai) return 'api_key_openai 未脱敏';
        if ('proxy_password' in oai) return 'proxy_password 未脱敏';
        return true;
    });
    r = cli(['raw', 'GET', '/api/utopinn/settings?raw=1']);
    expect('settings raw=1 CLI 面 200', r, { rc: 0 }, (data, rr) =>
        (rr.stdout.includes('"status":200') && rr.stdout.includes('"data":{"settings"'))
        || 'envelope 前缀缺 status:200/settings');
    {
        const raw = await directGet('/api/utopinn/settings?raw=1');
        const ok = raw.status === 200 && raw.data?.settings?.oai_settings?.api_key_openai === PLANTED_KEY;
        rec('settings raw=1 未脱敏(明文键)', ok, `status=${raw.status} key=${raw.data?.settings?.oai_settings?.api_key_openai} (${settingsFileSnapshot()})`);
    }
    let secretId = null;
    r = cli(['secret-set', 'api_key_openai', '--value', SECRET_VALUE]);
    expect('secret-set', r, { rc: 0 }, (data) => { secretId = data?.id ?? null; return secretId ? true : 'id 缺失'; });
    r = cli(['secrets']);
    expect('secrets 打码读', r, { rc: 0 }, (data) => {
        const v = data?.secrets?.api_key_openai?.[0]?.value;
        if (v === undefined) return 'api_key_openai 未列出';
        if (v === SECRET_VALUE) return '明文回显';
        return true;
    });
    if (secretId) {
        r = cli(['secret-delete', 'api_key_openai', String(secretId)]);
        expect('secret-delete', r, { rc: 0 });
    }

    // ──────────────── C. chat 写面:CAS / 重锚 / rename ────────────────
    group('chat 写面(CAS + 409 重锚 + rename)');
    const msg = (name, isUser, mes) => ({ name, is_user: isUser, is_system: false, send_date: Date.now(), mes });
    const docV1 = { header: { user_name: 'User', character_name: 'Ash the Cartographer' }, messages: [msg('User', true, '潮位几点合适?'), msg('Ash', false, '*她敲了敲海图边缘。* 等风停的那一阵。')] };
    const docV2 = { header: { user_name: 'User', character_name: 'Ash the Cartographer' }, messages: [msg('User', true, '潮位几点合适?'), msg('Ash', false, '等风停的那一阵。'), msg('User', true, '那就今夜。')] };
    r = cli(['chat-put', JSON.stringify(docV1)]);
    expect('chat-put v1(CAS)', r, { rc: 0 }, (data) => (data?.ok === true && typeof data?.integrity === 'string') || JSON.stringify(data));
    r = cli(['chat-get']);
    expect('回读 2 楼', r, { rc: 0 }, (data) => data?.messages?.length === 2 || `floors=${data?.messages?.length}`);
    // plant 陈旧 integrity → chat-put 必须 409→重锚→重试成功
    mutateCliState(s => { s.integrity = 'deadbeefdeadbeef'; });
    r = cli(['chat-put', JSON.stringify(docV2)]);
    expect('chat-put 409 重锚重试', r, { rc: 0 }, (data) => (data?.integrity && data.integrity !== 'deadbeefdeadbeef') || `integrity=${data?.integrity}`);
    r = cli(['chat-get']);
    expect('重锚后 3 楼', r, { rc: 0 }, (data) => data?.messages?.length === 3 || `floors=${data?.messages?.length}`);
    r = cli(['raw', 'PUT', `/api/utopinn/characters/${CHAR_DIR}/chats/${CHAT}/document`, JSON.stringify({ header: {}, messages: [], integrity: 'deadbeefdeadbeef' })]);
    expect('document CAS 服务端 409', r, { rc: 0 }, (data) => data?.status === 409 || `status=${data?.status}`);
    r = cli(['chat-get']);
    expect('409 后文档未损', r, { rc: 0 }, (data) => data?.messages?.length === 3 || `floors=${data?.messages?.length}`);
    r = cli(['chat-rename', 'acc-main2']);
    expect('chat-rename', r, { rc: 0 }, (data) => data?.renamed === 'acc-main2' || JSON.stringify(data));
    r = cli(['chat-get', CHAT]);
    expect('旧名 404', r, { rc: 1, err: 'not_found' });
    r = cli(['chats']);
    expect('新名入列', r, { rc: 0 }, (data) => Array.isArray(data) && data.some(c => c.name === 'acc-main2') || 'acc-main2 未出现');
    r = cli(['chat-rename', CHAT]);
    expect('rename 还原', r, { rc: 0 });
    r = cli(['chat-create', 'acc-tmp']);
    expect('chat-create ctx 内', r, { rc: 0 });
    r = cli(['chat-delete', 'acc-tmp']);
    expect('chat-delete', r, { rc: 0 });
    r = cli(['use', CHAR_DIR, CHAT]);
    expect('ctx 重绑', r, { rc: 0 });

    // ──────────────── D. generate 干跑 + jobs ────────────────
    group('generate 干跑 + jobs/inspect');
    r = cli(['preview']);
    expect('preview messages 非空', r, { rc: 0 }, (data) => (data?.count ?? 0) > 0 || `count=${data?.count}`);
    r = cli(['raw', 'POST', '/api/utopinn/generate', JSON.stringify({ charDir: CHAR_DIR, chatName: CHAT, type: 'quiet', user: { name: 'User' } })]);
    expect('generate 派发 200', r, { rc: 0 }, (data) => data?.status === 200 || `status=${data?.status} ${JSON.stringify(data?.data).slice(0, 140)}`);
    // 上游挂死 → job 常驻 'running';inspect 吃 running 态(failed job 的
    // error 字段会踩 cmdInspect `d.error`→not_found 的 CLI 已知误报)
    let jobId = null;
    {
        const dl = Date.now() + 15_000;
        while (Date.now() < dl && !jobId) {
            r = cli(['jobs']);
            const items = Array.isArray(d(r)) ? d(r) : [];
            if (items.length) jobId = items[0].id;
            else await new Promise(r2 => setTimeout(r2, 800));
        }
    }
    rec('jobs 列表有项', Boolean(jobId), jobId ? `id=${String(jobId).slice(0, 8)}` : '15s 内无 job');
    if (jobId) {
        r = cli(['inspect', jobId]);
        expect('inspect running job', r, { rc: 0 }, (data) => (data?.id === jobId && data?.status === 'running') || `id=${data?.id} status=${data?.status}`);
        // job 留在 'running' 态由 teardown 收掉——kernel 面当前没有暴露
        // job abort 路由(legacy /api/generation/:id/abort 不在 utopinn
        // named set 内),不越权验证未发布的协议面。
    }
    r = cli(['inspect', 'ffffffff-0000-0000-0000-000000000000']);
    expect('inspect 不存在 job', r, { rc: 1, err: 'not_found' });

    // ──────────────── E. mvu / plugins / backup / settings-set ────────────────
    group('mvu/plugins/backup/settings-set');
    r = cli(['mvu', 'state']);
    expect('mvu state', r, { rc: 0 });
    r = cli(['plugins']);
    expect('plugins 列表', r, { rc: 0 }, (data) => (Array.isArray(data) && data.length >= 8) || `fibers=${data?.length}`);
    r = cli(['backup', '--out', join(WORK, 'backup.zip')]);
    expect('backup 产物', r, { rc: 0 }, (data) => {
        const f = data?.file;
        if (!f || !existsSync(f)) return `file=${f}`;
        const head = readFileSync(f).subarray(0, 2).toString('latin1');
        return head === 'PK' || '非 zip';
    });
    r = cli(['settings-set', JSON.stringify({ power_user: { acceptance_probe: PU_PROBE } })]);
    expect('settings-set PATCH', r, { rc: 0 });
    // 回读同样绕 envelope 截断:settings --out 落盘后查 power_user 探针
    // (power_user 非密段,脱敏视图原样保留)。
    r = cli(['settings', '--out', join(WORK, 'settings-after.json')]);
    expect('settings 回读探针', r, { rc: 0 }, () => {
        let doc;
        try { doc = JSON.parse(readFileSync(join(WORK, 'settings-after.json'), 'utf8')); }
        catch (e) { return `out 文件不可读:${e?.message}`; }
        return doc?.power_user?.acceptance_probe === PU_PROBE || `got=${doc?.power_user?.acceptance_probe}`;
    });
    r = cli(['settings-set', JSON.stringify({ oai_settings: { model: 'x' } })]);
    expect('settings-set 白名单拒', r, { rc: 2, err: 'usage' });

    // ──────────────── F. state chat 全链 ────────────────
    group('state chat:get→patch→get→delete→空读');
    r = cli(['state', 'chat', 'patch', 'accns1', JSON.stringify([{ op: 'add', path: '/hp', value: 5 }])]);
    expect('chat patch 建档', r, { rc: 0 }, (data) => (data?.ok === true && data?.applied >= 1) || JSON.stringify(data));
    r = cli(['state', 'chat', 'get', 'accns1']);
    expect('chat get 回读', r, { rc: 0 }, (data) => data?.data?.hp === 5 || JSON.stringify(data?.data));
    r = cli(['state', 'chat', 'get', 'accns1', '--via', 'get']);
    expect('chat get --via get(ETag 线形)', r, { rc: 0 }, (data) => data?.data?.hp === 5 || JSON.stringify(data?.data));
    r = cli(['state', 'chat', 'get-batch', 'accns1', 'accnsX']);
    expect('chat get-batch', r, { rc: 0 }, (data) => (data?.data?.accns1?.hp === 5 && data?.data?.accnsX == null) || JSON.stringify(data?.data));
    r = cli(['state', 'chat', 'patch', 'accns1', JSON.stringify([{ op: 'test', path: '/hp', value: 999 }])]);
    expect('chat patch test-fail rc3', r, { rc: 3 });
    r = cli(['state', 'chat', 'delete', 'accns1']);
    expect('chat delete', r, { rc: 0 }, (data) => data?.deleted === true || JSON.stringify(data));
    r = cli(['state', 'chat', 'get', 'accns1']);
    expect('chat 空读 null', r, { rc: 0 }, (data) => (data?.ok === true && data?.data == null) || JSON.stringify(data));

    // ──────────────── G. state char 全链 ────────────────
    group('state char:set→patch→get→delete→空读');
    r = cli(['state', 'char', 'set', 'accns2', JSON.stringify({ gold: 7 })]);
    expect('char set 整态', r, { rc: 0 }, (data) => data?.ok === true || JSON.stringify(data));
    r = cli(['state', 'char', 'get', 'accns2']);
    expect('char get 回读', r, { rc: 0 }, (data) => data?.data?.gold === 7 || JSON.stringify(data?.data));
    r = cli(['state', 'char', 'get-batch', 'accns2', 'accnsX']);
    expect('char get-batch', r, { rc: 0 }, (data) => (data?.data?.accns2?.gold === 7 && data?.data?.accnsX == null) || JSON.stringify(data?.data));
    r = cli(['state', 'char', 'patch', 'accns2', JSON.stringify([{ op: 'test', path: '/gold', value: 1 }])]);
    expect('char patch test-fail rc3', r, { rc: 3 });
    r = cli(['state', 'char', 'patch', 'accns2', JSON.stringify([{ op: 'add', path: '/silver', value: 2 }])]);
    expect('char patch 增量', r, { rc: 0 });
    r = cli(['state', 'char', 'get', 'accns2']);
    expect('char 增量回读', r, { rc: 0 }, (data) => data?.data?.silver === 2 || JSON.stringify(data?.data));
    r = cli(['state', 'char', 'delete', 'accns2']);
    expect('char delete', r, { rc: 0 });
    r = cli(['state', 'char', 'get', 'accns2']);
    expect('char 空读 null', r, { rc: 0 }, (data) => (data?.ok === true && data?.data == null) || JSON.stringify(data));

    // ──────────────── H. state preset 全链 + 撞档 ────────────────
    group('state preset:全链 + rename 撞档');
    r = cli(['state', 'preset', 'patch', PRESET, 'accns1', JSON.stringify([{ op: 'add', path: '/x', value: 1 }])]);
    expect('preset patch 建档', r, { rc: 0 });
    r = cli(['state', 'preset', 'get', PRESET, 'accns1']);
    expect('preset get 回读', r, { rc: 0 }, (data) => data?.data?.x === 1 || JSON.stringify(data?.data));
    r = cli(['state', 'preset', 'get-batch', PRESET, 'accns1', 'accnsX']);
    expect('preset get-batch', r, { rc: 0 }, (data) => (data?.data?.accns1?.x === 1 && data?.data?.accnsX == null) || JSON.stringify(data?.data));
    r = cli(['state', 'preset', 'patch', PRESET, 'accns1', JSON.stringify([{ op: 'test', path: '/x', value: 2 }])]);
    expect('preset patch test-fail rc3', r, { rc: 3 });
    r = cli(['state', 'preset', 'delete', PRESET, 'accns1']);
    expect('preset delete', r, { rc: 0 });
    r = cli(['state', 'preset', 'get', PRESET, 'accns1']);
    expect('preset 空读 null', r, { rc: 0 }, (data) => (data?.ok === true && data?.data == null) || JSON.stringify(data));
    r = cli(['state', 'preset', 'patch', PRESET2, 'mvu', JSON.stringify([{ op: 'add', path: '/k', value: 1 }])]);
    expect('撞档预置:src ns', r, { rc: 0 });
    r = cli(['state', 'preset', 'patch', PRESET, 'mvu', JSON.stringify([{ op: 'add', path: '/k', value: 2 }])]);
    expect('撞档预置:dst 同 ns', r, { rc: 0 });
    r = cli(['state', 'preset', 'rename', PRESET2, PRESET]);
    expect('preset rename 撞档 rc3', r, { rc: 3, err: 'exists' });
    r = cli(['state', 'preset', 'delete-all', PRESET2]);
    expect('preset delete-all 清档', r, { rc: 0 }, (data) => (data?.deleted ?? 0) >= 1 || `deleted=${data?.deleted}`);
    r = cli(['state', 'preset', 'delete', PRESET, 'mvu']);
    expect('撞档清扫', r, { rc: 0 });

    // ──────────────── I. 错误面 ────────────────
    group('错误面(usage/not_found)');
    r = cli(['status']);
    expect('status 在线快照', r, { rc: 0 });
    r = cli(['chat-get', 'ghost-chat']);
    expect('chat-get 不存在', r, { rc: 1, err: 'not_found' });
    r = cli(['bogus-verb']);
    expect('未知动词 rc2', r, { rc: 2, err: 'usage' });
    r = cli(['state', 'chat', 'frobnicate']);
    expect('state 非法 op rc2', r, { rc: 2, err: 'usage' });

    // ──────────────── J. diag 事件总线(events/errors/stats/trace) ────────────────
    // 事件源已由上面各组自然产出:plugin_active(boot)/http_4xx(404/409/400)/
    // inject(preview+generate 组装)/job_running(generate 派发)。
    group('diag 总线:events/errors/stats/trace/client');
    r = cli(['logs']);
    expect('logs 全量有事件', r, { rc: 0 }, (data) =>
        (Array.isArray(data) && data.length > 0 && data.every(e => e.seq && e.ts && e.kind && e.lvl)) || 'empty/shape');
    r = cli(['logs', '--kind', 'inject']);
    expect('logs --kind inject 过滤', r, { rc: 0 }, (data) =>
        (Array.isArray(data) && data.length > 0 && data.every(e => e.kind === 'inject')) || `kinds=${[...new Set((data ?? []).map(e => e.kind))]}`);
    r = cli(['errors']);
    expect('errors 含 http_404', r, { rc: 0 }, (data) =>
        (Array.isArray(data) && data.some(e => e.kind === 'http' && String(e.code ?? '').includes('404'))) || 'http_404 未入总线');
    if (jobId) {
        r = cli(['trace', jobId]);
        expect('trace 聚合 job+injections', r, { rc: 0 }, (data) =>
            (data?.id === jobId && Array.isArray(data?.injections) && data.injections.some(s => s.stage === 'worldinfo') && Array.isArray(data?.events))
            || `id=${data?.id} inj=${data?.injections?.length}`);
    }
    r = cli(['raw', 'GET', '/api/utopinn/diag/stats']);
    expect('diag stats 计数', r, { rc: 0 }, (data) =>
        (data?.status === 200 && (data?.data?.byKind?.job ?? 0) >= 1 && (data?.data?.byKind?.http ?? 0) >= 1 && (data?.data?.byKind?.inject ?? 0) >= 1)
        || JSON.stringify(data?.data).slice(0, 140));
    r = cli(['diag-client', 'acc-probe', '--code', 'probe']);
    expect('diag-client 上报', r, { rc: 0 }, (data) => data?.ok === true && typeof data?.seq === 'number' || JSON.stringify(data));

    // ──────────────── K. cardapp headless 宿主(jsdom 真跑) ────────────────
    // 一次性进程语义:每动词独立 mount→act→dispose。jsdom 在 9P/NFS 上冷
    // import 可能 >60s——UTOPINN_CARDAPP_DEPS_DIR 指向本地镜像可秒级;本
    // 面只跑 6 个用例,正常磁盘 ~15s/个。
    group('cardapp headless(jsdom 真跑卡 HTML/JS)');
    r = cli(['chat-create', 'acc-cardapp-chat', '--char', 'acc-cardapp']);
    expect('cardapp chat 就绪', r, { rc: 0 });
    r = cli(['use', 'acc-cardapp', 'acc-cardapp-chat']);
    expect('cardapp ctx 绑定', r, { rc: 0 });
    r = cli(['chat-put', JSON.stringify({ header: { user_name: 'User', character_name: 'CardApp Probe', chat_metadata: { variables: { acc_probe: 'seeded', counter: 7 } } }, messages: [] })]);
    expect('cardapp 变量播种', r, { rc: 0 });
    r = cli(['cardapp', 'mount']);
    expect('cardapp mount(document 面)', r, { rc: 0 }, (data) =>
        (data?.ok === true && data?.mount?.face === 'th' && data?.mount?.entryKind === 'document')
        || `mount=${JSON.stringify(data?.mount).slice(0, 160)}`);
    r = cli(['cardapp', 'eval', "document.getElementById('app').textContent"]);
    expect('cardapp eval(卡自跑 TH 链)', r, { rc: 0 }, (data) =>
        /VARS:\{[^}]*acc_probe/.test(String(data?.result ?? '')) || `result=${JSON.stringify(data?.result).slice(0, 160)}`);
    r = cli(['cardapp', 'call', 'getVariables', '{"type":"chat"}']);
    expect('cardapp call getVariables', r, { rc: 0 }, (data) => data?.result?.acc_probe === 'seeded' || `result=${JSON.stringify(data?.result).slice(0, 140)}`);
    r = cli(['th', 'getVariables', '{"type":"chat"}']);
    expect('th getVariables 对拍同真值', r, { rc: 0 }, (data) => data?.result?.acc_probe === 'seeded' || `result=${JSON.stringify(data?.result).slice(0, 140)}`);
    // 事件投递:卡 init 里 eventOn('acc_probe_ev') → 宿主 push 等价物
    // (shim 的 __utopinnPanelReceive 入口,与 bridge.push 同路) → DOM 落 EVHIT
    r = cli(['cardapp', 'eval',
        "(async()=>{window.__utopinnPanelReceive({channel:'utopinn-panel',direction:'push',nonce:window.__UTOPINN_PANEL_NONCE__,event:'th.event',payload:{name:'acc_probe_ev',args:[]}});await new Promise(r=>setTimeout(r,80));return document.getElementById('app').textContent})()"]);
    expect('cardapp th.event 推送投递', r, { rc: 0 }, (data) => /EVHIT/.test(String(data?.result ?? '')) || `result=${JSON.stringify(data?.result).slice(0, 160)}`);
    // nonce 门:错 nonce 的桥请求必须回 bad_nonce wire 错(bridge.ts 同码)
    r = cli(['cardapp', 'eval',
        "(async()=>{let hit=null;const orig=window.__utopinnPanelReceive;window.__utopinnPanelReceive=(m)=>{hit=m;return orig(m)};window.__utopinnPanelPost({channel:'utopinn-panel',direction:'request',nonce:'BADNONCE',requestId:'q1',method:'th.getVariables',args:{type:'chat'}});await new Promise(r=>setTimeout(r,120));return hit?.error?.code??('resp='+JSON.stringify(hit))})()"]);
    expect('cardapp 错 nonce → bad_nonce', r, { rc: 0 }, (data) => data?.result === 'bad_nonce' || `result=${JSON.stringify(data?.result)}`);
    // module 面:esbuild bundle + 显式 init(ctx)——服务端 module shell 只
    // 载不跑,init 调用是本宿主补的死卡点(设计 §0-1)
    r = cli(['chat-create', 'acc-mod-chat', '--char', 'acc-cardapp-mod']);
    expect('module chat 就绪', r, { rc: 0 });
    r = cli(['cardapp', 'mount', '--char', 'acc-cardapp-mod', '--chat', 'acc-mod-chat']);
    expect('cardapp mount(module init)', r, { rc: 0 }, (data) =>
        (data?.ok === true && data?.mount?.initCalled === true && data?.mount?.face === 'ctx')
        || `mount=${JSON.stringify(data?.mount).slice(0, 160)}`);
    r = cli(['cardapp', 'eval', "document.getElementById('card-app-container').textContent", '--char', 'acc-cardapp-mod', '--chat', 'acc-mod-chat']);
    expect('module init(ctx) 真执行', r, { rc: 0 }, (data) =>
        /MODULE-INIT:acc-cardapp-mod/.test(String(data?.result ?? '')) || `result=${JSON.stringify(data?.result).slice(0, 160)}`);
    r = cli(['use', CHAR_DIR, CHAT]);
    expect('ctx 还原', r, { rc: 0 });

} catch (e) {
    console.error(`\nSETUP FAIL: ${e?.message ?? e}`);
    rec('setup', false, String(e?.message ?? e));
} finally {
    if (server) {
        await tearDownServer(server, { removeData: !KEEP });
    }
    if (hangServer) {
        try { hangServer.close(); } catch { /* ignore */ }
    }
}

// ─── 报告 ───
const fails = results.filter(x => !x.ok);
const ms = Date.now() - t0;
console.log(`\n${'═'.repeat(60)}`);
console.log(`结果: ${results.length - fails.length}/${results.length} pass · 总耗时 ${(ms / 1000).toFixed(1)}s`);
if (fails.length) {
    console.log('失败明细:');
    for (const f of results.filter(x => !x.ok)) console.log(`  ✗ ${f.name} — ${f.detail}`);
}
if (WORK && !KEEP) { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ } }
if (KEEP) console.log(`--keep: dataRoot=${server?.dataRoot} work=${WORK} state=${STATE_FILE}`);
process.exit(fails.length ? 1 : 0);
