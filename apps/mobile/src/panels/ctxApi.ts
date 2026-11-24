// ctxApi — 面板桥的类型面(TASK-009)。
//
// dispatch 已收敛:全部 'utopinn-panel' 方法(ctx.* + th.*)经
// CardAppHost.dispatch(@utopinn/api-client,web 同一宿主实现,由
// usePanelHost 接线)—— 本文件不再持有 method→server 的转发逻辑,
// 只留面板上下文类型。
// 历史说明:旧版 dispatchPanelCall 只认 th.* 并把每个 ctx.* 判
// unsupported_method —— ctx-face 卡(module entry)因此死透;
// 共享宿主落地后该洞已修。
export interface PanelCallArgs {
    type?: string;          // 'chat' | 'global' | 'message' (variables scope)
    message_id?: number;
    script_id?: string;
    [k: string]: unknown;
}

export interface PanelContext {
    charDir: string;
    chatName?: string;
}
