#!/usr/bin/env node
// extract-card.mjs — PNG char card → JSON payload + compat-surface manifest.
// Usage: node extract-card.mjs <dir|file.png> [--manifest out.json]
// Golden-diff 语料入库器:标签每张卡覆盖的兼容面,喂给捕获/比对管线。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { inflateSync } from 'node:zlib';

function decodeChunk(buf) {
    const kwEnd = buf.indexOf(0);
    const keyword = buf.slice(0, kwEnd).toString();
    return { keyword, text: buf.slice(kwEnd + 1).toString() };
}

export function extractCard(pngPath) {
    const buf = readFileSync(pngPath);
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + pngPath);
    const cards = {};
    let off = 8;
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (type === 'tEXt' || type === 'zTXt') {
            const raw = buf.slice(off + 8, off + 8 + len);
            const { keyword, text } = type === 'tEXt'
                ? decodeChunk(raw)
                : { keyword: raw.slice(0, raw.indexOf(0)).toString(), text: inflateSync(raw.slice(raw.indexOf(0) + 2)).toString() };
            if (keyword === 'chara' || keyword === 'ccv3') {
                try { cards[keyword] = JSON.parse(Buffer.from(text, 'base64').toString()); } catch { /* non-json chunk */ }
            }
        }
        off += 12 + len;
    }
    const card = cards.ccv3 || cards.chara;
    if (!card) throw new Error('no character data in ' + pngPath);
    return { card, fileSize: buf.length };
}

/** Label which compat surfaces a card exercises (golden-diff corpus index). */
export function surfaceTags(card) {
    const d = card.data || card;
    const ex = d.extensions || {};
    const tags = new Set();
    if (d.character_book?.entries && Object.keys(d.character_book.entries).length) tags.add('embedded_worldbook');
    if (ex.regex_scripts?.length) tags.add('regex_scripts');
    if (ex.tavern_helper) tags.add('tavern_helper');
    if (ex.card_app) tags.add('card_app');
    if (ex.depth_prompt?.prompt || ex.depth_prompt) tags.add('depth_prompt');
    if (d.alternate_greetings?.length) tags.add('alternate_greetings');
    if (d.group_only_greetings?.length) tags.add('group_card');
    if (ex.talkativeness !== undefined) tags.add('talkativeness');
    if (d.system_prompt || d.post_history_instructions) tags.add('system_override');
    const wiEntries = Object.values(d.character_book?.entries || {});
    if (wiEntries.some(e => e.use_regex)) tags.add('wi_regex_keys');
    if (wiEntries.some(e => e.selective)) tags.add('wi_selective');
    if (wiEntries.some(e => e.constant)) tags.add('wi_constant');
    return [...tags].sort();
}

const target = process.argv[2];
if (!target) { console.error('usage: extract-card.mjs <dir|file.png>'); process.exit(1); }
const files = statSync(target).isDirectory()
    ? readdirSync(target).filter(f => f.endsWith('.png')).map(f => join(target, f))
    : [target];
const manifest = [];
for (const f of files) {
    try {
        const { card, fileSize } = extractCard(f);
        manifest.push({
            file: basename(f),
            name: card.data?.name || card.name,
            spec: card.spec || 'v1/v2',
            fileSize,
            bookEntries: Object.keys(card.data?.character_book?.entries || {}).length,
            regexScripts: card.data?.extensions?.regex_scripts?.length || 0,
            thScripts: card.data?.extensions?.tavern_helper?.scripts?.length || 0,
            surfaces: surfaceTags(card),
        });
    } catch (e) { manifest.push({ file: basename(f), error: e.message }); }
}
console.log(JSON.stringify(manifest, null, 1));
if (process.argv.includes('--manifest')) {
    const out = process.argv[process.argv.indexOf('--manifest') + 1];
    writeFileSync(out, JSON.stringify(manifest, null, 1));
    console.error('manifest -> ' + out);
}
