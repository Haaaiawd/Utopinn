// chat-jsonl.test.mjs — 聊天 JSONL 读写往返 + 末条消息提取 + 卡面视图
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseChatJsonl, serializeChatJsonl, getLastChatMessage,
    detectSpec, cardData, getEmbeddedBook, getBoundWorldName, toV2,
} from '../dist/index.js';

const META = { integrity: 'abc', variables: {}, note_prompt: '' };
const M1 = { name: '掌门真人', is_user: false, send_date: '2026-01-01T00:00:00Z', mes: 'hi' };
const M2 = { name: 'User', is_user: true, send_date: '2026-01-01T00:01:00Z', mes: 'yo', swipes: ['yo'], swipe_id: 0 };

test('JSONL 解析:头行 metadata + 消息数组', () => {
    const text = serializeChatJsonl(META, [M1, M2]);
    const p = parseChatJsonl(text);
    assert.equal(p.metadata.integrity, 'abc');
    assert.equal(p.messages.length, 2);
    assert.equal(p.messages[0].name, '掌门真人');
    assert.equal(p.messages[1].swipe_id, 0);
});

test('JSONL 往返:serialize → parse 同构', () => {
    const text = serializeChatJsonl(META, [M1, M2]);
    const p = parseChatJsonl(text);
    assert.equal(serializeChatJsonl(p.metadata, p.messages), text);
});

test('getLastChatMessage 跳过 metadata 行', () => {
    const text = serializeChatJsonl(META, [M1, M2]);
    assert.equal(getLastChatMessage(text).name, 'User');
    assert.equal(getLastChatMessage(JSON.stringify({ chat_metadata: META })), null);
});

test('无头文件:全是消息', () => {
    const p = parseChatJsonl([M1, M2].map(JSON.stringify).join('\n'));
    assert.equal(p.metadata, null);
    assert.equal(p.messages.length, 2);
});

test('detectSpec / cardData / getEmbeddedBook / getBoundWorldName / toV2', () => {
    const v1 = { name: 'v1', description: 'd', first_mes: 'f' };
    assert.equal(detectSpec(v1), 'chara_card_v1');
    const v2 = toV2(v1);
    assert.equal(v2.spec, 'chara_card_v2');
    assert.equal(v2.data.name, 'v1');
    assert.equal(cardData(v2).first_mes, 'f');
    const v3 = { spec: 'chara_card_v3', data: { name: 'n', character_book: { entries: [] }, extensions: { world: 'book1' } } };
    assert.equal(detectSpec(v3), 'chara_card_v3');
    assert.deepEqual(getEmbeddedBook(v3), { entries: [] });
    assert.equal(getBoundWorldName(v3), 'book1');
    assert.equal(getBoundWorldName(v1), null);
});
