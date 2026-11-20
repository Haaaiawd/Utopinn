// 规范稿视图体:home(资产画廊)/ plugins(内置+市场)。
// studio 六类页已迁至 views/studio.tsx(端稿 renderStudioMain —— 真 API 面)。
// 走 view 贡献点注册;数据一律 useShell + SPEC-DATA mock。
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { charImageUrl } from '../../api/characters';
import { charImgFallback } from '../stage/StageFrame';
import { openImportModal } from '../shell/overlayBus';

const lbl = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]';

/** home:卡画廊 —— 点击卡面选中该卡最新会话(规范稿画廊网格)。
 *  移动端按规范稿 renderHomeGallery(true):h-12 头(menu + 标题 + 导入钮)
 *  + 「继续你的故事」hero + 16/11 封面砖(渐变压底,卡名·会话题叠字)。 */
export function HomeView() {
    const { t } = useI18n();
    const s = useShell();
    const cards = [...s.cards.values()];
    if (s.isMobile) {
        return (
            <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
                <header className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <div className="flex items-center gap-2">
                        <button className="ghost-btn h-8 w-8" onClick={() => s.setMobileDrawer(true)} title={t('mob.menu')}><Icon name="menu" size={20} /></button>
                        <span className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('nav.home')}</span>
                    </div>
                    <button
                        className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-1 text-[12px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                        onClick={openImportModal}
                    >
                        + {t('ov.import.short')}{t('mob.hub.cards')}
                    </button>
                </header>
                <div className="scroll-fade-mask min-h-0 flex-1 overflow-y-auto px-5 py-6">
                    <div className="mx-auto max-w-3xl space-y-8">
                        <div className="pt-2"><h1 className="heading-tight text-[24px] font-medium text-[color:var(--fg-primary)]">{t('home.hero')}</h1></div>
                        <div className="grid grid-cols-1 gap-3.5">
                            {cards.map((c) => {
                                const chat = s.chats.find((x) => x.charDir === c.charDir);
                                return (
                                    <button
                                        key={c.charDir}
                                        className="group relative aspect-[16/11] overflow-hidden rounded-[12px] border border-[color:var(--border-hairline)] text-left"
                                        onClick={() => (chat ? s.selectChat(chat.id) : s.newChat(c.charDir))}
                                    >
                                        {c.avatar
                                            ? <img src={charImageUrl(c.avatar)} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" onError={charImgFallback} />
                                            : <span className="absolute inset-0 flex items-center justify-center bg-[color:var(--bg-active)] text-[28px] text-[color:var(--brand)]">{c.name?.[0] ?? c.charDir[0]}</span>}
                                        <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(8,9,10,0.04) 0%, rgba(8,9,10,0.22) 48%, rgba(8,9,10,0.90) 100%)' }} />
                                        <span className="absolute bottom-3.5 left-4 right-4">
                                            <span className="heading-tight block truncate text-[14px] font-medium text-white">{c.name || c.charDir}</span>
                                            <span className="mt-0.5 block truncate text-[12px] text-white/65">{chat?.title ?? c.charDir}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </section>
        );
    }
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
