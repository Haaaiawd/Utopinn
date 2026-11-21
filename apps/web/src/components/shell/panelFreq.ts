// 面板使用频度 —— launcher 系统区排序依据(纯前端 pref,不进 WbLayout:
// 频度是人的习惯不是会话的布局,跨会话共享)。
// openPanel 每次调用 bump:{type:{count,lastAt}} → localStorage
// 'utopinn.wb.freq';读侧 score = count + 近因加成(≤2,两天线性衰减到 0),
// 无记录 → -1,launcher 里用过的排前、未用的保注册序殿后。

const KEY = 'utopinn.wb.freq';

export interface PanelFreq {
    count: number;
    lastAt: number;
}

export function readPanelFreq(): Record<string, PanelFreq> {
    try {
        const j = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Partial<PanelFreq>>;
        const out: Record<string, PanelFreq> = {};
        for (const [k, v] of Object.entries(j)) {
            if (v && typeof v.count === 'number' && typeof v.lastAt === 'number') {
                out[k] = { count: v.count, lastAt: v.lastAt };
            }
        }
        return out;
    } catch { return {}; }
}

export function bumpPanelFreq(type: string): void {
    try {
        const j = readPanelFreq();
        const cur = j[type];
        j[type] = { count: (cur?.count ?? 0) + 1, lastAt: Date.now() };
        localStorage.setItem(KEY, JSON.stringify(j));
    } catch { /* storage 不可用就静默 */ }
}

/** 频次 + 近因加成(≤2,两天线性衰减);无记录 → -1(殿后位)。 */
export function panelFreqScore(f: PanelFreq | undefined, now = Date.now()): number {
    if (!f) return -1;
    const days = Math.max(0, (now - f.lastAt) / 86_400_000);
    return f.count + Math.max(0, 2 - days);
}
