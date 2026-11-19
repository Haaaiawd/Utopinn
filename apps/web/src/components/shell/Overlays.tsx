// 全局弹层:cmdk 命令面板 + 设置模态 + 移动壳(hub/抽屉/vaul-sheet)。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useContribs, useShell } from '../../kernel/context';
import { Icon, type IconName } from '../Icon';
import { LogoU } from '../LogoU';
import { RAIL_VIEWS } from '../../types';

interface CmdkItem { id: string; label: string; icon: IconName; hint?: string; run: () => void }

export function Cmdk() {
    const { t } = useI18n();
    const shell = useShell();
    const { cmdkOpen, setCmdkOpen, chats, selectChat, setView, newChat, openLauncher, addPanel, panels, cards } = shell;
    const types = useContribs('panel.type');
    const views = useContribs('view');
    const [q, setQ] = useState('');
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdkOpen(!cmdkOpen); }
            if (e.key === 'Escape') setCmdkOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [cmdkOpen, setCmdkOpen]);
    useEffect(() => { if (cmdkOpen) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [cmdkOpen]);

    const items = useMemo<CmdkItem[]>(() => {
        const out: CmdkItem[] = [];
        for (const v of views)
            out.push({ id: `v-${v.view}`, label: t(`nav.${v.view}`), icon: 'layout', hint: t('cmdk.goto'), run: () => setView(v.view) });
        for (const c of chats)
            out.push({ id: `c-${c.id}`, label: c.title, icon: 'messages', hint: cards.get(c.charDir)?.name ?? c.charDir, run: () => selectChat(c.id) });
        for (const p of types)
            out.push({ id: `p-${p.type}`, label: t(`panel.type.${p.type}`), icon: p.icon, hint: t('cmdk.panel'), run: () => addPanel(p.type) });
        out.push({ id: 'a-new', label: t('sidebar.newChat'), icon: 'plus', run: () => newChat() });
        out.push({ id: 'a-launcher', label: t('wb.launcher'), icon: 'grid', run: openLauncher });
        out.push({ id: 'a-panels', label: t('cmdk.panelsCount').replace('{n}', String(panels.length)), icon: 'layers', run: openLauncher });
        return out;
    }, [views, chats, types, t, setView, selectChat, addPanel, newChat, openLauncher, cards, panels.length]);

    const filtered = useMemo(() => {
        const s = q.trim().toLowerCase();
        if (!s) return items.slice(0, 14);
        return items.filter((i) => (i.label + (i.hint ?? '')).toLowerCase().includes(s)).slice(0, 14);
    }, [items, q]);

    if (!cmdkOpen) return null;
    const pick = (i: CmdkItem) => { setCmdkOpen(false); i.run(); };
    return (
        <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/45 pt-[14vh]" onMouseDown={() => setCmdkOpen(false)}>
            <div className="pop-in w-[560px] max-w-[92vw] overflow-hidden rounded-[12px] bg-[color:var(--bg-elevated)] shadow-[var(--shadow-pop)]" onMouseDown={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 border-b border-[color:var(--border-hairline)] px-3.5">
                    <Icon name="search" size={15} className="text-[color:var(--fg-muted)]" />
                    <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }}
                        onKeyDown={(e) => {
                            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
                            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
                            if (e.key === 'Enter' && filtered[sel]) pick(filtered[sel]!);
                        }}
                        placeholder={t('cmdk.placeholder')}
                        className="h-11 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[color:var(--fg-faint)]" />
                    <kbd className="font-mono-ui rounded border border-[color:var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[color:var(--fg-muted)]">esc</kbd>
                </div>
                <div className="no-scrollbar max-h-[46vh] overflow-y-auto p-1.5">
                    {filtered.map((i, idx) => (
                        <button key={i.id} type="button" onClick={() => pick(i)} onMouseEnter={() => setSel(idx)}
                            className={`flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] ${idx === sel ? 'bg-[color:var(--bg-active)] text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)]'}`}>
                            <Icon name={i.icon} size={15} />
                            <span className="flex-1 truncate">{i.label}</span>
                            {i.hint && <span className="truncate text-[11px] text-[color:var(--fg-faint)]">{i.hint}</span>}
                        </button>
                    ))}
                    {filtered.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-[color:var(--fg-muted)]">{t('cmdk.empty')}</div>}
                </div>
            </div>
        </div>
    );
}

const SETTING_TABS = ['account', 'api', 'chat', 'appearance', 'about'] as const;

export function SettingsModal() {
    const { t } = useI18n();
    const { settingsOpen, closeSettings, settingsTab, setSettingsTab, chatSettings, setChatSetting } = useShell();
    useEffect(() => {
        if (!settingsOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [settingsOpen, closeSettings]);
    if (!settingsOpen) return null;
    return (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-6" onMouseDown={closeSettings}>
            <div className="pop-in flex h-[560px] w-[760px] max-w-full overflow-hidden rounded-[14px] bg-[color:var(--bg-workbench)] shadow-[var(--shadow-pop)]"
                onMouseDown={(e) => e.stopPropagation()}>
                <nav className="w-[168px] shrink-0 border-r border-[color:var(--border-hairline)] bg-[color:var(--bg-chrome)] p-2">
                    <div className="px-2 pb-2 pt-1.5 text-[12px] font-medium text-[color:var(--fg-muted)]">{t('nav.settings')}</div>
                    {SETTING_TABS.map((tab) => (
                        <button key={tab} type="button" onClick={() => setSettingsTab(tab)}
                            className={`flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] ${settingsTab === tab ? 'bg-[color:var(--bg-active)] text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-surface-hover)]'}`}>
                            {t(`st.${tab}`)}
                        </button>
                    ))}
                </nav>
                <div className="no-scrollbar min-w-0 flex-1 overflow-y-auto p-5">
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="heading-tight text-[15px]">{t(`st.${settingsTab}`)}</h2>
                        <button type="button" className="ghost-btn h-7 w-7" onClick={closeSettings}><Icon name="x" size={15} /></button>
                    </div>
                    {settingsTab === 'chat' && (
                        <div className="inset-group">
                            {([
                                ['st.renderCount', 'renderCount', 'num'],
                                ['st.streamFps', 'streamFps', 'num'],
                                ['st.autoParseThink', 'autoParseThink', 'bool'],
                                ['st.autoExpandThink', 'autoExpandThink', 'bool'],
                                ['st.showFloorNum', 'showFloorNum', 'bool'],
                                ['st.confirmDelete', 'confirmDelete', 'bool'],
                                ['st.fontSize', 'fontSize', 'num'],
                            ] as const).map(([key, field, kind]) => (
                                <div key={key} className="inset-row">
                                    <span className="text-[13px] text-[color:var(--fg-primary)]">{t(key)}</span>
                                    {kind === 'bool' ? (
                                        <button type="button" className="sh-switch" data-checked={Boolean(chatSettings[field as 'autoParseThink'])}
                                            onClick={() => setChatSetting(field as 'autoParseThink', !chatSettings[field as 'autoParseThink'])}>
                                            <span className="sh-switch-thumb" />
                                        </button>
                                    ) : (
                                        <input type="number" className="sh-select-trigger w-[84px]" value={Number(chatSettings[field as 'fontSize'])}
                                            onChange={(e) => setChatSetting(field as 'fontSize', Number(e.target.value))} />
                                    )}
                                </div>
                            ))}
                            <div className="inset-row">
                                <span className="text-[13px] text-[color:var(--fg-primary)]">{t('st.customCss')}</span>
                                <span className="text-[11px] text-[color:var(--fg-faint)]">{t('panel.stub')}</span>{/* SPEC-DATA: 待接 */}
                            </div>
                        </div>
                    )}
                    {settingsTab === 'api' && (
                        <div className="inset-group">
                            <div className="inset-row"><span className="text-[13px]">{t('st.endpoint')}</span>
                                <input className="sh-select-trigger w-[220px]" value={chatSettings.endpoint} onChange={(e) => setChatSetting('endpoint', e.target.value)} /></div>
                            <div className="inset-row"><span className="text-[13px]">{t('st.apiTab')}</span>
                                <span className="text-[11px] text-[color:var(--fg-faint)]">{chatSettings.apiTab} · {t('panel.stub')}</span></div>
                        </div>
                    )}
                    {(settingsTab === 'account' || settingsTab === 'appearance' || settingsTab === 'about') && (
                        <SettingsExtra tab={settingsTab} />
                    )}
                </div>
            </div>
        </div>
    );
}

function SettingsExtra({ tab }: { tab: string }) {
    const { t } = useI18n();
    const { vpMode, setVpMode } = useShell();
    if (tab === 'appearance') return (
        <div className="inset-group">
            <div className="inset-row"><span className="text-[13px]">{t('shell.theme')}</span>
                <span className="text-[11px] text-[color:var(--fg-faint)]">{t('st.appearanceHint')}</span></div>
            <div className="inset-row"><span className="text-[13px]">{t('st.viewport')}</span>
                <div className="flex items-center rounded-[8px] border border-[color:var(--border-hairline)] p-0.5">
                    {(['auto', 'desktop', 'mobile'] as const).map((m) => (
                        <button key={m} type="button"
                            className={`rounded-[6px] px-2 py-0.5 text-[11px] ${vpMode === m ? 'bg-[color:var(--bg-active)] text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-muted)]'}`}
                            onClick={() => setVpMode(m)}>
                            {t(`vp.${m}`)}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
    if (tab === 'about') return (
        <div className="inset-group">
            <div className="inset-row"><span className="text-[13px]">Utopinn</span><span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">web-shell · spec u_ui_codex</span></div>
        </div>
    );
    return (
        <div className="inset-group">
            <div className="inset-row"><span className="text-[13px]">{t('dock.profile')}</span>
                <span className="text-[11px] text-[color:var(--fg-faint)]">{t('panel.stub')}</span></div>{/* SPEC-DATA: 待接 */}
        </div>
    );
}

/* =========================================================================
   移动壳:hub(资产工坊页)+ 左抽屉 + vaul 底Sheet(closed/half/full)。
   ========================================================================= */
export function MobileFrame() {
    const { t } = useI18n();
    const { mobileDrawer, setMobileDrawer, sheetSnap, setSheetSnap, setView, addPanel } = useShell();
    const rail = useContribs('nav.rail');
    const types = useContribs('panel.type');
    const panels = useShell().panels;
    const activePanel = useShell().activePanel;
    const active = panels.find((p) => p.id === activePanel) ?? panels[panels.length - 1];
    const Body = active ? types.find((tp) => tp.type === active.type)?.Body : undefined;
    const [drag, setDrag] = useState<{ y0: number; h0: number } | null>(null);

    // vaul 拖拽:抓把手,按位移阈值决定吸附位
    const onHandleDown = (e: React.PointerEvent) => {
        const sheet = (e.currentTarget as HTMLElement).closest('.vaul-sheet') as HTMLElement | null;
        const h0 = sheet ? sheet.getBoundingClientRect().height : 0;
        setDrag({ y0: e.clientY, h0 });
        const mv = (ev: PointerEvent) => {
            if (!sheet) return;
            const parent = sheet.parentElement!.getBoundingClientRect().height;
            const target = (h0 - (ev.clientY - e.clientY)) / parent;
            sheet.classList.add('dragging');
            sheet.style.height = `${Math.min(0.92, Math.max(0.1, target)) * 100}%`;
        };
        const up = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', mv);
            window.removeEventListener('pointerup', up);
            if (!sheet) return;
            sheet.classList.remove('dragging');
            sheet.style.height = '';
            const delta = e.clientY - ev.clientY; // 上拖为正
            if (sheetSnap === 'closed' || sheetSnap === 'half') setSheetSnap(delta > 30 ? 'full' : delta < -30 ? 'closed' : sheetSnap === 'closed' ? 'half' : 'half');
            else setSheetSnap(delta < -40 ? 'half' : 'full');
            setDrag(null);
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
    };

    return (
        <div className="mobile-wrap">
            <div className="mobile-shell">
                {/* hub 页(view='hub' 贡献出口渲染资产网格) */}
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[color:var(--border-hairline)] px-3">
                    <button type="button" className="ghost-btn h-8 w-8" onClick={() => setMobileDrawer(true)}><Icon name="menu" size={17} /></button>
                    <LogoU size={20} />
                    <span className="heading-tight flex-1 text-[14px]">{t('app.name')}</span>
                    <button type="button" className="ghost-btn h-8 w-8" onClick={() => setSheetSnap(sheetSnap === 'closed' ? 'half' : 'closed')}>
                        <Icon name="grid" size={16} />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden"><MobileHubOutlet /></div>

                {/* mob-drawer */}
                <div className="mob-drawer" data-open={mobileDrawer}>
                    <div className="flex items-center justify-between p-3">
                        <span className="flex items-center gap-2 text-[14px] font-medium">
                            <LogoU size={19} />{t('app.name')}
                        </span>
                        <button type="button" className="ghost-btn h-7 w-7" onClick={() => setMobileDrawer(false)}><Icon name="x" size={15} /></button>
                    </div>
                    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                        {RAIL_VIEWS.map((id) => {
                            const r = rail.find((x) => x.view === id);
                            if (!r) return null;
                            return (
                                <button key={id} type="button" onClick={() => { setView(id); setMobileDrawer(false); }}
                                    className="flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2.5 text-left text-[13px] text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-surface-hover)]">
                                    <Icon name={r.icon} size={17} />{t(`nav.${r.view}`)}
                                </button>
                            );
                        })}
                        <div className="mt-3 px-3 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('wb.launcher.suggested')}</div>
                        {types.map((p) => (
                            <button key={p.type} type="button" onClick={() => { openPanelInSheet(p.type); }}
                                className="flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left text-[13px] text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-surface-hover)]">
                                <Icon name={p.icon} size={16} />{t(`panel.type.${p.type}`)}
                            </button>
                        ))}
                    </div>
                </div>
                {mobileDrawer && <div className="absolute inset-0 z-[54] bg-black/40" onClick={() => setMobileDrawer(false)} />}

                {/* vaul-sheet:工作台板块容器 */}
                <div className={`vaul-sheet${drag ? ' dragging' : ''}`} data-snap={sheetSnap}>
                    <div className="flex h-9 shrink-0 cursor-grab touch-none items-center justify-center" onPointerDown={onHandleDown}>
                        <span className="h-1 w-9 rounded-full bg-[color:var(--border-strong)]" />
                    </div>
                    <div className="flex items-center gap-1 border-b border-[color:var(--border-hairline)] px-3 pb-2">
                        <span className="text-[12px] font-medium text-[color:var(--fg-primary)]">
                            {active ? t(`panel.type.${active.type}`) : t('wb.launcher')}
                        </span>
                    </div>
                    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                        {Body ? <Body /> : <SheetPicker />}
                    </div>
                </div>
                {sheetSnap !== 'closed' && <div className="absolute inset-0 z-[44] bg-black/30" onClick={() => setSheetSnap('closed')} />}
            </div>
        </div>
    );

    function openPanelInSheet(type: string) {
        addPanel(type);
        setMobileDrawer(false);
        setSheetSnap('half');
    }
}

/** hub 主区出口:'hub' view 贡献;未注册时回落卡片网格空态。 */
function MobileHubOutlet() {
    const views = useContribs('view');
    const C = views.find((v) => v.view === 'hub')?.Component;
    return C ? <C /> : null;
}

function SheetPicker() {
    const { t } = useI18n();
    const { addPanel } = useShell();
    const types = useContribs('panel.type');
    return (
        <div className="grid grid-cols-2 gap-2">
            {types.map((p) => (
                <button key={p.type} type="button" onClick={() => addPanel(p.type)}
                    className="inset-group flex items-center gap-2 p-3 text-left text-[12px] text-[color:var(--fg-primary)]">
                    <Icon name={p.icon} size={15} />{t(`panel.type.${p.type}`)}
                </button>
            ))}
        </div>
    );
}
