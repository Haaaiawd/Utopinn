// 预设整档编辑组件 —— openai(apiId 家族)预设 ST 全字段粒度。
// PresetPanel(工作台激活预设实时调参)与 PresetsPage(工坊资产管理面:
// 列表/新建/复制/删除/导出/设默认)共用,勿双份实现 —— 右栏管「当前这份
// 怎么调」,studio 管「有哪些档、新建删」。
//
// 写路约定:onMutate(fn) —— fn 收当前 doc 回 next doc,宿主负责整档
// PUT /presets/:name(防抖/缓存策略归宿主)。组件只改它列出的键,
// 未识别键(preset 生态自定义字段)经 {...doc} 展开原样透传不丢。
//
// 键域对齐上游 settings-openai.json(ref/SillyTavern text-presets):
//   采样   temperature/top_p/top_k/min_p/top_a/tfs/typical_p/
//          frequency_penalty/presence_penalty/repetition_penalty/
//          repetition_penalty_range/seed/n/openai_max_context/openai_max_tokens
//   开关   stream_openai
//   停止串 custom_stop_strings:string[](数组形;JSON 串形兼容读、写回升格数组)
//   编排   prompts[{identifier,name,role,content,marker,...}] +
//          prompt_order[{character_id,order:[{identifier,enabled}]}]
//   正则   extensions.regex_scripts(PresetRegexSection 内嵌小节;
//          放行闸 apiId/presetName 作用域props给,缺席则只渲档内编辑面)
//   注     chat_completion_source / <source>_model 是连接域字段 —— 档内
//          透传不丢(JSON 视图可见),编辑面归连接设置/模型选择,此组件不渲。
import { useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon } from '../Icon';
import { useRemote } from './panelShared';
import type { PresetDocument } from '../../api/presets';
import { getRegexPresetScope, putRegexScope, type RegexScriptData } from '../../api/regex';
import {
    addPresetRegex, newPresetRegexScript, patchPresetRegex, presetRegexScripts,
    removePresetRegex, togglePresetRegex,
} from './presetRegex';

const numOr = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

const inputCls =
    'h-8 w-full rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-[12.5px] text-[color:var(--fg-primary)] outline-none transition-colors focus:border-[color:var(--border-strong)] disabled:opacity-50';

/* ---------------------------------------------------------------- */
/* 小件                                                              */
/* ---------------------------------------------------------------- */

/** 分组收合 —— 提示词等重内容不一次堆满屏;meta 放右侧摘要(徽标/计数)。 */
function Section({ title, meta, open, onToggle, children }: {
    title: string; meta?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode;
}) {
    return (
        <div className="mb-3">
            <button type="button" className="flex w-full items-center justify-between px-0.5 py-1 text-left" onClick={onToggle}>
                <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{title}</span>
                <span className="flex items-center gap-1.5 text-[color:var(--fg-faint)]">
                    {meta}
                    <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                </span>
            </button>
            {open && children}
        </div>
    );
}

/** 采样滑杆行 —— label 左 / 值右(mono),range 满行。 */
function Slider({ label, value, min, max, step, fmt, onChange, disabled }: {
    label: string; value: number; min: number; max: number; step: number;
    fmt: (v: number) => string; onChange: (v: number) => void; disabled?: boolean;
}) {
    return (
        <div className="inset-row flex-col items-stretch gap-1.5">
            <div className="flex w-full justify-between text-[12px]">
                <span className="text-[color:var(--fg-secondary)]">{label}</span>
                <span className="font-mono-ui text-[11.5px]">{fmt(value)}</span>
            </div>
            <input
                type="range" className="h-1.5 w-full" min={min} max={max} step={step}
                value={clamp(value, min, max)} disabled={disabled}
                onChange={(e) => onChange(Number(e.target.value))}
            />
        </div>
    );
}

/** 数值输入 —— 本地草稿允许 '-' 等中间态;合法即提交(onCommit 收到已钳位值)。
 *  ctx/tokens/seed 等大区间字段用输入框不用滑杆(精度可控,同上游 text_pole)。 */
function NumField({ value, min, max, onCommit, disabled, className }: {
    value: number; min: number; max: number; disabled?: boolean; className?: string;
    onCommit: (v: number) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <input
            type="number" className={className ?? inputCls} min={min} max={max}
            value={draft ?? String(value)} disabled={disabled}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setDraft(e.target.value);
                if (e.target.value === '') return;
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onCommit(clamp(n, min, max));
            }}
            onBlur={() => setDraft(null)}
        />
    );
}

function MiniSwitch({ on, onToggle, disabled, title }: { on: boolean; onToggle?: () => void; disabled?: boolean; title?: string }) {
    return (
        <button
            type="button" className="sh-switch" data-checked={on || undefined}
            onClick={disabled ? undefined : onToggle} disabled={disabled} title={title}
            style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
        >
            <span className="sh-switch-thumb" />
        </button>
    );
}

const badge = 'shrink-0 rounded px-1 py-px font-mono-ui text-[9.5px]';
const badgeStyle = { background: 'var(--bg-active)', color: 'var(--fg-muted)' } as const;

/* ---------------------------------------------------------------- */
/* 采样字段表 —— (key, i18n label, min, max, step, 上游缺省, 格式化)      */
/* 滑杆组                                                             */
/* ---------------------------------------------------------------- */

interface SliderDef { key: string; label: string; min: number; max: number; step: number; def: number; fmt: (v: number) => string }
const f2 = (v: number) => v.toFixed(2);
const f3 = (v: number) => v.toFixed(3);
const f0 = (v: number) => String(v);

const SLIDERS: SliderDef[] = [
    { key: 'temperature', label: 'param.temp', min: 0, max: 2, step: 0.01, def: 1, fmt: f2 },
    { key: 'top_p', label: 'param.topP', min: 0, max: 1, step: 0.01, def: 1, fmt: f2 },
    { key: 'top_k', label: 'param.topK', min: 0, max: 500, step: 1, def: 0, fmt: f0 },
    { key: 'min_p', label: 'param.minP', min: 0, max: 1, step: 0.001, def: 0, fmt: f3 },
    { key: 'top_a', label: 'param.topA', min: 0, max: 1, step: 0.001, def: 0, fmt: f3 },
    { key: 'frequency_penalty', label: 'param.freqPen', min: -2, max: 2, step: 0.01, def: 0, fmt: f2 },
    { key: 'presence_penalty', label: 'param.presPen', min: -2, max: 2, step: 0.01, def: 0, fmt: f2 },
    { key: 'repetition_penalty', label: 'param.repPen', min: 1, max: 2, step: 0.01, def: 1, fmt: f2 },
];

/* 扩展采样(textgen 系也出现在生态预设里 —— 同键透传,全显) */
const SLIDERS_EXT: SliderDef[] = [
    { key: 'tfs', label: 'param.tfs', min: 0, max: 1, step: 0.001, def: 1, fmt: f3 },
    { key: 'typical_p', label: 'param.typicalP', min: 0, max: 1, step: 0.01, def: 1, fmt: f2 },
];

interface NumDef { key: string; label: string; min: number; max: number; def: number }
const NUMBERS: NumDef[] = [
    { key: 'openai_max_context', label: 'param.ctxLenTokens', min: 512, max: 2_000_000, def: 4095 },
    { key: 'openai_max_tokens', label: 'param.maxReply', min: 1, max: 128_000, def: 300 },
    { key: 'repetition_penalty_range', label: 'param.repPenRange', min: -1, max: 8192, def: 0 },
    { key: 'seed', label: 'param.seed', min: -1, max: 2_147_483_647, def: -1 },
    { key: 'n', label: 'param.n', min: 1, max: 16, def: 1 },
];

/* ---------------------------------------------------------------- */
/* 停止串 —— doc.custom_stop_strings:string[];                        */
/* 字符串形(JSON 串或裸串)兼容读、写回一律升格数组。                     */
/* ---------------------------------------------------------------- */

function readStops(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (typeof v === 'string' && v.trim()) {
        try {
            const j = JSON.parse(v);
            if (Array.isArray(j)) return j.filter((x): x is string => typeof x === 'string');
        } catch { /* 裸串按单条 stop 展示 */ }
        return [v];
    }
    return [];
}

/* ---------------------------------------------------------------- */
/* prompts / prompt_order                                            */
/* ---------------------------------------------------------------- */

interface OrderEntry { identifier: string; enabled: boolean }
interface OrderBlock { character_id?: unknown; order: OrderEntry[] }
interface PromptItem extends Record<string, unknown> { identifier?: string }

const orderEntries = (raw: unknown): OrderEntry[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((o): o is Record<string, unknown> => isObj(o) && typeof o.identifier === 'string' && o.identifier.length > 0)
        .map((o) => ({ identifier: o.identifier as string, enabled: o.enabled !== false }));
};

/** prompt_order 读取 —— 缺档时由 prompts 合成(不落盘,写时才物化)。 */
function effectiveOrders(doc: PresetDocument): OrderBlock[] {
    const prompts = Array.isArray(doc.prompts) ? (doc.prompts as PromptItem[]) : [];
    if (Array.isArray(doc.prompt_order) && doc.prompt_order.length > 0) {
        return doc.prompt_order.filter(isObj).map((po) => ({
            character_id: po.character_id,
            order: orderEntries(po.order),
        }));
    }
    if (!prompts.length) return [];
    return [{
        character_id: 100000,
        order: prompts
            .filter((p) => isObj(p) && typeof p.identifier === 'string' && p.identifier)
            .map((p) => ({ identifier: p.identifier as string, enabled: true })),
    }];
}

/* ---------------------------------------------------------------- */
/* 正则脚本小节 —— 脚本本体在档(extensions.regex_scripts,doc 写路);    */
/* 放行闸 preset_allowed_regex 在 settings —— scoped GET 取态、PUT      */
/* allow 写回,in_use 徽标同源。apiId/presetName 缺 → 闸行不渲,档内      */
/* 编辑面照给(作用域未知不猜放行)。                                    */
/* ---------------------------------------------------------------- */

const RX_FLAGS: { key: 'markdownOnly' | 'promptOnly' | 'runOnEdit'; label: string }[] = [
    { key: 'markdownOnly', label: 'preset.ed.flagMarkdown' },
    { key: 'promptOnly', label: 'preset.ed.flagPrompt' },
    { key: 'runOnEdit', label: 'preset.ed.flagRunOnEdit' },
];

function PresetRegexSection({ apiId, presetName, doc, onMutate, disabled }: {
    apiId?: string; presetName?: string;
    doc: PresetDocument;
    onMutate: (fn: (d: PresetDocument) => PresetDocument) => void;
    disabled?: boolean;
}) {
    const { t } = useI18n();
    const s = useShell();
    const [open, setOpen] = useState(false);
    const [openKey, setOpenKey] = useState<string | number | null>(null);
    const [allowBusy, setAllowBusy] = useState(false);
    const scripts = useMemo(() => presetRegexScripts(doc), [doc]);
    const scoped = Boolean(apiId && presetName);
    const scope = useRemote(
        scoped ? `regex-preset:${apiId}:${presetName}` : null,
        () => getRegexPresetScope(apiId as string, presetName as string),
    );
    const keyOf = (sc: RegexScriptData, i: number): string | number =>
        (typeof sc.id === 'string' && sc.id) ? sc.id : i;

    const toggleAllow = () => {
        if (!scoped || allowBusy || !scope.data) return;
        setAllowBusy(true);
        void putRegexScope(
            { scope: 'preset', apiId: apiId as string, preset: presetName as string },
            { allow: !scope.data.allowed },
        )
            .then(() => scope.reload())
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setAllowBusy(false));
    };
    /* 写穿 mutate fn 内现取 d —— 与在途调参改动同通道串行,恒以最新档为准。 */
    const delScript = (i: number) => {
        const sc = scripts[i];
        const label = sc?.scriptName || `#${i}`;
        if (!window.confirm(`${t('studio.regex.delConfirm')}\n${label}`)) return;
        if (sc && openKey === keyOf(sc, i)) setOpenKey(null);
        onMutate((d) => removePresetRegex(d, i));
    };
    const addScript = () => {
        const sc = newPresetRegexScript(`rx-${Date.now().toString(36)}`);
        onMutate((d) => addPresetRegex(d, sc));
        setOpenKey(sc.id ?? null);
    };

    return (
        <Section
            title={t('preset.ed.regex')} open={open} onToggle={() => setOpen(!open)}
            meta={(
                <>
                    {scope.data?.inUse && (
                        <span className={badge} style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)' }}>
                            {t('studio.regex.inUse')}
                        </span>
                    )}
                    <span className="font-mono-ui text-[10px]">{scripts.length}</span>
                </>
            )}
        >
            {/* 放行闸 —— settings 侧键,与档写路分开;scoped 才取数才渲。 */}
            {scoped && (
                <div className="inset-row">
                    <span className="min-w-0 flex-1">
                        <span className="block text-[12px] text-[color:var(--fg-secondary)]">{t('studio.regex.allowPreset')}</span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-[color:var(--fg-faint)]">{t('preset.ed.allowNote')}</span>
                    </span>
                    {scope.error ? (
                        <button className="shrink-0 text-[10.5px] text-[color:var(--status-danger)]" onClick={scope.reload}>{t('panel.retry')}</button>
                    ) : (
                        <MiniSwitch
                            on={scope.data?.allowed ?? false} disabled={disabled || allowBusy || !scope.data}
                            title={t('studio.regex.allowPreset')} onToggle={toggleAllow}
                        />
                    )}
                </div>
            )}
            {scripts.length === 0 && (
                <div className="inset-group">
                    <div className="inset-row"><span className="text-[11px] text-[color:var(--fg-faint)]">{t('preset.ed.regexEmpty')}</span></div>
                </div>
            )}
            {scripts.length > 0 && (
                <div className="inset-group">
                    {scripts.map((sc, i) => {
                        const k = keyOf(sc, i);
                        const on = sc.disabled !== true;
                        const expanded = openKey === k;
                        const nm = (typeof sc.scriptName === 'string' && sc.scriptName.trim())
                            ? sc.scriptName : t('studio.regex.unnamed');
                        return (
                            <div key={k}>
                                <div className="inset-row" style={{ opacity: on ? 1 : 0.55 }}>
                                    <button
                                        type="button" className="ghost-btn h-6 w-6 shrink-0" disabled={disabled}
                                        onClick={() => setOpenKey(expanded ? null : k)}
                                    >
                                        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} />
                                    </button>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12.5px] text-[color:var(--fg-secondary)]">{nm}</span>
                                        {typeof sc.findRegex === 'string' && sc.findRegex && (
                                            <span className="mt-0.5 block truncate font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{sc.findRegex}</span>
                                        )}
                                    </span>
                                    <MiniSwitch on={on} disabled={disabled} onToggle={() => onMutate((d) => togglePresetRegex(d, i))} />
                                    <button
                                        type="button" className="ghost-btn h-6 w-6 shrink-0" disabled={disabled}
                                        title={t('studio.persona.delete')} style={{ color: 'var(--status-danger)' }}
                                        onClick={() => delScript(i)}
                                    >
                                        <Icon name="trash" size={12} />
                                    </button>
                                </div>
                                {expanded && (
                                    <div className="mx-3 mb-1 space-y-2 rounded-b-lg border border-t-0 border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] p-2.5">
                                        <label className="block">
                                            <span className="mb-1 block text-[10.5px] text-[color:var(--fg-muted)]">{t('preset.ed.name')}</span>
                                            <input
                                                className={`${inputCls} h-7 text-[12px]`} value={typeof sc.scriptName === 'string' ? sc.scriptName : ''}
                                                disabled={disabled} placeholder={t('studio.regex.namePh')}
                                                onChange={(e) => onMutate((d) => patchPresetRegex(d, i, { scriptName: e.target.value }))}
                                            />
                                        </label>
                                        <label className="block">
                                            <span className="mb-1 block text-[10.5px] text-[color:var(--fg-muted)]">{t('preset.ed.findRegex')}</span>
                                            <input
                                                className={`${inputCls} h-7 font-mono-ui text-[11.5px]`} value={typeof sc.findRegex === 'string' ? sc.findRegex : ''}
                                                disabled={disabled} placeholder="/pattern/g"
                                                onChange={(e) => onMutate((d) => patchPresetRegex(d, i, { findRegex: e.target.value }))}
                                            />
                                        </label>
                                        <label className="block">
                                            <span className="mb-1 block text-[10.5px] text-[color:var(--fg-muted)]">{t('preset.ed.replaceString')}</span>
                                            <textarea
                                                className="min-h-[60px] w-full select-text resize-y rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] p-2 font-mono-ui text-[11.5px] leading-relaxed text-[color:var(--fg-primary)] outline-none transition-colors focus:border-[color:var(--border-strong)] disabled:opacity-50"
                                                value={typeof sc.replaceString === 'string' ? sc.replaceString : ''}
                                                disabled={disabled} placeholder={t('studio.regex.replacePh')}
                                                onChange={(e) => onMutate((d) => patchPresetRegex(d, i, { replaceString: e.target.value }))}
                                            />
                                        </label>
                                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                                            {RX_FLAGS.map((f) => {
                                                const on = sc[f.key] === true;
                                                return (
                                                    <button
                                                        key={f.key} type="button" disabled={disabled}
                                                        className="rounded-full border px-2 py-0.5 text-[10px] transition-colors"
                                                        style={on
                                                            ? { borderColor: 'var(--border-strong)', background: 'var(--bg-active)', color: 'var(--fg-primary)' }
                                                            : { borderColor: 'var(--border-hairline)', color: 'var(--fg-faint)' }}
                                                        onClick={() => onMutate((d) => patchPresetRegex(d, i, { [f.key]: !on }))}
                                                    >
                                                        {t(f.label)}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            <button
                type="button" className="inset-row inset-row-btn w-full !justify-start gap-2" disabled={disabled}
                onClick={addScript}
            >
                <Icon name="plus" size={12} className="shrink-0 text-[color:var(--fg-muted)]" />
                <span className="text-[11.5px] font-medium text-[color:var(--fg-secondary)]">{t('preset.ed.regexAdd')}</span>
            </button>
        </Section>
    );
}

/* ---------------------------------------------------------------- */
/* 主组件                                                            */
/* ---------------------------------------------------------------- */

export function PresetDocEditor({ doc, onMutate, disabled, apiId, presetName }: {
    /** 当前预设整档(宿主真值;每次 onMutate 后宿主应以 next 重渲)。 */
    doc: PresetDocument;
    /** fn(curDoc) → nextDoc;宿主防抖整档 PUT。同步调用,组件内即时生效。 */
    onMutate: (fn: (doc: PresetDocument) => PresetDocument) => void;
    /** 离线/写中禁用整面。 */
    disabled?: boolean;
    /** 放行闸作用域(apiId 家族 + 预设名);缺 → 正则小节只给档内编辑面。 */
    apiId?: string;
    presetName?: string;
}) {
    const { t } = useI18n();
    const [openSec, setOpenSec] = useState<Record<string, boolean>>({ prompts: true });
    const toggleSec = (k: string) => setOpenSec((p) => ({ ...p, [k]: !p[k] }));

    /** 顶键 patch —— 其余键透传。 */
    const patch = (p: Record<string, unknown>) => onMutate((d) => ({ ...d, ...p }));

    /* ——— 停止串 ——— */
    const stops = readStops(doc.custom_stop_strings);

    /* ——— 提示词编排 ———
     * prompts 原始数组带真实下标(isObj 过滤只用于读,写按下标 merge —
     * 畸形非对象条目不炸面,JSON 视图兜底可见)。 */
    const prompts = Array.isArray(doc.prompts) ? doc.prompts : [];
    const promptAt = (i: number): PromptItem | null => (isObj(prompts[i]) ? (prompts[i] as PromptItem) : null);
    const orders = effectiveOrders(doc);
    const [orderIdx, setOrderIdx] = useState(0);
    const oi = orders.length ? Math.min(orderIdx, orders.length - 1) : 0;
    const sel = orders[oi] ?? null;
    const orderIds = new Set((sel?.order ?? []).map((o) => o.identifier));
    /** prompts 内 identifier → 下标反查(内容编辑按下标写)。 */
    const pIdxById = new Map<string, number>();
    prompts.forEach((p, i) => {
        if (isObj(p) && typeof p.identifier === 'string' && p.identifier) pIdxById.set(p.identifier, i);
    });
    /** 未进 order 的 prompts(带下标走 —— 无 identifier 行不炸 key)。 */
    const unordered = prompts
        .map((p, pi) => ({ p: isObj(p) ? (p as PromptItem) : null, pi }))
        .filter((x): x is { p: PromptItem; pi: number } =>
            x.p !== null && (typeof x.p.identifier !== 'string' || !x.p.identifier || !orderIds.has(x.p.identifier)));
    const enabledN = sel ? sel.order.filter((o) => o.enabled).length : 0;

    /** 对 sel 档 order 做变换(读现档 → fn → 写回 prompt_order 同位)。 */
    const mutateOrder = (fn: (order: OrderEntry[]) => OrderEntry[]) => onMutate((d) => {
        const eff = effectiveOrders(d);
        if (!eff.length) return d;
        const idx = Math.min(oi, eff.length - 1);
        return {
            ...d,
            prompt_order: eff.map((po, i) => (i === idx ? { ...po, order: fn(po.order) } : po)),
        };
    });
    const movePrompt = (id: string, dir: -1 | 1) => mutateOrder((order) => {
        const i = order.findIndex((o) => o.identifier === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= order.length) return order;
        const next = [...order];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return next;
    });
    /** 启停:在档 → 翻 enabled;不在档(未排序 prompt)→ 追加 enabled:true。 */
    const togglePrompt = (id: string) => mutateOrder((order) => {
        const hit = order.find((o) => o.identifier === id);
        if (!hit) return [...order, { identifier: id, enabled: true }];
        return order.map((o) => (o.identifier === id ? { ...o, enabled: !o.enabled } : o));
    });
    /** 单条 prompt 字段编辑(prompts[] 按下标 merge,其余键透传)。 */
    const editPrompt = (idx: number, p: Record<string, unknown>) => onMutate((d) => {
        const ps = Array.isArray(d.prompts) ? [...d.prompts] : [];
        const cur = ps[idx];
        if (!isObj(cur)) return d;
        ps[idx] = { ...cur, ...p };
        return { ...d, prompts: ps };
    });

    /* ——— 行展开态(content 编辑) ——— */
    const [openPrompt, setOpenPrompt] = useState<string | null>(null);

    const streamOn = doc.stream_openai !== false;
    const hasExt = SLIDERS_EXT.some((sl) => sl.key in doc) || NUMBERS.slice(2).some((n) => n.key in doc);

    return (
        <div>
            {/* 采样与生成 */}
            <Section
                title={t('preset.ed.sampling')} open={openSec.sampling ?? true} onToggle={() => toggleSec('sampling')}
            >
                <div className="inset-group">
                    {SLIDERS.map((sl) => (
                        <Slider
                            key={sl.key} label={t(sl.label)} value={numOr(doc[sl.key], sl.def)}
                            min={sl.min} max={sl.max} step={sl.step} fmt={sl.fmt} disabled={disabled}
                            onChange={(v) => patch({ [sl.key]: v })}
                        />
                    ))}
                    <div className="inset-row">
                        <span className="text-[12.5px] text-[color:var(--fg-secondary)]">{t('preset.ed.stream')}</span>
                        <MiniSwitch on={streamOn} disabled={disabled} onToggle={() => patch({ stream_openai: !streamOn })} />
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2.5">
                        {NUMBERS.slice(0, 2).map((nd) => (
                            <label key={nd.key} className="block">
                                <span className="mb-1 block text-[11px] text-[color:var(--fg-muted)]">{t(nd.label)}</span>
                                <NumField
                                    value={numOr(doc[nd.key], nd.def)} min={nd.min} max={nd.max} disabled={disabled}
                                    onCommit={(v) => patch({ [nd.key]: v })}
                                />
                            </label>
                        ))}
                    </div>
                </div>

                {/* 扩展采样 —— 非上游 oai 标配但生态档常携带;doc 已有时给「档内」徽标。 */}
                <div className="px-0.5 pb-1 pt-2 text-[11px] text-[color:var(--fg-faint)]">
                    {t('preset.ed.extSamplers')}{hasExt ? ` · ${t('preset.ed.extInDoc')}` : ''}
                </div>
                <div className="inset-group">
                    {SLIDERS_EXT.map((sl) => (
                        <Slider
                            key={sl.key} label={t(sl.label)} value={numOr(doc[sl.key], sl.def)}
                            min={sl.min} max={sl.max} step={sl.step} fmt={sl.fmt} disabled={disabled}
                            onChange={(v) => patch({ [sl.key]: v })}
                        />
                    ))}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2.5">
                        {NUMBERS.slice(2).map((nd) => (
                            <label key={nd.key} className="block">
                                <span className="mb-1 block text-[11px] text-[color:var(--fg-muted)]">{t(nd.label)}</span>
                                <NumField
                                    value={numOr(doc[nd.key], nd.def)} min={nd.min} max={nd.max} disabled={disabled}
                                    onCommit={(v) => patch({ [nd.key]: v })}
                                />
                            </label>
                        ))}
                    </div>
                </div>

                {/* 自定义停止串 —— 数组形直写 custom_stop_strings。 */}
                <div className="px-0.5 pb-1 pt-2 text-[11px] text-[color:var(--fg-faint)]">{t('preset.ed.stops')}</div>
                <div className="inset-group">
                    {stops.length === 0 && (
                        <div className="inset-row"><span className="text-[11px] text-[color:var(--fg-faint)]">{t('preset.ed.stopsEmpty')}</span></div>
                    )}
                    {stops.map((st, i) => (
                        <div key={i} className="inset-row gap-1.5">
                            <input
                                className={`${inputCls} h-7 font-mono-ui text-[11.5px]`} value={st} disabled={disabled}
                                placeholder={t('preset.ed.stopPh')}
                                onChange={(e) => patch({ custom_stop_strings: stops.map((x, j) => (j === i ? e.target.value : x)) })}
                            />
                            <button
                                type="button" className="ghost-btn h-7 w-7 shrink-0" disabled={disabled}
                                onClick={() => patch({ custom_stop_strings: stops.filter((_, j) => j !== i) })}
                            >
                                <Icon name="x" size={11} />
                            </button>
                        </div>
                    ))}
                    <button
                        type="button" className="inset-row inset-row-btn w-full !justify-start gap-2" disabled={disabled}
                        onClick={() => patch({ custom_stop_strings: [...stops, ''] })}
                    >
                        <Icon name="plus" size={12} className="shrink-0 text-[color:var(--fg-muted)]" />
                        <span className="text-[11.5px] font-medium text-[color:var(--fg-secondary)]">{t('preset.ed.addStop')}</span>
                    </button>
                </div>
            </Section>

            {/* 提示词编排 —— prompt_order 序/启停 + prompts 单条内容。 */}
            <Section
                title={t('preset.ed.prompts')} open={openSec.prompts ?? true} onToggle={() => toggleSec('prompts')}
                meta={<span className="font-mono-ui text-[10px]">{sel ? `${enabledN}/${sel.order.length + unordered.length}` : '0'}</span>}
            >
                {orders.length > 1 && (
                    <label className="mb-2 flex items-center gap-2 px-0.5 text-[11px] text-[color:var(--fg-muted)]">
                        {t('preset.ed.orderFor')}
                        <select
                            className={`${inputCls} h-7 w-auto cursor-pointer font-mono-ui text-[11px]`}
                            value={oi} disabled={disabled} onChange={(e) => setOrderIdx(Number(e.target.value))}
                        >
                            {orders.map((po, i) => (
                                <option key={i} value={i}>#{i} · character_id {String(po.character_id ?? '—')}</option>
                            ))}
                        </select>
                    </label>
                )}
                {!sel && (
                    <div className="inset-group">
                        <div className="inset-row"><span className="text-[11px] text-[color:var(--fg-faint)]">{t('preset.ed.noPrompts')}</span></div>
                    </div>
                )}
                <div className="inset-group">
                    {sel?.order.map((oe, i) => {
                        const pi = pIdxById.get(oe.identifier);
                        const p = pi !== undefined ? promptAt(pi) : null;
                        const marker = p?.marker === true;
                        const pName = (typeof p?.name === 'string' && p.name.trim()) ? p.name : oe.identifier;
                        const expandable = !marker && p !== null;
                        const expanded = expandable && openPrompt === oe.identifier;
                        return (
                            <div key={oe.identifier}>
                                <div className="inset-row" style={{ opacity: oe.enabled ? 1 : 0.55 }}>
                                    {expandable ? (
                                        <button
                                            type="button" className="ghost-btn h-6 w-6 shrink-0" disabled={disabled}
                                            onClick={() => setOpenPrompt(expanded ? null : oe.identifier)}
                                        >
                                            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} />
                                        </button>
                                    ) : (
                                        <span className="w-6 shrink-0" />
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12.5px] text-[color:var(--fg-secondary)]">{pName}</span>
                                        <span className="mt-0.5 flex items-center gap-1.5 font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">
                                            <span className="truncate">{oe.identifier}</span>
                                            {marker && <span className={badge} style={badgeStyle}>{t('preset.ed.marker')}</span>}
                                            {pi === undefined && <span className={badge} style={badgeStyle}>{t('preset.ed.noDef')}</span>}
                                            {!marker && typeof p?.role === 'string' && p.role && <span>{p.role}</span>}
                                        </span>
                                    </span>
                                    <button type="button" className="ghost-btn h-6 w-6 shrink-0" disabled={disabled || i === 0} onClick={() => movePrompt(oe.identifier, -1)}>
                                        <Icon name="chevronDown" size={11} className="rotate-180" />
                                    </button>
                                    <button type="button" className="ghost-btn h-6 w-6 shrink-0" disabled={disabled || i === sel.order.length - 1} onClick={() => movePrompt(oe.identifier, 1)}>
                                        <Icon name="chevronDown" size={11} />
                                    </button>
                                    <MiniSwitch on={oe.enabled} disabled={disabled} onToggle={() => togglePrompt(oe.identifier)} />
                                </div>
                                {expanded && pi !== undefined && (
                                    <div className="mx-3 mb-1 space-y-2 rounded-b-lg border border-t-0 border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] p-2.5">
                                        <div className="grid grid-cols-[1fr_120px] gap-2">
                                            <label className="block">
                                                <span className="mb-1 block text-[10.5px] text-[color:var(--fg-muted)]">{t('preset.ed.name')}</span>
                                                <input
                                                    className={`${inputCls} h-7 text-[12px]`} value={typeof p?.name === 'string' ? p.name : ''} disabled={disabled}
                                                    onChange={(e) => editPrompt(pi, { name: e.target.value })}
                                                />
                                            </label>
                                            <label className="block">
                                                <span className="mb-1 block text-[10.5px] text-[color:var(--fg-muted)]">{t('preset.ed.role')}</span>
                                                <select
                                                    className={`${inputCls} h-7 cursor-pointer text-[12px]`} disabled={disabled}
                                                    value={typeof p?.role === 'string' ? p.role : 'system'}
                                                    onChange={(e) => editPrompt(pi, { role: e.target.value })}
                                                >
                                                    <option value="system">system</option>
                                                    <option value="user">user</option>
                                                    <option value="assistant">assistant</option>
                                                </select>
                                            </label>
                                        </div>
                                        <label className="block">
                                            <span className="mb-1 block text-[10.5px] text-[color:var(--fg-muted)]">{t('preset.ed.content')}</span>
                                            <textarea
                                                className="min-h-[110px] w-full select-text resize-y rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] p-2 font-mono-ui text-[11.5px] leading-relaxed text-[color:var(--fg-primary)] outline-none transition-colors focus:border-[color:var(--border-strong)] disabled:opacity-50"
                                                value={typeof p?.content === 'string' ? p.content : ''} disabled={disabled}
                                                onChange={(e) => editPrompt(pi, { content: e.target.value })}
                                            />
                                        </label>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {unordered.length > 0 && (
                        <>
                            <div className="px-3 pb-1 pt-1.5 text-[10.5px] text-[color:var(--fg-faint)]">{t('preset.ed.unorderedGroup')}</div>
                            {unordered.map(({ p, pi }) => {
                                const pid = typeof p.identifier === 'string' && p.identifier ? p.identifier : null;
                                const pName = (typeof p.name === 'string' && p.name.trim()) ? p.name : (pid ?? `#${pi}`);
                                return (
                                    <div key={pid ?? `idx-${pi}`} className="inset-row" style={{ opacity: 0.55 }}>
                                        <span className="w-6 shrink-0" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-[12.5px] text-[color:var(--fg-secondary)]">{pName}</span>
                                            <span className="mt-0.5 flex items-center gap-1.5 font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">
                                                {pid && <span className="truncate">{pid}</span>}
                                                <span className={badge} style={badgeStyle}>{t('preset.ed.unordered')}</span>
                                            </span>
                                        </span>
                                        {pid && (
                                            <MiniSwitch
                                                on={false} disabled={disabled} title={t('preset.ed.unorderedTip')}
                                                onToggle={() => togglePrompt(pid)}
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>
            </Section>

            {/* 正则脚本 —— 档内 extensions.regex_scripts + settings 放行闸。 */}
            <PresetRegexSection apiId={apiId} presetName={presetName} doc={doc} onMutate={onMutate} disabled={disabled} />

            {/* 原始 JSON —— 未列出字段的透明位(只读;透传承诺可视化)。 */}
            <Section title={t('preset.ed.json')} open={openSec.json ?? false} onToggle={() => toggleSec('json')}>
                <pre className="inset-group mb-1 max-h-[420px] overflow-auto p-3 font-mono-ui text-[10.5px] leading-relaxed text-[color:var(--fg-secondary)]">
                    {JSON.stringify(doc, null, 2)}
                </pre>
                <p className="px-1 text-[10px] leading-relaxed text-[color:var(--fg-faint)]">{t('preset.ed.keepNote')}</p>
            </Section>
        </div>
    );
}
