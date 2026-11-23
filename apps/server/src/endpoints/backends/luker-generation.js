// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import path from 'node:path';
import sanitize from 'sanitize-filename';

import { CHAT_COMPLETION_SOURCES } from '../../constants.js';
import { appendMessagesToChatFile, readLastChatGenerationId, writeLastChatGenerationId } from '../chats.js';
import { getConfigValue } from '../../util.js';
import { stripJsonlExt } from '../../storage/name-validation.js';
import { getChatRepo } from '../../storage/index.js';
import { settlePersistedMvuMessage } from '../../services/mvu-settle.js';
import { emit as diagEmit } from '../../services/diag-bus.js';
import { REGEX_PERSISTED_MARK } from '../../services/extension-prompts.js';
import { regex_placement } from '@utopinn/core';

const generationJobs = new Map();
const LUKER_GENERATION_JOB_MAX_ITEMS = 128;
const LUKER_GENERATION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const LUKER_GENERATION_JOB_MAX_EVENTS = 8000;
const LUKER_GENERATION_ACK_GRACE_MS = Math.max(1000, Number(getConfigValue('generationAckGraceMs', 15_000, 'number')) || 15_000);

function normalizePersistJsonlFileName(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw) {
        return '';
    }
    const withExt = path.extname(raw) ? raw : `${raw}.jsonl`;
    return sanitize(path.basename(withExt));
}

function normalizePersistAvatarDirectory(avatarUrl) {
    const raw = String(avatarUrl || '').replace('.png', '').trim();
    if (!raw) {
        return '';
    }
    return sanitize(path.basename(raw));
}

function extractTextFromOpenAIMessageContent(content) {
    return extractTextFromStructuredContent(content);
}

function normalizeGenerationSource(source) {
    return String(source || '').trim().toLowerCase();
}

function isStructuredThinkingPart(part) {
    if (!part || typeof part !== 'object') {
        return false;
    }

    return Boolean(part.thought)
        || part.type === 'thinking'
        || Array.isArray(part.thinking)
        || typeof part.thinking === 'string';
}

function extractTextFromStructuredContent(content, options = {}) {
    const skipThoughts = options.skipThoughts !== false;

    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map(part => extractTextFromStructuredContent(part, { skipThoughts })).join('');
    }

    if (!content || typeof content !== 'object') {
        return '';
    }

    if (skipThoughts && isStructuredThinkingPart(content)) {
        return '';
    }

    if (typeof content.text === 'string') {
        return content.text;
    }

    if (typeof content.content === 'string') {
        return content.content;
    }

    if (Array.isArray(content.content)) {
        return extractTextFromStructuredContent(content.content, { skipThoughts });
    }

    if (content.content && typeof content.content === 'object') {
        return extractTextFromStructuredContent(content.content, { skipThoughts });
    }

    if (Array.isArray(content.text)) {
        return extractTextFromStructuredContent(content.text, { skipThoughts });
    }

    if (Array.isArray(content.message?.content)) {
        return extractTextFromStructuredContent(content.message.content, { skipThoughts });
    }

    return '';
}

function extractTextFromGeminiParts(parts, options = {}) {
    if (!Array.isArray(parts)) {
        return '';
    }

    const joiner = typeof options.joiner === 'string' ? options.joiner : '';
    const nonThoughtText = parts
        .filter(part => !part?.thought)
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .filter(Boolean);

    return nonThoughtText.join(joiner);
}

function extractTextFromStreamingPayload(payload, source) {
    const normalizedSource = normalizeGenerationSource(source);
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const defaultContent = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';

    switch (normalizedSource) {
        case CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES:
            if (payload?.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
                return payload.delta;
            }
            return '';
        case CHAT_COMPLETION_SOURCES.CLAUDE:
            return typeof payload?.delta?.text === 'string' ? payload.delta.text : '';
        case CHAT_COMPLETION_SOURCES.MAKERSUITE:
        case CHAT_COMPLETION_SOURCES.VERTEXAI:
            return extractTextFromGeminiParts(payload?.candidates?.[0]?.content?.parts);
        case CHAT_COMPLETION_SOURCES.COHERE:
            return payload?.delta?.message?.content?.text ?? payload?.delta?.message?.tool_plan ?? '';
        case CHAT_COMPLETION_SOURCES.DEEPSEEK:
        case CHAT_COMPLETION_SOURCES.XAI:
            return choice?.delta?.content ?? '';
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            return extractTextFromOpenAIMessageContent(defaultContent);
        case CHAT_COMPLETION_SOURCES.CUSTOM:
        case CHAT_COMPLETION_SOURCES.POLLINATIONS:
        case CHAT_COMPLETION_SOURCES.AIMLAPI:
        case CHAT_COMPLETION_SOURCES.MOONSHOT:
        case CHAT_COMPLETION_SOURCES.COMETAPI:
        case CHAT_COMPLETION_SOURCES.ELECTRONHUB:
        case CHAT_COMPLETION_SOURCES.NANOGPT:
        case CHAT_COMPLETION_SOURCES.ZAI:
        case CHAT_COMPLETION_SOURCES.SILICONFLOW:
        case CHAT_COMPLETION_SOURCES.CHUTES:
        case CHAT_COMPLETION_SOURCES.AZURE_OPENAI:
        case CHAT_COMPLETION_SOURCES.AI21:
            return extractTextFromOpenAIMessageContent(defaultContent);
        case CHAT_COMPLETION_SOURCES.MISTRALAI: {
            const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
            return extractTextFromOpenAIMessageContent(content);
        }
        default:
            return extractTextFromOpenAIMessageContent(defaultContent);
    }
}

export function extractTextFromFinalPayload(payload) {
    if (!payload) {
        return '';
    }

    if (typeof payload === 'string') {
        return payload;
    }

    if (typeof payload !== 'object') {
        return '';
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (choice) {
        const choiceContent = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? '';
        const extractedChoiceText = extractTextFromOpenAIMessageContent(choiceContent);
        if (extractedChoiceText) {
            return extractedChoiceText;
        }
        if (typeof choice?.message?.tool_plan === 'string') {
            return choice.message.tool_plan;
        }
    }

    const result = Array.isArray(payload?.results) ? payload.results[0] : null;
    if (result) {
        const resultContent = result?.message?.content ?? result?.content ?? result?.text ?? '';
        const extractedResultText = extractTextFromOpenAIMessageContent(resultContent);
        if (extractedResultText) {
            return extractedResultText;
        }
        if (typeof result?.message?.tool_plan === 'string') {
            return result.message.tool_plan;
        }
    }

    const responseContentText = extractTextFromGeminiParts(payload?.responseContent?.parts, { joiner: '\n\n' });
    if (responseContentText) {
        return responseContentText;
    }

    const payloadContentText = extractTextFromOpenAIMessageContent(payload?.content);
    if (payloadContentText) {
        return payloadContentText;
    }

    const payloadMessageContentText = extractTextFromOpenAIMessageContent(payload?.message?.content);
    if (payloadMessageContentText) {
        return payloadMessageContentText;
    }

    if (typeof payload?.message?.tool_plan === 'string') {
        return payload.message.tool_plan;
    }
    if (typeof payload.response === 'string') {
        return payload.response;
    }
    if (typeof payload.token === 'string') {
        return payload.token;
    }
    if (typeof payload.text === 'string') {
        return payload.text;
    }
    if (typeof payload.output === 'string') {
        return payload.output;
    }
    if (Array.isArray(payload?.output)) {
        const out = [];
        for (const item of payload.output) {
            if (item?.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part?.type === 'output_text' && typeof part.text === 'string') {
                        out.push(part.text);
                    }
                }
            }
        }
        if (out.length > 0) return out.join('');
    }

    return '';
}

export function extractTextFromStreamingFrameData(rawData, source = '') {
    if (!rawData || rawData === '[DONE]') {
        return '';
    }

    try {
        const parsed = JSON.parse(rawData);
        if (parsed?.luker && typeof parsed.luker === 'object') {
            return '';
        }
        return extractTextFromStreamingPayload(parsed, source) || extractTextFromFinalPayload(parsed);
    } catch {
        return '';
    }
}

/**
 * Given a raw chunk emitted from a dispatch (Uint8Array / Buffer / string),
 * attempt to extract text content and append to `job.text`. Supports both:
 *   - SSE frames (`\n\n` delimited, `data: ` prefixed lines), including
 *     multiple frames per chunk and partial frames spanning chunks (buffered
 *     on `job._sseBuffer`).
 *   - A single JSON object payload (non-streaming case, no SSE framing).
 *
 * Silently returns for other shapes (binary image bytes, unrelated bytes).
 * Never throws.
 *
 * The runner calls this on every `chunk` event so `job.text` stays in sync
 * with the streamed content. `appendGenerationEvent` still stores the raw
 * event verbatim in `job.events[]` for WS replay; text extraction is a
 * separate channel and does not alter the events array.
 *
 * @param {object} job
 * @param {Uint8Array | Buffer | string} chunkBytes
 */
export function accumulateChunkTextIntoJob(job, chunkBytes) {
    if (!job || chunkBytes == null) return;

    let text;
    if (typeof chunkBytes === 'string') {
        text = chunkBytes;
    } else if (chunkBytes instanceof Uint8Array || Buffer.isBuffer(chunkBytes)) {
        try {
            text = Buffer.from(chunkBytes).toString('utf8');
        } catch {
            return;
        }
    } else {
        return;
    }
    if (!text) return;

    const source = job?.requestMeta?.api || '';
    job._sseBuffer = String(job._sseBuffer || '') + text;
    // Normalize CRLF → LF before framing. Some upstream proxies (nginx-
    // wrapped Anthropic, Claude passthrough proxies) emit CRLF instead of
    // LF; without normalization the \n\n frame delimiter never matches and
    // job.text never accumulates. Legacy forwardStreamingWithGenerationJob
    // did this on every buffer append; the refactor must mirror it exactly.
    job._sseBuffer = job._sseBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // If the buffer looks like SSE (has a frame delimiter, or begins with a
    // `data:` line), parse SSE frames. Last split element may be a partial
    // frame — keep it in the buffer for the next call.
    if (job._sseBuffer.includes('\n\n') || job._sseBuffer.startsWith('data:')) {
        const frames = job._sseBuffer.split('\n\n');
        job._sseBuffer = frames.pop() || '';
        for (const frame of frames) {
            if (!frame) continue;
            // .trimEnd() + .slice(5).trimStart() matches legacy parsing
            // exactly. Full .trim() strips payload-internal trailing
            // whitespace in Claude thinking/tool_use deltas.
            const dataLines = frame
                .split('\n')
                .map(line => line.replace(/\s+$/, ''))
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).replace(/^\s+/, ''));
            if (dataLines.length === 0) continue;
            const payload = dataLines.join('\n');
            if (!payload || payload === '[DONE]') continue;
            const deltaText = extractTextFromStreamingFrameData(payload, source);
            if (deltaText) job.text += deltaText;
        }
        return;
    }

    // No SSE framing yet — try treating the buffer as a complete JSON payload
    // (non-streaming dispatch). Only attempt if it plausibly starts with JSON;
    // if extraction succeeds, clear the buffer so a subsequent chunk starts
    // fresh. Otherwise keep buffering (chunk may be partial JSON).
    const trimmed = job._sseBuffer.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const deltaText = extractTextFromStreamingFrameData(trimmed, source);
        if (deltaText) {
            job.text += deltaText;
            job._sseBuffer = '';
        }
    }
}

function pruneGenerationJobs() {
    const now = Date.now();
    for (const [key, job] of generationJobs.entries()) {
        const updatedAt = Number(job?.updatedAt || job?.createdAt || 0);
        if (!updatedAt || (now - updatedAt) > LUKER_GENERATION_JOB_TTL_MS) {
            clearGenerationJobPersistenceTimer(job);
            generationJobs.delete(key);
        }
    }

    while (generationJobs.size > LUKER_GENERATION_JOB_MAX_ITEMS) {
        const oldestKey = generationJobs.keys().next().value;
        clearGenerationJobPersistenceTimer(generationJobs.get(oldestKey));
        generationJobs.delete(oldestKey);
    }
}

function clearGenerationJobPersistenceTimer(job) {
    // Also owns the text-progress notify timer: every caller of this helper
    // is a state transition (complete / fail / cancel / persist), where a
    // pending progress frame would be stale noise.
    if (job?._textNotifyTimer) {
        clearTimeout(job._textNotifyTimer);
        job._textNotifyTimer = null;
    }
    if (!job?.persistenceTimer) {
        return;
    }

    clearTimeout(job.persistenceTimer);
    job.persistenceTimer = null;
}

// Live-text progress feed for recovery subscribers (/jobs/events-stream).
// Every status frame carries the FULL accumulated job.text, so notifying on
// each chunk would scale wire bytes quadratically with reply length (a
// 100KB reply arriving in 1KB chunks ≈ 5MB of redundant JSON per client).
// The interval bounds that to one frame per tick while the trailing timer
// guarantees the final partial segment is never stranded until completion.
const LUKER_GENERATION_TEXT_PROGRESS_NOTIFY_MS = 300;

/**
 * Throttled status notification during a running stream so recovery clients
 * see the preview text grow live instead of jumping at completion. Leading +
 * trailing edge: fires immediately when the interval has elapsed since the
 * last send, otherwise schedules one trailing send so text accumulated in
 * between is still delivered.
 *
 * No-op once the job leaves 'running' (terminal transitions notify their own
 * status frames), when text length is unchanged, or for jobs without text.
 * @param {object} job
 */
export function notifyJobTextProgress(job) {
    if (!job || String(job.status || '') !== 'running') {
        return;
    }
    const textLen = String(job.text || '').length;
    if (!textLen || textLen === Number(job._lastNotifiedTextLen || 0)) {
        return;
    }
    const now = Date.now();
    const elapsed = now - Number(job._lastTextNotifyAt || 0);
    if (elapsed >= LUKER_GENERATION_TEXT_PROGRESS_NOTIFY_MS) {
        if (job._textNotifyTimer) {
            clearTimeout(job._textNotifyTimer);
            job._textNotifyTimer = null;
        }
        job._lastTextNotifyAt = now;
        job._lastNotifiedTextLen = textLen;
        notifyJobStatus(job);
        return;
    }
    if (job._textNotifyTimer) {
        return;
    }
    job._textNotifyTimer = setTimeout(() => {
        job._textNotifyTimer = null;
        if (String(job.status || '') !== 'running') {
            return;
        }
        const lenNow = String(job.text || '').length;
        if (!lenNow || lenNow === Number(job._lastNotifiedTextLen || 0)) {
            return;
        }
        job._lastTextNotifyAt = Date.now();
        job._lastNotifiedTextLen = lenNow;
        notifyJobStatus(job);
    }, LUKER_GENERATION_TEXT_PROGRESS_NOTIFY_MS - elapsed);
}

function buildGenerationJobRequestMeta(request, persistTarget) {
    const lukerGeneration = request.body?.luker_generation;
    return {
        verb: String(request.body?.type || ''),
        api: String(request.body?.chat_completion_source || request.body?.api_type || request.body?.api || 'unknown'),
        char_name: String(persistTarget?.char_name || request.body?.char_name || 'Assistant'),
        model: String(request.body?.model || ''),
        // TASK-044 theater 契约:产出按「结构化 JSON 对象」解读——置真位
        // 有两个合法载体,等价宽松(luker_generation.theater|structured、
        // persist_target.theater|structured);不显式置真 = 原文落 mes,
        // 不猜不捏 extra(json_schema 存在本身不算置真——schema 可以描
        // 任意业务形状,只有调用方点名剧场契约才提 mes/extra)。
        theater: Boolean(
            lukerGeneration?.theater
            || lukerGeneration?.structured
            || persistTarget?.theater
            || persistTarget?.structured
        ),
        directories: {
            chats: String(request.user?.directories?.chats || ''),
            groupChats: String(request.user?.directories?.groupChats || ''),
            // TASK-013 autoInit:persist 阶段 mvu-settle resolveMvuInitLorebooks 读卡用。
            characters: String(request.user?.directories?.characters || ''),
        },
    };
}

export function getPersistChatKey(persistTarget) {
    if (!persistTarget || typeof persistTarget !== 'object') {
        return '';
    }

    if (persistTarget.kind === 'group') {
        return `group:${stripJsonlExt(persistTarget.id)}`;
    }

    const avatar = String(persistTarget.avatar_url || '');
    const fileName = String(persistTarget.file_name || '');
    if (!avatar || !fileName) {
        return '';
    }
    return `char:${avatar}:${stripJsonlExt(fileName)}`;
}

export function getTaskByRequestId(requestId, expectedOwner) {
    const id = String(requestId || '');
    if (!id) return null;
    const job = generationJobs.get(id);
    if (!job) return null;
    if (String(expectedOwner || '') !== String(job.owner || '')) {
        throw new Error('forbidden');
    }
    return job;
}

export function createGenerationJob(request, options) {
    if (!options || typeof options !== 'object') {
        return null;
    }

    const jobId = typeof options.job_id === 'string' && options.job_id.trim()
        ? options.job_id.trim()
        : '';
    if (!jobId) {
        return null;
    }

    const now = Date.now();
    const persistTarget = options.persist_target && typeof options.persist_target === 'object'
        ? options.persist_target
        : null;
    const chatKey = getPersistChatKey(persistTarget);
    const existing = generationJobs.get(jobId);
    const job = existing || {
        id: jobId,
        handle: request.user.profile.handle,
        owner: request.user.profile.handle,
        createdAt: now,
        updatedAt: now,
        status: 'running',
        text: '',
        events: [],
        lastSeq: 0,
        error: '',
        persisted: false,
        persistTarget,
        chatKey,
        abortController: null,
        cancelledByUser: false,
        acked: false,
        ackedAt: null,
        finishedAt: null,
        persistenceTimer: null,
        persistenceInFlight: false,
        requestMeta: null,
        modelName: '',
        // TASK-044:结构化产出的解析快照({text,name,extra}|null),
        // completeGenerationJobFromText 落定,GET /jobs/:id 透出。
        theater: null,
    };

    // A recycled job_id (the client re-POSTs the same job_id when it retries a
    // request) must start from a clean stream state. Without this reset the
    // retry's `resume from_seq: 1` replays the previous attempt's buffered
    // head/chunk/error frames into the new attempt, so the client treats the
    // old attempt's abort as the retry's own result. The previous attempt's
    // upstream request also survives: its AbortController was only nulled,
    // never aborted, so it keeps generating in parallel with the retry.
    if (existing) {
        try { existing.abortController?.abort('superseded by retry'); } catch { /* ignore */ }
        job.events = [];
        job.lastSeq = 0;
        job.text = '';
        job.theater = null; // 回收重跑:上一轮结构化快照一并清,防串戏
    }

    clearGenerationJobPersistenceTimer(job);
    job.status = 'running';
    job.updatedAt = now;
    job.error = '';
    job.persisted = false;
    job.persistTarget = persistTarget;
    job.chatKey = chatKey;
    job.acked = false;
    job.ackedAt = null;
    job.finishedAt = null;
    job.persistenceInFlight = false;
    job.requestMeta = buildGenerationJobRequestMeta(request, persistTarget);
    job.modelName = String(request.body?.model || '');
    if (!Array.isArray(job.events)) {
        job.events = [];
    }
    job.cancelledByUser = false;
    job.abortController = null;
    // diag 认亲键在此挂(早于 runner 的 trace/sources 挂载点)——
    // 'job_running' 事件本身也带 diagId,组装期 inject 事件可双键合并。
    job.diagId = request.utopinnDiagId ?? job.diagId ?? null;

    generationJobs.set(jobId, job);
    emitJobTransition(job); // job_running(重试回收同 id 时也会再翻 running)
    pruneGenerationJobs();
    return job;
}

export function attachJobToRequest(request, job) {
    if (!request || typeof request !== 'object') {
        return;
    }
    request.lukerGenerationJob = job || null;
}

export function getJobFromRequest(request) {
    return request?.lukerGenerationJob || null;
}

export function appendGenerationEvent(job, rawData) {
    if (!job) {
        return;
    }

    const nextSeq = Number(job.lastSeq || 0) + 1;
    job.lastSeq = nextSeq;
    const entry = { seq: nextSeq, data: rawData, ts: Date.now() };
    job.events.push(entry);
    if (job.events.length > LUKER_GENERATION_JOB_MAX_EVENTS) {
        job.events.splice(0, job.events.length - LUKER_GENERATION_JOB_MAX_EVENTS);
    }
    job.updatedAt = Date.now();

    const deltaText = extractTextFromStreamingFrameData(rawData, job?.requestMeta?.api);
    if (deltaText) {
        job.text += deltaText;
    }

    notifyJobSubscribers(job, { type: 'event', entry });
}

/**
 * In-memory subscribers (typically SSE response writers) per job id. Used by
 * the /jobs/events-stream endpoint to push events without polling. Job
 * completion/failure flushes a terminal status and clears the set.
 */
const jobSubscribers = new Map();

export function subscribeToJob(jobId, callback, options = {}) {
    const id = String(jobId || '');
    if (!id || typeof callback !== 'function') {
        return () => {};
    }
    const fromSeq = Number(options.fromSeq || 0);
    // Replay events with seq >= fromSeq
    if (fromSeq > 0) {
        const job = generationJobs.get(id);
        if (job && Array.isArray(job.events)) {
            for (const entry of job.events) {
                if (entry.seq >= fromSeq) {
                    try {
                        callback({ type: 'event', entry });
                    } catch (error) {
                        console.warn('[LukerGeneration] subscriber threw during replay', error);
                    }
                }
            }
        }
    }
    let set = jobSubscribers.get(id);
    if (!set) {
        set = new Set();
        jobSubscribers.set(id, set);
    }
    set.add(callback);
    return () => {
        const current = jobSubscribers.get(id);
        if (current) {
            current.delete(callback);
            if (current.size === 0) jobSubscribers.delete(id);
        }
    };
}

function notifyJobSubscribers(job, payload) {
    if (!job) return;
    const set = jobSubscribers.get(String(job.id));
    if (!set || set.size === 0) return;
    for (const cb of Array.from(set)) {
        try { cb(payload); } catch (error) {
            console.warn('[LukerGeneration] subscriber threw', error);
        }
    }
}

function notifyJobStatus(job) {
    notifyJobSubscribers(job, {
        type: 'status',
        status: job.status,
        text: job.text,
        last_seq: job.lastSeq,
        error: job.error || '',
        output_filtered: Boolean(job.outputFiltered),
        finished_at: job.finishedAt || null,
    });
    emitJobTransition(job);
}

/**
 * diag-bus 统一挂钩:全部状态迁移都汇到 notifyJobStatus(创建/running/
 * awaiting_ack/persisting/completed/failed/cancelled),这里按 status
 * 去重发 job 事件——比逐个迁移点埋点少一圈挂点,且节流 progress 帧
 * (status 不变)天然不重复发。
 */
function emitJobTransition(job) {
    try {
        const status = String(job?.status ?? '');
        if (!status || job._diagStatus === status) return;
        job._diagStatus = status;
        diagEmit({
            lvl: status === 'failed' ? 'error' : (status === 'cancelled' ? 'warn' : 'info'),
            kind: 'job',
            code: `job_${status}`,
            msg: `job ${String(job.id).slice(0, 8)} → ${status}${job.error ? `: ${String(job.error).slice(0, 140)}` : ''}`,
            ctx: {
                jobId: job.id,
                diagId: job.diagId ?? undefined,
                chatKey: job.chatKey,
                verb: job.requestMeta?.verb,
                model: job.modelName || undefined,
            },
            data: {
                status,
                error: job.error ? String(job.error).slice(0, 400) : undefined,
                persisted: Boolean(job.persisted),
                textLen: String(job.text ?? '').length,
                eventCount: Array.isArray(job.events) ? job.events.length : 0,
            },
        });
    } catch { /* 观测面绝不炸 job 生命周期 */ }
}

export function failGenerationJob(job, errorMessage = 'Unknown error occurred') {
    if (!job) {
        return;
    }
    // 终态不覆写:cancelled 保留(abort 语义),completed/failed 也保留——
    // dispatch 晚到的错误抛给已终态 job 不该把成功/已定失败改写。
    if (['cancelled', 'completed', 'failed'].includes(String(job.status || ''))) {
        return;
    }
    clearGenerationJobPersistenceTimer(job);
    job.persistenceInFlight = false;
    job.status = 'failed';
    job.error = String(errorMessage || 'Unknown error occurred');
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
    job.abortController = null;
    notifyJobStatus(job);
}

// ---------------------------------------------------------------------------
// TASK-044 剧场楼层 extra 契约(v0)
//
// 楼层 extra 是宽松透传袋——scene{bg?,bgm?}/choices[{label|text,goto?}]/
// narrator(true)|type('narrator' 上游惯例,regex 持久车道已认)三类剧场位,
// 客户端写侧(append/PATCH/messages)由 chats.js 全透传(只剥协议层
// luker_generation_id);本段补「生成侧兜底 persist」的两条来路:
//
//   1. 客户端指定 —— luker_generation.persist_target.extra 浅袋,
//      persist 时并入楼层 extra。服务端簿记键(api/model/
//      luker_server_persisted/luker_generation_id/gen_id)是生成真相,
//      袋内同键被滤掉(客户端不可伪造簿记)。
//   2. 模型结构化产出 —— requestMeta.theater 置真(置真位见
//      buildGenerationJobRequestMeta 注释)时,job.text 按 JSON 对象解析:
//      首个非空正文键(mes|text|line|content|dialogue|reply|response|
//      narration)提为楼层 mes;speaker|name 提为楼层 name(剧场逐楼
//      speaker 归因);其余键原样抬进 extra —— 不剥不捏,未识别键也进
//      extra 而不是丢(scene/choices/narrator/type 全走这条)。
//      解析失败/非对象 → null,调用方原文落 mes(诚实回退,不捏 extra)。
//
// job.theater = 解析快照({text,name,extra}),completeGenerationJobFromText
// 落定 → GET /api/utopinn/jobs/:id 透出 choices/theater;diag-bus 记
// theater_extra 摘要(观测面可见提键数,不落正文)。
// ---------------------------------------------------------------------------

/** 结构化产出 → 楼层正文的候选键(按序取首个非空字符串)。 */
const THEATER_LIFT_TEXT_KEYS = ['mes', 'text', 'line', 'content', 'dialogue', 'reply', 'response', 'narration'];
/** 结构化产出 → 楼层 speaker 归因的候选键(name 优先,正典楼层键名)。 */
const THEATER_LIFT_NAME_KEYS = ['name', 'speaker'];
/** 服务端簿记键——客户端 persistTarget.extra 袋不可覆盖。 */
const FLOOR_EXTRA_SERVER_KEYS = new Set(['api', 'model', 'luker_server_persisted', 'luker_generation_id', 'gen_id']);

function isLooseObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * persistTarget.extra 浅袋 → 可并入楼层 extra 的键集。
 * 非对象 → {};簿记键过滤(服务端真相不可被客户端袋盖)。
 */
function pickClientFloorExtra(persistTarget) {
    const bag = persistTarget?.extra;
    if (!isLooseObject(bag)) {
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(bag)) {
        if (!FLOOR_EXTRA_SERVER_KEYS.has(key)) {
            out[key] = value;
        }
    }
    return out;
}

/**
 * 结构化产出解析:requestMeta.theater 置真 + text 顶层是 JSON 对象 →
 * {mes, extra, name};否则 null。
 * mes 找不到正文键时回退原文(JSON 原文,不丢信息);extra 收一切非
 * 正文/name 键(宽松透传,剧场字段自由演进)。
 */
function computeTheaterLift(job, text) {
    if (job?.requestMeta?.theater !== true) {
        return null;
    }
    let parsed = null;
    try {
        parsed = JSON.parse(String(text ?? ''));
    } catch {
        parsed = null;
    }
    if (!isLooseObject(parsed)) {
        return null;
    }
    const extra = { ...parsed };
    let mes = '';
    for (const key of THEATER_LIFT_TEXT_KEYS) {
        if (typeof extra[key] === 'string' && extra[key].trim()) {
            mes = extra[key];
            delete extra[key];
            break;
        }
    }
    let name;
    for (const key of THEATER_LIFT_NAME_KEYS) {
        if (typeof extra[key] === 'string' && extra[key].trim()) {
            name = extra[key].trim();
            delete extra[key];
            break;
        }
    }
    return { mes: mes || String(text ?? ''), extra, name };
}

/** job.theater 快照形(供 jobs 详情面;name 缺省 → null)。 */
function theaterSnapshotOfLift(lift) {
    if (!lift) {
        return null;
    }
    return { text: lift.mes, name: lift.name ?? null, extra: lift.extra };
}

async function persistGeneratedReply(job, text, generationId = '', modelName = '') {
    const persistTarget = job?.persistTarget;
    if (!persistTarget || typeof persistTarget !== 'object') {
        return false;
    }

    const rawText = String(text || '');
    // theater 置真时按结构化产出提 mes/name/extra;否则原文 + 空袋。
    const lift = computeTheaterLift(job, rawText);
    const finalText = lift?.mes || rawText;
    if (!finalText) {
        return false;
    }

    const now = new Date().toISOString();
    const genStarted = new Date(Number(job?.createdAt) || Date.now()).toISOString();
    const message = {
        name: String(lift?.name || job?.requestMeta?.char_name || persistTarget.char_name || 'Assistant'),
        is_user: false,
        is_system: false,
        send_date: now,
        gen_started: genStarted,
        gen_finished: now,
        mes: finalText,
        extra: {
            // 客户端指定袋 → 模型结构化产出(本楼专属,盖袋)→ 服务端簿记
            // (恒最后写,api/model/luker_server_persisted 是生成真相)。
            ...pickClientFloorExtra(persistTarget),
            ...(lift ? lift.extra : {}),
            api: String(job?.requestMeta?.api || 'unknown'),
            model: modelName || job?.modelName || job?.requestMeta?.model || '',
            luker_server_persisted: true,
            // Canonical mark: job.text already ran the persisted regex lane at
            // completion — projections/prompt assembly must not re-apply it.
            ...(job?.outputRegexApplied === true ? { [REGEX_PERSISTED_MARK]: true } : {}),
            ...(generationId ? { luker_generation_id: generationId } : {}),
        },
    };
    // ST 楼层惯例(上游 saveReply 尾段):AI 楼恒带 swipe_id/swipes/swipe_info
    // 三元组——swipe 是「同一楼的多版本」而非新楼。缺这套结构的楼层在旧
    // 客户端里没有 swipe 面,也让 type:'swipe' 的并楼分支找不到槽位。
    // swipe_info[i].extra 是 floor.extra 的快照;luker_generation_id 是
    // 协议层一次性 ack 令牌,appendMessagesToChatFile 落盘前会剥掉顶层
    // (stripLukerGenerationIdFromMessage)——快照同步不嵌,保持盘上同形。
    const swipeInfoExtra = structuredClone(message.extra);
    delete swipeInfoExtra.luker_generation_id;
    message.swipe_id = 0;
    message.swipes = [finalText];
    message.swipe_info = [{
        send_date: now,
        gen_started: genStarted,
        gen_finished: now,
        extra: swipeInfoExtra,
    }];

    const directories = job?.requestMeta?.directories;
    const chatsDirectory = String(directories?.chats || '');
    const groupChatsDirectory = String(directories?.groupChats || '');

    if (persistTarget.kind === 'group') {
        const groupId = String(persistTarget.id || '');
        if (!groupId || !groupChatsDirectory) {
            return false;
        }

        // TASK-037 群楼层字段(getFirstCharacterMessage/saveReply 同形):
        // original_avatar = 发言成员 avatar 文件名;force_avatar = 缩略图 URL;
        // extra.gen_id = 群批次 id(客户端 swipe/重放对账用)。全部由
        // persistTarget 透传——缺省不写,保持旧兜底楼层形。
        if (persistTarget.original_avatar) {
            message.original_avatar = String(persistTarget.original_avatar);
        }
        if (persistTarget.force_avatar) {
            message.force_avatar = String(persistTarget.force_avatar);
        }
        if (persistTarget.gen_id !== undefined && persistTarget.gen_id !== null) {
            message.extra.gen_id = persistTarget.gen_id;
        }

        const chatFilePath = path.join(groupChatsDirectory, sanitize(`${groupId}.jsonl`));
        await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages: [message],
            chatMetadata: persistTarget.chat_metadata || {},
            // 兜底 persist 不做 CAS:persistTarget.integrity 是请求时快照,
            // 生成期间服务端自身写入(WI timed effects 等)必然推进 integrity,
            // 拿它校验 = 结构性必挂。双写由 gen-id sidecar/幂等 dedup 兜底。
            integritySlug: '',
            force: Boolean(persistTarget.force),
            // 兜底楼层也写 gen-id sidecar:迟到的客户端 append 带同 id
            // 时 dedup 生效,防「客户端半截楼 + 兜底全量楼」双写。
            incomingGenerationId: generationId,
            // Route through ChatRepo so writes land in the active engine,
            // not just the FS scratch directory. (filePath is still passed
            // so the sidecar gen-id helpers see a stable key.)
            // NOTE: requestMeta 无 handle 字段 —— 原 job?.requestMeta?.handle 恒为
            // undefined,会静默落入 legacy fs 分支;必须用 job.handle。
            handle: job?.handle,
            charDir: '',
            name: groupId,
            isGroup: true,
            groupId,
        });
        // TASK-013 settle seam:chat.messagePersisted 后串行跑 MVU 投影。
        // 结算失败不影响持久化结果(无 MVU 快照的聊天返回 no_baseline 即退)。
        try {
            await settlePersistedMvuMessage({
                handle: job?.handle,
                charDir: '',
                name: groupId,
                isGroup: true,
                groupId,
                // 新建聊天 floor-0 未初始化时先补 init 再结算(upstream initCheck)。
                autoInit: true,
                directories: job?.requestMeta?.directories,
            });
        } catch (error) {
            console.error('[mvu] post-persist settle failed (group):', error);
        }
        return true;
    }

    if (persistTarget.kind === 'character') {
        const avatar = normalizePersistAvatarDirectory(persistTarget.avatar_url);
        const fileName = normalizePersistJsonlFileName(persistTarget.file_name);
        if (!avatar || !fileName || !chatsDirectory) {
            return false;
        }

        const chatFilePath = path.join(
            chatsDirectory,
            avatar,
            fileName,
        );
        const baseName = fileName.replace(/\.jsonl$/i, '');
        await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages: [message],
            chatMetadata: persistTarget.chat_metadata || {},
            // 同 group 分支:兜底 persist 不做 CAS(见上注)。
            integritySlug: '',
            force: Boolean(persistTarget.force),
            incomingGenerationId: generationId,
            handle: job?.handle,
            charDir: avatar,
            name: baseName,
            isGroup: false,
        });
        // TASK-013 settle seam:同 group 分支,串行 post-persist 结算。
        try {
            await settlePersistedMvuMessage({
                handle: job?.handle,
                charDir: avatar,
                name: baseName,
                isGroup: false,
                // 同 group 分支:no_baseline 时自动 floor-0 初始化。
                autoInit: true,
                directories: job?.requestMeta?.directories,
            });
        } catch (error) {
            console.error('[mvu] post-persist settle failed (character):', error);
        }
        return true;
    }

    return false;
}

/**
 * ST 楼层 swipe 结构补全(上游 ensureSwipes 同语义):
 * AI 楼缺 swipe 字段时以当前 mes/extra 回填槽位 0。
 * @returns {boolean} 楼层可 swipe(非用户楼/非小系统楼)且结构已就位;
 *   不可 swipe → false(调用方退回新楼追加,同上游 saveReply 'normal' 回退)。
 */
function ensureFloorSwipeStructures(floor) {
    if (!floor || typeof floor !== 'object') {
        return false;
    }
    // 上游门槛:saveReply 对 swipe_id===undefined||is_user 的末楼退回
    // 'normal';ensureSwipes 再排除 extra.isSmallSys(小系统条)。两条件
    // 合起来 = 只有常规 AI 楼有资格承载 swipes[]。
    if (floor.is_user || floor?.extra?.isSmallSys) {
        return false;
    }
    if (!Array.isArray(floor.swipes)) {
        floor.swipes = [String(floor.mes ?? '')];
    }
    if (typeof floor.swipe_id !== 'number') {
        floor.swipe_id = 0;
    }
    if (!Array.isArray(floor.swipe_info)) {
        floor.swipe_info = floor.swipes.map(() => ({
            send_date: floor.send_date,
            gen_started: floor.gen_started,
            gen_finished: floor.gen_finished,
            extra: {},
        }));
    }
    while (floor.swipe_info.length < floor.swipes.length) {
        floor.swipe_info.push({
            send_date: floor.send_date,
            gen_started: floor.gen_started,
            gen_finished: floor.gen_finished,
            extra: {},
        });
    }
    return true;
}

const SWIPE_PERSIST_CAS_ATTEMPTS = 3;

/**
 * type:'swipe' 的服务端持久化:新文本并入「前一楼」的 swipes[] 槽位
 * (swipe_id 指到新槽、mes/send_date/gen_finished/extra 刷新),不追加新楼。
 * 对齐上游 saveReply({type:'swipe'}) 落盘形:swipe 是同一楼的多版本。
 *
 * 契约(swipe 不可并楼 → 返回 false,调用方退回 persistGeneratedReply
 * 新楼追加,与上游 type 回退 'normal' 一致):
 *   - 聊天不存在(空聊);
 *   - 末楼是用户楼/小系统楼(is_user/extra.isSmallSys);
 *   - persistTarget 字段不足以寻址。
 * 真写失败(NotFound/非完整性错)走 throw,由上层标 failed。
 *
 * CAS 与 dedup:读-改-写经 repo.save(expectedIntegrity);并发推进冲突时
 * 重读重试(≤3 次),与 persistWorldInfoTimedEffects 同语义。gen-id 侧车
 * 命中 = 本次生成已并楼,直接返回 true(重入幂等)。
 */
async function persistGeneratedSwipe(job, text, generationId = '', modelName = '') {
    const persistTarget = job?.persistTarget;
    const rawText = String(text || '');
    // theater 置真:swipe 槽位同样按结构化产出提 mes/extra(并楼语义
    // 不变——新槽正文 = 提后正文,新槽 extra = 提后 extra 快照)。
    const lift = computeTheaterLift(job, rawText);
    const finalText = lift?.mes || rawText;
    if (!persistTarget || typeof persistTarget !== 'object' || !finalText) {
        return false;
    }
    if (persistTarget.kind !== 'character' && persistTarget.kind !== 'group') {
        return false;
    }

    const directories = job?.requestMeta?.directories;
    const isGroup = persistTarget.kind === 'group';
    const avatar = isGroup ? '' : normalizePersistAvatarDirectory(persistTarget.avatar_url);
    const fileName = isGroup ? '' : normalizePersistJsonlFileName(persistTarget.file_name);
    const name = isGroup
        ? String(persistTarget.id || '')
        : fileName.replace(/\.jsonl$/i, '');
    const chatsDirectory = isGroup
        ? String(directories?.groupChats || '')
        : String(directories?.chats || '');
    if (!name || !chatsDirectory || (!isGroup && (!avatar || !fileName))) {
        return false;
    }
    const repoOpts = isGroup ? { isGroup: true, groupId: String(persistTarget.id || '') } : {};
    const chatFilePath = isGroup
        ? path.join(chatsDirectory, sanitize(`${name}.jsonl`))
        : path.join(chatsDirectory, avatar, fileName);

    // gen-id 侧车:本次生成已并楼(兜底重入/retry),不再叠第二份 swipe。
    const incomingId = String(generationId || '').trim();
    if (incomingId && chatFilePath && readLastChatGenerationId(chatFilePath) === incomingId) {
        return true;
    }

    const extra = {
        // 并楼 extra 合并序:旧楼层袋 → 客户端指定袋 → 本次结构化产出 →
        // 服务端簿记(与 persistGeneratedReply 同序——生成真相恒最后写)。
        ...pickClientFloorExtra(persistTarget),
        ...(lift ? lift.extra : {}),
        api: String(job?.requestMeta?.api || 'unknown'),
        model: modelName || job?.modelName || job?.requestMeta?.model || '',
        luker_server_persisted: true,
        // Canonical mark — job.text already ran the persisted regex lane.
        ...(job?.outputRegexApplied === true ? { [REGEX_PERSISTED_MARK]: true } : {}),
        // 群楼层同 persistGeneratedReply:gen_id = 群批次 id(对账键)。
        ...(isGroup && persistTarget.gen_id !== undefined && persistTarget.gen_id !== null
            ? { gen_id: persistTarget.gen_id }
            : {}),
    };
    const sendDate = new Date().toISOString();
    const genStarted = new Date(Number(job?.createdAt) || Date.now()).toISOString();

    const repo = getChatRepo();
    for (let attempt = 0; attempt < SWIPE_PERSIST_CAS_ATTEMPTS; attempt++) {
        const doc = await repo.get(job.handle, avatar, name, repoOpts);
        const body = Array.isArray(doc?.body) ? doc.body.slice() : null;
        const lastFloor = body?.length ? structuredClone(body[body.length - 1]) : null;
        if (!doc || !lastFloor || !ensureFloorSwipeStructures(lastFloor)) {
            return false;
        }
        body[body.length - 1] = lastFloor;

        // 并楼:新 swipe 追加在数组尾并选中。上游「overswipe→生成」
        // 的净效果;不向数组中间插洞(saveReply 的 swipes.length++
        // 稀疏槽行为不复制——服务端 swipe 恒为「再出一版」)。
        lastFloor.swipes.push(finalText);
        lastFloor.swipe_id = lastFloor.swipes.length - 1;
        lastFloor.mes = finalText;
        lastFloor.send_date = sendDate;
        lastFloor.gen_started = genStarted;
        lastFloor.gen_finished = sendDate;
        // 结构化产出携带 speaker/name → 当前槽 speaker 归因同步楼层名签。
        if (lift?.name) {
            lastFloor.name = lift.name;
        }
        lastFloor.extra = {
            ...(lastFloor.extra && typeof lastFloor.extra === 'object' ? lastFloor.extra : {}),
            ...extra,
        };
        lastFloor.swipe_info[lastFloor.swipe_id] = {
            send_date: sendDate,
            gen_started: genStarted,
            gen_finished: sendDate,
            extra: structuredClone(lastFloor.extra),
        };

        try {
            await repo.save(job.handle, avatar, name, doc.header, body, doc.integrity, repoOpts);
        } catch (error) {
            // 生成期间会话被并发推进(WI timed effects/客户端写)——
            // 重读最新 body 再并楼;超次数/非冲突错往外抛。
            if (error?.code !== 'integrity_mismatch' || attempt === SWIPE_PERSIST_CAS_ATTEMPTS - 1) {
                throw error;
            }
            continue;
        }
        if (incomingId && chatFilePath) {
            writeLastChatGenerationId(chatFilePath, incomingId);
        }
        // TASK-013 settle seam:与新楼 persist 同款,串行 post-persist
        // 结算——并楼改了末楼内容/ swipe_id,MVU 投影需对新槽位重算。
        try {
            await settlePersistedMvuMessage({
                handle: job?.handle,
                charDir: avatar,
                name,
                isGroup,
                groupId: isGroup ? String(persistTarget.id || '') : undefined,
                autoInit: true,
                directories,
            });
        } catch (error) {
            console.error('[mvu] post-persist settle failed (swipe):', error);
        }
        return true;
    }
    return false;
}

/**
 * 兜底持久化调度:verb 'swipe' → 并前楼 swipes[];不可并楼/其余动词 →
 * 追加新楼(对齐上游 saveReply 的 type 回退 'normal' 语义)。
 * kind:'none' 在前置守卫已被拦,到这里恒 character/group。
 */
export async function persistJobReplyText(job, text, generationId = '', modelName = '') {
    if (String(job?.requestMeta?.verb || '') === 'swipe') {
        const merged = await persistGeneratedSwipe(job, text, generationId, modelName);
        if (merged) {
            return true;
        }
        // 前楼不可 swipe(空聊/用户楼/小系统楼)——上游 type='normal' 回退。
    }
    return persistGeneratedReply(job, text, generationId, modelName);
}

export async function completeGenerationJobFromText(request, job, text, modelName = '') {
    if (!job) {
        return false;
    }
    if (job.status === 'cancelled') {
        clearGenerationJobPersistenceTimer(job);
        job.persistenceInFlight = false;
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        job.abortController = null;
        job.persisted = false;
        return false;
    }

    // 已终态 job 不许复活:ack 已标 completed(或兜底已 failed)后,
    // dispatch 收尾再进来会把 job 拖回 awaiting_ack + 重武装 15s 定时器
    // → 兜底 persist 再写一楼(双写)。cancelled 由下方专门分支处理。
    if (['completed', 'failed'].includes(String(job.status || ''))) {
        return Boolean(job.persisted);
    }

    const finalText = String(text || '');
    job.text = finalText || job.text || '';
    job.modelName = String(modelName || job.modelName || request.body?.model || '');
    if (!job.text) {
        // 上游空产出不许假 completed:provider !resp.ok 分支内部消化掉
        // HTTP 错(4xx/网络)后正常返回 → runner 走到这,空 text 之前会
        // 挂 awaiting_ack → 15s 后兜底把 job 标 completed,错误被吞。
        // 空产出即失败(含上游真回空,如推理 token 吃光预算)——诚实
        // failed + 明确 error,客户端/CLI 才能提示 attach/diagnose。
        job.status = 'failed';
        job.error = 'Generation produced no output.';
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        job.persisted = false;
        job.persistenceInFlight = false;
        job.abortController = null;
        clearGenerationJobPersistenceTimer(job);
        notifyJobStatus(job);
        return false;
    }

    // GH#3 residual — output-side regex on the generated reply, once, before
    // any persist route sees it. Upstream cleanUpMessage (script.js:11481)
    // rewrote the reply before the floor landed via the flagless persisted
    // lane; that is the lane applied here. Display-only markdown transforms
    // and prompt-only strips are deliberately NOT applied — job.text stays
    // canonical so every persist route, next-round prompt assembly and MVU
    // settle all consume the same authoritative text, while the display
    // projection re-derives its own view at read time. Impersonate floors
    // land as is_user -> USER_INPUT, all other verbs -> AI_OUTPUT, matching
    // chatFloorRegexPlacement. Floors stored from this text are stamped
    // extra.regex_persisted so projections skip a second persisted pass.
    //
    // Ordering vs MVU settle: this runs strictly before every settle call —
    // client appends, PATCH swipe merges and the grace-timer fallback all
    // consume job.text — preserving upstream order (regex -> floor lands ->
    // settle folds). extractCommands scans _.cmd(/<json_patch> patterns in the
    // canonical text, so <UpdateVariable> blocks hidden only for display still
    // settle. A post-settle pass would need the same transform threaded
    // through every settle call site plus a second write, and its only extra
    // reach — rewriting <StatusPlaceHolderImpl/> — would destroy the mount
    // anchor status panels expect in stored mes.
    const outputRunner = request?.utopinnFloorRegexRunner;
    if (outputRunner?.scriptCount) {
        const placement = job.requestMeta?.verb === 'impersonate'
            ? regex_placement.USER_INPUT
            : regex_placement.AI_OUTPUT;
        const processed = outputRunner.persisted(job.text, placement);
        const applied = processed === job.text ? 0 : 1;
        job.text = processed;
        job.outputRegexApplied = true;
        diagEmit({
            lvl: 'info', kind: 'inject', code: 'regex_output',
            msg: `regex_output ${job.chatKey || job.id} scripts=${outputRunner.scriptCount} applied=${applied}`,
            ctx: {
                jobId: job.id,
                diagId: job.diagId ?? undefined,
                charDir: job.persistTarget?.kind === 'character'
                    ? normalizePersistAvatarDirectory(job.persistTarget.avatar_url)
                    : undefined,
                chatKey: job.chatKey || undefined,
                verb: job.requestMeta?.verb,
                stage: 'regex_output',
            },
            data: {
                stage: 'regex_output',
                scripts: outputRunner.scriptCount,
                injected: applied,
                applied,
                filtered: processed === '' ? 1 : 0,
            },
        });
    }

    // A reply fully consumed by valid output regex is a finalized result, NOT
    // "provider produced nothing" (the failed branch above). The job completes
    // with outputFiltered=true, nothing is persisted, and clients must not
    // back-fill the floor from raw provider chunks after this terminal frame.
    if (!job.text) {
        job.outputFiltered = true;
        job.status = 'completed';
        job.error = '';
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        job.persisted = false;
        job.persistenceInFlight = false;
        job.abortController = null;
        clearGenerationJobPersistenceTimer(job);
        notifyJobStatus(job);
        return false;
    }
    // TASK-044 theater 快照:结构化产出此时定稿(流式 job.text 全量已到)。
    // jobs 详情面立即透出 choices/extra;兜底 persist 按同一份 lift 落楼,
    // 客户端写盘路(persist_target none/自写)拿 job.theater 自行组楼层。
    const theaterLift = computeTheaterLift(job, job.text);
    job.theater = theaterSnapshotOfLift(theaterLift);
    if (theaterLift && Object.keys(theaterLift.extra).length > 0) {
        diagEmit({
            lvl: 'info', kind: 'generate', code: 'theater_extra',
            msg: `theater lift: keys=[${Object.keys(theaterLift.extra).join(',')}]`,
            ctx: {
                jobId: job.id,
                diagId: job.diagId ?? undefined,
                chatKey: job.chatKey,
                verb: job.requestMeta?.verb,
            },
            data: {
                keys: Object.keys(theaterLift.extra),
                choices: Array.isArray(theaterLift.extra.choices) ? theaterLift.extra.choices.length : 0,
                scene: isLooseObject(theaterLift.extra.scene) ? Object.keys(theaterLift.extra.scene) : [],
                narrator: theaterLift.extra.narrator === true || theaterLift.extra.type === 'narrator',
            },
        });
    }
    job.status = 'awaiting_ack';
    job.updatedAt = Date.now();
    job.finishedAt = null;
    job.persisted = false;
    job.persistenceInFlight = false;
    job.abortController = null;
    clearGenerationJobPersistenceTimer(job);
    job.persistenceTimer = setTimeout(() => {
        void persistGenerationJobIfUnacked(job);
    }, LUKER_GENERATION_ACK_GRACE_MS);
    notifyJobStatus(job);
    return false;
}

export async function completeGenerationJobFromPayload(request, job, payload, modelName = '') {
    const text = extractTextFromFinalPayload(payload);
    return await completeGenerationJobFromText(request, job, text, modelName);
}

/**
 * Abort a running generation job from the request inspector.
 *
 * Differs from `cancelGenerationJobForRequest` in two ways that matter to the
 * client:
 *   - the job is marked `cancelled` (a user-initiated stop), not `failed`;
 *   - a terminal `error` event with `code: 'aborted'` is appended BEFORE the
 *     upstream AbortController fires. The WS delivery layer turns that code
 *     into a real AbortError on the client, which is what blocks the HTTP
 *     retry loop and the auto-continue / auto-swipe paths. Relying on the
 *     dispatch's own AbortError is not enough: some dispatches swallow it and
 *     return normally, and the generic error frame does not carry the abort
 *     code.
 *
 * @param {object} job
 * @param {string} [reason]
 * @returns {boolean} true when the job was running and is now cancelled
 */
export function abortGenerationJobForInspector(job, reason = 'Aborted from request inspector') {
    if (!job) return false;
    if (!['running', 'queued'].includes(String(job.status || ''))) return false;

    clearGenerationJobPersistenceTimer(job);
    job.persistenceInFlight = false;
    job.status = 'cancelled';
    job.cancelledByUser = true;
    job.error = String(reason || 'Aborted from request inspector');
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
    job.persisted = false;

    // Append the terminal frame before aborting so subscribers receive an
    // explicit abort even when the dispatch catches the AbortError and
    // returns without emitting one of its own.
    appendGenerationEvent(job, {
        kind: 'error',
        data: { code: 'aborted', message: job.error },
    });

    if (job.abortController && !job.abortController.signal?.aborted) {
        try { job.abortController.abort(job.error); } catch { /* already aborted */ }
    }
    job.abortController = null;
    notifyJobStatus(job);
    return true;
}

export function cancelGenerationJobForRequest(request, jobId, reason = 'Cancelled by user') {
    pruneGenerationJobs();
    const id = String(jobId || '').trim();
    if (!id) {
        return { ok: false, status: 400, message: 'Job id is required.' };
    }

    const job = generationJobs.get(id);
    if (!job || job.handle !== request.user.profile.handle) {
        return { ok: false, status: 404, message: 'Job not found.' };
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        return { ok: true, status: 200, cancelled: false, job };
    }

    clearGenerationJobPersistenceTimer(job);
    job.persistenceInFlight = false;
    job.status = 'cancelled';
    job.cancelledByUser = true;
    job.error = String(reason || 'Cancelled by user');
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
    job.persisted = false;

    if (job.abortController && !job.abortController.signal?.aborted) {
        try {
            job.abortController.abort(job.error);
        } catch {
            // ignore abort propagation failures
        }
    }
    job.abortController = null;
    notifyJobStatus(job);

    return { ok: true, status: 200, cancelled: true, job };
}

async function persistGenerationJobIfUnacked(job) {
    if (!job || job.status === 'cancelled' || job.status === 'failed' || job.status === 'completed' || job.persisted || job.acked) {
        return Boolean(job?.persisted);
    }

    clearGenerationJobPersistenceTimer(job);

    if (!job.text) {
        // 与 completeGenerationJobFromText 的空产出分支一致:无内容即 failed。
        job.status = 'failed';
        job.error = job.error || 'Generation produced no output.';
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        notifyJobStatus(job);
        return false;
    }

    // kind:'none' 目标由客户端拥有写盘(swipe/continue/impersonate/quiet):
    // 服务端无可落盘对象,兜底触发即「客户端未在 grace 内写盘+ack」——
    // 不是上游生成失败,错误信息要说清是谁的责任。
    if (!job.persistTarget || job.persistTarget.kind !== 'character' && job.persistTarget.kind !== 'group') {
        job.status = 'failed';
        job.error = 'Client-owned persist target was not written/acknowledged within grace (kind: none).';
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        job.persisted = false;
        notifyJobStatus(job);
        return false;
    }

    job.status = 'persisting';
    job.persistenceInFlight = true;
    job.updatedAt = Date.now();
    notifyJobStatus(job);

    try {
        const persisted = await persistJobReplyText(job, job.text, job.id, job.modelName);
        job.persisted = Boolean(persisted);
        // persist 跨 await:期间用户 abort 会把 status 翻 cancelled——
        // 不许被这里的终态赋值盖回 completed/failed。
        if (job.status !== 'cancelled') {
            job.status = persisted ? 'completed' : 'failed';
            job.error = persisted ? '' : 'Generation could not be persisted on server.';
        }
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        notifyJobStatus(job);
        return Boolean(job.persisted);
    } catch (error) {
        job.persisted = false;
        job.status = 'failed';
        job.error = String(error?.message || 'Generation could not be persisted on server.');
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        notifyJobStatus(job);
        return false;
    } finally {
        job.persistenceInFlight = false;
    }
}

export function acknowledgeGenerationJobsForRequest(request, generationIds = []) {
    pruneGenerationJobs();
    const handle = String(request?.user?.profile?.handle || '');
    const ids = Array.from(new Set(
        Array.isArray(generationIds)
            ? generationIds.map(id => String(id || '').trim()).filter(Boolean)
            : [],
    ));

    /** @type {string[]} */
    const acknowledged = [];
    const acknowledgedAt = Date.now();

    for (const id of ids) {
        const job = generationJobs.get(id);
        if (!job || job.handle !== handle) {
            continue;
        }
        if (job.persisted || job.persistenceInFlight) {
            continue;
        }
        if (!['awaiting_ack', 'completed'].includes(String(job.status || ''))) {
            continue;
        }

        clearGenerationJobPersistenceTimer(job);
        job.acked = true;
        job.ackedAt = acknowledgedAt;
        job.status = 'completed';
        job.error = '';
        job.updatedAt = acknowledgedAt;
        job.finishedAt = acknowledgedAt;
        job.abortController = null;
        acknowledged.push(id);
    }

    return acknowledged;
}

/**
 * Acknowledge a single unpersisted generation job for a persist target when
 * the client saved chat state without forwarding an explicit generation id.
 * This keeps server-side recovery for true disconnects, while allowing
 * message-hijack flows to confirm ownership after any successful chat write.
 * @param {import('express').Request} request
 * @param {object} persistTarget
 * @param {{statuses?: string[], maxJobs?: number}} [options]
 * @returns {string[]}
 */
export function acknowledgeGenerationJobsForPersistTarget(request, persistTarget, options = {}) {
    pruneGenerationJobs();
    const handle = String(request?.user?.profile?.handle || '');
    const chatKey = getPersistChatKey(persistTarget);
    if (!handle || !chatKey) {
        return [];
    }

    const statuses = new Set(
        Array.isArray(options?.statuses) && options.statuses.length
            ? options.statuses.map(status => String(status || '').trim()).filter(Boolean)
            : ['awaiting_ack'],
    );
    const maxJobs = Math.max(1, Number(options?.maxJobs) || 1);

    const candidates = Array.from(generationJobs.values())
        .filter(job => job.handle === handle
            && job.chatKey === chatKey
            && !job.persisted
            && !job.persistenceInFlight
            && statuses.has(String(job.status || '')))
        .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

    if (candidates.length === 0 || candidates.length > maxJobs) {
        return [];
    }

    return acknowledgeGenerationJobsForRequest(request, candidates.map(job => job.id));
}

export function getActiveGenerationJobsForRequest(request, persistTarget) {
    const chatKey = getPersistChatKey(persistTarget);
    if (!chatKey) {
        return [];
    }
    pruneGenerationJobs();
    const handle = request.user.profile.handle;
    return Array.from(generationJobs.values())
        .filter(job => job.handle === handle && job.chatKey === chatKey && ['running', 'queued', 'awaiting_ack', 'persisting'].includes(job.status))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .map(job => ({
            id: job.id,
            status: job.status,
            text: job.text,
            last_seq: job.lastSeq,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
        }));
}

export function getGenerationJobForRequest(request, jobId) {
    pruneGenerationJobs();
    const job = generationJobs.get(String(jobId || ''));
    if (!job || job.handle !== request.user.profile.handle) {
        return null;
    }
    return job;
}

/**
 * TASK-017 生成任务监视:本 handle 全部 job 的摘要列表(新→旧)。
 * 摘要字段足够监视面列表态;详情走 getGenerationJobForRequest 单取。
 */
export function listGenerationJobsForRequest(request) {
    pruneGenerationJobs();
    const handle = request.user.profile.handle;
    return Array.from(generationJobs.values())
        .filter(job => job.handle === handle)
        .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
        .map(job => ({
            id: job.id,
            status: job.status,
            verb: job.requestMeta?.verb ?? null,
            model: job.modelName || job.requestMeta?.model || '',
            chatKey: job.chatKey ?? null,
            textPreview: String(job.text ?? '').slice(0, 120),
            error: job.error || null,
            persisted: Boolean(job.persisted),
            eventCount: Array.isArray(job.events) ? job.events.length : 0,
            hasTrace: job.trace != null,
            totalMs: typeof job.perf?.totalMs === 'number' ? Math.round(job.perf.totalMs) : null,
            tokens: (job.trace?.tokenBudget != null && job.trace?.remainingBudget != null)
                ? job.trace.tokenBudget - job.trace.remainingBudget
                : null,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
        }));
}
