// byaf.test.mjs — BYAF manifest → v2 卡转换 + 图片/背景提取 + 宏替换
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { ByafParser } from '../dist/index.js';

const te = new TextEncoder();
const IMG = new Uint8Array([0x89, 0x50, 4, 5]);

function byaf(manifest, files) {
    return zipSync({ 'manifest.json': te.encode(JSON.stringify(manifest)), ...files });
}

const manifest = {
    author: { name: 'backyarder', backyardURL: 'https://backyard.ai/u/x' },
    characters: ['characters/hero.json'],
    scenarios: ['scenarios/s1.json', 'scenarios/s2.json'],
};
const character = {
    name: 'Hero',
    displayName: 'Hero显示名',
    persona: 'a {user} friendly {character}: knight',
    isNSFW: true,
    loreItems: [
        { key: 'sword, blade', value: 'a {character} sword of {user}' },
    ],
    images: [{ path: 'img/avatar.png', label: 'front' }],
};
const s1 = {
    narrative: '{character} meets {user}: intro',
    firstMessages: [{ text: 'hi {user}' }],
    exampleMessages: [{ text: '{user}: yo\n{character}: hey' }],
    formattingInstructions: 'always greet {user}',
    backgroundImage: 'bg/castle.png',
};
const s2 = {
    narrative: 'second scenario',
    firstMessages: [{ text: 'alt greeting' }],
};

const buf = byaf(manifest, {
    'characters/hero.json': te.encode(JSON.stringify(character)),
    'characters/img/avatar.png': IMG,
    'scenarios/s1.json': te.encode(JSON.stringify(s1)),
    'scenarios/s2.json': te.encode(JSON.stringify(s2)),
    'bg/castle.png': IMG,
});

test('BYAF → v2 卡:宏替换/NSFW 标签/内嵌书/display_name', () => {
    const r = new ByafParser(buf).parse();
    const d = r.card.data;
    assert.equal(r.card.spec, 'chara_card_v2');
    assert.equal(d.name, 'Hero');
    assert.equal(d.description, 'a {{user}} friendly {{char}}: knight');
    assert.equal(d.scenario, '{{char}} meets {{user}}: intro');
    assert.equal(d.first_mes, 'hi {{user}}');
    assert.equal(d.system_prompt, 'always greet {{user}}');
    assert.deepEqual(d.tags, ['nsfw']);
    assert.equal(d.creator, 'backyarder');
    assert.equal(d.creator_notes, 'https://backyard.ai/u/x');
    assert.equal(d.extensions.display_name, 'Hero显示名');
    // alternate greetings = s2 first message(s1 进 first_mes)
    assert.deepEqual(d.alternate_greetings, ['alt greeting']);
    // loreItems → character_book
    assert.equal(d.character_book.entries.length, 1);
    assert.deepEqual(d.character_book.entries[0].keys, ['sword', 'blade']);
    assert.match(d.character_book.entries[0].content, /\{\{char\}\} sword of \{\{user\}\}/);
    // mes_example 带 <START> 分隔
    assert.match(d.mes_example, /<START>\n\{\{user\}\}: yo/);
});

test('BYAF 图片与聊天背景提取', () => {
    const r = new ByafParser(buf).parse();
    assert.equal(r.images[0].filename, 'avatar.png');
    assert.deepEqual([...r.images[0].image], [...IMG]);
    assert.equal(r.chatBackgrounds.length, 1);
    assert.equal(r.chatBackgrounds[0].name, 'Hero bg 1');
    assert.deepEqual(r.chatBackgrounds[0].paths, ['bg/castle.png']);
});

test('缺 manifest / 缺角色报错', () => {
    assert.throws(() => new ByafParser(zipSync({})).parse(), /manifest\.json/);
    assert.throws(() => new ByafParser(byaf({ characters: [] }, {})).parse(), /characters array is empty/);
});
