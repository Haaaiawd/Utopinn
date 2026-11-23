/**
 * script-runs —— STscript「宿主往返」回执注册表(TASK-069)。
 *
 * 背景:/input /popup /buttons 是阻塞命令 —— 上游在浏览器弹窗等用户。
 * 服务端 /script/run 单 POST 无法中途要输入,拆两段:
 *   1) POST /api/utopinn/script/run   —— 脚本起跑;撞上阻塞 seam 时
 *      env 里 parked Promise 挂起,run 入册,响应带
 *      {awaiting:{runId,kind:'input'|'popup'|'buttons',...payload}};
 *      未挂起 → 与旧契约同(同步返完)。
 *   2) POST /api/utopinn/script/interact —— {runId,action,value}:
 *      submit → 兑现 parked(各 kind 语义值);cancel → 各 kind 的
 *      取消语义(input→false / popup→undefined / buttons→[]);
 *      abort → abortController 中止整 run。
 *      响应 = 下一个 awaiting 或最终 run 结果(同 /run 字段)。
 *
 * 挂起语义(先定的边界 —— 「job 挂起等回执」不阻塞):
 *   - INTERACT_TIMEOUT_MS:单次交互上限(默认 120s)。超时 = 该交互的
 *     取消语义兑现(input→false→onCancel;popup→undefined;buttons→[]),
 *     脚本继续自然收尾 —— 不 abort(用户可能只是去倒茶)。
 *   - RUN_TTL_MS:整 run 上限(默认 300s),到点 abort + 注销;迟到
 *     interact 拿 404(明确「run 不存在/已过期」,不装还在等)。
 *   - 容量:每 handle 同时挂起 ≤ MAX_PENDING_RUNS(默认 8),挤占时
 *     abort 最旧一条(防漏挂积内存)。
 *   - run 完成后保留至 TTL —— 客户端迟到的 interact 仍拿得到终态
 *     快照(不丢回执);完成即清理交互计时器。
 */
import { randomUUID } from 'node:crypto';
import { SlashCommandAbortController } from '@utopinn/core';
import { emit as diagEmit } from './diag-bus.js';

export const RUN_TTL_MS = Number(process.env.UTOPINN_SCRIPT_RUN_TTL_MS ?? 300_000) || 300_000;
export const INTERACT_TIMEOUT_MS = Number(process.env.UTOPINN_SCRIPT_INTERACT_TIMEOUT_MS ?? 120_000) || 120_000;
export const MAX_PENDING_RUNS = Number(process.env.UTOPINN_SCRIPT_MAX_PENDING_RUNS ?? 8) || 8;

/** @type {Map<string, object>} runId → run */
const runs = new Map();

/** 交互超时 → 各 kind 的「取消语义」兑现值(与 interact cancel 同源)。 */
function cancelValueFor(kind) {
    switch (kind) {
        case 'input': return false;
        case 'buttons': return [];
        case 'popup':
        default: return undefined;
    }
}

/** awaiting 回执面 —— 客户端渲染弹层所需的全部(可序列化)。 */
function awaitingOf(run) {
    const it = run.interaction;
    if (!it) return null;
    const out = { runId: run.id, kind: it.kind, at: it.at };
    for (const [k, v] of Object.entries(it.payload)) out[k] = v;
    return out;
}

/**
 * 挂起一个交互:kind + payload → Promise(兑现值由 interact/超时空回)。
 * kind:'input'|'popup'|'buttons'。
 */
function suspend(run, kind, payload) {
    return new Promise((resolve) => {
        const it = { kind, payload, resolve, at: Date.now(), timer: null };
        run.interaction = it;
        // 单次交互超时 → 取消语义兑现(脚本自然续跑;run 不死)。
        it.timer = setTimeout(() => {
            if (run.interaction !== it) return;
            run.interaction = null;
            diagEmit({
                lvl: 'warn', kind: 'script', code: 'interact_timeout',
                msg: 'script run ' + run.id.slice(0, 8) + ' ' + kind + ' timed out — resolving cancel',
                ctx: { runId: run.id, chatId: run.chatName },
                data: { kind },
            });
            it.resolve(cancelValueFor(kind));
        }, run.interactTimeoutMs);
        it.timer.unref?.();
        // 唤醒等待中的 next() —— /run 首段或 interact 续段在 race 它。
        run.onInteraction?.(it);
    });
}

/** 响应快照:run 最终态(完成/中止/失败)。 */
function finalOf(run) {
    return run.final ?? { state: 'running' };
}

export function listPendingRuns() {
    return [...runs.values()].map((r) => ({
        id: r.id, handle: r.handle, charDir: r.charDir, chatName: r.chatName,
        createdAt: r.createdAt, expiresAt: r.expiresAt,
        waiting: r.interaction ? { kind: r.interaction.kind, at: r.interaction.at } : null,
        done: Boolean(r.final),
    }));
}

export function getScriptRun(runId) {
    return runs.get(String(runId ?? '')) ?? null;
}

/**
 * 起跑一个挂起回执 run。给 env 绑上 requestInput/requestPopup/
 * requestButtons(覆盖 stscript-env 的 null 降级),执行体由调用方给。
 * @param {object} input
 * @param {object} input.env buildStscriptEnv 产物(host seams 在此换绑)
 * @param {() => Promise<unknown>} input.execute 脚本执行(runStscript 包装)
 * @param {object} input.meta {handle,charDir,chatName,userName}(诊断/台账)
 * @returns {object} run —— 供 nextRunState()/resolveInteraction() 使用
 */
export function beginScriptRun({ env, execute, meta = {} }) {
    // 容量闸:挤掉最旧的未完成 run(abort + 注销),不静默堆积。
    const mine = [...runs.values()].filter((r) => r.handle === meta.handle && !r.final);
    if (mine.length >= MAX_PENDING_RUNS) {
        const oldest = mine.sort((a, b) => a.createdAt - b.createdAt)[0];
        abortScriptRun(oldest, 'evicted: handle pending cap ' + MAX_PENDING_RUNS);
    }

    const abortController = new SlashCommandAbortController();
    const run = {
        id: randomUUID(),
        handle: meta.handle ?? '', charDir: meta.charDir ?? '', chatName: meta.chatName ?? '',
        abortController,
        interaction: null,
        onInteraction: null,
        completion: null,
        final: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + RUN_TTL_MS,
        ttlTimer: null,
        interactTimeoutMs: INTERACT_TIMEOUT_MS,
        env, // interact 终态响应要 env.ops / sinks —— run 持引用(env 属本 run)
    };

    // —— 宿主往返 seams:parked Promise + 入册 awaiting ——
    env.host.requestInput = (prompt, defaultInput, options) =>
        suspend(run, 'input', { prompt, defaultInput, options });
    env.host.requestPopup = (options) =>
        suspend(run, 'popup', { ...(options ?? {}) });
    env.host.requestButtons = (options) =>
        suspend(run, 'buttons', { ...(options ?? {}) });

    run.completion = Promise.resolve()
        .then(execute)
        .then((output) => ({ state: 'done', output }))
        .catch((error) => ({ state: 'error', error }));

    // TTL 兜底:整 run 上限,到点 abort;completed 已留 final 的不 abort。
    run.ttlTimer = setTimeout(() => {
        if (!run.final) {
            abortScriptRun(run, 'script run ttl expired');
        }
        // 完成态 run 也到点注销 —— 迟到 interact 404(注册表不是档案柜)。
        runs.delete(run.id);
    }, RUN_TTL_MS);
    run.ttlTimer.unref?.();

    // 完成后立即摘交互计时 + final 记档(awaiting 的 run 也留到完成/注销,
    // 客户端最后一跳 interact 拿得到终态)。
    void run.completion.then((outcome) => {
        run.final = outcome;
        if (run.interaction?.timer) clearTimeout(run.interaction.timer);
    });

    runs.set(run.id, run);
    return run;
}

/**
 * 等待 run 的下一个状态:完成 → {done:true, outcome};挂起 →
 * {awaiting:...}。调用方在 /run 首段与每次 interact 后各调一次。
 */
export async function nextRunState(run) {
    if (run.final) return { done: true, outcome: run.final };
    // 已挂起的交互先于 waiter 到达(interact 兑现→脚本微任务续跑→
    // 立刻撞下一个阻塞 seam)→ 直回 awaiting,不能空等 onInteraction。
    if (run.interaction) return { done: false, awaiting: awaitingOf(run) };
    const interactionAppeared = new Promise((resolve) => {
        run.onInteraction = resolve;
    });
    const outcome = await Promise.race([
        run.completion.then((o) => ({ done: true, outcome: o })),
        interactionAppeared.then(() => ({ done: false })),
    ]);
    if (outcome.done) return outcome;
    return { done: false, awaiting: awaitingOf(run) };
}

/**
 * 兑现当前挂起交互(submit/cancel/abort)。返回:
 *   {ok:true} —— 已兑现,调用方接着 nextRunState()
 *   {ok:false,status,error} —— 无挂起交互;abort 恒 ok。
 */
export function resolveInteraction(run, { action = 'submit', value } = {}) {
    const act = String(action ?? 'submit');
    if (act === 'abort') {
        abortScriptRun(run, 'aborted via /script/interact');
        return { ok: true };
    }
    const it = run.interaction;
    if (!it) {
        return { ok: false, status: 409, error: 'run has no pending interaction (already resolved or completed)' };
    }
    if (it.timer) clearTimeout(it.timer);
    run.interaction = null;
    if (act === 'cancel') {
        it.resolve(cancelValueFor(it.kind));
        return { ok: true };
    }
    // submit:按 kind 归一兑现值 —— input 文本、popup 结果码、buttons 码列。
    switch (it.kind) {
        case 'input':
            it.resolve(value === undefined || value === null ? '' : String(value));
            break;
        case 'popup': {
            const n = Number(value);
            it.resolve(value === undefined || value === null ? undefined : (Number.isFinite(n) ? n : undefined));
            break;
        }
        case 'buttons': {
            const codes = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
            it.resolve(codes.map((c) => Number(c)).filter((n) => Number.isFinite(n)));
            break;
        }
        default:
            it.resolve(undefined);
    }
    return { ok: true };
}

/** abort 一个 run(注销 + 中止信号 + 兑现当前挂起为取消语义)。 */
export function abortScriptRun(run, reason = 'aborted') {
    if (!run) return;
    try {
        run.abortController?.abort?.(String(reason));
    } catch { /* abort 信号源幂等 */ }
    if (run.interaction) {
        if (run.interaction.timer) clearTimeout(run.interaction.timer);
        const it = run.interaction;
        run.interaction = null;
        try { it.resolve(cancelValueFor(it.kind)); } catch { /* 兑现幂等 */ }
    }
    run.final ??= { state: 'error', error: new Error(String(reason)) };
    runs.delete(run.id);
}

export { finalOf };
