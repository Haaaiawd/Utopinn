// Automation panel view-model — pure pieces lifted out of AutomationPanel
// so node --test can exercise them without the DOM (same pattern as
// api/quickreplies-model.ts; type-stripped .ts only, no JSX here).
//
//   commands → filterCommands (search over registry snapshot)
//   regex    → flattenRegexView (full view → scope groups w/ op targets)
//   quick    → qrEntryKind (script vs text trigger classification)
//   run      → scriptResultLines (ScriptRunRes → honest display lines)
import type { RegexFullViewResponse, RegexScriptData } from '@utopinn/protocol';
import type { RegexScopeTarget } from '../api/regex';
import type { ScriptCommandInfo } from '../api/th';
import type { QrEntry } from '../api/quickreplies-model';

/* ------------------------------------------------------------------ */
/* commands — registry snapshot search                                  */
/* ------------------------------------------------------------------ */

/** Case-insensitive substring match over name + aliases + help text. */
export function filterCommands(cmds: ScriptCommandInfo[], query: string): ScriptCommandInfo[] {
    const q = query.trim().toLowerCase();
    if (!q) return cmds;
    return cmds.filter((c) =>
        c.name.toLowerCase().includes(q)
        || c.aliases.some((a) => a.toLowerCase().includes(q))
        || c.help.toLowerCase().includes(q));
}

/** `/<name><space? args>` — args already user-typed, trimmed outside. */
export function commandScriptLine(name: string, args: string): string {
    const a = args.trim();
    return `/${name}${a ? ` ${a}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* regex — full view → scope groups                                     */
/* ------------------------------------------------------------------ */

export interface RegexFlatItem {
    /** React key — scope + id + index (id 可复用,index 兜底同序稳定)。 */
    key: string;
    /** PATCH/DELETE/PUT 的 scope 寻址。 */
    target: RegexScopeTarget;
    /** id 命中优先,缺 id 退数组下标(服务端同一解析)。 */
    idOrIdx: string | number;
    script: RegexScriptData;
}

export interface RegexGroupView {
    key: string;
    kind: 'global' | 'char' | 'preset';
    /** 组级 scope 寻址(PUT allow / 新建整组替换用;items 为空也能寻址)。 */
    target: RegexScopeTarget;
    /** 组标:global 固定;char = 卡名|charDir;preset = apiId · 预设名。 */
    title: string;
    sub?: string;
    /** PUT allow 的真闸 —— 只 preset 域是放行开关;char 域 autoAllowed
     *  (issue #3 本卡恒放行,allowed 仅留档);global 无 allowlist。 */
    gate?: { allowed: boolean };
    /** 如实徽标 —— 只展示,不可点。 */
    inUse?: boolean;
    active?: boolean;
    shared?: boolean;
    items: RegexFlatItem[];
}

const flatItem = (kind: string, owner: string, target: RegexScopeTarget, sc: RegexScriptData, idx: number): RegexFlatItem => {
    const idOrIdx = typeof sc.id === 'string' && sc.id ? sc.id : idx;
    return { key: `${kind}:${owner}:${idOrIdx}:${idx}`, target, idOrIdx, script: sc };
};

/** GET /regex 全量视图 → 三组(global → char → preset)渲染模型。
 *  空组不产出 —— 面板按组渲染,空 scope 直接缺席。 */
export function flattenRegexView(full: RegexFullViewResponse): RegexGroupView[] {
    const out: RegexGroupView[] = [];
    const gTarget: RegexScopeTarget = { scope: 'global' };
    if (full.global.length) {
        out.push({
            key: 'global', kind: 'global', target: gTarget, title: 'global',
            items: full.global.map((sc, i) => flatItem('global', '', gTarget, sc, i)),
        });
    }
    for (const c of full.chars) {
        const target: RegexScopeTarget = { scope: 'char', charDir: c.charDir };
        out.push({
            key: `char:${c.charDir}`, kind: 'char', target,
            title: c.name || c.charDir, sub: c.charDir,
            active: c.active === true,
            /* shared 是服务端真键(池卡标),protocol RegexCharGroup 未声明。 */
            shared: (c as { shared?: boolean }).shared === true,
            items: c.scripts.map((sc, i) => flatItem('char', c.charDir, target, sc, i)),
        });
    }
    for (const p of full.presets) {
        const target: RegexScopeTarget = { scope: 'preset', apiId: p.apiId, preset: p.name };
        out.push({
            key: `preset:${p.apiId}:${p.name}`, kind: 'preset', target,
            title: p.name, sub: p.apiId,
            gate: { allowed: p.allowed },
            inUse: p.inUse === true,
            active: p.active === true,
            items: p.scripts.map((sc, i) => flatItem('preset', `${p.apiId}:${p.name}`, target, sc, i)),
        });
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* regex — edit draft                                                   */
/* ------------------------------------------------------------------ */

/** placement 值表(engine.js regex_placement;0/4 弃用不画)。 */
export const REGEX_PLACEMENTS = [1, 2, 3, 5, 6] as const;

export interface RegexEditDraft {
    scriptName: string;
    findRegex: string;
    replaceString: string;
    disabled: boolean;
    markdownOnly: boolean;
    promptOnly: boolean;
    runOnEdit: boolean;
    /** placement 选择集(数组成员)。 */
    placement: Set<number>;
    /** 空串 = null(ST 无界语义)。 */
    minDepth: string;
    maxDepth: string;
}

/** 现有脚本 → 编辑稿(新稿给 ST 常用默认:AI_OUTPUT,md-only,runOnEdit)。 */
export function regexDraftOf(sc?: RegexScriptData): RegexEditDraft {
    return {
        scriptName: sc?.scriptName ?? '',
        findRegex: sc?.findRegex ?? '',
        replaceString: sc?.replaceString ?? '',
        disabled: sc?.disabled === true,
        markdownOnly: sc?.markdownOnly ?? true,
        promptOnly: sc?.promptOnly === true,
        runOnEdit: sc?.runOnEdit ?? true,
        placement: new Set(Array.isArray(sc?.placement) ? sc.placement : [2]),
        minDepth: sc?.minDepth == null ? '' : String(sc.minDepth),
        maxDepth: sc?.maxDepth == null ? '' : String(sc.maxDepth),
    };
}

/** 编辑稿 → PATCH set 补丁(只含可写键;深度空串落 null)。 */
export function regexPatchFromDraft(d: RegexEditDraft): Partial<RegexScriptData> {
    const depth = (v: string): number | null => {
        const t = v.trim();
        if (!t) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
    };
    return {
        scriptName: d.scriptName,
        findRegex: d.findRegex,
        replaceString: d.replaceString,
        disabled: d.disabled,
        markdownOnly: d.markdownOnly,
        promptOnly: d.promptOnly,
        runOnEdit: d.runOnEdit,
        placement: [...d.placement].sort((a, b) => a - b),
        minDepth: depth(d.minDepth),
        maxDepth: depth(d.maxDepth),
    };
}

/** 编辑稿 → 新脚本对象(PUT 整组替换用;id 由调用方给)。 */
export function regexNewScript(d: RegexEditDraft, id: string): RegexScriptData {
    return { id, ...regexPatchFromDraft(d) };
}

/* ------------------------------------------------------------------ */
/* quick replies — entry trigger classification                         */
/* ------------------------------------------------------------------ */

export type QrEntryKind = 'script' | 'continue' | 'text' | 'empty';

/**
 * 条目 → 触发分类(与 composer chip 同一判定):
 *   /continue* → 续写快路径(面板不触发生成 —— 只标不跑);
 *   /…        → STscript(面板可跑);
 *   其它       → 普通用户文本(发送在 composer,面板只读)。
 */
export function qrEntryKind(e: QrEntry): QrEntryKind {
    const msg = (e.message ?? '').trim();
    if (!msg) return 'empty';
    if (/^\/continue(?:\s|$)/i.test(msg)) return 'continue';
    if (msg.startsWith('/')) return 'script';
    return 'text';
}

/* ------------------------------------------------------------------ */
/* run — ScriptRunRes → display lines                                   */
/* ------------------------------------------------------------------ */

/** 面板消费的 /script/run|interact 响应形(协议 ScriptRunResponse 是
 *  旧形缺 awaiting/error —— 与 StageFrame 一样本地如实定义)。 */
export interface ScriptRunRes {
    ok?: boolean;
    pipe?: unknown;
    isAborted?: boolean;
    error?: { code?: string; message?: string; commandName?: string };
    notifications?: { severity?: string; text?: string }[];
    popups?: unknown[];
    inputs?: unknown[];
    ops?: unknown[];
    awaiting?: { runId: string; kind: string; [k: string]: unknown } | null;
}

export interface ScriptResultLine { text: string; err: boolean }

const sinkText = (v: unknown): string =>
    typeof v === 'string' ? v
        : (v && typeof v === 'object' ? String((v as { text?: unknown }).text ?? '') : '');

/** 终态响应 → 展示行(pipe 主行 → error → notifications → popups → inputs)。
 *  ops 是导航类回执,由调用方另行消费,不在文本行里。 */
export function scriptResultLines(res: ScriptRunRes): ScriptResultLine[] {
    const out: ScriptResultLine[] = [];
    const pipe = typeof res.pipe === 'string' ? res.pipe.trim() : (res.pipe == null ? '' : JSON.stringify(res.pipe));
    if (pipe) out.push({ text: pipe, err: false });
    if (res.error?.message) {
        const at = res.error.commandName ? ` /${res.error.commandName}` : '';
        out.push({ text: `${res.error.code ?? 'error'}${at}: ${res.error.message}`, err: true });
    }
    for (const n of res.notifications ?? []) {
        if (n?.text) out.push({ text: String(n.text), err: n.severity === 'error' || n.severity === 'warning' });
    }
    for (const p of res.popups ?? []) {
        const text = sinkText(p).trim();
        if (text) out.push({ text, err: false });
    }
    for (const i of res.inputs ?? []) {
        const text = sinkText(i).trim();
        if (text) out.push({ text, err: false });
    }
    if (res.isAborted) out.push({ text: 'aborted', err: true });
    return out;
}
