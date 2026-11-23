// panel-wire — CardApp bridge 的 wire 闸与编解码面(耦合格调研 §5.1–5.2 收敛)。
//
// 原三份已漂移的同语义副本(web cardapp/bridge.ts、mobile panels/bridge.ts、
// cli cardapp-host.mjs)统一到此:授权展开、入站 shape 校验、wire 错误编码、
// surface 动词降级应答码。帧形状(PanelRequest/Response/Push)与方法表仍在
// ./panels.js —— 本模块只装「判」与「码」,不重述契约。
import {
    isPanelMethod,
    PANEL_METHODS,
    PANEL_METHODS_TH_T0,
    type PanelRequest,
} from './panels.js';

/** manifest.permissions.api expanded into a concrete grant set + face flags. */
export interface ApiGrants {
    /** Bridge methods this mount may invoke (server table stays the truth). */
    allowed: ReadonlySet<string>;
    /** Card declared the 'ctx' face ('ctx' or 'ctx.<method>'). */
    ctxFace: boolean;
    /** Card declared the 'th' face ('th' or 'th.<method>'). */
    thFace: boolean;
}

export interface ExpandApiGrantsOpts {
    /**
     * 'ctx' 整面授权收缩为 surface 两法(ctx.surfaceOpen/surfaceClose)——
     * 面板页本身就是卡的可视表面,open/close 可由宿主在 dispatch 拦截应答;
     * 其余 ctx.* 面该宿主无 ctxDispatch 可服务(mobile 面板页即此形态)。
     * 不传 → 'ctx' 展全 PANEL_METHODS(web/CLI 全面宿主)。
     */
    surfaceOnlyCtx?: boolean;
}

/** 'ctx' 档在 surfaceOnlyCtx 下实际放行的两法。 */
const SURFACE_CTX_METHODS = ['ctx.surfaceOpen', 'ctx.surfaceClose'] as const;

/**
 * Expand `permissions.api` grants(三端同一份语义):
 *   'th'      → the whole T0 table (PANEL_METHODS_TH_T0)
 *   'th.xxx'  → that single method
 *   'ctx'     → the whole ctx face (PANEL_METHODS);surfaceOnlyCtx → 只放
 *               surface 两法(宿主降级由 dispatch 侧如实应答)
 *   'ctx.xxx' → that single ctx method (shim still gets its local members)
 * api empty/undeclared → the ecosystem default = full T0 table.
 */
export function expandApiGrants(api: readonly string[] | undefined, opts: ExpandApiGrantsOpts = {}): ApiGrants {
    if (!api || api.length === 0) {
        return { allowed: new Set<string>(PANEL_METHODS_TH_T0), ctxFace: false, thFace: true };
    }
    const allowed = new Set<string>();
    let ctxFace = false;
    let thFace = false;
    for (const grant of api) {
        if (grant === 'th') {
            thFace = true;
            for (const m of PANEL_METHODS_TH_T0) allowed.add(m);
        } else if (grant === 'ctx') {
            ctxFace = true;
            for (const m of opts.surfaceOnlyCtx ? SURFACE_CTX_METHODS : PANEL_METHODS) allowed.add(m);
        } else if (grant.startsWith('ctx.')) {
            ctxFace = true;
            allowed.add(grant);
        } else if (grant.startsWith('th.')) {
            thFace = true;
            allowed.add(grant);
        }
    }
    return { allowed, ctxFace, thFace };
}

/**
 * Inbound request shape gate(六门之「shape」门;桥内 nonce 闸已过)。
 * 比 panels.isPanelRequest 严的两点(CLI 参照实现的原始语义,单法授权前收口):
 *   - requestId 必须非空(空串可关联但无意义)
 *   - args 缺席或为对象(契约 Record<string,unknown>;number/string/boolean
 *     形状进 dispatch 只会炸出难读的下游错)
 */
export function isPanelRequestData(v: unknown): v is PanelRequest {
    const m = v as Partial<PanelRequest> | null;
    return !!m && m.channel === 'utopinn-panel' && m.direction === 'request'
        && typeof m.nonce === 'string'
        && typeof m.requestId === 'string' && m.requestId.length > 0
        && isPanelMethod(m.method)
        && (m.args === undefined || (typeof m.args === 'object' && m.args !== null));
}

/**
 * dispatch 异常 → wire error 体。ctxApi/宿主层对表外方法抛
 * `unsupported_method: xxx` —— 保码,卡侧调试可直接判;其余一律
 * call_failed(原始 message 随行)。
 */
export function toWireError(e: unknown): { code: string; message: string } {
    const message = e instanceof Error ? e.message : String(e);
    const code = message.startsWith('unsupported_method') ? 'unsupported_method' : 'call_failed';
    return { code, message };
}

/**
 * surface 动词降级应答 reason —— ctx.surfaceOpen/surfaceClose 在宿主无壳
 * 可收时的统一应答。收敛原三名(web 'no_shell_surface'/'no_shell_nav'、
 * mobile 同、CLI 'headless_no_shell'):对卡而言语义只有一个——这个挂载
 * 形态没有可执行 surface 动词的壳面;应答体的 `surface` 字段(open/close)
 * 仍区分动词方向。
 */
export const PANEL_SURFACE_UNAVAILABLE = 'panel_surface_unavailable';
