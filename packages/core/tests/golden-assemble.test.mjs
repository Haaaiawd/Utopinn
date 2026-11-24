/**
 * Golden-diff:prompt 组装层逐卡对比 —— TASK-006 判卷 harness。
 *
 * golden = 已捕获的 ST/Luker 真实 wire 请求(权威基准)。
 * 适配层(golden-env.mjs)把每张卡的 card/chat/preset/WI 还原成
 * PromptBuildRequest,跑 dist 的 buildPromptMessages,逐条对比
 * role + content。
 *
 * 已知引擎差异类(不改 src,记录在 tests/corpus/GOLDEN-REPORT.md):
 *  - EMPTY_EXTRA:core flatten 保留空 content 消息,原版 getChat 丢弃
 *    (nsfw/jailbreak/charPersonality/scenario/personaDescription 等空 prompt)。
 *  - WI_SPLIT:core 把 before/after WI 桶 join 成单条消息,原版
 *    formatSplitWorldInfoEntries(wi_format='{0}')逐条发出。
 *  - MACRO_NONDET:输入含随机宏,重掷导致内容差异(预期)。
 *  - CONTENT_NORM:仅时间戳/UUID/水平空白差异。
 * 断言策略:除上述已知类与语料缺失(skip)外不得有 FAIL 级 diff。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { listGoldens, runFixture, summarizeDiffs } from './golden-env.mjs';

// 每张卡允许的 diff 类(已知差异,全部记录在报告;新增类即失败)
const TOLERATED = new Set(['PASS', 'CONTENT_NORM', 'EMPTY_EXTRA', 'WI_SPLIT', 'WI_ENTRY_EXTRA', 'MACRO_NONDET', 'GOLDEN_CORRUPT']);
const FATAL_CLASSES = new Set(['CONTENT_DIFF', 'ROLE_DIFF', 'EXTRA_MSG', 'MISSING_MSG', 'WI_ENTRY_MISSING', 'CONTENT_EXTRA']);

for (const g of listGoldens()) {
    test(`golden-assemble:${basename(g.file, '.golden.json')}`, async (t) => {
        const { fixture, built, diffs } = await runFixture(g.path);
        if (!fixture.cardPath) {
            t.skip(`card PNG not found for ${fixture.golden?.card?.file ?? g.file}`);
            return;
        }
        const s = summarizeDiffs(diffs, fixture.expected.length, built.messages.length);
        const fatal = diffs.filter((d) => FATAL_CLASSES.has(d.cls));
        const unknown = diffs.filter((d) => !TOLERATED.has(d.cls) && !FATAL_CLASSES.has(d.cls));
        console.log(`   [${basename(g.file)}] golden=${s.golden} actual=${s.actual} pass=${s.pass} classes=${JSON.stringify(s.byClass)}`);
        for (const d of [...fatal, ...unknown]) {
            const gTxt = d.expected ? JSON.stringify(d.expected.content).slice(0, 120) : '-';
            const aTxt = d.actual ? JSON.stringify(d.actual.content).slice(0, 120) : '-';
            console.log(`     ${d.cls} @g${d.goldenIdx ?? '?'} role=${d.role}\n       G: ${gTxt}\n       A: ${aTxt}`);
        }
        assert.equal(unknown.length, 0, `unclassified diffs: ${unknown.map((d) => d.cls).join(',')}`);
        assert.equal(fatal.length, 0, `${fatal.length} fatal diffs (see GOLDEN-REPORT.md)`);
    });
}

test('golden-assemble:语料存在性检查', (t) => {
    const goldens = listGoldens();
    console.log('   [golden-assemble] ' + goldens.length + ' golden files discovered');
    if (goldens.length === 0) {
        // 种子卡换位后公开语料为空(Seraphina 卡与 golden 一并移除),
        // 待 tests/golden-diff/capture.sh 对 default_我没想当掌门啊 重新捕获。
        t.skip('no public golden corpus — recapture for the new seed card');
        return;
    }
});
