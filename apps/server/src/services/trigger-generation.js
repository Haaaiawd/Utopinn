/**
 * trigger-generation —— /trigger(triggerGeneration seam)与 /swipe
 * 越界重生(generateSwipe seam)的服务端实弹派发面(TASK-069)。
 *
 * 语义 = 上游 Generate('normal'|'swipe'):非 quiet——组装含 WI/AN,
 * persist_target 落 character,生成产物成「新楼层」(normal)或
 * 「末楼新 swipe 槽」(swipe,persistGeneratedSwipe 并楼)。
 * 与 quiet-generation 同链(buildGenerationContext → presetToDispatchParams
 * → runLukerDispatch 合成 req/res → job 终态),差别在落地段:
 *   quiet   :persist_target=none,ack 即终,文本回给调用方;
 *   trigger :无客户端写盘——ack(客户端职责占位)后服务端
 *            persistJobReplyText 落楼层,等价于「客户端立即写盘+ack」。
 *
 * TH 事件:生命周期经 recordThEvent(utopinn-th)进信箱——
 *   generation_requested {type,via} → generation_started [type]
 *   → generation_ended [text] + message_received|message_swiped [floorIndex]
 *   失败/超时 → generation_stopped [err]。卡内 eventOn 订阅经宿主
 *   getEventLog 泵收到(ctxHost/CLI 既有链)。
 *
 * member 参数(/trigger <member>):上游 selected_group && value 才读 —
 *   单聊 env 恒无群绑定,参数接受但忽略(与上游单聊语义对齐),
 *   提供了就记 diag 不静默。群 env 绑定留待群脚本宿主接入。
 */
import { randomUUID } from 'node:crypto';

import { consumeEphemeralScriptInjects } from '@utopinn/core';
import { getChatRepo } from '../storage/index.js';
import { emit as diagEmit } from './diag-bus.js';
import {
    buildGenerationContext,
    logPerfLine,
    persistWorldInfoTimedEffects,
} from './generate-context.js';
import {
    loadDispatchLayer,
    makeSyntheticResponse,
    TERMINAL,
} from './quiet-generation.js';
import { flattenSchema } from '../util.js';

/** 信箱事件失败不掩生成主结果(recordThEvent 内部亦容错,双保险)。 */
async function emitTh(thCtx, event, args) {
    try {
        const { recordThEvent } = await import('../plugins/utopinn-th.js');
        await recordThEvent(thCtx, event, args);
    } catch { /* 观测面绝不炸生成链 */ }
}

/**
 * @param {object} input
 * @param {string} input.handle job owner + repos
 * @param {object} input.directories user directory snapshot
 * @param {string} input.charDir character dir(no .png)
 * @param {string} input.chatName chat name(no .jsonl)
 * @param {object} input.card loaded card doc
 * @param {string} [input.member] /trigger 位置参数 — 群成员定位值;单聊忽略
 * @param {'normal'|'swipe'} [input.type] 生成动词
 * @param {string} [input.userName] persona name(macro name1)
 * @param {Array}  [input.chat] env macro.chat 活数组 —— persist 后同步内存
 *   (上游 Generate 后 chat[] 即含新楼,后续命令 {{lastMessage}} 等可见)
 * @param {number} [input.timeoutMs] job 等待上限(默认 180s)
 * @returns {Promise<{jobId:string,status:string,text:string,floorIndex:number|null,persisted:boolean,diagId:string}>}
 */
export async function runTriggerGeneration({
    handle,
    directories,
    charDir,
    chatName,
    card,
    member,
    type = 'normal',
    userName = 'User',
    chat = null,
    timeoutMs = 180_000,
}) {
    if (!charDir || !chatName) {
        throw new Error('trigger generation requires a bound character + chat (charDir/chatName)');
    }
    if (type !== 'normal' && type !== 'swipe') {
        throw new Error('trigger generation type must be normal|swipe (got: ' + String(type) + ')');
    }
    const diagId = randomUUID();
    const jobId = randomUUID();
    const thCtx = { handle, charDir, chatName };
    /**
     * Luker consumeEphemeralScriptInjectsForMainGeneration(script.js
     * hideStopButton 同点):非 quiet 生成生命周期结束 —— 终态/失败/停止
     * 同口径 —— 清除 ephemeral inject。chatMetadata 为 buildGenerationContext
     * 读到的活对象;assemble 早夭时回落新取。失败仅告警不掩生成结果。
     */
    const consumeEphemerals = async () => {
        try {
            const md = chatMetadata
                ?? await getChatRepo().get(handle, charDir, chatName).then(d => d?.header?.chat_metadata).catch(() => null);
            if (md && consumeEphemeralScriptInjects(md) > 0) {
                await getChatRepo().updateChatMetadata(handle, charDir, chatName, { script_injects: md.script_injects });
            }
        } catch (e) {
            console.warn('trigger-generate ephemeral injects cleanup failed:', e?.message);
        }
    };
    const request = {
        method: 'POST',
        url: '/internal/trigger-generate',
        headers: {},
        user: { profile: { handle, name: userName }, directories },
        utopinnDiagId: diagId,
        once() { return this; },
        // dispatch 前回填整包;verb 预置保证 assemble 失败也能落台账。
        body: { type },
    };
    diagEmit({
        lvl: 'info', kind: 'generate', code: 'trigger_submit',
        msg: 'trigger gen ' + charDir + '/' + chatName + ' type=' + type + ' job=' + jobId.slice(0, 8),
        ctx: { charDir, chatId: chatName, verb: type, diagId },
    });
    await emitTh(thCtx, 'generation_requested', [{ type, via: 'stscript.trigger' }]);

    // 上游:selected_group && value —— member 仅在群语境消费;单聊
    // 环境(本 seam 唯一可达语境)忽略。记 diag 不静默吞参数。
    if (member !== undefined && member !== null && String(member).trim() !== '') {
        diagEmit({
            lvl: 'info', kind: 'generate', code: 'trigger_member_ignored',
            msg: '/trigger member "' + String(member).slice(0, 60) + '" ignored — single-chat context',
            ctx: { charDir, chatId: chatName, verb: type, diagId },
            data: { member: String(member) },
        });
    }

    const {
        presetToDispatchParams, selectChatCompletionDispatch, runLukerDispatch,
        getTaskByRequestId, acknowledgeGenerationJobsForRequest,
        createGenerationJob, failGenerationJob, persistJobReplyText,
        getPromptNames, postProcessPrompt,
    } = await loadDispatchLayer();

    const persistTarget = {
        kind: 'character',
        avatar_url: charDir + '.png',
        file_name: chatName + '.jsonl',
    };

    let builtPrompt, presetDoc, oaiSettings, trace, sources, perf, chatMetadata, chatIntegrity;
    try {
        ({ builtPrompt, presetDoc, oaiSettings, trace, sources, perf, chatMetadata, chatIntegrity } =
            await buildGenerationContext({
                request,
                charDir,
                chatName,
                card,
                user: { name: userName },
                type,
                mainApi: 'openai',
            }));
    } catch (assembleError) {
        const reason = String(assembleError?.message ?? assembleError ?? 'assemble failed');
        try {
            const failedJob = createGenerationJob(request, { job_id: jobId, persist_target: persistTarget });
            if (failedJob) failGenerationJob(failedJob, 'trigger generation assemble failed: ' + reason);
        } catch { /* 台账登记失败不掩盖原始异常 */ }
        await emitTh(thCtx, 'generation_stopped', [reason.slice(0, 300)]);
        await consumeEphemerals();
        throw assembleError;
    }
    request.utopinnPerf = perf;
    logPerfLine('utopinn/trigger-generate', perf, { charDir, chatName });

    // WI timed effects 写回 —— 与 /api/utopinn/generate 同位序(派发前,
    // 锚定生成前楼层计数);失败不阻断,下个周期自愈。
    try {
        await persistWorldInfoTimedEffects({
            request, charDir, chatName, chatMetadata,
            expectedIntegrity: chatIntegrity,
            groupChatId: null,
        });
        request.utopinnTimedWorldInfo = chatMetadata?.timedWorldInfo ?? null;
    } catch (persistErr) {
        console.warn('utopinn/trigger-generate timedWorldInfo persist skipped:', persistErr?.message);
    }

    const chatSource = oaiSettings?.chat_completion_source
        ?? presetDoc?.chat_completion_source ?? 'openai';
    const dispatchBody = {
        ...presetToDispatchParams(oaiSettings, { includeConnection: true }),
        ...presetToDispatchParams(presetDoc),
        chat_completion_source: chatSource,
        type,
        messages: builtPrompt.messages,
        // 服务端触发面不做流式 —— 等终态拿全量再 persist,与 quiet 同。
        stream: false,
        luker_generation: { job_id: jobId, persist_target: persistTarget },
    };
    const connModel = oaiSettings?.[chatSource + '_model'];
    dispatchBody.model ??= (typeof connModel === 'string' && connModel.trim() ? connModel.trim() : null)
        ?? dispatchBody[chatSource + '_model'] ?? null;
    dispatchBody.max_tokens ??= dispatchBody.openai_max_tokens ?? null;
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
    request.utopinnTrace = trace;
    request.utopinnSources = sources;

    try {
        const response = makeSyntheticResponse();
        await emitTh(thCtx, 'generation_started', [type]);
        await runLukerDispatch(request, response, {
            endpoint: 'utopinn-trigger-generate',
            select: (b) => selectChatCompletionDispatch(b),
        });
        if (response.statusCode !== 200) {
            throw new Error('trigger generation dispatch rejected: ' + JSON.stringify(response.body ?? response.statusCode));
        }

        const deadline = Date.now() + timeoutMs;
        let job = null;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 600));
            try { job = getTaskByRequestId(jobId, handle); } catch { job = null; }
            if (job && TERMINAL.has(String(job.status))) break;
        }
        if (!job) {
            throw new Error('trigger generation job lost: ' + jobId);
        }
        if (!TERMINAL.has(String(job.status))) {
            throw new Error('trigger generation timeout after ' + timeoutMs + 'ms (status=' + job.status + ')');
        }
        const status = String(job.status);
        if (status === 'failed' || status === 'cancelled') {
            const errText = String(job.error || 'trigger generation ' + status);
            await emitTh(thCtx, 'generation_stopped', [errText.slice(0, 300)]);
            throw new Error(errText);
        }

        // 无客户端写盘:ack(终态语义)后服务端兜底 persist —— 与
        // persistGenerationJobIfUnacked 同写面,但即时落不等 15s 宽限。
        // ack 先行:job → completed + 宽限计时器摘除;persist 失败再把
        // job 显式翻 failed(诚实台账,不装 completed)。
        acknowledgeGenerationJobsForRequest(request, [jobId]);
        let persisted = false;
        try {
            persisted = await persistJobReplyText(job, job.text, job.id, job.modelName);
        } catch (persistError) {
            job.persisted = false;
            job.status = 'failed';
            job.error = String(persistError?.message ?? persistError ?? 'persist failed').slice(0, 400);
            job.updatedAt = Date.now();
            job.finishedAt = Date.now();
            await emitTh(thCtx, 'generation_stopped', [String(job.error).slice(0, 300)]);
            throw new Error('trigger generation persist failed: ' + job.error);
        }
        job.persisted = Boolean(persisted);
        if (!persisted) {
            job.status = 'failed';
            job.error = 'Generation could not be persisted on server.';
            job.updatedAt = Date.now();
            job.finishedAt = Date.now();
            await emitTh(thCtx, 'generation_stopped', [job.error]);
            throw new Error(job.error);
        }

        // 楼层同步(env macro.chat 活数组 = 上游 chat[] 同语义):
        //   normal → 新楼入尾;swipe → 末楼整栋刷(swipe_id/swipes/mes)。
        const doc = await getChatRepo().get(handle, charDir, chatName).catch(() => null);
        const body = Array.isArray(doc?.body) ? doc.body : null;
        let floorIndex = null;
        if (body?.length) {
            floorIndex = body.length - 1;
            if (type === 'swipe') {
                if (Array.isArray(chat) && floorIndex < chat.length) {
                    chat[floorIndex] = body[floorIndex];
                }
            } else if (Array.isArray(chat) && body.length > chat.length) {
                chat.push(body[floorIndex]);
            }
        }

        const text = String(job.text ?? '');
        await emitTh(thCtx, 'generation_ended', [text]);
        await consumeEphemerals();
        if (floorIndex !== null) {
            await emitTh(thCtx, type === 'swipe' ? 'message_swiped' : 'message_received', [floorIndex]);
            await emitTh(thCtx, 'chat_changed', [{ chat: chatName }]);
        }
        diagEmit({
            lvl: 'info', kind: 'generate', code: 'trigger_terminal',
            msg: 'trigger gen ' + charDir + '/' + chatName + ' ' + job.status + ' ' + text.length + 'ch floor=' + (floorIndex ?? '-'),
            ctx: { charDir, chatId: chatName, verb: type, diagId },
            data: { jobId, floorIndex, persisted: true },
        });
        return { jobId, status: String(job.status), text, floorIndex, persisted: true, diagId };
    } catch (error) {
        diagEmit({
            lvl: 'warn', kind: 'generate', code: 'trigger_terminal',
            msg: 'trigger gen ' + charDir + '/' + chatName + ' failed: ' + String(error?.message ?? error).slice(0, 200),
            ctx: { charDir, chatId: chatName, verb: type, diagId },
            data: { jobId },
        });
        await consumeEphemerals();
        throw error;
    }
}
