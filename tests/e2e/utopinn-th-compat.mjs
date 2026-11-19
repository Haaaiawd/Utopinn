// TASK-025 TH 兼容层 E2E:
// getVariables/insertOrAssignVariables/deleteVariable(chat 域=chat_metadata.variables,
// 含 MVU stat_data 对象根)/ getChatMessages / triggerSlash 递归 /
// unsupported 显式返回 / {{getvar::stat_data.*}} 宏互通。
import fs from 'node:fs';
const B = 'http://127.0.0.1:8000';
const CHAR = 'default_Seraphina';
const CHAT = 'e2e-th-probe';
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
const call = (method, args, target = { charDir: CHAR, chatName: CHAT }) =>
    req('POST', '/api/utopinn/th/call', { method, args, target });

token = (await req('GET', '/csrf-token')).body?.token ?? '';
const base = `/api/utopinn/characters/${CHAR}/chats`;
await req('DELETE', `${base}/${CHAT}`);
await req('PUT', `${base}/${CHAT}`, {});
// 预置 MVU 形态的 stat_data 原生对象(TH 生态的真实形状)
await req('PATCH', `${base}/${CHAT}`, {
    ops: [{ op: 'replace', path: '/header/chat_metadata/variables', value: { stat_data: { 背包: { 金币: 100, 药水: ['红', '蓝'] } } } }],
});

// 1. getVariables chat 域读 stat_data 对象根
let r = await call('getVariables', { type: 'chat' });
log('chat 变量面', r.status === 200 && r.body?.result?.stat_data?.背包?.金币 === 100, JSON.stringify(r.body?.result).slice(0, 100));

// 2. path 深读(TH lodash 语义)
r = await call('getVariables', { type: 'chat', path: 'stat_data.背包.金币' });
log('path 深读', r.body?.result === 100, `result=${JSON.stringify(r.body?.result)}`);

// 3. insertOrAssignVariables 路径合写(不改整树)
r = await call('insertOrAssignVariables', { type: 'chat', variables: { 'stat_data.背包.金币': 150, 'stat_data.状态.hp': 80 } });
log('assign 写', r.status === 200 && r.body?.ok === true);
r = await call('getVariables', { type: 'chat', path: 'stat_data.背包.药水' });
log('其余字段未毁', Array.isArray(r.body?.result) && r.body.result[0] === '红', JSON.stringify(r.body?.result));

// 4. chat_metadata 落库验证
r = await req('GET', `${base}/${CHAT}`);
const vars = r.body?.header?.chat_metadata?.variables;
log('落库', vars?.stat_data?.背包?.金币 === 150 && vars?.stat_data?.状态?.hp === 80, JSON.stringify(vars).slice(0, 140));

// 5. {{getvar::stat_data.*}} 宏互通(stscript 宏 ↔ TH 面同一份数据)
r = await req('POST', '/api/utopinn/script/run', { charDir: CHAR, chatName: CHAT, script: '/echo {{getvar::stat_data.背包.金币}}' });
log('宏互通', r.body?.notifications?.some(n => /150/.test(n.text ?? '')), JSON.stringify(r.body?.notifications));

// 6. deleteVariable
r = await call('deleteVariable', { type: 'chat', path: 'stat_data.状态.hp' });
log('delete', r.body?.ok === true && r.body?.existed === true);
r = await call('getVariables', { type: 'chat', path: 'stat_data.状态.hp' });
log('delete 生效', r.body?.result === undefined || r.body?.result === null);

// 7. global 域
r = await call('insertOrAssignVariables', { type: 'global', variables: { 'th.probe': 'yes' } });
const s = JSON.parse(fs.readFileSync('apps/server/data/default-user/settings.json', 'utf8'));
log('global 落库', s?.extension_settings?.variables?.global?.th?.probe === 'yes');
await call('deleteVariable', { type: 'global', path: 'th.probe' });

// 8. getChatMessages
await req('POST', `${base}/${CHAT}/messages`, { messages: [{ name: 'You', is_user: true, mes: 'm1', send_date: 1 }, { name: 'Seraphina', is_user: false, mes: 'm2', send_date: 2 }] });
r = await call('getChatMessages', { start: 0, end: 2 });
log('消息面', r.body?.result?.length === 2 && r.body.result[1].role === 'assistant' && r.body.result[1].mes === 'm2', `count=${r.body?.result?.length}`);

// 9. triggerSlash
r = await call('triggerSlash', { script: '/echo th-triggered' });
log('triggerSlash', r.body?.ok === true && r.body?.notifications?.some(n => /th-triggered/.test(n.text ?? '')), JSON.stringify(r.body?.notifications));

// 10. unsupported 显式
r = await call('createOrReplaceCharacter', { name: 'x' });
log('unsupported', r.body?.unsupported === true && r.body?.method === 'createOrReplaceCharacter', JSON.stringify(r.body));

// 11. message 域(TH 消息级变量)
r = await call('insertOrAssignVariables', { type: 'message', message_id: 1, variables: { 'stat_data.临时': 'v' } });
log('message 域写', r.body?.ok === true);
r = await call('getVariables', { type: 'message', message_id: 1, path: 'stat_data.临时' });
log('message 域读', r.body?.result === 'v', `result=${r.body?.result}`);

// 12. 语料卡 th_scripts 抽样:getEmbeddedScripts 归一化 + 逐条 triggerSlash 实跑
const CARD = 'e2e-th-card';
const cbase = `/api/utopinn/characters/${CARD}/chats`;
fs.copyFileSync('tests/corpus/cards/th-probe.json', `apps/server/data/default-user/characters/${CARD}.json`);
await req('PUT', `${cbase}/${CHAT}`, {});
try {
    r = await call('getEmbeddedScripts', {}, { charDir: CARD, chatName: CHAT });
    const scripts = r.body?.result ?? [];
    log('卡嵌脚本枚举', scripts.length === 2 && scripts[1].name === 'init-bag', JSON.stringify(scripts).slice(0, 140));
    let ran = 0;
    for (const s of scripts) {
        const rr = await call('triggerSlash', { script: s.script }, { charDir: CARD, chatName: CHAT });
        if (rr.body?.ok === true) ran++;
    }
    log('th_scripts 抽样运行', ran === scripts.length && ran > 0, `ran=${ran}/${scripts.length}`);
    r = await call('getVariables', { type: 'chat', path: 'stat_data.背包.火把' }, { charDir: CARD, chatName: CHAT });
    log('卡脚本写变量', Number(r.body?.result) === 3, `火把=${JSON.stringify(r.body?.result)}`);
} finally {
    await req('DELETE', `${cbase}/${CHAT}`);
    fs.unlinkSync(`apps/server/data/default-user/characters/${CARD}.json`);
}

// 清理
await req('DELETE', `${base}/${CHAT}`);
log('清理', true);

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} pass`);
process.exit(fails.length ? 1 : 0);
