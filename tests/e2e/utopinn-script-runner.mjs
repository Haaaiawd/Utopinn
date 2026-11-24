// TASK-019 STscript runner E2E:
// /echo(通知收敛)/ /setvar+getvar(chat 变量持久化)/ /setglobalvar(settings 落库)
// /sendas(消息进 chat)/ /add /if 控制流 / /run QR(QuickReply 递归)
// 注意 ST 参数语义:setvar 的值是未名参数,if 的 then 是未名闭包子命令。
import fs from 'node:fs';
const B = 'http://127.0.0.1:8000';
const CHAR = 'default_我没想当掌门啊';
const CHAT = 'e2e-script-probe';
const QR_PROBE = 'apps/server/data/default-user/QuickReplies/_e2e_probe.json';
let cookie = '', token = '';

async function req(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-csrf-token'] = token;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setC = res.headers.getSetCookie?.() ?? [];
    if (setC.length) {
        const jar = new Map((cookie ? cookie + '; ' : '').split('; ').filter(Boolean).map(c => c.split('=')));
        for (const c of setC) { const [pair] = c.split(';'); const [k] = pair.split('='); jar.set(k, pair); }
        cookie = [...jar.values()].join('; ');
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

const out = [];
const log = (n, ok, d = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);
const run = (script) => req('POST', '/api/utopinn/script/run', { charDir: CHAR, chatName: CHAT, script });

token = (await req('GET', '/csrf-token')).body?.token ?? '';
const base = `/api/utopinn/characters/${CHAR}/chats`;
await req('DELETE', `${base}/${CHAT}`);
await req('PUT', `${base}/${CHAT}`, {});

// 探测 QR 集
fs.writeFileSync(QR_PROBE, JSON.stringify({
    version: 2, name: '_e2e_probe',
    qrList: [{ label: 'PROBE', message: '/return qr-fired', isHidden: true }],
}));

// 1. /echo → notifications
let r = await run('/echo hello-stscript');
log('echo 通知', r.status === 200 && r.body?.notifications?.some(n => /hello-stscript/.test(n.text ?? '')), JSON.stringify(r.body?.notifications).slice(0, 100));

// 2. /add 数学 pipe
r = await run('/add 2 3');
log('add', String(r.body?.pipe) === '5', `pipe=${r.body?.pipe}`);

// 3. /setvar(未名 value)+ /getvar 读回 + chat_metadata 落库
r = await run('/setvar key=probe 42');
r = await run('/getvar probe');
log('chat 变量读回', String(r.body?.pipe) === '42', `pipe=${r.body?.pipe}`);
r = await req('GET', `${base}/${CHAT}`);
log('chat_metadata.variables 落库', r.body?.header?.chat_metadata?.variables?.probe === '42', JSON.stringify(r.body?.header?.chat_metadata?.variables));

// 4. /setglobalvar → settings 落库
r = await run('/setglobalvar key=gprobe gval');
const settings = JSON.parse(fs.readFileSync('apps/server/data/default-user/settings.json', 'utf8'));
log('全局变量落库', settings?.extension_settings?.variables?.global?.gprobe === 'gval', JSON.stringify(settings?.extension_settings?.variables?.global).slice(0, 120));

// 5. /sendas → 消息进 chat
r = await run(`/sendas name={{user}} hello-from-script`);
let msgs = (await req('GET', `${base}/${CHAT}`)).body?.messages ?? [];
log('sendas 消息进 chat', msgs.some(m => /hello-from-script/.test(m.mes ?? '')), `msgs=${msgs.length}`);

// 6. /if + 闭包子命令(闭包是 /if 的未名参数,不接管道)
r = await run('/if left=1 right=1 rule=eq {: /return yes :}');
log('if 控制流', String(r.body?.pipe) === 'yes', `pipe=${JSON.stringify(r.body?.pipe)}`);

// 7. /run → QuickReply 递归
r = await run('/run PROBE');
log('QR 递归执行', String(r.body?.pipe) === 'qr-fired', `pipe=${JSON.stringify(r.body?.pipe)?.slice(0, 80)}`);

// 8. 宏替换 {{user}} {{char}}
r = await run('/echo {{user}} vs {{char}}');
log('宏求值', r.body?.notifications?.some(n => /我没想当掌门啊/.test(n.text ?? '')), JSON.stringify(r.body?.notifications?.[0]?.text));

// 9. 清理:chat + QR + 全局变量
await run('/flushglobalvar gprobe');
await req('DELETE', `${base}/${CHAT}`);
fs.unlinkSync(QR_PROBE);
const s2 = JSON.parse(fs.readFileSync('apps/server/data/default-user/settings.json', 'utf8'));
log('清理', !s2?.extension_settings?.variables?.global?.gprobe);

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
