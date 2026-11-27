/**
 * lib/automation.ts 纯件单测 —— automation 面板的视图模型语义钉死:
 * 命令检索 / 三域正则摊平(含 preset gate 与 shared 透传)/ QR 条目
 * 触发分类 / ScriptRunRes 终态行。零 DOM 零 fetch,type-stripped .ts。
 * 跑法:node --test apps/web/tests/automation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    commandScriptLine, filterCommands, flattenRegexView, qrEntryKind,
    regexDraftOf, regexNewScript, regexPatchFromDraft, scriptResultLines,
} from '../src/lib/automation.ts';

const cmd = (name, aliases = [], help = '', args = [], unnamed = [], returns = null) =>
    ({ name, aliases, help, args, unnamed, returns });

test('filterCommands — name/alias/help 子串,空串全量', () => {
    const cmds = [
        cmd('echo', [], 'print text to pipe'),
        cmd('input', ['ask'], 'prompt the user'),
        cmd('setvar', [], 'store variable'),
    ];
    assert.equal(filterCommands(cmds, '  ').length, 3);
    assert.deepEqual(filterCommands(cmds, 'echo').map((c) => c.name), ['echo']);
    assert.deepEqual(filterCommands(cmds, 'ASK').map((c) => c.name), ['input'], 'alias 命中且大小写无关');
    assert.deepEqual(filterCommands(cmds, 'variable').map((c) => c.name), ['setvar'], 'help 命中');
    assert.equal(filterCommands(cmds, 'zzz').length, 0);
});

test('commandScriptLine — 参数拼接,空参不加尾巴', () => {
    assert.equal(commandScriptLine('echo', ''), '/echo');
    assert.equal(commandScriptLine('echo', '  hi there '), '/echo hi there');
});

const rx = (id, scriptName, extra = {}) => ({ id, scriptName, findRegex: '/x/', ...extra });

test('flattenRegexView — 三域分组/寻址/徽标透传;空 global 不产组', () => {
    const full = {
        global: [],
        chars: [{
            charDir: 'a', name: 'Alice', avatar: 'a.png', active: true, shared: true,
            scripts: [rx('r1', 'c1'), { scriptName: 'noid', findRegex: '/y/' }],
        }],
        presets: [{
            apiId: 'openai', name: '默认', allowed: false, inUse: true, active: false,
            scripts: [rx('p1', 'p-sc')],
        }],
        allowed: false, inUse: false, disabled: false,
    };
    const gs = flattenRegexView(full);
    assert.equal(gs.length, 2, '空 global 缺席');
    const [ch, pr] = gs;
    assert.equal(ch.kind, 'char');
    assert.equal(ch.title, 'Alice');
    assert.equal(ch.shared, true, '服务端 shared 真键透传(protocol 未声明)');
    assert.equal(ch.gate, undefined, 'char 域无 allow 闸(autoAllowed 只徽标)');
    assert.deepEqual(ch.target, { scope: 'char', charDir: 'a' });
    assert.equal(ch.items[0].idOrIdx, 'r1', '有 id 用 id');
    assert.equal(ch.items[1].idOrIdx, 1, '缺 id 退下标');

    assert.equal(pr.kind, 'preset');
    assert.deepEqual(pr.target, { scope: 'preset', apiId: 'openai', preset: '默认' });
    assert.deepEqual(pr.gate, { allowed: false }, 'preset 放行闸');
    assert.equal(pr.inUse, true);
    assert.equal(pr.active, false);
    assert.equal(pr.items[0].script.scriptName, 'p-sc');
});

test('flattenRegexView — global 有货时排最前', () => {
    const gs = flattenRegexView({
        global: [rx('g1', 'g')], chars: [], presets: [],
        allowed: true, inUse: false, disabled: false,
    });
    assert.equal(gs.length, 1);
    assert.equal(gs[0].kind, 'global');
    assert.deepEqual(gs[0].target, { scope: 'global' });
});

test('regexDraftOf/patchFromDraft — 默认稿 + 深度空串落 null + placement 排序', () => {
    const d = regexDraftOf();
    assert.equal(d.markdownOnly, true, '新稿 ST 默认 md-only');
    assert.equal(d.runOnEdit, true);
    assert.deepEqual([...d.placement], [2], '新稿默认 AI 输出');
    const p = regexPatchFromDraft({ ...d, placement: new Set([6, 1, 5]), minDepth: '3', maxDepth: ' ' });
    assert.deepEqual(p.placement, [1, 5, 6], 'placement 升序');
    assert.equal(p.minDepth, 3);
    assert.equal(p.maxDepth, null, '空串 = 无界 null');

    const d2 = regexDraftOf(rx('x', 's', { disabled: true, minDepth: 0, maxDepth: 9 }));
    assert.equal(d2.disabled, true);
    assert.equal(d2.minDepth, '0', '0 深度如实转串,不当 null');
    assert.equal(d2.maxDepth, '9');
});

test('regexNewScript — id 由调用方给,补丁全键展开', () => {
    const n = regexNewScript(regexDraftOf(), 'rx-1');
    assert.equal(n.id, 'rx-1');
    assert.equal(n.findRegex, '');
    assert.equal(n.disabled, false);
});

test('qrEntryKind — /continue 快路径 / /x 脚本 / 文本 / 空', () => {
    assert.equal(qrEntryKind({ message: '/continue' }), 'continue');
    assert.equal(qrEntryKind({ message: '/Continue more' }), 'continue');
    assert.equal(qrEntryKind({ message: '/echo hi' }), 'script');
    assert.equal(qrEntryKind({ message: '你好' }), 'text');
    assert.equal(qrEntryKind({ message: '   ' }), 'empty');
    assert.equal(qrEntryKind({}), 'empty');
    assert.equal(qrEntryKind({ message: ' /echo' }), 'script', '前导空白照常判脚本');
});

test('scriptResultLines — pipe/error/notifications/aborted 终态合成', () => {
    assert.deepEqual(scriptResultLines({ ok: true, pipe: 'hi' }), [{ text: 'hi', err: false }]);
    const lines = scriptResultLines({
        ok: false, pipe: 42,
        error: { code: 'command_failed', message: 'boom', commandName: 'echo' },
        notifications: [{ severity: 'info', text: 'n1' }, { severity: 'error', text: 'n2' }],
        popups: [{ text: 'pop' }], isAborted: true,
    });
    assert.equal(lines[0].text, '42', '非串 pipe JSON 化');
    assert.equal(lines[1].text, 'command_failed /echo: boom');
    assert.equal(lines[1].err, true);
    assert.equal(lines.find((l) => l.text === 'n2')?.err, true);
    assert.equal(lines.find((l) => l.text === 'pop')?.err, false);
    assert.equal(lines.at(-1).text, 'aborted');
    assert.deepEqual(scriptResultLines({ ok: true }), [], '空终态不给行 —— 调用方补「已执行」');
});

test('regexDraftOf — existing script keeps runtime truth (rename must not change firing)', () => {
    /* Reported bug: absent fields were drafted as `true`, so a plain
       rename-save silently enabled markdownOnly/runOnEdit and widened
       placement — changing WHEN the script runs. Runtime semantics:
       absent flag ≡ falsy; absent placement ≡ skipped (same as []). */
    const legacy = { id: 'l', scriptName: 'L', findRegex: '/x/' }; // all flags absent
    const d = regexDraftOf(legacy);
    assert.equal(d.markdownOnly, false, 'absent markdownOnly ≡ falsy, not drafted true');
    assert.equal(d.runOnEdit, false, 'absent runOnEdit ≡ falsy');
    assert.equal(d.promptOnly, false);
    assert.equal(d.placement.size, 0, 'absent placement ≡ never matches — [] preserves that');
    const p = regexPatchFromDraft(d);
    assert.equal(p.markdownOnly, false);
    assert.equal(p.runOnEdit, false);
    assert.deepEqual(p.placement, [], 'explicit [] ≡ engine-skip, same as absent');

    /* Explicitly-set fields still round-trip honestly. */
    const set = rx('x', 's', { markdownOnly: true, placement: [2, 5] });
    const d2 = regexDraftOf(set);
    assert.equal(d2.markdownOnly, true);
    assert.deepEqual([...d2.placement], [2, 5]);
});
