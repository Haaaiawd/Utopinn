/**
 * MVU settle 引擎测试 — 对照 ref/dsh-tavern vendored magvarupdate 的关键语义:
 * extractCommands(_.cmd/json_patch)/parseCommandValue/pathFix/
 * settleMvuVariables(set·insert·delete·add + VWD + schema 门控)/
 * settleMvuMessage(基底快照 fold·占位符·回执)/
 * initializeMvuVariables(lorebook [initvar]·greeting <initvar> 覆盖)/
 * 幂等性(同一基底重复结算结果一致)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    settleMvuVariables,
    settleMvuMessage,
    initializeMvuVariables,
    createEmptyMvuData,
    findMvuBaselineIndex,
    MVU_STATUS_PLACEHOLDER,
} from '../dist/mvu/settle.js';
import { extractCommands, parseCommandValue, pathFix } from '../dist/mvu/parse.js';
import { isMvuData } from '../dist/mvu/types.js';
import { renderMvuStatusPanel } from '../dist/mvu/panel.js';
import { get, set, toPath } from '../dist/mvu/lodash.js';

/** 带合法 MvuData 的最小快照(isMvuData 要求 stat_data+schema 同时在场)。 */
function mvuData(statData, extra = {}) {
    return {
        initialized_lorebooks: {},
        stat_data: statData,
        delta_data: {},
        display_data: {},
        schema: { type: 'object', properties: {} },
        ...extra,
    };
}

function floor(mes, over = {}) {
    return { mes, is_user: false, is_system: false, swipe_id: 0, ...over };
}

// ---------- toPath / get / set(lodash 语义底座) ----------

test('toPath:点段/数字段/引号段/含点键,与 lodash 一致', () => {
    assert.deepEqual(toPath('a.b.c'), ['a', 'b', 'c']);
    assert.deepEqual(toPath('a[0].b'), ['a', '0', 'b']);
    assert.deepEqual(toPath('a["b c"].d'), ['a', 'b c', 'd']);
    assert.deepEqual(toPath('a[喵.呜].c'), ['a', '喵.呜', 'c']);
    assert.deepEqual(toPath(''), []);
});

test('set:按下游段建 []/{},数字段写数组下标', () => {
    const obj = {};
    set(obj, 'a.b[0].c', 1);
    assert.deepEqual(obj, { a: { b: [{ c: 1 }] } });
    set(obj, 'a.b[1]', 'x');
    assert.deepEqual(get(obj, 'a.b'), [{ c: 1 }, 'x']);
    // __proto__ 拒绝写入
    set(obj, '__proto__.polluted', true);
    assert.equal({}.polluted, undefined);
});

// ---------- extractCommands ----------

test('extractCommands:_.set 提取路径/值/注释;非有效命令跳过', () => {
    const cmds = extractCommands(`正文……\n<UpdateVariable>\n_.set('状态.体力', 62);//初始体力\n_.set('缺路径');\n</UpdateVariable>`);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].type, 'set');
    assert.deepEqual(cmds[0].args, ["'状态.体力'", '62']);
    assert.equal(cmds[0].reason, '初始体力');
    assert.match(cmds[0].full_match, /_\.set\('状态\.体力', 62\);/);
});

test('extractCommands:引号内 ); 不误截;缺分号命令跳过', () => {
    const cmds = extractCommands(
        `_.set('a', ["inner);text"]);\n_.set('b', 1)\n_.set('c', 2);`,
    );
    assert.equal(cmds.length, 2);
    assert.deepEqual(cmds[0].args, ["'a'", '["inner);text"]']);
    assert.deepEqual(cmds[1].args, ["'c'", '2']);
});

test('extractCommands:别名命令与参数个数校验', () => {
    const text = [
        `_.insert('arr', 5);`,
        `_.assign('obj', 'k', 6);`,
        `_.remove('x');`,
        `_.unset('y');`,
        `_.delete('z');`,
        `_.add('hp', 10);`,
        `_.add('hp');`, // add 需 2 参 → 无效
    ].join('\n');
    const types = extractCommands(text).map(c => c.type);
    assert.deepEqual(types, ['insert', 'assign', 'remove', 'unset', 'delete', 'add']);
});

test('extractCommands:<json_patch> 块翻译为等价命令并按文本序交错', () => {
    const text = [
        `_.set('a', 1);`,
        `<json_patch>[{"op":"replace","path":"/b/c","value":2},{"op":"remove","path":"/d"}]</json_patch>`,
        `_.add('e', 3);`,
    ].join('\n');
    const cmds = extractCommands(text);
    assert.deepEqual(
        cmds.map(c => [c.type, c.args[0]]),
        [['set', "'a'"], ['set', '["b"]["c"]'], ['delete', '["d"]'], ['add', "'e'"]],
    );
    assert.equal(cmds[1].reason, 'json_patch');
    // patch 块非 JSON → 安静跳过
    assert.equal(extractCommands('<json_patch>not-json{{</json_patch>').length, 0);
});

// ---------- parseCommandValue ----------

test('parseCommandValue:字面量/JSON/数学表达式/裸字符串', () => {
    assert.equal(parseCommandValue('true'), true);
    assert.equal(parseCommandValue('null'), null);
    assert.equal(parseCommandValue('42'), 42);
    assert.equal(parseCommandValue('"abc"'), 'abc');
    assert.deepEqual(parseCommandValue('{"a":1}'), { a: 1 });
    assert.equal(parseCommandValue('2*3+4'), 10);
    assert.equal(parseCommandValue('Math.sqrt(16)'), 4);
    // 未加引号的裸串 → 字符串
    assert.equal(parseCommandValue('hello_world'), 'hello_world');
    assert.equal(parseCommandValue("'单引号'"), '单引号');
    // JS 对象字面量(不带引号 key)→ JSON5 路径(替代 upstream new Function)
    assert.deepEqual(parseCommandValue("{a:1,b:'x'}"), { a: 1, b: 'x' });
});

// ---------- pathFix ----------

test('pathFix:裸数字→索引,引号数字→键,含空白/特殊字符键→["..."]', () => {
    assert.equal(pathFix('foo[0].bar'), 'foo[0].bar');
    assert.equal(pathFix("foo['5'].bar"), 'foo["5"].bar');
    assert.equal(pathFix('foo."a b".c'), 'foo["a b"].c');
    // upstream:无引号且无空白的 bracket 内容原样保留,由 toPath 按字面 key 处理
    assert.equal(pathFix('foo[喵.呜].c'), 'foo[喵.呜].c');
    assert.deepEqual(toPath('foo[喵.呜].c'), ['foo', '喵.呜', 'c']);
    assert.equal(pathFix('"武器栏".子'), '武器栏.子');
});

// ---------- settleMvuVariables:set ----------

test('set:基本写入 + display/delta 记录 + 回执', () => {
    const v = mvuData({ 状态: { 体力: 50 } });
    const r = settleMvuVariables(`<UpdateVariable>\n_.set('状态.体力', 62);//受伤\n</UpdateVariable>`, v);
    assert.equal(r.modified, true);
    assert.equal(v.stat_data.状态.体力, 62);
    assert.equal(r.receipt.ops.length, 1);
    assert.equal(r.receipt.ops[0].status, 'applied');
    assert.equal(r.receipt.ops[0].oldValue, 50);
    assert.equal(r.receipt.ops[0].newValue, 62);
    assert.match(r.receipt.ops[0].display, /50->62 \(受伤\)/);
    // display_data=快照克隆+变更路径改写为展示串;delta_data 只记本层变化
    assert.equal(v.display_data.状态.体力, '50->62 (受伤)');
    assert.equal(v.delta_data.状态.体力, '50->62 (受伤)');
});

// ---------- GH#15:lodash 自动建路径 + stat_data. 前缀剥除 ----------

test('set(GH#15):路径不存在 → 自动创建,oldValue=undefined 留痕', () => {
    const v = mvuData({ a: 1 });
    const r = settleMvuVariables(`_.set('不存在.路径', 1);`, v);
    assert.equal(r.modified, true);
    assert.equal(v.stat_data.不存在.路径, 1);
    assert.equal(r.receipt.ops[0].status, 'applied');
    assert.equal(r.receipt.ops[0].oldValue, undefined);
    assert.equal(r.receipt.errors.length, 0);
});

test('set(GH#15):stat_data. 前缀剥除——不嵌套 stat_data.stat_data', () => {
    const v = mvuData({ 日务: [{}, {}] });
    const r = settleMvuVariables(
        "_.set('stat_data.day', 2);\n_.set('stat_data.日务.1', {名:'晨课'});",
        v,
    );
    assert.equal(r.modified, true);
    assert.equal(v.stat_data.day, 2);
    assert.deepEqual(v.stat_data.日务[1], { 名: '晨课' });
    assert.equal(v.stat_data.stat_data, undefined);
    assert.deepEqual(r.receipt.ops.map(o => o.status), ['applied', 'applied']);
});

test('set(GH#15):_.set(\'stat_data\', obj) → 整体替换', () => {
    const v = mvuData({ a: 1 });
    const r = settleMvuVariables(`_.set('stat_data', {"b":2});`, v);
    assert.equal(r.modified, true);
    assert.deepEqual(v.stat_data, { b: 2 });
    assert.equal(r.receipt.ops[0].status, 'applied');
});

test('set(GH#15):variables.stat_data. 全前缀同样剥除', () => {
    const v = mvuData({});
    settleMvuVariables(`_.set('variables.stat_data.灵石', 310);`, v);
    assert.equal(v.stat_data.灵石, 310);
    assert.equal(v.stat_data.variables, undefined);
});

test('set:number 旧值 + 字符串新值 → Number() 强转', () => {
    const v = mvuData({ hp: 50 });
    settleMvuVariables(`_.set('hp', '80');`, v);
    assert.equal(v.stat_data.hp, 80);
});

test('set:ValueWithDescription([v,"desc"])只更 [0];strictSet 则整对替换', () => {
    const v = mvuData({ 好感: [10, '对主角的好感'] });
    settleMvuVariables(`_.set('好感', 15);`, v);
    assert.deepEqual(v.stat_data.好感, [15, '对主角的好感']);
    // strictSet:true 时 [v,"desc"] 视为普通数组 → 整体替换
    const v2 = mvuData({ 好感: [10, '对主角的好感'] }, { schema: { type: 'object', properties: {}, strictSet: true } });
    settleMvuVariables(`_.set('好感', '不爱了');`, v2);
    assert.equal(v2.stat_data.好感, '不爱了');
});

test('set:path 为空串 → 整个 stat_data 替换', () => {
    const v = mvuData({ a: 1 });
    const r = settleMvuVariables(`_.set('', {"b":2});`, v);
    assert.equal(r.modified, true);
    assert.deepEqual(v.stat_data, { b: 2 });
});

// ---------- settleMvuVariables:insert ----------

test('insert:2 参 → 数组 push / 对象 merge;3 参 → 下标插入/键写入', () => {
    const v = mvuData({ 背包: ['面包'], 状态: { 体力: 10 } });
    settleMvuVariables(
        `_.insert('背包', '药水');\n_.insert('状态', '饥饿', 30);\n_.insert('背包', 0, '急救包');`,
        v,
    );
    assert.deepEqual(v.stat_data.背包, ['急救包', '面包', '药水']);
    assert.equal(v.stat_data.状态.饥饿, 30);
});

test('insert:json_patch "-" → 数组尾插', () => {
    const v = mvuData({ 线索: ['a'] });
    settleMvuVariables(
        `<json_patch>[{"op":"add","path":"/线索/-","value":"b"}]</json_patch>`,
        v,
    );
    assert.deepEqual(v.stat_data.线索, ['a', 'b']);
});

test('insert:目标原始值 → error;父路径缺失 → error', () => {
    const v = mvuData({ 体力: 10 });
    const r = settleMvuVariables(`_.insert('体力', 5);`, v);
    assert.equal(r.modified, false);
    assert.equal(r.receipt.ops[0].status, 'error');
    const r2 = settleMvuVariables(`_.insert('新容器.子', 5);`, v);
    assert.equal(r2.receipt.ops[0].status, 'error');
    // 已存在 path 为 null → 可建容器
    const v2 = mvuData({ 格子: null });
    settleMvuVariables(`_.insert('格子', 'k', 1);`, v2);
    assert.deepEqual(v2.stat_data.格子, { k: 1 });
});

test('insert:schema extensible=false 数组拒绝;object 未知键拒绝', () => {
    const v = mvuData(
        { 固定表: ['a'], 固定格: { 已知: 1 } },
        {
            schema: {
                type: 'object',
                properties: {
                    固定表: { type: 'array', elementType: { type: 'any' }, extensible: false },
                    固定格: { type: 'object', properties: { 已知: { type: 'number' } }, extensible: false },
                },
            },
        },
    );
    const r = settleMvuVariables(`_.insert('固定表', 'b');\n_.insert('固定格', '新键', 2);`, v);
    assert.equal(r.modified, false);
    assert.equal(r.receipt.ops[0].status, 'error');
    assert.equal(r.receipt.ops[1].status, 'error');
    assert.deepEqual(v.stat_data.固定表, ['a']);
    assert.deepEqual(v.stat_data.固定格, { 已知: 1 });
});

test('insert:schema.template 应用到新元素', () => {
    const v = mvuData(
        { 队伍: [{ 名: 'a', 等级: 1 }] },
        {
            schema: {
                type: 'object',
                properties: {
                    队伍: {
                        type: 'array',
                        elementType: { type: 'object', properties: {} },
                        extensible: true,
                        template: { 名: '', 等级: 1, 职业: '无' },
                    },
                },
            },
        },
    );
    settleMvuVariables(`_.insert('队伍', {名:'b'});`, v);
    // applyTemplate:值优先,模板补全缺省键
    assert.deepEqual(v.stat_data.队伍[1], { 名: 'b', 等级: 1, 职业: '无' });
});

// ---------- settleMvuVariables:delete/remove/unset ----------

test('delete:1 参路径删除;数组下标 splice(快路径,先于 schema 门控)', () => {
    const v = mvuData({ a: 1, arr: ['x', 'y', 'z'] });
    settleMvuVariables(`_.remove('a');\n_.remove('arr[1]');`, v);
    assert.equal(v.stat_data.a, undefined);
    assert.deepEqual(v.stat_data.arr, ['x', 'z']);
});

test('delete:对象键 — 生成 schema 下非 extensible 对象的键为 required → 拒绝;extensible → 删除', () => {
    // upstream:reconcile 生成的 schema 把非 extensible 对象的键标 required,
    // `_.remove('obj','k2')` 命中 removeRequiredKey 门控。
    const locked = mvuData({ obj: { k1: 1, k2: 2 } });
    settleMvuVariables(`_.set('obj.k1', 5);`, locked); // 触发 reconcile 生成真实 schema
    const denied = settleMvuVariables(`_.remove('obj', 'k2');`, locked);
    assert.equal(denied.receipt.ops[0].status, 'error');
    assert.match(denied.receipt.ops[0].error, /required/i);
    assert.deepEqual(locked.stat_data.obj, { k1: 5, k2: 2 });

    // $meta.extensible → 子键 required=false → 允许删除
    // 注:$meta 只在 initCheck 阶段清理;settle 内 generateSchema 作用于克隆,
    // 真实 stat_data 中 $meta 继续存在(upstream 同)。
    const open = mvuData({ obj: { $meta: { extensible: true }, k1: 1, k2: 2 } });
    settleMvuVariables(`_.set('obj.k1', 5);`, open);
    const allowed = settleMvuVariables(`_.remove('obj', 'k2');`, open);
    assert.equal(allowed.receipt.ops[0].status, 'applied');
    assert.deepEqual(open.stat_data.obj, { $meta: { extensible: true }, k1: 5 });
});

test('delete:数组按值定位删除;不存在 → error', () => {
    const v = mvuData({ arr: ['a', 'b', 'a'] });
    settleMvuVariables(`_.remove('arr', 'a');`, v);
    assert.deepEqual(v.stat_data.arr, ['b', 'a']); // findIndex 命中首个
    const r = settleMvuVariables(`_.remove('missing');`, v);
    assert.equal(r.receipt.ops[0].status, 'error');
});

// ---------- settleMvuVariables:add ----------

test('add:number delta;VWD [0] delta;非数字 delta → error', () => {
    const v = mvuData({ hp: 50, 好感: [5, 'x'], name: 'abc' });
    const r = settleMvuVariables(`_.add('hp', -10);\n_.add('好感', 3);\n_.add('name', 1);`, v);
    assert.equal(v.stat_data.hp, 40);
    assert.deepEqual(v.stat_data.好感, [8, 'x']);
    assert.equal(r.receipt.ops[2].status, 'error');
});

test('add:日期值 + 毫秒 delta → ISO 字符串', () => {
    const v = mvuData({ 时间: '2024-01-01T00:00:00.000Z' });
    settleMvuVariables(`_.add('时间', 3600000);`, v);
    assert.equal(v.stat_data.时间, '2024-01-01T01:00:00.000Z');
});

// ---------- json_patch 全 op ----------

test('json_patch:replace/delta/insert/remove;move → unsupported 不生效', () => {
    const v = mvuData({ a: 1, hp: 10, arr: [1], b: 2, m: 1 });
    const r = settleMvuVariables(
        `<json_patch>[` +
        `{"op":"replace","path":"/a","value":9},` +
        `{"op":"delta","path":"/hp","value":5},` +
        `{"op":"insert","path":"/arr/0","value":0},` +
        `{"op":"remove","path":"/b"},` +
        `{"op":"move","from":"/m","to":"/n"}` +
        `]</json_patch>`,
        v,
    );
    assert.equal(v.stat_data.a, 9);
    assert.equal(v.stat_data.hp, 15);
    assert.deepEqual(v.stat_data.arr, [0, 1]);
    assert.equal(v.stat_data.b, undefined);
    assert.equal(v.stat_data.n, undefined); // move 不执行
    assert.equal(v.stat_data.m, 1);
    assert.equal(r.receipt.ops[4].status, 'unsupported');
});

// ---------- schema reconcile ----------

test('reconcile:修改后重生成 schema(嵌套属性/required)', () => {
    const v = mvuData({ a: { b: 1 } });
    settleMvuVariables(`_.set('a.b', 2);`, v);
    assert.equal(v.schema.type, 'object');
    assert.ok(v.schema.properties.a);
    assert.equal(v.schema.properties.a.type, 'object');
    assert.ok(v.schema.properties.a.properties.b);
});

// ---------- settleMvuMessage:楼层投影 ----------

test('settleMvuMessage:基底=前一楼层快照;fold 累积;占位符追加', () => {
    const messages = [
        floor('开场', { is_system: true, variables: { 0: mvuData({ 体力: 50 }) } }),
        floor(`冒险开始。\n<UpdateVariable>\n_.set('体力', 30);//跳下\n</UpdateVariable>`),
    ];
    const r = settleMvuMessage({ messages, messageIndex: 1 });
    assert.equal(r.status, 'settled');
    assert.equal(r.modified, true);
    assert.equal(r.baselineIndex, 0);
    assert.equal(r.swipeId, 0);
    assert.equal(r.variables.stat_data.体力, 30);
    assert.ok(r.message.endsWith(MVU_STATUS_PLACEHOLDER));
    assert.deepEqual(r.chatVariablesPatch.stat_data, { 体力: 30 });
    // 第二层楼再从第一层快照继续 fold(投影语义)
    messages[1].variables = { 0: r.variables };
    messages[1].mes = r.message;
    messages.push(floor(`继续。\n_.add('体力', -5);`));
    const r2 = settleMvuMessage({ messages, messageIndex: 2 });
    assert.equal(r2.baselineIndex, 1);
    assert.equal(r2.variables.stat_data.体力, 25);
});

test('settleMvuMessage:无基底 → no_baseline;swipe 槽位隔离', () => {
    const messages = [floor('hi'), floor('回复内容长度足够')];
    const r = settleMvuMessage({ messages, messageIndex: 1 });
    assert.equal(r.status, 'no_baseline');
    // 基底按楼层自身 swipe_id 取槽位
    const m2 = [
        floor('g', { variables: { 1: mvuData({ v: 1 }), 0: mvuData({ v: 0 }) }, swipe_id: 1 }),
        floor(`t t t t t _.set('v', 9);`),
    ];
    const r2 = settleMvuMessage({ messages: m2, messageIndex: 1 });
    assert.equal(r2.variables.stat_data.v, 9);
});

test('settleMvuMessage:status_current_variable 剥离;assistant<5 字跳过', () => {
    const messages = [
        floor('g', { variables: { 0: mvuData({ x: 1 }) } }),
        floor(`正文<status_current_variable>{"x":1}</status_current_variable>尾部`),
    ];
    const r = settleMvuMessage({ messages, messageIndex: 1 });
    assert.ok(!r.message.includes('status_current_variable'));
    const short = settleMvuMessage({ messages: [floor('g'), floor('...')], messageIndex: 1 });
    assert.equal(short.status, 'skipped');
});

test('幂等:同一基底重复 settle 产出完全一致(stat_data/schema/receipt.ops)', () => {
    const make = () => [floor('g', { variables: { 0: mvuData({ hp: 10, arr: [1] }) } }), floor(`_.add('hp', 5);\n_.insert('arr', 9);`)];
    const a = settleMvuMessage({ messages: make(), messageIndex: 1 });
    const b = settleMvuMessage({ messages: make(), messageIndex: 1 });
    assert.deepEqual(a.variables.stat_data, b.variables.stat_data);
    assert.deepEqual(a.receipt.ops.map(o => [o.type, o.status, o.display]), b.receipt.ops.map(o => [o.type, o.status, o.display]));
    // 已结算楼层不回读自身快照:基底仍是 floor0 → 重复跑结果一致
    const msgs = make();
    const first = settleMvuMessage({ messages: msgs, messageIndex: 1 });
    msgs[1].variables = { 0: first.variables };
    const second = settleMvuMessage({ messages: msgs, messageIndex: 1 });
    assert.equal(second.baselineIndex, 0);
    assert.deepEqual(second.variables.stat_data, first.variables.stat_data);
});

// ---------- initializeMvuVariables ----------

test('initialize:lorebook [initvar] 合并 + greeting <initvar> 覆盖 + $meta.strictSet', () => {
    const books = [
        {
            name: '主书',
            isPrimary: true,
            entries: [
                { comment: '[initvar]状态初值', content: '```json\n{"时间":{"日期":"第一天"},"背包":[]}\n```' },
                { comment: '普通条目', content: '{"忽略":true}' },
            ],
        },
        {
            name: '全局书',
            entries: [{ comment: '[initvar]补充', content: '声望: 0' }],
        },
    ];
    const r = initializeMvuVariables({
        swipeText: `开场白。\n<initvar>\n{"$meta":{"strictSet":true},"时间":{"日期":"开局"},"状态":{"体力":62}}\n</initvar>`,
        lorebooks: books,
        primaryLorebookName: '主书',
    });
    assert.equal(r.appliedInitVarOverride, true);
    assert.equal(r.variables.stat_data.时间.日期, '开局');
    assert.equal(r.variables.stat_data.状态.体力, 62);
    // 主书保留,其他书二次载入(声望并入覆盖后的 stat_data)
    assert.equal(r.variables.stat_data.声望, 0);
    assert.ok('主书' in r.variables.initialized_lorebooks);
    // upstream:<initvar> 覆盖后 $meta 留在 stat_data;swipe 无命令 →
    // isModified=false → reconcile 不跑 → strictSet 延迟到下一次真实更新落地
    assert.equal(r.variables.stat_data.$meta.strictSet, true);
    assert.equal(r.variables.schema.strictSet, undefined);
    const later = settleMvuVariables(`_.set('状态.体力', 60);`, r.variables);
    assert.equal(later.modified, true);
    assert.equal(r.variables.schema.strictSet, true);
});

test('initialize:greeting 内 _. 命令一并 fold;<initvar> 未命中走 lorebook', () => {
    const books = [{ name: 'b1', entries: [{ comment: '[initvar]x', content: 'hp: 10' }] }];
    const r = initializeMvuVariables({
        swipeText: `开局即战斗。\n_.add('hp', -3);`,
        lorebooks: books,
    });
    assert.equal(r.variables.stat_data.hp, 7);
    assert.equal(r.receipt.ops.length, 1);
});

// ---------- 真实 MVU 卡样例(ref/dsh-tavern/examples/airline-mvu/card.json) ----------

test('airline-mvu:[initvar] 内嵌书初始化 + json_patch 新人物(template 补全)', () => {
    // 卡内嵌世界书 [initvar] 条目的等比缩影:$meta.extensible + $meta.template。
    const books = [{
        name: '云际航空书',
        entries: [{
            comment: '[initvar]航空初始状态',
            content: `{
                "航班": {"阶段": "登机", "目的地": "未明确"},
                "当前交互人物": "澹台矜",
                "人物": {
                    "$meta": {
                        "extensible": true,
                        "template": {"姓名":"","年龄":0,"身份":"","在场":true}
                    },
                    "澹台矜": {"姓名":"澹台矜","年龄":23,"身份":"乘务员","在场":true}
                },
                "任务": {"$meta": {"extensible": true, "template": {"名称":"","状态":"进行中"}}}
            }`,
        }],
    }];
    const init = initializeMvuVariables({
        swipeText: '【舱内广播】"欢迎登机。"\n你来到舱门口。\n<airline-status/>',
        lorebooks: books,
    });
    assert.equal(init.appliedInitVarOverride, false);
    const vars = init.variables;
    assert.equal(vars.stat_data.当前交互人物, '澹台矜');
    // $meta 在 initCheck 阶段清出 stat_data,落入 schema
    assert.equal(vars.stat_data.人物.$meta, undefined);
    assert.equal(vars.schema.properties.人物.extensible, true);
    assert.deepEqual(vars.schema.properties.人物.template, { 姓名: '', 年龄: 0, 身份: '', 在场: true });

    // 模型 mvu_submit_update 提交等价 json_patch:新人物 insert → template 补全缺省字段
    const up = settleMvuVariables(
        `正文中机长林彻登场。\n` +
        `<json_patch>[{"op":"add","path":"/人物/林彻","value":{"姓名":"林彻","身份":"机长"}},` +
        `{"op":"replace","path":"/航班/阶段","value":"滑行"},` +
        `{"op":"add","path":"/任务/安全须知","value":{"名称":"安全须知","说明":"确认乘客系好安全带"}}]` +
        `</json_patch>`,
        vars,
    );
    assert.equal(up.modified, true);
    assert.equal(up.receipt.ops.length, 3);
    const 林彻 = vars.stat_data.人物.林彻;
    assert.equal(林彻.姓名, '林彻');
    assert.equal(林彻.身份, '机长');
    assert.equal(林彻.在场, true);   // template 补全
    assert.equal(林彻.年龄, 0);     // template 补全
    assert.equal(vars.stat_data.航班.阶段, '滑行');
    assert.equal(vars.stat_data.任务.安全须知.状态, '进行中');

    // 楼层投影 + 状态板固定模板渲染(seam 闭环)
    const messages = [
        floor('开场', { is_system: true, variables: { 0: vars } }),
        floor(`机长林彻走进客舱。\n<json_patch>[{"op":"replace","path":"/当前交互人物","value":"林彻"}]</json_patch>`),
    ];
    const msg = settleMvuMessage({ messages, messageIndex: 1 });
    assert.equal(msg.variables.stat_data.当前交互人物, '林彻');
    const panel = renderMvuStatusPanel(
        '<b>{{stat_data.航班.阶段}}</b> · {{stat_data.当前交互人物}} · {{stat_data.人物.澹台矜.身份}}',
        msg.chatVariablesPatch,
    );
    assert.equal(panel, '<b>滑行</b> · 林彻 · 乘务员');
});

// ---------- renderMvuStatusPanel(状态栏固定模板 seam) ----------

test('panel:getvar::/stat_data. 插值 + HTML 转义 + 三花括号裸输出', () => {
    const vars = { stat_data: { 状态: { 体力: 62, 称号: '<b>剑修</b>' }, 背包: ['面包'] } };
    const html = renderMvuStatusPanel(
        '<div>体力:{{stat_data.状态.体力}}</div>' +
        '<span>{{getvar::stat_data.状态.称号}}</span>' +
        '{{{getvar::stat_data.状态.称号}}}',
        vars,
    );
    assert.equal(
        html,
        '<div>体力:62</div>' +
        '<span>&lt;b&gt;剑修&lt;/b&gt;</span>' +
        '<b>剑修</b>',
    );
    // 未命中 → 空串;非 getvar/stat_data 前缀的 {{…}} 原样保留
    const partial = renderMvuStatusPanel('{{stat_data.不存在}}|{{other_macro}}|{{stat_data.背包.0}}', vars);
    assert.equal(partial, '|{{other_macro}}|面包');
});

// ---------- isMvuData / findMvuBaselineIndex ----------

test('isMvuData 需 stat_data+schema;findMvuBaselineIndex 取最近楼层', () => {
    assert.equal(isMvuData({ stat_data: {}, schema: {} }), true);
    assert.equal(isMvuData({ stat_data: {} }), false);
    const msgs = [
        floor('a', { variables: { 0: mvuData({}) } }),
        floor('b'),
        floor('c', { variables: { 0: { stat_data: {} } } }), // 无 schema → 不算
    ];
    assert.equal(findMvuBaselineIndex(msgs, 3), 0);
    assert.equal(findMvuBaselineIndex(msgs, 0), -1);
});
