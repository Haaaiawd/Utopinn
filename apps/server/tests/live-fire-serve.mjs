/**
 * 实弹常驻服务(手动工具,非 CI):与 live-fire-aiping.mjs 同一套种子,
 * 但起完不退——留给真实浏览器/Playwright 点发送验证前端改道。
 *
 * 用法:
 *   set -a; source apps/server/.env.local; set +a
 *   node apps/server/tests/live-fire-serve.mjs
 *   → 打印 URL 后持续驻留;Ctrl+C 退出。
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './e2e/_lib/server.js';
import { markOnboarded } from './e2e/_lib/fixtures.js';

const { UBERGE_TEST_API_URL, UBERGE_TEST_API_KEY, UBERGE_TEST_MODEL } = process.env;
if (!UBERGE_TEST_API_URL || !UBERGE_TEST_API_KEY || !UBERGE_TEST_MODEL) {
    console.error('need UBERGE_TEST_API_URL / UBERGE_TEST_API_KEY / UBERGE_TEST_MODEL in env');
    process.exit(2);
}

const HANDLE = 'default-user';
const CHAT = 'live-fire';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PRESET_SRC = resolve(REPO, 'assets/Meowssiah_1.9.12.json');
const CARD_SRC = resolve(REPO, 'assets/诡异修仙人生模拟器.png');
const CHAR_DIR = '诡异修仙人生模拟器';
const PETBOOK_SRC = resolve(REPO, 'assets/宠物行为世界书.json');
const PETBOOK = '宠物行为世界书';

const server = await startServer({
    batchKey: 'generation',
    scenarioId: 'aiping-live-serve',
    extraEnv: {
        NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    },
    extraConfig: {
        port: 18998,
        'requestProxy.enabled': true,
        'requestProxy.url': process.env.HTTPS_PROXY || process.env.https_proxy || '',
    },
});

console.log(`server up: ${server.baseURL}  dataRoot=${server.dataRoot}`);
markOnboarded({ dataRoot: server.dataRoot });

const userRoot = resolve(server.dataRoot, HANDLE);
const settingsPath = resolve(userRoot, 'settings.json');
const sdoc = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
sdoc.oai_settings = {
    ...(sdoc.oai_settings ?? {}),
    chat_completion_source: 'openai',
    reverse_proxy: UBERGE_TEST_API_URL,
    proxy_password: UBERGE_TEST_API_KEY,
    model: UBERGE_TEST_MODEL,
    openai_model: UBERGE_TEST_MODEL,
};
sdoc.world_info_settings = {
    ...(sdoc.world_info_settings ?? {}),
    world_info: {
        ...(sdoc.world_info_settings?.world_info ?? {}),
        globalSelect: [PETBOOK],
        charLore: [{ name: CHAR_DIR, extraBooks: [PETBOOK] }],
    },
};
writeFileSync(settingsPath, JSON.stringify(sdoc, null, 4));

mkdirSync(resolve(userRoot, 'OpenAI Settings'), { recursive: true });
mkdirSync(resolve(userRoot, 'characters'), { recursive: true });
const presetDst = resolve(userRoot, 'OpenAI Settings', 'Meowssiah.json');
copyFileSync(PRESET_SRC, presetDst);
const presetDoc = JSON.parse(readFileSync(presetDst, 'utf8'));
presetDoc.openai_model = UBERGE_TEST_MODEL;
if ('model' in presetDoc) presetDoc.model = UBERGE_TEST_MODEL;
writeFileSync(presetDst, JSON.stringify(presetDoc, null, 4));
copyFileSync(CARD_SRC, resolve(userRoot, 'characters', `${CHAR_DIR}.png`));
mkdirSync(resolve(userRoot, 'worlds'), { recursive: true });
copyFileSync(PETBOOK_SRC, resolve(userRoot, 'worlds', `${PETBOOK}.json`));

const chatsDir = resolve(userRoot, 'chats', CHAR_DIR);
mkdirSync(chatsDir, { recursive: true });
writeFileSync(resolve(chatsDir, `${CHAT}.jsonl`), [
    { user_name: 'User', character_name: CHAR_DIR, create_date: Date.now(), chat_metadata: { world_info: PETBOOK } },
    { name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: '系统,帮我看一下修仙境界和修行体系,顺便开始模拟吧。' },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

console.log(`READY  url=${server.baseURL}  char=${CHAR_DIR}  chat=${CHAT}`);
// 驻留:进程不退,harness 子进程随之存活;Ctrl+C 整组带走。
await new Promise(() => {});
