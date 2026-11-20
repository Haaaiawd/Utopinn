// 规范稿弹层与移动壳:MobileFrame(view-aware —— hub/studio 走 view 贡献点)|
// ImportModal(两页:文件导入 preview→commit / ST 迁移 scan-st)|
// CharEditorModal(真 GET 卡文档,只读 · C3)| Cmdk | SettingsModal(兼弹层宿主:
// 真 secrets 连接段 + 本地设置;source/BaseURL/连接测试 = C1/C2 disabled)。
// z 层与规范稿一致(sheet 45 / drawer 55 / popover 30 / float 70 / modal 85)。
// 模态开合态走 overlayBus external store —— 壳 ShellCtx 不增键,任何表面可开。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { LogoU } from '../LogoU';
import { PanelBody } from './Workbench';
import { ChatStage } from '../stage/CenterStage';
import { ChatTree } from '../sidebar/trees';
import { useRemote } from '../panels/panelShared';
import { cardData, charImageUrl, getCharacter } from '../../api/characters';
import { getSettings } from '../../api/settings';
import { listSecrets, putSecret, deleteSecret, type SecretEntry } from '../../api/secrets';
import {
    commitImport, fileToDraft, previewImportWithFallback, scanStImport,
    MAX_IMPORT_BYTES,
    type ImportConflictPolicy, type ImportDraft, type ImportPreview,
    type StScanKind, type StScanResult,
} from '../../api/import';
import { closeCharEditor, closeImportModal, openImportModal, useOverlay } from './overlayBus';
import { WiredBadge } from '../views/studio';

const mono = 'font-mono-ui';
const inputCls = 'w-full rounded-lg px-2.5 text-[12px] outline-none';

/* ------------------------------------------------------------------ */
/* MobileFrame —— view-aware:s.view!=='chat' 时从 view 贡献点解析整页     */
/* (hub = 资产工坊贡献;studio 各页自带移动头);chat 保持原 chrome。          */
/* ------------------------------------------------------------------ */

export function MobileFrame() {
    const { t } = useI18n();
    const s = useShell();
    const views = useContribs('view');
    const ViewC = views.find((v) => v.view === s.view)?.Component;
    const isChat = s.view === 'chat';
    return (
        <div className="mobile-wrap">
            <div className="mobile-shell">
                {isChat ? (
                    <>
                        {/* hub 条:≡ | 卡名 · 会话名 ⌄ | 📖 面板 */}
                        <div className="flex h-11 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-3">
                            <button className="ghost-btn h-7 w-7" onClick={() => s.setMobileDrawer(true)}><Icon name="list" size={15} /></button>
                            <button className="flex min-w-0 items-center gap-1.5" onClick={() => s.setMobileDrawer(true)}>
                                <span className="char-avatar-ring flex h-5 w-5 items-center justify-center text-[8.5px] font-semibold" style={{ background: 'linear-gradient(135deg,#4a6a8a,#2a3a4a)', color: 'var(--fg-primary)' }}>{(s.chat?.title ?? '云')[0]}</span>
                                <span className="heading-tight truncate text-[12px] text-[color:var(--fg-primary)]">{s.chat ? `${s.cards.get(s.chat.charDir)?.name ?? s.chat.charDir} · ${s.chat.title}` : t('app.name')}</span>
                                <Icon name="chevronDown" size={9} className="text-[color:var(--fg-faint)]" />
                            </button>
                            <button className="ghost-btn h-7 gap-1 rounded-md px-2 text-[10.5px] text-[color:var(--fg-secondary)]" onClick={() => s.setSheetSnap('half')}>
                                <Icon name="bookOpen" size={12} /> 面板
                            </button>
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col"><ChatStage /></div>
                    </>
                ) : ViewC ? (
                    <ViewC />
                ) : (
                    <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-[color:var(--fg-faint)]">{t(`nav.${s.view}`)}</div>
                )}
                {s.mobileDrawer && <div className="fixed inset-0 z-[54] bg-black/40" onClick={() => s.setMobileDrawer(false)} />}
                <div className="mob-drawer" data-open={s.mobileDrawer || undefined}>
                    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--border-hairline)] px-3 text-[color:var(--brand)]"><LogoU size={16} /><span className="heading-tight text-[12.5px] text-[color:var(--fg-primary)]">{t('app.name')}</span></div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2" onClick={() => s.setMobileDrawer(false)}>
                        {/* 域导航:会话 ↔ 资产工坊(端稿移动壳入口) */}
                        <div className="mb-1.5 flex gap-1.5">
                            <button
                                className="inset-row-btn flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px]"
                                style={isChat ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                                onClick={() => s.setView('chat')}
                            >
                                <Icon name="chat" size={13} />{t('mob.hub.chat')}
                            </button>
                            <button
                                className="inset-row-btn flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px]"
                                style={!isChat ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                                onClick={() => s.setView('hub')}
                            >
                                <Icon name="home" size={13} />{t('mob.hub.assetHub')}
                            </button>
                        </div>
                        <ChatTree />
                    </div>
                </div>
                <div className="vaul-sheet" data-snap={s.sheetSnap}>
                    <button className="mx-auto my-2 h-1 w-9 shrink-0 rounded-full bg-[color:var(--border-strong)]" onClick={() => s.setSheetSnap(s.sheetSnap === 'full' ? 'half' : s.sheetSnap === 'half' ? 'closed' : 'full')} />
                    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[color:var(--border-hairline)] px-2">
                        {s.openTabs.map((type) => (
                            <button key={type} className="wb-tab ghost-btn h-6 gap-1 rounded-md px-2 text-[10.5px]" data-active={s.activeTab === type || undefined} onClick={() => s.selectTab(type)}>
                                {t(`panel.type.${type}`)}
                                <span className="wb-tab-close" onClick={(e) => { e.stopPropagation(); s.closeTab(type); }}><Icon name="x" size={8} /></span>
                            </button>
                        ))}
                        <button className="ghost-btn h-6 w-6" onClick={s.openNewTab}><Icon name="plus" size={12} /></button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {s.activeTab && s.activeTab !== 'newtab' ? <PanelBody type={s.activeTab} /> : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* ImportModal —— 端稿 importModal:两页。                                */
/* 页1 文件导入:队列 = s.importDrafts(全局拖放/本模态选文件同一管道)        */
/*   → previewImportWithFallback(离线 → 本地嗅探 mock 徽标,禁 commit)     */
/*   → commitImport(冲突时 rename/overwrite/skip 三策)。                  */
/* 页2 ST 迁移:scan-st 真路由 —— 列目录清单;逐项拉取需文件字节,           */
/*   协议只认 dataBase64 → 列表只读 + 诚实注记。                           */
/* ------------------------------------------------------------------ */

const KIND_ICON: Record<string, IconName> = { char: 'home', world: 'bookOpen', preset: 'sliders', persona: 'persona' };

interface DraftRow {
    preview: ImportPreview | null;
    mock: boolean;
    err: string | null;
    loading: boolean;
    conflict: ImportConflictPolicy;
    busy: boolean;
    done: string | null;
}

function ImportModal() {
    const { t } = useI18n();
    const s = useShell();
    const ov = useOverlay();
    const [tab, setTab] = useState<'files' | 'st'>('files');
    const [rows, setRows] = useState<Record<string, DraftRow>>({});
    const started = useRef(new Set<string>());
    const fileRef = useRef<HTMLInputElement>(null);
    const draftsKey = s.importDrafts.map((d) => d.id).join('|');

    /* 每个新 draft 自动 preview 一次(离线走本地嗅探 mock);
     * 已发起的 id 进 started —— 追加新草稿不重跑旧预览。 */
    useEffect(() => {
        const live = new Set(s.importDrafts.map((d) => d.id));
        for (const id of [...started.current]) if (!live.has(id)) started.current.delete(id);
        setRows((prev) => {
            const next = Object.fromEntries(Object.entries(prev).filter(([id]) => live.has(id)));
            for (const d of s.importDrafts) {
                next[d.id] ??= { preview: null, mock: false, err: null, loading: true, conflict: 'rename', busy: false, done: null };
            }
            return next;
        });
        for (const d of s.importDrafts) {
            if (started.current.has(d.id)) continue;
            started.current.add(d.id);
            void previewImportWithFallback(d.name, d.dataBase64).then((r) => {
                setRows((prev) => prev[d.id]
                    ? { ...prev, [d.id]: { ...prev[d.id]!, preview: r.data, mock: r.mock, err: r.error ?? null, loading: false } }
                    : prev);
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draftsKey]);

    const pick = async (files: FileList | null) => {
        if (!files?.length) return;
        const drafts: ImportDraft[] = [];
        let skipped = 0;
        for (const f of Array.from(files)) {
            if (f.size > MAX_IMPORT_BYTES) { skipped += 1; continue; }
            drafts.push(await fileToDraft(f));
        }
        if (skipped) s.hint(t('imp.tooLarge'), true);
        if (drafts.length) s.queueImport(drafts);
    };

    const commit = (d: ImportDraft) => {
        const row = rows[d.id];
        if (!row?.preview || row.mock || row.busy) return;
        setRows((p) => ({ ...p, [d.id]: { ...p[d.id]!, busy: true } }));
        const apiId = row.preview.kind === 'preset' ? (row.preview.summary.apiId ?? 'openai') : undefined;
        commitImport({
            name: d.name,
            targetName: row.preview.targetName || undefined,
            dataBase64: d.dataBase64,
            kind: row.preview.kind,
            conflict: row.preview.conflicts.existingSameName ? row.conflict : undefined,
            apiId,
        }).then((r) => {
            s.hint(`${t('ov.import.done')} → ${r.targetName}`);
            s.dismissImportDraft(d.id);
            void s.refreshCards();
        }).catch((e) => {
            setRows((p) => (p[d.id] ? { ...p, [d.id]: { ...p[d.id]!, busy: false, err: e instanceof Error ? e.message : String(e) } } : p));
        });
    };

    /* ——— 页2:ST 迁移扫描 ——— */
    const [stDir, setStDir] = useState('');
    const [stBusy, setStBusy] = useState(false);
    const [stRes, setStRes] = useState<StScanResult | null>(null);
    const [stErr, setStErr] = useState<string | null>(null);
    const scan = () => {
        if (!stDir.trim() || stBusy) return;
        setStBusy(true); setStErr(null);
        scanStImport(stDir.trim())
            .then(setStRes)
            .catch((e) => { setStRes(null); setStErr(e instanceof Error ? e.message : String(e)); })
            .finally(() => setStBusy(false));
    };
    const ST_KIND_ORDER: StScanKind[] = ['character', 'world', 'preset', 'persona', 'quickReply', 'theme'];

    if (!ov.importOpen && s.importDrafts.length === 0) return null;
    /* 队列有待办但模态未开 → 右下小浮签引导(全局拖放 enqueue 后可达)。 */
    if (!ov.importOpen) {
        return (
            <button
                className="pop-in fixed bottom-4 right-4 z-[80] flex items-center gap-2 rounded-full px-3.5 py-2 text-[12px] font-medium"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-float)', color: 'var(--fg-primary)' }}
                onClick={openImportModal}
            >
                <Icon name="import" size={14} className="text-[color:var(--brand)]" />
                {s.importDrafts.length} {t('ov.import.pending')}
            </button>
        );
    }

    return (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4" onClick={closeImportModal}>
            <div className="pop-in flex max-h-[84vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-[14px]" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <span className="heading-tight text-[14px] font-medium text-[color:var(--fg-primary)]">{t('ov.import.title')}</span>
                    <button className="ghost-btn h-7 w-7" onClick={closeImportModal}><Icon name="x" size={14} /></button>
                </div>
                <div className="flex shrink-0 gap-1 border-b border-[color:var(--border-hairline)] px-3 pt-2">
                    {(['files', 'st'] as const).map((tb) => (
                        <button key={tb} className="rounded-t-md px-3 py-1.5 text-[12px]" style={tab === tb ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-muted)' }} onClick={() => setTab(tb)}>
                            {t(`ov.import.tab.${tb}`)}
                        </button>
                    ))}
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                    {tab === 'files' && (
                        <>
                            {/* 拖放区 + 浏览 */}
                            <div
                                className="flex flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed py-7 text-center"
                                style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-surface)' }}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files); }}
                            >
                                <Icon name="import" size={22} className="text-[color:var(--brand)]" />
                                <div className="text-[12.5px] text-[color:var(--fg-secondary)]">{t('ov.import.drop')}</div>
                                <button className="ghost-btn h-7 rounded-md px-2.5 text-[11.5px]" onClick={() => fileRef.current?.click()}>{t('ov.import.browse')}</button>
                                <input ref={fileRef} type="file" multiple accept=".png,.webp,.json,.charx,.byaf,.zip" className="hidden" onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
                            </div>
                            {/* 预览卡队列 */}
                            {s.importDrafts.map((d) => (
                                <ImportPreviewCard key={d.id} draft={d} row={rows[d.id]}
                                    onConflict={(c) => setRows((p) => ({ ...p, [d.id]: { ...p[d.id]!, conflict: c } }))}
                                    onCommit={() => commit(d)}
                                    onRemove={() => s.dismissImportDraft(d.id)} />
                            ))}
                            {!s.importDrafts.length && (
                                <p className="py-4 text-center text-[11.5px] text-[color:var(--fg-faint)]">{t('ov.import.empty')}</p>
                            )}
                        </>
                    )}
                    {tab === 'st' && (
                        <>
                            <div className="flex gap-2">
                                <input
                                    value={stDir} onChange={(e) => setStDir(e.target.value)}
                                    placeholder={t('ov.import.stDirPh')}
                                    className={`${inputCls} h-8 flex-1 ${mono}`}
                                    style={{ background: 'var(--bg-surface)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') scan(); }}
                                />
                                <button className="h-8 shrink-0 rounded-lg px-3.5 text-[12px] font-medium" style={{ background: 'var(--brand)', color: 'var(--brand-fg)', opacity: stBusy || !stDir.trim() ? 0.5 : 1 }} disabled={stBusy || !stDir.trim()} onClick={scan}>
                                    {stBusy ? t('ov.import.scanning') : t('ov.import.scan')}
                                </button>
                            </div>
                            {stErr && <div className={`rounded-lg p-2.5 text-[11px] ${mono}`} style={{ background: 'var(--bg-surface)', color: 'var(--status-danger)' }}>{stErr}</div>}
                            {stRes && (
                                <>
                                    <div className="flex flex-wrap gap-1.5">
                                        {ST_KIND_ORDER.filter((k) => stRes.counts[k]).map((k) => (
                                            <span key={k} className={`rounded-md px-2 py-0.5 text-[10.5px] ${mono}`} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-secondary)' }}>
                                                {k} ×{stRes.counts[k]}
                                            </span>
                                        ))}
                                        <span className={`ml-auto text-[10.5px] ${mono} text-[color:var(--fg-faint)]`}>{stRes.total} · {stRes.root}</span>
                                    </div>
                                    <div className="inset-group max-h-[300px] overflow-y-auto">
                                        {stRes.items.map((it) => (
                                            <div key={it.file} className="inset-row">
                                                <span className="text-[color:var(--fg-faint)]"><Icon name={KIND_ICON[it.kind] ?? 'file'} size={13} /></span>
                                                <div className="min-w-0">
                                                    <div className="truncate text-[12.5px] text-[color:var(--fg-primary)]">{it.name}</div>
                                                    <div className={`truncate text-[10px] text-[color:var(--fg-faint)] ${mono}`}>{it.file} · {(it.bytes / 1024).toFixed(0)}KB</div>
                                                </div>
                                                <span className={`shrink-0 text-[10px] ${mono} text-[color:var(--fg-faint)]`}>{it.kind}</span>
                                            </div>
                                        ))}
                                        {!stRes.items.length && <div className="p-4 text-center text-[11.5px] text-[color:var(--fg-faint)]">{t('ov.import.stEmpty')}</div>}
                                    </div>
                                    <p className="text-[10.5px] leading-relaxed text-[color:var(--fg-faint)]">{t('ov.import.stNote')}</p>
                                </>
                            )}
                            {!stRes && !stErr && (
                                <p className="py-4 text-center text-[11.5px] text-[color:var(--fg-faint)]">{t('ov.import.stHint')}</p>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function ImportPreviewCard({ draft, row, onConflict, onCommit, onRemove }: {
    draft: ImportDraft; row?: DraftRow;
    onConflict: (c: ImportConflictPolicy) => void;
    onCommit: () => void; onRemove: () => void;
}) {
    const { t } = useI18n();
    const p = row?.preview ?? null;
    const chips = useMemo(() => {
        const sum = p?.summary ?? {};
        const out: string[] = [];
        if (sum.spec) out.push(String(sum.spec).replace('chara_card_', 'v'));
        if (sum.entries != null) out.push(`${sum.entries} 条目`);
        if (sum.bookEntries) out.push(`书 ${sum.bookEntries}`);
        if (sum.regexScripts) out.push(`正则 ${sum.regexScripts}`);
        if (sum.cardAppFiles) out.push(`CardApp ${sum.cardAppFiles}`);
        if (sum.boundWorld) out.push(`绑《${sum.boundWorld}》`);
        if (sum.prompts != null) out.push(`prompts ${sum.prompts}`);
        if (sum.apiId) out.push(String(sum.apiId));
        if (sum.title) out.push(`title:${sum.title}`);
        if (sum.firstGreetingLen) out.push(`mes ${sum.firstGreetingLen}`);
        if (sum.alternateGreetings) out.push(`+${sum.alternateGreetings} alt`);
        if (sum.depthPrompt) out.push(`depth@${sum.depthPrompt.depth ?? '?'}`);
        if (sum.sourceFormat) out.push(String(sum.sourceFormat));
        return out;
    }, [p]);
    const conflict = p?.conflicts.existingSameName;
    return (
        <div className="space-y-2 rounded-[12px] p-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}>
            <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-active)', color: 'var(--fg-primary)' }}>
                    <Icon name={KIND_ICON[p?.kind ?? ''] ?? 'file'} size={15} />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{p?.targetName || p?.name || draft.name}</div>
                    <div className={`truncate text-[10px] text-[color:var(--fg-faint)] ${mono}`}>{draft.name}{p ? ` · ${p.kind}` : ''}{row?.mock ? ` · ${t('ov.import.mockBadge')}` : ''}</div>
                </div>
                <button className="ghost-btn h-6 w-6 shrink-0" onClick={onRemove} title={t('ov.import.remove')}><Icon name="x" size={11} /></button>
            </div>
            {row?.loading && <div className={`text-[11px] text-[color:var(--fg-faint)] ${mono}`}>{t('ov.import.previewing')}</div>}
            {row?.err && <div className={`rounded-md p-2 text-[10.5px] ${mono}`} style={{ background: 'var(--bg-active)', color: 'var(--status-danger)' }}>{row.err}</div>}
            {p && (
                <>
                    <div className="flex flex-wrap gap-1">
                        {chips.map((c) => <span key={c} className={`rounded px-1.5 py-0.5 text-[10px] ${mono}`} style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>{c}</span>)}
                        {!!p.summary.tags?.length && <span className={`rounded px-1.5 py-0.5 text-[10px] ${mono}`} style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>#{p.summary.tags.slice(0, 4).join(' #')}</span>}
                    </div>
                    {p.warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-[10.5px]" style={{ color: 'var(--status-warn)' }}><Icon name="warning" size={11} className="mt-0.5 shrink-0" />{w}</div>
                    ))}
                    <div className="flex items-center justify-between gap-2">
                        {conflict ? (
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10.5px]" style={{ color: 'var(--status-warn)' }}>{t('ov.import.conflict')}</span>
                                {(['rename', 'overwrite', 'skip'] as const).map((c) => (
                                    <button key={c} className="rounded-md px-1.5 py-0.5 text-[10.5px]" style={(row?.conflict ?? 'rename') === c ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-muted)' }} onClick={() => onConflict(c)}>
                                        {t(`ov.import.pol.${c}`)}
                                    </button>
                                ))}
                            </div>
                        ) : <span />}
                        <button
                            className="h-7 shrink-0 rounded-lg px-3 text-[12px] font-medium"
                            style={{ background: 'var(--brand)', color: 'var(--brand-fg)', opacity: row?.mock || row?.busy ? 0.5 : 1 }}
                            disabled={!!row?.mock || !!row?.busy}
                            title={row?.mock ? t('ov.import.mockNoCommit') : undefined}
                            onClick={onCommit}
                        >
                            {row?.busy ? t('ov.import.committing') : t('ov.import.commit')}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* CharEditorModal —— 端稿 charEditor:GET /characters/:charDir 真读,       */
/* 全控件只读(写面 C3 未备):name/description/first_mes/绑定书/ext JSON。    */
/* ------------------------------------------------------------------ */

function CharEditorModal() {
    const { t } = useI18n();
    const s = useShell();
    const ov = useOverlay();
    const dir = ov.charEditor;
    const docR = useRemote(dir ? `char:${dir}` : null, () => (dir ? getCharacter(dir) : Promise.reject(new Error('no dir'))));
    if (!dir) return null;
    const card = s.cards.get(dir);
    const data = docR.data ? cardData(docR.data) : null;
    const ext = data?.extensions ?? {};
    const boundWorld = typeof ext.world === 'string' && ext.world ? ext.world : null;
    const book = data?.character_book as { entries?: unknown } | undefined;
    const bookEntries = Array.isArray(book?.entries) ? book.entries.length
        : book?.entries && typeof book.entries === 'object' ? Object.keys(book.entries).length : 0;

    const ro = (label: string, value: string, rows?: number) => (
        <div>
            <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--fg-faint)]">{label}</div>
            {rows ? (
                <textarea readOnly value={value} rows={rows} className={`w-full resize-none rounded-lg p-2.5 text-[12px] leading-relaxed outline-none ${mono}`}
                    style={{ background: 'var(--bg-surface)', color: 'var(--fg-secondary)', border: '1px solid var(--border-hairline)' }} />
            ) : (
                <input readOnly value={value} className={`${inputCls} h-8`} style={{ background: 'var(--bg-surface)', color: 'var(--fg-secondary)', border: '1px solid var(--border-hairline)' }} />
            )}
        </div>
    );

    return (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4" onClick={closeCharEditor}>
            <div className="pop-in flex max-h-[86vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-[14px]" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
                <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-hairline)] px-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                        {card?.avatar ? <img src={charImageUrl(card.avatar)} alt="" className="h-7 w-7 rounded-lg object-cover" /> : <Icon name="home" size={16} className="text-[color:var(--fg-faint)]" />}
                        <span className="heading-tight truncate text-[14px] font-medium text-[color:var(--fg-primary)]">{data?.name || card?.name || dir}</span>
                        <WiredBadge warn>{t('ov.char.badge')}</WiredBadge>
                    </div>
                    <button className="ghost-btn h-7 w-7 shrink-0" onClick={closeCharEditor}><Icon name="x" size={14} /></button>
                </div>
                <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-4">
                    {docR.loading && <p className={`py-6 text-center text-[11.5px] text-[color:var(--fg-faint)] ${mono}`}>{t('ov.char.loading')}</p>}
                    {docR.error && <p className={`rounded-lg p-3 text-[11px] ${mono}`} style={{ background: 'var(--bg-surface)', color: 'var(--status-danger)' }}>{docR.error}</p>}
                    {data && (
                        <>
                            {ro(t('ov.char.name'), data.name ?? '')}
                            {ro(t('ov.char.desc'), data.description ?? '', 6)}
                            {ro(t('ov.char.first'), data.first_mes ?? '', 4)}
                            <div>
                                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--fg-faint)]">{t('ov.char.world')}</div>
                                <div className="inset-group">
                                    <div className="inset-row">
                                        <span className="text-[color:var(--fg-faint)]"><Icon name="bookOpen" size={13} /></span>
                                        <span className="min-w-0 truncate text-[12.5px] text-[color:var(--fg-secondary)]">
                                            {boundWorld ?? (bookEntries ? `${t('ov.char.bookEmbedded')} · ${bookEntries}` : t('ov.char.worldNone'))}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div>
                                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--fg-faint)]">{t('ov.char.ext')}</div>
                                <pre className={`select-text overflow-x-auto rounded-lg p-3 text-[11px] leading-relaxed ${mono}`} style={{ background: 'var(--bg-surface)', color: 'var(--fg-secondary)', border: '1px solid var(--border-hairline)' }}>
                                    {JSON.stringify(ext, null, 2)}
                                </pre>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Cmdk —— 命令面板(原样保留)                                             */
/* ------------------------------------------------------------------ */

export function Cmdk() {
    const { t } = useI18n();
    const s = useShell();
    const panels = useContribs('panel.type');
    const navs = useContribs('nav.rail');
    const [q, setQ] = useState('');
    if (!s.cmdkOpen) return null;
    const qq = q.trim().toLowerCase();
    const viewItems = navs.filter((n) => !qq || t(`nav.${n.view}`).toLowerCase().includes(qq));
    const panelItems = panels.filter((p) => !qq || t(`panel.type.${p.type}`).toLowerCase().includes(qq) || p.type.includes(qq));
    return (
        <div className="fixed inset-0 z-[85] flex items-start justify-center bg-black/50 pt-[14vh]" onClick={() => s.setCmdkOpen(false)}>
            <div className="pop-in w-[440px] max-w-[92vw] overflow-hidden rounded-[14px]" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 border-b border-[color:var(--border-hairline)] px-3.5 py-2.5">
                    <Icon name="search" size={14} className="text-[color:var(--fg-faint)]" />
                    <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cmdk.placeholder')} className="w-full bg-transparent text-[13px] outline-none" />
                </div>
                <div className="max-h-[46vh] overflow-y-auto p-1.5">
                    <div className="px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">{t('cmdk.views')}</div>
                    {viewItems.map((n) => (
                        <button key={n.view} className="inset-row-btn flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12px] text-[color:var(--fg-secondary)]" onClick={() => { s.setView(n.view); s.setCmdkOpen(false); }}>
                            <Icon name={n.icon} size={13} />{t(`nav.${n.view}`)}
                        </button>
                    ))}
                    <div className="px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">{t('cmdk.panels')}</div>
                    {panelItems.map((p) => (
                        <button key={p.type} className="inset-row-btn flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12px] text-[color:var(--fg-secondary)]" onClick={() => { s.openPanel(p.type); s.setCmdkOpen(false); }}>
                            <Icon name={p.icon} size={13} />{t(`panel.type.${p.type}`)}
                        </button>
                    ))}
                    {!viewItems.length && !panelItems.length && <div className="px-3 py-4 text-center text-[11.5px] text-[color:var(--fg-faint)]">{t('cmdk.empty')}</div>}
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* SettingsModal —— 兼弹层宿主(App 层挂点唯一,弹层在此汇合)。               */
/* api 页:连接段(source/BaseURL/测试 = C1/C2 disabled)+ 真 secrets 脱敏管理。 */
/* ------------------------------------------------------------------ */

function ConnectionSection() {
    const { t } = useI18n();
    const s = useShell();
    const open = s.settingsOpen;
    const settings = useRemote(open ? 'st:settings' : null, () => getSettings());
    const secrets = useRemote(open ? 'st:secrets' : null, listSecrets);
    const oai = (settings.data?.settings?.oai_settings ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const source = str(oai.chat_completion_source);
    const baseUrl = str(oai.reverse_proxy) || str(oai.custom_url);
    const SOURCES = ['openai', 'claude', 'openrouter', 'makersuite', 'mistralai', 'custom', 'deepseek', 'ai21', 'horde'];
    if (source && !SOURCES.includes(source)) SOURCES.unshift(source);

    const [addKey, setAddKey] = useState('api_key_openai');
    const [addVal, setAddVal] = useState('');
    const [addLabel, setAddLabel] = useState('');
    const [busy, setBusy] = useState(false);
    const act = (fn: () => Promise<unknown>, done?: () => void) => {
        if (busy) return;
        setBusy(true);
        void fn().then(() => { secrets.reload(); done?.(); })
            .catch((e) => s.hint(`${t('st.secrets.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };
    const secretKeys = Object.keys(secrets.data?.secrets ?? {});
    const groups = secretKeys.filter((k) => secrets.data!.secrets[k]?.length);
    return (
        <>
            <div className="inset-row">
                <span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.conn.source')}</span>
                <div className="flex items-center gap-1.5">
                    <select disabled value={source || ''} className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-1.5 py-1 text-[11px] opacity-50 outline-none">
                        {SOURCES.map((v) => <option key={v} value={v}>{v || '—'}</option>)}
                    </select>
                    <WiredBadge warn>C1</WiredBadge>
                </div>
            </div>
            <div className="inset-row">
                <span className="text-[12px] text-[color:var(--fg-secondary)]">Base URL</span>
                <div className="flex items-center gap-1.5">
                    <input disabled value={baseUrl} placeholder={t('st.conn.basePh')} className={`w-[200px] rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 py-1 text-[10.5px] opacity-50 outline-none ${mono}`} />
                    <button className="ghost-btn h-6 rounded-md px-2 text-[10.5px] opacity-50" disabled title={t('st.conn.unwired')}>{t('st.conn.test')}</button>
                    <WiredBadge warn>C2</WiredBadge>
                </div>
            </div>
            {/* 真 secrets 脱敏面 */}
            {groups.map((key) => (secrets.data!.secrets[key] ?? []).map((en: SecretEntry) => (
                <div key={`${key}:${en.id}`} className="inset-row">
                    <div className="min-w-0">
                        <div className={`truncate text-[11.5px] font-medium text-[color:var(--fg-primary)] ${mono}`}>{key}{en.label ? <span className="ml-1.5 text-[10px] font-normal text-[color:var(--fg-muted)]">{en.label}</span> : null}</div>
                        <div className={`truncate text-[10px] text-[color:var(--fg-faint)] ${mono}`}>{en.value}{en.active ? ` · ${t('st.secrets.active')}` : ''}</div>
                    </div>
                    <button className="ghost-btn h-6 w-6 shrink-0" disabled={busy} title={t('st.secrets.delete')} onClick={() => act(() => deleteSecret(key, en.id))} style={{ color: 'var(--status-danger)' }}>
                        <Icon name="trash" size={11} />
                    </button>
                </div>
            )))}
            {secrets.data && !groups.length && <div className="inset-row"><span className="text-[11.5px] text-[color:var(--fg-faint)]">{t('st.secrets.none')}</span></div>}
            {secrets.error && <div className="inset-row"><span className={`break-all text-[10.5px] ${mono}`} style={{ color: 'var(--status-danger)' }}>{secrets.error}</span></div>}
            <div className="inset-row flex-col !items-stretch gap-1.5">
                <span className="text-[10.5px] text-[color:var(--fg-faint)]">{t('st.secrets.add')}</span>
                <div className="flex gap-1.5">
                    <select value={addKey} onChange={(e) => setAddKey(e.target.value)} className={`rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-1.5 py-1 text-[10.5px] outline-none ${mono}`}>
                        {(secretKeys.length ? secretKeys : [addKey]).map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <input value={addVal} onChange={(e) => setAddVal(e.target.value)} type="password" placeholder={t('st.secrets.value')} className={`h-7 min-w-0 flex-1 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 text-[10.5px] outline-none ${mono}`} />
                </div>
                <div className="flex items-center justify-between gap-1.5">
                    <input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder={t('st.secrets.labelPh')} className="h-7 min-w-0 flex-1 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 text-[10.5px] outline-none" />
                    <button
                        className="h-7 shrink-0 rounded-lg px-2.5 text-[11px] font-medium"
                        style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: busy || !addVal.trim() ? 0.5 : 1 }}
                        disabled={busy || !addVal.trim()}
                        onClick={() => act(() => putSecret(addKey, addVal.trim(), addLabel.trim() || undefined), () => { setAddVal(''); setAddLabel(''); })}
                    >
                        {t('st.secrets.save')}
                    </button>
                </div>
            </div>
        </>
    );
}

function SettingsSheet() {
    const { t } = useI18n();
    const s = useShell();
    if (!s.settingsOpen) return null;
    const tabs = ['account', 'api', 'chat', 'appearance', 'about'];
    const cs = s.chatSettings;
    const sw = (on: boolean, fn: () => void) => <button className="sh-switch" data-checked={on || undefined} onClick={fn}><span className="sh-switch-thumb" /></button>;
    return (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50" onClick={s.closeSettings}>
            <div className="pop-in flex h-[460px] w-[680px] max-w-[94vw] overflow-hidden rounded-[14px]" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
                <div className="w-[150px] shrink-0 border-r border-[color:var(--border-hairline)] p-2">
                    {tabs.map((tb) => (
                        <button key={tb} className="inset-row-btn mb-0.5 w-full rounded-md px-2.5 py-2 text-left text-[12px]" style={s.settingsTab === tb ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }} onClick={() => s.setSettingsTab(tb)}>
                            {t(`st.${tb}`)}
                        </button>
                    ))}
                </div>
                <div className="min-w-0 flex-1 overflow-y-auto p-4">
                    <div className="inset-group">
                        {s.settingsTab === 'api' && <ConnectionSection />}
                        {s.settingsTab === 'chat' && (<>
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.renderCount')}</span><input type="range" min={5} max={100} value={cs.renderCount} onChange={(e) => s.setChatSetting('renderCount', Number(e.target.value))} className="w-[140px]" /><span className="w-8 text-right font-mono-ui text-[10.5px]">{cs.renderCount}</span></div>
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.fontSize')}</span><input type="range" min={12} max={18} step={0.5} value={cs.fontSize} onChange={(e) => s.setChatSetting('fontSize', Number(e.target.value))} className="w-[140px]" /><span className="w-8 text-right font-mono-ui text-[10.5px]">{cs.fontSize}</span></div>
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.showFloorNum')}</span>{sw(cs.showFloorNum, () => s.setChatSetting('showFloorNum', !cs.showFloorNum))}</div>
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.autoParseThink')}</span>{sw(cs.autoParseThink, () => s.setChatSetting('autoParseThink', !cs.autoParseThink))}</div>
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.confirmDelete')}</span>{sw(cs.confirmDelete, () => s.setChatSetting('confirmDelete', !cs.confirmDelete))}</div>
                        </>)}
                        {s.settingsTab === 'appearance' && (
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.customCss')}</span><textarea value={cs.customCss} onChange={(e) => s.setChatSetting('customCss', e.target.value)} className="h-20 w-[260px] resize-none rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-2 font-mono-ui text-[10px] outline-none" /></div>
                        )}
                        {(s.settingsTab === 'account' || s.settingsTab === 'about') && (
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-muted)]">{t('app.name')} · {s.settingsTab === 'about' ? 'spec-faithful shell' : t('acct.plan')}</span></div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** 弹层汇合 —— App.tsx 只挂 <SettingsModal/>;新模态在此汇入,壳不增 mount。 */
export function SettingsModal() {
    return (
        <>
            <SettingsSheet />
            <ImportModal />
            <CharEditorModal />
        </>
    );
}
