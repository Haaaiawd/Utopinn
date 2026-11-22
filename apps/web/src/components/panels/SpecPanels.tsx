// 规范稿板块体:PANEL_CATALOG 七块 —— 预设/模型、MVU 变量、手记、总簿
// (CardApp 宿主)、世界书、章节、频道、卡面应用。
// 每块无 props,ctx 一律 useShell();数据获取走 api 层 ——
//   preset  → listPresets/getPreset(openai 家族,只读;写面后续)
//   mvu     → getMvuState + settle/resettle + insertOrAssignVariables(经 th)
//   notes   → chat_state get/patch(ns='notes',test-op CAS,409 提示重试)
//   ledger/cardapp → CardAppFrame 真宿主
//   lore    → 卡绑书(getCharacter→extensions.world→getWorld)+ statsInject 命中,真接线;
//   chapters/channels → 服务端面未备,保持 mock + 诚实标注(wired:false)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { CardAppFrame } from '../../cardapp/CardAppFrame';
import { MessageIframe } from '../../cardapp/MessageIframe';
import { ApiError } from '../../api/client';
import { cardData, getCharacter } from '../../api/characters';
import { getMvuState, resettleMvu, settleMvu, type MvuTarget } from '../../api/mvu';
import { thCall } from '../../api/th';
import { getChatState, patchChatState, type JsonPatchOp } from '../../api/state';
import { getPreset } from '../../api/presets';
import { statsInject } from '../../api/stats';
import { getWorld } from '../../api/worlds';
import {
    PanelEmpty, PanelError, chatKey, chatStateTarget, flattenStatData, thCallTarget, useRemote, type MvuVarRow,
} from './panelShared';

const lbl = 'mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]';
const group = 'inset-group mb-3';
const row = 'inset-row text-[12.5px]';

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button className="sh-switch" data-checked={on || undefined} onClick={onToggle}>
            <span className="sh-switch-thumb" />
        </button>
    );
}

/** 未接服务端面的板块的诚实标注行 —— launcher 的系统类网格不渲 badge,由此行独自承担标注。 */
function UnwiredNote() {
    const { t } = useI18n();
    return <p className="mb-2 px-1 text-[11px] leading-relaxed text-[color:var(--fg-faint)]">{t('panel.unwired.note')}</p>;
}

/* ----------------------------------------------------------------------- */
/* preset —— /api/utopinn/presets + /models 实时调参写回                     */
/* ----------------------------------------------------------------------- */

const PRESET_API_ID = 'openai';

function ParamSlider({ label, value, min, max, step, fmt, onChange }: {
    label: string; value: number; min: number; max: number; step: number;
    fmt: (v: number) => string;
    onChange: (v: number) => void;
}) {
    return (
        <div className="inset-row flex-col items-stretch gap-1.5">
            <div className="flex w-full justify-between text-[12px]">
                <span className="text-[color:var(--fg-secondary)]">{label}</span>
                <span className="font-mono-ui text-[11.5px]">{fmt(value)}</span>
            </div>
            <input
                type="range"
                className="h-1.5 w-full"
                min={min}
                max={max}
                step={step}
                value={Math.min(max, Math.max(min, value))}
                onChange={(e) => onChange(Number(e.target.value))}
            />
        </div>
    );
}

/** 预设 / 模型板块 —— 与壳共享实时连接/模型/预设源,滑杆与条目开关防抖写回服务端。 */
export function PresetPanel() {
    const { t } = useI18n();
    const s = useShell();
    const [jsonView, setJsonView] = useState(false);
    const activeClean = s.activePresetId ? s.activePresetId.replace(/\.json$/i, '') : '';
    const detail = useRemote(
        s.live && jsonView && activeClean ? `panel-preset:${PRESET_API_ID}/${activeClean}` : null,
        () => getPreset(activeClean, PRESET_API_ID),
    );
    const pp = s.presetParams;

    if (s.live && s.presets.length === 0) {
        return <PanelEmpty icon="sliders">{t('panel.preset.empty')} · {PRESET_API_ID}</PanelEmpty>;
    }
    return (
        <div className="p-4">
            <div className="mb-5 flex items-start justify-between gap-2">
                <div>
                    <div className="heading-tight text-[14px] font-semibold">{t('panel.preset.title')}</div>
                    <div className="mt-0.5 text-[11.5px] text-[color:var(--fg-muted)]">{t('panel.preset.sub')}</div>
                </div>
                {s.live && activeClean && (
                    <button className="ghost-btn h-7 shrink-0 px-2.5 text-[11px]" onClick={() => setJsonView(!jsonView)}>
                        {jsonView ? t('panel.mvu.table') : 'JSON'}
                    </button>
                )}
            </div>
            <div className="mb-5 space-y-3">
                <div className="relative">
                    <label className="mb-1 block text-[11px] text-[color:var(--fg-muted)]">{t('panel.preset.modelSel')}</label>
                    <button className="sh-select-trigger" onClick={() => s.setOpenDropdown(s.openDropdown === 'panel-model' ? null : 'panel-model')}>
                        <span className="truncate font-mono-ui">{s.live ? (s.models.find((m) => m.id === s.activeModel)?.short || s.activeModel || t('st.conn.noModels')) : t('stage.demoData')}</span>
                        <span className="text-[color:var(--fg-muted)]"><Icon name="chevronDown" size={12} /></span>
                    </button>
                    {s.openDropdown === 'panel-model' && (
                        <div className="sh-select-menu pop-in max-h-60 overflow-y-auto">
                            {s.live && s.models.length > 0 ? s.models.map((m) => (
                                <button key={m.id} className="inset-row-btn flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left" onClick={() => { s.setActiveModel(m.id); s.setOpenDropdown(null); }}>
                                    <div className="min-w-0 pr-2">
                                        <div className="truncate font-mono-ui text-[12px]">{m.id}</div>
                                        <div className="truncate text-[11px] text-[color:var(--fg-muted)]">{m.provider}</div>
                                    </div>
                                    {m.id === s.activeModel && <Icon name="check" size={13} className="shrink-0 text-[color:var(--brand)]" />}
                                </button>
                            )) : (
                                <div className="space-y-2 p-2.5 text-[11.5px] text-[color:var(--fg-muted)]">
                                    <div>{s.live ? (s.modelsError ?? t('st.conn.noModels')) : t('stage.demoData')}</div>
                                    <button
                                        className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium"
                                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                        onClick={() => { s.setOpenDropdown(null); s.openSettings('api'); }}
                                    >
                                        {t('st.conn.configApi')}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div className="relative">
                    <label className="mb-1 block text-[11px] text-[color:var(--fg-muted)]">{t('panel.preset.presetSel')}</label>
                    <button className="sh-select-trigger" onClick={() => s.setOpenDropdown(s.openDropdown === 'panel-preset' ? null : 'panel-preset')}>
                        <span className="truncate font-mono-ui">{activeClean || '—'}</span>
                        <span className="text-[color:var(--fg-muted)]"><Icon name="chevronDown" size={12} /></span>
                    </button>
                    {s.openDropdown === 'panel-preset' && (
                        <div className="sh-select-menu pop-in max-h-60 overflow-y-auto">
                            {s.presets.map((p) => (
                                <button key={p.id} className="inset-row-btn flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left" onClick={() => { s.pickPreset(p.id); s.setOpenDropdown(null); }}>
                                    <div className="min-w-0 pr-2">
                                        <div className="truncate font-mono-ui text-[12px]">{p.id.replace(/\.json$/i, '')}</div>
                                        <div className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">T {p.temp} · TopP {p.topP}</div>
                                    </div>
                                    {p.id === s.activePresetId && <Icon name="check" size={13} className="shrink-0 text-[color:var(--brand)]" />}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            {detail.error && <PanelError error={detail.error} onRetry={detail.reload} />}
            {jsonView && detail.data?.doc ? (
                <pre className="inset-group mb-3 overflow-x-auto p-3 font-mono-ui text-[11px] leading-relaxed text-[color:var(--fg-secondary)]">
                    {JSON.stringify(detail.data.doc, null, 2)}
                </pre>
            ) : (
                <>
                    <div className="mb-5 space-y-1.5">
                        <div className="px-0.5 text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('panel.preset.sampling')}</div>
                        <div className="inset-group">
                            <ParamSlider label={t('param.temp')} value={pp.temp} min={0} max={2} step={0.05} fmt={(v) => v.toFixed(2)} onChange={(v) => s.setPresetParam('temp', v)} />
                            <ParamSlider label={t('param.topP')} value={pp.topP} min={0.05} max={1} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => s.setPresetParam('topP', v)} />
                            <ParamSlider label={t('param.ctxLenTokens')} value={pp.ctxLen} min={4096} max={200000} step={4096} fmt={(v) => v.toLocaleString()} onChange={(v) => s.setPresetParam('ctxLen', v)} />
                            <ParamSlider label={t('param.maxReply')} value={pp.maxReply} min={128} max={16384} step={128} fmt={(v) => String(v)} onChange={(v) => s.setPresetParam('maxReply', v)} />
                        </div>
                    </div>
                    {pp.blocks.length > 0 && (
                        <div className="mb-4 space-y-1.5">
                            <div className="px-0.5 text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('panel.preset.blocksLabel')}</div>
                            <div className="inset-group">
                                {pp.blocks.map((b) => (
                                    <div key={b.id} className={row}>
                                        <span className="min-w-0 truncate text-[12.5px] text-[color:var(--fg-secondary)]">{b.name}</span>
                                        <Switch on={b.enabled} onToggle={() => s.togglePresetBlock(b.id)} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* mvu —— /api/utopinn/mvu/* 读写面                                          */
/* ----------------------------------------------------------------------- */

interface MvuReceiptEntry {
    ts?: number;
    messageIndex?: number;
    swipeId?: number;
    modified?: boolean;
    ops?: unknown[];
    errors?: unknown[];
}

/** chat_state 'mvu' 侧车 → 最近回执(新→旧,取 5 条)。 */
function readMvuReceipts(state: unknown): MvuReceiptEntry[] {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
    const ops = (state as { ops?: unknown }).ops;
    if (!Array.isArray(ops)) return [];
    return ops.filter((o): o is MvuReceiptEntry => !!o && typeof o === 'object').slice(-5).reverse();
}

const fmtTs = (ts: unknown): string => {
    const d = typeof ts === 'number' ? new Date(ts) : null;
    return d && !Number.isNaN(d.getTime())
        ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : '';
};

/** MVU 变量面板 —— getMvuState 变量表(stat_data 投影,非 MVU 会话显 chat
 *  变量)+ 数值 ± 步进(th insertOrAssignVariables 真写)+ settle/resettle
 *  动作 + 'mvu' 侧车回执日志。无变量 → 空态不装假;无 ctx → 引导态。 */
export function MvuPanel() {
    const { t } = useI18n();
    const s = useShell();
    const target = chatStateTarget(s.chat);
    const thTarget = thCallTarget(s.chat);
    const cKey = chatKey(s.chat);
    const mvuRev = (s.panelParams['mvu'] as { rev?: number } | undefined)?.rev ?? 0;
    const remote = useRemote(cKey ? `${cKey}:${mvuRev}` : null, () => getMvuState(target as MvuTarget));
    const [jsonView, setJsonView] = useState(false);
    const [busy, setBusy] = useState(false);

    const data = remote.data;
    const statData = data?.statData && typeof data.statData === 'object' && !Array.isArray(data.statData)
        ? data.statData as Record<string, unknown>
        : null;
    const chatVars = data?.chatVariables && Object.keys(data.chatVariables).length > 0 ? data.chatVariables : null;
    const vars = statData ?? chatVars;
    const rows: MvuVarRow[] = vars ? flattenStatData(vars) : [];
    const receipts = readMvuReceipts(data?.state);

    const runOp = useCallback(async (op: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await op();
            remote.reload();
        } catch (e) {
            s.hint(e instanceof Error ? e.message : String(e), true);
        } finally {
            setBusy(false);
        }
    }, [remote, s]);

    /** ± 步进:stat_data 域写 'stat_data.<path>',非 MVU chat 变量写 '<path>';
     *  [值,"说明"] 元组回写保留说明串(写裸数会吃掉 desc)。 */
    const step = useCallback((r: MvuVarRow, d: number) => {
        if (r.num === undefined || !thTarget) return;
        const path = statData ? `stat_data.${r.path}` : r.path;
        const next = r.num + d;
        const value = r.desc !== undefined ? [next, r.desc] : next;
        void runOp(() => thCall('insertOrAssignVariables', {
            type: 'chat', variables: { [path]: value },
        }, thTarget).then((res) => {
            if (res.ok === false) throw new Error('error' in res ? res.error : `unsupported: ${res.method}`);
        }));
    }, [statData, thTarget, runOp]);

    if (!target || !thTarget) return <PanelEmpty icon="database">{t('panel.needChat')}</PanelEmpty>;
    if (remote.error) return <PanelError error={remote.error} onRetry={remote.reload} />;

    return (
        <div className="space-y-3 p-4">
            <div className="flex items-center justify-between">
                <div className="heading-tight text-[13px] font-semibold text-[color:var(--fg-primary)]">
                    {t('panel.mvu.snapshot')}
                    <span className="ml-1.5 align-middle font-mono-ui text-[10px] font-normal text-[color:var(--fg-faint)]">{statData ? 'stat_data' : 'chat_variables'}</span>
                </div>
                <span className="flex items-center gap-1">
                    <button className="ghost-btn h-6 px-2 text-[10px]" disabled={busy || remote.loading} onClick={() => void runOp(() => settleMvu(target))}>{t('panel.mvu.settle')}</button>
                    <button className="ghost-btn h-6 px-2 text-[10px]" disabled={busy || remote.loading} onClick={() => void runOp(() => resettleMvu(target))}>{t('panel.mvu.resettle')}</button>
                    <button className="ghost-btn h-6 px-2 text-[10px]" onClick={() => setJsonView(!jsonView)}>{jsonView ? t('panel.mvu.table') : 'JSON'}</button>
                </span>
            </div>
            {!data ? (
                <PanelEmpty icon="database">…</PanelEmpty>
            ) : jsonView ? (
                <pre className="inset-group mb-3 overflow-x-auto p-3 font-mono-ui text-[10.5px] leading-relaxed text-[color:var(--fg-secondary)]">
                    {JSON.stringify(vars ?? null, null, 2)}
                </pre>
            ) : rows.length === 0 ? (
                <PanelEmpty icon="database" desc={t('panel.mvu.emptyDesc')}>{t('panel.mvu.empty')}</PanelEmpty>
            ) : (
                <div className={group}>
                    {rows.map((r) => (
                        /* 规范稿行:左列「键名 11px muted / 值 13px mono medium」,
                           数值键右侧 ±;非数值键无步进。 */
                        <div key={r.path} className={row} title={r.desc}>
                            <span className="min-w-0">
                                <span className="block truncate text-[11px] text-[color:var(--fg-muted)]">{r.path}</span>
                                <span className="font-mono-ui mt-0.5 block truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{r.text}</span>
                            </span>
                            {r.num !== undefined && (
                                <span className="flex items-center gap-1">
                                    <button className="ghost-btn h-6 w-6 text-xs" disabled={busy} onClick={() => step(r, -1)}><Icon name="minus" size={10} /></button>
                                    <button className="ghost-btn h-6 w-6 text-xs" disabled={busy} onClick={() => step(r, 1)}><Icon name="plus" size={10} /></button>
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
            <span className={lbl}>{t('panel.mvu.receipts')}</span>
            <div className={group}>
                {receipts.length === 0 ? (
                    <div className={row}><span className="text-[10.5px] text-[color:var(--fg-faint)]">—</span></div>
                ) : receipts.map((rc, i) => (
                    <div key={`${rc.ts ?? i}-${i}`} className={row}>
                        <span className="min-w-0">
                            <span className="block truncate text-[color:var(--fg-secondary)]">
                                {t('panel.mvu.floor')} {rc.messageIndex ?? '?'} · {rc.ops?.length ?? 0} ops
                            </span>
                            <span className="mt-0.5 block font-mono-ui text-[9px] text-[color:var(--fg-faint)]">
                                {fmtTs(rc.ts)}{rc.errors?.length ? ` · ${rc.errors.length} err` : ''}
                            </span>
                        </span>
                        <span
                            className="rounded-full px-1.5 py-px text-[9px]"
                            style={rc.modified
                                ? { background: 'var(--bg-active)', color: 'var(--brand)' }
                                : { color: 'var(--fg-faint)' }}
                        >
                            {rc.modified ? t('panel.mvu.changed') : t('panel.mvu.unchanged')}
                        </span>
                    </div>
                ))}
            </div>
            <p className="px-1 text-[9.5px] leading-relaxed text-[color:var(--fg-faint)]">{t('panel.mvu.note')}</p>
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* notes —— chat_state ns='notes' 读写面                                     */
/* ----------------------------------------------------------------------- */

/** 手记持久位:chat_state sidecar 命名空间(面板自选 ns,标注于此)。 */
const NOTES_NS = 'notes';

/** 手记板块 —— chat_state get/patch 持久化(ns='notes',doc 形 {text})。
 *  写面 = JSON-Patch CAS:doc 在 → test '' 整档一致才 add;不在 → add 直建。
 *  409 → 「状态被改,刷新重试」横幅 + 重载按钮;停笔 900ms 自动保存。 */
export function NotesPanel() {
    const { t } = useI18n();
    const s = useShell();
    const target = chatStateTarget(s.chat);
    const key = chatKey(s.chat);
    const remote = useRemote(key, () => getChatState<Record<string, unknown>>(target!, NOTES_NS));

    type Phase = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';
    const [draft, setDraft] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [err, setErr] = useState('');
    const docRef = useRef<Record<string, unknown> | null>(null);
    const draftRef = useRef('');
    const savingRef = useRef(false);
    const targetRef = useRef(target);
    targetRef.current = target;
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const appliedRef = useRef<unknown>(null);
    const loadedKeyRef = useRef<string | null>(null);
    const [loadedKey, setLoadedKey] = useState<string | null>(null);

    // 换会话:立即清本地稿(docRef 置空,陈旧 CAS 底稿不许带去新聊天)。
    useEffect(() => {
        docRef.current = null;
        draftRef.current = '';
        setDraft('');
        setPhase('idle');
    }, [key]);

    const phaseRef = useRef<Phase>('idle');
    phaseRef.current = phase;

    const queueSave = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => flushRef.current(), 900);
    }, []);

    // 远端 doc 到达(当前 key 的新回包;useRemote 换 key 已清 data,
    // 到这里的必是本会话的档)→ 覆盖本地稿与 CAS 底稿。
    // 例外:冲突态的重载只换新 CAS 底稿、保留本地稿 —— 「刷新重试」
    // 之后 dirty 复查会把用户的稿子以新底稿重发,而不是静默丢掉。
    useEffect(() => {
        if (remote.loading || remote.error || !remote.data) return;
        if (appliedRef.current === remote.data) return; // 已应用过的同份回包
        appliedRef.current = remote.data;
        const raw = remote.data.data;
        const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
        docRef.current = doc;
        const keepDraft = phaseRef.current === 'conflict';
        if (!keepDraft) {
            const text = typeof doc?.text === 'string' ? doc.text : '';
            draftRef.current = text;
            setDraft(text);
        }
        setPhase(keepDraft ? 'dirty' : 'idle');
        loadedKeyRef.current = key;
        setLoadedKey(key);
        if (keepDraft) queueSave();
    }, [remote.data, remote.loading, remote.error, key, queueSave]);

    const flush = useCallback(async () => {
        const tgt = targetRef.current;
        // 目标缺失,或回包还不是当前会话的(切换窗口期)→ 不写。
        if (!tgt || loadedKeyRef.current !== key) return;
        if (savingRef.current) return; // 在途写完成后由 dirty 复查补一轮
        const text = draftRef.current;
        const prev = docRef.current;
        // 内容没变 / 空稿且 ns 未建 → 不发请求。
        if (prev !== null && prev.text === text) { setPhase('saved'); return; }
        if (prev === null && text === '') { setPhase('idle'); return; }
        savingRef.current = true;
        setPhase('saving');
        // CAS:doc 在 → test '' 整档一致才写;不在 → add 直建。
        // 写用 add 不用 replace:服务端 patch 实现(fast-json-patch.js
        // applyReplace)要求被换键已存在,add 对缺键/既有键都成立 ——
        // CAS 已由 test '' 兜住,add 只是落笔方式。
        const ops: JsonPatchOp[] = prev === null
            ? [{ op: 'add', path: '/text', value: text }]
            : [
                { op: 'test', path: '', value: prev },
                { op: 'add', path: '/text', value: text },
            ];
        try {
            await patchChatState(tgt, NOTES_NS, ops);
            docRef.current = { ...(prev ?? {}), text };
            setPhase(draftRef.current === text ? 'saved' : 'dirty');
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) setPhase('conflict');
            else { setErr(e instanceof Error ? e.message : String(e)); setPhase('error'); }
        } finally {
            savingRef.current = false;
            if (draftRef.current !== text && phase !== 'conflict') queueSave();
        }
    }, [phase, queueSave, key]);

    const flushRef = useRef(flush);
    flushRef.current = flush;

    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    const onChange = (v: string) => {
        draftRef.current = v;
        setDraft(v);
        if (phase === 'conflict') return; // 冲突未解不再轰炸服务端,等重载
        setPhase('dirty');
        queueSave();
    };

    if (!target) return <PanelEmpty icon="note">{t('panel.needChat')}</PanelEmpty>;
    if (remote.error && !remote.data) return <PanelError error={remote.error} onRetry={remote.reload} />;

    const busy = remote.loading || !remote.data;
    const statusText = phase === 'saving' ? t('panel.notes.saving')
        : phase === 'saved' ? t('panel.notes.saved')
        : phase === 'dirty' ? t('panel.notes.dirty')
        : phase === 'error' ? `${t('panel.notes.failed')}: ${err}`
        : '';
    return (
        <div className="flex h-full flex-col gap-2 p-4">
            <div className="heading-tight text-[13px] font-semibold text-[color:var(--fg-primary)]">{t('panel.type.notes')}</div>
            <textarea
                value={draft}
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => flushRef.current()}
                disabled={busy || phase === 'conflict' || loadedKey !== key}
                spellCheck={false}
                className="min-h-0 w-full flex-1 resize-none select-text rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-3.5 text-[13px] leading-relaxed text-[color:var(--fg-primary)] outline-none focus:border-[color:var(--border-strong)]"
            />
            <div className="flex items-center justify-between px-1">
                <span className="font-mono-ui text-[9px] text-[color:var(--fg-faint)]">chat_state · ns={NOTES_NS}</span>
                {phase === 'conflict' ? (
                    <span className="flex items-center gap-1.5">
                        <span className="text-[9.5px] text-[color:var(--status-danger,#e56)]">{t('panel.notes.conflict')}</span>
                        <button className="ghost-btn h-5 px-1.5 text-[9.5px]" onClick={remote.reload}>{t('panel.notes.reload')}</button>
                    </span>
                ) : phase === 'error' ? (
                    <span className="flex items-center gap-1.5">
                        <span className="max-w-[150px] truncate text-[9.5px] text-[color:var(--status-danger,#e56)]">{statusText}</span>
                        <button className="ghost-btn h-5 px-1.5 text-[9.5px]" onClick={() => flushRef.current()}>{t('panel.retry')}</button>
                    </span>
                ) : (
                    <span className="text-[9.5px] text-[color:var(--fg-faint)]">{busy ? '…' : statusText}</span>
                )}
            </div>
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* cardapp —— CardAppFrame 真宿主                                             */
/* ----------------------------------------------------------------------- */

/** CardApp 挂载体:ctx 缺席 → 引导空态(不许拿默认卡名硬挂)。 */
function CardAppMount() {
    const { t } = useI18n();
    const s = useShell();
    const chat = s.chat;
    if (!chat?.charDir || !chat?.chatName) {
        return <PanelEmpty icon="layout">{t('panel.needChat')}</PanelEmpty>;
    }
    return <CardAppFrame charDir={chat.charDir} chatName={chat.chatName} />;
}

/** CardApp 宿主板块 —— CardAppFrame 原样;离线时它自己给诚实错误态。
 *  (旧 'ledger' 板块是 mock 账簿遗留,与 cardapp 同宿主 → 已并轨。) */
export function CardAppPanel() {
    return (
        <div className="h-full min-h-[320px]">
            <CardAppMount />
        </div>
    );
}

/** 楼层卡面板板块 —— displayed_message 嵌帧「收至右栏」的落点
 *  (category:'hidden',不进 launcher;dock 动作 openPanel 顺带写
 *  params = {charDir,chatName,html,messageId,blockIndex})。
 *  params 缺席 → 引导空态(不拿别楼块源假挂载);内容按 params
 *  原样承载 —— 同块源重铸 mount,桥语义与楼层位同份。 */
export function MessageFramePanel() {
    const { t } = useI18n();
    const s = useShell();
    const p = s.panelParams['messageframe'] as
        | { charDir?: string; chatName?: string; html?: string; messageId?: number; blockIndex?: number }
        | undefined;
    if (!p?.charDir || typeof p.html !== 'string' || !p.html.trim()) {
        return <PanelEmpty icon="layout" desc={t('msgframe.idle')}>{t('panel.type.messageframe')}</PanelEmpty>;
    }
    return (
        <div className="h-full p-1.5">
            <MessageIframe
                charDir={p.charDir}
                chatName={p.chatName}
                html={p.html}
                messageId={p.messageId}
                blockIndex={p.blockIndex}
                chrome="panel"
            />
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* lore —— 全局栈 + 当前卡绑定主书 + stats/inject 真实命中                   */
/* ----------------------------------------------------------------------- */

export function LorePanel() {
    const { t } = useI18n();
    const s = useShell();
    const cKey = chatKey(s.chat);
    const cardLore = useRemote(s.live && s.chat?.charDir ? `lore-panel:${s.chat.charDir}` : null, async () => {
        const doc = await getCharacter(s.chat!.charDir);
        const worldName = cardData(doc).extensions?.world;
        if (typeof worldName !== 'string' || !worldName.trim()) return { worldName: null, entries: [] as { uid: string; title: string; constant: boolean; order: number }[] };
        const w = await getWorld(worldName.trim());
        const entries = Object.entries(w.doc.entries ?? {})
            .filter(([, e]) => e && e.disable !== true)
            .map(([uid, e]) => ({
                uid,
                title: (typeof e.comment === 'string' && e.comment.trim())
                    || (Array.isArray(e.key) && typeof e.key[0] === 'string' && e.key[0])
                    || `#${uid}`,
                constant: e.constant === true,
                order: typeof e.order === 'number' ? e.order : 100,
            }))
            .sort((a, b) => b.order - a.order);
        return { worldName: w.name, entries };
    });
    const hits = useRemote(s.live ? `lore-hits:${cKey ?? 'all'}` : null, async () => {
        const r = await statsInject(cKey ?? undefined);
        const wi = r.sources.find((x) => x.source === 'worldinfo');
        const map = new Map<string, number>();
        for (const e of wi?.entries ?? []) {
            const k = `${String(e.world ?? '')}:${String(e.uid ?? '')}`;
            map.set(k, (map.get(k) ?? 0) + e.hits);
        }
        return map;
    });

    if (!s.live) {
        return (
            <div className="space-y-3 p-4">
                <UnwiredNote />
                <div className="heading-tight text-[13px] font-semibold text-[color:var(--fg-primary)]">{t('panel.lore.title')}</div>
                <div className={group}>
                    {s.globalLore.filter((g) => g.enabled).map((g) => (
                        <div key={g.id} className={row}>
                            <span className="truncate text-[12.5px]">[全局] {g.name}</span>
                            <span className="font-mono-ui shrink-0 text-[11px] text-[color:var(--fg-muted)]">{g.tokens}t</span>
                        </div>
                    ))}
                    {s.worldbook.filter((w) => w.enabled).map((w) => (
                        <div key={w.id} className={row}>
                            <span className="truncate text-[12.5px] text-[color:var(--fg-secondary)]">{w.title}</span>
                            <span className="font-mono-ui shrink-0 text-[11px] text-[color:var(--fg-muted)]">P{w.priority}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    const activeGlobals = s.globalLore.filter((g) => g.enabled);
    const bound = cardLore.data;
    const hitMap = hits.data;
    const isEmpty = activeGlobals.length === 0 && (!bound || bound.entries.length === 0);

    return (
        <div className="space-y-3.5 p-4">
            <div className="flex items-center justify-between">
                <div className="heading-tight text-[13.5px] font-semibold text-[color:var(--fg-primary)]">{t('panel.lore.title')}</div>
                <button
                    className="text-[11.5px] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg-primary)]"
                    onClick={() => { s.setView('studio'); s.setStudioNav(bound?.worldName ? 'worldbook' : 'global'); }}
                >
                    {t('tree.manage')}
                </button>
            </div>
            {isEmpty ? (
                <PanelEmpty icon="bookOpen">{t('stats.wi.none')}</PanelEmpty>
            ) : (
                <>
                    {activeGlobals.length > 0 && (
                        <div className={group}>
                            {activeGlobals.map((g) => (
                                <div key={g.id} className={row}>
                                    <span className="truncate text-[12.5px] text-[color:var(--fg-primary)]">[全局] {g.name}</span>
                                    <Switch on={g.enabled} onToggle={() => s.toggleGlobalLore(g.id)} />
                                </div>
                            ))}
                        </div>
                    )}
                    {bound?.worldName && bound.entries.length > 0 && (
                        <div className="space-y-1.5">
                            <div className="px-0.5 font-mono-ui text-[11px] text-[color:var(--fg-muted)]">
                                {bound.worldName} · {bound.entries.length} {t('studio.world.entriesUnit')}
                            </div>
                            <div className={group}>
                                {bound.entries.slice(0, 40).map((e) => {
                                    const h = hitMap?.get(`${bound.worldName}:${e.uid}`) ?? 0;
                                    return (
                                        <div key={e.uid} className={row}>
                                            <span className="min-w-0 truncate text-[12.5px] text-[color:var(--fg-secondary)]">{e.title}</span>
                                            <span className="shrink-0 font-mono-ui text-[11px]" style={{ color: h > 0 ? 'var(--brand)' : 'var(--fg-muted)' }}>
                                                {h > 0 ? `${h}${t('stats.wi.hits')}` : `P${e.order}`}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* chapters / channels —— 服务端面未备,保持 mock(wired:false)                */
/* ----------------------------------------------------------------------- */

/** 章节板块(规范稿 L1685):章节目录头 + inset-group 章行
 *  (num mono / title)。目录服务端 schema 未出 → mock + unwired 标注;
 *  行点选联动 novel 阅读位是真行为,保留;「+新章」原为内存假持久(硬编码
 *  标题写 mock stageData),已按审计建议删除——持久化待 chat_state 侧车。 */
export function ChaptersPanel() {
    const { t } = useI18n();
    const s = useShell();
    const chs = s.stageData.chapters;
    return (
        <div className="p-4">
            <UnwiredNote />
            <div className="mb-3 flex items-center justify-between">
                <div className="heading-tight text-[13px] font-semibold text-[color:var(--fg-primary)]">{t('panel.chapters.title')}</div>
            </div>
            <div className={group}>
                {chs.map((c) => (
                    /* 规范稿为纯展示行;点选联动 selParaId 是 impl 真行为,保留点击、
                       去掉规范稿没有的「当前」徽标。 */
                    <button
                        key={c.id}
                        className={`${row} inset-row-btn`}
                        onClick={() => s.patchStageData({ selParaId: c.paras[0]?.id ?? null })}
                    >
                        <span className="min-w-0">
                            <span className="block font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{c.num}</span>
                            <span className="mt-0.5 block truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{c.title}</span>
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

/** 频道板块 —— mock 保持:messenger 形态频道数据无服务端面。 */
export function ChannelsPanel() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="space-y-3 p-4">
            <UnwiredNote />
            <div className="heading-tight text-[13px] font-semibold">{t('panel.channels.list')}</div>
            <div className={group}>
                {s.stageData.channels.map((c) => (
                    <button
                        key={c.id}
                        className={`${row} inset-row-btn`}
                        style={s.stageData.activeChannel === c.id ? { background: 'var(--bg-active)' } : undefined}
                        onClick={() => s.patchStageData({ activeChannel: c.id })}
                    >
                        <span className="min-w-0">
                            <span className="block truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{c.name}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-[color:var(--fg-muted)]">{c.msgs.length} {t('panel.channels.msgs')}</span>
                        </span>
                        {c.unread > 0 && (
                            <span className="font-mono-ui flex h-4 w-4 items-center justify-center rounded-full text-[10px]" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}>{c.unread}</span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}
