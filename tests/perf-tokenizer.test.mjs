/**
 * perf-tokenizer —— WASM tiktoken vs js-tiktoken 一致性 + 速度对比。
 *
 * 语料:tests/golden-diff/golden(|golden-private)/*.golden.json 的
 * wireRequests[].messages[].content —— 真实生成请求的消息文本(长系统块/
 * 示例对话/中文/emoji 混合),按长度降序取 ~20 条。
 *
 * 断言:同一 model 下两 encoder 的 token id 序列逐条全等(golden 一致性前提)。
 * 输出:各自整轮 encode 耗时 + 加速比(console.info,不打表即不影响断言)。
 *
 * 用法:node --test tests/perf-tokenizer.test.mjs(或直接 node 跑)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIRS = [
    join(REPO, 'tests', 'golden-diff', 'golden'),
    join(REPO, 'tests', 'golden-diff', 'golden-private'),
];
const requireFromServer = createRequire(join(REPO, 'apps', 'server', 'package.json'));

/** 与生产路径同一条 require 链(apps/server/src/tiktoken-adapter.js)。 */
const nativeTiktoken = requireFromServer('tiktoken');
const jsTiktoken = requireFromServer('js-tiktoken');

const SAMPLE_SIZE = 20;
const REPEAT = 3; // 每条文本每 encoder 重复轮数(取总耗时)

/** golden 抽真实消息文本:wireRequests[].messages[].content,去重后按长度降序取样。 */
function collectTexts(limit) {
    const texts = new Set();
    for (const dir of GOLDEN_DIRS) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((f) => f.endsWith('.golden.json'))) {
            const golden = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            for (const req of golden.wireRequests ?? []) {
                for (const m of req.messages ?? []) {
                    if (typeof m.content === 'string' && m.content.trim().length) texts.add(m.content);
                }
            }
        }
    }
    return [...texts].sort((a, b) => b.length - a.length).slice(0, limit);
}

const texts = collectTexts(SAMPLE_SIZE);

// o200k_base(gpt-4o/o1 系)+ cl100k_base(gpt-4/gpt-3.5 系)两族各验一遍。
const MODELS = ['gpt-4o', 'gpt-4'];

test(`tiktoken(WASM) vs js-tiktoken:${texts.length} 条真实消息 × ${MODELS.length} 模型族`, { skip: texts.length === 0 }, () => {
    for (const model of MODELS) {
        const native = nativeTiktoken.encoding_for_model(model);
        const js = jsTiktoken.encodingForModel(model);

        // —— 一致性:token id 序列逐条全等(不只是计数)——
        let totalTokens = 0;
        for (const text of texts) {
            const a = Array.from(native.encode(text));
            const b = Array.from(js.encode(text));
            assert.deepEqual(a, b, `model=${model} token ids differ (len=${text.length})`);
            totalTokens += a.length;
        }

        // —— 速度:先热身一轮(BPE 缓存/WASM 实例化不计),再各跑 REPEAT 轮 ——
        for (const text of texts) { native.encode(text); js.encode(text); }
        let t = performance.now();
        for (let i = 0; i < REPEAT; i++) for (const text of texts) native.encode(text);
        const nativeMs = performance.now() - t;
        t = performance.now();
        for (let i = 0; i < REPEAT; i++) for (const text of texts) js.encode(text);
        const jsMs = performance.now() - t;

        const totalChars = texts.reduce((n, s) => n + s.length, 0);
        console.info(
            `[perf-tokenizer] model=${model} enc=${native.name ?? '?'} texts=${texts.length}`
            + ` chars=${totalChars} tokens=${totalTokens}`
            + ` | wasm=${nativeMs.toFixed(1)}ms js=${jsMs.toFixed(1)}ms`
            + ` speedup=${(jsMs / nativeMs).toFixed(2)}x`,
        );
    }
});
