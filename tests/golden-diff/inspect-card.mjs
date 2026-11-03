// inspect-card.mjs — 深扒一张卡的兼容面:TH 脚本、regex、远程资源 URL
// Usage: node inspect-card.mjs <card.png>
import { extractCard, surfaceTags } from './extract-card.mjs';

const p = process.argv[2];
const { card, fileSize } = extractCard(p);
const d = card.data || card;
const ex = d.extensions || {};
console.log('fileSize', (fileSize / 1e6).toFixed(1) + 'MB');
console.log('name:', d.name);
console.log('ext keys:', Object.keys(ex));
console.log('surfaces:', surfaceTags(card).join(', '));
console.log('assets field:', JSON.stringify(d.assets || null)?.slice(0, 400));

const ths = ex.tavern_helper?.scripts || [];
console.log('\n=== tavern_helper scripts:', ths.length);
for (const s of ths) {
    console.log(`- ${s.name} | content ${(s.content || '').length}B | button:${!!s.button} | export_with:${s.export_with ?? '-'}`);
}
const rx = ex.regex_scripts || [];
console.log('\n=== regex scripts:', rx.length);
for (const s of rx) {
    console.log(`- ${s.scriptName || s.name} | find ${(s.findRegex || '').length}B replace ${(s.replaceString || '').length}B | placement:${JSON.stringify(s.placement)}`);
}

// 全部脚本体里的远程 URL(看资源从哪下载)
console.log('\n=== remote URLs in script bodies ===');
const seen = new Map();
const pools = [
    ...ths.map(s => ['th:' + s.name, s.content || '']),
    ...rx.map(s => ['rx:' + (s.scriptName || s.name), s.replaceString || '']),
    ['desc', d.description || ''],
    ['first_mes', d.first_mes || ''],
    ...(d.alternate_greetings || []).map((g, i) => ['greet' + i, g]),
];
for (const [where, body] of pools) {
    const urls = body.match(/https?:\/\/[^\s"'`\\<>)]+/g) || [];
    for (const u of urls) {
        const key = u.replace(/[?#].*/, '');
        if (!seen.has(key)) seen.set(key, where);
    }
}
for (const [u, w] of [...seen.entries()].slice(0, 40)) console.log(`${w} -> ${u.slice(0, 110)}`);

// 卡里引用的本地/内嵌资源名
const dataKeys = ['character_book', 'world', 'creator_notes_multilingual'];
for (const k of dataKeys) {
    if (d[k] !== undefined) console.log(`\n${k}:`, JSON.stringify(d[k]).slice(0, 200));
}
