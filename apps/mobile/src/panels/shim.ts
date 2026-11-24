// shim — 面板入口的 face 选择 + ctx-only 降级判据(纯逻辑,node --test 可直测)。
// 与 web CardAppFrame 同款矩阵;抽出原因是 PanelWebView 本体拖 RN import,
// node 侧不可测 —— 判据是伤 1(module 入口错走 t0 → init(ctx) 不被调)
// 的复发闸,值得钉死。
import { expandApiGrants } from '@utopinn/protocol';
import type { MountBundle } from './mounts';

export type PanelShim = 'ctx' | 't0';

/**
 * manifest.entryKind → ?shim= 值:
 *   module   → 'ctx' — ctx-shim 建 __CARDAPP_CTX__;服务端 module 壳带
 *              init-caller 调 module.init(ctx)。
 *   document/缺席 → 't0' — TH-face T0 表(生态默认 + messageframe)。
 */
export function pickPanelShim(manifest: MountBundle['manifest'] | undefined): PanelShim {
    return manifest?.entryKind === 'module' ? 'ctx' : 't0';
}

/**
 * ctx-only manifest 的降级判据:document 入口没有 init(ctx) 约定,
 * ctx 面该卡能调的只剩 surface 两法 —— 静态 UI 在徽标下照渲。
 * module 入口不在此列(ctx shim 完整服务)。
 */
export function degradesCtxOnly(manifest: MountBundle['manifest'] | undefined): boolean {
    const grants = expandApiGrants(manifest?.permissions?.api);
    return grants.ctxFace && !grants.thFace && manifest?.entryKind !== 'module';
}
