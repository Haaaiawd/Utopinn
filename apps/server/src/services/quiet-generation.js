/**
 * quiet-generation —— /gen(generateQuiet seam)与 CardApp 辅助生成的
 * 服务端执行面(TASK-046 段3a)。
 *
 * 语义:与 POST /api/utopinn/generate 的 type:'quiet' 同链——
 * buildGenerationContext(skipWIAN) → presetToDispatchParams →
 * runLukerDispatch(合成 req/res)→ job 终态 → ack → 返回文本。
 * 诊断:request.utopinnDiagId 认亲 → 组装 inject 事件 + job_running/
 * job_awaiting_ack/job_completed 全部入 diag-bus,'/gen 无产出'
 * 不再是无声失败。
 *
 * persist_target 恒 {kind:'none'} —— 辅助生成不落地楼层;
 * 调用方(STscript /gen 或 CardApp)拿到文本自行决定用途。
 */
import { randomUUID } from 'node:crypto';
import { buildGenerationContext, logPerfLine } from './generate-context.js';
import { emit as diagEmit } from './diag-bus.js';

// 端点侧模块(chat-completions/luker-generation/runner/utopinn-generate)顶层
// 会触 secrets.js 的 getConfigValue —— 任何 import stscript-env 的进程(含
// 单测)都被拖进 config 依赖。延迟到真正跑生成时再动态载入。
async function loadDispatchLayer() {
    const [gen, cc, runner, jobs, conv] = await Promise.all([
        import('../plugins/utopinn-generate.js'),
        import('../endpoints/backends/chat-completions.js'),
        import('../luker-dispatch/runner.js'),
        import('../endpoints/backends/luker-generation.js'),
        import('../prompt-converters.js'),
    ]);
    return {
        presetToDispatchParams: gen.presetToDispatchParams,
        selectChatCompletionDispatch: cc.selectChatCompletionDispatch,
        runLukerDispatch: runner.runLukerDispatch,
        getTaskByRequestId: jobs.getTaskByRequestId,
        acknowledgeGenerationJobsForRequest: jobs.acknowledgeGenerationJobsForRequest,
        createGenerationJob: jobs.createGenerationJob,
        failGenerationJob: jobs.failGenerationJob,
        getPromptNames: conv.getPromptNames,
        postProcessPrompt: conv.postProcessPrompt,
    };
}

const TERMINAL = new Set(['awaiting_ack', 'completed', 'failed', 'cancelled']);

/** /gen params.trimToSentence / params.stop 的本地后裁剪(上游同款)。 */
function trimGenerated(text, { trimToSentence = false, stop } = {}) {
    let out = String(text ?? '');
    const stops = Array.isArray(stop) ? stop : (stop ? [stop] : []);
    for (const s of stops) {
        const at = out.indexOf(String(s));
        if (at >= 0) out = out.slice(0, at);
    }
    if (trimToSentence) {
        const m = out.match(/[\s\S]*[.!?。!?\n]/);
        if (m) out = m[0];
    }
    return out.trim();
}

function makeSyntheticResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        json(b) { this.body = b; return this; },
        send(b) { this.body = b; return this; },
        end() { return this; },
    };
}

/**
 * @param {object} input
 * @param {string} input.handle user handle(job owner + repos)
 * @param {object} input.directories user directory snapshot
 * @param {string} input.charDir character dir (no .png)
 * @param {string} [input.chatName] chat name (no .jsonl) — prompt 上下文源
 * @param {object} input.card loaded card doc (stscript-env 已 load 的可复用)
 * @param {string} input.prompt quietPrompt 正文
 * @param {object} [input.params] /gen named-args {responseLength, trimToSentence, stop, quietToLoud, quietName,
 *   lorebookEntries(GH#9 th.generate 选择性 WI 注入——显式圈定本轮注入条目,
 *   ref 形见 generate-context.js resolveLorebookEntryRefs;persist_target 仍恒 none)}
 * @param {string} [input.userName] persona name(macro name1)
 * @param {number} [input.timeoutMs] job 等待上限(默认 180s)
 * @returns {Promise<{text:string, jobId:string, status:string, diagId:string}>}
 */
export async function runQuietGeneration({
    handle,
    directories,
    charDir,
    chatName,
    card,
    prompt,
    params = {},
    userName = 'User',
    timeoutMs = 180_000,
}) {
    if (!charDir) throw new Error('quiet generation requires a bound character (charDir)');
    // 组装面必须有 chat 上下文(楼层/WI/注入都挂在 chat 上)——prompt-only
    // 无 chat 的 quiet 生成暂未支持,诚实失败而不是给出空上下文拼装。
    if (!chatName) throw new Error('quiet generation requires a bound chat (chatName)');
    const diagId = randomUUID();
    const jobId = randomUUID();
    // 合成 request:runLukerDispatch/createGenerationJob/buildGenerationContext
    // 消费的表面 = user.profile.handle + user.directories + utopinnDiagId +
    // once('close')(opt-in 钩子,空实现)+ body(派发体在 dispatch 前回填)。
    const request = {
        method: 'POST',
        url: '/internal/quiet-generate',
        headers: {},
        user: { profile: { handle, name: userName }, directories },
        utopinnDiagId: diagId,
        once() { return this; },
        // 先置动词:派发体在 dispatch 前整体回填覆盖;组装失败路径上
        // createGenerationJob 读 request.body.type 落 job.requestMeta.verb,
        // 让台账里失败 job 也挂 'quiet' 而不是空串。
        body: { type: 'quiet' },
    };
    diagEmit({
        lvl: 'info', kind: 'generate', code: 'quiet_submit',
        msg: `quiet gen ${charDir}/${chatName ?? '-'} job=${jobId.slice(0, 8)}`,
        ctx: { charDir, chatId: chatName, verb: 'quiet', diagId },
        // quietToLoud/quietName 目前仅记录未实现(as=char 楼层回写与
        // 异角色预设解析留空)——diag 里不装死,验收面可见。
        data: {
            quietToLoud: !!params.quietToLoud,
            quietName: params.quietName ?? null,
        },
    });

    const {
        presetToDispatchParams, selectChatCompletionDispatch, runLukerDispatch,
        getTaskByRequestId, acknowledgeGenerationJobsForRequest,
        createGenerationJob, failGenerationJob,
        getPromptNames, postProcessPrompt,
    } = await loadDispatchLayer();

    let builtPrompt, presetDoc, oaiSettings, trace, sources, perf;
    try {
        ({ builtPrompt, presetDoc, oaiSettings, trace, sources, perf } = await buildGenerationContext({
            request,
            charDir,
            chatName,
            card,
            user: { name: userName },
            type: 'quiet',
            // 上游 generateQuietPrompt:quiet 任务不进 WI/AN(skipWIAN),
            // quietPrompt 作独立 system 注入(assemble.ts quietPrompt 位)。
            // GH#9 lorebookEntries:显式圈定的条目例外(选择性 WI 注入,
            // skipWIAN 不抹它;ref 全部未命中 → 抛 lorebook_entries_unresolved)。
            overrides: {
                quietPrompt: String(prompt ?? ''),
                skipWIAN: true,
                ...(params.lorebookEntries !== undefined ? { lorebookEntries: params.lorebookEntries } : {}),
            },
            mainApi: 'openai',
        }));
    } catch (assembleError) {
        // B5:组装失败(assemble_failed,如 Token budget exceeded)也要给
        // 调用方留终态——登记 failed job(jobs 台账可查)再抛原异常;
        // 否则 quiet_submit 之后再无下文,/jobs 里查无此任务。
        const reason = String(assembleError?.message ?? assembleError ?? 'assemble failed');
        try {
            const failedJob = createGenerationJob(request, {
                job_id: jobId,
                persist_target: { kind: 'none' },
            });
            if (failedJob) {
                failGenerationJob(failedJob, `quiet generation assemble failed: ${reason}`);
            }
        } catch { /* 台账登记失败不掩盖原始异常 */ }
        diagEmit({
            lvl: 'warn', kind: 'generate', code: 'quiet_terminal',
            msg: `quiet gen ${charDir}/${chatName ?? '-'} failed: ${reason.slice(0, 200)}`,
            ctx: { charDir, chatId: chatName, verb: 'quiet', diagId },
            data: { jobId, stage: 'assemble' },
        });
        throw assembleError;
    }
    request.utopinnPerf = perf;
    logPerfLine('utopinn/quiet-generate', perf, { charDir, chatName: chatName ?? '-' });

    const chatSource = oaiSettings?.chat_completion_source
        ?? presetDoc?.chat_completion_source ?? 'openai';
    const dispatchBody = {
        ...presetToDispatchParams(oaiSettings, { includeConnection: true }),
        ...presetToDispatchParams(presetDoc),
        chat_completion_source: chatSource,
        type: 'quiet',
        messages: builtPrompt.messages,
        stream: false,
        luker_generation: {
            job_id: jobId,
            persist_target: { kind: 'none' },
        },
    };
    dispatchBody.model ??= dispatchBody[`${chatSource}_model`] ?? null;
    dispatchBody.max_tokens ??= dispatchBody.openai_max_tokens ?? null;
    // /gen length=N → 响应长度上限(上游同键映射)
    const responseLength = Number(params.responseLength ?? 0) || 0;
    if (responseLength > 0) dispatchBody.max_tokens = responseLength;
    if (Array.isArray(dispatchBody.messages) && dispatchBody.custom_prompt_post_processing) {
        dispatchBody.messages = postProcessPrompt(
            dispatchBody.messages,
            dispatchBody.custom_prompt_post_processing,
            getPromptNames(request));
    }
    request.body = dispatchBody;
    request.utopinnTrace = trace;
    request.utopinnSources = sources;

    // GH#9 lorebookEntries 回执:圈定命中/未命中明细 + 实际激活条目。
    // 成功路径挂返回,失败路径挂 error.lorebook——部分未命中撞上后端
    // 事故时,未命中名单不该跟着事故一起吞掉(调用方只见 502 就查不
    // 到「GhostBook 写错了」这层)。
    const lorebookReceipt = sources?.worldInfo?.selective
        ? { ...sources.worldInfo.selective, activated: sources.worldInfo.activated ?? [] }
        : null;

    try {
        const response = makeSyntheticResponse();
        await runLukerDispatch(request, response, {
            endpoint: 'utopinn-quiet-generate',
            select: (b) => selectChatCompletionDispatch(b),
        });
        if (response.statusCode !== 200) {
            throw new Error(`quiet generation dispatch rejected: ${JSON.stringify(response.body ?? response.statusCode)}`);
        }

        // 终态等待:poll getTaskByRequestId(同 jobGet REST 面语义)。
        const deadline = Date.now() + timeoutMs;
        let job = null;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 600));
            try { job = getTaskByRequestId(jobId, handle); } catch { job = null; }
            if (job && TERMINAL.has(String(job.status))) break;
        }
        if (!job) {
            throw new Error(`quiet generation job lost: ${jobId}`);
        }
        if (!TERMINAL.has(String(job.status))) {
            throw new Error(`quiet generation timeout after ${timeoutMs}ms (status=${job.status})`);
        }
        // ack → completed(kind:'none' 无楼层可落,ack 即终态语义)
        acknowledgeGenerationJobsForRequest(request, [jobId]);
        const status = String(job.status);
        if (status === 'failed' || status === 'cancelled') {
            diagEmit({
                lvl: 'warn', kind: 'generate', code: 'quiet_terminal',
                msg: `quiet gen ${charDir}/${chatName ?? '-'} ${status}: ${String(job.error ?? '').slice(0, 200)}`,
                ctx: { charDir, chatId: chatName, verb: 'quiet', diagId },
            });
            throw new Error(job.error || `quiet generation ${status}`);
        }
        const text = trimGenerated(job.text ?? '', params);
        diagEmit({
            lvl: 'info', kind: 'generate', code: 'quiet_terminal',
            msg: `quiet gen ${charDir}/${chatName ?? '-'} ${status} ${text.length}ch`,
            ctx: { charDir, chatId: chatName, verb: 'quiet', diagId },
            data: { jobId, chars: text.length },
        });
        return {
            text, jobId, status: 'completed', diagId,
            ...(lorebookReceipt ? { lorebook: lorebookReceipt } : {}),
        };
    } catch (error) {
        if (lorebookReceipt?.unresolved?.length) error.lorebook = lorebookReceipt;
        throw error;
    }
}
