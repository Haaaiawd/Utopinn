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
import { WorkbenchBody } from './Workbench';
import { AccountPopCard } from './Chrome';
import { CenterStage } from '../stage/CenterStage';
import { charImgFallback } from '../stage/StageFrame';
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
    const trees = useContribs('sidebar.tree');
    const ViewC = views.find((v) => v.view === s.view)?.Component;
    const isChat = s.view === 'chat';
    /* 规范稿 drawer 头随「域」走:home 域落到 chat 树/头,studio/plugins 各自域头。 */
    const drawerDomain = s.railTab === 'home' ? 'chat' : s.railTab;
    const isChatDomain = drawerDomain === 'chat';
    const domainTrees = trees.filter((tr) => tr.rail === drawerDomain);
    const shellRef = useRef<HTMLDivElement>(null);
    const sheetRef = useRef<HTMLDivElement>(null);

    /* 规范稿 wireMobileSheetDrag:手柄行按下(钮除外)→ 百分比跟手;
     * 松手 >72% full / >24% half / 否则 closed。 */
    const onHandleDown = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        const sheet = sheetRef.current, shellEl = shellRef.current;
        if (!sheet || !shellEl) return;
        const shellH = shellEl.getBoundingClientRect().height;
        const startY = e.clientY;
        const startH = sheet.getBoundingClientRect().height;
        sheet.classList.add('dragging');
        const onMove = (ev: PointerEvent) => {
            sheet.style.height = `${Math.max(0, Math.min(94, ((startH + (startY - ev.clientY)) / shellH) * 100))}%`;
        };
        const onUp = () => {
            sheet.classList.remove('dragging');
            const finalPct = (sheet.getBoundingClientRect().height / shellH) * 100;
            sheet.style.height = '';
            s.setSheetSnap(finalPct > 72 ? 'full' : finalPct > 24 ? 'half' : 'closed');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <div className="mobile-wrap">
            <div className="mobile-shell" ref={shellRef}>
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                    {isChat ? (
                        <CenterStage />
                    ) : ViewC ? (
                        <ViewC />
                    ) : (
                        <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-[color:var(--fg-faint)]">{t(`nav.${s.view}`)}</div>
                    )}
                    {/* drawer 遮罩(规范稿 absolute inset-0 z-50 rgba(0,0,0,0.5)) */}
                    {s.mobileDrawer && <div className="absolute inset-0 z-50" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => s.setMobileDrawer(false)} />}
                    <aside className="mob-drawer" data-open={s.mobileDrawer || undefined}>
                        {/* 规范稿移动 drawer 头:logo + Utopinn[·域] + 搜索(仅 chat 域) + 关 */}
                        <div className={`flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4 ${isChatDomain ? 'mb-2.5' : 'mb-2'}`}>
                            <div className="flex items-center gap-2">
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center"><LogoU size={22} /></span>
                                <span className={`heading-tight ${isChatDomain ? 'text-[15px] font-semibold' : 'text-[13.5px] font-medium'} text-[color:var(--fg-primary)]`}>
                                    {isChatDomain ? t('app.name') : `${t('app.name')} · ${t(`nav.${s.view}`)}`}
                                </span>
                            </div>
                            <div className="flex items-center gap-1">
                                {isChatDomain && (
                                    <button className="ghost-btn h-8 w-8" title={t('chrome.search')} onClick={() => { s.setMobileDrawer(false); s.setCmdkOpen(true); }}><Icon name="search" size={16} /></button>
                                )}
                                <button className="ghost-btn h-8 w-8" onClick={() => s.setMobileDrawer(false)}><Icon name="x" size={15} /></button>
                            </div>
                        </div>
                        {/* 树体自管滚动(规范稿:pick 钮钉在头下,树列独立滚);
                            收屉只走 select-chat / rail-nav / close —— 点组头折叠不收屉。 */}
                        <div className="flex min-h-0 flex-1 flex-col">
                            {domainTrees.map((tr) => <tr.Component key={tr.rail + String(tr.order)} />)}
                        </div>
                        {/* 规范稿 drawer 底:资产工坊钮 + 账户行 + 齿轮 */}
                        <div className="shrink-0 space-y-1.5 border-t border-[color:var(--border-hairline)] p-2">
                            <button
                                className="flex w-full items-center justify-between rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-2 text-[12.5px] transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                                onClick={() => { s.setMobileDrawer(false); s.setView('hub'); }}
                            >
                                <span className="flex items-center gap-2"><Icon name="studio" size={16} /><span className="font-medium text-[color:var(--fg-primary)]">{t('mob.hub.assetHub')}</span></span>
                                <span className="text-[10.5px] text-[color:var(--fg-muted)]">{t('mob.hub.assetSub')}</span>
                            </button>
                            <div className="flex items-center justify-between gap-1">
                                <button
                                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-[color:var(--bg-surface)]"
                                    onClick={() => s.setAccountPopOpen(true)}
                                    title={t('acct.menu')}
                                >
                                    <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border" style={{ background: 'var(--bg-active)', borderColor: 'var(--border-strong)' }}>
                                        <img src="/assets/avatars/user-redpanda.png" alt="" className="h-full w-full rounded-full object-cover" />
                                        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border" style={{ background: 'var(--status-ok)', borderColor: 'var(--bg-sidebar)' }} />
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{t('acct.name')}</span>
                                        <span className="block truncate text-[10px] text-[color:var(--fg-muted)]">{t('acct.plan')}</span>
                                    </span>
                                </button>
                                <button className="ghost-btn h-8 w-8 shrink-0" onClick={() => { s.setMobileDrawer(false); s.openSettings('api'); }}>
                                    <Icon name="settings" size={16} />
                                </button>
                            </div>
                        </div>
                    </aside>
                    {/* 规范稿:sheet full 态遮罩(点按收回) */}
                    {s.sheetSnap === 'full' && <div className="absolute inset-0 z-40" style={{ background: 'rgba(0,0,0,0.48)' }} onClick={() => s.setSheetSnap('closed')} />}
                    <div ref={sheetRef} className="vaul-sheet" data-snap={s.sheetSnap}>
                        {/* 规范稿 sheet-drag-handle:左 snap 钮组,中 w-10 手柄,右「收起」 */}
                        <div
                            className="flex shrink-0 cursor-ns-resize touch-none items-center justify-between border-b border-[color:var(--border-hairline)] px-3.5 pb-2 pt-2.5"
                            onPointerDown={onHandleDown}
                        >
                            <div className="flex items-center gap-1">
                                {(['half', 'full'] as const).map((snap) => (
                                    <button
                                        key={snap}
                                        className="rounded-md px-2 py-0.5 text-[10.5px]"
                                        style={s.sheetSnap === snap ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                                        onClick={() => s.setSheetSnap(snap)}
                                    >
                                        {t(`mob.sheet.${snap}`)}
                                    </button>
                                ))}
                            </div>
                            <div className="h-1.5 w-10 rounded-full" style={{ background: 'var(--border-strong)' }} />
                            <button className="rounded-md px-2 py-0.5 text-[10.5px] text-[color:var(--fg-muted)]" onClick={() => s.setSheetSnap('closed')}>
                                {t('mob.sheet.collapse')}
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-hidden"><WorkbenchBody isMobile /></div>
                    </div>
                    {/* 规范稿:accountPop / settings / import / charEditor 均 absolute
                        锚在 mobile-shell 内(in-shell 全页/弹层),不挂全局 fixed。 */}
                    <MobileAccountPop />
                    <MobileSettingsSheet />
                    <ImportModal mobile />
                    <CharEditorModal mobile />
                </div>
            </div>
        </div>
    );
}

/** 移动账户弹层(规范稿:veil absolute inset-0 z-75 + left-3 right-3 bottom-16 卡)。 */
function MobileAccountPop() {
    const s = useShell();
    if (!s.accountPopOpen) return null;
    return (
        <div className="absolute inset-0 z-[75]" onClick={() => s.setAccountPopOpen(false)}>
            <div className="pop-in absolute inset-x-3 bottom-16" onClick={(e) => e.stopPropagation()}>
                <AccountPopCard />
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

function ImportModal({ mobile }: { mobile?: boolean }) {
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
                className={`pop-in ${mobile ? 'absolute' : 'fixed'} bottom-4 right-4 z-[80] flex items-center gap-2 rounded-full px-3.5 py-2 text-[12px] font-medium`}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-float)', color: 'var(--fg-primary)' }}
                onClick={openImportModal}
            >
                <Icon name="import" size={14} className="text-[color:var(--brand)]" />
                {s.importDrafts.length} {t('ov.import.pending')}
            </button>
        );
    }

    /* 规范稿 importModal:移动端 absolute inset-0 全页壳(w-full h-full),桌面固定弹层。 */
    return (
        <div
            className={`${mobile ? 'absolute' : 'fixed'} inset-0 z-[82] flex items-center justify-center bg-black/50 ${mobile ? '' : 'p-4'}`}
            style={{ backdropFilter: 'blur(4px)' }}
            onClick={closeImportModal}
        >
            <div
                className={mobile
                    ? 'pop-in flex h-full w-full flex-col overflow-hidden'
                    : 'pop-in flex max-h-[82vh] w-full max-w-[540px] flex-col overflow-hidden rounded-2xl'}
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }}
                onClick={(e) => e.stopPropagation()}
            >
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

function CharEditorModal({ mobile }: { mobile?: boolean }) {
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

    /* 规范稿 charEditor:移动端 absolute inset-0 全页壳,桌面固定弹层。 */
    return (
        <div
            className={`${mobile ? 'absolute' : 'fixed'} inset-0 z-[82] flex items-center justify-center bg-black/50 ${mobile ? '' : 'p-4'}`}
            style={{ backdropFilter: 'blur(4px)' }}
            onClick={closeCharEditor}
        >
            <div
                className={mobile
                    ? 'pop-in flex h-full w-full flex-col overflow-hidden'
                    : 'pop-in flex max-h-[82vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl'}
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-hairline)] px-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                        {card?.avatar ? <img src={charImageUrl(card.avatar)} alt="" className="h-7 w-7 rounded-lg object-cover" onError={charImgFallback} /> : <Icon name="home" size={16} className="text-[color:var(--fg-faint)]" />}
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
    const [q, setQ] = useState('');
    if (!s.cmdkOpen) return null;
    const qq = q.trim().toLowerCase();
    /* 规范稿 cmdk 两组:角色卡与会话(头像+card·title+形态)/ 右栏面板(截 4) */
    const sHits = s.chats.filter((c) =>
        !qq || c.title.toLowerCase().includes(qq) || (s.cards.get(c.charDir)?.name ?? c.charDir).toLowerCase().includes(qq));
    const pHits = panels.filter((p) =>
        !qq || t(`panel.type.${p.type}`).toLowerCase().includes(qq) || p.type.includes(qq));
    return (
        <div className="fixed inset-0 z-[85] flex items-start justify-center px-4 pt-20" style={{ background: 'rgba(0,0,0,0.52)', backdropFilter: 'blur(2px)' }} onClick={() => s.setCmdkOpen(false)}>
            <div className="w-full max-w-[480px] overflow-hidden rounded-2xl" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
                <div className="flex h-12 items-center gap-2.5 border-b border-[color:var(--border-hairline)] px-4">
                    <span className="text-[color:var(--fg-muted)]"><Icon name="search" size={16} /></span>
                    <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cmdk.placeholder')} className="w-full bg-transparent text-[13.5px] text-[color:var(--fg-primary)] outline-none" />
                    <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">ESC</span>
                </div>
                <div className="max-h-72 space-y-3 overflow-y-auto p-2">
                    {sHits.length > 0 && (
                        <div>
                            <div className="px-2.5 py-1 text-[10.5px] font-medium text-[color:var(--fg-muted)]">{t('tree.cardSessions')}</div>
                            {sHits.map((c) => {
                                const card = s.cards.get(c.charDir);
                                return (
                                    <button key={c.id} className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-active)]" onClick={() => { s.selectChat(c.id); s.setCmdkOpen(false); }}>
                                        <span className="flex min-w-0 items-center gap-2.5">
                                            <img src={card?.avatar ? charImageUrl(card.avatar) : '/assets/avatars/default-char.png'} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" onError={charImgFallback} />
                                            <span className="truncate text-[13px] text-[color:var(--fg-primary)]">{card?.name ?? c.charDir} · {c.title}</span>
                                        </span>
                                        <span className="shrink-0 text-[11px] text-[color:var(--fg-muted)]">{t(`stage.label.${c.stage ?? 'chat'}`)}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {pHits.length > 0 && (
                        <div>
                            <div className="px-2.5 py-1 text-[10.5px] font-medium text-[color:var(--fg-muted)]">{t('cmdk.panels')}</div>
                            {pHits.slice(0, 4).map((p) => (
                                <button key={p.type} className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-active)]" onClick={() => { s.openPanel(p.type); s.setCmdkOpen(false); }}>
                                    <span className="flex min-w-0 items-center gap-2.5">
                                        <span className="text-[color:var(--fg-secondary)]"><Icon name={p.icon} size={15} /></span>
                                        <span className="truncate text-[13px] text-[color:var(--fg-primary)]">{t(`panel.type.${p.type}`)}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                    {!sHits.length && !pHits.length && <div className="px-3 py-4 text-center text-[11.5px] text-[color:var(--fg-faint)]">{t('cmdk.empty')}</div>}
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
    const [addVal, setAddVal] = useState('');
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
    /* 规范稿单密钥模型:当前 source 对应 key 的激活条 → mask;无 → 未配置 */
    const curKey = `api_key_${source || 'openai'}`;
    const curEntry = (secrets.data?.secrets?.[curKey] ?? []).find((en) => en.active) ?? secrets.data?.secrets?.[curKey]?.[0];
    const hasSecret = !!curEntry;
    /* 规范稿四源 pills(openai/deepseek/anthropic/custom) */
    const PILL_SRCS = [['openai', 'OpenAI'], ['deepseek', 'DeepSeek'], ['anthropic', 'Anthropic'], ['custom', 'Custom']];
    return (
        <div className="space-y-4">
            {/* 规范稿 source 分段 pills(真源点亮,余禁用 + C1 标) */}
            <div className="flex items-center gap-1.5">
                <div className="inline-flex rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-0.5">
                    {PILL_SRCS.map(([k, lbl]) => (
                        <button key={k} disabled title={t('st.conn.unwired')} className="rounded-md px-2.5 py-1 text-[11.5px] font-medium disabled:cursor-not-allowed" style={source === k ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-muted)', opacity: source ? 0.55 : 1 }}>
                            {lbl}
                        </button>
                    ))}
                </div>
                <WiredBadge warn>C1</WiredBadge>
            </div>
            <div className="inset-group">
                {/* 规范稿上游 Base URL 行(列式 + 全宽 mono 输入) */}
                <div className="inset-row flex-col !items-stretch gap-1.5">
                    <div className="flex items-center justify-between">
                        <label className="text-[11px] text-[color:var(--fg-muted)]">{t('st.conn.baseLabel')}</label>
                        <WiredBadge warn>C2</WiredBadge>
                    </div>
                    <input disabled value={baseUrl} placeholder={t('st.conn.basePh')} className={`h-8 w-full rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-xs opacity-60 outline-none ${mono}`} />
                </div>
                {/* 规范稿 API 密钥行(mask 状态 + 覆盖写入 + 保存/清除) */}
                <div className="inset-row flex-col !items-stretch gap-1.5">
                    <div className="flex items-center justify-between">
                        <label className="text-[11px] text-[color:var(--fg-muted)]">{t('st.conn.secretLabel')}</label>
                        <span className={`text-[10.5px] ${mono}`} style={{ color: hasSecret ? 'var(--status-ok)' : 'var(--status-warn)' }}>
                            {hasSecret ? `${t('st.secrets.managed')} · ${curEntry!.value}` : t('st.secrets.none2')}
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <input value={addVal} onChange={(e) => setAddVal(e.target.value)} type="password" placeholder={t('st.conn.secretPh')} className={`h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-xs outline-none ${mono}`} />
                        <button
                            className="h-8 shrink-0 rounded-lg px-3 text-[11.5px] font-medium"
                            style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: busy || !addVal.trim() ? 0.5 : 1 }}
                            disabled={busy || !addVal.trim()}
                            onClick={() => act(() => putSecret(curKey, addVal.trim()), () => setAddVal(''))}
                        >
                            {t('st.secrets.save')}
                        </button>
                        {hasSecret && (
                            <button className="h-8 shrink-0 rounded-lg px-2.5 text-[11.5px]" style={{ background: 'var(--bg-active)', color: 'var(--status-danger)' }} disabled={busy}
                                onClick={() => act(() => deleteSecret(curKey, curEntry!.id))}>
                                {t('st.secrets.clear')}
                            </button>
                        )}
                    </div>
                </div>
                {/* 规范稿连通性探测行 */}
                <div className="inset-row">
                    <div className="min-w-0">
                        <div className="text-[12px] font-medium text-[color:var(--fg-primary)]">{t('st.conn.probe')}</div>
                        <div className={`mt-0.5 text-[11px] ${mono} text-[color:var(--fg-muted)]`}>{t('st.conn.probeHint')}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <button disabled title={t('st.conn.unwired')} className="h-8 rounded-lg px-3 text-[11.5px] font-medium opacity-50" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}>{t('st.conn.test')}</button>
                        <WiredBadge warn>C2</WiredBadge>
                    </div>
                </div>
            </div>
            {/* 真 secrets 脱敏面(规范稿未画,保留为附加 inset-group) */}
            {(groups.length > 0 || secrets.error) && (
                <div className="inset-group">
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
                    {secrets.error && <div className="inset-row"><span className={`break-all text-[10.5px] ${mono}`} style={{ color: 'var(--status-danger)' }}>{secrets.error}</span></div>}
                </div>
            )}
        </div>
    );
}

/* 规范稿六 tab(api/chat/appearance/plugins/diagnostics/account)。 */
const SETTINGS_TABS: { id: string; icon: IconName }[] = [
    { id: 'api', icon: 'cpu' }, { id: 'chat', icon: 'chat' }, { id: 'appearance', icon: 'sparkles' },
    { id: 'plugins', icon: 'plugins' }, { id: 'diagnostics', icon: 'code' }, { id: 'account', icon: 'user' },
];

/** 设置内容体 —— 桌面两栏模态与移动全页 sheet 共用(规范稿同一份 content)。 */
function SettingsTabContent() {
    const { t } = useI18n();
    const s = useShell();
    const cs = s.chatSettings;
    const sw = (on: boolean, fn: () => void) => <button className="sh-switch" data-checked={on || undefined} onClick={fn}><span className="sh-switch-thumb" /></button>;
    const rowLbl = 'text-[12px] text-[color:var(--fg-secondary)]';
    /* 规范稿背景格:文件名即 bgMode(接 CenterStage /assets/backgrounds/<mode>.png) */
    const bgOpts: { k: string; lbl: string }[] = [
        { k: 'none', lbl: '纯炭灰' }, { k: 'app-dark', lbl: '暗室底纹' }, { k: 'aurora-dark', lbl: '极光' }, { k: 'drawer-dark', lbl: '抽屉纹' },
    ];
    return (
        <>
            {s.settingsTab === 'api' && <div className="inset-group"><ConnectionSection /></div>}
                        {s.settingsTab === 'chat' && (
                            <div className="inset-group">
                                <div className="inset-row"><span className={rowLbl}>{t('st.renderCount')}</span><input type="range" min={5} max={100} value={cs.renderCount} onChange={(e) => s.setChatSetting('renderCount', Number(e.target.value))} className="w-[140px]" /><span className="w-8 text-right font-mono-ui text-[10.5px]">{cs.renderCount}</span></div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.streamFps')}</span><input type="range" min={10} max={60} step={5} value={cs.streamFps} onChange={(e) => s.setChatSetting('streamFps', Number(e.target.value))} className="w-[140px]" /><span className="w-8 text-right font-mono-ui text-[10.5px]">{cs.streamFps}</span></div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.fontSize')}</span><input type="range" min={12} max={18} step={0.5} value={cs.fontSize} onChange={(e) => s.setChatSetting('fontSize', Number(e.target.value))} className="w-[140px]" /><span className="w-8 text-right font-mono-ui text-[10.5px]">{cs.fontSize}</span></div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.showFloorNum')}</span>{sw(cs.showFloorNum, () => s.setChatSetting('showFloorNum', !cs.showFloorNum))}</div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.autoParseThink')}</span>{sw(cs.autoParseThink, () => s.setChatSetting('autoParseThink', !cs.autoParseThink))}</div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.autoExpandThink')}</span>{sw(cs.autoExpandThink, () => s.setChatSetting('autoExpandThink', !cs.autoExpandThink))}</div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.confirmDelete')}</span>{sw(cs.confirmDelete, () => s.setChatSetting('confirmDelete', !cs.confirmDelete))}</div>
                            </div>
                        )}
                        {s.settingsTab === 'appearance' && (
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <div className="px-0.5 text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('st.bgMode')}</div>
                                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        {bgOpts.map(({ k, lbl }) => (
                                            <button
                                                key={k}
                                                className="overflow-hidden rounded-xl border text-left transition-all"
                                                style={{ borderColor: cs.bgMode === k ? 'var(--primary-bg)' : 'var(--border-hairline)', background: 'var(--bg-surface)' }}
                                                onClick={() => s.setChatSetting('bgMode', k)}
                                            >
                                                {k === 'none'
                                                    ? <div className="flex h-12 items-center justify-center text-[11px] text-[color:var(--fg-muted)]">无图</div>
                                                    : <img src={`/assets/backgrounds/${k}.png`} alt="" className="h-12 w-full object-cover" />}
                                                <div className="truncate px-2 py-1 text-[10.5px] text-[color:var(--fg-secondary)]">{lbl}</div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <div className="px-0.5 text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('st.customCss')}</div>
                                    <textarea rows={3} value={cs.customCss} placeholder={t('st.customCss.ph')} onChange={(e) => s.setChatSetting('customCss', e.target.value)} className="w-full select-text rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-3 font-mono-ui text-[11.5px] text-[color:var(--fg-secondary)] outline-none" />
                                </div>
                            </div>
                        )}
                        {s.settingsTab === 'plugins' && (
                            <div className="inset-group">
                                {s.builtinPlugins.map((p) => (
                                    <div key={p.id} className="inset-row">
                                        <div className="min-w-0">
                                            <div className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{p.name}</div>
                                            <div className="truncate text-[11px] text-[color:var(--fg-muted)]">{p.desc}</div>
                                        </div>
                                        <span className="sh-switch" data-checked={p.enabled || undefined}><span className="sh-switch-thumb" /></span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {s.settingsTab === 'diagnostics' && (
                            <div className="inset-group">
                                <button className="inset-row inset-row-btn" onClick={() => { s.closeSettings(); s.openPanel('diag'); }}>
                                    <span className={rowLbl}>{t('panel.type.diag')}</span><Icon name="detach" size={13} className="text-[color:var(--fg-faint)]" />
                                </button>
                                <button className="inset-row inset-row-btn" onClick={() => { s.closeSettings(); s.openPanel('stats'); }}>
                                    <span className={rowLbl}>{t('panel.type.stats')}</span><Icon name="detach" size={13} className="text-[color:var(--fg-faint)]" />
                                </button>
                            </div>
                        )}
            {s.settingsTab === 'account' && (
                <div className="inset-group">
                    <div className="inset-row"><span className={rowLbl}>{t('acct.name')}</span><span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{t('acct.mail')}</span></div>
                    <div className="inset-row"><span className={rowLbl}>{t('app.name')}</span><span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{t('acct.plan')}</span></div>
                </div>
            )}
        </>
    );
}

/** 桌面设置:fixed 居中两栏模态(规范稿 renderSettingsModalHtml 桌面分支)。 */
function SettingsSheet() {
    const { t } = useI18n();
    const s = useShell();
    if (!s.settingsOpen) return null;
    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.58)', backdropFilter: 'blur(4px)' }} onClick={s.closeSettings}>
            <div className="flex h-[540px] w-full max-w-[760px] flex-row overflow-hidden rounded-2xl" style={{ background: 'var(--bg-canvas)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
                <aside className="flex w-[192px] shrink-0 flex-col border-r border-[color:var(--border-hairline)]" style={{ background: 'var(--bg-sidebar)' }}>
                    <div className="flex h-12 shrink-0 items-center px-4"><span className="heading-tight text-[13.5px] font-semibold text-[color:var(--fg-primary)]">{t('settings.title')}</span></div>
                    <div className="flex flex-col gap-0.5 overflow-y-auto px-2 pb-4">
                        {SETTINGS_TABS.map((tb) => {
                            const act = s.settingsTab === tb.id;
                            return (
                                <button key={tb.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors" style={act ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }} onClick={() => s.setSettingsTab(tb.id)}>
                                    <span style={{ color: act ? 'var(--fg-primary)' : 'var(--fg-muted)' }}><Icon name={tb.icon} size={17} active={act} /></span>
                                    <span>{t(`st.${tb.id}`)}</span>
                                </button>
                            );
                        })}
                    </div>
                </aside>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-5">
                        <span className="heading-tight text-[13.5px] font-semibold text-[color:var(--fg-primary)]">{t(`st.${s.settingsTab}`)}</span>
                        <button className="ghost-btn h-7 w-7" onClick={s.closeSettings}><Icon name="x" size={15} /></button>
                    </div>
                    <div className="flex-1 select-text overflow-y-auto p-5">
                        <SettingsTabContent />
                    </div>
                </div>
            </div>
        </div>
    );
}

/** 移动设置:in-shell 全页 sheet(规范稿 L2063 —— ‹设置 + × 头行,
 *  横滚 tab pills,内容 p-4)。挂进 MobileFrame 内层容器。 */
function MobileSettingsSheet() {
    const { t } = useI18n();
    const s = useShell();
    if (!s.settingsOpen) return null;
    return (
        <div className="absolute inset-0 z-[80] flex flex-col" style={{ background: 'var(--bg-canvas)' }}>
            <header
                className="flex h-12 shrink-0 items-center justify-between border-b px-3"
                style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border-hairline)' }}
            >
                <button className="ghost-btn h-8 gap-1 px-2 text-[13px] font-medium" onClick={s.closeSettings}>
                    <Icon name="arrowLeft" size={16} /><span>{t('settings.title')}</span>
                </button>
                <button className="ghost-btn h-8 w-8" onClick={s.closeSettings}><Icon name="x" size={15} /></button>
            </header>
            <div
                className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-2"
                style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border-hairline)' }}
            >
                {SETTINGS_TABS.map((tb) => {
                    const act = s.settingsTab === tb.id;
                    return (
                        <button
                            key={tb.id}
                            className="shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium"
                            style={act ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                            onClick={() => s.setSettingsTab(tb.id)}
                        >
                            {t(`st.${tb.id}`)}
                        </button>
                    );
                })}
            </div>
            <div className="flex-1 select-text overflow-y-auto p-4">
                <SettingsTabContent />
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
