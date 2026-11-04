/**
 * uberge-generate —— kernel 插件:服务端全组装生成面(TASK-007 首迁 POST)。
 *
 * POST /generate  全组装 → runLukerDispatch(与 chat-completions 同派发路径)
 * POST /preview   干跑组装,回 messages+trace+sources+perf(prompt viewer 数据源)
 *
 * handler 原样搬自 endpoints/uberge-generate.js;path 补全 /api/uberge 前缀,
 * 注册进 webServer pattern 表。request.body 由上游 express.json() 就位
 * (dispatcher 挂在全部路由中间件之后、legacy 挂载之前)。
 */
import { buildGenerationContext, logPerfLine } from '../services/generate-context.js';
import { selectChatCompletionDispatch } from '../endpoints/backends/chat-completions.js';
import { runLukerDispatch } from '../luker-dispatch/runner.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getPromptNames, postProcessPrompt } from '../prompt-converters.js';
import { flattenSchema } from '../util.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const inject = ['webServer'];

/** 角色卡加载:avatar 目录名 → 卡数据(data.* + name)。read() 返回 JSON 字符串 */
async function loadCharacterCard(directories, charDir) {
    const dir = directories.characters;
    const pngPath = path.join(dir, `${charDir}.png`);
    const jsonPath = path.join(dir, `${charDir}.json`);
    try {
        const raw = await fs.readFile(pngPath);
        const dataString = readCharacterCard(raw);
        return JSON.parse(dataString);
    } catch {
        const raw = await fs.readFile(jsonPath, 'utf8').catch(() => null);
        return raw ? JSON.parse(raw) : null;
    }
}

/**
 * presetDoc → chat-completions 派发 body 参数段(透传生成参数,
 * 与前端发往 /generate 的 oai_settings 子集同构)。
 */
function presetToDispatchParams(presetDoc, { includeConnection = false } = {}) {
    const d = presetDoc ?? {};
    const passthrough = {};
    for (const [k, v] of Object.entries(d)) {
        if (['prompts', 'prompt_order', 'extensions'].includes(k)) continue;
        if (!includeConnection && CONNECTION_KEYS.has(k)) continue;
        passthrough[k] = v;
    }
    return passthrough;
}

/**
 * 连接层字段:URL/密钥代理/模型名/自定义进出体 + source。
 * 这些产品语义上属"当前连接配置"而非"生成预设"——ST 选预设会整体重写
 * oai_settings(连 URL 一起洗掉是出名的坑),我们把连接面固定在
 * settings.oai_settings,preset 只贡献生成参数。
 */
const CONNECTION_KEYS = new Set([
    'chat_completion_source', 'reverse_proxy', 'proxy_password',
    'custom_url', 'custom_model', 'custom_include_body',
    'custom_exclude_body', 'custom_include_headers',
    'chat_completion_custom_models', 'show_external_models',
    'kimi_partial_name_source',
    'openrouter_group_models', 'openrouter_sort_models',
    'chutes_sort_models', 'electronhub_sort_models', 'electronhub_group_models',
]);

export function apply(ctx) {
    const reg = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));

    reg('/api/uberge/generate', async function (request, response) {
        try {
            const body = request.body ?? {};
            const charDir = String(body.charDir ?? '');
            const chatName = String(body.chatName ?? '');
            if (!charDir || !chatName) {
                return response.status(400).send({ error: 'charDir and chatName are required' });
            }

            const directories = request.user.directories;
            const cardStart = performance.now();
            const card = await loadCharacterCard(directories, charDir);
            const cardMs = performance.now() - cardStart;
            if (!card) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }

            const { builtPrompt, presetDoc, oaiSettings, trace, perf } = await buildGenerationContext({
                request,
                charDir,
                chatName,
                card,
                presetName: body.presetName,
                user: body.user ?? { name: request.user.profile.name },
                type: body.type ?? 'normal',
                overrides: body.overrides ?? {},
            });
            perf.cardMs = cardMs;
            perf.totalMs += cardMs;
            logPerfLine('uberge/generate', perf, { charDir, chatName });

            // 派发体 = 连接层 oai_settings(custom_url/reverse_proxy/source 等)
            //  ← 预设生成参数覆盖(ST 选预设=重写 oai_settings)← 调用方显式字段
            const dispatchBody = {
                ...presetToDispatchParams(oaiSettings, { includeConnection: true }),
                ...presetToDispatchParams(presetDoc),
                chat_completion_source: body.chat_completion_source
                    ?? oaiSettings?.chat_completion_source
                    ?? presetDoc?.chat_completion_source ?? 'openai',
                messages: builtPrompt.messages,
                stream: body.stream !== false,
                // 客户端可传 job_id(回放对齐);persist_target 兜底按本次 char/chat 填
                luker_generation: {
                    ...(body.luker_generation ?? {}),
                    persist_target: body.luker_generation?.persist_target ?? {
                        kind: 'character',
                        avatar_url: `${charDir}.png`,
                        file_name: `${chatName}.jsonl`,
                    },
                },
            };
            if (body.generation_overrides) Object.assign(dispatchBody, body.generation_overrides);

            // 与 /generate 原版派发前处理同序(chat-completions.js:1161-1172)
            if (Array.isArray(dispatchBody.messages) && dispatchBody.custom_prompt_post_processing) {
                dispatchBody.messages = postProcessPrompt(
                    dispatchBody.messages,
                    dispatchBody.custom_prompt_post_processing,
                    getPromptNames(request));
            }
            if (dispatchBody.json_schema?.value) {
                dispatchBody.json_schema.value = flattenSchema(dispatchBody.json_schema.value, dispatchBody.chat_completion_source);
            }

            request.body = dispatchBody;
            request.ubergeTrace = trace; // 诊断面挂点(request inspector 可摘)
            // /generate 响应体是 runner 立即 flush 的 {}(真实结果走 job 事件/WS),
            // perf 挂响应头——需在 runLukerDispatch 的 response.json() 之前 set。
            response.setHeader('x-uberge-perf', JSON.stringify(perf));

            return runLukerDispatch(request, response, {
                endpoint: 'uberge-generate',
                select: (b) => selectChatCompletionDispatch(b),
            });
        } catch (error) {
            console.error('uberge/generate failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    /** POST /preview —— 干跑组装,只回 messages+trace+sources+perf(prompt viewer 数据源) */
    reg('/api/uberge/preview', async function (request, response) {
        try {
            const body = request.body ?? {};
            const charDir = String(body.charDir ?? '');
            const chatName = String(body.chatName ?? '');
            if (!charDir || !chatName) {
                return response.status(400).send({ error: 'charDir and chatName are required' });
            }
            const directories = request.user.directories;
            const cardStart = performance.now();
            const card = await loadCharacterCard(directories, charDir);
            const cardMs = performance.now() - cardStart;
            if (!card) {
                return response.status(404).send({ error: `Character not found: ${charDir}` });
            }
            const { builtPrompt, trace, sources, perf } = await buildGenerationContext({
                request,
                charDir,
                chatName,
                card,
                presetName: body.presetName,
                user: body.user ?? { name: request.user.profile.name },
                type: body.type ?? 'normal',
                overrides: body.overrides ?? {},
            });
            perf.cardMs = cardMs;
            perf.totalMs += cardMs;
            logPerfLine('uberge/preview', perf, { charDir, chatName });
            return response.send({ messages: builtPrompt.messages, trace, sources, perf });
        } catch (error) {
            console.error('uberge/preview failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });
}
