/**
 * chaptersFloorsKey unit tests — ChaptersPanel 的 useRemote 失效信号。
 * PR#47 review #1:updatedAt 不随写楼变(群回复/已命名会话写楼后目录
 * 不刷新);修复 = updatedAt + 写楼 rev 双信号,rev 由 StageFrame
 * refreshPanels 在每次写楼落定 bump。「写一条回复后章节索引重取」
 * 断言 = rev 变化必然产出新 key(useRemote key 变 → 重取)。
 *
 * Run: node --test apps/web/tests/chapters-key.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaptersFloorsKey } from '../src/lib/novelToc.ts';

const solo = { charDir: 'default_Seraphina', chatName: 'demo-chat', updatedAt: 't0' };
const group = { groupId: 'g1', charDir: '', chatName: 'watch-group' };

test('写楼 rev bump → 取数 key 必变(回复落盘 → 目录重取)', () => {
    const k0 = chaptersFloorsKey(solo, 0);
    const k1 = chaptersFloorsKey(solo, 1);
    assert.notEqual(k0, k1);
    /* 群会话同闸:groupId 路径也吃 rev,updatedAt 缺席不影响失效。 */
    assert.notEqual(chaptersFloorsKey(group, 0), chaptersFloorsKey(group, 42));
});

test('同输入同 key —— 无写楼不重取(不多发请求)', () => {
    assert.equal(chaptersFloorsKey(solo, 7), chaptersFloorsKey(solo, 7));
});

test('updatedAt 变化仍失效(清单重拉路径保留)', () => {
    assert.notEqual(
        chaptersFloorsKey({ ...solo, updatedAt: 't1' }, 0),
        chaptersFloorsKey(solo, 0),
    );
});

test('群会话走 group/ 路径;单聊走 charDir/chatName 路径', () => {
    assert.match(chaptersFloorsKey(group, 0), /^chapters:group\/g1\/watch-group@/);
    assert.match(chaptersFloorsKey(solo, 0), /^chapters:default_Seraphina\/demo-chat@/);
});

test('chat 缺席或缺 chatName/charDir → null 不取数(引导空态)', () => {
    assert.equal(chaptersFloorsKey(null, 0), null);
    assert.equal(chaptersFloorsKey(undefined, 0), null);
    assert.equal(chaptersFloorsKey({ charDir: 'c' }, 0), null);            // 无 chatName
    assert.equal(chaptersFloorsKey({ chatName: 'x' }, 0), null);          // 无 charDir 且无 groupId
    /* 群会话 charDir 本就是空串 —— groupId 在即可取数。 */
    assert.ok(chaptersFloorsKey({ groupId: 'g', charDir: '', chatName: 'c' }, 0));
});
