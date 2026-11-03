/**
 * OpenAI 消息 token 计数 —— 移植 ST 服务端 /api/tokenizers/openai/count 公式:
 *   每条 +tokensPerMessage(3;gpt-3.5-turbo-0301 为4)
 *   每个字段值 +encode(value).length;key==='name' 时 +tokensPerName(1;0301 为-1)
 *   末尾 +3 padding;0301 再 +9
 * 客户端面:countTokensOpenAIAsync = totalRaw - (full ? 1 : 3);
 *   单条成本(本模块 count) = raw(单条) - 1 = 3 + Σencode + name±1 + 3 - 1。
 * encoder 由调用方注入(js-tiktoken 实例或等价),core 不直接依赖具体 tokenizer。
 */
import type { TokenCounter } from './messages.js';

export interface MessageEncoder {
    encode(text: string): ArrayLike<number> | number[];
}

export interface OpenAICountOptions {
    /** 原始 queryModel(决定 0301 特判) */
    model?: string;
}

export function createOpenAITokenCounter(
    encoderFor: (model?: string) => MessageEncoder,
): TokenCounter & { countBatch(messages: { role: string; content: string; name?: string }[]): Promise<number> } {
    return {
        async count(message) {
            const model = undefined;
            const per = openAIRawCount([message], model, encoderFor);
            return per.rawTotal - 1; // full=true
        },
        async countBatch(messages) {
            const model = undefined;
            return openAIRawCount(messages, model, encoderFor).rawTotal - 1;
        },
    };
}

export function openAIRawCount(
    messages: { role: string; content: string; name?: string }[],
    queryModel = '',
    encoderFor: (model?: string) => MessageEncoder,
): { rawTotal: number } {
    const is0301 = queryModel.includes('gpt-3.5-turbo-0301');
    const tokensPerName = is0301 ? -1 : 1;
    const tokensPerMessage = is0301 ? 4 : 3;
    const encoder = encoderFor(queryModel);
    let num = 0;
    for (const msg of messages) {
        num += tokensPerMessage;
        for (const [key, value] of Object.entries(msg)) {
            num += encoder.encode(String(value ?? '')).length;
            if (key === 'name') num += tokensPerName;
        }
    }
    num += 3;
    if (is0301) num += 9;
    return { rawTotal: num };
}
