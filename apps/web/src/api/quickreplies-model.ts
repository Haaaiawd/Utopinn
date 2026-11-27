// Quick Replies ST 文档模型(TASK-063)—— 纯件层:零 import,node --test
// 可直测。IO 层见 ./quickreplies.ts(经 export * 全量转发,消费方不用改路径)。
//
// ST 语义锚(legacy public/scripts/extensions/quick-reply):
//   册文档 = QuickReplySet.toJSON({version,name,disableSend,…,qrList,idIndex});
//   绑定面 = settings.extension_settings.quickReplyV2
//           {isEnabled,config:{setList:[{set,isVisible}]},
//            characterConfigs:{'<avatarFile>':{setList:[…]}}}
//           + chat_metadata.quickReply {setList:[…]}(本会话 scope);
//   钮行渲染 = 适用 scope 内 setList 里 isVisible 的册按钮;册启停 = link.isVisible;
//   条目启停 = qr.isHidden;link 在 = 已绑(「绑定但隐藏」是 ST 真状态,不偷删)。

/* ------------------------------------------------------------------ */
/* ST QuickReply 册文档形状(QuickReplySet.toJSON;未知键透传)              */
/* ------------------------------------------------------------------ */

export interface QrEntry {
    id?: number;
    icon?: string;
    label?: string;
    showLabel?: boolean;
    title?: string;
    message?: string;
    contextList?: unknown[];
    preventAutoExecute?: boolean;
    isHidden?: boolean;
    executeOnStartup?: boolean;
    executeOnUser?: boolean;
    executeOnAi?: boolean;
    executeOnChatChange?: boolean;
    executeOnGroupMemberDraft?: boolean;
    executeOnNewChat?: boolean;
    executeBeforeGeneration?: boolean;
    automationId?: string;
    [k: string]: unknown;
}

export interface QrSetDoc {
    version?: number;
    name?: string;
    disableSend?: boolean;
    placeBeforeInput?: boolean;
    injectInput?: boolean;
    color?: string;
    onlyBorderColor?: boolean;
    qrList?: QrEntry[];
    idIndex?: number;
    [k: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* quickReplyV2 settings 形状                                            */
/* ------------------------------------------------------------------ */

/** setList 链接项:{set:<册名>, isVisible} —— QuickReplySetLink.toJSON 同形。 */
export interface QrSetLink {
    set?: string;
    isVisible?: boolean;
    [k: string]: unknown;
}
export interface QrConfig {
    setList?: QrSetLink[];
    [k: string]: unknown;
}
export interface QrSettings {
    isEnabled?: boolean;
    isCombined?: boolean;
    isPopout?: boolean;
    showPopoutButton?: boolean;
    /** 全局 scope(QuickReplyConfig.toJSON)。 */
    config?: QrConfig;
    /** 卡 scope:键 = character.avatar 文件名(如 Alice.png)。 */
    characterConfigs?: Record<string, QrConfig>;
    [k: string]: unknown;
}

export function newQrSetDoc(name: string): QrSetDoc {
    return {
        version: 2, name,
        disableSend: false, placeBeforeInput: false, injectInput: false,
        color: 'transparent', onlyBorderColor: false,
        qrList: [], idIndex: 0,
    };
}

/* ------------------------------------------------------------------ */
/* scope 键与 header 提取                                                */
/* ------------------------------------------------------------------ */

/** 卡 scope 键 = character.avatar 文件名(ST characterConfigs 键);无图卡退 <charDir>.png。 */
export function qrCharScopeKey(avatar: string | null | undefined, charDir: string): string {
    return avatar || `${charDir}.png`;
}

/** chat_metadata.quickReply → QrConfig(header 原键读,非标形状不吃)。 */
export function qrChatConfigFromHeader(header: Record<string, unknown> | null | undefined): QrConfig | null {
    const meta = header?.chat_metadata;
    const qr = meta && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).quickReply : null;
    return qr && typeof qr === 'object' && !Array.isArray(qr) ? (qr as QrConfig) : null;
}

/* ------------------------------------------------------------------ */
/* link 解析小件(三 scope 同逻辑)                                        */
/* ------------------------------------------------------------------ */

export function qrLink(cfg: QrConfig | null | undefined, set: string): QrSetLink | undefined {
    return (cfg?.setList ?? []).find((l) => l && typeof l.set === 'string' && l.set === set);
}
/** 册在某 scope 已绑(link 存在,不看 isVisible)。 */
export function qrBound(cfg: QrConfig | null | undefined, set: string): boolean {
    return qrLink(cfg, set) != null;
}
/** 册在某 scope 可用(绑定且 isVisible !== false;缺省 isVisible 按可见)。 */
export function qrVisible(cfg: QrConfig | null | undefined, set: string): boolean {
    const l = qrLink(cfg, set);
    return l != null && l.isVisible !== false;
}
/** 本会话可用册集 = 全局 + 当前卡 + 本会话三 scope 的并集(钮行渲染闸)。 */
export function qrEnabledNames(qr: QrSettings | null, charKey: string | null, chatCfg: QrConfig | null, allNames: string[]): Set<string> {
    const out = new Set<string>();
    /* quickReplyV2 未初始化 = 从未配置过绑定面 —— 沿用旧只读面「有册即亮」
       语义(全册可视),不给存量部署造「全灭」观感;一旦文档存在则严格按
       link 解释(ST 钮行同语义:只渲染 visible link 的按钮)。
       覆盖两种「未配置」形状:null(服务端无此键)与 {}(共享 store 对
       missing doc 的归一化/外部写入的退档)—— 显式全关的真状态里
       link 带着 isVisible:false 留存,裸空对象只可能是没配置过。 */
    if (qr == null || Object.keys(qr).length === 0) {
        for (const n of allNames) out.add(n);
        return out;
    }
    const cfgs: (QrConfig | null | undefined)[] = [qr.config, charKey ? qr.characterConfigs?.[charKey] : null, chatCfg];
    for (const n of allNames) {
        if (cfgs.some((c) => qrVisible(c, n))) out.add(n);
    }
    return out;
}

/**
 * 启/停一册的 settings 侧写回稿(本会话视角):
 *   on=true  → 确保全局 scope 里 {set,isVisible:true}(无 link 补,有则翻真);
 *   on=false → settings 内全部适用 scope(全局+本卡)里该册 link isVisible
 *              翻假(link 保留 ——「绑定但隐藏」是 ST 真状态,不偷删绑定)。
 * 本会话 scope 不在 settings 文档里 —— chat 侧由调用方查 qrBound(chatCfg)
 * 后走 qrConfigWithLink + patchChatQrConfig 同翻假。
 */
export function qrv2WithSetVisible(qr: QrSettings | null, charKey: string | null, set: string, on: boolean): QrSettings {
    const next: QrSettings = qr ? { ...qr } : { isEnabled: true };
    const hide = (cfg: QrConfig | null | undefined): QrConfig | undefined => {
        if (!cfg?.setList) return cfg ?? undefined;
        return { ...cfg, setList: cfg.setList.map((l) => (l && l.set === set ? { ...l, isVisible: false } : l)) };
    };
    if (on) {
        const cfg: QrConfig = { ...(next.config ?? {}) };
        const list = [...(cfg.setList ?? [])];
        const i = list.findIndex((l) => l && l.set === set);
        if (i >= 0) list[i] = { ...list[i], isVisible: true };
        else list.push({ set, isVisible: true });
        next.config = { ...cfg, setList: list };
    } else {
        next.config = hide(next.config);
        if (charKey && next.characterConfigs?.[charKey]) {
            next.characterConfigs = { ...next.characterConfigs, [charKey]: hide(next.characterConfigs[charKey])! };
        }
    }
    return next;
}

/**
 * scope 级启停(管理页行内开关):
 *   on → link 存在则翻真,缺则补 {set,isVisible:true};
 *   off → link 翻假(保留绑定);
 *   unbind → 摘 link。
 * 返回新 QrConfig(null 入参按空 cfg 起)。
 */
export function qrConfigWithLink(cfg: QrConfig | null | undefined, set: string, op: 'on' | 'off' | 'unbind'): QrConfig {
    const next: QrConfig = { ...(cfg ?? {}) };
    const list = [...(next.setList ?? [])];
    const i = list.findIndex((l) => l && l.set === set);
    if (op === 'unbind') {
        if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
        list[i] = { ...list[i], isVisible: op === 'on' };
    } else if (op === 'on') {
        list.push({ set, isVisible: true });
    }
    next.setList = list;
    return next;
}
