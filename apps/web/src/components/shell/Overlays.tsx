// 规范稿弹层与移动壳:MobileFrame(view-aware —— hub/studio 走 view 贡献点)|
// ImportModal(两页:文件导入 preview→commit / ST 迁移 scan-st)|
// CharEditorModal(真 GET/PATCH 卡文档)| Cmdk | SettingsModal(兼弹层宿主:
// 真 secrets 连接段 + 本地设置;source/BaseURL/连接测试走 PATCH /settings + /connection/test)。
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
import { useRemote, PanelEmpty, type Remote } from '../panels/panelShared';
import { accountErrorText, changeUserName } from '../../api/account';
import { cardData, charImageUrl, getCharacter, patchCharacter } from '../../api/characters';
import {
    listProfiles, putProfile, deleteProfile, testConnectionTarget, listModelsFor,
    type ConnectionProbeTarget, type ConnectionProfile, type ConnectionProfileFormat,
    type ConnectionTestResponse,
} from '../../api/connection';
import { patchSettings } from '../../api/settings';
import {
    ambiencePinned, pinAmbience, uiAmbienceSlot, unpinAmbience,
    type UiAmbience,
} from '../../kernel/ambience';
import { listBackgrounds, bgCssUrl, BUILTIN_WALLPAPERS, builtinBgCssUrl } from '../../api/backgrounds';
import { patchChat, type ChatPatchOp } from '../../api/chats';
import { listSecrets, putSecret, deleteSecret, type SecretEntry, type SecretsResponse } from '../../api/secrets';
import { builtinCoverSrc, personaAvatarSrc } from '../../api/personas';
import { listWorlds } from '../../api/worlds';
import {
    commitImport, fileToDraft, previewImportWithFallback, scanStImport,
    MAX_IMPORT_BYTES,
    type ImportConflictPolicy, type ImportDraft, type ImportPreview,
    type StScanKind, type StScanResult,
} from '../../api/import';
import { closeCharEditor, closeGroupModal, closeImportModal, closeNewChatModal, openImportModal, useOverlay } from './overlayBus';
import { createGroup, patchGroupChat } from '../../api/groups';
import { CardMasonry, CardTile } from '../CardTile';
import { PluginsSections, useServerPlugins } from '../views/plugins';
import { useViewportInset, readVvKbdPx } from '../../lib/useViewportInset';
import { resolveSheetSnap, sheetDragHeight } from '../../lib/mobileShell';

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
    /* 进行中的拖拽 pointerId —— 第二根手指的 down/move/up 全部忽略,
       不然它的 pointerup 会被当成本次收尾,提前收档还算一次假 flick。 */
    const dragPidRef = useRef<number | null>(null);
    /* 软键盘遮挡 → --vv-kbd:composer/sheet/弹层锚位经 var() 消费;
       只在移动壳挂(桌面形态不渲染本帧,卸载即复位)。 */
    useViewportInset();

    /* 规范稿 wireMobileSheetDrag:手柄行按下(钮除外)→ 跟手;
     * 坐标系统一:可用舞台高 availH = shell 高 − --vv-kbd 键盘遮挡,
     * 拖拽 clamp(sheetDragHeight)与松手阈值(resolveSheetSnap)都按它
     * 归一化 —— 键盘期 sheet 被 CSS max-height cap 到 availH 仍能拖 full。
     * 松手落点 = 尾部窗口速度 |v|≥0.5px/ms 越档 —— 下甩直收,上甩直全。 */
    const onHandleDown = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        if (dragPidRef.current !== null) return; // 多指:只认第一根的拖拽
        e.preventDefault();
        const sheet = sheetRef.current, shellEl = shellRef.current;
        if (!sheet || !shellEl) return;
        const pid = e.pointerId;
        dragPidRef.current = pid;
        /* 指针捕获到手柄行:移出壳/扫过嵌卡 iframe 也不断拖;
           无此 API 的环境(jsdom/老内核)静默回落到 window 事件。 */
        try { (e.currentTarget as HTMLElement).setPointerCapture(pid); } catch { /* noop */ }
        const shellH = shellEl.getBoundingClientRect().height;
        const availH = Math.max(0, shellH - readVvKbdPx());
        const startY = e.clientY;
        const startH = sheet.getBoundingClientRect().height;
        sheet.classList.add('dragging');
        /* 速度采样环:松手取 ~60–200ms 窗口内的最早样本算均速,
           末段停手(dt>200ms)视为无速度回落高阈 —— 不冤枉慢放。 */
        const trail: { t: number; y: number }[] = [{ t: e.timeStamp, y: e.clientY }];
        const cleanup = () => {
            dragPidRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== pid) return;
            trail.push({ t: ev.timeStamp, y: ev.clientY });
            if (trail.length > 8) trail.shift();
            sheet.style.height = `${sheetDragHeight(startH, startY - ev.clientY, availH)}px`;
        };
        const onUp = (ev: PointerEvent) => {
            if (ev.pointerId !== pid) return;
            sheet.classList.remove('dragging');
            const finalH = sheet.getBoundingClientRect().height;
            sheet.style.height = '';
            let ref = trail[0]!;
            for (const p of trail) { if (ev.timeStamp - p.t >= 60) ref = p; else break; }
            const dt = ev.timeStamp - ref.t;
            const vy = dt > 0 && dt <= 200 ? (ev.clientY - ref.y) / dt : 0;
            s.setSheetSnap(resolveSheetSnap(finalH, availH, vy));
            cleanup();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        /* 系统手势抢指针(来电/多指)→ 同收档清理,不留 dragging 冻结态。 */
        window.addEventListener('pointercancel', onUp);
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
                        /* 无贡献视图的引导兜底 —— 不许裸 nav.* 文本。 */
                        <div className="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
                            <PanelEmpty
                                icon="warning"
                                desc={t('mob.view.noMobile')}
                                action={{ label: t('mob.view.back'), onClick: () => s.setView('chat') }}
                            >
                                {t(`nav.${s.view}`)}
                            </PanelEmpty>
                        </div>
                    )}
                    {/* drawer 遮罩(规范稿 absolute inset-0 z-50 rgba(0,0,0,0.5)) */}
                    {s.mobileDrawer && <div className="absolute inset-0 z-50" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => s.setMobileDrawer(false)} />}
                    <aside className="mob-drawer" data-open={s.mobileDrawer || undefined}>
                        {/* 规范稿移动 drawer 头:logo + Utopinn[·域] + 搜索(仅 chat 域) + 关 */}
                        <div className={`flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4 ${isChatDomain ? 'mb-2.5' : 'mb-2'}`}>
                            <div className="flex items-center gap-2">
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center"><LogoU size={26} /></span>
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
                                        <img
                                            src={personaAvatarSrc(s.persona?.avatar, s.persona?.avatar ? s.personas.find((p) => p.avatar === s.persona!.avatar)?.hasImage : undefined)}
                                            alt="" className="h-full w-full rounded-full object-cover"
                                            onError={(e) => { e.currentTarget.src = '/assets/avatars/user-redpanda.png'; }}
                                        />
                                        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border" style={{ background: s.live ? 'var(--status-ok)' : 'var(--status-warn)', borderColor: 'var(--bg-sidebar)' }} />
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{s.currentUser?.name || s.currentUser?.handle || t('acct.name')}</span>
                                        <span className="block truncate text-[10px] text-[color:var(--fg-muted)]">{s.live ? (s.currentUser?.handle ? `@${s.currentUser.handle}` : t('acct.plan')) : t('diag.job.offline')}</span>
                                    </span>
                                </button>
                                {/* 插件入口:移动端导航收敛 chat+hub,plugins 域无真视图 ——
                                    drawer 底直达 settings 插件页签(批量开关面,共享真数据)。 */}
                                <button className="ghost-btn h-8 w-8 shrink-0" title={t('nav.plugins')} onClick={() => s.openSettings('plugins')}>
                                    <Icon name="plugins" size={16} />
                                </button>
                                <button className="ghost-btn h-8 w-8 shrink-0" onClick={() => { s.setMobileDrawer(false); s.openSettings('api'); }} title={t('settings.title')}>
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
                    <NewChatModal mobile />
                    <GroupModal mobile />
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
/* CharEditorModal —— GET + PATCH /api/utopinn/characters/:charDir 真读写 */
/* ------------------------------------------------------------------ */

function CharEditorModal({ mobile }: { mobile?: boolean }) {
    const { t } = useI18n();
    const s = useShell();
    const ov = useOverlay();
    const dir = ov.charEditor;
    const docR = useRemote(dir ? `char:${dir}` : null, () => (dir ? getCharacter(dir) : Promise.reject(new Error('no dir'))));
    const worldsR = useRemote(dir ? 'char-edit:worlds' : null, listWorlds);
    const data = docR.data ? cardData(docR.data) : null;
    const ext = data?.extensions ?? {};
    const boundWorld = typeof ext.world === 'string' && ext.world ? ext.world : '';
    const book = data?.character_book as { entries?: unknown } | undefined;
    const bookEntries = Array.isArray(book?.entries) ? book.entries.length
        : book?.entries && typeof book.entries === 'object' ? Object.keys(book.entries).length : 0;

    const [nameDraft, setNameDraft] = useState('');
    const [descDraft, setDescDraft] = useState('');
    const [firstDraft, setFirstDraft] = useState('');
    const [worldDraft, setWorldDraft] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!data) return;
        setNameDraft(data.name ?? '');
        setDescDraft(data.description ?? '');
        setFirstDraft(data.first_mes ?? '');
        setWorldDraft(typeof data.extensions?.world === 'string' ? data.extensions.world : '');
    }, [dir, docR.data]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!dir) return null;
    const card = s.cards.get(dir);
    const worldNames = worldsR.data?.items.map((w) => w.name) ?? [];
    const dirty = !!data && (
        nameDraft.trim() !== (data.name ?? '').trim()
        || descDraft !== (data.description ?? '')
        || firstDraft !== (data.first_mes ?? '')
        || worldDraft !== boundWorld
    );

    const onSave = () => {
        if (!dir || !data || saving || !nameDraft.trim()) return;
        setSaving(true);
        void patchCharacter(dir, {
            name: nameDraft.trim(),
            description: descDraft,
            first_mes: firstDraft,
            extensions: { world: worldDraft },
        })
            .then(async (doc) => {
                // 共享卡 PATCH = 先物化:响应 __materialized + charDir(新私有
                // 干名)。弹层仍挂在旧(共享)干名上会再命中池卡 —— 收层后跳
                // 私有 copy 的角色页,编辑面指向真实写盘结果。
                if (doc.__materialized && typeof doc.charDir === 'string') {
                    closeCharEditor();
                    await s.refreshCards();
                    s.openChar(doc.charDir);
                    return;
                }
                await Promise.all([docR.reload(), s.refreshCards(), s.refreshConnection()]);
            })
            .then(() => s.hint(t('ov.char.saved')))
            .catch((e) => s.hint(`${t('ov.char.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setSaving(false));
    };

    const fieldStyle = { background: 'var(--bg-surface)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' };

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
                        <img src={card?.avatar ? charImageUrl(card.avatar) : builtinCoverSrc(dir)} alt="" className="h-7 w-7 rounded-lg object-cover" onError={charImgFallback} data-cover-key={dir} />
                        <span className="heading-tight truncate text-[14px] font-medium text-[color:var(--fg-primary)]">{data?.name || card?.name || dir}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {data && (
                            <button
                                className="h-7 rounded-lg px-3 text-[11.5px] font-medium"
                                style={{ background: 'var(--brand)', color: 'var(--brand-fg)', opacity: !dirty || saving || !nameDraft.trim() ? 0.45 : 1 }}
                                disabled={!dirty || saving || !nameDraft.trim()}
                                onClick={onSave}
                            >
                                {saving ? t('panel.notes.saving') : t('stage.edit.save')}
                            </button>
                        )}
                        <button className="ghost-btn h-7 w-7 shrink-0" onClick={closeCharEditor}><Icon name="x" size={14} /></button>
                    </div>
                </div>
                <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-4">
                    {docR.loading && <p className={`py-6 text-center text-[11.5px] text-[color:var(--fg-faint)] ${mono}`}>{t('ov.char.loading')}</p>}
                    {docR.error && <p className={`rounded-lg p-3 text-[11px] ${mono}`} style={{ background: 'var(--bg-surface)', color: 'var(--status-danger)' }}>{docR.error}</p>}
                    {data && (
                        <>
                            <div>
                                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--fg-faint)]">{t('ov.char.name')}</div>
                                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className={`${inputCls} h-8`} style={fieldStyle} />
                            </div>
                            <div>
                                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--fg-faint)]">{t('ov.char.desc')}</div>
                                <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} rows={6} className={`w-full resize-y rounded-lg p-2.5 text-[12px] leading-relaxed outline-none ${mono}`} style={fieldStyle} />
                            </div>
                            <div>
                                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--fg-faint)]">{t('ov.char.first')}</div>
                                <textarea value={firstDraft} onChange={(e) => setFirstDraft(e.target.value)} rows={4} className={`w-full resize-y rounded-lg p-2.5 text-[12px] leading-relaxed outline-none ${mono}`} style={fieldStyle} />
                            </div>
                            <div>
                                <div className="mb-1 flex items-center justify-between text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--fg-faint)]">
                                    <span>{t('ov.char.world')}</span>
                                    {bookEntries > 0 && <span className={mono}>{t('ov.char.bookEmbedded')} · {bookEntries}</span>}
                                </div>
                                <select
                                    value={worldDraft}
                                    onChange={(e) => setWorldDraft(e.target.value)}
                                    className={`h-8 w-full rounded-lg px-2.5 text-[12px] outline-none ${mono}`}
                                    style={fieldStyle}
                                >
                                    <option value="">{t('ov.char.worldNone')}</option>
                                    {boundWorld && !worldNames.includes(boundWorld) && (
                                        <option value={boundWorld}>{boundWorld}</option>
                                    )}
                                    {(worldsR.data?.items ?? []).map((w) => (
                                        <option key={w.name} value={w.name}>
                                            {w.displayName && w.displayName !== w.name ? `${w.displayName} (${w.name})` : w.name}
                                        </option>
                                    ))}
                                </select>
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
/* NewChatModal —— 新会话卡选择:newChat() 未指定卡时由 overlayBus 开。     */
/* 点卡 → close + s.newChat(dir)(自动 ST 风格命名直建,不再 window.prompt)。*/
/* ------------------------------------------------------------------ */

function NewChatModal({ mobile }: { mobile?: boolean }) {
    const { t } = useI18n();
    const s = useShell();
    const ov = useOverlay();
    if (!ov.newChatOpen) return null;
    const cards = [...s.cards.values()].filter((c) => c.readable !== false);
    const chatCount = (dir: string) => s.chats.filter((c) => c.charDir === dir).length;
    const pick = (dir: string) => { closeNewChatModal(); s.newChat(dir); };

    return (
        <div
            className={`${mobile ? 'absolute' : 'fixed'} inset-0 z-[82] flex items-center justify-center bg-black/50 ${mobile ? '' : 'p-4'}`}
            style={{ backdropFilter: 'blur(4px)' }}
            onClick={closeNewChatModal}
        >
            <div
                className={mobile
                    ? 'pop-in flex h-full w-full flex-col overflow-hidden'
                    : 'pop-in flex max-h-[82vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl'}
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <span className="heading-tight text-[14px] font-medium text-[color:var(--fg-primary)]">{t('ov.newChat.title')}</span>
                    <button className="ghost-btn h-7 w-7" onClick={closeNewChatModal}><Icon name="x" size={14} /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {cards.length === 0 ? (
                        <div className="flex flex-col items-center gap-3 py-10">
                            <p className="text-[12.5px] text-[color:var(--fg-muted)]">{t('ov.newChat.empty')}</p>
                            <button
                                className="h-8 rounded-lg px-4 text-[12px] font-medium"
                                style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                onClick={() => { closeNewChatModal(); openImportModal(); }}
                            >
                                {t('ov.newChat.import')}
                            </button>
                        </div>
                    ) : (
                        <CardMasonry className="lg:columns-3">
                            {cards.map((c) => (
                                <CardTile key={c.charDir} card={c} chatCount={chatCount(c.charDir)} onOpen={() => pick(c.charDir)} />
                            ))}
                        </CardMasonry>
                    )}
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* GroupModal —— 建群(TASK-062):成员多选(卡表)+ 编排设置                  */
/* (activation_strategy 4 态 / generation_mode 3 态 / 自应答应答 /
/*  join 前后缀 —— 字段名与值域同服务端群契约),POST /api/utopinn/groups   */
/*  落盘后 refreshChats + selectChat 直进群会话。                        */
/* ------------------------------------------------------------------ */

function GroupModal({ mobile }: { mobile?: boolean }) {
    const { t } = useI18n();
    const s = useShell();
    const ov = useOverlay();
    const [name, setName] = useState('');
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [strategy, setStrategy] = useState<number>(0);
    const [genMode, setGenMode] = useState<number>(0);
    const [selfResp, setSelfResp] = useState(false);
    const [joinPre, setJoinPre] = useState('');
    const [joinSuf, setJoinSuf] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    /* 开模态时重置草稿(overlay 常驻,复用上次态会带进旧选择)。 */
    useEffect(() => {
        if (!ov.groupOpen) return;
        setName(''); setPicked(new Set()); setStrategy(0); setGenMode(0);
        setSelfResp(false); setJoinPre(''); setJoinSuf(''); setBusy(false); setErr(null);
    }, [ov.groupOpen]);
    if (!ov.groupOpen) return null;

    const cards = [...s.cards.values()].filter((c) => c.readable !== false);
    /* 成员键 = avatar 文件名(服务端 roster 稳定键);JSON 卡无图 → charDir.png
       占位(服务端 avatarToCharDir → loadCharacterDoc 仍解析到卡)。 */
    const memberKey = (c: { charDir: string; avatar: string | null }) => c.avatar ?? `${c.charDir}.png`;
    const toggle = (key: string) => setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const canCreate = s.live && !busy && name.trim().length > 0 && picked.size >= 1;
    const create = () => {
        if (!canCreate) return;
        setBusy(true);
        setErr(null);
        void createGroup({
            name: name.trim(),
            members: [...picked],
            activation_strategy: strategy,
            generation_mode: genMode,
            allow_self_responses: selfResp,
            ...(genMode !== 0 ? { generation_mode_join_prefix: joinPre, generation_mode_join_suffix: joinSuf } : {}),
        })
            .then((doc) => s.refreshChats().then(() => doc))
            .then((doc) => { closeGroupModal(); s.selectChat(`group/${doc.id}/${doc.chat_id ?? doc.id}`); })
            .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    };

    const selCls = 'w-full rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 py-2 text-[12px] text-[color:var(--fg-primary)] outline-none';
    return (
        <div
            className={`${mobile ? 'absolute' : 'fixed'} inset-0 z-[82] flex items-center justify-center bg-black/50 ${mobile ? '' : 'p-4'}`}
            style={{ backdropFilter: 'blur(4px)' }}
            onClick={closeGroupModal}
        >
            <div
                className={mobile
                    ? 'pop-in flex h-full w-full flex-col overflow-hidden'
                    : 'pop-in flex max-h-[82vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl'}
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <span className="heading-tight text-[14px] font-medium text-[color:var(--fg-primary)]">{t('ov.group.title')}</span>
                    <button className="ghost-btn h-7 w-7" onClick={closeGroupModal}><Icon name="x" size={14} /></button>
                </div>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                    {!s.live && <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-2 text-[11.5px] text-[color:var(--fg-muted)]">{t('status.stub')}</div>}
                    <div>
                        <div className="pb-1.5 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('ov.group.name')}</div>
                        <input
                            className={inputCls}
                            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-primary)', height: 34 }}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t('ov.group.namePh')}
                            autoFocus
                        />
                    </div>
                    <div>
                        <div className="flex items-baseline justify-between pb-1.5">
                            <span className="text-[11px] font-medium text-[color:var(--fg-muted)]">{t('ov.group.members')}</span>
                            <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{picked.size}/{cards.length}</span>
                        </div>
                        {cards.length === 0 ? (
                            <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-4 text-center text-[11.5px] text-[color:var(--fg-muted)]">{t('ov.newChat.empty')}</div>
                        ) : (
                            <div className="inset-group max-h-56 overflow-y-auto">
                                {cards.map((c) => {
                                    const key = memberKey(c);
                                    const on = picked.has(key);
                                    return (
                                        <button key={c.charDir} type="button" className="inset-row inset-row-btn w-full" onClick={() => toggle(key)}>
                                            <span className="char-avatar-ring h-7 w-7 shrink-0">
                                                <img src={c.avatar ? charImageUrl(c.avatar) : builtinCoverSrc(c.charDir)} alt="" className="h-full w-full object-cover" onError={charImgFallback} data-cover-key={c.charDir} />
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-left text-[12.5px] text-[color:var(--fg-primary)]">{c.name || c.charDir}</span>
                                            <span
                                                className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border"
                                                style={{
                                                    width: 18, height: 18,
                                                    borderColor: on ? 'var(--brand)' : 'var(--border-bold)',
                                                    background: on ? 'var(--brand)' : 'transparent',
                                                    color: 'var(--brand-fg)',
                                                }}
                                            >
                                                {on && <Icon name="check" size={12} />}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <div className="pb-1.5 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('ov.group.strategy')}</div>
                            <select className={selCls} value={strategy} onChange={(e) => setStrategy(Number(e.target.value))}>
                                <option value={0}>{t('ov.group.strategy.natural')}</option>
                                <option value={1}>{t('ov.group.strategy.list')}</option>
                                <option value={2}>{t('ov.group.strategy.manual')}</option>
                                <option value={3}>{t('ov.group.strategy.pooled')}</option>
                            </select>
                        </div>
                        <div>
                            <div className="pb-1.5 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('ov.group.genmode')}</div>
                            <select className={selCls} value={genMode} onChange={(e) => setGenMode(Number(e.target.value))}>
                                <option value={0}>{t('ov.group.genmode.swap')}</option>
                                <option value={1}>{t('ov.group.genmode.append')}</option>
                                <option value={2}>{t('ov.group.genmode.appendDisabled')}</option>
                            </select>
                        </div>
                    </div>
                    <div className="inset-group">
                        <div className="inset-row">
                            <div className="min-w-0">
                                <div className="text-[12.5px] text-[color:var(--fg-primary)]">{t('ov.group.selfResp')}</div>
                                <div className="text-[10.5px] text-[color:var(--fg-muted)]">{t('ov.group.selfResp.desc')}</div>
                            </div>
                            <button type="button" className="sh-switch" data-checked={selfResp || undefined} onClick={() => setSelfResp((v) => !v)}><span className="sh-switch-thumb" /></button>
                        </div>
                    </div>
                    {genMode !== 0 && (
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <div className="pb-1.5 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('ov.group.joinPre')}</div>
                                <input className={inputCls} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-primary)', height: 34 }} value={joinPre} onChange={(e) => setJoinPre(e.target.value)} placeholder="\n" />
                            </div>
                            <div>
                                <div className="pb-1.5 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('ov.group.joinSuf')}</div>
                                <input className={inputCls} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-primary)', height: 34 }} value={joinSuf} onChange={(e) => setJoinSuf(e.target.value)} placeholder="\n" />
                            </div>
                        </div>
                    )}
                    {err && <div className="rounded-lg px-3 py-2 text-[11.5px]" style={{ background: 'rgba(248,113,113,0.09)', color: 'var(--status-danger)' }}>{err}</div>}
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[color:var(--border-hairline)] px-4 py-3">
                    <button className="ghost-btn h-8 px-3 text-[12px]" onClick={closeGroupModal}>{t('ov.char.cancel')}</button>
                    <button
                        className="h-8 rounded-lg px-4 text-[12px] font-medium transition-opacity"
                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)', opacity: canCreate ? 1 : 0.45 }}
                        disabled={!canCreate}
                        onClick={create}
                    >
                        {busy ? t('ov.group.creating') : t('ov.group.create')}
                    </button>
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
    /* category:'hidden' = 瞬态承载板块(messageframe 等)—— 可开 tab,
       不进 cmdk 目录(与 launcher 同口径:非目录条目)。 */
    const pHits = panels.filter((p) =>
        p.category !== 'hidden' && (!qq || t(`panel.type.${p.type}`).toLowerCase().includes(qq) || p.type.includes(qq)));
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
                                            <img src={card?.avatar ? charImageUrl(card.avatar) : builtinCoverSrc(c.charDir)} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" onError={charImgFallback} data-cover-key={c.charDir} />
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
/* api 页:连接段(PATCH /settings + POST /connection/test + /secrets 全真)。 */
/* ------------------------------------------------------------------ */

/* 连接配置档案制(推翻四源卡):干净 profile 列表 + 编辑器。
   profile = {id,name,format,baseUrl,secretId,models:{checked,manual,lastProbe?},disabled?}
   format → 派发面 + secrets 池:openai → custom 面 / api_key_custom;
   anthropic → claude 面 / api_key_claude(baseUrl 空 = 官方默认端点)。
   探测走目标制(POST /connection/test|models):profile_id 或内联草稿
   {format,baseUrl,secretId,key} —— 编辑器未落盘草稿直测,瞬时 key 不落盘;
   密钥只回显掩码,profile 只存 secretId 引用。'default' 档(迁移合成)置顶。 */
const PROFILE_SECRET_POOL: Record<ConnectionProfileFormat, string> = {
    openai: 'api_key_custom',
    anthropic: 'api_key_claude',
};

/* 供应商预设:格式内可选端点 —— 选预设自动带出 baseUrl(仍可改)。 */
const PROFILE_PRESETS: Record<ConnectionProfileFormat, { id: string; label: string; baseUrl: string }[]> = {
    openai: [
        { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
        { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
        { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
        { id: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1' },
        { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
        { id: 'custom', label: 'Custom', baseUrl: '' },
    ],
    anthropic: [
        { id: 'anthropic', label: 'Anthropic', baseUrl: '' },
        { id: 'custom', label: 'Custom', baseUrl: '' },
    ],
};

const segBtn = (on: boolean): React.CSSProperties => ({
    background: on ? 'var(--primary-bg)' : 'var(--bg-active)',
    color: on ? 'var(--primary-fg)' : 'var(--fg-secondary)',
});

/** 探测目标袋:草稿 + 已存 secretId 引用;keyDraft 非空 → 瞬时明文优先。 */
function draftTarget(format: ConnectionProfileFormat, baseUrl: string, secretId: string | null, keyDraft: string): ConnectionProbeTarget {
    return {
        format,
        baseUrl: baseUrl.trim(),
        secretId,
        ...(keyDraft.trim() ? { key: keyDraft.trim() } : {}),
        fresh: true,
    };
}

function ProfileEditor({ profile, secrets, done }: {
    profile: ConnectionProfile | null;
    secrets: Remote<SecretsResponse>;
    done: () => void;
}) {
    const { t } = useI18n();
    const s = useShell();
    const [name, setName] = useState(profile?.name ?? '');
    const [format, setFormat] = useState<ConnectionProfileFormat>(profile?.format ?? 'openai');
    const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '');
    const [keyDraft, setKeyDraft] = useState('');
    /* checked 用 Set 管勾选态;manual 是手填补充(恒算入并集,不挂勾)。 */
    const [checked, setChecked] = useState<Set<string>>(() => new Set(profile?.models.checked ?? []));
    const [manual, setManual] = useState<string[]>(profile?.models.manual ?? []);
    const [manualDraft, setManualDraft] = useState('');
    const [disabled, setDisabled] = useState(!!profile?.disabled);
    /* fetched = 最近一次上游清单(编辑器内新探 或 profile.lastProbe 回显)。 */
    const [fetched, setFetched] = useState<{ id: string }[] | null>(profile?.models.lastProbe?.items ?? null);
    const [fetchStale, setFetchStale] = useState(false);
    const [probeRes, setProbeRes] = useState<ConnectionTestResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [probing, setProbing] = useState(false);

    const pool = PROFILE_SECRET_POOL[format];
    const presets = PROFILE_PRESETS[format];
    const presetId = presets.find((p) => p.id !== 'custom' && p.baseUrl && p.baseUrl === baseUrl.trim())?.id ?? 'custom';
    /* 格式换了 → 旧 secretId 是别池引用,不能带(跨池 id 解不到)。 */
    const effSecretId = profile && profile.format === format ? profile.secretId : null;
    const entry = effSecretId
        ? (secrets.data?.secrets?.[pool] ?? []).find((en) => en.id === effSecretId) ?? null
        : null;
    const shared = !entry ? (secrets.data?.shared?.[pool] ?? null) : null;

    /* 清单行 = 上游清单 ∪ 已选但不在清单里的(防旧选无声丢勾选)。 */
    const fetchedIds = (fetched ?? []).map((m) => m.id);
    const extraChecked = [...checked].filter((id) => !fetchedIds.includes(id) && !manual.includes(id));
    const rows = [...fetchedIds, ...extraChecked];

    const toggleCheck = (id: string) => setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const addManual = () => {
        const id = manualDraft.trim();
        if (!id || manual.includes(id)) { setManualDraft(''); return; }
        setManual((prev) => [...prev, id]);
        setManualDraft('');
    };

    /* 测试配置 → 拉模型:草稿直测(不存档不切源);ok 后取上游清单进勾选面。 */
    const runProbe = () => {
        if (probing || busy) return;
        setProbing(true);
        setProbeRes(null);
        const target = draftTarget(format, baseUrl, effSecretId, keyDraft);
        void testConnectionTarget(target)
            .then(async (r) => {
                setProbeRes(r);
                if (r.ok) {
                    const m = await listModelsFor(target);
                    setFetched(m.items.map((it) => ({ id: it.id })));
                    setFetchStale(!!m.stale || !!m.error);
                } else {
                    setFetched(null);
                }
            })
            .catch((e) => setProbeRes({
                ok: false, source: format, credential: 'none', latencyMs: 0,
                upstreamStatus: null, error: 'unreachable',
                detail: e instanceof Error ? e.message : String(e),
            }))
            .finally(() => setProbing(false));
    };

    /* openai 面(custom 源)baseUrl 必填;anthropic 面空 = 官方默认端点。 */
    const canSave = !!name.trim() && (format === 'anthropic' || !!baseUrl.trim());
    const save = () => {
        if (busy || !canSave) return;
        setBusy(true);
        void (async () => {
            /* 新 key 先落 secrets 池拿 id —— profile 只存引用不存值。
               activate:false:不抢池 active 槽 —— active 是别档/旧路的
               fallback 凭证,档内显式 secretId 引用不依赖它。 */
            let secretId = effSecretId;
            if (keyDraft.trim()) {
                const r = await putSecret(pool, keyDraft.trim(), name.trim() || undefined, { activate: false });
                secretId = r.id;
            }
            await putProfile(profile?.id ?? 'new', {
                name: name.trim(), format, baseUrl: baseUrl.trim(), secretId,
                models: { checked: [...checked], manual },
                ...(disabled ? { disabled: true } : { disabled: false }),
            });
            secrets.reload();
            await s.refreshConnection();
            done();
        })().catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };

    return (
        <div className="space-y-4">
            <div className="inset-group">
                {/* 头:返回 + 名(就地当标题)。 */}
                <div className="inset-row">
                    <button type="button" className="ghost-btn h-7 w-7 shrink-0" disabled={busy} title={t('stage.edit.cancel')} onClick={done}>
                        <Icon name="arrowLeft" size={14} />
                    </button>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy}
                        placeholder={t('st.conn.namePh')}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-[13px] font-medium text-[color:var(--fg-primary)] outline-none focus:border-[color:var(--border-hairline)] focus:bg-[color:var(--bg-canvas)]"
                    />
                </div>
                {/* 格式分段:openai 面 / anthropic 面(决定派发源与密钥池)。 */}
                <div className="inset-row">
                    <span className="text-[12px] text-[color:var(--fg-muted)]">{t('st.conn.formatLabel')}</span>
                    <div className="flex shrink-0 gap-1">
                        {(['openai', 'anthropic'] as const).map((f) => (
                            <button
                                key={f}
                                type="button"
                                className="h-7 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors"
                                style={segBtn(format === f)}
                                disabled={busy}
                                onClick={() => setFormat(f)}
                            >
                                {f === 'openai' ? 'OpenAI' : 'Anthropic'}
                            </button>
                        ))}
                    </div>
                </div>
                {/* 供应商预设:点选自动带 baseUrl(custom 档=手填)。 */}
                <div className="inset-row">
                    <span className="shrink-0 text-[12px] text-[color:var(--fg-muted)]">{t('st.conn.presetLabel')}</span>
                    <div className="flex min-w-0 flex-wrap justify-end gap-1">
                        {presets.map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                className="h-6 rounded-md px-2 text-[10.5px] font-medium transition-colors"
                                style={segBtn(presetId === p.id)}
                                disabled={busy}
                                onClick={() => { if (p.baseUrl || p.id === 'custom') setBaseUrl(p.baseUrl); }}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                </div>
                {/* Base URL:openai 面必填;anthropic 面留空走官方默认端点。 */}
                <div className="inset-row flex-col !items-stretch gap-1.5">
                    <div className="flex items-center justify-between">
                        <label className="text-[11px] text-[color:var(--fg-muted)]">Base URL</label>
                        <span className={`text-[10px] text-[color:var(--fg-faint)] ${mono}`}>
                            {format === 'anthropic' ? t('st.conn.baseOptional') : t('st.conn.baseRequired')}
                        </span>
                    </div>
                    <input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        disabled={busy}
                        placeholder={format === 'anthropic' ? t('st.conn.basePh') : 'https://api.example.com/v1'}
                        className={`h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-xs text-[color:var(--fg-primary)] outline-none ${mono}`}
                    />
                </div>
                {/* API Key:掩码状态 + 新值(保存时先写 secrets 池再存引用)。 */}
                <div className="inset-row flex-col !items-stretch gap-1.5">
                    <div className="flex items-center justify-between">
                        <label className="text-[11px] text-[color:var(--fg-muted)]">{t('st.conn.secretLabel')}</label>
                        <span className={`text-[10.5px] ${mono}`} style={{ color: entry ? 'var(--status-ok)' : shared ? 'var(--status-info, var(--fg-secondary))' : 'var(--status-warn)' }}
                            title={shared ? t('st.secrets.sharedHint') : pool}>
                            {entry
                                ? `${t('st.secrets.managed')} · ${entry.value}`
                                : shared
                                    ? `${t('st.secrets.shared')}${shared.label ? ` · ${shared.label}` : ''}`
                                    : t('st.secrets.none2')}
                        </span>
                    </div>
                    <input
                        value={keyDraft}
                        onChange={(e) => setKeyDraft(e.target.value)}
                        disabled={busy}
                        type="password"
                        placeholder={entry || shared ? t('st.conn.secretKeepPh') : t('st.conn.secretPh')}
                        className={`h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-xs text-[color:var(--fg-primary)] outline-none ${mono}`}
                    />
                </div>
                {/* 探测行:草稿直测;ok 后上游清单灌进下方勾选面。 */}
                <div className="inset-row">
                    <div className="min-w-0">
                        <div className="text-[12px] font-medium text-[color:var(--fg-primary)]">{t('st.conn.probe')}</div>
                        <div className={`mt-0.5 truncate text-[11px] ${mono}`} style={{
                            color: probeRes
                                ? (probeRes.ok ? 'var(--status-ok)' : 'var(--status-danger)')
                                : 'var(--fg-muted)',
                        }}>
                            {probeRes
                                ? (probeRes.ok
                                    ? `✓ ${probeRes.latencyMs}ms · ${probeRes.modelCount ?? 0} models${probeRes.credential && probeRes.credential !== 'none' ? ` · ${t(`st.cred.${probeRes.credential}`)}` : ''}`
                                    : `✗ ${probeRes.error ?? 'error'}${probeRes.upstreamStatus ? ` (${probeRes.upstreamStatus})` : ''}${probeRes.detail ? ` · ${probeRes.detail}` : ''}`)
                                : t('st.conn.probeDraftHint')}
                        </div>
                    </div>
                    <button
                        type="button"
                        disabled={probing || busy}
                        onClick={runProbe}
                        className="h-8 shrink-0 rounded-lg px-3 text-[11.5px] font-medium transition-opacity"
                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)', opacity: probing || busy ? 0.55 : 1 }}
                    >
                        {probing ? t('st.conn.testing') : t('st.conn.test')}
                    </button>
                </div>
                {/* 勾选面:探测出的上游清单(默认不勾;已选保留勾)。 */}
                {(fetched !== null || extraChecked.length > 0) && (
                    <div className="inset-row flex-col !items-stretch gap-1">
                        <div className="flex items-center justify-between">
                            <label className="text-[11px] text-[color:var(--fg-muted)]">{t('st.conn.modelsLabel')}</label>
                            <span className={`text-[10px] text-[color:var(--fg-faint)] ${mono}`}>
                                {checked.size}{fetchStale ? ` · ${t('st.conn.staleModels')}` : ''}
                            </span>
                        </div>
                        <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] p-1">
                            {rows.map((id) => {
                                const on = checked.has(id);
                                return (
                                    <button
                                        key={id}
                                        type="button"
                                        className="inset-row-btn flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
                                        onClick={() => toggleCheck(id)}
                                    >
                                        <span
                                            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border"
                                            style={{
                                                borderColor: on ? 'var(--brand)' : 'var(--border-hairline)',
                                                background: on ? 'var(--brand)' : 'transparent',
                                                color: 'var(--brand-fg)',
                                            }}
                                        >
                                            {on && <Icon name="check" size={10} />}
                                        </span>
                                        <span className={`truncate text-[11.5px] ${mono}`} style={{ color: on ? 'var(--fg-primary)' : 'var(--fg-muted)' }}>{id}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
                {/* 手填模型:上游清单没列的 id 直接进并集。 */}
                <div className="inset-row flex-col !items-stretch gap-1.5">
                    <label className="text-[11px] text-[color:var(--fg-muted)]">{t('st.conn.manualLabel')}</label>
                    {manual.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            {manual.map((id) => (
                                <span key={id} className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] ${mono}`} style={{ background: 'var(--bg-active)', color: 'var(--fg-secondary)' }}>
                                    {id}
                                    <button type="button" className="text-[color:var(--fg-faint)] hover:text-[color:var(--status-danger)]" disabled={busy} onClick={() => setManual((prev) => prev.filter((x) => x !== id))}>
                                        <Icon name="x" size={10} />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                    <input
                        value={manualDraft}
                        onChange={(e) => setManualDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addManual(); }}
                        onBlur={addManual}
                        disabled={busy}
                        placeholder={t('st.conn.manualPh')}
                        className={`h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-xs text-[color:var(--fg-primary)] outline-none ${mono}`}
                    />
                </div>
                {/* 停用开关:停用档不进派发、不进模型并集。 */}
                <div className="inset-row">
                    <div className="min-w-0">
                        <div className="text-[12px] font-medium text-[color:var(--fg-primary)]">{t('st.conn.disableLabel')}</div>
                    </div>
                    <button type="button" className="sh-switch" data-checked={disabled || undefined} disabled={busy} onClick={() => setDisabled(!disabled)}>
                        <span className="sh-switch-thumb" />
                    </button>
                </div>
            </div>
            <button
                type="button"
                className="h-9 w-full rounded-xl text-[12.5px] font-medium transition-opacity"
                style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: busy || !canSave ? 0.5 : 1 }}
                disabled={busy || !canSave}
                onClick={save}
            >
                {t('st.secrets.save')}
            </button>
        </div>
    );
}

function ConnectionSection() {
    const { t } = useI18n();
    const s = useShell();
    const open = s.settingsOpen;
    const profiles = useRemote(open ? 'st:conn-profiles' : null, listProfiles);
    const secrets = useRemote(open ? 'st:secrets' : null, listSecrets);
    /* editing:null=列表;'new'=新建;其余=profile id。 */
    const [editing, setEditing] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [delArm, setDelArm] = useState<string | null>(null);

    const list = profiles.data?.profiles ?? [];
    /* 'default' 档(迁移合成)恒置顶,其余按存储序。 */
    const sorted = [...list].sort((a, b) => (a.id === 'default' ? 0 : 1) - (b.id === 'default' ? 0 : 1));
    const activePid = s.activeModel?.profileId || profiles.data?.activeModel?.profileId || '';
    const editingProfile = editing && editing !== 'new' ? (list.find((p) => p.id === editing) ?? null) : null;

    const actDelete = (id: string) => {
        if (busy) return;
        setBusy(true);
        void deleteProfile(id)
            .then(() => { profiles.reload(); void s.refreshConnection(); })
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => { setBusy(false); setDelArm(null); });
    };

    if (editing !== null) {
        return (
            <ProfileEditor
                profile={editingProfile}
                secrets={secrets}
                done={() => { setEditing(null); profiles.reload(); }}
            />
        );
    }

    const secretKeys = Object.keys(secrets.data?.secrets ?? {});
    const groups = secretKeys.filter((k) => secrets.data!.secrets[k]?.length);
    const actListSecret = (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        void fn()
            .then(() => { secrets.reload(); void s.refreshConnection({ freshModels: true }); })
            .catch((e) => s.hint(`${t('st.secrets.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };

    return (
        <div className="space-y-4">
            <div className="inset-group">
                {sorted.map((p) => {
                    const nModels = p.models.checked.length + p.models.manual.length;
                    return (
                        <div key={p.id} className="inset-row">
                            <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                    <span className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]" style={{ opacity: p.disabled ? 0.5 : 1 }}>{p.name}</span>
                                    <span className={`shrink-0 rounded px-1 py-px text-[9.5px] font-medium ${mono}`} style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>
                                        {p.format === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                                    </span>
                                    {p.id === 'default' && (
                                        <span className="shrink-0 text-[9.5px] text-[color:var(--fg-faint)]">{t('st.conn.defaultBadge')}</span>
                                    )}
                                    {p.disabled && (
                                        <span className="shrink-0 text-[9.5px] text-[color:var(--status-warn)]">{t('st.conn.disabledBadge')}</span>
                                    )}
                                    {activePid === p.id && !p.disabled && (
                                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)' }}>
                                            {t('st.conn.activeBadge')}
                                        </span>
                                    )}
                                </div>
                                <div className={`mt-0.5 truncate text-[10.5px] text-[color:var(--fg-muted)] ${mono}`}>
                                    {p.baseUrl || (p.format === 'anthropic' ? 'api.anthropic.com' : '—')}
                                    {` · ${nModels} ${t('st.conn.modelLabel')}`}
                                </div>
                            </div>
                            <button type="button" className="ghost-btn h-7 w-7 shrink-0" disabled={busy} title={t('st.conn.edit')} onClick={() => setEditing(p.id)}>
                                <Icon name="pencil" size={12} />
                            </button>
                            <button
                                type="button"
                                className="ghost-btn h-7 shrink-0 px-1.5 text-[10.5px]"
                                style={{ color: delArm === p.id ? 'var(--brand-fg)' : 'var(--status-danger)', background: delArm === p.id ? 'var(--status-danger)' : undefined }}
                                disabled={busy}
                                title={t('st.conn.delete')}
                                onClick={() => { if (delArm === p.id) actDelete(p.id); else { setDelArm(p.id); setTimeout(() => setDelArm((cur) => (cur === p.id ? null : cur)), 2500); } }}
                            >
                                {delArm === p.id ? t('st.conn.delConfirm') : <Icon name="trash" size={12} />}
                            </button>
                        </div>
                    );
                })}
                {sorted.length === 0 && (
                    <div className="inset-row">
                        <span className="text-[11.5px] text-[color:var(--fg-muted)]">
                            {profiles.loading ? '…' : (profiles.error ?? t('st.conn.empty'))}
                        </span>
                    </div>
                )}
                <div className="inset-row">
                    <button
                        type="button"
                        className="inset-row-btn flex w-full items-center justify-center gap-1.5 rounded-lg py-1 text-[12px] font-medium text-[color:var(--fg-secondary)]"
                        disabled={busy}
                        onClick={() => setEditing('new')}
                    >
                        <Icon name="plus" size={13} />
                        {t('st.conn.addProfile')}
                    </button>
                </div>
            </div>
            {/* 真 secrets 脱敏面(全键清单,含四家以外的槽)。 */}
            {(groups.length > 0 || secrets.error) && (
                <div className="inset-group">
                    {groups.map((key) => (secrets.data!.secrets[key] ?? []).map((en: SecretEntry) => (
                        <div key={`${key}:${en.id}`} className="inset-row">
                            <div className="min-w-0">
                                <div className={`truncate text-[11.5px] font-medium text-[color:var(--fg-primary)] ${mono}`}>{key}{en.label ? <span className="ml-1.5 text-[10px] font-normal text-[color:var(--fg-muted)]">{en.label}</span> : null}</div>
                                <div className={`truncate text-[10px] text-[color:var(--fg-faint)] ${mono}`}>{en.value}{en.active ? ` · ${t('st.secrets.active')}` : ''}</div>
                            </div>
                            <button className="ghost-btn h-6 w-6 shrink-0" disabled={busy} title={t('st.secrets.delete')} onClick={() => actListSecret(() => deleteSecret(key, en.id))} style={{ color: 'var(--status-danger)' }}>
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

function AccountSection() {
    const { t } = useI18n();
    const s = useShell();
    const me = s.currentUser;
    const [nameVal, setNameVal] = useState(me?.name ?? '');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setNameVal(me?.name ?? '');
    }, [me?.name, me?.handle]);

    const saveName = () => {
        if (!me || busy || !nameVal.trim() || nameVal.trim() === me.name) return;
        setBusy(true);
        void changeUserName(me.handle, nameVal.trim())
            .then(() => s.refreshCurrentUser())
            .then(() => s.hint(t('acct.saved')))
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${accountErrorText(e, t)}`, true))
            .finally(() => setBusy(false));
    };

    const rowLbl = 'text-[12px] text-[color:var(--fg-secondary)]';
    return (
        <div className="inset-group">
            <div className="inset-row">
                <span className={rowLbl}>Handle</span>
                <span className={`text-[11.5px] text-[color:var(--fg-primary)] ${mono}`}>
                    {me?.handle ?? (s.live ? 'default-user' : t('diag.job.offline'))}
                    {me?.admin ? <span className="ml-1.5 rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>admin</span> : null}
                </span>
            </div>
            <div className="inset-row gap-2">
                <span className={rowLbl}>{t('studio.persona.namePh')}</span>
                {me ? (
                    <div className="flex items-center gap-1.5">
                        <input
                            value={nameVal}
                            onChange={(e) => setNameVal(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
                            disabled={busy}
                            className="h-7 w-[160px] rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2 text-xs text-[color:var(--fg-primary)] outline-none"
                        />
                        {nameVal.trim() !== me.name && nameVal.trim() && (
                            <button
                                className="h-7 rounded-lg px-2.5 text-[11px] font-medium"
                                style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)' }}
                                disabled={busy}
                                onClick={saveName}
                            >
                                {t('stage.edit.save')}
                            </button>
                        )}
                    </div>
                ) : (
                    <span className={`text-[11px] text-[color:var(--fg-muted)] ${mono}`}>{t('acct.name')}</span>
                )}
            </div>
            <div className="inset-row">
                <span className={rowLbl}>{t('app.name')}</span>
                <span className={`text-[11px] ${mono}`} style={{ color: s.live ? 'var(--status-ok)' : 'var(--status-warn)' }}>
                    {s.live ? t('acct.plan') : t('diag.job.offline')}
                </span>
            </div>
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
    /* plugins 页签与插件页共享 PluginsSections(规范稿 renderPluginsSections
       两处用)—— full 模式无视 pluginsNav 过滤,三段全出。 */
    const serverPlugins = useServerPlugins();
    const sw = (on: boolean, fn: () => void) => <button className="sh-switch" data-checked={on || undefined} onClick={fn}><span className="sh-switch-thumb" /></button>;
    const rowLbl = 'text-[12px] text-[color:var(--fg-secondary)]';
    return (
        <>
            {s.settingsTab === 'api' && <ConnectionSection />}
                        {s.settingsTab === 'chat' && (
                            <div className="inset-group">
                                <div className="inset-row"><span className={rowLbl}>{t('st.renderCount')}</span><input type="range" min={5} max={200} step={5} value={cs.renderCount} onChange={(e) => s.setChatSetting('renderCount', Number(e.target.value))} className="w-[140px]" /><span className="w-9 text-right font-mono-ui text-[10.5px]">{cs.renderCount}</span></div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.fontSize')}</span><input type="range" min={12} max={18} step={0.5} value={cs.fontSize} onChange={(e) => s.setChatSetting('fontSize', Number(e.target.value))} className="w-[140px]" /><span className="w-9 text-right font-mono-ui text-[10.5px]">{cs.fontSize}</span></div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.showFloorNum')}</span>{sw(cs.showFloorNum, () => s.setChatSetting('showFloorNum', !cs.showFloorNum))}</div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.autoParseThink')}</span>{sw(cs.autoParseThink, () => s.setChatSetting('autoParseThink', !cs.autoParseThink))}</div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.autoExpandThink')}</span>{sw(cs.autoExpandThink, () => s.setChatSetting('autoExpandThink', !cs.autoExpandThink))}</div>
                                <div className="inset-row"><span className={rowLbl}>{t('st.confirmDelete')}</span>{sw(cs.confirmDelete, () => s.setChatSetting('confirmDelete', !cs.confirmDelete))}</div>
                            </div>
                        )}
                        {s.settingsTab === 'appearance' && <StAppearanceSection />}
                        {s.settingsTab === 'plugins' && <PluginsSections full plugins={serverPlugins} />}
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
            {s.settingsTab === 'account' && <AccountSection />}
        </>
    );
}

/** 外观页签 —— 聊天背景(内置 /assets/ 壁纸 + 服务端 Backgrounds 目录两组,
 *  同一 settings.background 槽)+ power_user.custom_css + 全局氛围层。
 *  写面仍是 ST 槽形:settings.background(#bg1 全局)+
 *  chat_metadata.custom_background(会话锁)—— 与生态卡写入语义同构,
 *  读侧渲染链(AmbientBackdrop 锁>全局)不动。 */
function StAppearanceSection() {
    const { t } = useI18n();
    const s = useShell();
    const cs = s.chatSettings;
    const bgs = useRemote(s.settingsOpen ? 'st:backgrounds' : null, listBackgrounds);
    const [cssDraft, setCssDraft] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const ambTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cssShown = cssDraft ?? s.stCss;
    const cssDirty = cssDraft !== null && cssDraft !== s.stCss;

    /* Ambience sliders: ctx write applies the CSS var instantly; the
       debounced (450ms) PATCH persists the ui_ambience slot. Server-side
       NESTED_MERGE_SLOTS deep-merges it, so keys this writer does not emit
       survive (tex_alpha orphans); flags still ride explicitly so unpin's
       false beats a stored true. */
    const setAmb = (next: UiAmbience) => {
        s.setUiAmbience(next);
        if (ambTimer.current) clearTimeout(ambTimer.current);
        ambTimer.current = setTimeout(() => {
            void patchSettings({ power_user: { ui_ambience: uiAmbienceSlot(next) } }).catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true));
        }, 450);
    };

    /* sel=null → 「无」;name 即 stBg.name 选中态判据(目录图=文件名,
       内置图=builtin:<key>),url 是 CSS url() 落盘形。 */
    const pickBg = (sel: { name: string; url: string } | null) => {
        if (busy) return;
        setBusy(true);
        /* ST 槽形:{name,url,fitting};「无」写空 url(渲染判空不画层,
           name 沿用 __transparent.png 哨兵 —— 与生态卡写「无背景」同形)。 */
        const bg = sel
            ? { name: sel.name, url: sel.url, fitting: 'classic' }
            : { name: '__transparent.png', url: '', fitting: 'classic' };
        void patchSettings({ background: bg })
            .then(() => { s.setStBg(sel ? bg : null); void s.refreshConnection(); })
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };

    const lockToChat = (on: boolean) => {
        const chat = s.chat;
        const url = s.stBg?.url ?? '';
        if (!chat || busy || (on && !url)) return;
        setBusy(true);
        /* json-patch add = upsert;解锁写空串(读侧 falsy 即无锁)。
           群会话走 groups 域(charDir 为空,与 StageFrame 的 dispatch 同款)。 */
        const ops: ChatPatchOp[] = [{ op: 'add', path: '/header/chat_metadata/custom_background', value: on ? url : '' }];
        const req = chat.groupId
            ? patchGroupChat(chat.groupId, chat.chatName, ops)
            : patchChat(chat.charDir, chat.chatName, ops);
        void req
            .then(() => s.setChatBgLock(on ? url : null))
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };

    const saveCss = () => {
        if (busy || !cssDirty) return;
        setBusy(true);
        void patchSettings({ power_user: { custom_css: cssShown } })
            .then(() => { s.setStCss(cssShown); setCssDraft(null); void s.refreshConnection(); })
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };

    const selName = s.stBg?.name ?? '__transparent.png';
    const selNone = !s.stBg || selName === '__transparent.png';
    const locked = !!s.chatBgLock;
    /* __transparent.png 是 ST 「无背景」哨兵图(68B 透明像素)—— 网格首卡
       已占这个语义位,目录实体不再单列。 */
    const items = (bgs.data?.items ?? []).filter((b) => b.filename !== '__transparent.png');
    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('st.chatBg')}</span>
                    {s.chat && (
                        <label className="flex items-center gap-1.5 text-[10.5px] text-[color:var(--fg-muted)]" title={t('st.chatBg.lockTip')}>
                            <input type="checkbox" checked={locked} disabled={busy || (!locked && !s.stBg)} onChange={(e) => lockToChat(e.target.checked)} />
                            {t('st.chatBg.lock')}
                        </label>
                    )}
                </div>
                <div className="px-0.5 pt-0.5 text-[10.5px] font-medium text-[color:var(--fg-muted)]">{t('st.chatBg.builtin')}</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <button
                        className="overflow-hidden rounded-xl border text-left transition-all"
                        style={{ borderColor: selNone ? 'var(--primary-bg)' : 'var(--border-hairline)', background: 'var(--bg-surface)' }}
                        onClick={() => pickBg(null)}
                        disabled={busy}
                    >
                        <div className="flex h-12 items-center justify-center text-[11px] text-[color:var(--fg-muted)]">{t('st.stBg.none')}</div>
                        <div className="truncate px-2 py-1 text-[10.5px] text-[color:var(--fg-secondary)]">{t('st.chatBg.none')}</div>
                    </button>
                    {BUILTIN_WALLPAPERS.map((w) => (
                        <button
                            key={w.key}
                            className="overflow-hidden rounded-xl border text-left transition-all"
                            style={{ borderColor: selName === `builtin:${w.key}` ? 'var(--primary-bg)' : 'var(--border-hairline)', background: 'var(--bg-surface)' }}
                            onClick={() => pickBg({ name: `builtin:${w.key}`, url: builtinBgCssUrl(w.file) })}
                            disabled={busy}
                        >
                            <img src={`/assets/backgrounds/${w.file}`} alt="" loading="lazy" className="h-12 w-full object-cover" />
                            <div className="truncate px-2 py-1 text-[10.5px] text-[color:var(--fg-secondary)]">{t(`st.chatBg.wall.${w.key}`)}</div>
                        </button>
                    ))}
                </div>
                <div className="px-0.5 pt-1 text-[10.5px] font-medium text-[color:var(--fg-muted)]">{t('st.chatBg.server')}</div>
                {items.length > 0 && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {items.map((b) => (
                            <button
                                key={b.filename}
                                className="overflow-hidden rounded-xl border text-left transition-all"
                                style={{ borderColor: selName === b.filename ? 'var(--primary-bg)' : 'var(--border-hairline)', background: 'var(--bg-surface)' }}
                                onClick={() => pickBg({ name: b.filename, url: bgCssUrl(b.filename) })}
                                disabled={busy}
                            >
                                <img src={b.url} alt="" loading="lazy" className="h-12 w-full object-cover" />
                                <div className="truncate px-2 py-1 text-[10.5px] text-[color:var(--fg-secondary)]">{b.filename}</div>
                            </button>
                        ))}
                    </div>
                )}
                <div className="px-0.5 text-[10.5px] text-[color:var(--fg-faint)]">{t('st.chatBg.dir')}</div>
                {!bgs.data && bgs.error && <div className="px-0.5 text-[10.5px] text-[color:var(--status-warn)]">{bgs.error}</div>}
            </div>
            <div className="space-y-1.5">
                <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('st.customCss')}</span>
                    {cssDirty && (
                        <button className="h-6 rounded-md px-2.5 text-[10.5px] font-medium" style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)' }} disabled={busy} onClick={saveCss}>
                            {t('st.secrets.save')}
                        </button>
                    )}
                </div>
                <textarea
                    rows={4}
                    value={cssShown}
                    placeholder={t('st.customCss.ph')}
                    onChange={(e) => setCssDraft(e.target.value)}
                    onBlur={saveCss}
                    className="w-full select-text rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-3 font-mono-ui text-[11.5px] text-[color:var(--fg-secondary)] outline-none"
                />
            </div>
            {/* 全局氛围层:壁纸浓度 / 毛玻璃 —— power_user.ui_ambience 服务端槽 */}
            <div className="space-y-2.5">
                <div className="px-0.5 text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('st.amb.title')}</div>
                {([
                    { k: 'bgAlpha' as const, lbl: t('st.amb.bg'), min: 0, max: 0.9, step: 0.02, fmt: (v: number) => `${Math.round(v * 100)}%` },
                    { k: 'glassBlur' as const, lbl: t('st.amb.glass'), min: 0, max: 28, step: 1, fmt: (v: number) => `${v}px` },
                ]).map(({ k, lbl, min, max, step, fmt }) => {
                    /* Dragging pins the value inline (override); the trailing
                       slot shows the source — a "follow CSS" reset link while
                       pinned, a quiet tag while the stylesheet owns the var. */
                    const pinned = ambiencePinned(s.uiAmbience, k);
                    return (
                        <div key={k} className="flex items-center gap-3 px-0.5">
                            <span className="w-16 shrink-0 text-[11.5px] text-[color:var(--fg-secondary)]">{lbl}</span>
                            <input
                                type="range" min={min} max={max} step={step}
                                value={s.uiAmbience[k]}
                                onChange={(e) => setAmb(pinAmbience(s.uiAmbience, k, Number(e.target.value)))}
                                className={`min-w-0 flex-1${pinned ? '' : ' opacity-60'}`}
                            />
                            <span className={`w-10 shrink-0 text-right font-mono-ui text-[11px] text-[color:var(--fg-muted)]${pinned ? '' : ' opacity-60'}`}>{fmt(s.uiAmbience[k])}</span>
                            {pinned ? (
                                <button
                                    type="button"
                                    title={t('st.amb.followCssTip')}
                                    onClick={() => setAmb(unpinAmbience(s.uiAmbience, k))}
                                    className="w-[68px] shrink-0 text-right text-[10.5px] text-[color:var(--fg-secondary)] underline decoration-dotted underline-offset-2 hover:text-[color:var(--fg-primary)]"
                                >
                                    {t('st.amb.followCss')}
                                </button>
                            ) : (
                                <span
                                    title={t('st.amb.followCssTip')}
                                    className="w-[68px] shrink-0 text-right text-[10.5px] text-[color:var(--fg-faint)]"
                                >
                                    {t('st.amb.followCss')}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** 桌面设置:fixed 居中两栏模态(规范稿 renderSettingsModalHtml 桌面分支)。 */
function SettingsSheet() {
    const { t } = useI18n();
    const s = useShell();
    if (!s.settingsOpen) return null;
    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.58)', backdropFilter: 'blur(4px)' }} onClick={s.closeSettings}>
            <div className="flex h-[540px] w-full max-w-[760px] flex-row overflow-hidden rounded-2xl" style={{ background: 'var(--bg-workbench)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
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
        <div className="absolute inset-0 z-[80] flex flex-col" style={{ background: 'var(--bg-workbench)' }}>
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
            <NewChatModal />
            <GroupModal />
        </>
    );
}
