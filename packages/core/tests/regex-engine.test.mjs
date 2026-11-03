/**
 * Regex 引擎测试 — 对照 ref/Luker engine.js 的关键语义:
 * placement 过滤 / scoped 目标(markdownOnly·promptOnly·pluginLanes)/
 * depth 区间 / runOnEdit / disabled / 宏替换钩子(NONE·RAW·ESCAPED)/
 * $N·$<name>·{{match}} 替换 / trimStrings / 脚本流水线顺序 /
 * ReDoS 暂停 / applyWorldInfoRegex。
 * 注:index.ts 尚未接出 regex,故直接 import dist/regex/*。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    runRegexScript,
    getRegexedString,
    getRegexScripts,
    regexFromString,
    applyWorldInfoRegex,
    RegexProvider,
} from '../dist/regex/engine.js';
import {
    regex_placement,
    substitute_find_regex,
} from '../dist/regex/types.js';
import {
    isRegexScriptPaused,
    pauseRegexScript,
    recordRegexExecution,
    resetAllRegexScriptState,
    resetRegexScriptState,
    REGEX_HARD_THRESHOLD_MS,
} from '../dist/regex/redos.js';

const P = regex_placement;

function ctx(over = {}) {
    return {
        chat: over.chat ?? [],
        chatMetadata: over.chatMetadata ?? {},
        globalVariables: over.globalVariables ?? {},
        name1: over.name1 ?? 'Bob',
        name2: over.name2 ?? 'Alice',
        ...over.extra,
    };
}

let _id = 0;
function script(over = {}) {
    return {
        id: `s${++_id}`,
        scriptName: 'test',
        findRegex: 'x',
        replaceString: 'y',
        trimStrings: [],
        placement: [P.AI_OUTPUT],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: substitute_find_regex.NONE,
        minDepth: null,
        maxDepth: null,
        ...over,
    };
}

// ---------- runRegexScript:替换与分组引用 ----------

test('runRegexScript:$N 组引用逐位替换,非 g 只换首个', () => {
    const s = script({ findRegex: '/(\\w+)@(\\w+)/', replaceString: '$2-$1' });
    assert.equal(runRegexScript(s, 'a@b c@d', {}, ctx()), 'b-a c@d');
    const g = script({ findRegex: '/(\\w+)@(\\w+)/g', replaceString: '$2-$1' });
    assert.equal(runRegexScript(g, 'a@b c@d', {}, ctx()), 'b-a d-c');
});

test('runRegexScript:{{match}} 展开为 $0 全匹配', () => {
    const s = script({ findRegex: '/\\d+/g', replaceString: '<{{match}}>' });
    assert.equal(runRegexScript(s, 'a1b22', {}, ctx()), 'a<1>b<22>');
});

test('runRegexScript:$<name> 命名组;缺组/越界组 → 空串', () => {
    const named = script({ findRegex: '/(?<w>\\w+)!/g', replaceString: '$<w>?' });
    assert.equal(runRegexScript(named, 'hey! yo!', {}, ctx()), 'hey? yo?');
    const missing = script({ findRegex: '/(\\w+)@(\\w+)/', replaceString: '$1|$3' });
    assert.equal(runRegexScript(missing, 'a@b', {}, ctx()), 'a|');
    // 无命名组的正则上写 $<name> → 空串
    const noNamed = script({ findRegex: '/(\\w+)!/', replaceString: '$<w>' });
    assert.equal(runRegexScript(noNamed, 'hey!', {}, ctx()), '');
});

test('runRegexScript:replaceString 末端走 substituteParams', () => {
    const s = script({ findRegex: '/(\\w+)/', replaceString: '{{user}}:$1' });
    assert.equal(runRegexScript(s, 'hello', {}, ctx()), 'Bob:hello');
});

test('runRegexScript:disabled / 缺 findRegex / 空串 → 原样返回', () => {
    assert.equal(runRegexScript(script({ disabled: true }), 'x', {}, ctx()), 'x');
    assert.equal(runRegexScript(script({ findRegex: '' }), 'x', {}, ctx()), 'x');
    assert.equal(runRegexScript(script({}), '', {}, ctx()), '');
});

// ---------- substituteRegex 宏钩子 ----------

test('substituteRegex:RAW 展开 {{char}};NONE 保留字面;ESCAPED 转义', () => {
    const raw = script({ findRegex: '{{char}}', substituteRegex: substitute_find_regex.RAW, replaceString: 'HIT' });
    assert.equal(runRegexScript(raw, 'say Alice', {}, ctx({ name2: 'Alice' })), 'say HIT');

    const none = script({ findRegex: '{{char}}', substituteRegex: substitute_find_regex.NONE, replaceString: 'HIT' });
    assert.equal(runRegexScript(none, 'say {{char}} Alice', {}, ctx()), 'say HIT Alice');

    // char 含正则元字符:ESCAPED 只命中字面 "A.lice"
    const esc = script({ findRegex: '{{char}}', substituteRegex: substitute_find_regex.ESCAPED, replaceString: 'HIT' });
    assert.equal(runRegexScript(esc, 'say A.lice and AXlice', {}, ctx({ name2: 'A.lice' })), 'say HIT and AXlice');
});

// ---------- trimStrings ----------

test('trimStrings:逐条从捕获组里剔除,支持 {{char}} + characterOverride', () => {
    const s = script({ findRegex: '/(\\w+!)/', replaceString: '[$1]', trimStrings: ['!'] });
    assert.equal(runRegexScript(s, 'wow!', {}, ctx()), '[wow]');

    const m = script({ findRegex: '/(.+)/', replaceString: '$1', trimStrings: ['{{char}}'] });
    assert.equal(runRegexScript(m, 'Alice says hi', { characterOverride: 'Alice' }, ctx({ name2: 'Carol' })), ' says hi');
    // 无 override → 用 ctx.name2('Carol' 不在文本里 → 不变)
    assert.equal(runRegexScript(m, 'Alice says hi', {}, ctx({ name2: 'Carol' })), 'Alice says hi');
});

// ---------- getRegexedString:placement 与 scoped 目标 ----------

test('placement:仅命中 placement 数组内的脚本执行;多数组项', () => {
    const scripts = [script({ findRegex: 'x', replaceString: 'y' })];
    assert.equal(getRegexedString('x', P.USER_INPUT, { scripts }, ctx()), 'x');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts }, ctx()), 'y');

    const multi = [script({ placement: [P.USER_INPUT, P.WORLD_INFO] })];
    assert.equal(getRegexedString('x', P.USER_INPUT, { scripts: multi }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.WORLD_INFO, { scripts: multi }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.SLASH_COMMAND, { scripts: multi }, ctx()), 'x');
});

test('scoped 目标:markdownOnly/promptOnly 只跑对应通道;无标记只跑持久化通道', () => {
    const md = script({ markdownOnly: true });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [md], isMarkdown: true }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [md], isPrompt: true }, ctx()), 'x');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [md] }, ctx()), 'x');

    const po = script({ promptOnly: true });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [po], isPrompt: true }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [po], isMarkdown: true }, ctx()), 'x');

    const plain = script({});
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [plain] }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [plain], isMarkdown: true }, ctx()), 'x');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [plain], isPrompt: true }, ctx()), 'x');
});

test('pluginLanes:request/reply 通道;仅 reply 旁路 placement 和 depth', () => {
    // request:matchesScopedTarget 命中后仍要 placementList.includes(placement)
    const req = script({ pluginLanes: ['request'], placement: [P.AI_OUTPUT] });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [req], isPluginInput: true }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [req], isPluginOutput: true }, ctx()), 'x');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [req] }, ctx()), 'x');
    const reqNoPlacement = script({ pluginLanes: ['request'], placement: [] });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [reqNoPlacement], isPluginInput: true }, ctx()), 'x');

    // reply:isReplyLane → 不看 placement,也不做 depth 过滤
    const rep = script({ pluginLanes: ['reply'], placement: [] });
    assert.equal(getRegexedString('x', 99, { scripts: [rep], isPluginOutput: true }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [rep], isPluginOutput: true, depth: 5 }, ctx()), 'y');

    // 旧字段 pluginOnly → 两条通道(request 仍需 placement)
    const legacy = script({ pluginLanes: undefined, pluginOnly: true, placement: [P.AI_OUTPUT] });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [legacy], isPluginInput: true }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [legacy], isPluginOutput: true }, ctx()), 'y');
});

// ---------- depth ----------

test('depth:minDepth/maxDepth 区间,边界值与原版一致', () => {
    const s = script({ minDepth: 2, maxDepth: 4 });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [s], depth: 1 }, ctx()), 'x');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [s], depth: 2 }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [s], depth: 4 }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [s], depth: 5 }, ctx()), 'x');
    // depth 未传/为 null → 不做深度过滤
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [s] }, ctx()), 'y');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [s], depth: null }, ctx()), 'y');

    // minDepth 需 >= -1 才生效;minDepth 0 拦 depth -1
    const m0 = script({ minDepth: 0 });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [m0], depth: -1 }, ctx()), 'x');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [m0], depth: 0 }, ctx()), 'y');
    // maxDepth 需 >= 0 才生效;-1 视为不设上限
    const mx = script({ maxDepth: -1 });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [mx], depth: 100 }, ctx()), 'y');
});

// ---------- 编辑 / 禁用 / 容错 ----------

test('isEdit:runOnEdit=false 跳过;true 执行', () => {
    const noEdit = script({ runOnEdit: false });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [noEdit], isEdit: true }, ctx()), 'x');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [noEdit] }, ctx()), 'y');
    const yesEdit = script({ runOnEdit: true });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [yesEdit], isEdit: true }, ctx()), 'y');
});

test('容错:regexDisabled / 非字符串 / 非法 placement', () => {
    const scripts = [script()];
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts, regexDisabled: true }, ctx()), 'x');
    assert.equal(getRegexedString(42, P.AI_OUTPUT, { scripts }, ctx()), '');
    assert.equal(getRegexedString('x', undefined, { scripts }, ctx()), 'x');
    // placement 非数组且无 pluginLanes → 告警跳过,不炸
    const bad = script({ placement: null });
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [bad] }, ctx()), 'x');
    // 脚本数组里混入非对象 → 跳过
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [null, scripts[0]] }, ctx()), 'y');
});

// ---------- 脚本汇集:顺序 GLOBAL→PRESET→SCOPED→runtime ----------

test('getRegexScripts:按 GLOBAL→PRESET→SCOPED→runtime 拼接,流水线逐段生效', () => {
    const g = script({ scriptName: 'g', findRegex: 'a', replaceString: 'G' });
    const p = script({ scriptName: 'p', findRegex: 'a', replaceString: 'P' });
    const s = script({ scriptName: 's', findRegex: 'a', replaceString: 'S' });
    const all = getRegexScripts({ global: [g], preset: [p], scoped: [s] });
    assert.deepEqual(all.map(x => x.scriptName), ['g', 'p', 's']);
    // 每个脚本 /a/ 非全局只换第一个 'a':G→P→S 依次作用
    assert.equal(getRegexedString('a a a', P.AI_OUTPUT, { scripts: all }, ctx()), 'G P S');
});

test('getRegexScripts:scoped(卡级)参与;runtime 校验 scriptName、补 trimStrings;非对象剔除', () => {
    const scoped = script({ scriptName: 'scoped', findRegex: 'x', replaceString: 'scoped!' });
    const rt = script({ id: 'rt1', scriptName: 'rt', findRegex: 'x', replaceString: '$1', trimStrings: undefined });
    const noName = { id: 'rt2', findRegex: 'x', replaceString: 'y' };
    const merged = getRegexScripts({ scoped: [scoped, null, 42], runtime: [rt, noName] });
    assert.equal(merged.length, 2);
    assert.equal(merged[0].scriptName, 'scoped');
    assert.equal(merged[1].scriptName, 'rt');
    assert.deepEqual(merged[1].trimStrings, []);
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: merged }, ctx()), 'scoped!');
});

// ---------- ReDoS ----------

test('ReDoS:暂停的脚本跳过;阈值自动暂停;allowSlow 豁免', () => {
    resetAllRegexScriptState();
    const paused = script({ id: 'paused1' });
    pauseRegexScript('paused1');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [paused] }, ctx()), 'x');
    resetRegexScriptState('paused1');
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [paused] }, ctx()), 'y');

    recordRegexExecution({ id: 'auto1', scriptName: 's', findRegex: 'x' }, REGEX_HARD_THRESHOLD_MS);
    assert.equal(isRegexScriptPaused('auto1'), true);
    assert.equal(getRegexedString('x', P.AI_OUTPUT, { scripts: [script({ id: 'auto1' })] }, ctx()), 'x');

    recordRegexExecution({ id: 'slow-ok', allowSlow: true }, REGEX_HARD_THRESHOLD_MS);
    assert.equal(isRegexScriptPaused('slow-ok'), false);
    resetAllRegexScriptState();
});

// ---------- regexFromString / RegexProvider ----------

test('regexFromString:/pat/flags、裸 pattern、非法 flags 回退字面', () => {
    const r1 = regexFromString('/foo/gi');
    assert.equal(r1.flags, 'gi');
    assert.equal(r1.source, 'foo');
    const r2 = regexFromString('foo');
    assert.equal(r2.source, 'foo');
    // 非法 flags → 整个串按字面 pattern
    const r3 = regexFromString('/foo/zzz');
    assert.equal(r3.test('see /foo/zzz here'), true);
    // 编译失败 → undefined → 脚本静默跳过
    const bad = script({ findRegex: '([' });
    assert.equal(runRegexScript(bad, 'x', {}, ctx()), 'x');
});

test('RegexProvider:缓存复用并重置 lastIndex', () => {
    RegexProvider.instance.clear();
    const a = RegexProvider.instance.get('/foo/g');
    const b = RegexProvider.instance.get('/foo/g');
    assert.equal(a, b);
    a.exec('foo foo');
    assert.equal(a.lastIndex, 3);
    const c = RegexProvider.instance.get('/foo/g');
    assert.equal(c.lastIndex, 0);
});

// ---------- applyWorldInfoRegex ----------

test('applyWorldInfoRegex:只跑 WORLD_INFO + promptOnly 脚本(isPrompt:true),depth 透传', () => {
    // 原版 WI 调用带 isPrompt:true → 只有 promptOnly 脚本参与 WI 内容处理
    const wi = script({ placement: [P.WORLD_INFO], promptOnly: true });
    const nonWi = script({ placement: [P.AI_OUTPUT], promptOnly: true });
    assert.equal(applyWorldInfoRegex([wi, nonWi], 'x', {}, ctx()), 'y');
    // placement WORLD_INFO 但未标 promptOnly → scoped 门禁挡掉(原版语义)
    const noScope = script({ placement: [P.WORLD_INFO] });
    assert.equal(applyWorldInfoRegex([noScope], 'x', {}, ctx()), 'x');

    const deep = script({ placement: [P.WORLD_INFO], promptOnly: true, minDepth: 3 });
    assert.equal(applyWorldInfoRegex([deep], 'x', { depth: 2 }, ctx()), 'x');
    assert.equal(applyWorldInfoRegex([deep], 'x', { depth: 4 }, ctx()), 'y');
    assert.equal(applyWorldInfoRegex([deep], 'x', { depth: null }, ctx()), 'y');
    // role 参数接受但忽略(属 WI @Depth 语义)
    assert.equal(applyWorldInfoRegex([wi], 'x', { depth: 0, role: 1 }, ctx()), 'y');
});
