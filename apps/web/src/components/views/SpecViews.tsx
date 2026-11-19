// 规范稿视图体:home(资产画廊)/ studio(世界书双栏)/ plugins(内置+市场)。
// 走 view 贡献点注册;数据一律 useShell + SPEC-DATA mock。
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';

const lbl = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]';

/** home:卡画廊 —— 点击卡面选中该卡最新会话(规范稿画廊网格)。 */
export function HomeView() {
    const { t } = useI18n();
    const s = useShell();
    const cards = [...s.cards.values()];
    return (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <h1 className="heading-tight mb-1 text-[18px] text-[color:var(--fg-primary)]">{t('nav.home')}</h1>
            <p className="mb-5 text-[12px] text-[color:var(--fg-muted)]">{t('home.sub')}</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {cards.map((c) => {
                    const chat = s.chats.find((x) => x.charDir === c.charDir);
                    return (
                        <button
                            key={c.charDir}
                            className="inset-group inset-row-btn overflow-hidden text-left"
                            onClick={() => (chat ? s.selectChat(chat.id) : s.newChat(c.charDir))}
                        >
                            <div className="flex h-[150px] items-center justify-center bg-[color:var(--bg-active)] text-[28px]" style={{ color: 'var(--brand)' }}>
                                {c.avatar ? <img src={`/api/utopinn/characters/${encodeURIComponent(c.charDir)}/image`} alt="" className="h-full w-full object-cover" /> : (c.name?.[0] ?? c.charDir[0])}
                            </div>
                            <div className="p-2.5">
                                <div className="truncate text-[12px] font-medium text-[color:var(--fg-primary)]">{c.name || c.charDir}</div>
                                <div className="mt-0.5 truncate text-[10px] text-[color:var(--fg-faint)]">{chat?.title ?? c.charDir}</div>
                            </div>
                        </button>
                    );
                })}
            </div>
            {s.cardsMock && <p className="mt-4 text-[10.5px] text-[color:var(--fg-faint)]">{t('common.mockData')}</p>}
        </div>
    );
}

/** studio:世界书双栏(规范稿 lore 双栏 —— 左条目列表右详情),其余 nav 诚实占位。 */
export function StudioView() {
    const { t } = useI18n();
    const s = useShell();
    const sel = s.worldbook.find((w) => w.id === s.selectedLoreId) ?? s.worldbook[0];
    if (s.studioNav !== 'lore') {
        return (
            <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--fg-faint)]">
                {t(`studio.nav.${s.studioNav}`)} · SPEC-DATA
            </div>
        );
    }
    return (
        <div className="flex min-h-0 flex-1">
            <div className="w-[240px] shrink-0 overflow-y-auto border-r border-[color:var(--border-hairline)] p-2">
                {s.worldbook.map((w) => (
                    <button
                        key={w.id}
                        className="inset-row-btn mb-1 flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left"
                        style={w.id === s.selectedLoreId ? { background: 'var(--bg-active)' } : undefined}
                        onClick={() => s.setSelectedLoreId(w.id)}
                    >
                        <span className="min-w-0">
                            <span className="block truncate text-[11.5px] text-[color:var(--fg-primary)]">{w.title}</span>
                            <span className="mt-0.5 block text-[9.5px] text-[color:var(--fg-faint)]">{w.type} · P{w.priority}</span>
                        </span>
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: w.enabled ? 'var(--status-ok)' : 'var(--fg-faint)' }} />
                    </button>
                ))}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto p-5">
                {sel && (
                    <>
                        <h2 className="heading-tight text-[15px] text-[color:var(--fg-primary)]">{sel.title}</h2>
                        <div className="mb-3 mt-1 text-[10.5px] text-[color:var(--fg-muted)]">{sel.type} · 优先级 {sel.priority} · {sel.tokens} tokens</div>
                        <div className="inset-group p-4 text-[12.5px] leading-relaxed text-[color:var(--fg-secondary)]">{sel.content}</div>
                    </>
                )}
            </div>
        </div>
    );
}

/** plugins:installed = 内置 cordis-* + 市场已装;market = 目录网格。 */
export function PluginsView() {
    const { t } = useI18n();
    const s = useShell();
    const installed = s.pluginsNav === 'installed';
    return (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <h1 className="heading-tight mb-5 text-[18px] text-[color:var(--fg-primary)]">{t(`plugins.nav.${s.pluginsNav}`)}</h1>
            {installed ? (
                <div className="flex flex-col gap-2.5">
                    {s.builtinPlugins.map((p) => (
                        <div key={p.id} className="inset-group flex items-center gap-3 p-3.5">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: p.bg, color: p.color }}>
                                <Icon name={p.icon as never} size={16} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{p.name}</span>
                                <span className="mt-0.5 block truncate text-[10.5px] text-[color:var(--fg-muted)]">{p.desc}</span>
                            </span>
                            <button className="sh-switch" data-checked={p.enabled || undefined} onClick={() => s.toggleBuiltinPlugin(p.id)}><span className="sh-switch-thumb" /></button>
                        </div>
                    ))}
                    {s.marketPlugins.filter((p) => p.installed).map((p) => (
                        <div key={p.id} className="inset-group flex items-center gap-3 p-3.5">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: p.bg, color: p.color }}>
                                <Icon name={p.icon as never} size={16} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{p.name}</span>
                                <span className="mt-0.5 block truncate text-[10.5px] text-[color:var(--fg-muted)]">{p.desc}</span>
                            </span>
                            <button className="ghost-btn h-7 rounded-md px-2.5 text-[10.5px] text-[color:var(--fg-muted)]" onClick={() => s.toggleMarketPlugin(p.id)}>{t('plugins.remove')}</button>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                    {s.marketPlugins.map((p) => (
                        <div key={p.id} className="inset-group p-3.5">
                            <div className="flex items-start gap-2.5">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: p.bg, color: p.color }}>
                                    <Icon name={p.icon as never} size={16} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{p.name}</div>
                                    <div className="text-[9.5px] text-[color:var(--fg-faint)]">{p.category}</div>
                                </div>
                            </div>
                            <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-[color:var(--fg-muted)]">{p.desc}</p>
                            <button
                                className="mt-2.5 w-full rounded-lg py-1.5 text-[11px]"
                                style={p.installed ? { background: 'var(--bg-active)', color: 'var(--fg-secondary)' } : { background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                onClick={() => s.toggleMarketPlugin(p.id)}
                            >
                                {p.installed ? t('plugins.installed') : t('plugins.install')}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
