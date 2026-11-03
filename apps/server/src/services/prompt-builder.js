/**
 * promptBuilder seam —— 服务端 Provider。
 * 把 @uberge/core 的 buildPromptMessages 接到服务器真实依赖上:
 * - TokenCounter:复用 endpoints/tokenizers 的 tiktoken 模型族映射,
 *   逐消息口径 = ST fallback 公式(tokensPerMessage + Σencode + name±1),
 *   批量 padding(+3)由 core 的 ChatCompletion.reserveBudget(3) 承担。
 * - depthInjection:getExtensionPrompt(IN_CHAT, depth, sep, role) 的服务端等价物,
 *   由 generate-context 经 extension-prompts.js createDepthInjectionProvider 接线。
 *
 * 入参/出参契约即 packages/core/src/prompt/types.ts 的
 * PromptBuildRequest / BuiltPrompt —— 客户端永远只见 BuiltPrompt。
 *
 * Perf:计时包在 server 包裹层,不动 core 签名。
 * - tokenMs:encoder.encode 累计耗时,AsyncLocalStorage 按 build 作用域归账
 *   (token counter 是模块级单例,ALS 保证并发 build 互不串账)。
 * - collectionMs/populateMs:以"首次 encode"为界——buildPromptMessages 前半段
 *   (preparePrompts/setOpenAIMessages/示例解析)是零 encode 的纯准备,
 *   首个 Message.fromPromptAsync/createManyAsync 计数即进入 populate 段。
 */
import {
    buildPromptMessages,
    setTokenCounter,
    createOpenAITokenCounter,
} from '@uberge/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { createTiktokenTokenizer } from '../tiktoken-adapter.js';

/** @type {AsyncLocalStorage<{tokenMs:number, firstEncodeAt:number}>} */
const buildPerfScope = new AsyncLocalStorage();

/**
 * 包一层 encode 计时:无 build 作用域时零开销直通。
 * @param {{encode:(t:string)=>ArrayLike<number>, decode?:(t:ArrayLike<number>)=>Uint8Array}} encoder
 */
function timedEncoder(encoder) {
    return {
        encode(text) {
            const store = buildPerfScope.getStore();
            if (!store) return encoder.encode(text);
            const t0 = performance.now();
            const out = encoder.encode(text);
            store.tokenMs += performance.now() - t0;
            if (!store.firstEncodeAt) store.firstEncodeAt = t0;
            return out;
        },
        decode: encoder.decode ? (tokens) => encoder.decode(tokens) : undefined,
    };
}

/** 模型→tiktoken 解析(自缓存,不带 endpoints 的 express/config 传递依赖),失败回退 gpt-4o */
const tokenizerCache = new Map();
function resolveTokenizer(model) {
    const key = model || 'gpt-4o';
    if (!tokenizerCache.has(key)) {
        try {
            tokenizerCache.set(key, timedEncoder(createTiktokenTokenizer(key)));
        } catch {
            tokenizerCache.set(key, timedEncoder(createTiktokenTokenizer('gpt-4o')));
        }
    }
    return tokenizerCache.get(key);
}

let boundModel;

/** 绑定全局 TokenCounter(幂等;同 model 跳过) */
export function bindPromptTokenCounter(model) {
    if (boundModel === model) return;
    setTokenCounter(createOpenAITokenCounter((m) => resolveTokenizer(m ?? model)));
    boundModel = model;
}

/**
 * 创建 promptBuilder 实例(ctx.promptBuilder 的候选实现)。
 * @param {{ model?: string, depthInjection?: (depth:number, role:string)=>Promise<string>, warn?:(m:string)=>void }} opts
 * @returns {(req: import('@uberge/core').PromptBuildRequest, deps: import('@uberge/core').AssembleDeps) => Promise<import('@uberge/core').BuiltPrompt>}
 */
export function createPromptBuilder(opts = {}) {
    if (opts.model !== undefined) bindPromptTokenCounter(opts.model);
    return async function promptBuilder(req, deps) {
        if (req.model) bindPromptTokenCounter(req.model);
        const mergedDeps = {
            ...deps,
            depthInjection: deps.depthInjection ?? opts.depthInjection ?? (async () => ''),
            warn: deps.warn ?? opts.warn ?? ((m) => console.warn(m)),
        };
        const perf = { tokenMs: 0, firstEncodeAt: 0 };
        const t0 = performance.now();
        const built = await buildPerfScope.run(perf, () => buildPromptMessages(req, mergedDeps));
        const assembleMs = performance.now() - t0;
        // 首次 encode 前 = collection 构建段;零 encode 的 build 全记 collection。
        const collectionMs = (perf.firstEncodeAt || (t0 + assembleMs)) - t0;
        built.perf = {
            assembleMs,
            collectionMs,
            populateMs: Math.max(0, assembleMs - collectionMs),
            tokenMs: perf.tokenMs,
        };
        return built;
    };
}
