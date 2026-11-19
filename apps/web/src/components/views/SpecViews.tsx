// 规范稿主区视图:home(资产画廊)/ studio(资产管理域)/ plugins(插件域)/ hub(移动)。
// home/hub 用真 cards;studio 子页按 studioNav 分面,library 子页复用 LibraryView;
// plugins.installed 复用 ExtensionsView(真插件管理),market 走 mock 目录。
import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon, type IconName } from '../Icon';
import { CardTile } from '../CardTile';
import { charImageUrl } from '../../api/characters';
import { LibraryView } from './LibraryView';
import { ExtensionsView } from './ExtensionsView';

function PageHead({ title, sub }: { title: string; sub?: string }) {
    return (
        <div className="mb-5">
            <h1 className="heading-tight text-[18px] text-[color:var(--fg-primary)]">{title}</h1>
            {sub && <p className="mt-0.5 text-[12px] text-[color:var(--fg-muted)]">{sub}</p>}
        </div>
    );
}

/* ================= home:问候 + 继续 + 卡格(真 cards/chats) ================= */
export function HomeGallery() {
    const { t } = useI18n();
    const { cards, chats, selectChat, openCharacter, cardsMock } = useShell();
    const cardList = useMemo(() => [...cards.values()], [cards]);
    const recent = chats.slice(0, 4);
    return (
        <div className="no-scrollbar h-full overflow-y-auto px-8 py-8">
            <PageHead title={t('home.greeting')} sub={t('home.sub')} />
            {recent.length > 0 && (
                <>
                    <div className="mb-2 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('home.continue')}</div>
                    <div className="inset-group mb-6">
                        {recent.map((c) => {
                            const card = cards.get(c.charDir);
                            return (
                                <button key={c.id} type="button" className="inset-row inset-row-btn" onClick={() => selectChat(c.id)}>
                                    <span className="flex min-w-0 items-center gap-2.5">
                                        <span className="char-avatar-ring flex h-7 w-7 items-center justify-center overflow-hidden text-[11px] text-[color:var(--fg-muted)]">
                                            {card?.avatar ? <img src={charImageUrl(card.avatar)} alt="" className="h-full w-full object-cover" /> : (card?.name ?? c.title).slice(0, 1)}
                                        </span>
                                        <span className="min-w-0">
                                            <span className="block truncate text-[13px] text-[color:var(--fg-primary)]">{c.title}</span>
                                            <span className="block truncate text-[10px] text-[color:var(--fg-faint)]">{card?.name ?? c.charDir} · {c.updatedAt}</span>
                                        </span>
                                    </span>
                                    {c.unread && <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--brand)]" />}
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
            <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-medium text-[color:var(--fg-muted)]">{t('home.cards')}</span>
                {cardsMock && <span className="text-[10px] text-[color:var(--fg-faint)]">{t('tree.mockNote')}</span>}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {cardList.map((c) => (
                    <CardTile key={c.charDir} card={c}
                        chatCount={chats.filter((x) => x.charDir === c.charDir).length}
                        onOpen={() => openCharacter(c.charDir)} />
                ))}
            </div>
            {cardList.length === 0 && <p className="py-10 text-center text-[12px] text-[color:var(--fg-faint)]">{t('home.empty')}</p>}
        </div>
    );
}

/* ================= studio:左树选中分面 ================= */
export function StudioView() {
    const { t } = useI18n();
    const { studioNav } = useShell();
    if (studioNav === 'library') return <div className="h-full overflow-hidden"><LibraryView /></div>;
    return (
        <div className="no-scrollbar h-full overflow-y-auto px-8 py-8">
            <PageHead title={t(`studio.${studioNav}`)} sub={t('studio.stubSub')} />
            {studioNav === 'presets' && <StudioPresets />}
            {studioNav === 'worlds' && <StudioWorlds />}
            {studioNav === 'secrets' && <StubBlock k="studio.secrets.stub" icon="shield" />}
            {studioNav === 'recent' && <StubBlock k="studio.recent.stub" icon="clock" />}
        </div>
    );
}

function StubBlock({ k, icon }: { k: string; icon: IconName }) {
    const { t } = useI18n();
    return (
        <div className="flex flex-col items-center gap-2 py-16 text-[color:var(--fg-faint)]">
            <Icon name={icon} size={26} />
            <p className="text-[12px]">{t(k)}</p>
        </div>
    );
}

function StudioPresets() {
    const { t } = useI18n();
    const { presets, activePresetId, setActivePreset } = useShell();
    return (
        <div className="inset-group max-w-[560px]">
            {presets.map((p) => (
                <button key={p.id} type="button" className="inset-row inset-row-btn" onClick={() => setActivePreset(p.id)}>
                    <span className="flex min-w-0 items-center gap-2.5">
                        <Icon name="zap" size={14} className={p.id === activePresetId ? 'text-[color:var(--brand)]' : 'text-[color:var(--fg-faint)]'} />
                        <span className="min-w-0">
                            <span className="block truncate text-[13px] text-[color:var(--fg-primary)]">{p.name}</span>
                            <span className="block truncate text-[11px] text-[color:var(--fg-faint)]">{p.desc} · T{p.temp} · {p.source}</span>
                        </span>
                    </span>
                    {p.id === activePresetId && <Icon name="check" size={14} className="text-[color:var(--brand)]" />}
                </button>
            ))}
            <div className="inset-row"><span className="text-[10px] text-[color:var(--fg-faint)]">{t('panel.preset.mockNote')}</span></div>
        </div>
    );
}

function StudioWorlds() {
    const { t } = useI18n();
    const { globalLore, toggleGlobalLore } = useShell();
    return (
        <div className="inset-group max-w-[560px]">
            {globalLore.map((g) => (
                <div key={g.id} className="inset-row">
                    <span className="flex min-w-0 items-center gap-2.5">
                        <Icon name="book" size={14} className="text-[color:var(--fg-muted)]" />
                        <span className="min-w-0">
                            <span className="block truncate text-[13px] text-[color:var(--fg-primary)]">{g.name}</span>
                            <span className="block text-[11px] text-[color:var(--fg-faint)]">{t('studio.entries').replace('{n}', String(g.entries))}</span>
                        </span>
                    </span>
                    <button type="button" className="sh-switch" data-checked={g.enabled} onClick={() => toggleGlobalLore(g.id)}>
                        <span className="sh-switch-thumb" />
                    </button>
                </div>
            ))}
        </div>
    );
}

/* ================= plugins:installed(真) + market(mock) ================= */
export function PluginsView() {
    const { t } = useI18n();
    const { pluginsNav, marketPlugins, toggleMarketPlugin } = useShell();
    if (pluginsNav === 'installed') return <div className="h-full overflow-hidden"><ExtensionsView /></div>;
    return (
        <div className="no-scrollbar h-full overflow-y-auto px-8 py-8">
            <PageHead title={t('plugins.market')} sub={t('plugins.marketSub')} />
            <div className="inset-group max-w-[640px]">
                {marketPlugins.map((m) => (
                    <div key={m.id} className="inset-row">
                        <span className="flex min-w-0 items-start gap-2.5">
                            <Icon name="plug" size={15} className="mt-0.5 text-[color:var(--fg-muted)]" />
                            <span className="min-w-0">
                                <span className="block truncate text-[13px] text-[color:var(--fg-primary)]">
                                    {m.name} <span className="text-[10px] text-[color:var(--fg-faint)]">· {m.author} · ⬇{m.installs}</span>
                                </span>
                                <span className="block text-[11px] leading-relaxed text-[color:var(--fg-muted)]">{m.desc}</span>
                            </span>
                        </span>
                        <button type="button"
                            className={`shrink-0 rounded-[7px] px-2.5 py-1 text-[11px] ${m.installed ? 'border border-[color:var(--border-subtle)] text-[color:var(--fg-muted)]' : 'bg-[color:var(--brand)] text-[color:var(--brand-fg)]'}`}
                            onClick={() => toggleMarketPlugin(m.id)}>
                            {m.installed ? t('plugins.installedBtn') : t('plugins.install')}
                        </button>
                    </div>
                ))}
                <div className="inset-row"><span className="text-[10px] text-[color:var(--fg-faint)]">{t('plugins.mockNote')}</span></div>
            </div>
        </div>
    );
}

/* ================= hub:移动资产工坊 ================= */
export function HubView() {
    const { t } = useI18n();
    const { cards, chats, selectChat, openCharacter } = useShell();
    return (
        <div className="no-scrollbar h-full overflow-y-auto px-4 py-4">
            <div className="mb-3 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('hub.recent')}</div>
            <div className="inset-group mb-4">
                {chats.slice(0, 3).map((c) => (
                    <button key={c.id} type="button" className="inset-row inset-row-btn" onClick={() => selectChat(c.id)}>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--fg-primary)]">{c.title}</span>
                        <Icon name="chevronRight" size={12} className="text-[color:var(--fg-faint)]" />
                    </button>
                ))}
            </div>
            <div className="mb-2 text-[11px] font-medium text-[color:var(--fg-muted)]">{t('home.cards')}</div>
            <div className="grid grid-cols-2 gap-2.5">
                {[...cards.values()].map((c) => (
                    <CardTile key={c.charDir} card={c}
                        chatCount={chats.filter((x) => x.charDir === c.charDir).length}
                        onOpen={() => openCharacter(c.charDir)} />
                ))}
            </div>
        </div>
    );
}
