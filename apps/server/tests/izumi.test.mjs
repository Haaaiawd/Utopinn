/**
 * izumi.test —— IzumiEdit 服务端解释器单测 + ChatRepo afterWrite 集成。
 * 跑法:node --test tests/izumi.test.mjs
 * 覆盖:九操作、替换唯一性、删除锚点、16 上限、隐藏区间过滤、
 *      同批新建不可引用、预设 scope 记录、指纹幂等、Konata 注入文重建。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyIzumiOps,
    hiddenFloorIndexSet,
    izumiAfterChatWrite,
    izumiStateView,
    normalizeIzumiState,
    parseIzumiBlocks,
    renderIzumiCatalog,
    renderKonataExtraInformation,
    IZUMI_MAX_OPS_PER_FLOOR,
    IZUMI_NS,
} from '../src/services/izumi.js';
// ChatRepo/harness 拉全量依赖,放测试内动态 import——纯解释器断言在依赖
// 未装齐的环境(如临时 worktree)也能先跑。

/* 真实样例:掌门卡楼层(我上轮拿到的完整块,原文未动)。 */
const FLOOR_NEW_XUANQUE = `<IzumiEdit>
新建 玄阙宗门现状
【时间线整理】
⟦第一年⟧
〔第1天〕
- 宗主推开宗主殿,殿里仅剩两人:管账的孙德寿、管杂务的周和。宗门待复业,欠债九百八十枚灵石,红签已插到门框上。
- 宗主坐下翻账册。账册前段为前任“老师叔”所记,后段由孙德寿接手;巡山弟子辟谷丹一栏被朱笔批“停发”;有一页被茶洇,孙德寿承认是自己弄的,数目四百二,另有一张“后厨酱牛肉失窃疑犯名单”便条夹在册中,周和名列其上。

【重要记忆区】
〔孙德寿〕
[账册]:老师叔走后由他接手记账。承认弄洇过一页(四百二),能一页页说清哪笔糊涂账的来由。
〔周和〕
[酱牛肉]:被列进失窃名单,坚称不是自己。
</IzumiEdit>`;

const FLOOR_APPEND = `<IzumiEdit>
追加 时间线整理
[第一日·夜]
- 门外的“巡捕”自称姓周、城东巡检司当差九年。
</IzumiEdit>`;

function msg(mes, extra) {
    return { is_user: false, name: 'char', mes, send_date: 0, extra };
}

test('parse: 单块新建(真实 fixture),正文含分节标记按名整条存', () => {
    const { ops, dropped } = parseIzumiBlocks(FLOOR_NEW_XUANQUE);
    assert.equal(dropped.length, 0);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].verb, '新建');
    assert.equal(ops[0].target, '玄阙宗门现状');
    assert.match(ops[0].body, /【时间线整理】/);
    assert.match(ops[0].body, /〔孙德寿〕/);
    assert.match(ops[0].body, /〔周和〕/);
    // 正文首尾无框架换行残留
    assert.ok(!ops[0].body.startsWith('\n'));
    assert.ok(!ops[0].body.endsWith('\n'));
});

test('apply: 新建 → 追加/前置/重写/替换/开启/关闭/删除(整条)全链', () => {
    const st = normalizeIzumiState(null);
    const mk = (verb, target, body, fields) => ({ verb, target, body: body ?? '', fields: fields ?? {} });
    const results = applyIzumiOps(st, [
        mk('新建', '时间线整理', '【时间线整理】\n⟦第一年⟧'),
        // 同批新建名不可引用 → 跳过
        mk('追加', '时间线整理', '\n- 同批不该进'),
    ]);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].reason, 'same_batch_ref');
    assert.equal(st.entries['时间线整理'].content, '【时间线整理】\n⟦第一年⟧');

    // 下一批:追加可引用
    applyIzumiOps(st, [mk('追加', '时间线整理', '\n〔第1天〕'), mk('前置', '时间线整理', '[头部]')]);
    assert.equal(st.entries['时间线整理'].content, '[头部]【时间线整理】\n⟦第一年⟧\n〔第1天〕');

    // 替换:唯一一处
    applyIzumiOps(st, [mk('替换', '时间线整理', '', { '原文': '〔第1天〕', '新文': '〔第2天〕' })]);
    assert.match(st.entries['时间线整理'].content, /第2天/);

    // 关闭 → 正文不进注入;开启 → 恢复
    applyIzumiOps(st, [mk('关闭', '时间线整理')]);
    assert.equal(st.entries['时间线整理'].enabled, false);
    assert.equal(renderKonataExtraInformation(st), null);
    applyIzumiOps(st, [mk('开启', '时间线整理')]);
    assert.equal(st.entries['时间线整理'].enabled, true);

    // 重写
    applyIzumiOps(st, [mk('重写', '时间线整理', '重写后的全文')]);
    assert.equal(st.entries['时间线整理'].content, '重写后的全文');

    // 删除(无锚点 → 删整条)
    applyIzumiOps(st, [mk('删除', '时间线整理')]);
    assert.equal(st.entries['时间线整理'], undefined);
});

test('apply: 替换唯一性(0 次 / ≥2 次都跳过;空新文删段)', () => {
    const st = normalizeIzumiState(null);
    applyIzumiOps(st, [{ verb: '新建', target: 'a', body: 'x猫x猫x', fields: {} }]);
    let r = applyIzumiOps(st, [
        { verb: '替换', target: 'a', body: '', fields: { '原文': '猫', '新文': '狗' } },
        { verb: '替换', target: 'a', body: '', fields: { '原文': '不存在', '新文': 'y' } },
    ]);
    assert.equal(r[0].reason, '原文_not_unique');
    assert.equal(r[1].reason, '原文_not_found');
    assert.equal(st.entries['a'].content, 'x猫x猫x');
    // 空新文 = 删匹配段
    r = applyIzumiOps(st, [{ verb: '替换', target: 'a', body: '', fields: { '原文': 'x猫x', '新文': '' } }]);
    assert.equal(r[0].ok, true);
    assert.equal(st.entries['a'].content, '猫x');
});

test('apply: 删除锚点模式(唯一+有序才删区间;歧义不执行不删条目)', () => {
    const st = normalizeIzumiState(null);
    applyIzumiOps(st, [{ verb: '新建', target: 'a', body: '头A中B尾C', fields: {} }]);
    // 开头在结尾之后 → anchor_order
    let r = applyIzumiOps(st, [{ verb: '删除', target: 'a', body: '', fields: { '开头': '尾', '结尾': '头' } }]);
    assert.equal(r[0].reason, 'anchor_order');
    // 锚点非唯一 → ambiguous(有歧义不执行,条目原样)
    applyIzumiOps(st, [{ verb: '重写', target: 'a', body: 'X头X头X', fields: {} }]);
    r = applyIzumiOps(st, [{ verb: '删除', target: 'a', body: '', fields: { '开头': '头', '结尾': 'X' } }]);
    assert.equal(r[0].reason, '开头_ambiguous');
    assert.equal(st.entries['a'].content, 'X头X头X');
    // 唯一且有序 → 连同两端删区间
    applyIzumiOps(st, [{ verb: '重写', target: 'a', body: '头A中B尾C', fields: {} }]);
    r = applyIzumiOps(st, [{ verb: '删除', target: 'a', body: '', fields: { '开头': 'A中', '结尾': '尾' } }]);
    assert.equal(r[0].ok, true);
    assert.equal(st.entries['a'].content, '头C');
    // 只有一端 → anchor_incomplete
    r = applyIzumiOps(st, [{ verb: '删除', target: 'a', body: '', fields: { '开头': '头' } }]);
    assert.equal(r[0].reason, 'anchor_incomplete');
});

test('apply: 隐藏楼层区间记录+归并,hiddenFloorIndexSet 展开过滤', () => {
    const st = normalizeIzumiState(null);
    const mk = (t) => ({ verb: '隐藏', target: t, body: '', fields: {} });
    applyIzumiOps(st, [mk('3楼~5楼'), mk('1楼'), mk('4楼~7楼')]);
    assert.deepEqual(st.hiddenFloors, [{ from: 1, to: 1 }, { from: 3, to: 7 }]);
    const set = hiddenFloorIndexSet(st);
    for (const i of [1, 3, 4, 5, 6, 7]) assert.ok(set.has(i), `floor ${i} hidden`);
    assert.ok(!set.has(0) && !set.has(2) && !set.has(8));
    // 坏区间跳过
    const r = applyIzumiOps(st, [{ verb: '隐藏', target: 'xx楼~xx楼', body: '', fields: {} }]);
    assert.equal(r[0].ok, false);
});

test('apply: 同批 16 上限,超出丢弃记 log', () => {
    const st = normalizeIzumiState(null);
    const blocks = Array.from({ length: 18 }, (_, i) => `<IzumiEdit>\n新建 条${i}\nb${i}\n</IzumiEdit>`).join('\n');
    const { ops, dropped } = parseIzumiBlocks(blocks);
    assert.equal(ops.length, IZUMI_MAX_OPS_PER_FLOOR);
    assert.equal(dropped.length, 18 - IZUMI_MAX_OPS_PER_FLOOR);
    assert.equal(dropped[0].reason, 'op_cap');
});

test('apply: 新建撞名加 -N 后缀,不覆盖旧条目', () => {
    const st = normalizeIzumiState(null);
    const r = applyIzumiOps(st, [
        { verb: '新建', target: '测试', body: 'one', fields: {} },
        { verb: '新建', target: '测试', body: 'two', fields: {} },
    ]);
    assert.equal(st.entries['测试'].content, 'one');
    assert.equal(st.entries['测试-1'].content, 'two');
    assert.equal(r[1].name, '测试-1');
});

test('apply: scope 前缀分流(资料 进注入目录,预设 只记录)', () => {
    const st = normalizeIzumiState(null);
    applyIzumiOps(st, [
        { verb: '新建', target: '资料/府志', body: '资料正文', fields: {} },
        { verb: '新建', target: '预设/通用规则', body: '预设正文', fields: {} },
    ]);
    assert.equal(st.entries['资料/府志'].scope, '资料');
    assert.equal(st.entries['预设/通用规则'].scope, '预设');
    const konata = renderKonataExtraInformation(st);
    assert.match(konata, /资料正文/);
    assert.ok(!konata.includes('预设正文')); // 预设 scope 不进 KonataExtraInformation(v1 只记录)
    assert.match(renderIzumiCatalog(st), /预设\/通用规则/); // 目录仍列出可整理名
});

test('apply: 关闭 世界系统 → 停注入;开启恢复', () => {
    const st = normalizeIzumiState(null);
    applyIzumiOps(st, [
        { verb: '新建', target: 'a', body: 'x', fields: {} },
        { verb: '关闭', target: '世界系统', body: '', fields: {} },
    ]);
    assert.equal(st.worldSystemClosed, true);
    assert.equal(renderKonataExtraInformation(st), null);
    applyIzumiOps(st, [{ verb: '开启', target: '世界系统', body: '', fields: {} }]);
    assert.ok(renderKonataExtraInformation(st));
});

test('parse: 未闭合尾块不处理', () => {
    const { ops, unclosed } = parseIzumiBlocks('abc <IzumiEdit>\n新建 a\nx\n</IzumiEdit> tail <IzumiEdit>\n删除 a');
    assert.equal(ops.length, 1);
    assert.equal(unclosed, true);
});

test('repo 集成:append 落 AI 楼 → izumi ns 落地;重写指纹幂等;隐藏楼层视图', async () => {
    const { ChatRepo } = await import('../src/storage/repositories/chat-repo.js');
    const { makeTempFsEngineHarness } = await import('./storage/harness/contract-harness.js');
    const h = await makeTempFsEngineHarness();
    try {
        const repo = new ChatRepo({ engine: h.engine, afterWrite: [izumiAfterChatWrite] });
        await repo.save(h.handle, 'A', 'c', {}, [{ is_user: true, mes: 'hi' }], null);
        // 追加含 IzumiEdit 的 AI 楼(gen_id 指纹)
        await repo.append(h.handle, 'A', 'c', [msg(`正文\n${FLOOR_NEW_XUANQUE}`, { gen_id: 'g1' })], null);
        const st1 = await repo.getState(h.handle, 'A', 'c', IZUMI_NS);
        assert.ok(st1?.entries?.['玄阙宗门现状']);
        assert.match(st1.entries['玄阙宗门现状'].content, /孙德寿/);
        assert.equal(st1.processed.includes('g:g1'), true);
        // 同 gen_id 重放(重试)→ 不二次应用
        await repo.append(h.handle, 'A', 'c', [msg(`正文\n${FLOOR_NEW_XUANQUE}`, { gen_id: 'g1' })], null);
        const st2 = await repo.getState(h.handle, 'A', 'c', IZUMI_NS);
        assert.equal(st2.processed.length, 1);
        // PATCH 写回路径(客户端 PATCH 落新楼)→ 同缝消费
        const doc = await repo.get(h.handle, 'A', 'c');
        await repo.patch(h.handle, 'A', 'c', [
            { op: 'add', path: `/body/${doc.body.length}`, value: msg('再更\n<IzumiEdit>\n追加 玄阙宗门现状\n- 新事实。\n</IzumiEdit>', { gen_id: 'g2' }) },
        ], doc.integrity);
        const st3 = await repo.getState(h.handle, 'A', 'c', IZUMI_NS);
        assert.match(st3.entries['玄阙宗门现状'].content, /新事实/);
        // 视图:隐藏楼层 + konata 预览成形
        const view = izumiStateView(st3);
        assert.ok(view.konata.includes('<KonataExtraInformation>'));
        assert.match(view.catalog, /玄阙宗门现状/);
        // user 楼含 IzumiEdit 不处理
        await repo.append(h.handle, 'A', 'c', [{ is_user: true, mes: '<IzumiEdit>\n新建 伪造\nx\n</IzumiEdit>' }], null);
        const st4 = await repo.getState(h.handle, 'A', 'c', IZUMI_NS);
        assert.equal(st4.entries['伪造'], undefined);
        // 回归:占位符等管线在块外改写楼层正文(实测 mes 尾巴多出
        // <StatusPlaceHolderImpl/>)—— 指纹只锁块原文,块外改动不许二次应用。
        const doc2 = await repo.get(h.handle, 'A', 'c');
        const mutated = doc2.body.map((m) => ({ ...m }));
        const aiIdx = mutated.findIndex((m) => !m.is_user && String(m.mes).includes('<IzumiEdit>'));
        mutated[aiIdx].mes += '\n\n<StatusPlaceHolderImpl/>';
        await repo.save(h.handle, 'A', 'c', doc2.header, mutated, null);
        const st5 = await repo.getState(h.handle, 'A', 'c', IZUMI_NS);
        assert.equal(st5.entries['玄阙宗门现状-1'], undefined, '块外改写不许二次应用(不应出现 -1 复本)');
        assert.equal(st5.entries['玄阙宗门现状'].content, st3.entries['玄阙宗门现状'].content);
    } finally {
        h.cleanup();
    }
});

test('渲染:目录含已关闭标记,关闭条目不进正文', () => {
    const st = normalizeIzumiState(null);
    applyIzumiOps(st, [
        { verb: '新建', target: '开着的', body: 'B1', fields: {} },
        { verb: '新建', target: '关着的', body: 'B2', fields: {} },
    ]);
    // 关闭须在下一批(同批新建不可引用)
    applyIzumiOps(st, [{ verb: '关闭', target: '关着的', body: '', fields: {} }]);
    const konata = renderKonataExtraInformation(st);
    assert.match(konata, /B1/);
    assert.ok(!konata.includes('B2'));
    assert.match(renderIzumiCatalog(st), /关着的\(已关闭\)/);
});
