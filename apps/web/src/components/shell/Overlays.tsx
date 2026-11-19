// 规范稿弹层与移动壳:MobileFrame(hub + mob-drawer + vaul-sheet)|
// Cmdk | SettingsModal。z 层与规范稿一致(sheet 45 / drawer 55 / popover 30 / float 70)。
import { useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { LogoU } from '../LogoU';
import { PanelBody } from './Workbench';
import { ChatStage } from '../stage/CenterStage';
import { ChatTree } from '../sidebar/trees';

/** 移动壳:hub 顶条 + 聊天主区 + 抽屉 + 底 sheet(规范稿 mobile-shell)。 */
export function MobileFrame() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="mobile-wrap">
            <div className="mobile-shell">
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
                {s.mobileDrawer && <div className="fixed inset-0 z-[54] bg-black/40" onClick={() => s.setMobileDrawer(false)} />}
                <div className="mob-drawer" data-open={s.mobileDrawer || undefined}>
                    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--border-hairline)] px-3 text-[color:var(--brand)]"><LogoU size={16} /><span className="heading-tight text-[12.5px] text-[color:var(--fg-primary)]">{t('app.name')}</span></div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2" onClick={() => s.setMobileDrawer(false)}><ChatTree /></div>
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

/** 命令面板:视图跳转 + 板块快开(规范稿 cmdk)。 */
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

/** 设置模态:左 tab 条 + 右 inset-group 控件组(规范稿 settings)。 */
export function SettingsModal() {
    const { t } = useI18n();
    const s = useShell();
    if (!s.settingsOpen) return null;
    const tabs = ['account', 'api', 'chat', 'appearance', 'about'];
    const cs = s.chatSettings;
    const sw = (on: boolean, fn: () => void) => <button className="sh-switch" data-checked={on || undefined} onClick={fn}><span className="sh-switch-thumb" /></button>;
    return (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50" onClick={s.closeSettings}>
            <div className="pop-in flex h-[440px] w-[640px] max-w-[94vw] overflow-hidden rounded-[14px]" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)' }} onClick={(e) => e.stopPropagation()}>
                <div className="w-[150px] shrink-0 border-r border-[color:var(--border-hairline)] p-2">
                    {tabs.map((tb) => (
                        <button key={tb} className="inset-row-btn mb-0.5 w-full rounded-md px-2.5 py-2 text-left text-[12px]" style={s.settingsTab === tb ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }} onClick={() => s.setSettingsTab(tb)}>
                            {t(`st.${tb}`)}
                        </button>
                    ))}
                </div>
                <div className="min-w-0 flex-1 overflow-y-auto p-4">
                    <div className="inset-group">
                        {s.settingsTab === 'api' && (
                            <div className="inset-row"><span className="text-[12px] text-[color:var(--fg-secondary)]">{t('st.endpoint')}</span><input value={cs.endpoint} onChange={(e) => s.setChatSetting('endpoint', e.target.value)} className="w-[240px] rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 py-1 font-mono-ui text-[10.5px] outline-none" /></div>
                        )}
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
