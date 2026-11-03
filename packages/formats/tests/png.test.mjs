// png.test.mjs — PNG 卡面读写往返 / ccv3 优先 / zTXt / strip
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zlibSync } from 'fflate';
import {
    encodePngChunks, parsePngChunks, encodeTextChunk,
    readCardFromPng, writeCardToPng, stripPngCardMetadata,
    u8ToBase64, base64ToU8,
} from '../dist/index.js';

const te = new TextEncoder();
const td = new TextDecoder();

function fakePng(extraChunks = []) {
    const ihdr = new Uint8Array(13);
    ihdr.set([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    return encodePngChunks([
        { name: 'IHDR', data: ihdr },
        ...extraChunks,
        { name: 'IDAT', data: new Uint8Array([0x78, 0x9c, 0x63]) },
        { name: 'IEND', data: new Uint8Array(0) },
    ]);
}

const card = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: '测试卡', description: 'desc', first_mes: 'hi {{user}}' },
};

test('base64 往返', () => {
    const u8 = te.encode(JSON.stringify(card));
    assert.deepEqual(base64ToU8(u8ToBase64(u8)), u8);
    // 奇数长度
    for (const n of [1, 2, 3, 5, 17]) {
        const s = new Uint8Array(n).map((_, i) => i * 7 & 0xff);
        assert.deepEqual(base64ToU8(u8ToBase64(s)), s);
    }
});

test('写卡→读卡往返;同时落 chara + ccv3', () => {
    const png = writeCardToPng(fakePng(), JSON.stringify(card));
    const chunks = parsePngChunks(png);
    const kws = chunks.filter(c => c.name === 'tEXt').map(c => td.decode(c.data.subarray(0, c.data.indexOf(0))));
    assert.deepEqual(kws, ['chara', 'ccv3']);
    const back = JSON.parse(readCardFromPng(png));
    // ccv3 优先:读回的是 spec 已改 v3 的版本
    assert.equal(back.spec, 'chara_card_v3');
    assert.equal(back.data.name, '测试卡');
});

test('ccv3 优先于 chara', () => {
    const v2png = writeCardToPng(fakePng(), JSON.stringify(card));
    const read = JSON.parse(readCardFromPng(v2png));
    assert.equal(read.spec_version, '3.0');
});

test('zTXt 压缩块可读', () => {
    const kw = te.encode('chara');
    const payload = new Uint8Array(kw.length + 2 + 1);
    // keyword\0 + method(0) + zlib(base64)
    const text = u8ToBase64(te.encode(JSON.stringify(card)));
    const zipped = zlibSync(te.encode(text));
    const data = new Uint8Array(kw.length + 2 + zipped.length);
    data.set(kw, 0); data[kw.length] = 0; data[kw.length + 1] = 0; data.set(zipped, kw.length + 2);
    const png = fakePng([{ name: 'zTXt', data }]);
    const back = JSON.parse(readCardFromPng(png));
    assert.equal(back.data.name, '测试卡');
});

test('strip 剥掉 chara/ccv3 保留其它 tEXt', () => {
    const withExtra = fakePng([encodeTextChunk('author', 'someone')]);
    const png = writeCardToPng(withExtra, JSON.stringify(card));
    const stripped = stripPngCardMetadata(png);
    const chunks = parsePngChunks(stripped);
    const kws = chunks.filter(c => c.name === 'tEXt').map(c => td.decode(c.data.subarray(0, c.data.indexOf(0))));
    assert.deepEqual(kws, ['author']);
    assert.throws(() => readCardFromPng(stripped), /No PNG metadata/);
});

test('无元数据报错与原实现同形', () => {
    assert.throws(() => readCardFromPng(fakePng()), /No PNG metadata/);
});
