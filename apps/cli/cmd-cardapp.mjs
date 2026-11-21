/**
 * cmd-cardapp — `utopinn cardapp <sub>` 动词层。
 * 一次性进程语义(design §4):每动词 = mount → settle → act → dispose → exit。
 * 卡真相在服务端(chat_metadata.variables/chat_state/chat body),重开面板无损。
 * harness 本体在 cardapp-host.mjs(jsdom 懒加载,utopinn-cli.mjs 启动零付费)。
 */
import fs from 'node:fs';

const jsonClone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

/**
 * @utopinn/* 走 pnpm workspace 链接(apps/cli/node_modules/@utopinn/*)。
 * reset/clean 或 node_modules 残缺后 `pnpm install` 可能走 up-to-date
 * 快路径不补链接 → 原生抛 ERR_MODULE_NOT_FOUND,报文看着像「包没装」,
 * 实际是链接没建。翻成 harness_missing 带可行动 hint(与 cardapp-host
 * loadDeps 同码,走 dispatch 里现成的分支)。
 */
async function importApiClient() {
    try { return await import('@utopinn/api-client'); }
    catch (e) {
        if (e?.code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find package/.test(String(e?.message ?? ''))) throw e;
        const err = new Error('找不到 @utopinn/api-client —— workspace 链接缺失(node_modules 残缺,非包未装)');
        err.code = 'harness_missing';
        err.detail = { missing: [String(e?.message ?? e)], hint: '仓库根目录 pnpm install;装过仍缺 → pnpm install --force(快路径可能不补链接)' };
        throw err;
    }
}

/**
 * run(io) — io 由 utopinn-cli.mjs 装配(不回头 import 大文件,保模块单向)。
 *   {positional, flags, SERVER, needCtx, out, fail, warn, footer, saveState,
 *    state, readTextArg, stripExt, JSON_MODE}
 */
export async function run(io) {
    const { positional, flags, needCtx, out, fail, warn, footer, saveState, state, readTextArg, stripExt } = io;
    const sub = positional[1];
    const usage = (msg) => fail('usage', `utopinn cardapp <mount|eval|call|op|status|unmount> — ${msg}`, {
        detail: [
            'cardapp mount [--card f(png|charx|json)] [--char d] [--chat n] [--with-parent-doc]',
            'cardapp eval <expr|--file f>          卡 window realm 求值(回 {result,console[]})',
            'cardapp call <method> [json]         直打 dispatch(th.getVariables|ctx.*|T1 透传)',
            'cardapp op dom|click <sel>           DOM 读/点击(click 带 bubbles)',
            'cardapp op input <sel> <value>      输入并派 input 事件',
            'cardapp op <sel> <click|input|focus|text|html> 面板+动作简写',
            'cardapp op dump [--out f]           document.outerHTML 落盘',
            'cardapp op push <event> [args-json] 宿主→卡事件(th.event + ctx emit)',
            'cardapp op wait <expr> [--timeout ms] 轮询到表达式真(等异步收敛)',
            'cardapp status                     mount 元信息(manifest 干跑+上次 mountId)',
            'cardapp unmount [--mount-id id]    撤服务端 mount 能力+清状态',
        ],
        rc: 2,
    });
    if (!sub || sub === 'help' || sub === '--help') return usage('缺子动词');

    let host = null;
    const mountIt = async () => {
        host = await import('./cardapp-host.mjs');
        // --char/--chat 优先;缺省落 ctx use 态;chat 缺席不拦(部分卡无 chat 也能跑,
        // chat-scope 的 th 调用会按服务端语义失败,诚实上报)
        const charDir = flags.char ? stripExt(flags.char, 'png')
            : state?.char?.dir ?? needCtx?.()?.charDir;
        const chatName = stripExt(flags.chat ?? state?.chat?.name ?? '', 'jsonl');
        if (!charDir) return void fail('no_ctx', 'cardapp 需要 char 目标', { hint: 'utopinn use <char> [chat],或 --char d', rc: 2 });
        if (!chatName) warn?.('cardapp: 无 chat 目标(chat-scope 变量/消息调用将 4xx)');
        const session = await host.mountCardApp({
            server: io.SERVER, charDir, chatName,
            card: flags.card, user: flags.user ?? state?.persona,
            withParentDoc: !!flags.withParentDoc,
            timeoutMs: flags.reqTimeout,
            generationWaitMs: flags.wait,
            settleMs: flags.settle,
        });
        saveState?.({ cardapp: { lastMountId: session.mount.mountId, charDir, chatName, at: Date.now() } });
        return session;
    };
    const consoleTail = (s, n = 15) => s.consoleLog.slice(flags.full ? -1e9 : -n);
    const mountBrief = (s) => ({
        mountId: s.mount.mountId, face: s.face, entry: s.mount.entry,
        entryKind: s.mount.entryKind, charDir: s.mount.charId, chatName: s.mount.chatName,
        initCalled: s.initCalled, warnings: s.warnings,
    });
    const domInventory = (s) => {
        const d = s.document, c = s.containerRef;
        return {
            panes: d.querySelectorAll('[data-pane]').length,
            tabs: d.querySelectorAll('[data-tab]').length,
            containerChildren: c?.children?.length ?? 0,
            gate: c?.dataset?.gate, init: c?.dataset?.init,
        };
    };
    const settleOutput = async (s, outObj, tag) => {
        const payload = { ok: true, ...outObj, console: consoleTail(s) };
        if (io.JSON_MODE) { await s.dispose().catch(() => { }); return out(payload); }
        // 人读面:简表 + console 尾
        const m = outObj.mount ?? {};
        if (m.face) console.log(`mount ${m.mountId} · face=${m.face} · ${m.entryKind}:${m.entry}${m.initCalled ? ' · init✓' : ''}`);
        if (outObj.result !== undefined) console.log(JSON.stringify(outObj.result, null, 2).slice(0, flags.full ? 1e9 : 6000));
        if (outObj.text !== undefined) console.log(String(outObj.text).slice(0, flags.full ? 1e9 : 6000));
        for (const line of consoleTail(s)) console.log(`\x1b[2m[card:${line.lvl}] ${line.msg}\x1b[0m`);
        await s.dispose().catch(() => { });
        footer?.(tag);
        return payload;
    };
    /** 卡 realm 求值:表达式先(裹括号),失败退语句块;promise 结果自动 await。 */
    const evalExpr = async (s, expr) => {
        let r;
        try { r = s.evalInCard(`(${expr})`); }
        catch { r = s.window.eval(expr); }
        r = await Promise.resolve(r);
        if (r && typeof r === 'object' && typeof r.nodeType === 'number') {
            return { nodeType: r.nodeType, outerHTML: String(r.outerHTML ?? '').slice(0, 4000), text: String(r.textContent ?? '').slice(0, 1000) };
        }
        try { return jsonClone(r); } catch { return String(r); }
    };
    const unmountServerMount = async (mountId) => {
        try { const { UtopinnClient } = await import('@utopinn/api-client');
            const c = new UtopinnClient({ baseUrl: io.SERVER });
            await c.request(`/api/card-runtime/mounts/${encodeURIComponent(mountId)}`, { method: 'DELETE' });
            return true;
        } catch { return false; }
    };
    const disposeSession = async (s) => {
        // server mount 是 6h TTL 能力凭证——一次性进程退出即撤,别留活口
        if (s?.mount?.mountId && !String(s.mount.mountId).startsWith('local-')) {
            await unmountServerMount(s.mount.mountId);
        }
        await s?.dispose?.().catch(() => { });
    };

    try {
        switch (sub) {
            case 'mount': {
                const s = await mountIt();
                if (!s) return;
                return settleOutput(s, { mount: mountBrief(s), dom: domInventory(s) }, 'mounted');
            }
            case 'eval': {
                const expr = flags.file ? fs.readFileSync(String(flags.file), 'utf8') : await readTextArg(positional.slice(2));
                if (!expr?.trim()) return usage('eval 需要表达式(或 --file)');
                const s = await mountIt();
                if (!s) return;
                try {
                    const result = await evalExpr(s, expr);
                    return settleOutput(s, { mount: mountBrief(s), result }, 'eval');
                } catch (e) {
                    await disposeSession(s);
                    return void fail('server', `eval 抛错: ${e?.message ?? e}`, { detail: e?.stack });
                }
                break;
            }
            case 'call': {
                const method = positional[2];
                if (!method) return usage('call <method> [json-args]');
                let args = {};
                if (flags.stdin) { try { args = JSON.parse(await readTextArg([])) ?? {}; } catch { args = {}; } }
                else if (positional[3] !== undefined) {
                    try { args = JSON.parse(positional.slice(3).join(' ')) ?? {}; }
                    catch { return void fail('usage', 'args 必须是 JSON', { rc: 2 }); }
                }
                const s = await mountIt();
                if (!s) return;
                try {
                    const result = await s.callDispatch(method, args);
                    return settleOutput(s, { mount: mountBrief(s), result: jsonClone(result) ?? null }, `call ${method}`);
                } catch (e) {
                    await disposeSession(s);
                    const code = String(e?.message ?? '').startsWith('unsupported_method') ? 'not_found' : 'server';
                    return void fail(code, `cardapp call ${method}: ${e?.message ?? e}`, { detail: e?.stack });
                }
                break;
            }
            case 'op': {
                const a = positional.slice(2);
                const opSub = a[0];
                const ACTIONS = new Set(['click', 'focus', 'input', 'text', 'html', 'dom']);
                const s = await mountIt();
                if (!s) return;
                const q = (sel) => s.document.querySelector(sel);
                const noEl = (sel) => fail('not_found', `选择器无命中: ${sel}`, { rc: 2 });
                try {
                    // ── 简写形:op <sel> <action> [value] ──
                    if (opSub && !['dom', 'click', 'dump', 'push', 'wait', 'input'].includes(opSub) && ACTIONS.has(a[1])) {
                        const el = q(opSub);
                        if (!el) { await disposeSession(s); return noEl(opSub); }
                        const act = a[1];
                        const payload = await doElementAction(s, el, act, a[2]);
                        return settleOutput(s, { mount: mountBrief(s), result: payload }, `op ${act}`);
                    }
                    switch (opSub) {
                        case 'dom': {
                            const el = q(a[1]);
                            if (!el) { await disposeSession(s); return noEl(a[1]); }
                            return settleOutput(s, {
                                mount: mountBrief(s),
                                result: { outerHTML: el.outerHTML.slice(0, flags.full ? 1e9 : 4000), textContent: (el.textContent ?? '').slice(0, 2000) },
                            }, 'op dom');
                        }
                        case 'click': {
                            const el = q(a[1]);
                            if (!el) { await disposeSession(s); return noEl(a[1]); }
                            el.dispatchEvent(new s.window.MouseEvent('click', { bubbles: true, cancelable: true, view: s.window }));
                            await new Promise(r => setTimeout(r, 60));   // 同步链+一拍异步尾巴
                            return settleOutput(s, { mount: mountBrief(s), result: { clicked: a[1], dom: domInventory(s) } }, `op click ${a[1]}`);
                        }
                        case 'input': {
                            const el = q(a[1]);
                            if (!el) { await disposeSession(s); return noEl(a[1]); }
                            el.value = a[2] ?? '';
                            el.dispatchEvent(new s.window.Event('input', { bubbles: true }));
                            return settleOutput(s, { mount: mountBrief(s), result: { input: a[1], value: el.value } }, `op input`);
                        }
                        case 'dump': {
                            const html = s.document.documentElement.outerHTML;
                            if (flags.out) fs.writeFileSync(String(flags.out), html, 'utf8');
                            return settleOutput(s, { mount: mountBrief(s), result: { bytes: html.length, out: flags.out ?? null, html: flags.out ? undefined : html.slice(0, flags.full ? 1e9 : 8000) } }, 'op dump');
                        }
                        case 'push': {
                            const ev = a[1];
                            if (!ev) { await disposeSession(s); return usage('op push <event> [args-json]'); }
                            let pargs = [];
                            if (a[2] !== undefined) { try { pargs = JSON.parse(a.slice(2).join(' ')); } catch { pargs = [a.slice(2).join(' ')]; } }
                            if (!Array.isArray(pargs)) pargs = [pargs];
                            s.pushThEvent(ev, pargs);
                            s.pushCtxEvent(ev, pargs);
                            await new Promise(r => setTimeout(r, 80));
                            return settleOutput(s, { mount: mountBrief(s), result: { pushed: ev, args: pargs, subscribed: s.subscribedEvents() } }, `op push ${ev}`);
                        }
                        case 'wait': {
                            const expr = a.slice(1).join(' ');
                            if (!expr) { await disposeSession(s); return usage('op wait <expr> [--timeout ms]'); }
                            const deadline = Date.now() + (flags.reqTimeout ?? 10_000);   // --timeout 走 reqTimeout(无独立 flags.timeout)
                            let last;
                            while (Date.now() < deadline) {
                                last = await evalExpr(s, expr).catch(() => undefined);
                                if (last) {
                                    return settleOutput(s, { mount: mountBrief(s), result: { waited: expr, value: last } }, 'op wait');
                                }
                                await new Promise(r => setTimeout(r, 120));
                            }
                            await disposeSession(s);
                            return void fail('timeout', `op wait 超时: ${expr}`, { detail: { last }, rc: 6 });
                        }
                        default:
                            await disposeSession(s);
                            return usage('op 子动词: dom|click|input|dump|push|wait|<sel> <action>');
                    }
                } catch (e) {
                    await disposeSession(s);
                    return void fail('server', `cardapp op 抛错: ${e?.message ?? e}`, { detail: e?.stack });
                }
                break;
            }
            case 'status': {
                const charDir = flags.char ? stripExt(flags.char, 'png')
                    : state?.char?.dir ?? needCtx?.()?.charDir;
                if (!charDir) return void fail('no_ctx', 'status 需要 char 目标', { hint: '--char d 或 utopinn use', rc: 2 });
                const { UtopinnClient } = await importApiClient();
                const client = new UtopinnClient({ baseUrl: io.SERVER });
                let manifest = null;
                try {
                    manifest = await client.request(`/api/card-runtime/cards/${encodeURIComponent(charDir)}/manifest`);
                } catch (e) {
                    manifest = { ok: false, error: String(e?.message ?? e) };
                }
                const payload = {
                    charDir, chatName: stripExt(flags.chat ?? state?.chat?.name ?? '', 'jsonl') || null,
                    manifest, lastMount: state?.cardapp ?? null,
                    note: '一次性进程语义:eval/call/op 每次新 mount(等价重开面板);--daemon 在完整期',
                };
                if (io.JSON_MODE) return out(payload);
                console.log(`card ${charDir} · chat ${payload.chatName ?? '—'}`);
                console.log(`manifest: ${manifest?.ok === false ? '✗ ' + (manifest.error ?? manifest?.errors?.join(';') ?? '?') : `✓ ${manifest?.manifest?.entryKind ?? '?'}:${manifest?.manifest?.entry ?? '?'}`}`);
                if (manifest?.warnings?.length) for (const w of manifest.warnings) console.log(`  warn ${w}`);
                if (state?.cardapp?.lastMountId) console.log(`last mount ${state.cardapp.lastMountId} @ ${new Date(state.cardapp.at).toISOString()}`);
                footer?.('status');
                return payload;
            }
            case 'unmount': {
                const mid = flags.mountId ?? flags['mount-id'] ?? state?.cardapp?.lastMountId;
                if (!mid) return void fail('not_found', '没有可撤的 mountId(本进程一次性语义,服务端 mount 已随退出撤销)', { hint: '--mount-id <id> 显式指定', rc: 2 });
                const ok = await unmountServerMount(String(mid));
                saveState?.({ cardapp: null });
                const payload = { ok, revoked: String(mid) };
                if (io.JSON_MODE) return out(payload);
                console.log(ok ? `revoked ${mid}` : `revoke ${mid} → 服务端 404/失败(可能已过期)`);
                footer?.('unmount');
                return payload;
            }
            default:
                return usage(`未知子动词: ${sub}`);
        }
    } catch (e) {
        if (e?.code === 'harness_missing') {
            return void fail('server', `cardapp harness 缺件: ${e.message}`, {
                code: 'harness_missing', detail: e.detail,
                hint: e.detail?.hint ?? 'pnpm install --filter @utopinn/cli',
            });
        }
        throw e;   // 其余交给大 dispatcher 的统一 fail
    }
}

async function doElementAction(s, el, act, value) {
    switch (act) {
        case 'click':
            el.dispatchEvent(new s.window.MouseEvent('click', { bubbles: true, cancelable: true, view: s.window }));
            await new Promise(r => setTimeout(r, 60));
            return { clicked: true };
        case 'focus': el.focus?.(); return { focused: true };
        case 'input':
            el.value = value ?? '';
            el.dispatchEvent(new s.window.Event('input', { bubbles: true }));
            return { value: el.value };
        case 'text': return { textContent: (el.textContent ?? '').slice(0, 2000) };
        case 'html': case 'dom': return { outerHTML: el.outerHTML.slice(0, 4000) };
        default: throw new Error(`unknown action: ${act}`);
    }
}
