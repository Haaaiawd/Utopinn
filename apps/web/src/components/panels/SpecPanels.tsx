// 规范稿板块体:PANEL_CATALOG 七块 —— 预设/模型、MVU 变量、手记、总簿
// (CardApp 宿主)、世界书、章节、频道、卡面应用。
// 每块无 props,ctx 一律 useShell();数据获取走 api 层 ——
//   preset  → listPresets/getPreset(openai 家族,只读;写面后续)
//   mvu     → getMvuState + settle/resettle + insertOrAssignVariables(经 th)
//   notes   → chat_state get/patch(ns='notes',test-op CAS,409 提示重试)
//   ledger/cardapp → CardAppFrame 真宿主
//   lore/chapters/channels → 服务端面未备,保持 mock + 诚实标注(wired:false)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { CardAppFrame } from '../../cardapp/CardAppFrame';
import { ApiError } from '../../api/client';
import { getMvuState, resettleMvu, settleMvu, type MvuTarget } from '../../api/mvu';
import { thCall } from '../../api/th';
import { getChatState, patchChatState, type JsonPatchOp } from '../../api/state';
import { getPreset, listPresets } from '../../api/presets';
import {
    PanelEmpty, PanelError, chatKey, chatStateTarget, flattenStatData, thCallTarget, useRemote, type MvuVarRow,
} from './panelShared';

const lbl = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]';
const group = 'inset-group mb-3';
const row = 'inset-row text-[12px]';

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button className="sh-switch" data-checked={on || undefined} onClick={onToggle}>
            <span className="sh-switch-thumb" />
        </button>
    );
}

/** 未接服务端面的板块的诚实标注行(launcher badge 同步显示「待服务端面」)。 */
function UnwiredNote() {
    const { t } = useI18n();
    return <p className="mb-2 px-1 text-[9.5px] leading-relaxed text-[color:var(--fg-faint)]">{t('panel.unwired.note')}</p>;
}

/* ----------------------------------------------------------------------- */
/* preset —— /api/utopinn/presets 只读面                                     */
/* ----------------------------------------------------------------------- */

/** 生成预设家族 —— 服务端 PRESET_FOLDER_BY_API_ID 白名单之一;家族切换留后续。 */
const PRESET_API_ID = 'openai';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 预设档 → 模型名:`<chat_completion_source>_model` 优先,兜 *_model 首值。 */
function pickPresetModel(doc: Record<string, unknown> | undefined): { source: string | null; model: string | null } {
    if (!doc) return { source: null, model: null };
    const source = str(doc.chat_completion_source);
    if (source) {
        const m = str(doc[`${source}_model`]);
        if (m) return { source, model: m };
    }
    for (const [k, v] of Object.entries(doc)) {
        if (k.endsWith('_model') && str(v)) return { source, model: str(v) };
    }
    return { source, model: null };
}

interface PresetPromptRow {
    key: string;
    name: string;
    role: string | null;
    enabled: boolean | null;
}

/** doc.prompts[] + doc.prompt_order[].order[].enabled 合成提示词条目行(只读)。 */
function presetPromptRows(doc: Record<string, unknown> | undefined): PresetPromptRow[] {
    if (!doc || !Array.isArray(doc.prompts)) return [];
    const enabled = new Map<string, boolean>();
    if (Array.isArray(doc.prompt_order)) {
        for (const po of doc.prompt_order) {
            const order = (po as { order?: unknown })?.order;
            if (!Array.isArray(order)) continue;
            for (const o of order) {
                const id = (o as { identifier?: unknown })?.identifier;
                if (typeof id === 'string') enabled.set(id, (o as { enabled?: unknown }).enabled !== false);
            }
        }
    }
    return doc.prompts.map((p, i) => {
        const o = p as { name?: unknown; identifier?: unknown; role?: unknown };
        const identifier = str(o.identifier) ?? str(o.name) ?? `prompt-${i}`;
        return {
            key: `${identifier}-${i}`,
            name: str(o.name) ?? identifier,
            role: str(o.role),
            enabled: enabled.has(identifier) ? enabled.get(identifier)! : null,
        };
    });
}

/** 预设 / 模型板块 —— /api/utopinn/presets 只读列表 + 选中档详情(参数/
 *  模型名/提示词条目全部读自真档;写面与家族切换留给后续)。 */
export function PresetPanel() {
    const { t } = useI18n();
    const s = useShell();
    const list = useRemote(PRESET_API_ID, () => listPresets(PRESET_API_ID));
    const [picked, setPicked] = useState<string | null>(null);
    const [jsonView, setJsonView] = useState(false);
    const names = list.data?.items.map((x) => x.name) ?? [];
    const active = picked && names.includes(picked) ? picked : (names[0] ?? null);
    const detail = useRemote(active ? `${PRESET_API_ID}/${active}` : null, () => getPreset(active!, PRESET_API_ID));
    const doc = detail.data?.doc as Record<string, unknown> | undefined;
    const { source, model } = pickPresetModel(doc);
    const params: [string, number | null][] = [
        [t('param.temp'), num(doc?.temperature)],
        [t('param.topP'), num(doc?.top_p)],
        [t('param.ctxLen'), num(doc?.openai_max_context)],
        [t('param.maxReply'), num(doc?.openai_max_tokens)],
    ];
    const prompts = presetPromptRows(doc);

    if (list.error) return <PanelError error={list.error} onRetry={list.reload} />;
    if (list.data && names.length === 0) {
        return <PanelEmpty icon="sliders">{t('panel.preset.empty')} · {PRESET_API_ID}</PanelEmpty>;
    }
    return (
        <div className="p-3">
            <div className="flex items-center justify-between">
                <span className={lbl} style={{ marginBottom: 0 }}>{t('panel.preset.preset')} · {PRESET_API_ID}</span>
                <button className="ghost-btn h-6 px-2 text-[10px]" onClick={() => setJsonView(!jsonView)} disabled={!doc}>
                    {jsonView ? t('panel.mvu.table') : 'JSON'}
                </button>
            </div>
            <div className="relative mb-3 mt-1">
                <button className="sh-select-trigger" onClick={() => s.setOpenDropdown(s.openDropdown === 'preset' ? null : 'preset')}>
                    <span className="truncate font-mono-ui text-[11px]">{list.data ? (active ?? '—') : '…'}</span>
                    <Icon name="chevronDown" size={12} className="text-[color:var(--fg-faint)]" />
                </button>
                {s.openDropdown === 'preset' && (
                    <div className="sh-select-menu pop-in">
                        {names.map((x) => (
                            <button key={x} className="inset-row-btn flex w-full items-center justify-between rounded-md px-2.5 py-[7px] text-[11.5px]" onClick={() => { setPicked(x); s.setOpenDropdown(null); }}>
                                <span className="truncate font-mono-ui text-[11px]">{x}</span>
                                {x === active && <Icon name="check" size={12} className="text-[color:var(--brand)]" />}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {detail.error && <PanelError error={detail.error} onRetry={detail.reload} />}
            {jsonView && doc ? (
                <pre className="inset-group mb-3 overflow-x-auto p-3 font-mono-ui text-[10.5px] leading-relaxed text-[color:var(--fg-secondary)]">
                    {JSON.stringify(doc, null, 2)}
                </pre>
            ) : (
                <>
                    <span className={lbl}>{t('panel.preset.model')}</span>
                    <div className={group}>
                        <div className={row}>
                            <span className="min-w-0 truncate font-mono-ui text-[11px] text-[color:var(--fg-primary)]">{detail.loading ? '…' : (model ?? '—')}</span>
                            <span className="font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{source ?? ''}</span>
                        </div>
                    </div>
                    <div className={group}>
                        {params.map(([name, v]) => (
                            <div key={name} className={row}>
                                <span className="text-[color:var(--fg-secondary)]">{name}</span>
                                <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-primary)]">{v ?? '—'}</span>
                            </div>
                        ))}
                    </div>
                    {prompts.length > 0 && (
                        <>
                            <span className={lbl}>{t('panel.preset.blocks')}</span>
                            <div className={group}>
                                {prompts.map((p) => (
                                    <div key={p.key} className={row}>
                                        <span className="min-w-0">
                                            <span className="block truncate text-[color:var(--fg-secondary)]">{p.name}</span>
                                            {p.role && <span className="block font-mono-ui text-[9px] text-[color:var(--fg-faint)]">{p.role}</span>}
                                        </span>
                                        {p.enabled !== null && (
                                            <span style={{ pointerEvents: 'none', opacity: 0.7 }}>
                                                <Switch on={p.enabled} onToggle={() => { }} />
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                    <p className="px-1 text-[9.5px] leading-relaxed text-[color:var(--fg-faint)]">{t('panel.preset.readonly')}</p>
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
    const remote = useRemote(chatKey(s.chat), () => getMvuState(target as MvuTarget));
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
        <div className="p-3">
            <div className="mb-2 flex items-center justify-between">
                <span className={lbl} style={{ marginBottom: 0 }}>
                    {t('panel.mvu.vars')} · {statData ? 'stat_data' : 'chat_variables'}
                </span>
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
                <PanelEmpty icon="database">{t('panel.mvu.empty')}</PanelEmpty>
            ) : (
                <div className={group}>
                    {rows.map((r) => (
                        <div key={r.path} className={row} title={r.desc}>
                            <span className="min-w-0 truncate text-[color:var(--fg-secondary)]">{r.path}</span>
                            <span className="flex items-center gap-1.5">
                                {r.num !== undefined && (
                                    <button className="ghost-btn h-5 w-5 text-[10px]" disabled={busy} onClick={() => step(r, -1)}><Icon name="minus" size={9} /></button>
                                )}
                                <span className="min-w-10 text-right font-mono-ui text-[11px] text-[color:var(--fg-primary)]">{r.text}</span>
                                {r.num !== undefined && (
                                    <button className="ghost-btn h-5 w-5 text-[10px]" disabled={busy} onClick={() => step(r, 1)}><Icon name="plus" size={9} /></button>
                                )}
                            </span>
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
        <div className="flex h-full flex-col p-3">
            <textarea
                value={draft}
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => flushRef.current()}
                disabled={busy || phase === 'conflict' || loadedKey !== key}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-[10px] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-3 font-mono-ui text-[11.5px] leading-relaxed text-[color:var(--fg-secondary)] outline-none focus:border-[color:var(--border-strong)]"
            />
            <div className="mt-2 flex items-center justify-between px-1">
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
/* ledger / cardapp —— CardAppFrame 真宿主                                    */
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

/** 总簿板块 —— CardApp 宿主:卡的 CardApp 自己渲总簿页。规范稿 mock 账簿
 *  的写死键(灵石/大殿耐久 平铺)对不上真 stat_data 契约(资源.灵石 嵌套、
 *  无耐久字段),面板体让位真宿主,不再维护假 schema。 */
export function LedgerPanel() {
    return (
        <div className="h-full min-h-[320px]">
            <CardAppMount />
        </div>
    );
}

/** CardApp 宿主板块 —— CardAppFrame 原样;离线时它自己给诚实错误态。 */
export function CardAppPanel() {
    return (
        <div className="h-full min-h-[320px]">
            <CardAppMount />
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* lore / chapters / channels —— 服务端面未备,保持 mock(wired:false)         */
/* ----------------------------------------------------------------------- */

/** 世界书板块 —— mock 保持:面板要的是卡绑定条目栈(主/辅/聊天/全局四层
 *  来源),/api/utopinn/worlds 只有整档 CRUD,绑定面未出。 */
export function LorePanel() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="p-3">
            <UnwiredNote />
            <span className={lbl}>{t('panel.lore.entries')}</span>
            <div className={group}>
                {s.worldbook.map((w) => (
                    <button key={w.id} className={`${row} inset-row-btn`} onClick={() => s.setSelectedLoreId(w.id)}>
                        <span className="min-w-0">
                            <span className="block truncate text-[color:var(--fg-primary)]">{w.title}</span>
                            <span className="mt-0.5 block text-[10px] text-[color:var(--fg-faint)]">
                                {w.type} · P{w.priority} · {w.tokens} tok
                            </span>
                        </span>
                        <Switch on={w.enabled} onToggle={() => {}} />
                    </button>
                ))}
            </div>
            <span className={lbl}>{t('panel.lore.global')}</span>
            <div className={group}>
                {s.globalLore.map((g) => (
                    <div key={g.id} className={row}>
                        <span className="min-w-0">
                            <span className="block truncate text-[color:var(--fg-primary)]">{g.name}</span>
                            <span className="mt-0.5 block font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{g.file} · {g.tokens} tok</span>
                        </span>
                        <Switch on={g.enabled} onToggle={() => s.toggleGlobalLore(g.id)} />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** 章节板块 —— mock 保持:novel 形态会话目录的服务端 schema 未出。 */
export function ChaptersPanel() {
    const { t } = useI18n();
    const s = useShell();
    const chs = s.stageData.chapters;
    return (
        <div className="p-3">
            <UnwiredNote />
            <div className={group}>
                {chs.map((c, i) => {
                    const active = s.chat?.stage === 'novel';
                    return (
                        <button
                            key={c.id}
                            className={`${row} inset-row-btn`}
                            onClick={() => s.patchStageData({ selParaId: c.paras[0]?.id ?? null })}
                        >
                            <span className="min-w-0">
                                <span className="block truncate text-[color:var(--fg-primary)]">{c.num} · {c.title}</span>
                                <span className="mt-0.5 block text-[10px] text-[color:var(--fg-faint)]">{c.paras.length} {t('panel.chapters.paras')}</span>
                            </span>
                            {i === chs.length - 1 && active && (
                                <span className="rounded-full px-1.5 py-px text-[9px]" style={{ background: 'var(--bg-active)', color: 'var(--brand)' }}>{t('panel.chapters.current')}</span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** 频道板块 —— mock 保持:messenger 形态频道数据无服务端面。 */
export function ChannelsPanel() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="p-3">
            <UnwiredNote />
            <div className={group}>
                {s.stageData.channels.map((c) => (
                    <button
                        key={c.id}
                        className={`${row} inset-row-btn`}
                        style={s.stageData.activeChannel === c.id ? { background: 'var(--bg-active)' } : undefined}
                        onClick={() => s.patchStageData({ activeChannel: c.id })}
                    >
                        <span className="min-w-0">
                            <span className="block truncate text-[color:var(--fg-primary)]">{c.name}</span>
                            {c.notice && <span className="mt-0.5 block truncate text-[10px] text-[color:var(--fg-faint)]">{c.notice}</span>}
                        </span>
                        {c.unread > 0 && (
                            <span className="rounded-full px-1.5 py-px text-[9.5px] font-medium" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}>{c.unread}</span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}
