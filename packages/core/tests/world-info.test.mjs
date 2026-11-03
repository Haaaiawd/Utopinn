/**
 * WI engine unit tests — checkWorldInfo port fidelity.
 * Covers: keyword hit / secondary keys / selective logic gates /
 * position routing / token budget / recursion / timed effects /
 * inclusion groups / decorators / source merging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkWorldInfo,
    mergeLoreSources,
    parseDecorators,
    parseRegexFromString,
    splitKeywordsAndRegexes,
    world_info_insertion_strategy,
    world_info_logic,
    world_info_position,
    DEFAULT_WI_SETTINGS,
} from '../dist/index.js';

const pos = world_info_position;
const logic = world_info_logic;

function entry(over = {}) {
    return { uid: 1, key: [], keysecondary: [], content: 'C', order: 100, position: 0, ...over };
}

function world(entries, worldName = 'W') {
    return { entries: Object.fromEntries(entries.map(e => [e.uid, e])) , _w: worldName };
}

function makeCtx(entries, over = {}) {
    const merged = entries.length && entries[0].world === undefined
        ? mergeLoreSources({
            selectedWorlds: [],
            chatWorlds: [],
            insertionStrategy: world_info_insertion_strategy.character_first,
            getWorldData: () => ({ entries: Object.fromEntries(entries.map(e => [e.uid, e])) }),
            characterPrimaryWorld: 'W',
        })
        : entries;
    return {
        sortedEntries: merged,
        chatMetadata: over.chatMetadata ?? {},
        settings: { ...DEFAULT_WI_SETTINGS, ...over.settings },
        rng: over.rng ?? (() => 0.5),
        countTokens: over.countTokens ?? ((t) => t.length),
        ...over.extra,
    };
}

test('基础关键字命中 → before 位置注入', async () => {
    const e = entry({ uid: 1, key: ['dragon'], content: 'LORE' });
    const r = await checkWorldInfo(['I saw a dragon today'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'LORE');
});

test('关键字大小写不敏感(默认)', async () => {
    const e = entry({ uid: 1, key: ['DRAGON'], content: 'LORE' });
    const r = await checkWorldInfo(['a dragon'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'LORE');
});

test('条目级 caseSensitive=true 覆盖全局', async () => {
    const e = entry({ uid: 1, key: ['DRAGON'], content: 'LORE', caseSensitive: true });
    const r = await checkWorldInfo(['a dragon'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, '');
});

test('matchWholeWords:dragon 不命中 dragonfly', async () => {
    const e = entry({ uid: 1, key: ['dragon'], content: 'LORE', matchWholeWords: true });
    const no = await checkWorldInfo(['a dragonfly'], 1000, false, {}, makeCtx([e]));
    assert.equal(no.worldInfoBefore, '');
    const yes = await checkWorldInfo(['a dragon, wow'], 1000, false, {}, makeCtx([e]));
    assert.equal(yes.worldInfoBefore, 'LORE');
});

test('regex 关键字 /dr.g/ 命中', async () => {
    const e = entry({ uid: 1, key: ['/dr.g/'], content: 'LORE' });
    const r = await checkWorldInfo(['drog'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'LORE');
});

test('constant 无条件激活', async () => {
    const e = entry({ uid: 1, key: ['nomatch'], constant: true, content: 'ALWAYS' });
    const r = await checkWorldInfo(['whatever'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'ALWAYS');
});

test('disable 跳过', async () => {
    const e = entry({ uid: 1, constant: true, disable: true, content: 'X' });
    const r = await checkWorldInfo(['x'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, '');
});

test('无 key 非常量条目不激活', async () => {
    const e = entry({ uid: 1, key: [], content: 'X' });
    const r = await checkWorldInfo(['x'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, '');
});

test('scanDepth 限制:超出深度的消息不扫', async () => {
    const e = entry({ uid: 1, key: ['old'], scanDepth: 1, content: 'LORE' });
    // chat[] 是逆序:idx0=最新。"old" 在深度 2 处,scanDepth 1 看不到
    const r = await checkWorldInfo(['newest msg', 'old keyword'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, '');
});

// ---------- secondary keys / selective logic ----------

test('AND_ANY:主+任一次关键字命中激活', async () => {
    const e = entry({ uid: 1, key: ['foo'], keysecondary: ['bar', 'baz'], selectiveLogic: logic.AND_ANY, content: 'S' });
    const r = await checkWorldInfo(['foo and baz'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'S');
    const r2 = await checkWorldInfo(['foo only'], 1000, false, {}, makeCtx([e]));
    assert.equal(r2.worldInfoBefore, '');
});

test('NOT_ALL:任一未命中即激活', async () => {
    const e = entry({ uid: 1, key: ['foo'], keysecondary: ['bar', 'baz'], selectiveLogic: logic.NOT_ALL, content: 'S' });
    const r = await checkWorldInfo(['foo bar'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'S');
    const r2 = await checkWorldInfo(['foo bar baz'], 1000, false, {}, makeCtx([e]));
    assert.equal(r2.worldInfoBefore, '');
});

test('NOT_ANY:全部未命中才激活', async () => {
    const e = entry({ uid: 1, key: ['foo'], keysecondary: ['bar', 'baz'], selectiveLogic: logic.NOT_ANY, content: 'S' });
    const r = await checkWorldInfo(['foo qux'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'S');
    const r2 = await checkWorldInfo(['foo bar'], 1000, false, {}, makeCtx([e]));
    assert.equal(r2.worldInfoBefore, '');
});

test('AND_ALL:全部命中才激活', async () => {
    const e = entry({ uid: 1, key: ['foo'], keysecondary: ['bar', 'baz'], selectiveLogic: logic.AND_ALL, content: 'S' });
    const r = await checkWorldInfo(['foo bar baz'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, 'S');
    const r2 = await checkWorldInfo(['foo bar'], 1000, false, {}, makeCtx([e]));
    assert.equal(r2.worldInfoBefore, '');
});

// ---------- position routing ----------

test('position 路由:before/after/atDepth/EM/AN/outlet', async () => {
    const mk = (uid, p, extra = {}) => entry({ uid, constant: true, content: `P${p}`, position: p, order: uid, ...extra });
    const entries = [
        mk(1, pos.before), mk(2, pos.after),
        mk(3, pos.atDepth, { depth: 2 }), mk(4, pos.atDepth, { depth: 2, role: 1 }),
        mk(5, pos.EMTop), mk(6, pos.EMBottom),
        mk(7, pos.ANTop), mk(8, pos.ANBottom),
        mk(9, pos.outlet, { outletName: 'inv' }),
    ];
    const r = await checkWorldInfo(['x'], 1000, false, {}, makeCtx(entries));
    assert.deepEqual(r.worldInfoBeforeEntries, ['P0']);
    assert.deepEqual(r.worldInfoAfterEntries, ['P1']);
    assert.deepEqual(r.EMEntries, [{ position: 0, content: 'P5' }, { position: 1, content: 'P6' }]);
    assert.deepEqual(r.ANBeforeEntries, ['P2']);
    assert.deepEqual(r.ANAfterEntries, ['P3']);
    assert.deepEqual(r.outletEntries, { inv: ['P7'] });
    // sortFn 降序 order → uid4(role1)先建桶,uid3(role0)在后
    assert.equal(r.WIDepthEntries.length, 2);
    assert.equal(r.WIDepthEntries[0].role, 1);
    assert.equal(r.WIDepthEntries[1].role, 0);
});

test('atDepth 同深度同 role 聚合,unshift 保序', async () => {
    const a = entry({ uid: 1, constant: true, content: 'A', position: pos.atDepth, depth: 3, order: 200 });
    const b = entry({ uid: 2, constant: true, content: 'B', position: pos.atDepth, depth: 3, order: 100 });
    const r = await checkWorldInfo(['x'], 1000, false, {}, makeCtx([a, b]));
    assert.equal(r.WIDepthEntries.length, 1);
    // order 200 先处理,unshift 到前 → [A, B] 再 unshift B → [B,A]? 原实现:
    // sortFn 降序 order → 先 A(order200) push 创建 [A],后 B unshift → [B,A]
    assert.deepEqual(r.WIDepthEntries[0].entries, ['B', 'A']);
});

test('before 位置多条目:unshift → order 小的在前', async () => {
    const a = entry({ uid: 1, constant: true, content: 'HIGH', position: pos.before, order: 200 });
    const b = entry({ uid: 2, constant: true, content: 'LOW', position: pos.before, order: 100 });
    const r = await checkWorldInfo(['x'], 1000, false, {}, makeCtx([a, b]));
    assert.deepEqual(r.worldInfoBeforeEntries, ['LOW', 'HIGH']);
});

// ---------- budget ----------

test('token 预算:溢出后普通条目停,ignoreBudget 继续', async () => {
    const mk = (uid, content, over = {}) => entry({ uid, constant: true, content, ...over });
    // budget = 25% * maxContext. maxContext=400 → budget=100; countTokens=len
    // 处理顺序 = order 降序 → e1(300) 先进,e2(200) 溢出,e3(100) ignoreBudget 放行
    const entries = [
        mk(1, 'X'.repeat(60), { order: 300 }),
        mk(2, 'Y'.repeat(60), { order: 200 }),          // 60+61>100 → 溢出
        mk(3, 'Z'.repeat(500), { order: 100, ignoreBudget: true }),
    ];
    const ctx = makeCtx(entries, { settings: { worldInfoBudget: 25, worldInfoBudgetCap: 0 } });
    const r = await checkWorldInfo(['x'], 400, false, {}, ctx);
    assert.ok(r.worldInfoBefore.includes('X'.repeat(60)));
    assert.ok(!r.worldInfoBefore.includes('Y'.repeat(60)));
    assert.ok(r.worldInfoBefore.includes('Z'.repeat(500)));
});

test('budget_cap 硬上限', async () => {
    const mk = (uid, c) => entry({ uid, constant: true, content: c, order: uid });
    const ctx = makeCtx([mk(1, 'AAAA'), mk(2, 'BBBB')], {
        settings: { worldInfoBudget: 100, worldInfoBudgetCap: 5 },
    });
    const r = await checkWorldInfo(['x'], 400, false, {}, ctx);
    // cap=5: 第一条 'AAAA\n'(5 tokens)=5 ≥ 5 → 溢出;实际第一条本身也触发 overflow
    assert.equal(r.worldInfoBefore, '');
});

// ---------- recursion ----------

test('递归:条目内容里的关键字触发下一轮激活', async () => {
    const e1 = entry({ uid: 1, key: ['foo'], content: 'contains BAR inside', order: 100 });
    const e2 = entry({ uid: 2, key: ['bar'], content: 'RECURSED', order: 90 });
    const ctx = makeCtx([e1, e2], { settings: { worldInfoRecursive: true } });
    const r = await checkWorldInfo(['foo'], 1000, false, {}, ctx);
    assert.ok(r.worldInfoBefore.includes('contains BAR inside'));
    assert.ok(r.worldInfoBefore.includes('RECURSED'));
});

test('excludeRecursion:递归轮被抑制', async () => {
    const e1 = entry({ uid: 1, key: ['foo'], content: 'BAR', order: 100 });
    const e2 = entry({ uid: 2, key: ['bar'], content: 'NO', order: 90, excludeRecursion: true });
    const ctx = makeCtx([e1, e2], { settings: { worldInfoRecursive: true } });
    const r = await checkWorldInfo(['foo'], 1000, false, {}, ctx);
    assert.ok(!r.worldInfoBefore.includes('NO'));
});

test('preventRecursion:内容不进递归缓冲', async () => {
    const e1 = entry({ uid: 1, key: ['foo'], content: 'BAR', order: 100, preventRecursion: true });
    const e2 = entry({ uid: 2, key: ['bar'], content: 'NO', order: 90 });
    const ctx = makeCtx([e1, e2], { settings: { worldInfoRecursive: true } });
    const r = await checkWorldInfo(['foo'], 1000, false, {}, ctx);
    assert.ok(!r.worldInfoBefore.includes('NO'));
});

test('maxRecursionSteps 限制递归轮数', async () => {
    // e1 触发 e2,e2 内容触发 e3(如果允许第 3 轮)
    const e1 = entry({ uid: 1, key: ['a'], content: 'has b', order: 100 });
    const e2 = entry({ uid: 2, key: ['b'], content: 'has c', order: 90 });
    const e3 = entry({ uid: 3, key: ['c'], content: 'DEEP', order: 80 });
    const ctx = makeCtx([e1, e2, e3], {
        settings: { worldInfoRecursive: true, worldInfoMaxRecursionSteps: 2 },
    });
    const r = await checkWorldInfo(['a'], 1000, false, {}, ctx);
    assert.ok(r.worldInfoBefore.includes('has b'));
    assert.ok(r.worldInfoBefore.includes('has c'));
    assert.ok(!r.worldInfoBefore.includes('DEEP'));
});

test('delayUntilRecursion:首轮抑制,递归轮放行', async () => {
    const e1 = entry({ uid: 1, key: ['foo'], content: 'TRIG', order: 100 });
    const e2 = entry({ uid: 2, constant: true, delayUntilRecursion: 1, content: 'DELAYED', order: 90 });
    const ctx = makeCtx([e1, e2], { settings: { worldInfoRecursive: true } });
    const r = await checkWorldInfo(['foo'], 1000, false, {}, ctx);
    assert.ok(r.worldInfoBefore.includes('DELAYED'));
});

// ---------- timed effects ----------

test('sticky:激活后写入 timedWorldInfo,下轮免匹配', async () => {
    const chatMetadata = {};
    const e = entry({ uid: 1, key: ['foo'], sticky: 2, content: 'STICKY' });
    const ctx = makeCtx([e], { chatMetadata });
    await checkWorldInfo(['foo'], 1000, false, {}, ctx);
    assert.ok(chatMetadata.timedWorldInfo?.sticky?.['W.1']);
    // 下轮:聊天前进 1 条,无关键字仍 sticky 激活
    const ctx2 = makeCtx([e], { chatMetadata });
    const r2 = await checkWorldInfo(['no match', 'foo'], 1000, false, {}, ctx2);
    assert.ok(r2.worldInfoBefore.includes('STICKY'));
});

test('cooldown:间隔内抑制', async () => {
    const chatMetadata = { timedWorldInfo: { cooldown: {}, sticky: {} } };
    const e = entry({ uid: 1, key: ['foo'], cooldown: 3, content: 'CD' });
    const ctx = makeCtx([e], { chatMetadata });
    await checkWorldInfo(['foo'], 1000, false, {}, ctx);
    // cooldown 已写入;再激活在冷却期被抑制
    const ctx2 = makeCtx([e], { chatMetadata });
    const r2 = await checkWorldInfo(['foo again', 'foo'], 1000, false, {}, ctx2);
    assert.equal(r2.worldInfoBefore, '');
});

test('delay:chat.length < delay 抑制', async () => {
    const e = entry({ uid: 1, key: ['foo'], delay: 5, content: 'D' });
    const r = await checkWorldInfo(['foo', 'x', 'y'], 1000, false, {}, makeCtx([e]));
    assert.equal(r.worldInfoBefore, '');
    const r2 = await checkWorldInfo(['foo', 'x', 'y', 'z', 'w', 'v'], 1000, false, {}, makeCtx([e]));
    assert.equal(r2.worldInfoBefore, 'D');
});

// ---------- groups / probability / decorators ----------

test('inclusion group:同组加权随机器只留一个(rng 注入决定)', async () => {
    const mk = (uid, w) => entry({ uid, key: ['k'], group: 'g', groupWeight: w, content: `E${uid}` });
    const entries = [mk(1, 50), mk(2, 50)];
    // roll=rng*100:rng=0.4 → 40 ≤50 命中第一条
    const r1 = await checkWorldInfo(['k'], 1000, false, {}, makeCtx(entries, { rng: () => 0.4 }));
    assert.deepEqual(r1.worldInfoBeforeEntries, ['E1']);
    // rng=0.9 → 90 落入第二区间(51-100)
    const r2 = await checkWorldInfo(['k'], 1000, false, {}, makeCtx(entries, { rng: () => 0.9 }));
    assert.deepEqual(r2.worldInfoBeforeEntries, ['E2']);
});

test('groupOverride 优先于加权', async () => {
    const mk = (uid, over = {}) => entry({ uid, key: ['k'], group: 'g', content: `E${uid}`, order: uid, ...over });
    const entries = [mk(1), mk(2, { groupOverride: true })];
    const r = await checkWorldInfo(['k'], 1000, false, {}, makeCtx(entries));
    assert.deepEqual(r.worldInfoBeforeEntries, ['E2']);
});

test('probability:rng 注入决定成败,失败进 failedProbabilityChecks', async () => {
    const e = entry({ uid: 1, key: ['k'], useProbability: true, probability: 30, content: 'P' });
    const ok = await checkWorldInfo(['k'], 1000, false, {}, makeCtx([e], { rng: () => 0.2 }));
    assert.equal(ok.worldInfoBefore, 'P');
    const no = await checkWorldInfo(['k'], 1000, false, {}, makeCtx([e], { rng: () => 0.9 }));
    assert.equal(no.worldInfoBefore, '');
});

test('@@activate / @@dont_activate 装饰器', async () => {
    const [dec1, c1] = parseDecorators('@@activate\nFORCED');
    assert.deepEqual(dec1, ['@@activate']);
    assert.equal(c1, 'FORCED');
    const [dec2] = parseDecorators('@@dont_activate\nX');
    assert.deepEqual(dec2, ['@@dont_activate']);

    const books = { entries: {
        1: entry({ uid: 1, key: [], content: '@@activate\nFORCED', order: 100 }),
        2: entry({ uid: 2, key: ['k'], content: '@@dont_activate\nNEVER', order: 90 }),
    } };
    const ctx = makeCtx([], {});
    ctx.sortedEntries = mergeLoreSources({
        selectedWorlds: ['W'], chatWorlds: [],
        insertionStrategy: 1, getWorldData: () => books,
    });
    const r = await checkWorldInfo(['nomatch'], 1000, false, {}, ctx);
    assert.ok(r.worldInfoBefore.includes('FORCED'));
    assert.ok(!r.worldInfoBefore.includes('NEVER'));
});

test('min_activations:加深扫描直到满足', async () => {
    const e1 = entry({ uid: 1, key: ['deep'], content: 'D1' });
    const chat = ['newest', 'x', 'deep keyword here'];  // 'deep' 在深度 3
    const ctx = makeCtx([e1], { settings: { worldInfoMinActivations: 1, worldInfoDepth: 1 } });
    const r = await checkWorldInfo(chat, 1000, false, {}, ctx);
    assert.equal(r.worldInfoBefore, 'D1');
});

// ---------- sources merging ----------

test('五层合并:chat>persona>char/global;去重;hash 盖章', () => {
    const mk = (uid, order) => entry({ uid, order });
    const books = {
        globalA: { entries: { 1: mk(1, 10) } },
        charMain: { entries: { 2: mk(2, 20) } },
        chatB: { entries: { 3: mk(3, 30) } },
        personaC: { entries: { 4: mk(4, 40) } },
    };
    const merged = mergeLoreSources({
        selectedWorlds: ['globalA'],
        characterPrimaryWorld: 'charMain',
        chatWorlds: ['chatB'],
        personaWorld: 'personaC',
        insertionStrategy: world_info_insertion_strategy.character_first,
        getWorldData: (n) => books[n],
    });
    assert.deepEqual(merged.map(e => `${e.world}.${e.uid}`), ['chatB.3', 'personaC.4', 'charMain.2', 'globalA.1']);
    assert.ok(merged.every(e => typeof e.hash === 'number'));
    assert.ok(merged.every(e => Array.isArray(e.decorators)));
});

test('同名去重:char 主书已在 global 激活则跳过', () => {
    const books = { shared: { entries: { 1: entry({ uid: 1 }) } } };
    const merged = mergeLoreSources({
        selectedWorlds: ['shared'],
        characterPrimaryWorld: 'shared',
        chatWorlds: [],
        insertionStrategy: 1,
        getWorldData: (n) => books[n],
    });
    assert.equal(merged.length, 1);
});

test('strategy 排序:character_first vs global_first vs evenly', () => {
    const books = {
        g: { entries: { 1: entry({ uid: 1, order: 50 }) } },
        c: { entries: { 2: entry({ uid: 2, order: 10 }) } },
    };
    const base = {
        selectedWorlds: ['g'], characterPrimaryWorld: 'c', chatWorlds: [],
        getWorldData: (n) => books[n],
    };
    const cf = mergeLoreSources({ ...base, insertionStrategy: 1 });
    assert.deepEqual(cf.map(e => e.world), ['c', 'g']);
    const gf = mergeLoreSources({ ...base, insertionStrategy: 2 });
    assert.deepEqual(gf.map(e => e.world), ['g', 'c']);
    const ev = mergeLoreSources({ ...base, insertionStrategy: 0 });
    assert.deepEqual(ev.map(e => e.world), ['g', 'c']); // order 50 > 10
});

// ---------- regex parsing ----------

test('parseRegexFromString:合法/转义/非法', () => {
    assert.ok(parseRegexFromString('/abc/i') instanceof RegExp);
    assert.ok(parseRegexFromString('/a\\/b/') instanceof RegExp);
    assert.equal(parseRegexFromString('/a/b/'), null);       // 未转义分隔符
    assert.equal(parseRegexFromString('abc'), null);
    assert.equal(parseRegexFromString('/[/'), null);
});

test('splitKeywordsAndRegexes:逗号分隔 + 正则内逗号保护', () => {
    assert.deepEqual(splitKeywordsAndRegexes('a, b, c'), ['a', 'b', 'c']);
    assert.deepEqual(splitKeywordsAndRegexes('/a,b/, c'), ['/a,b/', 'c']);
});
