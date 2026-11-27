// Automation panel — single management surface for the three script-flavored
// capabilities that already run on the server but were scattered or hidden:
//
//   commands  GET /api/utopinn/script/commands registry snapshot — browseable
//             (until now only the composer `/` autocomplete consumed it); each
//             command expands to help/args and can be run against the current
//             chat via POST /script/run. Parked runs (/input /popup /buttons)
//             have no modal surface here → aborted server-side with an honest
//             "use the composer" note.
//   regex     GET /api/utopinn/regex full view — all three scopes (global /
//             char / preset) with per-script PATCH toggle + edit, DELETE, PUT
//             add, and the preset `allowed` gate (PUT allow). The preset scope
//             is the reachability fix: studio's regex page only lists
//             global/char (its own headnote defers preset scripts to the
//             preset editor), so this is where preset regex becomes editable.
//   quick     QuickReply sets + bindings: enabled-state for the current chat
//             (global+char+chat scope union, same semantics as the composer
//             strip), per-set toggle writes back to settings + chat_metadata;
//             `/` entries run through the same script runner, text entries are
//             marked composer-side (they send as user input there).
//
// Zero new server surface — everything rides existing api/th, api/regex,
// api/quickreplies layers. Pure view-model helpers live in lib/automation.ts.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { PanelEmpty, PanelError, useRemote } from './panelShared';
import { apiPost } from '../../api/client';
import { listScriptCommands, type ScriptCommandInfo } from '../../api/th';
import type { PresetDocument } from '../../api/presets';
import {
    deleteRegexScript, deleteRegexScriptByContent, getRegexFullView, mutateRegexScope,
    patchRegexScript, patchRegexScriptByContent, putRegexScope, RegexScriptMovedError,
    type RegexScopeTarget, type RegexScriptData,
} from '../../api/regex';
import {
    getQrSet, listQrSets, newQrSetDoc,
    qrBound, qrCharScopeKey,
    qrConfigWithLink, qrEnabledNames, qrStudioFocus, qrv2WithSetVisible,
    saveQrSet, type QrConfig, type QrSettings,
} from '../../api/quickreplies';
import {
    addPresetRegex, patchPresetRegexByKey, presetRegexKeyOf, presetRegexScripts,
    removePresetRegexByKey, togglePresetRegexByKey,
} from './presetRegex';
import {
    flushPresetDoc, flushQrChatCfg, flushQrSettings, invalidateSharedDocs,
    mutatePresetDoc, mutateQrChatCfg, mutateQrSettings,
    usePresetDoc, useQrChatCfg, useQrSettings,
} from '../../kernel/docStores';
import {
    commandScriptLine, filterCommands, flatItemsForPreset, flattenRegexView, qrEntryKind,
    regexDraftOf, regexNewScript, regexPatchFromDraft, scriptResultLines,
    REGEX_PLACEMENTS, type RegexEditDraft, type RegexFlatItem, type RegexGroupView,
    type ScriptResultLine, type ScriptRunRes,
} from '../../lib/automation';

const lbl = 'mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]';
const group = 'inset-group mb-3';
const row = 'inset-row text-[12.5px]';
const inputCls = 'h-8 w-full rounded-lg px-2.5 text-xs outline-none';
const inputStyle = { background: 'var(--bg-canvas)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' } as const;
const monoInputCls = 'h-8 w-full rounded-lg px-2.5 font-mono-ui text-xs outline-none';

function Switch({ on, onToggle, disabled, title }: { on: boolean; onToggle?: () => void; disabled?: boolean; title?: string }) {
    return (
        <button
            className="sh-switch"
            data-checked={on || undefined}
            onClick={disabled ? undefined : onToggle}
            disabled={disabled}
            title={title}
            style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
        >
            <span className="sh-switch-thumb" />
        </button>
    );
}

/** Small mono badge — honest state markers only (in_use / active / shared…). */
function Tag({ children, brand }: { children: ReactNode; brand?: boolean }) {
    return (
        <span
            className="shrink-0 rounded px-1.5 py-px font-mono-ui text-[9.5px]"
            style={brand
                ? { background: 'var(--bg-active)', color: 'var(--brand)' }
                : { color: 'var(--fg-faint)', border: '1px solid var(--border-hairline)' }}
        >
            {children}
        </span>
    );
}

/* ----------------------------------------------------------------------- */
/* shared script runner — run + abort parked runs + navigation ops          */
/* ----------------------------------------------------------------------- */

/**
 * POST /script/run with the current chat as env (group chats → env-less run,
 * same rule as the composer). Parked runs are aborted server-side — the
 * panel has no awaiting modal, so `awaiting` is answered honestly instead of
 * leaving a zombie run in the registry TTL. Navigation ops (go/close-chat)
 * are honored at shell level so session-mutating commands do something real.
 */
function useScriptRun() {
    const s = useShell();
    const { t } = useI18n();
    return useCallback(async (script: string): Promise<ScriptResultLine[]> => {
        const chat = s.chat;
        const ctx = chat && !chat.groupId && chat.charDir && chat.chatName
            ? { charDir: chat.charDir, chatName: chat.chatName }
            : {};
        /* A script can cut/edit floors mid-run — the transcript's index-
           addressed actions must not stay live on pre-mutation indexes.
           begin marks the window (StageFrame guards floor ops while >0);
           the revision bump after the run makes the stale state explicit
           until the refetch lands (review 🔴5). */
        s.beginChatMutation();
        try {
            let res = await apiPost<ScriptRunRes>('/api/utopinn/script/run', { script, ...ctx });
            let parked = false;
            while (res.awaiting?.runId) {
                res = await apiPost<ScriptRunRes>('/api/utopinn/script/interact', {
                    runId: res.awaiting.runId, action: 'abort',
                });
                parked = true;
            }
            const ops = (res.ops ?? [])
                .map((raw) => (raw && typeof raw === 'object' ? raw as { type?: string; kind?: string; charDir?: string; chatName?: string } : null))
                .filter((op): op is NonNullable<typeof op> => op != null);
            for (const op of ops) {
                if (op.type === 'go' && op.charDir && op.chatName) {
                    await s.refreshChats();
                    s.selectChat(`${op.charDir}/${op.chatName}`);
                } else if (op.type === 'custom' && op.kind === 'close-chat') {
                    /* chat already deleted server-side; drop selection so the
                       stage's 404 fallback never reselects the corpse. */
                    await s.refreshChats();
                    s.selectChat('');
                }
            }
            /* Scripts can mutate floors (/cut etc.) and any shared doc
               server-side (preset regex via TH, QR links, variables). The
               bump makes StageFrame refetch before floor actions go live
               again; shared docs re-pull so edit surfaces converge. */
            s.notifyChatMutation();
            invalidateSharedDocs();
            const lines = scriptResultLines(res);
            if (parked) lines.unshift({ text: t('panel.auto.runInteractive'), err: true });
            if (!lines.length) lines.push({ text: t('panel.auto.runDone'), err: false });
            return lines;
        } finally {
            s.endChatMutation();
        }
    }, [s, t]);
}

/* ----------------------------------------------------------------------- */
/* section: commands — registry browse + run                              */
/* ----------------------------------------------------------------------- */

const CMD_PAGE = 150;

function CommandsSection({ run }: { run: (script: string) => Promise<ScriptResultLine[]> }) {
    const { t } = useI18n();
    const s = useShell();
    const remote = useRemote(s.live ? 'script:commands' : null, listScriptCommands);
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState<string | null>(null);
    const [args, setArgs] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ cmd: string; lines: ScriptResultLine[] } | null>(null);

    const filtered = useMemo(() => filterCommands(remote.data ?? [], query), [remote.data, query]);
    const shown = filtered.slice(0, CMD_PAGE);

    const doRun = (c: ScriptCommandInfo) => {
        if (busy) return;
        setBusy(true);
        run(commandScriptLine(c.name, args))
            .then((lines) => setResult({ cmd: c.name, lines }))
            .catch((e) => setResult({ cmd: c.name, lines: [{ text: e instanceof Error ? e.message : String(e), err: true }] }))
            .finally(() => setBusy(false));
    };

    if (remote.error) return <PanelError error={remote.error} onRetry={remote.reload} />;
    if (!remote.data) return <PanelEmpty icon="command">…</PanelEmpty>;

    return (
        <div className="space-y-3">
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('panel.auto.cmd.search')}
                className={inputCls}
                style={inputStyle}
            />
            {filtered.length === 0 ? (
                <PanelEmpty icon="command" desc={t('panel.auto.cmd.emptyDesc')}>{t('panel.auto.cmd.empty')}</PanelEmpty>
            ) : (
                <div className={group}>
                    {shown.map((c) => {
                        const isOpen = open === c.name;
                        return (
                            <div key={c.name}>
                                <button
                                    className={`${row} inset-row-btn`}
                                    onClick={() => { setOpen(isOpen ? null : c.name); setArgs(''); }}
                                >
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-1.5">
                                            <span className="shrink-0 font-mono-ui text-[12px] font-medium text-[color:var(--fg-primary)]">/{c.name}</span>
                                            {c.aliases.length > 0 && (
                                                <span className="truncate font-mono-ui text-[10px] text-[color:var(--fg-faint)]">
                                                    {c.aliases.map((a) => `/${a}`).join(' ')}
                                                </span>
                                            )}
                                        </span>
                                        {c.help && (
                                            <span className="mt-0.5 block truncate text-[11px] text-[color:var(--fg-muted)]">{c.help}</span>
                                        )}
                                    </span>
                                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} className="shrink-0 text-[color:var(--fg-faint)]" />
                                </button>
                                {isOpen && (
                                    <div className="space-y-2 border-t border-[color:var(--border-hairline)] px-3.5 py-2.5" style={{ background: 'var(--bg-canvas)' }}>
                                        {c.help && <p className="text-[11.5px] leading-relaxed text-[color:var(--fg-secondary)]">{c.help}</p>}
                                        {c.args.length > 0 && (
                                            <div className="space-y-0.5">
                                                <span className="block font-mono-ui text-[9.5px] uppercase tracking-wide text-[color:var(--fg-faint)]">{t('panel.auto.cmd.args')}</span>
                                                {c.args.map((a) => (
                                                    <div key={a.name} className="flex items-baseline gap-2 font-mono-ui text-[10.5px]">
                                                        <span className="text-[color:var(--fg-primary)]">{a.name}</span>
                                                        {a.required && <span className="text-[9px]" style={{ color: 'var(--status-danger)' }}>{t('panel.auto.cmd.required')}</span>}
                                                        {a.def !== null && <span className="truncate text-[color:var(--fg-faint)]">= {a.def}</span>}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {c.unnamed.length > 0 && (
                                            <div className="font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">
                                                {c.unnamed.map((u) => `<${u}>`).join(' ')}
                                            </div>
                                        )}
                                        {c.returns && (
                                            <div className="font-mono-ui text-[10px] text-[color:var(--fg-faint)]">→ {c.returns}</div>
                                        )}
                                        <div className="flex items-center gap-1.5 pt-0.5">
                                            <input
                                                value={args}
                                                onChange={(e) => setArgs(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') doRun(c); }}
                                                placeholder={t('panel.auto.cmd.argsPh')}
                                                className="h-7 min-w-0 flex-1 rounded-md px-2 font-mono-ui text-[11px] outline-none"
                                                style={inputStyle}
                                            />
                                            <button
                                                className="h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium"
                                                style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: busy ? 0.5 : 1 }}
                                                disabled={busy}
                                                onClick={() => doRun(c)}
                                            >
                                                {t('panel.auto.cmd.run')}
                                            </button>
                                        </div>
                                        {result?.cmd === c.name && result.lines.map((l, i) => (
                                            <p
                                                key={i}
                                                className="whitespace-pre-wrap break-all font-mono-ui text-[10.5px] leading-relaxed"
                                                style={{ color: l.err ? 'var(--status-danger)' : 'var(--fg-secondary)' }}
                                            >
                                                {l.text}
                                            </p>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {filtered.length > shown.length && (
                        <div className={row}>
                            <span className="text-[10.5px] text-[color:var(--fg-faint)]">+{filtered.length - shown.length}…</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* section: regex — three-scope management                                */
/* ----------------------------------------------------------------------- */

const PLACEMENT_LABEL: Record<number, string> = {
    1: 'panel.auto.rx.pl1', 2: 'panel.auto.rx.pl2', 3: 'panel.auto.rx.pl3',
    5: 'panel.auto.rx.pl5', 6: 'panel.auto.rx.pl6',
};

function RegexEditForm({ draft, busy, onChange, onCancel, onSave }: {
    draft: RegexEditDraft; busy: boolean;
    onChange: (d: RegexEditDraft) => void; onCancel: () => void; onSave: () => void;
}) {
    const { t } = useI18n();
    const set = (p: Partial<RegexEditDraft>) => onChange({ ...draft, ...p });
    const flag = (k: keyof RegexEditDraft, key: string) => (
        <label className="flex items-center justify-between gap-2 py-0.5 text-[11.5px] text-[color:var(--fg-secondary)]">
            {t(key)}
            <Switch on={draft[k] === true} onToggle={() => set({ [k]: !(draft[k] === true) } as Partial<RegexEditDraft>)} />
        </label>
    );
    return (
        <div className="space-y-2 border-t border-[color:var(--border-hairline)] px-3.5 py-3" style={{ background: 'var(--bg-canvas)' }}>
            <input
                value={draft.scriptName}
                onChange={(e) => set({ scriptName: e.target.value })}
                placeholder={t('panel.auto.rx.f.name')}
                className={inputCls} style={inputStyle}
            />
            <input
                value={draft.findRegex}
                onChange={(e) => set({ findRegex: e.target.value })}
                placeholder={t('panel.auto.rx.f.find')}
                className={monoInputCls} style={inputStyle}
            />
            <textarea
                value={draft.replaceString}
                onChange={(e) => set({ replaceString: e.target.value })}
                placeholder={t('panel.auto.rx.f.replace')}
                rows={2}
                className="w-full resize-none rounded-lg p-2.5 font-mono-ui text-xs outline-none"
                style={inputStyle}
            />
            <div className="grid grid-cols-2 gap-x-3">
                {flag('disabled', 'panel.auto.rx.f.disabled')}
                {flag('markdownOnly', 'panel.auto.rx.f.mdOnly')}
                {flag('promptOnly', 'panel.auto.rx.f.promptOnly')}
                {flag('runOnEdit', 'panel.auto.rx.f.runOnEdit')}
            </div>
            <div>
                <span className="mb-1 block font-mono-ui text-[9.5px] uppercase tracking-wide text-[color:var(--fg-faint)]">{t('panel.auto.rx.f.placement')}</span>
                <div className="flex flex-wrap gap-1">
                    {REGEX_PLACEMENTS.map((p) => {
                        const on = draft.placement.has(p);
                        return (
                            <button
                                key={p}
                                type="button"
                                className="h-6 rounded-full px-2 font-mono-ui text-[10px] transition-colors"
                                style={on
                                    ? { background: 'var(--bg-active)', color: 'var(--brand)', border: '1px solid var(--brand)' }
                                    : { color: 'var(--fg-muted)', border: '1px solid var(--border-hairline)' }}
                                onClick={() => {
                                    const next = new Set(draft.placement);
                                    if (next.has(p)) next.delete(p); else next.add(p);
                                    set({ placement: next });
                                }}
                            >
                                {t(PLACEMENT_LABEL[p]!)}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className="flex items-center gap-2">
                <span className="shrink-0 font-mono-ui text-[9.5px] uppercase tracking-wide text-[color:var(--fg-faint)]">{t('panel.auto.rx.f.depth')}</span>
                <input
                    value={draft.minDepth} inputMode="numeric"
                    onChange={(e) => set({ minDepth: e.target.value })}
                    placeholder="min" className="h-7 w-16 rounded-md px-2 font-mono-ui text-[11px] outline-none" style={inputStyle}
                />
                <input
                    value={draft.maxDepth} inputMode="numeric"
                    onChange={(e) => set({ maxDepth: e.target.value })}
                    placeholder="max" className="h-7 w-16 rounded-md px-2 font-mono-ui text-[11px] outline-none" style={inputStyle}
                />
            </div>
            <div className="flex justify-end gap-2 pt-0.5">
                <button className="ghost-btn h-7 rounded-md px-2.5 text-[11.5px]" onClick={onCancel}>{t('panel.auto.rx.cancel')}</button>
                <button
                    className="h-7 rounded-lg px-3 text-[11.5px] font-medium"
                    style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: busy || !draft.findRegex.trim() ? 0.5 : 1 }}
                    disabled={busy || !draft.findRegex.trim()}
                    onClick={onSave}
                >
                    {t('panel.auto.rx.save')}
                </button>
            </div>
        </div>
    );
}

function RegexGroupBlock({ g, busyKey, editing, draft, onToggle, onEdit, onDelete, onDraft, onCancelEdit, onSaveEdit, onAdd, onGate }: {
    g: RegexGroupView; busyKey: string | null;
    editing: string | null; draft: RegexEditDraft | null;
    onToggle: (r: RegexFlatItem) => void; onEdit: (r: RegexFlatItem) => void; onDelete: (r: RegexFlatItem) => void;
    onDraft: (d: RegexEditDraft) => void; onCancelEdit: () => void; onSaveEdit: () => void;
    onAdd: () => void; onGate?: (on: boolean) => void;
}) {
    const { t } = useI18n();
    /* Preset groups render from the shared doc store — the SAME doc the
       preset editors write. Rows made here are id/identity-addressed into
       that doc, so a full-view snapshot can never shift a write onto the
       wrong script; global/char groups keep the server view. */
    const pT = g.target.scope === 'preset' ? g.target : null;
    const snap = usePresetDoc(pT?.apiId ?? 'openai', pT?.preset ?? null);
    const items = pT && snap.doc
        ? flatItemsForPreset(pT.apiId, pT.preset, presetRegexScripts(snap.doc))
        : g.items;
    return (
        <div className={group}>
            {/* group header — scope identity + honest badges + gate + add */}
            <div className="inset-row gap-2 py-2.5" style={{ background: 'var(--bg-canvas)' }}>
                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-semibold text-[color:var(--fg-primary)]">{g.title}</span>
                        {g.inUse && <Tag brand>{t('panel.auto.rx.inUse')}</Tag>}
                        {g.active && <Tag>{t('panel.auto.rx.active')}</Tag>}
                        {g.shared && <Tag>{t('panel.auto.rx.shared')}</Tag>}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 font-mono-ui text-[10px] text-[color:var(--fg-faint)]">
                        {g.sub && <span className="truncate">{g.sub}</span>}
                        {g.kind === 'char' && <span>· {t('panel.auto.rx.autoAllowed')}</span>}
                        {g.gate && !g.gate.allowed && <span>· {t('panel.auto.rx.gateOff')}</span>}
                    </span>
                </span>
                {g.gate && onGate && (
                    <span title={t('panel.auto.rx.allowed')}>
                        <Switch on={g.gate.allowed} disabled={busyKey !== null} onToggle={() => onGate(!g.gate!.allowed)} />
                    </span>
                )}
                <button className="ghost-btn h-6 w-6 shrink-0" title={t('panel.auto.rx.new')} disabled={busyKey !== null} onClick={onAdd}>
                    <Icon name="plus" size={12} />
                </button>
            </div>
            {editing === `new:${g.key}` && draft && (
                <RegexEditForm draft={draft} busy={busyKey !== null} onChange={onDraft} onCancel={onCancelEdit} onSave={onSaveEdit} />
            )}
            {items.map((r) => {
                const on = r.script.disabled !== true;
                const isEditing = editing === r.key;
                return (
                    <div key={r.key}>
                        <div className={row} style={!on ? { opacity: 0.55 } : undefined}>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">
                                    {r.script.scriptName || t('panel.auto.rx.unnamed')}
                                </div>
                                {r.script.findRegex && (
                                    <div className="mt-0.5 truncate font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{r.script.findRegex}</div>
                                )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <Switch on={on} disabled={busyKey === r.key} onToggle={() => onToggle(r)} />
                                <button className="ghost-btn h-6 w-6" disabled={busyKey !== null} title={t('studio.persona.edit')} onClick={() => onEdit(r)}>
                                    <Icon name="pencil" size={12} />
                                </button>
                                <button className="ghost-btn h-6 w-6" disabled={busyKey !== null} title={t('studio.persona.delete')} style={{ color: 'var(--status-danger)' }} onClick={() => onDelete(r)}>
                                    <Icon name="trash" size={12} />
                                </button>
                            </div>
                        </div>
                        {isEditing && draft && (
                            <RegexEditForm draft={draft} busy={busyKey !== null} onChange={onDraft} onCancel={onCancelEdit} onSave={onSaveEdit} />
                        )}
                    </div>
                );
            })}
            {items.length === 0 && (
                <div className={row}><span className="text-[10.5px] text-[color:var(--fg-faint)]">—</span></div>
            )}
        </div>
    );
}

function RegexSection() {
    const { t } = useI18n();
    const s = useShell();
    const full = useRemote(s.live ? 'regex:full' : null, getRegexFullView);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    /** editing: item.key for patches, `new:<groupKey>` for creates. */
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<RegexEditDraft | null>(null);
    /** Create-mode context — which scope the new script lands in. The old
       code also snapshotted the group's script array here and PUT it back
       whole — a stale base that dropped rows added elsewhere. Now the
       transform itself re-reads current state (doc lane / fresh scope). */
    const [createCtx, setCreateCtx] = useState<{ target: RegexScopeTarget } | null>(null);
    /** The item being edited — preset rows may render from the shared doc
       store while the full view lags a flush behind, so the row object is
       stashed at startEdit instead of re-found by key at save time. */
    const [editItem, setEditItem] = useState<RegexFlatItem | null>(null);

    const groups = useMemo(() => (full.data ? flattenRegexView(full.data) : []), [full.data]);
    const fail = (e: unknown) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true);
    const act = (key: string, op: () => Promise<unknown>) => {
        if (busyKey) return;
        setBusyKey(key);
        void op()
            .then(() => { setEditing(null); setDraft(null); setCreateCtx(null); setEditItem(null); full.reload(); })
            .catch((e) => {
                fail(e);
                /* The captured script is gone/changed server-side — pull a
                   fresh view so the next op resolves against real rows. */
                if (e instanceof RegexScriptMovedError) full.reload();
            })
            .finally(() => setBusyKey(null));
    };

    /* Id-less scripts have NO stable :id — the API falls back to the array
       index, which is whichever snapshot this view rendered. That was the
       original #65/#70 bug shape: send the old index, hit a neighbour.
       Instead route through mutateRegexScope's serial GET→fn→PUT chain
       and locate by deep-equal CONTENT on the fresh array (review 🔴4;
       the same trap existed on toggle/edit — all three go by content). */
    const idOp = (r: RegexFlatItem): r is RegexFlatItem & { idOrIdx: string } =>
        typeof r.idOrIdx === 'string';

    /* Preset-scope rows route through the shared doc lane: the mutation
       is addressed by stable key (id, or the rendered script object for
       id-less entries) against the SAME doc the preset editors hold —
       never an index into a stale snapshot. flush() lands it immediately. */
    const presetOp = (r: RegexFlatItem, fn: (d: PresetDocument) => PresetDocument) =>
        act(r.key, async () => {
            const t = r.target as { apiId: string; preset: string };
            mutatePresetDoc(t.apiId, t.preset, fn);
            await flushPresetDoc(t.apiId, t.preset);
        });

    const toggleRow = (r: RegexFlatItem) =>
        r.target.scope === 'preset'
            ? presetOp(r, (d) => togglePresetRegexByKey(d, presetRegexKeyOf(r.script)))
            : act(r.key, () => idOp(r)
                ? patchRegexScript(r.target, r.idOrIdx, { disabled: !r.script.disabled })
                : patchRegexScriptByContent(r.target, r.script, { disabled: !r.script.disabled }));
    const removeRow = (r: RegexFlatItem) => {
        const label = r.script.scriptName || String(r.idOrIdx);
        if (!window.confirm(`${t('panel.auto.rx.delConfirm')}\n${label}`)) return;
        if (r.target.scope === 'preset') presetOp(r, (d) => removePresetRegexByKey(d, presetRegexKeyOf(r.script)));
        else act(r.key, () => idOp(r)
            ? deleteRegexScript(r.target, r.idOrIdx)
            : deleteRegexScriptByContent(r.target, r.script));
    };
    const startEdit = (r: RegexFlatItem) => {
        setEditing(r.key); setDraft(regexDraftOf(r.script));
        setCreateCtx(null); setEditItem(r);
    };
    const startAdd = (g: RegexGroupView) => {
        setEditing(`new:${g.key}`);
        setDraft(regexDraftOf());
        setCreateCtx({ target: g.target });
        setEditItem(null);
    };
    const saveEdit = () => {
        if (!draft) return;
        if (editing?.startsWith('new:') && createCtx) {
            const t = createCtx.target;
            const sc = regexNewScript(draft, `rx-${Date.now()}`);
            if (t.scope === 'preset') {
                act('new', async () => {
                    mutatePresetDoc(t.apiId, t.preset, (d) => addPresetRegex(d, sc));
                    await flushPresetDoc(t.apiId, t.preset);
                });
            } else {
                /* Whole-array PUT is blind — mutateRegexScope re-reads the
                   scope inside a serialized chain so the append lands on
                   the freshest array. */
                act('new', () => mutateRegexScope(t, (arr) => [...arr, sc]));
            }
            return;
        }
        if (!editItem) return;
        const set = regexPatchFromDraft(draft);
        if (editItem.target.scope === 'preset') {
            presetOp(editItem, (d) => patchPresetRegexByKey(d, presetRegexKeyOf(editItem.script), set));
        } else {
            act(editItem.key, () => idOp(editItem)
                ? patchRegexScript(editItem.target, editItem.idOrIdx, set)
                : patchRegexScriptByContent(editItem.target, editItem.script, set));
        }
    };

    if (full.error) return <PanelError error={full.error} onRetry={full.reload} />;
    if (!full.data) return <PanelEmpty icon="code">…</PanelEmpty>;

    const kinds: { kind: RegexGroupView['kind']; label: string }[] = [
        { kind: 'global', label: t('panel.auto.rx.global') },
        { kind: 'char', label: t('panel.auto.rx.chars') },
        { kind: 'preset', label: t('panel.auto.rx.presets') },
    ];
    return (
        <div>
            {full.data.extensionDisabled && (
                <p className="mb-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--status-warn)' }}>
                    {t('panel.auto.rx.extOff')}
                </p>
            )}
            {groups.length === 0 && <PanelEmpty icon="code">{t('panel.auto.rx.empty')}</PanelEmpty>}
            {kinds.map(({ kind, label }) => {
                const gs = groups.filter((g) => g.kind === kind);
                if (!gs.length) return null;
                return (
                    <div key={kind} className="mb-3">
                        <span className={lbl}>{label}</span>
                        {gs.map((g) => (
                            <RegexGroupBlock
                                key={g.key} g={g} busyKey={busyKey}
                                editing={editing} draft={draft}
                                onToggle={toggleRow} onEdit={startEdit} onDelete={removeRow}
                                onDraft={setDraft}
                                onCancelEdit={() => { setEditing(null); setDraft(null); setCreateCtx(null); setEditItem(null); }}
                                onSaveEdit={saveEdit}
                                onAdd={() => startAdd(g)}
                                onGate={g.gate
                                    ? (on) => act(`gate:${g.key}`, () => putRegexScope(g.target, { allow: on }))
                                    : undefined}
                            />
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* section: quick replies — sets + bindings + trigger                     */
/* ----------------------------------------------------------------------- */

function QuickSection({ run }: { run: (script: string) => Promise<ScriptResultLine[]> }) {
    const { t } = useI18n();
    const s = useShell();
    /* names: live list; settings/chatCfg: shared stores — the composer
       strip and studio QR page toggle the SAME docs, so a write here
       can't revert a toggle made on another surface. */
    const names = useRemote(s.live ? 'qr:names' : null, listQrSets);
    const qrSnap = useQrSettings();
    const qr = qrSnap.doc;
    const chat = s.chat;
    const canBindChat = !!chat && !chat.groupId && !!chat.charDir && !!chat.chatName;
    const cfgSnap = useQrChatCfg(canBindChat ? chat!.charDir : null, canBindChat ? chat!.chatName : null);
    const chatCfg = cfgSnap.doc;
    const [sel, setSel] = useState('');
    const [newName, setNewName] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [result, setResult] = useState<{ id: number; lines: ScriptResultLine[] } | null>(null);

    const charKey = chat?.charDir
        ? qrCharScopeKey(s.cards.get(chat.charDir)?.avatar ?? null, chat.charDir)
        : null;
    const canBind = !!chat && !chat.groupId;

    const ns = names.data ?? [];
    const enabled = qrEnabledNames(qr, charKey, chatCfg, ns);

    /* auto-select first enabled set (composer strip picks the same). */
    useEffect(() => {
        if (!ns.length) { if (sel) setSel(''); return; }
        if (sel && ns.includes(sel)) return;
        setSel(ns.find((n) => enabled.has(n)) ?? ns[0] ?? '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ns, sel, qr, chatCfg, charKey]);

    const doc = useRemote(s.live && sel ? `qr:set:${sel}` : null, () => getQrSet(sel));
    const entries = useMemo(
        () => (doc.data?.qrList ?? []).map((q, i) => ({ q, i, kind: qrEntryKind(q) })).filter((e) => e.kind !== 'empty'),
        [doc.data],
    );

    const fail = (e: unknown) => s.hint(`${t('panel.auto.qr.opFailed')}: ${e instanceof Error ? e.message : String(e)}`, true);

    /** Set enable/disable — settings scopes flip + chat link off when hiding
        (same write pair as the composer's toggleQrSet), now through the
        shared stores: the transform applies onto the optimistic doc, so a
        composer toggle that landed after this page loaded is preserved. */
    const toggleSet = async (name: string, on: boolean) => {
        if (busy) return;
        setBusy(`set:${name}`);
        try {
            mutateQrSettings((base) => qrv2WithSetVisible(base, charKey, name, on));
            await flushQrSettings();
            if (!on && canBind && chat && qrBound(chatCfg, name)) {
                mutateQrChatCfg(chat.charDir, chat.chatName, (base) => qrConfigWithLink(base, name, 'off'));
                await flushQrChatCfg(chat.charDir, chat.chatName);
            }
        } catch (e) { fail(e); }
        finally { setBusy(null); }
    };

    const createSet = async () => {
        const nm = newName.trim();
        if (!nm || busy) return;
        if (ns.includes(nm)) { s.hint(t('panel.auto.qr.exists'), true); return; }
        setBusy('new');
        try {
            /* Fresh exists-check — the names list is a snapshot; a set
               created elsewhere between fetch and save would be silently
               clobbered by the unconditional PUT upsert. */
            const existing = await getQrSet(nm).then(() => true).catch(() => false);
            if (existing) { s.hint(t('panel.auto.qr.exists'), true); return; }
            await saveQrSet(nm, newQrSetDoc(nm));
            setNewName('');
            names.reload();
            setSel(nm);
        } catch (e) { fail(e); }
        finally { setBusy(null); }
    };

    const runEntry = (id: number, message: string) => {
        if (busy) return;
        setBusy(`run:${id}`);
        run(message)
            .then((lines) => setResult({ id, lines }))
            .catch((e) => setResult({ id, lines: [{ text: e instanceof Error ? e.message : String(e), err: true }] }))
            .finally(() => setBusy(null));
    };

    const openStudio = () => {
        qrStudioFocus.set = sel || null;
        if (s.isMobile) s.setSheetSnap('closed');
        s.setView('studio', true);
        s.setStudioNav('quickreplies');
    };

    if (names.error) return <PanelError error={names.error} onRetry={names.reload} />;
    if (!names.data) return <PanelEmpty icon="zap">…</PanelEmpty>;
    if (ns.length === 0) {
        return (
            <div className="space-y-3">
                <PanelEmpty icon="zap" desc={t('panel.auto.qr.emptyDesc')}>{t('panel.auto.qr.empty')}</PanelEmpty>
                <NewSetRow newName={newName} setNewName={setNewName} busy={busy === 'new'} onCreate={() => void createSet()} />
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {/* sets — name + this-chat enabled switch; off = bound-but-hidden
                stays bound (ST link semantics, toggle never strips links). */}
            <div className={group}>
                {ns.map((n) => {
                    const on = enabled.has(n);
                    const active = sel === n;
                    return (
                        <div key={n} className={`${row} inset-row-btn`} style={active ? { background: 'var(--bg-active)' } : undefined} onClick={() => setSel(n)}>
                            <span className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0" style={{ color: on ? 'var(--brand)' : 'var(--fg-faint)' }}>
                                    <Icon name="zap" size={13} />
                                </span>
                                <span className="truncate text-[12.5px] text-[color:var(--fg-primary)]">{n}</span>
                            </span>
                            <span onClick={(e) => e.stopPropagation()}>
                                <Switch on={on} disabled={busy !== null || !canBind} title={canBind ? t('panel.auto.qr.on') : t('panel.auto.qr.noChat')} onToggle={() => void toggleSet(n, !on)} />
                            </span>
                        </div>
                    );
                })}
            </div>
            <NewSetRow newName={newName} setNewName={setNewName} busy={busy !== null} onCreate={() => void createSet()} />

            {/* selected set entries — `/` entries are runnable from here;
                text/continue entries send through the composer strip. */}
            <span className={lbl}>{sel} · {t('panel.auto.qr.entries')}</span>
            {doc.error ? (
                <PanelError error={doc.error} onRetry={doc.reload} />
            ) : !doc.data ? (
                <PanelEmpty icon="zap">…</PanelEmpty>
            ) : entries.length === 0 ? (
                <PanelEmpty icon="zap" desc={t('panel.auto.qr.noEntriesDesc')}>{t('panel.auto.qr.noEntries')}</PanelEmpty>
            ) : (
                <div className={group}>
                    {entries.map(({ q, i, kind }) => (
                        <div key={`${q.id ?? i}`}>
                            <div className={row}>
                                <span className="min-w-0">
                                    <span className="flex items-center gap-1.5">
                                        <span className="truncate text-[12.5px] text-[color:var(--fg-primary)]">{(q.label ?? '').trim() || `#${q.id ?? i}`}</span>
                                        {q.isHidden === true && <Tag>{t('panel.auto.qr.hidden')}</Tag>}
                                        {kind === 'text' && <Tag>{t('panel.auto.qr.textKind')}</Tag>}
                                        {kind === 'continue' && <Tag>/continue</Tag>}
                                    </span>
                                    <span className="mt-0.5 block truncate font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{(q.message ?? '').trim()}</span>
                                </span>
                                {kind === 'script' ? (
                                    <button
                                        className="ghost-btn h-6 w-6 shrink-0"
                                        title={t('panel.auto.cmd.run')}
                                        disabled={busy !== null || (!canBind && !chat)}
                                        onClick={() => runEntry(q.id ?? i, (q.message ?? '').trim())}
                                    >
                                        <Icon name="play" size={12} />
                                    </button>
                                ) : (
                                    <span className="shrink-0 text-[9.5px] text-[color:var(--fg-faint)]" title={t('panel.auto.qr.textHint')}>
                                        <Icon name="chat" size={13} />
                                    </span>
                                )}
                            </div>
                            {result?.id === (q.id ?? i) && (
                                <div className="border-t border-[color:var(--border-hairline)] px-3.5 py-2" style={{ background: 'var(--bg-canvas)' }}>
                                    {result.lines.map((l, k) => (
                                        <p key={k} className="whitespace-pre-wrap break-all font-mono-ui text-[10.5px] leading-relaxed" style={{ color: l.err ? 'var(--status-danger)' : 'var(--fg-secondary)' }}>{l.text}</p>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
            <div className="flex items-center justify-between px-1">
                <span className="text-[9.5px] leading-relaxed text-[color:var(--fg-faint)]">{t('panel.auto.qr.textHint')}</span>
                <button className="shrink-0 text-[11px] font-medium text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg-primary)]" onClick={openStudio}>
                    {t('panel.auto.qr.manage')} →
                </button>
            </div>
        </div>
    );
}

function NewSetRow({ newName, setNewName, busy, onCreate }: {
    newName: string; setNewName: (v: string) => void; busy: boolean; onCreate: () => void;
}) {
    const { t } = useI18n();
    return (
        <div className="flex items-center gap-1.5">
            <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onCreate(); }}
                placeholder={t('panel.auto.qr.newPh')}
                className="h-8 min-w-0 flex-1 rounded-lg px-2.5 text-xs outline-none"
                style={inputStyle}
            />
            <button
                className="h-8 shrink-0 rounded-lg px-3 text-[11.5px] font-medium"
                style={{ border: '1px solid var(--border-strong)', color: 'var(--fg-primary)', opacity: busy || !newName.trim() ? 0.5 : 1 }}
                disabled={busy || !newName.trim()}
                onClick={onCreate}
            >
                {t('panel.auto.qr.new')}
            </button>
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* panel shell — segmented sections                                       */
/* ----------------------------------------------------------------------- */

type Sec = 'commands' | 'regex' | 'quick';
const SECS: { id: Sec; icon: IconName; labelKey: string }[] = [
    { id: 'commands', icon: 'command', labelKey: 'panel.auto.seg.cmd' },
    { id: 'regex', icon: 'code', labelKey: 'panel.auto.seg.regex' },
    { id: 'quick', icon: 'zap', labelKey: 'panel.auto.seg.qr' },
];

export function AutomationPanel() {
    const { t } = useI18n();
    const s = useShell();
    const params = s.panelParams['automation'] as { sec?: Sec } | undefined;
    const [sec, setSec] = useState<Sec>(
        params?.sec && SECS.some((x) => x.id === params.sec) ? params.sec : 'commands',
    );
    const run = useScriptRun();

    if (!s.live) {
        return <PanelEmpty icon="wand" desc={t('panel.auto.offlineDesc')}>{t('status.stub')}</PanelEmpty>;
    }

    return (
        <div className="p-4">
            <div className="mb-4">
                <div className="heading-tight text-[14px] font-semibold">{t('panel.auto.title')}</div>
                <div className="mt-0.5 text-[11.5px] text-[color:var(--fg-muted)]">{t('panel.auto.sub')}</div>
            </div>
            {/* segmented switch — pill rail, active block floats up; same
                grammar as the launcher chips, no new chrome invented. */}
            <div className="mb-4 flex gap-1 rounded-[10px] p-1" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}>
                {SECS.map((x) => {
                    const on = sec === x.id;
                    return (
                        <button
                            key={x.id}
                            className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg text-[11.5px] font-medium transition-colors"
                            style={on
                                ? { background: 'var(--bg-active)', color: 'var(--fg-primary)', boxShadow: 'var(--inner-highlight)' }
                                : { color: 'var(--fg-muted)' }}
                            onClick={() => setSec(x.id)}
                        >
                            <Icon name={x.icon} size={12} className="shrink-0" />
                            <span className="truncate">{t(x.labelKey)}</span>
                        </button>
                    );
                })}
            </div>
            {sec === 'commands' && <CommandsSection run={run} />}
            {sec === 'regex' && <RegexSection />}
            {sec === 'quick' && <QuickSection run={run} />}
        </div>
    );
}
