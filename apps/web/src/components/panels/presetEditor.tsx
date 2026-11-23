// 预设整档编辑组件 —— openai(apiId 家族)预设 ST 全字段粒度。
// PresetPanel(工作台实时调参)与 PresetsPage(工坊管理面)共用,勿双份实现。
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
//   绑定   chat_completion_source + <source>_model
import { useId, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import type { ModelItem } from '../../api/mock';
import type { PresetDocument } from '../../api/presets';

const numOr = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

const inputCls =
    'h-8 w-full rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-[12.5px] text-[color:var(--fg-primary)] outline-none transition-colors focus:border-[color:var(--border-strong)] disabled:opacity-50';

/* 上游 chat_completion_sources(openai.js:177)—— 预设档内 source 绑定枚举。 */
const CHAT_SOURCES = [
    'openai', 'claude', 'openrouter', 'ai21', 'makersuite', 'vertexai',
    'mistralai', 'custom', 'cohere', 'perplexity', 'groq', 'electronhub',
    'chutes', 'nanogpt', 'deepseek', 'aimlapi', 'xai', 'pollinations',
    'moonshot', 'fireworks', 'cometapi', 'azure_openai', 'zai',
    'siliconflow', 'workers_ai', 'minimax',
];

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
/* 主组件                                                            */
/* ---------------------------------------------------------------- */

export function PresetDocEditor({ doc, onMutate, models, disabled }: {
    /** 当前预设整档(宿主真值;每次 onMutate 后宿主应以 next 重渲)。 */
    doc: PresetDocument;
    /** fn(curDoc) → nextDoc;宿主防抖整档 PUT。同步调用,组件内即时生效。 */
    onMutate: (fn: (doc: PresetDocument) => PresetDocument) => void;
    /** 模型下拉候选(壳 live 列表);缺省 → 绑定模型纯文本输入。 */
    models?: ModelItem[];
    /** 离线/写中禁用整面。 */
    disabled?: boolean;
}) {
    const { t } = useI18n();
    const listId = useId();
    const [openSec, setOpenSec] = useState<Record<string, boolean>>({ prompts: true });
    const toggleSec = (k: string) => setOpenSec((p) => ({ ...p, [k]: !p[k] }));

    /** 顶键 patch —— 其余键透传。 */
    const patch = (p: Record<string, unknown>) => onMutate((d) => ({ ...d, ...p }));

    /* ——— 模型绑定:chat_completion_source + <source>_model ——— */
    const source = typeof doc.chat_completion_source === 'string' && doc.chat_completion_source
        ? doc.chat_completion_source : 'openai';
    const srcKnown = CHAT_SOURCES.includes(source);
    const modelKey = `${source}_model`;
    const boundModel = typeof doc[modelKey] === 'string' ? (doc[modelKey] as string) : '';

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
            {/* 档内模型绑定 —— 生成链 presetDoc.{source}_model 正典消费位。 */}
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr]">
                <div>
                    <label className="mb-1 block text-[11px] text-[color:var(--fg-muted)]">{t('preset.ed.source')}</label>
                    <select
                        className={`${inputCls} cursor-pointer font-mono-ui text-[12px]`}
                        value={srcKnown ? source : '__other'} disabled={disabled}
                        onChange={(e) => patch({ chat_completion_source: e.target.value })}
                    >
                        {!srcKnown && <option value="__other">{source}</option>}
                        {CHAT_SOURCES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                </div>
                <div>
                    <label className="mb-1 block text-[11px] text-[color:var(--fg-muted)]">
                        {t('preset.ed.model')} <span className="font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{modelKey}</span>
                    </label>
                    <input
                        className={`${inputCls} font-mono-ui`} value={boundModel} disabled={disabled}
                        placeholder={t('preset.ed.modelPh')} list={`${listId}-models`}
                        onChange={(e) => patch({ [modelKey]: e.target.value })}
                    />
                    {models && models.length > 0 && (
                        <datalist id={`${listId}-models`}>
                            {models.map((m) => <option key={m.id} value={m.id} />)}
                        </datalist>
                    )}
                </div>
            </div>

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
