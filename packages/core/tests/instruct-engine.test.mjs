/**
 * Instruct 引擎测试 —— 对照 ref/Luker/public/scripts/instruct-mode.js 语义。
 * 预期值按原版逐行手算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatInstructModeChat,
    formatInstructModePrompt,
    formatInstructModeStoryString,
    formatInstructModeExamples,
    formatInstructModeSystemPrompt,
    getInstructStoppingSequences,
    autoSelectInstructPreset,
    migrateInstructModeSettings,
    createInstructEngine,
    names_behavior_types,
    force_output_sequence,
} from '../dist/instruct/engine.js';
import { substituteParams, parseInstructExampleIntoIndividual as parseExampleIntoIndividual, regexFromString } from '../dist/index.js';

const FIRST = force_output_sequence.FIRST;
const LAST = force_output_sequence.LAST;

/** Alpaca 风格默认 instruct(power-user.js:274-301 同构) */
function mkInstruct(over = {}) {
    return {
        enabled: true,
        preset: 'Test',
        input_sequence: '### Instruction:',
        input_suffix: '',
        output_sequence: '### Response:',
        output_suffix: '',
        system_sequence: '### System:',
        system_suffix: '',
        last_system_sequence: '',
        first_input_sequence: '',
        first_output_sequence: '',
        last_input_sequence: '',
        last_output_sequence: '',
        story_string_prefix: '',
        story_string_suffix: '',
        stop_sequence: '',
        wrap: true,
        macro: true,
        names_behavior: names_behavior_types.NONE,
        activation_regex: '',
        bind_to_context: false,
        user_alignment_message: '',
        system_same_as_user: false,
        sequences_as_stop_strings: true,
        skip_examples: false,
        ...over,
    };
}

function mkCtx(instruct, extra = {}) {
    const { contextTemplate, ...rest } = extra;
    return {
        chat: [],
        chatMetadata: {},
        globalVariables: {},
        name1: 'Alice',
        name2: 'Char',
        instruct,
        contextTemplate: contextTemplate ?? {},
        ...rest,
    };
}

// ---------- formatInstructModeChat:首/中/末序列拼接 ----------

test('formatChat:user/assistant/narrator 各自前后缀 + wrap', () => {
    const ctx = mkCtx(mkInstruct());
    assert.equal(formatInstructModeChat('Alice', 'hi', true, false, null, 'Alice', 'Char', false, ctx),
        '### Instruction:\nhi\n');
    assert.equal(formatInstructModeChat('Char', 'hello', false, false, null, 'Alice', 'Char', false, ctx),
        '### Response:\nhello\n');
    assert.equal(formatInstructModeChat('', 'note', false, true, null, 'Alice', 'Char', false, ctx),
        '### System:\nnote\n');
});

test('formatChat:FIRST/LAST 序列差异与 || 回落', () => {
    const ctx = mkCtx(mkInstruct({
        first_input_sequence: '### First In:',
        last_input_sequence: '### Last In:',
        first_output_sequence: '### First Out:',
        last_output_sequence: '### Last Out:',
    }));
    assert.equal(formatInstructModeChat('Alice', 'hi', true, false, null, 'Alice', 'Char', FIRST, ctx),
        '### First In:\nhi\n');
    assert.equal(formatInstructModeChat('Alice', 'hi', true, false, null, 'Alice', 'Char', LAST, ctx),
        '### Last In:\nhi\n');
    assert.equal(formatInstructModeChat('Char', 'yo', false, false, null, 'Alice', 'Char', FIRST, ctx),
        '### First Out:\nyo\n');
    assert.equal(formatInstructModeChat('Char', 'yo', false, false, null, 'Alice', 'Char', LAST, ctx),
        '### Last Out:\nyo\n');
    // 未配置 first/last 时回落 input/output_sequence
    const ctx2 = mkCtx(mkInstruct());
    assert.equal(formatInstructModeChat('Alice', 'hi', true, false, null, 'Alice', 'Char', FIRST, ctx2),
        '### Instruction:\nhi\n');
    assert.equal(formatInstructModeChat('Char', 'yo', false, false, null, 'Alice', 'Char', LAST, ctx2),
        '### Response:\nyo\n');
});

test('formatChat:wrap=false → 无分隔、suffix 不补换行', () => {
    const ctx = mkCtx(mkInstruct({ wrap: false }));
    assert.equal(formatInstructModeChat('Alice', 'hi', true, false, null, 'Alice', 'Char', false, ctx),
        '### Instruction:hi');
    // 显式 suffix 时照常拼接
    const ctx2 = mkCtx(mkInstruct({ wrap: false, output_suffix: '###' }));
    assert.equal(formatInstructModeChat('Char', 'yo', false, false, null, 'Alice', 'Char', false, ctx2),
        '### Response:yo###');
});

test('formatChat:macro 开 {{user}}/{{char}}/{{name}} 替换;关则原样', () => {
    const ctx = mkCtx(mkInstruct({
        input_sequence: '### {{user}}:',
        output_sequence: '### {{name}}:',
    }));
    assert.equal(formatInstructModeChat('Alice', 'hi', true, false, null, 'Alice', 'Char', false, ctx),
        '### Alice:\nhi\n');
    assert.equal(formatInstructModeChat('Char', 'yo', false, false, null, 'Alice', 'Char', false, ctx),
        '### Char:\nyo\n');
    // narrator 的 {{name}} 兜底 'System'
    assert.equal(formatInstructModeChat('', 'note', false, true, null, 'Alice', 'Char', false,
        mkCtx(mkInstruct({ system_sequence: '### {{name}}:' }))),
        '### System:\nnote\n');
    // macro 关:{{}} 原样保留
    const ctxOff = mkCtx(mkInstruct({ macro: false, input_sequence: '### {{user}}:' }));
    assert.equal(formatInstructModeChat('Alice', 'hi', true, false, null, 'Alice', 'Char', false, ctxOff),
        '### {{user}}:\nhi\n');
});

// ---------- names_behavior ----------

test('formatChat:names_behavior 三态 + group/forceAvatar 差异', () => {
    const mes = ['Char', 'yo', false, false];
    const umes = ['Alice', 'hi', true, false];
    // none → 永不带名
    const none = mkCtx(mkInstruct({ names_behavior: 'none' }), { selectedGroup: 'g1' });
    assert.equal(formatInstructModeChat(...mes, null, 'Alice', 'Char', false, none), '### Response:\nyo\n');
    // always → 带名
    const always = mkCtx(mkInstruct({ names_behavior: 'always' }));
    assert.equal(formatInstructModeChat(...mes, null, 'Alice', 'Char', false, always), '### Response:\nChar: yo\n');
    assert.equal(formatInstructModeChat(...umes, null, 'Alice', 'Char', false, always), '### Instruction:\nAlice: hi\n');
    // narrator 即使 always 也不带名
    assert.equal(formatInstructModeChat('', 'note', false, true, null, 'Alice', 'Char', false, always), '### System:\nnote\n');
    // force 无群 → 不带名
    const force = mkCtx(mkInstruct({ names_behavior: 'force' }));
    assert.equal(formatInstructModeChat(...mes, null, 'Alice', 'Char', false, force), '### Response:\nyo\n');
    // force + 群 + name!==name1 → 带名;name===name1 → 不带
    const forceG = mkCtx(mkInstruct({ names_behavior: 'force' }), { selectedGroup: 'g1' });
    assert.equal(formatInstructModeChat(...mes, null, 'Alice', 'Char', false, forceG), '### Response:\nChar: yo\n');
    assert.equal(formatInstructModeChat(...umes, null, 'Alice', 'Char', false, forceG), '### Instruction:\nhi\n');
    // force + forceAvatar(name!==name1)→ 带名
    assert.equal(formatInstructModeChat(...mes, 'other.png', 'Alice', 'Char', false, force), '### Response:\nChar: yo\n');
});

test('formatChat:system_same_as_user → narrator 用 user 序列', () => {
    const ctx = mkCtx(mkInstruct({ system_same_as_user: true, input_suffix: '!' }));
    assert.equal(formatInstructModeChat('', 'note', false, true, null, 'Alice', 'Char', false, ctx),
        '### Instruction:\nnote!');
});

// ---------- formatInstructModePrompt ----------

test('formatPrompt:默认/带名/last 序列/impersonate/quiet/bias', () => {
    const none = mkCtx(mkInstruct());
    // includeNames=false:text='\n'+seq,尾部分隔符补回
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', false, false, none),
        '\n### Response:\n');
    // always → 带名、无尾部分隔
    const always = mkCtx(mkInstruct({ names_behavior: 'always' }));
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', false, false, always),
        '\n### Response:\nChar:');
    // last_output_sequence 优先
    const last = mkCtx(mkInstruct({ names_behavior: 'always', last_output_sequence: '## Final:' }));
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', false, false, last),
        '\n## Final:\nChar:');
    // impersonate → last_input||input
    assert.equal(formatInstructModePrompt('Alice', true, '', 'Alice', 'Char', false, false, always),
        '\n### Instruction:\nAlice:');
    // impersonate 不吃 promptBias
    assert.equal(formatInstructModePrompt('Alice', true, 'BIAS', 'Alice', 'Char', false, false, always),
        '\n### Instruction:\nAlice:');
    // quiet 且非 toLoud → last_system||output,去前导分隔、无名字
    const quiet = mkCtx(mkInstruct({ names_behavior: 'always', last_system_sequence: '## Sys:' }));
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', true, false, quiet),
        '## Sys:\n');
    // quiet toLoud → 保持角色序列与名字
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', true, true, always),
        '### Response:\nChar:');
    // bias:includeNames 直拼,否则分隔+trimStart
    assert.equal(formatInstructModePrompt('Char', false, '  bias!', 'Alice', 'Char', false, false, none),
        '\n### Response:\nbias!\n');
    assert.equal(formatInstructModePrompt('Char', false, 'bias!', 'Alice', 'Char', false, false, always),
        '\n### Response:\nChar:bias!');
    // macro 关 → {{name}} 原样
    const off = mkCtx(mkInstruct({ macro: false, last_output_sequence: '## {{name}}:', names_behavior: 'none' }));
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', false, false, off),
        '\n## {{name}}:\n');
});

test('formatPrompt:Mistral nameFiller —— output 尾空格 last 无', () => {
    const ctx = mkCtx(mkInstruct({
        names_behavior: 'always',
        output_sequence: '### Response: ',
        last_output_sequence: '[RESP]',
    }));
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', false, false, ctx),
        '\n[RESP]\n Char:');
    // last 也带尾空格 → 不补(但 sequence 自身的尾空格保留,trimEnd 只削结尾)
    const ctx2 = mkCtx(mkInstruct({
        names_behavior: 'always',
        output_sequence: '### Response: ',
        last_output_sequence: '[RESP] ',
    }));
    assert.equal(formatInstructModePrompt('Char', false, '', 'Alice', 'Char', false, false, ctx2),
        '\n[RESP] \nChar:');
});

// ---------- getInstructStoppingSequences ----------

test('stoppingSequences:stop+各序列、wrap 前缀、去重、context 尾缀', () => {
    const ctx = mkCtx(mkInstruct({ stop_sequence: '### END' }), {
        contextTemplate: { use_stop_strings: true, chat_start: 'Chat start', example_separator: '***' },
    });
    assert.deepEqual(getInstructStoppingSequences(ctx), [
        '\n### END', '\n### Instruction:', '\n### Response:', '\n### System:',
        '\nChat start', '\n***',
    ]);
    // sequences_as_stop_strings=false → 只有 stop_sequence
    const noSeq = mkCtx(mkInstruct({ stop_sequence: '### END', sequences_as_stop_strings: false }), {
        contextTemplate: { use_stop_strings: true, chat_start: 'Chat start' },
    });
    assert.deepEqual(getInstructStoppingSequences(noSeq), ['\n### END', '\nChat start']);
    // wrap=false → 无前缀;context 两条仍硬编码 \n 前缀
    const noWrap = mkCtx(mkInstruct({ wrap: false }), {
        contextTemplate: { use_stop_strings: true, example_separator: '***' },
    });
    assert.deepEqual(getInstructStoppingSequences(noWrap),
        ['### Instruction:', '### Response:', '### System:', '\n***']);
    // instruct disabled → 只剩 context 部分;useStopStrings=false 参数压过设置
    const off = mkCtx(mkInstruct({ enabled: false }), {
        contextTemplate: { use_stop_strings: true, chat_start: 'CS' },
    });
    assert.deepEqual(getInstructStoppingSequences(off), ['\nCS']);
    assert.deepEqual(getInstructStoppingSequences(off, { useStopStrings: false }), []);
    // customInstruct 视为启用;同名序列去重;纯空白序列跳过;{{name}}→对应名
    const custom = mkCtx(mkInstruct({ enabled: false }));
    assert.deepEqual(getInstructStoppingSequences(custom, {
        customInstruct: mkInstruct({
            enabled: true,
            stop_sequence: '',
            input_sequence: '### {{name}}:',
            output_sequence: '### {{name}}:',
            system_sequence: '   ',
            last_system_sequence: '',
            wrap: false,
        }),
        useStopStrings: false,
    }), ['### Alice:', '### Char:']);
    // macro 开 → stop 串里的 {{user}} 也被替换(其余序列照常入列)
    const macro = mkCtx(mkInstruct({ input_sequence: 'IN {{user}}', wrap: false }), {
        contextTemplate: { use_stop_strings: false },
    });
    assert.deepEqual(getInstructStoppingSequences(macro), ['IN Alice', '### Response:', '### System:']);
    // macro 关 → 原样
    const macroOff = mkCtx(mkInstruct({ macro: false, input_sequence: 'IN {{user}}', wrap: false }), {
        contextTemplate: { use_stop_strings: false },
    });
    assert.deepEqual(getInstructStoppingSequences(macroOff), ['IN {{user}}', '### Response:', '### System:']);
});

// ---------- activation_regex / autoSelectInstructPreset ----------

test('autoSelectPreset:映射表 > activation_regex > bind_to_context', () => {
    const warns = [];
    const ctx = mkCtx(mkInstruct({ enabled: true, bind_to_context: true }), {
        instructPresets: [
            { name: 'Meth', enabled: true, activation_regex: '/meth|plato/i' },
            { name: 'Catch', enabled: true, activation_regex: '/.*/' },
            { name: 'Ctx', enabled: true },
        ],
        contextTemplate: { preset: 'Ctx' },
        modelTemplatesMappings: { 'model-x': { instruct: 'P1', context: 'C1' } },
        warn: (m) => warns.push(m),
    });
    // 映射表命中(即使 regex 也想抢)
    assert.deepEqual(autoSelectInstructPreset('model-x', ctx),
        { matched: true, instructPreset: 'P1', contextPreset: 'C1' });
    // regex 命中取第一个
    assert.deepEqual(autoSelectInstructPreset('my-METHarme-v2', ctx),
        { matched: true, instructPreset: 'Meth' });
    // 无 regex 命中 + bind_to_context → 同名预设
    assert.deepEqual(autoSelectInstructPreset('whatever', ctx),
        { matched: true, instructPreset: 'Catch' }); // '/.*/' 会先命中
    // 去掉 Catch 后轮到 bind_to_context
    const ctx2 = mkCtx(mkInstruct({ enabled: true, bind_to_context: true }), {
        instructPresets: [{ name: 'Ctx', enabled: true }],
        contextTemplate: { preset: 'Ctx' },
    });
    assert.deepEqual(autoSelectInstructPreset('nothing', ctx2), { matched: true, instructPreset: 'Ctx' });
    // 无命中 → matched:false
    const ctx3 = mkCtx(mkInstruct({ enabled: true }), { instructPresets: [{ name: 'A', enabled: true, activation_regex: '/xyz/' }] });
    assert.deepEqual(autoSelectInstructPreset('abc', ctx3), { matched: false });
    // instruct 关闭 → 直接 false
    const ctx4 = mkCtx(mkInstruct({ enabled: false }), { instructPresets: [{ name: 'A', enabled: true, activation_regex: '/.*/' }] });
    assert.deepEqual(autoSelectInstructPreset('abc', ctx4), { matched: false });
    // 非法 regex 静默跳过(regexFromString 返回 undefined)
    const ctx5 = mkCtx(mkInstruct({ enabled: true }), { instructPresets: [{ name: 'Bad', enabled: true, activation_regex: '///' }] });
    assert.deepEqual(autoSelectInstructPreset('abc', ctx5), { matched: false });
    assert.equal(regexFromString('/meth/i') instanceof RegExp, true);
    assert.equal(regexFromString('/(a/') === undefined, true);
});

// ---------- formatInstructModeExamples ----------

const EXAMPLES = ['<START>\nAlice: hi\nChar: hello\n'];

test('formatExamples:块头 + user/assistant 前后缀', () => {
    const ctx = mkCtx(mkInstruct(), { contextTemplate: { example_separator: '***' } });
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', ctx), [
        '***\n',
        '### Instruction:\nhi\n',
        '### Response:\nhello\n',
    ]);
    // 无 example_separator → 无块头
    const noSep = mkCtx(mkInstruct());
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', noSep), [
        '### Instruction:\nhi\n',
        '### Response:\nhello\n',
    ]);
});

test('formatExamples:names_behavior —— always/force/group 差异', () => {
    const always = mkCtx(mkInstruct({ names_behavior: 'always' }));
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', always), [
        '### Instruction:\nAlice: hi\n',
        '### Response:\nChar: hello\n',
    ]);
    // force 无群:user 占位带名,assistant 不带
    const force = mkCtx(mkInstruct({ names_behavior: 'force' }));
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', force), [
        '### Instruction:\nAlice: hi\n',
        '### Response:\nhello\n',
    ]);
    // force + 群:名字由 parseExampleIntoIndividual 内嵌,不再额外加前缀
    const group = mkCtx(mkInstruct({ names_behavior: 'force' }), {
        selectedGroup: 'g1',
        groupMemberNames: ['Char', 'Rex'],
    });
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', group), [
        '### Instruction:\nAlice: hi\n',
        '### Response:\nChar: hello\n',
    ]);
    // 群成员名行(非 name2)识别为 assistant,保留群名
    const multiBot = ['<START>\nAlice: hi\nRex: woof\n'];
    assert.deepEqual(formatInstructModeExamples(multiBot, 'Alice', 'Char', group), [
        '### Instruction:\nAlice: hi\n',
        '### Response:\nRex: woof\n',
    ]);
});

test('formatExamples:skip_examples / 空解析回退 / macro-off 怪癖', () => {
    const sep = { contextTemplate: { example_separator: '***' } };
    // skip_examples → 原样换块头
    const skip = mkCtx(mkInstruct({ skip_examples: true }), sep);
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', skip),
        ['***\nAlice: hi\nChar: hello\n']);
    // 无名字可解析 → 回退同 skip
    const ctx = mkCtx(mkInstruct(), sep);
    assert.deepEqual(formatInstructModeExamples(['<START>\nno names here\n'], 'Alice', 'Char', ctx),
        ['***\nno names here\n']);
    // macro=false 且 wrap:空 suffix 不补 '\n'(原版只在 macro 分支内补)
    const off = mkCtx(mkInstruct({ macro: false }));
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', off), [
        '### Instruction:\nhi',
        '### Response:\nhello',
    ]);
    // macro=false → 序列里的 {{}} 原样
    const off2 = mkCtx(mkInstruct({ macro: false, input_sequence: '{{user}} in:' }));
    assert.deepEqual(formatInstructModeExamples(EXAMPLES, 'Alice', 'Char', off2), [
        '{{user}} in:\nhi',
        '### Response:\nhello',
    ]);
});

test('parseExampleIntoIndividual:群成员 botName 切换与连续 bot 合并', () => {
    const ctx = mkCtx(mkInstruct(), { selectedGroup: 'g1', groupMemberNames: ['Char', 'Rex'] });
    // 原版行为:botName 一旦换成群成员就不因 name2 行重置;
    // 连续 bot 行(中间无 user)合并进同一条 example_assistant
    const r = parseExampleIntoIndividual('{Example Dialogue:}\nAlice: a1\nRex: r1\nChar: c1\n', true, ctx);
    assert.deepEqual(r, [
        { role: 'system', content: 'Alice: a1', name: 'example_user' },
        { role: 'system', content: 'Rex: r1\nChar: c1', name: 'example_assistant' },
    ]);
    // botName 粘滞:name2 行出现在 Rex 之后,内嵌名仍是 Rex
    const r2 = parseExampleIntoIndividual('{Example Dialogue:}\nAlice: a1\nRex: r1\nAlice: a2\nChar: c1\n', true, ctx);
    assert.deepEqual(r2, [
        { role: 'system', content: 'Alice: a1', name: 'example_user' },
        { role: 'system', content: 'Rex: r1', name: 'example_assistant' },
        { role: 'system', content: 'Alice: a2', name: 'example_user' },
        { role: 'system', content: 'Rex: Char: c1', name: 'example_assistant' },
    ]);
    // 无群 → 不内嵌名字
    const solo = mkCtx(mkInstruct());
    assert.deepEqual(parseExampleIntoIndividual('{Example Dialogue:}\nAlice: a1\nChar: c1\n', false, solo), [
        { role: 'system', content: 'a1', name: 'example_user' },
        { role: 'system', content: 'c1', name: 'example_assistant' },
    ]);
});

// ---------- story string / system prompt / migrate ----------

test('formatStoryString:前后缀、wrap、IN_CHAT 跳过、{{name}}→System', () => {
    const ctx = mkCtx(mkInstruct({
        story_string_prefix: 'Sys {{name}}:',
        story_string_suffix: '[END]',
    }));
    assert.equal(formatInstructModeStoryString('BODY', ctx), 'Sys System:\nBODY[END]');
    // story_string_position=IN_CHAT(1)→ 不上序列
    const inChat = mkCtx(mkInstruct({ story_string_prefix: 'P', story_string_suffix: 'S' }), {
        contextTemplate: { story_string_position: 1 },
    });
    assert.equal(formatInstructModeStoryString('BODY', inChat), 'BODY');
    // wrap=false → 无分隔
    const noWrap = mkCtx(mkInstruct({ wrap: false, story_string_prefix: 'P' }));
    assert.equal(formatInstructModeStoryString('BODY', noWrap), 'PBODY');
    assert.equal(formatInstructModeStoryString('', ctx), '');
    assert.equal(formatInstructModeSystemPrompt('ABC'), 'ABC');
});

test('migrateInstructModeSettings:旧字段迁移与默认补齐', () => {
    const s = { enabled: true, separator_sequence: '</s>', names: false, names_force_groups: true, system_sequence_prefix: 'x' };
    migrateInstructModeSettings(s);
    assert.equal(s.output_suffix, '</s>');
    assert.equal(s.separator_sequence, undefined);
    assert.equal(s.names_behavior, 'force');
    assert.equal(s.names, undefined);
    assert.equal(s.names_force_groups, undefined);
    assert.equal(s.system_sequence_prefix, undefined);
    assert.equal(s.skip_examples, false);
    assert.equal(s.sequences_as_stop_strings, true);
    const s2 = { enabled: true, names: true };
    migrateInstructModeSettings(s2);
    assert.equal(s2.names_behavior, 'always');
    const s3 = { enabled: true, names: false, names_force_groups: false };
    migrateInstructModeSettings(s3);
    assert.equal(s3.names_behavior, 'none');
});

// ---------- seam:SubstituteContext.formatInstructExamples ----------

test('seam:createInstructEngine.formatInstructExamples 可直接填入 substituteParams', () => {
    const instruct = mkInstruct();
    const ctx = mkCtx(instruct, {
        contextTemplate: { example_separator: '***' },
        cardFields: { mesExamples: '<START>\nAlice: hi\nChar: hello' },
        mainApi: 'textgen',
    });
    const engine = createInstructEngine(ctx);
    ctx.formatInstructExamples = engine.formatInstructExamples;
    // 经 {{mesExamples}} 宏全链路:parseMesExamples → instruct 格式化 → join
    const out = substituteParams('{{mesExamples}}', ctx);
    assert.equal(out, '***\n### Instruction:\nhi\n### Response:\nhello\n');
    // engine 其余绑定面
    assert.equal(engine.formatChat('Alice', 'hi', true, false, null, 'Alice', 'Char'), '### Instruction:\nhi\n');
    assert.equal(engine.formatPrompt('Char', false, '', 'Alice', 'Char', false, false), '\n### Response:\n');
    assert.equal(engine.formatStoryString('B'), 'B');
    assert.deepEqual(engine.getStoppingSequences({ useStopStrings: false }),
        ['\n### Instruction:', '\n### Response:', '\n### System:']);
});
