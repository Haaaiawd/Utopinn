/**
 * /api/uberge/generate —— 服务端全组装生成端点(TASK-007)。
 *
 * 薄客户端只发 {charDir, chatName, type, prompt?, presetName?, stream?};
 * 服务端完成:chat/card/preset/settings/WI 全量加载 → core promptBuilder
 * → 改写 body 走与 /api/backends/chat-completions/generate 同一条
 * runLukerDispatch + provider dispatch 路径(job/SSE/persist 全部继承)。
 */
import express from 'express';
import { buildGenerationContext } from '../services/generate-context.js';
import { selectChatCompletionDispatch } from './backends/chat-completions.js';
import { runLukerDispatch } from '../luker-dispatch/runner.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getPromptNames, postProcessPrompt } from '../prompt-converters.js';
import { flattenSchema } from '../util.js';
import path from 'node:path';
import fs from 'node:fs/promises';

export const router = express.Router();

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
function presetToDispatchParams(presetDoc) {
    const d = presetDoc ?? {};
    const passthrough = {};
    for (const [k, v] of Object.entries(d)) {
        if (['prompts', 'prompt_order', 'extensions'].includes(k)) continue;
        passthrough[k] = v;
    }
    return passthrough;
}

router.post('/generate', async function (request, response) {
    try {
        const body = request.body ?? {};
        const charDir = String(body.charDir ?? '');
        const chatName = String(body.chatName ?? '');
        if (!charDir || !chatName) {
            return response.status(400).send({ error: 'charDir and chatName are required' });
        }

        const directories = request.user.directories;
        const card = await loadCharacterCard(directories, charDir);
        if (!card) {
            return response.status(404).send({ error: `Character not found: ${charDir}` });
        }

        const { builtPrompt, presetDoc, trace } = await buildGenerationContext({
            request,
            charDir,
            chatName,
            card,
            presetName: body.presetName,
            user: body.user ?? { name: request.user.profile.name },
            type: body.type ?? 'normal',
            overrides: body.overrides ?? {},
        });

        // 派发体 = 预设生成参数 + 组装好的 messages + 生成控制字段
        const dispatchBody = {
            ...presetToDispatchParams(presetDoc),
            chat_completion_source: body.chat_completion_source ?? presetDoc?.chat_completion_source ?? 'openai',
            messages: builtPrompt.messages,
            stream: body.stream !== false,
            luker_generation: body.luker_generation ?? {
                persist_target: {
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

        return runLukerDispatch(request, response, {
            endpoint: 'uberge-generate',
            select: (b) => selectChatCompletionDispatch(b),
        });
    } catch (error) {
        console.error('uberge/generate failed:', error);
        return response.status(500).send({ error: String(error?.message ?? error) });
    }
});

/** GET /api/uberge/generate/preview —— 干跑组装,只回 messages+trace(prompt viewer 数据源) */
router.post('/preview', async function (request, response) {
    try {
        const body = request.body ?? {};
        const charDir = String(body.charDir ?? '');
        const chatName = String(body.chatName ?? '');
        if (!charDir || !chatName) {
            return response.status(400).send({ error: 'charDir and chatName are required' });
        }
        const directories = request.user.directories;
        const card = await loadCharacterCard(directories, charDir);
        if (!card) {
            return response.status(404).send({ error: `Character not found: ${charDir}` });
        }
        const { builtPrompt, trace, sources } = await buildGenerationContext({
            request,
            charDir,
            chatName,
            card,
            presetName: body.presetName,
            user: body.user ?? { name: request.user.profile.name },
            type: body.type ?? 'normal',
            overrides: body.overrides ?? {},
        });
        return response.send({ messages: builtPrompt.messages, trace, sources });
    } catch (error) {
        console.error('uberge/preview failed:', error);
        return response.status(500).send({ error: String(error?.message ?? error) });
    }
});
