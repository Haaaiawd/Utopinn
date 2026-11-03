// charx.test.mjs — CharX zip 解包:card.json + 嵌入资产映射
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { CharXParser } from '../dist/index.js';

const te = new TextEncoder();
const PNG1 = new Uint8Array([0x89, 0x50, 1, 2, 3]);
const PNG2 = new Uint8Array([0x89, 0x50, 9, 9, 9]);

function makeCharx(card, files) {
    return zipSync({ 'card.json': te.encode(JSON.stringify(card)), ...files });
}

test('CharX 解包:card + icon avatar + sprite/background/misc 映射', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'CharX卡',
            assets: [
                { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
                { type: 'emotion', name: 'Smile Face.png', uri: 'embeded://assets/emotion/smile.png', ext: 'png' },
                { type: 'background', name: 'Castle View', uri: 'embeded://assets/bg/castle.png', ext: 'png' },
                { type: 'other', name: 'voice note', uri: 'embeded://assets/misc/note.txt', ext: 'txt' },
                { type: 'emotion', name: 'remote-only', uri: 'https://cdn.example.com/x.png', ext: 'png' },
            ],
        },
    };
    const buf = makeCharx(card, {
        'assets/icon/main.png': PNG1,
        'assets/emotion/smile.png': PNG2,
        'assets/bg/castle.png': PNG2,
        'assets/misc/note.txt': te.encode('hello'),
    });
    const r = new CharXParser(buf).parse();
    assert.equal(r.card.data.name, 'CharX卡');
    // avatar = main icon
    assert.deepEqual([...r.avatar], [...PNG1]);
    // 存储映射:sprite(emotion→hyphen)/background;icon、远程资产、非图片扩展名(txt)均不进
    const cats = r.auxiliaryAssets.map(a => `${a.storageCategory}:${a.baseName}`).sort();
    assert.deepEqual(cats, ['background:castle_view', 'sprite:smile-face']);
    // 提取的 buffer 仅含映射中的路径(icon + sprite + bg,misc 非图不进 storage 映射但仍在 collect 集)
    assert.ok(r.extractedBuffers.size >= 3);
    assert.deepEqual([...r.extractedBuffers.get('assets/emotion/smile.png')], [...PNG2]);
});

test('缺 card.json / 缺 spec 报错', () => {
    assert.throws(() => new CharXParser(zipSync({ 'x.txt': te.encode('1') })).parse(), /card\.json/);
    assert.throws(() => new CharXParser(makeCharx({ data: {} }, {})).parse(), /spec/);
});

test('无 icon 资产时 avatar 为 null', () => {
    const r = new CharXParser(makeCharx({ spec: 'chara_card_v3', data: { name: 'x', assets: [] } }, {})).parse();
    assert.equal(r.avatar, null);
});
