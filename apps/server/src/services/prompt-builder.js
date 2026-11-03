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
 */
import {
    buildPromptMessages,
    setTokenCounter,
    createOpenAITokenCounter,
} from '@uberge/core';
import { createTiktokenTokenizer } from '../tiktoken-adapter.js';

/** 模型→tiktoken 解析(自缓存,不带 endpoints 的 express/config 传递依赖),失败回退 gpt-4o */
const tokenizerCache = new Map();
function resolveTokenizer(model) {
    const key = model || 'gpt-4o';
    if (!tokenizerCache.has(key)) {
        try {
            tokenizerCache.set(key, createTiktokenTokenizer(key));
        } catch {
            tokenizerCache.set(key, createTiktokenTokenizer('gpt-4o'));
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
        return buildPromptMessages(req, mergedDeps);
    };
}
